'use strict';

/**
 * Painel administrativo — editais.
 *
 *   GET    /api/admin/exam-notices          lista paginada (q, exam_id, year, status, sort, dir)
 *   GET    /api/admin/exam-notices/:id
 *   POST   /api/admin/exam-notices          cadastra
 *   PUT    /api/admin/exam-notices/:id      edita (parcial)
 *   POST   /api/admin/exam-notices/:id/publish   publica e arquiva os anteriores da mesma prova
 *   POST   /api/admin/exam-notices/:id/archive
 *   DELETE /api/admin/exam-notices/:id
 *
 * Publicar um edital arquiva automaticamente os outros editais publicados da
 * mesma prova: só um vale por vez para o aluno. Quando o edital publicado traz
 * data de prova, ela também atualiza a data padrão do vestibular, que é o que o
 * cronograma usa para calcular a urgência dos assuntos.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { nullableFileRef } = require('../../utils/validators');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const nullableUrl = nullableFileRef(2000, 'Informe um endereço válido ou envie o arquivo.');
const nullableDate = z.preprocess(
  emptyToNull,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD.').nullable().optional()
);
const nullableInt = (max) => z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(max).nullable().optional());

/** Pontos de atenção exibidos ao aluno: [{ label, value }]. */
const highlights = z
  .array(
    z.object({
      label: z.string().trim().min(1, 'Informe o rótulo.').max(80),
      value: z.string().trim().min(1, 'Informe o conteúdo.').max(400),
    })
  )
  .max(20)
  .optional();

const createBody = z.object({
  exam_id: uuid,
  year: z.coerce.number().int().min(1950).max(2100),
  title: z.string().trim().min(3, 'Informe o título do edital.').max(200),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  board: nullableText(80),
  pdf_url: nullableUrl,
  external_url: nullableUrl,
  summary: nullableText(8000),
  published_at: nullableDate,
  registration_start: nullableDate,
  registration_end: nullableDate,
  exam_date: nullableDate,
  second_exam_date: nullableDate,
  result_date: nullableDate,
  vacancies: nullableInt(1000000),
  fee_cents: nullableInt(10000000),
  highlights,
  notes: nullableText(2000),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
});

const updateBody = createBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  exam_id: z.preprocess(emptyToUndefined, uuid.optional()),
  year: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1950).max(2100).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['draft', 'published', 'archived']).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SORTABLE = {
  year: 'n.year',
  title: 'n.title',
  status: 'n.status',
  exam_date: 'n.exam_date',
  updated_at: 'n.updated_at',
  created_at: 'n.created_at',
  exam_name: 'e.name',
};

const SELECT_NOTICE = `
  SELECT n.id, n.exam_id, n.year, n.title, n.status, n.board, n.pdf_url, n.external_url, n.summary,
         n.published_at, n.registration_start, n.registration_end, n.exam_date, n.second_exam_date,
         n.result_date, n.vacancies, n.fee_cents, n.highlights, n.notes, n.sort_order,
         n.created_at, n.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name, e.slug AS exam_slug, e.track AS exam_track
    FROM exam_notices n
    JOIN exams e ON e.id = n.exam_id`;

const WRITABLE = [
  'exam_id', 'year', 'title', 'status', 'board', 'pdf_url', 'external_url', 'summary',
  'published_at', 'registration_start', 'registration_end', 'exam_date', 'second_exam_date',
  'result_date', 'vacancies', 'fee_cents', 'notes', 'sort_order',
];

async function assertExam(examId) {
  const exam = await db.one('SELECT id FROM exams WHERE id = $1', [examId]);
  if (!exam) {
    throw new AppError(400, 'validation_error', 'Vestibular não encontrado.', [
      { path: 'exam_id', message: 'Vestibular não encontrado.' },
    ]);
  }
}

async function loadNotice(id) {
  const notice = await db.one(`${SELECT_NOTICE} WHERE n.id = $1`, [id]);
  if (!notice) throw new AppError(404, 'not_found', 'Edital não encontrado.');
  return notice;
}

/**
 * Deixa apenas este edital publicado na prova e sincroniza a data da prova.
 * Roda em transação: arquivar os antigos e publicar o novo é uma coisa só.
 */
async function publishNotice(id) {
  return db.tx(async (client) => {
    const current = await client.one('SELECT id, exam_id, exam_date, second_exam_date FROM exam_notices WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Edital não encontrado.');

    const archived = await client.query(
      `UPDATE exam_notices SET status = 'archived'
        WHERE exam_id = $1 AND id <> $2 AND status = 'published'`,
      [current.exam_id, id]
    );
    await client.query(
      `UPDATE exam_notices
          SET status = 'published', published_at = coalesce(published_at, current_date)
        WHERE id = $1`,
      [id]
    );
    // a data da prova alimenta a contagem regressiva e a urgência do cronograma
    if (current.exam_date) {
      await client.query('UPDATE exams SET exam_date = $2 WHERE id = $1', [current.exam_id, current.exam_date]);
    }
    return { archived: archived.rowCount };
  });
}

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 25, maxLimit: 200 });
    const sort = parseSort(query, SORTABLE, { defaultSort: 'year', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(fe_unaccent(n.title) ILIKE fe_unaccent(${like}) OR fe_unaccent(e.name) ILIKE fe_unaccent(${like}))`);
    }
    if (query.exam_id) clauses.push(`n.exam_id = ${push(query.exam_id)}`);
    if (query.year) clauses.push(`n.year = ${push(query.year)}`);
    if (query.status) clauses.push(`n.status = ${push(query.status)}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [totalRow, items, years] = await Promise.all([
      db.one(`SELECT count(*)::int AS total FROM exam_notices n JOIN exams e ON e.id = n.exam_id ${where}`, params),
      db.many(
        `${SELECT_NOTICE} ${where} ORDER BY ${sort.sql}, n.sort_order, n.title
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.many('SELECT DISTINCT year FROM exam_notices ORDER BY year DESC'),
    ]);

    res.json({ ...paginate(items, totalRow.total, { page, limit }), years: years.map((row) => row.year) });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    res.json(await loadNotice(req.valid.params.id));
  })
);

router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertExam(body.exam_id);

    const duplicated = await db.one('SELECT id FROM exam_notices WHERE exam_id = $1 AND year = $2', [body.exam_id, body.year]);
    if (duplicated) {
      throw new AppError(409, 'conflict', 'Este vestibular já tem um edital cadastrado para esse ano.', [
        { path: 'year', message: 'Já existe um edital deste ano.' },
      ]);
    }

    const created = await db.one(
      `INSERT INTO exam_notices (
         exam_id, year, title, status, board, pdf_url, external_url, summary,
         published_at, registration_start, registration_end, exam_date, second_exam_date,
         result_date, vacancies, fee_cents, highlights, notes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
       RETURNING id`,
      [
        body.exam_id, body.year, body.title, body.status ?? 'draft', body.board ?? null,
        body.pdf_url ?? null, body.external_url ?? null, body.summary ?? null,
        body.published_at ?? null, body.registration_start ?? null, body.registration_end ?? null,
        body.exam_date ?? null, body.second_exam_date ?? null, body.result_date ?? null,
        body.vacancies ?? null, body.fee_cents ?? null, JSON.stringify(body.highlights ?? []),
        body.notes ?? null, body.sort_order ?? 0,
      ]
    );

    if ((body.status ?? 'draft') === 'published') await publishNotice(created.id);

    const notice = await loadNotice(created.id);
    await audit(req, 'exam_notice.create', 'exam_notice', created.id, { title: body.title, year: body.year });
    res.status(201).json(notice);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT id, exam_id, year FROM exam_notices WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Edital não encontrado.');
    if (body.exam_id) await assertExam(body.exam_id);

    const examId = body.exam_id ?? current.exam_id;
    const year = body.year ?? current.year;
    if (body.exam_id || body.year) {
      const duplicated = await db.one('SELECT id FROM exam_notices WHERE exam_id = $1 AND year = $2 AND id <> $3', [examId, year, id]);
      if (duplicated) {
        throw new AppError(409, 'conflict', 'Este vestibular já tem um edital cadastrado para esse ano.', [
          { path: 'year', message: 'Já existe um edital deste ano.' },
        ]);
      }
    }

    const sets = [];
    const params = [];
    for (const key of WRITABLE) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      params.push(body[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'highlights')) {
      params.push(JSON.stringify(body.highlights ?? []));
      sets.push(`highlights = $${params.length}::jsonb`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE exam_notices SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    if (body.status === 'published') await publishNotice(id);

    const notice = await loadNotice(id);
    await audit(req, 'exam_notice.update', 'exam_notice', id, { changes: Object.keys(body) });
    res.json(notice);
  })
);

router.post(
  '/:id/publish',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const { archived } = await publishNotice(id);
    const notice = await loadNotice(id);
    await audit(req, 'exam_notice.publish', 'exam_notice', id, { archived });
    res.json({ ...notice, archived });
  })
);

router.post(
  '/:id/archive',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const current = await db.one('SELECT id FROM exam_notices WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Edital não encontrado.');
    await db.query(`UPDATE exam_notices SET status = 'archived' WHERE id = $1`, [id]);
    const notice = await loadNotice(id);
    await audit(req, 'exam_notice.archive', 'exam_notice', id, {});
    res.json(notice);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const notice = await db.one('SELECT id, title FROM exam_notices WHERE id = $1', [id]);
    if (!notice) throw new AppError(404, 'not_found', 'Edital não encontrado.');
    await db.query('DELETE FROM exam_notices WHERE id = $1', [id]);
    await audit(req, 'exam_notice.delete', 'exam_notice', id, { title: notice.title });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/exam-notices', router };

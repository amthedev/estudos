'use strict';

/**
 * Painel administrativo — provas anteriores (PDF da prova e do gabarito).
 *
 *   GET    /api/admin/past-exams        lista paginada (q, exam_id, year, status, sort, dir)
 *   GET    /api/admin/past-exams/:id
 *   POST   /api/admin/past-exams        { exam_id, year, day?, title, board?, pdf_url?, answer_key_url?,
 *                                         external_url?, notes?, sort_order?, active? }
 *   PUT    /api/admin/past-exams/:id    edita (parcial)
 *   DELETE /api/admin/past-exams/:id
 *   PATCH  /api/admin/past-exams/reorder { ids[] }
 *
 * A tela do aluno (/api/past-exams) mostra apenas as provas ativas de vestibulares ativos.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const nullableUrl = z.preprocess(emptyToNull, z.string().trim().url('URL inválida.').max(2000).nullable().optional());

const createBody = z.object({
  exam_id: uuid,
  year: z.coerce.number().int().min(1950).max(2100),
  day: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(9).nullable().optional()),
  title: z.string().trim().min(3, 'Informe o título da prova.').max(200),
  board: nullableText(80),
  pdf_url: nullableUrl,
  answer_key_url: nullableUrl,
  external_url: nullableUrl,
  notes: nullableText(2000),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
});
const updateBody = createBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  exam_id: z.preprocess(emptyToUndefined, uuid.optional()),
  year: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1950).max(2100).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SORTABLE = {
  year: 'pe.year',
  title: 'pe.title',
  sort_order: 'pe.sort_order',
  created_at: 'pe.created_at',
  updated_at: 'pe.updated_at',
  exam_name: 'e.name',
};

const SELECT_PAST_EXAM = `
  SELECT pe.id, pe.exam_id, pe.year, pe.day, pe.title, pe.board, pe.pdf_url, pe.answer_key_url,
         pe.external_url, pe.notes, pe.sort_order, pe.active, pe.created_at, pe.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name, e.track AS exam_track, e.slug AS exam_slug
    FROM past_exams pe
    JOIN exams e ON e.id = pe.exam_id`;

const WRITABLE = ['exam_id', 'year', 'day', 'title', 'board', 'pdf_url', 'answer_key_url', 'external_url', 'notes', 'sort_order', 'active'];

async function assertExam(examId) {
  const exam = await db.one('SELECT id FROM exams WHERE id = $1', [examId]);
  if (!exam) {
    throw new AppError(400, 'validation_error', 'Vestibular não encontrado.', [{ path: 'exam_id', message: 'Vestibular não encontrado.' }]);
  }
}

router.patch(
  '/reorder',
  validate({ body: z.object({ ids: z.array(uuid).min(1).max(2000) }) }),
  wrap(async (req, res) => {
    const ids = Array.from(new Set(req.valid.body.ids));
    const result = await db.query(
      `UPDATE past_exams AS pe SET sort_order = o.position
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
        WHERE pe.id = o.id`,
      [ids]
    );
    await audit(req, 'past_exam.reorder', 'past_exam', null, { count: result.rowCount });
    res.json({ ok: true, updated: result.rowCount });
  })
);

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
      clauses.push(`(fe_unaccent(pe.title) ILIKE fe_unaccent(${like}) OR fe_unaccent(e.name) ILIKE fe_unaccent(${like}))`);
    }
    if (query.exam_id) clauses.push(`pe.exam_id = ${push(query.exam_id)}`);
    if (query.year) clauses.push(`pe.year = ${push(query.year)}`);
    if (query.status) clauses.push(`pe.active = ${push(query.status === 'active')}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [totalRow, items, years] = await Promise.all([
      db.one(`SELECT count(*)::int AS total FROM past_exams pe JOIN exams e ON e.id = pe.exam_id ${where}`, params),
      db.many(
        `${SELECT_PAST_EXAM} ${where} ORDER BY ${sort.sql}, pe.sort_order, pe.day NULLS FIRST, pe.title
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.many('SELECT DISTINCT year FROM past_exams ORDER BY year DESC'),
    ]);

    res.json({ ...paginate(items, totalRow.total, { page, limit }), years: years.map((row) => row.year) });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const item = await db.one(`${SELECT_PAST_EXAM} WHERE pe.id = $1`, [req.valid.params.id]);
    if (!item) throw new AppError(404, 'not_found', 'Prova anterior não encontrada.');
    res.json(item);
  })
);

router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertExam(body.exam_id);
    const order = body.sort_order ?? Number(
      (await db.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM past_exams WHERE exam_id = $1 AND year = $2', [body.exam_id, body.year])).next
    );
    const created = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, board, pdf_url, answer_key_url, external_url, notes, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        body.exam_id, body.year, body.day ?? null, body.title, body.board ?? null, body.pdf_url ?? null,
        body.answer_key_url ?? null, body.external_url ?? null, body.notes ?? null, order, body.active ?? true,
      ]
    );
    const item = await db.one(`${SELECT_PAST_EXAM} WHERE pe.id = $1`, [created.id]);
    await audit(req, 'past_exam.create', 'past_exam', created.id, { title: body.title, year: body.year });
    res.status(201).json(item);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT id FROM past_exams WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Prova anterior não encontrada.');
    if (body.exam_id) await assertExam(body.exam_id);

    const sets = [];
    const params = [];
    for (const key of WRITABLE) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      params.push(body[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE past_exams SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const item = await db.one(`${SELECT_PAST_EXAM} WHERE pe.id = $1`, [id]);
    await audit(req, 'past_exam.update', 'past_exam', id, { changes: Object.keys(body) });
    res.json(item);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const item = await db.one('SELECT id, title FROM past_exams WHERE id = $1', [id]);
    if (!item) throw new AppError(404, 'not_found', 'Prova anterior não encontrada.');
    await db.query('DELETE FROM past_exams WHERE id = $1', [id]);
    await audit(req, 'past_exam.delete', 'past_exam', id, { title: item.title });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/past-exams', router };

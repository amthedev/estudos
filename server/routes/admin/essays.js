'use strict';

/**
 * Painel administrativo — redação (temas, critérios de correção e redações enviadas).
 *
 *   GET    /api/admin/essays/themes            lista paginada (q, exam_id, status, year)
 *   GET    /api/admin/essays/themes/:id
 *   POST   /api/admin/essays/themes            { exam_id?, title, prompt_text?, support_texts?, source?, year?, active? }
 *   PUT    /api/admin/essays/themes/:id
 *   DELETE /api/admin/essays/themes/:id        409 quando o tema já foi usado em redações
 *   GET    /api/admin/essays/criteria/:examId  conjunto de critérios da prova (vazio = pronto para preencher)
 *   PUT    /api/admin/essays/criteria/:examId  { name, max_score, genre, min_lines, max_lines, instructions,
 *                                                active, criteria: [{ key?, name, max, description?, guidance? }] }
 *   GET    /api/admin/essays/submissions       redações enviadas (aluno, prova, tema, nota, data, status)
 *   GET    /api/admin/essays/submissions/:id   redação + correção completa
 *
 * Regra dos critérios: a soma dos máximos dos critérios precisa ser igual à escala máxima
 * (`max_score`) — é essa soma que o corretor IA usa como nota máxima da prova.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { slugify } = require('../../utils/slug');

const SCORE_TOLERANCE = 0.01;

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const examParams = z.object({ examId: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

// ---------------------------------------------------------------------------
// Temas
// ---------------------------------------------------------------------------
const themeBody = z.object({
  exam_id: z.preprocess(emptyToNull, uuid.nullable().optional()),
  title: z.string().trim().min(5, 'Informe o título do tema.').max(300),
  prompt_text: nullableText(20000),
  support_texts: nullableText(40000),
  source: nullableText(200),
  year: z.preprocess(emptyToNull, z.coerce.number().int().min(1950).max(2100).nullable().optional()),
  active: z.boolean().optional(),
});
const themeUpdate = themeBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const themeListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  exam_id: z.preprocess(emptyToUndefined, uuid.optional()),
  year: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1950).max(2100).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
  origin: z.preprocess(emptyToUndefined, z.enum(['ai', 'manual']).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const THEME_SORTABLE = {
  title: 'th.title',
  year: 'th.year',
  created_at: 'th.created_at',
  updated_at: 'th.updated_at',
  exam_name: 'e.name',
};

const SELECT_THEME = `
  SELECT th.id, th.exam_id, th.title, th.prompt_text, th.support_texts, th.source, th.year,
         th.generated_by_ai, th.active, th.created_at, th.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name,
         (SELECT count(*)::int FROM essays es WHERE es.theme_id = th.id) AS essays_count
    FROM essay_themes th
    LEFT JOIN exams e ON e.id = th.exam_id`;

// ---------------------------------------------------------------------------
// Critérios
// ---------------------------------------------------------------------------
const criterionSchema = z.object({
  key: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  name: z.string().trim().min(2, 'Informe o nome do critério.').max(200),
  max: z.coerce.number().min(0.01, 'O máximo do critério precisa ser maior que zero.').max(10000),
  description: nullableText(4000),
  guidance: nullableText(8000),
});

const criteriaBody = z.object({
  name: z.string().trim().min(3, 'Informe o nome do conjunto de critérios.').max(200),
  max_score: z.coerce.number().min(0.01, 'Informe a escala máxima da prova.').max(10000),
  genre: z.string().trim().min(3).max(200).optional(),
  min_lines: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(200).nullable().optional()),
  max_lines: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(400).nullable().optional()),
  instructions: nullableText(20000),
  active: z.boolean().optional(),
  criteria: z.array(criterionSchema).min(1, 'Cadastre pelo menos um critério.').max(30),
});

/** Normaliza a lista de critérios: chaves únicas e números arredondados. */
function normalizeCriteria(list) {
  const seen = new Set();
  return list.map((item, index) => {
    let key = item.key ? slugify(item.key, { maxLength: 40, separator: '_' }) : slugify(item.name, { maxLength: 40, separator: '_' });
    if (!key) key = `c${index + 1}`;
    if (seen.has(key)) key = `${key}_${index + 1}`;
    seen.add(key);
    return {
      key,
      name: item.name,
      max: Math.round(Number(item.max) * 100) / 100,
      description: item.description ?? null,
      guidance: item.guidance ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Redações enviadas
// ---------------------------------------------------------------------------
const submissionsQuery = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.preprocess(emptyToUndefined, z.enum(['draft', 'submitted', 'corrected', 'failed']).optional()),
  exam_id: z.preprocess(emptyToUndefined, uuid.optional()),
  user_id: z.preprocess(emptyToUndefined, uuid.optional()),
  theme_id: z.preprocess(emptyToUndefined, uuid.optional()),
  from: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  to: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SUBMISSION_SORTABLE = {
  created_at: 'es.created_at',
  submitted_at: 'es.submitted_at',
  corrected_at: 'es.corrected_at',
  score: 'es.score',
  user_name: 'u.name',
  exam_name: 'e.name',
};

const SUBMISSION_COLUMNS = `
    es.id, es.user_id, u.name AS user_name, u.email AS user_email,
    es.exam_id, e.name AS exam_name, e.short_name AS exam_short_name,
    es.theme_id, es.theme_title, es.status, es.score, es.max_score, es.word_count, es.model,
    es.error_message, es.submitted_at, es.corrected_at, es.created_at, es.updated_at`;

const SUBMISSION_FROM = `
    FROM essays es
    JOIN users u ON u.id = es.user_id
    LEFT JOIN exams e ON e.id = es.exam_id`;

const SELECT_SUBMISSION = `SELECT ${SUBMISSION_COLUMNS} ${SUBMISSION_FROM}`;
const SELECT_SUBMISSION_FULL = `SELECT ${SUBMISSION_COLUMNS}, es.content, es.correction ${SUBMISSION_FROM}`;

// ---------------------------------------------------------------------------
// Rotas — temas
// ---------------------------------------------------------------------------
router.get(
  '/themes',
  validate({ query: themeListQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, THEME_SORTABLE, { defaultSort: 'created_at', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) clauses.push(`fe_unaccent(th.title) ILIKE fe_unaccent(${push(`%${query.q}%`)})`);
    if (query.exam_id) clauses.push(`th.exam_id = ${push(query.exam_id)}`);
    if (query.year) clauses.push(`th.year = ${push(query.year)}`);
    if (query.status) clauses.push(`th.active = ${push(query.status === 'active')}`);
    if (query.origin) clauses.push(`th.generated_by_ai = ${push(query.origin === 'ai')}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await db.one(
      `SELECT count(*)::int AS total FROM essay_themes th LEFT JOIN exams e ON e.id = th.exam_id ${where}`,
      params
    );
    const items = await db.many(
      `${SELECT_THEME} ${where} ORDER BY ${sort.sql}, th.title LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    for (const item of items) {
      delete item.support_texts;
      delete item.prompt_text;
    }
    res.json(paginate(items, totalRow.total, { page, limit }));
  })
);

router.get(
  '/themes/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const theme = await db.one(`${SELECT_THEME} WHERE th.id = $1`, [req.valid.params.id]);
    if (!theme) throw new AppError(404, 'not_found', 'Tema não encontrado.');
    res.json(theme);
  })
);

router.post(
  '/themes',
  validate({ body: themeBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    if (body.exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1', [body.exam_id]);
      if (!exam) throw new AppError(400, 'validation_error', 'Prova não encontrada.', [{ path: 'exam_id', message: 'Prova não encontrada.' }]);
    }
    const created = await db.one(
      `INSERT INTO essay_themes (exam_id, title, prompt_text, support_texts, source, year, generated_by_ai, active)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7) RETURNING id`,
      [body.exam_id ?? null, body.title, body.prompt_text ?? null, body.support_texts ?? null, body.source ?? null, body.year ?? null, body.active ?? true]
    );
    const theme = await db.one(`${SELECT_THEME} WHERE th.id = $1`, [created.id]);
    await audit(req, 'essay_theme.create', 'essay_theme', created.id, { title: body.title, exam_id: body.exam_id ?? null });
    res.status(201).json(theme);
  })
);

router.put(
  '/themes/:id',
  validate({ params: idParams, body: themeUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT id FROM essay_themes WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Tema não encontrado.');
    if (body.exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1', [body.exam_id]);
      if (!exam) throw new AppError(400, 'validation_error', 'Prova não encontrada.', [{ path: 'exam_id', message: 'Prova não encontrada.' }]);
    }

    const sets = [];
    const params = [];
    for (const key of ['exam_id', 'title', 'prompt_text', 'support_texts', 'source', 'year', 'active']) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      params.push(body[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE essay_themes SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const theme = await db.one(`${SELECT_THEME} WHERE th.id = $1`, [id]);
    await audit(req, 'essay_theme.update', 'essay_theme', id, { changes: Object.keys(body) });
    res.json(theme);
  })
);

router.delete(
  '/themes/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const theme = await db.one('SELECT id, title FROM essay_themes WHERE id = $1', [id]);
    if (!theme) throw new AppError(404, 'not_found', 'Tema não encontrado.');
    const used = await db.one('SELECT count(*)::int AS total FROM essays WHERE theme_id = $1', [id]);
    if (used.total > 0) {
      throw new AppError(409, 'conflict', `Este tema já foi usado em ${used.total} redação(ões). Desative-o em vez de excluir.`, {
        essays: used.total,
      });
    }
    await db.query('DELETE FROM essay_themes WHERE id = $1', [id]);
    await audit(req, 'essay_theme.delete', 'essay_theme', id, { title: theme.title });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Rotas — critérios por prova
// ---------------------------------------------------------------------------
router.get(
  '/criteria/:examId',
  validate({ params: examParams }),
  wrap(async (req, res) => {
    const { examId } = req.valid.params;
    const exam = await db.one('SELECT id, name, short_name, board, track, has_essay, essay_max_score FROM exams WHERE id = $1', [examId]);
    if (!exam) throw new AppError(404, 'not_found', 'Prova não encontrada.');

    const row = await db.one(
      `SELECT id, exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines, active, updated_at
         FROM essay_criteria_sets WHERE exam_id = $1`,
      [examId]
    );

    const criteria = row && Array.isArray(row.criteria) ? row.criteria : [];
    const sum = Math.round(criteria.reduce((total, item) => total + (Number(item.max) || 0), 0) * 100) / 100;
    res.json({
      exam: { id: exam.id, name: exam.name, short_name: exam.short_name, board: exam.board, track: exam.track, has_essay: exam.has_essay },
      exists: Boolean(row),
      id: row ? row.id : null,
      name: row ? row.name : `Critérios de redação — ${exam.name}`,
      max_score: row ? Number(row.max_score) : Number(exam.essay_max_score),
      genre: row ? row.genre : 'Texto dissertativo-argumentativo',
      min_lines: row ? row.min_lines : null,
      max_lines: row ? row.max_lines : null,
      instructions: row ? row.instructions : null,
      active: row ? row.active : true,
      criteria,
      criteria_sum: sum,
      updated_at: row ? row.updated_at : null,
    });
  })
);

router.put(
  '/criteria/:examId',
  validate({ params: examParams, body: criteriaBody }),
  wrap(async (req, res) => {
    const { examId } = req.valid.params;
    const body = req.valid.body;
    const exam = await db.one('SELECT id, name FROM exams WHERE id = $1', [examId]);
    if (!exam) throw new AppError(404, 'not_found', 'Prova não encontrada.');

    const criteria = normalizeCriteria(body.criteria);
    const sum = Math.round(criteria.reduce((total, item) => total + item.max, 0) * 100) / 100;
    const maxScore = Math.round(Number(body.max_score) * 100) / 100;
    if (Math.abs(sum - maxScore) > SCORE_TOLERANCE) {
      throw new AppError(
        400,
        'validation_error',
        `A soma dos máximos dos critérios (${sum}) precisa ser igual à escala máxima da prova (${maxScore}).`,
        [{ path: 'criteria', message: `Soma atual: ${sum}. Esperado: ${maxScore}.` }]
      );
    }
    if (body.min_lines != null && body.max_lines != null && body.min_lines > body.max_lines) {
      throw new AppError(400, 'validation_error', 'O mínimo de linhas não pode ser maior que o máximo.', [
        { path: 'min_lines', message: 'Valor maior que o máximo de linhas.' },
      ]);
    }

    const saved = await db.one(
      `INSERT INTO essay_criteria_sets (exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (exam_id) DO UPDATE
          SET name = EXCLUDED.name, max_score = EXCLUDED.max_score, genre = EXCLUDED.genre,
              criteria = EXCLUDED.criteria, instructions = EXCLUDED.instructions,
              min_lines = EXCLUDED.min_lines, max_lines = EXCLUDED.max_lines, active = EXCLUDED.active,
              updated_at = now()
       RETURNING id, exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines, active, updated_at`,
      [
        examId, body.name, maxScore, body.genre || 'Texto dissertativo-argumentativo', JSON.stringify(criteria),
        body.instructions ?? null, body.min_lines ?? null, body.max_lines ?? null, body.active ?? true,
      ]
    );
    // a escala do vestibular acompanha a matriz cadastrada
    await db.query('UPDATE exams SET essay_max_score = $2 WHERE id = $1', [examId, maxScore]);

    await audit(req, 'essay_criteria.update', 'exam', examId, { criteria: criteria.length, max_score: maxScore });
    res.json({ ...saved, criteria_sum: sum, exists: true });
  })
);

// ---------------------------------------------------------------------------
// Rotas — redações enviadas
// ---------------------------------------------------------------------------
router.get(
  '/submissions',
  validate({ query: submissionsQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, SUBMISSION_SORTABLE, { defaultSort: 'created_at', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    // sem filtro de status, a lista mostra apenas o que já foi enviado (rascunhos ficam de fora)
    clauses.push(query.status ? `es.status = ${push(query.status)}` : "es.status <> 'draft'");
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(fe_unaccent(u.name) ILIKE fe_unaccent(${like}) OR u.email ILIKE ${like}
                     OR fe_unaccent(es.theme_title) ILIKE fe_unaccent(${like}))`);
    }
    if (query.exam_id) clauses.push(`es.exam_id = ${push(query.exam_id)}`);
    if (query.user_id) clauses.push(`es.user_id = ${push(query.user_id)}`);
    if (query.theme_id) clauses.push(`es.theme_id = ${push(query.theme_id)}`);
    if (query.from) clauses.push(`es.created_at >= ${push(query.from)}::timestamptz`);
    if (query.to) clauses.push(`es.created_at < (${push(query.to)}::timestamptz + interval '1 day')`);
    const where = `WHERE ${clauses.join(' AND ')}`;

    const [totalRow, items, summary] = await Promise.all([
      db.one(`SELECT count(*)::int AS total FROM essays es JOIN users u ON u.id = es.user_id ${where}`, params),
      db.many(
        `${SELECT_SUBMISSION} ${where} ORDER BY ${sort.sql} NULLS LAST, es.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.one(
        `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
                count(*) FILTER (WHERE status = 'corrected')::int AS corrected,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                round(avg(score) FILTER (WHERE status = 'corrected')::numeric, 1) AS avg_score
           FROM essays`
      ),
    ]);
    res.json({ ...paginate(items, totalRow.total, { page, limit }), summary });
  })
);

router.get(
  '/submissions/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const essay = await db.one(`${SELECT_SUBMISSION_FULL} WHERE es.id = $1`, [req.valid.params.id]);
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    const theme = essay.theme_id
      ? await db.one('SELECT id, title, prompt_text, source, year FROM essay_themes WHERE id = $1', [essay.theme_id])
      : null;
    essay.theme = theme;
    res.json(essay);
  })
);

module.exports = { basePath: '/api/admin/essays', router };

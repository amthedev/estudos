'use strict';

/**
 * Caderno de erros do aluno (error_notebook).
 *
 *   GET    /api/errors           filtros subject_id, topic_id, resolved (true|false), page, limit → paginado
 *                                item: questão, alternativa marcada, correta, explicação, datas, times_wrong, notes
 *   GET    /api/errors/summary   → { total, unresolved, resolved, by_subject[], by_topic[] }
 *   POST   /api/errors/redo      { ids?, subject_id?, topic_id?, limit = 10 } → questões sem gabarito (com error_id)
 *   PATCH  /api/errors/:id       { notes } → item atualizado
 *   DELETE /api/errors/:id       → { ok: true }
 *
 * O caderno mostra a alternativa correta e a explicação porque o aluno já respondeu (e errou) a questão;
 * o gabarito continua fora de GET /api/questions. Toda consulta filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { parsePagination, paginate } = require('../utils/pagination');
const questions = require('../services/questions');

router.use(requireStudent, requireAccess);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const boolFromQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no'].includes(normalized)) return false;
  return value;
}, z.boolean().optional());

const listQuerySchema = z.object({
  subject_id: uuid.optional(),
  topic_id: uuid.optional(),
  resolved: boolFromQuery,
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const redoSchema = z.object({
  ids: z.array(uuid).min(1).max(50).optional(),
  subject_id: uuid.optional(),
  topic_id: uuid.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const idParamsSchema = z.object({ id: uuid });

const notesSchema = z.object({
  notes: z.string().trim().max(2000).nullable(),
});

// ---------------------------------------------------------------------------
// SQL compartilhado
// ---------------------------------------------------------------------------
const OPTION_JSON = (alias) => `json_build_object('id', ${alias}.id, 'letter', ${alias}.letter, 'text', ${alias}.text)`;

const ITEM_SELECT = `
  SELECT e.id, e.question_id, e.subject_id, e.topic_id, e.wrong_option_id, e.times_wrong, e.resolved, e.resolved_at,
         e.notes, e.added_at, e.last_wrong_at,
         s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
         t.name AS topic_name, st.name AS subtopic_name, q.subtopic_id,
         q.statement, q.image_url, q.difficulty, q.year, q.board, q.explanation, q.resolution,
         ${questions.OPTIONS_SQL},
         (SELECT ${OPTION_JSON('wo')} FROM question_options wo WHERE wo.id = e.wrong_option_id) AS wrong_option,
         (SELECT ${OPTION_JSON('co')} FROM question_options co
           WHERE co.question_id = q.id AND co.is_correct ORDER BY co.sort_order, co.letter LIMIT 1) AS correct_option
    FROM error_notebook e
    JOIN questions q ON q.id = e.question_id AND q.active
    JOIN subjects s ON s.id = e.subject_id
    JOIN topics t ON t.id = e.topic_id
    LEFT JOIN subtopics st ON st.id = q.subtopic_id`;

/** Formato de saída de um item do caderno. */
function notebookItem(row) {
  if (!row) return null;
  const options = Array.isArray(row.options) ? row.options : [];
  return {
    id: row.id,
    question_id: row.question_id,
    subject_id: row.subject_id,
    subject_name: row.subject_name,
    subject_color: row.subject_color,
    subject_icon: row.subject_icon,
    topic_id: row.topic_id,
    topic_name: row.topic_name,
    subtopic_id: row.subtopic_id,
    subtopic_name: row.subtopic_name,
    times_wrong: row.times_wrong,
    resolved: row.resolved,
    resolved_at: row.resolved_at,
    notes: row.notes,
    added_at: row.added_at,
    last_wrong_at: row.last_wrong_at,
    question: {
      id: row.question_id,
      statement: row.statement,
      image_url: row.image_url,
      difficulty: row.difficulty,
      year: row.year,
      board: row.board,
      options: options.map((option) => ({ id: option.id, letter: option.letter, text: option.text })),
    },
    wrong_option: row.wrong_option || null,
    correct_option: row.correct_option || null,
    explanation: row.explanation,
    resolution: row.resolution,
  };
}

async function findItem(userId, id) {
  const row = await db.one(`${ITEM_SELECT} WHERE e.user_id = $1 AND e.id = $2`, [userId, id]);
  return notebookItem(row);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuerySchema }),
  wrap(async (req, res) => {
    const filters = req.valid.query;
    const { page, limit, offset } = parsePagination(filters, { defaultLimit: 20, maxLimit: 50 });

    const params = [req.user.id];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['e.user_id = $1', 'q.active'];
    if (filters.subject_id) where.push(`e.subject_id = ${add(filters.subject_id)}`);
    if (filters.topic_id) where.push(`e.topic_id = ${add(filters.topic_id)}`);
    if (filters.resolved !== undefined) where.push(`e.resolved = ${add(filters.resolved)}`);
    const whereSql = where.join(' AND ');

    const countRow = await db.one(
      `SELECT count(*)::int AS total FROM error_notebook e JOIN questions q ON q.id = e.question_id WHERE ${whereSql}`,
      params
    );
    const total = countRow ? countRow.total : 0;

    let items = [];
    if (total > 0 && offset < total) {
      const rows = await db.many(
        `${ITEM_SELECT}
          WHERE ${whereSql}
          ORDER BY e.resolved ASC, e.last_wrong_at DESC, e.id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      items = rows.map(notebookItem);
    }

    res.json(paginate(items, total, { page, limit }));
  })
);

router.get(
  '/summary',
  wrap(async (req, res) => {
    const userId = req.user.id;
    const [totals, bySubject, byTopic] = await Promise.all([
      db.one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE NOT e.resolved)::int AS unresolved,
                count(*) FILTER (WHERE e.resolved)::int AS resolved
           FROM error_notebook e JOIN questions q ON q.id = e.question_id AND q.active
          WHERE e.user_id = $1`,
        [userId]
      ),
      db.many(
        `SELECT s.id AS subject_id, s.name, s.color, s.icon,
                count(*)::int AS total,
                count(*) FILTER (WHERE NOT e.resolved)::int AS unresolved
           FROM error_notebook e
           JOIN questions q ON q.id = e.question_id AND q.active
           JOIN subjects s ON s.id = e.subject_id
          WHERE e.user_id = $1
          GROUP BY s.id
          ORDER BY unresolved DESC, total DESC, s.sort_order, s.name`,
        [userId]
      ),
      db.many(
        `SELECT t.id AS topic_id, t.name, t.subject_id, s.name AS subject_name,
                count(*)::int AS total,
                count(*) FILTER (WHERE NOT e.resolved)::int AS unresolved
           FROM error_notebook e
           JOIN questions q ON q.id = e.question_id AND q.active
           JOIN topics t ON t.id = e.topic_id
           JOIN subjects s ON s.id = t.subject_id
          WHERE e.user_id = $1
          GROUP BY t.id, s.id
          ORDER BY unresolved DESC, total DESC, s.sort_order, t.sort_order, t.name`,
        [userId]
      ),
    ]);
    res.json({
      total: totals ? totals.total : 0,
      unresolved: totals ? totals.unresolved : 0,
      resolved: totals ? totals.resolved : 0,
      by_subject: bySubject,
      by_topic: byTopic,
    });
  })
);

router.post(
  '/redo',
  validate({ body: redoSchema }),
  wrap(async (req, res) => {
    const { ids, subject_id: subjectId, topic_id: topicId } = req.valid.body;
    const limit = req.valid.body.limit || 10;

    const params = [req.user.id];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['e.user_id = $1', 'q.active'];
    if (ids && ids.length) where.push(`e.id = ANY(${add(ids)}::uuid[])`);
    if (subjectId) where.push(`e.subject_id = ${add(subjectId)}`);
    if (topicId) where.push(`e.topic_id = ${add(topicId)}`);

    const rows = await db.many(
      `SELECT ${questions.QUESTION_COLUMNS}, ${questions.NAME_COLUMNS}, ${questions.OPTIONS_SQL},
              e.id AS error_id, e.times_wrong, e.resolved
         FROM error_notebook e
         JOIN questions q ON q.id = e.question_id
         ${questions.BASE_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY e.resolved ASC, e.times_wrong DESC, e.last_wrong_at DESC
        LIMIT ${add(limit)}`,
      params
    );
    res.json(questions.shuffle(rows.map(questions.publicQuestion)));
  })
);

router.patch(
  '/:id',
  validate({ params: idParamsSchema, body: notesSchema }),
  wrap(async (req, res) => {
    const notes = req.valid.body.notes ? req.valid.body.notes : null;
    const updated = await db.one(
      `UPDATE error_notebook SET notes = $3 WHERE id = $2 AND user_id = $1 RETURNING id`,
      [req.user.id, req.valid.params.id, notes]
    );
    if (!updated) throw new AppError(404, 'not_found', 'Registro do caderno não encontrado.');
    const item = await findItem(req.user.id, updated.id);
    if (!item) throw new AppError(404, 'not_found', 'Registro do caderno não encontrado.');
    res.json(item);
  })
);

router.delete(
  '/:id',
  validate({ params: idParamsSchema }),
  wrap(async (req, res) => {
    const deleted = await db.one(
      'DELETE FROM error_notebook WHERE id = $2 AND user_id = $1 RETURNING id',
      [req.user.id, req.valid.params.id]
    );
    if (!deleted) throw new AppError(404, 'not_found', 'Registro do caderno não encontrado.');
    res.json({ ok: true, id: deleted.id });
  })
);

module.exports = { basePath: '/api/errors', router };

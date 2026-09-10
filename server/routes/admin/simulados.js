'use strict';

/**
 * Painel administrativo — simulados modelo.
 *
 *   GET    /api/admin/simulados       lista paginada (q, type, exam_id, subject_id, status, sort, dir)
 *   GET    /api/admin/simulados/:id   modelo + questões fixas (quando houver) + tentativas
 *   POST   /api/admin/simulados       { name, description?, type, exam_id?, subject_id?, topic_id?,
 *                                       duration_min?, question_count?, question_ids?[], active? }
 *   PUT    /api/admin/simulados/:id   edita (parcial)
 *   DELETE /api/admin/simulados/:id
 *
 * `question_ids` vazio = as questões são sorteadas na hora pelo services/simulados.js a partir do
 * tipo e dos filtros; com a lista preenchida, o simulado usa exatamente essas questões, na ordem.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { MAX_QUESTIONS, MAX_DURATION } = require('../../services/simulados');

const TYPES = ['exam', 'subject', 'topic', 'custom'];

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableUuid = z.preprocess(emptyToNull, uuid.nullable().optional());

const createBody = z.object({
  name: z.string().trim().min(3, 'Informe o nome do simulado.').max(160),
  description: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
  type: z.enum(TYPES, { errorMap: () => ({ message: `Tipo inválido. Opções: ${TYPES.join(', ')}.` }) }),
  exam_id: nullableUuid,
  subject_id: nullableUuid,
  topic_id: nullableUuid,
  duration_min: z.coerce.number().int().min(5).max(MAX_DURATION).optional(),
  question_count: z.coerce.number().int().min(1).max(MAX_QUESTIONS).optional(),
  question_ids: z.array(uuid).max(MAX_QUESTIONS).optional(),
  active: z.boolean().optional(),
});
const updateBody = createBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(160).optional(),
  type: z.preprocess(emptyToUndefined, z.enum(TYPES).optional()),
  exam_id: z.preprocess(emptyToUndefined, uuid.optional()),
  subject_id: z.preprocess(emptyToUndefined, uuid.optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SORTABLE = {
  name: 'sm.name',
  type: 'sm.type',
  created_at: 'sm.created_at',
  updated_at: 'sm.updated_at',
  duration_min: 'sm.duration_min',
  question_count: 'sm.question_count',
};

const SELECT_SIMULADO = `
  SELECT sm.id, sm.name, sm.description, sm.type, sm.exam_id, sm.subject_id, sm.topic_id,
         sm.duration_min, sm.question_count, sm.question_ids, sm.config, sm.active,
         sm.created_at, sm.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name,
         s.name AS subject_name, s.color AS subject_color, t.name AS topic_name,
         coalesce(array_length(sm.question_ids, 1), 0) AS fixed_questions_count,
         (SELECT count(*)::int FROM simulado_attempts sa WHERE sa.simulado_id = sm.id) AS attempts_count
    FROM simulados sm
    LEFT JOIN exams e ON e.id = sm.exam_id
    LEFT JOIN subjects s ON s.id = sm.subject_id
    LEFT JOIN topics t ON t.id = sm.topic_id`;

const WRITABLE = ['name', 'description', 'type', 'exam_id', 'subject_id', 'topic_id', 'duration_min',
  'question_count', 'question_ids', 'active'];

/** Coerência entre o tipo do simulado e as referências informadas. */
function assertTypeReferences(data) {
  const required = { exam: 'exam_id', subject: 'subject_id', topic: 'topic_id' }[data.type];
  if (required && !data[required]) {
    const labels = { exam_id: 'a prova', subject_id: 'a matéria', topic_id: 'o assunto' };
    throw new AppError(400, 'validation_error', `Para este tipo de simulado, informe ${labels[required]}.`, [
      { path: required, message: 'Campo obrigatório para o tipo escolhido.' },
    ]);
  }
}

/** Confere existência das referências e das questões fixas. */
async function assertReferences(data) {
  const checks = [
    ['exam_id', 'exams', 'Prova não encontrada.'],
    ['subject_id', 'subjects', 'Matéria não encontrada.'],
    ['topic_id', 'topics', 'Assunto não encontrado.'],
  ];
  for (const [field, table, message] of checks) {
    if (!data[field]) continue;
    const row = await db.one(`SELECT id FROM ${table} WHERE id = $1`, [data[field]]);
    if (!row) throw new AppError(400, 'validation_error', message, [{ path: field, message }]);
  }
  if (data.topic_id && data.subject_id) {
    const topic = await db.one('SELECT subject_id FROM topics WHERE id = $1', [data.topic_id]);
    if (topic && topic.subject_id !== data.subject_id) {
      throw new AppError(400, 'validation_error', 'O assunto não pertence à matéria selecionada.', [
        { path: 'topic_id', message: 'Assunto de outra matéria.' },
      ]);
    }
  }
  if (Array.isArray(data.question_ids) && data.question_ids.length) {
    const ids = Array.from(new Set(data.question_ids));
    const rows = await db.many('SELECT id FROM questions WHERE id = ANY($1::uuid[])', [ids]);
    if (rows.length !== ids.length) {
      throw new AppError(400, 'validation_error', 'Uma ou mais questões selecionadas não existem.', [
        { path: 'question_ids', message: 'Questão não encontrada.' },
      ]);
    }
  }
}

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, SORTABLE, { defaultSort: 'created_at', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) clauses.push(`fe_unaccent(sm.name) ILIKE fe_unaccent(${push(`%${query.q}%`)})`);
    if (query.type) clauses.push(`sm.type = ${push(query.type)}`);
    if (query.exam_id) clauses.push(`sm.exam_id = ${push(query.exam_id)}`);
    if (query.subject_id) clauses.push(`sm.subject_id = ${push(query.subject_id)}`);
    if (query.status) clauses.push(`sm.active = ${push(query.status === 'active')}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await db.one(`SELECT count(*)::int AS total FROM simulados sm ${where}`, params);
    const items = await db.many(
      `${SELECT_SIMULADO} ${where} ORDER BY ${sort.sql}, sm.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json(paginate(items, totalRow.total, { page, limit }));
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const simulado = await db.one(`${SELECT_SIMULADO} WHERE sm.id = $1`, [req.valid.params.id]);
    if (!simulado) throw new AppError(404, 'not_found', 'Simulado não encontrado.');

    simulado.questions = [];
    if (Array.isArray(simulado.question_ids) && simulado.question_ids.length) {
      simulado.questions = await db.many(
        `SELECT q.id, left(q.statement, 240) AS excerpt, q.difficulty, q.year, q.board,
                s.name AS subject_name, t.name AS topic_name, q.active
           FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
           JOIN questions q ON q.id = o.id
           JOIN subjects s ON s.id = q.subject_id
           JOIN topics t ON t.id = q.topic_id
          ORDER BY o.position`,
        [simulado.question_ids]
      );
    }
    simulado.attempts = await db.many(
      `SELECT sa.id, sa.user_id, u.name AS user_name, sa.status, sa.score, sa.correct_count,
              sa.wrong_count, sa.blank_count, sa.started_at, sa.finished_at
         FROM simulado_attempts sa JOIN users u ON u.id = sa.user_id
        WHERE sa.simulado_id = $1
        ORDER BY sa.started_at DESC LIMIT 20`,
      [simulado.id]
    );
    res.json(simulado);
  })
);

router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    assertTypeReferences(body);
    await assertReferences(body);

    const questionIds = Array.from(new Set(body.question_ids || []));
    const created = await db.one(
      `INSERT INTO simulados (name, description, type, exam_id, subject_id, topic_id, duration_min,
                              question_count, question_ids, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11) RETURNING id`,
      [
        body.name, body.description ?? null, body.type, body.exam_id ?? null, body.subject_id ?? null,
        body.topic_id ?? null, body.duration_min ?? 60,
        body.question_count ?? (questionIds.length || 20), questionIds,
        body.active ?? true, req.admin ? req.admin.id : null,
      ]
    );
    const simulado = await db.one(`${SELECT_SIMULADO} WHERE sm.id = $1`, [created.id]);
    await audit(req, 'simulado.create', 'simulado', created.id, { name: body.name, type: body.type });
    res.status(201).json(simulado);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT * FROM simulados WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Simulado não encontrado.');

    const merged = {
      type: body.type ?? current.type,
      exam_id: body.exam_id === undefined ? current.exam_id : body.exam_id,
      subject_id: body.subject_id === undefined ? current.subject_id : body.subject_id,
      topic_id: body.topic_id === undefined ? current.topic_id : body.topic_id,
      question_ids: body.question_ids === undefined ? current.question_ids : Array.from(new Set(body.question_ids)),
    };
    assertTypeReferences(merged);
    await assertReferences(merged);

    const fields = { ...body, ...merged };
    const sets = [];
    const params = [];
    for (const key of WRITABLE) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      params.push(fields[key]);
      sets.push(key === 'question_ids' ? `${key} = $${params.length}::uuid[]` : `${key} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE simulados SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const simulado = await db.one(`${SELECT_SIMULADO} WHERE sm.id = $1`, [id]);
    await audit(req, 'simulado.update', 'simulado', id, { changes: Object.keys(body) });
    res.json(simulado);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const simulado = await db.one('SELECT id, name FROM simulados WHERE id = $1', [id]);
    if (!simulado) throw new AppError(404, 'not_found', 'Simulado não encontrado.');
    await db.query('DELETE FROM simulados WHERE id = $1', [id]);
    await audit(req, 'simulado.delete', 'simulado', id, { name: simulado.name });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/simulados', router };

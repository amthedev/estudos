'use strict';

/**
 * Banco de questões do aluno.
 *
 *   GET  /api/questions            filtros exam_id, subject_id, topic_id, subtopic_id, difficulty, year, board,
 *                                  q, status (answered|unanswered|wrong), page, limit → paginado, sem gabarito
 *   GET  /api/questions/filters    → { years[], boards[], difficulties[], subjects[], topics[], subtopics[] }
 *   GET  /api/questions/:id        → questão com alternativas (sem gabarito)
 *   POST /api/questions/:id/answer { option_id, context, context_id?, time_spent_sec? }
 *                                  → { is_correct, correct_option_id, resolution, explanation, attempt_id }
 *   POST /api/questions/generate   { topic_id? , subject_id?, exam_id?, difficulty? }
 *                                  elabora questões do recorte quando o banco não tem nenhuma
 *   POST /api/questions/:id/report { reason, comment? } → 201
 *                                  avisa que a questão tem problema (gabarito, enunciado, alternativas…)
 *
 * O gabarito (is_correct, resolution, explanation) só sai na resposta do POST /answer.
 * Toda leitura de dados do aluno (último resultado, tentativas) filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { parsePagination, paginate } = require('../utils/pagination');
const questions = require('../services/questions');
const questionAi = require('../services/question-ai');
const { aiLimiter } = require('../middleware/rateLimit');

router.use(requireStudent, requireAccess);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const optionalUuid = uuid.optional();
const optionalInt = (min, max) => z.coerce.number().int().min(min).max(max).optional();

const listQuerySchema = z.object({
  exam_id: optionalUuid,
  subject_id: optionalUuid,
  topic_id: optionalUuid,
  subtopic_id: optionalUuid,
  difficulty: optionalInt(1, 3),
  year: optionalInt(1900, 2100),
  board: z.string().trim().max(80).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['answered', 'unanswered', 'wrong']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const idParamsSchema = z.object({ id: uuid });

/**
 * Chamado do aluno sobre uma questão.
 *
 * Existe por causa de uma decisão tomada de olhos abertos: a questão elaborada
 * pela IA entra ativa no banco, sem esperar conferência — esconder a questão
 * faria o erro do aluno sumir do caderno dele. O preço é que um gabarito errado
 * pode chegar antes de alguém olhar. Este é o canal de volta.
 */
const reportSchema = z
  .object({
    reason: z.enum(['gabarito', 'enunciado', 'alternativas', 'assunto', 'outro'], {
      errorMap: () => ({ message: 'Escolha o que está errado na questão.' }),
    }),
    comment: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().max(1000).optional()
    ),
  })
  .strict();

/**
 * Pedido de questões novas a partir do banco vazio.
 *
 * O combinado com o cliente: "a IA pega lá do banco de questões e, caso não
 * tiver no banco, ela gera ela mesma". Aqui é o "ela gera": o aluno filtrou,
 * não veio nada, e pede para a IA elaborar daquele recorte. O teto diário por
 * aluno é o mesmo da prática pós-aula.
 */
const generateSchema = z
  .object({
    topic_id: optionalUuid,
    subject_id: optionalUuid,
    exam_id: optionalUuid,
    difficulty: z.coerce.number().int().min(1).max(3).optional(),
  })
  .strict()
  .refine((body) => body.topic_id || body.subject_id, {
    message: 'Escolha ao menos uma matéria para a IA elaborar as questões.',
    path: ['subject_id'],
  });

const answerSchema = z.object({
  option_id: uuid,
  context: z.enum(['practice', 'bank', 'review', 'errors_redo']),
  context_id: uuid.nullable().optional(),
  time_spent_sec: z.number().int().min(0).max(24 * 60 * 60).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escapa curingas do LIKE para a busca por texto livre. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
}

/** Resultado da última tentativa do aluno (sub-consulta lateral, alias la). */
const LAST_ATTEMPT_JOIN = (userParam) => `
  LEFT JOIN LATERAL (
    SELECT a.is_correct, a.answered_at
      FROM question_attempts a
     WHERE a.user_id = ${userParam} AND a.question_id = q.id
     ORDER BY a.answered_at DESC
     LIMIT 1
  ) la ON true`;

const USER_COLUMNS = (userParam) => `
  CASE WHEN la.is_correct IS NULL THEN NULL WHEN la.is_correct THEN 'correct' ELSE 'wrong' END AS user_last_result,
  (SELECT count(*)::int FROM question_attempts a WHERE a.user_id = ${userParam} AND a.question_id = q.id) AS user_attempts,
  (SELECT e.id FROM error_notebook e WHERE e.user_id = ${userParam} AND e.question_id = q.id AND NOT e.resolved) AS error_id`;

/** Monta FROM/WHERE compartilhados entre a contagem e a listagem. */
function buildListQuery(userId, filters) {
  const params = [userId];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['q.active'];

  if (filters.subject_id) where.push(`q.subject_id = ${add(filters.subject_id)}`);
  if (filters.topic_id) where.push(`q.topic_id = ${add(filters.topic_id)}`);
  if (filters.subtopic_id) where.push(`q.subtopic_id = ${add(filters.subtopic_id)}`);
  if (filters.difficulty) where.push(`q.difficulty = ${add(filters.difficulty)}`);
  if (filters.year) where.push(`q.year = ${add(filters.year)}`);
  if (filters.board) where.push(`lower(q.board) = lower(${add(filters.board)})`);
  if (filters.exam_id) {
    const p = add(filters.exam_id);
    where.push(`(q.source_exam_id = ${p} OR EXISTS (SELECT 1 FROM question_exams qe WHERE qe.question_id = q.id AND qe.exam_id = ${p}))`);
  }
  if (filters.q) {
    // Busca textual sem acento; o ILIKE cobre termos que o dicionário não indexa
    // (siglas, números).
    //
    // Os nomes da matéria, do assunto e do subassunto entram junto porque é
    // assim que o aluno procura: ele digita "Porcentagem", não uma palavra que
    // esteja dentro do enunciado. O índice de texto cobre só o enunciado, então
    // procurar pelo assunto devolvia zero — exatamente o contrário do que a
    // tela promete ao chamar o campo de "assunto, palavra do enunciado…".
    const term = add(filters.q);
    const pattern = add(likePattern(filters.q));
    where.push(`(
      q.search_vector @@ plainto_tsquery('portuguese', fe_unaccent(${term}))
      OR fe_unaccent(q.statement) ILIKE fe_unaccent(${pattern})
      OR fe_unaccent(s.name) ILIKE fe_unaccent(${pattern})
      OR fe_unaccent(t.name) ILIKE fe_unaccent(${pattern})
      OR fe_unaccent(st.name) ILIKE fe_unaccent(${pattern})
    )`);
  }
  if (filters.status === 'answered') where.push('la.is_correct IS NOT NULL');
  else if (filters.status === 'unanswered') where.push('la.is_correct IS NULL');
  else if (filters.status === 'wrong') where.push('la.is_correct = false');

  const from = `FROM questions q ${questions.BASE_JOINS} ${LAST_ATTEMPT_JOIN('$1')} WHERE ${where.join(' AND ')}`;
  return { from, params };
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
    const { from, params } = buildListQuery(req.user.id, filters);

    const countRow = await db.one(`SELECT count(*)::int AS total ${from}`, params);
    const total = countRow ? countRow.total : 0;

    let items = [];
    if (total > 0 && offset < total) {
      const rows = await db.many(
        `SELECT ${questions.QUESTION_COLUMNS}, ${questions.NAME_COLUMNS}, ${questions.OPTIONS_SQL}, ${USER_COLUMNS('$1')}
         ${from}
         ORDER BY s.sort_order, s.name, t.sort_order, t.name, q.difficulty, q.created_at DESC, q.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      items = rows.map(questions.publicQuestion);
    }

    res.json(paginate(items, total, { page, limit }));
  })
);

router.get(
  '/filters',
  wrap(async (req, res) => {
    const [years, boards, difficulties, subjects, topics, subtopics] = await Promise.all([
      db.many(`SELECT DISTINCT year FROM questions WHERE active AND year IS NOT NULL ORDER BY year DESC`),
      db.many(`SELECT DISTINCT board FROM questions WHERE active AND board IS NOT NULL AND board <> '' ORDER BY board`),
      db.many(`SELECT difficulty, count(*)::int AS total FROM questions WHERE active GROUP BY difficulty ORDER BY difficulty`),
      db.many(
        `SELECT s.id, s.name, s.color, s.icon, count(*)::int AS total
           FROM questions q JOIN subjects s ON s.id = q.subject_id
          WHERE q.active AND s.active
          GROUP BY s.id ORDER BY s.sort_order, s.name`
      ),
      db.many(
        `SELECT t.id, t.subject_id, t.name, count(*)::int AS total
           FROM questions q JOIN topics t ON t.id = q.topic_id
          WHERE q.active AND t.active
          GROUP BY t.id ORDER BY t.sort_order, t.name`
      ),
      db.many(
        `SELECT st.id, st.topic_id, st.name, count(*)::int AS total
           FROM questions q JOIN subtopics st ON st.id = q.subtopic_id
          WHERE q.active AND st.active
          GROUP BY st.id ORDER BY st.sort_order, st.name`
      ),
    ]);
    res.json({
      years: years.map((row) => row.year),
      boards: boards.map((row) => row.board),
      difficulties: difficulties.map((row) => row.difficulty),
      subjects,
      topics,
      subtopics,
    });
  })
);

router.get(
  '/:id',
  validate({ params: idParamsSchema }),
  wrap(async (req, res) => {
    const row = await db.one(
      `SELECT ${questions.QUESTION_COLUMNS}, ${questions.NAME_COLUMNS}, ${questions.OPTIONS_SQL}, ${USER_COLUMNS('$1')},
              COALESCE((
                SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'short_name', e.short_name) ORDER BY e.sort_order)
                  FROM question_exams qe JOIN exams e ON e.id = qe.exam_id
                 WHERE qe.question_id = q.id AND e.active
              ), '[]'::json) AS exams
         FROM questions q ${questions.BASE_JOINS} ${LAST_ATTEMPT_JOIN('$1')}
        WHERE q.id = $2 AND q.active`,
      [req.user.id, req.valid.params.id]
    );
    if (!row) throw new AppError(404, 'not_found', 'Questão não encontrada.');
    res.json(questions.publicQuestion(row));
  })
);

router.post(
  '/:id/answer',
  validate({ params: idParamsSchema, body: answerSchema }),
  wrap(async (req, res) => {
    const { option_id: optionId, context, context_id: contextId, time_spent_sec: timeSpentSec } = req.valid.body;
    const result = await questions.gradeAnswer({
      userId: req.user.id,
      questionId: req.valid.params.id,
      optionId,
      context,
      contextId: contextId || null,
      timeSpentSec: timeSpentSec ?? null,
    });
    res.status(201).json(result);
  })
);

/** Quantas questões a IA elabora de uma vez para o banco do aluno. */
const GERAR_POR_VEZ = 5;

router.post(
  '/generate',
  aiLimiter,
  validate({ body: generateSchema }),
  wrap(async (req, res) => {
    const { topic_id: topicId, subject_id: subjectId, exam_id: examId, difficulty } = req.valid.body;

    // Quem espera aqui é uma tela com o botão girando, atrás de uma borda que
    // corta a requisição perto dos 100 segundos. A elaboração tem que caber
    // nesse tempo e parar sozinha se o aluno desistir — antes disso, um clique
    // podia deixar a IA trabalhando por mais de uma hora para ninguém.
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    let criadas;
    try {
      criadas = await questionAi.fillPool({
        examId: examId || null,
        subjectId: topicId ? null : subjectId || null,
        topicId: topicId || null,
        difficulty: questionAi.difficultyOf(difficulty),
        count: GERAR_POR_VEZ,
        userId: req.user.id,
        prazoMs: questionAi.PRAZO_INTERATIVO_MS,
        timeoutMs: questionAi.TIMEOUT_INTERATIVO_MS,
        signal: controller.signal,
      });
    } finally {
      res.off('close', onClose);
    }

    if (controller.signal.aborted) return;

    if (!criadas.length) {
      throw new AppError(
        503,
        'ai_unavailable',
        'A IA não conseguiu elaborar questões deste assunto agora. Tente de novo em instantes ou escolha outro recorte.'
      );
    }

    const lista = await questions.getQuestionsByIds(criadas.map((q) => q.id));
    res.status(201).json({ questions: lista, generated: lista.length });
  })
);

router.post(
  '/:id/report',
  validate({ params: idParamsSchema, body: reportSchema }),
  wrap(async (req, res) => {
    const questionId = req.valid.params.id;
    const existe = await db.one('SELECT id FROM questions WHERE id = $1 AND active', [questionId]);
    if (!existe) throw new AppError(404, 'not_found', 'Questão não encontrada.');

    const { reason, comment } = req.valid.body;
    // Um aluno, um chamado por questão: reclamar de novo atualiza o que ele
    // disse em vez de encher a fila do painel com a mesma questão.
    const row = await db.one(
      `INSERT INTO question_reports (question_id, user_id, reason, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (question_id, user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET reason = EXCLUDED.reason,
                       comment = EXCLUDED.comment,
                       status = 'aberto',
                       resolved_at = NULL,
                       created_at = now()
       RETURNING id, reason, created_at`,
      [questionId, req.user.id, reason, comment ?? null]
    );
    res.status(201).json({ ...row, message: 'Obrigado. A equipe vai conferir esta questão.' });
  })
);

module.exports = { basePath: '/api/questions', router };

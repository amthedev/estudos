'use strict';

/**
 * Revisões espaçadas (ARCHITECTURE §5).
 *
 *   const reviews = require('../services/reviews');
 *   await reviews.scheduleReviews(userId, { topicId, lessonId });   // cria +1/+7/+30 (review_intervals)
 *   await reviews.getDueReviews(userId, { date });                   // pendentes com due_date <= data
 *   await reviews.listReviews(userId, { status, from, to });
 *   await reviews.completeReview(userId, reviewId, { score });       // grava score, marca item, study_log
 *   await reviews.skipReview(userId, reviewId);
 *   await reviews.getReviewQuestions(userId, reviewId);              // 5 questões do assunto (sem gabarito)
 *
 * Toda consulta filtra por user_id. Ao criar revisões o cronograma é recalculado a partir de amanhã
 * (a revisão de +1 dia entra automaticamente no próximo dia de estudo).
 */
const db = require('../db/pool');
const { getSetting } = require('./settings');
const dates = require('../utils/dates');

const DEFAULT_INTERVALS = [1, 7, 30];
const DEFAULT_REVIEW_MIN = 15;
const REVIEW_QUESTION_COUNT = 5;

const REVIEW_COLUMNS = `
  r.id, r.topic_id, r.lesson_id, r.stage, r.due_date, r.status, r.score, r.completed_at, r.created_at,
  t.name AS topic_name, t.subject_id, s.name AS subject_name, s.color AS subject_color,
  l.title AS lesson_title, l.thumbnail_url AS lesson_thumbnail_url`;

const REVIEW_FROM = `
  FROM reviews r
  JOIN topics t ON t.id = r.topic_id
  JOIN subjects s ON s.id = t.subject_id
  LEFT JOIN lessons l ON l.id = r.lesson_id`;

function normalizeIntervals(value) {
  const list = Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  const unique = [...new Set(list)].sort((a, b) => a - b).slice(0, 3);
  return unique.length === 3 ? unique : DEFAULT_INTERVALS;
}

async function getIntervals() {
  return normalizeIntervals(await getSetting('review_intervals', DEFAULT_INTERVALS));
}

async function getReviewMinutes() {
  const defaults = (await getSetting('schedule_defaults')) || {};
  const value = Number(defaults.review_block_min);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_REVIEW_MIN;
}

/** Recalcula o cronograma a partir de amanhã sem derrubar a operação principal. */
async function regenerateSafely(userId) {
  try {
    // require tardio: schedule.js também depende deste módulo
    const schedule = require('./schedule');
    await schedule.regenerateFromTomorrow(userId);
    return true;
  } catch (err) {
    console.error('[reviews] falha ao recalcular o cronograma:', err.message);
    return false;
  }
}

/**
 * Cria as revisões de um assunto/aula (estágios 1, 2 e 3) sem duplicar.
 * @returns {Promise<{ created: object[], existing: number, reviews: object[] }>}
 */
async function scheduleReviews(userId, { topicId, lessonId = null, from, regenerate = true } = {}) {
  if (!topicId) {
    const lesson = lessonId ? await db.one('SELECT topic_id FROM lessons WHERE id = $1', [lessonId]) : null;
    if (!lesson) throw new Error('scheduleReviews exige topicId (ou lessonId de uma aula existente).');
    topicId = lesson.topic_id;
  }
  const intervals = await getIntervals();
  const base = dates.toISODate(from) || dates.todayISO();

  const existing = lessonId
    ? await db.many('SELECT id, stage, status FROM reviews WHERE user_id = $1 AND lesson_id = $2', [userId, lessonId])
    : await db.many(
        `SELECT id, stage, status FROM reviews
          WHERE user_id = $1 AND topic_id = $2 AND lesson_id IS NULL AND status = 'pending'`,
        [userId, topicId]
      );
  const existingStages = new Set(existing.map((row) => Number(row.stage)));

  const created = [];
  await db.tx(async (client) => {
    for (let index = 0; index < intervals.length; index += 1) {
      const stage = index + 1;
      if (existingStages.has(stage)) continue;
      const row = await client.one(
        `INSERT INTO reviews (user_id, topic_id, lesson_id, stage, due_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [userId, topicId, lessonId, stage, dates.addDays(base, intervals[index])]
      );
      if (row) created.push(row);
    }
  });

  if (created.length > 0 && regenerate) await regenerateSafely(userId);

  const reviews = await db.many(
    `SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM}
      WHERE r.user_id = $1 AND r.topic_id = $2 AND ($3::uuid IS NULL OR r.lesson_id = $3)
      ORDER BY r.stage`,
    [userId, topicId, lessonId]
  );
  return { created, existing: existing.length, reviews };
}

/** Revisões pendentes vencidas ou do dia (due_date <= date). */
async function getDueReviews(userId, { date } = {}) {
  const day = dates.toISODate(date) || dates.todayISO();
  return db.many(
    `SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM}
      WHERE r.user_id = $1 AND r.status = 'pending' AND r.due_date <= $2
      ORDER BY r.due_date ASC, r.created_at ASC`,
    [userId, day]
  );
}

/**
 * Lista revisões do aluno.
 * status: 'pending' | 'done' | 'skipped' | 'all' (padrão pending). from/to filtram due_date.
 */
async function listReviews(userId, { status = 'pending', from, to, limit = 200 } = {}) {
  const params = [userId];
  const where = ['r.user_id = $1'];
  if (status && status !== 'all') {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`r.due_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`r.due_date <= $${params.length}`);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 200)));
  const order = status === 'done' || status === 'skipped' ? 'r.completed_at DESC NULLS LAST, r.due_date DESC' : 'r.due_date ASC, r.created_at ASC';
  return db.many(`SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params);
}

/** Contadores para as abas da tela de revisões. */
async function getCounts(userId) {
  const today = dates.todayISO();
  const row = await db.one(
    `SELECT
       count(*) FILTER (WHERE status = 'pending' AND due_date < $2)::int AS overdue,
       count(*) FILTER (WHERE status = 'pending' AND due_date = $2)::int AS today,
       count(*) FILTER (WHERE status = 'pending' AND due_date > $2 AND due_date <= $3)::int AS upcoming,
       count(*) FILTER (WHERE status = 'done')::int AS done,
       count(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM reviews WHERE user_id = $1`,
    [userId, today, dates.addDays(today, 7)]
  );
  return {
    overdue: Number(row ? row.overdue : 0),
    today: Number(row ? row.today : 0),
    upcoming: Number(row ? row.upcoming : 0),
    done: Number(row ? row.done : 0),
    pending: Number(row ? row.pending : 0),
  };
}

async function findReview(userId, reviewId) {
  return db.one(`SELECT ${REVIEW_COLUMNS} ${REVIEW_FROM} WHERE r.user_id = $1 AND r.id = $2`, [userId, reviewId]);
}

/**
 * Conclui a revisão: grava score, marca o item de cronograma ligado como concluído e registra study_log.
 * @returns {Promise<object|null>} revisão atualizada (null se não existir para o aluno)
 */
async function completeReview(userId, reviewId, { score = null } = {}) {
  const review = await findReview(userId, reviewId);
  if (!review) return null;
  const minutes = await getReviewMinutes();
  const today = dates.todayISO();
  const scoreValue = score === null || score === undefined ? null : Math.max(0, Math.min(100, Math.round(Number(score) * 100) / 100));

  await db.tx(async (client) => {
    await client.query(
      `UPDATE reviews SET status = 'done', score = $3, completed_at = now() WHERE id = $1 AND user_id = $2`,
      [reviewId, userId, scoreValue]
    );
    const items = await client.many(
      `UPDATE schedule_items SET status = 'done', completed_at = now()
        WHERE user_id = $1 AND review_id = $2 AND status <> 'done'
        RETURNING id`,
      [userId, reviewId]
    );
    if (review.status !== 'done') {
      await client.query(
        `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
         VALUES ($1, 'review', $2, $3, $4, $5)`,
        [userId, reviewId, review.subject_id, minutes, today]
      );
    }
    return items;
  });

  return findReview(userId, reviewId);
}

/** Pula a revisão (status skipped) e o item de cronograma ligado. */
async function skipReview(userId, reviewId) {
  const review = await findReview(userId, reviewId);
  if (!review) return null;
  await db.tx(async (client) => {
    await client.query(`UPDATE reviews SET status = 'skipped', completed_at = now() WHERE id = $1 AND user_id = $2`, [reviewId, userId]);
    await client.query(
      `UPDATE schedule_items SET status = 'skipped' WHERE user_id = $1 AND review_id = $2 AND status = 'pending'`,
      [userId, reviewId]
    );
  });
  return findReview(userId, reviewId);
}

/** Questões do assunto sem gabarito (fallback quando o módulo de questões não está disponível). */
async function pickQuestionsFallback(userId, { topicId, subtopicId = null, limit = REVIEW_QUESTION_COUNT }) {
  const questions = await db.many(
    `SELECT q.id, q.statement, q.image_url, q.difficulty, q.year, q.board, q.subject_id, q.topic_id, q.subtopic_id,
            s.name AS subject_name, t.name AS topic_name,
            (SELECT max(answered_at) FROM question_attempts qa WHERE qa.user_id = $1 AND qa.question_id = q.id) AS last_answered_at
       FROM questions q
       JOIN subjects s ON s.id = q.subject_id
       JOIN topics t ON t.id = q.topic_id
      WHERE q.active AND q.topic_id = $2
      ORDER BY (q.subtopic_id = $3) DESC NULLS LAST, last_answered_at ASC NULLS FIRST, q.difficulty ASC, q.created_at ASC
      LIMIT $4`,
    [userId, topicId, subtopicId, limit]
  );
  if (questions.length === 0) return [];
  const options = await db.many(
    `SELECT id, question_id, letter, text, sort_order FROM question_options
      WHERE question_id = ANY($1::uuid[]) ORDER BY question_id, sort_order, letter`,
    [questions.map((q) => q.id)]
  );
  const byQuestion = new Map();
  for (const option of options) {
    if (!byQuestion.has(option.question_id)) byQuestion.set(option.question_id, []);
    byQuestion.get(option.question_id).push({ id: option.id, letter: option.letter, text: option.text });
  }
  return questions.map(({ last_answered_at, ...question }) => ({ ...question, options: byQuestion.get(question.id) || [] }));
}

function looksLikeQuestionList(value) {
  return Array.isArray(value) && value.every((q) => q && q.id && Array.isArray(q.options));
}

/**
 * Questões para a revisão (5 do assunto; prioriza o subassunto da aula).
 * Usa routes/questions.pickQuestions quando existir; senão consulta direta (sem gabarito).
 */
async function getReviewQuestions(userId, reviewId) {
  const review = await findReview(userId, reviewId);
  if (!review) return null;
  let subtopicId = null;
  if (review.lesson_id) {
    const lesson = await db.one('SELECT subtopic_id FROM lessons WHERE id = $1', [review.lesson_id]);
    subtopicId = lesson ? lesson.subtopic_id : null;
  }
  let questions = null;
  try {
    // módulo de outro time: assinatura pode variar; validamos o resultado antes de usar
    const questionsRoute = require('../routes/questions');
    if (questionsRoute && typeof questionsRoute.pickQuestions === 'function') {
      const picked = await questionsRoute.pickQuestions(userId, {
        topicId: review.topic_id,
        topic_id: review.topic_id,
        subtopicId,
        subtopic_id: subtopicId,
        limit: REVIEW_QUESTION_COUNT,
        count: REVIEW_QUESTION_COUNT,
        context: 'review',
      });
      const list = Array.isArray(picked) ? picked : picked && Array.isArray(picked.items) ? picked.items : picked && Array.isArray(picked.questions) ? picked.questions : null;
      if (looksLikeQuestionList(list)) {
        questions = list.slice(0, REVIEW_QUESTION_COUNT).map((q) => ({
          ...q,
          options: q.options.map(({ is_correct, ...option }) => option),
        }));
      }
    }
  } catch (err) {
    if (!/Cannot find module/.test(err.message)) console.warn('[reviews] pickQuestions indisponível, usando fallback:', err.message);
  }
  if (!questions || questions.length === 0) {
    questions = await pickQuestionsFallback(userId, { topicId: review.topic_id, subtopicId });
  }
  return { review, questions };
}

module.exports = {
  scheduleReviews,
  getDueReviews,
  listReviews,
  getCounts,
  findReview,
  completeReview,
  skipReview,
  getReviewQuestions,
  getIntervals,
  getReviewMinutes,
  REVIEW_QUESTION_COUNT,
};

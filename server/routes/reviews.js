'use strict';

/**
 * Revisões espaçadas do aluno (ARCHITECTURE §4 "cronograma / revisões", §5).
 *
 *   GET  /api/reviews?status=pending|done|skipped|all&from&to → { items, counts, today }
 *   GET  /api/reviews/:id/questions                          → { review, questions } (5 questões do assunto)
 *   POST /api/reviews/:id/complete { score?, correct?, total? }
 *   POST /api/reviews/:id/skip
 *
 * As revisões são criadas ao concluir uma aula (services/reviews.scheduleReviews) e entram
 * automaticamente no cronograma. Todas as consultas filtram por user_id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const reviews = require('../services/reviews');
const questions = require('../services/questions');
const { isISODate, todayISO } = require('../utils/dates');

router.use(requireStudent, requireAccess);

const isoDate = z.string().refine(isISODate, { message: 'Data inválida (use AAAA-MM-DD).' });
const idParams = z.object({ id: z.string().uuid() });

const listQuery = z
  .object({
    status: z.enum(['pending', 'done', 'skipped', 'all']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .passthrough();

const completeBody = z
  .object({
    score: z.coerce.number().min(0).max(100).nullish(),
    correct: z.coerce.number().int().min(0).max(500).optional(),
    total: z.coerce.number().int().min(1).max(500).optional(),
  })
  .default({});

/** Carrega a revisão do aluno ou lança 404. */
async function loadReview(userId, reviewId) {
  const review = await reviews.findReview(userId, reviewId);
  if (!review) throw new AppError(404, 'not_found', 'Revisão não encontrada.');
  return review;
}

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const { status = 'pending', from, to, limit } = req.valid.query;
    const [items, counts] = await Promise.all([
      reviews.listReviews(req.user.id, { status, from, to, limit }),
      reviews.getCounts(req.user.id),
    ]);
    res.json({ items, counts, today: todayISO(), status });
  })
);

router.get(
  '/:id/questions',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const review = await loadReview(userId, req.valid.params.id);

    let subtopicId = null;
    if (review.lesson_id) {
      const lesson = await db.one('SELECT subtopic_id FROM lessons WHERE id = $1', [review.lesson_id]);
      subtopicId = lesson ? lesson.subtopic_id : null;
    }

    const list = await questions.pickQuestions({
      userId,
      topicId: review.topic_id,
      subtopicId,
      count: reviews.REVIEW_QUESTION_COUNT,
      excludeRecentDays: 3,
    });

    res.json({ review, questions: list });
  })
);

router.post(
  '/:id/complete',
  validate({ params: idParams, body: completeBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    await loadReview(userId, req.valid.params.id);
    const body = req.valid.body || {};

    let score = body.score === undefined || body.score === null ? null : Number(body.score);
    if (score === null && body.total) score = Math.round(((Number(body.correct) || 0) / Number(body.total)) * 100);

    const review = await reviews.completeReview(userId, req.valid.params.id, { score });
    if (!review) throw new AppError(404, 'not_found', 'Revisão não encontrada.');
    res.json(review);
  })
);

router.post(
  '/:id/skip',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    await loadReview(userId, req.valid.params.id);
    const review = await reviews.skipReview(userId, req.valid.params.id);
    if (!review) throw new AppError(404, 'not_found', 'Revisão não encontrada.');
    res.json(review);
  })
);

module.exports = { basePath: '/api/reviews', router };

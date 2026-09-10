'use strict';

/**
 * Cronograma adaptativo do aluno (ARCHITECTURE §4 "cronograma / revisões").
 *
 *   GET    /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD  → { from, to, days: [{ date, is_study_day, items, total_min, done_min }] }
 *   GET    /api/schedule/today                          → { date, items, next_item, summary }
 *   POST   /api/schedule/generate                       → (re)gera a partir de hoje (preserva concluídos e manuais)
 *   POST   /api/schedule/skip-today                     → redistribui os pendentes de hoje → { moved }
 *   POST   /api/schedule/after-practice                 → { lesson_id, correct, total } adapta após a prática
 *   POST   /api/schedule/items                          → item manual
 *   PATCH  /api/schedule/items/:id                      → { status | date | start_time | position }
 *   DELETE /api/schedule/items/:id                      → só itens manuais
 *
 * GET / e GET /today garantem pelo menos uma semana de cronograma à frente (ensureScheduleAhead).
 * Todas as consultas filtram por user_id (ver services/schedule.js).
 */
const router = require('express').Router();
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const schedule = require('../services/schedule');
const { isISODate, todayISO, addDays } = require('../utils/dates');

router.use(requireStudent, requireAccess);

const isoDate = z.string().refine(isISODate, { message: 'Data inválida (use AAAA-MM-DD).' });
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM).');
const idParams = z.object({ id: z.string().uuid() });

const rangeQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    days: z.coerce.number().int().min(1).max(120).optional(),
  })
  .passthrough();

const generateBody = z
  .object({
    from: isoDate.optional(),
    days: z.coerce.number().int().min(1).max(60).optional(),
  })
  .default({});

const itemBody = z.object({
  date: isoDate,
  title: z.string().trim().min(2, 'Informe um título.').max(160),
  type: z.enum(['custom', 'lesson', 'topic', 'questions', 'essay', 'simulado']).default('custom'),
  subject_id: z.string().uuid().nullish(),
  topic_id: z.string().uuid().nullish(),
  lesson_id: z.string().uuid().nullish(),
  duration_min: z.coerce.number().int().min(5).max(600).default(30),
  start_time: timeOfDay.nullish(),
  note: z.string().trim().max(500).nullish(),
});

const patchBody = z
  .object({
    status: z.enum(['pending', 'done', 'skipped', 'missed']).optional(),
    date: isoDate.optional(),
    start_time: timeOfDay.nullable().optional(),
    position: z.coerce.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Informe ao menos um campo para atualizar.' });

const practiceBody = z.object({
  lesson_id: z.string().uuid(),
  correct: z.coerce.number().int().min(0).max(500),
  total: z.coerce.number().int().min(1).max(500),
});

/** Gera mais dias quando o horizonte está curto; nunca derruba a leitura do cronograma. */
async function ensureAhead(userId) {
  try {
    await schedule.ensureScheduleAhead(userId);
  } catch (err) {
    console.error('[schedule] falha ao estender o cronograma:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: rangeQuery }),
  wrap(async (req, res) => {
    const { from, to, days } = req.valid.query;
    await ensureAhead(req.user.id);
    const start = from || todayISO();
    const end = to || (days ? addDays(start, days - 1) : undefined);
    res.json(await schedule.getScheduleRange(req.user.id, { from: start, to: end }));
  })
);

router.get(
  '/today',
  wrap(async (req, res) => {
    await ensureAhead(req.user.id);
    res.json(await schedule.getToday(req.user.id));
  })
);

// ---------------------------------------------------------------------------
// Geração e adaptação
// ---------------------------------------------------------------------------
router.post(
  '/generate',
  validate({ body: generateBody }),
  wrap(async (req, res) => {
    const { from, days } = req.valid.body || {};
    const result = await schedule.generateSchedule(req.user.id, { from, days });
    const range = await schedule.getScheduleRange(req.user.id, { from: result.from, to: result.to });
    res.json({ ...range, created: result.created });
  })
);

router.post(
  '/skip-today',
  wrap(async (req, res) => {
    const result = await schedule.skipToday(req.user.id);
    res.json(result);
  })
);

router.post(
  '/after-practice',
  validate({ body: practiceBody }),
  wrap(async (req, res) => {
    const { lesson_id: lessonId, correct, total } = req.valid.body;
    if (correct > total) {
      throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
        { path: 'correct', message: 'Não pode ser maior que o total de questões.' },
      ]);
    }
    res.json(await schedule.afterPractice(req.user.id, { lessonId, correct, total }));
  })
);

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------
router.post(
  '/items',
  validate({ body: itemBody }),
  wrap(async (req, res) => {
    const item = await schedule.createItem(req.user.id, req.valid.body);
    res.status(201).json(item);
  })
);

router.patch(
  '/items/:id',
  validate({ params: idParams, body: patchBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const { id } = req.valid.params;
    const { status, ...changes } = req.valid.body;

    const current = await schedule.findItem(userId, id);
    if (!current) throw new AppError(404, 'not_found', 'Item do cronograma não encontrado.');

    if (Object.keys(changes).length > 0) {
      const updated = await schedule.rescheduleItem(userId, id, changes);
      if (!updated) throw new AppError(404, 'not_found', 'Item do cronograma não encontrado.');
    }
    if (status) {
      const updated = await schedule.setItemStatus(userId, id, status);
      if (!updated) throw new AppError(404, 'not_found', 'Item do cronograma não encontrado.');
    }

    res.json(await schedule.findItem(userId, id));
  })
);

router.delete(
  '/items/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const item = await schedule.findItem(req.user.id, req.valid.params.id);
    if (!item) throw new AppError(404, 'not_found', 'Item do cronograma não encontrado.');
    if (item.generated) {
      throw new AppError(403, 'forbidden', 'Só é possível excluir itens que você mesmo criou. Use "não realizada" ou reagende.');
    }
    await schedule.deleteItem(req.user.id, item.id);
    res.json({ ok: true, id: item.id });
  })
);

module.exports = { basePath: '/api/schedule', router };

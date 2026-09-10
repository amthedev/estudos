'use strict';

/**
 * Aulas (biblioteca de conteúdo — visão do aluno).
 *
 *   GET  /api/lessons                 ?subject_id&topic_id&status=done|pending|in_progress&q&page&limit&all=1 → paginado
 *   GET  /api/lessons/continue        últimas 6 aulas em andamento
 *   GET  /api/lessons/:id             aula + exams[] + progress + note + favorited + next_lesson + prev_lesson
 *   POST /api/lessons/:id/start       marca como em andamento (não desfaz conclusão)
 *   POST /api/lessons/:id/complete    conclui: study_log, revisões (services/reviews), item do cronograma
 *                                     → { progress, reviews_created, ... }
 *   GET  /api/lessons/:id/practice    5 questões do assunto (prioriza o subassunto, evita respondidas
 *                                     nos últimos 3 dias, embaralha) — sem gabarito
 *   PUT  /api/lessons/:id/note        { content } upsert da anotação da aula
 *
 * A listagem respeita o syllabus da prova do aluno (ver services/progress.js).
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { parsePagination, paginate } = require('../utils/pagination');
const { todayISO } = require('../utils/dates');
const progress = require('../services/progress');

router.use(requireStudent, requireAccess);

const PRACTICE_SIZE = 5;
const RECENT_ATTEMPT_DAYS = 3;
const CONTINUE_LIMIT = 6;

const flag = z
  .string()
  .optional()
  .transform((value) => value === '1' || value === 'true');

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z
  .object({
    subject_id: z.string().uuid().optional(),
    topic_id: z.string().uuid().optional(),
    subtopic_id: z.string().uuid().optional(),
    status: z.enum(['done', 'pending', 'in_progress']).optional(),
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    all: flag,
  })
  .passthrough();

const noteBody = z.object({
  content: z.string().max(50_000),
  title: z.string().trim().max(200).optional(),
});

const LESSON_LIST_COLUMNS = `
  l.id, l.slug, l.title, l.description, l.duration_min, l.difficulty, l.teacher_name, l.thumbnail_url,
  l.video_provider, l.sort_order, l.subject_id, s.name AS subject_name, s.color AS subject_color,
  s.icon AS subject_icon, l.topic_id, t.name AS topic_name, l.subtopic_id, st.name AS subtopic_name,
  lp.status, lp.started_at, lp.completed_at,
  coalesce(lp.status = 'completed', false) AS completed,
  EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = $1 AND f.item_type = 'lesson' AND f.item_id = l.id) AS favorited`;

const LESSON_LIST_FROM = `
  FROM lessons l
  JOIN subjects s ON s.id = l.subject_id AND s.active
  JOIN topics t ON t.id = l.topic_id AND t.active
  LEFT JOIN subtopics st ON st.id = l.subtopic_id
  LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1`;

const LESSON_ORDER = 'ORDER BY s.sort_order, s.name, t.sort_order, t.name, l.sort_order, l.title';

/** Carrega a aula ativa ou lança 404. */
async function loadLesson(id) {
  const lesson = await db.one(
    `SELECT l.*, s.name AS subject_name, s.slug AS subject_slug, s.color AS subject_color, s.icon AS subject_icon,
            t.name AS topic_name, t.slug AS topic_slug, st.name AS subtopic_name
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN topics t ON t.id = l.topic_id
       LEFT JOIN subtopics st ON st.id = l.subtopic_id
      WHERE l.id = $1 AND l.active`,
    [id]
  );
  if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
  delete lesson.search_vector;
  return lesson;
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Normaliza o retorno de services/reviews.scheduleReviews (array, número ou objeto). */
function countReviews(result) {
  if (Array.isArray(result)) return result.length;
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object') {
    if (Array.isArray(result.reviews)) return result.reviews.length;
    if (Array.isArray(result.created)) return result.created.length;
    const n = Number(result.created ?? result.count ?? result.total ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Agenda revisões pela conclusão da aula; o módulo é de outro agente e pode não existir ainda. */
async function scheduleReviewsSafely(userId, { topicId, lessonId, subjectId }) {
  let reviews;
  try {
    reviews = require('../services/reviews');
  } catch {
    return { created: 0, available: false };
  }
  try {
    if (typeof reviews.scheduleReviews !== 'function') return { created: 0, available: false };
    const result = await reviews.scheduleReviews(userId, { topicId, lessonId, subjectId });
    return { created: countReviews(result), available: true };
  } catch (err) {
    console.error('[lessons] falha ao agendar revisões:', err.message);
    return { created: 0, available: true };
  }
}

// ---------------------------------------------------------------------------
// Listagem e "continuar assistindo"
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });

    const scope = await progress.resolveScope(userId, { all: query.all, subjectId: query.subject_id || null });
    const params = [userId];
    const where = ['l.active', progress.lessonScopeSql(scope, params)];

    if (query.subject_id) {
      params.push(query.subject_id);
      where.push(`l.subject_id = $${params.length}`);
    }
    if (query.topic_id) {
      params.push(query.topic_id);
      where.push(`l.topic_id = $${params.length}`);
    }
    if (query.subtopic_id) {
      params.push(query.subtopic_id);
      where.push(`l.subtopic_id = $${params.length}`);
    }
    if (query.status === 'done') where.push(`lp.status = 'completed'`);
    else if (query.status === 'in_progress') where.push(`lp.status = 'in_progress'`);
    else if (query.status === 'pending') where.push(`(lp.status IS NULL OR lp.status <> 'completed')`);
    if (query.q) {
      params.push(query.q);
      const idx = params.length;
      params.push(`%${query.q}%`);
      where.push(
        `(l.search_vector @@ plainto_tsquery('portuguese', fe_unaccent($${idx}))
          OR fe_unaccent(l.title) ILIKE fe_unaccent($${idx + 1})
          OR fe_unaccent(t.name) ILIKE fe_unaccent($${idx + 1}))`
      );
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await db.one(`SELECT count(*) AS total ${LESSON_LIST_FROM} ${whereSql}`, params);
    const total = countRow ? countRow.total : 0;

    params.push(limit, offset);
    const items = await db.many(
      `SELECT ${LESSON_LIST_COLUMNS} ${LESSON_LIST_FROM} ${whereSql} ${LESSON_ORDER}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginate(items, total, { page, limit }));
  })
);

router.get(
  '/continue',
  wrap(async (req, res) => {
    const items = await db.many(
      `SELECT ${LESSON_LIST_COLUMNS} ${LESSON_LIST_FROM}
        WHERE l.active AND lp.status = 'in_progress'
        ORDER BY lp.started_at DESC
        LIMIT $2`,
      [req.user.id, CONTINUE_LIMIT]
    );
    res.json(items);
  })
);

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);

    const [exams, progressRow, note, favorited, neighbors, questions] = await Promise.all([
      db.many(
        `SELECT e.id, e.slug, e.name, e.short_name, e.track
           FROM lesson_exams le JOIN exams e ON e.id = le.exam_id AND e.active
          WHERE le.lesson_id = $1
          ORDER BY e.sort_order, e.name`,
        [lesson.id]
      ),
      db.one('SELECT status, started_at, completed_at FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]),
      db.one('SELECT id, title, content, updated_at FROM notes WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]),
      db.one(`SELECT 1 FROM favorites WHERE user_id = $1 AND item_type = 'lesson' AND item_id = $2`, [userId, lesson.id]),
      db.one(
        `WITH ordered AS (
           SELECT l.id,
                  lag(l.id)  OVER w AS prev_id,
                  lead(l.id) OVER w AS next_id
             FROM lessons l
             JOIN topics t ON t.id = l.topic_id AND t.active
            WHERE l.subject_id = $1 AND l.active
           WINDOW w AS (ORDER BY t.sort_order, t.name, l.sort_order, l.title)
         )
         SELECT prev_id, next_id FROM ordered WHERE id = $2`,
        [lesson.subject_id, lesson.id]
      ),
      db.one('SELECT count(*) AS total FROM questions WHERE topic_id = $1 AND active', [lesson.topic_id]),
    ]);

    const siblingIds = [neighbors && neighbors.prev_id, neighbors && neighbors.next_id].filter(Boolean);
    const siblings = siblingIds.length
      ? await db.many(
          `SELECT l.id, l.title, l.duration_min, l.topic_id, t.name AS topic_name
             FROM lessons l JOIN topics t ON t.id = l.topic_id
            WHERE l.id = ANY($1::uuid[])`,
          [siblingIds]
        )
      : [];
    const byId = new Map(siblings.map((row) => [row.id, row]));

    res.json({
      ...lesson,
      exams,
      progress: progressRow || null,
      note: note || null,
      favorited: Boolean(favorited),
      prev_lesson: (neighbors && byId.get(neighbors.prev_id)) || null,
      next_lesson: (neighbors && byId.get(neighbors.next_id)) || null,
      questions_available: questions ? questions.total : 0,
    });
  })
);

// ---------------------------------------------------------------------------
// Progresso
// ---------------------------------------------------------------------------
router.post(
  '/:id/start',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const lesson = await loadLesson(req.valid.params.id);
    const row = await db.one(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, started_at)
       VALUES ($1, $2, 'in_progress', now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE
         SET started_at = CASE WHEN lesson_progress.status = 'in_progress' THEN now() ELSE lesson_progress.started_at END
       RETURNING status, started_at, completed_at`,
      [req.user.id, lesson.id]
    );
    res.json({ lesson_id: lesson.id, progress: row });
  })
);

router.post(
  '/:id/complete',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);
    const today = todayISO();

    const outcome = await db.tx(async (client) => {
      const current = await client.one('SELECT status FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]);
      const alreadyCompleted = Boolean(current && current.status === 'completed');

      const progressRow = await client.one(
        `INSERT INTO lesson_progress (user_id, lesson_id, status, started_at, completed_at)
         VALUES ($1, $2, 'completed', now(), now())
         ON CONFLICT (user_id, lesson_id) DO UPDATE
           SET status = 'completed',
               completed_at = coalesce(lesson_progress.completed_at, now())
         RETURNING status, started_at, completed_at`,
        [userId, lesson.id]
      );

      let studyMinutes = 0;
      if (!alreadyCompleted) {
        studyMinutes = Number(lesson.duration_min) || 0;
        await client.query(
          `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
           VALUES ($1, 'lesson', $2, $3, $4, $5)`,
          [userId, lesson.id, lesson.subject_id, studyMinutes, today]
        );
      }

      const scheduled = await client.query(
        `UPDATE schedule_items SET status = 'done', completed_at = now()
          WHERE user_id = $1 AND lesson_id = $2 AND status = 'pending' AND date <= $3`,
        [userId, lesson.id, today]
      );

      return { progressRow, alreadyCompleted, studyMinutes, scheduleItemsDone: scheduled.rowCount || 0 };
    });

    let reviews = { created: 0, available: false };
    if (!outcome.alreadyCompleted) {
      reviews = await scheduleReviewsSafely(userId, { topicId: lesson.topic_id, lessonId: lesson.id, subjectId: lesson.subject_id });
    }

    res.json({
      lesson_id: lesson.id,
      progress: outcome.progressRow,
      reviews_created: reviews.created,
      already_completed: outcome.alreadyCompleted,
      study_minutes: outcome.studyMinutes,
      schedule_items_done: outcome.scheduleItemsDone,
    });
  })
);

// ---------------------------------------------------------------------------
// Pratique agora
// ---------------------------------------------------------------------------
router.get(
  '/:id/practice',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);

    // posições dos parâmetros de assunto e subassunto (o subassunto da aula pode ser nulo)
    const selectSql = (topicParam, subtopicParam) => `
      SELECT q.id, q.statement, q.image_url, q.difficulty, q.year, q.board, q.source,
             q.subject_id, q.topic_id, q.subtopic_id,
             (q.subtopic_id IS NOT NULL AND q.subtopic_id = $${subtopicParam}::uuid) AS same_subtopic
        FROM questions q
       WHERE q.active AND q.topic_id = $${topicParam}`;

    // 1) prioriza o subassunto da aula e evita questões respondidas recentemente
    let questions = await db.many(
      `${selectSql(2, 3)}
         AND NOT EXISTS (SELECT 1 FROM question_attempts qa
                          WHERE qa.user_id = $1 AND qa.question_id = q.id
                            AND qa.answered_at > now() - ($5::int * interval '1 day'))
       ORDER BY same_subtopic DESC, random()
       LIMIT $4`,
      [userId, lesson.topic_id, lesson.subtopic_id, PRACTICE_SIZE, RECENT_ATTEMPT_DAYS]
    );

    // 2) completa com questões já respondidas se ainda faltar
    if (questions.length < PRACTICE_SIZE) {
      const chosen = questions.map((row) => row.id);
      const fill = await db.many(
        `${selectSql(1, 2)} AND NOT (q.id = ANY($4::uuid[]))
         ORDER BY same_subtopic DESC, random()
         LIMIT $3`,
        [lesson.topic_id, lesson.subtopic_id, PRACTICE_SIZE - questions.length, chosen]
      );
      questions = questions.concat(fill);
    }

    if (!questions.length) return res.json([]);

    const options = await db.many(
      `SELECT id, question_id, letter, text, sort_order
         FROM question_options
        WHERE question_id = ANY($1::uuid[])
        ORDER BY question_id, sort_order, letter`,
      [questions.map((row) => row.id)]
    );
    const byQuestion = new Map();
    for (const option of options) {
      if (!byQuestion.has(option.question_id)) byQuestion.set(option.question_id, []);
      const { question_id, ...rest } = option;
      byQuestion.get(question_id).push(rest);
    }

    const payload = shuffle(questions).map(({ same_subtopic, ...question }) => ({
      ...question,
      lesson_id: lesson.id,
      subject_name: lesson.subject_name,
      topic_name: lesson.topic_name,
      options: byQuestion.get(question.id) || [],
    }));
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// Anotação da aula (autosave)
// ---------------------------------------------------------------------------
router.put(
  '/:id/note',
  validate({ params: idParams, body: noteBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);
    const { content, title } = req.valid.body;

    const note = await db.one(
      `INSERT INTO notes (user_id, lesson_id, subject_id, topic_id, title, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, lesson_id) WHERE lesson_id IS NOT NULL DO UPDATE
         SET content = EXCLUDED.content,
             title = CASE WHEN $7::boolean THEN EXCLUDED.title ELSE notes.title END,
             subject_id = EXCLUDED.subject_id,
             topic_id = EXCLUDED.topic_id
       RETURNING id, lesson_id, subject_id, topic_id, title, content, created_at, updated_at`,
      [userId, lesson.id, lesson.subject_id, lesson.topic_id, title || lesson.title, content, title !== undefined]
    );
    res.json(note);
  })
);

module.exports = { basePath: '/api/lessons', router };

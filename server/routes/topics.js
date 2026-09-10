'use strict';

/**
 * Assuntos (biblioteca de conteúdo — visão do aluno).
 *
 *   GET /api/topics/:id   assunto + subject + subtopics[] + lessons[] (completed, favorited, duration_min,
 *                         difficulty, teacher_name, thumbnail_url, subtopic_id) + acurácia do aluno.
 *                         As aulas seguem o syllabus da prova do aluno (?all=1 mostra todas).
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const progress = require('../services/progress');

router.use(requireStudent, requireAccess);

const flag = z
  .string()
  .optional()
  .transform((value) => value === '1' || value === 'true');

router.get(
  '/:id',
  validate({ params: z.object({ id: z.string().uuid() }), query: z.object({ all: flag }).passthrough() }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const topicId = req.valid.params.id;

    const topic = await db.one(
      `SELECT t.id, t.slug, t.name, t.description, t.sort_order, t.subject_id,
              s.name AS subject_name, s.slug AS subject_slug, s.color AS subject_color, s.icon AS subject_icon,
              a.name AS area_name
         FROM topics t
         JOIN subjects s ON s.id = t.subject_id AND s.active
         LEFT JOIN areas a ON a.id = s.area_id
        WHERE t.id = $1 AND t.active`,
      [topicId]
    );
    if (!topic) throw new AppError(404, 'not_found', 'Assunto não encontrado.');

    const scope = await progress.resolveScope(userId, { all: req.valid.query.all, subjectId: topic.subject_id });
    const params = [userId, topicId];
    const lessonScope = progress.lessonScopeSql(scope, params);

    const [subtopics, lessons, accuracy, questions, exams, favorited] = await Promise.all([
      db.many(
        `SELECT id, slug, name, description, sort_order
           FROM subtopics WHERE topic_id = $1 AND active
          ORDER BY sort_order, name`,
        [topicId]
      ),
      db.many(
        `SELECT l.id, l.slug, l.title, l.description, l.duration_min, l.difficulty, l.teacher_name,
                l.thumbnail_url, l.video_provider, l.sort_order, l.subtopic_id, l.subject_id, l.topic_id,
                lp.status, lp.started_at, lp.completed_at,
                coalesce(lp.status = 'completed', false) AS completed,
                EXISTS (SELECT 1 FROM favorites f
                         WHERE f.user_id = $1 AND f.item_type = 'lesson' AND f.item_id = l.id) AS favorited
           FROM lessons l
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          WHERE l.topic_id = $2 AND l.active AND ${lessonScope}
          ORDER BY l.sort_order, l.title`,
        params
      ),
      progress.getTopicAccuracy(userId, topicId),
      db.one('SELECT count(*) AS total FROM questions WHERE topic_id = $1 AND active', [topicId]),
      db.many(
        `SELECT e.id, e.slug, e.short_name, e.name
           FROM exam_topics et JOIN exams e ON e.id = et.exam_id AND e.active
          WHERE et.topic_id = $1
          ORDER BY e.sort_order, e.name`,
        [topicId]
      ),
      db.one(`SELECT 1 FROM favorites WHERE user_id = $1 AND item_type = 'topic' AND item_id = $2`, [userId, topicId]),
    ]);

    const { subject_name, subject_slug, subject_color, subject_icon, area_name, ...rest } = topic;
    const lessonsDone = lessons.filter((lesson) => lesson.completed).length;

    res.json({
      ...rest,
      subject: { id: topic.subject_id, name: subject_name, slug: subject_slug, color: subject_color, icon: subject_icon, area_name },
      subtopics,
      lessons,
      exams,
      favorited: Boolean(favorited),
      lessons_total: lessons.length,
      lessons_done: lessonsDone,
      progress_pct: progress.pct(lessonsDone, lessons.length),
      questions_total: questions ? questions.total : 0,
      questions_answered: accuracy.questions_answered,
      accuracy_pct: accuracy.accuracy_pct,
    });
  })
);

module.exports = { basePath: '/api/topics', router };

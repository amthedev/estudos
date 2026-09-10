'use strict';

/**
 * Matérias (biblioteca de conteúdo — visão do aluno).
 *
 *   GET /api/subjects          matérias da prova do aluno (sem prova → todas ativas; ?all=1 → todas)
 *                              com progress_pct, lessons_total, lessons_done, accuracy_pct, area_name
 *   GET /api/subjects/:id      matéria + topics[] (do syllabus quando houver exam_topics, senão todos)
 *                              com lessons_total, lessons_done, accuracy_pct, subtopics_count
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

const listQuery = z.object({ all: flag }).passthrough();
const idParams = z.object({ id: z.string().uuid() });

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const { all } = req.valid.query;
    const examId = await progress.getStudentExamId(req.user.id);
    const subjects = await progress.getSubjectProgress(req.user.id, examId, { all: all || !examId });
    res.json(subjects);
  })
);

router.get(
  '/:id',
  validate({ params: idParams, query: listQuery }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const subjectId = req.valid.params.id;
    const { all } = req.valid.query;

    const subject = await db.one(
      `SELECT s.id, s.slug, s.name, s.description, s.icon, s.color, s.sort_order, s.area_id,
              a.name AS area_name, a.slug AS area_slug
         FROM subjects s
         LEFT JOIN areas a ON a.id = s.area_id
        WHERE s.id = $1 AND s.active`,
      [subjectId]
    );
    if (!subject) throw new AppError(404, 'not_found', 'Matéria não encontrada.');

    const scope = await progress.resolveScope(userId, { all, subjectId });
    const topics = await progress.getTopicProgress(userId, subjectId, scope.examId, { scope });

    const params = [userId, subjectId];
    const lessonScope = progress.lessonScopeSql(scope, params);
    const [totals, accuracy, nextLesson] = await Promise.all([
      db.one(
        `SELECT count(*) AS lessons_total,
                count(*) FILTER (WHERE lp.status = 'completed') AS lessons_done,
                count(*) FILTER (WHERE lp.status = 'in_progress') AS lessons_in_progress,
                coalesce(sum(l.duration_min), 0) AS minutes_total,
                coalesce(sum(l.duration_min) FILTER (WHERE lp.status = 'completed'), 0) AS minutes_done
           FROM lessons l
           JOIN topics t ON t.id = l.topic_id AND t.active
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          WHERE l.subject_id = $2 AND l.active AND ${lessonScope}`,
        params
      ),
      db.one(
        `SELECT count(*) AS questions_answered,
                round(100.0 * sum(is_correct::int) / NULLIF(count(*), 0)) AS accuracy_pct
           FROM question_attempts WHERE user_id = $1 AND subject_id = $2`,
        [userId, subjectId]
      ),
      db.one(
        `SELECT l.id, l.title, l.duration_min, l.topic_id, t.name AS topic_name,
                coalesce(lp.status, 'not_started') AS status
           FROM lessons l
           JOIN topics t ON t.id = l.topic_id AND t.active
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          WHERE l.subject_id = $2 AND l.active AND ${lessonScope}
            AND (lp.status IS NULL OR lp.status <> 'completed')
          ORDER BY (lp.status = 'in_progress') DESC NULLS LAST, t.sort_order, t.name, l.sort_order, l.title
          LIMIT 1`,
        params
      ),
    ]);

    res.json({
      ...subject,
      in_exam: Boolean(scope.examId),
      lessons_total: totals ? totals.lessons_total : 0,
      lessons_done: totals ? totals.lessons_done : 0,
      lessons_in_progress: totals ? totals.lessons_in_progress : 0,
      minutes_total: totals ? totals.minutes_total : 0,
      minutes_done: totals ? totals.minutes_done : 0,
      progress_pct: progress.pct(totals && totals.lessons_done, totals && totals.lessons_total),
      questions_answered: accuracy ? accuracy.questions_answered : 0,
      accuracy_pct: accuracy ? accuracy.accuracy_pct : null,
      next_lesson: nextLesson || null,
      topics,
    });
  })
);

module.exports = { basePath: '/api/subjects', router };

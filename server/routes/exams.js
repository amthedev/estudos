'use strict';

/**
 * Provas e vestibulares (público — usado pelo onboarding e pela landing).
 *
 *   GET /api/exams              → provas ativas [{ id, slug, name, short_name, track, board, exam_date, has_essay, ... }]
 *   GET /api/exams/:id/subjects → matérias da prova com peso [{ id, name, color, icon, weight, topics_count }]
 *
 * Sem dados sensíveis e sem sessão: são informações de catálogo.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z
  .object({
    track: z.enum(['enem', 'barro_branco', 'vestibular']).optional(),
  })
  .passthrough();

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const params = [];
    let filter = '';
    if (req.valid.query.track) {
      params.push(req.valid.query.track);
      filter = `AND e.track = $${params.length}`;
    }
    const exams = await db.many(
      `SELECT e.id, e.slug, e.name, e.short_name, e.track, e.board, e.description, e.exam_date,
              e.has_essay, e.essay_max_score, e.score_max, e.sort_order,
              (SELECT count(*) FROM exam_subjects es WHERE es.exam_id = e.id) AS subjects_count
         FROM exams e
        WHERE e.active ${filter}
        ORDER BY e.sort_order, e.name`,
      params
    );
    res.json(exams);
  })
);

router.get(
  '/:id/subjects',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const exam = await db.one('SELECT id, name, short_name, track FROM exams WHERE id = $1 AND active', [id]);
    if (!exam) throw new AppError(404, 'not_found', 'Prova não encontrada.');

    const subjects = await db.many(
      `SELECT s.id, s.slug, s.name, s.description, s.icon, s.color, s.sort_order,
              es.weight, a.name AS area_name, a.slug AS area_slug,
              (SELECT count(*) FROM topics t
                WHERE t.subject_id = s.id AND t.active
                  AND (NOT EXISTS (SELECT 1 FROM exam_topics x WHERE x.exam_id = $1)
                       OR EXISTS (SELECT 1 FROM exam_topics et WHERE et.exam_id = $1 AND et.topic_id = t.id))
              ) AS topics_count
         FROM exam_subjects es
         JOIN subjects s ON s.id = es.subject_id AND s.active
         LEFT JOIN areas a ON a.id = s.area_id
        WHERE es.exam_id = $1
        ORDER BY es.weight DESC, s.sort_order, s.name`,
      [id]
    );

    res.json(subjects);
  })
);

module.exports = { basePath: '/api/exams', router };

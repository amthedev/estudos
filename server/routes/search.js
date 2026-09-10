'use strict';

/**
 * Busca global do aluno.
 *
 *   GET /api/search?q=texto → { q, lessons[], questions[], topics[], notes[], total }
 *
 * Aulas e questões usam o search_vector (português, sem acento) com fallback ILIKE para
 * termos parciais; assuntos e resumos usam ILIKE sem acento (fe_unaccent). Máximo de 8
 * itens por grupo. Resumos são sempre do próprio aluno (user_id = req.user.id).
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');

const LIMIT = 8;

const querySchema = z
  .object({
    q: z.string().trim().min(2, 'Digite pelo menos 2 caracteres.').max(100),
  })
  .passthrough();

/** Escapa curingas do LIKE para que o texto do aluno seja tratado literalmente. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function excerpt(text, max = 220) {
  const clean = String(text || '')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

router.use(requireStudent, requireAccess);

router.get(
  '/',
  validate({ query: querySchema }),
  wrap(async (req, res) => {
    const q = req.valid.query.q;
    const like = likePattern(q);
    const userId = req.user.id;

    const [lessons, questions, topics, notes] = await Promise.all([
      db.many(
        `SELECT l.id, l.title, l.description, l.duration_min, l.difficulty, l.thumbnail_url,
                l.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
                l.topic_id, t.name AS topic_name,
                (lp.status = 'completed') AS completed,
                ts_rank(l.search_vector, plainto_tsquery('portuguese', fe_unaccent($1))) AS rank
           FROM lessons l
           JOIN subjects s ON s.id = l.subject_id
           JOIN topics t ON t.id = l.topic_id
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $3
          WHERE l.active = true
            AND (l.search_vector @@ plainto_tsquery('portuguese', fe_unaccent($1))
                 OR fe_unaccent(l.title) ILIKE fe_unaccent($2) ESCAPE '\\')
          ORDER BY rank DESC, l.title ASC
          LIMIT ${LIMIT}`,
        [q, like, userId]
      ),
      db.many(
        `SELECT qs.id, qs.statement, qs.difficulty, qs.year, qs.board,
                qs.subject_id, s.name AS subject_name, s.color AS subject_color,
                qs.topic_id, t.name AS topic_name,
                ts_rank(qs.search_vector, plainto_tsquery('portuguese', fe_unaccent($1))) AS rank
           FROM questions qs
           JOIN subjects s ON s.id = qs.subject_id
           JOIN topics t ON t.id = qs.topic_id
          WHERE qs.active = true
            AND (qs.search_vector @@ plainto_tsquery('portuguese', fe_unaccent($1))
                 OR fe_unaccent(qs.statement) ILIKE fe_unaccent($2) ESCAPE '\\')
          ORDER BY rank DESC, qs.created_at DESC
          LIMIT ${LIMIT}`,
        [q, like]
      ),
      db.many(
        `SELECT t.id, t.name, t.description, t.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
                (SELECT count(*) FROM lessons l WHERE l.topic_id = t.id AND l.active = true) AS lessons_total
           FROM topics t
           JOIN subjects s ON s.id = t.subject_id
          WHERE t.active = true AND s.active = true
            AND fe_unaccent(t.name) ILIKE fe_unaccent($1) ESCAPE '\\'
          ORDER BY (fe_unaccent(t.name) ILIKE fe_unaccent($2) ESCAPE '\\') DESC, s.sort_order, t.sort_order, t.name
          LIMIT ${LIMIT}`,
        [like, `${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`]
      ),
      db.many(
        `SELECT n.id, n.title, n.content, n.lesson_id, n.subject_id, s.name AS subject_name, s.color AS subject_color,
                n.topic_id, t.name AS topic_name, l.title AS lesson_title, n.updated_at
           FROM notes n
           LEFT JOIN subjects s ON s.id = n.subject_id
           LEFT JOIN topics t ON t.id = n.topic_id
           LEFT JOIN lessons l ON l.id = n.lesson_id
          WHERE n.user_id = $1
            AND (fe_unaccent(n.title) ILIKE fe_unaccent($2) ESCAPE '\\'
                 OR fe_unaccent(n.content) ILIKE fe_unaccent($2) ESCAPE '\\')
          ORDER BY n.updated_at DESC
          LIMIT ${LIMIT}`,
        [userId, like]
      ),
    ]);

    const result = {
      q,
      lessons: lessons.map(({ rank, ...lesson }) => ({
        ...lesson,
        description: excerpt(lesson.description, 160),
        completed: Boolean(lesson.completed),
        href: `/app/aulas/${lesson.id}`,
      })),
      questions: questions.map(({ rank, statement, ...question }) => ({
        ...question,
        excerpt: excerpt(statement),
        href: `/app/questoes?topic_id=${question.topic_id}&q=${encodeURIComponent(q)}`,
      })),
      topics: topics.map((topic) => ({
        ...topic,
        description: excerpt(topic.description, 160),
        href: `/app/materias/${topic.subject_id}/assuntos/${topic.id}`,
      })),
      notes: notes.map(({ content, ...note }) => ({
        ...note,
        title: note.title || note.lesson_title || 'Resumo sem título',
        excerpt: excerpt(content, 180),
        href: `/app/resumos/${note.id}`,
      })),
    };
    result.total = result.lessons.length + result.questions.length + result.topics.length + result.notes.length;
    res.json(result);
  })
);

module.exports = { basePath: '/api/search', router };

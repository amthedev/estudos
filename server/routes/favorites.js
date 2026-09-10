'use strict';

/**
 * Favoritos do aluno (aulas, questões, assuntos e resumos).
 *
 *   GET    /api/favorites?type=lesson|question|topic|note
 *     → { items: [...], counts: { lesson, question, topic, note, total }, total }
 *       Cada item já vem resolvido e pronto para o card:
 *         { id, item_type, item_id, created_at, title, subtitle, href,
 *           subject_id, subject_name, subject_color, ...campos do tipo }
 *         lesson   → duration_min, thumbnail_url, difficulty, topic_name, completed
 *         question → excerpt, difficulty, year, board, topic_name
 *         topic    → lessons_total, topic_id
 *         note     → excerpt, updated_at, lesson_title
 *   POST   /api/favorites   { item_type, item_id } → 201 com o item resolvido (200 se já era favorito)
 *   DELETE /api/favorites   { item_type, item_id } → { ok, removed }
 *
 * Itens inativos (ou apagados) somem da lista e das contagens. Só é possível favoritar resumos do
 * próprio aluno. Toda consulta filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');

router.use(requireStudent, requireAccess);

const TYPES = Object.freeze(['lesson', 'question', 'topic', 'note']);
const TITLE_LENGTH = 120;
const EXCERPT_LENGTH = 220;

const listQuery = z.object({ type: z.enum(TYPES).optional() }).passthrough();
const itemBody = z.object({ item_type: z.enum(TYPES), item_id: z.string().uuid() });

const NOT_FOUND_MESSAGE = {
  lesson: 'Aula não encontrada.',
  question: 'Questão não encontrada.',
  topic: 'Assunto não encontrado.',
  note: 'Resumo não encontrado.',
};

/** Aceita { item_type, item_id } também na query (conveniente para DELETE sem corpo). */
function bodyOrQuery(req, res, next) {
  const empty = !req.body || Object.keys(req.body).length === 0;
  if (empty && req.query && Object.keys(req.query).length > 0) req.body = { ...req.query };
  next();
}

function excerpt(text, max = EXCERPT_LENGTH) {
  const clean = String(text || '')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const BASE_COLUMNS = 'f.id, f.item_type, f.item_id, f.created_at';

/** Consultas de resolução por tipo — cada uma devolve os favoritos já com os dados do item. */
const RESOLVERS = {
  lesson: {
    exists: 'SELECT id FROM lessons WHERE id = $1 AND active',
    list: `
      SELECT ${BASE_COLUMNS}, l.title, l.duration_min, l.thumbnail_url, l.difficulty, l.video_provider,
             l.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
             l.topic_id, t.name AS topic_name,
             coalesce(lp.status = 'completed', false) AS completed
        FROM favorites f
        JOIN lessons l ON l.id = f.item_id AND l.active
        JOIN subjects s ON s.id = l.subject_id AND s.active
        JOIN topics t ON t.id = l.topic_id
        LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = f.user_id
       WHERE f.user_id = $1 AND f.item_type = 'lesson'`,
    present: (row) => ({
      ...row,
      subtitle: row.topic_name,
      href: `/app/aulas/${row.item_id}`,
    }),
  },
  question: {
    exists: 'SELECT id FROM questions WHERE id = $1 AND active',
    list: `
      SELECT ${BASE_COLUMNS}, q.statement, q.difficulty, q.year, q.board,
             q.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
             q.topic_id, t.name AS topic_name
        FROM favorites f
        JOIN questions q ON q.id = f.item_id AND q.active
        JOIN subjects s ON s.id = q.subject_id AND s.active
        JOIN topics t ON t.id = q.topic_id
       WHERE f.user_id = $1 AND f.item_type = 'question'`,
    present: ({ statement, ...row }) => ({
      ...row,
      title: excerpt(statement, TITLE_LENGTH),
      excerpt: excerpt(statement),
      subtitle: row.topic_name,
      href: `/app/questoes?question_id=${row.item_id}&topic_id=${row.topic_id}`,
    }),
  },
  topic: {
    exists: `SELECT t.id FROM topics t JOIN subjects s ON s.id = t.subject_id AND s.active
              WHERE t.id = $1 AND t.active`,
    list: `
      SELECT ${BASE_COLUMNS}, t.name AS title, t.description, t.id AS topic_id,
             t.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
             (SELECT count(*)::int FROM lessons l WHERE l.topic_id = t.id AND l.active) AS lessons_total
        FROM favorites f
        JOIN topics t ON t.id = f.item_id AND t.active
        JOIN subjects s ON s.id = t.subject_id AND s.active
       WHERE f.user_id = $1 AND f.item_type = 'topic'`,
    present: ({ description, ...row }) => ({
      ...row,
      excerpt: excerpt(description, TITLE_LENGTH),
      subtitle: row.subject_name,
      href: `/app/materias/${row.subject_id}/assuntos/${row.topic_id}`,
    }),
  },
  note: {
    // um aluno só pode favoritar os próprios resumos
    exists: 'SELECT id FROM notes WHERE id = $1 AND user_id = $2',
    list: `
      SELECT ${BASE_COLUMNS}, n.title, n.content, n.updated_at, n.lesson_id, l.title AS lesson_title,
             n.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
             n.topic_id, t.name AS topic_name
        FROM favorites f
        JOIN notes n ON n.id = f.item_id AND n.user_id = f.user_id
        LEFT JOIN subjects s ON s.id = n.subject_id
        LEFT JOIN topics t ON t.id = n.topic_id
        LEFT JOIN lessons l ON l.id = n.lesson_id
       WHERE f.user_id = $1 AND f.item_type = 'note'`,
    present: ({ content, ...row }) => ({
      ...row,
      title: row.title || row.lesson_title || 'Resumo sem título',
      excerpt: excerpt(content),
      subtitle: row.subject_name || row.lesson_title || null,
      href: `/app/resumos/${row.item_id}`,
    }),
  },
};

/** Favoritos resolvidos dos tipos pedidos, do mais recente para o mais antigo. */
async function listFavorites(userId, types) {
  const groups = await Promise.all(
    types.map(async (type) => {
      const rows = await db.many(`${RESOLVERS[type].list} ORDER BY f.created_at DESC`, [userId]);
      return rows.map((row) => RESOLVERS[type].present(row));
    })
  );
  return groups.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/** Contagem por tipo, ignorando favoritos cujo item não existe mais. */
async function countFavorites(userId) {
  const rows = await db.many(
    `SELECT f.item_type, count(*)::int AS total
       FROM favorites f
      WHERE f.user_id = $1
        AND ((f.item_type = 'lesson'   AND EXISTS (SELECT 1 FROM lessons l   WHERE l.id = f.item_id AND l.active))
          OR (f.item_type = 'question' AND EXISTS (SELECT 1 FROM questions q WHERE q.id = f.item_id AND q.active))
          OR (f.item_type = 'topic'    AND EXISTS (SELECT 1 FROM topics t
                                                     JOIN subjects s ON s.id = t.subject_id AND s.active
                                                    WHERE t.id = f.item_id AND t.active))
          OR (f.item_type = 'note'     AND EXISTS (SELECT 1 FROM notes n WHERE n.id = f.item_id AND n.user_id = f.user_id)))
      GROUP BY f.item_type`,
    [userId]
  );
  const counts = { lesson: 0, question: 0, topic: 0, note: 0, total: 0 };
  for (const row of rows) {
    counts[row.item_type] = Number(row.total);
    counts.total += Number(row.total);
  }
  return counts;
}

/** Garante que o item existe (e é do aluno, no caso de resumo). */
async function assertItemExists(userId, type, itemId) {
  const params = type === 'note' ? [itemId, userId] : [itemId];
  const row = await db.one(RESOLVERS[type].exists, params);
  if (!row) throw new AppError(404, 'not_found', NOT_FOUND_MESSAGE[type]);
}

/** Um favorito já resolvido (null quando o item deixou de existir). */
async function findFavorite(userId, type, itemId) {
  const row = await db.one(`${RESOLVERS[type].list} AND f.item_id = $2`, [userId, itemId]);
  return row ? RESOLVERS[type].present(row) : null;
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const types = req.valid.query.type ? [req.valid.query.type] : TYPES;
    const [items, counts] = await Promise.all([listFavorites(userId, types), countFavorites(userId)]);
    res.json({ items, counts, total: items.length });
  })
);

// ---------------------------------------------------------------------------
// Favoritar
// ---------------------------------------------------------------------------
router.post(
  '/',
  bodyOrQuery,
  validate({ body: itemBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const { item_type: type, item_id: itemId } = req.valid.body;
    await assertItemExists(userId, type, itemId);

    const inserted = await db.one(
      `INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_type, item_id) DO NOTHING
       RETURNING id`,
      [userId, type, itemId]
    );

    const favorite = await findFavorite(userId, type, itemId);
    if (!favorite) throw new AppError(404, 'not_found', NOT_FOUND_MESSAGE[type]);
    res.status(inserted ? 201 : 200).json({ ...favorite, created: Boolean(inserted) });
  })
);

// ---------------------------------------------------------------------------
// Desfavoritar
// ---------------------------------------------------------------------------
router.delete(
  '/',
  bodyOrQuery,
  validate({ body: itemBody }),
  wrap(async (req, res) => {
    const { item_type: type, item_id: itemId } = req.valid.body;
    const deleted = await db.one(
      'DELETE FROM favorites WHERE user_id = $1 AND item_type = $2 AND item_id = $3 RETURNING id',
      [req.user.id, type, itemId]
    );
    res.json({ ok: true, removed: Boolean(deleted), item_type: type, item_id: itemId });
  })
);

module.exports = { basePath: '/api/favorites', router };

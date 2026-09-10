'use strict';

/**
 * Meus Resumos — anotações do aluno (avulsas ou ligadas a uma aula).
 *
 *   GET    /api/notes        ?subject_id&topic_id&lesson_id&from&to&q&page&limit → paginado
 *                            (itens com subject_name, topic_name, lesson_title, excerpt e favorited)
 *   GET    /api/notes/:id    anotação completa (content) + nomes + favorited
 *   POST   /api/notes        { title, content?, subject_id?, topic_id?, lesson_id? } → 201
 *   PUT    /api/notes/:id    { title?, content?, subject_id?, topic_id? } (atualização parcial)
 *   DELETE /api/notes/:id    remove a anotação e o favorito correspondente
 *
 * A anotação da aula (uma por aula) é salva pelo autosave em PUT /api/lessons/:id/note; aqui ela
 * aparece na listagem e pode ser editada ou removida como qualquer outra.
 *
 * `from`/`to` filtram pela data da última edição (AAAA-MM-DD, fuso America/Sao_Paulo) e `q` busca
 * no título e no conteúdo sem diferenciar acentos. Toda consulta filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { parsePagination, paginate } = require('../utils/pagination');
const { isISODate, TIMEZONE } = require('../utils/dates');

router.use(requireStudent, requireAccess);

const MAX_CONTENT = 50_000;
const EXCERPT_LENGTH = 220;

const isoDate = z.string().refine(isISODate, 'Data inválida (use AAAA-MM-DD).');
const idParams = z.object({ id: z.string().uuid() });

const listQuery = z
  .object({
    subject_id: z.string().uuid().optional(),
    topic_id: z.string().uuid().optional(),
    lesson_id: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .passthrough();

const createBody = z.object({
  title: z.string().trim().min(1, 'Dê um título ao resumo.').max(200),
  content: z.string().max(MAX_CONTENT).optional().default(''),
  subject_id: z.string().uuid().nullable().optional(),
  topic_id: z.string().uuid().nullable().optional(),
  lesson_id: z.string().uuid().nullable().optional(),
});

const updateBody = z
  .object({
    title: z.string().trim().min(1, 'Dê um título ao resumo.').max(200).optional(),
    content: z.string().max(MAX_CONTENT).optional(),
    subject_id: z.string().uuid().nullable().optional(),
    topic_id: z.string().uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Envie ao menos um campo para atualizar.');

const NOTE_JOINS = `
  FROM notes n
  LEFT JOIN subjects s ON s.id = n.subject_id
  LEFT JOIN topics t ON t.id = n.topic_id
  LEFT JOIN lessons l ON l.id = n.lesson_id`;

const NOTE_COLUMNS = `
  n.id, n.user_id, n.lesson_id, n.subject_id, n.topic_id, n.title, n.created_at, n.updated_at,
  s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
  t.name AS topic_name, l.title AS lesson_title,
  EXISTS (SELECT 1 FROM favorites f
           WHERE f.user_id = n.user_id AND f.item_type = 'note' AND f.item_id = n.id) AS favorited`;

/** Escapa curingas do LIKE para que o texto digitado seja tratado literalmente. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Trecho legível do conteúdo (sem marcações de markdown). */
function excerpt(text, max = EXCERPT_LENGTH) {
  const clean = String(text || '')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Título exibido: o do aluno, o da aula ou um rótulo neutro. */
function displayTitle(row) {
  return row.title || row.lesson_title || 'Resumo sem título';
}

function presentRow(row, { content } = {}) {
  const { user_id, ...rest } = row;
  const note = { ...rest, title: displayTitle(row) };
  if (content !== undefined) {
    note.content = content;
    note.excerpt = excerpt(content);
  }
  return note;
}

/** Valida os vínculos informados e devolve { lesson_id, subject_id, topic_id } coerentes. */
async function resolveLinks({ lesson_id: lessonId, topic_id: topicId, subject_id: subjectId }, current = null) {
  const links = {
    lesson_id: lessonId !== undefined ? lessonId : current ? current.lesson_id : null,
    topic_id: topicId !== undefined ? topicId : current ? current.topic_id : null,
    subject_id: subjectId !== undefined ? subjectId : current ? current.subject_id : null,
  };

  if (links.lesson_id) {
    const lesson = await db.one('SELECT id, subject_id, topic_id, title FROM lessons WHERE id = $1 AND active', [links.lesson_id]);
    if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    if (!links.topic_id) links.topic_id = lesson.topic_id;
    if (!links.subject_id) links.subject_id = lesson.subject_id;
  }

  if (links.topic_id) {
    const topic = await db.one('SELECT id, subject_id FROM topics WHERE id = $1 AND active', [links.topic_id]);
    if (!topic) throw new AppError(404, 'not_found', 'Assunto não encontrado.');
    // o assunto manda: evita resumo com matéria e assunto de árvores diferentes
    links.subject_id = topic.subject_id;
  } else if (links.subject_id) {
    const subject = await db.one('SELECT id FROM subjects WHERE id = $1 AND active', [links.subject_id]);
    if (!subject) throw new AppError(404, 'not_found', 'Matéria não encontrada.');
  }

  return links;
}

/** Carrega a anotação do próprio aluno ou lança 404. */
async function loadNote(userId, id) {
  const note = await db.one(
    `SELECT ${NOTE_COLUMNS}, n.content ${NOTE_JOINS} WHERE n.id = $1 AND n.user_id = $2`,
    [id, userId]
  );
  if (!note) throw new AppError(404, 'not_found', 'Resumo não encontrado.');
  return note;
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });

    const params = [userId];
    const where = ['n.user_id = $1'];

    if (query.subject_id) {
      params.push(query.subject_id);
      where.push(`n.subject_id = $${params.length}`);
    }
    if (query.topic_id) {
      params.push(query.topic_id);
      where.push(`n.topic_id = $${params.length}`);
    }
    if (query.lesson_id) {
      params.push(query.lesson_id);
      where.push(`n.lesson_id = $${params.length}`);
    }
    if (query.from) {
      params.push(TIMEZONE, query.from);
      where.push(`(n.updated_at AT TIME ZONE $${params.length - 1})::date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(TIMEZONE, query.to);
      where.push(`(n.updated_at AT TIME ZONE $${params.length - 1})::date <= $${params.length}::date`);
    }
    if (query.q) {
      params.push(likePattern(query.q));
      const idx = params.length;
      where.push(
        `(fe_unaccent(n.title) ILIKE fe_unaccent($${idx}) ESCAPE '\\'
          OR fe_unaccent(n.content) ILIKE fe_unaccent($${idx}) ESCAPE '\\'
          OR fe_unaccent(coalesce(l.title, '')) ILIKE fe_unaccent($${idx}) ESCAPE '\\')`
      );
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await db.one(`SELECT count(*) AS total ${NOTE_JOINS} ${whereSql}`, params);

    params.push(limit, offset);
    const rows = await db.many(
      `SELECT ${NOTE_COLUMNS}, n.content ${NOTE_JOINS} ${whereSql}
        ORDER BY n.updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const items = rows.map(({ content, ...row }) => ({ ...presentRow(row), excerpt: excerpt(content) }));
    res.json(paginate(items, countRow ? countRow.total : 0, { page, limit }));
  })
);

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { content, ...row } = await loadNote(req.user.id, req.valid.params.id);
    res.json(presentRow(row, { content }));
  })
);

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const body = req.valid.body;
    const links = await resolveLinks(body);

    if (links.lesson_id) {
      const existing = await db.one('SELECT id FROM notes WHERE user_id = $1 AND lesson_id = $2', [userId, links.lesson_id]);
      if (existing) {
        throw new AppError(409, 'conflict', 'Esta aula já tem um resumo. Edite o resumo existente.', { note_id: existing.id });
      }
    }

    const created = await db.one(
      `INSERT INTO notes (user_id, lesson_id, subject_id, topic_id, title, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, links.lesson_id, links.subject_id, links.topic_id, body.title, body.content]
    );

    const { content, ...row } = await loadNote(userId, created.id);
    res.status(201).json(presentRow(row, { content }));
  })
);

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------
router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const noteId = req.valid.params.id;
    const body = req.valid.body;
    const current = await loadNote(userId, noteId);

    const hasLinkChange = body.subject_id !== undefined || body.topic_id !== undefined;
    const links = hasLinkChange
      ? await resolveLinks(body, current)
      : { subject_id: current.subject_id, topic_id: current.topic_id };

    const sets = [];
    const params = [userId, noteId];
    const push = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (body.title !== undefined) push('title', body.title);
    if (body.content !== undefined) push('content', body.content);
    if (hasLinkChange) {
      push('subject_id', links.subject_id);
      push('topic_id', links.topic_id);
    }

    if (sets.length > 0) {
      await db.query(`UPDATE notes SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2`, params);
    }

    const { content, ...row } = await loadNote(userId, noteId);
    res.json(presentRow(row, { content }));
  })
);

// ---------------------------------------------------------------------------
// Remoção
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const noteId = req.valid.params.id;

    const deleted = await db.tx(async (client) => {
      const row = await client.one('DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id', [noteId, userId]);
      if (!row) return null;
      // favorites.item_id é genérico (sem chave estrangeira): limpa o favorito órfão
      await client.query(`DELETE FROM favorites WHERE user_id = $1 AND item_type = 'note' AND item_id = $2`, [userId, noteId]);
      return row;
    });

    if (!deleted) throw new AppError(404, 'not_found', 'Resumo não encontrado.');
    res.json({ ok: true, id: deleted.id });
  })
);

module.exports = { basePath: '/api/notes', router };

'use strict';

/**
 * Painel administrativo — aulas.
 *
 *   GET    /api/admin/lessons                 lista paginada (q, subject_id, topic_id, subtopic_id, exam_id,
 *                                             difficulty, status=active|inactive, sort, dir)
 *   GET    /api/admin/lessons/:id             aula completa com exam_ids
 *   POST   /api/admin/lessons                 cria (slug gerado do título; exam_ids → lesson_exams
 *                                             + garante exam_topics/exam_subjects)
 *   PUT    /api/admin/lessons/:id             edita (parcial)
 *   DELETE /api/admin/lessons/:id
 *   PATCH  /api/admin/lessons/reorder         { ids[] } → sort_order pela posição
 *   POST   /api/admin/lessons/import          cadastra várias aulas de uma vez a partir de
 *                                             vídeos já enviados ao armazenamento da plataforma
 *
 * As videoaulas são arquivos enviados pelo painel (MP4, WEBM ou MOV). O envio em
 * si acontece em POST /api/admin/uploads, que grava em fluxo; aqui chegam apenas
 * os caminhos resultantes.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const config = require('../../config');
const { validate, z } = require('../../middleware/validate');
const { nullableFileRef } = require('../../utils/validators');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { uniqueSlug } = require('../../utils/slug');
const { parseVideoUrl } = require('../../utils/video');
const { join: pathJoin } = require('node:path');
const fsp = require('node:fs/promises');
const uploads = require('../../services/uploads');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { ensureExamCoverage, assertExamsExist } = require('./content');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());
const nullableUrl = nullableFileRef(2000, 'Informe um endereço válido ou envie o arquivo.');

const lessonBody = z.object({
  title: z.string().trim().min(3, 'Informe pelo menos 3 caracteres.').max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  video_url: nullableUrl,
  thumbnail_url: nullableUrl,
  duration_min: z.coerce.number().int().min(1).max(600).optional(),
  teacher_name: z.string().trim().max(120).nullable().optional(),
  subject_id: uuid,
  topic_id: uuid,
  subtopic_id: z.preprocess((v) => (v === '' ? null : v), uuid.nullable().optional()),
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
  summary: z.string().max(200000).nullable().optional(),
  active: z.boolean().optional(),
  exam_ids: z.array(uuid).max(100).optional(),
});
const lessonUpdate = lessonBody.partial().refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  subject_id: optionalUuid,
  topic_id: optionalUuid,
  subtopic_id: optionalUuid,
  exam_id: optionalUuid,
  difficulty: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(3).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
  page: z.string().optional(),
  limit: z.string().optional(),
  sort: z.string().optional(),
  dir: z.string().optional(),
});

const SORTABLE = {
  title: 'l.title',
  sort_order: 'l.sort_order',
  created_at: 'l.created_at',
  updated_at: 'l.updated_at',
  duration_min: 'l.duration_min',
  difficulty: 'l.difficulty',
  subject_name: 's.name',
  topic_name: 't.name',
};

const SELECT_LESSON = `
  SELECT l.id, l.slug, l.title, l.description, l.video_url, l.video_provider, l.thumbnail_url, l.duration_min,
         l.teacher_name, l.difficulty, l.sort_order, l.active, l.summary, l.created_at, l.updated_at,
         l.subject_id, s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
         l.topic_id, t.name AS topic_name, l.subtopic_id, st.name AS subtopic_name,
         coalesce(ex.exams, '[]'::json) AS exams,
         coalesce(ex.exam_ids, '{}'::uuid[]) AS exam_ids
    FROM lessons l
    JOIN subjects s ON s.id = l.subject_id
    JOIN topics t ON t.id = l.topic_id
    LEFT JOIN subtopics st ON st.id = l.subtopic_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', e.id, 'slug', e.slug, 'short_name', e.short_name) ORDER BY e.sort_order, e.name) AS exams,
             array_agg(e.id) AS exam_ids
        FROM lesson_exams le JOIN exams e ON e.id = le.exam_id
       WHERE le.lesson_id = l.id
    ) ex ON true`;

/** Confere coerência matéria → assunto → subassunto. */
async function assertClassification({ subject_id, topic_id, subtopic_id }) {
  const topic = await db.one('SELECT id, subject_id FROM topics WHERE id = $1', [topic_id]);
  if (!topic) throw new AppError(400, 'validation_error', 'Assunto não encontrado.', [{ path: 'topic_id', message: 'Assunto não encontrado.' }]);
  if (topic.subject_id !== subject_id) {
    throw new AppError(400, 'validation_error', 'O assunto não pertence à matéria selecionada.', [{ path: 'topic_id', message: 'Assunto de outra matéria.' }]);
  }
  if (subtopic_id) {
    const sub = await db.one('SELECT id, topic_id FROM subtopics WHERE id = $1', [subtopic_id]);
    if (!sub) throw new AppError(400, 'validation_error', 'Subassunto não encontrado.', [{ path: 'subtopic_id', message: 'Subassunto não encontrado.' }]);
    if (sub.topic_id !== topic_id) {
      throw new AppError(400, 'validation_error', 'O subassunto não pertence ao assunto selecionado.', [{ path: 'subtopic_id', message: 'Subassunto de outro assunto.' }]);
    }
  }
}

/** Provedor e miniatura derivados da URL do vídeo. */
function videoMeta(videoUrl, thumbnailUrl) {
  const value = String(videoUrl || '').trim();
  if (!value) return { video_url: null, video_provider: 'none', thumbnail_url: thumbnailUrl || null };
  // arquivo enviado pelo painel e servido pela própria plataforma
  if (isUploadedVideo(value)) {
    return { video_url: value, video_provider: 'upload', thumbnail_url: thumbnailUrl || null };
  }
  const parsed = parseVideoUrl(value);
  return {
    video_url: parsed.provider === 'none' ? null : parsed.url,
    video_provider: parsed.provider,
    thumbnail_url: thumbnailUrl || parsed.thumbnail_url || null,
  };
}

/**
 * Vídeo gravado pelo painel. Pode ser um endereço do Blob da Square Cloud
 * (https://public-blob.squarecloud.dev/...) ou, quando o provedor é o disco,
 * um caminho servido pela própria aplicação (/uploads/...).
 */
function isUploadedVideo(value) {
  const text = String(value || '').trim();
  if (/^https:\/\/[a-z0-9.-]*squarecloud\.dev\/\S+\.(mp4|webm|mov)$/i.test(text)) return true;
  return /^\/uploads\/[a-z]+\/[a-f0-9]{8,}\.(mp4|webm|mov)$/i.test(text);
}

/**
 * Confere que o arquivo apontado existe de fato. Só dá para verificar em
 * disco; no Blob a existência é garantida pela resposta do próprio envio.
 */
async function assertVideoFile(url) {
  if (!isUploadedVideo(url)) {
    throw new AppError(400, 'validation_error', 'Envie o arquivo do vídeo pelo painel antes de cadastrar a aula.', [
      { path: 'video_url', message: 'Arquivo de vídeo inválido.' },
    ]);
  }
  if (!String(url).startsWith('/uploads/')) return;
  const full = pathJoin(uploads.UPLOADS_DIR, String(url).replace('/uploads/', ''));
  try {
    await fsp.access(full);
  } catch {
    throw new AppError(400, 'validation_error', 'O arquivo deste vídeo não está mais no armazenamento.', [
      { path: 'video_url', message: 'Arquivo não encontrado.' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Cadastro em massa
//
// A equipe envia os arquivos das videoaulas pelo painel e cadastra todas de
// uma vez dentro do mesmo assunto. Os vídeos já subiram por
// POST /api/admin/uploads; aqui chegam só os caminhos, o título e a duração
// que o navegador leu de cada arquivo.
// ---------------------------------------------------------------------------

const MAX_IMPORT = 200;

const importItems = z
  .array(
    z.object({
      video_url: z.string().trim().min(1, 'Envie o arquivo do vídeo.').max(500),
      title: z.string().trim().min(3, 'Informe um título com pelo menos 3 caracteres.').max(200),
      duration_min: z.coerce.number().int().min(1).max(600).nullable().optional(),
      video_seconds: z.coerce.number().int().min(1).max(360000).nullable().optional(),
      video_bytes: z.coerce.number().int().min(0).nullable().optional(),
      video_mime: z.string().trim().max(80).nullable().optional(),
      thumbnail_url: nullableUrl,
    })
  )
  .min(1, 'Envie pelo menos um vídeo.')
  .max(MAX_IMPORT, `Cadastre no máximo ${MAX_IMPORT} aulas por vez.`);

router.post(
  '/import',
  validate({
    body: z.object({
      subject_id: uuid,
      topic_id: uuid,
      subtopic_id: optionalUuid,
      difficulty: z.coerce.number().int().min(1).max(3).optional(),
      teacher_name: z.string().trim().max(120).nullable().optional(),
      duration_min: z.coerce.number().int().min(1).max(600).optional(),
      active: z.boolean().optional(),
      exam_ids: z.array(uuid).max(50).optional(),
      skip_existing: z.boolean().optional(),
      items: importItems,
    }),
  }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertClassification(body);
    const examIds = await assertExamsExist(db, body.exam_ids);
    const skipExisting = body.skip_existing !== false;

    let order = Number(
      (await db.one('SELECT coalesce(max(sort_order), 0) AS last FROM lessons WHERE topic_id = $1', [body.topic_id])).last
    );

    const created = [];
    const errors = [];
    const seen = new Set();

    for (const [index, item] of body.items.entries()) {
      const line = index + 1;
      const title = item.title.trim();
      try {
        await assertVideoFile(item.video_url);

        if (seen.has(item.video_url)) {
          errors.push({ line, title, message: 'O mesmo arquivo aparece duas vezes na lista.' });
          continue;
        }
        seen.add(item.video_url);

        if (skipExisting) {
          const existing = await db.one('SELECT id FROM lessons WHERE video_url = $1', [item.video_url]);
          if (existing) {
            errors.push({ line, title, message: 'Já existe uma aula com este vídeo.' });
            continue;
          }
        }

        const slug = await uniqueSlug(title, async (candidate) =>
          Boolean(await db.one('SELECT 1 FROM lessons WHERE slug = $1', [candidate]))
        );
        order += 1;
        const position = order;
        const minutes = item.duration_min
          || (item.video_seconds ? Math.max(1, Math.round(item.video_seconds / 60)) : null)
          || body.duration_min
          || 30;

        // cada aula em sua própria transação: uma linha com problema não
        // derruba as que já entraram
        const id = await db.tx(async (client) => {
          const row = await client.one(
            `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, video_url, video_provider,
                                  thumbnail_url, duration_min, teacher_name, difficulty, sort_order, active,
                                  video_bytes, video_mime, video_seconds)
             VALUES ($1, $2, $3, $4, $5, $6, 'upload', $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [
              body.subject_id, body.topic_id, body.subtopic_id ?? null, slug, title,
              item.video_url, item.thumbnail_url ?? null, minutes,
              body.teacher_name ?? null, body.difficulty ?? 2, position, body.active ?? true,
              item.video_bytes ?? null, item.video_mime ?? null, item.video_seconds ?? null,
            ]
          );
          if (examIds.length) {
            await client.query(
              'INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING',
              [row.id, examIds]
            );
            await ensureExamCoverage(client, examIds, { topicId: body.topic_id, subjectId: body.subject_id });
          }
          return row.id;
        });

        created.push({ id, title, video_url: item.video_url, duration_min: minutes });
      } catch (err) {
        errors.push({ line, title, message: (err && err.message) || 'Não foi possível cadastrar esta aula.' });
      }
    }

    await audit(req, 'lesson.import', 'lesson', null, {
      topic_id: body.topic_id,
      imported: created.length,
      failed: errors.length,
    });

    res.status(created.length ? 201 : 200).json({ imported: created.length, failed: errors.length, created, errors });
  })
);

// ---------------------------------------------------------------------------
// utilitários (antes de /:id)
// ---------------------------------------------------------------------------
router.patch(
  '/reorder',
  validate({ body: z.object({ ids: z.array(uuid).min(1).max(5000) }) }),
  wrap(async (req, res) => {
    const ids = Array.from(new Set(req.valid.body.ids));
    const result = await db.query(
      `UPDATE lessons AS l SET sort_order = o.position
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
        WHERE l.id = o.id`,
      [ids]
    );
    await audit(req, 'lesson.reorder', 'lesson', null, { count: result.rowCount });
    res.json({ ok: true, updated: result.rowCount });
  })
);

// ---------------------------------------------------------------------------
// listagem e leitura
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const q = req.valid.query;
    const { page, limit, offset } = parsePagination(q, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(q, SORTABLE, { defaultSort: 'created_at', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (q.q) add(`(fe_unaccent(l.title) ILIKE fe_unaccent(?) OR l.search_vector @@ plainto_tsquery('portuguese', fe_unaccent(?)))`, `%${q.q}%`);
    if (q.q) clauses[clauses.length - 1] = clauses[clauses.length - 1].replace('?', `$${params.length}`);
    if (q.subject_id) add('l.subject_id = ?', q.subject_id);
    if (q.topic_id) add('l.topic_id = ?', q.topic_id);
    if (q.subtopic_id) add('l.subtopic_id = ?', q.subtopic_id);
    if (q.difficulty) add('l.difficulty = ?', q.difficulty);
    if (q.status) add('l.active = ?', q.status === 'active');
    if (q.exam_id) add('EXISTS (SELECT 1 FROM lesson_exams le2 WHERE le2.lesson_id = l.id AND le2.exam_id = ?)', q.exam_id);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await db.one(`SELECT count(*)::int AS total FROM lessons l ${where}`, params);
    const items = await db.many(
      `${SELECT_LESSON} ${where} ORDER BY ${sort.sql}, l.title ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    for (const item of items) delete item.summary;
    res.json(paginate(items, totalRow.total, { page, limit }));
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [req.valid.params.id]);
    if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    const stats = await db.one(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*)::int AS started
         FROM lesson_progress WHERE lesson_id = $1`,
      [lesson.id]
    );
    lesson.progress_stats = stats;
    res.json(lesson);
  })
);

// ---------------------------------------------------------------------------
// escrita
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate({ body: lessonBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertClassification(body);
    const examIds = await assertExamsExist(db, body.exam_ids);
    if (body.video_url) await assertVideoFile(body.video_url);
    const slug = await uniqueSlug(body.title, async (s) => Boolean(await db.one('SELECT 1 FROM lessons WHERE slug = $1', [s])));
    const video = videoMeta(body.video_url, body.thumbnail_url);
    const order = body.sort_order ?? Number((await db.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM lessons WHERE topic_id = $1', [body.topic_id])).next);

    const id = await db.tx(async (client) => {
      const row = await client.one(
        `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, description, video_url, video_provider,
                              thumbnail_url, duration_min, teacher_name, difficulty, summary, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [
          body.subject_id, body.topic_id, body.subtopic_id ?? null, slug, body.title, body.description ?? null,
          video.video_url, video.video_provider, video.thumbnail_url, body.duration_min ?? 30, body.teacher_name ?? null,
          body.difficulty ?? 2, body.summary ?? null, order, body.active ?? true,
        ]
      );
      if (examIds.length) {
        await client.query('INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING', [row.id, examIds]);
        await ensureExamCoverage(client, examIds, { topicId: body.topic_id, subjectId: body.subject_id });
      }
      return row.id;
    });
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [id]);
    await audit(req, 'lesson.create', 'lesson', id, { title: body.title, exam_ids: examIds });
    res.status(201).json(lesson);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: lessonUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const current = await db.one('SELECT * FROM lessons WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    if (body.video_url) await assertVideoFile(body.video_url);

    const merged = {
      subject_id: body.subject_id ?? current.subject_id,
      topic_id: body.topic_id ?? current.topic_id,
      subtopic_id: body.subtopic_id === undefined ? current.subtopic_id : body.subtopic_id,
    };
    if (body.subject_id || body.topic_id || body.subtopic_id !== undefined) {
      // se a matéria/assunto mudou e o subassunto antigo não bate, ele é descartado
      if (body.subtopic_id === undefined && body.topic_id && body.topic_id !== current.topic_id) merged.subtopic_id = null;
      await assertClassification(merged);
    }
    const examIds = body.exam_ids !== undefined ? await assertExamsExist(db, body.exam_ids) : null;

    const fields = { ...body, ...merged };
    if (body.video_url !== undefined || body.thumbnail_url !== undefined) {
      const video = videoMeta(
        body.video_url === undefined ? current.video_url : body.video_url,
        body.thumbnail_url === undefined ? current.thumbnail_url : body.thumbnail_url
      );
      // ao trocar o vídeo sem informar miniatura, usa a miniatura derivada do novo vídeo
      if (body.video_url !== undefined && body.thumbnail_url === undefined) {
        const parsed = parseVideoUrl(body.video_url || '');
        video.thumbnail_url = parsed.thumbnail_url || (parsed.provider === 'none' ? null : current.thumbnail_url);
      }
      Object.assign(fields, video);
    }
    delete fields.exam_ids;

    await db.tx(async (client) => {
      const allowed = ['title', 'description', 'video_url', 'video_provider', 'thumbnail_url', 'duration_min', 'teacher_name',
        'subject_id', 'topic_id', 'subtopic_id', 'difficulty', 'sort_order', 'summary', 'active'];
      const sets = [];
      const params = [];
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await client.query(`UPDATE lessons SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (examIds) {
        await client.query('DELETE FROM lesson_exams WHERE lesson_id = $1 AND NOT (exam_id = ANY($2::uuid[]))', [id, examIds]);
        if (examIds.length) {
          await client.query('INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING', [id, examIds]);
          await ensureExamCoverage(client, examIds, { topicId: merged.topic_id, subjectId: merged.subject_id });
        }
      }
    });
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [id]);
    await audit(req, 'lesson.update', 'lesson', id, { changes: Object.keys(body) });
    res.json(lesson);
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const lesson = await db.one('SELECT id, title FROM lessons WHERE id = $1', [id]);
    if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    await db.query('DELETE FROM lessons WHERE id = $1', [id]);
    await audit(req, 'lesson.delete', 'lesson', id, { title: lesson.title });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/lessons', router };

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
 *   POST   /api/admin/lessons/parse-video     { url } → provider, embed, miniatura, título/duração quando disponíveis
 *   PATCH  /api/admin/lessons/reorder         { ids[] } → sort_order pela posição
 *   POST   /api/admin/lessons/import/preview   { text|items[] } → metadados de cada link, sem gravar
 *   POST   /api/admin/lessons/import           cria várias aulas de uma vez no mesmo assunto
 */
const router = require('express').Router();
const db = require('../../db/pool');
const config = require('../../config');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { uniqueSlug } = require('../../utils/slug');
const { parseVideoUrl } = require('../../utils/video');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { ensureExamCoverage, assertExamsExist } = require('./content');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());
const nullableUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.string().trim().url('URL inválida.').max(2000).nullable().optional()
);

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
  const parsed = parseVideoUrl(videoUrl || '');
  return {
    video_url: parsed.provider === 'none' ? null : parsed.url,
    video_provider: parsed.provider,
    thumbnail_url: thumbnailUrl || parsed.thumbnail_url || null,
  };
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Importação em massa
//
// A equipe grava as aulas no YouTube e cadastra os links. Uma a uma seria uma
// tarde inteira, então aqui ela cola a lista, confere a prévia (título e
// miniatura vêm do próprio vídeo) e confirma tudo de uma vez.
// ---------------------------------------------------------------------------

const MAX_IMPORT = 200;

/**
 * Lê o texto colado. Uma aula por linha, no formato:
 *   https://youtu.be/abc123
 *   https://youtu.be/abc123 | Título escolhido à mão
 * Linhas em branco e começadas por # são ignoradas.
 */
function parseImportText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [url, ...rest] = line.split('|');
      return { url: url.trim(), title: rest.join('|').trim() || null };
    })
    .filter((item) => item.url);
}

/** Metadados de um link: provedor, miniatura e, quando o vídeo informa, título e duração. */
async function describeVideo(url) {
  const parsed = parseVideoUrl(url);
  const out = {
    url,
    provider: parsed.provider,
    video_url: parsed.provider === 'none' ? null : parsed.url,
    thumbnail_url: parsed.thumbnail_url || null,
    title: null,
    duration_min: null,
  };
  if (config.isTest) return out;
  if (parsed.provider !== 'youtube' && parsed.provider !== 'vimeo') return out;

  const endpoint = parsed.provider === 'youtube'
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
    : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(parsed.url)}`;
  const data = await fetchJson(endpoint);
  if (data) {
    if (typeof data.title === 'string') out.title = data.title.slice(0, 200);
    if (!out.thumbnail_url && typeof data.thumbnail_url === 'string') out.thumbnail_url = data.thumbnail_url;
    const seconds = Number(data.duration);
    if (Number.isFinite(seconds) && seconds > 0) out.duration_min = Math.max(1, Math.round(seconds / 60));
  }
  return out;
}

/** Consulta os links em pequenos lotes para não abrir 200 conexões de uma vez. */
async function describeAll(items) {
  const out = [];
  const BATCH = 6;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const described = await Promise.all(slice.map((item) => describeVideo(item.url)));
    described.forEach((meta, index) => {
      out.push({ ...meta, title: slice[index].title || meta.title });
    });
  }
  return out;
}

const importItems = z
  .array(
    z.object({
      url: z.string().trim().min(1, 'Informe o link.').max(2000),
      title: z.string().trim().max(200).nullable().optional(),
      duration_min: z.coerce.number().int().min(1).max(600).nullable().optional(),
      thumbnail_url: nullableUrl,
    })
  )
  .min(1, 'Informe pelo menos um link.')
  .max(MAX_IMPORT, `Importe no máximo ${MAX_IMPORT} aulas por vez.`);

const importSource = z
  .object({
    text: z.string().max(60000).optional(),
    items: importItems.optional(),
  })
  .refine((body) => body.text || body.items, 'Cole os links das aulas.');

router.post(
  '/import/preview',
  validate({ body: importSource }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const parsed = body.items ? body.items.map((i) => ({ url: i.url, title: i.title || null })) : parseImportText(body.text);
    if (!parsed.length) throw new AppError(400, 'validation_error', 'Nenhum link encontrado no texto.');
    if (parsed.length > MAX_IMPORT) {
      throw new AppError(400, 'validation_error', `Importe no máximo ${MAX_IMPORT} aulas por vez.`);
    }

    const described = await describeAll(parsed);
    const urls = described.map((item) => item.video_url).filter(Boolean);
    const known = urls.length
      ? await db.many('SELECT video_url, title FROM lessons WHERE video_url = ANY($1::text[])', [urls])
      : [];
    const byUrl = new Map(known.map((row) => [row.video_url, row.title]));

    const seen = new Set();
    const items = described.map((item) => {
      const duplicatedInList = item.video_url ? seen.has(item.video_url) : false;
      if (item.video_url) seen.add(item.video_url);
      const existing = item.video_url ? byUrl.get(item.video_url) : null;
      return {
        ...item,
        already_registered: Boolean(existing),
        existing_title: existing || null,
        duplicated_in_list: duplicatedInList,
        valid: item.provider !== 'none',
      };
    });

    res.json({
      items,
      total: items.length,
      ready: items.filter((item) => item.valid && !item.already_registered && !item.duplicated_in_list).length,
    });
  })
);

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

    const described = await describeAll(body.items.map((i) => ({ url: i.url, title: i.title || null })));
    // preserva a duração e a miniatura que o administrador ajustou na prévia
    described.forEach((meta, index) => {
      const chosen = body.items[index] || {};
      if (chosen.duration_min) meta.duration_min = chosen.duration_min;
      if (chosen.thumbnail_url) meta.thumbnail_url = chosen.thumbnail_url;
    });

    let order = Number(
      (await db.one('SELECT coalesce(max(sort_order), 0) AS last FROM lessons WHERE topic_id = $1', [body.topic_id])).last
    );

    const created = [];
    const errors = [];
    const seen = new Set();

    for (const [index, meta] of described.entries()) {
      const line = index + 1;
      try {
        if (meta.provider === 'none') {
          errors.push({ line, url: meta.url, message: 'Link de vídeo não reconhecido.' });
          continue;
        }
        if (seen.has(meta.video_url)) {
          errors.push({ line, url: meta.url, message: 'Link repetido na própria lista.' });
          continue;
        }
        seen.add(meta.video_url);

        if (skipExisting) {
          const existing = await db.one('SELECT id FROM lessons WHERE video_url = $1', [meta.video_url]);
          if (existing) {
            errors.push({ line, url: meta.url, message: 'Já existe uma aula com este vídeo.' });
            continue;
          }
        }

        const title = (meta.title || '').trim() || `Aula ${line}`;
        if (title.length < 3) {
          errors.push({ line, url: meta.url, message: 'Informe um título com pelo menos 3 caracteres.' });
          continue;
        }

        const slug = await uniqueSlug(title, async (candidate) =>
          Boolean(await db.one('SELECT 1 FROM lessons WHERE slug = $1', [candidate]))
        );
        order += 1;
        const position = order;

        // cada aula em sua própria transação: uma linha com problema não
        // derruba as que já entraram
        const id = await db.tx(async (client) => {
          const row = await client.one(
            `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, video_url, video_provider,
                                  thumbnail_url, duration_min, teacher_name, difficulty, sort_order, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
            [
              body.subject_id, body.topic_id, body.subtopic_id ?? null, slug, title,
              meta.video_url, meta.provider, meta.thumbnail_url,
              meta.duration_min || body.duration_min || 30,
              body.teacher_name ?? null, body.difficulty ?? 2, position, body.active ?? true,
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

        created.push({ id, title, url: meta.url, thumbnail_url: meta.thumbnail_url, duration_min: meta.duration_min });
      } catch (err) {
        errors.push({ line, url: meta.url, message: (err && err.message) || 'Não foi possível cadastrar esta aula.' });
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
router.post(
  '/parse-video',
  validate({ body: z.object({ url: z.string().trim().min(1, 'Informe a URL.').max(2000) }) }),
  wrap(async (req, res) => {
    const parsed = parseVideoUrl(req.valid.body.url);
    const out = { ...parsed, title: null, duration_min: null };
    if (parsed.provider === 'none') {
      return res.json(out);
    }
    // oEmbed público (sem chave): título e miniatura; o Vimeo também devolve a duração
    if (!config.isTest && (parsed.provider === 'youtube' || parsed.provider === 'vimeo')) {
      const endpoint = parsed.provider === 'youtube'
        ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
        : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(parsed.url)}`;
      const data = await fetchJson(endpoint);
      if (data) {
        if (typeof data.title === 'string') out.title = data.title.slice(0, 200);
        if (!out.thumbnail_url && typeof data.thumbnail_url === 'string') out.thumbnail_url = data.thumbnail_url;
        if (Number.isFinite(Number(data.duration)) && Number(data.duration) > 0) out.duration_min = Math.max(1, Math.round(Number(data.duration) / 60));
      }
    }
    res.json(out);
  })
);

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

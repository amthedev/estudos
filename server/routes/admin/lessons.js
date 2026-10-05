'use strict';

/**
 * Painel administrativo — aulas.
 *
 *   GET    /api/admin/lessons                 lista paginada (q, subject_id, topic_id, subtopic_id, exam_id,
 *                                             difficulty, status=active|inactive, sort, dir)
 *   GET    /api/admin/lessons/:id             aula completa com exam_ids e topics[] (assuntos na ordem)
 *   POST   /api/admin/lessons                 cria (slug gerado do título; exam_ids → lesson_exams
 *                                             + garante exam_topics/exam_subjects)
 *   PUT    /api/admin/lessons/:id             edita (parcial)
 *   DELETE /api/admin/lessons/:id
 *   PATCH  /api/admin/lessons/reorder         { ids[] } → sort_order pela posição
 *   POST   /api/admin/lessons/import          cadastra várias aulas de uma vez a partir de
 *                                             vídeos já enviados ao armazenamento da plataforma
 *   POST   /api/admin/lessons/analyze-titles  { subject_id, titles[] } → proposta de assuntos por
 *                                             título, SEM gravar nada
 *   POST   /api/admin/lessons/reidentify      { ids[] } → reidentifica os assuntos pelo título e grava
 *   POST   /api/admin/lessons/:id/reidentify  o mesmo, para uma aula
 *   POST   /api/admin/lessons/requeue-questions      { ids[] } → "Preparar as questões de novo"
 *   POST   /api/admin/lessons/:id/requeue-questions  o mesmo, para uma aula (devolve a aula)
 *
 * As videoaulas são arquivos enviados pelo painel (MP4, WEBM ou MOV). O envio em
 * si acontece em POST /api/admin/uploads, que grava em fluxo; aqui chegam apenas
 * os caminhos resultantes.
 *
 * Assuntos da aula: uma aula cobre de 1 a 3 assuntos da mesma matéria
 * (lesson_topics, na ordem do título). Quem escreve aceita
 *   topics: [{ topic_id?, subtopic_id?, new_topic_name?, label?, source?: 'manual'|'ia' }]
 * e o formato antigo (topic_id + subtopic_id, um assunto só). lessons.topic_id
 * é sempre o primeiro da lista. Cadastrar a aula ou mudar os assuntos dela põe
 * as questões da aula na fila (questions_status = 'pending').
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
const { assertExamsExist } = require('./content');
const lessonTopics = require('../../services/lesson-topics');
const lessonQuestions = require('../../services/lesson-questions');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const optionalUuid = z.preprocess(emptyToUndefined, uuid.optional());
const nullableUuid = z.preprocess((v) => (v === '' ? null : v), uuid.nullable().optional());
const nullableUrl = nullableFileRef(2000, 'Informe um endereço válido ou envie o arquivo.');

/** Um assunto da aula: existente (topic_id/subtopic_id) ou novo, pelo nome. */
const topicChoice = z
  .object({
    topic_id: nullableUuid,
    subtopic_id: nullableUuid,
    new_topic_name: z.string().trim().min(2, 'Informe pelo menos 2 caracteres.').max(120).nullable().optional(),
    label: z.string().trim().max(200).nullable().optional(),
    source: z.enum(['manual', 'ia']).optional(),
  })
  .refine((v) => Boolean(v.topic_id || v.subtopic_id || v.new_topic_name), {
    message: 'Escolha um assunto ou informe o nome do assunto novo.',
  });
const topicsField = z
  .array(topicChoice)
  .min(1, 'Escolha pelo menos um assunto para a aula.')
  .max(lessonTopics.MAX_ASSUNTOS, `Uma aula tem no máximo ${lessonTopics.MAX_ASSUNTOS} assuntos.`);

const lessonBody = z.object({
  title: z.string().trim().min(3, 'Informe pelo menos 3 caracteres.').max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  video_url: nullableUrl,
  thumbnail_url: nullableUrl,
  duration_min: z.coerce.number().int().min(1).max(600).optional(),
  teacher_name: z.string().trim().max(120).nullable().optional(),
  subject_id: uuid,
  // formato antigo, um assunto só; sem ele e sem topics, o assunto sai do título
  topic_id: optionalUuid,
  subtopic_id: nullableUuid,
  topics: topicsField.optional(),
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
         coalesce(tp.topics, '[]'::json) AS topics,
         l.questions_status, l.questions_error, l.questions_updated_at,
         coalesce(ex.exams, '[]'::json) AS exams,
         coalesce(ex.exam_ids, '{}'::uuid[]) AS exam_ids
    FROM lessons l
    JOIN subjects s ON s.id = l.subject_id
    JOIN topics t ON t.id = l.topic_id
    LEFT JOIN subtopics st ON st.id = l.subtopic_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'position', lt.position, 'topic_id', lt.topic_id, 'topic_name', tt.name, 'topic_slug', tt.slug,
               'subtopic_id', lt.subtopic_id, 'subtopic_name', sst.name, 'label', lt.label, 'source', lt.source
             ) ORDER BY lt.position) AS topics
        FROM lesson_topics lt
        JOIN topics tt ON tt.id = lt.topic_id
        LEFT JOIN subtopics sst ON sst.id = lt.subtopic_id
       WHERE lt.lesson_id = l.id
    ) tp ON true
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
// Assuntos da aula
// ---------------------------------------------------------------------------

/** Provas em que a aula cai: os assuntos dela entram no conteúdo programático dessas provas. */
async function lessonExamIds(lessonId) {
  const rows = await db.many('SELECT exam_id FROM lesson_exams WHERE lesson_id = $1', [lessonId]);
  return rows.map((row) => row.exam_id);
}

/**
 * Os assuntos de uma aula nova a partir do corpo da requisição:
 * topics[] (escolhidos no painel) > topic_id (formato antigo) > o título.
 */
async function topicsForNewLesson(req, body, examIds) {
  if (body.topics && body.topics.length) {
    return lessonTopics.resolveTopics(body.subject_id, body.topics, { req, examIds });
  }
  if (body.topic_id) {
    await assertClassification(body);
    return lessonTopics.resolveTopics(
      body.subject_id,
      [{ topic_id: body.topic_id, subtopic_id: body.subtopic_id ?? null }],
      { req, examIds }
    );
  }
  const [found] = await lessonTopics.identify({ subjectId: body.subject_id, titles: [body.title] });
  if (!found || !found.topics.length) {
    const message = 'Não deu para identificar o assunto pelo título. Escolha o assunto da aula.';
    throw new AppError(400, 'validation_error', message, [{ path: 'topics', message }]);
  }
  return lessonTopics.resolveTopics(body.subject_id, found.topics, { req, examIds, source: 'ia' });
}

/** O que a resposta conta de cada assunto gravado. */
function topicSummary(list) {
  return list.map((t) => ({
    topic_id: t.topic_id,
    topic_name: t.topic_name,
    subtopic_id: t.subtopic_id,
    subtopic_name: t.subtopic_name,
    label: t.label,
    source: t.source,
    created: t.created,
  }));
}

// ---------------------------------------------------------------------------
// Cadastro em massa
//
// A equipe envia os arquivos das videoaulas pelo painel e cadastra todas de
// uma vez dentro da mesma matéria. Os vídeos já subiram por
// POST /api/admin/uploads; aqui chegam só os caminhos, o título e a duração
// que o navegador leu de cada arquivo.
//
// O assunto deixou de ser um só para o lote: cada aula traz os seus (topics,
// normalmente a proposta de analyze-titles conferida na tela). O assunto do
// lote, quando vem, é o PADRÃO para as aulas que chegam sem topics. Sem
// nenhum dos dois, o assunto sai do título aqui mesmo — com o prazo da
// identificação; para lote grande, a tela chama analyze-titles antes.
// ---------------------------------------------------------------------------

const MAX_IMPORT = 200;
const MAX_REIDENTIFY = 100;
/** Pôr de novo na fila é só um UPDATE: cabe a seleção de várias páginas da lista. */
const MAX_REQUEUE = 1000;

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
      topics: topicsField.optional(),
    })
  )
  .min(1, 'Envie pelo menos um vídeo.')
  .max(MAX_IMPORT, `Cadastre no máximo ${MAX_IMPORT} aulas por vez.`);

router.post(
  '/import',
  validate({
    body: z.object({
      subject_id: uuid,
      // assunto padrão: vale para as aulas que chegam sem topics
      topic_id: optionalUuid,
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
    const subject = await db.one('SELECT id FROM subjects WHERE id = $1', [body.subject_id]);
    if (!subject) {
      throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [{ path: 'subject_id', message: 'Matéria não encontrada.' }]);
    }
    let padrao = null;
    if (body.topic_id) {
      await assertClassification(body);
      padrao = [{ topic_id: body.topic_id, subtopic_id: body.subtopic_id ?? null }];
    }
    const examIds = await assertExamsExist(db, body.exam_ids);
    const skipExisting = body.skip_existing !== false;

    // Aulas sem assunto num lote sem assunto padrão: o assunto sai do título,
    // numa identificação só para o lote (uma chamada de IA serve 30 títulos).
    const semAssunto = padrao
      ? []
      : body.items.map((item, index) => (item.topics && item.topics.length ? -1 : index)).filter((index) => index >= 0);
    const identificadas = new Map();
    if (semAssunto.length) {
      const found = await lessonTopics.identify({
        subjectId: body.subject_id,
        titles: semAssunto.map((index) => body.items[index].title),
      });
      semAssunto.forEach((index, k) => identificadas.set(index, found[k]));
    }

    // A ordem continua de onde o assunto principal de cada aula parou.
    const ordens = new Map();
    async function nextOrder(topicId) {
      if (!ordens.has(topicId)) {
        const row = await db.one('SELECT coalesce(max(sort_order), 0) AS last FROM lessons WHERE topic_id = $1', [topicId]);
        ordens.set(topicId, Number(row.last) || 0);
      }
      const next = ordens.get(topicId) + 1;
      ordens.set(topicId, next);
      return next;
    }

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

        let escolha;
        let source = 'manual';
        if (item.topics && item.topics.length) {
          escolha = item.topics;
        } else if (padrao) {
          escolha = padrao;
        } else {
          const found = identificadas.get(index);
          if (!found || !found.topics.length) {
            const motivo = found && found.error ? ` (${found.error})` : '';
            errors.push({
              line,
              title,
              message: `Não deu para identificar o assunto pelo título${motivo}. Escolha o assunto desta aula.`,
            });
            continue;
          }
          escolha = found.topics;
          source = 'ia';
        }
        const assuntos = await lessonTopics.resolveTopics(body.subject_id, escolha, {
          req,
          examIds,
          source,
          path: `items.${index}.topics`,
        });
        const principal = assuntos[0];

        const slug = await uniqueSlug(title, async (candidate) =>
          Boolean(await db.one('SELECT 1 FROM lessons WHERE slug = $1', [candidate]))
        );
        const position = await nextOrder(principal.topic_id);
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
                                  video_bytes, video_mime, video_seconds, questions_status, questions_updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'upload', $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', now())
             RETURNING id`,
            [
              body.subject_id, principal.topic_id, principal.subtopic_id, slug, title,
              item.video_url, item.thumbnail_url ?? null, minutes,
              body.teacher_name ?? null, body.difficulty ?? 2, position, body.active ?? true,
              item.video_bytes ?? null, item.video_mime ?? null, item.video_seconds ?? null,
            ]
          );
          await lessonTopics.writeLessonTopics(client, row.id, assuntos);
          if (examIds.length) {
            await client.query(
              'INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING',
              [row.id, examIds]
            );
            await lessonTopics.coverLessonTopics(client, examIds, body.subject_id, assuntos);
          }
          return row.id;
        });

        created.push({ id, title, video_url: item.video_url, duration_min: minutes, topics: topicSummary(assuntos) });
      } catch (err) {
        errors.push({ line, title, message: (err && err.message) || 'Não foi possível cadastrar esta aula.' });
      }
    }

    await audit(req, 'lesson.import', 'lesson', null, {
      subject_id: body.subject_id,
      topic_id: body.topic_id ?? null,
      identified_by_title: semAssunto.length,
      imported: created.length,
      failed: errors.length,
    });

    res.status(created.length ? 201 : 200).json({ imported: created.length, failed: errors.length, created, errors });
  })
);

// ---------------------------------------------------------------------------
// Identificação dos assuntos pelo título
// ---------------------------------------------------------------------------

/**
 * Proposta de assuntos para cada título, sem gravar nada. A tela do envio em
 * massa chama assim que os arquivos são escolhidos, para o administrador
 * conferir os assuntos antes de enviar.
 *
 *   → { subject_id, items: [{ title, via, error?, topics: [{ label, topic_id, subtopic_id,
 *                                                         new_topic_name, topic_name, subtopic_name }] }] }
 */
router.post(
  '/analyze-titles',
  validate({
    body: z.object({
      subject_id: uuid,
      titles: z.array(z.string().max(300)).min(1, 'Envie pelo menos um título.').max(MAX_IMPORT),
    }),
  }),
  wrap(async (req, res) => {
    const { subject_id: subjectId, titles } = req.valid.body;
    const items = await lessonTopics.identify({ subjectId, titles });
    res.json({ subject_id: subjectId, items });
  })
);

/**
 * Reidentifica os assuntos das aulas pelo título e grava. Serve para as aulas
 * cadastradas antes de a aula ter vários assuntos: todas ficaram com o
 * assunto único que tinham.
 */
async function reidentify(req, ids) {
  const lessons = await db.many(
    `SELECT l.id, l.title, l.subject_id,
            coalesce(array_agg(le.exam_id) FILTER (WHERE le.exam_id IS NOT NULL), '{}'::uuid[]) AS exam_ids
       FROM lessons l
       LEFT JOIN lesson_exams le ON le.lesson_id = l.id
      WHERE l.id = ANY($1::uuid[])
      GROUP BY l.id`,
    [ids]
  );
  const bySubject = new Map();
  for (const lesson of lessons) {
    if (!bySubject.has(lesson.subject_id)) bySubject.set(lesson.subject_id, []);
    bySubject.get(lesson.subject_id).push(lesson);
  }

  // um prazo para a requisição inteira, não para cada matéria
  const deadline = Date.now() + lessonTopics.PRAZO_INTERATIVO_MS;
  const results = new Map();
  for (const [subjectId, group] of bySubject) {
    const found = await lessonTopics.identify({
      subjectId,
      titles: group.map((lesson) => lesson.title),
      deadlineMs: Math.max(0, deadline - Date.now()),
    });
    for (const [k, lesson] of group.entries()) {
      const proposta = found[k];
      const base = { id: lesson.id, title: lesson.title, via: proposta.via };
      if (!proposta.topics.length) {
        results.set(lesson.id, {
          ...base,
          status: 'sem_assunto',
          message: proposta.error
            ? `Não deu para identificar o assunto pelo título (${proposta.error}). A aula ficou como estava.`
            : 'Nenhum assunto reconhecido no título. A aula ficou como estava.',
        });
        continue;
      }
      try {
        const assuntos = await lessonTopics.resolveTopics(subjectId, proposta.topics, {
          req,
          examIds: lesson.exam_ids,
          source: 'ia',
        });
        const { changed } = await db.tx(async (client) => {
          const out = await lessonTopics.writeLessonTopics(client, lesson.id, assuntos);
          await lessonTopics.coverLessonTopics(client, lesson.exam_ids, subjectId, assuntos);
          return out;
        });
        results.set(lesson.id, { ...base, status: changed ? 'atualizada' : 'sem_mudanca' });
      } catch (err) {
        results.set(lesson.id, { ...base, status: 'erro', message: (err && err.message) || 'Não foi possível gravar.' });
      }
    }
  }

  const rows = lessons.length ? await db.many(`${SELECT_LESSON} WHERE l.id = ANY($1::uuid[])`, [lessons.map((l) => l.id)]) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = ids
    .filter((id) => results.has(id))
    .map((id) => {
      const lesson = byId.get(id);
      if (lesson) delete lesson.summary;
      return { ...results.get(id), lesson: lesson || null };
    });
  const count = (status) => items.filter((item) => item.status === status).length;
  const summary = {
    updated: count('atualizada'),
    unchanged: count('sem_mudanca'),
    unidentified: count('sem_assunto'),
    failed: count('erro'),
    not_found: ids.length - items.length,
  };
  await audit(req, 'lesson.reidentify', 'lesson', ids.length === 1 ? ids[0] : null, { ids: ids.slice(0, MAX_REIDENTIFY), ...summary });
  return { ...summary, items };
}

router.post(
  '/reidentify',
  validate({ body: z.object({ ids: z.array(uuid).min(1).max(MAX_REIDENTIFY, `Reidentifique no máximo ${MAX_REIDENTIFY} aulas por vez.`) }) }),
  wrap(async (req, res) => {
    res.json(await reidentify(req, Array.from(new Set(req.valid.body.ids))));
  })
);

router.post(
  '/:id/reidentify',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const result = await reidentify(req, [req.valid.params.id]);
    if (!result.items.length) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    res.json(result.items[0]);
  })
);

/**
 * "Preparar as questões de novo". A fila (services/lesson-questions.js) para
 * de tentar uma aula depois de três rodadas ruins, e a aula pronta pode ter
 * perdido uma questão apagada no banco; sem esta ação a aula ficava em
 * "Falharam" para sempre, e o jeito era trocar os assuntos e desfazer a troca.
 * A rodada seguinte só pede à IA o que ainda falta. A aula que já está na fila
 * ou sendo preparada fica como está.
 */
router.post(
  '/requeue-questions',
  validate({
    body: z.object({
      ids: z.array(uuid).min(1).max(MAX_REQUEUE, `Marque no máximo ${MAX_REQUEUE} aulas por vez.`),
    }),
  }),
  wrap(async (req, res) => {
    const ids = Array.from(new Set(req.valid.body.ids));
    const queued = await lessonQuestions.requeue(ids);
    await audit(req, 'lesson.questions_requeue', 'lesson', ids.length === 1 ? ids[0] : null, {
      requested: ids.length,
      ids: queued,
    });
    res.json({ queued: queued.length, unchanged: ids.length - queued.length, ids: queued });
  })
);

router.post(
  '/:id/requeue-questions',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const current = await db.one('SELECT questions_status FROM lessons WHERE id = $1', [id]);
    if (!current) throw new AppError(404, 'not_found', 'Aula não encontrada.');
    const queued = await lessonQuestions.requeue([id]);
    if (!queued.length) {
      throw new AppError(409, 'conflict', 'As questões desta aula já estão na fila ou sendo preparadas agora.');
    }
    await audit(req, 'lesson.questions_requeue', 'lesson', id, { requested: 1, ids: queued });
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [id]);
    delete lesson.summary;
    res.json(lesson);
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
    // a aula aparece no filtro de qualquer um dos assuntos dela, não só do principal
    if (q.topic_id) add('EXISTS (SELECT 1 FROM lesson_topics ltf WHERE ltf.lesson_id = l.id AND ltf.topic_id = ?)', q.topic_id);
    if (q.subtopic_id) add('EXISTS (SELECT 1 FROM lesson_topics lsf WHERE lsf.lesson_id = l.id AND lsf.subtopic_id = ?)', q.subtopic_id);
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
    const examIds = await assertExamsExist(db, body.exam_ids);
    if (body.video_url) await assertVideoFile(body.video_url);
    // por último: pode cadastrar assunto novo, e nada antes disso pode falhar depois
    const topics = await topicsForNewLesson(req, body, examIds);
    const principal = topics[0];
    const slug = await uniqueSlug(body.title, async (s) => Boolean(await db.one('SELECT 1 FROM lessons WHERE slug = $1', [s])));
    const video = videoMeta(body.video_url, body.thumbnail_url);
    const order = body.sort_order ?? Number((await db.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM lessons WHERE topic_id = $1', [principal.topic_id])).next);

    const id = await db.tx(async (client) => {
      const row = await client.one(
        `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, description, video_url, video_provider,
                              thumbnail_url, duration_min, teacher_name, difficulty, summary, sort_order, active,
                              questions_status, questions_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', now()) RETURNING id`,
        [
          body.subject_id, principal.topic_id, principal.subtopic_id, slug, body.title, body.description ?? null,
          video.video_url, video.video_provider, video.thumbnail_url, body.duration_min ?? 30, body.teacher_name ?? null,
          body.difficulty ?? 2, body.summary ?? null, order, body.active ?? true,
        ]
      );
      await lessonTopics.writeLessonTopics(client, row.id, topics);
      if (examIds.length) {
        await client.query('INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING', [row.id, examIds]);
        await lessonTopics.coverLessonTopics(client, examIds, body.subject_id, topics);
      }
      return row.id;
    });
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [id]);
    await audit(req, 'lesson.create', 'lesson', id, {
      title: body.title,
      exam_ids: examIds,
      topic_ids: topics.map((t) => t.topic_id),
    });
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

    const subjectId = body.subject_id ?? current.subject_id;
    const examIds = body.exam_ids !== undefined ? await assertExamsExist(db, body.exam_ids) : null;

    // Os assuntos que a aula passa a ter, ou null quando não mudam.
    let nextTopics = null;
    if (body.topics && body.topics.length) {
      nextTopics = await lessonTopics.resolveTopics(subjectId, body.topics, {
        req,
        examIds: examIds ?? (await lessonExamIds(id)),
      });
    } else if (body.subject_id || body.topic_id || body.subtopic_id !== undefined) {
      // Formato antigo: troca só o assunto principal e mantém os outros que
      // continuam na matéria da aula.
      const merged = {
        subject_id: subjectId,
        topic_id: body.topic_id ?? current.topic_id,
        subtopic_id: body.subtopic_id === undefined ? current.subtopic_id : body.subtopic_id,
      };
      // se a matéria/assunto mudou e o subassunto antigo não bate, ele é descartado
      if (body.subtopic_id === undefined && body.topic_id && body.topic_id !== current.topic_id) merged.subtopic_id = null;
      await assertClassification(merged);
      const mudou = merged.subject_id !== current.subject_id
        || merged.topic_id !== current.topic_id
        || (merged.subtopic_id || null) !== (current.subtopic_id || null);
      if (mudou) {
        const others = await db.many(
          `SELECT lt.topic_id, lt.subtopic_id, lt.label, lt.source
             FROM lesson_topics lt JOIN topics t ON t.id = lt.topic_id
            WHERE lt.lesson_id = $1 AND lt.position > 1 AND t.subject_id = $2
            ORDER BY lt.position`,
          [id, merged.subject_id]
        );
        const principalKey = `${merged.topic_id}/${merged.subtopic_id || ''}`;
        nextTopics = [
          { topic_id: merged.topic_id, subtopic_id: merged.subtopic_id || null, label: null, source: 'manual' },
          ...others.filter((t) => `${t.topic_id}/${t.subtopic_id || ''}` !== principalKey),
        ].slice(0, lessonTopics.MAX_ASSUNTOS);
      }
    }

    const fields = { ...body };
    // o assunto principal é gravado junto com lesson_topics, logo abaixo
    delete fields.topic_id;
    delete fields.subtopic_id;
    delete fields.topics;
    delete fields.exam_ids;
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

    let topicsChanged = false;
    await db.tx(async (client) => {
      const allowed = ['title', 'description', 'video_url', 'video_provider', 'thumbnail_url', 'duration_min', 'teacher_name',
        'subject_id', 'difficulty', 'sort_order', 'summary', 'active'];
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
      if (nextTopics) {
        // assunto novo ou outra ordem: as questões da aula voltam para a fila
        ({ changed: topicsChanged } = await lessonTopics.writeLessonTopics(client, id, nextTopics));
      }
      if (examIds) {
        await client.query('DELETE FROM lesson_exams WHERE lesson_id = $1 AND NOT (exam_id = ANY($2::uuid[]))', [id, examIds]);
        if (examIds.length) {
          await client.query('INSERT INTO lesson_exams (lesson_id, exam_id) SELECT $1, e FROM unnest($2::uuid[]) AS e ON CONFLICT DO NOTHING', [id, examIds]);
        }
      }
      if (nextTopics || (examIds && examIds.length)) {
        const covered = nextTopics || (await client.many('SELECT topic_id FROM lesson_topics WHERE lesson_id = $1', [id]));
        const exams = examIds ?? (await client.many('SELECT exam_id FROM lesson_exams WHERE lesson_id = $1', [id])).map((r) => r.exam_id);
        await lessonTopics.coverLessonTopics(client, exams, subjectId, covered);
      }
    });
    const lesson = await db.one(`${SELECT_LESSON} WHERE l.id = $1`, [id]);
    await audit(req, 'lesson.update', 'lesson', id, { changes: Object.keys(body), topics_changed: topicsChanged });
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

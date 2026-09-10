'use strict';

/**
 * Painel administrativo — conteúdo da página inicial.
 *
 *   GET    /api/admin/landing/blocks                blocos de texto (inclusive os desativados)
 *   PUT    /api/admin/landing/blocks/:key           salva um bloco (envio parcial: só o que vier é alterado)
 *
 *   GET    /api/admin/landing/faqs                  perguntas frequentes
 *   POST   /api/admin/landing/faqs
 *   PUT    /api/admin/landing/faqs/:id
 *   DELETE /api/admin/landing/faqs/:id
 *   PATCH  /api/admin/landing/faqs/reorder          { ids[] } → sort_order pela posição na lista
 *
 *   GET    /api/admin/landing/testimonials          depoimentos
 *   POST   /api/admin/landing/testimonials
 *   PUT    /api/admin/landing/testimonials/:id
 *   DELETE /api/admin/landing/testimonials/:id
 *   PATCH  /api/admin/landing/testimonials/reorder  { ids[] }
 *
 *   GET    /api/admin/landing/exams                 provas com os campos da página inicial
 *   PUT    /api/admin/landing/exams/:id             { featured, logo_url, landing_headline, landing_text, landing_cta }
 *
 * Já está sob requireAdmin (montagem em app.js). Toda escrita registra auditoria e invalida o
 * cache de GET /api/landing, para que a página inicial mostre a alteração na hora.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { invalidateLandingCache } = require('../landing');

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const keyParams = z.object({
  key: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/, 'Identificador de bloco inválido.'),
});

/** Texto opcional: string vazia vira null (o campo fica em branco no banco). */
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const text = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

/** Endereço de imagem: URL completa ou caminho interno. */
const assetUrl = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => /^https?:\/\/\S+$/i.test(value) || value.startsWith('/'),
      'Use uma URL completa (https://…) ou um caminho interno começando com "/".'
    )
    .nullable()
    .optional()
);

/** Destino de botão: caminho interno, âncora, URL completa, e-mail ou telefone. */
const linkHref = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => /^(https?:\/\/|mailto:|tel:)\S+$/i.test(value) || value.startsWith('/') || value.startsWith('#'),
      'Use um caminho interno (/cadastro), uma âncora (#planos) ou uma URL completa.'
    )
    .nullable()
    .optional()
);

const sortField = z.coerce.number().int().min(0).max(100000).optional();

const itemSchema = z
  .object({
    icon: z.preprocess(
      emptyToNull,
      z.string().trim().max(60).regex(/^[a-z0-9-]+$/, 'Nome de ícone inválido.').nullable().optional()
    ),
    title: text(200),
    text: text(1000),
    cta_label: text(80),
    cta_href: linkHref,
    image_url: assetUrl,
  })
  .strict();

const blockBase = z
  .object({
    eyebrow: text(120),
    title: text(300),
    subtitle: text(600),
    body: text(6000),
    items: z.array(itemSchema).max(24, 'Use no máximo 24 itens por bloco.').optional(),
    cta_label: text(80),
    cta_href: linkHref,
    image_url: assetUrl,
    sort_order: sortField,
    active: z.boolean().optional(),
  })
  .strict();
const blockBody = blockBase.refine((value) => Object.keys(value).length > 0, 'Nada para salvar.');

const faqBase = z
  .object({
    question: z.string().trim().min(3, 'Escreva a pergunta.').max(300),
    answer: z.string().trim().min(1, 'Escreva a resposta.').max(6000),
    category: text(60),
    sort_order: sortField,
    active: z.boolean().optional(),
  })
  .strict();
const faqUpdate = faqBase.partial().refine((value) => Object.keys(value).length > 0, 'Nada para salvar.');

const testimonialBase = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome do aluno.').max(120),
    role: text(120),
    content: text(4000),
    image_url: assetUrl,
    photo_url: assetUrl,
    rating: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(5).nullable().optional()),
    exam_id: z.preprocess(emptyToNull, uuid.nullable().optional()),
    sort_order: sortField,
    active: z.boolean().optional(),
  })
  .strict();
const testimonialUpdate = testimonialBase.partial().refine((value) => Object.keys(value).length > 0, 'Nada para salvar.');

const examBody = z
  .object({
    featured: z.boolean().optional(),
    logo_url: assetUrl,
    landing_headline: text(120),
    landing_text: text(2000),
    landing_cta: text(80),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nada para salvar.');

const reorderBody = z.object({ ids: z.array(uuid).min(1).max(500) });

// ---------------------------------------------------------------------------
// utilitários
// ---------------------------------------------------------------------------
/** Aplica as chaves enviadas sobre o registro atual (envio parcial não apaga o resto). */
function merge(current, body, fields) {
  const result = {};
  for (const field of fields) {
    result[field] = Object.prototype.hasOwnProperty.call(body, field) ? body[field] : current[field];
  }
  return result;
}

/** Diferenças entre o antes e o depois, só das chaves realmente enviadas. */
function diffOf(before, after, body) {
  const diff = {};
  for (const key of Object.keys(body)) {
    const from = before ? before[key] : null;
    const to = after[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) diff[key] = { from, to };
  }
  return diff;
}

async function nextSortOrder(table) {
  const row = await db.one(`SELECT coalesce(max(sort_order), 0) + 1 AS next FROM ${table}`);
  return Number(row.next) || 1;
}

/** Depoimento precisa de conteúdo: texto do depoimento ou print da conversa. */
function ensureTestimonialContent(record) {
  const hasText = typeof record.content === 'string' && record.content.trim() !== '';
  const hasImage = typeof record.image_url === 'string' && record.image_url.trim() !== '';
  if (hasText || hasImage) return;
  throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
    { path: 'content', message: 'Escreva o depoimento ou informe a imagem do print da conversa.' },
    { path: 'image_url', message: 'Escreva o depoimento ou informe a imagem do print da conversa.' },
  ]);
}

async function ensureExam(examId) {
  if (!examId) return;
  const exam = await db.one('SELECT id FROM exams WHERE id = $1', [examId]);
  if (!exam) {
    throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
      { path: 'exam_id', message: 'Prova não encontrada.' },
    ]);
  }
}

const TESTIMONIAL_COLUMNS = `t.id, t.name, t.role, t.content, t.image_url, t.photo_url, t.rating, t.exam_id,
  t.sort_order, t.active, t.created_at, t.updated_at,
  e.short_name AS exam_short_name, e.name AS exam_name`;

const findTestimonial = (id) =>
  db.one(`SELECT ${TESTIMONIAL_COLUMNS} FROM testimonials t LEFT JOIN exams e ON e.id = t.exam_id WHERE t.id = $1`, [id]);

// ---------------------------------------------------------------------------
// blocos de texto
// ---------------------------------------------------------------------------
const BLOCK_FIELDS = ['eyebrow', 'title', 'subtitle', 'body', 'items', 'cta_label', 'cta_href', 'image_url', 'sort_order', 'active'];

router.get(
  '/blocks',
  wrap(async (req, res) => {
    const blocks = await db.many(
      `SELECT key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order, active, updated_at
         FROM landing_blocks
        ORDER BY sort_order ASC, key ASC`
    );
    res.json(blocks);
  })
);

router.put(
  '/blocks/:key',
  validate({ params: keyParams, body: blockBody }),
  wrap(async (req, res) => {
    const { key } = req.valid.params;
    const body = req.valid.body;
    const before = await db.one('SELECT * FROM landing_blocks WHERE key = $1', [key]);

    const current = before || {
      eyebrow: null, title: null, subtitle: null, body: null, items: [],
      cta_label: null, cta_href: null, image_url: null, sort_order: 0, active: true,
    };
    const next = merge(current, body, BLOCK_FIELDS);

    const saved = await db.one(
      `INSERT INTO landing_blocks (key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
       ON CONFLICT (key) DO UPDATE SET
         eyebrow = EXCLUDED.eyebrow, title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, body = EXCLUDED.body,
         items = EXCLUDED.items, cta_label = EXCLUDED.cta_label, cta_href = EXCLUDED.cta_href,
         image_url = EXCLUDED.image_url, sort_order = EXCLUDED.sort_order, active = EXCLUDED.active
       RETURNING key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order, active, updated_at`,
      [
        key, next.eyebrow, next.title, next.subtitle, next.body,
        JSON.stringify(Array.isArray(next.items) ? next.items : []),
        next.cta_label, next.cta_href, next.image_url,
        Number(next.sort_order) || 0, next.active !== false,
      ]
    );

    invalidateLandingCache();
    await audit(req, 'landing.block.update', 'landing_block', key, { created: !before, diff: diffOf(current, saved, body) });
    res.json(saved);
  })
);

// ---------------------------------------------------------------------------
// perguntas frequentes
// ---------------------------------------------------------------------------
router.get(
  '/faqs',
  wrap(async (req, res) => {
    const faqs = await db.many(
      `SELECT id, question, answer, category, sort_order, active, created_at, updated_at
         FROM faqs
        ORDER BY sort_order ASC, created_at ASC`
    );
    res.json(faqs);
  })
);

router.post(
  '/faqs',
  validate({ body: faqBase }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const order = body.sort_order ?? (await nextSortOrder('faqs'));
    const faq = await db.one(
      `INSERT INTO faqs (question, answer, category, sort_order, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, question, answer, category, sort_order, active, created_at, updated_at`,
      [body.question, body.answer, body.category ?? null, order, body.active !== false]
    );
    invalidateLandingCache();
    await audit(req, 'landing.faq.create', 'faq', faq.id, { question: faq.question });
    res.status(201).json(faq);
  })
);

router.patch(
  '/faqs/reorder',
  validate({ body: reorderBody }),
  wrap(async (req, res) => {
    const ids = Array.from(new Set(req.valid.body.ids));
    const updated = await db.tx(async (client) => {
      const result = await client.query(
        `UPDATE faqs AS f SET sort_order = o.position
           FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
          WHERE f.id = o.id`,
        [ids]
      );
      return result.rowCount;
    });
    invalidateLandingCache();
    await audit(req, 'landing.faq.reorder', 'faq', null, { count: updated });
    res.json({ ok: true, updated });
  })
);

router.put(
  '/faqs/:id',
  validate({ params: idParams, body: faqUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const before = await db.one('SELECT * FROM faqs WHERE id = $1', [id]);
    if (!before) throw new AppError(404, 'not_found', 'Pergunta não encontrada.');

    const next = merge(before, body, ['question', 'answer', 'category', 'sort_order', 'active']);
    const faq = await db.one(
      `UPDATE faqs SET question = $1, answer = $2, category = $3, sort_order = $4, active = $5
        WHERE id = $6
       RETURNING id, question, answer, category, sort_order, active, created_at, updated_at`,
      [next.question, next.answer, next.category ?? null, Number(next.sort_order) || 0, next.active !== false, id]
    );

    invalidateLandingCache();
    await audit(req, 'landing.faq.update', 'faq', id, { diff: diffOf(before, faq, body) });
    res.json(faq);
  })
);

router.delete(
  '/faqs/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const faq = await db.one('SELECT id, question FROM faqs WHERE id = $1', [id]);
    if (!faq) throw new AppError(404, 'not_found', 'Pergunta não encontrada.');
    await db.query('DELETE FROM faqs WHERE id = $1', [id]);
    invalidateLandingCache();
    await audit(req, 'landing.faq.delete', 'faq', id, { question: faq.question });
    res.json({ ok: true, message: 'Pergunta excluída.' });
  })
);

// ---------------------------------------------------------------------------
// depoimentos
// ---------------------------------------------------------------------------
const TESTIMONIAL_FIELDS = ['name', 'role', 'content', 'image_url', 'photo_url', 'rating', 'exam_id', 'sort_order', 'active'];

router.get(
  '/testimonials',
  wrap(async (req, res) => {
    const testimonials = await db.many(
      `SELECT ${TESTIMONIAL_COLUMNS}
         FROM testimonials t
         LEFT JOIN exams e ON e.id = t.exam_id
        ORDER BY t.sort_order ASC, t.created_at ASC`
    );
    res.json(testimonials);
  })
);

router.post(
  '/testimonials',
  validate({ body: testimonialBase }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    ensureTestimonialContent(body);
    await ensureExam(body.exam_id ?? null);

    const order = body.sort_order ?? (await nextSortOrder('testimonials'));
    const created = await db.one(
      `INSERT INTO testimonials (name, role, content, image_url, photo_url, rating, exam_id, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        body.name, body.role ?? null, body.content ?? null, body.image_url ?? null, body.photo_url ?? null,
        body.rating ?? null, body.exam_id ?? null, order, body.active !== false,
      ]
    );

    invalidateLandingCache();
    await audit(req, 'landing.testimonial.create', 'testimonial', created.id, { name: body.name });
    res.status(201).json(await findTestimonial(created.id));
  })
);

router.patch(
  '/testimonials/reorder',
  validate({ body: reorderBody }),
  wrap(async (req, res) => {
    const ids = Array.from(new Set(req.valid.body.ids));
    const updated = await db.tx(async (client) => {
      const result = await client.query(
        `UPDATE testimonials AS t SET sort_order = o.position
           FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
          WHERE t.id = o.id`,
        [ids]
      );
      return result.rowCount;
    });
    invalidateLandingCache();
    await audit(req, 'landing.testimonial.reorder', 'testimonial', null, { count: updated });
    res.json({ ok: true, updated });
  })
);

router.put(
  '/testimonials/:id',
  validate({ params: idParams, body: testimonialUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const before = await db.one('SELECT * FROM testimonials WHERE id = $1', [id]);
    if (!before) throw new AppError(404, 'not_found', 'Depoimento não encontrado.');

    const next = merge(before, body, TESTIMONIAL_FIELDS);
    ensureTestimonialContent(next);
    await ensureExam(next.exam_id ?? null);

    await db.query(
      `UPDATE testimonials SET name = $1, role = $2, content = $3, image_url = $4, photo_url = $5,
              rating = $6, exam_id = $7, sort_order = $8, active = $9
        WHERE id = $10`,
      [
        next.name, next.role ?? null, next.content ?? null, next.image_url ?? null, next.photo_url ?? null,
        next.rating ?? null, next.exam_id ?? null, Number(next.sort_order) || 0, next.active !== false, id,
      ]
    );

    const testimonial = await findTestimonial(id);
    invalidateLandingCache();
    await audit(req, 'landing.testimonial.update', 'testimonial', id, { diff: diffOf(before, testimonial, body) });
    res.json(testimonial);
  })
);

router.delete(
  '/testimonials/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const testimonial = await db.one('SELECT id, name FROM testimonials WHERE id = $1', [id]);
    if (!testimonial) throw new AppError(404, 'not_found', 'Depoimento não encontrado.');
    await db.query('DELETE FROM testimonials WHERE id = $1', [id]);
    invalidateLandingCache();
    await audit(req, 'landing.testimonial.delete', 'testimonial', id, { name: testimonial.name });
    res.json({ ok: true, message: 'Depoimento excluído.' });
  })
);

// ---------------------------------------------------------------------------
// provas em destaque
// ---------------------------------------------------------------------------
const EXAM_LANDING_COLUMNS = `id, slug, name, short_name, track, active, sort_order,
  featured, logo_url, landing_headline, landing_text, landing_cta`;

router.get(
  '/exams',
  wrap(async (req, res) => {
    const exams = await db.many(
      `SELECT ${EXAM_LANDING_COLUMNS} FROM exams ORDER BY featured DESC, sort_order ASC, short_name ASC`
    );
    res.json(exams);
  })
);

router.put(
  '/exams/:id',
  validate({ params: idParams, body: examBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const before = await db.one(`SELECT ${EXAM_LANDING_COLUMNS} FROM exams WHERE id = $1`, [id]);
    if (!before) throw new AppError(404, 'not_found', 'Prova não encontrada.');

    const next = merge(before, body, ['featured', 'logo_url', 'landing_headline', 'landing_text', 'landing_cta']);
    const exam = await db.one(
      `UPDATE exams SET featured = $1, logo_url = $2, landing_headline = $3, landing_text = $4, landing_cta = $5
        WHERE id = $6
       RETURNING ${EXAM_LANDING_COLUMNS}`,
      [
        Boolean(next.featured), next.logo_url ?? null, next.landing_headline ?? null,
        next.landing_text ?? null, next.landing_cta ?? null, id,
      ]
    );

    invalidateLandingCache();
    await audit(req, 'landing.exam.update', 'exam', id, { short_name: exam.short_name, diff: diffOf(before, exam, body) });
    res.json(exam);
  })
);

module.exports = { basePath: '/api/admin/landing', router };

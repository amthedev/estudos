'use strict';

/**
 * Painel administrativo — planos de assinatura.
 *
 *   GET    /api/admin/plans                 todos os planos (inclusive inativos) com contagem de assinaturas
 *   GET    /api/admin/plans/:id
 *   POST   /api/admin/plans                 { name, slug?, description?, price_cents, currency?, interval, interval_count?,
 *                                             trial_days?, features?[], highlight?, active?, sort_order? }
 *   PUT    /api/admin/plans/:id
 *   DELETE /api/admin/plans/:id             409 quando há assinaturas vinculadas (desative o plano)
 *   POST   /api/admin/plans/:id/sync-provider valida o plano com o Asaas
 *   GET    /api/admin/plans/provider-status   provedor ativo, ambiente e chave mascarada
 *
 * A integração com o Asaas vive em services/payments/ (módulo de billing); aqui ela é
 * opcional: os planos são cadastrados normalmente mesmo sem chave configurada.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { slugify, uniqueSlug } = require('../../utils/slug');
const payments = require('../../services/payments');

const idParams = z.object({ id: z.string().uuid() });
const nullable = (schema) => schema.nullable().optional();

const planSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Use apenas letras minúsculas, números e hífens.').optional(),
    description: nullable(z.string().trim().max(500)),
    price_cents: z.number().int().min(0).max(100_000_000),
    currency: z.string().trim().toLowerCase().length(3).default('brl'),
    interval: z.enum(['month', 'year']),
    interval_count: z.number().int().min(1).max(12).default(1),
    trial_days: z.number().int().min(0).max(1).default(0),
    // duração do acesso vendido e bônus (ex.: pague 12 meses, receba 15)
    duration_months: z.number().int().min(1).max(60).default(1),
    bonus_months: z.number().int().min(0).max(36).default(0),
    // preço de comparação exibido riscado no card; vazio = o card não mostra economia
    compare_price_cents: nullable(z.number().int().min(0).max(100_000_000)),
    badge: nullable(z.string().trim().max(40)),
    features: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    highlight: z.boolean().default(false),
    active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(1000).default(0),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.trial_days === 1 && ![6, 12].includes(plan.duration_months)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trial_days'],
        message: 'As 24 horas grátis só podem ser usadas nos planos de 6 ou 12 meses.',
      });
    }
  });

const PLAN_COLUMNS = `p.id, p.slug, p.name, p.description, p.price_cents, p.currency, p.interval, p.interval_count,
  p.trial_days, p.duration_months, p.bonus_months, p.compare_price_cents, p.badge,
  p.provider_plan_id, p.features, p.highlight, p.active, p.sort_order,
  p.created_at, p.updated_at,
  (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id
     AND s.status IN ('active','trialing')
     AND (s.current_period_end IS NULL OR s.current_period_end > now())) AS active_subscriptions,
  (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id) AS subscriptions_total`;

async function findPlan(id) {
  return db.one(`SELECT ${PLAN_COLUMNS} FROM plans p WHERE p.id = $1`, [id]);
}

async function requirePlan(id) {
  const plan = await findPlan(id);
  if (!plan) throw new AppError(404, 'not_found', 'Plano não encontrado.');
  return plan;
}

router.get(
  '/',
  wrap(async (req, res) => {
    const plans = await db.many(`SELECT ${PLAN_COLUMNS} FROM plans p ORDER BY p.sort_order ASC, p.name ASC`);
    res.json(plans);
  })
);

// antes de '/:id' para que "provider-status" não seja lido como identificador de plano
router.get(
  '/provider-status',
  wrap(async (req, res) => {
    res.json(await payments.status());
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    res.json(await requirePlan(req.valid.params.id));
  })
);

router.post(
  '/',
  validate({ body: planSchema }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const slug = await uniqueSlug(body.slug || body.name, async (candidate) => {
      const row = await db.one('SELECT 1 FROM plans WHERE slug = $1', [candidate]);
      return Boolean(row);
    });
    if (body.slug && body.slug !== slug) throw new AppError(409, 'conflict', 'Já existe um plano com este identificador (slug).');

    const created = await db.one(
      `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count, trial_days,
                          duration_months, bonus_months, compare_price_cents, badge,
                          features, highlight, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16)
       RETURNING id`,
      [
        slug, body.name, body.description ?? null, body.price_cents, body.currency, body.interval, body.interval_count,
        body.trial_days, body.duration_months, body.bonus_months, body.compare_price_cents ?? null, body.badge || null,
        JSON.stringify(body.features), body.highlight, body.active, body.sort_order,
      ]
    );
    await audit(req, 'plan.create', 'plan', created.id, { name: body.name, price_cents: body.price_cents, interval: body.interval });
    res.status(201).json(await findPlan(created.id));
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: planSchema }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const before = await requirePlan(id);

    let slug = before.slug;
    if (body.slug && body.slug !== before.slug) {
      const taken = await db.one('SELECT 1 FROM plans WHERE slug = $1 AND id <> $2', [body.slug, id]);
      if (taken) throw new AppError(409, 'conflict', 'Já existe um plano com este identificador (slug).');
      slug = slugify(body.slug);
    }

    await db.query(
      `UPDATE plans SET slug = $1, name = $2, description = $3, price_cents = $4, currency = $5, interval = $6,
              interval_count = $7, trial_days = $8, duration_months = $9, bonus_months = $10,
              compare_price_cents = $11, badge = $12, features = $13::jsonb, highlight = $14, active = $15,
              sort_order = $16
        WHERE id = $17`,
      [
        slug, body.name, body.description ?? null, body.price_cents, body.currency, body.interval, body.interval_count,
        body.trial_days, body.duration_months, body.bonus_months, body.compare_price_cents ?? null, body.badge || null,
        JSON.stringify(body.features), body.highlight, body.active, body.sort_order, id,
      ]
    );

    const diff = {};
    for (const key of ['name', 'price_cents', 'interval', 'interval_count', 'trial_days', 'duration_months', 'bonus_months', 'compare_price_cents', 'badge', 'active', 'highlight']) {
      if (before[key] !== body[key]) diff[key] = { from: before[key], to: body[key] };
    }
    await audit(req, 'plan.update', 'plan', id, diff);
    res.json(await findPlan(id));
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const plan = await requirePlan(id);
    if (Number(plan.subscriptions_total) > 0) {
      throw new AppError(409, 'conflict', 'Este plano tem assinaturas vinculadas. Desative-o em vez de excluir.');
    }

    // Tentativas de checkout apontam para o plano com ON DELETE RESTRICT, então
    // qualquer plano que alguém tenha aberto uma vez ficaria impossível de
    // excluir para sempre — inclusive um criado por engano. Elas são registro
    // de tentativa, não de cobrança: o que importa para auditoria financeira
    // são as assinaturas, barradas acima, e os eventos do provedor, que ficam
    // guardados por fora. Então saem junto, na mesma transação.
    await db.tx(async (client) => {
      await client.query('DELETE FROM payment_checkouts WHERE plan_id = $1', [id]);
      await client.query('DELETE FROM plans WHERE id = $1', [id]);
    });
    await audit(req, 'plan.delete', 'plan', id, { name: plan.name, slug: plan.slug });
    res.json({ ok: true, message: 'Plano excluído.' });
  })
);

router.post(
  '/:id/sync-provider',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const plan = await requirePlan(id);
    const provider = await payments.getProvider();

    if (!(await payments.isConfigured())) {
      throw new AppError(
        503,
        'payments_unavailable',
        'Asaas não configurado no servidor. Defina ASAAS_API_KEY para liberar os pagamentos.'
      );
    }

    let result;
    try {
      result = await payments.syncPlan(plan);
    } catch (err) {
      console.error(`[plans] falha ao sincronizar o plano ${plan.slug} com o provedor ${provider}:`, err.message);
      throw new AppError(502, 'payment_provider_error', `Falha ao sincronizar com o provedor de pagamento: ${err.message}`);
    }

    const updated = await findPlan(id);
    await audit(req, 'plan.sync_provider', 'plan', id, { provider, synced: Boolean(result && result.synced) });
    res.json({
      plan: updated,
      provider,
      synced: Boolean(result && result.synced),
      message: (result && result.message) || 'Plano sincronizado com o provedor de pagamento.',
    });
  })
);

module.exports = { basePath: '/api/admin/plans', router };

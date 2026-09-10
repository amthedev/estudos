'use strict';

/**
 * Assinaturas (provedor selecionável: Asaas ou Stripe).
 *
 *   GET  /api/billing/plans      → planos ativos, sem identificadores do provedor           [pub]
 *   GET  /api/billing/status     → { require_subscription, access, subscription, payment_provider, ... }
 *   POST /api/billing/checkout   { plan_id, tax_id? } → { url, provider }
 *   POST /api/billing/portal     → { url|null, provider, invoices }
 *   POST /api/billing/webhook    corpo cru, sem cookie e sem CSRF; o provedor é identificado
 *                                pelo cabeçalho (stripe-signature ou asaas-access-token)
 *
 * Sem provedor configurado, checkout e portal respondem 503 com mensagem clara em português.
 * As rotas de aluno NÃO usam requireAccess: quem está sem assinatura precisa chegar ao checkout.
 */
const router = require('express').Router();
const config = require('../config');
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { computeAccess, isSubscriptionRequired, ACTIVE_STATUSES } = require('../middleware/access');
const { getSetting } = require('../services/settings');
const payments = require('../services/payments');

/** Colunas visíveis ao público. Nenhum id de provedor (stripe_*, provider_plan_id) sai daqui. */
const PUBLIC_PLAN_COLUMNS = [
  'id', 'slug', 'name', 'description', 'price_cents', 'currency', 'interval', 'interval_count',
  'trial_days', 'features', 'highlight', 'sort_order',
  'duration_months', 'bonus_months', 'compare_price_cents', 'badge',
].join(', ');

/**
 * Traduz o erro do provedor em resposta da API.
 * Nada que venha do Asaas ou do Stripe chega cru ao aluno.
 */
function toApiError(err) {
  if (err instanceof AppError) return err;
  switch (err && err.code) {
    case 'payments_not_configured':
      return new AppError(503, 'payments_unavailable', err.message || payments.UNAVAILABLE_MESSAGE);
    case 'payments_unavailable':
      return new AppError(503, 'payments_unavailable', err.message);
    case 'webhook_invalid_token':
    case 'webhook_invalid_signature':
    case 'webhook_invalid_payload':
    case 'webhook_unknown_provider':
      return new AppError(400, 'validation_error', err.message);
    case 'provider_error':
      return new AppError(502, 'payment_provider_error', `O provedor de pagamento recusou a operação: ${err.message}`);
    case 'not_found':
      return new AppError(404, 'not_found', err.message);
    default:
      return null;
  }
}

/** Executa uma operação do provedor convertendo erros conhecidos em AppError. */
async function callProvider(operation) {
  try {
    return await operation();
  } catch (err) {
    const mapped = toApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Planos (público)
// ---------------------------------------------------------------------------
const toInt = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Acrescenta ao plano o que a vitrine precisa mostrar sem inventar número:
 * meses de acesso, equivalente mensal e economia — esta última só quando o
 * preço de comparação foi cadastrado no painel.
 */
function decoratePlan(plan) {
  const duration = Math.max(1, Number(plan.duration_months) || 1);
  const bonus = Math.max(0, Number(plan.bonus_months) || 0);
  const accessMonths = duration + bonus;
  const price = Number(plan.price_cents) || 0;
  const compare = toInt(plan.compare_price_cents);

  return {
    ...plan,
    duration_months: duration,
    bonus_months: bonus,
    access_months: accessMonths,
    compare_price_cents: compare,
    monthly_equivalent_cents: accessMonths > 1 ? Math.round(price / accessMonths) : null,
    savings_cents: compare !== null && compare > price ? compare - price : null,
  };
}

router.get(
  '/plans',
  wrap(async (req, res) => {
    const plans = await db.many(
      `SELECT ${PUBLIC_PLAN_COLUMNS}
         FROM plans
        WHERE active = true
        ORDER BY sort_order ASC, name ASC`
    );
    res.set('Cache-Control', 'no-store');
    res.json(plans.map(decoratePlan));
  })
);

// ---------------------------------------------------------------------------
// Webhook (antes do requireStudent: não há cookie nem CSRF)
// ---------------------------------------------------------------------------
router.post(
  '/webhook',
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      throw new AppError(400, 'validation_error', 'Corpo da requisição inválido para o webhook.');
    }
    const provider = payments.detectProvider(req.headers);
    if (!provider) {
      throw new AppError(400, 'validation_error', 'Não foi possível identificar o provedor de pagamento deste webhook.');
    }

    const outcome = await callProvider(() =>
      payments.handleWebhook({ provider, rawBody: req.body, headers: req.headers })
    );

    res.json({
      received: true,
      provider: outcome.provider,
      id: outcome.event_id,
      type: outcome.type,
      processed: outcome.processed,
      duplicate: outcome.duplicate,
    });
  })
);

// ---------------------------------------------------------------------------
// Rotas do aluno
// ---------------------------------------------------------------------------
router.use(requireStudent);

/** Resumo público da assinatura (sem identificadores do provedor). */
function publicSubscription(subscription, extra = {}) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    plan_id: subscription.plan_id || null,
    plan_name: subscription.plan_name || null,
    plan_slug: subscription.plan_slug || null,
    plan_interval: subscription.plan_interval || null,
    plan_price_cents: subscription.plan_price_cents ?? null,
    status: subscription.status,
    current_period_start: subscription.current_period_start || null,
    current_period_end: subscription.current_period_end || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    canceled_at: subscription.canceled_at || null,
    is_active: ACTIVE_STATUSES.has(subscription.status),
    provider: extra.provider || null,
    payment_method: extra.payment_method || null,
    last_payment_at: extra.last_payment_at || null,
  };
}

router.get(
  '/status',
  wrap(async (req, res) => {
    const [access, required, provider, configured, supportEmail] = await Promise.all([
      computeAccess(req.user.id),
      isSubscriptionRequired(),
      payments.getProvider(),
      payments.isConfigured(),
      getSetting('support_email'),
    ]);

    // as colunas de provedor não vêm de computeAccess; são lidas só da assinatura em foco
    let extra = {};
    if (access.subscription) {
      extra =
        (await db.one('SELECT provider, payment_method, last_payment_at FROM subscriptions WHERE id = $1', [
          access.subscription.id,
        ])) || {};
    }

    const adapter = payments.getAdapter(provider);
    res.json({
      require_subscription: required,
      payments_configured: configured,
      payment_provider: provider,
      payment_provider_label: payments.LABELS[provider] || provider,
      portal_available: Boolean(configured && adapter && adapter.status().portal_available),
      support_email: supportEmail || null,
      // compatibilidade: a tela de assinatura usa esta chave para liberar o botão de checkout
      stripe_configured: configured,
      access: {
        allowed: access.allowed,
        reason: access.reason,
        required: access.required,
        access_override_until: access.access_override_until,
      },
      subscription: publicSubscription(access.subscription, extra),
    });
  })
);

const checkoutBody = z
  .object({
    plan_id: z.string().uuid(),
    // CPF/CNPJ do pagador: o Asaas exige o documento para emitir pix e boleto
    tax_id: z
      .string()
      .trim()
      .transform((value) => value.replace(/\D+/g, ''))
      .refine((value) => value.length === 11 || value.length === 14, 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).')
      .optional(),
  })
  .strict();

router.post(
  '/checkout',
  validate({ body: checkoutBody }),
  wrap(async (req, res) => {
    if (!(await payments.isConfigured())) {
      throw new AppError(503, 'payments_unavailable', payments.UNAVAILABLE_MESSAGE);
    }

    const plan = await db.one('SELECT * FROM plans WHERE id = $1 AND active = true', [req.valid.body.plan_id]);
    if (!plan) throw new AppError(404, 'not_found', 'Plano não encontrado ou indisponível.');

    const access = await computeAccess(req.user.id);
    const current = access.subscription;
    if (current && ACTIVE_STATUSES.has(current.status)) {
      throw new AppError(409, 'conflict', 'Você já tem uma assinatura ativa. Para trocar de plano, use "Gerenciar assinatura".', {
        subscription: publicSubscription(current),
      });
    }

    if (req.valid.body.tax_id) {
      await db.query('UPDATE users SET tax_id = $1 WHERE id = $2', [req.valid.body.tax_id, req.user.id]);
    }

    const checkout = await callProvider(() =>
      payments.createCheckout({
        user: req.user,
        plan,
        successUrl: `${config.appUrl}/app/perfil?checkout=success`,
        cancelUrl: `${config.appUrl}/app/assinatura?checkout=cancel`,
      })
    );

    if (!checkout || !checkout.url) {
      throw new AppError(502, 'payment_provider_error', 'O provedor de pagamento não devolveu o link de pagamento. Tente novamente.');
    }
    res.json({ url: checkout.url, provider: checkout.provider, session_id: checkout.session_id || null });
  })
);

router.post(
  '/portal',
  wrap(async (req, res) => {
    if (!(await payments.isConfigured())) {
      throw new AppError(503, 'payments_unavailable', payments.UNAVAILABLE_MESSAGE);
    }
    const portal = await callProvider(() => payments.createPortal(req.user, `${config.appUrl}/app/perfil`));
    res.json({
      url: portal.url || null,
      provider: portal.provider,
      invoices: Array.isArray(portal.invoices) ? portal.invoices : [],
      message: portal.message || null,
      support_email: (await getSetting('support_email')) || null,
    });
  })
);

module.exports = { basePath: '/api/billing', router };

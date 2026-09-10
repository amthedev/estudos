'use strict';

/**
 * Camada única de pagamentos: o resto do sistema fala só com este módulo.
 *
 *   const payments = require('../services/payments');
 *   await payments.getProvider();                                  // 'asaas' | 'stripe' | 'none'
 *   await payments.isConfigured();
 *   await payments.status();                                       // para o painel
 *   await payments.createCheckout({ user, plan, successUrl, cancelUrl });  // → { url, provider }
 *   await payments.createPortal(user, returnUrl);                  // → { url|null, provider }
 *   await payments.syncPlan(plan);
 *   await payments.handleWebhook({ provider, rawBody, headers });
 *
 * Escolha do provedor: a configuração `payment_provider` manda; na falta dela vale
 * PAYMENT_PROVIDER do ambiente; sem nenhuma das duas, usa o Asaas quando ASAAS_API_KEY
 * existir, senão o Stripe quando STRIPE_SECRET_KEY existir, senão 'none'.
 *
 * A gravação em subscriptions é comum aos dois provedores (applySubscription) e a
 * idempotência do webhook passa pela tabela payment_events (provider + event_id).
 */
const config = require('../../config');
const db = require('../../db/pool');
const { getSetting } = require('../settings');
const asaas = require('./asaas');
const stripe = require('./stripe');

const ADAPTERS = { asaas, stripe };
const PROVIDER_NAMES = ['asaas', 'stripe', 'none'];
const LABELS = { asaas: asaas.label, stripe: stripe.label, none: 'Nenhum' };

const UNAVAILABLE_MESSAGE =
  'Pagamentos indisponíveis no momento: a plataforma ainda não tem um provedor de pagamento configurado. Fale com o suporte.';

function providerError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ---------------------------------------------------------------------------
// Provedor ativo
// ---------------------------------------------------------------------------
function normalizeName(value) {
  const name = String(value || '').trim().toLowerCase();
  return PROVIDER_NAMES.includes(name) ? name : null;
}

/** Adaptador de um provedor pelo nome; null para 'none' ou nome desconhecido. */
function getAdapter(name) {
  return ADAPTERS[normalizeName(name)] || null;
}

/**
 * Provedor ativo: configuração do painel → variável de ambiente → detecção pelas chaves.
 * @returns {Promise<'asaas'|'stripe'|'none'>}
 */
async function getProvider() {
  const chosen = normalizeName(await getSetting('payment_provider', '')) || normalizeName(process.env.PAYMENT_PROVIDER);
  if (chosen) return chosen;
  if (asaas.isConfigured()) return 'asaas';
  if (stripe.isConfigured()) return 'stripe';
  return 'none';
}

/** Adaptador ativo. Lança 'payments_not_configured' quando não há provedor utilizável. */
async function requireAdapter() {
  const name = await getProvider();
  const adapter = getAdapter(name);
  if (!adapter || !adapter.isConfigured()) {
    throw providerError('payments_not_configured', UNAVAILABLE_MESSAGE, { provider: name });
  }
  return adapter;
}

/** Há um provedor ativo e com credenciais? */
async function isConfigured() {
  const adapter = getAdapter(await getProvider());
  return Boolean(adapter && adapter.isConfigured());
}

/** Situação dos pagamentos para o painel (nenhum segredo é exposto). */
async function status() {
  const name = await getProvider();
  const adapter = getAdapter(name);
  const active = adapter ? adapter.status() : null;
  return {
    provider: name,
    label: LABELS[name] || name,
    configured: Boolean(active && active.configured),
    environment: active ? active.environment : null,
    key_masked: active ? active.key_masked : null,
    webhook_configured: Boolean(active && active.webhook_configured),
    webhook_url: `${config.appUrl}/api/billing/webhook`,
    portal_available: Boolean(active && active.portal_available),
    providers: { asaas: asaas.status(), stripe: stripe.status() },
  };
}

// ---------------------------------------------------------------------------
// Operações do provedor ativo
// ---------------------------------------------------------------------------
async function ensureCustomer(user) {
  const adapter = await requireAdapter();
  return adapter.ensureCustomer(user);
}

/**
 * Abre o checkout do provedor ativo.
 * @returns {Promise<{ url: string, provider: string }>}
 */
async function createCheckout({ user, plan, successUrl, cancelUrl }) {
  const adapter = await requireAdapter();
  const result = await adapter.createCheckout({ user, plan, successUrl, cancelUrl });
  return { provider: adapter.name, ...result };
}

/**
 * Área de gerenciamento da assinatura. O Asaas não tem portal: devolve a fatura em
 * aberto quando existe e, na falta dela, url nula — a tela do aluno então mostra os
 * dados da assinatura e o contato do suporte.
 */
async function createPortal(user, returnUrl) {
  const adapter = await requireAdapter();
  const result = await adapter.createPortal(user, returnUrl);
  return { provider: adapter.name, url: null, invoices: [], ...result };
}

/** Sincroniza o plano com o provedor ativo (no Asaas não há catálogo a sincronizar). */
async function syncPlan(plan) {
  const adapter = await requireAdapter();
  return adapter.syncPlan(plan);
}

// ---------------------------------------------------------------------------
// Gravação comum das assinaturas
// ---------------------------------------------------------------------------
/**
 * Cria ou atualiza a assinatura do aluno. Vale para qualquer provedor: a linha é
 * identificada por (provider, provider_subscription_id).
 * Campos nulos não apagam o que já estava gravado.
 */
async function applySubscription(tx, data) {
  if (!data || !data.user_id || !data.provider || !data.provider_subscription_id) {
    throw new Error('applySubscription exige user_id, provider e provider_subscription_id.');
  }
  return tx.one(
    `INSERT INTO subscriptions (
       user_id, plan_id, provider, provider_customer_id, provider_subscription_id,
       stripe_customer_id, stripe_subscription_id, status,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at,
       last_payment_at, payment_method
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       plan_id = COALESCE(EXCLUDED.plan_id, subscriptions.plan_id),
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
       status = EXCLUDED.status,
       current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       canceled_at = COALESCE(EXCLUDED.canceled_at, subscriptions.canceled_at),
       last_payment_at = COALESCE(EXCLUDED.last_payment_at, subscriptions.last_payment_at),
       payment_method = COALESCE(EXCLUDED.payment_method, subscriptions.payment_method)
     RETURNING *`,
    [
      data.user_id,
      data.plan_id ?? null,
      data.provider,
      data.provider_customer_id ?? null,
      data.provider_subscription_id,
      data.stripe_customer_id ?? null,
      data.stripe_subscription_id ?? null,
      data.status,
      data.current_period_start ?? null,
      data.current_period_end ?? null,
      Boolean(data.cancel_at_period_end),
      data.canceled_at ?? null,
      data.last_payment_at ?? null,
      data.payment_method ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
/** Descobre o provedor pelo cabeçalho da requisição. */
function detectProvider(headers = {}) {
  if (headers['stripe-signature'] || headers['Stripe-Signature']) return 'stripe';
  if (headers['asaas-access-token'] || headers['Asaas-Access-Token']) return 'asaas';
  return null;
}

/** Registro do evento (idempotência). Devolve false quando o evento já foi processado. */
async function recordEvent(tx, { provider, event_id: eventId, type, payload }) {
  const inserted = await tx.one(
    `INSERT INTO payment_events (provider, event_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [provider, eventId, type, JSON.stringify(payload ?? null)]
  );
  return Boolean(inserted);
}

/** Localiza o aluno do evento: assinatura conhecida → referência externa → cliente. */
async function resolveUser(tx, { current, reference, customerId }) {
  if (current) return current.user_id;
  if (reference.user_id) {
    const row = await tx.one('SELECT id FROM users WHERE id = $1', [reference.user_id]);
    if (row) return row.id;
  }
  if (customerId) {
    const row = await tx.one('SELECT id FROM users WHERE provider_customer_id = $1', [customerId]);
    if (row) return row.id;
  }
  return null;
}

async function resolvePlan(tx, { current, reference }) {
  if (reference.plan_id) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [reference.plan_id]);
    if (row) return row;
  }
  if (current && current.plan_id) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [current.plan_id]);
    if (row) return row;
  }
  return null;
}

/**
 * Aplica um evento já validado do Asaas na assinatura do aluno.
 * @returns {Promise<object>} resumo do que foi feito
 */
async function applyAsaasEvent(tx, event) {
  const info = asaas.normalizeEvent(event.payload);
  if (!info.subscription_id) return { skipped: 'evento sem assinatura vinculada' };

  const current = await tx.one(
    `SELECT * FROM subscriptions WHERE provider = 'asaas' AND provider_subscription_id = $1`,
    [info.subscription_id]
  );
  const reference = asaas.parseReference(info.external_reference);
  const userId = await resolveUser(tx, { current, reference, customerId: info.customer_id });
  if (!userId) {
    console.warn(`[pagamentos] evento ${event.type} da assinatura ${info.subscription_id} sem aluno correspondente.`);
    return { skipped: 'sem aluno correspondente' };
  }
  const plan = await resolvePlan(tx, { current, reference });

  const now = new Date();
  const previousEnd = current && current.current_period_end ? new Date(current.current_period_end) : null;
  const stillPaid = Boolean(previousEnd && previousEnd.getTime() > now.getTime());

  const patch = {
    user_id: userId,
    plan_id: plan ? plan.id : null,
    provider: 'asaas',
    provider_customer_id: info.customer_id || (current && current.provider_customer_id) || null,
    provider_subscription_id: info.subscription_id,
    cancel_at_period_end: Boolean(current && current.cancel_at_period_end),
  };

  switch (event.type) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED': {
      const paidAt = (info.payment && info.payment.paid_at) || now;
      const first = !current || !current.last_payment_at;
      const months = asaas.accessMonths(plan, { first });
      // renovação antes do fim do período: o acesso é somado ao que ainda resta
      const from = !first && previousEnd && previousEnd.getTime() > paidAt.getTime() ? previousEnd : paidAt;
      patch.status = 'active';
      patch.current_period_start = paidAt;
      patch.current_period_end = asaas.addMonths(from, months);
      patch.last_payment_at = paidAt;
      patch.payment_method = (info.payment && info.payment.method) || null;
      patch.cancel_at_period_end = false;
      break;
    }
    case 'PAYMENT_OVERDUE': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.status = 'past_due';
      break;
    }
    case 'PAYMENT_REFUNDED': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.status = 'canceled';
      patch.canceled_at = now;
      patch.current_period_end = now; // devolvido o dinheiro, encerra o acesso
      patch.cancel_at_period_end = false;
      break;
    }
    case 'PAYMENT_DELETED': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      // cobrança removida: só derruba o acesso se ele já não estivesse pago
      if (stillPaid) return { subscription_id: current.id, unchanged: 'período pago em andamento' };
      patch.status = 'canceled';
      patch.canceled_at = now;
      break;
    }
    case 'SUBSCRIPTION_DELETED': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.canceled_at = now;
      if (stillPaid) {
        // o aluno já pagou o período: mantém o acesso até o fim e não renova
        patch.status = current.status;
        patch.cancel_at_period_end = true;
      } else {
        patch.status = 'canceled';
        patch.cancel_at_period_end = false;
      }
      break;
    }
    default:
      return { skipped: 'evento sem tratamento' };
  }

  if (info.customer_id) {
    await tx.query('UPDATE users SET provider_customer_id = $1 WHERE id = $2 AND provider_customer_id IS NULL', [
      info.customer_id,
      userId,
    ]);
  }

  const row = await applySubscription(tx, patch);
  return {
    subscription_id: row.id,
    status: row.status,
    current_period_end: row.current_period_end,
    payment_method: row.payment_method,
  };
}

/** Fluxo completo do webhook do Asaas: valida → registra → aplica, tudo numa transação. */
async function handleAsaasWebhook({ rawBody, headers }) {
  const event = asaas.parseWebhook({ rawBody, headers });
  const handled = asaas.HANDLED_EVENTS.has(event.type);

  return db.tx(async (tx) => {
    const isNew = await recordEvent(tx, event);
    const base = { provider: 'asaas', event_id: event.event_id, type: event.type, handled };
    if (!isNew) return { ...base, processed: false, duplicate: true };
    if (!handled) return { ...base, processed: true, duplicate: false };
    const result = await applyAsaasEvent(tx, event);
    return { ...base, processed: true, duplicate: false, result };
  });
}

/** Fluxo do webhook do Stripe: o serviço original faz o trabalho; aqui só o registro comum. */
async function handleStripeWebhook({ rawBody, headers }) {
  const outcome = await stripe.handleWebhook({ rawBody, headers });
  try {
    await db.query(
      `INSERT INTO payment_events (provider, event_id, type, payload)
       VALUES ('stripe', $1, $2, $3::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [outcome.event_id, outcome.type, JSON.stringify(outcome.payload ?? null)]
    );
  } catch (err) {
    // o registro é histórico: uma falha aqui não invalida o evento já processado
    console.error(`[pagamentos] não foi possível registrar o evento ${outcome.event_id}: ${err.message}`);
  }
  const { payload, ...rest } = outcome;
  return rest;
}

/**
 * Processa um evento de webhook do provedor indicado.
 * @param {{ provider: string, rawBody: Buffer|string, headers: object }} params
 * @returns {Promise<{ provider, event_id, type, processed, duplicate, handled, result? }>}
 */
async function handleWebhook({ provider, rawBody, headers = {} }) {
  const name = normalizeName(provider) || detectProvider(headers);
  if (name === 'asaas') return handleAsaasWebhook({ rawBody, headers });
  if (name === 'stripe') return handleStripeWebhook({ rawBody, headers });
  throw providerError('webhook_unknown_provider', 'Não foi possível identificar o provedor de pagamento deste webhook.');
}

module.exports = {
  PROVIDER_NAMES,
  LABELS,
  UNAVAILABLE_MESSAGE,
  adapters: ADAPTERS,

  getProvider,
  getAdapter,
  isConfigured,
  status,

  ensureCustomer,
  createCheckout,
  createPortal,
  syncPlan,

  applySubscription,
  detectProvider,
  handleWebhook,
};

'use strict';

/**
 * Integração com o Stripe (assinaturas recorrentes).
 *
 *   const stripeService = require('../services/stripe');
 *   stripeService.isConfigured()                                   // STRIPE_SECRET_KEY presente?
 *   await stripeService.ensureCustomer(user)                       // cria/recupera o customer e grava em users
 *   await stripeService.createCheckoutSession({ user, plan, successUrl, cancelUrl }) // → { id, url }
 *   await stripeService.createPortalSession(user, returnUrl)       // → { url }
 *   await stripeService.syncPlanToStripe(plan)                     // product + price recorrente; grava ids em plans
 *   await stripeService.handleEvent(event)                         // webhook idempotente (tabela stripe_events)
 *   stripeService.status()                                         // { configured, webhook_configured, mode, ... }
 *
 * Os segredos vêm apenas do ambiente (config.stripe). Nada aqui é chamado sem chave: as rotas
 * verificam isConfigured() antes e respondem 503 com mensagem clara.
 */
const Stripe = require('stripe');
const config = require('../config');
const db = require('../db/pool');

/** Status aceitos pela coluna subscriptions.status (mesmos nomes do Stripe). */
const SUBSCRIPTION_STATUSES = new Set([
  'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused',
]);

/** Eventos tratados pelo webhook. Os demais são registrados e ignorados. */
const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

let client = null;

function isConfigured() {
  return Boolean(config.stripe.enabled && config.stripe.secretKey);
}

/** Instância do SDK (criada sob demanda). Lança se a chave não estiver configurada. */
function getStripe() {
  if (!isConfigured()) {
    const err = new Error('Stripe não configurado: defina STRIPE_SECRET_KEY no ambiente.');
    err.code = 'stripe_not_configured';
    throw err;
  }
  if (!client) {
    client = new Stripe(config.stripe.secretKey, {
      appInfo: { name: config.brandName, version: config.version },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return client;
}

/**
 * Valida a assinatura do webhook e devolve o evento. Usa a API estática do SDK, que não
 * depende da chave secreta — só do STRIPE_WEBHOOK_SECRET.
 */
function constructWebhookEvent(rawBody, signature) {
  if (!config.stripe.webhookSecret) {
    const err = new Error('Webhook do Stripe não configurado: defina STRIPE_WEBHOOK_SECRET.');
    err.code = 'stripe_not_configured';
    throw err;
  }
  return Stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/** Status para o painel, sem expor segredos. */
function status() {
  const key = config.stripe.secretKey || '';
  return {
    configured: isConfigured(),
    webhook_configured: Boolean(config.stripe.webhookSecret),
    publishable_key: config.stripe.publishableKey || null,
    mode: key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : null,
    secret_key_last4: key ? key.slice(-4) : null,
    webhook_secret_last4: config.stripe.webhookSecret ? config.stripe.webhookSecret.slice(-4) : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toDate = (unixSeconds) => (unixSeconds ? new Date(Number(unixSeconds) * 1000) : null);
const idOf = (value) => (value && typeof value === 'object' ? value.id : value) || null;

function normalizeStatus(value) {
  return SUBSCRIPTION_STATUSES.has(value) ? value : 'incomplete';
}

/** Período atual: API 2024 devolve no objeto; versões mais novas, no primeiro item. */
function periodOf(subscription) {
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  return {
    start: toDate(subscription.current_period_start ?? (item && item.current_period_start)),
    end: toDate(subscription.current_period_end ?? (item && item.current_period_end)),
  };
}

function priceIdOf(subscription) {
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  if (!item) return null;
  return idOf(item.price) || (item.plan && item.plan.id) || null;
}

function metadataOf(obj) {
  return (obj && obj.metadata && typeof obj.metadata === 'object' && obj.metadata) || {};
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------
/**
 * Garante um customer no Stripe para o usuário. Grava users.stripe_customer_id.
 * @returns {Promise<string>} id do customer
 */
async function ensureCustomer(user) {
  if (!user || !user.id) throw new Error('ensureCustomer exige um usuário.');
  const row = await db.one('SELECT id, name, email, stripe_customer_id FROM users WHERE id = $1', [user.id]);
  if (!row) throw new Error('Usuário não encontrado.');
  if (row.stripe_customer_id) return row.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: row.email,
    name: row.name,
    metadata: { user_id: row.id, platform: config.brandName },
  });
  await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [
    customer.id,
    row.id,
  ]);
  // outra requisição pode ter gravado antes: prevalece o que está no banco
  const saved = await db.one('SELECT stripe_customer_id FROM users WHERE id = $1', [row.id]);
  return (saved && saved.stripe_customer_id) || customer.id;
}

// ---------------------------------------------------------------------------
// Planos → produto e preço no Stripe
// ---------------------------------------------------------------------------
/**
 * Cria (ou atualiza) o produto e garante um preço recorrente compatível com o plano.
 * Preços do Stripe são imutáveis: se valor/moeda/intervalo mudaram, cria um preço novo,
 * define-o como padrão do produto e arquiva o anterior. Grava os ids em plans.
 * @returns {Promise<object>} linha atualizada de plans
 */
async function syncPlanToStripe(plan) {
  if (!plan || !plan.id) throw new Error('syncPlanToStripe exige um plano.');
  const stripe = getStripe();
  const current = await db.one('SELECT * FROM plans WHERE id = $1', [plan.id]);
  if (!current) throw new Error('Plano não encontrado.');

  const productPayload = {
    name: current.name,
    description: current.description || undefined,
    active: current.active,
    metadata: { plan_id: current.id, slug: current.slug },
  };

  let productId = current.stripe_product_id;
  if (productId) {
    try {
      await stripe.products.update(productId, productPayload);
    } catch (err) {
      if (err && err.code === 'resource_missing') productId = null;
      else throw err;
    }
  }
  if (!productId) {
    const product = await stripe.products.create(productPayload);
    productId = product.id;
  }

  const wanted = {
    unit_amount: Number(current.price_cents),
    currency: String(current.currency || 'brl').toLowerCase(),
    interval: current.interval,
    interval_count: Number(current.interval_count || 1),
  };

  let priceId = current.stripe_price_id;
  if (priceId) {
    let existing = null;
    try {
      existing = await stripe.prices.retrieve(priceId);
    } catch (err) {
      if (err && err.code === 'resource_missing') existing = null;
      else throw err;
    }
    const compatible =
      existing &&
      existing.active &&
      existing.product === productId &&
      Number(existing.unit_amount) === wanted.unit_amount &&
      existing.currency === wanted.currency &&
      existing.recurring &&
      existing.recurring.interval === wanted.interval &&
      Number(existing.recurring.interval_count) === wanted.interval_count;
    if (!compatible) {
      if (existing && existing.active) {
        await stripe.prices.update(priceId, { active: false }).catch(() => {});
      }
      priceId = null;
    }
  }
  if (!priceId) {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: wanted.unit_amount,
      currency: wanted.currency,
      recurring: { interval: wanted.interval, interval_count: wanted.interval_count },
      metadata: { plan_id: current.id, slug: current.slug },
    });
    priceId = price.id;
    await stripe.products.update(productId, { default_price: priceId }).catch(() => {});
  }

  return db.one(
    'UPDATE plans SET stripe_product_id = $1, stripe_price_id = $2 WHERE id = $3 RETURNING *',
    [productId, priceId, current.id]
  );
}

// ---------------------------------------------------------------------------
// Checkout e portal
// ---------------------------------------------------------------------------
/**
 * Cria uma sessão do Stripe Checkout em modo assinatura.
 * @returns {Promise<{ id: string, url: string }>}
 */
async function createCheckoutSession({ user, plan, successUrl, cancelUrl }) {
  if (!user || !plan) throw new Error('createCheckoutSession exige usuário e plano.');
  const stripe = getStripe();
  let target = plan;
  if (!target.stripe_price_id) target = await syncPlanToStripe(plan);

  const customerId = await ensureCustomer(user);
  const trialDays = Number(target.trial_days) > 0 ? Number(target.trial_days) : undefined;
  const metadata = { user_id: user.id, plan_id: target.id, plan_slug: target.slug || '' };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: target.stripe_price_id, quantity: 1 }],
    subscription_data: {
      metadata,
      ...(trialDays ? { trial_period_days: trialDays } : {}),
    },
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: 'pt-BR',
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    customer_update: { address: 'auto', name: 'auto' },
  });
  return { id: session.id, url: session.url };
}

/** Sessão do Billing Portal (gerenciar cartão, cancelar, trocar plano). */
async function createPortalSession(user, returnUrl) {
  const stripe = getStripe();
  const customerId = await ensureCustomer(user);
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return { id: session.id, url: session.url };
}

// ---------------------------------------------------------------------------
// Webhook — persistência das assinaturas
// ---------------------------------------------------------------------------
async function findUserIdForSubscription(tx, subscription) {
  const meta = metadataOf(subscription);
  if (meta.user_id) {
    const row = await tx.one('SELECT id FROM users WHERE id = $1', [meta.user_id]);
    if (row) return row.id;
  }
  const customerId = idOf(subscription.customer);
  if (customerId) {
    const row = await tx.one('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
    if (row) return row.id;
  }
  if (subscription.id) {
    const row = await tx.one('SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1', [subscription.id]);
    if (row) return row.user_id;
  }
  return null;
}

async function findPlanIdForSubscription(tx, subscription) {
  const meta = metadataOf(subscription);
  if (meta.plan_id) {
    const row = await tx.one('SELECT id FROM plans WHERE id = $1', [meta.plan_id]);
    if (row) return row.id;
  }
  const priceId = priceIdOf(subscription);
  if (priceId) {
    const row = await tx.one('SELECT id FROM plans WHERE stripe_price_id = $1', [priceId]);
    if (row) return row.id;
  }
  if (subscription.id) {
    const row = await tx.one('SELECT plan_id FROM subscriptions WHERE stripe_subscription_id = $1', [subscription.id]);
    if (row) return row.plan_id;
  }
  return null;
}

/** Cria/atualiza a linha de subscriptions a partir de um objeto Subscription do Stripe. */
async function upsertSubscription(tx, subscription, { statusOverride } = {}) {
  if (!subscription || !subscription.id) return null;
  const userId = await findUserIdForSubscription(tx, subscription);
  if (!userId) {
    console.warn(`[stripe] assinatura ${subscription.id} sem usuário correspondente; ignorada.`);
    return null;
  }
  const planId = await findPlanIdForSubscription(tx, subscription);
  const period = periodOf(subscription);
  const status = normalizeStatus(statusOverride || subscription.status);
  const customerId = idOf(subscription.customer);

  if (customerId) {
    await tx.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [
      customerId,
      userId,
    ]);
  }

  return tx.one(
    `INSERT INTO subscriptions (
       user_id, plan_id, stripe_customer_id, stripe_subscription_id, status,
       current_period_start, current_period_end, cancel_at_period_end, canceled_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       plan_id = COALESCE(EXCLUDED.plan_id, subscriptions.plan_id),
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       status = EXCLUDED.status,
       current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       canceled_at = COALESCE(EXCLUDED.canceled_at, subscriptions.canceled_at)
     RETURNING *`,
    [
      userId,
      planId,
      customerId,
      subscription.id,
      status,
      period.start,
      period.end,
      Boolean(subscription.cancel_at_period_end),
      toDate(subscription.canceled_at),
    ]
  );
}

/** Busca a assinatura completa no Stripe quando o evento só traz o id (checkout, invoice). */
async function retrieveSubscription(subscriptionId) {
  if (!subscriptionId || !isConfigured()) return null;
  try {
    return await getStripe().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(`[stripe] falha ao consultar assinatura ${subscriptionId}: ${err.message}`);
    return null;
  }
}

async function onCheckoutCompleted(tx, session) {
  const meta = metadataOf(session);
  const customerId = idOf(session.customer);
  const userId = meta.user_id || session.client_reference_id || null;

  if (userId && customerId) {
    await tx.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, userId]);
  }
  if (session.mode !== 'subscription' || !session.subscription) return { linked: Boolean(userId && customerId) };

  let subscription = typeof session.subscription === 'object' ? session.subscription : null;
  if (!subscription) subscription = await retrieveSubscription(session.subscription);
  if (!subscription) {
    // Sem acesso à API (ou falha): registra o vínculo com o melhor que o evento oferece.
    // Os eventos customer.subscription.* completam status e período em seguida.
    const plan = meta.plan_id ? await tx.one('SELECT id, trial_days FROM plans WHERE id = $1', [meta.plan_id]) : null;
    subscription = {
      id: idOf(session.subscription),
      customer: customerId,
      status: plan && Number(plan.trial_days) > 0 ? 'trialing' : 'active',
      metadata: { user_id: userId, plan_id: meta.plan_id },
      cancel_at_period_end: false,
    };
  } else if (userId || meta.plan_id) {
    subscription.metadata = { ...metadataOf(subscription), ...(userId ? { user_id: userId } : {}), ...(meta.plan_id ? { plan_id: meta.plan_id } : {}) };
  }
  const row = await upsertSubscription(tx, subscription);
  return { subscription_id: row ? row.id : null };
}

async function onSubscriptionEvent(tx, subscription, type) {
  const override = type === 'customer.subscription.deleted' ? 'canceled' : undefined;
  if (override && !subscription.canceled_at) subscription = { ...subscription, canceled_at: Math.floor(Date.now() / 1000) };
  const row = await upsertSubscription(tx, subscription, { statusOverride: override });
  return { subscription_id: row ? row.id : null };
}

async function onInvoicePaid(tx, invoice) {
  const subscriptionId = idOf(invoice.subscription);
  if (!subscriptionId) return { skipped: 'sem assinatura' };
  const fresh = await retrieveSubscription(subscriptionId);
  if (fresh) {
    const row = await upsertSubscription(tx, fresh);
    return { subscription_id: row ? row.id : null };
  }
  const line = invoice.lines && invoice.lines.data && invoice.lines.data[0];
  const period = line && line.period ? line.period : {};
  const row = await tx.one(
    `UPDATE subscriptions
        SET status = 'active',
            current_period_start = COALESCE($2, current_period_start),
            current_period_end = COALESCE($3, current_period_end)
      WHERE stripe_subscription_id = $1
      RETURNING id`,
    [subscriptionId, toDate(period.start), toDate(period.end)]
  );
  return { subscription_id: row ? row.id : null };
}

async function onInvoicePaymentFailed(tx, invoice) {
  const subscriptionId = idOf(invoice.subscription);
  if (!subscriptionId) return { skipped: 'sem assinatura' };
  const row = await tx.one(
    `UPDATE subscriptions
        SET status = 'past_due'
      WHERE stripe_subscription_id = $1 AND status IN ('active', 'trialing', 'past_due')
      RETURNING id`,
    [subscriptionId]
  );
  return { subscription_id: row ? row.id : null };
}

/**
 * Processa um evento do webhook de forma idempotente: o id do evento é gravado em
 * stripe_events dentro da mesma transação da alteração; um evento repetido é ignorado.
 * Se o processamento falhar, nada é gravado e o Stripe pode reenviar.
 * @returns {Promise<{ processed: boolean, duplicate: boolean, handled: boolean, type: string, result?: object }>}
 */
async function handleEvent(event) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw new Error('Evento do Stripe inválido.');
  }
  const type = event.type;
  const object = event.data && event.data.object ? event.data.object : null;

  return db.tx(async (tx) => {
    const inserted = await tx.one(
      `INSERT INTO stripe_events (id, type, payload) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [event.id, type, JSON.stringify(event)]
    );
    if (!inserted) return { processed: false, duplicate: true, handled: HANDLED_EVENTS.has(type), type };

    if (!HANDLED_EVENTS.has(type) || !object) {
      return { processed: true, duplicate: false, handled: false, type };
    }

    let result;
    switch (type) {
      case 'checkout.session.completed':
        result = await onCheckoutCompleted(tx, object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        result = await onSubscriptionEvent(tx, object, type);
        break;
      case 'invoice.paid':
        result = await onInvoicePaid(tx, object);
        break;
      case 'invoice.payment_failed':
        result = await onInvoicePaymentFailed(tx, object);
        break;
      default:
        result = {};
    }
    return { processed: true, duplicate: false, handled: true, type, result };
  });
}

module.exports = {
  getStripe,
  isConfigured,
  constructWebhookEvent,
  ensureCustomer,
  createCheckoutSession,
  createPortalSession,
  syncPlanToStripe,
  handleEvent,
  status,
  HANDLED_EVENTS,
  SUBSCRIPTION_STATUSES,
};

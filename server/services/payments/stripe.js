'use strict';

/**
 * Adaptador do Stripe para a camada única de pagamentos.
 *
 * Não reimplementa nada: toda a lógica continua em server/services/stripe.js (usada
 * também por server/routes/admin/plans.js). Aqui só existe a tradução para a interface
 * comum — createCheckout, createPortal, syncPlan, handleWebhook — e o preenchimento das
 * colunas genéricas de subscriptions (provider, provider_customer_id,
 * provider_subscription_id, last_payment_at, payment_method), que o serviço original
 * não conhece porque nasceu antes do provedor ser selecionável.
 */
const config = require('../../config');
const db = require('../../db/pool');
const stripeService = require('../stripe');

const NAME = 'stripe';
const LABEL = 'Stripe';

function providerError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.provider = NAME;
  Object.assign(err, extra);
  return err;
}

function isConfigured() {
  return stripeService.isConfigured();
}

/** Status para o painel, no mesmo formato do adaptador do Asaas. */
function status() {
  const raw = stripeService.status();
  return {
    provider: NAME,
    label: LABEL,
    configured: raw.configured,
    environment: raw.mode === 'live' ? 'production' : raw.mode === 'test' ? 'sandbox' : null,
    api_base: 'https://api.stripe.com',
    key_masked: raw.secret_key_last4 ? `••••${raw.secret_key_last4}` : null,
    key_last4: raw.secret_key_last4,
    webhook_configured: raw.webhook_configured,
    webhook_url: `${config.appUrl}/api/billing/webhook`,
    publishable_key: raw.publishable_key,
    portal_available: true,
  };
}

async function ensureCustomer(user) {
  return stripeService.ensureCustomer(user);
}

async function createCheckout({ user, plan, successUrl, cancelUrl }) {
  const session = await stripeService.createCheckoutSession({ user, plan, successUrl, cancelUrl });
  return { url: session.url, provider: NAME, session_id: session.id };
}

async function createPortal(user, returnUrl) {
  const session = await stripeService.createPortalSession(user, returnUrl);
  return { url: session.url, provider: NAME, session_id: session.id, invoices: [] };
}

async function syncPlan(plan) {
  const updated = await stripeService.syncPlanToStripe(plan);
  return {
    plan: updated,
    provider: NAME,
    synced: true,
    message: 'Plano sincronizado com o Stripe.',
  };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
const idOf = (value) => (value && typeof value === 'object' ? value.id : value) || null;
const toDate = (unixSeconds) => (unixSeconds ? new Date(Number(unixSeconds) * 1000) : null);

/** Identificador da assinatura afetada por um evento (quando existe). */
function subscriptionIdOf(event) {
  const object = (event.data && event.data.object) || {};
  if (object.object === 'subscription') return object.id || null;
  return idOf(object.subscription) || null;
}

/**
 * Copia os identificadores do Stripe para as colunas genéricas e registra o pagamento.
 * O serviço original grava apenas as colunas stripe_*; sem este passo o painel e a tela
 * do aluno não conseguiriam mostrar provedor e forma de pagamento de forma uniforme.
 */
async function fillProviderColumns(event) {
  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) return;

  await db.query(
    `UPDATE subscriptions
        SET provider = 'stripe',
            provider_customer_id = COALESCE(provider_customer_id, stripe_customer_id),
            provider_subscription_id = COALESCE(provider_subscription_id, stripe_subscription_id)
      WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );

  if (event.type === 'invoice.paid') {
    const invoice = (event.data && event.data.object) || {};
    await db.query(
      `UPDATE subscriptions
          SET last_payment_at = COALESCE($2, now()),
              payment_method = COALESCE(payment_method, 'credit_card')
        WHERE stripe_subscription_id = $1`,
      [subscriptionId, toDate(invoice.status_transitions && invoice.status_transitions.paid_at) || toDate(invoice.created)]
    );
  }
}

/**
 * Valida a assinatura do webhook, delega o processamento ao serviço original
 * (idempotente pela tabela stripe_events) e normaliza as colunas de provedor.
 * @returns {Promise<{ provider, event_id, type, processed, duplicate, handled, payload }>}
 */
async function handleWebhook({ rawBody, headers = {} }) {
  if (!config.stripe.webhookSecret) {
    throw providerError('payments_not_configured', 'Webhook do Stripe não configurado: defina STRIPE_WEBHOOK_SECRET no servidor.');
  }
  const signature = headers['stripe-signature'] || headers['Stripe-Signature'] || null;
  if (!signature) {
    throw providerError('webhook_invalid_signature', 'Cabeçalho Stripe-Signature ausente.');
  }

  let event;
  try {
    event = stripeService.constructWebhookEvent(rawBody, signature);
  } catch {
    throw providerError('webhook_invalid_signature', 'Assinatura do webhook inválida.');
  }

  const outcome = await stripeService.handleEvent(event);
  if (outcome.processed) await fillProviderColumns(event);

  return {
    provider: NAME,
    event_id: event.id,
    type: event.type,
    processed: outcome.processed,
    duplicate: outcome.duplicate,
    handled: outcome.handled,
    payload: event,
  };
}

module.exports = {
  name: NAME,
  label: LABEL,
  isConfigured,
  status,
  ensureCustomer,
  createCheckout,
  createPortal,
  syncPlan,
  handleWebhook,
};

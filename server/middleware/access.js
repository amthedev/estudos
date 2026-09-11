'use strict';

/**
 * Controle de acesso por assinatura.
 *
 *   router.use(requireStudent, requireAccess);
 *   const access = await computeAccess(userId); // { allowed, reason, subscription, ... }
 *
 * Quando a configuração require_subscription (fallback: REQUIRE_SUBSCRIPTION do .env) é verdadeira,
 * o aluno precisa de users.access_override_until > now() OU de uma assinatura com status
 * active/trialing cujo current_period_end seja nulo ou futuro. Caso contrário: 402 payment_required.
 *
 * reason: 'override' | 'subscription' | 'open' | 'no_subscription' | 'expired' | <status da assinatura>
 */
const config = require('../config');
const db = require('../db/pool');
const { getSetting } = require('../services/settings');
const { AppError } = require('./errors');

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

/**
 * Assinatura vale acesso agora?
 *
 * Status ativo não basta: nada no servidor faz uma assinatura envelhecer
 * sozinha — só os webhooks escrevem em subscriptions —, então uma linha
 * 'active' ou 'trialing' com o período vencido é um estado que fica. Quem
 * olhasse só o status daria acesso a quem já não tem, e quem olhasse só o
 * período trataria como ativa uma assinatura cancelada.
 *
 * É por existir em um lugar só que o acesso ao conteúdo e a liberação do
 * checkout não podem divergir. Quando divergiam, o aluno com período vencido
 * ficava trancado nos dois: sem conteúdo, porque expirou, e sem poder pagar,
 * porque "já tem assinatura ativa".
 */
function isSubscriptionActive(subscription, at = Date.now()) {
  if (!subscription || !ACTIVE_STATUSES.has(subscription.status)) return false;
  if (!subscription.current_period_end) return true;
  return new Date(subscription.current_period_end).getTime() > at;
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'sim', 'yes', 'on'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

async function isSubscriptionRequired() {
  return toBool(await getSetting('require_subscription', config.requireSubscription));
}

/** Assinatura mais relevante do aluno (ativa primeiro; senão a mais recente). */
async function findSubscription(userId) {
  return db.one(
    `SELECT s.id, s.status, s.plan_id, p.name AS plan_name, p.slug AS plan_slug, p.interval AS plan_interval,
            p.price_cents AS plan_price_cents,
            s.provider_subscription_id, s.current_period_start, s.current_period_end,
            s.cancel_at_period_end, s.canceled_at, s.created_at, s.updated_at
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1
      ORDER BY (s.status IN ('active','trialing')) DESC,
               s.current_period_end DESC NULLS LAST,
               s.created_at DESC
      LIMIT 1`,
    [userId]
  );
}

/**
 * Calcula o acesso do aluno.
 * @returns {Promise<{ allowed: boolean, reason: string, required: boolean, subscription: object|null, access_override_until: Date|null }>}
 */
async function computeAccess(userId) {
  const [required, user, subscription] = await Promise.all([
    isSubscriptionRequired(),
    db.one('SELECT access_override_until FROM users WHERE id = $1', [userId]),
    findSubscription(userId),
  ]);

  const now = Date.now();
  const overrideUntil = user && user.access_override_until ? new Date(user.access_override_until) : null;
  const overrideActive = Boolean(overrideUntil && overrideUntil.getTime() > now);
  const subscriptionActive = isSubscriptionActive(subscription, now);

  let allowed = true;
  let reason;
  if (overrideActive) reason = 'override';
  else if (subscriptionActive) reason = 'subscription';
  else if (!required) reason = 'open';
  else {
    allowed = false;
    if (!subscription) reason = 'no_subscription';
    else if (ACTIVE_STATUSES.has(subscription.status)) reason = 'expired';
    else reason = subscription.status; // past_due, canceled, unpaid, incomplete, paused...
  }

  return {
    allowed,
    reason,
    required,
    subscription: subscription || null,
    access_override_until: overrideUntil,
  };
}

/** Middleware: usar depois de requireStudent. Popula req.access. */
function requireAccess(req, res, next) {
  if (!req.user) return next(new AppError(401, 'unauthorized', 'Faça login para continuar.'));
  computeAccess(req.user.id)
    .then((access) => {
      req.access = access;
      if (!access.allowed) {
        return next(
          new AppError(402, 'payment_required', 'É preciso ter uma assinatura ativa para acessar este conteúdo.', {
            reason: access.reason,
          })
        );
      }
      next();
    })
    .catch(next);
}

module.exports = { requireAccess, computeAccess, isSubscriptionRequired, isSubscriptionActive, ACTIVE_STATUSES };

'use strict';

/**
 * Moedas diárias por nível de plano.
 *
 *   const coins = require('../services/coins');
 *   const wallet = await coins.getWallet({ user: req.user, access: req.access });
 *   const { chargeId } = await coins.charge(db, { user, access, action: 'essay_correction', cost, refType: 'essay', refId });
 *   await coins.refund(chargeId, 'falha na correção');
 *
 * Cada nível (Básico, Pro, Avançado) recebe um tanto de moedas por dia, e cada
 * ação que chama a IA custa algumas. O saldo não é um número guardado: é a
 * conta do dia sobre o livro coin_ledger — moedas do nível + concessões do dia
 * − cobranças do dia não estornadas. A virada do dia acontece sozinha, sem
 * processo nenhum zerando saldo à meia-noite, e o que sobrou ontem não passa
 * para hoje.
 *
 * O "dia" é o dia civil de São Paulo calculado aqui, em JS, e passado ao SQL.
 * Se fosse o now() do banco, a virada do dia não teria como ser testada.
 *
 * Quem não gasta moeda (ilimitado): a equipe, o assinante de plano antigo até o
 * fim do período que já tinha pago, a cortesia dada pelo painel e o acesso
 * aberto (require_subscription desligado).
 */
const db = require('../db/pool');
const { getSetting } = require('./settings');
const { AppError } = require('../middleware/errors');
const { computeAccess, isSubscriptionActive } = require('../middleware/access');
const dates = require('../utils/dates');

const TIERS = Object.freeze(['basico', 'pro', 'avancado']);
const TIER_LABELS = Object.freeze({ basico: 'Básico', pro: 'Pro', avancado: 'Avançado' });

/** Custo de cada ação → chave da configuração. */
const COST_SETTINGS = Object.freeze({
  essay_correction: 'coin_cost_essay_correction',
  simulado_short: 'coin_cost_simulado_short',
  simulado_long: 'coin_cost_simulado_long',
  simulado_short_max_questions: 'coin_simulado_short_max_questions',
  practice: 'coin_cost_practice',
  questions: 'coin_cost_questions',
  essay_theme: 'coin_cost_essay_theme',
});

const INSUFFICIENT_MESSAGE =
  'Suas moedas de hoje acabaram. Elas voltam à meia-noite — ou faça upgrade para ter mais moedas por dia.';
const ALREADY_CHARGED_MESSAGE = 'Esta ação já está em andamento.';

/** Posição do nível (0, 1, 2); -1 para plano sem nível. Serve para dizer o que é upgrade. */
function tierRank(tier) {
  return TIERS.indexOf(tier);
}

function toTime(now) {
  const time = now instanceof Date ? now.getTime() : new Date(now === undefined ? Date.now() : now).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

/** Número de moedas/tokens de uma configuração: inteiro >= 0, nunca NaN. */
async function wholeSetting(key) {
  const value = Number(await getSetting(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Moedas por dia do nível (0 para nível desconhecido). */
async function dailyCoins(tier) {
  if (!TIERS.includes(tier)) return 0;
  return wholeSetting(`coins_daily_${tier}`);
}

/**
 * Cota mensal de tokens do Tutor IA do nível. Zero deixa o nível sem Tutor: a
 * regra é "barra quando o gasto do mês chega à cota", e com cota zero o gasto
 * já chegou.
 */
async function tutorMonthlyTokens(tier) {
  if (!TIERS.includes(tier)) return 0;
  return wholeSetting(`tutor_tokens_${tier}`);
}

/**
 * Moedas por dia e cota mensal do Tutor de cada nível, lidas das
 * configurações. É o que a vitrine de planos mostra ao lado do preço: o número
 * vem daqui, e não do texto do plano, para mudar junto quando o painel muda.
 * @returns {Promise<Record<string, { daily_coins: number, tutor_monthly_tokens: number }>>}
 */
async function tierAllowances() {
  const result = {};
  for (const tier of TIERS) {
    result[tier] = { daily_coins: await dailyCoins(tier), tutor_monthly_tokens: await tutorMonthlyTokens(tier) };
  }
  return result;
}

/** Custos de todas as ações, sem o prefixo da configuração. */
async function readCosts() {
  const costs = {};
  for (const [name, key] of Object.entries(COST_SETTINGS)) costs[name] = await wholeSetting(key);
  return costs;
}

/**
 * Custo de um simulado pelo número de questões que ele realmente tem: até o
 * limite do curto, preço de curto; acima, preço de longo.
 */
async function simuladoCost(questionCount) {
  const costs = await readCosts();
  return Number(questionCount) <= costs.simulado_short_max_questions ? costs.simulado_short : costs.simulado_long;
}

/** Próxima meia-noite de São Paulo depois de `now`, em ISO. */
function resetsAt(now) {
  const tomorrow = dates.addDays(dates.toISODate(new Date(toTime(now))), 1);
  return dates.midnightInSaoPaulo(tomorrow).toISOString();
}

/**
 * Nível que vale para as moedas agora.
 *
 * A ordem importa. A assinatura com nível vence a cortesia: quem pagou o Pro e
 * também ganhou uma liberação manual continua com as moedas do Pro, em vez de
 * ficar ilimitado sem ninguém ter decidido isso. E o plano antigo só é
 * ilimitado enquanto legacy_until não passou — depois disso, a mesma assinatura
 * renovada vale como Básico.
 *
 * @returns {Promise<{ unlimited: boolean, tier: string|null, reason: string }>}
 */
async function resolveTier({ user, access, now = new Date() } = {}) {
  if (user && user.role === 'admin') return { unlimited: true, tier: null, reason: 'admin' };

  const at = toTime(now);
  const subscription = access && access.subscription;
  if (subscription && isSubscriptionActive(subscription, at)) {
    if (TIERS.includes(subscription.plan_tier)) {
      return { unlimited: false, tier: subscription.plan_tier, reason: 'plan' };
    }
    const legacyUntil = subscription.legacy_until ? new Date(subscription.legacy_until).getTime() : null;
    if (legacyUntil && legacyUntil > at) return { unlimited: true, tier: null, reason: 'legacy' };
    return { unlimited: false, tier: 'basico', reason: 'plan_without_tier' };
  }

  if (access && access.reason === 'override') return { unlimited: true, tier: null, reason: 'override' };
  if (access && access.reason === 'open') return { unlimited: true, tier: null, reason: 'open' };
  return { unlimited: false, tier: null, reason: 'none' };
}

/** Completa papel e acesso quando quem chama só tem o id do aluno. */
async function loadContext(user, access) {
  if (!user || !user.id) throw new Error('coins: informe o aluno (user.id).');
  let fullUser = user;
  if (user.role === undefined) {
    const row = await db.one('SELECT id, role FROM users WHERE id = $1', [user.id]);
    fullUser = { ...user, role: row ? row.role : null };
  }
  return { user: fullUser, access: access || (await computeAccess(user.id)) };
}

/** Somas do dia: moedas gastas (cobranças vivas) e concedidas. */
async function dayTotals(client, userId, day) {
  const row = await client.one(
    `SELECT coalesce(sum(amount) FILTER (WHERE kind = 'debit' AND refunded_at IS NULL), 0)::int AS spent,
            coalesce(sum(amount) FILTER (WHERE kind = 'grant'), 0)::int AS granted
       FROM coin_ledger
      WHERE user_id = $1 AND day = $2`,
    [userId, day]
  );
  return { spent: Number(row ? row.spent : 0) || 0, granted: Number(row ? row.granted : 0) || 0 };
}

function buildWallet({ tierInfo, daily, spent, granted, day, now, costs }) {
  const base = {
    unlimited: tierInfo.unlimited,
    tier: tierInfo.tier,
    tier_label: tierInfo.tier ? TIER_LABELS[tierInfo.tier] : null,
    reason: tierInfo.reason,
    spent,
    granted,
    day,
    resets_at: resetsAt(now),
    costs,
  };
  if (tierInfo.unlimited) return { ...base, daily: null, balance: null };
  return { ...base, daily, balance: Math.max(0, daily + granted - spent) };
}

/**
 * Carteira do aluno hoje.
 *
 * `client` serve a quem já está numa transação (charge): a soma do dia sai
 * pela mesma conexão em vez de pedir outra ao pool.
 * @returns {Promise<{ unlimited, tier, tier_label, reason, daily, spent, granted, balance, day, resets_at, costs }>}
 */
async function getWallet({ user, access, now = new Date(), client = db } = {}) {
  const context = await loadContext(user, access);
  const tierInfo = await resolveTier({ ...context, now });
  const day = dates.toISODate(new Date(toTime(now)));
  const [totals, daily, costs] = await Promise.all([
    dayTotals(client || db, context.user.id, day),
    tierInfo.unlimited ? null : dailyCoins(tierInfo.tier),
    readCosts(),
  ]);
  return buildWallet({ tierInfo, daily: daily || 0, ...totals, day, now, costs });
}

/** O cliente recebido é o módulo do pool (e não um cliente de transação)? */
function isPool(client) {
  return !client || client === db || typeof client.tx === 'function';
}

/**
 * Cobra uma ação.
 *
 * `client` pode ser o pool (abre transação própria) ou o cliente de uma
 * transação em andamento (db.tx) — a redação, por exemplo, muda o status e
 * cobra na mesma transação, para nunca cobrar sem ter mudado nem mudar sem
 * ter cobrado.
 *
 * A trava por aluno (advisory lock da transação) faz duas cobranças do mesmo
 * aluno acontecerem uma de cada vez: a segunda só lê o saldo depois que a
 * primeira gravou. Sem ela, dois cliques leriam o mesmo saldo e os dois
 * passariam. A mesma trava faz a conferência de "já cobrado" ser confiável;
 * o índice único do banco fica como segunda barreira.
 *
 * Dentro de uma transação, nada aqui pede outra conexão ao pool — nem a
 * carteira de quem não paga. Transação esperando uma segunda conexão é o
 * jeito de travar o app inteiro: com o pool cheio de transações assim, todas
 * esperam uma conexão que só volta quando uma delas terminar.
 *
 * @returns {Promise<{ chargeId: string|null, wallet: object }>}
 */
async function charge(client, { user, access, action, cost, refType = null, refId = null, now = new Date() } = {}) {
  if (!action) throw new Error('coins.charge: informe a ação cobrada.');
  const amount = Math.max(0, Math.floor(Number(cost) || 0));
  const context = await loadContext(user, access);
  const tierInfo = await resolveTier({ ...context, now });
  const userId = context.user.id;

  if (tierInfo.unlimited || amount === 0) {
    return { chargeId: null, wallet: await getWallet({ ...context, now, client: isPool(client) ? db : client }) };
  }

  const day = dates.toISODate(new Date(toTime(now)));
  const ref = refId === null || refId === undefined ? null : String(refId);
  const [daily, costs] = await Promise.all([dailyCoins(tierInfo.tier), readCosts()]);

  const run = async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

    if (ref) {
      const live = await tx.one(
        `SELECT id FROM coin_ledger
          WHERE user_id = $1 AND action = $2 AND ref_type IS NOT DISTINCT FROM $3 AND ref_id = $4
            AND kind = 'debit' AND refunded_at IS NULL
          LIMIT 1`,
        [userId, action, refType, ref]
      );
      if (live) throw new AppError(409, 'already_charged', ALREADY_CHARGED_MESSAGE);
    }

    const totals = await dayTotals(tx, userId, day);
    const balance = Math.max(0, daily + totals.granted - totals.spent);
    if (balance < amount) {
      throw new AppError(402, 'insufficient_coins', INSUFFICIENT_MESSAGE, {
        balance,
        cost: amount,
        daily,
        tier: tierInfo.tier,
        resets_at: resetsAt(now),
      });
    }

    let row;
    try {
      row = await tx.one(
        `INSERT INTO coin_ledger (user_id, day, kind, action, amount, ref_type, ref_id)
         VALUES ($1, $2, 'debit', $3, $4, $5, $6)
         RETURNING id`,
        [userId, day, action, amount, refType, ref]
      );
    } catch (err) {
      if (err && err.code === '23505') throw new AppError(409, 'already_charged', ALREADY_CHARGED_MESSAGE);
      throw err;
    }

    const wallet = buildWallet({
      tierInfo,
      daily,
      spent: totals.spent + amount,
      granted: totals.granted,
      day,
      now,
      costs,
    });
    return { chargeId: row.id, wallet };
  };

  return isPool(client) ? db.tx(run) : run(client);
}

/**
 * Estorna uma cobrança. Idempotente, e nunca lança: o estorno roda justamente
 * no caminho de erro da ação cobrada, e uma falha aqui não pode esconder o
 * erro original.
 *
 * A moeda volta ao DIA DA COBRANÇA. Se a IA falhar depois da meia-noite, o
 * estorno cai no dia anterior e não aumenta o saldo de hoje — que já veio
 * cheio. É de propósito: o aluno não perde nada (o dia novo começou completo)
 * e ninguém ganha moeda a mais com uma falha que atravessou a virada.
 *
 * Quem estorna de dentro de uma transação passa o `client` dela, pelo mesmo
 * motivo do charge: não pedir uma segunda conexão ao pool com a primeira
 * presa. O estorno passa a valer junto com a transação.
 */
async function refund(chargeId, reason = null, client = db) {
  if (!chargeId) return false;
  try {
    const result = await (client || db).query(
      `UPDATE coin_ledger SET refunded_at = now(), refund_reason = $2
        WHERE id = $1 AND kind = 'debit' AND refunded_at IS NULL`,
      [chargeId, reason]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error(`[moedas] falha ao estornar a cobrança ${chargeId}:`, err.message);
    return false;
  }
}

/**
 * Estorna a cobrança viva de um objeto, se houver. Serve a quem não guardou o
 * id da cobrança: a correção de redação que falhou em segundo plano, o boot
 * que destrava redações presas, o reenvio de uma redação órfã. Mesmas
 * garantias do refund: idempotente, sem lançar e com o `client` da transação
 * de quem chama, se houver.
 */
async function refundByRef(userId, action, refType, refId, reason = null, client = db) {
  if (!userId || !action || refId === null || refId === undefined) return false;
  try {
    const result = await (client || db).query(
      `UPDATE coin_ledger SET refunded_at = now(), refund_reason = $5
        WHERE user_id = $1 AND action = $2 AND ref_type IS NOT DISTINCT FROM $3 AND ref_id = $4
          AND kind = 'debit' AND refunded_at IS NULL`,
      [userId, action, refType === undefined ? null : refType, String(refId), reason]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error(`[moedas] falha ao estornar ${action} ${refType}:${refId}:`, err.message);
    return false;
  }
}

/**
 * Concede moedas extras hoje (suporte). Somam ao saldo do dia e, como as do
 * nível, não passam para amanhã.
 */
async function grant(client, { userId, amount, adminId = null, note = null, now = new Date() } = {}) {
  const value = Math.floor(Number(amount));
  if (!userId) throw new Error('coins.grant: informe o aluno.');
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(400, 'validation_error', 'Informe uma quantidade de moedas maior que zero.');
  }
  const runner = client || db;
  return runner.one(
    `INSERT INTO coin_ledger (user_id, day, kind, action, amount, created_by, note)
     VALUES ($1, $2, 'grant', 'admin_grant', $3, $4, $5)
     RETURNING id, user_id, day, kind, action, amount, created_by, note, created_at`,
    [userId, dates.toISODate(new Date(toTime(now))), value, adminId, note]
  );
}

/** Últimos lançamentos do aluno, do mais novo para o mais antigo. */
async function ledger(userId, { limit = 30 } = {}) {
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 30)));
  return db.many(
    `SELECT id, day, kind, action, amount, ref_type, ref_id, refunded_at, refund_reason,
            created_by, note, created_at
       FROM coin_ledger
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, size]
  );
}

module.exports = {
  TIERS,
  TIER_LABELS,
  COST_SETTINGS,
  INSUFFICIENT_MESSAGE,
  tierRank,
  resolveTier,
  getWallet,
  charge,
  refund,
  refundByRef,
  grant,
  ledger,
  dailyCoins,
  tutorMonthlyTokens,
  tierAllowances,
  readCosts,
  simuladoCost,
  resetsAt,
};

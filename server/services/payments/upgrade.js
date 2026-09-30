'use strict';

/**
 * Upgrade de plano pagando só a diferença.
 *
 *   const upgrade = require('./upgrade');
 *   upgrade.upgradeQuote({ fromPlan, toPlan, periodEnd, now, minCents }); // a conta, sem banco
 *   await upgrade.checkUpgrade({ userId, toPlanId });      // valida e cota (GET /api/billing/upgrade/quote)
 *   await upgrade.createUpgrade({ user, toPlanId });       // abre a cobrança (POST /api/billing/upgrade)
 *   await upgrade.pendingUpgrade(userId);                  // pedido esperando pagamento (GET /api/billing/status)
 *   await upgrade.unappliedUpgrades();                     // pagos sem troca, para o suporte (painel)
 *   await upgrade.findUpgradeForEvent(tx, info);           // o evento do webhook é de um upgrade?
 *   await upgrade.applyUpgradeEvent(tx, change, event);    // aplica o evento ao pedido
 *
 * Regras de negócio:
 *   - só entre níveis (Básico → Pro → Avançado), só para cima e na MESMA
 *     duração: o período já pago continua o mesmo, só o nível muda;
 *   - só com a assinatura 'active'. No teste de 24h nada foi pago ainda, e
 *     cobrar diferença sobre um período que não existe não faz sentido;
 *   - o valor é a diferença de preço proporcional ao que falta do ciclo atual,
 *     nunca abaixo do mínimo configurado (o Asaas recusa cobrança muito baixa).
 *
 * O que a troca NÃO toca, de propósito: current_period_end, status,
 * legacy_until e, sobretudo, last_payment_id. Este último é a trava que impede
 * o reprocessamento de creditar a mesma cobrança de novo; se o upgrade o
 * sobrescrevesse, reprocessar a compra original concederia outro período
 * inteiro.
 *
 * Cada pedido vira uma linha em plan_changes e uma cobrança avulsa no Asaas.
 * O webhook reconhece essa cobrança pelo id do pagamento gravado aqui (e, de
 * reserva, pela referência 'upgrade:<id do pedido>') ANTES da lógica de compra
 * e renovação: sem esse desvio, pagar a diferença cairia no ramo do Pix avulso
 * e daria ao aluno um período inteiro novo.
 */
const db = require('../../db/pool');
const { getSetting } = require('../settings');
const { AppError } = require('../../middleware/errors');
const { computeAccess, isSubscriptionActive } = require('../../middleware/access');
const coins = require('../coins');
const dates = require('../../utils/dates');
const asaas = require('./asaas');

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE_PREFIX = 'upgrade:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// O fim do período é copiado para o pedido pelo próprio banco, então em
// condições normais a diferença é zero. A folga cobre só arredondamento de
// milissegundos; uma renovação muda o fim em meses.
const PERIOD_TOLERANCE_MS = 1000;

function unavailable(reason, message, extra = {}) {
  return new AppError(409, 'upgrade_unavailable', message, { reason, ...extra });
}

const toTime = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** O fim do período ainda é o mesmo da cotação? Sem as duas datas, não dá para garantir. */
function samePeriod(current, quoted) {
  if (!current || !quoted) return false;
  const diff = Math.abs(toTime(current) - toTime(quoted));
  return Number.isFinite(diff) && diff <= PERIOD_TOLERANCE_MS;
}

// ---------------------------------------------------------------------------
// Cotação
// ---------------------------------------------------------------------------
/**
 * Quanto custa subir de nível agora. Função pura: sem banco e sem relógio
 * próprio, para a conta poder ser conferida com datas fixas.
 *
 * O ciclo atual é reconstruído a partir do FIM do período (fim − duração do
 * plano), e não de current_period_start: a renovação grava o início como a data
 * do pagamento e soma o fim ao anterior, então (fim − início) pode ser maior
 * que um ciclo e baratearia a diferença.
 *
 * @returns {{ amount_cents: number, ratio: number, remaining_days: number, min_applied: boolean,
 *             difference_cents: number, period_start: Date, period_end: Date }}
 */
function upgradeQuote({ fromPlan, toPlan, periodEnd, now = new Date(), minCents = 0 } = {}) {
  if (!fromPlan || !toPlan) throw new Error('upgradeQuote exige o plano atual e o plano novo.');
  if (!coins.TIERS.includes(fromPlan.tier)) {
    throw unavailable(
      'no_tier',
      'Seu plano atual é anterior aos níveis e não pode ser trocado pagando só a diferença. Fale com o suporte para mudar de plano.'
    );
  }
  if (!coins.TIERS.includes(toPlan.tier)) {
    throw unavailable('no_tier', 'Este plano não tem nível e não pode ser escolhido como upgrade.');
  }
  if (coins.tierRank(toPlan.tier) <= coins.tierRank(fromPlan.tier)) {
    throw unavailable('not_higher', 'O upgrade só vale para um nível acima do seu plano atual.');
  }

  const duration = Math.round(Number(fromPlan.duration_months) || 0);
  if (duration < 1 || duration !== Math.round(Number(toPlan.duration_months) || 0)) {
    throw unavailable(
      'different_duration',
      'O upgrade vale só para o plano com a mesma duração do seu (mensal, 6 meses ou 12 meses).'
    );
  }

  const difference = Math.round(Number(toPlan.price_cents)) - Math.round(Number(fromPlan.price_cents));
  if (!Number.isFinite(difference) || difference <= 0) {
    // Nível acima custando o mesmo ou menos é cadastro errado no painel.
    // Cobrar o mínimo aqui seria cobrar por nada.
    throw unavailable(
      'no_difference',
      'Não há diferença de preço para pagar neste plano. Fale com o suporte para fazer a troca.'
    );
  }

  const end = periodEnd instanceof Date ? new Date(periodEnd.getTime()) : new Date(periodEnd || NaN);
  const at = toTime(now);
  if (Number.isNaN(end.getTime()) || !Number.isFinite(at)) {
    throw unavailable('no_period', 'Não foi possível calcular o upgrade da sua assinatura. Fale com o suporte.');
  }
  if (end.getTime() <= at) {
    throw unavailable('period_over', 'O período da sua assinatura já terminou. Renove o plano para fazer upgrade.');
  }

  const start = asaas.addMonths(end, -duration);
  const total = end.getTime() - start.getTime();
  const remaining = end.getTime() - at;
  const ratio = Math.min(1, Math.max(0, remaining / total));
  const proportional = Math.round(difference * ratio);
  // Nunca zero: uma cobrança de R$ 0,00 não existe no provedor.
  const floor = Math.max(1, Math.round(Number(minCents) || 0));

  return {
    amount_cents: Math.max(proportional, floor),
    ratio,
    remaining_days: Math.ceil(remaining / DAY_MS),
    min_applied: proportional < floor,
    difference_cents: difference,
    period_start: start,
    period_end: end,
  };
}

async function minimumCents() {
  const value = Number(await getSetting('upgrade_min_cents'));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Confere se o aluno pode subir para o plano pedido e calcula o valor.
 * Não grava nada: é o que a tela mostra antes do clique.
 *
 * @returns {Promise<{ subscription: object, fromPlan: object, toPlan: object, quote: object }>}
 */
async function checkUpgrade({ userId, toPlanId, now = new Date(), access = null } = {}) {
  if (!userId) throw new Error('checkUpgrade exige o aluno.');
  const at = toTime(now);
  const current = access || (await computeAccess(userId));
  const sub = current && current.subscription;

  // Mesmo critério do acesso ao conteúdo: status ativo com período vencido
  // não é assinatura, e cortesia do painel não é plano pago.
  if (!sub || !isSubscriptionActive(sub, at)) {
    throw unavailable('no_subscription', 'Você não tem uma assinatura ativa. Escolha um plano para assinar.');
  }
  if (sub.status === 'trialing') {
    throw unavailable('trialing', 'O upgrade fica disponível depois do período de teste.');
  }
  if (sub.status !== 'active') {
    throw unavailable('not_active', 'O upgrade só fica disponível com a assinatura em dia.');
  }
  if (!coins.TIERS.includes(sub.plan_tier)) {
    const legacyUntil = sub.legacy_until ? new Date(sub.legacy_until) : null;
    if (legacyUntil && legacyUntil.getTime() > at) {
      throw unavailable(
        'legacy',
        `Seu plano atual já tem acesso completo até ${dates.formatBR(legacyUntil)}. O upgrade vale para os planos com nível.`,
        { legacy_until: legacyUntil.toISOString() }
      );
    }
    throw unavailable(
      'no_tier',
      'Seu plano atual é anterior aos níveis e não pode ser trocado pagando só a diferença. Fale com o suporte para mudar de plano.'
    );
  }
  if (!sub.current_period_end) {
    throw unavailable('no_period', 'Não foi possível calcular o upgrade da sua assinatura. Fale com o suporte.');
  }

  const [fromPlan, toPlan, minCents] = await Promise.all([
    db.one('SELECT * FROM plans WHERE id = $1', [sub.plan_id]),
    db.one('SELECT * FROM plans WHERE id = $1 AND active = true', [toPlanId]),
    minimumCents(),
  ]);
  if (!toPlan) throw new AppError(404, 'not_found', 'Plano não encontrado ou indisponível.');
  if (!fromPlan) {
    throw unavailable('no_tier', 'Não foi possível identificar o seu plano atual. Fale com o suporte.');
  }

  const quote = upgradeQuote({ fromPlan, toPlan, periodEnd: sub.current_period_end, now: new Date(at), minCents });
  return { subscription: sub, fromPlan, toPlan, quote };
}

// ---------------------------------------------------------------------------
// Pedido e cobrança
// ---------------------------------------------------------------------------
/** Marca o pedido como cancelado sem deixar a falha disso esconder o erro original. */
async function cancelChange(changeId) {
  try {
    await db.query(`UPDATE plan_changes SET status = 'canceled' WHERE id = $1 AND status = 'pending'`, [changeId]);
  } catch (err) {
    console.error(`[upgrade] não foi possível cancelar o pedido ${changeId}: ${err.message}`);
  }
}

/** Apaga no Asaas uma cobrança de upgrade que não vale mais. Melhor esforço: falhar aqui só fica no log. */
async function dropPayment(paymentId, changeId) {
  if (!paymentId) return;
  try {
    await asaas.deletePayment(paymentId);
  } catch (err) {
    console.warn(`[upgrade] não foi possível apagar a cobrança ${paymentId} do pedido ${changeId}: ${err.message}`);
  }
}

/**
 * Abre o pedido de upgrade e a cobrança da diferença no Asaas.
 * @returns {Promise<{ url: string, amount_cents: number, plan_change_id: string }>}
 */
async function createUpgrade({ user, toPlanId, now = new Date() } = {}) {
  if (!user || !user.id) throw new Error('createUpgrade exige o aluno.');
  const { subscription, fromPlan, toPlan, quote } = await checkUpgrade({ userId: user.id, toPlanId, now });

  const { change, stale } = await db.tx(async (tx) => {
    // Dois cliques em "Fazer upgrade" chegam juntos. A trava por aluno faz um
    // esperar o outro, e cada pedido novo cancela os anteriores: fica no
    // máximo uma cobrança de upgrade em aberto por aluno. Duas abertas (Pro e
    // Avançado, por exemplo) poderiam ser pagas as duas.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${REFERENCE_PREFIX}${user.id}`]);
    const antigos = await tx.many(
      `UPDATE plan_changes SET status = 'canceled'
        WHERE user_id = $1 AND status IN ('pending', 'expired')
        RETURNING id, provider_payment_id`,
      [user.id]
    );
    // A linha nasce a partir da assinatura, e só se ela ainda estiver como na
    // cotação: mesmo plano, ativa e com o mesmo fim de período. O fim é
    // copiado pelo banco para a comparação no webhook ser exata.
    const criado = await tx.one(
      `INSERT INTO plan_changes (user_id, subscription_id, from_plan_id, to_plan_id, amount_cents,
                                 period_end_at_quote, status, provider)
       SELECT s.user_id, s.id, s.plan_id, $3, $4, s.current_period_end, 'pending', 'asaas'
         FROM subscriptions s
        WHERE s.id = $1 AND s.user_id = $2 AND s.plan_id = $5 AND s.status = 'active'
          AND abs(extract(epoch FROM s.current_period_end - $6::timestamptz)) < 1
       RETURNING *`,
      [subscription.id, user.id, toPlan.id, quote.amount_cents, fromPlan.id, new Date(subscription.current_period_end)]
    );
    if (!criado) {
      throw unavailable(
        'changed',
        'Sua assinatura mudou enquanto o upgrade era calculado. Atualize a página e tente de novo.'
      );
    }
    return { change: criado, stale: antigos };
  });

  for (const antigo of stale) await dropPayment(antigo.provider_payment_id, antigo.id);

  let payment;
  try {
    payment = await asaas.createUpgradePayment({
      user,
      amountCents: change.amount_cents,
      description: `Upgrade para ${toPlan.name}`,
      reference: `${REFERENCE_PREFIX}${change.id}`,
    });
  } catch (err) {
    await cancelChange(change.id);
    throw err;
  }

  // O id do pagamento é gravado mesmo que o pedido não siga adiante: é por
  // ele que o webhook reconhece a cobrança, e uma cobrança que o Asaas não
  // deixou apagar ainda pode ser paga.
  const saved = await db.one(
    `UPDATE plan_changes SET provider_payment_id = $2, invoice_url = $3 WHERE id = $1 RETURNING status`,
    [change.id, payment.id, payment.invoice_url]
  );

  if (!payment.invoice_url) {
    await cancelChange(change.id);
    await dropPayment(payment.id, change.id);
    throw new AppError(
      502,
      'payment_provider_error',
      'O provedor de pagamento não devolveu o link de pagamento. Tente novamente.'
    );
  }
  if (!saved || saved.status !== 'pending') {
    // Outro clique abriu um pedido depois deste e já o cancelou.
    await dropPayment(payment.id, change.id);
    throw unavailable('superseded', 'Outro pedido de upgrade foi aberto ao mesmo tempo. Atualize a página e use o mais recente.');
  }

  return { url: payment.invoice_url, amount_cents: change.amount_cents, plan_change_id: change.id };
}

/**
 * Upgrade do aluno que espera pagamento e que ainda vale se for pago agora:
 * é da assinatura atual, ela continua ativa, no plano de origem e com o mesmo
 * fim de período da cotação. A tela de assinatura mostra a fatura dele em vez
 * de oferecer o botão de novo. Um pedido que já não pode ser aplicado (o
 * período renovou, o plano mudou) fica de fora: pagá-lo só geraria um caso
 * para o suporte, e um pedido novo o cancela.
 *
 * @returns {Promise<null | { id: string, to_plan: { id: string, name: string, tier: string|null },
 *                           amount_cents: number, invoice_url: string, created_at: string }>}
 */
async function pendingUpgrade(userId, { now = new Date() } = {}) {
  if (!userId) return null;
  const row = await db.one(
    `SELECT pc.id, pc.amount_cents, pc.invoice_url, pc.created_at,
            tp.id AS to_plan_id, tp.name AS to_plan_name, tp.tier AS to_plan_tier
       FROM plan_changes pc
       JOIN subscriptions s ON s.id = pc.subscription_id
       JOIN plans tp ON tp.id = pc.to_plan_id
      WHERE pc.user_id = $1 AND pc.status = 'pending' AND pc.invoice_url IS NOT NULL
        AND s.plan_id = pc.from_plan_id AND s.status = 'active' AND s.current_period_end > $2
        AND abs(extract(epoch FROM s.current_period_end - pc.period_end_at_quote)) < 1
      ORDER BY pc.created_at DESC
      LIMIT 1`,
    [userId, now]
  );
  if (!row) return null;
  return {
    id: row.id,
    to_plan: { id: row.to_plan_id, name: row.to_plan_name, tier: row.to_plan_tier || null },
    amount_cents: row.amount_cents,
    invoice_url: row.invoice_url,
    created_at: row.created_at,
  };
}

/**
 * Upgrades pagos que NÃO trocaram o plano (status 'paid' e applied_at nulo).
 *
 * O webhook confirma o pagamento e, se a assinatura já não está como na
 * cotação, registra sem trocar — decidir entre aplicar à mão e devolver o
 * valor é do suporte. Esta lista é por onde o suporte fica sabendo; antes, o
 * caso só aparecia no log do servidor. O motivo é recalculado com a mesma
 * régua do webhook sobre a assinatura de hoje, por isso é o motivo PROVÁVEL:
 * a assinatura pode ter mudado de novo depois do pagamento.
 */
async function unappliedUpgrades({ now = new Date() } = {}) {
  const rows = await db.many(
    `SELECT pc.id, pc.user_id, pc.subscription_id, pc.from_plan_id, pc.to_plan_id, pc.amount_cents,
            pc.period_end_at_quote, pc.provider, pc.provider_payment_id, pc.invoice_url,
            pc.created_at, pc.paid_at,
            u.name AS user_name, u.email AS user_email,
            fp.name AS from_plan_name, fp.tier AS from_plan_tier,
            tp.name AS to_plan_name, tp.tier AS to_plan_tier,
            s.id AS sub_id, s.plan_id AS sub_plan_id, s.status AS sub_status,
            s.current_period_end AS sub_current_period_end, sp.name AS sub_plan_name
       FROM plan_changes pc
       JOIN users u ON u.id = pc.user_id
       LEFT JOIN plans fp ON fp.id = pc.from_plan_id
       LEFT JOIN plans tp ON tp.id = pc.to_plan_id
       LEFT JOIN subscriptions s ON s.id = pc.subscription_id
       LEFT JOIN plans sp ON sp.id = s.plan_id
      WHERE pc.status = 'paid' AND pc.applied_at IS NULL
      ORDER BY pc.paid_at DESC NULLS LAST, pc.created_at DESC`
  );

  return rows.map((row) => {
    const sub = row.sub_id
      ? { id: row.sub_id, plan_id: row.sub_plan_id, status: row.sub_status, current_period_end: row.sub_current_period_end }
      : null;
    // Sem bloqueio hoje, a assinatura só não estava como na cotação no
    // momento do pagamento (em atraso, por exemplo) e depois voltou.
    const reason = blockingReason(row, sub, now)
      || 'no dia do pagamento a assinatura não estava como na cotação; hoje está, e a troca pode ser aplicada';
    return {
      id: row.id,
      user: { id: row.user_id, name: row.user_name, email: row.user_email },
      from_plan: { id: row.from_plan_id, name: row.from_plan_name || null, tier: row.from_plan_tier || null },
      to_plan: { id: row.to_plan_id, name: row.to_plan_name || null, tier: row.to_plan_tier || null },
      amount_cents: row.amount_cents,
      paid_at: row.paid_at,
      created_at: row.created_at,
      provider: row.provider,
      provider_payment_id: row.provider_payment_id,
      invoice_url: row.invoice_url,
      subscription: sub
        ? { ...sub, plan_name: row.sub_plan_name || null }
        : null,
      reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
/**
 * Descobre se um evento do Asaas é da cobrança de um upgrade.
 *
 * A primeira chave é o id do pagamento, gravado quando a cobrança foi criada:
 * é o único identificador que certamente vem no evento. A referência
 * 'upgrade:<id>' é a reserva para o caso raro de o Asaas ter criado a cobrança
 * e a resposta não ter chegado aqui (queda de rede, tempo esgotado).
 *
 * @returns {Promise<null | { change: object|null, paymentId: string|null }>}
 *   null quando o evento não é de upgrade; `change` nulo quando a referência
 *   diz que é, mas o pedido não existe — nesse caso o evento não pode seguir
 *   para a lógica de compra de jeito nenhum.
 */
async function findUpgradeForEvent(tx, info) {
  const paymentId = info && info.payment && info.payment.id ? String(info.payment.id) : null;
  if (paymentId) {
    const byPayment = await tx.one(
      `SELECT * FROM plan_changes WHERE provider = 'asaas' AND provider_payment_id = $1 FOR UPDATE`,
      [paymentId]
    );
    if (byPayment) return { change: byPayment, paymentId };
  }

  const reference = info && typeof info.external_reference === 'string' ? info.external_reference.trim() : '';
  if (!reference.toLowerCase().startsWith(REFERENCE_PREFIX)) return null;
  const changeId = reference.slice(REFERENCE_PREFIX.length);
  const byReference = UUID_RE.test(changeId)
    ? await tx.one('SELECT * FROM plan_changes WHERE id = $1 FOR UPDATE', [changeId])
    : null;
  return { change: byReference, paymentId };
}

/**
 * Leva o valor da assinatura recorrente no Asaas para o preço do plano.
 * Sem isso o cartão renovaria no preço do nível anterior. Falhar aqui não pode
 * derrubar o webhook (o nível já foi decidido); fica no log para o suporte.
 */
async function updateRecurringValue(tx, subscription, planId, userId) {
  const plan = await tx.one('SELECT * FROM plans WHERE id = $1', [planId]);
  if (!plan) return false;
  try {
    await asaas.request('PUT', `/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}`, {
      value: Number(plan.price_cents || 0) / 100,
      description: asaas.subscriptionDescription(plan),
      externalReference: asaas.buildReference(userId, plan.id),
      // a próxima cobrança pode já existir, pendente, no valor antigo
      updatePendingPayments: true,
    });
    return true;
  } catch (err) {
    console.error(
      `[upgrade] não foi possível levar a assinatura ${subscription.provider_subscription_id} para o valor de ${plan.name}: ${err.message}. A próxima cobrança pode sair no valor antigo.`
    );
    return false;
  }
}

/**
 * Por que o pedido não pode trocar o plano da assinatura agora (null quando
 * pode). É a mesma régua da confirmação do pagamento e da lista do painel de
 * upgrades pagos sem troca, para o suporte ler ali o motivo que o webhook viu.
 */
function blockingReason(change, sub, now = new Date()) {
  if (!sub) return 'a assinatura do pedido não existe mais';
  if (sub.plan_id !== change.from_plan_id) {
    return sub.plan_id === change.to_plan_id ? 'a assinatura já estava no plano novo' : 'o plano da assinatura mudou depois do pedido';
  }
  if (sub.status !== 'active' || !isSubscriptionActive(sub, toTime(now))) return 'a assinatura não está mais ativa';
  if (!samePeriod(sub.current_period_end, change.period_end_at_quote)) {
    // Renovou entre o pedido e o pagamento: a diferença foi cotada sobre o
    // restinho do período velho, e aplicar agora daria o nível novo por um
    // ciclo inteiro pago no preço antigo.
    return 'o período da assinatura renovou depois do pedido';
  }
  return null;
}

/**
 * Assinatura recorrente que ainda vai cobrar de novo no Asaas.
 *
 * cancel_at_period_end sozinho não prova que ela acabou lá: o cartão recusado
 * na renovação, com o período ainda pago, também o liga — para a tela avisar —
 * e a assinatura continua viva no Asaas, pronta para cobrar quando o aluno
 * trocar o cartão. Tratá-la como encerrada pulava o PUT do valor novo, e o
 * cartão renovava o Pro no preço do Básico para sempre. Encerrada de verdade é
 * a que também tem canceled_at: o cancelamento pelo aluno (DELETE no Asaas),
 * SUBSCRIPTION_DELETED e SUBSCRIPTION_INACTIVATED gravam os dois juntos.
 */
const renewsOnCard = (subscription) =>
  Boolean(
    subscription &&
      subscription.provider_subscription_id &&
      !(subscription.cancel_at_period_end && subscription.canceled_at)
  );

async function confirmUpgrade(tx, change, info, paymentId) {
  if (change.status === 'paid') return { unchanged: 'upgrade já aplicado' };
  if (change.status === 'refunded') return { unchanged: 'upgrade já estornado' };

  // A MESMA linha da cotação, travada: tudo abaixo decide a partir dela.
  const sub = change.subscription_id
    ? await tx.one('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [change.subscription_id])
    : null;
  const now = new Date();

  // Pedido cancelado ou vencido também chega aqui quando o aluno paga mesmo
  // assim (a cobrança antiga nem sempre pode ser apagada). O dinheiro entrou,
  // então a troca vale se a assinatura continua exatamente como na cotação.
  const motivo = blockingReason(change, sub, now);

  const applied = !motivo;
  if (applied) {
    // Só o plano. Período, status, last_payment_id e legacy_until ficam como
    // estão (ver o comentário do topo do arquivo).
    await tx.query('UPDATE subscriptions SET plan_id = $2 WHERE id = $1', [sub.id, change.to_plan_id]);
  }
  await tx.query(
    `UPDATE plan_changes
        SET status = 'paid', paid_at = $2, applied_at = $3,
            provider_payment_id = COALESCE(provider_payment_id, $4)
      WHERE id = $1`,
    [change.id, (info.payment && info.payment.paid_at) || now, applied ? now : null, paymentId]
  );

  if (!applied) {
    console.warn(
      `[upgrade] pedido ${change.id} do aluno ${change.user_id} foi pago (R$ ${(change.amount_cents / 100).toFixed(2).replace('.', ',')}) e o plano NÃO foi trocado: ${motivo}. O suporte precisa aplicar à mão ou devolver o valor.`
    );
    return { status: 'paid', applied: false, reason: motivo };
  }

  const value = info.payment && info.payment.value_cents;
  if (value && value !== change.amount_cents) {
    console.warn(`[upgrade] pedido ${change.id}: cotado em ${change.amount_cents} centavos e pago ${value}.`);
  }
  if (renewsOnCard(sub)) await updateRecurringValue(tx, sub, change.to_plan_id, change.user_id);
  return { status: 'paid', applied: true, subscription_id: sub.id };
}

async function refundUpgrade(tx, change) {
  if (change.status === 'refunded') return { unchanged: 'upgrade já estornado' };

  const sub = change.subscription_id
    ? await tx.one('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [change.subscription_id])
    : null;

  // Só desfaz a troca que este pedido fez. O acesso NÃO acaba: o que voltou
  // ao aluno foi a diferença, e o período do plano anterior continua pago.
  let reverted = false;
  if (change.status === 'paid' && change.applied_at && sub && sub.plan_id === change.to_plan_id) {
    if (samePeriod(sub.current_period_end, change.period_end_at_quote)) {
      await tx.query('UPDATE subscriptions SET plan_id = $2 WHERE id = $1', [sub.id, change.from_plan_id]);
      reverted = true;
      if (renewsOnCard(sub)) await updateRecurringValue(tx, sub, change.from_plan_id, change.user_id);
    } else {
      // Depois da renovação o ciclo atual já foi cobrado no preço do nível
      // novo; devolver a diferença do ciclo anterior não tira esse nível.
      console.warn(
        `[upgrade] estorno do pedido ${change.id} chegou depois da renovação; o nível novo foi mantido porque o período atual já foi pago nele.`
      );
    }
  } else if (change.status === 'paid' && change.applied_at) {
    console.warn(`[upgrade] estorno do pedido ${change.id}: o plano mudou depois da troca, nada foi desfeito.`);
  }

  await tx.query(`UPDATE plan_changes SET status = 'refunded', refunded_at = now() WHERE id = $1`, [change.id]);
  return { status: 'refunded', reverted };
}

/**
 * Aplica um evento do Asaas a um pedido de upgrade.
 *
 * Idempotente por construção: pedido pago não é aplicado de novo, estornado
 * não volta a ser pago. Isso cobre o CONFIRMED e o RECEIVED da mesma
 * cobrança, o reenvio do webhook e o reprocessamento pelo painel.
 */
async function applyUpgradeEvent(tx, change, event) {
  const info = asaas.normalizeEvent(event.payload);
  const paymentId = info.payment && info.payment.id ? String(info.payment.id) : null;
  const base = { upgrade: true, plan_change_id: change.id };

  if (paymentId && change.provider_payment_id && change.provider_payment_id !== paymentId) {
    // Achado pela referência, mas com outra cobrança gravada: não é este
    // pedido. Melhor não mexer em nada do que trocar plano por engano.
    console.warn(
      `[upgrade] evento ${event.type} da cobrança ${paymentId} cita o pedido ${change.id}, que é da cobrança ${change.provider_payment_id}. Ignorado.`
    );
    return { ...base, skipped: 'cobrança não confere com o pedido de upgrade' };
  }

  switch (event.type) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED':
      return { ...base, ...(await confirmUpgrade(tx, change, info, paymentId)) };
    case 'PAYMENT_REFUNDED':
    case 'PAYMENT_PARTIALLY_REFUNDED':
    case 'PAYMENT_CHARGEBACK_REQUESTED':
    case 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL':
    case 'PAYMENT_CHARGEBACK_DISPUTE':
      return { ...base, ...(await refundUpgrade(tx, change)) };
    case 'PAYMENT_DELETED':
    case 'PAYMENT_OVERDUE': {
      const next = event.type === 'PAYMENT_DELETED' ? 'canceled' : 'expired';
      const row = await tx.one(
        `UPDATE plan_changes SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING status`,
        [change.id, next]
      );
      return row ? { ...base, status: row.status } : { ...base, unchanged: `pedido já estava ${change.status}` };
    }
    default:
      return { ...base, skipped: 'evento de upgrade sem tratamento' };
  }
}

module.exports = {
  REFERENCE_PREFIX,
  upgradeQuote,
  checkUpgrade,
  createUpgrade,
  pendingUpgrade,
  unappliedUpgrades,
  blockingReason,
  findUpgradeForEvent,
  applyUpgradeEvent,
};

'use strict';

/**
 * Camada única de pagamentos: o resto do sistema fala só com este módulo.
 *
 *   const payments = require('../services/payments');
 *   await payments.getProvider();                                  // 'asaas' | 'none'
 *   await payments.isConfigured();
 *   await payments.status();                                       // para o painel
 *   await payments.createCheckout({ user, plan, successUrl, cancelUrl });  // → { url, provider }
 *   await payments.createPortal(user, returnUrl);                  // → { url|null, provider }
 *   await payments.syncPlan(plan);
 *   await payments.quoteUpgrade({ user, planId });                 // → { fromPlan, toPlan, quote, ... }
 *   await payments.createUpgrade({ user, planId });                // → { url, amount_cents, plan_change_id }
 *   await payments.handleWebhook({ provider, rawBody, headers });
 *
 * O Asaas é o único provedor de cobrança. A configuração `payment_provider=none`
 * permite desligar pagamentos temporariamente; qualquer outro valor usa o Asaas.
 *
 * A gravação em subscriptions passa por applySubscription e a idempotência do
 * webhook usa payment_events (provider + event_id).
 */
const config = require('../../config');
const db = require('../../db/pool');
const { getSetting } = require('../settings');
const dates = require('../../utils/dates');
const asaas = require('./asaas');
const upgrade = require('./upgrade');

const ADAPTERS = { asaas };
const PROVIDER_NAMES = ['asaas', 'none'];
const LABELS = { asaas: asaas.label, none: 'Nenhum' };

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
 * @returns {Promise<'asaas'|'none'>}
 */
async function getProvider() {
  const stored = normalizeName(await getSetting('payment_provider'));
  const environment = normalizeName(process.env.PAYMENT_PROVIDER);
  return stored || environment || 'asaas';
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
    payment_methods: active && Array.isArray(active.payment_methods) ? active.payment_methods : ['credit_card'],
    providers: { asaas: asaas.status() },
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
async function createCheckout({ user, plan, paymentMethod, successUrl, cancelUrl }) {
  const adapter = await requireAdapter();
  const result = await adapter.createCheckout({ user, plan, paymentMethod, successUrl, cancelUrl });
  return { provider: adapter.name, ...result };
}

/**
 * Área de gerenciamento da assinatura. O Asaas não tem portal: devolve a fatura em
 * aberto quando existe e, na falta dela, url nula — a tela do aluno então mostra os
 * dados da assinatura e o contato do suporte.
 */
/**
 * Cancela a assinatura do aluno no provedor e agenda o encerramento.
 *
 * O período já pago não é devolvido nem encurtado: o acesso vale até o fim e
 * só não renova. Quem paga por seis meses e desiste no segundo continua com os
 * quatro que comprou.
 */
async function cancelSubscription(user) {
  const adapter = await requireAdapter();
  const current = await db.one(
    `SELECT id, status, provider, provider_subscription_id, current_period_end
       FROM subscriptions
      WHERE user_id = $1 AND status IN ('active', 'trialing')
      ORDER BY current_period_end DESC NULLS LAST
      LIMIT 1`,
    [user.id]
  );
  if (!current) {
    throw providerError('not_found', 'Você não tem uma assinatura ativa para cancelar.');
  }

  // Pix avulso não tem assinatura do lado do provedor: não há o que cancelar
  // lá, e o acesso já termina sozinho no fim do período pago.
  if (current.provider_subscription_id && adapter.cancelSubscription) {
    await adapter.cancelSubscription(current.provider_subscription_id);
  }

  const row = await db.one(
    `UPDATE subscriptions
        SET cancel_at_period_end = true, canceled_at = coalesce(canceled_at, now())
      WHERE id = $1
      RETURNING id, status, current_period_end, cancel_at_period_end`,
    [current.id]
  );
  return row;
}

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
// Upgrade pela diferença (regras em ./upgrade.js)
// ---------------------------------------------------------------------------
/** Valida e cota o upgrade, sem gravar nada. */
async function quoteUpgrade({ user, planId, now }) {
  return upgrade.checkUpgrade({ userId: user.id, toPlanId: planId, now });
}

/** Abre o pedido de upgrade e a cobrança da diferença no provedor ativo. */
async function createUpgrade({ user, planId }) {
  await requireAdapter();
  return upgrade.createUpgrade({ user, toPlanId: planId });
}

// ---------------------------------------------------------------------------
// Gravação comum das assinaturas
// ---------------------------------------------------------------------------
/**
 * Cria ou atualiza a assinatura Asaas do aluno. A linha é identificada por
 * (provider, provider_subscription_id).
 * Campos nulos não apagam o que já estava gravado.
 */
async function applySubscription(tx, data) {
  if (!data || !data.user_id || !data.provider) {
    throw new Error('applySubscription exige user_id e provider.');
  }

  // Pix avulso não gera assinatura no Asaas, então não há id do provedor para
  // conciliar. Nesses casos a linha é encontrada pelo id local, que o chamador
  // já buscou pelo aluno, ou criada do zero.
  if (!data.provider_subscription_id) {
    if (data.id) {
      return tx.one(
        `UPDATE subscriptions SET
           plan_id = COALESCE($2, plan_id),
           provider_customer_id = COALESCE($3, provider_customer_id),
           status = $4,
           current_period_start = COALESCE($5, current_period_start),
           current_period_end = COALESCE($6, current_period_end),
           cancel_at_period_end = $7,
           canceled_at = COALESCE($8, canceled_at),
           last_payment_at = COALESCE($9, last_payment_at),
           last_payment_id = COALESCE($10, last_payment_id),
           payment_method = COALESCE($11, payment_method)
         WHERE id = $1
         RETURNING *`,
        [
          data.id,
          data.plan_id ?? null,
          data.provider_customer_id ?? null,
          data.status,
          data.current_period_start ?? null,
          data.current_period_end ?? null,
          Boolean(data.cancel_at_period_end),
          data.canceled_at ?? null,
          data.last_payment_at ?? null,
          data.last_payment_id ?? null,
          data.payment_method ?? null,
        ]
      );
    }
    return tx.one(
      `INSERT INTO subscriptions (
         user_id, plan_id, provider, provider_customer_id, provider_subscription_id,
         status, current_period_start, current_period_end, cancel_at_period_end,
         canceled_at, last_payment_at, last_payment_id, payment_method
       ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.user_id,
        data.plan_id ?? null,
        data.provider,
        data.provider_customer_id ?? null,
        data.status,
        data.current_period_start ?? null,
        data.current_period_end ?? null,
        Boolean(data.cancel_at_period_end),
        data.canceled_at ?? null,
        data.last_payment_at ?? null,
        data.last_payment_id ?? null,
        data.payment_method ?? null,
      ]
    );
  }

  return tx.one(
    `INSERT INTO subscriptions (
       user_id, plan_id, provider, provider_customer_id, provider_subscription_id,
       status, current_period_start, current_period_end, cancel_at_period_end,
       canceled_at, last_payment_at, last_payment_id, payment_method
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
       last_payment_id = COALESCE(EXCLUDED.last_payment_id, subscriptions.last_payment_id),
       payment_method = COALESCE(EXCLUDED.payment_method, subscriptions.payment_method)
     RETURNING *`,
    [
      data.user_id,
      data.plan_id ?? null,
      data.provider,
      data.provider_customer_id ?? null,
      data.provider_subscription_id,
      data.status,
      data.current_period_start ?? null,
      data.current_period_end ?? null,
      Boolean(data.cancel_at_period_end),
      data.canceled_at ?? null,
      data.last_payment_at ?? null,
      data.last_payment_id ?? null,
      data.payment_method ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
/** Descobre o provedor pelo cabeçalho da requisição. */
function detectProvider(headers = {}) {
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

/**
 * Plano a gravar na assinatura por causa deste evento.
 *
 * Com a assinatura já conhecida, vale o plano que está nela, e não o da
 * referência externa nem o do checkout. A referência é fixada quando a
 * assinatura nasce e continua chegando em todo evento dela — renovação,
 * atraso, cancelamento. Depois de um upgrade pela diferença ela ainda aponta
 * para o plano antigo (o Asaas não promete reescrevê-la nas cobranças já
 * geradas), e dar prioridade a ela desfazia o upgrade no primeiro evento que
 * chegasse, inclusive o SUBSCRIPTION_DELETED do próprio cancelamento.
 *
 * A exceção é a compra nova (`newPurchase`): o Pix avulso reaproveita a mesma
 * linha a cada compra, e ali o plano certo é o que acabou de ser comprado.
 */
async function resolvePlan(tx, { current, reference, checkout, newPurchase = false }) {
  if (current && current.plan_id && !newPurchase) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [current.plan_id]);
    if (row) return row;
  }
  if (reference.plan_id) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [reference.plan_id]);
    if (row) return row;
  }
  if (checkout && checkout.plan_id) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [checkout.plan_id]);
    if (row) return row;
  }
  if (current && current.plan_id) {
    const row = await tx.one('SELECT * FROM plans WHERE id = $1', [current.plan_id]);
    if (row) return row;
  }
  return null;
}

/** A migration que criou os níveis e tirou os planos antigos da vitrine. */
const MIGRATION_DOS_NIVEIS = '218_moedas_e_niveis.sql';

/**
 * Compra de plano antigo que já estava em andamento quando os níveis entraram:
 * teste de 24h no cartão, assinatura esperando a primeira cobrança, checkout
 * do Pix aberto antes e pago depois.
 *
 * A migration 218 só deu legacy_until a quem já tinha período. No teste, o
 * "período" era o das 24h; nos outros casos, nenhum. Esses alunos pagam o
 * preço cheio do plano antigo, vendido como acesso completo, DEPOIS da
 * migration — e sem isto passariam o período inteiro no Básico, sem upgrade
 * (plano sem nível) e sem poder comprar outro (assinatura ativa). A primeira
 * cobrança deles é a compra do pacote antigo, não uma renovação, então o
 * legado acompanha o período comprado.
 *
 * Checkout aberto antes da migration é o critério porque ela tirou os planos
 * antigos da vitrine: plano sem nível comprado depois disso é plano criado ou
 * reativado no painel, e esse vale Básico, como decidido. A reserva é o teste
 * que a própria migration pegou: legacy_until gravado e nenhum pagamento.
 */
async function oldPlanPurchaseInFlight(tx, { plan, current, checkout, first }) {
  if (!plan || plan.tier) return false;
  if (first && current && current.legacy_until) return true;
  if (!checkout || !checkout.created_at) return false;
  const migration = await tx.one('SELECT applied_at FROM schema_migrations WHERE name = $1', [MIGRATION_DOS_NIVEIS]);
  return Boolean(migration && new Date(checkout.created_at).getTime() < new Date(migration.applied_at).getTime());
}

/** Legado até o fim do período que a compra acabou de conceder. */
async function extendLegacyToPeriodEnd(tx, subscriptionId) {
  await tx.query('UPDATE subscriptions SET legacy_until = current_period_end WHERE id = $1', [subscriptionId]);
}

/** Checkout mais provável para um evento cuja assinatura ainda não foi ligada localmente. */
async function findRelatedCheckout(tx, { userId, planId, subscriptionId, paymentMethod }) {
  if (!userId) return null;
  return tx.one(
    `SELECT *
       FROM payment_checkouts
      WHERE provider = 'asaas'
        AND user_id = $1
        AND (provider_subscription_id = $2 OR provider_subscription_id IS NULL)
        AND ($3::text IS NULL OR payment_method = $3)
        AND ($4::uuid IS NULL OR plan_id = $4)
        AND status IN ('pending', 'completed', 'paid')
      ORDER BY CASE WHEN provider_subscription_id = $2 THEN 0 ELSE 1 END,
               created_at DESC
      LIMIT 1`,
    [userId, subscriptionId, paymentMethod || null, planId || null]
  );
}

/**
 * Evento de cobrança de upgrade? Então ele é aplicado ao pedido de upgrade e
 * NÃO segue para a lógica de compra e renovação.
 *
 * Fica no topo de applyAsaasEvent e de applyAsaasCheckoutEvent, e não só em
 * handleAsaasWebhook, porque o reprocessamento do painel e o script
 * scripts/reprocessar-pagamentos.js chamam essas duas funções direto. Um
 * pagamento de diferença que escapasse do desvio cairia no ramo do Pix avulso
 * e daria ao aluno um período inteiro novo (ou criaria uma assinatura para
 * quem assina no cartão).
 *
 * @returns {Promise<object|null>} resultado do upgrade, ou null se o evento não é de upgrade
 */
async function divertUpgrade(tx, event, info) {
  const found = await upgrade.findUpgradeForEvent(tx, info);
  if (!found) return null;
  if (!found.change) {
    console.warn(
      `[pagamentos] evento ${event.type} com referência de upgrade sem pedido correspondente (${info.external_reference}). Ignorado.`
    );
    return { upgrade: true, skipped: 'pedido de upgrade desconhecido' };
  }
  return upgrade.applyUpgradeEvent(tx, found.change, event);
}

/** Atualiza apenas o estado operacional do checkout; acesso depende da assinatura/pagamento. */
async function applyAsaasCheckoutEvent(tx, event) {
  const info = asaas.normalizeEvent(event.payload);
  const deUpgrade = await divertUpgrade(tx, event, info);
  if (deUpgrade) return deUpgrade;
  if (!info.checkout_id) return { skipped: 'evento sem checkout vinculado' };

  const nextStatus = {
    CHECKOUT_PAID: 'paid',
    CHECKOUT_CANCELED: 'canceled',
    CHECKOUT_EXPIRED: 'expired',
  }[event.type];
  if (!nextStatus) return { skipped: 'evento de checkout sem tratamento' };

  const row = await tx.one(
    `UPDATE payment_checkouts
        SET status = $2, updated_at = now()
      WHERE provider = 'asaas' AND provider_checkout_id = $1
      RETURNING id, provider_checkout_id, status, user_id, plan_id, payment_method, provider_subscription_id, created_at`,
    [info.checkout_id, nextStatus]
  );
  if (!row) return { skipped: 'checkout desconhecido' };

  // O cliente no Asaas nasce quando o aluno preenche o checkout hospedado, e é
  // aqui que ficamos sabendo o id dele. Guardar agora importa: os eventos
  // seguintes da assinatura chegam identificados só pelo cliente, e sem esse
  // vínculo o pagamento não encontraria o aluno.
  if (info.customer_id) {
    await tx.query('UPDATE users SET provider_customer_id = $1 WHERE id = $2 AND provider_customer_id IS NULL', [
      info.customer_id,
      row.user_id,
    ]);
  }

  // Pix é cobrança avulsa: não nasce assinatura no Asaas, e o evento de
  // pagamento pode chegar sem o externalReference do checkout — o Asaas não
  // promete copiar esse campo para a cobrança. Quando isso acontece, o
  // CHECKOUT_PAID é a única notícia confiável de que o aluno pagou, e é dele
  // que o acesso precisa sair. Foi exatamente o que falhou em produção: o Pix
  // foi pago e o plano não liberou.
  // Só o Pix: no cartão o checkout também chega aqui sem assinatura ainda,
  // porque ela nasce no SUBSCRIPTION_CREATED que vem depois — e é lá que o
  // teste de 24h e a recorrência são decididos.
  if (event.type === 'CHECKOUT_PAID' && row.payment_method === 'pix') {
    const plano = await tx.one('SELECT * FROM plans WHERE id = $1', [row.plan_id]);
    const credito = `checkout:${row.provider_checkout_id}`;
    // FOR UPDATE: a cobrança deste mesmo Pix pode estar sendo aplicada agora,
    // e a decisão abaixo depende do que ela gravar.
    const existente = await tx.one(
      `SELECT id, status, current_period_end, last_payment_at, last_payment_id FROM subscriptions
        WHERE provider = 'asaas' AND user_id = $1 AND provider_subscription_id IS NULL
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [row.user_id]
    );
    // Este checkout já concedeu o período: recalcular a partir de now() faria
    // o acesso crescer um pouco a cada reprocessamento.
    if (existente && existente.last_payment_id === credito) {
      return { ...row, subscription_id: existente.id, unchanged: 'cobrança já creditada' };
    }
    const agora = new Date();
    // A cobrança do Pix (PAYMENT_RECEIVED com a referência do checkout) pode
    // chegar antes deste evento e já ter concedido o período. O checkout só
    // abre para quem não tem assinatura vigente, então a linha vigente e paga
    // desde o dia em que ele foi aberto foi paga por esta compra. Recalcular
    // aqui não acrescentava nada e desfazia o que veio depois: um upgrade pago
    // nesse meio-tempo voltava ao plano do checkout, com o pedido marcado como
    // aplicado — ninguém ficava sabendo. O dia, e não a hora, porque a data de
    // pagamento do Asaas chega sem hora (meio-dia UTC). Só a trava do
    // reprocessamento passa a apontar para o checkout, como na ordem inversa.
    if (
      existente &&
      existente.status === 'active' &&
      existente.current_period_end &&
      new Date(existente.current_period_end).getTime() > agora.getTime() &&
      existente.last_payment_at &&
      new Date(existente.last_payment_at).getTime() >=
        dates.midnightInSaoPaulo(dates.toISODate(new Date(row.created_at))).getTime()
    ) {
      await tx.query('UPDATE subscriptions SET last_payment_id = $2 WHERE id = $1', [existente.id, credito]);
      return { ...row, subscription_id: existente.id, unchanged: 'cobrança já creditada pelo pagamento' };
    }
    if (plano) {
      const meses = asaas.accessMonths(plano, { first: true });
      const assinatura = await applySubscription(tx, {
        id: existente ? existente.id : null,
        user_id: row.user_id,
        plan_id: plano.id,
        provider: 'asaas',
        provider_customer_id: info.customer_id || null,
        provider_subscription_id: null,
        status: 'active',
        current_period_start: agora,
        current_period_end: asaas.addMonths(agora, meses),
        last_payment_at: agora,
        last_payment_id: credito,
        payment_method: row.payment_method,
        cancel_at_period_end: true, // pagamento único: não renova sozinho
      });
      if (await oldPlanPurchaseInFlight(tx, { plan: plano, checkout: row })) {
        await extendLegacyToPeriodEnd(tx, assinatura.id);
      }
      return { ...row, subscription_id: assinatura.id, current_period_end: assinatura.current_period_end };
    }
  }
  return row;
}

/**
 * Aplica um evento já validado do Asaas na assinatura do aluno.
 * @returns {Promise<object>} resumo do que foi feito
 */
async function applyAsaasEvent(tx, event) {
  const info = asaas.normalizeEvent(event.payload);
  // Antes de qualquer outra coisa: ver divertUpgrade.
  const deUpgrade = await divertUpgrade(tx, event, info);
  if (deUpgrade) return deUpgrade;
  const reference = asaas.parseReference(info.external_reference);

  // Pix é cobrança avulsa no Asaas — não existe assinatura do lado de lá, e o
  // evento chega sem `subscription`. O acesso desses alunos vem do pagamento
  // em si, conciliado pelo externalReference que o checkout gravou. Sem isso,
  // quem pagasse por Pix nunca receberia acesso.
  const avulso = !info.subscription_id;
  if (avulso && !info.payment) {
    return { skipped: 'evento sem assinatura vinculada' };
  }

  // O externalReference do checkout nem sempre acompanha a cobrança, então o
  // aluno do Pix avulso também é procurado pelo cliente do Asaas — que o
  // CHECKOUT_PAID já gravou no usuário.
  const alunoAvulso = avulso
    ? reference.user_id ||
      (info.customer_id
        ? (await tx.one('SELECT id FROM users WHERE provider_customer_id = $1', [info.customer_id]))?.id
        : null)
    : null;
  if (avulso && !alunoAvulso) {
    return { skipped: 'pagamento avulso sem aluno identificado' };
  }

  const current = avulso
    ? await tx.one(
        `SELECT * FROM subscriptions
          WHERE provider = 'asaas' AND user_id = $1 AND provider_subscription_id IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [alunoAvulso]
      )
    : await tx.one(
        // FOR UPDATE porque todo o resto do handler decide a partir desta
        // leitura. Sem a trava, dois eventos entregues ao mesmo tempo leem o
        // mesmo estado antigo e o último sobrescreve a decisão do primeiro.
        // O envio sequencial do provedor evita isso na prática, mas é
        // configuração no painel dele, não garantia nossa.
        `SELECT * FROM subscriptions
          WHERE provider = 'asaas' AND provider_subscription_id = $1
          FOR UPDATE`,
        [info.subscription_id]
      );
  const userId = await resolveUser(tx, { current, reference, customerId: info.customer_id });
  if (!userId) {
    console.warn(`[pagamentos] evento ${event.type} da assinatura ${info.subscription_id} sem aluno correspondente.`);
    return { skipped: 'sem aluno correspondente' };
  }
  const checkout = await findRelatedCheckout(tx, {
    userId,
    planId: reference.plan_id,
    subscriptionId: info.subscription_id,
    paymentMethod: info.payment_method,
  });

  const now = new Date();
  const previousEnd = current && current.current_period_end ? new Date(current.current_period_end) : null;
  const stillPaid = Boolean(previousEnd && previousEnd.getTime() > now.getTime());

  // Pagamento de Pix avulso depois que o período anterior acabou é compra
  // nova sobre a linha reaproveitada: o plano vem do que foi comprado agora.
  // Com o período ainda valendo (ou no cartão, cuja assinatura no Asaas é
  // sempre a mesma), vale o plano gravado — que pode ter mudado por upgrade.
  const newPurchase =
    avulso && !stillPaid && (event.type === 'PAYMENT_CONFIRMED' || event.type === 'PAYMENT_RECEIVED');
  const plan = await resolvePlan(tx, { current, reference, checkout, newPurchase });

  if (info.subscription_id && checkout && checkout.provider_subscription_id !== info.subscription_id) {
    await tx.query(
      `UPDATE payment_checkouts
          SET provider_subscription_id = $1,
              status = CASE WHEN status = 'pending' THEN 'completed' ELSE status END,
              updated_at = now()
        WHERE id = $2`,
      [info.subscription_id, checkout.id]
    );
  }

  const patch = {
    id: current ? current.id : null,
    user_id: userId,
    plan_id: plan ? plan.id : null,
    provider: 'asaas',
    provider_customer_id: info.customer_id || (current && current.provider_customer_id) || null,
    provider_subscription_id: info.subscription_id || null,
    cancel_at_period_end: Boolean(current && current.cancel_at_period_end),
    payment_method: info.payment_method || (checkout && checkout.payment_method) || null,
  };
  // O evento concede o período de uma compra (e não de uma renovação)? Aí o
  // legado de uma compra de plano antigo em andamento na virada dos níveis
  // acompanha o período — ver oldPlanPurchaseInFlight.
  let compra = false;
  let primeiraCobranca = false;

  switch (event.type) {
    case 'SUBSCRIPTION_CREATED': {
      const trialEnd = checkout && checkout.trial_ends_at ? new Date(checkout.trial_ends_at) : null;
      const trialActive = Boolean(
        checkout &&
        checkout.payment_method === 'credit_card' &&
        trialEnd &&
        trialEnd.getTime() > now.getTime()
      );
      if (current && current.last_payment_at) {
        // Webhooks podem chegar fora de ordem; nunca rebaixe uma cobrança já confirmada.
        patch.status = current.status;
        patch.current_period_start = current.current_period_start;
        patch.current_period_end = current.current_period_end;
        patch.cancel_at_period_end = current.cancel_at_period_end;
      } else {
        patch.status = trialActive ? 'trialing' : 'incomplete';
        patch.current_period_start = trialActive ? now : null;
        patch.current_period_end = trialActive ? trialEnd : null;
        patch.cancel_at_period_end = false;
        compra = trialActive;
        // O teste vale uma vez por aluno, e é aqui que ele de fato começa —
        // não na abertura do checkout, senão quem desistisse antes de pagar
        // perderia o direito sem ter usado.
        if (trialActive) {
          await tx.query('UPDATE users SET trial_used_at = now() WHERE id = $1 AND trial_used_at IS NULL', [userId]);
        }
      }
      break;
    }
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED': {
      // O Asaas emite CONFIRMED e RECEIVED como eventos distintos para a MESMA
      // cobrança: confirmada na hora, recebida quando o dinheiro cai. Os dois
      // caem aqui, e creditar nos dois dobrava o período — quem pagasse uma vez
      // o plano de 12+3 meses ganhava 27. A idempotência por id de evento não
      // pega, porque os eventos são diferentes; a chave certa é a cobrança.
      const paymentId = (info.payment && info.payment.id) || null;
      if (paymentId && current && current.last_payment_id === paymentId) {
        return {
          subscription_id: current.id,
          unchanged: 'cobrança já creditada',
        };
      }
      // Pix é avulso e o CHECKOUT_PAID já concedeu o período, gravando
      // last_payment_id como "checkout:<id>". O PAYMENT_RECEIVED/CONFIRMED que
      // vem depois é a MESMA cobrança, mas com outro id ("pay_<id>"), então a
      // comparação acima não bate e o período era somado de novo — o aluno
      // pagava 6 meses e recebia 12. Quando já há crédito por checkout numa
      // assinatura avulsa, este evento não acrescenta período.
      if (avulso && current && typeof current.last_payment_id === 'string' && current.last_payment_id.startsWith('checkout:')) {
        return {
          subscription_id: current.id,
          unchanged: 'cobrança já creditada pelo checkout',
        };
      }
      const paidAt = (info.payment && info.payment.paid_at) || now;
      const first = !current || !current.last_payment_at;
      // Compra nova de Pix na linha reaproveitada (período anterior acabado) é a
      // primeira cobrança DAQUELA compra: leva o mês de bônus do plano. Sem isso,
      // quando o pagamento chegava antes do CHECKOUT_PAID, a linha já tinha
      // last_payment_at e o evento virava renovação — pagava 13 meses, levava 12.
      const months = asaas.accessMonths(plan, { first: first || newPurchase });
      // renovação antes do fim do período: o acesso é somado ao que ainda resta
      const from = !first && previousEnd && previousEnd.getTime() > paidAt.getTime() ? previousEnd : paidAt;
      patch.status = 'active';
      patch.current_period_start = paidAt;
      patch.current_period_end = asaas.addMonths(from, months);
      patch.last_payment_at = paidAt;
      patch.last_payment_id = paymentId;
      patch.payment_method = (info.payment && info.payment.method) || patch.payment_method;
      // Pix avulso não renova sozinho: o acesso vale o período pago e acaba.
      patch.cancel_at_period_end = avulso;
      compra = first || newPurchase;
      primeiraCobranca = first;
      break;
    }
    case 'PAYMENT_OVERDUE': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      // Uma cobrança pode vencer sem que o período esteja em aberto: tentativa
      // antiga que ficou pendente, ou evento fora de ordem chegando depois do
      // pagamento. Rebaixar sem olhar derrubava aluno que já tinha pago —
      // PAYMENT_DELETED, logo abaixo, sempre respeitou isso.
      if (stillPaid) return { subscription_id: current.id, unchanged: 'período pago em andamento' };
      patch.status = 'past_due';
      break;
    }
    case 'PAYMENT_REFUNDED':
    case 'PAYMENT_PARTIALLY_REFUNDED': {
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.status = 'canceled';
      patch.canceled_at = now;
      patch.current_period_end = now; // devolvido o dinheiro, encerra o acesso
      patch.cancel_at_period_end = false;
      break;
    }
    case 'PAYMENT_CHARGEBACK_REQUESTED':
    case 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL':
    case 'PAYMENT_CHARGEBACK_DISPUTE': {
      // Contestação: o dinheiro volta para o aluno. Manter o acesso seria
      // entregar o produto de graça a quem pediu o estorno — e a contestação
      // costuma ser justamente de quem já usou. Se a disputa for ganha, o
      // pagamento seguinte reabre o acesso normalmente.
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.status = 'canceled';
      patch.canceled_at = now;
      patch.current_period_end = now;
      patch.cancel_at_period_end = false;
      break;
    }
    case 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED': {
      // Cartão recusado na cobrança. Diferente do PAYMENT_OVERDUE, que só
      // chega na data do vencimento: aqui a falha é imediata, e o aluno
      // precisa saber para trocar o cartão antes de perder o acesso.
      //
      // O período já pago é respeitado — quem pagou seis meses e teve a
      // renovação recusada no quinto continua até o fim. O que muda é o
      // status, que a tela usa para avisar.
      if (!current) return { skipped: 'assinatura desconhecida' };
      if (stillPaid) {
        patch.status = current.status;
        patch.cancel_at_period_end = true;
        break;
      }
      patch.status = 'past_due';
      break;
    }
    case 'SUBSCRIPTION_INACTIVATED': {
      // Inativada no provedor: não gera mais cobrança. É o fim mais comum de
      // uma assinatura, e o período pago continua valendo.
      if (!current) return { skipped: 'assinatura desconhecida' };
      patch.canceled_at = now;
      if (stillPaid) {
        patch.status = current.status;
        patch.cancel_at_period_end = true;
      } else {
        patch.status = 'canceled';
        patch.cancel_at_period_end = false;
      }
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
  if (compra && (await oldPlanPurchaseInFlight(tx, { plan, current, checkout, first: primeiraCobranca }))) {
    await extendLegacyToPeriodEnd(tx, row.id);
  }

  // No plano anual promocional, a renovação vem depois dos 3 meses de bônus.
  if (event.type === 'SUBSCRIPTION_CREATED' && info.subscription_id && plan && Number(plan.bonus_months) > 0) {
    const firstChargeAt = info.next_due_date || (checkout && checkout.trial_ends_at) || now;
    const nextDueDate = asaas.toISODate(asaas.addMonths(firstChargeAt, asaas.accessMonths(plan)));
    try {
      await asaas.request('PUT', `/subscriptions/${encodeURIComponent(info.subscription_id)}`, {
        nextDueDate,
        updatePendingPayments: false,
      });
    } catch (err) {
      console.error(`[asaas] não foi possível adiar a renovação de ${info.subscription_id}: ${err.message}`);
    }
  }

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
    const result = event.type.startsWith('CHECKOUT_')
      ? await applyAsaasCheckoutEvent(tx, event)
      : await applyAsaasEvent(tx, event);
    return { ...base, processed: true, duplicate: false, result };
  });
}

/**
 * Processa um evento de webhook do Asaas.
 * @param {{ provider: string, rawBody: Buffer|string, headers: object }} params
 * @returns {Promise<{ provider, event_id, type, processed, duplicate, handled, result? }>}
 */
async function handleWebhook({ provider, rawBody, headers = {} }) {
  const name = normalizeName(provider) || detectProvider(headers);
  if (name === 'asaas') return handleAsaasWebhook({ rawBody, headers });
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
  cancelSubscription,
  createPortal,

  // Exportados para o reprocessamento de eventos já recebidos
  // (scripts/reprocessar-pagamentos.js): um pagamento descartado por um defeito
  // já corrigido precisa poder passar de novo pelo processamento atual.
  applyAsaasEvent,
  applyAsaasCheckoutEvent,
  syncPlan,

  quoteUpgrade,
  createUpgrade,
  pendingUpgrade: upgrade.pendingUpgrade,
  unappliedUpgrades: upgrade.unappliedUpgrades,
  upgradeQuote: upgrade.upgradeQuote,
  applyUpgradeEvent: upgrade.applyUpgradeEvent,

  applySubscription,
  detectProvider,
  handleWebhook,
};

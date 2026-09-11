'use strict';

/**
 * Cliente do Asaas (assinaturas recorrentes em real, com cartão, pix ou boleto).
 *
 *   const asaas = require('./asaas');
 *   asaas.isConfigured();                                  // ASAAS_API_KEY presente?
 *   await asaas.ensureCustomer(user);                      // cria/reaproveita o cliente
 *   await asaas.createCheckout({ user, plan });            // → { url, provider, ... }
 *   await asaas.createPortal(user);                        // → { url|null, invoices }
 *   asaas.parseWebhook({ rawBody, headers });              // valida o token e normaliza o evento
 *
 * Ambiente: https://api.asaas.com/v3 em produção e https://api-sandbox.asaas.com/v3
 * quando ASAAS_ENV=sandbox. Autenticação pelo cabeçalho `access_token`.
 *
 * As credenciais são lidas do ambiente a cada chamada (nunca do banco), de modo que o
 * servidor não precisa reiniciar quando a chave muda e os testes conseguem simular
 * cenários com e sem configuração. O transporte HTTP é injetável (setHttpClient) para
 * que os testes nunca toquem a API real.
 */
const config = require('../../config');
const db = require('../../db/pool');

const API_BASE_PRODUCTION = 'https://api.asaas.com/v3';
const API_BASE_SANDBOX = 'https://api-sandbox.asaas.com/v3';
const CHECKOUT_BASE_URL = 'https://asaas.com/checkoutSession/show';

const NAME = 'asaas';
const LABEL = 'Asaas';

/** Eventos que alteram a assinatura do aluno. Os demais são registrados e ignorados. */
const HANDLED_EVENTS = new Set([
  'CHECKOUT_PAID',
  'CHECKOUT_CANCELED',
  'CHECKOUT_EXPIRED',
  'SUBSCRIPTION_CREATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_REFUNDED',
  'PAYMENT_DELETED',
  'SUBSCRIPTION_DELETED',
]);

/** billingType do Asaas → forma de pagamento gravada em subscriptions.payment_method. */
const PAYMENT_METHODS = {
  CREDIT_CARD: 'credit_card',
  DEBIT_CARD: 'debit_card',
  PIX: 'pix',
  BOLETO: 'boleto',
  TRANSFER: 'transfer',
  DEPOSIT: 'deposit',
};

/** Forma escolhida no site → billingType aceito pelo Checkout Asaas. */
const BILLING_TYPES = {
  credit_card: 'CREDIT_CARD',
  pix: 'PIX',
};

const REQUEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Credenciais e status
// ---------------------------------------------------------------------------
const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Lê ASAAS_API_KEY, ASAAS_ENV e ASAAS_WEBHOOK_TOKEN do ambiente. */
function credentials() {
  const environment = String(process.env.ASAAS_ENV || '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  return {
    apiKey: trimmed(process.env.ASAAS_API_KEY),
    webhookToken: trimmed(process.env.ASAAS_WEBHOOK_TOKEN),
    environment,
  };
}

function isConfigured() {
  return Boolean(credentials().apiKey);
}

function baseUrl() {
  return credentials().environment === 'sandbox' ? API_BASE_SANDBOX : API_BASE_PRODUCTION;
}

/** Mostra apenas os últimos caracteres da chave — o painel nunca vê o valor inteiro. */
function maskKey(key) {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

/** Status para o painel, sem expor segredos. */
function status() {
  const { apiKey, webhookToken, environment } = credentials();
  return {
    provider: NAME,
    label: LABEL,
    configured: Boolean(apiKey),
    environment,
    api_base: baseUrl(),
    key_masked: maskKey(apiKey),
    key_last4: apiKey ? apiKey.slice(-4) : null,
    webhook_configured: Boolean(webhookToken),
    webhook_url: `${config.appUrl}/api/billing/webhook`,
    portal_available: false,
    payment_methods: ['credit_card', 'pix'],
  };
}

/** Erro de provedor: `code` é traduzido em status HTTP pela rota. */
function providerError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.provider = NAME;
  Object.assign(err, extra);
  return err;
}

// ---------------------------------------------------------------------------
// Transporte HTTP
// ---------------------------------------------------------------------------
let httpClient = null;

/** Injeta um cliente HTTP (assinatura de fetch). Passe null para voltar ao fetch nativo. */
function setHttpClient(client) {
  httpClient = typeof client === 'function' ? client : null;
}

function getHttpClient() {
  return httpClient || globalThis.fetch;
}

/** Mensagem legível a partir do corpo de erro do Asaas ({ errors: [{ description }] }). */
function describeError(payload, httpStatus) {
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    const description = payload.errors.map((item) => item && (item.description || item.code)).filter(Boolean).join(' ');
    if (description) return description;
  }
  if (payload && typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 300);
  return `O Asaas respondeu com o código ${httpStatus}.`;
}

/**
 * Chamada autenticada à API do Asaas.
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path caminho a partir da base (ex.: '/subscriptions')
 * @param {object} [body]
 */
async function request(method, path, body) {
  const { apiKey } = credentials();
  if (!apiKey) {
    throw providerError('payments_not_configured', 'Asaas não configurado: defina ASAAS_API_KEY no servidor.');
  }
  const fetchImpl = getHttpClient();
  if (typeof fetchImpl !== 'function') {
    throw providerError('payments_unavailable', 'Este servidor não tem um cliente HTTP disponível para falar com o Asaas.');
  }

  const init = {
    method,
    headers: {
      access_token: apiKey,
      accept: 'application/json',
      'User-Agent': `${config.brandName}/${config.version}`,
    },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  if (controller) init.signal = controller.signal;

  let response;
  try {
    response = await fetchImpl(`${baseUrl()}${path}`, init);
  } catch (err) {
    throw providerError('payments_unavailable', `Não foi possível falar com o Asaas: ${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = typeof response.text === 'function' ? await response.text() : '';
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw providerError('provider_error', describeError(payload, response.status), {
      httpStatus: response.status,
      payload,
    });
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Datas e ciclos
// ---------------------------------------------------------------------------
/** Data em UTC no formato AAAA-MM-DD (o Asaas trabalha com datas sem hora). */
function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return date.toISOString().slice(0, 10);
}

/** Data e hora no formato aceito pelo objeto subscription do Checkout Asaas. */
function toAsaasDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  date.setUTCDate(date.getUTCDate() + Math.round(Number(days) || 0));
  return date;
}

/** Soma meses preservando o dia (31 de janeiro + 1 mês = 28/29 de fevereiro). */
function addMonths(value, months) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  const count = Math.round(Number(months) || 0);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1, 12, 0, 0));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
  return target;
}

/** Ciclo de cobrança do Asaas a partir da duração do plano em meses. */
function cycleFor(durationMonths) {
  const months = Math.max(1, Math.round(Number(durationMonths) || 1));
  if (months >= 12) return 'YEARLY';
  if (months >= 6) return 'SEMIANNUALLY';
  if (months >= 3) return 'QUARTERLY';
  if (months >= 2) return 'BIMONTHLY';
  return 'MONTHLY';
}

const durationOf = (plan) => Math.max(1, Math.round(Number(plan && plan.duration_months) || 1));
const bonusOf = (plan) => Math.max(0, Math.round(Number(plan && plan.bonus_months) || 0));

/**
 * Meses de acesso liberados por um pagamento.
 * O bônus ("pague 12, ganhe 15") só vale na primeira cobrança.
 */
function accessMonths(plan, { first = true } = {}) {
  return durationOf(plan) + (first ? bonusOf(plan) : 0);
}

/**
 * Calendário de cobrança do plano.
 * A primeira cobrança vence hoje; a seguinte só acontece depois de todo o período de
 * acesso (duração + bônus), para que o aluno pague 12 meses e fique 15 com acesso.
 * @returns {{ cycle: string, first_due_date: string, next_due_date: string, duration_months: number, bonus_months: number, access_months: number }}
 */
function planSchedule(plan, from = new Date()) {
  const duration = durationOf(plan);
  const bonus = bonusOf(plan);
  const start = from instanceof Date ? from : new Date(from);
  return {
    cycle: cycleFor(duration),
    first_due_date: toISODate(start),
    next_due_date: toISODate(addMonths(start, duration + bonus)),
    duration_months: duration,
    bonus_months: bonus,
    access_months: duration + bonus,
  };
}

// ---------------------------------------------------------------------------
// Cliente (customer)
// ---------------------------------------------------------------------------
/** Só dígitos: o Asaas recusa CPF/CNPJ com pontuação. */
const onlyDigits = (value) => (typeof value === 'string' ? value.replace(/\D+/g, '') : '');

/** Busca um cliente já criado para este usuário (externalReference = id do usuário). */
async function findCustomerByUser(userId) {
  const data = await request('GET', `/customers?externalReference=${encodeURIComponent(userId)}&limit=1`);
  const list = data && Array.isArray(data.data) ? data.data : [];
  return list[0] || null;
}

/**
 * Garante um cliente no Asaas para o aluno e grava users.provider_customer_id.
 * @returns {Promise<string>} id do cliente
 */
async function ensureCustomer(user) {
  if (!user || !user.id) throw new Error('ensureCustomer exige um usuário.');
  const row = await db.one('SELECT id, name, email, tax_id, provider_customer_id FROM users WHERE id = $1', [user.id]);
  if (!row) throw providerError('not_found', 'Usuário não encontrado.');
  if (row.provider_customer_id) return row.provider_customer_id;

  let customer = await findCustomerByUser(row.id);
  if (!customer) {
    const payload = {
      name: row.name,
      email: row.email,
      externalReference: row.id,
      notificationDisabled: false,
    };
    const taxId = onlyDigits(row.tax_id);
    if (taxId) payload.cpfCnpj = taxId;
    customer = await request('POST', '/customers', payload);
  }
  if (!customer || !customer.id) {
    throw providerError('provider_error', 'O Asaas não devolveu o identificador do cliente.');
  }

  await db.query('UPDATE users SET provider_customer_id = $1 WHERE id = $2 AND provider_customer_id IS NULL', [
    customer.id,
    row.id,
  ]);
  // outra requisição pode ter gravado antes: prevalece o que está no banco
  const saved = await db.one('SELECT provider_customer_id FROM users WHERE id = $1', [row.id]);
  return (saved && saved.provider_customer_id) || customer.id;
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------
function subscriptionDescription(plan) {
  const months = accessMonths(plan);
  const period = months === 1 ? '1 mês' : `${months} meses`;
  return `${config.brandName} — ${plan.name} (${period} de acesso)`;
}

/** Referência externa: liga o evento do webhook ao aluno e ao plano. */
const buildReference = (userId, planId) => `${userId}:${planId}`;

/** Lê a referência externa gravada na assinatura/cobrança. */
function parseReference(value) {
  if (typeof value !== 'string') return { user_id: null, plan_id: null };
  const [userId, planId] = value.split(':');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    user_id: uuid.test(userId || '') ? userId : null,
    plan_id: uuid.test(planId || '') ? planId : null,
  };
}

/** Cria uma assinatura recorrente diretamente, usado em rotinas administrativas. */
async function createSubscription({ user, plan, customerId, paymentMethod = 'pix', from = new Date() }) {
  const billingType = BILLING_TYPES[paymentMethod];
  if (!billingType) throw providerError('unsupported_payment_method', 'Escolha cartão de crédito ou Pix.');
  const schedule = planSchedule(plan, from);
  const created = await request('POST', '/subscriptions', {
    customer: customerId,
    billingType,
    value: Number(plan.price_cents || 0) / 100,
    nextDueDate: schedule.first_due_date,
    cycle: schedule.cycle,
    description: subscriptionDescription(plan),
    externalReference: buildReference(user.id, plan.id),
  });
  if (!created || !created.id) {
    throw providerError('provider_error', 'O Asaas não devolveu o identificador da assinatura.');
  }

  // Com bônus, a próxima cobrança só entra depois de todo o período de acesso.
  // A cobrança já emitida (vencendo hoje) não é alterada.
  if (schedule.bonus_months > 0) {
    try {
      await request('PUT', `/subscriptions/${encodeURIComponent(created.id)}`, {
        nextDueDate: schedule.next_due_date,
        updatePendingPayments: false,
      });
    } catch (err) {
      // O checkout continua válido; só a data da renovação precisará de ajuste manual.
      console.error(`[asaas] não foi possível adiar a renovação de ${created.id}: ${err.message}`);
    }
  }

  return { subscription: created, schedule };
}

/** Link de pagamento da primeira cobrança (é para lá que o aluno é levado). */
async function firstPaymentUrl(subscriptionId) {
  const data = await request('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=10`);
  const list = data && Array.isArray(data.data) ? data.data : [];
  const pending = list.find((item) => item && item.invoiceUrl && item.status !== 'RECEIVED' && item.status !== 'CONFIRMED');
  const chosen = pending || list.find((item) => item && item.invoiceUrl) || null;
  return chosen ? chosen.invoiceUrl || chosen.bankSlipUrl || null : null;
}

function trialDaysFor(plan, paymentMethod) {
  if (paymentMethod !== 'credit_card') return 0;
  const duration = durationOf(plan);
  const enabled = Math.round(Number(plan && plan.trial_days) || 0) > 0;
  return enabled && (duration === 6 || duration === 12) ? 1 : 0;
}

function checkoutUrl(checkout) {
  if (checkout && typeof checkout.link === 'string' && checkout.link.trim()) return checkout.link.trim();
  if (!checkout || !checkout.id) return null;
  return `${CHECKOUT_BASE_URL}?id=${encodeURIComponent(checkout.id)}`;
}

/**
 * Dados do aluno que já temos, para o checkout hospedado chegar preenchido.
 * Lê do banco porque o CPF costuma ser gravado na mesma requisição que abre o
 * checkout, e o objeto em memória ainda não o tem.
 */
async function customerDataFor(user) {
  const row =
    (await db.one('SELECT name, email, tax_id, provider_customer_id FROM users WHERE id = $1', [user.id])) || user;
  const data = {
    name: trimmed(row.name) || undefined,
    email: trimmed(row.email) || undefined,
  };
  const taxId = onlyDigits(row.tax_id);
  if (taxId) data.cpfCnpj = taxId;
  return data;
}

/**
 * Cria o Checkout hospedado do Asaas. Assim o cartão nunca passa pelo nosso servidor:
 * o próprio Asaas coleta e valida os dados antes de criar a assinatura.
 */
async function createCheckout({ user, plan, paymentMethod = 'credit_card', successUrl, cancelUrl }) {
  if (!user || !plan) throw new Error('createCheckout exige usuário e plano.');
  const billingType = BILLING_TYPES[paymentMethod];
  if (!billingType) throw providerError('unsupported_payment_method', 'Escolha cartão de crédito ou Pix.');

  const now = new Date();
  const trialDays = trialDaysFor(plan, paymentMethod);
  const firstChargeAt = trialDays > 0 ? addDays(now, trialDays) : now;
  const schedule = planSchedule(plan, firstChargeAt);
  const reference = buildReference(user.id, plan.id);

  // O Asaas só faz assinatura recorrente no cartão: "o método de pagamento
  // CREDIT_CARD é o único permitido para operações RECURRENT", e Pix exige
  // cobrança avulsa (DETACHED). Por isso o Pix aqui é pagamento único do
  // período contratado — o aluno paga os 6 ou 15 meses de uma vez e não
  // renova sozinho. Mandar `subscription` junto com Pix faz o Asaas recusar
  // o checkout inteiro.
  const recorrente = billingType === 'CREDIT_CARD';
  const created = await request('POST', '/checkouts', {
    billingTypes: [billingType],
    chargeTypes: [recorrente ? 'RECURRENT' : 'DETACHED'],
    minutesToExpire: 60,
    externalReference: reference,
    callback: {
      successUrl,
      cancelUrl,
      expiredUrl: cancelUrl,
    },
    items: [
      {
        name: plan.name,
        description: subscriptionDescription(plan),
        quantity: 1,
        value: Number(plan.price_cents || 0) / 100,
      },
    ],
    // `customerData` em vez de `customer`: os dois são mutuamente exclusivos, e
    // passar um cliente já cadastrado obriga que ele esteja COMPLETO no Asaas —
    // CPF, telefone e endereço inteiro. Um aluno que só fez cadastro com nome e
    // e-mail derrubava o checkout com "o campo cpfCnpj deve existir para o
    // customer informado". Todos os subcampos de customerData são opcionais: o
    // que faltar, o próprio checkout hospedado coleta do aluno na tela, que é
    // justamente para isso que ele existe. O que já sabemos vai preenchido.
    customerData: await customerDataFor(user),
    ...(recorrente
      ? {
          subscription: {
            cycle: schedule.cycle,
            nextDueDate: toAsaasDateTime(firstChargeAt),
          },
        }
      : {}),
  });
  const url = checkoutUrl(created);
  if (!url) {
    throw providerError('provider_error', 'O Asaas não devolveu o identificador do checkout. Tente novamente em instantes.');
  }

  await db.query(
    `INSERT INTO payment_checkouts (
       provider, provider_checkout_id, user_id, plan_id, payment_method, status, trial_ends_at
     ) VALUES ('asaas', $1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (provider, provider_checkout_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       plan_id = EXCLUDED.plan_id,
       payment_method = EXCLUDED.payment_method,
       trial_ends_at = EXCLUDED.trial_ends_at,
       updated_at = now()`,
    [created.id, user.id, plan.id, paymentMethod, trialDays > 0 ? firstChargeAt : null]
  );

  return {
    url,
    provider: NAME,
    // O cliente no Asaas nasce quando o aluno preenche o checkout, então aqui
    // só existe id se ele já tiver pago alguma vez antes.
    customer_id: idOf(created.customer) || null,
    checkout_id: created.id,
    payment_method: paymentMethod,
    trial_ends_at: trialDays > 0 ? firstChargeAt : null,
    schedule,
  };
}

/** Cancela a assinatura no Asaas. */
async function cancelSubscription(subscriptionId) {
  return request('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

const centsOf = (value) => Math.round(Number(value || 0) * 100);

/** Faturas do cliente, da mais recente para a mais antiga. */
async function listInvoices(customerId, { limit = 12 } = {}) {
  if (!customerId) return [];
  const data = await request(
    'GET',
    `/payments?customer=${encodeURIComponent(customerId)}&limit=${Math.max(1, Math.min(50, limit))}&order=desc&sort=dueDate`
  );
  const list = data && Array.isArray(data.data) ? data.data : [];
  return list.map((item) => ({
    id: item.id,
    status: item.status,
    value_cents: centsOf(item.value),
    due_date: item.dueDate || null,
    paid_at: item.paymentDate || item.confirmedDate || null,
    payment_method: PAYMENT_METHODS[item.billingType] || null,
    invoice_url: item.invoiceUrl || item.bankSlipUrl || null,
  }));
}

/**
 * O Asaas não tem portal do assinante. Devolve a fatura em aberto (quando existe)
 * e a lista de faturas, para que a tela de assinatura mostre a situação ao aluno.
 */
async function createPortal(user) {
  const row = await db.one('SELECT provider_customer_id FROM users WHERE id = $1', [user.id]);
  const customerId = row && row.provider_customer_id;
  if (!customerId) {
    return { url: null, provider: NAME, invoices: [], message: 'Ainda não há faturas para este cadastro.' };
  }
  const invoices = await listInvoices(customerId);
  const open = invoices.find((item) => item.invoice_url && item.status !== 'RECEIVED' && item.status !== 'CONFIRMED');
  return {
    url: open ? open.invoice_url : null,
    provider: NAME,
    invoices,
    message: open
      ? 'Abrindo a fatura em aberto.'
      : 'O Asaas não tem portal do assinante: para trocar de plano ou cancelar, fale com o suporte.',
  };
}

/**
 * O Asaas não mantém catálogo de planos: o valor e o ciclo vão em cada assinatura.
 * Não há nada a sincronizar — a função existe para a camada única (payments/index.js).
 */
async function syncPlan(plan) {
  return {
    plan,
    provider: NAME,
    synced: false,
    message: 'O Asaas não exige cadastro prévio de planos: o valor e o ciclo são enviados em cada assinatura.',
  };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
/** Compara o token do cabeçalho `asaas-access-token` com ASAAS_WEBHOOK_TOKEN. */
function verifyWebhookToken(headers = {}) {
  const { webhookToken } = credentials();
  if (!webhookToken) {
    throw providerError('payments_not_configured', 'Webhook do Asaas não configurado: defina ASAAS_WEBHOOK_TOKEN no servidor.');
  }
  const received = headers['asaas-access-token'] || headers['Asaas-Access-Token'] || null;
  if (!received || String(received) !== webhookToken) {
    throw providerError('webhook_invalid_token', 'Token do webhook inválido.');
  }
  return true;
}

/**
 * Valida o token, lê o corpo cru e devolve o evento no formato comum.
 * @returns {{ provider: string, event_id: string, type: string, payload: object }}
 */
function parseWebhook({ rawBody, headers = {} }) {
  verifyWebhookToken(headers);

  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : typeof rawBody === 'string' ? rawBody : '';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw providerError('webhook_invalid_payload', 'Corpo do webhook não é um JSON válido.');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') {
    throw providerError('webhook_invalid_payload', 'Corpo do webhook não tem o campo "event".');
  }

  const target = payload.payment || payload.subscription || payload.checkout || {};
  const eventId = trimmed(payload.id) || `${payload.event}:${target.id || 'sem-id'}`;
  return { provider: NAME, event_id: eventId, type: payload.event, payload };
}

const parseDate = (value) => {
  if (!value) return null;
  // datas sem hora ('2026-01-15') chegam como meio-dia UTC para não mudar de dia por fuso
  const text = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00.000Z` : String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
};

const idOf = (value) => (value && typeof value === 'object' ? value.id : value) || null;

/**
 * Traduz o corpo do webhook para os dados que a camada de pagamentos precisa.
 * @returns {{ type: string, subscription_id: string|null, customer_id: string|null, external_reference: string|null, payment: object|null }}
 */
function normalizeEvent(payload) {
  const payment = payload && payload.payment ? payload.payment : null;
  const subscription = payload && payload.subscription ? payload.subscription : null;
  const checkout = payload && payload.checkout ? payload.checkout : null;
  const source = payment || subscription || checkout || {};
  const billingTypes = checkout && Array.isArray(checkout.billingTypes) ? checkout.billingTypes : [];
  const subscriptionRules = checkout && checkout.subscription ? checkout.subscription : null;

  return {
    type: payload && payload.event,
    subscription_id: payment ? idOf(payment.subscription) : idOf(subscription),
    checkout_id: idOf(checkout),
    customer_id: idOf(source.customer),
    external_reference: trimmed(source.externalReference) || trimmed(subscription && subscription.externalReference),
    payment_method:
      (payment && PAYMENT_METHODS[payment.billingType]) ||
      (subscription && PAYMENT_METHODS[subscription.billingType]) ||
      PAYMENT_METHODS[billingTypes[0]] ||
      null,
    next_due_date: parseDate(
      (subscription && subscription.nextDueDate) || (subscriptionRules && subscriptionRules.nextDueDate)
    ),
    payment: payment
      ? {
          id: payment.id || null,
          value_cents: centsOf(payment.value),
          status: payment.status || null,
          method: PAYMENT_METHODS[payment.billingType] || null,
          due_date: parseDate(payment.dueDate),
          paid_at: parseDate(payment.paymentDate || payment.confirmedDate || payment.clientPaymentDate),
          invoice_url: payment.invoiceUrl || payment.bankSlipUrl || null,
        }
      : null,
  };
}

module.exports = {
  name: NAME,
  label: LABEL,
  HANDLED_EVENTS,
  PAYMENT_METHODS,
  BILLING_TYPES,
  API_BASE_PRODUCTION,
  API_BASE_SANDBOX,
  CHECKOUT_BASE_URL,

  credentials,
  isConfigured,
  baseUrl,
  status,
  setHttpClient,
  request,

  toISODate,
  toAsaasDateTime,
  addDays,
  addMonths,
  cycleFor,
  accessMonths,
  planSchedule,
  parseReference,

  ensureCustomer,
  findCustomerByUser,
  createSubscription,
  firstPaymentUrl,
  trialDaysFor,
  checkoutUrl,
  createCheckout,
  cancelSubscription,
  listInvoices,
  createPortal,
  syncPlan,

  verifyWebhookToken,
  parseWebhook,
  normalizeEvent,
};

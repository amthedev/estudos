'use strict';

/**
 * Asaas falso para os testes de pagamento.
 *
 *   const fake = require('./asaas-fake');
 *   const api = fake.fakeAsaasApi([...fake.defaultRoutes(), { method: 'POST', match: /^\/payments$/, body: {...} }]);
 *   asaas.setHttpClient(api.client);
 *   api.find('PUT', /^\/subscriptions\/sub_000001$/).body;   // o que foi enviado
 *   await fake.sendWebhook(ctx, fake.paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_1', reference }));
 *
 * Nenhum teste toca a API real: o transporte HTTP do Asaas é injetado. Os
 * formatos são os mesmos de tests/payments.test.js, que nasceu com eles.
 */

const WEBHOOK_TOKEN = 'token-de-webhook-do-asaas';
const PAYMENT_ENV_KEYS = ['ASAAS_API_KEY', 'ASAAS_ENV', 'ASAAS_WEBHOOK_TOKEN', 'PAYMENT_PROVIDER'];

/** Guarda as variáveis de ambiente de pagamento e devolve a função que as restaura. */
function snapshotEnv() {
  const saved = {};
  for (const key of PAYMENT_ENV_KEYS) saved[key] = process.env[key];
  return () => {
    for (const key of PAYMENT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

function clearPaymentEnv() {
  for (const key of PAYMENT_ENV_KEYS) delete process.env[key];
}

/** Liga o Asaas de teste: chave de sandbox e token do webhook. */
function configureAsaasEnv() {
  clearPaymentEnv();
  process.env.ASAAS_API_KEY = '$aact_chave_de_teste_1234';
  process.env.ASAAS_ENV = 'sandbox';
  process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
}

const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (data === undefined ? '' : JSON.stringify(data)),
});

/**
 * Cliente HTTP que responde pelas rotas dadas e grava cada chamada.
 * @param {Array<{ method: string, match: RegExp, body: object|Function, status?: number }>} routes
 */
function fakeAsaasApi(routes) {
  const calls = [];
  const client = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https?:\/\/[^/]+(?:\/api)?\/v3/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, token: init.headers && init.headers.access_token });

    const route = routes.find((item) => item.method === method && item.match.test(path));
    if (!route) {
      return jsonResponse(404, { errors: [{ description: `rota não simulada: ${method} ${path}` }] });
    }
    const payload = typeof route.body === 'function' ? route.body(body, path) : route.body;
    return jsonResponse(route.status || 200, payload);
  };
  return {
    calls,
    client,
    find: (method, re) => calls.find((c) => c.method === method && re.test(c.path)),
    filter: (method, re) => calls.filter((c) => c.method === method && re.test(c.path)),
  };
}

const defaultRoutes = () => [
  { method: 'GET', match: /^\/customers\?/, body: { data: [], totalCount: 0 } },
  { method: 'POST', match: /^\/customers$/, body: { id: 'cus_000001', object: 'customer' } },
  { method: 'POST', match: /^\/checkouts$/, body: { id: 'checkout_000001' } },
  {
    method: 'POST',
    match: /^\/subscriptions$/,
    body: (sent) => ({ id: 'sub_000001', object: 'subscription', cycle: sent.cycle, nextDueDate: sent.nextDueDate }),
  },
  { method: 'PUT', match: /^\/subscriptions\/sub_000001$/, body: { id: 'sub_000001', object: 'subscription' } },
  { method: 'DELETE', match: /^\/subscriptions\/sub_000001$/, body: { deleted: true, id: 'sub_000001' } },
];

/** Corpo de webhook do Asaas para um evento de cobrança. */
function paymentEvent(type, { id, reference, subscription = 'sub_000001', customer = 'cus_000001', overrides = {} }) {
  return {
    id,
    event: type,
    dateCreated: '2026-03-10 09:00:00',
    payment: {
      object: 'payment',
      id: 'pay_000001',
      customer,
      subscription,
      value: 359.9,
      billingType: 'PIX',
      status: 'CONFIRMED',
      dueDate: '2026-03-10',
      paymentDate: '2026-03-10',
      confirmedDate: '2026-03-10',
      externalReference: reference,
      invoiceUrl: 'https://sandbox.asaas.com/i/pay_000001',
      ...overrides,
    },
  };
}

function subscriptionEvent(type, { id, reference = null, customer = 'cus_000001', overrides = {} }) {
  return {
    id,
    event: type,
    dateCreated: '2026-03-10 09:00:00',
    subscription: {
      object: 'subscription',
      id: 'sub_000001',
      customer,
      value: 359.9,
      nextDueDate: '2026-03-11',
      cycle: 'YEARLY',
      billingType: 'CREDIT_CARD',
      status: 'ACTIVE',
      externalReference: reference,
      ...overrides,
    },
  };
}

/** Entrega o evento ao webhook de verdade, com o token certo (ou o que for passado). */
function sendWebhook(ctx, payload, { token = WEBHOOK_TOKEN } = {}) {
  return ctx.request('POST', '/api/billing/webhook', {
    raw: true,
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', 'asaas-access-token': token },
  });
}

module.exports = {
  WEBHOOK_TOKEN,
  snapshotEnv,
  clearPaymentEnv,
  configureAsaasEnv,
  jsonResponse,
  fakeAsaasApi,
  defaultRoutes,
  paymentEvent,
  subscriptionEvent,
  sendWebhook,
};

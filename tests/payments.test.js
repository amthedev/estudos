'use strict';

/**
 * Pagamentos e assinaturas pelo Asaas.
 *
 *   NODE_ENV=test node --test tests/payments.test.js
 *
 * Cobre o que não pode quebrar: sem chave nenhuma o checkout responde 503 e o status diz
 * que não há provedor; o webhook recusa token inválido; um pagamento confirmado cria a
 * assinatura, soma o bônus de meses e libera o acesso; o mesmo evento reprocessado não
 * duplica nada; o cancelamento marca a assinatura; e os planos públicos nunca expõem
 * identificadores do provedor de pagamento.
 *
 * Nenhum teste toca a API real: o transporte HTTP do Asaas é injetado (setHttpClient).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const payments = require('../server/services/payments');
const asaas = require('../server/services/payments/asaas');

const WEBHOOK_TOKEN = 'token-de-webhook-do-asaas';
const PAYMENT_ENV_KEYS = ['ASAAS_API_KEY', 'ASAAS_ENV', 'ASAAS_WEBHOOK_TOKEN', 'PAYMENT_PROVIDER'];

/** Guarda e restaura as variáveis de ambiente de pagamento. */
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

// ---------------------------------------------------------------------------
// Cliente HTTP falso do Asaas
// ---------------------------------------------------------------------------
const jsonResponse = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (data === undefined ? '' : JSON.stringify(data)),
});

/**
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
  return { calls, client, find: (method, re) => calls.find((c) => c.method === method && re.test(c.path)) };
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
  {
    method: 'GET',
    match: /^\/subscriptions\/sub_000001\/payments/,
    body: {
      data: [{ id: 'pay_000001', status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/pay_000001' }],
    },
  },
  {
    method: 'GET',
    match: /^\/payments\?/,
    body: {
      data: [
        {
          id: 'pay_000001',
          status: 'CONFIRMED',
          value: 359.9,
          dueDate: '2026-03-10',
          paymentDate: '2026-03-10',
          billingType: 'PIX',
          invoiceUrl: 'https://sandbox.asaas.com/i/pay_000001',
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------
async function seedPlans(db) {
  const monthly = await db.one(
    `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count,
                        duration_months, bonus_months, trial_days, features, highlight, active, sort_order)
     VALUES ('mensal', 'Mensal', 'Acesso completo mês a mês', 4490, 'brl', 'month', 1, 1, 0, 0,
             '["Aulas","Simulados"]', false, true, 1)
     RETURNING id`
  );
  const sixMonths = await db.one(
    `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count,
                        duration_months, bonus_months, trial_days, features, highlight, active, sort_order)
     VALUES ('seis-meses', '6 meses', 'Acesso completo por seis meses', 21990, 'brl', 'month', 6, 6, 0, 1,
             '["Tudo do mensal"]', false, true, 2)
     RETURNING id`
  );
  const yearly = await db.one(
    `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count,
                        duration_months, bonus_months, trial_days, compare_price_cents, badge,
                        stripe_product_id, stripe_price_id, provider_plan_id,
                        features, highlight, active, sort_order)
     VALUES ('15-meses', '15 meses', 'Pague 12, estude 15', 35990, 'brl', 'year', 1, 12, 3, 1, 53880, 'MELHOR OFERTA',
             'prod_secreto', 'price_secreto', 'asaas_secreto',
             '["Tudo do mensal","3 meses de bônus"]', true, true, 3)
     RETURNING id`
  );
  return { monthly: monthly.id, sixMonths: sixMonths.id, yearly: yearly.id };
}

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

function checkoutEvent(type, { id, checkout = 'checkout_000001', customer = 'cus_000001', reference = null, pix = false }) {
  return {
    id,
    event: type,
    dateCreated: '2026-03-10 09:00:00',
    checkout: {
      id: checkout,
      customer,
      externalReference: reference,
      status: type === 'CHECKOUT_PAID' ? 'PAID' : type.replace('CHECKOUT_', ''),
      billingTypes: [pix ? 'PIX' : 'CREDIT_CARD'],
      chargeTypes: [pix ? 'DETACHED' : 'RECURRENT'],
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

describe('Pagamentos: Asaas, checkout e webhooks', () => {
  let ctx;
  let restoreEnv;

  before(async () => {
    ctx = await createTestContext();
    restoreEnv = snapshotEnv();
  });

  after(async () => {
    asaas.setHttpClient(null);
    restoreEnv();
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  describe('cálculo de datas e ciclos', () => {
    it('deriva o ciclo do Asaas a partir da duração do plano', () => {
      assert.equal(asaas.cycleFor(1), 'MONTHLY');
      assert.equal(asaas.cycleFor(6), 'SEMIANNUALLY');
      assert.equal(asaas.cycleFor(12), 'YEARLY');
      assert.equal(asaas.cycleFor(15), 'YEARLY');
    });

    it('soma o bônus na data da próxima cobrança do plano de 15 meses', () => {
      const plan = { duration_months: 12, bonus_months: 3 };
      const schedule = asaas.planSchedule(plan, new Date('2026-01-15T09:00:00.000Z'));
      assert.equal(schedule.cycle, 'YEARLY');
      assert.equal(schedule.first_due_date, '2026-01-15');
      assert.equal(schedule.next_due_date, '2027-04-15');
      assert.equal(schedule.access_months, 15);
      assert.equal(asaas.accessMonths(plan, { first: true }), 15);
      // o bônus vale uma única vez: a renovação libera só os meses pagos
      assert.equal(asaas.accessMonths(plan, { first: false }), 12);
    });

    it('não estoura o fim do mês ao somar meses', () => {
      assert.equal(asaas.toISODate(asaas.addMonths(new Date('2026-01-31T12:00:00.000Z'), 1)), '2026-02-28');
    });

    it('limita as 24 horas grátis ao cartão dos planos de 6 e 12 meses', async () => {
      // Sem aluno informado não há teste: a regra depende de quem está pedindo,
      // porque cada aluno tem direito a um só.
      const semAluno = { id: null };
      assert.equal(await asaas.trialDaysFor({ duration_months: 1, trial_days: 1 }, 'credit_card', semAluno), 0);
      assert.equal(await asaas.trialDaysFor({ duration_months: 6, trial_days: 1 }, 'pix', semAluno), 0);
      assert.equal(await asaas.trialDaysFor({ duration_months: 6, trial_days: 0 }, 'credit_card', semAluno), 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('sem provedor configurado', () => {
    let student;

    before(async () => {
      await ctx.resetDb();
      clearPaymentEnv();
      await seedPlans(ctx.db);
      student = await ctx.registerStudent();
    });

    it('o status informa que o Asaas ainda não está configurado', async () => {
      const res = await student.agent.get('/api/billing/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.payment_provider, 'asaas');
      assert.equal(res.body.payments_configured, false);
      assert.equal(res.body.portal_available, false);
    });

    it('o checkout responde 503 com mensagem em português', async () => {
      const plans = await ctx.request('GET', '/api/billing/plans');
      const res = await student.agent.post('/api/billing/checkout', { plan_id: plans.body[0].id });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'payments_unavailable');
      assert.match(res.body.error.message, /provedor de pagamento/i);
    });

    it('o portal também responde 503', async () => {
      const res = await student.agent.post('/api/billing/portal', {});
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'payments_unavailable');
    });
  });

  // -------------------------------------------------------------------------
  describe('planos públicos', () => {
    before(async () => {
      await ctx.resetDb();
      clearPaymentEnv();
      await seedPlans(ctx.db);
    });

    it('devolve duração, bônus, equivalente mensal e economia', async () => {
      const res = await ctx.request('GET', '/api/billing/plans');
      assert.equal(res.status, 200);
      const yearly = res.body.find((plan) => plan.slug === '15-meses');
      assert.ok(yearly, 'o plano de 15 meses precisa aparecer na vitrine');
      assert.equal(yearly.duration_months, 12);
      assert.equal(yearly.bonus_months, 3);
      assert.equal(yearly.access_months, 15);
      assert.equal(yearly.badge, 'MELHOR OFERTA');
      assert.equal(yearly.compare_price_cents, 53880);
      assert.equal(yearly.monthly_equivalent_cents, Math.round(35990 / 15));
      assert.equal(yearly.savings_cents, 53880 - 35990);
    });

    it('omite economia e equivalente mensal quando o dado não existe no banco', async () => {
      const res = await ctx.request('GET', '/api/billing/plans');
      const monthly = res.body.find((plan) => plan.slug === 'mensal');
      assert.equal(monthly.compare_price_cents, null);
      assert.equal(monthly.savings_cents, null);
      assert.equal(monthly.monthly_equivalent_cents, null);
    });

    it('nunca expõe identificadores do provedor de pagamento', async () => {
      const res = await ctx.request('GET', '/api/billing/plans');
      for (const plan of res.body) {
        assert.equal(plan.stripe_product_id, undefined);
        assert.equal(plan.stripe_price_id, undefined);
        assert.equal(plan.provider_plan_id, undefined);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('checkout no Asaas', () => {
    let student;
    let plans;
    let api;

    beforeEach(async () => {
      await ctx.resetDb();
      clearPaymentEnv();
      process.env.ASAAS_API_KEY = '$aact_chave_de_teste_1234';
      process.env.ASAAS_ENV = 'sandbox';
      plans = await seedPlans(ctx.db);
      student = await ctx.registerStudent();
      api = fakeAsaasApi(defaultRoutes());
      asaas.setHttpClient(api.client);
    });

    after(() => {
      asaas.setHttpClient(null);
    });

    it('o Asaas vira o provedor ativo assim que a chave existe', async () => {
      assert.equal(await payments.getProvider(), 'asaas');
      const status = await payments.status();
      assert.equal(status.provider, 'asaas');
      assert.equal(status.configured, true);
      assert.equal(status.environment, 'sandbox');
      assert.match(status.key_masked, /^••••/);
      assert.equal(status.key_masked.includes('aact'), false);
      assert.match(status.webhook_url, /\/api\/billing\/webhook$/);
      assert.deepEqual(status.payment_methods, ['credit_card', 'pix']);
    });

    it('cartão no plano anual cadastra o checkout com 24 horas grátis', async () => {
      const before = Date.now();
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
        tax_id: '390.533.447-05',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.provider, 'asaas');
      assert.equal(res.body.payment_method, 'credit_card');
      assert.equal(res.body.url, 'https://asaas.com/checkoutSession/show?id=checkout_000001');
      const trialEndsAt = new Date(res.body.trial_ends_at).getTime();
      assert.ok(trialEndsAt - before >= 23.99 * 60 * 60 * 1000);
      assert.ok(trialEndsAt - before <= 24.01 * 60 * 60 * 1000);

      // O cliente não é mais criado antes: passar um `customer` já cadastrado
      // obriga que ele esteja completo no Asaas (CPF, telefone e endereço), e
      // um aluno recém-cadastrado derrubava o checkout. Vai `customerData` com
      // o que já sabemos, e o checkout hospedado coleta o resto.
      assert.equal(api.find('POST', /^\/customers$/), undefined, 'não cria cliente antes do checkout');

      const checkout = api.find('POST', /^\/checkouts$/);
      assert.deepEqual(checkout.body.billingTypes, ['CREDIT_CARD']);
      assert.deepEqual(checkout.body.chargeTypes, ['RECURRENT']);
      // Nem `customer` nem `customerData`: o Asaas exige cadastro completo em
      // qualquer um dos dois, e a plataforma só tem nome e e-mail. Quem pede
      // CPF, telefone e endereço ao aluno é o checkout hospedado.
      assert.equal(checkout.body.customer, undefined);
      assert.equal(checkout.body.customerData, undefined);
      assert.equal(checkout.body.subscription.cycle, 'YEARLY');
      assert.equal(checkout.body.items[0].value, 359.9);
      assert.equal(checkout.body.externalReference, `${student.user.id}:${plans.yearly}`);
      const firstChargeAt = new Date(`${checkout.body.subscription.nextDueDate.replace(' ', 'T')}Z`).getTime();
      assert.ok(firstChargeAt - before >= 23.99 * 60 * 60 * 1000);

      const savedCheckout = await ctx.db.one('SELECT * FROM payment_checkouts WHERE user_id = $1', [student.user.id]);
      assert.equal(savedCheckout.provider_checkout_id, 'checkout_000001');
      assert.equal(savedCheckout.payment_method, 'credit_card');
      assert.equal(savedCheckout.status, 'pending');
      assert.ok(savedCheckout.trial_ends_at);

      // O cliente no Asaas passa a existir quando o aluno conclui o checkout,
      // então o id só é gravado a partir do webhook do pagamento.
      const user = await ctx.db.one('SELECT provider_customer_id, tax_id FROM users WHERE id = $1', [student.user.id]);
      assert.equal(user.tax_id, '39053344705');
    });

    it('Pix vai como cobrança avulsa, sem assinatura e sem teste', async () => {
      // O Asaas recusa Pix recorrente: "o método de pagamento CREDIT_CARD é o
      // único permitido para operações RECURRENT" e "o tipo de cobrança
      // DETACHED é obrigatório para o método de pagamento PIX". Mandar o campo
      // `subscription` junto derruba o checkout inteiro — foi o erro que
      // apareceu em produção.
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.sixMonths,
        payment_method: 'pix',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.payment_method, 'pix');
      assert.equal(res.body.trial_ends_at, null);

      const checkout = api.find('POST', /^\/checkouts$/);
      assert.deepEqual(checkout.body.billingTypes, ['PIX']);
      assert.deepEqual(checkout.body.chargeTypes, ['DETACHED']);
      assert.equal(checkout.body.subscription, undefined, 'Pix não pode levar o campo subscription');
      assert.equal(checkout.body.items[0].value, 219.9, 'cobra o período inteiro de uma vez');

      const savedCheckout = await ctx.db.one('SELECT payment_method, trial_ends_at FROM payment_checkouts WHERE user_id = $1', [student.user.id]);
      assert.equal(savedCheckout.payment_method, 'pix');
      assert.equal(savedCheckout.trial_ends_at, null);
    });

    it('cartão continua como assinatura recorrente', async () => {
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.sixMonths,
        payment_method: 'credit_card',
      });
      assert.equal(res.status, 200);
      const checkout = api.find('POST', /^\/checkouts$/);
      assert.deepEqual(checkout.body.chargeTypes, ['RECURRENT']);
      assert.equal(checkout.body.subscription.cycle, 'SEMIANNUALLY');
    });

    it('o plano mensal também não recebe teste no cartão', async () => {
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.monthly,
        payment_method: 'credit_card',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.trial_ends_at, null);
      assert.deepEqual(api.find('POST', /^\/checkouts$/).body.billingTypes, ['CREDIT_CARD']);
    });

    it('o teste de 24h vale uma vez por aluno', async () => {
      // Sem essa trava o teste era repetível: cartão que passa na validação e
      // falha na cobrança deixava a assinatura em past_due, o guarda liberava,
      // e um teste novo começava — todo dia, sem pagar.
      const primeiro = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      assert.equal(primeiro.status, 200);
      assert.ok(primeiro.body.trial_ends_at, 'o primeiro checkout oferece o teste');

      await ctx.db.query('UPDATE users SET trial_used_at = now() WHERE id = $1', [student.user.id]);

      const segundo = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      assert.equal(segundo.status, 200);
      assert.equal(segundo.body.trial_ends_at, null, 'quem já usou não recebe outro teste');
    });

    it('assinatura com período vencido não tranca o aluno fora do checkout', async () => {
      // O caso que trancava dos dois lados: status ativo com período vencido
      // bloqueava o conteúdo (expirou) e bloqueava a compra ("já tem
      // assinatura ativa"), sem saída nenhuma pelo produto.
      await ctx.db.query(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, $2, 'asaas', 'sub_vencida', 'active', now() - interval '2 days')`,
        [student.user.id, plans.yearly]
      );

      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      assert.equal(res.status, 200, 'precisa poder pagar de novo');

      const status = await student.agent.get('/api/billing/status');
      assert.equal(status.body.subscription.is_active, false, 'período vencido não é assinatura ativa');
    });

    it('assinatura ativa de verdade continua bloqueando um segundo checkout', async () => {
      await ctx.db.query(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, $2, 'asaas', 'sub_viva', 'active', now() + interval '30 days')`,
        [student.user.id, plans.yearly]
      );
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      assert.equal(res.status, 409);
      assert.match(res.body.error.message, /já tem uma assinatura ativa/i);
    });

    it('o aluno cancela sozinho e mantém o período já pago', async () => {
      // A função de cancelar existia no cliente do Asaas e nunca era chamada:
      // a única saída documentada era "fale com o suporte".
      await ctx.db.query(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, $2, 'asaas', 'sub_000001', 'active', now() + interval '90 days')`,
        [student.user.id, plans.yearly]
      );

      const res = await student.agent.post('/api/billing/cancel', {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.subscription.cancel_at_period_end, true);
      assert.match(res.body.message, /até o fim do período/i);

      // avisou o Asaas
      assert.ok(api.find('DELETE', /^\/subscriptions\/sub_000001$/), 'precisa cancelar no provedor');

      // e o acesso continua até o fim do que foi pago
      const status = await student.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, true);
      assert.equal(status.body.subscription.cancel_at_period_end, true);
    });

    it('cancelar sem assinatura ativa devolve erro claro', async () => {
      const res = await student.agent.post('/api/billing/cancel', {});
      assert.equal(res.status, 404);
      assert.match(res.body.error.message, /não tem uma assinatura ativa/i);
    });

    it('recusa uma forma de pagamento diferente de cartão ou Pix', async () => {
      const res = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'boleto',
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      assert.equal(api.find('POST', /^\/checkouts$/), undefined);
    });

    it('traduz a recusa do Asaas em erro da API, sem vazar o corpo cru', async () => {
      asaas.setHttpClient(
        fakeAsaasApi([
          {
            method: 'POST',
            match: /^\/checkouts$/,
            status: 400,
            body: { errors: [{ code: 'invalid_cpfCnpj', description: 'O CPF informado é inválido.' }] },
          },
        ]).client
      );
      const res = await student.agent.post('/api/billing/checkout', { plan_id: plans.yearly });
      assert.equal(res.status, 502);
      assert.equal(res.body.error.code, 'payment_provider_error');
      assert.match(res.body.error.message, /CPF informado é inválido/);
    });

    it('o portal do Asaas devolve as faturas e explica que não há portal do assinante', async () => {
      // O cliente no Asaas passa a existir quando o aluno conclui o checkout,
      // e o id chega pelo webhook do pagamento. Aqui ele é simulado direto.
      await ctx.db.query('UPDATE users SET provider_customer_id = $1 WHERE id = $2', ['cus_000001', student.user.id]);
      const res = await student.agent.post('/api/billing/portal', {});
      assert.equal(res.status, 200);
      assert.equal(res.body.provider, 'asaas');
      assert.equal(res.body.url, null); // a única fatura simulada já está confirmada
      assert.equal(res.body.invoices.length, 1);
      assert.equal(res.body.invoices[0].payment_method, 'pix');
      assert.match(res.body.message, /portal do assinante/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('webhook do Asaas', () => {
    let student;
    let plans;
    let reference;
    let api;

    const sendWebhook = (payload, { token = WEBHOOK_TOKEN } = {}) =>
      ctx.request('POST', '/api/billing/webhook', {
        raw: true,
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', 'asaas-access-token': token },
      });

    beforeEach(async () => {
      await ctx.resetDb();
      clearPaymentEnv();
      process.env.ASAAS_API_KEY = '$aact_chave_de_teste_1234';
      process.env.ASAAS_ENV = 'sandbox';
      process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
      api = fakeAsaasApi(defaultRoutes());
      asaas.setHttpClient(api.client);
      plans = await seedPlans(ctx.db);
      student = await ctx.registerStudent();
      reference = `${student.user.id}:${plans.yearly}`;
      await settings.setSetting('require_subscription', true);
    });

    after(async () => {
      asaas.setHttpClient(null);
      await settings.setSetting('require_subscription', null);
    });

    it('recusa o webhook com token inválido', async () => {
      const res = await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_token', reference }), { token: 'errado' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      assert.match(res.body.error.message, /token/i);
      assert.equal(await ctx.db.one('SELECT count(*)::int AS total FROM payment_events').then((r) => r.total), 0);
    });

    it('recusa o webhook sem cabeçalho de provedor', async () => {
      const res = await ctx.request('POST', '/api/billing/webhook', {
        raw: true,
        body: JSON.stringify(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_sem_header', reference })),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /provedor/i);
    });

    it('libera o teste somente depois que o Asaas cria a assinatura com o cartão cadastrado', async () => {
      const checkout = await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      assert.equal(checkout.status, 200);

      const before = await student.agent.get('/api/billing/status');
      assert.equal(before.body.access.allowed, false);

      const paid = await sendWebhook(checkoutEvent('CHECKOUT_PAID', {
        id: 'evt_checkout_pago',
        reference,
      }));
      assert.equal(paid.status, 200);
      assert.equal(paid.body.processed, true);
      assert.equal(await ctx.db.one('SELECT count(*)::int AS total FROM subscriptions').then((row) => row.total), 0);

      const pending = await ctx.db.one('SELECT * FROM payment_checkouts WHERE user_id = $1', [student.user.id]);
      assert.equal(pending.status, 'paid');
      const trialEnd = new Date(pending.trial_ends_at);

      const created = await sendWebhook(subscriptionEvent('SUBSCRIPTION_CREATED', {
        id: 'evt_assinatura_criada',
        overrides: { nextDueDate: asaas.toISODate(trialEnd) },
      }));
      assert.equal(created.status, 200);

      const row = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'trialing');
      assert.equal(row.plan_id, plans.yearly);
      assert.equal(row.payment_method, 'credit_card');
      assert.equal(row.provider_subscription_id, 'sub_000001');
      assert.equal(new Date(row.current_period_end).getTime(), trialEnd.getTime());
      assert.equal(row.last_payment_at, null);

      const linked = await ctx.db.one('SELECT * FROM payment_checkouts WHERE id = $1', [pending.id]);
      assert.equal(linked.provider_subscription_id, 'sub_000001');

      const status = await student.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, true);
      assert.equal(status.body.subscription.status, 'trialing');

      const postponed = api.find('PUT', /^\/subscriptions\/sub_000001$/);
      assert.ok(postponed, 'a renovação anual precisa considerar os 3 meses de bônus');
      assert.equal(postponed.body.updatePendingPayments, false);
      assert.equal(postponed.body.nextDueDate, asaas.toISODate(asaas.addMonths(trialEnd, 15)));
    });

    it('pagamento confirmado cria a assinatura, soma o bônus e libera o acesso', async () => {
      const before = await student.agent.get('/api/billing/status');
      assert.equal(before.body.access.allowed, false);
      assert.equal(before.body.access.reason, 'no_subscription');

      const res = await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_1', reference }));
      assert.equal(res.status, 200);
      assert.equal(res.body.provider, 'asaas');
      assert.equal(res.body.processed, true);
      assert.equal(res.body.duplicate, false);

      const row = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'active');
      assert.equal(row.provider, 'asaas');
      assert.equal(row.provider_subscription_id, 'sub_000001');
      assert.equal(row.provider_customer_id, 'cus_000001');
      assert.equal(row.plan_id, plans.yearly);
      assert.equal(row.payment_method, 'pix');
      assert.ok(row.last_payment_at, 'o pagamento precisa ficar registrado na assinatura');
      // pago em 10/03/2026 com 12 meses pagos + 3 de bônus → acesso até 10/06/2027
      assert.equal(new Date(row.current_period_end).toISOString().slice(0, 10), '2027-06-10');

      const after = await student.agent.get('/api/billing/status');
      assert.equal(after.body.access.allowed, true);
      assert.equal(after.body.subscription.is_active, true);
      assert.equal(after.body.subscription.provider, 'asaas');
      assert.equal(after.body.subscription.payment_method, 'pix');
    });

    it('confirmado e recebido da mesma cobrança creditam o período uma vez só', async () => {
      // O Asaas emite os dois eventos para a MESMA cobrança: confirmada na
      // hora, recebida quando o dinheiro cai. Antes os dois estendiam o
      // período, e quem pagasse uma vez o plano de 12+3 meses recebia 27
      // meses. A idempotência por id de evento não pega, porque são eventos
      // diferentes — a chave tem que ser a cobrança.
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_conf', reference }));
      const depoisDoPrimeiro = await ctx.db.one('SELECT current_period_end, last_payment_id FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(new Date(depoisDoPrimeiro.current_period_end).toISOString().slice(0, 10), '2027-06-10');
      assert.equal(depoisDoPrimeiro.last_payment_id, 'pay_000001');

      const segundo = await sendWebhook(paymentEvent('PAYMENT_RECEIVED', { id: 'evt_receb', reference }));
      assert.equal(segundo.status, 200);
      // Não é duplicata de evento — são dois eventos distintos, e os dois são
      // processados. O que não pode é o período mudar.
      assert.equal(segundo.body.duplicate, false);
      assert.equal(segundo.body.processed, true);

      const depoisDoSegundo = await ctx.db.one(
        'SELECT current_period_end, last_payment_at FROM subscriptions WHERE user_id = $1',
        [student.user.id]
      );
      assert.equal(
        new Date(depoisDoSegundo.current_period_end).toISOString().slice(0, 10),
        '2027-06-10',
        'o segundo evento da mesma cobrança não pode somar período'
      );
      assert.equal(
        await ctx.db.one('SELECT count(*)::int AS total FROM subscriptions WHERE user_id = $1', [student.user.id]).then((r) => r.total),
        1,
        'nem criar uma segunda assinatura'
      );
    });

    it('cobrança seguinte, de outro id, renova normalmente', async () => {
      // A trava é por cobrança, não por assinatura: a renovação do ciclo
      // seguinte chega com outro id de pagamento e precisa somar.
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_c1', reference }));
      await sendWebhook(
        paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_c2',
          reference,
          overrides: { id: 'pay_000002', paymentDate: '2027-06-10', confirmedDate: '2027-06-10' },
        })
      );
      const row = await ctx.db.one('SELECT current_period_end, last_payment_id FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.last_payment_id, 'pay_000002');
      // renovação sem bônus: 12 meses a partir do fim do período anterior
      assert.equal(new Date(row.current_period_end).toISOString().slice(0, 10), '2028-06-10');
    });

    it('Pix avulso libera o acesso mesmo sem assinatura no Asaas', async () => {
      // Pix no Asaas é cobrança avulsa: o evento chega sem `subscription`.
      // Antes esse pagamento era ignorado ("evento sem assinatura vinculada")
      // e o aluno pagava sem receber acesso.
      const antes = await student.agent.get('/api/billing/status');
      assert.equal(antes.body.access.allowed, false);

      const res = await sendWebhook(
        paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pix_avulso', reference, subscription: null })
      );
      assert.equal(res.status, 200);

      const row = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'active');
      assert.equal(row.provider_subscription_id, null, 'não existe assinatura do lado do Asaas');
      assert.equal(row.payment_method, 'pix');
      assert.equal(row.cancel_at_period_end, true, 'pagamento único não renova sozinho');
      assert.equal(new Date(row.current_period_end).toISOString().slice(0, 10), '2027-06-10');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, true);
    });

    it('Pix pago libera o acesso pelo CHECKOUT_PAID, sem depender da cobrança', async () => {
      // O caso real de produção: o aluno pagou no Pix e o plano não liberou.
      // O acesso dependia do externalReference chegar NA COBRANÇA, e o Asaas
      // não promete copiar esse campo do checkout para o pagamento. O
      // CHECKOUT_PAID é a notícia confiável de que o Pix foi pago.
      await student.agent.post('/api/billing/checkout', { plan_id: plans.yearly, payment_method: 'pix' });

      const antes = await student.agent.get('/api/billing/status');
      assert.equal(antes.body.access.allowed, false);

      const pago = await sendWebhook(checkoutEvent('CHECKOUT_PAID', { id: 'evt_pix_checkout', pix: true }));
      assert.equal(pago.status, 200);

      const row = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.ok(row, 'o pagamento precisa gerar acesso');
      assert.equal(row.status, 'active');
      assert.equal(row.payment_method, 'pix');
      assert.equal(row.provider_subscription_id, null);
      assert.equal(row.cancel_at_period_end, true, 'pagamento único não renova');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, true);
    });

    it('a cobrança do mesmo Pix, chegando depois, não soma outro período', async () => {
      await student.agent.post('/api/billing/checkout', { plan_id: plans.yearly, payment_method: 'pix' });
      await sendWebhook(checkoutEvent('CHECKOUT_PAID', { id: 'evt_pix_c2', pix: true }));
      const primeiro = await ctx.db.one('SELECT current_period_end FROM subscriptions WHERE user_id = $1', [student.user.id]);

      // agora chega o PAYMENT_CONFIRMED da mesma compra
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pix_pay', reference, subscription: null }));

      const total = await ctx.db.one('SELECT count(*)::int AS total FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(total.total, 1, 'não pode nascer uma segunda assinatura');
      const depois = await ctx.db.one('SELECT current_period_end FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.ok(
        new Date(depois.current_period_end).getTime() >= new Date(primeiro.current_period_end).getTime(),
        'o acesso não pode encolher'
      );
    });

    it('o painel lista e reprocessa pagamento que não virou acesso', async () => {
      // A hospedagem não dá terminal, então a recuperação precisa caber no
      // painel. Este é o caminho que devolve o acesso de quem pagou e ficou
      // sem — o caso real do Pix em produção.
      const admin = await ctx.loginAdmin();
      await student.agent.post('/api/billing/checkout', { plan_id: plans.yearly, payment_method: 'pix' });

      // o evento chega e é descartado porque o aluno não é identificável
      await ctx.db.query(
        `INSERT INTO payment_events (provider, event_id, type, payload)
         VALUES ('asaas', 'evt_orfao', 'CHECKOUT_PAID', $1::jsonb)`,
        [JSON.stringify({ id: 'evt_orfao', event: 'CHECKOUT_PAID', checkout: { id: 'checkout_000001', status: 'PAID' } })]
      );

      const antes = await student.agent.get('/api/billing/status');
      assert.equal(antes.body.access.allowed, false, 'o aluno pagou e está sem acesso');

      const lista = await admin.agent.get('/api/admin/subscriptions/pendentes');
      assert.equal(lista.status, 200);
      assert.ok(lista.body.total >= 1);
      const item = lista.body.items.find((i) => i.event_id === 'evt_orfao');
      assert.ok(item, 'o pagamento aparece na lista');
      assert.equal(item.com_acesso, false, 'marcado como sem acesso');
      assert.equal(item.aluno.email, student.user.email, 'nomeia quem pagou');

      const res = await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.liberados.length, 1);
      assert.equal(res.body.liberados[0].email, student.user.email);

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, true, 'o acesso foi devolvido');
    });

    it('reprocessar de novo não concede período em dobro', async () => {
      const admin = await ctx.loginAdmin();
      await student.agent.post('/api/billing/checkout', { plan_id: plans.yearly, payment_method: 'pix' });
      await ctx.db.query(
        `INSERT INTO payment_events (provider, event_id, type, payload)
         VALUES ('asaas', 'evt_orfao_2', 'CHECKOUT_PAID', $1::jsonb)`,
        [JSON.stringify({ id: 'evt_orfao_2', event: 'CHECKOUT_PAID', checkout: { id: 'checkout_000001', status: 'PAID' } })]
      );

      await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
      const primeiro = await ctx.db.one('SELECT current_period_end FROM subscriptions WHERE user_id = $1', [student.user.id]);

      await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
      const segundo = await ctx.db.one(
        'SELECT current_period_end, count(*) OVER ()::int AS total FROM subscriptions WHERE user_id = $1',
        [student.user.id]
      );
      assert.equal(segundo.total, 1, 'uma assinatura só');
      assert.equal(
        new Date(segundo.current_period_end).getTime(),
        new Date(primeiro.current_period_end).getTime(),
        'o período não pode crescer ao repetir'
      );
    });

    it('evento de criação atrasado não rebaixa uma assinatura já paga', async () => {
      await student.agent.post('/api/billing/checkout', {
        plan_id: plans.yearly,
        payment_method: 'credit_card',
      });
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', {
        id: 'evt_pago_antes_da_assinatura',
        reference,
        overrides: { billingType: 'CREDIT_CARD' },
      }));

      const paid = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(paid.status, 'active');

      await sendWebhook(subscriptionEvent('SUBSCRIPTION_CREATED', {
        id: 'evt_assinatura_atrasada',
        reference,
      }));

      const after = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(after.status, 'active');
      assert.equal(new Date(after.current_period_end).getTime(), new Date(paid.current_period_end).getTime());
      assert.equal(new Date(after.last_payment_at).getTime(), new Date(paid.last_payment_at).getTime());
    });

    it('reprocessar o mesmo evento não duplica nada', async () => {
      const event = paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_2', reference });
      const first = await sendWebhook(event);
      assert.equal(first.body.duplicate, false);

      const second = await sendWebhook(event);
      assert.equal(second.status, 200);
      assert.equal(second.body.duplicate, true);
      assert.equal(second.body.processed, false);

      const counts = await ctx.db.one(
        `SELECT (SELECT count(*)::int FROM subscriptions) AS subscriptions,
                (SELECT count(*)::int FROM payment_events) AS events`
      );
      assert.equal(counts.subscriptions, 1);
      assert.equal(counts.events, 1);
    });

    it('atraso marca a assinatura como em atraso e bloqueia o acesso', async () => {
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_3', reference }));
      const res = await sendWebhook(
        paymentEvent('PAYMENT_OVERDUE', { id: 'evt_atraso_3', reference, overrides: { status: 'OVERDUE' } })
      );
      assert.equal(res.status, 200);

      const row = await ctx.db.one('SELECT status FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'past_due');

      const status = await student.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, false);
      assert.equal(status.body.access.reason, 'past_due');
    });

    it('cancelamento da assinatura mantém o período pago e agenda o encerramento', async () => {
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_4', reference }));
      const res = await sendWebhook({
        id: 'evt_cancelada_4',
        event: 'SUBSCRIPTION_DELETED',
        subscription: { object: 'subscription', id: 'sub_000001', customer: 'cus_000001', externalReference: reference },
      });
      assert.equal(res.status, 200);

      const row = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.ok(row.canceled_at, 'o cancelamento precisa ficar registrado');
      assert.equal(row.cancel_at_period_end, true);
      assert.equal(row.status, 'active'); // o aluno já pagou: o acesso segue até o fim do período
    });

    it('contestação de cobrança encerra o acesso na hora', async () => {
      // Chargeback é o dinheiro voltando para o aluno. Manter o acesso seria
      // entregar o produto de graça a quem pediu o estorno — e quem contesta
      // costuma já ter usado.
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_cb', reference }));
      const antes = await student.agent.get('/api/billing/status');
      assert.equal(antes.body.access.allowed, true);

      const res = await sendWebhook(paymentEvent('PAYMENT_CHARGEBACK_REQUESTED', { id: 'evt_cb', reference }));
      assert.equal(res.status, 200);

      const row = await ctx.db.one('SELECT status, current_period_end FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'canceled');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, false, 'o acesso cai junto com a contestação');
    });

    it('cartão recusado na renovação preserva o período já pago', async () => {
      // O aluno pagou seis meses e a renovação falhou no quinto: ele continua
      // até o fim do que comprou. O que muda é o aviso de que não vai renovar.
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_cc', reference }));

      const res = await sendWebhook(
        paymentEvent('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', { id: 'evt_recusado', reference })
      );
      assert.equal(res.status, 200);

      const row = await ctx.db.one(
        'SELECT status, cancel_at_period_end FROM subscriptions WHERE user_id = $1',
        [student.user.id]
      );
      assert.equal(row.cancel_at_period_end, true, 'avisa que não renova');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, true, 'o que já foi pago continua valendo');
    });

    it('cartão recusado sem período pago bloqueia o acesso', async () => {
      // Sem nada pago, não há o que preservar: a recusa vale como atraso.
      await ctx.db.query(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status, current_period_end)
         VALUES ($1, $2, 'asaas', 'sub_000001', 'active', now() - interval '1 day')`,
        [student.user.id, plans.yearly]
      );

      await sendWebhook(paymentEvent('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', { id: 'evt_recusado_2', reference }));

      const row = await ctx.db.one('SELECT status FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'past_due');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, false);
    });

    it('assinatura inativada mantém o período pago e não renova', async () => {
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_inat', reference }));

      const res = await sendWebhook(subscriptionEvent('SUBSCRIPTION_INACTIVATED', { id: 'evt_inativada' }));
      assert.equal(res.status, 200);

      const row = await ctx.db.one(
        'SELECT cancel_at_period_end, canceled_at FROM subscriptions WHERE user_id = $1',
        [student.user.id]
      );
      assert.equal(row.cancel_at_period_end, true);
      assert.ok(row.canceled_at, 'registra quando foi encerrada');

      const depois = await student.agent.get('/api/billing/status');
      assert.equal(depois.body.access.allowed, true, 'o período pago continua');
    });

    it('estorno encerra o acesso na hora', async () => {
      await sendWebhook(paymentEvent('PAYMENT_CONFIRMED', { id: 'evt_pago_5', reference }));
      await sendWebhook(paymentEvent('PAYMENT_REFUNDED', { id: 'evt_estorno_5', reference, overrides: { status: 'REFUNDED' } }));

      const row = await ctx.db.one('SELECT status, canceled_at FROM subscriptions WHERE user_id = $1', [student.user.id]);
      assert.equal(row.status, 'canceled');
      assert.ok(row.canceled_at);

      const status = await student.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, false);
    });

    it('evento sem tratamento é registrado e ignorado sem erro', async () => {
      const res = await sendWebhook({
        id: 'evt_desconhecido',
        event: 'PAYMENT_CREATED',
        payment: { id: 'pay_000001', subscription: 'sub_000001', customer: 'cus_000001', externalReference: reference },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.processed, true);
      assert.equal(await ctx.db.one('SELECT count(*)::int AS total FROM subscriptions').then((r) => r.total), 0);
    });

    it('corpo que não é JSON é recusado com 400', async () => {
      const res = await ctx.request('POST', '/api/billing/webhook', {
        raw: true,
        body: 'isto não é json',
        headers: { 'content-type': 'application/json', 'asaas-access-token': WEBHOOK_TOKEN },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
    });
  });

  // -------------------------------------------------------------------------
  describe('painel administrativo', () => {
    let admin;

    before(async () => {
      await ctx.resetDb();
      clearPaymentEnv();
      admin = await ctx.loginAdmin();
    });

    it('informa o provedor ativo sem expor a chave', async () => {
      const res = await admin.agent.get('/api/admin/plans/provider-status');
      assert.equal(res.status, 200);
      assert.equal(res.body.provider, 'asaas');
      assert.equal(res.body.configured, false);
      assert.match(res.body.webhook_url, /\/api\/billing\/webhook$/);
      assert.equal(res.body.providers.asaas.configured, false);
      assert.deepEqual(Object.keys(res.body.providers), ['asaas']);
    });

    it('grava duração, bônus, preço de comparação e selo do plano', async () => {
      const created = await admin.agent.post('/api/admin/plans', {
        name: '15 meses',
        description: 'Pague 12, estude 15',
        price_cents: 35990,
        currency: 'brl',
        interval: 'year',
        interval_count: 1,
        trial_days: 0,
        duration_months: 12,
        bonus_months: 3,
        compare_price_cents: 53880,
        badge: 'MELHOR OFERTA',
        features: ['Tudo do mensal', '3 meses de bônus'],
        highlight: true,
        active: true,
        sort_order: 3,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.duration_months, 12);
      assert.equal(created.body.bonus_months, 3);
      assert.equal(created.body.compare_price_cents, 53880);
      assert.equal(created.body.badge, 'MELHOR OFERTA');

      const updated = await admin.agent.put(`/api/admin/plans/${created.body.id}`, {
        name: '15 meses',
        price_cents: 35990,
        currency: 'brl',
        interval: 'year',
        interval_count: 1,
        trial_days: 0,
        duration_months: 12,
        bonus_months: 6,
        compare_price_cents: null,
        badge: null,
        features: [],
        highlight: true,
        active: true,
        sort_order: 3,
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.bonus_months, 6);
      assert.equal(updated.body.compare_price_cents, null);
      assert.equal(updated.body.badge, null);
    });

    it('recusa teste grátis fora dos planos de 6 e 12 meses', async () => {
      const res = await admin.agent.post('/api/admin/plans', {
        name: 'Mensal com teste inválido',
        price_cents: 4490,
        currency: 'brl',
        interval: 'month',
        interval_count: 1,
        trial_days: 1,
        duration_months: 1,
        bonus_months: 0,
        features: [],
        highlight: false,
        active: true,
        sort_order: 10,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      assert.match(JSON.stringify(res.body.error.details), /24 horas grátis/i);
    });

    it('sem provedor configurado a sincronização responde 503', async () => {
      const plans = await admin.agent.get('/api/admin/plans');
      const res = await admin.agent.post(`/api/admin/plans/${plans.body[0].id}/sync-provider`, {});
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'payments_unavailable');
    });

    it('nenhuma rota de pagamento do painel responde a um aluno', async () => {
      const student = await ctx.registerStudent();
      const res = await student.agent.get('/api/admin/plans/provider-status');
      assert.equal(res.status, 401);
    });
  });
});

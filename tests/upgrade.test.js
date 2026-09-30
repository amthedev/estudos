'use strict';

/**
 * Planos com nível e upgrade pagando só a diferença.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/upgrade.test.js
 *
 * É dinheiro real, então o foco é no que daria prejuízo ou cobraria errado:
 * a conta da diferença; a cobrança avulsa aberta com o valor e a referência
 * certos; o pagamento da diferença reconhecido pelo id da cobrança (sem
 * referência nenhuma) e que troca SÓ o plano — nada de período novo, nada de
 * assinatura nova, last_payment_id intocado; o evento repetido e o
 * reprocessamento sem efeito; a renovação com a referência antiga que não
 * desfaz o upgrade; o estorno que volta o nível sem cortar o acesso; e o
 * teste de 24h, onde o upgrade não existe. Também: a volta ao app depois de
 * pagar (com a segunda tentativa sem o endereço de retorno, se o Asaas
 * recusá-lo), o upgrade em aberto no status do aluno e a lista do painel com
 * os upgrades pagos que não trocaram o plano.
 *
 * Nenhum teste toca a API real: o Asaas é o falso de tests/asaas-fake.js.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestContext } = require('./helpers');
const fake = require('./asaas-fake');
const settings = require('../server/services/settings');
const payments = require('../server/services/payments');
const upgrade = require('../server/services/payments/upgrade');
const asaas = require('../server/services/payments/asaas');
const config = require('../server/config');
const dates = require('../server/utils/dates');
const { invalidateLandingCache } = require('../server/routes/landing');

const DAY = 24 * 60 * 60 * 1000;

/** Plano no formato que upgradeQuote recebe. */
const plano = (tier, duration_months, price_cents) => ({ tier, duration_months, price_cents });

describe('Upgrade de plano pela diferença', () => {
  let ctx;
  let restoreEnv;

  before(async () => {
    ctx = await createTestContext();
    restoreEnv = fake.snapshotEnv();
  });

  after(async () => {
    asaas.setHttpClient(null);
    restoreEnv();
    await settings.setSetting('require_subscription', null);
    await ctx.close();
  });

  /** Os planos da grade que os testes usam, mais um antigo sem nível. */
  async function criarPlanos() {
    const grade = [
      ['basico-mensal', 'Básico Mensal', 'basico', 2990, 1, 11],
      ['pro-mensal', 'Pro Mensal', 'pro', 4990, 1, 21],
      ['avancado-mensal', 'Avançado Mensal', 'avancado', 6990, 1, 31],
      ['basico-6-meses', 'Básico 6 meses', 'basico', 15990, 6, 12],
      ['pro-6-meses', 'Pro 6 meses', 'pro', 26990, 6, 22],
    ];
    const ids = {};
    for (const [slug, name, tier, price, duration, sort] of grade) {
      const row = await ctx.db.one(
        `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months,
                            bonus_months, trial_days, tier, active, sort_order)
         VALUES ($1, $2, $3, 'brl', 'month', $4, $4, 0, $5, $6, true, $7)
         RETURNING id`,
        [slug, name, price, duration, duration > 1 ? 1 : 0, tier, sort]
      );
      ids[slug] = row.id;
    }
    const antigo = await ctx.db.one(
      `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, active, sort_order)
       VALUES ('mensal', 'Mensal', 3990, 'brl', 'month', 1, 1, false, 1)
       RETURNING id`
    );
    ids.antigo = antigo.id;
    return ids;
  }

  /**
   * Assinatura vigente, por padrão no cartão (recorrente no Asaas), paga há
   * 15 dias e com mais 15 pela frente.
   */
  async function assinar(userId, planId, overrides = {}) {
    const opts = {
      status: 'active',
      fim: new Date(Date.now() + 15 * DAY),
      providerSubscriptionId: 'sub_000001',
      cancelAtPeriodEnd: false,
      lastPaymentId: 'pay_compra',
      paymentMethod: 'credit_card',
      legacyUntil: null,
      ...overrides,
    };
    return ctx.db.one(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_customer_id, provider_subscription_id, status,
                                  current_period_start, current_period_end, cancel_at_period_end,
                                  last_payment_at, last_payment_id, payment_method, legacy_until)
       VALUES ($1, $2, 'asaas', 'cus_000001', $3, $4, now() - interval '15 days', $5, $6,
               now() - interval '15 days', $7, $8, $9)
       RETURNING *`,
      [
        userId, planId, opts.providerSubscriptionId, opts.status, opts.fim, opts.cancelAtPeriodEnd,
        opts.lastPaymentId, opts.paymentMethod, opts.legacyUntil,
      ]
    );
  }

  /** Aluno que já pagou alguma vez: o cliente no Asaas está gravado. */
  async function alunoCliente() {
    const aluno = await ctx.registerStudent();
    await ctx.db.query('UPDATE users SET provider_customer_id = $1 WHERE id = $2', ['cus_000001', aluno.user.id]);
    return aluno;
  }

  /** Rotas do Asaas falso com a cobrança avulsa do upgrade (um id novo a cada pedido). */
  function rotasDoUpgrade() {
    let seq = 0;
    return [
      ...fake.defaultRoutes(),
      {
        method: 'POST',
        match: /^\/payments$/,
        body: (sent) => {
          seq += 1;
          return {
            id: `pay_upgrade_${seq}`,
            object: 'payment',
            status: 'PENDING',
            value: sent.value,
            invoiceUrl: `https://sandbox.asaas.com/i/pay_upgrade_${seq}`,
          };
        },
      },
      { method: 'DELETE', match: /^\/payments\/[^/]+$/, body: (sent, path) => ({ deleted: true, id: path.split('/').pop() }) },
    ];
  }

  /**
   * Evento da cobrança do upgrade como o Asaas manda para uma cobrança
   * avulsa: sem assinatura e — de propósito — sem externalReference. O
   * reconhecimento tem de vir do id do pagamento.
   */
  function eventoDoUpgrade(type, id, { paymentId = 'pay_upgrade_1', value = 10, overrides = {} } = {}) {
    return fake.paymentEvent(type, {
      id,
      reference: undefined,
      subscription: null,
      overrides: { id: paymentId, value, billingType: 'PIX', ...overrides },
    });
  }

  const assinaturaDe = (userId) =>
    ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at LIMIT 1', [userId]);
  const totalDeAssinaturas = (userId) =>
    ctx.db.one('SELECT count(*)::int AS total FROM subscriptions WHERE user_id = $1', [userId]).then((r) => r.total);
  const pedido = (id) => ctx.db.one('SELECT * FROM plan_changes WHERE id = $1', [id]);

  // -------------------------------------------------------------------------
  describe('conta da diferença (upgradeQuote)', () => {
    // 1º de junho a 1º de julho: 30 dias de ciclo
    const fimDoMes = new Date('2026-07-01T15:00:00.000Z');

    it('na metade do período cobra metade da diferença', () => {
      const quote = payments.upgradeQuote({
        fromPlan: plano('basico', 1, 2990),
        toPlan: plano('pro', 1, 4990),
        periodEnd: fimDoMes,
        now: new Date('2026-06-16T15:00:00.000Z'),
        minCents: 500,
      });
      assert.equal(quote.ratio, 0.5);
      assert.equal(quote.amount_cents, 1000);
      assert.equal(quote.remaining_days, 15);
      assert.equal(quote.min_applied, false);
    });

    it('no plano de 6 meses o ciclo é o semestre inteiro', () => {
      // 1º de julho de 2026 a 1º de janeiro de 2027: 184 dias; faltam 92
      const quote = payments.upgradeQuote({
        fromPlan: plano('basico', 6, 15990),
        toPlan: plano('pro', 6, 26990),
        periodEnd: new Date('2027-01-01T12:00:00.000Z'),
        now: new Date('2026-10-01T12:00:00.000Z'),
        minCents: 500,
      });
      assert.equal(quote.ratio, 0.5);
      assert.equal(quote.amount_cents, 5500);
    });

    it('perto do fim do período cobra o mínimo configurado', () => {
      const quote = payments.upgradeQuote({
        fromPlan: plano('basico', 1, 2990),
        toPlan: plano('pro', 1, 4990),
        periodEnd: fimDoMes,
        now: new Date(fimDoMes.getTime() - 60 * 60 * 1000),
        minCents: 500,
      });
      assert.equal(quote.min_applied, true);
      assert.equal(quote.amount_cents, 500);
    });

    it('recusa descer de nível, ficar no mesmo ou trocar a duração', () => {
      const casos = [
        [plano('pro', 1, 4990), plano('basico', 1, 2990), 'not_higher'],
        [plano('pro', 1, 4990), plano('pro', 1, 4990), 'not_higher'],
        [plano('basico', 1, 2990), plano('pro', 6, 26990), 'different_duration'],
        [plano(null, 1, 3990), plano('pro', 1, 4990), 'no_tier'],
      ];
      for (const [fromPlan, toPlan, reason] of casos) {
        assert.throws(
          () =>
            payments.upgradeQuote({
              fromPlan,
              toPlan,
              periodEnd: fimDoMes,
              now: new Date('2026-06-16T15:00:00.000Z'),
              minCents: 500,
            }),
          (err) => err.status === 409 && err.code === 'upgrade_unavailable' && err.details.reason === reason,
          `esperava recusa "${reason}"`
        );
      }
    });

    it('recusa quando o período já terminou', () => {
      assert.throws(
        () =>
          payments.upgradeQuote({
            fromPlan: plano('basico', 1, 2990),
            toPlan: plano('pro', 1, 4990),
            periodEnd: fimDoMes,
            now: new Date(fimDoMes.getTime() + 1000),
            minCents: 500,
          }),
        (err) => err.code === 'upgrade_unavailable' && err.details.reason === 'period_over'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('pedido de upgrade', () => {
    let planos;
    let aluno;
    let api;

    beforeEach(async () => {
      await ctx.resetDb();
      fake.configureAsaasEnv();
      api = fake.fakeAsaasApi(rotasDoUpgrade());
      asaas.setHttpClient(api.client);
      planos = await criarPlanos();
      aluno = await alunoCliente();
      await settings.setSetting('require_subscription', true);
    });

    it('a cotação devolve a diferença proporcional ao que falta do período', async () => {
      const assinatura = await assinar(aluno.user.id, planos['basico-mensal']);
      const esperado = payments.upgradeQuote({
        fromPlan: plano('basico', 1, 2990),
        toPlan: plano('pro', 1, 4990),
        periodEnd: assinatura.current_period_end,
        now: new Date(),
        minCents: 500,
      });

      const res = await aluno.agent.get(`/api/billing/upgrade/quote?plan_id=${planos['pro-mensal']}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.from_plan, { id: planos['basico-mensal'], name: 'Básico Mensal', tier: 'basico' });
      assert.deepEqual(res.body.to_plan, { id: planos['pro-mensal'], name: 'Pro Mensal', tier: 'pro' });
      assert.ok(Math.abs(res.body.amount_cents - esperado.amount_cents) <= 1, `${res.body.amount_cents} ≠ ${esperado.amount_cents}`);
      assert.equal(res.body.remaining_days, 15);
      assert.equal(res.body.min_applied, false);
      assert.equal(new Date(res.body.period_end).getTime(), new Date(assinatura.current_period_end).getTime());
      assert.equal(api.calls.length, 0, 'cotar não fala com o provedor');
    });

    it('o pedido abre uma cobrança avulsa com o valor e a referência do upgrade', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);

      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-mensal'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.url, 'https://sandbox.asaas.com/i/pay_upgrade_1');
      assert.ok(res.body.amount_cents >= 500);

      const cobranca = api.find('POST', /^\/payments$/);
      assert.ok(cobranca, 'a diferença é cobrada por POST /payments');
      assert.equal(cobranca.body.customer, 'cus_000001');
      assert.equal(cobranca.body.billingType, 'UNDEFINED');
      assert.equal(cobranca.body.value, res.body.amount_cents / 100);
      assert.equal(cobranca.body.dueDate, dates.todayISO());
      assert.equal(cobranca.body.externalReference, `upgrade:${res.body.plan_change_id}`);
      assert.match(cobranca.body.description, /Upgrade para Pro Mensal/);
      assert.equal(api.find('POST', /^\/checkouts$/), undefined, 'upgrade não passa pelo checkout de compra');

      const linha = await pedido(res.body.plan_change_id);
      const assinatura = await assinaturaDe(aluno.user.id);
      assert.equal(linha.status, 'pending');
      assert.equal(linha.provider_payment_id, 'pay_upgrade_1');
      assert.equal(linha.invoice_url, 'https://sandbox.asaas.com/i/pay_upgrade_1');
      assert.equal(linha.amount_cents, res.body.amount_cents);
      assert.equal(linha.from_plan_id, planos['basico-mensal']);
      assert.equal(linha.to_plan_id, planos['pro-mensal']);
      assert.equal(linha.subscription_id, assinatura.id);
      assert.equal(new Date(linha.period_end_at_quote).getTime(), new Date(assinatura.current_period_end).getTime());
    });

    it('no teste de 24h o upgrade responde 409 e nada é cobrado', async () => {
      await assinar(aluno.user.id, planos['basico-6-meses'], {
        status: 'trialing',
        fim: new Date(Date.now() + DAY),
        lastPaymentId: null,
      });

      const cotacao = await aluno.agent.get(`/api/billing/upgrade/quote?plan_id=${planos['pro-6-meses']}`);
      assert.equal(cotacao.status, 409);
      assert.equal(cotacao.body.error.code, 'upgrade_unavailable');
      assert.equal(cotacao.body.error.message, 'O upgrade fica disponível depois do período de teste.');

      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-6-meses'] });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'upgrade_unavailable');
      assert.equal(api.find('POST', /^\/payments$/), undefined);
      assert.equal(await ctx.db.one('SELECT count(*)::int AS n FROM plan_changes').then((r) => r.n), 0);
    });

    it('não deixa descer de nível nem trocar de duração', async () => {
      await assinar(aluno.user.id, planos['pro-mensal']);

      const descer = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['basico-mensal'] });
      assert.equal(descer.status, 409);
      assert.equal(descer.body.error.details.reason, 'not_higher');

      const outraDuracao = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-6-meses'] });
      assert.equal(outraDuracao.status, 409);

      assert.equal(api.find('POST', /^\/payments$/), undefined);
    });

    it('assinante de plano antigo ouve que já tem acesso completo até a data', async () => {
      const ate = new Date(Date.now() + 10 * DAY);
      await assinar(aluno.user.id, planos.antigo, { fim: ate, legacyUntil: ate });

      const res = await aluno.agent.get(`/api/billing/upgrade/quote?plan_id=${planos['pro-mensal']}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, 'legacy');
      assert.ok(res.body.error.message.includes(dates.formatBR(ate)), res.body.error.message);
    });

    it('sem assinatura não há upgrade', async () => {
      const res = await aluno.agent.get(`/api/billing/upgrade/quote?plan_id=${planos['pro-mensal']}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, 'no_subscription');
    });

    it('se o Asaas recusa a cobrança, responde 502 e o pedido fica cancelado', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      api = fake.fakeAsaasApi([
        {
          method: 'POST',
          match: /^\/payments$/,
          status: 400,
          body: { errors: [{ code: 'invalid_value', description: 'Valor abaixo do mínimo.' }] },
        },
      ]);
      asaas.setHttpClient(api.client);

      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-mensal'] });
      assert.equal(res.status, 502);
      assert.equal(res.body.error.code, 'payment_provider_error');
      const linhas = await ctx.db.many('SELECT status FROM plan_changes WHERE user_id = $1', [aluno.user.id]);
      assert.deepEqual(linhas.map((l) => l.status), ['canceled']);
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['basico-mensal'], 'o plano não muda');
    });

    it('um pedido novo cancela o anterior e apaga a cobrança dele', async () => {
      // Dois pedidos abertos (Pro e Avançado) poderiam ser pagos os dois.
      await assinar(aluno.user.id, planos['basico-mensal']);
      const primeiro = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-mensal'] });
      const segundo = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['avancado-mensal'] });
      assert.equal(segundo.status, 200, JSON.stringify(segundo.body));

      assert.equal((await pedido(primeiro.body.plan_change_id)).status, 'canceled');
      assert.equal((await pedido(segundo.body.plan_change_id)).status, 'pending');
      assert.ok(api.find('DELETE', /^\/payments\/pay_upgrade_1$/), 'a cobrança antiga é apagada no Asaas');
      assert.equal(segundo.body.url, 'https://sandbox.asaas.com/i/pay_upgrade_2');
    });
  });

  // -------------------------------------------------------------------------
  describe('pagamento do upgrade (webhook)', () => {
    let planos;
    let aluno;
    let api;

    beforeEach(async () => {
      await ctx.resetDb();
      fake.configureAsaasEnv();
      api = fake.fakeAsaasApi(rotasDoUpgrade());
      asaas.setHttpClient(api.client);
      planos = await criarPlanos();
      aluno = await alunoCliente();
      await settings.setSetting('require_subscription', true);
    });

    async function abrirUpgrade(planoNovo = 'pro-mensal') {
      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos[planoNovo] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    }

    it('reconhece o pagamento só pelo id: troca o plano e mais nada', async () => {
      const antes = await assinar(aluno.user.id, planos['basico-mensal']);
      const aberto = await abrirUpgrade();

      const res = await fake.sendWebhook(
        ctx,
        eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_conf', { value: aberto.amount_cents / 100 })
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal'], 'o nível sobe');
      assert.equal(
        new Date(depois.current_period_end).getTime(),
        new Date(antes.current_period_end).getTime(),
        'pagar a diferença não pode dar período novo'
      );
      assert.equal(depois.last_payment_id, 'pay_compra', 'o upgrade não mexe na trava do reprocessamento');
      assert.equal(depois.status, 'active');
      assert.equal(depois.cancel_at_period_end, false);
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1, 'aluno de cartão sem linha Pix não ganha assinatura nova');

      const linha = await pedido(aberto.plan_change_id);
      assert.equal(linha.status, 'paid');
      assert.ok(linha.paid_at);
      assert.ok(linha.applied_at, 'a troca foi aplicada');

      // a recorrência do cartão passa a cobrar o preço do Pro
      const put = api.find('PUT', /^\/subscriptions\/sub_000001$/);
      assert.ok(put, 'o valor da assinatura no Asaas precisa mudar');
      assert.equal(put.body.value, 49.9);
      assert.equal(put.body.updatePendingPayments, true);
      assert.equal(put.body.externalReference, `${aluno.user.id}:${planos['pro-mensal']}`);

      // e as moedas de hoje já são as do Pro
      const carteira = await aluno.agent.get('/api/coins');
      assert.equal(carteira.status, 200, JSON.stringify(carteira.body));
      assert.equal(carteira.body.tier, 'pro');
      assert.equal(carteira.body.daily, 60);
    });

    it('o mesmo pagamento repetido (e o RECEIVED depois do CONFIRMED) não muda nada', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      const aberto = await abrirUpgrade();
      const evento = eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_rep');
      await fake.sendWebhook(ctx, evento);
      const primeiro = await assinaturaDe(aluno.user.id);
      const pedidoPago = await pedido(aberto.plan_change_id);

      const repetido = await fake.sendWebhook(ctx, evento);
      assert.equal(repetido.body.duplicate, true);
      const recebido = await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_RECEIVED', 'evt_up_receb'));
      assert.equal(recebido.status, 200);
      assert.equal(recebido.body.duplicate, false);

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal']);
      assert.equal(new Date(depois.current_period_end).getTime(), new Date(primeiro.current_period_end).getTime());
      assert.equal(depois.last_payment_id, 'pay_compra');
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
      assert.equal(
        new Date((await pedido(aberto.plan_change_id)).applied_at).getTime(),
        new Date(pedidoPago.applied_at).getTime()
      );
      assert.equal(api.filter('PUT', /^\/subscriptions\//).length, 1, 'o valor no Asaas muda uma vez só');
    });

    it('reprocessar o evento (painel ou script) não aplica de novo', async () => {
      // O painel e scripts/reprocessar-pagamentos.js chamam applyAsaasEvent
      // direto, sem passar pelo webhook. Sem o desvio lá dentro, o pagamento
      // da diferença viraria compra.
      const antes = await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_repro'));

      const guardado = await ctx.db.one(`SELECT event_id, type, payload FROM payment_events WHERE event_id = 'evt_up_repro'`);
      const resultado = await ctx.db.tx((tx) =>
        payments.applyAsaasEvent(tx, { provider: 'asaas', event_id: guardado.event_id, type: guardado.type, payload: guardado.payload })
      );
      assert.equal(resultado.upgrade, true);
      assert.ok(resultado.unchanged, JSON.stringify(resultado));

      const admin = await ctx.loginAdmin();
      const painel = await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
      assert.equal(painel.status, 200, JSON.stringify(painel.body));
      assert.deepEqual(painel.body.erros, []);

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal']);
      assert.equal(new Date(depois.current_period_end).getTime(), new Date(antes.current_period_end).getTime());
      assert.equal(depois.last_payment_id, 'pay_compra');
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
      assert.equal(api.filter('PUT', /^\/subscriptions\//).length, 1);
    });

    it('reprocessar antes de o webhook ter aplicado também só troca o plano', async () => {
      // O evento ficou guardado mas não foi aplicado (queda no meio, por
      // exemplo): o reprocessamento é o primeiro a passar por ele.
      const antes = await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();
      const evento = eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_so_guardado');
      await ctx.db.query(
        `INSERT INTO payment_events (provider, event_id, type, payload) VALUES ('asaas', $1, $2, $3::jsonb)`,
        [evento.id, evento.event, JSON.stringify(evento)]
      );

      const admin = await ctx.loginAdmin();
      const painel = await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
      assert.equal(painel.status, 200, JSON.stringify(painel.body));

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal']);
      assert.equal(new Date(depois.current_period_end).getTime(), new Date(antes.current_period_end).getTime());
      assert.equal(depois.last_payment_id, 'pay_compra');
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
    });

    it('a renovação com a referência antiga mantém o plano novo', async () => {
      // A assinatura do cartão nasceu com a referência do Básico, e é ela que
      // continua vindo nos eventos. Antes, qualquer evento seguinte gravava o
      // plano da referência e desfazia o upgrade.
      const antes = await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_antes_renov'));

      const referenciaAntiga = `${aluno.user.id}:${planos['basico-mensal']}`;
      const renovacao = await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_renovacao',
          reference: referenciaAntiga,
          overrides: { id: 'pay_renovacao', value: 49.9, billingType: 'CREDIT_CARD' },
        })
      );
      assert.equal(renovacao.status, 200);

      const renovada = await assinaturaDe(aluno.user.id);
      assert.equal(renovada.plan_id, planos['pro-mensal'], 'a renovação não pode voltar ao Básico');
      assert.equal(renovada.last_payment_id, 'pay_renovacao');
      // renovação mensal: um mês a partir do fim anterior
      assert.equal(
        new Date(renovada.current_period_end).getTime(),
        asaas.addMonths(antes.current_period_end, 1).getTime()
      );

      // nem o cancelamento, que também chega com a referência antiga
      await fake.sendWebhook(
        ctx,
        fake.subscriptionEvent('SUBSCRIPTION_DELETED', { id: 'evt_cancelada', reference: referenciaAntiga })
      );
      const cancelada = await assinaturaDe(aluno.user.id);
      assert.equal(cancelada.plan_id, planos['pro-mensal']);
      assert.equal(cancelada.cancel_at_period_end, true);
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
    });

    it('Pix comprado de novo depois de vencido ainda vale o plano comprado', async () => {
      // O outro lado da regra acima: o Pix avulso reaproveita a mesma linha a
      // cada compra, e numa compra nova (período anterior já acabado) o plano
      // certo é o da compra, não o que estava gravado.
      await assinar(aluno.user.id, planos['basico-mensal'], {
        providerSubscriptionId: null,
        cancelAtPeriodEnd: true,
        paymentMethod: 'pix',
        lastPaymentId: 'pay_pix_antigo',
        fim: new Date(Date.now() - 2 * DAY),
      });

      const hoje = dates.todayISO();
      await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_pix_de_novo',
          reference: `${aluno.user.id}:${planos['pro-6-meses']}`,
          subscription: null,
          overrides: { id: 'pay_pix_novo', value: 269.9, paymentDate: hoje, confirmedDate: hoje },
        })
      );

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-6-meses']);
      assert.equal(depois.last_payment_id, 'pay_pix_novo');
      // seis meses a partir de hoje, os do plano comprado
      assert.equal(
        asaas.toISODate(depois.current_period_end),
        asaas.toISODate(asaas.addMonths(new Date(`${hoje}T12:00:00.000Z`), 6))
      );
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
    });

    it('Pix de 12 meses comprado de novo depois de vencido ganha o mês de bônus', async () => {
      // Compra nova na linha reaproveitada é primeira cobrança daquela compra:
      // o bônus vale mesmo quando o pagamento chega antes do CHECKOUT_PAID.
      // Antes, a linha já tinha last_payment_at e o evento virava "renovação",
      // sem o mês de bônus — o aluno pagava 13 meses e levava 12.
      const doze = await ctx.db.one(
        `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months,
                            bonus_months, trial_days, tier, active, sort_order)
         VALUES ('pro-12-meses-pix', 'Pro 12 meses', 44990, 'brl', 'month', 12, 12, 1, 1, 'pro', true, 23)
         RETURNING id`
      );
      await assinar(aluno.user.id, planos['basico-mensal'], {
        providerSubscriptionId: null,
        cancelAtPeriodEnd: true,
        paymentMethod: 'pix',
        lastPaymentId: 'pay_pix_antigo_12',
        fim: new Date(Date.now() - 2 * DAY),
      });

      const hoje = dates.todayISO();
      await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_pix_12_de_novo',
          reference: `${aluno.user.id}:${doze.id}`,
          subscription: null,
          overrides: { id: 'pay_pix_12_novo', value: 449.9, paymentDate: hoje, confirmedDate: hoje },
        })
      );

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, doze.id);
      // 12 meses pagos + 1 de bônus, a partir de hoje
      assert.equal(
        asaas.toISODate(depois.current_period_end),
        asaas.toISODate(asaas.addMonths(new Date(`${hoje}T12:00:00.000Z`), 13))
      );
    });

    it('o estorno da diferença volta o nível e não corta o acesso', async () => {
      const antes = await assinar(aluno.user.id, planos['basico-mensal']);
      const aberto = await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_pago'));
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['pro-mensal']);

      const res = await fake.sendWebhook(
        ctx,
        eventoDoUpgrade('PAYMENT_REFUNDED', 'evt_up_estorno', { overrides: { status: 'REFUNDED' } })
      );
      assert.equal(res.status, 200);

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['basico-mensal'], 'volta ao Básico');
      assert.equal(depois.status, 'active', 'o acesso continua');
      assert.equal(new Date(depois.current_period_end).getTime(), new Date(antes.current_period_end).getTime());
      assert.equal(depois.canceled_at, null);
      assert.equal((await pedido(aberto.plan_change_id)).status, 'refunded');

      // e a recorrência volta ao preço do Básico
      const puts = api.filter('PUT', /^\/subscriptions\/sub_000001$/);
      assert.equal(puts.length, 2);
      assert.equal(puts[1].body.value, 29.9);
      assert.equal(puts[1].body.externalReference, `${aluno.user.id}:${planos['basico-mensal']}`);

      const status = await aluno.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, true);

      // o CONFIRMED que chegar atrasado não reaplica o que foi devolvido
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_RECEIVED', 'evt_up_atrasado'));
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['basico-mensal']);
    });

    it('contestação da diferença também volta o nível sem encerrar o acesso', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_cb_pago'));
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CHARGEBACK_REQUESTED', 'evt_up_cb'));

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['basico-mensal']);
      assert.equal(depois.status, 'active');
      const status = await aluno.agent.get('/api/billing/status');
      assert.equal(status.body.access.allowed, true);
    });

    it('no Pix avulso a diferença não vira renovação nem mexe no Asaas', async () => {
      // Assinatura Pix concedida por PAYMENT_CONFIRMED ('pay_...'): sem o
      // desvio, o pagamento da diferença era tratado como renovação e somava
      // um ciclo inteiro.
      const antes = await assinar(aluno.user.id, planos['basico-mensal'], {
        providerSubscriptionId: null,
        cancelAtPeriodEnd: true,
        paymentMethod: 'pix',
        lastPaymentId: 'pay_pix_compra',
      });
      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_pix'));

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal']);
      assert.equal(new Date(depois.current_period_end).getTime(), new Date(antes.current_period_end).getTime());
      assert.equal(depois.last_payment_id, 'pay_pix_compra');
      assert.equal(depois.cancel_at_period_end, true);
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
      assert.equal(api.find('PUT', /^\/subscriptions\//), undefined, 'Pix não tem assinatura no Asaas');
    });

    it('cartão já cancelado pelo aluno troca o nível sem mexer na assinatura do Asaas', async () => {
      // A assinatura cancelada já sofreu DELETE no Asaas; um PUT nela é erro.
      // O cancelamento é o de verdade, pela tela: é ele que diz o que fica
      // gravado na assinatura.
      await assinar(aluno.user.id, planos['basico-mensal']);
      const cancelada = await aluno.agent.post('/api/billing/cancel', {});
      assert.equal(cancelada.status, 200, JSON.stringify(cancelada.body));
      assert.ok(api.find('DELETE', /^\/subscriptions\/sub_000001$/));

      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_cancelada'));

      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['pro-mensal']);
      assert.equal(api.find('PUT', /^\/subscriptions\//), undefined);
    });

    it('cartão recusado na renovação, com o período ainda pago: o valor no Asaas acompanha o nível', async () => {
      // A recusa liga cancel_at_period_end para a tela avisar, mas a assinatura
      // continua viva no Asaas e cobra quando o aluno trocar o cartão. Tomá-la
      // por encerrada pulava o PUT, e o Pro renovava no preço do Básico.
      await assinar(aluno.user.id, planos['basico-mensal']);
      const recusa = await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', {
          id: 'evt_cartao_recusado',
          reference: `${aluno.user.id}:${planos['basico-mensal']}`,
          overrides: { id: 'pay_renovacao_recusada', value: 29.9, billingType: 'CREDIT_CARD', status: 'PENDING' },
        })
      );
      assert.equal(recusa.status, 200, JSON.stringify(recusa.body));
      const recusada = await assinaturaDe(aluno.user.id);
      assert.equal(recusada.status, 'active', 'o período pago continua valendo');
      assert.equal(recusada.cancel_at_period_end, true);

      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_cartao_recusado'));
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['pro-mensal']);
      const put = api.find('PUT', /^\/subscriptions\/sub_000001$/);
      assert.ok(put, 'a assinatura viva no Asaas precisa passar a cobrar o Pro');
      assert.equal(put.body.value, 49.9);

      // e o estorno da diferença leva o valor de volta ao do Básico
      await fake.sendWebhook(
        ctx,
        eventoDoUpgrade('PAYMENT_REFUNDED', 'evt_up_cartao_recusado_estorno', { overrides: { status: 'REFUNDED' } })
      );
      const puts = api.filter('PUT', /^\/subscriptions\/sub_000001$/);
      assert.equal(puts.length, 2);
      assert.equal(puts[1].body.value, 29.9);
    });

    it('o CHECKOUT_PAID do Pix que chega depois do upgrade não volta ao plano do checkout', async () => {
      // A cobrança do Pix chegou antes, com a referência do checkout, e já
      // concedeu o período; o aluno subiu de nível; só depois o CHECKOUT_PAID
      // da mesma compra foi entregue. Ele regravava o plano do checkout e
      // recalculava o período: o upgrade pago sumia, com o pedido marcado como
      // aplicado.
      await ctx.db.query(
        `INSERT INTO payment_checkouts (provider, provider_checkout_id, user_id, plan_id, payment_method, status, created_at)
         VALUES ('asaas', 'checkout_pix_atrasado', $1, $2, 'pix', 'pending', now() - interval '5 minutes')`,
        [aluno.user.id, planos['basico-mensal']]
      );
      const hoje = dates.todayISO();
      const cobrancaDoPix = fake.paymentEvent('PAYMENT_RECEIVED', {
        id: 'evt_pix_da_compra',
        reference: `${aluno.user.id}:${planos['basico-mensal']}`,
        subscription: null,
        overrides: { id: 'pay_pix_da_compra', value: 29.9, paymentDate: hoje, confirmedDate: hoje },
      });
      await fake.sendWebhook(ctx, cobrancaDoPix);
      const comprada = await assinaturaDe(aluno.user.id);
      assert.equal(comprada.plan_id, planos['basico-mensal']);

      const aberto = await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_antes_do_checkout'));
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['pro-mensal']);

      const checkoutPago = {
        id: 'evt_checkout_atrasado',
        event: 'CHECKOUT_PAID',
        dateCreated: '2026-03-10 09:00:00',
        checkout: {
          id: 'checkout_pix_atrasado',
          customer: 'cus_000001',
          status: 'PAID',
          billingTypes: ['PIX'],
          chargeTypes: ['DETACHED'],
        },
      };
      const atrasado = await fake.sendWebhook(ctx, checkoutPago);
      assert.equal(atrasado.status, 200, JSON.stringify(atrasado.body));

      const depois = await assinaturaDe(aluno.user.id);
      assert.equal(depois.plan_id, planos['pro-mensal'], 'o upgrade pago continua valendo');
      assert.equal(
        new Date(depois.current_period_end).getTime(),
        new Date(comprada.current_period_end).getTime(),
        'a mesma compra não recalcula o período'
      );
      assert.equal(depois.last_payment_id, 'checkout:checkout_pix_atrasado', 'a trava aponta para o checkout, como na ordem inversa');
      assert.equal(await totalDeAssinaturas(aluno.user.id), 1);
      assert.ok((await pedido(aberto.plan_change_id)).applied_at);

      // reprocessar os dois eventos da compra (painel ou script) não muda nada
      await ctx.db.query('DELETE FROM payment_events WHERE event_id IN ($1, $2)', ['evt_pix_da_compra', 'evt_checkout_atrasado']);
      await fake.sendWebhook(ctx, cobrancaDoPix);
      await fake.sendWebhook(ctx, checkoutPago);
      const reprocessada = await assinaturaDe(aluno.user.id);
      assert.equal(reprocessada.plan_id, planos['pro-mensal']);
      assert.equal(new Date(reprocessada.current_period_end).getTime(), new Date(comprada.current_period_end).getTime());
    });

    it('pago depois de o período renovar: registra, mas não troca sozinho', async () => {
      // A diferença foi cotada sobre o restinho do período velho. Aplicar
      // depois da renovação daria o Pro por um ciclo inteiro pago no preço do
      // Básico — fica para o suporte.
      await assinar(aluno.user.id, planos['basico-mensal']);
      const aberto = await abrirUpgrade();
      await ctx.db.query(
        `UPDATE subscriptions SET current_period_end = current_period_end + interval '1 month' WHERE user_id = $1`,
        [aluno.user.id]
      );

      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_tarde'));

      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['basico-mensal']);
      const linha = await pedido(aberto.plan_change_id);
      assert.equal(linha.status, 'paid');
      assert.equal(linha.applied_at, null, 'pago sem troca: o suporte decide');
      assert.equal(api.find('PUT', /^\/subscriptions\//), undefined);
    });

    it('cobrança vencida marca o pedido; se for paga depois sem nada ter mudado, troca', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      const aberto = await abrirUpgrade();

      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_OVERDUE', 'evt_up_vencida', { overrides: { status: 'OVERDUE' } }));
      assert.equal((await pedido(aberto.plan_change_id)).status, 'expired');
      assert.equal((await assinaturaDe(aluno.user.id)).status, 'active', 'o vencimento da diferença não afeta a assinatura');

      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_up_paga_tarde'));
      assert.equal((await pedido(aberto.plan_change_id)).status, 'paid');
      assert.equal((await assinaturaDe(aluno.user.id)).plan_id, planos['pro-mensal']);
    });

    it('referência de upgrade sem pedido nunca cai na lógica de compra', async () => {
      // Sem o desvio, o aluno seria achado pelo cliente do Asaas e ganharia
      // uma assinatura Pix de um mês.
      const res = await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_up_orfao',
          reference: `upgrade:${randomUUID()}`,
          subscription: null,
          overrides: { id: 'pay_sem_pedido', value: 10 },
        })
      );
      assert.equal(res.status, 200);
      assert.equal(await totalDeAssinaturas(aluno.user.id), 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('compra de plano antigo em andamento na virada dos níveis', () => {
    // A migration 218 deu legado só a quem já tinha período pago. Quem estava
    // no teste de 24h, esperando a primeira cobrança ou com o Pix aberto paga
    // o preço cheio do plano antigo DEPOIS dela — e não pode acabar no Básico.
    let planos;
    let aluno;

    beforeEach(async () => {
      await ctx.resetDb();
      fake.configureAsaasEnv();
      asaas.setHttpClient(fake.fakeAsaasApi(rotasDoUpgrade()).client);
      planos = await criarPlanos();
      aluno = await alunoCliente();
      await settings.setSetting('require_subscription', true);
    });

    /** Assinatura de cartão do plano antigo que ainda não teve nenhum pagamento. */
    function assinaturaSemPagamento(userId, { status, fim = null, legado = null }) {
      return ctx.db.one(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_customer_id, provider_subscription_id, status,
                                    current_period_start, current_period_end, legacy_until, payment_method)
         VALUES ($1, $2, 'asaas', 'cus_000001', 'sub_000001', $3, now(), $4, $5, 'credit_card')
         RETURNING *`,
        [userId, planos.antigo, status, fim, legado]
      );
    }

    /** Checkout do plano antigo aberto antes (ou depois) de a migration dos níveis rodar. */
    function checkoutAntigo(userId, { id, metodo, assinatura = null, antesDaMigration = true }) {
      return ctx.db.query(
        `INSERT INTO payment_checkouts (provider, provider_checkout_id, provider_subscription_id, user_id, plan_id,
                                        payment_method, status, created_at)
         VALUES ('asaas', $1, $2, $3, $4, $5, 'pending',
                 CASE WHEN $6::boolean
                      THEN (SELECT applied_at - interval '1 hour' FROM schema_migrations WHERE name = '218_moedas_e_niveis.sql')
                      ELSE now() END)`,
        [id, assinatura, userId, planos.antigo, metodo, antesDaMigration]
      );
    }

    /** Primeira cobrança do cartão, paga hoje. */
    function primeiraCobranca(id, paymentId) {
      const hoje = dates.todayISO();
      return fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id,
          reference: `${aluno.user.id}:${planos.antigo}`,
          overrides: { id: paymentId, value: 39.9, billingType: 'CREDIT_CARD', paymentDate: hoje, confirmedDate: hoje },
        })
      );
    }

    async function carteira() {
      const res = await aluno.agent.get('/api/coins');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    }

    it('no teste de 24h pego pela migration, a primeira cobrança leva o legado ao fim do período comprado', async () => {
      const fimDoTeste = new Date(Date.now() + 2 * 60 * 60 * 1000);
      // o que a migration grava para quem está no teste: o legado acaba com ele
      await assinaturaSemPagamento(aluno.user.id, { status: 'trialing', fim: fimDoTeste, legado: fimDoTeste });

      const res = await primeiraCobranca('evt_fim_do_teste', 'pay_primeira_do_teste');
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const paga = await assinaturaDe(aluno.user.id);
      assert.equal(paga.status, 'active');
      assert.ok(new Date(paga.current_period_end).getTime() > fimDoTeste.getTime());
      assert.equal(new Date(paga.legacy_until).getTime(), new Date(paga.current_period_end).getTime());
      const hoje = await carteira();
      assert.equal(hoje.unlimited, true);
      assert.equal(hoje.reason, 'legacy');
    });

    it('esperando a primeira cobrança de um checkout aberto antes da migration, também ganha o legado', async () => {
      await assinaturaSemPagamento(aluno.user.id, { status: 'incomplete' });
      await checkoutAntigo(aluno.user.id, { id: 'checkout_cartao_antigo', metodo: 'credit_card', assinatura: 'sub_000001' });

      await primeiraCobranca('evt_primeira_incompleta', 'pay_primeira_incompleta');

      const paga = await assinaturaDe(aluno.user.id);
      assert.equal(paga.status, 'active');
      assert.ok(paga.legacy_until, 'quem comprou o plano antigo tem acesso completo');
      assert.equal(new Date(paga.legacy_until).getTime(), new Date(paga.current_period_end).getTime());
      assert.equal((await carteira()).reason, 'legacy');
    });

    it('Pix de plano antigo aberto antes da migration e pago depois ganha o legado', async () => {
      await checkoutAntigo(aluno.user.id, { id: 'checkout_pix_antigo', metodo: 'pix' });

      const res = await fake.sendWebhook(ctx, {
        id: 'evt_pix_antigo_pago',
        event: 'CHECKOUT_PAID',
        dateCreated: '2026-03-10 09:00:00',
        checkout: {
          id: 'checkout_pix_antigo',
          customer: 'cus_000001',
          status: 'PAID',
          billingTypes: ['PIX'],
          chargeTypes: ['DETACHED'],
        },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const paga = await assinaturaDe(aluno.user.id);
      assert.equal(paga.plan_id, planos.antigo);
      assert.equal(paga.status, 'active');
      assert.equal(new Date(paga.legacy_until).getTime(), new Date(paga.current_period_end).getTime());
      assert.equal((await carteira()).reason, 'legacy');
    });

    it('plano sem nível comprado depois da virada e a renovação do antigo não ganham legado', async () => {
      // Checkout aberto depois da migration: plano sem nível criado ou
      // reativado no painel, que vale Básico.
      await assinaturaSemPagamento(aluno.user.id, { status: 'incomplete' });
      await checkoutAntigo(aluno.user.id, {
        id: 'checkout_depois',
        metodo: 'credit_card',
        assinatura: 'sub_000001',
        antesDaMigration: false,
      });
      await primeiraCobranca('evt_depois_da_virada', 'pay_depois_da_virada');
      const paga = await assinaturaDe(aluno.user.id);
      assert.equal(paga.legacy_until, null);
      const hoje = await carteira();
      assert.equal(hoje.unlimited, false);
      assert.equal(hoje.tier, 'basico');
      assert.equal(hoje.reason, 'plan_without_tier');

      // Assinante antigo que renova: o legado continua no fim do período que já
      // estava pago na migration, e daí em diante vale o nível.
      const outro = await ctx.registerStudent({ name: 'Assinante antigo que renova' });
      const legado = new Date(Date.now() + 3 * DAY);
      await ctx.db.query(
        `INSERT INTO subscriptions (user_id, plan_id, provider, provider_customer_id, provider_subscription_id, status,
                                    current_period_start, current_period_end, last_payment_at, last_payment_id,
                                    payment_method, legacy_until)
         VALUES ($1, $2, 'asaas', 'cus_renova', 'sub_renova', 'active', now() - interval '27 days', $3,
                 now() - interval '27 days', 'pay_antigo', 'credit_card', $3)`,
        [outro.user.id, planos.antigo, legado]
      );
      const hojeISO = dates.todayISO();
      await fake.sendWebhook(
        ctx,
        fake.paymentEvent('PAYMENT_CONFIRMED', {
          id: 'evt_renovacao_do_antigo',
          reference: `${outro.user.id}:${planos.antigo}`,
          subscription: 'sub_renova',
          customer: 'cus_renova',
          overrides: { id: 'pay_renovacao_antigo', value: 39.9, billingType: 'CREDIT_CARD', paymentDate: hojeISO, confirmedDate: hojeISO },
        })
      );
      const renovada = await ctx.db.one('SELECT * FROM subscriptions WHERE user_id = $1', [outro.user.id]);
      assert.equal(renovada.last_payment_id, 'pay_renovacao_antigo');
      assert.ok(new Date(renovada.current_period_end).getTime() > legado.getTime());
      assert.equal(new Date(renovada.legacy_until).getTime(), legado.getTime(), 'a renovação não estende o legado');
    });
  });

  // -------------------------------------------------------------------------
  describe('volta ao app, upgrade em aberto e upgrades pagos sem troca', () => {
    let planos;
    let aluno;
    let api;

    beforeEach(async () => {
      await ctx.resetDb();
      fake.configureAsaasEnv();
      api = fake.fakeAsaasApi(rotasDoUpgrade());
      asaas.setHttpClient(api.client);
      planos = await criarPlanos();
      aluno = await alunoCliente();
      await settings.setSetting('require_subscription', true);
    });

    async function abrirUpgrade(planoNovo = 'pro-mensal') {
      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos[planoNovo] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    }

    it('a cobrança leva o aluno de volta à tela de assinatura depois de pagar', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();

      const cobranca = api.find('POST', /^\/payments$/);
      assert.deepEqual(cobranca.body.callback, {
        successUrl: `${config.appUrl}/app/assinatura?upgrade=success`,
        autoRedirect: true,
      });
      assert.equal(api.filter('POST', /^\/payments$/).length, 1);
    });

    it('se o Asaas recusa o endereço de retorno, cria a cobrança de novo sem ele', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      const recusa = {
        errors: [{ code: 'invalid_callback', description: 'O domínio da URL de sucesso não está cadastrado na sua conta.' }],
      };
      let seq = 0;
      api = fake.fakeAsaasApi([
        ...fake.defaultRoutes(),
        { method: 'POST', match: /^\/payments$/, status: 400, body: recusa },
      ]);
      // O falso responde por rota fixa, e aqui a resposta depende do corpo: o
      // cliente é embrulhado para que, sem o callback, a cobrança seja criada.
      const client = api.client;
      asaas.setHttpClient(async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        if (String(init.method).toUpperCase() === 'POST' && /\/payments$/.test(String(url)) && body && !body.callback) {
          await client(url, init); // só para gravar a chamada
          seq += 1;
          return fake.jsonResponse(200, {
            id: `pay_upgrade_${seq}`,
            status: 'PENDING',
            invoiceUrl: `https://sandbox.asaas.com/i/pay_upgrade_${seq}`,
          });
        }
        return client(url, init);
      });

      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-mensal'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.url, 'https://sandbox.asaas.com/i/pay_upgrade_1');

      const tentativas = api.filter('POST', /^\/payments$/);
      assert.equal(tentativas.length, 2, 'uma tentativa com o retorno e uma sem');
      assert.ok(tentativas[0].body.callback);
      assert.equal(tentativas[1].body.callback, undefined);
      assert.equal(tentativas[1].body.value, tentativas[0].body.value);
      assert.equal(tentativas[1].body.externalReference, tentativas[0].body.externalReference);

      const linha = await pedido(res.body.plan_change_id);
      assert.equal(linha.status, 'pending');
      assert.equal(linha.provider_payment_id, 'pay_upgrade_1');
    });

    it('outra recusa do Asaas não é repetida: o erro chega ao aluno', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      api = fake.fakeAsaasApi([
        {
          method: 'POST',
          match: /^\/payments$/,
          status: 400,
          body: { errors: [{ code: 'invalid_customer', description: 'O CPF do cliente é obrigatório.' }] },
        },
      ]);
      asaas.setHttpClient(api.client);

      const res = await aluno.agent.post('/api/billing/upgrade', { plan_id: planos['pro-mensal'] });
      assert.equal(res.status, 502);
      assert.equal(api.filter('POST', /^\/payments$/).length, 1, 'sem segunda tentativa');
      assert.match(res.body.error.message, /CPF/);
    });

    it('o status mostra o upgrade que espera pagamento, e ele some quando é pago', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      const semPedido = await aluno.agent.get('/api/billing/status');
      assert.equal(semPedido.status, 200, JSON.stringify(semPedido.body));
      assert.equal(semPedido.body.pending_upgrade, null);

      const aberto = await abrirUpgrade();
      const res = await aluno.agent.get('/api/billing/status');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const pendente = res.body.pending_upgrade;
      assert.ok(pendente, 'o pedido aberto aparece no status');
      assert.equal(pendente.id, aberto.plan_change_id);
      assert.deepEqual(pendente.to_plan, { id: planos['pro-mensal'], name: 'Pro Mensal', tier: 'pro' });
      assert.equal(pendente.amount_cents, aberto.amount_cents);
      assert.equal(pendente.invoice_url, 'https://sandbox.asaas.com/i/pay_upgrade_1');
      assert.ok(pendente.created_at);

      // um pedido novo (para o Avançado) substitui o anterior no status
      await abrirUpgrade('avancado-mensal');
      const trocado = await aluno.agent.get('/api/billing/status');
      assert.equal(trocado.body.pending_upgrade.to_plan.name, 'Avançado Mensal');
      assert.equal(trocado.body.pending_upgrade.invoice_url, 'https://sandbox.asaas.com/i/pay_upgrade_2');

      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_status_pago', { paymentId: 'pay_upgrade_2' }));
      const pago = await aluno.agent.get('/api/billing/status');
      assert.equal(pago.body.pending_upgrade, null);
      assert.equal(pago.body.subscription.plan_tier, 'avancado');
    });

    it('pedido que já não pode valer (o período renovou) não aparece como aguardando pagamento', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      await abrirUpgrade();
      await ctx.db.query(
        `UPDATE subscriptions SET current_period_end = current_period_end + interval '1 month' WHERE user_id = $1`,
        [aluno.user.id]
      );
      const res = await aluno.agent.get('/api/billing/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.pending_upgrade, null);
    });

    it('o painel lista os upgrades pagos que não trocaram o plano, com o motivo provável', async () => {
      await assinar(aluno.user.id, planos['basico-mensal']);
      const admin = await ctx.loginAdmin();

      // um upgrade que deu certo não entra na lista
      await abrirUpgrade();
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_lista_ok'));
      const vazia = await admin.agent.get('/api/admin/subscriptions/upgrades-nao-aplicados');
      assert.equal(vazia.status, 200, JSON.stringify(vazia.body));
      assert.deepEqual(vazia.body, { total: 0, items: [] });

      // outro aluno paga depois de o período renovar: pago, sem troca
      const outro = await alunoCliente();
      await assinar(outro.user.id, planos['basico-mensal'], { providerSubscriptionId: 'sub_000002', lastPaymentId: 'pay_compra_2' });
      const res = await outro.agent.post('/api/billing/upgrade', { plan_id: planos['avancado-mensal'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await ctx.db.query(
        `UPDATE subscriptions SET current_period_end = current_period_end + interval '1 month' WHERE user_id = $1`,
        [outro.user.id]
      );
      await fake.sendWebhook(ctx, eventoDoUpgrade('PAYMENT_CONFIRMED', 'evt_lista_tarde', { paymentId: 'pay_upgrade_2' }));

      const lista = await admin.agent.get('/api/admin/subscriptions/upgrades-nao-aplicados');
      assert.equal(lista.status, 200, JSON.stringify(lista.body));
      assert.equal(lista.body.total, 1);
      const [item] = lista.body.items;
      assert.equal(item.id, res.body.plan_change_id);
      assert.equal(item.user.id, outro.user.id);
      assert.equal(item.user.email, outro.user.email);
      assert.equal(item.from_plan.name, 'Básico Mensal');
      assert.equal(item.to_plan.name, 'Avançado Mensal');
      assert.equal(item.amount_cents, res.body.amount_cents);
      assert.ok(item.paid_at);
      assert.equal(item.provider_payment_id, 'pay_upgrade_2');
      assert.equal(item.subscription.plan_name, 'Básico Mensal');
      assert.equal(item.reason, 'o período da assinatura renovou depois do pedido');

      // aluno não vê a lista
      const proibido = await outro.agent.get('/api/admin/subscriptions/upgrades-nao-aplicados');
      assert.ok([401, 403].includes(proibido.status), `status ${proibido.status}`);

      // o suporte devolve o valor no Asaas: o estorno tira o pedido da lista
      await fake.sendWebhook(
        ctx,
        eventoDoUpgrade('PAYMENT_REFUNDED', 'evt_lista_estorno', { paymentId: 'pay_upgrade_2', overrides: { status: 'REFUNDED' } })
      );
      const depois = await admin.agent.get('/api/admin/subscriptions/upgrades-nao-aplicados');
      assert.equal(depois.body.total, 0);
      assert.equal((await assinaturaDe(outro.user.id)).plan_id, planos['basico-mensal'], 'o estorno de pedido não aplicado não mexe no plano');
    });

    it('o motivo diz quando a assinatura já estava no plano novo ou não está mais ativa', () => {
      const change = {
        from_plan_id: 'a',
        to_plan_id: 'b',
        period_end_at_quote: new Date('2026-07-01T15:00:00.000Z'),
      };
      const agora = new Date('2026-06-15T12:00:00.000Z');
      const sub = (extra) => ({ plan_id: 'a', status: 'active', current_period_end: change.period_end_at_quote, ...extra });
      assert.equal(upgrade.blockingReason(change, null, agora), 'a assinatura do pedido não existe mais');
      assert.equal(upgrade.blockingReason(change, sub({ plan_id: 'b' }), agora), 'a assinatura já estava no plano novo');
      assert.equal(upgrade.blockingReason(change, sub({ plan_id: 'c' }), agora), 'o plano da assinatura mudou depois do pedido');
      assert.equal(upgrade.blockingReason(change, sub({ status: 'past_due' }), agora), 'a assinatura não está mais ativa');
      assert.equal(upgrade.blockingReason(change, sub({}), agora), null);
    });
  });

  // -------------------------------------------------------------------------
  describe('planos com nível na vitrine e no painel', () => {
    let planos;

    beforeEach(async () => {
      await ctx.resetDb();
      fake.clearPaymentEnv();
      planos = await criarPlanos();
      invalidateLandingCache();
    });

    afterEach(async () => {
      await settings.setSetting('coins_daily_pro', null);
      invalidateLandingCache();
    });

    it('/api/billing/plans traz nível, duração, moedas por dia e cota do Tutor', async () => {
      await settings.setSetting('coins_daily_pro', 75);
      await ctx.db.query(
        `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, active, sort_order)
         VALUES ('sem-nivel', 'Sem nível', 1000, 'brl', 'month', 1, 1, true, 99)`
      );

      const res = await ctx.request('GET', '/api/billing/plans');
      assert.equal(res.status, 200);
      const basico = res.body.find((p) => p.slug === 'basico-mensal');
      assert.equal(basico.tier, 'basico');
      assert.equal(basico.duration_months, 1);
      assert.equal(basico.daily_coins, 30);
      assert.equal(basico.tutor_monthly_tokens, 1500000);
      const pro = res.body.find((p) => p.slug === 'pro-6-meses');
      assert.equal(pro.duration_months, 6);
      assert.equal(pro.daily_coins, 75, 'o número vem da configuração, não do plano');
      const semNivel = res.body.find((p) => p.slug === 'sem-nivel');
      assert.equal(semNivel.tier, null);
      assert.equal(semNivel.daily_coins, null);
      assert.equal(semNivel.tutor_monthly_tokens, null);
      assert.equal(res.body.find((p) => p.slug === 'mensal'), undefined, 'plano antigo desativado sai da vitrine');
    });

    it('/api/landing traz o nível e as moedas por dia de cada plano', async () => {
      const res = await ctx.request('GET', '/api/landing');
      assert.equal(res.status, 200);
      const avancado = res.body.plans.find((p) => p.slug === 'avancado-mensal');
      assert.equal(avancado.tier, 'avancado');
      assert.equal(avancado.duration_months, 1);
      assert.equal(avancado.daily_coins, 100);
      assert.equal(avancado.tutor_monthly_tokens, 5000000);
    });

    it('o status da assinatura diz o nível e a duração do plano atual', async () => {
      const aluno = await ctx.registerStudent();
      await assinar(aluno.user.id, planos['pro-6-meses']);
      const res = await aluno.agent.get('/api/billing/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.subscription.plan_tier, 'pro');
      assert.equal(res.body.subscription.plan_duration_months, 6);
    });

    it('o painel grava o nível, mantém quando o formulário não manda e recusa nível inventado', async () => {
      const admin = await ctx.loginAdmin();
      const base = {
        name: 'Pro trimestral',
        price_cents: 13990,
        currency: 'brl',
        interval: 'month',
        interval_count: 3,
        duration_months: 3,
        features: [],
        active: true,
        sort_order: 50,
      };

      const criado = await admin.agent.post('/api/admin/plans', { ...base, tier: 'pro' });
      assert.equal(criado.status, 201, JSON.stringify(criado.body));
      assert.equal(criado.body.tier, 'pro');

      // Formulário antigo, sem o campo: o nível não pode sumir junto.
      const semCampo = await admin.agent.put(`/api/admin/plans/${criado.body.id}`, { ...base, price_cents: 14990 });
      assert.equal(semCampo.status, 200, JSON.stringify(semCampo.body));
      assert.equal(semCampo.body.tier, 'pro');
      assert.equal(semCampo.body.price_cents, 14990);

      const semNivel = await admin.agent.put(`/api/admin/plans/${criado.body.id}`, { ...base, tier: null });
      assert.equal(semNivel.status, 200);
      assert.equal(semNivel.body.tier, null);

      const inventado = await admin.agent.post('/api/admin/plans', { ...base, name: 'Ouro', tier: 'ouro' });
      assert.equal(inventado.status, 400);
      assert.equal(inventado.body.error.code, 'validation_error');
    });
  });

  // -------------------------------------------------------------------------
  describe('os 9 planos do seed', () => {
    const seedPlans = require('../server/db/seed/data/plans');
    const seed = require('../server/db/seed/run');

    /** Só a etapa dos planos do seed, no modo normal ou no --force-plans. */
    const semearPlanos = (forcePlans) =>
      ctx.db.tx((client) => seed.seedPlans(client, { forcePlans, summary: { upsert() {} } }));

    it('são três níveis em três durações, com os preços da tabela', () => {
      const tabela = {
        'basico-mensal': ['basico', 2990, 3990, 1, 0, false],
        'basico-6-meses': ['basico', 15990, 23940, 6, 1, false],
        'basico-12-meses': ['basico', 27990, 47880, 12, 1, false],
        'pro-mensal': ['pro', 4990, 5990, 1, 0, true],
        'pro-6-meses': ['pro', 26990, 35940, 6, 1, true],
        'pro-12-meses': ['pro', 44990, 71880, 12, 1, true],
        'avancado-mensal': ['avancado', 6990, 7990, 1, 0, false],
        'avancado-6-meses': ['avancado', 36990, 47940, 6, 1, false],
        'avancado-12-meses': ['avancado', 59990, 95880, 12, 1, false],
      };
      assert.deepEqual(seedPlans.map((p) => p.slug).sort(), Object.keys(tabela).sort());
      for (const p of seedPlans) {
        const [tier, price, compare, duration, trial, destaque] = tabela[p.slug];
        assert.equal(p.tier, tier, p.slug);
        assert.equal(p.price_cents, price, p.slug);
        assert.equal(p.compare_price_cents, compare, p.slug);
        assert.equal(p.duration_months, duration, p.slug);
        assert.equal(p.interval_count, duration, p.slug);
        // 12 meses dá 1 mês de bônus (13 meses de acesso); os outros, nenhum
        assert.equal(p.bonus_months, duration === 12 ? 1 : 0, p.slug);
        assert.equal(p.trial_days, trial, p.slug);
        assert.equal(p.highlight, destaque, p.slug);
        assert.equal(p.badge, destaque ? 'Mais escolhido' : null, p.slug);
        // o número de moedas nunca vai no texto do plano: vem das configurações
        assert.ok(!p.features.some((f) => /\d/.test(f)), `${p.slug}: feature com número`);
      }
    });

    it('o seed grava o nível e não reativa plano que o painel desligou', async () => {
      await ctx.resetDb();
      await semearPlanos(false);
      const gravados = await ctx.db.many(`SELECT slug, tier, active FROM plans ORDER BY sort_order`);
      assert.equal(gravados.length, 9);
      assert.ok(gravados.every((p) => p.active && p.tier));

      // O seed normal não mexe em plano que já existe...
      await ctx.db.query(`UPDATE plans SET active = false, tier = NULL, price_cents = 1 WHERE slug = 'pro-mensal'`);
      await semearPlanos(false);
      const intocado = await ctx.db.one(`SELECT tier, active, price_cents FROM plans WHERE slug = 'pro-mensal'`);
      assert.deepEqual(intocado, { tier: null, active: false, price_cents: 1 });

      // ...e o --force-plans reaplica preço e nível, mas não liga de volta o
      // que o painel desligou.
      await semearPlanos(true);
      const pro = await ctx.db.one(`SELECT tier, active, price_cents FROM plans WHERE slug = 'pro-mensal'`);
      assert.equal(pro.tier, 'pro');
      assert.equal(pro.price_cents, 4990);
      assert.equal(pro.active, false);
      await ctx.resetDb();
    });
  });
});

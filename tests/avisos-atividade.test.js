'use strict';

/**
 * Avisos de atividade real na página inicial ("Ana, que estuda para o ENEM,
 * assinou o Pro · há 2 horas").
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/avisos-atividade.test.js
 *
 * É prova social: o que não pode acontecer é mostrar algo que não houve ou
 * expor mais do que o primeiro nome. Por isso o foco é no que fica de fora —
 * renovação como se fosse compra, cortesia, equipe, conta bloqueada, teste
 * não pago, compra pendente, upgrade que não trocou o plano, quem desligou os
 * avisos no perfil, nome que não é nome — e na lista que volta vazia quando
 * os avisos estão desligados ou quando não há avisos reais suficientes.
 * Também: o nível da compra é o comprado (não o de depois do upgrade), a
 * janela em dias, a hora cheia no lugar do minuto, o limite de 20, e a rota
 * do perfil que grava a escolha do aluno.
 *
 * Os casos em que a linha de subscriptions deixa de contar a primeira compra
 * — aluno antigo com linha nova, Pix reaproveitado, pagamento reprocessado —
 * passam pelo código de pagamento de verdade (payments), não por INSERT à mão:
 * a regra dos avisos precisa bater com o que ele grava.
 *
 * No fim, o texto do balão (public/js/landing.js): o artigo de cada prova e os
 * dias contados pelo calendário.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const activity = require('../server/services/activity');
const payments = require('../server/services/payments');
const { invalidateLandingCache } = require('../server/routes/landing');

describe('Avisos de atividade na página inicial', () => {
  let ctx;
  let db;
  let ids;
  let seq = 0;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
  });

  after(async () => {
    await ctx.close();
  });

  /** Provas e planos de cada teste; cada teste começa com o banco limpo. */
  beforeEach(async () => {
    await ctx.resetDb();
    invalidateLandingCache();
    const enem = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1) RETURNING id`
    );
    const barro = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('barro-branco', 'Academia do Barro Branco', 'Barro Branco', 'barro_branco', 2) RETURNING id`
    );
    const plano = async (slug, name, tier, price) =>
      (
        await db.one(
          `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, tier, active)
           VALUES ($1, $2, $3, 'brl', 'month', 1, 1, $4, true) RETURNING id`,
          [slug, name, price, tier]
        )
      ).id;
    ids = {
      enem: enem.id,
      barro: barro.id,
      basico: await plano('basico-mensal', 'Básico Mensal', 'basico', 2990),
      pro: await plano('pro-mensal', 'Pro Mensal', 'pro', 4990),
      avancado: await plano('avancado-mensal', 'Avançado Mensal', 'avancado', 6990),
      antigo: await plano('mensal', 'Mensal', null, 3990),
    };
    // Nos testes de inclusão, um aviso já basta; o mínimo tem teste próprio.
    await settings.setSetting('activity_feed_min_events', 1);
  });

  /** Aluno direto no banco, com a prova no perfil. */
  async function aluno(name, { role = 'student', status = 'active', exam = ids.enem, show = true, override = null } = {}) {
    seq += 1;
    const row = await db.one(
      `INSERT INTO users (name, email, password_hash, role, status, show_in_activity, access_override_until)
       VALUES ($1, $2, 'x', $3, $4, $5, $6) RETURNING id`,
      [name, `aviso${seq}@teste.focoelite.com.br`, role, status, show, override]
    );
    await db.query('INSERT INTO student_profiles (user_id, exam_id) VALUES ($1, $2)', [row.id, exam]);
    return row.id;
  }

  /**
   * Assinatura no cartão com a idade informada, e o checkout que o aluno
   * abriu minutos antes (como na compra de verdade). `pagoHa` nulo = nunca
   * pagou (teste de 24h, primeira cobrança pendente); por padrão, pagou
   * quando nasceu.
   */
  async function assinatura(userId, { plan = ids.pro, status = 'active', criadaHa = '2 hours', pagoHa } = {}) {
    seq += 1;
    const pago = pagoHa === undefined ? criadaHa : pagoHa;
    await db.query(
      `INSERT INTO payment_checkouts (provider, provider_checkout_id, provider_subscription_id, user_id, plan_id,
                                      payment_method, status, created_at)
       VALUES ('asaas', $1, $2, $3, $4, 'credit_card', 'completed', now() - $5::interval - interval '5 minutes')`,
      [`chk_aviso_${seq}`, `sub_aviso_${seq}`, userId, plan, criadaHa]
    );
    const row = await db.one(
      `INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, payment_method, status,
                                  created_at, last_payment_at, current_period_start, current_period_end)
       VALUES ($1, $2, 'asaas', $6, 'credit_card', $3, now() - $4::interval,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $5::interval END,
               now() - $4::interval, now() + interval '25 days')
       RETURNING id`,
      [userId, plan, status, criadaHa, pago, `sub_aviso_${seq}`]
    );
    return row.id;
  }

  /**
   * Pix pago pelo caminho de produção: o aluno abre o checkout e o
   * CHECKOUT_PAID do Asaas cria (ou reaproveita) a linha da assinatura.
   * @returns a linha de subscriptions do Pix, depois do pagamento
   */
  async function pixPago(userId, planId) {
    seq += 1;
    const checkout = `chk_pix_${seq}`;
    await db.query(
      `INSERT INTO payment_checkouts (provider, provider_checkout_id, user_id, plan_id, payment_method)
       VALUES ('asaas', $1, $2, $3, 'pix')`,
      [checkout, userId, planId]
    );
    const payload = { id: `evt_${checkout}`, event: 'CHECKOUT_PAID', checkout: { id: checkout, status: 'PAID' } };
    await db.tx((tx) =>
      payments.applyAsaasCheckoutEvent(tx, { provider: 'asaas', event_id: payload.id, type: 'CHECKOUT_PAID', payload })
    );
    return db.one('SELECT * FROM subscriptions WHERE user_id = $1 AND provider_subscription_id IS NULL', [userId]);
  }

  /** Estorno do Pix pelo caminho de produção (PAYMENT_REFUNDED da cobrança avulsa). */
  async function estornoPix(userId, planId) {
    seq += 1;
    const payload = {
      id: `evt_estorno_${seq}`,
      event: 'PAYMENT_REFUNDED',
      payment: {
        object: 'payment',
        id: `pay_estorno_${seq}`,
        subscription: null,
        value: 29.9,
        billingType: 'PIX',
        status: 'REFUNDED',
        externalReference: `${userId}:${planId}`,
      },
    };
    await db.tx((tx) =>
      payments.applyAsaasEvent(tx, { provider: 'asaas', event_id: payload.id, type: 'PAYMENT_REFUNDED', payload })
    );
  }

  /** Leva a compra do aluno (assinatura e checkouts) para o passado, como se tivesse sido feita há `ha`. */
  async function envelhecer(userId, ha) {
    await db.query(
      `UPDATE subscriptions
          SET created_at = created_at - $2::interval,
              current_period_start = current_period_start - $2::interval,
              current_period_end = current_period_end - $2::interval,
              last_payment_at = last_payment_at - $2::interval,
              canceled_at = canceled_at - $2::interval
        WHERE user_id = $1`,
      [userId, ha]
    );
    await db.query('UPDATE payment_checkouts SET created_at = created_at - $2::interval WHERE user_id = $1', [userId, ha]);
  }

  /**
   * Pedido de upgrade no estado informado. `aplicadoHa` nulo = pago sem troca.
   * Por padrão foi pago na hora em que foi aplicado (ou há 1 hora, se não foi).
   */
  async function upgrade(
    userId,
    subscriptionId,
    { from = ids.basico, to = ids.pro, status = 'paid', aplicadoHa = '1 hour', pagoHa } = {}
  ) {
    const pago = pagoHa || aplicadoHa || '1 hour';
    await db.query(
      `INSERT INTO plan_changes (user_id, subscription_id, from_plan_id, to_plan_id, amount_cents, status,
                                 paid_at, applied_at, created_at)
       VALUES ($1, $2, $3, $4, 2000, $5,
               CASE WHEN $5 IN ('paid', 'refunded') THEN now() - $7::interval END,
               CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::interval END,
               now() - $7::interval - interval '10 minutes')`,
      [userId, subscriptionId, from, to, status, aplicadoHa, pago]
    );
  }

  /** Avisos como a página inicial recebe. */
  async function landingActivity() {
    invalidateLandingCache();
    const res = await ctx.request('GET', '/api/landing');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.activity), 'activity deveria ser sempre uma lista');
    return res.body.activity;
  }

  const nomes = (list) => list.map((item) => item.first_name);

  // -------------------------------------------------------------------------
  // O que aparece
  // -------------------------------------------------------------------------
  it('compra paga aparece com primeiro nome, prova, nível e hora, e nada além disso', async () => {
    const ana = await aluno('ana souza');
    await assinatura(ana, { plan: ids.pro, criadaHa: '2 hours 17 minutes' });

    const list = await landingActivity();
    assert.equal(list.length, 1, JSON.stringify(list));
    const [item] = list;
    assert.deepEqual(Object.keys(item).sort(), ['at', 'exam_short_name', 'first_name', 'kind', 'tier', 'tier_label']);
    assert.equal(item.first_name, 'Ana');
    assert.equal(item.exam_short_name, 'ENEM');
    assert.equal(item.kind, 'subscribed');
    assert.equal(item.tier, 'pro');
    assert.equal(item.tier_label, 'Pro');

    const payload = JSON.stringify(list);
    for (const leak of ['souza', 'Souza', '@teste.focoelite', ana, '4990', '49,90']) {
      assert.ok(!payload.includes(leak), `o aviso vazou "${leak}"`);
    }
  });

  it('sem prova no perfil, o aviso sai sem o trecho da prova', async () => {
    const bia = await aluno('Bia', { exam: null });
    await assinatura(bia);
    const [item] = await activity.recentActivity();
    assert.equal(item.first_name, 'Bia');
    assert.equal(item.exam_short_name, null);
  });

  it('plano antigo, sem nível, aparece como compra sem nível', async () => {
    const caio = await aluno('Caio Lima', { exam: ids.barro });
    await assinatura(caio, { plan: ids.antigo });
    const [item] = await activity.recentActivity();
    assert.equal(item.kind, 'subscribed');
    assert.equal(item.tier, null);
    assert.equal(item.tier_label, null);
    assert.equal(item.exam_short_name, 'Barro Branco');
  });

  it('assinatura com pagamento atrasado (past_due) continua sendo compra paga', async () => {
    const duda = await aluno('Duda');
    await assinatura(duda, { status: 'past_due' });
    assert.deepEqual(nomes(await activity.recentActivity()), ['Duda']);
  });

  it('upgrade pago e aplicado aparece como "subiu", e a compra mostra o nível comprado', async () => {
    const pedro = await aluno('Pedro Henrique');
    // comprou o Básico há 3 dias e subiu para o Avançado há 1 hora: a
    // assinatura agora aponta para o Avançado, mas a compra foi do Básico
    const sub = await assinatura(pedro, { plan: ids.avancado, criadaHa: '3 days' });
    await upgrade(pedro, sub, { from: ids.basico, to: ids.avancado, aplicadoHa: '1 hour' });

    const list = await activity.recentActivity();
    assert.deepEqual(
      list.map((item) => [item.first_name, item.kind, item.tier]),
      [
        ['Pedro', 'upgraded', 'avancado'],
        ['Pedro', 'subscribed', 'basico'],
      ]
    );
    assert.equal(list[0].tier_label, 'Avançado');
  });

  it('upgrade pago sem troca, pendente, estornado ou de assinatura estornada não aparece', async () => {
    const semTroca = await aluno('Sergio');
    await upgrade(semTroca, await assinatura(semTroca, { criadaHa: '40 days' }), { aplicadoHa: null });
    const pendente = await aluno('Paula');
    await upgrade(pendente, await assinatura(pendente, { criadaHa: '40 days' }), { status: 'pending', aplicadoHa: null });
    const estornado = await aluno('Rita');
    await upgrade(estornado, await assinatura(estornado, { criadaHa: '40 days' }), { status: 'refunded' });
    const cancelada = await aluno('Tales');
    await upgrade(cancelada, await assinatura(cancelada, { criadaHa: '40 days', status: 'canceled' }));

    assert.deepEqual(await activity.recentActivity(), []);
  });

  // -------------------------------------------------------------------------
  // O que nunca aparece
  // -------------------------------------------------------------------------
  it('renovação não vira "assinou": vale a data em que a assinatura nasceu', async () => {
    const ana = await aluno('Ana');
    // assinou há 40 dias; o cartão renovou há 1 hora
    await assinatura(ana, { criadaHa: '40 days', pagoHa: '1 hour' });
    assert.deepEqual(await activity.recentActivity(), []);
  });

  it('quem já pagou outra assinatura antes e volta com uma linha nova não vira "assinou"', async () => {
    // Ana assina no cartão desde março; a renovação foi recusada (past_due) e
    // ela pagou o mês no Pix. O Pix não enxerga a linha do cartão e cria outra,
    // mas é a mesma aluna continuando.
    const ana = await aluno('Ana');
    await assinatura(ana, { criadaHa: '200 days', pagoHa: '40 days', status: 'past_due' });
    const pix = await pixPago(ana, ids.pro);
    assert.equal(pix.status, 'active');
    const linhas = await db.one('SELECT count(*)::int AS total FROM subscriptions WHERE user_id = $1', [ana]);
    assert.equal(linhas.total, 2, 'o Pix criou uma linha nova ao lado da do cartão');

    // Caio cancelou o cartão, o período acabou e ele voltou com outro checkout
    const caio = await aluno('Caio');
    await assinatura(caio, { criadaHa: '100 days', pagoHa: '70 days', status: 'canceled' });
    await assinatura(caio, { criadaHa: '3 hours' });

    assert.deepEqual(await activity.recentActivity(), []);

    // teste de 24h que nunca foi pago não é compra anterior
    const lia = await aluno('Lia');
    await assinatura(lia, { criadaHa: '30 days', pagoHa: null, status: 'canceled' });
    await assinatura(lia, { criadaHa: '2 hours' });
    assert.deepEqual(nomes(await activity.recentActivity()), ['Lia']);
  });

  it('Pix reaproveitado não junta a data de uma compra com o nível de outra', async () => {
    await settings.setSetting('activity_feed_days', 90);

    // Bruno comprou o Básico no Pix há 8 dias, pediu estorno no dia seguinte
    // e hoje comprou o Pro. O Pix reaproveita a linha: plano novo, created_at
    // da compra estornada.
    const bruno = await aluno('Bruno');
    const primeira = await pixPago(bruno, ids.basico);
    await envelhecer(bruno, '8 days');
    await estornoPix(bruno, ids.basico);
    await db.query(`UPDATE subscriptions SET canceled_at = now() - interval '7 days' WHERE id = $1`, [primeira.id]);
    const recompra = await pixPago(bruno, ids.pro);
    assert.equal(recompra.id, primeira.id, 'o Pix reaproveitou a linha');
    assert.equal(recompra.plan_id, ids.pro);
    assert.equal(recompra.status, 'active');

    // Duda comprou o Básico de um mês há 45 dias; o período acabou e hoje ela
    // comprou o Avançado (janela de 90 dias: o created_at antigo ainda entra)
    const duda = await aluno('Duda');
    await pixPago(duda, ids.basico);
    await envelhecer(duda, '45 days');
    const volta = await pixPago(duda, ids.avancado);
    assert.equal(volta.plan_id, ids.avancado);

    // Gil comprou e pediu estorno de manhã, e comprou de novo à tarde
    const gil = await aluno('Gil');
    const manha = await pixPago(gil, ids.basico);
    await envelhecer(gil, '5 hours');
    await estornoPix(gil, ids.basico);
    await db.query(`UPDATE subscriptions SET canceled_at = now() - interval '4 hours' WHERE id = $1`, [manha.id]);
    await pixPago(gil, ids.pro);

    assert.deepEqual(await activity.recentActivity(), []);

    // A primeira compra do Pix, ainda no período dela, aparece — mesmo com o
    // "cancelar" do aluno, que no Pix só avisa que não vai renovar.
    const ivo = await aluno('Ivo');
    const compra = await pixPago(ivo, ids.pro);
    await envelhecer(ivo, '1 hour');
    await db.query(
      `UPDATE subscriptions
          SET cancel_at_period_end = true, canceled_at = current_period_start + interval '10 minutes'
        WHERE id = $1`,
      [compra.id]
    );
    const list = await activity.recentActivity();
    assert.deepEqual(list.map((item) => [item.first_name, item.kind, item.tier]), [['Ivo', 'subscribed', 'pro']]);
  });

  it('pagamento reprocessado pelo painel dias depois não vira "assinou há menos de 1 hora"', async () => {
    const admin = await ctx.loginAdmin();
    const dezDias = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    // Rui pagou o Pix há 10 dias; o CHECKOUT_PAID chegou e foi descartado
    const rui = await aluno('Rui');
    await db.query(
      `INSERT INTO payment_checkouts (provider, provider_checkout_id, user_id, plan_id, payment_method, created_at)
       VALUES ('asaas', 'chk_orfao', $1, $2, 'pix', now() - interval '10 days')`,
      [rui, ids.pro]
    );
    const eventoPix = { id: 'evt_orfao_pix', event: 'CHECKOUT_PAID', checkout: { id: 'chk_orfao', status: 'PAID' } };

    // Rosa assinou no cartão há 10 dias; a cobrança chegou e foi descartada
    const rosa = await aluno('Rosa');
    await db.query(
      `INSERT INTO payment_checkouts (provider, provider_checkout_id, user_id, plan_id, payment_method, created_at)
       VALUES ('asaas', 'chk_orfao_cartao', $1, $2, 'credit_card', now() - interval '10 days')`,
      [rosa, ids.basico]
    );
    const eventoCartao = {
      id: 'evt_orfao_cartao',
      event: 'PAYMENT_CONFIRMED',
      payment: {
        object: 'payment',
        id: 'pay_orfao_cartao',
        subscription: 'sub_orfao_cartao',
        value: 29.9,
        billingType: 'CREDIT_CARD',
        status: 'CONFIRMED',
        confirmedDate: dezDias,
        externalReference: `${rosa}:${ids.basico}`,
      },
    };
    for (const evento of [eventoPix, eventoCartao]) {
      await db.query(
        `INSERT INTO payment_events (provider, event_id, type, payload, processed_at)
         VALUES ('asaas', $1, $2, $3::jsonb, now() - interval '10 days')`,
        [evento.id, evento.event, JSON.stringify(evento)]
      );
    }

    const res = await admin.agent.post('/api/admin/subscriptions/reprocessar', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.liberados.length, 2, 'o reprocesso devolveu o acesso aos dois');
    assert.deepEqual(await activity.recentActivity(), []);

    // A mesma compra ao vivo, com o checkout aberto na hora, aparece
    const sara = await aluno('Sara');
    await pixPago(sara, ids.pro);
    assert.deepEqual(nomes(await activity.recentActivity()), ['Sara']);
  });

  it('upgrade aplicado num reprocesso dias depois do pagamento não vira "subiu há 1 hora"', async () => {
    const tito = await aluno('Tito');
    const sub = await assinatura(tito, { criadaHa: '40 days' });
    await upgrade(tito, sub, { to: ids.avancado, pagoHa: '5 days', aplicadoHa: '1 hour' });
    assert.deepEqual(await activity.recentActivity(), []);

    // pago e aplicado no mesmo dia (a data do Asaas vem sem hora) aparece
    const vera = await aluno('Vera');
    const outra = await assinatura(vera, { criadaHa: '40 days' });
    await upgrade(vera, outra, { to: ids.avancado, pagoHa: '14 hours', aplicadoHa: '1 hour' });
    assert.deepEqual(nomes(await activity.recentActivity()), ['Vera']);
  });

  it('cortesia, equipe, conta bloqueada, teste não pago e compra pendente não aparecem', async () => {
    // cortesia sem assinatura nenhuma
    await aluno('Carla', { override: new Date(Date.now() + 30 * 86400000) });
    // cortesia em vigor, mesmo com assinatura paga
    const cortesia = await aluno('Clara', { override: new Date(Date.now() + 30 * 86400000) });
    await assinatura(cortesia);
    const admin = await aluno('Adriana', { role: 'admin' });
    await assinatura(admin);
    const bloqueado = await aluno('Bruno', { status: 'blocked' });
    await assinatura(bloqueado);
    const teste = await aluno('Tiago');
    await assinatura(teste, { status: 'trialing', pagoHa: null });
    const pendente = await aluno('Patricia');
    await assinatura(pendente, { status: 'incomplete', pagoHa: null });
    // ativa sem pagamento registrado (acesso dado à mão) também não é compra
    const semPagamento = await aluno('Sofia');
    await assinatura(semPagamento, { status: 'active', pagoHa: null });
    // estornada
    const estornada = await aluno('Erica');
    await assinatura(estornada, { status: 'canceled' });

    assert.deepEqual(await activity.recentActivity(), []);
    assert.deepEqual(await landingActivity(), []);
  });

  it('cortesia que já acabou não esconde a compra paga depois dela', async () => {
    const lia = await aluno('Lia', { override: new Date(Date.now() - 5 * 86400000) });
    await assinatura(lia);
    assert.deepEqual(nomes(await activity.recentActivity()), ['Lia']);
  });

  it('quem desligou os avisos no perfil não aparece', async () => {
    const quieto = await aluno('Otavio', { show: false });
    const sub = await assinatura(quieto);
    await upgrade(quieto, sub, { to: ids.avancado });
    assert.deepEqual(await activity.recentActivity(), []);
  });

  // -------------------------------------------------------------------------
  // Nome
  // -------------------------------------------------------------------------
  it('só o primeiro nome, com a primeira letra maiúscula', async () => {
    await assinatura(await aluno('maria eduarda da silva'));
    await assinatura(await aluno('JOÃO PEDRO'), { criadaHa: '3 hours' });
    await assinatura(await aluno('  ana-clara   ramos '), { criadaHa: '4 hours' });

    const list = await activity.recentActivity();
    assert.deepEqual(nomes(list), ['Maria', 'João', 'Ana-Clara']);
    const payload = JSON.stringify(list);
    for (const leak of ['Eduarda', 'eduarda', 'silva', 'PEDRO', 'Pedro', 'ramos']) {
      assert.ok(!payload.includes(leak), `o aviso vazou "${leak}"`);
    }
  });

  it('nome vazio, de uma letra, com número ou com @ descarta o aviso', async () => {
    for (const [i, name] of ['   ', 'A', 'joao123', 'bia@gmail.com', 'x', '_bia_'].entries()) {
      await assinatura(await aluno(name), { criadaHa: `${i + 1} hours` });
    }
    assert.deepEqual(await activity.recentActivity(), []);

    assert.equal(activity.firstNameOf(''), null);
    assert.equal(activity.firstNameOf('J. Silva'), null);
    assert.equal(activity.firstNameOf('Lu'), 'Lu');
  });

  // -------------------------------------------------------------------------
  // Configuração e limites
  // -------------------------------------------------------------------------
  it('abaixo do mínimo de avisos reais, a lista volta vazia', async () => {
    await settings.setSetting('activity_feed_min_events', 3);
    await assinatura(await aluno('Ana'));
    await assinatura(await aluno('Bruna'), { criadaHa: '3 hours' });
    assert.deepEqual(await activity.recentActivity(), []);
    assert.deepEqual(await landingActivity(), []);

    // o terceiro aviso real libera os três — nada repetido para completar
    await assinatura(await aluno('Cris'), { criadaHa: '4 hours' });
    const list = await landingActivity();
    assert.deepEqual(nomes(list), ['Ana', 'Bruna', 'Cris']);
  });

  it('o mínimo conta só avisos que passam pelos filtros', async () => {
    await settings.setSetting('activity_feed_min_events', 3);
    await assinatura(await aluno('Ana'));
    await assinatura(await aluno('Bruna'), { criadaHa: '3 hours' });
    await assinatura(await aluno('joao123'), { criadaHa: '4 hours' });
    await assinatura(await aluno('Dora', { show: false }), { criadaHa: '5 hours' });
    assert.deepEqual(await activity.recentActivity(), []);
  });

  it('desligado no painel, a lista volta vazia', async () => {
    await assinatura(await aluno('Ana'));
    await settings.setSetting('activity_feed_enabled', false);
    assert.deepEqual(await activity.recentActivity(), []);
    assert.deepEqual(await landingActivity(), []);
  });

  it('fora da janela de dias fica de fora; aumentar a janela traz de volta', async () => {
    await assinatura(await aluno('Vera'), { criadaHa: '20 days' });
    const sub = await assinatura(await aluno('Ivo'), { criadaHa: '40 days' });
    const ivo = (await db.one('SELECT user_id FROM subscriptions WHERE id = $1', [sub])).user_id;
    await upgrade(ivo, sub, { aplicadoHa: '16 days' });

    assert.deepEqual(await activity.recentActivity(), [], 'a janela padrão é de 14 dias');

    await settings.setSetting('activity_feed_days', 30);
    const list = await activity.recentActivity();
    assert.deepEqual(list.map((item) => [item.first_name, item.kind]), [['Ivo', 'upgraded'], ['Vera', 'subscribed']]);
  });

  it('o momento sai na hora cheia, sem minuto nem segundo', async () => {
    await assinatura(await aluno('Ana'), { criadaHa: '2 hours 17 minutes 31 seconds' });
    const [item] = await landingActivity();
    const at = new Date(item.at);
    assert.match(item.at, /T\d{2}:00:00\.000Z$/);
    assert.equal(at.getUTCMinutes(), 0);
    const real = Date.now() - (2 * 3600 + 17 * 60 + 31) * 1000;
    assert.ok(at.getTime() <= real, 'a hora cheia é arredondada para baixo, nunca para o futuro');
    assert.ok(real - at.getTime() < 3600 * 1000, 'e fica dentro da mesma hora');

    assert.equal(activity.toHour('2026-09-29T14:47:31.250Z'), '2026-09-29T14:00:00.000Z');
    assert.equal(activity.toHour('2026-09-29T14:00:00.000Z'), '2026-09-29T14:00:00.000Z');
  });

  it('no máximo 20 avisos, do mais recente para o mais antigo', async () => {
    const nomesBase = [
      'Ana', 'Bia', 'Caio', 'Dani', 'Edu', 'Fabi', 'Gabi', 'Hugo', 'Iara', 'Joana', 'Kaio',
      'Lara', 'Mateus', 'Nina', 'Olga', 'Paulo', 'Quenia', 'Rafa', 'Sara', 'Tito', 'Ursula', 'Vini',
    ];
    for (const [i, name] of nomesBase.entries()) {
      await assinatura(await aluno(name), { criadaHa: `${i + 1} hours` });
    }
    const list = await landingActivity();
    assert.equal(list.length, 20);
    assert.deepEqual(nomes(list), nomesBase.slice(0, 20));
    const times = list.map((item) => new Date(item.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  // -------------------------------------------------------------------------
  // Perfil do aluno e painel
  // -------------------------------------------------------------------------
  it('a rota do perfil grava a saída dos avisos, e o aviso some na hora', async () => {
    const aluna = await ctx.registerStudent({ name: 'Helena Prado' });
    assert.equal(aluna.user.show_in_activity, true, 'aparecer é o padrão');
    await db.query('UPDATE student_profiles SET exam_id = $1 WHERE user_id = $2', [ids.enem, aluna.user.id]);
    await assinatura(aluna.user.id);
    assert.deepEqual(nomes(await landingActivity()), ['Helena']);

    // a landing já está em cache: sair dos avisos precisa valer sem esperar
    const off = await aluna.agent.put('/api/profile', { show_in_activity: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.user.show_in_activity, false);
    const row = await db.one('SELECT show_in_activity FROM users WHERE id = $1', [aluna.user.id]);
    assert.equal(row.show_in_activity, false);
    const cached = await ctx.request('GET', '/api/landing');
    assert.deepEqual(cached.body.activity, []);

    const me = await aluna.agent.get('/api/auth/me');
    assert.equal(me.body.user.show_in_activity, false);

    const on = await aluna.agent.put('/api/profile', { show_in_activity: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(nomes(await landingActivity()), ['Helena']);

    const invalid = await aluna.agent.put('/api/profile', { show_in_activity: 'talvez' });
    assert.equal(invalid.status, 400);
  });

  it('o painel grava as três chaves e recusa valores fora da faixa', async () => {
    const admin = await ctx.loginAdmin();
    const ok = await admin.agent.put('/api/admin/settings', {
      activity_feed_enabled: false,
      activity_feed_days: 30,
      activity_feed_min_events: 5,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.activity_feed_enabled, false);
    assert.equal(ok.body.activity_feed_days, 30);
    assert.equal(ok.body.activity_feed_min_events, 5);

    for (const body of [{ activity_feed_days: 0 }, { activity_feed_days: 91 }, { activity_feed_min_events: 21 }, { activity_feed_enabled: 'sim' }]) {
      const res = await admin.agent.put('/api/admin/settings', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} deveria ser recusado`);
    }
  });

  it('os padrões são: ligado, 14 dias e mínimo de 3', () => {
    assert.equal(settings.DEFAULTS.activity_feed_enabled, true);
    assert.equal(settings.DEFAULTS.activity_feed_days, 14);
    assert.equal(settings.DEFAULTS.activity_feed_min_events, 3);
  });
});

/**
 * As funções de texto do balão, tiradas de public/js/landing.js. O arquivo
 * inteiro não carrega fora do navegador (monta a página ao ser importado),
 * então só estes trechos, que não tocam no DOM, rodam aqui.
 */
function landingActivityText() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'landing.js'), 'utf8');
  const trecho = (inicio) => {
    const start = source.indexOf(inicio);
    assert.ok(start >= 0, `landing.js não tem mais "${inicio}"`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const code = [trecho('function activityWhen('), trecho('const EXAM_ARTICLES = {'), trecho('function activityExam(')];
  return vm.runInNewContext(`${code.join('\n')}\n({ activityWhen, activityExam });`);
}

describe('Texto do aviso na página inicial', () => {
  let text;

  before(() => {
    text = landingActivityText();
  });

  it('o artigo acompanha a prova, e prova sem artigo conhecido sai sem nenhum', () => {
    assert.equal(text.activityExam('ENEM'), ', que estuda para o ENEM,');
    assert.equal(text.activityExam('Barro Branco'), ', que estuda para o Barro Branco,');
    assert.equal(text.activityExam('Mackenzie'), ', que estuda para o Mackenzie,');
    for (const prova of ['FUVEST', 'UNICAMP', 'UNESP', 'FGV', 'PUC-SP']) {
      assert.equal(text.activityExam(prova), `, que estuda para a ${prova},`);
    }
    // prova cadastrada depois pelo painel: sem artigo, nunca no gênero errado
    assert.equal(text.activityExam('UFRJ'), ', que estuda para UFRJ,');
    assert.equal(text.activityExam(null), '');
    assert.equal(text.activityExam(''), '');
  });

  it('até 23 horas conta horas; depois, "ontem" e "há X dias" seguem o calendário', () => {
    // segunda, 28/09/2026, no fuso de quem vê a página
    const quando = (dia, hora, minuto = 0) => new Date(2026, 8, dia, hora, minuto);
    const segunda20h = quando(28, 20).toISOString();
    const vistoEm = (dia, hora, minuto) => text.activityWhen(segunda20h, quando(dia, hora, minuto).getTime());

    assert.equal(vistoEm(28, 20, 30), 'há menos de 1 hora');
    assert.equal(vistoEm(28, 21, 10), 'há 1 hora');
    assert.equal(vistoEm(29, 7), 'há 11 horas', 'virar o dia com menos de 24h continua em horas');
    assert.equal(vistoEm(29, 23), 'ontem');
    // 35 horas depois, na quarta de manhã: foi anteontem
    assert.equal(vistoEm(30, 7), 'há 2 dias');

    // segunda às 23h vista na quinta à 0h30 (49h): três dias de calendário
    const segunda23h = quando(28, 23).toISOString();
    const quinta0h30 = new Date(2026, 9, 1, 0, 30).getTime();
    assert.equal(text.activityWhen(segunda23h, quinta0h30), 'há 3 dias');
  });
});

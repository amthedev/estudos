'use strict';

/**
 * Painel de vendas e marketing (GET /api/admin/analytics).
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/analytics.test.js
 *
 * O que não pode quebrar: venda é pagamento de verdade (assinatura com
 * last_payment_at), não checkout aberto; a receita soma o preço do plano; a
 * origem agrupa pelo utm_source gravado no cadastro; e o painel não explode
 * quando não há nenhuma venda.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

async function criarPlano(db, { slug, name, price_cents }) {
  const row = await db.one(
    `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count, trial_days, features, highlight, sort_order, duration_months, bonus_months)
     VALUES ($1, $2, 'teste', $3, 'brl', 'month', 1, 0, '[]'::jsonb, false, 0, 1, 0)
     RETURNING id`,
    [slug, name, price_cents]
  );
  return row.id;
}

async function criarAluno(db, { email, tracking = null, created_at = null }) {
  const row = await db.one(
    `INSERT INTO users (name, email, password_hash, role, tracking, created_at)
     VALUES ('Aluno', $1, 'x', 'student', $2::jsonb, coalesce($3::timestamptz, now()))
     RETURNING id`,
    [email, tracking ? JSON.stringify(tracking) : null, created_at]
  );
  return row.id;
}

async function criarVenda(db, { userId, planId, method = 'pix', paidAt = null }) {
  await db.query(
    `INSERT INTO subscriptions (user_id, plan_id, provider, status, payment_method, last_payment_at, current_period_end)
     VALUES ($1, $2, 'asaas', 'active', $3, coalesce($4::timestamptz, now()), now() + interval '30 days')`,
    [userId, planId, method, paidAt]
  );
}

describe('Analytics: painel de vendas e marketing', () => {
  let ctx;
  let admin;
  let planoMensal;

  before(async () => {
    ctx = await createTestContext();
    admin = await ctx.loginAdmin();
    planoMensal = await criarPlano(ctx.db, { slug: 'mensal-a', name: 'Mensal', price_cents: 3990 });
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  it('exige admin', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics');
    assert.equal(res.status, 401);
  });

  it('painel vazio não quebra e zera os cards', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics?period=30', { cookie: admin.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.cards.vendas.value, 0);
    assert.equal(res.body.cards.receita.value, 0);
    assert.deepEqual(res.body.origem, []);
    assert.ok(Array.isArray(res.body.series.por_dia));
  });

  it('conta venda e soma receita; checkout aberto não vira venda', async () => {
    const a1 = await criarAluno(ctx.db, { email: `v1_${Date.now()}@t.com`, tracking: { utm_source: 'facebook', utm_campaign: 'promo1' } });
    const a2 = await criarAluno(ctx.db, { email: `v2_${Date.now()}@t.com`, tracking: { utm_source: 'facebook', utm_campaign: 'promo1' } });
    const a3 = await criarAluno(ctx.db, { email: `v3_${Date.now()}@t.com` }); // sem origem
    await criarVenda(ctx.db, { userId: a1, planId: planoMensal });
    await criarVenda(ctx.db, { userId: a2, planId: planoMensal });
    // a3 só tem checkout aberto, não pagou
    await ctx.db.query(
      `INSERT INTO payment_checkouts (provider, provider_checkout_id, user_id, plan_id, payment_method, status)
       VALUES ('asaas', $1, $2, $3, 'pix', 'pending')`,
      [`chk_${Date.now()}`, a3, planoMensal]
    );

    const res = await ctx.request('GET', '/api/admin/analytics?period=30', { cookie: admin.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.cards.vendas.value, 2, 'duas vendas pagas');
    assert.equal(res.body.cards.receita.value, 7980, '2 x 3990');
    assert.equal(res.body.cards.cadastros.value, 3, 'três cadastros');
    assert.equal(res.body.funil.checkouts, 1, 'um checkout aberto');
    assert.equal(res.body.funil.vendas, 2);
  });

  it('agrupa a origem por utm_source e separa quem veio sem UTM', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics?period=30', { cookie: admin.cookie });
    const fb = res.body.origem.find((o) => o.fonte === 'facebook');
    const direto = res.body.origem.find((o) => o.fonte === 'Direto / orgânico');
    assert.ok(fb, 'tem a linha do facebook');
    assert.equal(fb.cadastros, 2);
    assert.equal(fb.vendas, 2);
    assert.equal(fb.receita_cents, 7980);
    assert.ok(direto, 'tem a linha de quem veio sem UTM');
    assert.equal(direto.vendas, 0, 'o aluno sem origem não comprou');
  });

  it('ticket médio e conversão', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics?period=30', { cookie: admin.cookie });
    assert.equal(res.body.cards.ticket_medio.value, 3990, 'receita/vendas');
    // 2 vendas / 3 cadastros = 66.7%
    assert.equal(res.body.cards.conversao.value, 66.7);
  });

  it('venda fora do período não entra', async () => {
    const velho = await criarAluno(ctx.db, { email: `velho_${Date.now()}@t.com`, created_at: '2020-01-01' });
    await criarVenda(ctx.db, { userId: velho, planId: planoMensal, paidAt: '2020-01-01' });
    const res = await ctx.request('GET', '/api/admin/analytics?period=7', { cookie: admin.cookie });
    // a venda de 2020 não pode aparecer na janela de 7 dias
    assert.equal(res.body.cards.receita.value, 7980, 'só as duas vendas recentes');
  });

  it('últimas vendas lista aluno, plano, valor e origem', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics?period=30', { cookie: admin.cookie });
    assert.ok(res.body.ultimas_vendas.length >= 2);
    const v = res.body.ultimas_vendas[0];
    assert.ok('nome' in v && 'plano' in v && 'valor_cents' in v && 'fonte' in v && 'pago_em' in v);
  });

  it('exporta CSV de origem', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics/export?period=30&type=origem', { cookie: admin.cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    assert.match(res.text, /Fonte;Campanha;Cadastros;Vendas;Receita/);
    assert.match(res.text, /facebook/);
  });

  it('recusa período inválido', async () => {
    const res = await ctx.request('GET', '/api/admin/analytics?period=999', { cookie: admin.cookie });
    assert.equal(res.status, 400);
  });
});

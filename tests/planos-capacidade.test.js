'use strict';

/**
 * Vitrine de planos: quanto as moedas de cada plano rendem por dia.
 *
 *   NODE_ENV=test node --test tests/planos-capacidade.test.js
 *
 * "60 moedas por dia" não diz nada para quem vai comprar; "até 3 redações
 * corrigidas por dia" diz. A conta sai das configurações do painel (moedas do
 * nível ÷ custo da ação) e chega pronta nas duas rotas que a vitrine lê, para a
 * página nunca inventar número.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const coins = require('../server/services/coins');
const { invalidateLandingCache } = require('../server/routes/landing');

describe('Quanto cada plano rende por dia', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
    await ctx.db.query(
      `INSERT INTO plans (slug, name, price_cents, currency, interval, interval_count, duration_months, tier, sort_order, active) VALUES
         ('basico-mensal', 'Básico Mensal', 2990, 'brl', 'month', 1, 1, 'basico', 1, true),
         ('pro-mensal', 'Pro Mensal', 4990, 'brl', 'month', 1, 1, 'pro', 2, true),
         ('avancado-mensal', 'Avançado Mensal', 6990, 'brl', 'month', 1, 1, 'avancado', 3, true),
         ('antigo', 'Plano antigo', 3990, 'brl', 'month', 1, 1, NULL, 4, true)`
    );
    invalidateLandingCache();
  });

  after(async () => {
    await ctx.close();
  });

  it('a conta é moedas ÷ custo, arredondada para baixo; custo 0 é grátis', () => {
    const costs = { essay_correction: 20, simulado_long: 30, simulado_short: 10, practice: 2, questions: 0 };
    assert.deepEqual(coins.dailyCapacity(60, costs), {
      essay_corrections: 3, simulados_long: 2, simulados_short: 6, practices: 30, question_batches: null,
    });
    assert.equal(coins.dailyCapacity(30, costs).simulados_long, 1);
    assert.equal(coins.dailyCapacity(29, costs).simulados_long, 0);
    assert.equal(coins.dailyCapacity(null, costs), null);
  });

  it('/api/billing/plans traz o rendimento de cada nível pelas configurações', async () => {
    const res = await ctx.request('GET', '/api/billing/plans');
    assert.equal(res.status, 200);
    const bySlug = Object.fromEntries(res.body.map((plan) => [plan.slug, plan]));
    // padrões: 30/60/100 moedas; redação 20, simulado longo 30, curto 10, prática 2, questões 5
    assert.deepEqual(bySlug['basico-mensal'].daily_capacity, {
      essay_corrections: 1, simulados_long: 1, simulados_short: 3, practices: 15, question_batches: 6,
    });
    assert.equal(bySlug['pro-mensal'].daily_capacity.essay_corrections, 3);
    assert.equal(bySlug['avancado-mensal'].daily_capacity.essay_corrections, 5);
    assert.equal(bySlug['avancado-mensal'].daily_capacity.simulados_long, 3);
    assert.equal(bySlug.antigo.daily_capacity, null, 'plano sem nível não usa moedas');
  });

  it('muda sozinho quando o painel muda o custo, e a landing traz os custos', async () => {
    await settings.setSetting('coin_cost_essay_correction', 30);
    invalidateLandingCache();
    try {
      const planos = await ctx.request('GET', '/api/billing/plans');
      const pro = planos.body.find((plan) => plan.slug === 'pro-mensal');
      assert.equal(pro.daily_capacity.essay_corrections, 2);

      const landing = await ctx.request('GET', '/api/landing');
      assert.equal(landing.status, 200);
      assert.equal(landing.body.coin_costs.essay_correction, 30);
      assert.equal(landing.body.coin_costs.simulado_long, 30);
      const avancado = landing.body.plans.find((plan) => plan.slug === 'avancado-mensal');
      assert.equal(avancado.daily_capacity.essay_corrections, 3);
    } finally {
      await settings.setSetting('coin_cost_essay_correction', null);
      invalidateLandingCache();
    }
  });
});

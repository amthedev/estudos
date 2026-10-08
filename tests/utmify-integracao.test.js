'use strict';

/**
 * Integração da Utmify com o resto do sistema:
 *   - o cadastro grava a origem (UTMs) no usuário;
 *   - o webhook só conta como venda ('paid') o crédito novo, não o
 *     reprocessamento nem o evento sem efeito.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/utmify-integracao.test.js
 *
 * O envio HTTP em si não é exercido aqui: em teste o token da Utmify é vazio
 * por segurança (config), então sendOrder nunca chama a rede. O que importa
 * testar é a cadeia que leva até ele: a origem gravada e a decisão de quando
 * uma venda vira pedido.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const payments = require('../server/services/payments');

describe('Utmify: integração', () => {
  describe('creditouVenda: só o crédito novo vira venda', () => {
    it('pagamento confirmado com assinatura é venda', () => {
      assert.equal(payments.creditouVenda('PAYMENT_CONFIRMED', { subscription_id: 's1' }), true);
      assert.equal(payments.creditouVenda('PAYMENT_RECEIVED', { subscription_id: 's1' }), true);
      assert.equal(payments.creditouVenda('CHECKOUT_PAID', { subscription_id: 's1' }), true);
    });

    it('reprocessamento (unchanged) NÃO é venda', () => {
      assert.equal(
        payments.creditouVenda('PAYMENT_CONFIRMED', { subscription_id: 's1', unchanged: 'cobrança já creditada' }),
        false
      );
    });

    it('evento sem efeito (skipped) NÃO é venda', () => {
      assert.equal(payments.creditouVenda('PAYMENT_RECEIVED', { skipped: 'sem aluno' }), false);
    });

    it('resultado sem assinatura NÃO é venda', () => {
      assert.equal(payments.creditouVenda('PAYMENT_CONFIRMED', { skipped: 'x' }), false);
      assert.equal(payments.creditouVenda('PAYMENT_CONFIRMED', null), false);
    });

    it('evento que não concede período (ex.: cancelamento) NÃO é venda', () => {
      assert.equal(payments.creditouVenda('SUBSCRIPTION_CANCELED', { subscription_id: 's1' }), false);
    });
  });

  describe('cadastro grava a origem', () => {
    let ctx;
    before(async () => {
      ctx = await createTestContext();
    });
    after(async () => {
      if (ctx) await ctx.close();
    });

    it('register com tracking guarda só os campos conhecidos em users.tracking', async () => {
      const email = `utm_${Date.now()}@teste.com`;
      const res = await ctx.request('POST', '/api/auth/register', {
        body: {
          name: 'Aluna da Origem',
          email,
          password: 'senhaforte123',
          tracking: { utm_source: 'fb', utm_campaign: 'promo', lixo: 'ignora', sck: 'abc' },
        },
      });
      assert.equal(res.status, 201);

      const row = await ctx.db.one('SELECT tracking FROM users WHERE lower(email) = lower($1)', [email]);
      assert.ok(row && row.tracking, 'tracking foi gravado');
      assert.equal(row.tracking.utm_source, 'fb');
      assert.equal(row.tracking.utm_campaign, 'promo');
      assert.equal(row.tracking.sck, 'abc');
      assert.equal(row.tracking.lixo, undefined, 'campo estranho não é gravado');
    });

    it('register sem tracking deixa users.tracking nulo', async () => {
      const email = `semutm_${Date.now()}@teste.com`;
      const res = await ctx.request('POST', '/api/auth/register', {
        body: { name: 'Aluno Orgânico', email, password: 'senhaforte123' },
      });
      assert.equal(res.status, 201);
      const row = await ctx.db.one('SELECT tracking FROM users WHERE lower(email) = lower($1)', [email]);
      assert.equal(row.tracking, null);
    });

    it('register com tracking vazio (campos em branco) não grava objeto vazio', async () => {
      const email = `vazio_${Date.now()}@teste.com`;
      const res = await ctx.request('POST', '/api/auth/register', {
        body: {
          name: 'Aluno Sem Origem',
          email,
          password: 'senhaforte123',
          tracking: { utm_source: '', utm_campaign: '' },
        },
      });
      assert.equal(res.status, 201);
      const row = await ctx.db.one('SELECT tracking FROM users WHERE lower(email) = lower($1)', [email]);
      assert.equal(row.tracking, null);
    });
  });
});

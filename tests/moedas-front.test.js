'use strict';

/**
 * Moedas nas telas do aluno (public/js/core/coins.js).
 *
 *   NODE_ENV=test node --test tests/moedas-front.test.js
 *
 * O front mostra o custo antes do clique e o servidor cobra depois: se as duas
 * contas divergirem, o botão promete um preço e a carteira desconta outro. Este
 * arquivo guarda o contrato entre os dois lados — a régua do simulado, as chaves
 * de custo que as telas leem, os nomes dos níveis e os códigos de erro que abrem
 * o aviso de moedas.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverCoins = require('../server/services/coins');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');

const WALLET = Object.freeze({
  unlimited: false,
  tier: 'basico',
  tier_label: 'Básico',
  reason: 'plan',
  daily: 30,
  spent: 12,
  granted: 0,
  balance: 18,
  costs: {
    essay_correction: 20,
    simulado_short: 10,
    simulado_long: 30,
    simulado_short_max_questions: 30,
    practice: 2,
    questions: 5,
    essay_theme: 5,
  },
});

/** Todos os .js de public/js, para procurar as chaves de custo que as telas usam. */
function frontFiles(dir = PUBLIC_JS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return frontFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('Moedas nas telas do aluno', () => {
  let coins;

  before(async () => {
    // ui.js testa `instanceof Node` ao montar o html; fora do navegador basta
    // uma classe vazia para o módulo carregar (nada aqui é um nó do DOM).
    if (typeof globalThis.Node === 'undefined') globalThis.Node = class {};
    coins = await import(`file://${path.join(PUBLIC_JS, 'core', 'coins.js')}`);
  });

  it('o preço do simulado segue a mesma régua do servidor: vale o número de questões', () => {
    const limite = WALLET.costs.simulado_short_max_questions;
    for (const questoes of [1, 20, limite, limite + 1, 80, 90]) {
      const esperado = questoes <= limite ? WALLET.costs.simulado_short : WALLET.costs.simulado_long;
      assert.equal(coins.simuladoCost(questoes, WALLET), esperado, `${questoes} questões`);
    }
    // o limite ainda paga o curto (<=), como em services/coins.js
    assert.equal(coins.simuladoCost(30, WALLET), 10);
    assert.equal(coins.simuladoCost(31, WALLET), 30);
  });

  it('quem não gasta moeda não vê custo nenhum', () => {
    const ilimitado = { ...WALLET, unlimited: true, tier: null, balance: null, daily: null, reason: 'legacy' };
    const semNivel = { ...WALLET, tier: null, reason: 'none' };
    for (const carteira of [ilimitado, semNivel, null]) {
      assert.equal(coins.hasCoinLimit(carteira), false);
      assert.equal(coins.costFor('essay_correction', carteira), 0);
      assert.equal(coins.simuladoCost(80, carteira), 0);
    }
    assert.equal(String(coins.coinCost(coins.costFor('practice', ilimitado))), '');
  });

  it('o chip de custo mostra o número e diz o custo por extenso', () => {
    const chip = String(coins.coinCost(20));
    assert.match(chip, /class="coin-cost"/);
    assert.match(chip, /Custa 20 moedas/);
    assert.match(String(coins.coinCost(1)), /Custa 1 moeda"/);
    assert.equal(String(coins.coinCost(0)), '');
    assert.equal(String(coins.coinCost(-3)), '');
  });

  it('toda chave de custo que uma tela lê existe na carteira do servidor', () => {
    const usadas = new Set();
    for (const file of frontFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/costFor\(\s*'([a-z_]+)'/g)) usadas.add(m[1]);
    }
    assert.ok(usadas.size >= 5, 'as telas leem os custos pela carteira');
    for (const chave of usadas) {
      assert.ok(chave in serverCoins.COST_SETTINGS, `a chave '${chave}' não existe em COST_SETTINGS`);
    }
  });

  it('os nomes dos níveis são os mesmos do servidor', () => {
    for (const tier of serverCoins.TIERS) {
      assert.equal(coins.tierLabel(tier), serverCoins.TIER_LABELS[tier]);
    }
    assert.equal(coins.tierLabel(null), '');
  });

  it('só os erros de moedas e da cota do Tutor abrem o aviso de planos', () => {
    assert.equal(coins.isCoinError({ code: 'insufficient_coins' }), true);
    assert.equal(coins.isCoinError({ code: 'tutor_quota_reached' }), true);
    for (const code of ['payment_required', 'ai_unavailable', 'ai_limit_reached', 'already_charged', undefined]) {
      assert.equal(coins.isCoinError({ code }), false, String(code));
      // qualquer outro erro volta para a tela tratar do jeito de sempre, sem modal
      assert.equal(coins.handleCoinError({ code }), false, String(code));
    }
    assert.equal(coins.handleCoinError(null), false);
  });

  it('corrigir e gerar tema ignoram a cota do Tutor, mas respeitam o limite do mês de quem não gasta moedas', () => {
    // Status como o /api/tutor/status devolve em cada caso.
    const comNivelSemTutor = { configured: true, available: false, limit_reached: true, tutor_quota_reached: true };
    const comNivel = { configured: true, available: true, limit_reached: false, tutor_quota_reached: false };
    const ilimitadoNoLimite = { configured: true, available: false, limit_reached: true, tutor_quota_reached: false };
    const desligada = { configured: false, available: false, limit_reached: false, tutor_quota_reached: false };

    assert.equal(coins.aiActionBlock(comNivelSemTutor), null, 'quem limita a redação é a moeda, não a cota do Tutor');
    assert.equal(coins.aiActionBlock(comNivel), null);
    // o servidor recusaria a correção depois de a redação sair do rascunho
    assert.equal(coins.aiActionBlock(ilimitadoNoLimite), 'monthly_limit');
    assert.equal(coins.aiActionBlock(desligada), 'not_configured');
    assert.equal(coins.aiActionBlock(null), 'not_configured');
  });
});

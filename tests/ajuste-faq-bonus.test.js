'use strict';

/**
 * Ajuste único de outubro/2026: perguntas frequentes novas e 12 meses com 1 mês
 * de bônus (13 meses de acesso).
 *
 *   NODE_ENV=test node --test tests/ajuste-faq-bonus.test.js
 *
 * Simula o banco de produção de hoje (as perguntas antigas do seed, uma
 * pergunta a mais cadastrada no painel e os planos de 12 meses sem bônus) e
 * confere: as antigas saem do ar sem ser apagadas, as novas entram na ordem,
 * os 12 meses ganham o bônus sem mexer em preço nem nos outros planos, rodar de
 * novo não duplica nada, e a página mostra as respostas com os números do
 * painel no lugar de {{planos}}, {{moedas}} e {{custos}}.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { faqEBonusOutubro2026 } = require('../server/db/seed/ajustes');
const { faqs } = require('../server/db/seed/data/landing');
const { invalidateLandingCache, costsAsText, coinsAsText } = require('../server/routes/landing');

describe('Ajuste único: perguntas novas e 12 meses com bônus', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
    // como está em produção antes do ajuste
    await ctx.db.query(
      `INSERT INTO faqs (question, answer, sort_order, active) VALUES
         ('Quanto custa a Foco de Elite?', 'Você pode escolher entre os planos disponíveis:\n\n{{planos}}', 1, true),
         ('Como funciona o plano de 15 meses?', 'Você paga 12 e recebe mais 3 meses de bônus, totalizando 15 meses.', 2, true),
         ('Qual plano oferece a maior vantagem?', 'O plano de 15 meses.', 3, true),
         ('Pergunta que o Guilherme cadastrou', 'Resposta dele.', 12, true),
         ('Pergunta já desativada', 'Fica como está.', 13, false)`
    );
    await ctx.db.query(
      `INSERT INTO plans (slug, name, description, price_cents, currency, interval, interval_count, duration_months, bonus_months, tier, sort_order, active, features) VALUES
         ('basico-mensal', 'Básico Mensal', 'Mensal', 2990, 'brl', 'month', 1, 1, 0, 'basico', 11, true, '["Videoaulas completas"]'),
         ('basico-12-meses', 'Básico 12 meses', 'Antiga', 27990, 'brl', 'month', 12, 12, 0, 'basico', 13, true, '["Videoaulas completas"]'),
         ('pro-12-meses', 'Pro 12 meses', 'Antiga', 45000, 'brl', 'month', 12, 12, 0, 'pro', 23, true, '["Tudo do Básico"]'),
         ('avancado-12-meses', 'Avançado 12 meses', 'Antiga', 59990, 'brl', 'month', 12, 12, 0, 'avancado', 33, true, '["Tudo do Pro"]')`
    );
  });

  after(async () => {
    await ctx.close();
  });

  it('troca as perguntas e dá 1 mês de bônus aos planos de 12 meses', async () => {
    const resumo = await faqEBonusOutubro2026();
    assert.equal(resumo.planos, 3);
    assert.equal(resumo.perguntasDesativadas, 3, 'as duas do plano de 15 meses e a extra do painel');
    assert.equal(resumo.perguntasAtualizadas, 1, '"Quanto custa" já existia e recebe a resposta nova');
    assert.equal(resumo.perguntasCriadas, faqs.length - 1);

    const ativas = await ctx.db.many('SELECT question, answer FROM faqs WHERE active = true ORDER BY sort_order ASC');
    assert.deepEqual(ativas.map((row) => row.question), faqs.map((faq) => faq.question));
    assert.ok(!ativas.some((row) => /15 meses/.test(row.question + row.answer)), 'nada sobre o plano de 15 meses no ar');

    const antigas = await ctx.db.many(`SELECT question FROM faqs WHERE active = false ORDER BY question`);
    assert.equal(antigas.length, 4, 'desativadas, não apagadas: dá para reativar no painel');

    const planos = await ctx.db.many('SELECT slug, bonus_months, price_cents, features, description FROM plans ORDER BY sort_order');
    const bySlug = Object.fromEntries(planos.map((row) => [row.slug, row]));
    for (const slug of ['basico-12-meses', 'pro-12-meses', 'avancado-12-meses']) {
      assert.equal(bySlug[slug].bonus_months, 1, slug);
      assert.ok(!bySlug[slug].features.some((f) => /\d/.test(f)), 'recurso sem número: o bônus vem de bonus_months');
      assert.match(bySlug[slug].description, /13 meses de acesso/);
    }
    assert.equal(bySlug['pro-12-meses'].price_cents, 45000, 'o preço do painel não é tocado');
    assert.equal(bySlug['basico-mensal'].bonus_months, 0, 'os outros planos ficam como estão');
    assert.deepEqual(bySlug['basico-mensal'].features, ['Videoaulas completas']);
  });

  it('rodar de novo não duplica nem muda nada', async () => {
    await faqEBonusOutubro2026();
    const { total } = await ctx.db.one('SELECT count(*)::int AS total FROM faqs WHERE active = true');
    assert.equal(total, faqs.length);
    const { todas } = await ctx.db.one('SELECT count(*)::int AS todas FROM faqs');
    assert.equal(todas, faqs.length + 4);
  });

  it('a página mostra as respostas com os números do painel', async () => {
    invalidateLandingCache();
    const res = await ctx.request('GET', '/api/landing');
    assert.equal(res.status, 200);
    const porPergunta = Object.fromEntries(res.body.faqs.map((faq) => [faq.question, faq.answer]));

    const preco = porPergunta['Quanto custa a Foco de Elite?'];
    assert.match(preco, /Básico 12 meses — R\$\s?279,90 \(13 meses de acesso\)/);
    assert.doesNotMatch(preco, /\{\{/);

    const diferenca = porPergunta['Qual a diferença entre Básico, Pro e Avançado?'];
    assert.match(diferenca, /Básico — 30 moedas por dia\nPro — 60 moedas por dia\nAvançado — 100 moedas por dia/);

    const moedas = porPergunta['O que são as moedas?'];
    assert.match(moedas, /Correção de redação — 20 moedas/);
    assert.match(moedas, /Simulado curto \(até 30 questões\) — 10 moedas/);
    assert.match(moedas, /Simulado longo \(mais de 30 questões\) — 30 moedas/);
    assert.doesNotMatch(moedas, /\{\{/);
  });

  it('ação de custo 0 não entra na lista de custos, e sem moedas a lista some', () => {
    const texto = costsAsText({ essay_correction: 20, simulado_long: 30, simulado_short: 0, questions: 1, essay_theme: 0, practice: 2 });
    assert.equal(texto, 'Correção de redação — 20 moedas\nSimulado longo — 30 moedas\nLote de questões da IA — 1 moeda\nPrática da aula com IA — 2 moedas');
    assert.equal(coinsAsText({ basico: { daily_coins: 0 } }), '');
  });
});

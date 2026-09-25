'use strict';

/**
 * Cota de IA por aluno.
 *
 *   NODE_ENV=test node --test tests/ai-cota-por-aluno.test.js
 *
 * Antes o limite era um só para a plataforma inteira: dois ou três alunos
 * engajados esgotavam o teto e a IA desligava para todo mundo até o mês virar.
 *
 * O que não pode quebrar: o aluno que passa da cota fica sem IA; os OUTROS
 * alunos seguem normais; a equipe e as chamadas internas nunca são barradas;
 * o aviso do tutor ("limite atingido") aparece só para quem estourou; e cota 0
 * significa sem limite.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const ai = require('../server/services/ai');
const settings = require('../server/services/settings');

const COTA = 50_000;

describe('Cota de IA por aluno', () => {
  let ctx;
  let gastador;
  let colega;
  let admin;

  before(async () => {
    ctx = await createTestContext();
    gastador = await ctx.registerStudent({ name: 'Aluno Que Usa Muito' });
    colega = await ctx.registerStudent({ name: 'Colega de Turma' });
    admin = await ctx.loginAdmin();
    await settings.setSetting('ai_student_monthly_token_limit', COTA);
    // o gastador passa da cota; o admin também gasta muito (ler prova, gerar questões)
    for (const pessoa of [gastador, admin]) {
      await ai.recordUsage({
        userId: pessoa.user.id,
        feature: 'tutor',
        model: 'teste/modelo',
        usage: { prompt_tokens: COTA, completion_tokens: 10, total_tokens: COTA + 10 },
      });
    }
  });

  afterEach(async () => {
    await settings.setSetting('ai_student_monthly_token_limit', COTA);
  });

  after(async () => {
    await settings.setSetting('ai_student_monthly_token_limit', null);
    await ctx.close();
  });

  it('o aluno que passou da cota fica sem IA', async () => {
    await assert.rejects(() => ai.assertAvailable(gastador.user.id), /Limite mensal de uso da IA atingido/);
  });

  it('o colega segue usando normalmente', async () => {
    await ai.assertAvailable(colega.user.id);
    const resposta = await ai.chat({
      messages: [{ role: 'user', content: 'Me explica porcentagem?' }],
      userId: colega.user.id,
      feature: 'tutor',
    });
    assert.ok(resposta.content.length > 0);
  });

  it('a equipe e as chamadas internas nunca são barradas', async () => {
    await ai.assertAvailable(admin.user.id);
    await ai.assertAvailable(null);
  });

  it('o aviso do tutor aparece só para quem estourou', async () => {
    const dele = await gastador.agent.get('/api/tutor/status');
    assert.equal(dele.status, 200);
    assert.equal(dele.body.limit_reached, true);
    assert.equal(dele.body.available, false);

    const doColega = await colega.agent.get('/api/tutor/status');
    assert.equal(doColega.body.limit_reached, false);
    assert.equal(doColega.body.available, true);
  });

  it('cota 0 significa sem limite', async () => {
    await settings.setSetting('ai_student_monthly_token_limit', 0);
    await ai.assertAvailable(gastador.user.id);
  });
});

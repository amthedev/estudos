'use strict';

/**
 * Registro de uso da IA: chamada cancelada não é chamada bem-sucedida.
 *
 *   NODE_ENV=test node --test tests/ai-usage-abortada.test.js
 *
 * Existe por causa de uma investigação que andou uma hora na direção errada.
 * Durante a leitura de uma prova em produção, o painel mostrava "6 chamadas,
 * 48 mil tokens, 0 erros" — e nenhuma das seis tinha devolvido um único token:
 * todas morreram no tempo limite. O bloco que trata o cancelamento não marcava
 * erro, e o registro saía como 'ok' com os tokens do prompt estimados.
 *
 * O que não pode quebrar: cancelada tem que ser distinguível de bem-sucedida,
 * sem virar "erro" (aluno fechar o tutor é rotina), e os tokens do prompt
 * continuam contando, porque foram enviados e cobrados.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const ai = require('../server/services/ai');

let ctx;
let db;

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
});

after(async () => {
  await ctx.close();
});

afterEach(() => {
  ai.setClientForTests(null);
});

/** Cliente que nunca responde: quem chamar vai desistir pelo sinal. */
function clienteQueNaoResponde() {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const signal = options && options.signal;
          return new Promise((_, reject) => {
            const falhar = () => {
              const err = new Error('Chamada cancelada.');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal && signal.aborted) return falhar();
            if (signal) signal.addEventListener('abort', falhar, { once: true });
          });
        },
      },
    },
  };
}

describe('Chamada de IA cancelada', () => {
  it('fica registrada como cancelada, e não como sucesso', async () => {
    ai.setClientForTests(clienteQueNaoResponde());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    const resultado = await ai.chat({
      messages: [{ role: 'user', content: 'texto longo o suficiente para estimar tokens do prompt' }],
      signal: controller.signal,
      feature: 'other',
    });
    assert.equal(resultado.aborted, true);
    assert.equal(resultado.content, '', 'nada voltou');

    const linha = await db.one(`SELECT status, prompt_tokens, completion_tokens, error_message FROM ai_usage ORDER BY created_at DESC LIMIT 1`);
    assert.equal(linha.status, 'aborted', 'registrar como "ok" faz o painel mentir sobre o que aconteceu');
    assert.equal(linha.completion_tokens, 0, 'não veio resposta, logo não há token de resposta');
    assert.ok(linha.prompt_tokens > 0, 'o prompt foi enviado e cobrado: continua contando');
    assert.match(linha.error_message || '', /cancelad/i);
  });

  it('o painel separa cancelada de erro', async () => {
    const antes = await db.one(
      `SELECT count(*) FILTER (WHERE status = 'error')::int AS erros,
              count(*) FILTER (WHERE status = 'aborted')::int AS canceladas
         FROM ai_usage`
    );
    assert.ok(antes.canceladas >= 1);
    assert.equal(antes.erros, 0, 'cancelamento não pode encher a contagem de erros');

    const admin = await ctx.loginAdmin();
    const res = await admin.agent.get('/api/admin/ai/usage?days=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.totals.errors, 0);
    assert.ok(res.body.totals.aborted >= 1, 'a tela precisa conseguir mostrar isso');
  });

  it('provedor sem informar consumo não vira consumo zero', async () => {
    // Number(null) é ZERO, não NaN: escrito sem cuidado, o caso "o provedor não
    // mandou consumo" passava por número válido, a estimativa nunca rodava, e a
    // chamada entrava no teto mensal como se fosse de graça.
    ai.setClientForTests({
      chat: {
        completions: {
          async create() {
            return {
              model: 'teste/modelo',
              choices: [{ index: 0, message: { role: 'assistant', content: 'resposta com algum tamanho' }, finish_reason: 'stop' }],
              usage: null,
            };
          },
        },
      },
    });

    const texto = 'pergunta com tamanho suficiente para a estimativa fazer sentido';
    const res = await ai.chat({ messages: [{ role: 'user', content: texto }], feature: 'other' });
    assert.ok(res.usage.prompt_tokens > 0, 'o prompt foi enviado: tem que contar');
    assert.ok(res.usage.completion_tokens > 0, 'a resposta veio: tem que contar');

    const linha = await db.one(`SELECT prompt_tokens, total_tokens FROM ai_usage ORDER BY created_at DESC LIMIT 1`);
    assert.ok(linha.prompt_tokens > 0);
    assert.ok(linha.total_tokens > 0, 'senão o teto mensal não segura custo nenhum');
  });

  it('quando o provedor informa, o número dele é o que vale', async () => {
    ai.setClientForTests({
      chat: {
        completions: {
          async create() {
            return {
              model: 'teste/modelo',
              choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
            };
          },
        },
      },
    });
    const res = await ai.chat({ messages: [{ role: 'user', content: 'oi' }], feature: 'other' });
    assert.equal(res.usage.prompt_tokens, 123);
    assert.equal(res.usage.completion_tokens, 45);
    assert.equal(res.usage.total_tokens, 168);
  });

  it('chamada que responde continua sendo sucesso', async () => {
    const res = await ai.chat({ messages: [{ role: 'user', content: 'oi' }], feature: 'other' });
    assert.equal(res.aborted, false);
    const linha = await db.one(`SELECT status FROM ai_usage ORDER BY created_at DESC LIMIT 1`);
    assert.equal(linha.status, 'ok');
  });
});

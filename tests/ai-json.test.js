'use strict';

/**
 * Respostas JSON da IA: o que acontece quando vêm erradas.
 *
 *   NODE_ENV=test node --test tests/ai-json.test.js
 *
 * A geração de tema de redação falhava com "a IA devolveu uma resposta em
 * formato inválido". A causa não era o formato: o limite de tokens era curto
 * demais para a proposta mais os três textos motivadores, e a resposta chegava
 * cortada no meio do JSON. As duas situações pedem ações diferentes — uma é
 * limite, a outra é o modelo desobedecendo — e precisam de mensagens
 * diferentes, senão manda investigar o lugar errado.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../server/services/ai');

/** Cliente falso que devolve exatamente o conteúdo e o motivo de parada pedidos. */
function clienteQueResponde(content, finishReason = 'stop') {
  return {
    chat: {
      completions: {
        async create() {
          return {
            model: 'teste/modelo',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        },
      },
    },
  };
}

const pergunta = [{ role: 'user', content: 'devolva um JSON' }];

describe('Respostas JSON da IA', () => {
  afterEach(() => {
    ai.setClientForTests(null);
  });

  it('interpreta o JSON limpo', async () => {
    ai.setClientForTests(clienteQueResponde('{"title":"Um tema","prompt_text":"proposta"}'));
    const res = await ai.json({ messages: pergunta });
    assert.equal(res.data.title, 'Um tema');
    assert.equal(res.truncated, false);
  });

  it('tolera cerca de markdown em volta do JSON', async () => {
    ai.setClientForTests(clienteQueResponde('Claro!\n```json\n{"title":"Com cerca"}\n```\n'));
    const res = await ai.json({ messages: pergunta });
    assert.equal(res.data.title, 'Com cerca');
  });

  it('diz que a resposta foi CORTADA quando o modelo bate no limite', async () => {
    // É o caso real da geração de tema: o JSON começa certo e acaba no meio.
    const cortado = '{"title":"Tema longo","support_texts":"Texto I — a primeira parte do texto motiv';
    ai.setClientForTests(clienteQueResponde(cortado, 'length'));

    await assert.rejects(
      () => ai.json({ messages: pergunta }),
      (err) => {
        assert.match(err.message, /cortada/i, 'a mensagem precisa falar em resposta cortada');
        assert.match(err.message, /limite de tamanho/i, 'e apontar o limite como causa provável');
        assert.doesNotMatch(err.message, /formato inválido/i, 'não é um problema de formato');
        return true;
      }
    );
  });

  it('diz que o FORMATO está inválido quando o modelo devolve outra coisa', async () => {
    ai.setClientForTests(clienteQueResponde('Desculpe, não posso ajudar com isso.', 'stop'));

    await assert.rejects(
      () => ai.json({ messages: pergunta }),
      (err) => {
        assert.match(err.message, /formato inválido/i);
        assert.doesNotMatch(err.message, /cortada/i);
        return true;
      }
    );
  });

  it('marca truncated no resultado, mesmo quando o JSON cortado ainda dá para ler', async () => {
    // Um JSON pode fechar por acaso antes do corte. O sinal precisa continuar
    // visível para quem for investigar depois.
    ai.setClientForTests(clienteQueResponde('{"title":"Fechou por sorte"}', 'length'));
    const res = await ai.json({ messages: pergunta });
    assert.equal(res.data.title, 'Fechou por sorte');
    assert.equal(res.truncated, true);
  });
});

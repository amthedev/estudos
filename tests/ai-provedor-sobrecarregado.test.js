'use strict';

/**
 * Tutor: falha momentânea do provedor não pode chegar ao aluno.
 *
 *   NODE_ENV=test node --test tests/ai-provedor-sobrecarregado.test.js
 *
 * O caso real: o aluno manda "oi", recebe resposta, pergunta "qual a melhor
 * hora para estudar" e vê "A IA está sobrecarregada". No streaming o OpenRouter
 * responde 200 na hora e o 429 do provedor que roda o modelo chega DENTRO do
 * fluxo, onde o cliente HTTP não repetia. Uma segunda tentativa, um instante
 * depois, resolve.
 *
 * O que não pode quebrar: falha antes do primeiro trecho é repetida sem o aluno
 * ver; falha depois do primeiro trecho NÃO é repetida (duplicaria a resposta na
 * tela); erro que não é passageiro (chave inválida) sobe na hora; e se o
 * provedor seguir fora, o aluno recebe a mensagem de sempre.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const ai = require('../server/services/ai');

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

afterEach(() => {
  ai.setClientForTests(null);
});

function erroDoProvedor(status, message = 'Provider returned error') {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Cliente de streaming cujo roteiro diz o que cada chamada faz:
 * 'falha-no-inicio' → o erro chega antes de qualquer texto;
 * 'falha-no-meio'   → entrega um trecho e depois falha;
 * 'ok'              → entrega a resposta inteira.
 */
function clienteRoteirizado(roteiro, { status = 429 } = {}) {
  const chamadas = [];
  return {
    chamadas,
    chat: {
      completions: {
        async create() {
          const passo = roteiro[chamadas.length] || 'ok';
          chamadas.push(passo);
          return (async function* fluxo() {
            if (passo === 'falha-no-inicio') throw erroDoProvedor(status);
            yield { model: 'teste/modelo', choices: [{ delta: { content: 'De acordo com estudos, ' } }] };
            if (passo === 'falha-no-meio') throw erroDoProvedor(status);
            yield { choices: [{ delta: { content: 'o melhor horário é o que você mantém.' }, finish_reason: 'stop' }] };
          })();
        },
      },
    },
  };
}

async function perguntar(cliente) {
  ai.setClientForTests(cliente);
  const trechos = [];
  const resultado = await ai.chat({
    messages: [{ role: 'user', content: 'de acordo com estudos qual melhor hora pra estudar' }],
    stream: true,
    feature: 'tutor',
    onDelta: (texto) => trechos.push(texto),
  });
  return { resultado, trechos };
}

describe('Provedor da IA sobrecarregado', () => {
  it('falha antes do primeiro trecho é repetida e o aluno recebe a resposta', async () => {
    const cliente = clienteRoteirizado(['falha-no-inicio', 'ok']);
    const { resultado, trechos } = await perguntar(cliente);
    assert.deepEqual(cliente.chamadas, ['falha-no-inicio', 'ok']);
    assert.equal(resultado.content, 'De acordo com estudos, o melhor horário é o que você mantém.');
    assert.equal(trechos.join(''), resultado.content, 'o aluno não vê nada da tentativa que falhou');
  });

  it('aguenta duas falhas seguidas', async () => {
    const cliente = clienteRoteirizado(['falha-no-inicio', 'falha-no-inicio', 'ok']);
    const { resultado } = await perguntar(cliente);
    assert.equal(cliente.chamadas.length, 3);
    assert.match(resultado.content, /melhor horário/);
  });

  it('se o provedor seguir fora, o aluno recebe a mensagem de sobrecarga', async () => {
    const cliente = clienteRoteirizado(['falha-no-inicio', 'falha-no-inicio', 'falha-no-inicio', 'ok']);
    await assert.rejects(() => perguntar(cliente), /sobrecarregada/);
    assert.equal(cliente.chamadas.length, 3, 'para depois de duas novas tentativas');
  });

  it('falha depois do primeiro trecho não é repetida, para não duplicar a resposta', async () => {
    const cliente = clienteRoteirizado(['falha-no-meio', 'ok']);
    await assert.rejects(() => perguntar(cliente), /sobrecarregada/);
    assert.equal(cliente.chamadas.length, 1);
  });

  it('chave inválida não é repetida', async () => {
    const cliente = clienteRoteirizado(['falha-no-inicio', 'ok'], { status: 401 });
    await assert.rejects(() => perguntar(cliente), /chave inválida/);
    assert.equal(cliente.chamadas.length, 1);
  });
});

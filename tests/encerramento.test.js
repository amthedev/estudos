'use strict';

/**
 * Encerramento do servidor.
 *
 *   NODE_ENV=test node --test tests/encerramento.test.js
 *
 * Existe por causa de uma investigação inteira atrás de um defeito que não
 * existia. A leitura de prova morria em produção e o painel não registrava
 * nada; o uptime voltava para 8 segundos. Não era queda: era publicação.
 * Cada `git push` manda SIGTERM, e o encerramento de então (a) esperava as
 * requisições em curso, travando no SSE do Tutor até o prazo de 8 segundos,
 * (b) saía SEMPRE com código 1, que a hospedagem lê como "caiu", e (c) não
 * gravava uma linha sequer.
 *
 * O que não pode quebrar: parada pedida sai com código 0, queda sai com 1,
 * as duas deixam registro, e uma conexão aberta não segura o encerramento.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const RAIZ = path.join(__dirname, '..');

/** Sobe o servidor de verdade numa porta própria e espera ele responder. */
async function subirServidor(porta) {
  const filho = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(porta) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  filho.stdout.on('data', (p) => { saida += p.toString(); });
  filho.stderr.on('data', (p) => { saida += p.toString(); });

  for (let tentativa = 0; tentativa < 60; tentativa += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const vivo = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: porta, path: '/api/health' }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (vivo) return { filho, porta, saida: () => saida };
  }
  filho.kill('SIGKILL');
  throw new Error(`servidor não subiu na porta ${porta}: ${saida.slice(0, 400)}`);
}

const esperarSaida = (filho) =>
  new Promise((resolve) => filho.on('exit', (codigo, sinal) => resolve({ codigo, sinal })));

describe('Encerramento do servidor', () => {
  it('parada pedida sai com código 0 — e não como se tivesse caído', async () => {
    // Código 1 é o que a hospedagem lê como queda. Uma publicação saindo com 1
    // fazia toda publicação parecer um acidente nos registros.
    const s = await subirServidor(4181);
    const saiu = esperarSaida(s.filho);
    s.filho.kill('SIGTERM');
    const { codigo } = await Promise.race([
      saiu,
      new Promise((r) => setTimeout(() => r({ codigo: 'demorou' }), 12_000)),
    ]);
    assert.equal(codigo, 0, 'parada pedida não é queda');
  });

  it('uma conexão aberta não segura o encerramento até o prazo estourar', async () => {
    // Era isto que fazia o uptime aparecer como 8 segundos: o close() esperava
    // a conversa do Tutor terminar, e o prazo forçado matava o processo.
    const s = await subirServidor(4182);

    // Mantém uma conexão viva contra o servidor.
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: s.porta, path: '/api/health', agent: new http.Agent({ keepAlive: true }) }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });

    const t0 = Date.now();
    const saiu = esperarSaida(s.filho);
    s.filho.kill('SIGTERM');
    const { codigo } = await Promise.race([
      saiu,
      new Promise((r) => setTimeout(() => r({ codigo: 'demorou' }), 12_000)),
    ]);
    const segundos = (Date.now() - t0) / 1000;

    assert.equal(codigo, 0);
    assert.ok(segundos < 7, `encerrou em ${segundos.toFixed(1)}s; com conexão presa, batia no prazo de 8s`);
  });
});

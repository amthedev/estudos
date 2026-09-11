'use strict';

/**
 * Porta e host em que a aplicação escuta.
 *
 *   NODE_ENV=test node --test tests/config-port.test.js
 *
 * Este teste existe por causa do modo de falha da Square Cloud: ela só roteia o
 * tráfego da borda para a porta 80 do container, e uma aplicação escutando em
 * qualquer outra porta sobe normalmente, escreve um log limpo e deixa o
 * endereço dando timeout. Não há erro para investigar — então a regra que
 * escolhe a porta precisa estar coberta, para ninguém "simplificar" a detecção
 * depois e derrubar o site em silêncio.
 *
 * A configuração é carregada num diretório temporário, com uma cópia de
 * server/config.js e nenhum arquivo .env, porque é assim que a aplicação roda
 * na hospedagem: sem .env, só com as variáveis do painel. Carregar o config da
 * raiz do projeto leria o .env local e mascararia justamente o caso que
 * interessa.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = path.join(__dirname, '..');

describe('Porta e host da aplicação', () => {
  let temp;

  before(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'focoelite-config-'));
    fs.mkdirSync(path.join(temp, 'server'));
    fs.copyFileSync(path.join(raiz, 'server', 'config.js'), path.join(temp, 'server', 'config.js'));
    fs.copyFileSync(path.join(raiz, 'package.json'), path.join(temp, 'package.json'));
    fs.symlinkSync(path.join(raiz, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  });

  after(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  /** Carrega a configuração num processo limpo e devolve porta e host. */
  function carrega(env) {
    const saida = execFileSync(
      process.execPath,
      ['-e', 'const c = require("./server/config.js"); console.log(JSON.stringify({ port: c.port, host: c.host }))'],
      {
        cwd: temp,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: 'postgres://usuario:senha@host:5432/focoelite',
          JWT_SECRET: 'a'.repeat(48),
          ADMIN_JWT_SECRET: 'b'.repeat(48),
          ...env,
        },
      }
    );
    return JSON.parse(saida.trim().split('\n').pop());
  }

  it('escuta na 80 quando reconhece a Square Cloud', () => {
    // SQUARECLOUD_APP_ID é a única variável que a documentação da plataforma
    // afirma injetar sozinha; é por ela que a aplicação se reconhece lá.
    const { port, host } = carrega({ NODE_ENV: 'production', SQUARECLOUD_APP_ID: 'app-123' });
    assert.equal(port, 80);
    assert.equal(host, '0.0.0.0');
  });

  it('não depende de NODE_ENV para escolher a porta 80', () => {
    // A documentação da Square Cloud não menciona NODE_ENV em lugar nenhum.
    // Amarrar a porta a ela reintroduziria o timeout silencioso.
    assert.equal(carrega({ SQUARECLOUD_APP_ID: 'app-123' }).port, 80);
  });

  it('deixa a PORT explícita vencer a detecção', () => {
    // Sem isso a plataforma ficaria presa à Square Cloud.
    assert.equal(carrega({ SQUARECLOUD_APP_ID: 'app-123', PORT: '8080' }).port, 8080);
  });

  it('usa 4100 fora da Square Cloud', () => {
    assert.equal(carrega({}).port, 4100);
  });

  it('aceita um host diferente quando pedido', () => {
    assert.equal(carrega({ HOST: '127.0.0.1' }).host, '127.0.0.1');
  });
});

'use strict';

/**
 * Configuração da aplicação: porta, host, ambiente presumido e o que vai parar
 * no log quando um valor está errado.
 *
 *   NODE_ENV=test node --test tests/config.test.js
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

describe('Configuração da aplicação', () => {
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

  /** Carrega a configuração num processo limpo e devolve os valores públicos usados nos testes. */
  function carrega(env) {
    const saida = execFileSync(
      process.execPath,
      [
        '-e',
        'const c = require("./server/config.js"); console.log(JSON.stringify({ port: c.port, host: c.host, env: c.env, openrouter: { model: c.openrouter.model, essayModel: c.openrouter.essayModel } }))',
      ],
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

  /** Mesma carga, mas sem os segredos, para ver a aplicação recusar subir. */
  function semSegredos(env) {
    try {
      execFileSync(process.execPath, ['-e', 'require("./server/config.js")'], {
        cwd: temp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://usuario:senha@host:5432/focoelite', ...env },
      });
      return { erro: '' };
    } catch (err) {
      return { erro: String(err.stderr || err.message) };
    }
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

  it('usa o modelo econômico do OpenRouter no tutor e na redação', () => {
    const { openrouter } = carrega({});
    assert.equal(openrouter.model, 'qwen/qwen3.8-flash');
    assert.equal(openrouter.essayModel, 'qwen/qwen3.8-flash');
  });

  it('trata a hospedagem como produção quando NODE_ENV não vem', () => {
    // Presumir desenvolvimento numa hospedagem daria à aplicação os segredos
    // de sessão de desenvolvimento, que são previsíveis e estão publicados
    // neste repositório: o site subiria funcionando e aberto, sem erro nenhum.
    assert.equal(carrega({ SQUARECLOUD_APP_ID: 'app-123' }).env, 'production');
    assert.equal(carrega({}).env, 'development');
    assert.equal(carrega({ SQUARECLOUD_APP_ID: 'app-123', NODE_ENV: 'development' }).env, 'development');
  });

  it('recusa subir na hospedagem sem segredos de sessão', () => {
    const { erro } = semSegredos({ SQUARECLOUD_APP_ID: 'app-123' });
    assert.match(erro, /JWT_SECRET/);
    assert.match(erro, /ADMIN_JWT_SECRET/);
  });

  it('mostra o valor recebido para ajudar a achar o erro de digitação', () => {
    const { erro } = semSegredos({ APP_URL: 'focoelite.com.br' });
    assert.match(erro, /APP_URL/);
    assert.match(erro, /focoelite\.com\.br/);
    assert.match(erro, /https:\/\//); // o exemplo do formato certo
  });

  it('nunca escreve um valor secreto no log', () => {
    // O log de deploy da hospedagem é lido por quem tiver acesso ao painel, e
    // fica guardado lá. Um segredo recusado não pode vazar por causa da
    // mensagem de erro.
    const { erro } = semSegredos({ JWT_SECRET: 'curto-demais' });
    assert.match(erro, /JWT_SECRET/);
    assert.doesNotMatch(erro, /curto-demais/);
  });
});

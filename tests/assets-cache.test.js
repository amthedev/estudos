'use strict';

/**
 * Versão nos endereços dos estáticos.
 *
 *   NODE_ENV=test node --test tests/assets-cache.test.js
 *
 * A plataforma roda atrás do Cloudflare, que reescreve o cabeçalho de cache
 * dos arquivos estáticos para 31 dias no navegador — a aplicação pede 5
 * minutos e não é obedecida. Na prática, quem já tinha aberto o site continuava
 * com o JavaScript antigo por um mês: publicar correção não chegava a ninguém,
 * e a resposta virava "limpe o cache do navegador".
 *
 * O que não pode quebrar: o endereço dos estáticos tem que mudar quando os
 * arquivos mudam, a marca precisa se propagar pelos imports relativos dos
 * módulos, e o HTML tem que continuar saindo sem cache — senão o navegador
 * guardaria a página que aponta para a versão velha.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const assets = require('../server/utils/assets');
const config = require('../server/config');

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

describe('Marca de versão dos estáticos', () => {
  it('versiona o caminho, não a query — é o que faz o import relativo herdar a marca', () => {
    const html = assets.versionHtml('<script type="module" src="/js/app/shell.js"></script>', config.publicDir);
    const marca = assets.stamp(config.publicDir);
    assert.match(html, new RegExp(`src="/a/${marca}/js/app/shell\\.js"`));
    assert.doesNotMatch(html, /\?v=/, 'com query, só o primeiro arquivo seria versionado');

    // /a/<marca>/js/app/shell.js importando ../core/api.js resolve para
    // /a/<marca>/js/core/api.js — é disso que depende a árvore inteira.
    const base = new URL(`https://x/a/${marca}/js/app/shell.js`);
    assert.equal(new URL('../core/api.js', base).pathname, `/a/${marca}/js/core/api.js`);
  });

  it('alcança CSS, bibliotecas e imagens, e ignora o resto', () => {
    const marca = assets.stamp(config.publicDir);
    const html = assets.versionHtml(
      '<link href="/css/app.css"><script src="/vendor/chart.umd.js"></script>' +
        '<img src="/assets/brand/x.png"><a href="/app/aulas">aulas</a><a href="/api/health">api</a>',
      config.publicDir
    );
    for (const pasta of ['css', 'vendor', 'assets']) {
      assert.ok(html.includes(`/a/${marca}/${pasta}/`), `${pasta} ficou sem versão`);
    }
    assert.ok(html.includes('href="/app/aulas"'), 'link de navegação não é estático');
    assert.ok(html.includes('href="/api/health"'), 'endereço de API não é estático');
  });

  it('deixa a marca ao alcance do JavaScript, sem script embutido', () => {
    // A política de segurança da página proíbe script inline; por isso a marca
    // viaja em <meta>, que é de onde core/icons.js monta o endereço do sprite.
    const html = assets.versionHtml('<html><head><title>x</title></head><body></body></html>', config.publicDir);
    assert.match(html, /<meta name="fe-assets" content="[0-9a-f]{6,}">/);
    assert.doesNotMatch(html, /<script>/, 'script embutido seria bloqueado pela política de segurança');
  });

  it('reconhece o caminho versionado e devolve o original', () => {
    const separado = assets.splitVersioned('/a/abc123def0/js/app/shell.js');
    assert.deepEqual(separado, { stamp: 'abc123def0', rest: '/js/app/shell.js' });
    assert.equal(assets.splitVersioned('/js/app/shell.js'), null);
    assert.equal(assets.splitVersioned('/a/nao-e-marca/js/x.js'), null);
  });

  it('a marca muda quando um arquivo muda', () => {
    const fs = require('node:fs');
    const alvo = path.join(config.publicDir, 'css', 'app.css');
    const antes = assets.stamp(config.publicDir);

    const original = fs.readFileSync(alvo);
    try {
      fs.writeFileSync(alvo, `${original}\n/* marca de teste */\n`);
      assets.reset();
      assert.notEqual(assets.stamp(config.publicDir), antes, 'arquivo diferente precisa de endereço diferente');
    } finally {
      fs.writeFileSync(alvo, original);
      assets.reset();
    }
    assert.equal(assets.stamp(config.publicDir), antes, 'voltando o arquivo, volta a marca');
  });
});

describe('O que o navegador recebe', () => {
  it('a página vem sem cache e já apontando para os estáticos versionados', async () => {
    const res = await ctx.request('GET', '/app');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.match(res.text, /\/a\/[0-9a-f]{6,}\/js\/app\/shell\.js/);
    assert.match(res.text, /<meta name="fe-assets"/);
  });

  it('o estático versionado é servido, e pode ficar em cache para sempre', async () => {
    const marca = assets.stamp(config.publicDir);
    const res = await ctx.request('GET', `/a/${marca}/js/app/shell.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /immutable/);
    assert.match(res.text, /export|import/, 'veio o módulo de verdade');
  });

  it('o caminho sem versão continua funcionando', async () => {
    // Páginas antigas guardadas no navegador ainda pedem o caminho sem marca.
    const res = await ctx.request('GET', '/js/app/shell.js');
    assert.equal(res.status, 200);
  });

  it('marca antiga não trava ninguém: serve o arquivo atual', async () => {
    const res = await ctx.request('GET', '/a/0000000000/js/app/shell.js');
    assert.equal(res.status, 200, 'quem voltar com um endereço velho recebe o arquivo, não um 404');
  });
});

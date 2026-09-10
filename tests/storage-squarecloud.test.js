'use strict';

/**
 * Driver do Blob Storage da Square Cloud.
 *
 *   NODE_ENV=test node --test tests/storage-squarecloud.test.js
 *
 * Roda contra um servidor falso que imita a API da Square Cloud, então prova o
 * comportamento sem consumir a conta: envio simples até 100 MB, envio em partes
 * acima disso, aborto quando uma parte falha, remoção e listagem.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// carrega a configuração antes de mexer no ambiente, para que o teste da
// chave ausente não esbarre no valor guardado em cache pelo config
require('../server/config');

const ORIGINAL_KEY = process.env.SQUARECLOUD_API_KEY;

describe('Blob Storage da Square Cloud', () => {
  let server;
  let base;
  let driver;
  let calls;
  let failPart = 0;

  /** Lê o corpo bruto da requisição. */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const body = await readBody(req);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), bytes: body.length });

      if (!req.headers.authorization) return send(401, { status: 'error', code: 'ACCESS_DENIED' });

      // envio simples
      if (req.method === 'POST' && url.pathname === '/v1/objects') {
        const name = url.searchParams.get('name');
        const prefix = url.searchParams.get('prefix');
        return send(200, {
          status: 'success',
          response: {
            id: `123/${prefix}/${name}.mp4`,
            name,
            size: body.length,
            url: `https://public-blob.squarecloud.dev/123/${prefix}/${name}.mp4`,
          },
        });
      }
      // abre envio em partes
      if (req.method === 'POST' && url.pathname === '/v1/objects/chunked') {
        return send(200, {
          status: 'success',
          response: {
            upload: 'token-de-teste',
            id: '123/videos/aula.mp4',
            url: 'https://public-blob.squarecloud.dev/123/videos/aula.mp4',
            // nomes exatos da documentação
            chunk: {
              min_size: 5 * 1024 * 1024,
              max_size: 5 * 1024 * 1024,
              max_parts: 205,
              max_object_size: 1024 * 1024 * 1024,
            },
          },
        });
      }
      // recebe uma parte
      if (req.method === 'PUT' && url.pathname === '/v1/objects/chunked') {
        const part = Number(url.searchParams.get('part'));
        if (failPart && part === failPart) return send(500, { status: 'error', code: 'CHUNK_FAILED' });
        return send(200, { status: 'success', response: { part, size: body.length, etag: '"x"' } });
      }
      // fecha o envio
      if (req.method === 'PATCH' && url.pathname === '/v1/objects/chunked') {
        const enviadas = calls.filter((c) => c.method === 'PUT').reduce((sum, c) => sum + c.bytes, 0);
        return send(200, {
          status: 'success',
          response: {
            id: '123/videos/aula.mp4',
            size: enviadas,
            parts: calls.filter((c) => c.method === 'PUT').length,
            url: 'https://public-blob.squarecloud.dev/123/videos/aula.mp4',
          },
        });
      }
      // aborta
      if (req.method === 'DELETE' && url.pathname === '/v1/objects/chunked') return send(200, { status: 'success' });
      // remove objeto
      if (req.method === 'DELETE' && url.pathname === '/v1/objects') return send(200, { status: 'success' });
      // lista
      if (req.method === 'GET' && url.pathname === '/v1/objects') {
        return send(200, {
          status: 'success',
          response: {
            objects: [{ id: '123/videos/aula.mp4', size: 10, created_at: '2026-09-10T12:00:00.000Z' }],
            continuationToken: null,
          },
        });
      }
      return send(404, { status: 'error', code: 'NOT_FOUND' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/v1/objects`;

    process.env.SQUARECLOUD_API_KEY = 'chave-de-teste';
    // aponta o driver para o servidor falso
    const modulePath = require.resolve('../server/services/storage/squarecloud');
    delete require.cache[modulePath];
    const source = require('node:fs').readFileSync(modulePath, 'utf8');
    const patched = source.replace(
      "const BASE = 'https://blob.squarecloud.app/v1/objects';",
      `const BASE = ${JSON.stringify(base)};`
    );
    const Module = require('node:module');
    driver = new Module(modulePath, module);
    driver.filename = modulePath;
    driver.paths = Module._nodeModulePaths(require('node:path').dirname(modulePath));
    driver._compile(patched, modulePath);
    driver = driver.exports;
  });

  after(async () => {
    process.env.SQUARECLOUD_API_KEY = ORIGINAL_KEY;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    calls = [];
    failPart = 0;
  });

  /** Fluxo a partir de um buffer, em pedaços, como chega uma requisição. */
  async function* streamOf(buffer, piece = 512 * 1024) {
    for (let i = 0; i < buffer.length; i += piece) yield buffer.subarray(i, i + piece);
  }

  it('reconhece a chave da conta', () => {
    assert.equal(driver.isConfigured(), true);
  });

  it('arquivo pequeno vai em uma requisição só', async () => {
    const buffer = Buffer.alloc(64 * 1024, 1);
    const saved = await driver.putStream(streamOf(buffer), {
      filename: 'Aula de Porcentagem.mp4',
      folder: 'videos',
      contentType: 'video/mp4',
    });

    assert.match(saved.url, /^https:\/\/public-blob\.squarecloud\.dev\//);
    // o servidor falso devolve o tamanho do corpo multipart, que carrega o
    // delimitador além do arquivo; o que importa é que o tamanho veio da API
    assert.ok(saved.bytes >= buffer.length);
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/v1/objects');
    assert.equal(posts.length, 1, 'deve usar o envio simples');
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'não abre envio em partes');
    assert.match(posts[0].query.name, /^Aula_de_Porcentagem_/, 'o nome do objeto sai do nome do arquivo');
    assert.equal(posts[0].query.prefix, 'videos');
  });

  it('arquivo grande é dividido em partes e fechado no fim', async () => {
    // o corte para envio em partes é 16 MB (o que fica na memória por vez);
    // com 40 MB o driver abre o envio em partes e passa a usar 5 MB por parte
    const buffer = Buffer.alloc(40 * 1024 * 1024, 2);
    const saved = await driver.putStream(streamOf(buffer), {
      filename: 'aula-longa.mp4',
      folder: 'videos',
      contentType: 'video/mp4',
    });

    const partes = calls.filter((c) => c.method === 'PUT');
    assert.equal(partes.length, 8, '40 MB em partes de 5 MB dão oito partes');
    assert.deepEqual(partes.map((c) => Number(c.query.part)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(partes[0].bytes, 5 * 1024 * 1024);
    assert.ok(partes.at(-1).bytes <= 5 * 1024 * 1024, 'a última parte pode ser menor');
    assert.equal(partes.reduce((sum, c) => sum + c.bytes, 0), buffer.length, 'nada se perde no caminho');
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'fecha o envio');
    assert.equal(saved.bytes, buffer.length);
    assert.match(saved.url, /public-blob\.squarecloud\.dev/);
  });

  it('quando uma parte falha, o envio é abortado e o erro sobe', async () => {
    failPart = 2;
    const buffer = Buffer.alloc(40 * 1024 * 1024, 3);
    await assert.rejects(
      () => driver.putStream(streamOf(buffer), { filename: 'falha.mp4', folder: 'videos' }),
      /armazenamento/i
    );
    assert.equal(
      calls.filter((c) => c.method === 'DELETE' && c.path === '/v1/objects/chunked').length,
      1,
      'aborta para não deixar partes órfãs ocupando cota'
    );
  });

  it('remove um objeto pela chave', async () => {
    await driver.remove('123/videos/aula.mp4');
    const apagou = calls.find((c) => c.method === 'DELETE' && c.path === '/v1/objects');
    assert.ok(apagou, 'chama a remoção da API');
  });

  it('lista os objetos da conta', async () => {
    const { items, cursor } = await driver.list({ folder: 'videos' });
    assert.equal(items.length, 1);
    assert.equal(items[0].key, '123/videos/aula.mp4');
    assert.equal(cursor, null);
  });

  it('recusa arquivo menor que o mínimo aceito pela API', async () => {
    await assert.rejects(
      () => driver.putStream(streamOf(Buffer.alloc(100, 1)), { filename: 'minusculo.png', folder: 'logos' }),
      /pequeno demais/i
    );
    assert.equal(calls.length, 0, 'nem chega a bater na API');
  });

  it('respeita o tamanho de parte que o servidor informa', async () => {
    const buffer = Buffer.alloc(40 * 1024 * 1024, 4);
    await driver.putStream(streamOf(buffer), { filename: 'aula.mp4', folder: 'videos' });
    const partes = calls.filter((c) => c.method === 'PUT');
    // o servidor falso pede 5 MB por parte, não os 16 MB do plano B
    assert.ok(partes.every((c) => c.bytes <= 5 * 1024 * 1024), 'nenhuma parte passa do máximo informado');
    assert.equal(partes[0].bytes, 5 * 1024 * 1024);
  });

  it('sem chave, avisa que o armazenamento não está configurado', async () => {
    process.env.SQUARECLOUD_API_KEY = '';
    try {
      await assert.rejects(
        () => driver.putStream(streamOf(Buffer.alloc(4096, 1)), { filename: 'x.mp4', folder: 'videos' }),
        /não está configurado/i
      );
    } finally {
      process.env.SQUARECLOUD_API_KEY = 'chave-de-teste';
    }
  });
});

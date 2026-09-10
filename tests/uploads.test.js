'use strict';

/**
 * Envio de arquivos pelo painel.
 *
 *   NODE_ENV=test node --test tests/uploads.test.js
 *
 * Regras que não podem quebrar: só administrador envia, o tipo vem dos bytes e
 * não do que o navegador declara, arquivo grande é recusado, o mesmo conteúdo
 * não duplica no disco e a remoção não escapa da pasta de uploads.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const uploads = require('../server/services/uploads');

/** PNG de 1x1 válido (cabeçalho + IHDR). */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

describe('Envio de arquivos', () => {
  let ctx;
  let admin;
  let student;
  const created = [];

  before(async () => {
    ctx = await createTestContext();
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluno Upload' });
  });

  after(async () => {
    for (const url of created) await uploads.remove(url).catch(() => {});
    await ctx.close();
  });

  /** POST cru no endpoint de upload, como o painel faz. */
  async function upload(agentCookie, body, { contentType, query = '' } = {}) {
    return ctx.request('POST', `/api/admin/uploads${query}`, {
      cookie: agentCookie,
      body,
      raw: true,
      headers: { 'Content-Type': contentType },
    });
  }

  it('aluno e visitante não enviam arquivo', async () => {
    const asStudent = await upload(student.cookie, PNG, { contentType: 'image/png' });
    assert.ok([401, 403].includes(asStudent.status), `aluno recebeu ${asStudent.status}`);

    const anonymous = await upload(undefined, PNG, { contentType: 'image/png' });
    assert.ok([401, 403].includes(anonymous.status));

    const listing = await student.agent.get('/api/admin/uploads');
    assert.ok([401, 403].includes(listing.status));
  });

  it('grava a imagem e devolve a URL pública', async () => {
    const res = await upload(admin.cookie, PNG, {
      contentType: 'image/png',
      query: '?folder=logos&filename=Logo%20Barro%20Branco.png',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.url, /^\/uploads\/logos\/[a-f0-9]{24}\.png$/);
    assert.equal(res.body.content_type, 'image/png');
    assert.equal(res.body.kind, 'image');
    assert.equal(res.body.label, 'Logo Barro Branco');
    created.push(res.body.url);

    const onDisk = path.join(uploads.UPLOADS_DIR, res.body.url.replace('/uploads/', ''));
    const stat = await fs.stat(onDisk);
    assert.equal(stat.size, PNG.length);
  });

  it('aceita PDF na pasta de editais', async () => {
    const res = await upload(admin.cookie, PDF, {
      contentType: 'application/pdf',
      query: '?folder=editais&filename=edital-2026.pdf',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.content_type, 'application/pdf');
    assert.equal(res.body.kind, 'document');
    assert.equal(res.body.folder, 'editais');
    created.push(res.body.url);
  });

  it('o tipo vem dos bytes: texto renomeado para .png é recusado', async () => {
    const res = await upload(admin.cookie, Buffer.from('<script>alert(1)</script>'), {
      contentType: 'image/png',
      query: '?folder=logos&filename=fake.png',
    });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'unsupported_type');
  });

  it('recusa tipo fora da lista mesmo com conteúdo válido', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload(admin.cookie, svg, { contentType: 'image/svg+xml', query: '?folder=logos' });
    assert.equal(res.status, 415);
  });

  it('recusa corpo vazio', async () => {
    const res = await upload(admin.cookie, Buffer.alloc(0), { contentType: 'image/png' });
    assert.ok([400, 415].includes(res.status), `corpo vazio respondeu ${res.status}`);
  });

  it('o mesmo conteúdo não duplica no disco', async () => {
    const first = await upload(admin.cookie, PNG, { contentType: 'image/png', query: '?folder=geral&filename=a.png' });
    const second = await upload(admin.cookie, PNG, { contentType: 'image/png', query: '?folder=geral&filename=b.png' });
    assert.equal(first.body.url, second.body.url);
    assert.equal(second.body.reused, true);
    created.push(first.body.url);
  });

  it('lista os arquivos enviados', async () => {
    const res = await admin.agent.get('/api/admin/uploads');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.some((item) => created.includes(item.url)));
    assert.ok(res.body.folders.includes('editais'));
  });

  it('a remoção não escapa da pasta de uploads', async () => {
    const escape = await admin.agent.del('/api/admin/uploads', { url: '/../../.env' });
    assert.equal(escape.status, 400);

    const traversal = await admin.agent.del('/api/admin/uploads', { url: '/uploads/../../.env' });
    assert.ok([400, 200].includes(traversal.status));
    // o arquivo do projeto continua lá
    await fs.access(path.join(uploads.UPLOADS_DIR, '..', '.env'));
  });

  it('remove um arquivo enviado', async () => {
    const res = await upload(admin.cookie, PDF, { contentType: 'application/pdf', query: '?folder=provas' });
    const removed = await admin.agent.del('/api/admin/uploads', { url: res.body.url });
    assert.equal(removed.status, 200);
    await assert.rejects(fs.access(path.join(uploads.UPLOADS_DIR, res.body.url.replace('/uploads/', ''))));
  });
});

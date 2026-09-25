'use strict';

/**
 * Envio de arquivo grande em partes (videoaula acima dos 100 MB do Cloudflare).
 *
 *   NODE_ENV=test node --test tests/uploads-em-partes.test.js
 *
 * O que não pode quebrar: o arquivo remontado sai idêntico ao original, parte
 * repetida (o navegador tentou de novo após queda) não duplica bytes, parte fora
 * de ordem é recusada, a checagem de tipo pelos bytes continua valendo, envio
 * incompleto não vira arquivo e só administrador envia.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTestContext } = require('./helpers');
const uploads = require('../server/services/uploads');
const sessions = require('../server/services/upload-sessions');

const PART = sessions.PART_SIZE;

/** MP4 falso de `size` bytes: caixa "ftyp" no começo e conteúdo variado. */
function fakeMp4(size) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftypisom', 4, 'ascii');
  for (let i = 16; i < size; i += 4096) buffer[i] = i % 251;
  return buffer;
}

describe('Envio de arquivo em partes', () => {
  let ctx;
  let admin;
  let student;
  const created = [];

  before(async () => {
    ctx = await createTestContext();
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluno Partes' });
  });

  after(async () => {
    for (const url of created) await uploads.remove(url).catch(() => {});
    await ctx.close();
  });

  const openSession = (cookie, body) =>
    ctx.request('POST', '/api/admin/uploads/sessions', { cookie, body });

  const sendPart = (cookie, id, index, buffer) =>
    ctx.request('PUT', `/api/admin/uploads/sessions/${id}/parts/${index}`, {
      cookie,
      body: buffer,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

  const finish = (cookie, id) => ctx.request('POST', `/api/admin/uploads/sessions/${id}/complete`, { cookie });

  it('remonta o vídeo idêntico e aceita parte repetida sem duplicar', async () => {
    const file = fakeMp4(PART * 2 + 12345);
    const opened = await openSession(admin.cookie, {
      folder: 'videos', filename: 'Aula de Demografia.mp4', content_type: 'video/mp4', size: file.length,
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const { id, part_size: partSize } = opened.body;
    assert.equal(partSize, PART);

    const parts = [file.subarray(0, PART), file.subarray(PART, PART * 2), file.subarray(PART * 2)];
    assert.equal((await sendPart(admin.cookie, id, 1, parts[0])).status, 200);
    // o navegador perdeu a resposta e mandou a parte 1 de novo
    const repeated = await sendPart(admin.cookie, id, 1, parts[0]);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.received, PART);

    assert.equal((await sendPart(admin.cookie, id, 2, parts[1])).status, 200);
    assert.equal((await sendPart(admin.cookie, id, 3, parts[2])).status, 200);

    const done = await finish(admin.cookie, id);
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.content_type, 'video/mp4');
    assert.equal(done.body.kind, 'video');
    assert.equal(done.body.bytes, file.length);
    created.push(done.body.url);

    const onDisk = await fs.readFile(path.join(uploads.UPLOADS_DIR, done.body.url.replace('/uploads/', '')));
    assert.ok(onDisk.equals(file), 'o arquivo gravado difere do enviado');
  });

  it('recusa parte fora de ordem', async () => {
    const file = fakeMp4(PART + 100);
    const { body } = await openSession(admin.cookie, { folder: 'videos', filename: 'x.mp4', size: file.length });
    const skipped = await sendPart(admin.cookie, body.id, 2, file.subarray(PART));
    assert.equal(skipped.status, 409);
    await ctx.request('DELETE', `/api/admin/uploads/sessions/${body.id}`, { cookie: admin.cookie });
  });

  it('confere o tipo pelos bytes já na primeira parte', async () => {
    const fake = Buffer.alloc(PART, 0x41); // texto disfarçado de vídeo
    const { body } = await openSession(admin.cookie, {
      folder: 'videos', filename: 'virus.mp4', content_type: 'video/mp4', size: fake.length * 2,
    });
    const res = await sendPart(admin.cookie, body.id, 1, fake);
    assert.equal(res.status, 415);
    // a sessão morreu junto: nada mais entra nela
    const after = await sendPart(admin.cookie, body.id, 2, fake);
    assert.equal(after.status, 404);
  });

  it('envio incompleto não vira arquivo', async () => {
    const file = fakeMp4(PART + 500);
    const { body } = await openSession(admin.cookie, { folder: 'videos', filename: 'meio.mp4', size: file.length });
    assert.equal((await sendPart(admin.cookie, body.id, 1, file.subarray(0, PART))).status, 200);
    const done = await finish(admin.cookie, body.id);
    assert.equal(done.status, 409);
  });

  it('recusa arquivo acima do limite já na abertura', async () => {
    const res = await openSession(admin.cookie, { folder: 'videos', filename: 'enorme.mp4', size: uploads.MAX_BYTES + 1 });
    assert.equal(res.status, 413);
  });

  it('aluno e visitante não abrem envio', async () => {
    const asStudent = await openSession(student.cookie, { folder: 'videos', filename: 'a.mp4', size: 1000 });
    assert.ok([401, 403].includes(asStudent.status), `aluno recebeu ${asStudent.status}`);
    const anonymous = await openSession(undefined, { folder: 'videos', filename: 'a.mp4', size: 1000 });
    assert.ok([401, 403].includes(anonymous.status));
  });
});

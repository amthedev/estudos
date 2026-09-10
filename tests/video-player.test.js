'use strict';

/**
 * Utilitários do player de vídeo.
 *
 *   NODE_ENV=test node --test tests/video-player.test.js
 *
 * Guarda o defeito que apareceu na verificação: a videoaula hospedada pela
 * plataforma vinha como caminho interno (/uploads/...), a leitura da extensão
 * só entendia endereço absoluto, e o aluno recebia o cartão "abrir em outra
 * página" no lugar do player.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

describe('Player de vídeo', () => {
  let player;

  before(async () => {
    const file = path.join(__dirname, '..', 'public', 'js', 'components', 'video-player.js');
    player = await import(`file://${file}`);
  });

  it('reconhece o vídeo hospedado pela plataforma', () => {
    assert.equal(player.detectProvider('/uploads/videos/abc123.mp4'), 'upload');
    assert.equal(player.detectProvider('https://public-blob.squarecloud.dev/123/videos/aula.mp4'), 'upload');
    assert.equal(player.detectProvider(''), 'none');
  });

  it('lê a extensão de caminho interno e de endereço absoluto', () => {
    assert.equal(player.fileExtension('/uploads/videos/abc123.mp4'), 'mp4');
    assert.equal(player.fileExtension('/uploads/videos/abc123.webm'), 'webm');
    assert.equal(player.fileExtension('/uploads/videos/abc123.mp4?v=2'), 'mp4');
    assert.equal(player.fileExtension('https://public-blob.squarecloud.dev/1/videos/aula.mp4'), 'mp4');
    assert.equal(player.fileExtension('https://exemplo.com/pagina'), '');
  });

  it('mantém o provedor declarado quando ele bate com o endereço', () => {
    assert.equal(player.resolveProvider('upload', '/uploads/videos/a.mp4'), 'upload');
    assert.equal(player.resolveProvider('none', '/uploads/videos/a.mp4'), 'none');
    assert.equal(player.resolveProvider('upload', ''), 'none');
  });
});

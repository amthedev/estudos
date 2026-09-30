'use strict';

/**
 * Comentários de alunos da faixa do topo da página inicial.
 *
 *   NODE_ENV=test node --test tests/comentarios-alunos.test.js
 *
 * O que não pode quebrar: os comentários entram pelo seed com o texto como o
 * aluno escreveu, uma vez só — rodar o seed de novo não duplica, e um
 * comentário apagado no painel não volta no deploy seguinte (o seed roda a
 * cada boot em produção). E a página inicial entrega esses comentários para a
 * faixa, separados dos depoimentos com foto ou vídeo.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { runSeed } = require('../server/db/seed/run');
const { studentComments } = require('../server/db/seed/data/curated_assets');
const { invalidateLandingCache } = require('../server/routes/landing');

const textOnly = `SELECT count(*)::int AS total FROM testimonials
                   WHERE content IS NOT NULL AND image_url IS NULL AND video_url IS NULL`;

describe('Comentários de alunos no topo da página inicial', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
    await runSeed({ quiet: true });
    invalidateLandingCache();
  });

  after(async () => {
    await ctx.close();
  });

  it('a lista tem os 50 comentários, sem nome ou texto vazio e sem repetição', () => {
    assert.equal(studentComments.length, 50);
    const vistos = new Set();
    for (const comment of studentComments) {
      assert.ok(comment.name.trim().length > 1, 'nome vazio');
      assert.ok(comment.content.trim().length > 5, `texto vazio para ${comment.name}`);
      const chave = `${comment.name}|${comment.content}`;
      assert.ok(!vistos.has(chave), `comentário repetido: ${chave}`);
      vistos.add(chave);
    }
  });

  it('o seed grava os comentários com o texto como o aluno escreveu', async () => {
    const { total } = await ctx.db.one(textOnly);
    assert.equal(total, 50);
    const gabi = await ctx.db.one('SELECT content, active FROM testimonials WHERE name = $1', ['Gabi']);
    assert.equal(gabi.content, 'eu literalmente não sabia por onde começar pro enem, agr pelo menos tenho uma direção 😭');
    assert.equal(gabi.active, true);
  });

  it('rodar o seed de novo não duplica, e o apagado no painel não volta', async () => {
    await ctx.db.query('DELETE FROM testimonials WHERE name = $1', ['Carlos']);
    await runSeed({ quiet: true });
    const { total } = await ctx.db.one(textOnly);
    assert.equal(total, 49, 'o comentário apagado não pode voltar no próximo boot');
    const carlos = await ctx.db.one('SELECT count(*)::int AS total FROM testimonials WHERE name = $1', ['Carlos']);
    assert.equal(carlos.total, 0);
  });

  it('a página inicial entrega os comentários para a faixa do topo', async () => {
    invalidateLandingCache();
    const res = await ctx.request('GET', '/api/landing');
    assert.equal(res.status, 200);
    const comentarios = res.body.testimonials.filter((item) => item.content && !item.image_url && !item.video_url);
    assert.equal(comentarios.length, 49);
    const lucas = comentarios.find((item) => item.name === 'Lucas');
    assert.ok(lucas, 'o comentário do Lucas precisa estar na lista');
    assert.match(lucas.content, /^comecei essa semana/);
    // A ordem é a da lista enviada (o painel pode reordenar depois).
    assert.equal(comentarios[0].name, 'Lucas');
  });
});

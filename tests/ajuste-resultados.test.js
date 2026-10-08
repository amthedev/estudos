'use strict';

/**
 * Resultados da página inicial (outubro/2026): fotos dos aprovados em
 * "Aprovados", prints de conversa em "Mensagens recebidas".
 *
 *   NODE_ENV=test node --test tests/ajuste-resultados.test.js
 *
 * Simula o banco de produção de antes do ajuste (posts de Instagram, prints
 * antigos, fotos de aprovados enviadas pelo painel e um vídeo) e confere: a
 * migration marca cada imagem com o bloco certo, o ajuste apaga os posts e os
 * prints antigos e leva as fotos para a cópia leve sem mexer no vídeo, rodar de
 * novo não muda nada, o painel grava o bloco escolhido e todo arquivo citado
 * existe com a sua miniatura.
 */
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const { resultadosOutubro2026, FOTOS_APROVADOS } = require('../server/db/seed/ajustes');
const { testimonials } = require('../server/db/seed/data/curated_assets');
const { invalidateLandingCache } = require('../server/routes/landing');

const PUBLIC = path.join(__dirname, '..', 'public');
const BLOB = 'https://public-blob.squarecloud.dev/0a9f7f1de21c92b5fe36d1006d36b96186874a93/depoimentos';
const MIGRATION = path.join(__dirname, '..', 'server', 'db', 'migrations', '228_secao_do_depoimento.sql');

function thumbOf(url) {
  return url.replace(/^(\/assets\/results\/[a-z-]+\/)([^/]+)\.(png|jpe?g)$/i, '$1thumbs/$2.jpg');
}

describe('Resultados: Aprovados com fotos, Mensagens com prints', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext();
    // como está em produção antes da migration e do ajuste (sem o bloco marcado)
    await ctx.db.query(
      `INSERT INTO testimonials (name, role, image_url, video_url, sort_order, active) VALUES
         ('Ana Estuda', 'Aprovada em Medicina', '/assets/results/posts/aprovacao-medicina-ana.png', NULL, 1, true),
         ('Ana Souza', 'Medicina pelo ENEM', '/assets/results/messages/depoimento-enem-ana.png', NULL, 2, true),
         ('Ana Martins', 'Aprovada Academia do Barro Branco', '${BLOB}/Cadete_em_Patio_da_Acade_199685.png', NULL, 3, true),
         ('Lucas Robis', 'Aprovado em Medicina pelo ENEM', '${BLOB}/Retrato_em_frente_a_Medi_2958a8.png', NULL, 4, true),
         ('Aluno Foco Elite', 'Aluno aprovado', NULL, '${BLOB}/ENEM_DEP_f0fab9.mov', 5, true)`
    );
    await ctx.db.query(fs.readFileSync(MIGRATION, 'utf8'));
  });

  after(async () => {
    await ctx.close();
  });

  it('a migration separa print de conversa de foto e deixa o vídeo sem bloco', async () => {
    const rows = await ctx.db.many('SELECT name, kind FROM testimonials ORDER BY sort_order');
    assert.deepEqual(rows.map((row) => row.kind), ['foto', 'conversa', 'foto', 'foto', null]);
  });

  it('apaga posts e prints antigos e leva as fotos do painel para a cópia leve', async () => {
    const resumo = await resultadosOutubro2026();
    assert.deepEqual(resumo, { removidos: 2, fotos: 2 });

    const rows = await ctx.db.many('SELECT name, role, image_url, video_url, kind FROM testimonials ORDER BY sort_order');
    assert.deepEqual(rows, [
      { name: 'Ana Martins', role: 'Aprovada Academia do Barro Branco', image_url: '/assets/results/aprovados/aprovada-barro-branco-ana.jpg', video_url: null, kind: 'foto' },
      { name: 'Lucas Robis', role: 'Aprovado em Medicina pelo ENEM', image_url: '/assets/results/aprovados/aprovado-medicina-lucas.jpg', video_url: null, kind: 'foto' },
      { name: 'Aluno Foco Elite', role: 'Aluno aprovado', image_url: null, video_url: `${BLOB}/ENEM_DEP_f0fab9.mov`, kind: null },
    ]);

    // rodar de novo não muda nada
    assert.deepEqual(await resultadosOutubro2026(), { removidos: 0, fotos: 0 });
  });

  it('a página pública entrega o bloco de cada imagem', async () => {
    invalidateLandingCache();
    const res = await ctx.request('GET', '/api/landing');
    assert.equal(res.status, 200);
    const fotos = res.body.testimonials.filter((item) => item.kind === 'foto');
    assert.deepEqual(fotos.map((item) => item.name), ['Ana Martins', 'Lucas Robis']);
  });

  it('o painel grava o bloco escolhido; imagem sem escolha vai para Aprovados', async () => {
    const admin = await ctx.loginAdmin();
    const conversa = await admin.agent.post('/api/admin/landing/testimonials', {
      name: 'Print novo', image_url: '/assets/results/conversas/conversa-medicina-enzo.jpg', kind: 'conversa',
    });
    assert.equal(conversa.status, 201);
    assert.equal(conversa.body.kind, 'conversa');

    const foto = await admin.agent.post('/api/admin/landing/testimonials', {
      name: 'Foto nova', image_url: '/assets/results/aprovados/aprovado-medicina-igor.jpg',
    });
    assert.equal(foto.body.kind, 'foto');

    const virouTexto = await admin.agent.put(`/api/admin/landing/testimonials/${foto.body.id}`, {
      image_url: '', content: 'Agora só em texto.',
    });
    assert.equal(virouTexto.status, 200);
    assert.equal(virouTexto.body.kind, null, 'sem imagem, sem bloco');

    const invalido = await admin.agent.post('/api/admin/landing/testimonials', {
      name: 'Bloco errado', image_url: '/assets/results/aprovados/aprovado-medicina-igor.jpg', kind: 'instagram',
    });
    assert.equal(invalido.status, 400);
  });

  it('todo arquivo citado existe, com a sua miniatura', () => {
    const urls = [
      ...Object.values(FOTOS_APROVADOS).map((nome) => `/assets/results/aprovados/${nome}.jpg`),
      ...testimonials.filter((item) => item.image_url).map((item) => item.image_url),
    ];
    const prints = testimonials.filter((item) => item.image_url);
    assert.equal(prints.length, 12, 'os doze prints novos');
    assert.ok(prints.every((item) => item.kind === 'conversa'));
    for (const url of urls) {
      assert.ok(fs.existsSync(path.join(PUBLIC, url)), `${url} existe`);
      assert.ok(fs.existsSync(path.join(PUBLIC, thumbOf(url))), `miniatura de ${url} existe`);
    }
  });
});

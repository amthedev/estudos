'use strict';

/**
 * Capa da matéria: a equipe envia uma imagem por matéria e todas as aulas dela
 * usam essa capa.
 *
 *   NODE_ENV=test node --test tests/subject-cover.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

describe('Capa da matéria', () => {
  let ctx;
  let db;
  let admin;
  let subject;
  let topic;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    subject = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('geo-capa', 'Geografia', 1) RETURNING id`);
    topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'cartografia-capa', 'Cartografia', 1) RETURNING id`,
      [subject.id]
    );
  });

  after(async () => {
    await ctx.close();
  });

  async function thumb(lessonId) {
    return (await db.one('SELECT thumbnail_url FROM lessons WHERE id = $1', [lessonId])).thumbnail_url;
  }

  it('aplica a capa nas aulas da matéria e preserva a miniatura própria', async () => {
    const semCapa = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title) VALUES ($1, $2, 'aula-sem-capa', 'Escalas') RETURNING id`,
      [subject.id, topic.id]
    );
    const propria = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, thumbnail_url)
       VALUES ($1, $2, 'aula-propria', 'Coordenadas', 'https://exemplo.com/propria.jpg') RETURNING id`,
      [subject.id, topic.id]
    );

    const res = await admin.agent.put(`/api/admin/content/subjects/${subject.id}`, { cover_url: 'https://exemplo.com/geo.jpg' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cover_url, 'https://exemplo.com/geo.jpg');
    assert.equal(await thumb(semCapa.id), 'https://exemplo.com/geo.jpg');
    assert.equal(await thumb(propria.id), 'https://exemplo.com/propria.jpg');

    // trocar a capa troca a das aulas que estavam com a anterior
    await admin.agent.put(`/api/admin/content/subjects/${subject.id}`, { cover_url: 'https://exemplo.com/geo-2.jpg' });
    assert.equal(await thumb(semCapa.id), 'https://exemplo.com/geo-2.jpg');
    assert.equal(await thumb(propria.id), 'https://exemplo.com/propria.jpg');
  });

  it('aula nova sem miniatura nasce com a capa da matéria', async () => {
    const res = await admin.agent.post('/api/admin/lessons', {
      title: 'Projeções cartográficas',
      subject_id: subject.id,
      topics: [{ topic_id: topic.id }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await thumb(res.body.id), 'https://exemplo.com/geo-2.jpg');
  });
});

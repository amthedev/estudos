'use strict';

/**
 * Importação de aulas em massa.
 *
 *   NODE_ENV=test node --test tests/lessons-import.test.js
 *
 * Regras que não podem quebrar: só administrador importa, link repetido ou já
 * cadastrado não vira aula duplicada, linha inválida não derruba as boas, a
 * ordem continua de onde o assunto parou e as provas marcadas valem para todas.
 *
 * Em NODE_ENV=test a consulta de metadados ao YouTube é desligada, então o
 * título vem do que foi informado (ou do rótulo automático) e o teste não
 * depende de rede.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

const V1 = 'https://www.youtube.com/watch?v=aaaaaaaaaa1';
const V2 = 'https://youtu.be/bbbbbbbbbb2';
const V3 = 'https://vimeo.com/123456789';

describe('Importação de aulas', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let subject;
  let topic;
  let exam;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('enem-import', 'ENEM', 'ENEM', 'enem', 'INEP') RETURNING id`
    );
    subject = await db.one(
      `INSERT INTO subjects (slug, name, sort_order) VALUES ('mat-import', 'Matemática', 1) RETURNING id`
    );
    topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
      [subject.id]
    );
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Import' });
  });

  after(async () => {
    await ctx.close();
  });

  const base = () => ({ subject_id: subject.id, topic_id: topic.id, teacher_name: 'Equipe', exam_ids: [exam.id] });

  it('aluno e visitante não importam', async () => {
    const asStudent = await student.agent.post('/api/admin/lessons/import', { ...base(), items: [{ url: V1 }] });
    assert.ok([401, 403].includes(asStudent.status));

    const anonymous = await ctx.request('POST', '/api/admin/lessons/import/preview', { body: { text: V1 } });
    assert.ok([401, 403].includes(anonymous.status));
  });

  it('a prévia separa link válido de inválido sem gravar nada', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import/preview', {
      text: `${V1}\n${V2} | Título escolhido\nisto-nao-e-link\n# comentário ignorado`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3, 'a linha de comentário não deve contar');
    assert.equal(res.body.ready, 2);

    const [first, second, third] = res.body.items;
    assert.equal(first.provider, 'youtube');
    assert.equal(first.valid, true);
    assert.equal(second.title, 'Título escolhido', 'o título após a barra deve prevalecer');
    assert.equal(third.valid, false);

    const count = await db.one('SELECT count(*)::int AS total FROM lessons');
    assert.equal(count.total, 0, 'a prévia não pode gravar aula');
  });

  it('importa a lista, ignora repetido e inválido, e vincula a prova', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [
        { url: V1, title: 'Porcentagem — parte 1' },
        { url: V2, title: 'Porcentagem — parte 2' },
        { url: V1, title: 'Repetida' },
        { url: 'nao-e-link', title: 'Inválida' },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.failed, 2);
    assert.match(res.body.errors[0].message, /repetido/i);
    assert.match(res.body.errors[1].message, /não reconhecido/i);

    const lessons = await db.many(
      'SELECT title, sort_order, video_provider, teacher_name FROM lessons WHERE topic_id = $1 ORDER BY sort_order',
      [topic.id]
    );
    assert.equal(lessons.length, 2);
    assert.deepEqual(lessons.map((l) => l.title), ['Porcentagem — parte 1', 'Porcentagem — parte 2']);
    assert.deepEqual(lessons.map((l) => l.sort_order), [1, 2], 'a ordem deve ser sequencial');
    assert.equal(lessons[0].video_provider, 'youtube');
    assert.equal(lessons[0].teacher_name, 'Equipe');

    const links = await db.one(
      `SELECT count(*)::int AS total FROM lesson_exams le
         JOIN lessons l ON l.id = le.lesson_id
        WHERE l.topic_id = $1 AND le.exam_id = $2`,
      [topic.id, exam.id]
    );
    assert.equal(links.total, 2, 'todas as aulas importadas recebem a prova marcada');

    // a prova passa a cobrir o assunto, para o cronograma enxergar
    const coverage = await db.one('SELECT count(*)::int AS total FROM exam_topics WHERE exam_id = $1 AND topic_id = $2', [exam.id, topic.id]);
    assert.equal(coverage.total, 1);
  });

  it('reimportar a mesma lista não duplica', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ url: V1, title: 'Outra vez' }, { url: V2, title: 'De novo' }],
    });
    assert.equal(res.body.imported, 0);
    assert.equal(res.body.failed, 2);
    assert.match(res.body.errors[0].message, /já existe/i);

    const count = await db.one('SELECT count(*)::int AS total FROM lessons WHERE topic_id = $1', [topic.id]);
    assert.equal(count.total, 2);
  });

  it('a prévia avisa quando o vídeo já está cadastrado', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import/preview', { text: `${V1}\n${V3}` });
    assert.equal(res.body.items[0].already_registered, true);
    assert.equal(res.body.items[0].existing_title, 'Porcentagem — parte 1');
    assert.equal(res.body.items[1].already_registered, false);
    assert.equal(res.body.ready, 1);
  });

  it('continua a numeração de onde o assunto parou', async () => {
    const res = await admin.agent.post('/api/admin/lessons/import', {
      ...base(),
      items: [{ url: V3, title: 'Porcentagem — parte 3' }],
    });
    assert.equal(res.body.imported, 1);

    const last = await db.one('SELECT sort_order FROM lessons WHERE topic_id = $1 ORDER BY sort_order DESC LIMIT 1', [topic.id]);
    assert.equal(last.sort_order, 3);
  });

  it('recusa assunto inexistente e lista vazia', async () => {
    const noTopic = await admin.agent.post('/api/admin/lessons/import', {
      subject_id: subject.id,
      topic_id: '00000000-0000-0000-0000-000000000000',
      items: [{ url: V1 }],
    });
    assert.ok([400, 404].includes(noTopic.status));

    const empty = await admin.agent.post('/api/admin/lessons/import', { ...base(), items: [] });
    assert.equal(empty.status, 400);

    const noText = await admin.agent.post('/api/admin/lessons/import/preview', { text: '   \n # só comentário' });
    assert.equal(noText.status, 400);
  });
});

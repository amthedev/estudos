'use strict';

/**
 * Planos de estudo no painel.
 *
 *   NODE_ENV=test node --test tests/study-plans-admin.test.js
 *
 * É a sequência de assuntos que o gerador de cronograma segue. O que não pode
 * quebrar: a numeração das posições fica sempre 1..N sem buraco (a coluna é
 * única por plano, então reordenar e apagar são as operações delicadas), o
 * assunto precisa pertencer à matéria escolhida, um plano ativo não é apagado
 * por engano, e aluno nenhum chega nessas rotas.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

describe('Planos de estudo no painel', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let exam;
  let matematica;
  let portugues;
  let topicoMat;
  let topicoPort;
  let planId;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('enem-plano', 'ENEM', 'ENEM', 'enem', 'INEP') RETURNING id`
    );
    matematica = await db.one(
      `INSERT INTO subjects (slug, name, color) VALUES ('matematica-plano', 'Matemática', '#2F80ED') RETURNING id`
    );
    portugues = await db.one(
      `INSERT INTO subjects (slug, name, color) VALUES ('portugues-plano', 'Língua Portuguesa', '#4DA3FF') RETURNING id`
    );
    topicoMat = await db.one(
      `INSERT INTO topics (subject_id, slug, name) VALUES ($1, 'porcentagem-plano', 'Porcentagem') RETURNING id`,
      [matematica.id]
    );
    topicoPort = await db.one(
      `INSERT INTO topics (subject_id, slug, name) VALUES ($1, 'interpretacao-plano', 'Interpretação') RETURNING id`,
      [portugues.id]
    );
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Plano' });
  });

  after(async () => {
    await ctx.close();
  });

  it('fecha as rotas para quem não é administrador', async () => {
    const comoAluno = await student.agent.get('/api/admin/study-plans');
    assert.ok([401, 403].includes(comoAluno.status), `respondeu ${comoAluno.status} a um aluno`);
    const semSessao = await ctx.request('GET', '/api/admin/study-plans');
    assert.ok([401, 403].includes(semSessao.status), `respondeu ${semSessao.status} sem sessão`);
  });

  it('cria um plano e gera o endereço a partir do nome', async () => {
    const res = await admin.agent.post('/api/admin/study-plans', {
      exam_id: exam.id,
      name: 'ENEM — um ano',
      lessons_per_week: 3,
      exam_every_weeks: 4,
      weeks: 52,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.slug, 'enem-um-ano');
    assert.equal(res.body.exam_name, 'ENEM');
    assert.deepEqual(res.body.items, []);
    planId = res.body.id;
  });

  it('acrescenta passos numerando de 1 em diante e derivando a semana do ritmo', async () => {
    const titulos = ['Porcentagem', 'Razão e proporção', 'Interpretação de texto', 'Funções'];
    for (const title of titulos) {
      const res = await admin.agent.post(`/api/admin/study-plans/${planId}/items`, {
        title,
        subject_id: /Interpreta/.test(title) ? portugues.id : matematica.id,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    const plano = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    assert.equal(plano.body.items.length, 4);
    assert.deepEqual(
      plano.body.items.map((i) => i.position),
      [1, 2, 3, 4]
    );
    // três aulas por semana: os três primeiros na semana 1, o quarto na 2
    assert.deepEqual(
      plano.body.items.map((i) => i.week),
      [1, 1, 1, 2]
    );
    assert.equal(plano.body.items[0].subject_name, 'Matemática');
  });

  it('recusa assunto que não pertence à matéria escolhida', async () => {
    // Casar matéria e assunto errados faria o cronograma apontar para o
    // conteúdo errado sem nenhum aviso.
    const res = await admin.agent.post(`/api/admin/study-plans/${planId}/items`, {
      title: 'Passo torto',
      subject_id: matematica.id,
      topic_id: topicoPort.id,
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /não pertence/);

    const certo = await admin.agent.post(`/api/admin/study-plans/${planId}/items`, {
      title: 'Passo certo',
      subject_id: portugues.id,
      topic_id: topicoPort.id,
    });
    assert.equal(certo.status, 201);
    assert.equal(certo.body.topic_name, 'Interpretação');
    await admin.agent.del(`/api/admin/study-plans/${planId}/items/${certo.body.id}`);
  });

  it('reordena sem colidir com a unicidade de posição', async () => {
    // O caso perigoso: (plan_id, position) é único, então inverter a ordem
    // cruza posições ainda ocupadas se a troca for feita de uma vez.
    const antes = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    const invertido = antes.body.items.map((i) => i.id).reverse();

    const res = await admin.agent.patch(`/api/admin/study-plans/${planId}/items/reorder`, { ids: invertido });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.items.map((i) => i.position),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      res.body.items.map((i) => i.id),
      invertido
    );
    assert.deepEqual(
      res.body.items.map((i) => i.title),
      antes.body.items.map((i) => i.title).reverse()
    );
  });

  it('exige a ordem completa ao reordenar', async () => {
    const plano = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    const res = await admin.agent.patch(`/api/admin/study-plans/${planId}/items/reorder`, {
      ids: [plano.body.items[0].id],
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /ordem completa/);
  });

  it('fecha o buraco na numeração ao apagar um passo do meio', async () => {
    const antes = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    const doMeio = antes.body.items[1];

    const res = await admin.agent.del(`/api/admin/study-plans/${planId}/items/${doMeio.id}`);
    assert.equal(res.status, 200);

    const depois = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    assert.deepEqual(
      depois.body.items.map((i) => i.position),
      [1, 2, 3]
    );
    assert.ok(!depois.body.items.some((i) => i.id === doMeio.id));
  });

  it('recalcula as semanas quando o ritmo muda', async () => {
    const res = await admin.agent.put(`/api/admin/study-plans/${planId}`, { lessons_per_week: 1 });
    assert.equal(res.status, 200);
    // uma aula por semana: cada passo em uma semana
    assert.deepEqual(
      res.body.items.map((i) => i.week),
      [1, 2, 3]
    );
    await admin.agent.put(`/api/admin/study-plans/${planId}`, { lessons_per_week: 3 });
  });

  it('não apaga um plano ativo', async () => {
    const res = await admin.agent.del(`/api/admin/study-plans/${planId}`);
    assert.equal(res.status, 409);
    assert.match(JSON.stringify(res.body), /Desative/);

    await admin.agent.put(`/api/admin/study-plans/${planId}`, { active: false });
    const depois = await admin.agent.del(`/api/admin/study-plans/${planId}`);
    assert.equal(depois.status, 200);

    const sumiu = await admin.agent.get(`/api/admin/study-plans/${planId}`);
    assert.equal(sumiu.status, 404);
  });
});

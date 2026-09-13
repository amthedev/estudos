'use strict';

/**
 * Banco de questões: a IA elabora quando o filtro do aluno não acha nada.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/bank-generate.test.js
 *
 * O combinado com o cliente: "a IA pega lá do banco de questões e, caso não
 * tiver no banco, ela gera ela mesma". O aluno filtra por matéria ou assunto,
 * não vem nada, e pede para a IA elaborar.
 *
 * O que não pode quebrar: a questão elaborada tem que APARECER no mesmo filtro
 * que estava vazio (senão o botão é enfeite), ficar gravada para o próximo
 * aluno, e o teto diário por aluno tem que valer aqui como vale na aula.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

let ctx;
let db;
let aluno;
let subject;
let topic;

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  aluno = await ctx.registerStudent({ name: 'Aluno do Banco Vazio' });
  subject = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-bg', 'Matemática', 1) RETURNING id`
  );
  topic = await db.one(
    `INSERT INTO topics (subject_id, slug, name, description, sort_order)
     VALUES ($1, 'porcentagem', 'Porcentagem', 'Razão centesimal e descontos.', 1) RETURNING id`,
    [subject.id]
  );
  await db.query(`INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, 'juros', 'Juros simples', 0)`, [
    topic.id,
  ]);
});

after(async () => {
  await ctx.close();
});

describe('Questões elaboradas a partir do banco vazio', () => {
  it('o filtro do aluno não acha nada antes de gerar', async () => {
    const res = await aluno.agent.get(`/api/questions?topic_id=${topic.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 0, 'o cenário precisa começar vazio');
  });

  it('a IA elabora as questões daquele assunto', async () => {
    const res = await aluno.agent.post('/api/questions/generate', { topic_id: topic.id, difficulty: 2 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.generated >= 1);
    for (const questao of res.body.questions) {
      assert.equal(questao.difficulty, 2);
      for (const alternativa of questao.options) {
        assert.equal(alternativa.is_correct, undefined, 'o gabarito nunca sai junto');
      }
    }
  });

  it('e elas aparecem no MESMO filtro que estava vazio', async () => {
    const res = await aluno.agent.get(`/api/questions?topic_id=${topic.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1, 'senão o botão de elaborar é enfeite');
  });

  it('ficam gravadas para o próximo aluno, sem nova chamada de IA', async () => {
    const outro = await ctx.registerStudent({ name: 'Aluno Seguinte' });
    const antes = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`);
    const res = await outro.agent.get(`/api/questions?topic_id=${topic.id}`);
    assert.ok(res.body.items.length >= 1);
    const depois = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`);
    assert.equal(depois.total, antes.total, 'só pesquisar não pode gastar IA');
  });

  it('gerar por matéria também funciona', async () => {
    const outro = await ctx.registerStudent({ name: 'Aluno da Matéria' });
    const res = await outro.agent.post('/api/questions/generate', { subject_id: subject.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.generated >= 1);
  });

  it('sem matéria nem assunto, recusa em vez de gerar qualquer coisa', async () => {
    const res = await aluno.agent.post('/api/questions/generate', {});
    assert.equal(res.status, 400);
  });

  it('o teto diário do aluno vale aqui também', async () => {
    const questionAi = require('../server/services/question-ai');
    const cansado = await ctx.registerStudent({ name: 'Aluno no Teto' });
    for (let i = 0; i < questionAi.GERACOES_POR_DIA; i += 1) {
      await db.query(
        `INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'ok', 100)`,
        [cansado.user.id]
      );
    }
    const res = await cansado.agent.post('/api/questions/generate', { topic_id: topic.id });
    assert.equal(res.status, 429, JSON.stringify(res.body));
    assert.match(res.body.error.message, /hoje/i);
  });

  it('visitante sem sessão não manda a plataforma gastar IA', async () => {
    const res = await ctx.request('POST', '/api/questions/generate', { body: { topic_id: topic.id } });
    assert.ok([401, 403].includes(res.status), `respondeu ${res.status}`);
  });
});

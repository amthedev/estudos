'use strict';

/**
 * Aviso do aluno sobre uma questão e fila de conferência do painel.
 *
 *   NODE_ENV=test node --test tests/question-review.test.js
 *
 * Existe por causa de uma decisão tomada de olhos abertos: a questão elaborada
 * pela IA entra ATIVA no banco, sem esperar conferência, porque o caderno de
 * erros só lista questão ativa — escondê-la faria o erro do aluno desaparecer
 * da lista dele. O preço é que um gabarito errado pode chegar antes de alguém
 * olhar, e estes dois caminhos são a contrapartida.
 *
 * O que não pode quebrar: o aluno consegue avisar, avisar de novo não enche a
 * fila, um aluno não vê nem mexe no chamado de outro, e marcar como conferida
 * fecha os avisos — senão a fila nunca esvazia.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

async function seedQuestion(db, { generatedByAi = false } = {}) {
  const subject = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ($1, 'Matemática', 1) RETURNING id`,
    [`mat-${Math.random().toString(36).slice(2, 8)}`]
  );
  const topic = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
    [subject.id]
  );
  const question = await db.one(
    `INSERT INTO questions (subject_id, topic_id, statement, difficulty, generated_by_ai)
     VALUES ($1, $2, 'Enunciado com tamanho suficiente para passar na validação.', 2, $3)
     RETURNING id`,
    [subject.id, topic.id, generatedByAi]
  );
  for (const [index, letter] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [question.id, letter, `Alternativa ${letter}`, index === 0, index]
    );
  }
  return { subject, topic, question };
}

// Um contexto para o arquivo inteiro: o pool do banco é compartilhado, e
// fechá-lo no fim do primeiro bloco derrubaria o segundo.
let ctx;
let db;
let admin;
let aluno;
let outro;
let conteudo;
let daIa;
let deProva;

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  admin = await ctx.loginAdmin();
  aluno = await ctx.registerStudent({ name: 'Aluno Atento' });
  outro = await ctx.registerStudent({ name: 'Outro Aluno' });
  conteudo = await seedQuestion(db, { generatedByAi: true });
  daIa = await seedQuestion(db, { generatedByAi: true });
  deProva = await seedQuestion(db, { generatedByAi: false });
});

after(async () => {
  await ctx.close();
});

describe('Aviso do aluno sobre uma questão', () => {
  it('o aluno avisa que o gabarito está errado', async () => {
    const res = await aluno.agent.post(`/api/questions/${conteudo.question.id}/report`, {
      reason: 'gabarito',
      comment: 'A conta dá 30%, que é a alternativa C.',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.reason, 'gabarito');

    const linha = await db.one('SELECT reason, comment, status FROM question_reports WHERE question_id = $1', [
      conteudo.question.id,
    ]);
    assert.equal(linha.status, 'aberto');
    assert.match(linha.comment, /30%/);
  });

  it('avisar de novo atualiza, em vez de encher a fila', async () => {
    const res = await aluno.agent.post(`/api/questions/${conteudo.question.id}/report`, { reason: 'enunciado' });
    assert.equal(res.status, 201);

    const linhas = await db.many('SELECT reason FROM question_reports WHERE question_id = $1', [conteudo.question.id]);
    assert.equal(linhas.length, 1, 'continua um chamado por aluno');
    assert.equal(linhas[0].reason, 'enunciado', 'o motivo passa a ser o último informado');
  });

  it('dois alunos abrem dois chamados', async () => {
    const res = await outro.agent.post(`/api/questions/${conteudo.question.id}/report`, { reason: 'alternativas' });
    assert.equal(res.status, 201);
    const linhas = await db.many('SELECT id FROM question_reports WHERE question_id = $1', [conteudo.question.id]);
    assert.equal(linhas.length, 2);
  });

  it('recusa um motivo que não existe', async () => {
    const res = await aluno.agent.post(`/api/questions/${conteudo.question.id}/report`, { reason: 'nao-gostei' });
    assert.equal(res.status, 400);
  });

  it('não deixa avisar sobre questão inexistente', async () => {
    const res = await aluno.agent.post('/api/questions/00000000-0000-0000-0000-000000000000/report', {
      reason: 'outro',
    });
    assert.equal(res.status, 404);
  });

  it('visitante sem sessão não abre chamado', async () => {
    const res = await ctx.request('POST', `/api/questions/${conteudo.question.id}/report`, {
      body: { reason: 'gabarito' },
    });
    assert.ok([401, 403].includes(res.status), `respondeu ${res.status}`);
  });
});

describe('Fila de conferência do painel', () => {
  it('separa o que a IA escreveu do que veio de prova', async () => {
    const ia = await admin.agent.get('/api/admin/questions?origem=ia');
    assert.equal(ia.status, 200);
    const idsIa = ia.body.items.map((q) => q.id);
    assert.ok(idsIa.includes(daIa.question.id));
    assert.ok(!idsIa.includes(deProva.question.id), 'questão de prova não entra na fila da IA');

    const humana = await admin.agent.get('/api/admin/questions?origem=humana');
    const idsHumana = humana.body.items.map((q) => q.id);
    assert.ok(idsHumana.includes(deProva.question.id));
    assert.ok(!idsHumana.includes(daIa.question.id));
  });

  it('lista o que ninguém conferiu ainda', async () => {
    const res = await admin.agent.get('/api/admin/questions?conferencia=pendente');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 2, 'nenhuma foi conferida ainda');
    for (const item of res.body.items) assert.equal(item.reviewed_at, null);
  });

  it('lista o que aluno reclamou', async () => {
    await aluno.agent.post(`/api/questions/${daIa.question.id}/report`, { reason: 'gabarito' });

    const res = await admin.agent.get('/api/admin/questions?conferencia=reclamada');
    assert.equal(res.status, 200);
    const reclamada = res.body.items.find((q) => q.id === daIa.question.id);
    assert.ok(reclamada, 'a questão reclamada aparece na fila');
    assert.equal(reclamada.open_reports, 1, 'a contagem de avisos chega ao painel');
  });

  it('o painel lê o que o aluno escreveu', async () => {
    const res = await admin.agent.get(`/api/admin/questions/${daIa.question.id}/reports`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].reason, 'gabarito');
    assert.equal(res.body.items[0].user_name, 'Aluno Atento');
  });

  it('marcar como conferida fecha os avisos', async () => {
    const res = await admin.agent.patch('/api/admin/questions/revisao', {
      ids: [daIa.question.id],
      reviewed: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.updated, 1);

    const questao = await db.one('SELECT reviewed_at FROM questions WHERE id = $1', [daIa.question.id]);
    assert.ok(questao.reviewed_at, 'a data de conferência foi gravada');

    const chamado = await db.one('SELECT status, resolved_at FROM question_reports WHERE question_id = $1', [
      daIa.question.id,
    ]);
    assert.equal(chamado.status, 'resolvido', 'senão a fila nunca esvazia');
    assert.ok(chamado.resolved_at);

    const fila = await admin.agent.get('/api/admin/questions?conferencia=reclamada');
    assert.ok(!fila.body.items.some((q) => q.id === daIa.question.id), 'sai da fila depois de conferida');
  });

  it('conferir e desativar de uma vez', async () => {
    const res = await admin.agent.patch('/api/admin/questions/revisao', {
      ids: [deProva.question.id],
      reviewed: true,
      active: false,
    });
    assert.equal(res.status, 200);
    const questao = await db.one('SELECT active, reviewed_at FROM questions WHERE id = $1', [deProva.question.id]);
    assert.equal(questao.active, false);
    assert.ok(questao.reviewed_at);
  });

  it('aluno não alcança a fila de conferência', async () => {
    const lista = await aluno.agent.get('/api/admin/questions?conferencia=pendente');
    assert.ok([401, 403].includes(lista.status));
    const patch = await aluno.agent.patch('/api/admin/questions/revisao', { ids: [daIa.question.id] });
    assert.ok([401, 403].includes(patch.status));
  });
});

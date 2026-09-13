'use strict';

/**
 * O que o cliente relatou usando a plataforma, e o que a varredura achou junto.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/relato-do-cliente.test.js
 *
 * Em 13/09/2026 o Guilherme abriu o banco de questões e disse: "umas apareceram,
 * mas não tem de todos; quando clico pra filtrar matemática não aparece nenhuma",
 * "fica carregando infinito e no final dá um erro no canto da tela" e, no painel,
 * "acho que o (8)(1)(1) é o número de questões que subiram pro banco".
 *
 * O que não pode voltar a acontecer: o filtro esconder que a matéria está zerada,
 * um pedido de elaboração ficar pendurado sem prazo, o painel mostrar números que
 * não fecham, e — achados da mesma varredura — o mesmo estudo ser contado duas
 * vezes no simulado e no cronograma.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const questionAi = require('../server/services/question-ai');
const schedule = require('../server/services/schedule');

let ctx;
let db;
let aluno;
let exam;
let comQuestoes;
let semQuestoes;
let topic;

async function criarQuestao(subjectId, topicId, enunciado) {
  const questao = await db.one(
    `INSERT INTO questions (subject_id, topic_id, statement, difficulty)
     VALUES ($1, $2, $3, 2) RETURNING id`,
    [subjectId, topicId, enunciado]
  );
  for (const [ordem, letra] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [questao.id, letra, `Alternativa ${letra}`, ordem === 0, ordem]
    );
  }
  return questao;
}

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  aluno = await ctx.registerStudent({ name: 'Aluno do Relato' });

  exam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, sort_order)
     VALUES ('enem-rel', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1) RETURNING id`
  );
  comQuestoes = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('historia-rel', 'História', 1) RETURNING id`
  );
  semQuestoes = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-rel', 'Matemática', 2) RETURNING id`
  );

  topic = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'brasil-colonia', 'Brasil Colônia', 1) RETURNING id`,
    [comQuestoes.id]
  );
  // Matemática existe no conteúdo programático e não tem nenhuma questão: é
  // exatamente o cenário que o cliente encontrou.
  const vazio = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem-rel', 'Porcentagem', 1) RETURNING id`,
    [semQuestoes.id]
  );
  await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2), ($1, $3)', [exam.id, topic.id, vazio.id]);
  await criarQuestao(comQuestoes.id, topic.id, 'Questão de História cadastrada pelo professor, com enunciado longo o bastante.');
});

after(async () => {
  await ctx.close();
});

describe('Banco de questões: o filtro precisa contar a verdade', () => {
  it('a matéria sem nenhuma questão não entra na contagem dos filtros', async () => {
    const res = await aluno.agent.get('/api/questions/filters');
    assert.equal(res.status, 200);
    const nomes = res.body.subjects.map((materia) => materia.name);
    assert.ok(nomes.includes('História'), 'a matéria que tem questão precisa aparecer');
    assert.ok(!nomes.includes('Matemática'), 'a matéria zerada não pode ser oferecida como se tivesse questão');
  });

  it('e a que tem questão vem com o total, que é o rótulo mostrado ao aluno', async () => {
    const res = await aluno.agent.get('/api/questions/filters');
    const historia = res.body.subjects.find((materia) => materia.name === 'História');
    assert.equal(historia.total, 1);
    const assunto = res.body.topics.find((item) => item.name === 'Brasil Colônia');
    assert.equal(assunto.total, 1);
  });

  it('filtrar a matéria vazia devolve lista vazia, sem erro', async () => {
    const res = await aluno.agent.get(`/api/questions?subject_id=${semQuestoes.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.items.length, 0);
  });
});

describe('Elaboração por IA: com prazo, cancelável e dentro do filtro', () => {
  it('a questão elaborada com prova no filtro aparece no MESMO filtro', async () => {
    const res = await aluno.agent.post('/api/questions/generate', {
      subject_id: semQuestoes.id,
      exam_id: exam.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.generated >= 1);

    const lista = await aluno.agent.get(`/api/questions?subject_id=${semQuestoes.id}&exam_id=${exam.id}`);
    assert.equal(lista.status, 200);
    assert.ok(
      lista.body.items.length >= 1,
      'sem o vínculo com a prova, a tela recarregava dizendo "questões elaboradas" e continuava vazia'
    );
  });

  it('pedido já cancelado não chama a IA', async () => {
    const controller = new AbortController();
    controller.abort();
    const antes = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`);
    const criadas = await questionAi.fillPool({
      subjectId: comQuestoes.id,
      count: 5,
      userId: aluno.user.id,
      signal: controller.signal,
    });
    const depois = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`);
    assert.equal(criadas.length, 0);
    assert.equal(depois.total, antes.total, 'aluno que fechou a aba não pode continuar gastando IA');
  });

  it('prazo esgotado devolve o que deu tempo, em vez de insistir', async () => {
    const criadas = await questionAi.fillPool({
      subjectId: comQuestoes.id,
      count: 90,
      userId: aluno.user.id,
      prazoMs: 1,
    });
    assert.ok(Array.isArray(criadas), 'o prazo curto não pode virar exceção');
    assert.ok(criadas.length < 90, 'com o prazo estourado a elaboração para no meio');
  });

  it('a tentativa que falhou também conta no teto diário', async () => {
    const cansado = await ctx.registerStudent({ name: 'Aluno das Tentativas' });
    for (let i = 0; i < questionAi.TENTATIVAS_POR_DIA; i += 1) {
      await db.query(
        `INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'error', 100)`,
        [cansado.user.id]
      );
    }
    const res = await cansado.agent.post('/api/questions/generate', { subject_id: comQuestoes.id });
    assert.equal(res.status, 429, 'modelo quebrado não pode gastar sem limite justamente no dia em que não entrega nada');
  });
});

describe('Nada pode ser contado duas vezes', () => {
  it('finalizar o mesmo simulado duas vezes corrige uma vez só', async () => {
    const criado = await aluno.agent.post('/api/simulados/attempts', {
      type: 'subject',
      subject_id: comQuestoes.id,
      question_count: 1,
      duration_min: 30,
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const attemptId = criado.body.id;
    const questaoId = criado.body.questions[0].id;
    const alternativa = criado.body.questions[0].options[0].id;
    await aluno.agent.patch(`/api/simulados/attempts/${attemptId}/answers`, {
      question_id: questaoId,
      option_id: alternativa,
    });

    const [primeira, segunda] = await Promise.all([
      aluno.agent.post(`/api/simulados/attempts/${attemptId}/finish`, {}),
      aluno.agent.post(`/api/simulados/attempts/${attemptId}/finish`, {}),
    ]);
    const status = [primeira.status, segunda.status].sort();
    assert.deepEqual(status, [200, 409], `respostas: ${primeira.status} e ${segunda.status}`);

    const tentativas = await db.one(
      `SELECT count(*)::int AS total FROM question_attempts WHERE context = 'simulado' AND context_id = $1`,
      [attemptId]
    );
    assert.equal(tentativas.total, 1, 'duas correções gravavam a mesma resposta duas vezes');
    const registros = await db.one(
      `SELECT count(*)::int AS total FROM study_logs WHERE ref_id = $1 AND activity_type = 'simulado'`,
      [attemptId]
    );
    assert.equal(registros.total, 1, 'e contavam o tempo de estudo em dobro');
  });

  it('concluir, reabrir e concluir de novo conta o estudo uma vez', async () => {
    const item = await db.one(
      `INSERT INTO schedule_items (user_id, date, type, title, subject_id, duration_min)
       VALUES ($1, current_date, 'questions', 'Questões: História', $2, 20) RETURNING id`,
      [aluno.user.id, comQuestoes.id]
    );

    await schedule.completeItem(aluno.user.id, item.id);
    await schedule.setItemStatus(aluno.user.id, item.id, 'pending');
    await schedule.completeItem(aluno.user.id, item.id);

    const registros = await db.one(
      `SELECT count(*)::int AS total, coalesce(sum(minutes), 0)::int AS minutos
         FROM study_logs WHERE user_id = $1 AND ref_id = $2`,
      [aluno.user.id, item.id]
    );
    assert.equal(registros.total, 1, 'reabrir e concluir de novo somava as horas outra vez');
    assert.equal(registros.minutos, 20, 'um bloco de vinte minutos não pode virar quarenta');
  });
});

describe('Leitura da prova nao pode perder questao no meio do caminho', () => {
  const examImport = require('../server/services/exam-import');

  const catalogo = [
    { subject_slug: 'matematica', subject_name: 'Matemática', topic_slug: 'porcentagem', topic_name: 'Porcentagem' },
    { subject_slug: 'historia', subject_name: 'História', topic_slug: 'brasil-colonia', topic_name: 'Brasil Colônia' },
  ];
  const questoes = [
    { number: 1, statement: 'Enunciado da primeira questao, com tamanho suficiente.', A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' },
    { number: 2, statement: 'Enunciado da segunda questao, com tamanho suficiente.', A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' },
    { number: 3, statement: 'Enunciado da terceira questao, com tamanho suficiente.', A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' },
  ];

  it('modelo que pula itens nao apaga as questoes que ele pulou', () => {
    // O modelo classificou só a primeira. As outras duas ja estavam
    // transcritas: perde-las era transformar 80 questoes lidas em 36.
    const saida = examImport.mergeClassifications(
      questoes,
      { classifications: [{ item: 1, subject_slug: 'matematica', topic_slug: 'porcentagem', difficulty: 2, correct: 'A' }] },
      catalogo
    );
    assert.equal(saida.length, 3, 'as tres questoes precisam sobreviver');
    assert.equal(saida[0].topic_slug, 'porcentagem');
    assert.equal(saida[1].topic_slug, '', 'a nao classificada fica marcada, nao sumida');
    assert.equal(saida[2].topic_slug, '');
  });

  it('assunto inventado pelo modelo tambem nao apaga a questao', () => {
    const saida = examImport.mergeClassifications(
      questoes.slice(0, 1),
      { classifications: [{ item: 1, subject_slug: 'astrologia', topic_slug: 'signos', difficulty: 2 }] },
      catalogo
    );
    assert.equal(saida.length, 1);
    assert.equal(saida[0].topic_slug, '');
    assert.equal(saida[0].statement, questoes[0].statement, 'o enunciado transcrito continua inteiro');
  });

  it('so a materia errada, com assunto certo, continua sendo corrigido sozinho', () => {
    const saida = examImport.mergeClassifications(
      questoes.slice(0, 1),
      { classifications: [{ item: 1, subject_slug: 'historia', topic_slug: 'porcentagem', difficulty: 2 }] },
      catalogo
    );
    assert.equal(saida[0].subject_slug, 'matematica');
    assert.equal(saida[0].topic_slug, 'porcentagem');
  });

  it('questao sem resposta conhecida vira item de conferencia, nao lixo', () => {
    const bruto = {
      number: 7,
      statement: 'Enunciado transcrito por inteiro, com mais de vinte caracteres.',
      A: 'primeira', B: 'segunda', C: 'terceira', D: 'quarta', E: 'quinta',
      subject_slug: 'matematica',
      topic_slug: 'porcentagem',
    };
    const item = examImport.normalizeExtracted(bruto, { answerKey: null, exam: null, year: 2024, board: null });
    assert.ok(item, 'sem gabarito e sem letra deduzida a questao era descartada inteira');
    assert.equal(item.correct, '');
    assert.equal(item.needs_answer, true);
    assert.equal(item.answer_from_key, false);
  });

  it('gabarito oficial que nao cobre aquele numero cai na letra deduzida', () => {
    const bruto = {
      number: 12,
      statement: 'Enunciado transcrito por inteiro, com mais de vinte caracteres.',
      A: 'primeira', B: 'segunda', C: 'terceira', D: 'quarta', E: 'quinta',
      correct: 'D',
      subject_slug: 'matematica',
      topic_slug: 'porcentagem',
    };
    const item = examImport.normalizeExtracted(bruto, { answerKey: { 1: 'A' }, exam: null, year: 2024, board: null });
    assert.equal(item.correct, 'D');
    assert.equal(item.answer_from_key, false, 'letra deduzida continua exigindo conferencia');
  });

  it('gabarito oficial continua mandando quando cobre o numero', () => {
    const bruto = {
      number: 1,
      statement: 'Enunciado transcrito por inteiro, com mais de vinte caracteres.',
      A: 'primeira', B: 'segunda', C: 'terceira', D: 'quarta', E: 'quinta',
      correct: 'D',
      subject_slug: 'matematica',
      topic_slug: 'porcentagem',
    };
    const item = examImport.normalizeExtracted(bruto, { answerKey: { 1: 'B' }, exam: null, year: 2024, board: null });
    assert.equal(item.correct, 'B');
    assert.equal(item.answer_from_key, true);
  });
});

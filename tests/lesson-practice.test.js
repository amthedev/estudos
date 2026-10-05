'use strict';

/**
 * Pratique agora: três questões divididas entre os assuntos da aula.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/lesson-practice.test.js
 *
 * O cliente pediu um botão depois da aula que devolva três questões dos
 * assuntos dela, com o aluno escolhendo fácil, média ou difícil. A aula tem de
 * 1 a 3 assuntos (lesson_topics) e a divisão é dele: três assuntos, uma de
 * cada; dois, duas do primeiro e uma do segundo; um, as três dele. O banco vem
 * primeiro; o que faltar é elaborado na hora.
 *
 * O que não pode quebrar: a dificuldade escolhida tem que ser respeitada (senão
 * o botão é enfeite), a questão elaborada tem que ficar ATIVA — o caderno de
 * erros só lista questão ativa, e esconder a questão faria o erro do aluno
 * sumir da lista dele —, o que já existe no banco tem que ser usado antes de
 * gastar uma chamada de IA, e cada questão tem que ficar no assunto do SEU
 * alvo: a questão de Regra de Três gravada como Porcentagem joga o desempenho
 * do aluno no assunto errado.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

/** Matéria, assunto com três subassuntos e uma aula — o cenário mínimo do recurso. */
async function seedContent(db) {
  const subject = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-prat', 'Matemática', 1) RETURNING id`
  );
  const topic = await db.one(
    `INSERT INTO topics (subject_id, slug, name, description, sort_order)
     VALUES ($1, 'porcentagem', 'Porcentagem', 'Razão centesimal, aumentos e descontos sucessivos.', 1)
     RETURNING id`,
    [subject.id]
  );
  const subtopics = [];
  const nomes = ['Razão centesimal', 'Aumentos e descontos', 'Juros simples'];
  for (const [index, name] of nomes.entries()) {
    subtopics.push(
      await db.one(
        `INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
        [topic.id, `sub-${index}`, name, index]
      )
    );
  }
  const lesson = await db.one(
    `INSERT INTO lessons (subject_id, topic_id, subtopic_id, slug, title, description, summary, duration_min)
     VALUES ($1, $2, $3, 'aula-porcentagem', 'Porcentagem do zero', 'Como ler e calcular porcentagens.',
             'Nesta aula: razão centesimal, aumentos e descontos sucessivos e uma introdução a juros simples.', 20)
     RETURNING id`,
    [subject.id, topic.id, subtopics[0].id]
  );
  return { subject, topic, subtopics, lesson };
}

/** Grava uma questão de banco no assunto, na dificuldade pedida. */
async function seedQuestion(db, { subject, topic, subtopicId, difficulty, statement }) {
  const question = await db.one(
    `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, difficulty, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [subject.id, topic.id, subtopicId, statement, difficulty]
  );
  for (const [index, letter] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [question.id, letter, `Alternativa ${letter}`, index === 0, index]
    );
  }
  return question.id;
}

async function aiCalls(db) {
  const row = await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`);
  return row ? row.total : 0;
}

let sequencia = 0;

/**
 * Aula com vários assuntos, na ordem dada: o primeiro é o principal
 * (lessons.topic_id, que o gatilho da migration 223 põe na posição 1) e os
 * outros entram em lesson_topics nas posições seguintes.
 */
async function seedMultiTopicLesson(db, subject, names) {
  sequencia += 1;
  const topics = [];
  for (const [index, name] of names.entries()) {
    topics.push(
      await db.one(
        `INSERT INTO topics (subject_id, slug, name, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
        [subject.id, `multi-${sequencia}-${index}`, name, `Ementa de ${name}.`, 100 + sequencia * 10 + index]
      )
    );
  }
  const lesson = await db.one(
    `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min)
     VALUES ($1, $2, $3, $4, 20) RETURNING id`,
    [subject.id, topics[0].id, `aula-multi-${sequencia}`, names.join(', ')]
  );
  for (const [index, topic] of topics.entries()) {
    if (index === 0) continue;
    await db.query(
      `INSERT INTO lesson_topics (lesson_id, position, topic_id, source) VALUES ($1, $2, $3, 'manual')`,
      [lesson.id, index + 1, topic.id]
    );
  }
  return { lesson, topics };
}

/** Questão como a IA devolve, para os clientes falsos abaixo. */
function questaoDaIa(target, assunto) {
  return {
    target,
    statement: `Questão elaborada sobre ${assunto}, com contexto suficiente para responder sem a aula.`,
    options: ['A', 'B', 'C', 'D', 'E'].map((letter, index) => ({
      letter,
      text: `Alternativa ${letter} de ${assunto}`,
      is_correct: index === 1,
    })),
    resolution: `Resolução de ${assunto}.`,
    explanation: `Distratores de ${assunto}.`,
  };
}

/** Cliente de IA que devolve exatamente o JSON dado e guarda o prompt recebido. */
function clienteFixo(data, prompts = []) {
  return {
    chat: {
      completions: {
        async create(params) {
          prompts.push(params.messages.map((message) => message.content).join('\n'));
          return {
            model: 'teste',
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(data) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        },
      },
    },
  };
}

describe('Pratique agora com questões da IA', () => {
  let ctx;
  let db;
  let content;
  let student;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    content = await seedContent(db);
    student = await ctx.registerStudent({ name: 'Aluna da Prática' });
  });

  after(async () => {
    await ctx.close();
  });

  it('com o banco vazio, elabora uma questão para cada assunto da aula', async () => {
    const res = await student.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.questions.length, 3, 'três questões, uma por assunto');
    assert.equal(res.body.from_bank, 0);
    assert.equal(res.body.generated, 3);
    assert.deepEqual(res.body.subjects, content.subtopics.map((_, i) => ['Razão centesimal', 'Aumentos e descontos', 'Juros simples'][i]));

    for (const question of res.body.questions) {
      assert.equal(question.difficulty, 2, 'a dificuldade pedida é a da questão');
      assert.ok(question.statement.length > 20);
      assert.equal(question.options.length, 5);
      for (const option of question.options) {
        assert.equal(option.is_correct, undefined, 'o gabarito nunca sai junto com a questão');
      }
    }

    const gravadas = await db.many(
      `SELECT id, active, generated_by_ai, lesson_id, subtopic_id, difficulty
         FROM questions WHERE lesson_id = $1`,
      [content.lesson.id]
    );
    assert.equal(gravadas.length, 3);
    for (const row of gravadas) {
      assert.equal(row.generated_by_ai, true);
      assert.equal(row.active, true, 'questão inativa sumiria do caderno de erros do aluno');
      assert.equal(row.difficulty, 2);
    }
    const assuntos = gravadas.map((row) => row.subtopic_id).sort();
    // Aula de um assunto só: as três vagas são dele, espalhadas pelos
    // subassuntos (o da aula primeiro) para não sair três vezes a mesma coisa.
    assert.deepEqual(assuntos, content.subtopics.map((s) => s.id).sort(), 'uma questão por subassunto');
    assert.deepEqual(
      res.body.topics.map((topic) => [topic.topic_id, topic.questions]),
      [[content.topic.id, 3]],
      'um assunto: as três questões são dele'
    );
  });

  it('cada nível de dificuldade gera o seu próprio conjunto', async () => {
    const res = await student.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 3 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.difficulty, 3);
    for (const question of res.body.questions) assert.equal(question.difficulty, 3);
  });

  it('sem dificuldade informada, usa a média', async () => {
    const res = await student.agent.post(`/api/lessons/${content.lesson.id}/practice`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.difficulty, 2);
  });

  it('recusa uma dificuldade fora da escala', async () => {
    const res = await student.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 7 });
    assert.equal(res.status, 400);
  });

  it('usa o que já existe no banco antes de gastar uma chamada de IA', async () => {
    // Um aluno novo, e as três questões do nível 1 já cadastradas à mão.
    for (const [index, subtopic] of content.subtopics.entries()) {
      await seedQuestion(db, {
        subject: content.subject,
        topic: content.topic,
        subtopicId: subtopic.id,
        difficulty: 1,
        statement: `Questão de prova número ${index + 1} sobre porcentagem, cadastrada pelo professor.`,
      });
    }
    const outro = await ctx.registerStudent({ name: 'Aluno com Banco Cheio' });
    const antes = await aiCalls(db);

    const res = await outro.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 1 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.from_bank, 3, 'as três vieram do banco');
    assert.equal(res.body.generated, 0);
    assert.equal(await aiCalls(db), antes, 'nenhuma chamada de IA foi feita');
  });

  it('a questão elaborada é reaproveitada pelo próximo aluno', async () => {
    const outro = await ctx.registerStudent({ name: 'Aluno que Chegou Depois' });
    const antes = await aiCalls(db);

    const res = await outro.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.from_bank, 3, 'as questões do primeiro aluno servem para este');
    assert.equal(await aiCalls(db), antes, 'não gera de novo o que já existe');
  });

  it('o aluno responde e o erro entra no caderno de erros', async () => {
    // É por isto que a questão elaborada fica ativa: o caderno de erros filtra
    // por questão ativa, e uma questão escondida faria o erro sumir da lista.
    const aluno = await ctx.registerStudent({ name: 'Aluno que Errou' });
    const res = await aluno.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 3 });
    assert.equal(res.status, 200);
    const question = res.body.questions[0];

    const correta = await db.one(
      'SELECT id FROM question_options WHERE question_id = $1 AND is_correct',
      [question.id]
    );
    const errada = question.options.find((option) => option.id !== correta.id);

    const resposta = await aluno.agent.post(`/api/questions/${question.id}/answer`, {
      option_id: errada.id,
      context: 'practice',
      context_id: content.lesson.id,
    });
    assert.equal(resposta.status, 201, JSON.stringify(resposta.body));
    assert.equal(resposta.body.is_correct, false);
    assert.equal(resposta.body.correct_option_id, correta.id);

    const caderno = await aluno.agent.get('/api/errors');
    assert.equal(caderno.status, 200);
    const items = caderno.body.items || [];
    assert.ok(
      items.some((item) => item.question_id === question.id),
      'a questão errada aparece no caderno de erros'
    );
  });

  it('a IA falhando não zera o que o banco já tinha', async () => {
    // Havia um buraco: a chamada não estava protegida, e o 503 da IA descia
    // inteiro — o aluno com duas questões no banco recebia zero.
    const ai = require('../server/services/ai');
    const subtopic = content.subtopics[0];
    await seedQuestion(db, {
      subject: content.subject,
      topic: content.topic,
      subtopicId: subtopic.id,
      difficulty: 3,
      statement: 'Única questão de nível difícil cadastrada pelo professor para este assunto.',
    });

    const aluno = await ctx.registerStudent({ name: 'Aluno com IA Fora do Ar' });
    ai.setClientForTests({
      chat: { completions: { async create() { throw Object.assign(new Error('503 upstream'), { status: 503 }); } } },
    });
    try {
      const res = await aluno.agent.post(`/api/lessons/${content.lesson.id}/practice`, { difficulty: 3 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.questions.length >= 1, 'entrega o que o banco tinha');
      assert.equal(res.body.generated, 0);
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('sem nada no banco e com a IA fora do ar, explica em vez de entregar tela vazia', async () => {
    const ai = require('../server/services/ai');
    const vazio = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min)
       VALUES ($1, $2, 'aula-sem-banco', 'Aula sem questões', 15) RETURNING id`,
      [content.subject.id, content.topic.id]
    );
    // um assunto novo, sem questão nenhuma
    const outroTopic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'vazio', 'Assunto vazio', 9) RETURNING id`,
      [content.subject.id]
    );
    await db.query('UPDATE lessons SET topic_id = $2 WHERE id = $1', [vazio.id, outroTopic.id]);

    const aluno = await ctx.registerStudent({ name: 'Aluno sem Sorte' });
    ai.setClientForTests({
      chat: { completions: { async create() { throw Object.assign(new Error('503 upstream'), { status: 503 }); } } },
    });
    try {
      const res = await aluno.agent.post(`/api/lessons/${vazio.id}/practice`, { difficulty: 2 });
      assert.equal(res.status, 503);
      assert.match(res.body.error.message, /instantes|montar/i);
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('o aluno tem teto diário de questões novas', async () => {
    const questionAi = require('../server/services/question-ai');
    const aluno = await ctx.registerStudent({ name: 'Aluno Insaciável' });
    // Marca o consumo do dia como já estourado, sem precisar gerar de verdade.
    for (let i = 0; i < questionAi.GERACOES_POR_DIA; i += 1) {
      await db.query(
        `INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'ok', 100)`,
        [aluno.user.id]
      );
    }

    // Assunto sem banco: só a IA poderia atender, e ela está barrada.
    const topicVazio = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'teto', 'Assunto do teto', 20) RETURNING id`,
      [content.subject.id]
    );
    const aula = await db.one(
      `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min)
       VALUES ($1, $2, 'aula-teto', 'Aula do teto', 15) RETURNING id`,
      [content.subject.id, topicVazio.id]
    );

    const res = await aluno.agent.post(`/api/lessons/${aula.id}/practice`, { difficulty: 2 });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.match(res.body.error.message, /hoje/i, 'diz que o limite é do dia, não que deu erro');
  });

  // -------------------------------------------------------------------------
  // Aulas com vários assuntos
  // -------------------------------------------------------------------------

  it('aula com três assuntos: uma questão de cada, gravada no assunto dela', async () => {
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, [
      'Razão e proporção',
      'Regra de três',
      'Porcentagem simples',
    ]);
    const aluno = await ctx.registerStudent({ name: 'Aluna dos Três Assuntos' });

    const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.questions.length, 3);
    assert.equal(res.body.generated, 3);
    assert.deepEqual(
      res.body.questions.map((question) => question.topic_id),
      topics.map((topic) => topic.id),
      'na ordem do título, uma de cada assunto'
    );
    assert.deepEqual(
      res.body.questions.map((question) => question.topic_name),
      topics.map((topic) => topic.name),
      'cada questão diz o assunto dela, não o principal da aula'
    );
    assert.deepEqual(res.body.topics.map((topic) => topic.questions), [1, 1, 1]);

    const gravadas = await db.many('SELECT topic_id FROM questions WHERE lesson_id = $1', [lesson.id]);
    assert.deepEqual(
      gravadas.map((row) => row.topic_id).sort(),
      topics.map((topic) => topic.id).sort(),
      'a questão de Regra de Três é gravada em Regra de Três'
    );
  });

  it('aula com dois assuntos: duas do primeiro e uma do segundo', async () => {
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, ['Função afim', 'Função quadrática']);
    const aluno = await ctx.registerStudent({ name: 'Aluno dos Dois Assuntos' });

    const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 2 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.questions.map((question) => question.topic_id),
      [topics[0].id, topics[0].id, topics[1].id]
    );
    assert.deepEqual(res.body.topics.map((topic) => topic.questions), [2, 1]);
  });

  it('a página da aula traz os assuntos, a parte de cada um na prática e as questões de todos', async () => {
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, ['Geometria plana', 'Trigonometria']);
    for (const [index, topic] of topics.entries()) {
      await seedQuestion(db, {
        subject: content.subject,
        topic,
        subtopicId: null,
        difficulty: 2,
        statement: `Questão de banco número ${index + 1} sobre ${topic.name}, cadastrada pelo professor.`,
      });
    }
    const res = await student.agent.get(`/api/lessons/${lesson.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.topics.map((topic) => [topic.topic_id, topic.topic_name, topic.practice_questions]),
      [
        [topics[0].id, 'Geometria plana', 2],
        [topics[1].id, 'Trigonometria', 1],
      ]
    );
    assert.equal(res.body.topic_id, topics[0].id, 'o principal continua sendo o primeiro');
    assert.equal(res.body.questions_available, 2, 'conta as questões dos dois assuntos, não só do principal');
    assert.equal(res.body.questions_status, undefined, 'o estado da fila de geração não é assunto do aluno');
  });

  it('usa o banco de cada assunto e só pede à IA as vagas que faltam', async () => {
    const ai = require('../server/services/ai');
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, [
      'Estatística descritiva',
      'Probabilidade básica',
      'Análise combinatória',
    ]);
    const doBanco = await seedQuestion(db, {
      subject: content.subject,
      topic: topics[1],
      subtopicId: null,
      difficulty: 1,
      statement: 'Questão de prova sobre probabilidade básica, a única do banco nesta aula.',
    });
    const aluno = await ctx.registerStudent({ name: 'Aluno do Banco Parcial' });

    // o simulador de sempre, guardando o prompt que ele recebeu
    const simulador = ai.getClient();
    const prompts = [];
    ai.setClientForTests({
      chat: {
        completions: {
          async create(params, options) {
            prompts.push(params.messages.map((message) => message.content).join('\n'));
            return simulador.chat.completions.create(params, options);
          },
        },
      },
    });
    try {
      const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 1 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.from_bank, 1);
      assert.equal(res.body.generated, 2);
      assert.deepEqual(res.body.questions.map((question) => question.topic_id), topics.map((topic) => topic.id));
      assert.equal(res.body.questions[1].id, doBanco, 'a vaga de Probabilidade ficou com a questão do banco');

      assert.equal(prompts.length, 1, 'uma chamada para as duas vagas vazias');
      assert.match(prompts[0], /Elabore 2 questões/);
      assert.match(prompts[0], /1\. Estatística descritiva/);
      assert.match(prompts[0], /2\. Análise combinatória/);
      // (o título da aula, que cita os três, continua no prompt como contexto)
      assert.doesNotMatch(prompts[0], /^\d+\. Probabilidade/m, 'o assunto que o banco cobriu não vira item');
      assert.doesNotMatch(prompts[0], /^- Probabilidade/m, 'nem entra na lista de assuntos a cobrar');
      assert.match(prompts[0], /^Assuntos da aula:$/m);
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('casa a questão elaborada pelo alvo, não pela posição', async () => {
    // A IA devolve fora de ordem, duas do primeiro assunto e nenhuma do
    // segundo. Casando pela posição, a sobra do primeiro ocupava a vaga do
    // segundo e a prática prometia três assuntos entregando dois.
    const ai = require('../server/services/ai');
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, [
      'Juros simples e compostos',
      'Equações do 1º grau',
      'Sistemas lineares',
    ]);
    const aluno = await ctx.registerStudent({ name: 'Aluno do Alvo' });
    ai.setClientForTests(
      clienteFixo({
        questions: [
          questaoDaIa(3, 'sistemas lineares'),
          questaoDaIa(1, 'juros'),
          questaoDaIa(1, 'juros, de novo'),
        ],
      })
    );
    try {
      const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 3 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        res.body.questions.map((question) => question.topic_id),
        [topics[0].id, topics[2].id],
        'a vaga de Equações fica vazia em vez de receber uma questão de juros'
      );
      assert.match(res.body.questions[1].statement, /sistemas lineares/);

      const gravadas = await db.many('SELECT topic_id, statement FROM questions WHERE lesson_id = $1', [lesson.id]);
      assert.equal(gravadas.length, 3, 'a sobra de juros vai para o banco, no assunto dela');
      assert.equal(gravadas.filter((row) => row.topic_id === topics[0].id).length, 2);
      assert.equal(gravadas.filter((row) => row.topic_id === topics[1].id).length, 0);
      assert.ok(gravadas.find((row) => row.topic_id === topics[2].id).statement.includes('sistemas lineares'));
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('questão que não diz o alvo ocupa a única vaga vazia', async () => {
    const ai = require('../server/services/ai');
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, [
      'Logaritmos',
      'Exponenciais',
      'Progressões',
    ]);
    const aluno = await ctx.registerStudent({ name: 'Aluno do Alvo Perdido' });
    ai.setClientForTests(
      clienteFixo({
        questions: [questaoDaIa(3, 'progressões'), questaoDaIa(null, 'exponenciais'), questaoDaIa(1, 'logaritmos')],
      })
    );
    try {
      const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 3 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.questions.map((question) => question.topic_id), topics.map((topic) => topic.id));
      assert.match(res.body.questions[1].statement, /exponenciais/);
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('duas questões sem alvo para duas vagas: nenhuma é gravada num assunto adivinhado', async () => {
    // Casadas pela ordem da resposta, a de progressões ia para a vaga de
    // Exponenciais e a de exponenciais para a de Progressões.
    const ai = require('../server/services/ai');
    const { lesson, topics } = await seedMultiTopicLesson(db, content.subject, [
      'Funções trigonométricas',
      'Exponenciais e logaritmos',
      'Progressões aritméticas',
    ]);
    const aluno = await ctx.registerStudent({ name: 'Aluno dos Alvos Trocados' });
    ai.setClientForTests(
      clienteFixo({
        questions: [
          questaoDaIa(1, 'trigonometria'),
          questaoDaIa(null, 'progressões'),
          questaoDaIa(null, 'exponenciais'),
        ],
      })
    );
    try {
      const res = await aluno.agent.post(`/api/lessons/${lesson.id}/practice`, { difficulty: 3 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.questions.map((question) => question.topic_id), [topics[0].id]);
      const gravadas = await db.many('SELECT topic_id, statement FROM questions WHERE lesson_id = $1', [lesson.id]);
      assert.equal(gravadas.length, 1, 'as duas sem alvo não foram gravadas em assunto nenhum');
      assert.equal(gravadas[0].topic_id, topics[0].id);
    } finally {
      ai.setClientForTests(null);
    }
  });

  it('só deduz o alvo quando não há escolha: uma questão sem alvo e uma vaga vazia', () => {
    const questionAi = require('../server/services/question-ai');
    const pedidos = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    const item = (index, nome) => ({ index, target: index === null ? null : pedidos[index], statement: nome });

    // uma sem alvo, uma vaga: é dela
    assert.deepEqual(
      questionAi.placeGenerated([item(0, 'a'), item(null, 'x'), item(2, 'c')], pedidos).map((q) => [q.index, q.statement]),
      [[0, 'a'], [1, 'x'], [2, 'c']]
    );
    // duas sem alvo, duas vagas: as duas saem
    assert.deepEqual(
      questionAi.placeGenerated([item(0, 'a'), item(null, 'sobre C'), item(null, 'sobre B')], pedidos).map((q) => q.statement),
      ['a']
    );
    // uma sem alvo, duas vagas (o alvo 1 veio repetido): pode ser de B ou de C, sai
    assert.deepEqual(
      questionAi.placeGenerated([item(0, 'a'), item(0, 'a2'), item(null, 'x')], pedidos).map((q) => [q.index, q.statement]),
      [[0, 'a'], [0, 'a2']]
    );
    // sem vaga sobrando, a sem alvo sai
    assert.equal(questionAi.placeGenerated([item(0, 'a'), item(1, 'b'), item(2, 'c'), item(null, 'x')], pedidos).length, 3);
  });

  it('a divisão das vagas segue a regra do cliente', () => {
    const questionAi = require('../server/services/question-ai');
    assert.deepEqual(questionAi.distribute(3), [1, 1, 1]);
    assert.deepEqual(questionAi.distribute(2), [2, 1]);
    assert.deepEqual(questionAi.distribute(1), [3]);
    assert.deepEqual(questionAi.distribute(0), []);
  });

  it('aula que não existe responde 404', async () => {
    const res = await student.agent.post('/api/lessons/00000000-0000-0000-0000-000000000000/practice', {});
    assert.equal(res.status, 404);
  });

  it('visitante sem sessão não dispara geração', async () => {
    const res = await ctx.request('POST', `/api/lessons/${content.lesson.id}/practice`, { body: { difficulty: 2 } });
    assert.ok([401, 403].includes(res.status), `respondeu ${res.status}`);
  });
});

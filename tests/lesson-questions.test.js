'use strict';

/**
 * Questões da aula preparadas em segundo plano (services/lesson-questions).
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/lesson-questions.test.js
 *
 * Cadastrar a aula põe as questões dela na fila (questions_status 'pending');
 * a fila deixa no banco as três questões da prática na dificuldade média,
 * divididas entre os assuntos da aula, antes do primeiro aluno chegar.
 *
 * O que não pode quebrar: cada questão no assunto do SEU alvo; o banco
 * reaproveitado antes de chamar a IA; a geração da plataforma sem cota diária
 * e sem moeda (um envio de 200 aulas não pode parar na 13ª); o estado preso em
 * 'generating' depois de um reinício voltando para a fila; e a troca de
 * assuntos no meio da geração não sendo apagada pelo fim da rodada antiga.
 *
 * Em teste o laço não liga (start() não faz nada): cada teste chama
 * processNext() na hora em que quer.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

const ai = require('../server/services/ai');
const questionAi = require('../server/services/question-ai');
const lessonQuestions = require('../server/services/lesson-questions');

let sequencia = 0;

async function seedTopics(db, subject, names) {
  sequencia += 1;
  const topics = [];
  for (const [index, name] of names.entries()) {
    topics.push(
      await db.one(
        `INSERT INTO topics (subject_id, slug, name, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
        [subject.id, `fila-${sequencia}-${index}`, name, `Ementa de ${name}.`, sequencia * 10 + index]
      )
    );
  }
  return topics;
}

/** Aula direto no banco, já na fila, com os assuntos na ordem dada. */
async function seedPendingLesson(db, subject, topics, { status = 'pending', updatedAgo = '0 minutes' } = {}) {
  sequencia += 1;
  const lesson = await db.one(
    `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, questions_status, questions_updated_at)
     VALUES ($1, $2, $3, $4, 20, $5, now() - $6::interval) RETURNING id`,
    [subject.id, topics[0].id, `aula-fila-${sequencia}`, topics.map((t) => t.name).join(', '), status, updatedAgo]
  );
  for (const [index, topic] of topics.entries()) {
    if (index === 0) continue;
    await db.query(
      `INSERT INTO lesson_topics (lesson_id, position, topic_id, source) VALUES ($1, $2, $3, 'manual')`,
      [lesson.id, index + 1, topic.id]
    );
  }
  return lesson;
}

async function seedBankQuestion(db, { subject, topic, difficulty = 2 }) {
  const question = await db.one(
    `INSERT INTO questions (subject_id, topic_id, statement, difficulty, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [subject.id, topic.id, `Questão de prova sobre ${topic.name}, já cadastrada no banco.`, difficulty]
  );
  for (const [index, letter] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [question.id, letter, `Alternativa ${letter}`, index === 0, index]
    );
  }
  return question.id;
}

async function statusOf(db, lessonId) {
  return db.one(
    `SELECT questions_status, questions_error, questions_updated_at, questions_attempts, questions_retry_at,
            questions_retry_at > now() AS esperando
       FROM lessons WHERE id = $1`,
    [lessonId]
  );
}

/** O tempo da espera passou: a aula volta a poder ser pega pela fila. */
async function esperaPassou(db, lessonId) {
  await db.query(`UPDATE lessons SET questions_retry_at = now() - interval '1 second' WHERE id = $1`, [lessonId]);
}

async function lessonQuestionsOf(db, lessonId) {
  return db.many(
    `SELECT id, topic_id, difficulty, generated_by_ai, active FROM questions WHERE lesson_id = $1 ORDER BY created_at`,
    [lessonId]
  );
}

async function questionCalls(db) {
  return (await db.one(`SELECT count(*)::int AS total FROM ai_usage WHERE feature = 'questions'`)).total;
}

/** Só a aula do teste fica na fila: as dos testes anteriores saem dela. */
async function onlyThisInQueue(db, ids) {
  await db.query(
    `UPDATE lessons SET questions_status = 'ready' WHERE questions_status IN ('pending', 'generating') AND NOT (id = ANY($1::uuid[]))`,
    [ids]
  );
}

/** O simulador de sempre, guardando o prompt de cada chamada. */
function simuladorQueAnota(prompts) {
  const simulador = ai.getClient();
  return {
    chat: {
      completions: {
        async create(params, options) {
          prompts.push(params.messages.map((message) => message.content).join('\n'));
          return simulador.chat.completions.create(params, options);
        },
      },
    },
  };
}

function clienteQueFalha(status = 503) {
  return {
    chat: { completions: { async create() { throw Object.assign(new Error(`${status} upstream`), { status }); } } },
  };
}

/** A IA responde, mas sem nada aproveitável: culpa da rodada, não do provedor. */
function clienteQueRespondeMal() {
  return {
    chat: {
      completions: {
        async create() {
          return {
            model: 'teste',
            choices: [{ index: 0, message: { role: 'assistant', content: 'isto não é JSON' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        },
      },
    },
  };
}

describe('Fila de questões das aulas', () => {
  let ctx;
  let db;
  let subject;
  let admin;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    subject = await db.one(
      `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-fila', 'Matemática', 1) RETURNING id, name`
    );
    admin = await ctx.loginAdmin();
  });

  afterEach(() => {
    ai.setClientForTests(null);
  });

  after(async () => {
    await ctx.close();
  });

  it('em teste o laço não liga: quem dirige é o teste', () => {
    assert.equal(lessonQuestions.start(), false);
  });

  it('fila vazia: processNext não faz nada', async () => {
    await onlyThisInQueue(db, []);
    assert.equal(await lessonQuestions.processNext(), null);
  });

  it('aula cadastrada pelo painel entra na fila e sai com uma questão de cada assunto', async () => {
    const topics = await seedTopics(db, subject, ['Razão e proporção', 'Regra de três', 'Porcentagem']);
    const res = await admin.agent.post('/api/admin/lessons', {
      title: 'Aula 05 — Razão e Proporção, Regra de Três e Porcentagem',
      subject_id: subject.id,
      topics: topics.map((topic) => ({ topic_id: topic.id })),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.questions_status, 'pending');
    await onlyThisInQueue(db, [res.body.id]);

    const antes = await questionCalls(db);
    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.lesson_id, res.body.id);
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    assert.equal(outcome.created, 3);
    assert.equal(outcome.reused, 0);
    assert.equal(await questionCalls(db), antes + 1, 'uma chamada para as três');

    const status = await statusOf(db, res.body.id);
    assert.equal(status.questions_status, 'ready');
    assert.equal(status.questions_error, null);

    const gravadas = await lessonQuestionsOf(db, res.body.id);
    assert.equal(gravadas.length, 3);
    assert.deepEqual(
      gravadas.map((row) => row.topic_id).sort(),
      topics.map((topic) => topic.id).sort(),
      'cada questão no assunto do seu alvo'
    );
    for (const row of gravadas) {
      assert.equal(row.difficulty, lessonQuestions.DIFICULDADE);
      assert.equal(row.generated_by_ai, true);
      assert.equal(row.active, true);
    }

    // É para isto que a fila existe: o primeiro aluno já encontra tudo pronto.
    const aluno = await ctx.registerStudent({ name: 'Primeira Aluna da Aula' });
    const pratica = await aluno.agent.post(`/api/lessons/${res.body.id}/practice`, { difficulty: lessonQuestions.DIFICULDADE });
    assert.equal(pratica.status, 200, JSON.stringify(pratica.body));
    assert.equal(pratica.body.from_bank, 3);
    assert.equal(pratica.body.generated, 0);
    assert.deepEqual(pratica.body.questions.map((question) => question.topic_id), topics.map((topic) => topic.id));
    assert.equal(await questionCalls(db), antes + 1, 'a prática não chamou a IA de novo');
  });

  it('dois assuntos: duas questões do primeiro e uma do segundo', async () => {
    const topics = await seedTopics(db, subject, ['Função afim', 'Função quadrática']);
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    const gravadas = await lessonQuestionsOf(db, lesson.id);
    assert.equal(gravadas.filter((row) => row.topic_id === topics[0].id).length, 2);
    assert.equal(gravadas.filter((row) => row.topic_id === topics[1].id).length, 1);
  });

  it('um assunto: as três questões são dele', async () => {
    const topics = await seedTopics(db, subject, ['Geometria espacial']);
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    const gravadas = await lessonQuestionsOf(db, lesson.id);
    assert.equal(gravadas.length, 3);
    assert.ok(gravadas.every((row) => row.topic_id === topics[0].id));
  });

  it('reaproveita o banco: só o assunto sem questão vai para a IA', async () => {
    const topics = await seedTopics(db, subject, ['Estatística', 'Probabilidade', 'Combinatória']);
    const bancoA = await seedBankQuestion(db, { subject, topic: topics[0] });
    const bancoC = await seedBankQuestion(db, { subject, topic: topics[2] });
    // questão fácil não serve: a fila prepara a dificuldade média
    await seedBankQuestion(db, { subject, topic: topics[1], difficulty: 1 });
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    const prompts = [];
    ai.setClientForTests(simuladorQueAnota(prompts));
    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    assert.equal(outcome.reused, 2);
    assert.equal(outcome.created, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Elabore 1 questão/);
    assert.match(prompts[0], /^1\. Probabilidade$/m);

    const gravadas = await lessonQuestionsOf(db, lesson.id);
    assert.equal(gravadas.length, 1);
    assert.equal(gravadas[0].topic_id, topics[1].id);
    const intactas = await db.many('SELECT id FROM questions WHERE id = ANY($1::uuid[]) AND lesson_id IS NULL', [[bancoA, bancoC]]);
    assert.equal(intactas.length, 2, 'as do banco continuam do banco');
  });

  it('banco que cobre a aula inteira: pronta sem chamar a IA', async () => {
    const topics = await seedTopics(db, subject, ['Matrizes']);
    for (let i = 0; i < 3; i += 1) await seedBankQuestion(db, { subject, topic: topics[0] });
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    const antes = await questionCalls(db);
    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    assert.equal(outcome.reused, 3);
    assert.equal(outcome.created, 0);
    assert.equal(await questionCalls(db), antes, 'nenhuma chamada de IA');
  });

  it('a geração é da plataforma: sem cota diária e sem moeda', async () => {
    // O administrador já "gastou" o teto diário de um aluno. Se a fila usasse
    // o id de quem cadastrou, o envio em massa parava aqui com 429.
    for (let i = 0; i < questionAi.TENTATIVAS_POR_DIA; i += 1) {
      await db.query(`INSERT INTO ai_usage (user_id, feature, status, total_tokens) VALUES ($1, 'questions', 'ok', 100)`, [
        admin.user.id,
      ]);
    }
    const topics = await seedTopics(db, subject, ['Polinômios', 'Números complexos']);
    const res = await admin.agent.post('/api/admin/lessons', {
      title: 'Polinômios e números complexos',
      subject_id: subject.id,
      topics: topics.map((topic) => ({ topic_id: topic.id })),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await onlyThisInQueue(db, [res.body.id]);

    const desde = await db.one('SELECT now() AS agora');
    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));

    const uso = await db.many(
      `SELECT user_id FROM ai_usage WHERE feature = 'questions' AND created_at >= $1`,
      [desde.agora]
    );
    assert.ok(uso.length >= 1);
    assert.ok(uso.every((row) => row.user_id === null), 'a chamada não é de nenhum usuário');
    const moedas = await db.one('SELECT count(*)::int AS total FROM coin_ledger');
    assert.equal(moedas.total, 0, 'ninguém paga moeda pela fila');
  });

  it('IA fora do ar: a aula volta para a fila sem gastar tentativa, e o laço espera antes da próxima', async () => {
    const topics = await seedTopics(db, subject, ['Cônicas']);
    const lesson = await seedPendingLesson(db, subject, topics);
    const outra = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id, outra.id]);

    // Sem crédito (402) a IA nem responde: antes, a fila inteira virava "failed" a cada 2 s.
    ai.setClientForTests(clienteQueFalha(402));
    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.lesson_id, lesson.id);
    assert.equal(outcome.status, 'pending', JSON.stringify(outcome));
    assert.equal(outcome.ai_down, true);
    assert.equal(
      lessonQuestions.proximaRodadaMs(outcome),
      lessonQuestions.PAUSA_IA_FORA_MS,
      'o laço espera minutos, não segue para a próxima aula'
    );
    const status = await statusOf(db, lesson.id);
    assert.equal(status.questions_status, 'pending');
    assert.equal(status.questions_attempts, 0, 'a culpa não é da aula');
    assert.equal(status.esperando, true);
    assert.match(status.questions_error, /volta para a fila/, 'o painel mostra o porquê');
    assert.equal((await statusOf(db, outra.id)).questions_status, 'pending', 'a outra aula nem foi tocada');

    // A IA volta: a outra aula sai primeiro, e a que esperava sai quando a espera passa.
    ai.setClientForTests(null);
    const seguinte = await lessonQuestions.processNext();
    assert.equal(seguinte.lesson_id, outra.id);
    assert.equal(seguinte.status, 'ready', JSON.stringify(seguinte));
    assert.equal(await lessonQuestions.processNext(), null, 'a que falhou ainda está esperando');
    await esperaPassou(db, lesson.id);
    const depois = await lessonQuestions.processNext();
    assert.equal(depois.lesson_id, lesson.id);
    assert.equal(depois.status, 'ready', JSON.stringify(depois));
    const pronta = await statusOf(db, lesson.id);
    assert.equal(pronta.questions_error, null);
    assert.equal(pronta.questions_retry_at, null);
  });

  it('o intervalo do laço: 2 s com fila, 20 s sem fila, minutos com a IA fora do ar', () => {
    assert.ok(lessonQuestions.proximaRodadaMs(null) > lessonQuestions.proximaRodadaMs({ status: 'ready' }));
    assert.equal(lessonQuestions.proximaRodadaMs({ status: 'pending', ai_down: true }), lessonQuestions.PAUSA_IA_FORA_MS);
    assert.ok(lessonQuestions.PAUSA_IA_FORA_MS >= 60_000);
  });

  it('três rodadas em que a IA responde mal: "failed" com o motivo, e o painel põe de novo na fila', async () => {
    const topics = await seedTopics(db, subject, ['Hipérbole']);
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    ai.setClientForTests(clienteQueRespondeMal());
    for (let rodada = 1; rodada <= lessonQuestions.MAX_TENTATIVAS; rodada += 1) {
      const outcome = await lessonQuestions.processNext();
      assert.ok(outcome, `rodada ${rodada} pegou a aula`);
      assert.equal(outcome.ai_down, false);
      assert.equal(outcome.attempts, rodada);
      const status = await statusOf(db, lesson.id);
      if (rodada < lessonQuestions.MAX_TENTATIVAS) {
        assert.equal(status.questions_status, 'pending', `rodada ${rodada}`);
        assert.equal(status.esperando, true);
        assert.equal(await lessonQuestions.processNext(), null, 'a aula espera antes da próxima tentativa');
        await esperaPassou(db, lesson.id);
      } else {
        assert.equal(status.questions_status, 'failed');
        assert.equal(status.questions_retry_at, null);
        assert.match(status.questions_error, /Depois de 3 tentativas/);
        assert.match(status.questions_error, /Preparar as questões de novo/);
      }
    }
    assert.equal(await lessonQuestions.processNext(), null, '"failed" não volta sozinha');

    // Aluno não mexe na fila.
    const aluno = await ctx.registerStudent({ name: 'Aluno Curioso' });
    const negado = await aluno.agent.post(`/api/admin/lessons/${lesson.id}/requeue-questions`, {});
    assert.ok([401, 403].includes(negado.status), `respondeu ${negado.status}`);

    // "Preparar as questões de novo" no painel: tentativas zeradas, na fila na hora.
    ai.setClientForTests(null);
    const res = await admin.agent.post(`/api/admin/lessons/${lesson.id}/requeue-questions`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, lesson.id);
    assert.equal(res.body.questions_status, 'pending');
    assert.equal(res.body.questions_error, null);
    const naFila = await statusOf(db, lesson.id);
    assert.equal(naFila.questions_attempts, 0);
    assert.equal(naFila.questions_retry_at, null);

    const repetido = await admin.agent.post(`/api/admin/lessons/${lesson.id}/requeue-questions`, {});
    assert.equal(repetido.status, 409, 'já está na fila');

    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.lesson_id, lesson.id);
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
  });

  it('em lote, só as aulas paradas entram na fila; a que está na fila fica como está', async () => {
    const topics = await seedTopics(db, subject, ['Parábola']);
    const falhou = await seedPendingLesson(db, subject, topics, { status: 'failed' });
    const pronta = await seedPendingLesson(db, subject, topics, { status: 'ready' });
    const antiga = await seedPendingLesson(db, subject, topics, { status: 'none' });
    const gerando = await seedPendingLesson(db, subject, topics, { status: 'generating' });
    await db.query(`UPDATE lessons SET questions_attempts = 3, questions_error = 'Falhou.' WHERE id = $1`, [falhou.id]);

    const res = await admin.agent.post('/api/admin/lessons/requeue-questions', {
      ids: [falhou.id, pronta.id, antiga.id, gerando.id],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued, 3);
    assert.equal(res.body.unchanged, 1);
    assert.deepEqual(res.body.ids.sort(), [falhou.id, pronta.id, antiga.id].sort());
    assert.equal((await statusOf(db, gerando.id)).questions_status, 'generating', 'quem está gerando não é mexido');
    const zerada = await statusOf(db, falhou.id);
    assert.equal(zerada.questions_status, 'pending');
    assert.equal(zerada.questions_attempts, 0);
    assert.equal(zerada.questions_error, null);
  });

  it('IA entrega menos que o pedido: volta para a fila com o que faltou, e a nova rodada só completa', async () => {
    const topics = await seedTopics(db, subject, ['Sequências', 'Limites', 'Derivadas']);
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    // só a questão do primeiro assunto volta
    ai.setClientForTests({
      chat: {
        completions: {
          async create() {
            const questao = {
              target: 1,
              statement: 'Questão elaborada sobre sequências numéricas, com contexto suficiente para responder.',
              options: ['A', 'B', 'C', 'D', 'E'].map((letter, index) => ({ letter, text: `Alternativa ${letter}`, is_correct: index === 0 })),
              resolution: 'Resolução.',
              explanation: 'Distratores.',
            };
            return {
              model: 'teste',
              choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ questions: [questao] }) }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            };
          },
        },
      },
    });
    const primeira = await lessonQuestions.processNext();
    assert.equal(primeira.status, 'pending', JSON.stringify(primeira));
    assert.equal(primeira.attempts, 1);
    assert.deepEqual(primeira.missing, ['Limites', 'Derivadas']);
    const status = await statusOf(db, lesson.id);
    assert.equal(status.questions_status, 'pending');
    assert.equal(status.questions_attempts, 1, 'a IA respondeu sem o que faltava: conta uma tentativa');
    assert.match(status.questions_error, /2 de 3/);
    assert.match(status.questions_error, /volta para a fila/);
    assert.equal((await lessonQuestionsOf(db, lesson.id)).length, 1, 'o que ficou pronto continua no banco');

    // passada a espera, a rodada seguinte só pede as duas que faltam
    ai.setClientForTests(null);
    await esperaPassou(db, lesson.id);
    const prompts = [];
    ai.setClientForTests(simuladorQueAnota(prompts));
    const segunda = await lessonQuestions.processNext();
    assert.equal(segunda.status, 'ready', JSON.stringify(segunda));
    assert.equal(segunda.reused, 1);
    assert.equal(segunda.created, 2);
    assert.match(prompts[0], /Elabore 2 questões/);
    const gravadas = await lessonQuestionsOf(db, lesson.id);
    assert.deepEqual(gravadas.map((row) => row.topic_id).sort(), topics.map((topic) => topic.id).sort());
    const pronta = await statusOf(db, lesson.id);
    assert.equal(pronta.questions_error, null);
    assert.equal(pronta.questions_attempts, 0, 'pronta zera as tentativas');
  });

  it('assuntos trocados no meio da geração: o fim da rodada antiga não marca "ready"', async () => {
    const topics = await seedTopics(db, subject, ['Óptica']);
    const lesson = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [lesson.id]);

    const simulador = ai.getClient();
    ai.setClientForTests({
      chat: {
        completions: {
          async create(params, options) {
            // enquanto a IA escreve, o administrador muda os assuntos da aula
            await db.query(`UPDATE lessons SET questions_status = 'pending', questions_updated_at = now() WHERE id = $1`, [lesson.id]);
            return simulador.chat.completions.create(params, options);
          },
        },
      },
    });
    await lessonQuestions.processNext();
    assert.equal((await statusOf(db, lesson.id)).questions_status, 'pending', 'a aula continua na fila para os assuntos novos');
  });

  it('"generating" preso há muito tempo volta para a fila e é processado', async () => {
    const topics = await seedTopics(db, subject, ['Termologia']);
    const presa = await seedPendingLesson(db, subject, topics, { status: 'generating', updatedAgo: '40 minutes' });
    const recente = await seedPendingLesson(db, subject, topics, { status: 'generating', updatedAgo: '1 minute' });
    await onlyThisInQueue(db, [presa.id, recente.id]);

    const outcome = await lessonQuestions.processNext();
    assert.equal(outcome.lesson_id, presa.id);
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
    assert.equal(
      (await statusOf(db, recente.id)).questions_status,
      'generating',
      'quem está gerando há pouco pode estar vivo: não é mexido'
    );
  });

  it('no boot, tudo o que estava "generating" volta para a fila', async () => {
    const topics = await seedTopics(db, subject, ['Ondulatória']);
    const a = await seedPendingLesson(db, subject, topics, { status: 'generating', updatedAgo: '1 minute' });
    const b = await seedPendingLesson(db, subject, topics, { status: 'ready' });
    await onlyThisInQueue(db, [a.id]);

    const liberadas = await lessonQuestions.releaseInterrupted();
    assert.ok(liberadas >= 1);
    const status = await statusOf(db, a.id);
    assert.equal(status.questions_status, 'pending');
    assert.match(status.questions_error, /reiniciou/);
    assert.equal((await statusOf(db, b.id)).questions_status, 'ready', 'aula pronta não volta para a fila');
  });

  it('duas rodadas ao mesmo tempo pegam aulas diferentes', async () => {
    const topics = await seedTopics(db, subject, ['Eletrostática']);
    const a = await seedPendingLesson(db, subject, topics);
    const b = await seedPendingLesson(db, subject, topics);
    await onlyThisInQueue(db, [a.id, b.id]);

    const [um, dois] = await Promise.all([lessonQuestions.processNext(), lessonQuestions.processNext()]);
    assert.ok(um && dois);
    assert.notEqual(um.lesson_id, dois.lesson_id);
    assert.deepEqual([um.lesson_id, dois.lesson_id].sort(), [a.id, b.id].sort());
  });
});

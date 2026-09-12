'use strict';

/**
 * Simulados: formatos, complemento por IA e o aviso de simulado curto.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/simulados.test.js
 *
 * O cliente pediu simulado completo de 80 questões, mini de 20, e que a IA
 * complete quando o banco não tiver o suficiente.
 *
 * O que não pode quebrar: o formato escolhido tem que valer (com 180 minutos de
 * teto, um completo de 80 tinha o tempo cortado em silêncio), o teto de
 * complemento por IA tem que ser respeitado — é ele que segura o custo — e o
 * simulado que sai menor que o pedido tem que dizer isso, em vez de fingir que
 * está inteiro.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const simulados = require('../server/services/simulados');
const settings = require('../server/services/settings');

let ctx;
let db;
let aluno;
let exam;
let subject;
let topics = [];

/** Uma prova com uma matéria, três assuntos e `porAssunto` questões em cada. */
async function seedExam(porAssunto) {
  exam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, sort_order)
     VALUES ('enem-sim', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1) RETURNING id`
  );
  subject = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-sim', 'Matemática', 1) RETURNING id`
  );
  await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [exam.id, subject.id]);

  for (const [index, nome] of ['Porcentagem', 'Funções', 'Geometria'].entries()) {
    const topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
      [subject.id, `assunto-${index}`, nome, index]
    );
    await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [exam.id, topic.id]);
    await db.query(
      `INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, $2, $3, 0)`,
      [topic.id, `sub-${index}`, `Subassunto de ${nome}`]
    );
    topics.push(topic);

    for (let i = 0; i < porAssunto; i += 1) {
      const q = await db.one(
        `INSERT INTO questions (subject_id, topic_id, statement, difficulty)
         VALUES ($1, $2, $3, 2) RETURNING id`,
        [subject.id, topic.id, `Questão ${i + 1} de ${nome}, cadastrada pelo professor.`]
      );
      for (const [ordem, letra] of ['A', 'B', 'C', 'D', 'E'].entries()) {
        await db.query(
          `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [q.id, letra, `Alternativa ${letra}`, ordem === 0, ordem]
        );
      }
    }
  }
}

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  aluno = await ctx.registerStudent({ name: 'Aluno do Simulado' });
  // Banco curto de propósito: 12 questões contra um pedido de 80.
  await seedExam(4);
  await db.query(
    `INSERT INTO student_profiles (user_id, exam_id, study_days, hours_per_day, level)
     VALUES ($1, $2, '{1,2,3,4,5}', 2, 'intermediario')
     ON CONFLICT (user_id) DO UPDATE SET exam_id = EXCLUDED.exam_id`,
    [aluno.user.id, exam.id]
  );
});

after(async () => {
  await ctx.close();
});

describe('Formatos do simulado', () => {
  it('o completo pede 80 questões e o tempo da prova real', () => {
    const completo = simulados.getDefaults('exam', 'enem', 'completo');
    assert.equal(completo.question_count, 80);
    assert.ok(completo.duration_min > 180, 'quatro horas não cabiam no teto antigo de 180 minutos');
    assert.ok(completo.duration_min <= simulados.MAX_DURATION, 'o teto precisa comportar o formato');
  });

  it('o mini cabe em uma sessão de estudo', () => {
    const mini = simulados.getDefaults('exam', 'enem', 'mini');
    assert.equal(mini.question_count, 20);
    assert.equal(mini.duration_min, 60);
  });

  it('sem formato, valem os padrões da trilha da prova', () => {
    const padrao = simulados.getDefaults('exam', 'enem');
    assert.notEqual(padrao.question_count, 80);
  });

  it('a API entrega os formatos ao aluno, em vez de o número ficar fixo na tela', async () => {
    const res = await aluno.agent.get('/api/simulados');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const modes = res.body.defaults.modes || [];
    assert.deepEqual(modes.map((m) => m.key).sort(), ['completo', 'mini']);
    assert.equal(res.body.defaults.max.duration_min, simulados.MAX_DURATION);
  });
});

describe('Complemento por IA quando o banco é curto', () => {
  it('com o complemento desligado, o simulado sai do tamanho do banco', async () => {
    await settings.setSetting('simulado_ai_questions_max', 0);
    const res = await aluno.agent.post('/api/simulados/attempts', {
      type: 'exam',
      mode: 'completo',
      exam_id: exam.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.questions.length, 12, 'as 12 do banco, e nada além');
    assert.equal(res.body.config.requested_count, 80);
    assert.equal(res.body.config.generated_count, 0);
    // É esta diferença que a tela do aluno usa para avisar.
    assert.ok(res.body.config.requested_count > res.body.questions.length);
    await aluno.agent.post(`/api/simulados/attempts/${res.body.id}/abandon`, {});
  });

  it('com o complemento ligado, a IA fecha parte do buraco — até o teto', async () => {
    await settings.setSetting('simulado_ai_questions_max', 6);
    const antes = await db.one('SELECT count(*)::int AS total FROM questions WHERE generated_by_ai');

    const res = await aluno.agent.post('/api/simulados/attempts', {
      type: 'exam',
      mode: 'completo',
      exam_id: exam.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.config.generated_count, 6, 'exatamente o teto, nem uma a mais');
    assert.equal(res.body.questions.length, 18, '12 do banco + 6 elaboradas');

    const depois = await db.one('SELECT count(*)::int AS total FROM questions WHERE generated_by_ai');
    assert.equal(depois.total - antes.total, 6, 'as questões elaboradas ficam no banco para os próximos');
    await aluno.agent.post(`/api/simulados/attempts/${res.body.id}/abandon`, {});
  });

  it('o teto vem da configuração do painel, não do código', async () => {
    await settings.setSetting('simulado_ai_questions_max', 3);
    assert.equal(await simulados.aiFillLimit(), 3);
    await settings.setSetting('simulado_ai_questions_max', 0);
    assert.equal(await simulados.aiFillLimit(), 0);
  });

  it('o mini simulado cabe no banco e não aciona a IA', async () => {
    await settings.setSetting('simulado_ai_questions_max', 20);
    const antes = await db.one('SELECT count(*)::int AS total FROM questions WHERE generated_by_ai');

    const res = await aluno.agent.post('/api/simulados/attempts', {
      type: 'topic',
      topic_id: topics[0].id,
      question_count: 4,
      duration_min: 10,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.questions.length, 4);
    assert.equal(res.body.config.generated_count, 0);

    const depois = await db.one('SELECT count(*)::int AS total FROM questions WHERE generated_by_ai');
    assert.equal(depois.total, antes.total, 'nada foi elaborado à toa');
    await aluno.agent.post(`/api/simulados/attempts/${res.body.id}/abandon`, {});
  });

  it('o tempo do formato completo não é mais cortado em silêncio', async () => {
    await settings.setSetting('simulado_ai_questions_max', 0);
    const res = await aluno.agent.post('/api/simulados/attempts', {
      type: 'exam',
      mode: 'completo',
      exam_id: exam.id,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.duration_min, simulados.getDefaults('exam', 'enem', 'completo').duration_min);
    await aluno.agent.post(`/api/simulados/attempts/${res.body.id}/abandon`, {});
  });
});

describe('Disponibilidade informada ao aluno', () => {
  it('a prova com banco vazio deixa de ser barrada, porque a IA completa', async () => {
    await settings.setSetting('simulado_ai_questions_max', 10);
    const res = await aluno.agent.get('/api/simulados');
    assert.equal(res.status, 200);
    assert.equal(res.body.defaults.ai_fill.max, 10, 'a tela precisa saber se pode contar com a IA');
  });
});

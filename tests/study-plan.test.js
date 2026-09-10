'use strict';

/**
 * Cronograma guiado pelo plano de estudos.
 *
 *   NODE_ENV=test node --test tests/study-plan.test.js
 *
 * O cliente definiu o ritmo: um dia de aula, o dia seguinte com o resumo
 * daquela aula e questões só daquele conteúdo, prova anterior a cada quatro
 * semanas, e treino físico em paralelo no Barro Branco. Quem tem menos dias
 * por semana avança mais devagar, na mesma sequência.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const schedule = require('../server/services/schedule');
const studyPlan = require('../server/services/study-plan');

describe('Plano de estudos', () => {
  let ctx;
  let db;
  let exam;
  let subjects = {};
  let plan;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;

    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board, has_essay)
       VALUES ('enem-plano', 'ENEM', 'ENEM', 'enem', 'INEP', true) RETURNING id`
    );

    for (const [slug, nome] of [['mat', 'Matemática'], ['por', 'Português'], ['his', 'História']]) {
      const row = await db.one(
        'INSERT INTO subjects (slug, name, sort_order) VALUES ($1, $2, 1) RETURNING id',
        [slug, nome]
      );
      subjects[slug] = row.id;
      await db.query('INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, 1)', [exam.id, row.id]);
    }

    plan = await db.one(
      `INSERT INTO study_plans (exam_id, slug, name, weeks, lessons_per_week, exam_every_weeks)
       VALUES ($1, 'plano-teste', 'Plano de teste', 4, 3, 4) RETURNING id`,
      [exam.id]
    );

    // quinze passos: cinco semanas de três aulas, o bastante para o horizonte
    // dos testes cruzar a quarta semana, quando entra a prova anterior
    const passos = [
      ['mat', 'Razão e proporção'], ['por', 'Interpretação de texto'], ['his', 'Egito antigo'],
      ['mat', 'Porcentagem e juros'], ['por', 'Coesão e coerência'], ['his', 'Grécia e Roma'],
      ['mat', 'Equações e sistemas'], ['por', 'Classes de palavras'], ['his', 'Feudalismo'],
      ['mat', 'Funções e gráficos'], ['por', 'Sintaxe do período'], ['his', 'Renascimento'],
      ['mat', 'Progressões'], ['por', 'Concordância verbal'], ['his', 'Revolução Francesa'],
    ];
    let posicao = 0;
    for (const [slug, titulo] of passos) {
      posicao += 1;
      await db.query(
        `INSERT INTO study_plan_items (plan_id, position, week, subject_id, title)
         VALUES ($1, $2, $3, $4, $5)`,
        [plan.id, posicao, Math.ceil(posicao / 3), subjects[slug], titulo]
      );
    }
  });

  after(async () => {
    await ctx.close();
  });

  /** Aluno novo com a prova e os dias informados. */
  async function aluno({ dias, horas = 2 }) {
    const student = await ctx.registerStudent({ name: `Aluno ${dias.join('')}${Math.random()}` });
    await db.query(
      `UPDATE student_profiles
          SET exam_id = $2, study_days = $3, hours_per_day = $4, onboarding_completed = true
        WHERE user_id = $1`,
      [student.user.id, exam.id, dias, horas]
    );
    return student;
  }

  /** Itens gerados, em ordem de data e posição. */
  async function itens(userId) {
    return db.many(
      `SELECT date, type, title, duration_min, plan_item_id, position, status
         FROM schedule_items WHERE user_id = $1 ORDER BY date, position`,
      [userId]
    );
  }

  it('encontra o plano da prova', async () => {
    const data = await studyPlan.loadPlanForExam(exam.id);
    assert.ok(data, 'o plano precisa ser encontrado pela prova');
    assert.equal(data.items.length, 15);
    assert.equal(data.items[0].title, 'Razão e proporção');
  });

  it('alterna aula e, no dia seguinte, resumo com questões do mesmo conteúdo', async () => {
    const student = await aluno({ dias: [1, 2, 3, 4, 5, 6] });
    await schedule.generateSchedule(student.user.id, { days: 14 });
    const lista = await itens(student.user.id);

    const porDia = new Map();
    for (const item of lista) {
      if (!porDia.has(item.date)) porDia.set(item.date, []);
      porDia.get(item.date).push(item);
    }
    const dias = [...porDia.keys()].sort();

    // primeiro dia de estudo: uma aula (ou bloco de estudo do tema)
    const primeiro = porDia.get(dias[0]);
    assert.ok(['lesson', 'topic'].includes(primeiro[0].type), `esperava aula, veio ${primeiro[0].type}`);
    assert.equal(primeiro[0].title, 'Razão e proporção');

    // dia seguinte: resumo daquela aula e questões daquele conteúdo
    const segundo = porDia.get(dias[1]);
    const tipos = segundo.map((item) => item.type);
    assert.ok(tipos.includes('summary'), 'o dia seguinte precisa ter o resumo');
    assert.ok(tipos.includes('questions'), 'o dia seguinte precisa ter as questões');

    const resumo = segundo.find((item) => item.type === 'summary');
    const questoes = segundo.find((item) => item.type === 'questions');
    assert.match(resumo.title, /Razão e proporção/);
    assert.match(questoes.title, /Razão e proporção/, 'as questões são só daquele conteúdo');
    assert.equal(resumo.plan_item_id, primeiro[0].plan_item_id, 'resumo e aula apontam para o mesmo passo');

    // terceiro dia: aula seguinte da sequência
    const terceiro = porDia.get(dias[2]);
    assert.equal(terceiro[0].title, 'Interpretação de texto');
  });

  it('segue a ordem do plano, sem pular nem repetir', async () => {
    const student = await aluno({ dias: [1, 2, 3, 4, 5, 6] });
    await schedule.generateSchedule(student.user.id, { days: 21 });
    const lista = await itens(student.user.id);

    const aulas = lista.filter((item) => ['lesson', 'topic'].includes(item.type));
    const titulos = aulas.map((item) => item.title);
    const esperado = ['Razão e proporção', 'Interpretação de texto', 'Egito antigo', 'Porcentagem e juros'];
    assert.deepEqual(titulos.slice(0, 4), esperado);
    assert.equal(new Set(titulos).size, titulos.length, 'nenhuma aula se repete');
  });

  it('quem estuda menos dias avança mais devagar, na mesma sequência', async () => {
    const seisDias = await aluno({ dias: [1, 2, 3, 4, 5, 6] });
    const doisDias = await aluno({ dias: [2, 5] });
    await schedule.generateSchedule(seisDias.user.id, { days: 21 });
    await schedule.generateSchedule(doisDias.user.id, { days: 21 });

    const aulasSeis = (await itens(seisDias.user.id)).filter((i) => ['lesson', 'topic'].includes(i.type));
    const aulasDois = (await itens(doisDias.user.id)).filter((i) => ['lesson', 'topic'].includes(i.type));

    assert.ok(aulasSeis.length > aulasDois.length, 'mais dias por semana, mais aulas no mesmo período');
    assert.equal(aulasDois[0].title, 'Razão e proporção', 'a sequência começa igual para os dois');
    assert.equal(aulasSeis[0].title, 'Razão e proporção');
  });

  it('respeita as horas por dia que o aluno informou', async () => {
    const student = await aluno({ dias: [1, 2, 3, 4, 5, 6], horas: 1 });
    await schedule.generateSchedule(student.user.id, { days: 14 });
    const lista = await itens(student.user.id);

    const porDia = new Map();
    for (const item of lista) {
      if (item.type === 'training') continue; // treino corre em paralelo
      porDia.set(item.date, (porDia.get(item.date) || 0) + item.duration_min);
    }
    for (const [date, minutos] of porDia) {
      assert.ok(minutos <= 60, `${date} somou ${minutos} min, acima da hora declarada`);
    }
  });

  it('marca prova anterior a cada quatro semanas', async () => {
    const student = await aluno({ dias: [1, 2, 3, 4, 5, 6] });
    await schedule.generateSchedule(student.user.id, { days: 30 });
    const lista = await itens(student.user.id);
    const provas = lista.filter((item) => item.type === 'past_exam');
    assert.ok(provas.length >= 1, 'a quarta semana precisa ter prova anterior');
  });

  it('a posição avança conforme o aluno conclui, não conforme o tempo passa', async () => {
    const student = await aluno({ dias: [1, 2, 3, 4, 5, 6] });
    await schedule.generateSchedule(student.user.id, { days: 14 });

    assert.equal(await studyPlan.currentPosition(student.user.id, plan.id), 0);

    const primeira = await db.one(
      `SELECT id, plan_item_id FROM schedule_items
        WHERE user_id = $1 AND plan_item_id IS NOT NULL ORDER BY date, position LIMIT 1`,
      [student.user.id]
    );
    await db.query(`UPDATE schedule_items SET status = 'done' WHERE id = $1`, [primeira.id]);

    assert.equal(await studyPlan.currentPosition(student.user.id, plan.id), 1);

    // ao refazer o cronograma, continua de onde parou
    await schedule.generateSchedule(student.user.id, { days: 14 });
    const lista = await itens(student.user.id);
    const aulas = lista.filter((item) => ['lesson', 'topic'].includes(item.type) && item.status !== 'done');
    assert.ok(
      aulas.every((item) => item.title !== 'Razão e proporção'),
      'a aula concluída não volta para o cronograma'
    );
  });

  it('o treino físico entra em paralelo e não ocupa a carga do dia', async () => {
    const bb = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('bb-plano', 'Barro Branco', 'Barro Branco', 'barro_branco', 'VUNESP') RETURNING id`
    );
    const planoBB = await db.one(
      `INSERT INTO study_plans (exam_id, slug, name, weeks, exam_every_weeks, training_weekdays, training_label)
       VALUES ($1, 'plano-bb', 'Plano BB', 4, 4, '{2,4,6}', 'Treino físico para o TAF') RETURNING id`,
      [bb.id]
    );
    await db.query(
      `INSERT INTO study_plan_items (plan_id, position, week, subject_id, title)
       VALUES ($1, 1, 1, $2, 'Razão e proporção'), ($1, 2, 1, $3, 'Interpretação')`,
      [planoBB.id, subjects.mat, subjects.por]
    );

    const student = await ctx.registerStudent({ name: 'Aluno TAF' });
    await db.query(
      `UPDATE student_profiles SET exam_id = $2, study_days = '{1,2,3,4,5,6}', hours_per_day = 1,
              onboarding_completed = true WHERE user_id = $1`,
      [student.user.id, bb.id]
    );
    await schedule.generateSchedule(student.user.id, { days: 14 });

    const lista = await itens(student.user.id);
    const treinos = lista.filter((item) => item.type === 'training');
    assert.ok(treinos.length > 0, 'o plano do Barro Branco precisa marcar treino');
    assert.equal(treinos[0].title, 'Treino físico para o TAF');

    // nos dias de treino, o estudo continua acontecendo
    const diasComTreino = new Set(treinos.map((item) => item.date));
    const estudoNoMesmoDia = lista.filter(
      (item) => diasComTreino.has(item.date) && item.type !== 'training'
    );
    assert.ok(estudoNoMesmoDia.length > 0, 'o treino não pode substituir o estudo do dia');
  });

  it('prova sem plano continua usando a distribuição por peso', async () => {
    const outra = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, board)
       VALUES ('fuvest-plano', 'FUVEST', 'FUVEST', 'vestibular', 'Fuvest') RETURNING id`
    );
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, 2)', [outra.id, subjects.mat]);
    const topico = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'algebra', 'Álgebra', 1) RETURNING id`,
      [subjects.mat]
    );
    await db.query('INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, 1)', [outra.id, topico.id]);

    const student = await ctx.registerStudent({ name: 'Aluno sem plano' });
    await db.query(
      `UPDATE student_profiles SET exam_id = $2, study_days = '{1,3,5}', hours_per_day = 2,
              onboarding_completed = true WHERE user_id = $1`,
      [student.user.id, outra.id]
    );
    await schedule.generateSchedule(student.user.id, { days: 14 });

    const lista = await itens(student.user.id);
    assert.ok(lista.length > 0, 'sem plano, o cronograma ainda é montado');
    assert.ok(
      lista.every((item) => item.plan_item_id === null),
      'nenhum item deve apontar para passo de plano'
    );
  });
});

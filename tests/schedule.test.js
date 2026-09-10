'use strict';

/**
 * Cronograma adaptativo, revisões, onboarding e dashboard.
 *
 *   NODE_ENV=test node --test tests/schedule.test.js
 *
 * Cobre: onboarding gerando cronograma dentro dos dias/horas escolhidos, capacidade diária,
 * revisões entrando no cronograma, "não consegui estudar hoje", adaptação após prática fraca
 * e isolamento entre alunos.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const dates = require('../server/utils/dates');

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
/** Tolerância da capacidade diária (minutos) — ver ARCHITECTURE §5. */
const CAPACITY_TOLERANCE_MIN = 10;

/** Prova, matérias com peso, assuntos, aulas e questões de teste. */
async function seedContent(db) {
  const exam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, has_essay)
     VALUES ('enem-teste', 'ENEM Teste', 'ENEM', 'enem', 'INEP', true) RETURNING id`
  );

  const subjects = {};
  const subjectSpecs = [
    { slug: 'matematica', name: 'Matemática', weight: 3, order: 1 },
    { slug: 'portugues', name: 'Língua Portuguesa', weight: 2, order: 2 },
    { slug: 'historia', name: 'História', weight: 1, order: 3 },
  ];
  for (const spec of subjectSpecs) {
    const row = await db.one(
      `INSERT INTO subjects (slug, name, sort_order, color) VALUES ($1, $2, $3, '#2F80ED') RETURNING id`,
      [spec.slug, spec.name, spec.order]
    );
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, $3)', [
      exam.id,
      row.id,
      spec.weight,
    ]);
    subjects[spec.slug] = row.id;
  }

  const topics = {};
  const lessons = {};
  for (const spec of subjectSpecs) {
    for (let index = 1; index <= 3; index += 1) {
      const key = `${spec.slug}-${index}`;
      const topic = await db.one(
        `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
        [subjects[spec.slug], key, `${spec.name} — assunto ${index}`, index]
      );
      topics[key] = topic.id;
      await db.query('INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, 1)', [exam.id, topic.id]);
      for (let n = 1; n <= 2; n += 1) {
        const lesson = await db.one(
          `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, sort_order)
           VALUES ($1, $2, $3, $4, 20, $5) RETURNING id`,
          [subjects[spec.slug], topic.id, `${key}-aula-${n}`, `${spec.name} — aula ${index}.${n}`, n]
        );
        lessons[`${key}-${n}`] = lesson.id;
        await db.query('INSERT INTO lesson_exams (lesson_id, exam_id) VALUES ($1, $2)', [lesson.id, exam.id]);
      }
    }
  }

  // questões para as revisões e para a prática
  for (const key of ['matematica-1', 'matematica-2']) {
    for (let n = 1; n <= 6; n += 1) {
      const question = await db.one(
        `INSERT INTO questions (subject_id, topic_id, statement, resolution, explanation, difficulty, year, board)
         VALUES ($1, $2, $3, 'Resolução.', 'Explicação.', 2, 2024, 'INEP') RETURNING id`,
        [subjects.matematica, topics[key], `Questão ${n} de ${key}: calcule o valor pedido.`]
      );
      for (let i = 0; i < LETTERS.length; i += 1) {
        await db.query(
          `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [question.id, LETTERS[i], `Alternativa ${LETTERS[i]}`, i === 1, i + 1]
        );
      }
    }
  }

  return { exam: exam.id, subjects, topics, lessons };
}

const onboardingPayload = (examId, overrides = {}) => ({
  exam_id: examId,
  study_days: [0, 1, 2, 3, 4, 5, 6],
  hours_per_day: 2,
  level: 'intermediario',
  target_course: 'Medicina',
  target_university: 'USP',
  target_score: '800',
  ...overrides,
});

describe('Cronograma, revisões e onboarding', () => {
  let ctx;
  let content;
  let student;
  let db;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    content = await seedContent(db);
    student = await ctx.registerStudent({ name: 'Aluna Cronograma' });
    const res = await student.agent.post('/api/onboarding', onboardingPayload(content.exam));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    student.onboarding = res.body;
  });

  after(async () => {
    await ctx.close();
  });

  it('onboarding salva o perfil, calcula a meta semanal e gera o cronograma', async () => {
    const { profile, schedule_today: today } = student.onboarding;
    assert.equal(profile.onboarding_completed, true);
    assert.deepEqual(profile.study_days, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(Number(profile.hours_per_day), 2);
    assert.equal(Number(profile.weekly_goal_hours), 14);
    assert.equal(profile.exam.short_name, 'ENEM');
    assert.ok(today.items.length > 0, 'o cronograma de hoje deve ter itens');

    const res = await student.agent.get('/api/schedule');
    assert.equal(res.status, 200);
    assert.equal(res.body.days.length, 14);
    const withItems = res.body.days.filter((day) => day.items.length > 0);
    assert.ok(withItems.length >= 7, 'com estudo todos os dias, o cronograma deve cobrir a quinzena');
    for (const item of res.body.days[0].items) {
      assert.ok(item.id && item.type && item.title, 'item precisa de id, tipo e título');
      assert.ok(typeof item.href === 'string' && item.href.startsWith('/app/'));
    }
  });

  it('respeita os dias escolhidos e a capacidade diária', async () => {
    const other = await ctx.registerStudent({ name: 'Aluno Dois Dias' });
    const res = await other.agent.post(
      '/api/onboarding',
      onboardingPayload(content.exam, { study_days: [1, 3], hours_per_day: 1 })
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const schedule = await other.agent.get('/api/schedule');
    assert.equal(schedule.status, 200);
    const capacity = 60;
    for (const day of schedule.body.days) {
      const weekday = dates.weekday(day.date);
      if (![1, 3].includes(weekday)) {
        assert.equal(day.items.length, 0, `não deveria haver itens em ${day.date}`);
        assert.equal(day.is_study_day, false);
      } else {
        assert.equal(day.is_study_day, true);
      }
      assert.ok(
        day.total_min <= capacity + CAPACITY_TOLERANCE_MIN,
        `dia ${day.date} com ${day.total_min} min excede a capacidade de ${capacity} min`
      );
    }
    assert.ok(
      schedule.body.days.some((day) => day.items.length > 0),
      'os dias de estudo escolhidos precisam receber itens'
    );
  });

  it('aceita vestibular fora do catálogo e monta o plano com todas as matérias', async () => {
    const other = await ctx.registerStudent({ name: 'Aluno Outro Vestibular' });
    const res = await other.agent.post('/api/onboarding', {
      other_exam_name: 'Vestibular da UEM',
      target_university: 'UEM',
      target_course: 'Direito',
      study_days: [2, 4, 6],
      hours_per_day: 1.5,
      level: 'iniciante',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.profile.other_exam_name, 'Vestibular da UEM');
    assert.equal(res.body.profile.exam_id, null);
    assert.equal(Number(res.body.profile.weekly_goal_hours), 4.5);

    const schedule = await other.agent.get('/api/schedule');
    const items = schedule.body.days.flatMap((day) => day.items);
    assert.ok(items.length > 0, 'sem prova cadastrada o cronograma ainda deve ser gerado');
    assert.equal(items.some((item) => item.type === 'essay'), false, 'sem prova não há redação semanal');
    for (const day of schedule.body.days) {
      assert.ok(day.total_min <= 90 + CAPACITY_TOLERANCE_MIN, `dia ${day.date} acima da capacidade`);
      if (day.items.length > 0) assert.ok([2, 4, 6].includes(dates.weekday(day.date)));
    }
  });

  it('não ultrapassa a capacidade diária do aluno de 2h', async () => {
    const res = await student.agent.get('/api/schedule');
    for (const day of res.body.days) {
      assert.ok(
        day.total_min <= 120 + CAPACITY_TOLERANCE_MIN,
        `dia ${day.date} com ${day.total_min} min excede a capacidade de 120 min`
      );
    }
  });

  it('revisões criadas ao concluir uma aula aparecem no cronograma', async () => {
    const lessonId = content.lessons['matematica-1-1'];
    const completed = await student.agent.post(`/api/lessons/${lessonId}/complete`, {});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.ok(completed.body.reviews_created >= 1, 'concluir a aula deve criar revisões');

    const list = await student.agent.get('/api/reviews');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 1);
    const review = list.body.items[0];
    assert.equal(review.topic_id, content.topics['matematica-1']);
    assert.ok(list.body.counts.pending >= 1);

    const schedule = await student.agent.get('/api/schedule');
    const reviewItems = schedule.body.days.flatMap((day) => day.items.filter((item) => item.type === 'review'));
    assert.ok(reviewItems.length >= 1, 'a revisão devida precisa entrar no cronograma');
    assert.ok(reviewItems.some((item) => item.review_id === review.id));
    assert.equal(reviewItems[0].href, '/app/revisoes');

    const questions = await student.agent.get(`/api/reviews/${review.id}/questions`);
    assert.equal(questions.status, 200);
    assert.ok(Array.isArray(questions.body.questions));
    for (const question of questions.body.questions) {
      assert.equal(question.resolution, undefined, 'a revisão não pode expor o gabarito');
    }
  });

  it('prática com 2 de 5 acertos agenda um bloco de questões do assunto', async () => {
    const lessonId = content.lessons['matematica-2-1'];
    const res = await student.agent.post('/api/schedule/after-practice', {
      lesson_id: lessonId,
      correct: 2,
      total: 5,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accuracy_pct, 40);
    assert.ok(res.body.reinforcement, 'acurácia abaixo de 60% precisa gerar reforço');
    assert.equal(res.body.reinforcement.type, 'questions');
    assert.equal(res.body.reinforcement.topic_id, content.topics['matematica-2']);
    assert.equal(res.body.regenerated, true);

    const schedule = await student.agent.get('/api/schedule');
    const found = schedule.body.days
      .flatMap((day) => day.items)
      .find((item) => item.id === res.body.reinforcement.id);
    assert.ok(found, 'o bloco de reforço deve permanecer no cronograma após a regeração');
    assert.equal(found.date, dates.addDays(dates.todayISO(), 1));
    assert.ok(found.href.includes(`topic_id=${content.topics['matematica-2']}`));

    const good = await student.agent.post('/api/schedule/after-practice', {
      lesson_id: lessonId,
      correct: 5,
      total: 5,
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.reinforcement, null, 'acerto alto não agenda reforço');
  });

  it('o dashboard entrega tudo que a tela Início precisa', async () => {
    const res = await student.agent.get('/api/dashboard');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body;
    assert.equal(body.user.name, 'Aluna Cronograma');
    assert.equal(body.greeting_date, dates.todayISO());
    assert.ok(typeof body.quote === 'string' && body.quote.length > 0);
    assert.equal(body.exam.short_name, 'ENEM');
    assert.ok(Array.isArray(body.today.items));
    assert.ok(Array.isArray(body.subject_rings) && body.subject_rings.length <= 6);
    assert.equal(typeof body.plan_progress_pct, 'number');
    assert.equal(typeof body.stats.streak_days, 'number');
    assert.equal(typeof body.stats.weekly_goal.hours_goal, 'number');
    assert.equal(body.stats.weekly_goal.hours_goal, 14);
    assert.ok(body.upcoming_reviews_count >= 1);
    assert.equal(typeof body.checklist.lesson_done, 'boolean');
    if (body.next_item) assert.ok(body.next_item.href.startsWith('/app/'));
  });

  it('concluir um item do cronograma registra estudo e some da lista de pendentes', async () => {
    const today = await student.agent.get('/api/schedule/today');
    const pending = today.body.items.find((item) => item.status === 'pending' && item.type !== 'lesson');
    assert.ok(pending, 'deve haver item pendente hoje');

    const res = await student.agent.patch(`/api/schedule/items/${pending.id}`, { status: 'done' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'done');

    const after = await student.agent.get('/api/schedule/today');
    assert.equal(after.body.items.find((item) => item.id === pending.id).status, 'done');
    assert.ok(after.body.summary.done_min >= pending.duration_min);

    const log = await db.one(
      'SELECT count(*)::int AS total FROM study_logs WHERE user_id = $1 AND ref_id = $2',
      [student.user.id, pending.id]
    );
    assert.ok(Number(log.total) >= 1, 'concluir o item precisa gravar study_log');
  });

  it('itens manuais podem ser criados e removidos; os gerados não', async () => {
    const created = await student.agent.post('/api/schedule/items', {
      date: dates.todayISO(),
      title: 'Revisar caderno de erros',
      type: 'custom',
      duration_min: 25,
      start_time: '19:30',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.generated, false);
    assert.equal(created.body.start_time, '19:30');

    const generated = await student.agent.get('/api/schedule/today');
    const generatedItem = generated.body.items.find((item) => item.generated);
    if (generatedItem) {
      const blocked = await student.agent.del(`/api/schedule/items/${generatedItem.id}`);
      assert.equal(blocked.status, 403);
    }

    const removed = await student.agent.del(`/api/schedule/items/${created.body.id}`);
    assert.equal(removed.status, 200);
    const check = await student.agent.get('/api/schedule/today');
    assert.equal(check.body.items.some((item) => item.id === created.body.id), false);
  });

  it('"não consegui estudar hoje" move os pendentes para os próximos dias', async () => {
    const before = await student.agent.get('/api/schedule/today');
    const pendingBefore = before.body.items.filter((item) => item.status === 'pending');
    assert.ok(pendingBefore.length > 0, 'precisa haver itens pendentes hoje');

    const res = await student.agent.post('/api/schedule/skip-today', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.moved, pendingBefore.length);

    const after = await student.agent.get('/api/schedule/today');
    assert.equal(
      after.body.items.filter((item) => item.status === 'pending').length,
      0,
      'nenhum pendente deve sobrar hoje'
    );

    const moved = await db.many('SELECT id, date FROM schedule_items WHERE user_id = $1 AND id = ANY($2::uuid[])', [
      student.user.id,
      pendingBefore.map((item) => item.id),
    ]);
    assert.equal(moved.length, pendingBefore.length);
    for (const item of moved) {
      assert.ok(item.date > dates.todayISO(), 'o item precisa ir para um dia futuro');
    }

    // o remanejamento não pode ser desfeito pela próxima regeração
    const regenerated = await student.agent.post('/api/schedule/generate', {});
    assert.equal(regenerated.status, 200);
    const survivors = await db.many('SELECT id, date FROM schedule_items WHERE user_id = $1 AND id = ANY($2::uuid[])', [
      student.user.id,
      pendingBefore.map((item) => item.id),
    ]);
    assert.equal(survivors.length, pendingBefore.length, 'os itens remanejados devem sobreviver à regeração');
  });

  it('um aluno não altera nem enxerga itens de outro aluno', async () => {
    const intruder = await ctx.registerStudent({ name: 'Aluno Intruso' });
    await intruder.agent.post('/api/onboarding', onboardingPayload(content.exam, { study_days: [1, 2, 3, 4, 5] }));

    const victim = await db.one(
      `SELECT id FROM schedule_items WHERE user_id = $1 AND status = 'pending' ORDER BY date LIMIT 1`,
      [student.user.id]
    );
    assert.ok(victim, 'o aluno original precisa ter itens');

    const patched = await intruder.agent.patch(`/api/schedule/items/${victim.id}`, { status: 'done' });
    assert.equal(patched.status, 404);

    const deleted = await intruder.agent.del(`/api/schedule/items/${victim.id}`);
    assert.equal(deleted.status, 404);

    const still = await db.one('SELECT status FROM schedule_items WHERE id = $1', [victim.id]);
    assert.notEqual(still.status, 'done');

    const anonymous = await ctx.request('GET', '/api/schedule');
    assert.equal(anonymous.status, 401);
  });

  it('as provas ficam disponíveis para o onboarding sem sessão', async () => {
    const exams = await ctx.request('GET', '/api/exams');
    assert.equal(exams.status, 200);
    assert.ok(Array.isArray(exams.body) && exams.body.length >= 1);
    const exam = exams.body.find((row) => row.id === content.exam);
    assert.ok(exam, 'a prova de teste precisa aparecer');
    assert.equal(exam.short_name, 'ENEM');

    const subjects = await ctx.request('GET', `/api/exams/${content.exam}/subjects`);
    assert.equal(subjects.status, 200);
    assert.equal(subjects.body.length, 3);
    assert.equal(subjects.body[0].name, 'Matemática', 'a matéria de maior peso vem primeiro');
    assert.ok(Number(subjects.body[0].weight) === 3);
    assert.ok(Number(subjects.body[0].topics_count) === 3);
  });
});

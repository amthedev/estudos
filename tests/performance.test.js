'use strict';

/**
 * Provas anteriores, desempenho, resumos e favoritos.
 *
 *   NODE_ENV=test node --test tests/performance.test.js
 *
 * Cobre: agrupamento das provas anteriores por prova/ano, desempenho coerente com as tentativas
 * gravadas, CRUD de resumos, favoritar/desfavoritar e o isolamento entre alunos.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const dates = require('../server/utils/dates');

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Conteúdo mínimo: provas, matérias, assuntos, aula, questões e provas anteriores. */
async function seedContent(db) {
  const enem = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, sort_order)
     VALUES ('enem-teste', 'ENEM Teste', 'ENEM', 'enem', 'INEP', 1) RETURNING id`
  );
  const fuvest = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, sort_order)
     VALUES ('fuvest-teste', 'FUVEST Teste', 'FUVEST', 'vestibular', 'FUVEST', 2) RETURNING id`
  );
  const math = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`);
  const history = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('historia', 'História', 2) RETURNING id`);
  const percent = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
    [math.id]
  );
  const industrial = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'revolucao-industrial', 'Revolução Industrial', 1) RETURNING id`,
    [history.id]
  );
  const lesson = await db.one(
    `INSERT INTO lessons (subject_id, topic_id, slug, title, duration_min, summary)
     VALUES ($1, $2, 'aula-porcentagem', 'Porcentagem do zero', 30, 'Resumo da aula.') RETURNING id`,
    [math.id, percent.id]
  );

  async function question(subjectId, topicId, statement) {
    const row = await db.one(
      `INSERT INTO questions (subject_id, topic_id, statement, resolution, explanation, difficulty, year, board)
       VALUES ($1, $2, $3, 'Resolução.', 'Explicação.', 2, 2024, 'INEP') RETURNING id`,
      [subjectId, topicId, statement]
    );
    const options = {};
    for (let i = 0; i < LETTERS.length; i += 1) {
      const option = await db.one(
        `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [row.id, LETTERS[i], `Alternativa ${LETTERS[i]}`, LETTERS[i] === 'B', i + 1]
      );
      options[LETTERS[i]] = option.id;
    }
    return { id: row.id, options, correct: options.B, wrong: options.A };
  }

  const mathQuestions = [];
  for (let i = 1; i <= 5; i += 1) mathQuestions.push(await question(math.id, percent.id, `Questão de porcentagem ${i}`));
  const historyQuestions = [];
  for (let i = 1; i <= 5; i += 1) historyQuestions.push(await question(history.id, industrial.id, `Questão de história ${i}`));

  async function pastExam(examId, year, day, title, { active = true, sortOrder = 0 } = {}) {
    const row = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, board, pdf_url, answer_key_url, sort_order, active)
       VALUES ($1, $2, $3, $4, 'INEP', $5, $6, $7, $8) RETURNING id`,
      [examId, year, day, title, `https://exemplo.test/${year}-${day || 1}.pdf`, `https://exemplo.test/${year}-gabarito.pdf`, sortOrder, active]
    );
    return row.id;
  }

  const past = {
    enem2024day1: await pastExam(enem.id, 2024, 1, 'ENEM 2024 — 1º dia', { sortOrder: 1 }),
    enem2024day2: await pastExam(enem.id, 2024, 2, 'ENEM 2024 — 2º dia', { sortOrder: 2 }),
    enem2023day1: await pastExam(enem.id, 2023, 1, 'ENEM 2023 — 1º dia'),
    fuvest2024: await pastExam(fuvest.id, 2024, null, 'FUVEST 2024 — 1ª fase'),
    inactive: await pastExam(enem.id, 2022, 1, 'ENEM 2022 — 1º dia', { active: false }),
  };

  return {
    enem: enem.id,
    fuvest: fuvest.id,
    math: math.id,
    history: history.id,
    percent: percent.id,
    industrial: industrial.id,
    lesson: lesson.id,
    mathQuestions,
    historyQuestions,
    past,
  };
}

describe('provas anteriores, desempenho, resumos e favoritos', () => {
  let ctx;
  let content;
  let alice;
  let bob;

  before(async () => {
    ctx = await createTestContext();
    content = await seedContent(ctx.db);
    alice = await ctx.registerStudent({ name: 'Alice Aluna' });
    bob = await ctx.registerStudent({ name: 'Bob Aluno' });
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  // -------------------------------------------------------------------------
  describe('GET /api/past-exams', () => {
    it('agrupa por prova e por ano, do ano mais recente para o mais antigo', async () => {
      const res = await alice.agent.get('/api/past-exams');
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 4, 'a prova inativa não entra');

      const [first, second] = res.body.exams;
      assert.equal(first.exam.short_name, 'ENEM');
      assert.equal(first.exam.track, 'enem');
      assert.equal(first.exam.board, 'INEP');
      assert.equal(second.exam.short_name, 'FUVEST');

      assert.deepEqual(first.years.map((year) => year.year), [2024, 2023]);
      assert.equal(first.total, 3);
      assert.deepEqual(first.years[0].items.map((item) => item.day), [1, 2]);
      assert.equal(first.years[0].items[0].title, 'ENEM 2024 — 1º dia');
      assert.ok(first.years[0].items[0].pdf_url.endsWith('.pdf'));
      assert.ok(first.years[0].items[0].answer_key_url);

      const titles = res.body.exams.flatMap((group) => group.years.flatMap((year) => year.items.map((item) => item.title)));
      assert.ok(!titles.some((title) => title.includes('2022')), 'prova inativa não pode aparecer');

      assert.deepEqual(res.body.filters.years, [2024, 2023]);
      assert.deepEqual(res.body.filters.exams.map((exam) => exam.short_name), ['ENEM', 'FUVEST']);
    });

    it('filtra por prova e por ano', async () => {
      const byExam = await alice.agent.get(`/api/past-exams?exam_id=${content.fuvest}`);
      assert.equal(byExam.body.exams.length, 1);
      assert.equal(byExam.body.exams[0].exam.short_name, 'FUVEST');
      assert.equal(byExam.body.exams[0].years[0].items[0].day, null);

      const byYear = await alice.agent.get('/api/past-exams?year=2023');
      assert.equal(byYear.body.total, 1);
      assert.equal(byYear.body.exams[0].years[0].year, 2023);

      const invalid = await alice.agent.get('/api/past-exams?exam_id=abc');
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'validation_error');
    });

    it('exige sessão de aluno', async () => {
      const res = await ctx.request('GET', '/api/past-exams');
      assert.equal(res.status, 401);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /api/performance', () => {
    before(async () => {
      // Matemática: 3 acertos em 5 · História: 1 acerto em 5 (contexto practice não gera study_log)
      for (let i = 0; i < 5; i += 1) {
        const question = content.mathQuestions[i];
        await alice.agent.post(`/api/questions/${question.id}/answer`, {
          option_id: i < 3 ? question.correct : question.wrong,
          context: 'practice',
        });
      }
      for (let i = 0; i < 5; i += 1) {
        const question = content.historyQuestions[i];
        await alice.agent.post(`/api/questions/${question.id}/answer`, {
          option_id: i < 1 ? question.correct : question.wrong,
          context: 'practice',
        });
      }
      // aula concluída → 30 minutos de estudo hoje
      await alice.agent.post(`/api/lessons/${content.lesson}/complete`, {});

      await ctx.db.query(
        `INSERT INTO simulado_attempts (user_id, title, type, question_ids, status, score, correct_count, wrong_count, blank_count, finished_at)
         VALUES ($1, 'Simulado ENEM', 'exam', $2::uuid[], 'finished', 72.5, 29, 11, 0, now())`,
        [alice.user.id, content.mathQuestions.map((question) => question.id)]
      );
      await ctx.db.query(
        `INSERT INTO essays (user_id, exam_id, theme_title, content, status, score, max_score, submitted_at, corrected_at)
         VALUES ($1, $2, 'Desafios da mobilidade urbana', 'Texto da redação.', 'corrected', 840, 1000, now(), now())`,
        [alice.user.id, content.enem]
      );
    });

    it('resume o desempenho de acordo com as tentativas gravadas', async () => {
      const res = await alice.agent.get('/api/performance');
      assert.equal(res.status, 200);
      const body = res.body;

      assert.deepEqual(body.overall, { answered: 10, correct: 4, wrong: 6, accuracy_pct: 40 });

      const math = body.by_subject.find((subject) => subject.name === 'Matemática');
      const history = body.by_subject.find((subject) => subject.name === 'História');
      assert.deepEqual(
        { answered: math.answered, correct: math.correct, accuracy_pct: math.accuracy_pct },
        { answered: 5, correct: 3, accuracy_pct: 60 }
      );
      assert.equal(history.accuracy_pct, 20);
      assert.equal(body.by_subject[0].name, 'Matemática', 'ordena por volume e depois pela ordem da matéria');

      const percent = body.by_topic.find((topic) => topic.name === 'Porcentagem');
      assert.equal(percent.subject_name, 'Matemática');
      assert.equal(percent.answered, 5);
      assert.equal(percent.accuracy_pct, 60);
      assert.ok(body.by_topic.length <= 30);

      assert.equal(body.strengths[0].name, 'Porcentagem');
      assert.equal(body.weaknesses[0].name, 'Revolução Industrial');
      assert.equal(body.strengths.length, 2, 'apenas assuntos com 5 ou mais respostas');
    });

    it('devolve séries semanais e mensais completas, horas, aulas, simulados e redações', async () => {
      const body = (await alice.agent.get('/api/performance')).body;
      const today = dates.todayISO();

      assert.equal(body.weekly.length, 12);
      assert.equal(body.monthly.length, 6);
      const currentWeek = body.weekly[body.weekly.length - 1];
      assert.equal(currentWeek.week_start, dates.startOfWeek(today, 1));
      assert.equal(currentWeek.week_end, dates.addDays(currentWeek.week_start, 6));
      assert.equal(currentWeek.answered, 10);
      assert.equal(currentWeek.accuracy_pct, 40);
      assert.equal(currentWeek.minutes, 30);
      assert.equal(body.weekly[0].answered, 0, 'semanas sem estudo entram zeradas');

      const currentMonth = body.monthly[body.monthly.length - 1];
      assert.equal(currentMonth.month_start, dates.startOfMonth(today));
      assert.equal(currentMonth.month, today.slice(0, 7));
      assert.equal(currentMonth.minutes, 30);

      assert.deepEqual(body.hours, { total: 0.5, this_week: 0.5, this_month: 0.5 });
      assert.deepEqual(body.lessons, { done: 1, total: 1, pct: 100 });
      assert.equal(body.streak_days, 1);

      assert.equal(body.simulados.length, 1);
      assert.equal(body.simulados[0].title, 'Simulado ENEM');
      assert.equal(body.simulados[0].score, 72.5);
      assert.ok(body.simulados[0].finished_at);

      assert.equal(body.essays.length, 1);
      assert.equal(body.essays[0].theme_title, 'Desafios da mobilidade urbana');
      assert.equal(body.essays[0].score, 840);
      assert.equal(body.essays[0].max_score, 1000);
    });

    it('devolve zeros para quem ainda não estudou', async () => {
      const body = (await bob.agent.get('/api/performance')).body;
      assert.deepEqual(body.overall, { answered: 0, correct: 0, wrong: 0, accuracy_pct: null });
      assert.deepEqual(body.by_subject, []);
      assert.deepEqual(body.by_topic, []);
      assert.deepEqual(body.strengths, []);
      assert.deepEqual(body.weaknesses, []);
      assert.deepEqual(body.simulados, []);
      assert.deepEqual(body.essays, []);
      assert.equal(body.streak_days, 0);
      assert.equal(body.hours.total, 0);
      assert.equal(body.lessons.done, 0);
      assert.equal(body.weekly.length, 12);
      assert.equal(body.weekly.every((week) => week.answered === 0 && week.minutes === 0), true);
    });
  });

  // -------------------------------------------------------------------------
  describe('resumos (/api/notes)', () => {
    let noteId;

    it('cria um resumo e deriva a matéria a partir do assunto', async () => {
      const res = await alice.agent.post('/api/notes', {
        title: 'Fator de aumento',
        content: '# Revisão de porcentagem\n\nAumento de 20% equivale a multiplicar por 1,2.',
        topic_id: content.percent,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.subject_id, content.math);
      assert.equal(res.body.subject_name, 'Matemática');
      assert.equal(res.body.topic_name, 'Porcentagem');
      assert.equal(res.body.favorited, false);
      assert.ok(res.body.content.includes('1,2'));
      noteId = res.body.id;
    });

    it('lista com trecho, nomes e filtros de matéria, texto e período', async () => {
      const list = await alice.agent.get('/api/notes');
      assert.equal(list.status, 200);
      assert.equal(list.body.total, 1);
      assert.equal(list.body.page, 1);
      const [item] = list.body.items;
      assert.equal(item.title, 'Fator de aumento');
      assert.equal(item.subject_name, 'Matemática');
      assert.equal(item.topic_name, 'Porcentagem');
      assert.ok(item.excerpt.startsWith('Revisão de porcentagem'), 'o trecho vem sem marcação de markdown');
      assert.equal(item.content, undefined, 'a listagem não carrega o conteúdo inteiro');

      const bySubject = await alice.agent.get(`/api/notes?subject_id=${content.math}`);
      assert.equal(bySubject.body.total, 1);
      const otherSubject = await alice.agent.get(`/api/notes?subject_id=${content.history}`);
      assert.equal(otherSubject.body.total, 0);

      const search = await alice.agent.get('/api/notes?q=revisao');
      assert.equal(search.body.total, 1, 'a busca ignora acentos');
      const noMatch = await alice.agent.get('/api/notes?q=fotossintese');
      assert.equal(noMatch.body.total, 0);

      const today = dates.todayISO();
      const inRange = await alice.agent.get(`/api/notes?from=${today}&to=${today}`);
      assert.equal(inRange.body.total, 1);
      const future = await alice.agent.get(`/api/notes?from=${dates.addDays(today, 1)}`);
      assert.equal(future.body.total, 0);
      const badDate = await alice.agent.get('/api/notes?from=01/01/2026');
      assert.equal(badDate.status, 400);
    });

    it('lê, edita e apaga o resumo', async () => {
      const detail = await alice.agent.get(`/api/notes/${noteId}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.content.includes('Aumento de 20%'));

      const updated = await alice.agent.put(`/api/notes/${noteId}`, {
        title: 'Fator de aumento e de desconto',
        content: 'Desconto de 20% equivale a multiplicar por 0,8.',
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.title, 'Fator de aumento e de desconto');
      assert.ok(updated.body.content.includes('0,8'));

      const empty = await alice.agent.put(`/api/notes/${noteId}`, {});
      assert.equal(empty.status, 400);

      const created = await alice.agent.post('/api/notes', { title: 'Descartável', content: 'texto' });
      const removed = await alice.agent.del(`/api/notes/${created.body.id}`);
      assert.equal(removed.status, 200);
      assert.equal(removed.body.ok, true);
      const gone = await alice.agent.get(`/api/notes/${created.body.id}`);
      assert.equal(gone.status, 404);
      assert.equal(gone.body.error.code, 'not_found');
    });

    it('convive com a anotação da aula sem duplicá-la', async () => {
      const saved = await alice.agent.put(`/api/lessons/${content.lesson}/note`, { content: 'Anotação feita durante a aula.' });
      assert.equal(saved.status, 200);

      const list = await alice.agent.get(`/api/notes?lesson_id=${content.lesson}`);
      assert.equal(list.body.total, 1);
      assert.equal(list.body.items[0].lesson_title, 'Porcentagem do zero');
      assert.equal(list.body.items[0].lesson_id, content.lesson);

      const duplicated = await alice.agent.post('/api/notes', { title: 'Outra', content: 'x', lesson_id: content.lesson });
      assert.equal(duplicated.status, 409);
      assert.equal(duplicated.body.error.code, 'conflict');
    });

    it('recusa vínculos inexistentes', async () => {
      const res = await alice.agent.post('/api/notes', { title: 'Sem assunto', topic_id: UNKNOWN_ID });
      assert.equal(res.status, 404);
      const noTitle = await alice.agent.post('/api/notes', { content: 'sem título' });
      assert.equal(noTitle.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  describe('favoritos (/api/favorites)', () => {
    let noteId;

    before(async () => {
      const note = await alice.agent.post('/api/notes', { title: 'Resumo favorito', content: 'Conteúdo do resumo favorito.' });
      noteId = note.body.id;
    });

    it('favorita aula, questão, assunto e resumo com os dados já resolvidos', async () => {
      const lesson = await alice.agent.post('/api/favorites', { item_type: 'lesson', item_id: content.lesson });
      assert.equal(lesson.status, 201);
      assert.equal(lesson.body.created, true);
      assert.equal(lesson.body.title, 'Porcentagem do zero');
      assert.equal(lesson.body.subject_name, 'Matemática');
      assert.equal(lesson.body.duration_min, 30);
      assert.equal(lesson.body.href, `/app/aulas/${content.lesson}`);

      const question = await alice.agent.post('/api/favorites', { item_type: 'question', item_id: content.mathQuestions[0].id });
      assert.equal(question.status, 201);
      assert.ok(question.body.title.startsWith('Questão de porcentagem'));
      assert.ok(question.body.href.includes('/app/questoes'));

      const topic = await alice.agent.post('/api/favorites', { item_type: 'topic', item_id: content.percent });
      assert.equal(topic.status, 201);
      assert.equal(topic.body.title, 'Porcentagem');
      assert.equal(topic.body.lessons_total, 1);
      assert.equal(topic.body.href, `/app/materias/${content.math}/assuntos/${content.percent}`);

      const note = await alice.agent.post('/api/favorites', { item_type: 'note', item_id: noteId });
      assert.equal(note.status, 201);
      assert.equal(note.body.title, 'Resumo favorito');
      assert.equal(note.body.href, `/app/resumos/${noteId}`);

      const again = await alice.agent.post('/api/favorites', { item_type: 'lesson', item_id: content.lesson });
      assert.equal(again.status, 200);
      assert.equal(again.body.created, false, 'favoritar duas vezes não duplica');
    });

    it('lista tudo, filtra por tipo e conta por tipo', async () => {
      const all = await alice.agent.get('/api/favorites');
      assert.equal(all.status, 200);
      assert.equal(all.body.total, 4);
      assert.deepEqual(all.body.counts, { lesson: 1, question: 1, topic: 1, note: 1, total: 4 });
      assert.deepEqual(new Set(all.body.items.map((item) => item.item_type)), new Set(['lesson', 'question', 'topic', 'note']));

      const onlyLessons = await alice.agent.get('/api/favorites?type=lesson');
      assert.equal(onlyLessons.body.items.length, 1);
      assert.equal(onlyLessons.body.items[0].item_id, content.lesson);
      assert.equal(onlyLessons.body.counts.total, 4, 'as contagens sempre cobrem todos os tipos');

      const invalid = await alice.agent.get('/api/favorites?type=aula');
      assert.equal(invalid.status, 400);
    });

    it('desfavorita e limpa o favorito quando o resumo é apagado', async () => {
      const removed = await alice.agent.del('/api/favorites', { item_type: 'question', item_id: content.mathQuestions[0].id });
      assert.equal(removed.status, 200);
      assert.equal(removed.body.removed, true);

      const again = await alice.agent.del('/api/favorites', { item_type: 'question', item_id: content.mathQuestions[0].id });
      assert.equal(again.body.removed, false);

      const afterRemove = await alice.agent.get('/api/favorites');
      assert.equal(afterRemove.body.total, 3);
      assert.equal(afterRemove.body.counts.question, 0);

      await alice.agent.del(`/api/notes/${noteId}`);
      const afterNote = await alice.agent.get('/api/favorites');
      assert.equal(afterNote.body.total, 2);
      assert.equal(afterNote.body.counts.note, 0);
      const orphan = await ctx.db.one(`SELECT id FROM favorites WHERE user_id = $1 AND item_type = 'note' AND item_id = $2`, [
        alice.user.id,
        noteId,
      ]);
      assert.equal(orphan, null, 'o favorito órfão é removido junto com o resumo');
    });

    it('recusa itens inexistentes', async () => {
      const res = await alice.agent.post('/api/favorites', { item_type: 'lesson', item_id: UNKNOWN_ID });
      assert.equal(res.status, 404);
      const invalid = await alice.agent.post('/api/favorites', { item_type: 'video', item_id: content.lesson });
      assert.equal(invalid.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  describe('isolamento entre alunos', () => {
    it('um aluno não vê nem altera resumos e favoritos de outro', async () => {
      const aliceNote = await alice.agent.post('/api/notes', { title: 'Só da Alice', content: 'Conteúdo privado.' });
      assert.equal(aliceNote.status, 201);
      await alice.agent.post('/api/favorites', { item_type: 'topic', item_id: content.industrial });

      const notes = await bob.agent.get('/api/notes');
      assert.equal(notes.body.total, 0);
      assert.equal((await bob.agent.get(`/api/notes/${aliceNote.body.id}`)).status, 404);
      assert.equal((await bob.agent.put(`/api/notes/${aliceNote.body.id}`, { title: 'invasão' })).status, 404);
      assert.equal((await bob.agent.del(`/api/notes/${aliceNote.body.id}`)).status, 404);

      const favorites = await bob.agent.get('/api/favorites');
      assert.equal(favorites.body.total, 0);
      assert.equal(favorites.body.counts.total, 0);

      const stealNote = await bob.agent.post('/api/favorites', { item_type: 'note', item_id: aliceNote.body.id });
      assert.equal(stealNote.status, 404, 'não é possível favoritar o resumo de outro aluno');

      const removeOther = await bob.agent.del('/api/favorites', { item_type: 'topic', item_id: content.industrial });
      assert.equal(removeOther.body.removed, false);

      const untouched = await ctx.db.one('SELECT title FROM notes WHERE id = $1', [aliceNote.body.id]);
      assert.equal(untouched.title, 'Só da Alice');
      const aliceFavorites = await alice.agent.get('/api/favorites');
      assert.ok(aliceFavorites.body.items.some((item) => item.item_id === content.industrial));
    });
  });
});

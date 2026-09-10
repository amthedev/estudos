'use strict';

/**
 * Questões e caderno de erros: filtros, resposta com feedback, caderno (entrada, resolução, notas,
 * remoção, refazer), gabarito nunca exposto em GET e isolamento entre alunos.
 *
 *   NODE_ENV=test node --test tests/questions.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/** Insere prova, matérias, assuntos e questões diretamente no banco de teste. */
async function seedContent(db) {
  const exam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board) VALUES ('enem-teste', 'ENEM Teste', 'ENEM', 'enem', 'INEP') RETURNING id`
  );
  const otherExam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board) VALUES ('fuvest-teste', 'FUVEST Teste', 'FUVEST', 'vestibular', 'FUVEST') RETURNING id`
  );
  const math = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`);
  const history = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('historia', 'História', 2) RETURNING id`);
  const percent = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
    [math.id]
  );
  const ratio = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'regra-de-tres', 'Regra de três', 2) RETURNING id`,
    [math.id]
  );
  const industrial = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'revolucao-industrial', 'Revolução Industrial', 1) RETURNING id`,
    [history.id]
  );
  const subtopic = await db.one(
    `INSERT INTO subtopics (topic_id, slug, name) VALUES ($1, 'fator', 'Fator de aumento e de desconto') RETURNING id`,
    [percent.id]
  );

  async function question({ subject, topic, subtopic: sub = null, statement, difficulty = 2, year = 2024, board = 'INEP', correct = 'B', exams = [], sourceExam = null, active = true }) {
    const row = await db.one(
      `INSERT INTO questions (subject_id, topic_id, subtopic_id, statement, resolution, explanation, difficulty, year, board, source_exam_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [subject, topic, sub, statement, `Resolução da questão: ${statement}`, `Explicação: a correta é ${correct}.`, difficulty, year, board, sourceExam, active]
    );
    const options = {};
    for (let i = 0; i < LETTERS.length; i += 1) {
      const option = await db.one(
        `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [row.id, LETTERS[i], `Alternativa ${LETTERS[i]}`, LETTERS[i] === correct, i + 1]
      );
      options[LETTERS[i]] = option.id;
    }
    for (const examId of exams) {
      await db.query('INSERT INTO question_exams (question_id, exam_id) VALUES ($1, $2)', [row.id, examId]);
    }
    return { id: row.id, options, correct: options[correct] };
  }

  const q1 = await question({ subject: math.id, topic: percent.id, subtopic: subtopic.id, statement: 'Uma loja oferece desconto de 12% em um tênis de R$ 250,00. Qual o valor à vista?', difficulty: 1, year: 2023, board: 'INEP', correct: 'B', exams: [exam.id] });
  const q2 = await question({ subject: math.id, topic: percent.id, statement: 'Aumento de 20% seguido de desconto de 20%: qual a variação final?', difficulty: 2, year: 2024, board: 'INEP', correct: 'C', exams: [exam.id] });
  const q3 = await question({ subject: math.id, topic: ratio.id, statement: 'Seis operários constroem um muro em 10 dias. Em quantos dias 15 operários constroem o mesmo muro?', difficulty: 3, year: 2022, board: 'VUNESP', correct: 'D', exams: [otherExam.id] });
  const q4 = await question({ subject: history.id, topic: industrial.id, statement: 'Os cercamentos na Inglaterra consistiram na privatização de terras comunais.', difficulty: 2, year: 2021, board: 'FUVEST', correct: 'A', sourceExam: otherExam.id });
  const inactive = await question({ subject: history.id, topic: industrial.id, statement: 'Questão desativada pelo administrador.', active: false });

  return { exam, otherExam, math, history, percent, ratio, industrial, subtopic, q1, q2, q3, q4, inactive };
}

function assertNoAnswerKey(question) {
  assert.equal(question.resolution, undefined, 'resolution não pode sair na listagem');
  assert.equal(question.explanation, undefined, 'explanation não pode sair na listagem');
  assert.ok(Array.isArray(question.options) && question.options.length === 5);
  for (const option of question.options) {
    assert.equal(option.is_correct, undefined, 'is_correct não pode sair nas alternativas');
    assert.deepEqual(Object.keys(option).sort(), ['id', 'letter', 'text']);
  }
}

describe('Questões: banco, resposta com feedback e caderno de erros', () => {
  let ctx;
  let content;
  let alice;
  let bob;

  before(async () => {
    ctx = await createTestContext();
    content = await seedContent(ctx.db);
    alice = await ctx.registerStudent({ name: 'Alice Teste' });
    bob = await ctx.registerStudent({ name: 'Bob Teste' });
  });

  after(async () => {
    await ctx.close();
  });

  describe('segurança básica', () => {
    it('sem login → 401 nas rotas de questões e do caderno', async () => {
      for (const path of ['/api/questions', `/api/questions/${content.q1.id}`, '/api/questions/filters', '/api/errors', '/api/errors/summary']) {
        const res = await ctx.request('GET', path);
        assert.equal(res.status, 401, path);
        assert.equal(res.body.error.code, 'unauthorized');
      }
      const answer = await ctx.request('POST', `/api/questions/${content.q1.id}/answer`, {
        body: { option_id: content.q1.correct, context: 'bank' },
      });
      assert.equal(answer.status, 401);
    });

    it('com assinatura obrigatória e sem assinatura → 402 payment_required', async () => {
      await settings.setSetting('require_subscription', true);
      try {
        const res = await alice.agent.get('/api/questions');
        assert.equal(res.status, 402);
        assert.equal(res.body.error.code, 'payment_required');
      } finally {
        await settings.setSetting('require_subscription', null);
      }
    });
  });

  describe('GET /api/questions', () => {
    it('lista paginada com nomes de matéria/assunto, alternativas sem gabarito e user_last_result nulo', async () => {
      const res = await alice.agent.get('/api/questions');
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 4, 'questão inativa não entra');
      assert.equal(res.body.page, 1);
      assert.equal(res.body.items.length, 4);
      const first = res.body.items[0];
      assert.equal(first.subject_name, 'Matemática');
      assert.equal(first.topic_name, 'Porcentagem');
      assert.equal(first.user_last_result, null);
      assert.equal(first.user_attempts, 0);
      res.body.items.forEach(assertNoAnswerKey);
      assert.ok(!res.body.items.some((q) => q.id === content.inactive.id));
    });

    it('filtra por matéria, assunto, subassunto, dificuldade, ano e banca', async () => {
      const bySubject = await alice.agent.get(`/api/questions?subject_id=${content.math.id}`);
      assert.equal(bySubject.body.total, 3);

      const byTopic = await alice.agent.get(`/api/questions?topic_id=${content.percent.id}`);
      assert.equal(byTopic.body.total, 2);

      const bySubtopic = await alice.agent.get(`/api/questions?subtopic_id=${content.subtopic.id}`);
      assert.equal(bySubtopic.body.total, 1);
      assert.equal(bySubtopic.body.items[0].id, content.q1.id);

      const byDifficulty = await alice.agent.get('/api/questions?difficulty=3');
      assert.equal(byDifficulty.body.total, 1);
      assert.equal(byDifficulty.body.items[0].id, content.q3.id);

      const byYear = await alice.agent.get('/api/questions?year=2021');
      assert.equal(byYear.body.total, 1);
      assert.equal(byYear.body.items[0].id, content.q4.id);

      const byBoard = await alice.agent.get('/api/questions?board=vunesp');
      assert.equal(byBoard.body.total, 1);
      assert.equal(byBoard.body.items[0].id, content.q3.id);
    });

    it('filtra por prova via question_exams ou source_exam_id', async () => {
      const enem = await alice.agent.get(`/api/questions?exam_id=${content.exam.id}`);
      assert.equal(enem.body.total, 2);

      const fuvest = await alice.agent.get(`/api/questions?exam_id=${content.otherExam.id}`);
      assert.equal(fuvest.body.total, 2, 'q3 (question_exams) + q4 (source_exam_id)');
      const ids = fuvest.body.items.map((q) => q.id).sort();
      assert.deepEqual(ids, [content.q3.id, content.q4.id].sort());
    });

    it('busca textual ignora acentos (full-text e fallback ILIKE)', async () => {
      const accent = await alice.agent.get('/api/questions?q=operários');
      assert.equal(accent.body.total, 1);
      assert.equal(accent.body.items[0].id, content.q3.id);

      const noAccent = await alice.agent.get('/api/questions?q=operarios');
      assert.equal(noAccent.body.total, 1);

      const partial = await alice.agent.get('/api/questions?q=R$ 250');
      assert.equal(partial.body.total, 1);
      assert.equal(partial.body.items[0].id, content.q1.id);

      const none = await alice.agent.get('/api/questions?q=fotossíntese');
      assert.equal(none.body.total, 0);
      assert.deepEqual(none.body.items, []);
    });

    it('rejeita filtros inválidos com 400', async () => {
      const res = await alice.agent.get('/api/questions?difficulty=9&subject_id=abc');
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_error');
      const paths = res.body.error.details.map((d) => d.path);
      assert.ok(paths.includes('difficulty'));
      assert.ok(paths.includes('subject_id'));
    });

    it('pagina com page/limit', async () => {
      const page1 = await alice.agent.get('/api/questions?limit=3&page=1');
      assert.equal(page1.body.items.length, 3);
      assert.equal(page1.body.pages, 2);
      const page2 = await alice.agent.get('/api/questions?limit=3&page=2');
      assert.equal(page2.body.items.length, 1);
      const page3 = await alice.agent.get('/api/questions?limit=3&page=3');
      assert.deepEqual(page3.body.items, []);
      assert.equal(page3.body.total, 4);
    });
  });

  describe('GET /api/questions/filters e /:id', () => {
    it('devolve anos, bancas, dificuldades e taxonomia com questões ativas', async () => {
      const res = await alice.agent.get('/api/questions/filters');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.years, [2024, 2023, 2022, 2021]);
      assert.deepEqual(res.body.boards, ['FUVEST', 'INEP', 'VUNESP']);
      assert.deepEqual(res.body.difficulties, [1, 2, 3]);
      assert.equal(res.body.subjects.length, 2);
      const math = res.body.subjects.find((s) => s.id === content.math.id);
      assert.equal(math.total, 3);
      assert.equal(res.body.topics.length, 3);
      assert.equal(res.body.subtopics.length, 1);
    });

    it('GET /:id devolve a questão sem gabarito, com provas; 404 para inexistente ou inativa', async () => {
      const res = await alice.agent.get(`/api/questions/${content.q1.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.id, content.q1.id);
      assert.equal(res.body.subject_name, 'Matemática');
      assert.equal(res.body.exams.length, 1);
      assert.equal(res.body.exams[0].short_name, 'ENEM');
      assertNoAnswerKey(res.body);

      const missing = await alice.agent.get('/api/questions/00000000-0000-0000-0000-000000000000');
      assert.equal(missing.status, 404);
      const inactive = await alice.agent.get(`/api/questions/${content.inactive.id}`);
      assert.equal(inactive.status, 404);
      const invalid = await alice.agent.get('/api/questions/nao-e-uuid');
      assert.equal(invalid.status, 400);
    });
  });

  describe('POST /api/questions/:id/answer', () => {
    it('resposta certa devolve feedback completo e grava a tentativa (sem entrar no caderno)', async () => {
      const res = await alice.agent.post(`/api/questions/${content.q1.id}/answer`, {
        option_id: content.q1.correct,
        context: 'bank',
        time_spent_sec: 42,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.is_correct, true);
      assert.equal(res.body.correct_option_id, content.q1.correct);
      assert.match(res.body.resolution, /^Resolução/);
      assert.match(res.body.explanation, /^Explicação/);
      assert.ok(res.body.attempt_id);
      assert.equal(res.body.notebook, null);

      const attempt = await ctx.db.one('SELECT * FROM question_attempts WHERE id = $1', [res.body.attempt_id]);
      assert.equal(attempt.user_id, alice.user.id);
      assert.equal(attempt.context, 'bank');
      assert.equal(attempt.is_correct, true);
      assert.equal(attempt.time_spent_sec, 42);
      assert.equal(attempt.subject_id, content.math.id);

      const notebook = await ctx.db.one('SELECT id FROM error_notebook WHERE user_id = $1 AND question_id = $2', [alice.user.id, content.q1.id]);
      assert.equal(notebook, null);

      const log = await ctx.db.one(`SELECT minutes FROM study_logs WHERE user_id = $1 AND activity_type = 'questions' AND ref_id = $2`, [alice.user.id, content.q1.id]);
      assert.ok(log, 'resposta no banco gera registro de estudo');
      assert.equal(log.minutes, 1);

      const listed = await alice.agent.get(`/api/questions?topic_id=${content.percent.id}`);
      const item = listed.body.items.find((q) => q.id === content.q1.id);
      assert.equal(item.user_last_result, 'correct');
      assert.equal(item.user_attempts, 1);
    });

    it('resposta errada entra no caderno; errar de novo incrementa times_wrong', async () => {
      const wrongOption = content.q2.options.A;
      const first = await alice.agent.post(`/api/questions/${content.q2.id}/answer`, {
        option_id: wrongOption,
        context: 'practice',
        context_id: '11111111-1111-4111-8111-111111111111',
        time_spent_sec: 30,
      });
      assert.equal(first.status, 201);
      assert.equal(first.body.is_correct, false);
      assert.equal(first.body.correct_option_id, content.q2.correct);
      assert.ok(first.body.notebook);
      assert.equal(first.body.notebook.times_wrong, 1);
      assert.equal(first.body.notebook.resolved, false);

      const second = await alice.agent.post(`/api/questions/${content.q2.id}/answer`, {
        option_id: content.q2.options.E,
        context: 'bank',
      });
      assert.equal(second.body.notebook.times_wrong, 2);

      const row = await ctx.db.one('SELECT * FROM error_notebook WHERE user_id = $1 AND question_id = $2', [alice.user.id, content.q2.id]);
      assert.equal(row.times_wrong, 2);
      assert.equal(row.wrong_option_id, content.q2.options.E, 'guarda a última alternativa errada');
      assert.equal(row.resolved, false);

      const listed = await alice.agent.get('/api/questions?status=wrong');
      assert.equal(listed.body.total, 1);
      assert.equal(listed.body.items[0].id, content.q2.id);
      assert.equal(listed.body.items[0].user_last_result, 'wrong');
      assert.equal(listed.body.items[0].error_id, row.id);

      const answered = await alice.agent.get('/api/questions?status=answered');
      assert.equal(answered.body.total, 2);
      const unanswered = await alice.agent.get('/api/questions?status=unanswered');
      assert.equal(unanswered.body.total, 2);
    });

    it('rejeita alternativa de outra questão, contexto inválido e questão inexistente', async () => {
      const foreign = await alice.agent.post(`/api/questions/${content.q1.id}/answer`, {
        option_id: content.q2.options.A,
        context: 'bank',
      });
      assert.equal(foreign.status, 400);
      assert.equal(foreign.body.error.code, 'validation_error');
      assert.equal(foreign.body.error.details[0].path, 'option_id');

      const badContext = await alice.agent.post(`/api/questions/${content.q1.id}/answer`, {
        option_id: content.q1.correct,
        context: 'simulado',
      });
      assert.equal(badContext.status, 400);

      const missing = await alice.agent.post('/api/questions/00000000-0000-0000-0000-000000000000/answer', {
        option_id: content.q1.correct,
        context: 'bank',
      });
      assert.equal(missing.status, 404);

      const inactive = await alice.agent.post(`/api/questions/${content.inactive.id}/answer`, {
        option_id: content.inactive.correct,
        context: 'bank',
      });
      assert.equal(inactive.status, 404);

      const total = await ctx.db.one('SELECT count(*)::int AS n FROM question_attempts WHERE user_id = $1', [alice.user.id]);
      assert.equal(total.n, 3, 'nenhuma tentativa inválida foi gravada');
    });
  });

  describe('Caderno de erros', () => {
    let entryId;

    it('GET /api/errors lista o erro com marcada, correta, explicação e resumo', async () => {
      const res = await alice.agent.get('/api/errors');
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 1);
      const item = res.body.items[0];
      entryId = item.id;
      assert.equal(item.question_id, content.q2.id);
      assert.equal(item.subject_name, 'Matemática');
      assert.equal(item.topic_name, 'Porcentagem');
      assert.equal(item.times_wrong, 2);
      assert.equal(item.resolved, false);
      assert.equal(item.notes, null);
      assert.equal(item.wrong_option.id, content.q2.options.E);
      assert.equal(item.wrong_option.letter, 'E');
      assert.equal(item.correct_option.id, content.q2.correct);
      assert.equal(item.correct_option.letter, 'C');
      assert.match(item.explanation, /^Explicação/);
      assert.ok(item.question.statement);
      assert.equal(item.question.options.length, 5);
      assert.ok(item.question.options.every((o) => o.is_correct === undefined));
      assert.ok(item.last_wrong_at);

      const summary = await alice.agent.get('/api/errors/summary');
      assert.equal(summary.body.total, 1);
      assert.equal(summary.body.unresolved, 1);
      assert.equal(summary.body.resolved, 0);
      assert.equal(summary.body.by_subject.length, 1);
      assert.equal(summary.body.by_subject[0].subject_id, content.math.id);
      assert.equal(summary.body.by_subject[0].unresolved, 1);
      assert.equal(summary.body.by_topic[0].topic_id, content.percent.id);

      const bySubject = await alice.agent.get(`/api/errors?subject_id=${content.history.id}`);
      assert.equal(bySubject.body.total, 0);
      const unresolved = await alice.agent.get('/api/errors?resolved=false');
      assert.equal(unresolved.body.total, 1);
      const resolved = await alice.agent.get('/api/errors?resolved=true');
      assert.equal(resolved.body.total, 0);
    });

    it('PATCH /api/errors/:id salva notas pessoais', async () => {
      const res = await alice.agent.patch(`/api/errors/${entryId}`, { notes: 'Revisar fator multiplicativo.' });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, entryId);
      assert.equal(res.body.notes, 'Revisar fator multiplicativo.');

      const cleared = await alice.agent.patch(`/api/errors/${entryId}`, { notes: '   ' });
      assert.equal(cleared.body.notes, null);

      const invalid = await alice.agent.patch(`/api/errors/${entryId}`, { notes: 'x'.repeat(2001) });
      assert.equal(invalid.status, 400);
    });

    it('POST /api/errors/redo devolve as questões sem gabarito e acertar em errors_redo resolve a entrada', async () => {
      // mais um erro em outra matéria para testar o filtro por matéria
      await alice.agent.post(`/api/questions/${content.q4.id}/answer`, { option_id: content.q4.options.B, context: 'bank' });

      const all = await alice.agent.post('/api/errors/redo', {});
      assert.equal(all.status, 200);
      assert.equal(all.body.length, 2);
      all.body.forEach(assertNoAnswerKey);
      assert.ok(all.body.every((q) => q.error_id));

      const onlyMath = await alice.agent.post('/api/errors/redo', { subject_id: content.math.id, limit: 5 });
      assert.equal(onlyMath.body.length, 1);
      assert.equal(onlyMath.body[0].id, content.q2.id);
      assert.equal(onlyMath.body[0].error_id, entryId);

      const byIds = await alice.agent.post('/api/errors/redo', { ids: [entryId] });
      assert.equal(byIds.body.length, 1);

      // errar de novo no refazer mantém pendente e incrementa
      const wrongAgain = await alice.agent.post(`/api/questions/${content.q2.id}/answer`, { option_id: content.q2.options.A, context: 'errors_redo' });
      assert.equal(wrongAgain.body.notebook.times_wrong, 3);

      const fixed = await alice.agent.post(`/api/questions/${content.q2.id}/answer`, { option_id: content.q2.correct, context: 'errors_redo' });
      assert.equal(fixed.status, 201);
      assert.equal(fixed.body.is_correct, true);
      assert.equal(fixed.body.notebook.resolved, true);

      const row = await ctx.db.one('SELECT resolved, resolved_at, times_wrong FROM error_notebook WHERE id = $1', [entryId]);
      assert.equal(row.resolved, true);
      assert.ok(row.resolved_at);
      assert.equal(row.times_wrong, 3);

      const summary = await alice.agent.get('/api/errors/summary');
      assert.equal(summary.body.total, 2);
      assert.equal(summary.body.unresolved, 1);
      assert.equal(summary.body.resolved, 1);

      // acertar no banco (context bank) não resolve; só errors_redo/review
      await alice.agent.post(`/api/questions/${content.q4.id}/answer`, { option_id: content.q4.correct, context: 'bank' });
      const stillOpen = await ctx.db.one('SELECT resolved FROM error_notebook WHERE user_id = $1 AND question_id = $2', [alice.user.id, content.q4.id]);
      assert.equal(stillOpen.resolved, false);

      // lista ordena pendentes primeiro
      const list = await alice.agent.get('/api/errors');
      assert.equal(list.body.items[0].resolved, false);
      assert.equal(list.body.items[1].resolved, true);

      // a listagem do banco não expõe error_id de entradas já resolvidas
      const bank = await alice.agent.get(`/api/questions/${content.q2.id}`);
      assert.equal(bank.body.error_id, null);
    });

    it('DELETE /api/errors/:id remove a entrada', async () => {
      const res = await alice.agent.del(`/api/errors/${entryId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      const again = await alice.agent.del(`/api/errors/${entryId}`);
      assert.equal(again.status, 404);
      const list = await alice.agent.get('/api/errors');
      assert.equal(list.body.total, 1);
    });
  });

  describe('isolamento entre alunos', () => {
    it('o aluno B não vê tentativas nem caderno do aluno A e não altera os registros dele', async () => {
      const list = await bob.agent.get('/api/questions?status=answered');
      assert.equal(list.body.total, 0, 'nenhuma questão aparece como respondida para B');
      const wrong = await bob.agent.get('/api/questions?status=wrong');
      assert.equal(wrong.body.total, 0);
      const detail = await bob.agent.get(`/api/questions/${content.q2.id}`);
      assert.equal(detail.body.user_last_result, null);
      assert.equal(detail.body.error_id, null);

      const notebook = await bob.agent.get('/api/errors');
      assert.equal(notebook.body.total, 0);
      const summary = await bob.agent.get('/api/errors/summary');
      assert.equal(summary.body.total, 0);
      assert.deepEqual(summary.body.by_subject, []);
      const redo = await bob.agent.post('/api/errors/redo', {});
      assert.deepEqual(redo.body, []);

      const aliceEntry = await ctx.db.one('SELECT id FROM error_notebook WHERE user_id = $1', [alice.user.id]);
      assert.ok(aliceEntry);
      const patch = await bob.agent.patch(`/api/errors/${aliceEntry.id}`, { notes: 'invasão' });
      assert.equal(patch.status, 404);
      const del = await bob.agent.del(`/api/errors/${aliceEntry.id}`);
      assert.equal(del.status, 404);
      const byIds = await bob.agent.post('/api/errors/redo', { ids: [aliceEntry.id] });
      assert.deepEqual(byIds.body, []);

      const untouched = await ctx.db.one('SELECT notes FROM error_notebook WHERE id = $1', [aliceEntry.id]);
      assert.equal(untouched.notes, null);
    });
  });

  describe('serviço pickQuestions', () => {
    it('prioriza o subassunto, evita questões recentes e nunca devolve gabarito', async () => {
      const { pickQuestions } = require('../server/services/questions');
      const picked = await pickQuestions({ userId: bob.user.id, topicId: content.percent.id, subtopicId: content.subtopic.id, count: 5 });
      assert.equal(picked.length, 2, 'só há duas questões ativas no assunto');
      picked.forEach(assertNoAnswerKey);

      // Bob responde q1 agora; ela sai da primeira seleção e só volta para completar a cota
      await bob.agent.post(`/api/questions/${content.q1.id}/answer`, { option_id: content.q1.correct, context: 'practice' });
      const one = await pickQuestions({ userId: bob.user.id, topicId: content.percent.id, count: 1, excludeRecentDays: 7 });
      assert.equal(one.length, 1);
      assert.equal(one[0].id, content.q2.id);

      const filled = await pickQuestions({ userId: bob.user.id, topicId: content.percent.id, count: 5, excludeRecentDays: 7 });
      assert.equal(filled.length, 2, 'completa com a recente quando faltam questões');

      const byExam = await pickQuestions({ userId: bob.user.id, examId: content.otherExam.id, count: 10, excludeRecentDays: 0 });
      assert.equal(byExam.length, 2);
    });
  });
});

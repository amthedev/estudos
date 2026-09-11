'use strict';

/**
 * Painel administrativo — questões, provas anteriores, vestibulares, simulados, redação,
 * professores, agendamentos, configurações, plataforma e uso de IA.
 *
 *   NODE_ENV=test node --test tests/admin.test.js
 *
 * Cobre as regras que não podem quebrar: nenhuma rota administrativa responde a um aluno logado,
 * a questão precisa ter exatamente uma alternativa correta, a importação valida linha a linha
 * (sem gravar as inválidas), a exportação devolve JSON válido, os critérios de redação conferem
 * a soma dos máximos, as configurações recusam valores inválidos e a saúde da plataforma responde.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const mailer = require('../server/services/mailer');

/** Conteúdo mínimo: uma prova, duas matérias, assuntos e um subassunto. */
async function seedContent(db) {
  const exam = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, has_essay, essay_max_score)
     VALUES ('enem-admin', 'ENEM Administrativo', 'ENEM', 'enem', 'INEP', true, 1000) RETURNING id`
  );
  const math = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-admin', 'Matemática', 1) RETURNING id`
  );
  const portuguese = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('portugues-admin', 'Língua Portuguesa', 2) RETURNING id`
  );
  const functions = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'funcoes', 'Funções', 1) RETURNING id`,
    [math.id]
  );
  const percentage = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 2) RETURNING id`,
    [math.id]
  );
  const reading = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'interpretacao', 'Interpretação de texto', 1) RETURNING id`,
    [portuguese.id]
  );
  const affine = await db.one(
    `INSERT INTO subtopics (topic_id, slug, name, sort_order) VALUES ($1, 'funcao-afim', 'Função afim', 1) RETURNING id`,
    [functions.id]
  );
  await db.query('INSERT INTO exam_subjects (exam_id, subject_id, weight) VALUES ($1, $2, 3)', [exam.id, math.id]);
  await db.query('INSERT INTO exam_topics (exam_id, topic_id, weight) VALUES ($1, $2, 1)', [exam.id, functions.id]);

  return {
    exam: exam.id,
    math: math.id,
    portuguese: portuguese.id,
    functions: functions.id,
    percentage: percentage.id,
    reading: reading.id,
    affine: affine.id,
  };
}

const questionPayload = (content, overrides = {}) => ({
  statement: 'Qual é a raiz da função afim f(x) = 2x - 8?',
  subject_id: content.math,
  topic_id: content.functions,
  subtopic_id: content.affine,
  difficulty: 2,
  year: 2024,
  board: 'INEP',
  resolution: 'Basta resolver 2x - 8 = 0, portanto x = 4.',
  explanation: 'A raiz é o valor de x que zera a função.',
  exam_ids: [content.exam],
  options: [
    { letter: 'A', text: 'x = -4' },
    { letter: 'B', text: 'x = 0' },
    { letter: 'C', text: 'x = 4', is_correct: true },
    { letter: 'D', text: 'x = 8' },
    { letter: 'E', text: 'x = 16' },
  ],
  ...overrides,
});

describe('Painel administrativo', () => {
  let ctx;
  let db;
  let content;
  let admin;
  let student;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    content = await seedContent(db);
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Painel' });
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Segurança
  // -------------------------------------------------------------------------
  it('aluno logado não acessa nenhuma rota do painel', async () => {
    const paths = [
      '/api/admin/questions',
      '/api/admin/questions/filters',
      '/api/admin/questions/export',
      '/api/admin/past-exams',
      '/api/admin/exams',
      '/api/admin/simulados',
      '/api/admin/essays/themes',
      '/api/admin/essays/submissions',
      '/api/admin/teachers',
      '/api/admin/bookings',
      '/api/admin/settings',
      '/api/admin/settings/integrations',
      '/api/admin/platform/health',
      '/api/admin/platform/errors',
      '/api/admin/platform/audit',
      '/api/admin/ai/usage',
    ];
    for (const path of paths) {
      const withStudent = await student.agent.get(path);
      assert.ok([401, 403].includes(withStudent.status), `${path} respondeu ${withStudent.status} a um aluno`);
      const anonymous = await ctx.request('GET', path);
      assert.ok([401, 403].includes(anonymous.status), `${path} respondeu ${anonymous.status} sem sessão`);
    }

    const write = await student.agent.post('/api/admin/questions', questionPayload(content));
    assert.ok([401, 403].includes(write.status));
    const settingsWrite = await student.agent.put('/api/admin/settings', { brand_name: 'Invasão' });
    assert.ok([401, 403].includes(settingsWrite.status));
  });

  // -------------------------------------------------------------------------
  // Questões
  // -------------------------------------------------------------------------
  it('cria, lê com gabarito, edita e exclui uma questão', async () => {
    const created = await admin.agent.post('/api/admin/questions', questionPayload(content));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.options.length, 5);
    assert.deepEqual(created.body.exam_ids, [content.exam]);

    const detail = await admin.agent.get(`/api/admin/questions/${created.body.id}`);
    assert.equal(detail.status, 200);
    const correct = detail.body.options.filter((option) => option.is_correct);
    assert.equal(correct.length, 1);
    assert.equal(correct[0].letter, 'C');
    assert.equal(detail.body.resolution, 'Basta resolver 2x - 8 = 0, portanto x = 4.');

    const updated = await admin.agent.put(`/api/admin/questions/${created.body.id}`, {
      difficulty: 3,
      board: 'VUNESP',
      options: [
        { letter: 'A', text: 'x = 4', is_correct: true },
        { letter: 'B', text: 'x = 8' },
      ],
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.difficulty, 3);
    assert.equal(updated.body.options.length, 2);

    const list = await admin.agent.get('/api/admin/questions?subject_id=' + content.math);
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);
    assert.equal(list.body.items[0].correct_letter, 'A');

    const removed = await admin.agent.del(`/api/admin/questions/${created.body.id}`);
    assert.equal(removed.status, 200);
    const gone = await admin.agent.get(`/api/admin/questions/${created.body.id}`);
    assert.equal(gone.status, 404);
  });

  it('recusa questão com duas alternativas corretas e questão sem gabarito', async () => {
    const twoCorrect = await admin.agent.post(
      '/api/admin/questions',
      questionPayload(content, {
        options: [
          { letter: 'A', text: 'x = 4', is_correct: true },
          { letter: 'B', text: 'x = 8', is_correct: true },
          { letter: 'C', text: 'x = 12' },
        ],
      })
    );
    assert.equal(twoCorrect.status, 400, JSON.stringify(twoCorrect.body));
    assert.equal(twoCorrect.body.error.code, 'validation_error');

    const noneCorrect = await admin.agent.post(
      '/api/admin/questions',
      questionPayload(content, {
        options: [
          { letter: 'A', text: 'x = 4' },
          { letter: 'B', text: 'x = 8' },
        ],
      })
    );
    assert.equal(noneCorrect.status, 400);

    const singleOption = await admin.agent.post(
      '/api/admin/questions',
      questionPayload(content, { options: [{ letter: 'A', text: 'x = 4', is_correct: true }] })
    );
    assert.equal(singleOption.status, 400);

    const wrongTopic = await admin.agent.post(
      '/api/admin/questions',
      questionPayload(content, { topic_id: content.reading })
    );
    assert.equal(wrongTopic.status, 400);
  });

  it('importa CSV validando linha a linha e não grava as linhas inválidas', async () => {
    const csv = [
      'statement;A;B;C;D;E;correct;resolution;explanation;subject_slug;topic_slug;subtopic_slug;difficulty;year;board;exams',
      'Quanto é 20% de 250 reais?;R$ 25,00;R$ 50,00;R$ uma;R$ 75,00;;B;20% de 250 = 50.;Regra de três simples.;matematica-admin;porcentagem;;1;2023;IMPORT-TESTE;enem-admin',
      'Enunciado com matéria inexistente para testar o relatório de erros;Uma;Duas;Três;;;A;;;quimica-inexistente;porcentagem;;2;2023;IMPORT-TESTE;',
      'Enunciado cujo gabarito aponta para alternativa vazia e deve falhar;Uma;Duas;;;;C;;;matematica-admin;porcentagem;;2;2023;IMPORT-TESTE;',
      'Qual é o coeficiente angular da reta y = 3x + 1?;1;2;3;4;5;C;O coeficiente angular é o número que multiplica x.;Na função afim y = ax + b, a é o coeficiente angular.;matematica-admin;funcoes;funcao-afim;2;2024;IMPORT-TESTE;enem-admin',
    ].join('\n');

    const res = await admin.agent.post('/api/admin/questions/import', { csv });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.imported, 2, JSON.stringify(res.body));
    assert.equal(res.body.errors.length, 2);
    assert.deepEqual(res.body.errors.map((error) => error.line).sort(), [3, 4]);
    for (const error of res.body.errors) {
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 5);
    }

    const stored = await db.many("SELECT statement FROM questions WHERE board = 'IMPORT-TESTE' ORDER BY statement");
    assert.equal(stored.length, 2);
    assert.ok(!stored.some((row) => row.statement.includes('matéria inexistente')));
    assert.ok(!stored.some((row) => row.statement.includes('alternativa vazia')));

    const withSubtopic = await db.one(
      "SELECT subtopic_id, difficulty, year FROM questions WHERE statement LIKE 'Qual é o coeficiente angular%'"
    );
    assert.equal(withSubtopic.subtopic_id, content.affine);
    assert.equal(withSubtopic.difficulty, 2);
    assert.equal(withSubtopic.year, 2024);
  });

  it('importa lista JSON e recusa lote sem dados', async () => {
    const res = await admin.agent.post('/api/admin/questions/import', {
      items: [
        {
          statement: 'Qual o valor de x na equação x + 7 = 12?',
          A: '3',
          B: '5',
          C: '7',
          correct: 'B',
          subject_slug: 'matematica-admin',
          topic_slug: 'porcentagem',
          board: 'IMPORT-JSON',
        },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.format, 'json');

    const empty = await admin.agent.post('/api/admin/questions/import', { csv: '   ' });
    assert.equal(empty.status, 400);
  });

  it('exporta questões em JSON válido e em CSV', async () => {
    const json = await admin.agent.get('/api/admin/questions/export?format=json&board=IMPORT-TESTE');
    assert.equal(json.status, 200);
    const parsed = JSON.parse(json.text);
    assert.ok(Array.isArray(parsed.items));
    assert.equal(parsed.items.length, 2);
    for (const item of parsed.items) {
      assert.ok(item.statement.length > 5);
      assert.ok(Array.isArray(item.options) && item.options.length >= 2);
      assert.equal(item.options.filter((option) => option.is_correct).length, 1);
      assert.ok(['A', 'B', 'C', 'D', 'E'].includes(item.correct));
    }

    const csv = await admin.agent.get('/api/admin/questions/export?format=csv&board=IMPORT-TESTE');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    const lines = csv.text.trim().split('\n');
    assert.match(lines[0], /statement;A;B;C;D;E;correct/);
    assert.equal(lines.length, 3);

    const template = await admin.agent.get('/api/admin/questions/template.csv');
    assert.equal(template.status, 200);
    assert.match(template.text, /statement;A;B;C;D;E;correct/);
  });

  // -------------------------------------------------------------------------
  // Provas anteriores
  // -------------------------------------------------------------------------
  it('mantém o cadastro de provas anteriores', async () => {
    const created = await admin.agent.post('/api/admin/past-exams', {
      exam_id: content.exam,
      year: 2023,
      day: 1,
      title: 'ENEM 2023 — 1º dia',
      board: 'INEP',
      pdf_url: 'https://exemplo.com.br/enem-2023-dia-1.pdf',
      answer_key_url: 'https://exemplo.com.br/enem-2023-gabarito.pdf',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.exam_name, 'ENEM Administrativo');

    const updated = await admin.agent.put(`/api/admin/past-exams/${created.body.id}`, { notes: 'Prova aplicada em novembro.' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.notes, 'Prova aplicada em novembro.');

    const list = await admin.agent.get(`/api/admin/past-exams?exam_id=${content.exam}&year=2023`);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.deepEqual(list.body.years, [2023]);

    const invalid = await admin.agent.post('/api/admin/past-exams', { exam_id: content.exam, year: 2023, title: 'x' });
    assert.equal(invalid.status, 400);

    const removed = await admin.agent.del(`/api/admin/past-exams/${created.body.id}`);
    assert.equal(removed.status, 200);
  });

  // -------------------------------------------------------------------------
  // Vestibulares
  // -------------------------------------------------------------------------
  it('cria vestibular com critérios vazios, aceita pesos e inclui assuntos em lote', async () => {
    const created = await admin.agent.post('/api/admin/exams', {
      name: 'Academia do Barro Branco',
      short_name: 'Barro Branco',
      track: 'barro_branco',
      board: 'VUNESP',
      has_essay: true,
      essay_max_score: 100,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const examId = created.body.id;
    assert.equal(created.body.slug, 'academia-do-barro-branco');

    // o conjunto de critérios de redação nasce junto com a prova, vazio e editável
    const criteria = await admin.agent.get(`/api/admin/essays/criteria/${examId}`);
    assert.equal(criteria.status, 200);
    assert.equal(criteria.body.exists, true);
    assert.deepEqual(criteria.body.criteria, []);

    const subjects = await admin.agent.put(`/api/admin/exams/${examId}/subjects`, {
      subjects: [
        { subject_id: content.math, weight: 2.5 },
        { subject_id: content.portuguese, weight: 1.5 },
      ],
    });
    assert.equal(subjects.status, 200, JSON.stringify(subjects.body));
    assert.equal(subjects.body.subjects.length, 2);

    const detail = await admin.agent.get(`/api/admin/exams/${examId}`);
    assert.equal(detail.status, 200);
    const math = detail.body.subjects.find((item) => item.subject_id === content.math);
    assert.equal(math.weight, 2.5);
    assert.equal(math.topics_total, 2);
    assert.equal(math.topics_in_exam, 0);

    const bulk = await admin.agent.post(`/api/admin/exams/${examId}/topics/bulk`, { subject_id: content.math, all: true });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal(bulk.body.topics_in_exam, 2);

    const topics = await admin.agent.put(`/api/admin/exams/${examId}/topics`, {
      subject_id: content.math,
      topics: [{ topic_id: content.functions, weight: 3 }],
    });
    assert.equal(topics.status, 200);
    assert.equal(topics.body.topics_total, 1);

    const afterDetail = await admin.agent.get(`/api/admin/exams/${examId}`);
    assert.equal(afterDetail.body.subjects.find((item) => item.subject_id === content.math).topics_in_exam, 1);

    const invalidTrack = await admin.agent.post('/api/admin/exams', { name: 'Prova sem trilha', track: 'inexistente' });
    assert.equal(invalidTrack.status, 400);
  });

  // -------------------------------------------------------------------------
  // Redação
  // -------------------------------------------------------------------------
  it('valida a soma dos máximos dos critérios de redação', async () => {
    const short = await admin.agent.put(`/api/admin/essays/criteria/${content.exam}`, {
      name: 'Matriz do ENEM',
      max_score: 1000,
      criteria: [
        { name: 'Competência 1', max: 200 },
        { name: 'Competência 2', max: 200 },
      ],
    });
    assert.equal(short.status, 400, JSON.stringify(short.body));
    assert.match(short.body.error.message, /soma/i);

    const ok = await admin.agent.put(`/api/admin/essays/criteria/${content.exam}`, {
      name: 'Matriz de referência do ENEM',
      max_score: 1000,
      genre: 'Texto dissertativo-argumentativo em prosa',
      min_lines: 8,
      max_lines: 30,
      instructions: 'Some as cinco competências para chegar à nota final.',
      criteria: [
        { name: 'Competência 1 — Norma-padrão', max: 200, description: 'Domínio da escrita formal.' },
        { name: 'Competência 2 — Compreensão da proposta', max: 200 },
        { name: 'Competência 3 — Seleção de argumentos', max: 200 },
        { name: 'Competência 4 — Coesão', max: 200 },
        { name: 'Competência 5 — Proposta de intervenção', max: 200, guidance: 'Exige agente, ação, meio, efeito e detalhamento.' },
      ],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.criteria.length, 5);
    assert.equal(ok.body.criteria_sum, 1000);
    assert.ok(ok.body.criteria.every((item) => typeof item.key === 'string' && item.key.length > 0));

    const reread = await admin.agent.get(`/api/admin/essays/criteria/${content.exam}`);
    assert.equal(reread.body.criteria.length, 5);
    assert.equal(reread.body.max_score, 1000);
  });

  it('cadastra temas de redação e lista as redações enviadas', async () => {
    const theme = await admin.agent.post('/api/admin/essays/themes', {
      exam_id: content.exam,
      title: 'Os desafios da mobilidade urbana nas capitais brasileiras',
      prompt_text: 'A partir dos textos motivadores, redija um texto dissertativo-argumentativo.',
      year: 2024,
    });
    assert.equal(theme.status, 201, JSON.stringify(theme.body));

    const generated = await admin.agent.post('/api/admin/essays/themes/generate', {
      exam_id: content.exam,
    });
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.generated_by_ai, true);
    assert.ok(generated.body.prompt_text);
    assert.ok(generated.body.support_texts);

    const themes = await admin.agent.get(`/api/admin/essays/themes?exam_id=${content.exam}`);
    assert.equal(themes.status, 200);
    assert.equal(themes.body.total, 2);

    const essay = await db.one(
      `INSERT INTO essays (user_id, exam_id, theme_id, theme_title, content, word_count, status, score, max_score,
                           correction, submitted_at, corrected_at)
       VALUES ($1, $2, $3, $4, 'Texto da redação enviada pela aluna para correção.', 220, 'corrected', 840, 1000,
               '{"summary":"Bom texto, com repertório pertinente."}'::jsonb, now(), now())
       RETURNING id`,
      [student.user.id, content.exam, theme.body.id, theme.body.title]
    );

    const submissions = await admin.agent.get('/api/admin/essays/submissions');
    assert.equal(submissions.status, 200);
    assert.equal(submissions.body.total, 1);
    const item = submissions.body.items[0];
    assert.equal(item.user_name, 'Aluna Painel');
    assert.equal(item.exam_short_name, 'ENEM');
    assert.equal(item.score, 840);
    assert.equal(item.status, 'corrected');

    const detail = await admin.agent.get(`/api/admin/essays/submissions/${essay.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.correction.summary, 'Bom texto, com repertório pertinente.');
    assert.ok(detail.body.content.length > 10);
    assert.equal(detail.body.theme.title, theme.body.title);

    const inUse = await admin.agent.del(`/api/admin/essays/themes/${theme.body.id}`);
    assert.equal(inUse.status, 409);
  });

  // -------------------------------------------------------------------------
  // Simulados
  // -------------------------------------------------------------------------
  it('mantém os simulados modelo', async () => {
    const created = await admin.agent.post('/api/admin/simulados', {
      name: 'Simulado de Matemática — Funções',
      type: 'subject',
      subject_id: content.math,
      duration_min: 45,
      question_count: 10,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.subject_name, 'Matemática');

    const missingRef = await admin.agent.post('/api/admin/simulados', { name: 'Simulado sem matéria', type: 'topic' });
    assert.equal(missingRef.status, 400);

    const updated = await admin.agent.put(`/api/admin/simulados/${created.body.id}`, { duration_min: 60, active: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.duration_min, 60);
    assert.equal(updated.body.active, false);

    const list = await admin.agent.get('/api/admin/simulados?status=inactive');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);

    assert.equal((await admin.agent.del(`/api/admin/simulados/${created.body.id}`)).status, 200);
  });

  // -------------------------------------------------------------------------
  // Professores e agendamentos
  // -------------------------------------------------------------------------
  it('cadastra professor com matérias e disponibilidade e confirma um agendamento', async () => {
    const teacher = await admin.agent.post('/api/admin/teachers', {
      name: 'Professor Ricardo Alves',
      email: 'ricardo@focoelite.com.br',
      hourly_price_cents: 12000,
      slot_minutes: 60,
      subject_ids: [content.math],
      availability: [
        { weekday: 1, start_time: '18:00', end_time: '21:00' },
        { weekday: 3, start_time: '19:00', end_time: '22:00' },
      ],
    });
    assert.equal(teacher.status, 201, JSON.stringify(teacher.body));
    assert.equal(teacher.body.availability.length, 2);
    assert.equal(teacher.body.subjects.length, 1);

    const badWindow = await admin.agent.put(`/api/admin/teachers/${teacher.body.id}/availability`, {
      availability: [{ weekday: 2, start_time: '20:00', end_time: '19:00' }],
    });
    assert.equal(badWindow.status, 400);

    const booking = await db.one(
      `INSERT INTO bookings (user_id, teacher_id, subject_id, starts_at, ends_at, status, price_cents, student_notes)
       VALUES ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 1 hour', 'pending', 12000, 'Preciso de ajuda com funções.')
       RETURNING id`,
      [student.user.id, teacher.body.id, content.math]
    );

    const pending = await admin.agent.get('/api/admin/bookings?status=pending');
    assert.equal(pending.status, 200);
    assert.equal(pending.body.total, 1);
    assert.equal(pending.body.items[0].user_name, 'Aluna Painel');
    assert.equal(pending.body.items[0].duration_min, 60);

    const before = mailer.outbox.length;
    const confirmed = await admin.agent.post(`/api/admin/bookings/${booking.id}/confirm`, {
      meeting_link: 'https://meet.exemplo.com.br/aula-ricardo',
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal(confirmed.body.meeting_link, 'https://meet.exemplo.com.br/aula-ricardo');
    assert.equal(mailer.outbox.length, before + 1, 'o aluno precisa ser avisado por e-mail');
    assert.equal(mailer.outbox[mailer.outbox.length - 1].to, student.user.email);

    const completed = await admin.agent.post(`/api/admin/bookings/${booking.id}/complete`, {});
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');

    const cancelAfter = await admin.agent.post(`/api/admin/bookings/${booking.id}/cancel`, { reason: 'Professor indisponível.' });
    assert.equal(cancelAfter.status, 409);

    const busy = await admin.agent.del(`/api/admin/teachers/${teacher.body.id}`);
    assert.equal(busy.status, 200, 'sem aulas futuras ativas o professor pode ser excluído');
  });

  // -------------------------------------------------------------------------
  // Configurações
  // -------------------------------------------------------------------------
  it('valida as configurações e nunca devolve a chave de API inteira', async () => {
    const badIntervals = await admin.agent.put('/api/admin/settings', { review_intervals: [1, 7] });
    assert.equal(badIntervals.status, 400, JSON.stringify(badIntervals.body));

    const outOfOrder = await admin.agent.put('/api/admin/settings', { review_intervals: [30, 7, 1] });
    assert.equal(outOfOrder.status, 400);

    const unknownKey = await admin.agent.put('/api/admin/settings', { chave_inventada: 'valor' });
    assert.equal(unknownKey.status, 400);

    const badEmail = await admin.agent.put('/api/admin/settings', { support_email: 'sem-arroba' });
    assert.equal(badEmail.status, 400);

    const badSchedule = await admin.agent.put('/api/admin/settings', { schedule_defaults: { questions_block_min: 1000 } });
    assert.equal(badSchedule.status, 400);

    const saved = await admin.agent.put('/api/admin/settings', {
      brand_name: 'Foco de Elite',
      support_email: 'suporte@focoelite.com.br',
      review_intervals: [1, 7, 30],
      private_lessons_enabled: true,
      daily_quotes: ['Disciplina transforma sonhos em realidade.', 'Disciplina hoje, aprovação amanhã.'],
      schedule_defaults: { questions_block_min: 25, review_block_min: 15, essay_weekly: true, simulado_every_days: 14 },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.brand_name, 'Foco de Elite');
    assert.deepEqual(saved.body.review_intervals, [1, 7, 30]);

    const all = await admin.agent.get('/api/admin/settings');
    assert.equal(all.status, 200);
    assert.equal(all.body.schedule_defaults.questions_block_min, 25);
    assert.equal(all.body.daily_quotes.length, 2);
    assert.equal(typeof all.body.tutor_system_prompt, 'string');

    const integrations = await admin.agent.get('/api/admin/settings/integrations');
    assert.equal(integrations.status, 200);
    for (const key of ['openrouter', 'asaas', 'payments', 'smtp']) {
      assert.ok(integrations.body[key], `faltou o status de ${key}`);
      assert.equal(typeof integrations.body[key].configured, 'boolean');
    }
    const openrouterKey = integrations.body.openrouter.key;
    assert.ok(openrouterKey === null || openrouterKey.length <= 8, 'a chave do OpenRouter precisa vir mascarada');
    assert.equal(JSON.stringify(integrations.body).includes('sk-'), false);
  });

  // -------------------------------------------------------------------------
  // Plataforma e IA
  // -------------------------------------------------------------------------
  it('responde a saúde da plataforma com banco, memória e contagens', async () => {
    const res = await admin.agent.get('/api/admin/platform/health');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.db.ok, true);
    assert.ok(typeof res.body.db.size_pretty === 'string' && res.body.db.size_pretty.length > 0);
    assert.ok(Number.isFinite(res.body.db.latency_ms));
    assert.ok(res.body.uptime >= 0);
    assert.equal(res.body.node_version, process.version);
    assert.ok(typeof res.body.app_version === 'string');
    assert.ok(res.body.memory_mb.rss > 0);
    assert.ok(res.body.counts.students >= 1);
    assert.ok(res.body.counts.questions >= 1);
  });

  it('lista auditoria com o nome do administrador e os erros registrados', async () => {
    const audit = await admin.agent.get('/api/admin/platform/audit?limit=10');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.total > 0, 'as escritas anteriores precisam estar auditadas');
    assert.equal(audit.body.items[0].admin_name, admin.user.name);
    assert.ok(audit.body.actions.includes('question.create'));

    const filtered = await admin.agent.get('/api/admin/platform/audit?action=settings.update');
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.total >= 1);

    await db.query(
      `INSERT INTO error_logs (level, message, path, method) VALUES ('error', 'Falha simulada no cadastro', '/api/admin/questions', 'POST')`
    );
    const errors = await admin.agent.get('/api/admin/platform/errors?q=simulada');
    assert.equal(errors.status, 200);
    assert.equal(errors.body.total, 1);
    assert.equal(errors.body.items[0].path, '/api/admin/questions');
  });

  it('resume o uso da IA por dia, recurso e aluno', async () => {
    await db.query('DELETE FROM ai_usage');
    for (const [feature, tokens, status] of [['tutor', 1200, 'ok'], ['tutor', 800, 'ok'], ['essay', 3000, 'error']]) {
      await db.query(
        `INSERT INTO ai_usage (user_id, feature, model, prompt_tokens, completion_tokens, total_tokens, status, latency_ms)
         VALUES ($1, $2, 'qwen/qwen3.8-flash', $3, $4, $5, $6, 900)`,
        [student.user.id, feature, Math.round(tokens * 0.6), Math.round(tokens * 0.4), tokens, status]
      );
    }

    const res = await admin.agent.get('/api/admin/ai/usage?days=7');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.days, 7);
    assert.equal(res.body.by_day.length, 7);
    assert.equal(res.body.totals.requests, 3);
    assert.equal(res.body.totals.tokens, 5000);
    assert.equal(res.body.totals.errors, 1);

    const tutor = res.body.by_feature.find((row) => row.feature === 'tutor');
    assert.equal(tutor.requests, 2);
    assert.equal(tutor.tokens, 2000);

    assert.equal(res.body.top_users.length, 1);
    assert.equal(res.body.top_users[0].user_id, student.user.id);
    assert.equal(res.body.top_users[0].tokens, 5000);

    const today = res.body.by_day[res.body.by_day.length - 1];
    assert.equal(today.requests, 3);
  });
});

'use strict';

/**
 * Remover as questões de uma prova, para ler de novo do zero.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/exam-cleanup.test.js
 *
 * Provas entraram erradas no banco (capa colada no enunciado, alternativa
 * cortada) e já chegaram aos alunos. O cliente decidiu APAGAR as questões da
 * prova e ler de novo, vendo antes o que some junto.
 *
 * O que não pode quebrar: questão cadastrada à mão da mesma prova não some;
 * questão de outra prova não some; a que perdeu o vínculo só sai com a caixa
 * marcada; simulado finalizado fica como estava; a releitura grava tudo de
 * novo em vez de reaproveitar o que foi apagado; aluno não chega perto.
 */
process.env.OPENROUTER_MOCK = '1';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

const MIGRATION_222 = path.join(__dirname, '..', 'server', 'db', 'migrations', '222_vinculo_questao_prova.sql');

/** Um pedaço de prova com `total` questões numeradas, no formato do ENEM. */
function fakeExam(total) {
  const partes = [];
  for (let i = 1; i <= total; i += 1) {
    partes.push(`QUESTÃO ${i}`);
    partes.push(
      `Um comerciante aplicou um desconto sobre o preço de um produto e precisa saber o valor final. ` +
        `Este é o enunciado da questão número ${i}, com contexto suficiente para ser respondida.`
    );
    partes.push('A  Primeira alternativa.');
    partes.push('B  Segunda alternativa.');
    partes.push('C  Terceira alternativa.');
    partes.push('D  Quarta alternativa.');
    partes.push('E  Quinta alternativa.');
    partes.push('');
  }
  return partes.join('\n');
}

/** Varre até o fim como a tela faz: dispara e acompanha pelo estado da leitura. */
async function varrerAteOFim(admin, id, { maxLotes = 30 } = {}) {
  for (let lote = 0; lote < maxLotes; lote += 1) {
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${id}/sweep`, {});
    if (disparo.status !== 200 && disparo.status !== 202) {
      throw new Error(`varredura recusada (${disparo.status}): ${JSON.stringify(disparo.body)}`);
    }
    if (disparo.body.done) break;
    let parou = false;
    for (let espera = 0; espera < 120 && !parou; espera += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const atual = await admin.agent.get(`/api/admin/exam-imports/${id}`);
      if (atual.body.status !== 'extraindo') parou = true;
    }
    if (!parou) throw new Error('a varredura não terminou a tempo');
  }
  return (await admin.agent.get(`/api/admin/exam-imports/${id}`)).body;
}

const GABARITO = '1-A 2-B 3-C 4-D 5-E 6-A';

describe('Remover as questões de uma prova para ler de novo', () => {
  let ctx;
  let db;
  let admin;
  let aluna;
  let aluno;
  let exam;
  let subject;
  let topic;
  let prova;
  let provaIrma;

  // Questões do cenário
  let lidas = []; // gravadas pela leitura do painel
  let soPorItem; // ligada à prova só por um item de leitura
  let manual; // cadastrada à mão pelo formulário, mesma prova e ano
  let semVinculo; // tem a marca da leitura, mas a leitura já foi excluída
  let daIa; // elaborada pela IA, mesma marca
  let daIrma; // do 2º dia (outra prova anterior), mesma marca

  // Simulados
  let simuladoMisto;
  let simuladoSoDaProva;
  let simuladoFinalizado;
  let modeloMisto;
  let modeloSoDaProva;
  let cobranca;

  const url = (id = prova.id) => `/api/admin/exam-imports/provas/${id}/questoes`;

  /** Questão gravada direto no banco, com duas alternativas. */
  async function questaoDireta(campos = {}) {
    const q = await db.one(
      `INSERT INTO questions (subject_id, topic_id, statement, source_exam_id, year, source,
                              generated_by_ai, past_exam_id, exam_import_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now())) RETURNING id`,
      [
        subject.id,
        topic.id,
        campos.statement || 'Enunciado de uma questão da prova, com contexto suficiente.',
        campos.source_exam_id === undefined ? exam.id : campos.source_exam_id,
        campos.year === undefined ? 2024 : campos.year,
        campos.source === undefined ? 'ENEM 2024' : campos.source,
        campos.generated_by_ai || false,
        campos.past_exam_id || null,
        campos.exam_import_id || null,
        campos.updated_at || null,
      ]
    );
    const certa = await db.one(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, 'A', 'Certa', true, 0) RETURNING id`,
      [q.id]
    );
    await db.query(
      `INSERT INTO question_options (question_id, letter, text, is_correct, sort_order)
       VALUES ($1, 'B', 'Errada', false, 1)`,
      [q.id]
    );
    return { id: q.id, optionId: certa.id };
  }

  async function existe(id) {
    return Boolean(await db.one('SELECT 1 AS ok FROM questions WHERE id = $1', [id]));
  }

  async function alternativaCerta(questionId) {
    return (await db.one('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [questionId])).id;
  }

  async function responder(user, questionId, { certo }) {
    const opcao = await alternativaCerta(questionId);
    await db.query(
      `INSERT INTO question_attempts (user_id, question_id, subject_id, topic_id, selected_option_id, is_correct, context)
       VALUES ($1, $2, $3, $4, $5, $6, 'bank')`,
      [user.id, questionId, subject.id, topic.id, opcao, certo]
    );
    if (!certo) {
      await db.query(
        `INSERT INTO error_notebook (user_id, question_id, subject_id, topic_id) VALUES ($1, $2, $3, $4)`,
        [user.id, questionId, subject.id, topic.id]
      );
    }
  }

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    aluna = (await ctx.registerStudent({ name: 'Aluna Que Respondeu' })).user;
    aluno = (await ctx.registerStudent({ name: 'Aluno Do Simulado' })).user;

    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem-limpeza', 'ENEM', 'ENEM', 'enem', 1) RETURNING id`
    );
    subject = await db.one(
      `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`
    );
    topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
      [subject.id]
    );
    await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [exam.id, topic.id]);
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [exam.id, subject.id]);

    prova = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, board, pdf_url)
       VALUES ($1, 2024, 1, 'ENEM 2024 — 1º dia', 'INEP', '/uploads/provas/enem-2024-dia-1.pdf') RETURNING id, title`,
      [exam.id]
    );
    provaIrma = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, board, pdf_url)
       VALUES ($1, 2024, 2, 'ENEM 2024 — 2º dia', 'INEP', '/uploads/provas/enem-2024-dia-2.pdf') RETURNING id, title`,
      [exam.id]
    );
  });

  after(async () => {
    await ctx.close();
  });

  it('a 222 liga as questões antigas à leitura e à prova pelos itens, sem carimbar como editadas', async () => {
    // Uma leitura do 2º dia feita antes da coluna existir: só o item sabe.
    const antiga = await db.one(
      `INSERT INTO exam_imports (past_exam_id, exam_id, title, year, status)
       VALUES ($1, $2, 'ENEM 2024 — 2º dia', 2024, 'concluida') RETURNING id`,
      [provaIrma.id, exam.id]
    );
    daIrma = await questaoDireta({ updated_at: '2024-03-01T12:00:00Z' });
    await db.query(
      `INSERT INTO exam_import_items (import_id, number, payload, status, question_id)
       VALUES ($1, 91, '{}'::jsonb, 'importada', $2)`,
      [antiga.id, daIrma.id]
    );

    // A migration roda de novo como rodaria no deploy: numa transação.
    const sql = fs.readFileSync(MIGRATION_222, 'utf8');
    await db.tx((client) => client.query(sql));

    const depois = await db.one('SELECT exam_import_id, past_exam_id, updated_at FROM questions WHERE id = $1', [
      daIrma.id,
    ]);
    assert.equal(depois.exam_import_id, antiga.id, 'a leitura de origem veio do item');
    assert.equal(depois.past_exam_id, provaIrma.id, 'a prova veio da leitura');
    assert.equal(
      new Date(depois.updated_at).toISOString(),
      '2024-03-01T12:00:00.000Z',
      'preencher o vínculo não é editar a questão'
    );

    // O gatilho de updated_at voltou a valer.
    await db.query(`UPDATE questions SET difficulty = 3 WHERE id = $1`, [daIrma.id]);
    const editada = await db.one('SELECT updated_at FROM questions WHERE id = $1', [daIrma.id]);
    assert.notEqual(new Date(editada.updated_at).toISOString(), '2024-03-01T12:00:00.000Z');
  });

  it('a leitura do painel grava em cada questão de qual leitura e de qual prova ela veio', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: prova.title,
      source_url: '/uploads/provas/enem-2024-dia-1.pdf',
      past_exam_id: prova.id,
      exam_id: exam.id,
      year: 2024,
      board: 'INEP',
      answer_key: GABARITO,
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, { chunk: fakeExam(6), done: true });
    const final = await varrerAteOFim(admin, criada.body.id);
    const importadas = final.items.filter((item) => item.status === 'importada');
    assert.ok(importadas.length >= 5, `foram ${importadas.length} para o banco`);

    const gravadas = await db.many(
      'SELECT id, exam_import_id, past_exam_id FROM questions WHERE id = ANY($1::uuid[]) ORDER BY created_at, id',
      [importadas.map((item) => item.question_id)]
    );
    assert.equal(gravadas.length, importadas.length);
    for (const questao of gravadas) {
      assert.equal(questao.exam_import_id, criada.body.id);
      assert.equal(questao.past_exam_id, prova.id);
    }
    lidas = gravadas.map((questao) => questao.id);
  });

  it('o impacto conta, em separado, o que é da prova e o que só parece ser', async () => {
    // Uma leitura antiga da mesma prova reaproveitou uma questão que não tem
    // a coluna preenchida: o item é o único elo.
    const releitura = await db.one(
      `INSERT INTO exam_imports (past_exam_id, exam_id, title, year, status)
       VALUES ($1, $2, 'Releitura antiga', 2024, 'concluida') RETURNING id`,
      [prova.id, exam.id]
    );
    soPorItem = await questaoDireta();
    await db.query(
      `INSERT INTO exam_import_items (import_id, number, payload, status, question_id)
       VALUES ($1, 45, '{}'::jsonb, 'importada', $2)`,
      [releitura.id, soPorItem.id]
    );

    // Cadastrada à mão pelo formulário, com a mesma marca de prova e ano.
    const criada = await admin.agent.post('/api/admin/questions', {
      statement: 'Questão do ENEM 2024 digitada pelo professor, com a resolução comentada.',
      options: [
        { letter: 'A', text: 'Certa', is_correct: true },
        { letter: 'B', text: 'Errada' },
      ],
      subject_id: subject.id,
      topic_id: topic.id,
      source_exam_id: exam.id,
      year: 2024,
      source: 'ENEM 2024',
      board: 'INEP',
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    manual = { id: criada.body.id };

    semVinculo = await questaoDireta();
    daIa = await questaoDireta({ generated_by_ai: true });

    // O que os alunos fizeram com essas questões.
    await responder(aluna, lidas[0], { certo: false });
    await responder(aluna, lidas[1], { certo: true });
    await responder(aluna, manual.id, { certo: true });
    await responder(aluno, soPorItem.id, { certo: true });
    await db.query(`INSERT INTO question_reports (question_id, user_id, reason) VALUES ($1, $2, 'gabarito')`, [
      lidas[1],
      aluna.id,
    ]);
    await db.query(`INSERT INTO favorites (user_id, item_type, item_id) VALUES ($1, 'question', $2)`, [
      aluna.id,
      lidas[2],
    ]);

    const respostas = {
      [lidas[0]]: await alternativaCerta(lidas[0]),
      [manual.id]: await alternativaCerta(manual.id),
    };
    simuladoMisto = await db.one(
      `INSERT INTO simulado_attempts (user_id, title, type, question_ids, answers, status)
       VALUES ($1, 'Simulado misto', 'custom', $2::uuid[], $3::jsonb, 'in_progress') RETURNING id`,
      [aluno.id, [lidas[0], manual.id, lidas[1]], JSON.stringify(respostas)]
    );
    simuladoSoDaProva = await db.one(
      `INSERT INTO simulado_attempts (user_id, title, type, question_ids, status)
       VALUES ($1, 'Só desta prova', 'custom', $2::uuid[], 'in_progress') RETURNING id`,
      [aluno.id, [lidas[3], soPorItem.id]]
    );
    cobranca = await db.one(
      `INSERT INTO coin_ledger (user_id, day, kind, action, amount, ref_type, ref_id)
       VALUES ($1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, 'debit', 'simulado', 2, 'simulado_attempt', $2)
       RETURNING id`,
      [aluno.id, simuladoSoDaProva.id]
    );
    simuladoFinalizado = await db.one(
      `INSERT INTO simulado_attempts (user_id, title, type, question_ids, status, finished_at, score, correct_count)
       VALUES ($1, 'Já entregue', 'custom', $2::uuid[], 'finished', now(), 50, 1) RETURNING id`,
      [aluna.id, [lidas[0], manual.id]]
    );
    modeloMisto = await db.one(
      `INSERT INTO simulados (name, type, question_ids) VALUES ('Modelo misto', 'custom', $1::uuid[]) RETURNING id`,
      [[lidas[0], manual.id]]
    );
    modeloSoDaProva = await db.one(
      `INSERT INTO simulados (name, type, question_ids) VALUES ('Modelo da prova', 'custom', $1::uuid[]) RETURNING id`,
      [[lidas[1], lidas[2]]]
    );

    const res = await admin.agent.get(`${url()}/impacto`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const impacto = res.body;
    assert.equal(impacto.past_exam.year, 2024);
    assert.equal(impacto.questions, lidas.length + 1, 'as da leitura e a ligada só pelo item');
    assert.equal(impacto.students, 2, 'cada aluno conta uma vez');
    assert.equal(impacto.attempts, 3, 'a resposta na questão feita à mão não entra');
    assert.equal(impacto.error_notebook, 1);
    assert.equal(impacto.in_progress_simulados, 2);
    assert.equal(impacto.in_progress_simulados_emptied, 1);
    assert.equal(impacto.simulado_models, 2);
    assert.equal(impacto.simulado_models_emptied, 1);
    assert.equal(impacto.reports, 1);
    assert.equal(impacto.favorites, 1);
    assert.equal(impacto.imports, 2, 'as duas leituras da prova saem junto');
    assert.equal(impacto.reading_now, false);

    // Só a que perdeu a leitura: a feita à mão, a da IA e a do 2º dia ficam de fora.
    assert.equal(impacto.orphans_heuristic.questions, 1);
    assert.equal(impacto.orphans_heuristic.source, 'ENEM 2024');
    assert.deepEqual(
      impacto.orphans_heuristic.siblings.map((p) => p.title),
      [provaIrma.title],
      'o aviso diz de qual outra prova elas podem ser'
    );
    assert.equal(impacto.with_orphans.questions, lidas.length + 2);
  });

  it('aluno não vê nem apaga, e quem deixou de ser administrador recebe 403', async () => {
    const espiar = await ctx.request('GET', `${url()}/impacto`, { cookie: (await ctx.registerStudent()).cookie });
    assert.ok([401, 403].includes(espiar.status), `respondeu ${espiar.status}`);

    const exAdmin = await ctx.loginAdmin({ email: 'ex-admin@teste.focoelite.com.br', name: 'Ex Admin' });
    await db.query(`UPDATE users SET role = 'student' WHERE lower(email) = 'ex-admin@teste.focoelite.com.br'`);
    const ver = await exAdmin.agent.get(`${url()}/impacto`);
    assert.equal(ver.status, 403);
    const apagar = await exAdmin.agent.del(url(), { confirm: true });
    assert.equal(apagar.status, 403);

    assert.ok(await existe(lidas[0]), 'nada foi apagado');
  });

  it('sem a confirmação explícita nada é apagado', async () => {
    for (const corpo of [{}, { confirm: false }, { confirm: 'sim' }, { confirm: true, tudo: true }]) {
      const res = await admin.agent.del(url(), corpo);
      assert.equal(res.status, 400, `aceitou ${JSON.stringify(corpo)}`);
    }
    assert.ok(await existe(lidas[0]));
  });

  it('não apaga enquanto uma leitura da prova está varrendo', async () => {
    const leitura = await db.one(`SELECT id FROM exam_imports WHERE past_exam_id = $1 AND title = $2`, [
      prova.id,
      prova.title,
    ]);
    await db.query(`UPDATE exam_imports SET status = 'extraindo' WHERE id = $1`, [leitura.id]);
    const impacto = await admin.agent.get(`${url()}/impacto`);
    assert.equal(impacto.body.reading_now, true, 'a tela avisa antes');

    const res = await admin.agent.del(url(), { confirm: true });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.ok(await existe(lidas[0]));

    await db.query(`UPDATE exam_imports SET status = 'concluida' WHERE id = $1`, [leitura.id]);
  });

  it('apaga as questões ligadas à prova, e só elas', async () => {
    const res = await admin.agent.del(url(), { confirm: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removed.questions, lidas.length + 1);
    assert.equal(res.body.orphans_removed, 0);
    assert.equal(res.body.imports_removed, 2);

    for (const id of [...lidas, soPorItem.id]) assert.equal(await existe(id), false);
    assert.ok(await existe(manual.id), 'a feita à mão fica');
    assert.ok(await existe(semVinculo.id), 'a sem vínculo só sai com a caixa marcada');
    assert.ok(await existe(daIa.id), 'a da IA fica');
    assert.ok(await existe(daIrma.id), 'a do 2º dia fica');

    // O histórico das questões apagadas some; o da que ficou, não.
    const tentativas = await db.many('SELECT question_id FROM question_attempts WHERE user_id = $1', [aluna.id]);
    assert.deepEqual(tentativas.map((t) => t.question_id), [manual.id]);
    const caderno = await db.one('SELECT count(*)::int AS n FROM error_notebook WHERE user_id = $1', [aluna.id]);
    assert.equal(caderno.n, 0);
    const avisos = await db.one('SELECT count(*)::int AS n FROM question_reports');
    assert.equal(avisos.n, 0);
    const favoritos = await db.one(`SELECT count(*)::int AS n FROM favorites WHERE item_type = 'question'`);
    assert.equal(favoritos.n, 0, 'favorito não tem chave estrangeira e ficaria órfão');

    // Simulado em andamento perde a questão e a resposta dada nela.
    const misto = await db.one('SELECT question_ids, answers, status FROM simulado_attempts WHERE id = $1', [
      simuladoMisto.id,
    ]);
    assert.deepEqual(misto.question_ids, [manual.id]);
    assert.deepEqual(Object.keys(misto.answers), [manual.id]);
    assert.equal(misto.status, 'in_progress');

    // O que ficaria vazio é encerrado e a moeda volta.
    const vazio = await db.one('SELECT question_ids, status FROM simulado_attempts WHERE id = $1', [
      simuladoSoDaProva.id,
    ]);
    assert.deepEqual(vazio.question_ids, []);
    assert.equal(vazio.status, 'abandoned');
    const estorno = await db.one('SELECT refunded_at FROM coin_ledger WHERE id = $1', [cobranca.id]);
    assert.ok(estorno.refunded_at, 'a moeda do simulado que deixou de existir voltou');

    // O finalizado fica como o aluno viu.
    const entregue = await db.one('SELECT question_ids, score FROM simulado_attempts WHERE id = $1', [
      simuladoFinalizado.id,
    ]);
    assert.deepEqual(entregue.question_ids, [lidas[0], manual.id]);
    assert.equal(Number(entregue.score), 50);

    // Modelos: o misto perde a questão e segue no ar; o que esvaziou sai do ar.
    const misto2 = await db.one('SELECT question_ids, active FROM simulados WHERE id = $1', [modeloMisto.id]);
    assert.deepEqual(misto2.question_ids, [manual.id]);
    assert.equal(misto2.active, true);
    const esvaziado = await db.one('SELECT question_ids, active FROM simulados WHERE id = $1', [modeloSoDaProva.id]);
    assert.deepEqual(esvaziado.question_ids, []);
    assert.equal(esvaziado.active, false, 'lista vazia viraria "sorteado pelos filtros"');

    // As leituras da prova saíram; a do 2º dia, não.
    const leituras = await db.one('SELECT count(*)::int AS n FROM exam_imports WHERE past_exam_id = $1', [prova.id]);
    assert.equal(leituras.n, 0);
    const doSegundoDia = await db.one('SELECT count(*)::int AS n FROM exam_imports WHERE past_exam_id = $1', [
      provaIrma.id,
    ]);
    assert.equal(doSegundoDia.n, 1);

    // A auditoria guarda os ids e as contagens.
    const registro = await db.one(
      `SELECT data FROM audit_logs WHERE action = 'past_exam.questions_remove' AND entity_id = $1`,
      [prova.id]
    );
    assert.ok(registro, 'a remoção foi auditada');
    assert.deepEqual([...registro.data.question_ids].sort(), [...lidas, soPorItem.id].sort());
    assert.deepEqual(registro.data.orphan_ids, []);
    assert.equal(registro.data.counts.questions, lidas.length + 1);
    assert.equal(registro.data.counts.students, 2);

    // A prova volta a "não lida" para quem escolhe o que ler.
    const provas = await admin.agent.get('/api/admin/exam-imports/provas');
    const linha = provas.body.items.find((p) => p.id === prova.id);
    assert.equal(linha.leituras, 0);
    assert.equal(linha.leitura_concluida, false);
    assert.equal(linha.ultima_leitura_id, null);

    const depois = await admin.agent.get(`${url()}/impacto`);
    assert.equal(depois.body.questions, 0);
    assert.equal(depois.body.imports, 0);
    assert.equal(depois.body.orphans_heuristic.questions, 1);
  });

  it('a prova pode ser lida de novo do zero, sem reaproveitar o que foi apagado', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: prova.title,
      source_url: '/uploads/provas/enem-2024-dia-1.pdf',
      past_exam_id: prova.id,
      exam_id: exam.id,
      year: 2024,
      board: 'INEP',
      answer_key: GABARITO,
    });
    assert.equal(criada.status, 201);
    await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, { chunk: fakeExam(6), done: true });
    const final = await varrerAteOFim(admin, criada.body.id);
    const importadas = final.items.filter((item) => item.status === 'importada');
    assert.equal(importadas.length, lidas.length, 'a prova inteira voltou ao banco');

    const novas = importadas.map((item) => item.question_id);
    for (const id of novas) {
      assert.ok(id, 'cada item aponta para uma questão');
      assert.ok(!lidas.includes(id), 'nada foi reaproveitado das apagadas');
      assert.ok(await existe(id));
    }
    const vinculo = await db.many('SELECT DISTINCT exam_import_id, past_exam_id FROM questions WHERE id = ANY($1::uuid[])', [
      novas,
    ]);
    assert.deepEqual(vinculo, [{ exam_import_id: criada.body.id, past_exam_id: prova.id }]);
    lidas = novas;
  });

  it('as questões sem vínculo só saem com a caixa marcada, e a feita à mão nunca', async () => {
    const impacto = await admin.agent.get(`${url()}/impacto`);
    assert.equal(impacto.body.questions, lidas.length);
    assert.equal(impacto.body.orphans_heuristic.questions, 1);

    const res = await admin.agent.del(url(), { confirm: true, include_orphans: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removed.questions, lidas.length + 1);
    assert.equal(res.body.orphans_removed, 1);
    assert.equal(res.body.include_orphans, true);

    assert.equal(await existe(semVinculo.id), false);
    for (const id of lidas) assert.equal(await existe(id), false);
    assert.ok(await existe(manual.id), 'cadastrada pelo formulário não é heurística, é do professor');
    assert.ok(await existe(daIa.id));
    assert.ok(await existe(daIrma.id));

    const registro = await db.one(
      `SELECT data FROM audit_logs WHERE action = 'past_exam.questions_remove' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [prova.id]
    );
    assert.deepEqual(registro.data.orphan_ids, [semVinculo.id]);
    assert.equal(registro.data.include_orphans, true);
  });

  it('a lista de provas anteriores diz quantas questões de cada uma estão no banco', async () => {
    const res = await admin.agent.get('/api/admin/past-exams');
    assert.equal(res.status, 200);
    const dia1 = res.body.items.find((p) => p.id === prova.id);
    const dia2 = res.body.items.find((p) => p.id === provaIrma.id);
    assert.equal(dia1.questions_count, 0);
    assert.equal(dia1.imports_count, 0);
    assert.equal(dia2.questions_count, 1);
    assert.equal(dia2.imports_count, 1);
  });

  describe('leituras sem prova anterior do mesmo vestibular e ano', () => {
    let segundoDia; // leitura viva, feita pelo arquivo sem escolher a prova
    let questoesDoSegundoDia = [];
    let reaplicacao; // leitura que perdeu a prova anterior quando ela foi excluída
    let daReaplicacao;

    before(async () => {
      // A tela deixa ler sem escolher a prova anterior: "Não — vou escolher o arquivo".
      const criada = await admin.agent.post('/api/admin/exam-imports', {
        title: 'ENEM 2024 — segundo dia',
        source_url: '/uploads/provas/enem-2024-dia-2.pdf',
        exam_id: exam.id,
        year: 2024,
        board: 'INEP',
        answer_key: GABARITO,
      });
      assert.equal(criada.status, 201, JSON.stringify(criada.body));
      await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, { chunk: fakeExam(4), done: true });
      const final = await varrerAteOFim(admin, criada.body.id);
      segundoDia = { id: criada.body.id, title: 'ENEM 2024 — segundo dia' };
      questoesDoSegundoDia = final.items.filter((item) => item.status === 'importada').map((item) => item.question_id);
      assert.ok(questoesDoSegundoDia.length >= 3, `foram ${questoesDoSegundoDia.length} para o banco`);
      const marca = await db.many(
        'SELECT DISTINCT source, year, source_exam_id, exam_import_id, past_exam_id FROM questions WHERE id = ANY($1::uuid[])',
        [questoesDoSegundoDia]
      );
      assert.deepEqual(
        marca,
        [{ source: 'ENEM 2024', year: 2024, source_exam_id: exam.id, exam_import_id: segundoDia.id, past_exam_id: null }],
        'exatamente a marca que a heurística das sem vínculo procura'
      );

      // Uma leitura de outra prova anterior, que depois foi excluída: as duas
      // colunas viram NULL (ON DELETE SET NULL) e a leitura continua viva.
      const excluida = await db.one(
        `INSERT INTO past_exams (exam_id, year, title, board) VALUES ($1, 2024, 'ENEM 2024 — reaplicação', 'INEP') RETURNING id`,
        [exam.id]
      );
      reaplicacao = await db.one(
        `INSERT INTO exam_imports (past_exam_id, exam_id, title, year, status)
         VALUES ($1, $2, 'ENEM 2024 — reaplicação', 2024, 'concluida') RETURNING id, title`,
        [excluida.id, exam.id]
      );
      daReaplicacao = await questaoDireta({ past_exam_id: excluida.id, exam_import_id: reaplicacao.id });
      await db.query(
        `INSERT INTO exam_import_items (import_id, number, payload, status, question_id)
         VALUES ($1, 7, '{}'::jsonb, 'importada', $2)`,
        [reaplicacao.id, daReaplicacao.id]
      );
      await db.query('DELETE FROM past_exams WHERE id = $1', [excluida.id]);

      await responder(aluna, questoesDoSegundoDia[0], { certo: false });
    });

    it('as questões de uma leitura viva não entram nas sem vínculo: aparecem por leitura, com o título', async () => {
      const res = await admin.agent.get(`${url()}/impacto`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.questions, 0);
      assert.equal(
        res.body.orphans_heuristic.questions,
        0,
        'antes, o 2º dia inteiro entrava na caixa que diz que a leitura foi excluída'
      );

      const soltas = res.body.unlinked_imports;
      assert.deepEqual(
        soltas.map((leitura) => leitura.title).sort(),
        [reaplicacao.title, segundoDia.title].sort()
      );
      const doSegundoDia = soltas.find((leitura) => leitura.id === segundoDia.id);
      assert.equal(doSegundoDia.questions, questoesDoSegundoDia.length);
      assert.equal(doSegundoDia.students, 1);
      assert.equal(doSegundoDia.reading_now, false);
      assert.equal(soltas.find((leitura) => leitura.id === reaplicacao.id).questions, 1);
      assert.deepEqual(
        res.body.unlinked_siblings.map((p) => p.title),
        [provaIrma.title],
        'o aviso diz de qual outra prova elas podem ser'
      );
      assert.equal(res.body.selected.questions, 0, 'nada escolhido, nada além das ligadas');
    });

    it('marcar a caixa das sem vínculo não leva as questões nem os itens da leitura viva', async () => {
      const res = await admin.agent.del(url(), { confirm: true, include_orphans: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.removed.questions, 0);
      assert.equal(res.body.orphans_removed, 0);
      assert.equal(res.body.imports_removed, 0);

      for (const id of questoesDoSegundoDia) assert.ok(await existe(id), 'a questão do 2º dia fica');
      assert.ok(await existe(daReaplicacao.id));
      const itens = await db.many('SELECT DISTINCT status FROM exam_import_items WHERE import_id = $1', [segundoDia.id]);
      assert.deepEqual(itens.map((item) => item.status), ['importada'], 'nenhum item da leitura viva virou "recusada"');
      const leitura = await db.one('SELECT 1 AS ok FROM exam_imports WHERE id = $1', [segundoDia.id]);
      assert.ok(leitura, 'a leitura do 2º dia continua');
    });

    it('a conta da escolha vem do servidor, e só a leitura escolhida sai', async () => {
      const conta = await admin.agent.get(`${url()}/impacto?import_ids=${reaplicacao.id}`);
      assert.equal(conta.status, 200, JSON.stringify(conta.body));
      assert.equal(conta.body.selected.questions, 1);
      assert.equal(conta.body.selected.imports, 1);
      assert.deepEqual(conta.body.selected.import_ids, [reaplicacao.id]);

      const duas = await admin.agent.get(`${url()}/impacto?import_ids=${reaplicacao.id}&import_ids=${segundoDia.id}`);
      assert.equal(duas.body.selected.questions, questoesDoSegundoDia.length + 1);
      assert.equal(duas.body.selected.students, 1);

      const invalida = await admin.agent.get(`${url()}/impacto?import_ids=nao-e-id`);
      assert.equal(invalida.status, 400);

      const res = await admin.agent.del(url(), { confirm: true, import_ids: [reaplicacao.id] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.removed.questions, 1);
      assert.equal(res.body.unlinked_questions_removed, 1);
      assert.equal(res.body.unlinked_imports_removed, 1);
      assert.equal(res.body.imports_removed, 1);

      assert.equal(await existe(daReaplicacao.id), false);
      assert.equal(await db.one('SELECT 1 AS ok FROM exam_imports WHERE id = $1', [reaplicacao.id]), null);
      for (const id of questoesDoSegundoDia) assert.ok(await existe(id), 'a leitura que não foi escolhida fica inteira');

      const registro = await db.one(
        `SELECT data FROM audit_logs WHERE action = 'past_exam.questions_remove' AND entity_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [prova.id]
      );
      assert.deepEqual(registro.data.unlinked_import_question_ids, [daReaplicacao.id]);
      assert.deepEqual(registro.data.unlinked_imports, [{ id: reaplicacao.id, title: reaplicacao.title }]);
    });

    it('leitura de outra prova, ou que não existe mais, não pode ser escolhida', async () => {
      const deOutra = await db.one('SELECT id FROM exam_imports WHERE past_exam_id = $1', [provaIrma.id]);
      const res = await admin.agent.del(url(), { confirm: true, import_ids: [deOutra.id] });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.ok(await existe(daIrma.id), 'a do 2º dia cadastrado continua');

      const sumida = await admin.agent.del(url(), { confirm: true, import_ids: [reaplicacao.id] });
      assert.equal(sumida.status, 409, 'a leitura já foi apagada');
      for (const id of questoesDoSegundoDia) assert.ok(await existe(id));
    });
  });

  it('questão de planilha com a prova de origem escolhida no formulário não vira "sem vínculo"', async () => {
    // Controle: a marca da leitura sem rastro de mão nenhuma é sem vínculo.
    const perdida = await questaoDireta({ statement: 'Questão de uma leitura que já foi excluída, sem vínculo.' });

    const planilha = await admin.agent.post('/api/admin/questions/import', {
      items: [
        {
          statement: 'Questão importada por planilha com a mesma origem que a leitura grava.',
          correct: 'A',
          A: 'Certa',
          B: 'Errada',
          subject_slug: 'matematica',
          topic_slug: 'porcentagem',
          year: 2024,
          source: 'ENEM 2024',
        },
      ],
    });
    assert.equal(planilha.status, 200, JSON.stringify(planilha.body));
    const [daPlanilha] = planilha.body.ids;

    // Sem a prova de origem, não tem a marca: não é candidata.
    let impacto = await admin.agent.get(`${url()}/impacto`);
    assert.equal(impacto.body.orphans_heuristic.questions, 1);

    const editada = await admin.agent.put(`/api/admin/questions/${daPlanilha}`, {
      source_exam_id: exam.id,
      source: 'ENEM 2024',
      year: 2024,
    });
    assert.equal(editada.status, 200, JSON.stringify(editada.body));
    impacto = await admin.agent.get(`${url()}/impacto`);
    assert.equal(impacto.body.orphans_heuristic.questions, 1, 'a escolhida no formulário fica de fora');

    const res = await admin.agent.del(url(), { confirm: true, include_orphans: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.orphans_removed, 1);
    assert.equal(await existe(perdida.id), false);
    assert.ok(await existe(daPlanilha), 'quem escolheu a prova de origem foi uma pessoa');
  });

  it('prova que não existe responde 404', async () => {
    const inexistente = '00000000-0000-4000-8000-000000000000';
    const ver = await admin.agent.get(`${url(inexistente)}/impacto`);
    assert.equal(ver.status, 404);
    const apagar = await admin.agent.del(url(inexistente), { confirm: true });
    assert.equal(apagar.status, 404);
  });
});

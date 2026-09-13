'use strict';

/**
 * Prova em PDF virando banco de questões.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/exam-import.test.js
 *
 * O cliente mandou as provas do ENEM, do ENEM PPL e do Barro Branco em PDF e
 * disse que cadastrar uma a uma "é osso". O texto é lido no navegador dele e
 * sobe para cá; a varredura anda em lotes.
 *
 * O que não pode quebrar: um lote nunca pode terminar no meio de uma questão
 * (a IA transcreveria metade e inventaria o resto), o gabarito oficial tem que
 * vencer a resposta que a IA deduziu, uma falha no meio não pode perder o que
 * já foi lido, e aluno nenhum chega perto disso.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');
const examImport = require('../server/services/exam-import');

/** Um pedaço de prova com `total` questões numeradas, no formato do ENEM. */
function fakeExam(total, { from = 1 } = {}) {
  const partes = [];
  for (let i = from; i < from + total; i += 1) {
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

describe('Recorte da prova em lotes', () => {
  it('encontra o número de cada questão', () => {
    const marcas = examImport.questionMarks(fakeExam(4));
    assert.deepEqual(marcas.map((m) => m.number), [1, 2, 3, 4]);
  });

  it('entende os outros formatos de numeração', () => {
    const texto = ['12.', 'Enunciado um.', '', '13)', 'Enunciado dois.', '', 'Questão 14', 'Enunciado três.'].join('\n');
    assert.deepEqual(examImport.questionMarks(texto).map((m) => m.number), [12, 13, 14]);
  });

  it('não confunde um número no meio do parágrafo com início de questão', () => {
    const texto = 'O produto custava 42. Depois do desconto, passou a custar 30 reais.';
    assert.deepEqual(examImport.questionMarks(texto), []);
  });

  it('o lote termina sempre no começo de uma questão', () => {
    // Prova grande o bastante para não caber em um lote só.
    const prova = fakeExam(90);
    assert.ok(prova.length > examImport.BATCH_CHARS, 'o cenário precisa de mais de um lote');

    let cursor = 0;
    let lotes = 0;
    let ultimo = 0;
    while (cursor < prova.length && lotes < 50) {
      const lote = examImport.nextBatch(prova, cursor);
      if (!lote) break;
      lotes += 1;
      assert.ok(lote.end > cursor, 'o cursor precisa andar, senão a varredura não termina');
      // O que sobra tem que começar em "QUESTÃO n" — é isso que garante que
      // nenhum enunciado foi partido ao meio.
      if (lote.end < prova.length) {
        const resto = prova.slice(lote.end);
        assert.match(resto.slice(0, 40), /^\s*QUEST(?:ÃO|AO)\s*\d+/i, 'o lote cortou no meio de uma questão');
        assert.ok(lote.last_number > ultimo, 'os números avançam entre os lotes');
        ultimo = lote.last_number;
      }
      cursor = lote.end;
    }
    assert.ok(lotes > 1, 'uma prova de 90 questões não pode sair em um lote só');
    assert.equal(cursor, prova.length, 'a varredura tem que chegar ao fim do texto');
  });

  it('texto sem marca de questão ainda anda, em vez de travar', () => {
    const texto = 'a'.repeat(50_000);
    const lote = examImport.nextBatch(texto, 0);
    assert.ok(lote.end > 0 && lote.end <= examImport.BATCH_MAX_CHARS);
  });

  it('no fim do texto não há mais lote', () => {
    const prova = fakeExam(2);
    assert.equal(examImport.nextBatch(prova, prova.length), null);
  });
});

describe('Gabarito oficial colado pelo administrador', () => {
  it('lê os formatos que aparecem na folha de respostas', () => {
    const { key, count } = examImport.parseAnswerKey('1-A 2) B\n3. C\n04 D\n5 = E');
    assert.equal(count, 5);
    assert.deepEqual(key, { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' });
  });

  it('ignora o que não é gabarito', () => {
    const { count } = examImport.parseAnswerKey('Gabarito oficial da prova aplicada em 2024');
    assert.equal(count, 0);
  });
});

describe('Leitura de prova pelo painel', () => {
  let ctx;
  let db;
  let admin;
  let student;
  let exam;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluno Curioso' });

    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem-imp', 'ENEM', 'ENEM', 'enem', 1) RETURNING id`
    );
    const subject = await db.one(
      `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`
    );
    const topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
      [subject.id]
    );
    await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [exam.id, topic.id]);
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [exam.id, subject.id]);
  });

  after(async () => {
    await ctx.close();
  });

  it('aluno não enxerga nem cria leitura de prova', async () => {
    const lista = await student.agent.get('/api/admin/exam-imports');
    assert.ok([401, 403].includes(lista.status), `respondeu ${lista.status}`);
    const criar = await student.agent.post('/api/admin/exam-imports', { title: 'Tentativa', source_url: '/uploads/x.pdf' });
    assert.ok([401, 403].includes(criar.status));
  });

  it('lê uma prova inteira em lotes, com o gabarito mandando na resposta', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'ENEM 2024 — dia 2',
      source_url: '/uploads/provas/enem-2024.pdf',
      exam_id: exam.id,
      year: 2024,
      board: 'INEP',
      answer_key: '1-A 2-B 3-C 4-D 5-E 6-A 7-B 8-C 9-D 10-E 11-A 12-B',
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    assert.equal(criada.body.answer_key_count, 12, 'o gabarito colado foi entendido');
    const id = criada.body.id;

    // O texto sobe como o navegador manda: em pedaços.
    const prova = fakeExam(12);
    const metade = Math.floor(prova.length / 2);
    let res = await admin.agent.post(`/api/admin/exam-imports/${id}/text`, { chunk: prova.slice(0, metade) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await admin.agent.post(`/api/admin/exam-imports/${id}/text`, { chunk: prova.slice(metade), done: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.chars_total, prova.length, 'os pedaços foram emendados na ordem');
    assert.equal(res.body.status, 'pronta');

    // Varre até o fim, um lote por requisição.
    let done = false;
    let voltas = 0;
    let ultimo = null;
    while (!done && voltas < 20) {
      voltas += 1;
      const sweep = await admin.agent.post(`/api/admin/exam-imports/${id}/sweep`, {});
      assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
      done = sweep.body.done;
      ultimo = sweep.body;
    }
    assert.equal(done, true, 'a varredura tem que terminar');
    assert.equal(ultimo.status, 'concluida');
    assert.equal(ultimo.percent, 100);

    const itens = ultimo.items;
    assert.ok(itens.length >= 10, `encontrou ${itens.length} questões`);
    const numeros = itens.map((item) => item.number);
    assert.equal(new Set(numeros).size, numeros.length, 'questão repetida entre lotes não pode entrar duas vezes');

    // O gabarito oficial venceu: a questão 1 é A, não o "C" que o modelo chuta.
    const primeira = itens.find((item) => item.number === 1);
    assert.equal(primeira.payload.correct, 'A');
    assert.equal(primeira.payload.answer_from_key, true);
  });

  it('manda as questões conferidas para o banco de questões', async () => {
    const lista = await admin.agent.get('/api/admin/exam-imports');
    const id = lista.body.items[0].id;
    const detalhe = await admin.agent.get(`/api/admin/exam-imports/${id}`);
    const pendentes = detalhe.body.items.filter((item) => item.status === 'pendente').slice(0, 5);
    assert.ok(pendentes.length >= 2);

    const res = await admin.agent.post(`/api/admin/exam-imports/${id}/import`, {
      item_ids: pendentes.map((item) => item.id),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.imported, pendentes.length, JSON.stringify(res.body.errors));
    assert.equal(res.body.failed, 0);

    // A questão entrou de verdade, com alternativas e ligada à prova de origem.
    const questao = await db.one(
      'SELECT id, statement, year, board, source_exam_id, generated_by_ai FROM questions WHERE id = $1',
      [res.body.ids[0]]
    );
    assert.ok(questao);
    assert.equal(questao.year, 2024);
    assert.equal(questao.board, 'INEP');
    assert.equal(questao.source_exam_id, exam.id, 'a questão sabe de que prova veio');
    assert.equal(questao.generated_by_ai, false, 'questão de prova não é questão elaborada por IA');

    const alternativas = await db.many('SELECT letter, is_correct FROM question_options WHERE question_id = $1', [questao.id]);
    assert.equal(alternativas.length, 5);
    assert.equal(alternativas.filter((o) => o.is_correct).length, 1);

    const vinculo = await db.one('SELECT 1 FROM question_exams WHERE question_id = $1 AND exam_id = $2', [questao.id, exam.id]);
    assert.ok(vinculo, 'a questão cai na prova de onde foi tirada');

    // Importar de novo o mesmo item não duplica.
    const repetido = await admin.agent.post(`/api/admin/exam-imports/${id}/import`, {
      item_ids: [pendentes[0].id],
    });
    assert.equal(repetido.status, 400, 'item já importado não volta para o banco');
  });

  it('o administrador corrige o gabarito de um item antes de importar', async () => {
    const lista = await admin.agent.get('/api/admin/exam-imports');
    const id = lista.body.items[0].id;
    const detalhe = await admin.agent.get(`/api/admin/exam-imports/${id}`);
    const item = detalhe.body.items.find((row) => row.status === 'pendente');

    const res = await admin.agent.patch(`/api/admin/exam-imports/${id}/items/${item.id}`, { correct: 'D' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.payload.correct, 'D');
    assert.equal(res.body.payload.answer_from_key, true, 'correção humana vale como gabarito conferido');
    assert.equal(res.body.payload.statement, item.payload.statement, 'o resto do item fica como estava');
  });

  it('aceita o texto da prova colado à mão, sem PDF', async () => {
    // "adicionar em PDF ou em qualquer formato": prova em Word, copiada de um
    // site ou digitalizada e passada por um leitor entra por aqui.
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'Prova colada à mão',
      exam_id: exam.id,
      answer_key: '1-B 2-B 3-B',
    });
    assert.equal(criada.status, 201);

    const texto = fakeExam(3);
    const res = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, {
      chunk: texto,
      done: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'pronta');
    assert.equal(res.body.chars_total, texto.length);

    // Um lote termina no começo da questão seguinte, então a última questão
    // do texto só entra na passada final — por isso a varredura vai até o fim.
    let done = false;
    let sweep = null;
    for (let volta = 0; volta < 10 && !done; volta += 1) {
      sweep = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/sweep`, {});
      assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
      done = sweep.body.done;
    }
    assert.equal(done, true);
    assert.equal(sweep.body.items.length, 3, 'as questões saem do texto colado como sairiam do PDF');
    assert.equal(sweep.body.items[0].payload.correct, 'B', 'o gabarito colado continua mandando');
  });

  it('varrer sem texto avisa, em vez de estourar', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', { title: 'Prova vazia' });
    const res = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/sweep`, {});
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /texto/i);
  });

  it('apagar a leitura leva os itens junto', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', { title: 'Para apagar' });
    const res = await admin.agent.del(`/api/admin/exam-imports/${criada.body.id}`);
    assert.equal(res.status, 200);
    const sumiu = await admin.agent.get(`/api/admin/exam-imports/${criada.body.id}`);
    assert.equal(sumiu.status, 404);
  });
});

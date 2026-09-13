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

  it('lista as provas anteriores que já têm PDF, para não reenviar o arquivo', async () => {
    // O cliente sobe a prova uma vez em "Provas anteriores"; ler as questões
    // dela não pode exigir enviar o mesmo arquivo de novo.
    const comPdf = await db.one(
      `INSERT INTO past_exams (exam_id, year, title, board, pdf_url)
       VALUES ($1, 2023, 'ENEM PPL 2023 — dia 1', 'INEP', '/uploads/provas/ppl-2023.pdf')
       RETURNING id`,
      [exam.id]
    );
    await db.query(
      `INSERT INTO past_exams (exam_id, year, title) VALUES ($1, 2022, 'Prova sem arquivo')`,
      [exam.id]
    );

    const res = await admin.agent.get('/api/admin/exam-imports/provas');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.items.map((p) => p.id);
    assert.ok(ids.includes(comPdf.id));
    assert.equal(
      res.body.items.every((p) => p.pdf_url),
      true,
      'prova sem PDF não serve para ler questões e não entra na lista'
    );
  });

  it('o PDF da prova é entregue pelo próprio domínio', async () => {
    // Buscar o arquivo direto do armazenamento seria barrado pela política de
    // segurança da página, então quem busca é o servidor.
    const prova = await db.one(
      `SELECT id FROM past_exams WHERE pdf_url IS NOT NULL ORDER BY created_at LIMIT 1`
    );
    const res = await admin.agent.get(`/api/admin/exam-imports/provas/${prova.id}/arquivo`);
    // O arquivo não existe no disco de teste: o que importa é que a rota
    // resolveu a prova e foi procurá-lo, em vez de aceitar um endereço de fora.
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /arquivo|encontrado/i);
  });

  it('prova sem PDF cadastrado não tem arquivo para ler', async () => {
    const semPdf = await db.one(`SELECT id FROM past_exams WHERE pdf_url IS NULL LIMIT 1`);
    const res = await admin.agent.get(`/api/admin/exam-imports/provas/${semPdf.id}/arquivo`);
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /não tem PDF/i);
  });

  it('aluno não baixa prova pelo caminho do painel', async () => {
    const prova = await db.one(`SELECT id FROM past_exams WHERE pdf_url IS NOT NULL LIMIT 1`);
    const res = await student.agent.get(`/api/admin/exam-imports/provas/${prova.id}/arquivo`);
    assert.ok([401, 403].includes(res.status), `respondeu ${res.status}`);
  });

  it('a leitura guarda a prova de origem', async () => {
    const prova = await db.one(`SELECT id FROM past_exams WHERE pdf_url IS NOT NULL LIMIT 1`);
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'Leitura ligada à prova',
      past_exam_id: prova.id,
      exam_id: exam.id,
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    assert.equal(criada.body.past_exam_id, prova.id);
    assert.equal(criada.body.exam_short_name, 'ENEM', 'a resposta já traz o vestibular, para a tela não dizer "sem vestibular"');

    // E a prova passa a contar quantas leituras já teve.
    const lista = await admin.agent.get('/api/admin/exam-imports/provas');
    const linha = lista.body.items.find((p) => p.id === prova.id);
    assert.ok(linha.leituras >= 1, 'o painel mostra que esta prova já foi lida');
  });

  it('varrer sem texto avisa, em vez de estourar', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', { title: 'Prova vazia' });
    const res = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/sweep`, {});
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /texto/i);
  });

  it('o caminho inteiro: prova cadastrada → leitura → banco → o aluno acha pesquisando', async () => {
    // É exatamente o que o cliente pediu: "as questões desses PDF tinha que tá
    // na parte de questões, o pessoal pesquisar lá e aparecer pra eles".
    const prova = await db.one(
      `INSERT INTO past_exams (exam_id, year, title, board, pdf_url)
       VALUES ($1, 2023, 'ENEM PPL 2023 — caminho completo', 'INEP', '/uploads/provas/ppl-completo.pdf')
       RETURNING id`,
      [exam.id]
    );

    // 1. A leitura nasce ligada à prova — sem reenviar arquivo nenhum.
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'ENEM PPL 2023',
      past_exam_id: prova.id,
      exam_id: exam.id,
      year: 2023,
      board: 'INEP',
      answer_key: '1-A 2-B 3-C 4-D',
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));

    // 2. O texto da prova entra e é varrido até o fim.
    await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, {
      chunk: fakeExam(4),
      done: true,
    });
    let done = false;
    let ultimo = null;
    for (let volta = 0; volta < 10 && !done; volta += 1) {
      ultimo = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/sweep`, {});
      assert.equal(ultimo.status, 200, JSON.stringify(ultimo.body));
      done = ultimo.body.done;
    }
    assert.equal(done, true);

    // 3. As questões conferidas vão para o banco.
    const pendentes = ultimo.body.items.filter((i) => i.status === 'pendente');
    assert.ok(pendentes.length >= 3, `encontrou ${pendentes.length} questões`);
    const importadas = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/import`, {
      item_ids: pendentes.map((i) => i.id),
    });
    assert.equal(importadas.status, 200, JSON.stringify(importadas.body));
    assert.equal(importadas.body.failed, 0, JSON.stringify(importadas.body.errors));

    // 4. O ALUNO acha a questão pesquisando — pelo assunto, pelo ano e pela prova.
    const aluno = await ctx.registerStudent({ name: 'Aluna que Pesquisa' });
    const topico = await db.one('SELECT topic_id FROM questions WHERE id = $1', [importadas.body.ids[0]]);

    const porAssunto = await aluno.agent.get(`/api/questions?topic_id=${topico.topic_id}`);
    assert.equal(porAssunto.status, 200, JSON.stringify(porAssunto.body));
    assert.ok(porAssunto.body.items.length >= 3, 'as questões da prova aparecem no banco do aluno');

    const porAno = await aluno.agent.get('/api/questions?year=2023');
    assert.ok(porAno.body.items.length >= 3, 'e aparecem filtrando pelo ano da prova');

    const porProva = await aluno.agent.get(`/api/questions?exam_id=${exam.id}`);
    assert.ok(porProva.body.items.length >= 3, 'e aparecem filtrando pela prova de origem');

    // 5. O gabarito nunca sai junto com a questão.
    for (const questao of porAssunto.body.items) {
      for (const alternativa of questao.options) {
        assert.equal(alternativa.is_correct, undefined);
      }
    }

    // 6. E dá para responder de verdade.
    const primeira = porAssunto.body.items[0];
    const correta = await db.one('SELECT id FROM question_options WHERE question_id = $1 AND is_correct', [primeira.id]);
    const resposta = await aluno.agent.post(`/api/questions/${primeira.id}/answer`, {
      option_id: correta.id,
      context: 'bank',
    });
    assert.equal(resposta.status, 201, JSON.stringify(resposta.body));
    assert.equal(resposta.body.is_correct, true);
  });

  it('questão repetida dentro do mesmo lote não entra duas vezes', async () => {
    // Achado em uma varredura de prova real: a checagem só olhava os lotes
    // anteriores, então o modelo transcrevendo a mesma questão duas vezes na
    // mesma resposta passava direto.
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'Prova com questão repetida',
      exam_id: exam.id,
    });
    // O mesmo bloco de questões duas vezes seguidas no texto.
    const bloco = fakeExam(3);
    await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/text`, {
      chunk: `${bloco}\n${bloco}`,
      done: true,
    });

    let done = false;
    let ultimo = null;
    for (let volta = 0; volta < 12 && !done; volta += 1) {
      ultimo = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/sweep`, {});
      assert.equal(ultimo.status, 200, JSON.stringify(ultimo.body));
      done = ultimo.body.done;
    }
    assert.equal(done, true);

    const numeros = ultimo.body.items.map((i) => i.number).filter((n) => n != null);
    assert.equal(new Set(numeros).size, numeros.length, `números repetidos: ${numeros.join(', ')}`);
  });

  it('questão que a IA classificou errado não fica presa', async () => {
    // O caso que trava uma prova de verdade: a IA escolhe um assunto que não
    // existe, a questão é recusada — e antes não havia como consertar, porque
    // a importação só leva o que está pendente e o item ficava em "falhou".
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      title: 'Prova com classificação errada',
      exam_id: exam.id,
    });
    await db.query(
      `INSERT INTO exam_import_items (import_id, number, payload) VALUES ($1, 1, $2::jsonb)`,
      [
        criada.body.id,
        JSON.stringify({
          number: 1,
          statement: 'Enunciado transcrito com tamanho suficiente para passar na validação.',
          A: 'a', B: 'b', C: 'c', D: 'd', E: 'e',
          correct: 'B',
          subject_slug: 'matematica',
          topic_slug: 'assunto-que-a-ia-inventou',
          difficulty: 2,
          answer_from_key: true,
        }),
      ]
    );
    const item = await db.one('SELECT id FROM exam_import_items WHERE import_id = $1', [criada.body.id]);

    // 1. A importação recusa, e diz por quê.
    const primeira = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/import`, {
      item_ids: [item.id],
    });
    assert.equal(primeira.body.failed, 1);
    assert.match(primeira.body.errors[0].message, /Assunto .* não encontrado/i);
    const falhou = await db.one('SELECT status FROM exam_import_items WHERE id = $1', [item.id]);
    assert.equal(falhou.status, 'falhou');

    // 2. O administrador escolhe o assunto certo pelo nome — a tela oferece a lista.
    const taxonomia = await admin.agent.get('/api/admin/exam-imports/taxonomia');
    assert.equal(taxonomia.status, 200);
    const materia = taxonomia.body.items.find((m) => m.slug === 'matematica');
    assert.ok(materia && materia.topics.length, 'a lista traz matéria e assuntos com nome');

    const corrigido = await admin.agent.patch(`/api/admin/exam-imports/${criada.body.id}/items/${item.id}`, {
      topic_slug: materia.topics[0].slug,
    });
    assert.equal(corrigido.status, 200, JSON.stringify(corrigido.body));
    assert.equal(corrigido.body.status, 'pendente', 'corrigir devolve a questão para a fila');
    assert.equal(corrigido.body.error_message, null);

    // 3. E agora entra no banco.
    const segunda = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/import`, {
      item_ids: [item.id],
    });
    assert.equal(segunda.body.imported, 1, JSON.stringify(segunda.body.errors));
  });

  it('trocar a matéria limpa o assunto que valia na anterior', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', { title: 'Troca de matéria' });
    await db.query(
      `INSERT INTO exam_import_items (import_id, number, payload) VALUES ($1, 9, $2::jsonb)`,
      [criada.body.id, JSON.stringify({ statement: 'Enunciado suficiente.', A: 'a', B: 'b', correct: 'A', subject_slug: 'matematica', topic_slug: 'porcentagem' })]
    );
    const item = await db.one('SELECT id FROM exam_import_items WHERE import_id = $1', [criada.body.id]);

    const res = await admin.agent.patch(`/api/admin/exam-imports/${criada.body.id}/items/${item.id}`, {
      subject_slug: 'outra-materia',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.payload.topic_slug, '', 'assunto pertence a uma matéria; o antigo não vale na nova');
  });

  it('apagar a leitura leva os itens junto', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', { title: 'Para apagar' });
    const res = await admin.agent.del(`/api/admin/exam-imports/${criada.body.id}`);
    assert.equal(res.status, 200);
    const sumiu = await admin.agent.get(`/api/admin/exam-imports/${criada.body.id}`);
    assert.equal(sumiu.status, 404);
  });
});

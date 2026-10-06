'use strict';

/**
 * Leitura de prova no servidor, de ponta a ponta (services/exam-reading.js).
 *
 *   NODE_ENV=test node --test tests/exam-reading.test.js
 *   CORPUS_PROVAS=/pasta/com/os/pdfs NODE_ENV=test node --test tests/exam-reading.test.js
 *
 * O PDF é lido no servidor, com posição: as figuras vão para a pasta
 * 'questoes', cada questão vira um item com enunciado em markdown, cinco
 * alternativas, variante de idioma e alertas, e vai sozinho ao banco SÓ o
 * item sem alerta e com a letra do gabarito oficial. O resto espera a
 * conferência no painel. A IA é a de simulação; os PDFs são montados aqui
 * (fontes padrão), e uma prova real do corpus é lida quando existe.
 *
 * O que não pode quebrar: a rota não segura a requisição, a figura não some
 * quando o armazenamento recusa por excesso, a leitura que parou no meio
 * continua sem duplicar nada, inglês e espanhol nunca viram a mesma questão,
 * e sem o leitor no servidor o caminho antigo continua de pé.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestContext } = require('./helpers');
const uploads = require('../server/services/uploads');
const ai = require('../server/services/ai');
const examReading = require('../server/services/exam-reading');

const CORPUS = process.env.CORPUS_PROVAS || path.join(__dirname, '..', 'public', 'assets', 'past-exams');
const PASTA_PROVAS = path.join(uploads.UPLOADS_DIR, 'provas');
const PASTA_QUESTOES = path.join(uploads.UPLOADS_DIR, 'questoes');

// ---------------------------------------------------------------------------
// PDF montado aqui (fontes padrão, latin1)
// ---------------------------------------------------------------------------

/**
 * PDF de várias páginas. Cada página: { linhas: [[fonte, x, y, texto]], desenho }
 * (F1 = Helvetica, F2 = Helvetica-Bold; y a partir de baixo, como no PDF).
 */
function pdfDeTeste(paginas) {
  const objetos = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const { linhas, desenho = '' } of paginas) {
    const conteudo = [
      desenho,
      ...linhas.map(([fonte, x, y, texto]) => `BT /${fonte} 10 Tf ${x} ${y} Td (${texto.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`),
    ]
      .filter(Boolean)
      .join('\n');
    objetos.push(`<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`);
    const conteudoId = objetos.length;
    objetos.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${conteudoId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`
    );
    kids.push(`${objetos.length} 0 R`);
  }
  objetos[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Uma questão do ENEM a partir de `y`: marca, enunciado, alternativas. */
function questao(n, y, enunciado, alternativas) {
  const linhas = [['F2', 40, y, `QUESTÃO ${String(n).padStart(2, '0')}`]];
  let cursor = y - 20;
  for (const l of enunciado) {
    linhas.push(['F1', 40, cursor, l]);
    cursor -= 14;
  }
  cursor -= 6;
  alternativas.forEach((a, i) => {
    linhas.push(['F2', 40, cursor, 'ABCDE'[i]]);
    linhas.push(['F1', 57, cursor, a]);
    cursor -= 15;
  });
  return { linhas, y: cursor - 20 };
}

/**
 * Três questões em duas páginas: a 1 limpa, a 2 com uma figura (retângulo
 * azul) entre o texto e a pergunta, a 3 com só quatro alternativas.
 */
function provaComFigura() {
  const q1 = questao(
    1,
    790,
    ['Um comerciante aplicou um desconto de 20% sobre o preço de um produto de R$ 50,00.', 'Qual é o novo preço do produto?'],
    ['R$ 30,00.', 'R$ 35,00.', 'R$ 40,00.', 'R$ 45,00.', 'R$ 48,00.']
  );
  const pagina1 = [...q1.linhas, ['F2', 40, q1.y, 'QUESTÃO 02'], ['F1', 40, q1.y - 20, 'Observe a figura a seguir, que mostra um retângulo colorido desenhado na página.']];
  const yFigura = q1.y - 140;
  pagina1.push(['F1', 40, yFigura - 15, 'Qual é a cor do retângulo desenhado acima?']);
  let y = yFigura - 35;
  ['Azul.', 'Verde.', 'Vermelho.', 'Amarelo.', 'Preto.'].forEach((a, i) => {
    pagina1.push(['F2', 40, y, 'ABCDE'[i]], ['F1', 57, y, a]);
    y -= 15;
  });
  const q3 = questao(3, 790, ['Assinale a alternativa que completa corretamente a frase sobre o tema proposto no texto.'], [
    'primeira.',
    'segunda.',
    'terceira.',
    'quarta.',
  ]);
  return pdfDeTeste([
    { linhas: pagina1, desenho: `0.1 0.3 0.9 rg 60 ${yFigura} 200 100 re f` },
    { linhas: q3.linhas },
  ]);
}

/** Dia 1 do ENEM em miniatura: a questão 1 em inglês e em espanhol, e a 2. */
function provaComIdiomas() {
  const linhas = [['F2', 40, 800, 'Questões de 01 a 01 (opção inglês)']];
  // (o enunciado não cita charge nem cartum: questão que cita imagem e não tem
  // figura ganha o alerta 'figura_incerta' e espera a conferência)
  const ingles = questao(1, 780, ['Read the text below and answer the question about the meaning of the last sentence.'], ['first.', 'second.', 'third.', 'fourth.', 'fifth.']);
  linhas.push(...ingles.linhas, ['F2', 40, ingles.y, 'Questões de 01 a 01 (opção espanhol)']);
  const espanhol = questao(1, ingles.y - 20, ['Lee el texto a continuación y contesta la pregunta sobre el significado de la frase.'], [
    'primera.',
    'segunda.',
    'tercera.',
    'cuarta.',
    'quinta.',
  ]);
  linhas.push(...espanhol.linhas, ['F2', 40, espanhol.y, 'Questões de 02 a 45']);
  const segunda = questao(2, espanhol.y - 20, ['Enunciado da questão dois, com contexto suficiente para ser respondida pelo aluno.'], [
    'um.',
    'dois.',
    'três.',
    'quatro.',
    'cinco.',
  ]);
  linhas.push(...segunda.linhas);
  return pdfDeTeste([{ linhas }]);
}

/** Folha de gabarito do INEP em miniatura, com as colunas de idioma. */
function gabaritoComIdiomas() {
  return pdfDeTeste([
    {
      linhas: [
        ['F2', 88, 640, 'QUESTÃO'], ['F2', 187, 650, 'GABARITO'],
        ['F2', 160, 630, 'INGLÊS'], ['F2', 219, 630, 'ESPANHOL'],
        ['F1', 108, 612, '1'], ['F2', 174, 612, 'B'], ['F2', 241, 612, 'A'],
        ['F1', 108, 600, '2'], ['F2', 207, 600, 'C'],
      ],
    },
  ]);
}

// ---------------------------------------------------------------------------

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Leitura de prova no servidor', () => {
  let ctx;
  let db;
  let admin;
  let exam;
  const arquivos = [];
  let questoesAntes = new Set();
  const saveOriginal = uploads.save;
  const availableOriginal = examReading.available;

  /** Grava o PDF onde o armazenamento local guarda as provas e devolve o caminho público. */
  function guardarPdf(buffer, nome = 'prova') {
    fs.mkdirSync(PASTA_PROVAS, { recursive: true });
    const arquivo = `teste-leitor-${nome}-${crypto.randomBytes(5).toString('hex')}.pdf`;
    fs.writeFileSync(path.join(PASTA_PROVAS, arquivo), buffer);
    arquivos.push(path.join(PASTA_PROVAS, arquivo));
    return `/uploads/provas/${arquivo}`;
  }

  /** Acompanha a leitura como a tela faz, até ela sair de 'extraindo'. */
  async function esperarLeitura(id, { limiteMs = 30_000 } = {}) {
    const inicio = Date.now();
    for (;;) {
      const atual = await admin.agent.get(`/api/admin/exam-imports/${id}`);
      if (atual.body.status !== 'extraindo') return atual.body;
      if (Date.now() - inicio > limiteMs) throw new Error(`a leitura não terminou em ${limiteMs} ms`);
      await esperar(40);
    }
  }

  async function criarLeitura(campos) {
    const criada = await admin.agent.post('/api/admin/exam-imports', { exam_id: exam.id, year: 2024, ...campos });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    return criada.body;
  }

  async function lerAteOFim(id, body = {}) {
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${id}/ler`, body);
    assert.ok([200, 202].includes(disparo.status), `${disparo.status}: ${JSON.stringify(disparo.body)}`);
    return esperarLeitura(id);
  }

  const itemDe = (leitura, number, variant = null) =>
    leitura.items.find((i) => i.number === number && (i.variant || null) === variant);

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem-leitor', 'ENEM', 'ENEM', 'enem', 1) RETURNING id`
    );
    const subject = await db.one(`INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica', 'Matemática', 1) RETURNING id`);
    const topic = await db.one(
      `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
      [subject.id]
    );
    await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [exam.id, topic.id]);
    await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [exam.id, subject.id]);
    questoesAntes = new Set(fs.existsSync(PASTA_QUESTOES) ? fs.readdirSync(PASTA_QUESTOES) : []);
  });

  afterEach(() => {
    uploads.save = saveOriginal;
    examReading.available = availableOriginal;
    examReading.setReaderForTests(null);
    ai.setClientForTests(null);
  });

  after(async () => {
    for (const arquivo of arquivos) fs.rmSync(arquivo, { force: true });
    if (fs.existsSync(PASTA_QUESTOES)) {
      for (const nome of fs.readdirSync(PASTA_QUESTOES)) {
        if (!questoesAntes.has(nome)) fs.rmSync(path.join(PASTA_QUESTOES, nome), { force: true });
      }
    }
    await ctx.close();
  });

  it('o painel sabe que o leitor do servidor está disponível', async () => {
    const res = await admin.agent.get('/api/admin/exam-imports/leitor');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
  });

  it('lê no servidor: responde na hora, figura na pasta questoes, só a questão limpa vai ao banco', async () => {
    // Um leitor lento de propósito: a rota não pode esperar por ele.
    const { readExam } = require('../server/services/exam-reader');
    examReading.setReaderForTests(async (buffer, opts) => {
      await esperar(800);
      return readExam(buffer, opts);
    });
    const leitura = await criarLeitura({ title: 'ENEM 2024 — com figura', source_url: guardarPdf(provaComFigura()), answer_key: '1-C 2-A 3-B' });

    const t0 = Date.now();
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    const ms = Date.now() - t0;
    assert.equal(disparo.status, 202, JSON.stringify(disparo.body));
    assert.equal(disparo.body.running, true);
    assert.equal(disparo.body.status, 'extraindo');
    assert.equal(disparo.body.engine, 'leitor');
    assert.ok(ms < 700, `a resposta levou ${ms} ms; ela não pode esperar a leitura`);

    const final = await esperarLeitura(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.percent, 100);
    assert.equal(final.found_count, 3);
    assert.equal(final.read_report.questions, 3);
    assert.equal(final.items.length, 3);

    const [q1, q2, q3] = [1, 2, 3].map((n) => itemDe(final, n));
    // Sem alerta e com gabarito oficial: no banco sem ninguém clicar.
    assert.equal(q1.status, 'importada');
    assert.equal(q2.status, 'importada');
    assert.equal(q2.payload.correct, 'A');
    assert.equal(q2.payload.answer_from_key, true);
    // Faltou alternativa: espera a conferência, mesmo com gabarito.
    assert.equal(q3.status, 'pendente');
    assert.deepEqual(q3.payload.alerts, ['alternativas_incompletas']);
    assert.equal(q3.payload.E, '');

    // A figura está no enunciado, na posição dela, e o arquivo existe.
    const figura = /!\[Figura\]\((\/uploads\/questoes\/[a-f0-9]+\.png)#w=(\d+)\)/.exec(q2.payload.statement);
    assert.ok(figura, q2.payload.statement);
    assert.match(q2.payload.statement, /^Observe a figura a seguir[^\n]*\n\n!\[Figura\]\([^)]+\)\n\nQual é a cor do retângulo desenhado acima\?$/);
    assert.equal(q2.payload.image_url, null, 'a figura vai no markdown, não em image_url (apareceria duas vezes)');
    const png = fs.readFileSync(path.join(uploads.UPLOADS_DIR, figura[1].replace('/uploads/', '')));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(q2.payload.figures[0].url, `${figura[1]}#w=${figura[2]}`);
    assert.doesNotMatch(JSON.stringify(final.items), /figura:\d/, 'nenhum marcador do leitor sobrou');

    // E a questão do aluno é a mesma coisa.
    const noBanco = await db.one('SELECT statement, image_url, source FROM questions WHERE id = $1', [q2.question_id]);
    assert.equal(noBanco.statement, q2.payload.statement);
    assert.equal(noBanco.image_url, null);
    assert.equal(noBanco.source, 'ENEM 2024');
  });

  it('inglês e espanhol: cada um com a sua letra, e nunca deduplicados um com o outro', async () => {
    const pdf = guardarPdf(provaComIdiomas(), 'idiomas');
    const chave = 'QUESTÃO GABARITO\nINGLÊS ESPANHOL\n1 B A\n2 C';
    const primeira = await criarLeitura({ title: 'ENEM 2024 — dia 1', source_url: pdf, answer_key: chave });
    assert.equal(primeira.answer_key_count, 3, 'o gabarito colado trouxe a letra do espanhol');
    const final = await lerAteOFim(primeira.id);
    assert.equal(final.status, 'concluida', final.error_message);

    const ingles = itemDe(final, 1, 'ingles');
    const espanhol = itemDe(final, 1, 'espanhol');
    const segunda = itemDe(final, 2);
    assert.ok(ingles && espanhol && segunda, JSON.stringify(final.items.map((i) => [i.number, i.variant])));
    assert.equal(ingles.payload.correct, 'B');
    assert.equal(espanhol.payload.correct, 'A', 'a de espanhol não herda a letra da de inglês');
    assert.equal(espanhol.payload.source, 'ENEM 2024 (Espanhol)');
    assert.match(espanhol.payload.statement, /^Lee el texto/);
    for (const item of [ingles, espanhol, segunda]) assert.equal(item.status, 'importada', `${item.number} ${item.variant}`);
    assert.notEqual(ingles.question_id, espanhol.question_id, 'são duas questões no banco');

    // Ler de novo a mesma prova reaproveita cada uma — pela variante.
    const antes = await db.one('SELECT count(*)::int AS n FROM questions');
    const releitura = await criarLeitura({ title: 'ENEM 2024 — dia 1', source_url: pdf, answer_key: chave });
    const final2 = await lerAteOFim(releitura.id);
    const depois = await db.one('SELECT count(*)::int AS n FROM questions');
    assert.equal(depois.n, antes.n, 'nenhuma questão duplicada');
    assert.equal(itemDe(final2, 1, 'ingles').question_id, ingles.question_id);
    assert.equal(itemDe(final2, 1, 'espanhol').question_id, espanhol.question_id);
  });

  it('prova anterior: o servidor lê o PDF da prova e o do gabarito, e a prova aparece como lida', async () => {
    const prova = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, pdf_url, answer_key_url)
       VALUES ($1, 2023, 1, 'ENEM 2023 — 1º dia (teste)', $2, $3) RETURNING id`,
      [exam.id, guardarPdf(provaComIdiomas(), 'anterior'), guardarPdf(gabaritoComIdiomas(), 'gabarito')]
    );
    const leitura = await criarLeitura({ title: 'ENEM 2023 — 1º dia (teste)', past_exam_id: prova.id, year: 2023 });
    assert.equal(leitura.answer_key_count, 0);

    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.answer_key_count, 3, 'o gabarito em PDF foi lido no servidor');
    assert.equal(itemDe(final, 1, 'espanhol').payload.correct, 'A');
    assert.equal(itemDe(final, 1, 'ingles').payload.correct, 'B');
    assert.ok(final.items.every((i) => i.status === 'importada'));

    const provas = await admin.agent.get('/api/admin/exam-imports/provas');
    const linha = provas.body.items.find((p) => p.id === prova.id);
    assert.equal(linha.leitura_concluida, true);
    assert.equal(linha.ultima_leitura_percent, 100);
  });

  it('sem gabarito, tudo espera a conferência; o gabarito colado depois reconcilia pela variante', async () => {
    const leitura = await criarLeitura({ title: 'Sem gabarito', source_url: guardarPdf(provaComIdiomas(), 'sem-gabarito'), year: 2019 });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    for (const item of final.items) {
      assert.equal(item.status, 'pendente');
      assert.ok(item.payload.alerts.includes('sem_gabarito'));
      assert.equal(item.payload.answer_from_key, false);
    }
    assert.equal(final.counts.com_alerta, 3);

    const res = await admin.agent.put(`/api/admin/exam-imports/${leitura.id}/answer-key`, {
      answer_key: 'INGLÊS ESPANHOL\n1 B A\n2 C',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reconciled, 3);
    assert.equal(res.body.imported_now, 3, 'sem outro alerta, vão ao banco');
    const depois = await admin.agent.get(`/api/admin/exam-imports/${leitura.id}`);
    assert.equal(itemDe(depois.body, 1, 'espanhol').payload.correct, 'A');
    assert.deepEqual(itemDe(depois.body, 1, 'espanhol').payload.alerts, []);
  });

  it('conferência: editar texto e figura, aprovar e descartar', async () => {
    const leitura = await criarLeitura({ title: 'Conferência', source_url: guardarPdf(provaComFigura(), 'conferencia'), answer_key: '1-C 2-A 3-B' });
    const final = await lerAteOFim(leitura.id);
    const q3 = itemDe(final, 3);
    const url = `/api/admin/exam-imports/${leitura.id}/items/${q3.id}`;

    // Figura enviada pelo painel (/uploads/...) ou do Blob: os dois valem.
    let res = await admin.agent.patch(url, {
      statement: 'Assinale a alternativa que completa a frase.\n\n![Figura](/uploads/questoes/abc123.png#w=200)',
      E: '![Alternativa E](https://public-blob.squarecloud.dev/abc/questoes/alt_e.png)',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.payload.alerts, [], 'completou a alternativa: o alerta sai');
    assert.match(res.body.payload.E, /Alternativa E/);

    res = await admin.agent.patch(url, { image_url: '/uploads/questoes/abc123.png' });
    assert.equal(res.status, 200, 'image_url aceita caminho interno');

    for (const ruim of ['javascript:alert(1)', 'data:image/png;base64,AAAA']) {
      res = await admin.agent.patch(url, { statement: `Enunciado com figura ruim.\n\n![Figura](${ruim})` });
      assert.equal(res.status, 400, ruim);
    }
    res = await admin.agent.patch(url, { A: 'x'.repeat(7000) });
    assert.equal(res.status, 400);

    // Tirar a letra E de novo devolve o alerta.
    res = await admin.agent.patch(url, { E: '' });
    assert.ok(res.body.payload.alerts.includes('alternativas_incompletas'));
    res = await admin.agent.patch(url, { E: 'quinta.' });
    assert.deepEqual(res.body.payload.alerts, []);

    // Aprovar: vai ao banco com o que foi editado.
    const aprovar = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/import`, { item_ids: [q3.id] });
    assert.equal(aprovar.status, 200, JSON.stringify(aprovar.body));
    assert.equal(aprovar.body.imported, 1);
    const item = await db.one('SELECT status, question_id FROM exam_import_items WHERE id = $1', [q3.id]);
    assert.equal(item.status, 'importada');
    const opcoes = await db.many('SELECT letter, text, is_correct FROM question_options WHERE question_id = $1 ORDER BY letter', [item.question_id]);
    assert.equal(opcoes.length, 5);
    assert.equal(opcoes.find((o) => o.is_correct).letter, 'B');
    const questao3 = await db.one('SELECT statement FROM questions WHERE id = $1', [item.question_id]);
    assert.match(questao3.statement, /!\[Figura\]\(\/uploads\/questoes\/abc123\.png#w=200\)/);

    // Descartar outra (reabre a importada? não: só pendente) — cria uma nova para descartar.
    const outra = await criarLeitura({ title: 'Descarte', source_url: guardarPdf(provaComFigura(), 'descarte') });
    const lida = await lerAteOFim(outra.id);
    const pendente = lida.items.find((i) => i.status === 'pendente');
    res = await admin.agent.patch(`/api/admin/exam-imports/${outra.id}/items/${pendente.id}`, { status: 'recusada' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'recusada');
  });

  it('figura: pausa e nova tentativa quando o armazenamento recusa por excesso (429)', async () => {
    let chamadas = 0;
    uploads.save = async (...args) => {
      chamadas += 1;
      if (chamadas <= 2) {
        const err = new Error('Muitos envios ao mesmo tempo.');
        err.status = 429;
        err.code = 'RATE_LIMIT';
        throw err;
      }
      return saveOriginal(...args);
    };
    const leitura = await criarLeitura({ title: 'Recusa 429', source_url: guardarPdf(provaComFigura(), '429'), answer_key: '1-C 2-A 3-B' });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(chamadas, 3, 'duas recusas, e na terceira a figura subiu');
    assert.match(itemDe(final, 2).payload.statement, /\/uploads\/questoes\//);
  });

  it('armazenamento fora do ar: a leitura para sem perder nada e continua de onde parou', async () => {
    uploads.save = async () => {
      const err = new Error('O armazenamento não respondeu.');
      err.status = 503;
      throw err;
    };
    const leitura = await criarLeitura({ title: 'Blob fora', source_url: guardarPdf(provaComFigura(), 'blob-fora'), answer_key: '1-C 2-A 3-B' });
    const parada = await lerAteOFim(leitura.id);
    assert.equal(parada.status, 'pronta');
    assert.match(parada.error_message, /figuras/);
    assert.ok(parada.items.length < 3, 'a questão da figura não entrou sem a figura');

    uploads.save = saveOriginal;
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    const chaves = final.items.map((i) => `${i.number}|${i.variant || ''}`);
    assert.deepEqual(chaves.sort(), ['1|', '2|', '3|'], 'nada duplicado na retomada');
    assert.equal(itemDe(final, 1).status, 'importada');
    assert.equal(itemDe(final, 2).status, 'importada');
  });

  it('IA fora do ar: a leitura para e continua depois, sem duplicar', async () => {
    ai.setClientForTests({
      chat: {
        completions: {
          async create() {
            const err = new Error('provedor fora do ar');
            err.status = 503;
            throw err;
          },
        },
      },
    });
    const leitura = await criarLeitura({ title: 'IA fora', source_url: guardarPdf(provaComFigura(), 'ia-fora'), answer_key: '1-C 2-A 3-B' });
    const parada = await lerAteOFim(leitura.id);
    assert.equal(parada.status, 'pronta');
    assert.ok(parada.error_message);
    assert.equal(parada.items.length, 0);

    ai.setClientForTests(null);
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.items.length, 3);
  });

  it('dois cliques seguidos não leem a mesma prova duas vezes', async () => {
    const leitura = await criarLeitura({ title: 'Clique duplo', source_url: guardarPdf(provaComFigura(), 'duplo'), answer_key: '1-C 2-A 3-B' });
    const [a, b] = await Promise.all([
      admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {}),
      admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {}),
    ]);
    assert.ok([202, 409].includes(a.status) && [202, 409].includes(b.status), `${a.status} ${b.status}`);
    const final = await esperarLeitura(leitura.id);
    assert.equal(final.items.length, 3);
    const lida = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    assert.equal(lida.status, 200, 'leitura concluída não é lida (nem paga) de novo');
    assert.equal(lida.body.done, true);
  });

  it('leitura parada (o processo morreu no meio) é destravada e continua', async () => {
    const leitura = await criarLeitura({ title: 'Parada', source_url: guardarPdf(provaComFigura(), 'parada'), answer_key: '1-C 2-A 3-B' });
    // O trigger de updated_at regrava "agora": desligado só para simular o órfão.
    await db.query('ALTER TABLE exam_imports DISABLE TRIGGER exam_imports_updated');
    try {
      await db.query(
        `UPDATE exam_imports SET status = 'extraindo', engine = 'leitor', stage = 'classificando',
                updated_at = now() - interval '10 minutes' WHERE id = $1`,
        [leitura.id]
      );
    } finally {
      await db.query('ALTER TABLE exam_imports ENABLE TRIGGER exam_imports_updated');
    }
    const visto = await admin.agent.get(`/api/admin/exam-imports/${leitura.id}`);
    assert.equal(visto.body.status, 'pronta', 'a tela não fica "lendo" para sempre');
    assert.match(visto.body.error_message, /Continue de onde parou/);
    assert.equal(visto.body.stage, null);

    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.items.length, 3);
  });

  it('leitura em andamento de verdade não é destravada', async () => {
    const leitura = await criarLeitura({ title: 'Em andamento', source_url: guardarPdf(provaComFigura(), 'andamento') });
    await db.query(`UPDATE exam_imports SET status = 'extraindo', engine = 'leitor' WHERE id = $1`, [leitura.id]);
    const visto = await admin.agent.get(`/api/admin/exam-imports/${leitura.id}`);
    assert.equal(visto.body.status, 'extraindo');
    const outra = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    assert.equal(outra.status, 409);
    await db.query(`UPDATE exam_imports SET status = 'pronta' WHERE id = $1`, [leitura.id]);
  });

  it('PDF sem questões: a leitura falha explicando o que fazer', async () => {
    const vazio = pdfDeTeste([{ linhas: [['F1', 40, 780, 'Este arquivo é só uma página de instruções, sem questão nenhuma.']] }]);
    const leitura = await criarLeitura({ title: 'Sem questões', source_url: guardarPdf(vazio, 'vazio') });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'falhou');
    assert.match(final.error_message, /Nenhuma questão/);
  });

  it('sem PDF nenhum, a rota diz o que falta', async () => {
    const leitura = await criarLeitura({ title: 'Sem arquivo' });
    const res = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /Envie o PDF/);
  });

  it('plano B: sem o leitor no servidor, a rota avisa e o caminho antigo continua', async () => {
    examReading.available = async () => ({ ok: false, message: 'A leitura de provas no servidor não está disponível neste ambiente.' });
    const status = await admin.agent.get('/api/admin/exam-imports/leitor');
    assert.equal(status.body.available, false);

    const leitura = await criarLeitura({ title: 'Plano B', source_url: guardarPdf(provaComFigura(), 'plano-b'), answer_key: '1-C 2-A' });
    const res = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'leitor_indisponivel');

    // O texto extraído no navegador sobe e é varrido como sempre.
    const texto = [
      'QUESTÃO 1',
      'Um comerciante aplicou um desconto sobre o preço de um produto e precisa saber o valor final.',
      'A  R$ 30,00.',
      'B  R$ 35,00.',
      'C  R$ 40,00.',
      'D  R$ 45,00.',
      'E  R$ 48,00.',
      '',
    ].join('\n');
    const enviado = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/text`, { chunk: texto, done: true });
    assert.equal(enviado.status, 200);
    assert.equal(enviado.body.engine, 'texto');
    await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/sweep`, {});
    let atual;
    for (let i = 0; i < 200; i += 1) {
      atual = (await admin.agent.get(`/api/admin/exam-imports/${leitura.id}`)).body;
      if (atual.status !== 'extraindo') break;
      await esperar(25);
    }
    assert.equal(atual.found_count, 1);
  });

  /**
   * Resultado do leitor para uma prova da VUNESP (ou do ENEM): a 39 em inglês
   * e em espanhol, e a 40. `answerKey`: o gabarito que veio no fim do PDF.
   */
  function provaComLinguas({ kind = 'vunesp', answerKey = null } = {}) {
    const questao = (number, variant, enunciado) => ({
      number,
      variant,
      statement_md: enunciado,
      alternatives: ['A', 'B', 'C', 'D', 'E'].map((letter) => ({ letter, text_md: `${enunciado.slice(0, 18)} — opção ${letter}.` })),
      figures: [],
      alerts: [],
      source_pages: [13],
      regions: [],
    });
    return async () => ({
      pages: 29,
      kind,
      discarded: [],
      decode: [],
      booklet_type: null,
      answer_key: answerKey,
      questions: [
        questao(39, 'ingles', 'According to the text, road safety education should start early in life because'),
        questao(39, 'espanhol', 'Según el texto, la educación vial debe empezar temprano en la vida porque'),
        questao(40, null, 'Um capital de R$ 1.000,00 aplicado a juros simples de 2% ao mês rende, em um ano,'),
      ],
    });
  }

  it('gabarito no fim do PDF da prova, uma letra por número (VUNESP): o espanhol fica com a letra oficial', async () => {
    examReading.setReaderForTests(provaComLinguas({ answerKey: { key: { 39: 'B', 40: 'D' }, count: 2, sharedLanguages: true } }));
    const leitura = await criarLeitura({ title: 'Barro Branco (teste)', source_url: guardarPdf(provaComIdiomas(), 'vunesp-gabarito'), year: 2022 });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.answer_key_count, 3, 'a 39 de espanhol ganhou a mesma letra');
    const espanhol = itemDe(final, 39, 'espanhol');
    assert.equal(espanhol.payload.correct, 'B');
    assert.equal(espanhol.payload.answer_from_key, true);
    assert.ok(!espanhol.payload.alerts.includes('sem_gabarito'), espanhol.payload.alerts.join());
    assert.equal(itemDe(final, 39, 'ingles').payload.correct, 'B');
    assert.equal(itemDe(final, 40).payload.correct, 'D');
  });

  it('no ENEM a letra do inglês nunca vale para o espanhol, nem com folha de letra única', async () => {
    examReading.setReaderForTests(provaComLinguas({ kind: 'enem', answerKey: { key: { 39: 'B', 40: 'D' }, count: 2, sharedLanguages: true } }));
    const leitura = await criarLeitura({ title: 'ENEM (teste de idioma)', source_url: guardarPdf(provaComIdiomas(), 'enem-unica'), year: 2021 });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.answer_key_count, 2);
    const espanhol = itemDe(final, 39, 'espanhol');
    assert.ok(espanhol.payload.alerts.includes('sem_gabarito'));
    assert.equal(espanhol.payload.answer_from_key, false);
  });

  it('gabarito da VUNESP colado depois da leitura reconcilia a questão de espanhol também', async () => {
    examReading.setReaderForTests(provaComLinguas());
    const leitura = await criarLeitura({ title: 'Barro Branco sem gabarito', source_url: guardarPdf(provaComIdiomas(), 'vunesp-colado'), year: 2022 });
    const final = await lerAteOFim(leitura.id);
    assert.equal(final.status, 'concluida', final.error_message);
    assert.ok(itemDe(final, 39, 'espanhol').payload.alerts.includes('sem_gabarito'));
    const res = await admin.agent.put(`/api/admin/exam-imports/${leitura.id}/answer-key`, { answer_key: '39 - B 40 - D' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reconciled, 3);
    const depois = (await admin.agent.get(`/api/admin/exam-imports/${leitura.id}`)).body;
    assert.equal(itemDe(depois, 39, 'espanhol').payload.correct, 'B');
    assert.ok(!itemDe(depois, 39, 'espanhol').payload.alerts.includes('sem_gabarito'));
  });

  // -------------------------------------------------------------------------
  // Prova real do corpus
  // -------------------------------------------------------------------------
  const PROVA = path.join(CORPUS, 'enem-2023-dia-1.pdf');
  const GABARITO = path.join(CORPUS, 'enem-2023-gabarito-dia-1.pdf');
  const temCorpus = fs.existsSync(PROVA) && fs.existsSync(GABARITO);

  it('ENEM 2023, dia 1, de verdade: 95 itens, figuras gravadas, só os limpos no banco', { skip: temCorpus ? false : 'PDF fora do corpus', timeout: 180_000 }, async () => {
    const prova = await db.one(
      `INSERT INTO past_exams (exam_id, year, day, title, pdf_url, answer_key_url)
       VALUES ($1, 2023, 1, 'ENEM 2023 — 1º dia', $2, $3) RETURNING id`,
      [exam.id, guardarPdf(fs.readFileSync(PROVA), 'enem2023d1'), guardarPdf(fs.readFileSync(GABARITO), 'enem2023g1')]
    );
    const leitura = await criarLeitura({ title: 'ENEM 2023 — 1º dia', past_exam_id: prova.id, year: 2023 });
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/ler`, {});
    assert.equal(disparo.status, 202);
    const final = await esperarLeitura(leitura.id, { limiteMs: 170_000 });
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(final.answer_key_count, 95);
    assert.equal(final.items.length, 95);
    assert.equal(final.items.filter((i) => i.variant === 'espanhol').length, 5);
    assert.equal(final.items.filter((i) => i.variant === 'ingles').length, 5);

    for (const item of final.items) {
      const p = item.payload;
      const limpo = !p.alerts.length;
      assert.equal(item.status, limpo ? 'importada' : 'pendente', `${item.number} ${item.variant || ''}: ${p.alerts.join(',')}`);
      assert.doesNotMatch(`${p.statement}\n${p.A}\n${p.B}\n${p.C}\n${p.D}\n${p.E}`, /figura:\d|QUESTÃO\s*\d|CADERNO|\*[A-Z0-9]{6,}\*/);
      for (const f of p.figures) {
        assert.ok(f.url, `${item.number}: figura sem endereço`);
        assert.ok(fs.existsSync(path.join(uploads.UPLOADS_DIR, f.url.split('#')[0].replace('/uploads/', ''))), f.url);
      }
    }
    // Espanhol com a letra do espanhol (folha do INEP: 1 B A, 4 D E).
    assert.equal(itemDe(final, 1, 'ingles').payload.correct, 'B');
    assert.equal(itemDe(final, 1, 'espanhol').payload.correct, 'A');
    assert.equal(itemDe(final, 4, 'espanhol').payload.correct, 'E');
    const comFigura = final.items.filter((i) => i.payload.figures.length);
    assert.ok(comFigura.length >= 10, `${comFigura.length} questões com figura`);
    const noBanco = final.items.filter((i) => i.status === 'importada').length;
    assert.equal(final.imported_count, noBanco);
  });
});

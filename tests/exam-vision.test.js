'use strict';

/**
 * Leitura de questão pela imagem — o reforço opcional da leitura de provas
 * (services/exam-vision.js), desligado por padrão.
 *
 *   NODE_ENV=test node --test --test-concurrency=1 tests/exam-vision.test.js
 *   CORPUS_PROVAS=/pasta/com/os/pdfs NODE_ENV=test node --test tests/exam-vision.test.js
 *
 * O que não pode quebrar: desligada, nenhuma imagem vai à IA; ligada, só a
 * questão com alerta de texto ilegível ou de alternativa faltando vai, com a
 * imagem da região dela; resposta boa troca o texto e tira o alerta, resposta
 * ruim (ou IA fora do ar) mantém o alerta; a figura que a questão tinha não
 * some; o base64 da imagem não conta como texto na cota de tokens; e o script
 * de medição explica o que fazer quando não há chave. A IA é a de simulação.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createTestContext } = require('./helpers');
const settings = require('../server/services/settings');
const seedSettings = require('../server/db/seed/data/settings');
const uploads = require('../server/services/uploads');
const ai = require('../server/services/ai');
const visao = require('../server/services/exam-vision');
const { readExam } = require('../server/services/exam-reader');

const RAIZ = path.join(__dirname, '..');
const CORPUS = process.env.CORPUS_PROVAS || path.join(RAIZ, 'public', 'assets', 'past-exams');
const PASTA_PROVAS = path.join(uploads.UPLOADS_DIR, 'provas');
const PASTA_QUESTOES = path.join(uploads.UPLOADS_DIR, 'questoes');

// ---------------------------------------------------------------------------
// PDF montado aqui (fontes padrão, latin1) — o mesmo formato de
// tests/exam-reading.test.js
// ---------------------------------------------------------------------------

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
 * Três questões: a 1 limpa, a 2 com uma figura (retângulo azul) e a 3 com só
 * quatro alternativas — o alerta 'alternativas_incompletas' que a visão lê.
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

/** PNG de verdade, pequeno (1×1), para as questões montadas à mão. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64'
);

/** Questão como o leitor devolve, com a imagem da região. */
function questaoLida(campos = {}) {
  return {
    number: 7,
    variant: null,
    statement_md: 'Ç\u0003ÿ\u0002 texto \u0001\u0004 embaralhado',
    alternatives: ['A', 'B', 'C', 'D', 'E'].map((letter) => ({ letter, text_md: `alternativa ${letter.toLowerCase()}` })),
    figures: [],
    alerts: ['texto_ilegivel'],
    source_pages: [3],
    regions: [{ page: 3, x: 0, y: 90, w: 300, h: 400 }],
    region_png: PNG_1X1,
    ...campos,
  };
}

/** Cliente de IA que repassa ao de simulação e anota o que foi pedido. */
function clienteQueAnota(responder = null) {
  const simulacao = ai.getClient();
  const pedidos = [];
  const cliente = {
    chat: {
      completions: {
        async create(params, options) {
          pedidos.push(params);
          if (responder && ai.imageCount(params.messages) > 0) return responder(params, options);
          return simulacao.chat.completions.create(params, options);
        },
      },
    },
  };
  return { cliente, pedidos, comImagem: () => pedidos.filter((p) => ai.imageCount(p.messages) > 0) };
}

/** Resposta JSON do provedor, no formato da API. */
function respostaJson(objeto) {
  return {
    model: 'teste/visao',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(objeto) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100 },
  };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

describe('IA: conteúdo com imagem', () => {
  const imagemGrande = `data:image/png;base64,${crypto.randomBytes(300_000).toString('base64')}`;
  const mensagens = [
    { role: 'system', content: 'Transcreva.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcreva a questão 12 desta prova. "alternatives"' },
        { type: 'image_url', image_url: { url: imagemGrande } },
      ],
    },
  ];

  it('o base64 da imagem não conta como texto; cada imagem vale um valor fixo', () => {
    const texto = ai.messagesText(mensagens);
    assert.doesNotMatch(texto, /base64/);
    assert.match(texto, /questão 12/);
    assert.equal(ai.imageCount(mensagens), 1);
    const estimado = ai.estimatePromptTokens(mensagens);
    assert.ok(estimado < ai.TOKENS_POR_IMAGEM + 100, `${estimado} tokens estimados para uma imagem de 400 KB`);
    assert.ok(estimado >= ai.TOKENS_POR_IMAGEM);
  });
});

describe('Validação da transcrição', () => {
  it('troca o texto, devolve a figura ao lugar dela e tira o alerta', () => {
    const q = questaoLida({
      statement_md: 'Texto \u0001\u0002 lixo\n\n![Figura](figura:0)\n\nPergunta \u0003 lixo',
      figures: [{ page: 3, kind: 'image', slot: 'enunciado', crop: { x: 1, y: 1, w: 10, h: 10 } }],
      alerts: ['texto_ilegivel', 'numero_fora_de_sequencia'],
    });
    const t = visao.validar(
      {
        statement: 'TEXTO I\nO <b>rio</b> corre para o mar.\n\n[[FIGURA]]\n\n# Qual é a ideia **central** do texto?',
        alternatives: { A: 'O rio.', B: 'O mar.', C: 'A chuva.', D: 'O vento.', E: 'A <script>alert(1)</script>areia.' },
      },
      q
    );
    assert.ok(!t.erro, t.erro);
    assert.equal(
      t.statement_md,
      '**TEXTO I**\nO rio corre para o mar.\n\n![Figura](figura:0)\n\n\\# Qual é a ideia central do texto?'
    );
    assert.doesNotMatch(JSON.stringify(t), /<script|<b>/);
    visao.aplicar(q, t, { model: 'teste/visao' });
    assert.deepEqual(q.alerts, ['numero_fora_de_sequencia'], 'só os alertas que a visão resolve saem');
    assert.deepEqual(q.vision, { model: 'teste/visao' });
    assert.equal(q.alternatives.length, 5);
  });

  it('aceita as alternativas em lista e mantém a alternativa que é figura', () => {
    const q = questaoLida({
      alternatives: [
        { letter: 'A', text_md: '![Alternativa A](figura:0)' },
        { letter: 'B', text_md: '![Alternativa B](figura:1)' },
        { letter: 'C', text_md: '![Alternativa C](figura:2)' },
      ],
      figures: [0, 1, 2].map((i) => ({ page: 3, kind: 'image', slot: 'ABC'[i], crop: { x: 1, y: 1, w: 9, h: 9 } })),
      alerts: ['alternativas_incompletas'],
    });
    const mensagens = visao.montarMensagens(q, 'data:image/png;base64,AAAA');
    assert.match(mensagens[1].content[0].text, /Alternativas que são figura: A, B, C/);
    const t = visao.validar(
      {
        statement: 'Qual dos gráficos representa a função descrita no enunciado da questão?',
        alternatives: [
          { letter: 'A', text: '[[FIGURA]]' },
          { letter: 'B', text: 'um gráfico de barras' },
          { letter: 'C', text: '[[FIGURA]]' },
          { letter: 'D', text: '[[FIGURA]]' },
          { letter: 'E', text: 'y = 2x + 1' },
        ],
      },
      q
    );
    assert.equal(t.erro, 'alternativa D vazia', 'a figura da D não existe: o alerta fica');

    const boa = visao.validar(
      {
        statement: 'Qual dos gráficos representa a função descrita no enunciado da questão?',
        alternatives: ['[[FIGURA]]', 'descrição que não entra', '[[FIGURA]]', 'y = x²', 'y = 2x + 1'],
      },
      q
    );
    assert.ok(!boa.erro, boa.erro);
    assert.deepEqual(
      boa.alternatives.map((a) => a.text_md),
      ['![Alternativa A](figura:0)', '![Alternativa B](figura:1)', '![Alternativa C](figura:2)', 'y = x²', 'y = 2x + 1']
    );
  });

  it('recusa o que não é transcrição boa: figura a menos, trecho ilegível, alternativa faltando, lixo', () => {
    const comFigura = questaoLida({
      statement_md: 'Texto\n\n![Figura](figura:0)\n\nPergunta',
      figures: [{ page: 3, kind: 'image', slot: 'enunciado', crop: { x: 1, y: 1, w: 10, h: 10 } }],
    });
    const alternativas = { A: 'um', B: 'dois', C: 'três', D: 'quatro', E: 'cinco' };
    const casos = [
      [{ statement: 'Um texto inteiro, mas sem o lugar da figura do enunciado.', alternatives: alternativas }, /figura/],
      [{ statement: 'O texto tem um trecho [ilegível] no meio. [[FIGURA]]', alternatives: alternativas }, /não conseguiu ler/],
      [{ statement: 'Enunciado completo e legível da questão. [[FIGURA]]', alternatives: { ...alternativas, E: '' } }, /alternativa E vazia/],
      [{ statement: 'Enunciado \u0001\u0002\u0003\u0004\u0005\u0006 com lixo [[FIGURA]]', alternatives: alternativas }, /ilegível/],
      [{ statement: '', alternatives: alternativas }, /enunciado vazio/],
      [null, /sem JSON/],
    ];
    for (const [resposta, motivo] of casos) {
      const r = visao.validar(resposta, comFigura);
      assert.ok(r.erro, JSON.stringify(resposta));
      assert.match(r.erro, motivo);
    }
    // figura a mais: sai do texto, e a questão fica para alguém olhar
    const aMais = visao.validar({ statement: 'Texto.\n\n[[FIGURA]]\n\nPergunta da questão?\n\n[[FIGURA]]', alternatives: alternativas }, comFigura);
    assert.ok(!aMais.erro, aMais.erro);
    assert.equal(aMais.statement_md.match(/figura:0/g).length, 1);
    assert.doesNotMatch(aMais.statement_md, /\[\[FIGURA\]\]/);
    assert.deepEqual(aMais.alerts, ['figura_incerta']);
  });
});

describe('Leitura pela imagem', () => {
  let ctx;
  let db;
  let admin;
  let exam;
  const arquivos = [];
  let questoesAntes = new Set();

  function guardarPdf(buffer, nome = 'prova') {
    fs.mkdirSync(PASTA_PROVAS, { recursive: true });
    const arquivo = `teste-visao-${nome}-${crypto.randomBytes(5).toString('hex')}.pdf`;
    fs.writeFileSync(path.join(PASTA_PROVAS, arquivo), buffer);
    arquivos.push(path.join(PASTA_PROVAS, arquivo));
    return `/uploads/provas/${arquivo}`;
  }

  async function lerAteOFim(campos) {
    const criada = await admin.agent.post('/api/admin/exam-imports', { exam_id: exam.id, year: 2024, ...campos });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${criada.body.id}/ler`, {});
    assert.ok([200, 202].includes(disparo.status), `${disparo.status}: ${JSON.stringify(disparo.body)}`);
    const inicio = Date.now();
    for (;;) {
      const atual = await admin.agent.get(`/api/admin/exam-imports/${criada.body.id}`);
      if (atual.body.status !== 'extraindo') return atual.body;
      if (Date.now() - inicio > 30_000) throw new Error('a leitura não terminou');
      await esperar(40);
    }
  }

  const itemDe = (leitura, number) => leitura.items.find((i) => i.number === number);

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    admin = await ctx.loginAdmin();
    exam = await db.one(
      `INSERT INTO exams (slug, name, short_name, track, sort_order)
       VALUES ('enem-visao', 'ENEM', 'ENEM', 'enem', 1) RETURNING id`
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

  afterEach(async () => {
    ai.setClientForTests(null);
    await settings.setSetting('exam_import_vision_enabled', null);
    await settings.setSetting('openrouter_vision_model', null);
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

  it('desligada por padrão: configuração, semente e painel', async () => {
    assert.equal(settings.DEFAULTS.exam_import_vision_enabled, false);
    assert.equal(settings.DEFAULTS.openrouter_vision_model, '');
    assert.equal(seedSettings.exam_import_vision_enabled, false);
    assert.equal(seedSettings.openrouter_vision_model, '');

    let res = await admin.agent.get('/api/admin/settings');
    assert.equal(res.body.exam_import_vision_enabled, false);
    assert.equal(res.body.openrouter_vision_model, '');

    res = await admin.agent.put('/api/admin/settings', { exam_import_vision_enabled: true, openrouter_vision_model: 'qwen/qwen2.5-vl-72b-instruct' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.exam_import_vision_enabled, true);
    assert.deepEqual(await visao.configuracao(), { enabled: true, model: 'qwen/qwen2.5-vl-72b-instruct', available: true });

    res = await admin.agent.put('/api/admin/settings', { openrouter_vision_model: '' });
    assert.equal(res.status, 200);
    await settings.setSetting('openrouter_extract_model', 'google/gemini-flash-leitura');
    assert.equal((await visao.configuracao()).model, 'google/gemini-flash-leitura', 'vazio usa o modelo da leitura de prova');
    await settings.setSetting('openrouter_extract_model', null);

    res = await admin.agent.put('/api/admin/settings', { openrouter_vision_model: 'modelo sem provedor' });
    assert.equal(res.status, 400);
    res = await admin.agent.put('/api/admin/settings', { exam_import_vision_enabled: 'sim' });
    assert.equal(res.status, 400);
  });

  it('o mock reconhece o pedido com imagem e o raciocínio fica desligado no qwen de visão', async () => {
    const { cliente, pedidos } = clienteQueAnota();
    ai.setClientForTests(cliente);
    const mensagens = visao.montarMensagens(questaoLida(), 'data:image/png;base64,AAAA');
    const r = await ai.json({ messages: mensagens, model: 'qwen/qwen2.5-vl-72b-instruct', feature: 'exam_import', maxTokens: 4000 });
    assert.equal(typeof r.data.statement, 'string');
    assert.deepEqual(Object.keys(r.data.alternatives), ['A', 'B', 'C', 'D', 'E']);
    assert.ok(r.usage.prompt_tokens < ai.TOKENS_POR_IMAGEM + 1000, `${r.usage.prompt_tokens} tokens de entrada`);
    assert.deepEqual(pedidos[0].reasoning, { enabled: false, exclude: true });

    // Só texto, no mesmo modelo: nada muda para quem não manda imagem.
    await ai.chat({ messages: [{ role: 'user', content: 'oi' }], model: 'qwen/qwen2.5-vl-72b-instruct' });
    assert.equal(pedidos[1].reasoning, undefined);
    // Outra família: o parâmetro não vai.
    await ai.json({ messages: mensagens, model: 'google/gemini-2.5-flash', feature: 'exam_import' });
    assert.equal(pedidos[2].reasoning, undefined);
  });

  it('o leitor renderiza a região só das questões pedidas', async () => {
    const pdf = provaComFigura();
    const semRegioes = await readExam(pdf);
    assert.ok(semRegioes.questions.every((q) => !q.region_png), 'sem pedir, nenhuma imagem de região');
    for (const q of semRegioes.questions) {
      assert.ok(q.regions.length >= 1, `questão ${q.number} sem região`);
      for (const r of q.regions) assert.ok(r.w > 100 && r.h > 20 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 595.5 && r.y + r.h <= 842.5, JSON.stringify(r));
    }

    const lida = await readExam(pdf, { regions: visao.precisaDeVisao });
    const comImagem = lida.questions.filter((q) => q.region_png);
    assert.deepEqual(comImagem.map((q) => q.number), [3], 'só a questão com alternativa faltando');
    const png = comImagem[0].region_png;
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // largura e altura do PNG (cabeçalho IHDR): a região em escala 2
    const [largura, altura] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const [regiao] = comImagem[0].regions;
    assert.equal(largura, Math.ceil(regiao.w * 2));
    assert.equal(altura, Math.ceil(regiao.h * 2));
  });

  it('desligada: nenhuma imagem vai à IA e a questão com alerta espera a conferência', async () => {
    const { cliente, comImagem } = clienteQueAnota();
    ai.setClientForTests(cliente);
    const final = await lerAteOFim({ title: 'Visão desligada', source_url: guardarPdf(provaComFigura(), 'desligada'), answer_key: '1-C 2-A 3-B' });
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(comImagem().length, 0);
    const q3 = itemDe(final, 3);
    assert.equal(q3.status, 'pendente');
    assert.deepEqual(q3.payload.alerts, ['alternativas_incompletas']);
    assert.equal(q3.payload.vision, undefined);
    assert.equal(final.read_report.vision, undefined);
  });

  it('ligada: só a questão com alerta é lida pela imagem; a boa vai ao banco sozinha', async () => {
    await settings.setSetting('exam_import_vision_enabled', true);
    await settings.setSetting('openrouter_vision_model', 'qwen/qwen2.5-vl-72b-instruct');
    const { cliente, comImagem } = clienteQueAnota();
    ai.setClientForTests(cliente);
    const final = await lerAteOFim({ title: 'Visão ligada', source_url: guardarPdf(provaComFigura(), 'ligada'), answer_key: '1-C 2-A 3-B' });
    assert.equal(final.status, 'concluida', final.error_message);

    const pedidos = comImagem();
    assert.equal(pedidos.length, 1, 'uma chamada com imagem: a da questão 3');
    assert.equal(pedidos[0].model, 'qwen/qwen2.5-vl-72b-instruct');
    assert.match(pedidos[0].messages[1].content[0].text, /questão 3\b/);
    assert.match(pedidos[0].messages[1].content[1].image_url.url, /^data:image\/png;base64,iVBORw0KGgo/);

    const q3 = itemDe(final, 3);
    assert.deepEqual(q3.payload.alerts, [], 'transcrição boa: o alerta sai');
    assert.equal(q3.payload.E.length > 0, true);
    assert.match(q3.payload.statement, /lido na imagem/);
    assert.deepEqual(q3.payload.vision, { model: 'qwen/qwen2.5-vl-72b-instruct (simulação)' });
    assert.equal(q3.status, 'importada', 'sem alerta e com gabarito: vai ao banco');
    const opcoes = await db.many('SELECT letter FROM question_options WHERE question_id = $1', [q3.question_id]);
    assert.equal(opcoes.length, 5);

    // As outras não foram tocadas.
    assert.equal(itemDe(final, 1).payload.vision, undefined);
    assert.match(itemDe(final, 2).payload.statement, /!\[Figura\]\(\/uploads\/questoes\//);
    assert.equal(final.read_report.vision.tried, 1);
    assert.equal(final.read_report.vision.fixed, 1);
    assert.ok(final.read_report.vision.prompt_tokens > 0);
  });

  it('ligada, mas a resposta não serve: o alerta fica e a leitura termina', async () => {
    await settings.setSetting('exam_import_vision_enabled', true);
    const { cliente, comImagem } = clienteQueAnota(async () =>
      respostaJson({ statement: 'Assinale a alternativa que completa corretamente a frase.', alternatives: { A: 'primeira.', B: 'segunda.', C: 'terceira.', D: 'quarta.' } })
    );
    ai.setClientForTests(cliente);
    const final = await lerAteOFim({ title: 'Visão ruim', source_url: guardarPdf(provaComFigura(), 'ruim'), answer_key: '1-C 2-A 3-B' });
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(comImagem().length, 1);
    const q3 = itemDe(final, 3);
    assert.equal(q3.status, 'pendente');
    assert.deepEqual(q3.payload.alerts, ['alternativas_incompletas']);
    assert.equal(q3.payload.E, '');
    assert.equal(final.read_report.vision.failed, 1);
  });

  it('ligada, mas a IA de visão fora do ar: a leitura não para e o alerta fica', async () => {
    await settings.setSetting('exam_import_vision_enabled', true);
    const { cliente, comImagem } = clienteQueAnota(async () => {
      const err = new Error('o modelo não aceita imagem');
      err.status = 404;
      throw err;
    });
    ai.setClientForTests(cliente);
    const final = await lerAteOFim({ title: 'Visão fora', source_url: guardarPdf(provaComFigura(), 'fora'), answer_key: '1-C 2-A 3-B' });
    assert.equal(final.status, 'concluida', final.error_message);
    assert.equal(comImagem().length, 1);
    assert.equal(final.items.length, 3);
    assert.deepEqual(itemDe(final, 3).payload.alerts, ['alternativas_incompletas']);
    assert.equal(itemDe(final, 1).status, 'importada', 'o resto da prova segue como sem visão');
  });

  it('IA fora do ar seguidas vezes: desiste da visão nesta leitura', async () => {
    let chamadas = 0;
    const { cliente } = clienteQueAnota(async () => {
      chamadas += 1;
      const err = new Error('chave recusada');
      err.status = 401;
      throw err;
    });
    ai.setClientForTests(cliente);
    const questoes = Array.from({ length: 8 }, (_, i) => questaoLida({ number: i + 1 }));
    const stats = await visao.melhorar(questoes, { model: 'teste/visao', concorrencia: 1 });
    assert.equal(stats.stopped, true);
    assert.equal(chamadas, 3, 'três falhas seguidas e para');
    assert.ok(questoes.every((q) => q.alerts.includes('texto_ilegivel')));
    assert.ok(questoes.every((q) => !q.region_png), 'as imagens saem da memória');
  });

  it('script de medição: sem chave explica o que fazer; com a simulação mede', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'medir-visao-'));
    try {
      const arquivo = path.join(pasta, 'prova.pdf');
      fs.writeFileSync(arquivo, provaComFigura());
      const script = path.join(RAIZ, 'scripts', 'medir-leitura-visao.js');
      const ambiente = { ...process.env, OPENROUTER_API_KEY: '' };
      delete ambiente.OPENROUTER_MOCK;

      const semChave = spawnSync(process.execPath, [script, arquivo], { env: ambiente, encoding: 'utf8', timeout: 60_000 });
      assert.equal(semChave.status, 1, semChave.stderr);
      assert.match(semChave.stdout, /OPENROUTER_API_KEY/);
      assert.match(semChave.stdout, /Nada foi chamado e nada foi gasto/);

      const simulado = spawnSync(process.execPath, [script, arquivo, '--questoes', '2'], {
        env: { ...ambiente, OPENROUTER_MOCK: '1', NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(simulado.status, 0, simulado.stderr);
      assert.match(simulado.stdout, /1 com alerta/);
      assert.match(simulado.stdout, /Questão 3 — alertas: alternativas_incompletas — imagem \d+ KB — \d+ tokens de entrada, \d+ de saída/);
      assert.match(simulado.stdout, /alertas depois: nenhum/);
      assert.match(simulado.stdout, /Simulação: sem preço/);

      const porPagina = spawnSync(process.execPath, [script, arquivo, '--paginas', '1'], {
        env: { ...ambiente, OPENROUTER_MOCK: '1', NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(porPagina.status, 0, porPagina.stderr);
      assert.match(porPagina.stdout, /Medindo 2 questões das páginas 1/);
      assert.match(porPagina.stdout, /bate com a leitura sem IA: \d+%/);
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Prova real do corpus
  // -------------------------------------------------------------------------
  const PPL = path.join(CORPUS, 'enem-ppl-2017-dia-1.pdf');

  it('PPL 2017, dia 1, de verdade: toda questão tem região, e a imagem dela é a questão inteira', { skip: fs.existsSync(PPL) ? false : 'PDF fora do corpus', timeout: 120_000 }, async () => {
    const escolhidas = new Set([1, 11, 46]);
    const prova = await readExam(fs.readFileSync(PPL), { figures: false, regions: (q) => escolhidas.has(q.number) && q.variant !== 'espanhol' });
    for (const q of prova.questions) {
      assert.ok(q.regions.length >= 1 && q.regions.length <= 3, `questão ${q.number}: ${q.regions.length} pedaços`);
    }
    const imagens = prova.questions.filter((q) => q.region_png);
    assert.deepEqual(imagens.map((q) => q.number), [1, 11, 46]);
    for (const q of imagens) {
      const altura = q.region_png.readUInt32BE(20);
      assert.ok(altura > 300, `questão ${q.number}: imagem de ${altura} px de altura`);
    }
  });
});

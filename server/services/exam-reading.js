'use strict';

/**
 * Leitura de prova no servidor, em segundo plano.
 *
 *   const reading = require('./exam-reading');
 *   await reading.available();               // { ok, message } — o leitor carrega neste servidor?
 *   reading.start(importId, { adminId });    // dispara e volta na hora (a rota responde 202)
 *   await reading.run(importId, { adminId }); // o trabalho inteiro (testes chamam direto)
 *   reading.isRunning(importId);
 *   await reading.releaseIfStalled(row);     // lazy: 'extraindo' de quem morreu → 'pronta'
 *
 * O caminho, de ponta a ponta:
 *
 *   1. baixa o PDF da leitura (exam_imports.source_url) ou da prova anterior
 *      (past_exams.pdf_url) — disco da aplicação, Blob ou Google Drive;
 *   2. lê a prova com posição (exam-reader/): enunciado em markdown, cinco
 *      alternativas, figuras recortadas em PNG, variante de idioma e alertas;
 *   3. sem gabarito na leitura, lê o PDF do gabarito da prova anterior
 *      (exam-reader/answer-key.js), com as colunas de inglês e espanhol — ou,
 *      sem ele, o gabarito do fim do próprio PDF da prova;
 *   4. em lotes de até 12 questões: com a leitura pela imagem ligada
 *      (exam_import_vision_enabled), as questões com alerta de texto ilegível
 *      ou de alternativa faltando são transcritas por uma IA de visão
 *      (exam-vision.js); a IA classifica (matéria, assunto, dificuldade —
 *      buildClassificationPrompt, como sempre), as figuras sobem para a pasta
 *      'questoes' do armazenamento, e cada questão vira um item de
 *      exam_import_items;
 *   5. vai ao banco sozinho SÓ o item sem alerta e com a letra do gabarito
 *      oficial (exam-import-bank.js); o resto espera a conferência no painel.
 *
 * O estado mora no banco (status 'extraindo', etapa, progresso), porque a
 * hospedagem reinicia o processo quando quer. Recuperação:
 *   - no boot, scripts/bootstrap.js devolve todo 'extraindo' para 'pronta';
 *   - sem boot, releaseIfStalled destrava a leitura parada há mais de dois
 *     minutos que este processo não conhece (o trabalho de verdade dá sinal de
 *     vida a cada 20 segundos);
 *   - "Continuar a leitura" relê o PDF (segundos, sem IA) e pula as questões
 *     que já viraram item: nada é classificado nem enviado duas vezes.
 *
 * O recorte é determinístico — sem IA. A IA só classifica, como antes; a de
 * visão é reforço opcional, desligado por padrão, só para questão com alerta.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/pool');
const config = require('../config');
const { AppError } = require('../middleware/errors');
const uploads = require('./uploads');
const examImport = require('./exam-import');
const bank = require('./exam-import-bank');
const examVision = require('./exam-vision');
const answerKeys = require('./exam-reader/answer-key');

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const VARIANTE = { ingles: 'Inglês', espanhol: 'Espanhol' };

/** Prazo para o servidor do arquivo começar a responder. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** O Blob recusa rajada com 429 — ler 25 provas seguidas esbarra nisso. */
const DOWNLOAD_TENTATIVAS = 3;
/** PDF de prova passa de 10 MB; acima disto não é prova, e a memória agradece. */
const MAX_PDF_BYTES = 80 * 1024 * 1024;
/** Sinal de vida da leitura em andamento (updated_at). */
const PULSO_MS = 20_000;
/** Sem sinal de vida por mais que isto, e fora deste processo: a leitura morreu. */
const PARADA_MS = 2 * 60_000;
/** Tentativas de enviar uma figura quando o armazenamento recusa por excesso (429) ou cai. */
const ENVIO_TENTATIVAS = 5;
const ENVIO_ESPERA_MS = config.isTest ? 5 : 1500;
/** Figura em PNG maior que o limite de imagem do armazenamento vira JPEG. */
const MAX_FIGURA_BYTES = 5 * 1024 * 1024;
/** O Blob recusa arquivo menor que 512 bytes (fórmula pequena dá 250). */
const MIN_FIGURA_BYTES = 640;

const MSG_PARADA = 'A leitura parou no meio (a aplicação reiniciou ou o processo caiu). Continue de onde parou.';

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Leituras que ESTE processo está fazendo agora. */
const emAndamento = new Map();

let leitorDeTeste = null;

/**
 * Troca o leitor do PDF (só nos testes): fn(buffer, opts) → resultado no
 * formato de readExam. Passe null para restaurar.
 */
function setReaderForTests(fn) {
  leitorDeTeste = fn;
}

function leitor() {
  // eslint-disable-next-line global-require
  return leitorDeTeste ? { readExam: leitorDeTeste } : require('./exam-reader');
}

/** Erro que não adianta tentar de novo com o mesmo arquivo: a leitura vai para 'falhou'. */
function definitivo(mensagem) {
  const err = new Error(mensagem);
  err.definitivo = true;
  return err;
}

// ---------------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------------

/**
 * O leitor carrega neste servidor? (pdf.js + canvas). Quando não, o painel usa
 * o caminho antigo: texto extraído no navegador e varredura em lotes.
 * @returns {Promise<{ ok: boolean, message: string|null }>}
 */
async function available() {
  if (leitorDeTeste) return { ok: true, message: null };
  try {
    // eslint-disable-next-line global-require
    await require('./exam-reader/layout').loadRuntime();
    return { ok: true, message: null };
  } catch (err) {
    console.warn(`[exam-reading] leitor indisponível: ${err.cause ? err.cause.message : err.message}`);
    return {
      ok: false,
      message: 'A leitura de provas no servidor não está disponível neste ambiente. Use a leitura pelo navegador.',
    };
  }
}

// ---------------------------------------------------------------------------
// O arquivo
// ---------------------------------------------------------------------------

/**
 * Baixa um arquivo da internet, com prazo e retentativa.
 *
 * Sem isto, uma recusa temporária do armazenamento virava 502 na cara de quem
 * estava lendo as provas em lote — e, como o lote só contava a falha, a prova
 * simplesmente não era lida e ninguém sabia por quê.
 */
async function baixarPdf(destino) {
  let ultimoStatus = 0;
  for (let tentativa = 1; tentativa <= DOWNLOAD_TENTATIVAS; tentativa += 1) {
    const controller = new AbortController();
    const relogio = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let resposta = null;
    try {
      resposta = await fetch(destino, { redirect: 'follow', signal: controller.signal });
    } catch (err) {
      if (tentativa === DOWNLOAD_TENTATIVAS) {
        throw new AppError(
          504,
          'timeout',
          'O servidor onde o PDF está guardado demorou demais para responder. Tente de novo em instantes.'
        );
      }
      await esperar(1500 * tentativa);
      continue;
    } finally {
      clearTimeout(relogio);
    }
    if (resposta.ok && resposta.body) return resposta;
    ultimoStatus = resposta.status;
    const valeTentarDeNovo = resposta.status === 429 || resposta.status >= 500;
    if (!valeTentarDeNovo || tentativa === DOWNLOAD_TENTATIVAS) break;
    await esperar(1500 * tentativa);
  }
  throw new AppError(
    502,
    'bad_gateway',
    ultimoStatus === 429
      ? 'O armazenamento recusou tantos downloads seguidos. Espere um minuto e leia esta prova de novo.'
      : `Não foi possível baixar o PDF desta prova (HTTP ${ultimoStatus}).`
  );
}

/** Caminho de disco de um arquivo servido pela própria aplicação, ou null. */
function arquivoLocal(url) {
  const bases = [
    ['/uploads/', uploads.UPLOADS_DIR],
    ['/assets/', path.join(config.publicDir, 'assets')],
  ];
  for (const [prefixo, base] of bases) {
    if (!url.startsWith(prefixo)) continue;
    const relativo = decodeURIComponent(url.slice(prefixo.length).split(/[?#]/)[0]);
    const alvo = path.resolve(base, relativo);
    if (!alvo.startsWith(path.resolve(base) + path.sep)) return null;
    return alvo;
  }
  return null;
}

/**
 * O PDF inteiro em memória (Buffer), venha de onde vier: disco da aplicação
 * (/uploads/…, /assets/…), Blob ou link do Google Drive.
 */
async function lerPdf(endereco) {
  const url = String(endereco || '').trim();
  if (!url) throw definitivo('Esta leitura não tem PDF: envie o arquivo ou escolha uma prova cadastrada.');

  if (url.startsWith('/')) {
    const alvo = arquivoLocal(url);
    if (!alvo || !fs.existsSync(alvo)) throw definitivo('O arquivo desta prova não foi encontrado no servidor.');
    const tamanho = fs.statSync(alvo).size;
    if (tamanho > MAX_PDF_BYTES) throw definitivo('O arquivo é grande demais para uma prova.');
    return fs.promises.readFile(alvo);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw definitivo('O endereço do PDF desta prova não é um arquivo que a plataforma consiga abrir.');
  }

  const resposta = await baixarPdf(examImport.directDownloadUrl(url));
  const tipo = String(resposta.headers.get('content-type') || '');
  if (/text\/html/i.test(tipo)) {
    await resposta.body.cancel().catch(() => {});
    throw definitivo(
      examImport.isDriveUrl(url)
        ? 'O Google Drive não entregou o arquivo. Abra o link no Drive, em Compartilhar, e deixe como "qualquer pessoa com o link".'
        : 'O endereço cadastrado devolveu uma página, não um PDF. Confira o link da prova.'
    );
  }
  const partes = [];
  let total = 0;
  for await (const parte of resposta.body) {
    total += parte.length;
    if (total > MAX_PDF_BYTES) throw definitivo('O arquivo é grande demais para uma prova.');
    partes.push(Buffer.from(parte));
  }
  return Buffer.concat(partes, total);
}

// ---------------------------------------------------------------------------
// Figuras
// ---------------------------------------------------------------------------

const CRC_TABELA = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABELA[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * PNG pequeno demais para o Blob (fórmula de uma linha dá 250 bytes): ganha um
 * bloco de comentário antes do fim. A imagem é a mesma — o bloco tEXt é
 * ignorado por quem desenha.
 */
function completarPng(png, minimo = MIN_FIGURA_BYTES) {
  if (png.length >= minimo || png.subarray(1, 4).toString('latin1') !== 'PNG') return png;
  const iend = png.length - 12;
  const falta = minimo - png.length;
  const dados = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(Math.max(1, falta), 0x20)]);
  const tipoEDados = Buffer.concat([Buffer.from('tEXt', 'latin1'), dados]);
  const bloco = Buffer.alloc(12 + dados.length);
  bloco.writeUInt32BE(dados.length, 0);
  tipoEDados.copy(bloco, 4);
  bloco.writeUInt32BE(crc32(tipoEDados), 8 + dados.length);
  return Buffer.concat([png.subarray(0, iend), bloco, png.subarray(iend)]);
}

/** PNG acima do limite de imagem vira JPEG (mapa colorido de página inteira). */
async function caberNoLimite(png) {
  if (png.length <= MAX_FIGURA_BYTES) return { buffer: png, ext: '.png', type: 'image/png' };
  // eslint-disable-next-line global-require
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  for (const qualidade of [85, 70, 55]) {
    const jpeg = canvas.toBuffer('image/jpeg', qualidade);
    if (jpeg.length <= MAX_FIGURA_BYTES) return { buffer: jpeg, ext: '.jpg', type: 'image/jpeg' };
  }
  throw definitivo('Uma figura desta prova é grande demais para o armazenamento.');
}

/** Recusa passageira do armazenamento: excesso de envios (429), queda, demora. */
function recusaPassageira(err) {
  const status = Number(err && err.status);
  return (
    status === 429 ||
    status >= 500 ||
    (err && (err.code === 'RATE_LIMIT' || err.code === 'storage_timeout' || err.code === 'storage_error'))
  );
}

/**
 * Envia uma figura para a pasta 'questoes', com pausa e nova tentativa quando
 * o armazenamento recusa por excesso de envios. Uma prova tem dezenas de
 * figuras: sem a pausa, a rajada esbarra no 429 do Blob no meio da leitura.
 */
async function enviarFigura(png, nome) {
  const arquivo = await caberNoLimite(completarPng(png));
  let ultimo = null;
  for (let tentativa = 1; tentativa <= ENVIO_TENTATIVAS; tentativa += 1) {
    try {
      const salvo = await uploads.save(arquivo.buffer, {
        folder: 'questoes',
        filename: `${nome}${arquivo.ext}`,
        contentType: arquivo.type,
      });
      return salvo.url;
    } catch (err) {
      ultimo = err;
      if (!recusaPassageira(err) || tentativa === ENVIO_TENTATIVAS) break;
      await esperar(ENVIO_ESPERA_MS * tentativa * (Number(err.status) === 429 ? 2 : 1));
    }
  }
  const motivo = ultimo && ultimo.message ? ultimo.message : 'motivo desconhecido';
  throw new Error(`Não foi possível guardar as figuras desta prova: ${motivo}`);
}

/** Prefixo curto e legível para o nome das figuras no armazenamento. */
function prefixoDosArquivos(row) {
  const base = String(row.title || 'prova')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .slice(0, 12);
  return base || 'prova';
}

/**
 * Largura de exibição da figura, no próprio endereço (`#w=`): o recorte é
 * renderizado em escala 2, e sem isto uma fração de uma linha aparecia com
 * três linhas de altura. 1,6 px por ponto acompanha o texto da tela, que é
 * ~1,2 vez o da prova impressa. O fragmento não vai ao servidor; quem lê é
 * public/js/core/markdown.js.
 */
function larguraDeTela(figura) {
  // (recorte girado de lado: a largura na tela é a altura na página)
  const w = figura && figura.crop ? Number(figura.rotate ? figura.crop.h : figura.crop.w) : 0;
  return w > 0 ? Math.max(8, Math.round(w * 1.6)) : null;
}

/**
 * Sobe as figuras de uma questão e devolve as URLs por índice. Figura repetida
 * (apoio compartilhado por várias questões) sobe uma vez só.
 */
async function subirFiguras(questao, { cache, prefixo }) {
  const urls = [];
  for (let i = 0; i < questao.figures.length; i += 1) {
    const figura = questao.figures[i];
    if (!figura.png) {
      urls.push(null);
      continue;
    }
    const resumo = crypto.createHash('sha1').update(figura.png).digest('hex');
    if (!cache.has(resumo)) {
      const nome = `${prefixo}_q${questao.number}${questao.variant ? questao.variant.slice(0, 2) : ''}_${i + 1}`;
      cache.set(resumo, await enviarFigura(figura.png, nome));
    }
    const largura = larguraDeTela(figura);
    urls.push(`${cache.get(resumo)}${largura ? `#w=${largura}` : ''}`);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Item da leitura
// ---------------------------------------------------------------------------

/** Texto da questão para a IA classificar: no lugar da figura, o texto dela. */
function paraClassificar(q) {
  const semFiguras = (md) =>
    String(md || '').replace(/!\[([^\]]*)\]\(figura:(\d+)\)/g, (m, alt, n) => {
      const figura = q.figures[Number(n)];
      const texto = figura && figura.text ? String(figura.text).replace(/\s+/g, ' ').slice(0, 300) : '';
      return texto ? `[${alt}: ${texto}]` : `[${String(alt || 'figura').toLowerCase()}]`;
    });
  const out = { number: q.number, variant: q.variant || null, statement: semFiguras(q.statement_md) };
  for (const a of q.alternatives) if (LETRAS.includes(a.letter)) out[a.letter] = semFiguras(a.text_md);
  return out;
}

/** O marcador `figura:N` vira a URL guardada. */
function comUrls(md, urls) {
  return String(md || '').replace(/\]\(figura:(\d+)\)/g, (m, n) => (urls[Number(n)] ? `](${urls[Number(n)]})` : m));
}

/**
 * Monta o payload do item: o mesmo formato que a importação por planilha
 * entende (statement, A–E, correct, subject_slug...), mais o que a conferência
 * precisa (variant, alerts, figures).
 *
 * As figuras vão DENTRO do markdown, na posição em que estavam na prova
 * (`![Figura](url)` no enunciado, `![Alternativa B](url)` na alternativa).
 * image_url fica vazio de propósito: as telas do aluno mostram image_url
 * depois do enunciado, e a figura apareceria duas vezes.
 */
function montarPayload(q, classificacao, urls, { answerKey, exam, year, board }) {
  const alternativas = {};
  for (const a of q.alternatives) {
    if (LETRAS.includes(a.letter)) alternativas[a.letter] = comUrls(a.text_md, urls).trim();
  }
  const opcoes = {};
  for (const letra of LETRAS) opcoes[letra] = alternativas[letra] || '';

  // O gabarito oficial manda. A letra que a IA deduziu só vale quando não há
  // gabarito — e aí o item tem o alerta 'sem_gabarito' e espera a conferência.
  const oficial = answerKeys.answerFor(answerKey, q.number, q.variant);
  const deduzida = String((classificacao && classificacao.correct) || '').trim().toUpperCase();
  const correct = oficial || (LETRAS.includes(deduzida) && opcoes[deduzida] ? deduzida : '');

  const alerts = [...(q.alerts || [])];
  if (!oficial && !alerts.includes('sem_gabarito')) alerts.push('sem_gabarito');
  if (urls.some((url, i) => !url && q.figures[i]) && !alerts.includes('figura_incerta')) alerts.push('figura_incerta');

  const dificuldade = Number.parseInt(classificacao && classificacao.difficulty, 10);
  const subject = String((classificacao && classificacao.subject_slug) || '').trim();
  const topic = String((classificacao && classificacao.topic_slug) || '').trim();
  const base = exam ? `${exam.name}${year ? ` ${year}` : ''}` : null;

  return {
    number: q.number,
    variant: q.variant || null,
    statement: comUrls(q.statement_md, urls).trim(),
    ...opcoes,
    correct,
    subject_slug: subject,
    topic_slug: topic,
    needs_topic: !topic,
    needs_answer: !correct,
    difficulty: dificuldade >= 1 && dificuldade <= 3 ? dificuldade : 2,
    year: year || null,
    board: board || (exam ? exam.board : null) || null,
    source: base && q.variant ? `${base} (${VARIANTE[q.variant]})` : base,
    answer_from_key: Boolean(oficial),
    image_url: null,
    alerts,
    figures: q.figures.map((f, i) => ({
      url: urls[i] || null,
      page: f.page,
      slot: f.slot,
      kind: f.kind,
      ...(f.uncertain && f.uncertain.length ? { uncertain: f.uncertain } : {}),
    })),
    source_pages: q.source_pages || [],
    reader: 'leitor',
    // Texto transcrito pela IA de visão (a fonte do PDF não deu para ler).
    ...(q.vision ? { vision: { model: q.vision.model || null } } : {}),
  };
}

/** Resumo da leitura para a tela: questões, alertas por tipo, figuras, descarte. */
function relatorio(resultado, ms) {
  const alertas = {};
  for (const q of resultado.questions) for (const a of q.alerts || []) alertas[a] = (alertas[a] || 0) + 1;
  const descartado = {};
  for (const d of resultado.discarded || []) descartado[d.kind] = (descartado[d.kind] || 0) + 1;
  return {
    kind: resultado.kind,
    questions: resultado.questions.length,
    with_alerts: resultado.questions.filter((q) => (q.alerts || []).length).length,
    variants: resultado.questions.filter((q) => q.variant === 'espanhol').length,
    figures: resultado.questions.reduce((n, q) => n + q.figures.length, 0),
    alerts: alertas,
    discarded: descartado,
    ms,
  };
}

// ---------------------------------------------------------------------------
// O trabalho
// ---------------------------------------------------------------------------

async function carregar(importId) {
  return db.one(
    `SELECT i.*, e.name AS exam_name, e.board AS exam_board,
            p.pdf_url AS past_exam_pdf_url, p.answer_key_url AS past_exam_answer_key_url
       FROM exam_imports i
       LEFT JOIN exams e ON e.id = i.exam_id
       LEFT JOIN past_exams p ON p.id = i.past_exam_id
      WHERE i.id = $1`,
    [importId]
  );
}

async function etapa(importId, stage, extra = {}) {
  const campos = ['stage = $2'];
  const valores = [importId, stage];
  for (const [coluna, valor] of Object.entries(extra)) {
    valores.push(valor);
    campos.push(`${coluna} = $${valores.length}`);
  }
  await db.query(`UPDATE exam_imports SET ${campos.join(', ')} WHERE id = $1`, valores);
}

/** Quantas vezes cada questão (número|variante) já virou item nesta leitura. */
async function jaLidas(importId) {
  const rows = await db.many(
    `SELECT number, coalesce(variant, payload->>'variant') AS variant, count(*)::int AS n
       FROM exam_import_items WHERE import_id = $1 AND number IS NOT NULL
      GROUP BY 1, 2`,
    [importId]
  );
  return new Map(rows.map((r) => [bank.chaveDaQuestao(r.number, r.variant), r.n]));
}

/**
 * O gabarito da leitura. Sem um, lê o PDF do gabarito da prova anterior; sem
 * esse (ou ilegível), o gabarito que vem no fim do próprio PDF da prova (a
 * VUNESP e a FGV publicam assim — o leitor só lê as páginas que não são de
 * questão). Chamado depois da leitura da prova: o tipo do caderno escolhe a
 * tabela certa quando a folha traz uma por tipo, e a lista das questões de
 * espanhol completa o gabarito de letra única.
 *
 * Gabarito de letra única (a folha não fala em espanhol), numa prova que não
 * é do ENEM: a letra vale para a opção de espanhol também — a entrada
 * "N:espanhol" é gravada com a mesma letra. No ENEM, nunca: a folha do INEP
 * sempre traz as duas colunas, e faltar a de espanhol é erro de leitura.
 */
async function garantirGabarito(row, resultado = null) {
  const atual = row.answer_key && typeof row.answer_key === 'object' && Object.keys(row.answer_key).length ? row.answer_key : null;
  let lido = atual ? { key: atual, count: Object.keys(atual).length, sharedLanguages: Boolean(row.answer_key_shared) } : null;
  if (!lido && row.past_exam_answer_key_url) {
    await etapa(row.id, 'gabarito');
    try {
      const tipo = resultado && resultado.booklet_type ? { tipo: resultado.booklet_type } : {};
      lido = await answerKeys.readAnswerKey(await lerPdf(row.past_exam_answer_key_url), tipo);
    } catch (err) {
      // Sem gabarito a leitura continua: as questões ficam com o alerta
      // 'sem_gabarito' e esperam a conferência, em vez de a prova não ser lida.
      console.warn(`[exam-reading] gabarito de ${row.id} não pôde ser lido: ${err.message}`);
      lido = null;
    }
  }
  if ((!lido || !lido.count) && resultado && resultado.answer_key && resultado.answer_key.count) lido = resultado.answer_key;
  if (!lido || !lido.count) return null;

  let { key } = lido;
  if (lido.sharedLanguages && resultado && resultado.kind && resultado.kind !== 'enem') {
    const espanhol = resultado.questions.filter((q) => q.variant === 'espanhol').map((q) => q.number);
    key = answerKeys.shareLanguages(key, espanhol);
  }
  if (!atual || Object.keys(key).length !== Object.keys(atual).length) {
    await db.query('UPDATE exam_imports SET answer_key = $2::jsonb, answer_key_shared = $3 WHERE id = $1', [
      row.id,
      JSON.stringify(key),
      Boolean(lido.sharedLanguages),
    ]);
  }
  return key;
}

/**
 * Baixa e lê o PDF. Fica numa função à parte para o arquivo (dezenas de MB)
 * sair da memória antes da classificação, que é a parte demorada.
 */
async function lerProva(row, { regioes = false } = {}) {
  await etapa(row.id, 'baixando');
  const pdf = await lerPdf(row.source_url || row.past_exam_pdf_url);
  await etapa(row.id, 'lendo');
  try {
    // Com a leitura pela imagem ligada, a região inteira das questões com
    // alerta sai em PNG também — só delas, para não segurar a prova inteira
    // em imagem na memória.
    const opcoes = regioes ? { examKind: 'auto', regions: examVision.precisaDeVisao } : { examKind: 'auto' };
    return await leitor().readExam(pdf, opcoes);
  } catch (err) {
    if (err && err.code === 'pdf_invalido') throw definitivo('Não foi possível abrir este arquivo como PDF. Confira o arquivo da prova.');
    if (err && err.code === 'leitor_indisponivel') {
      throw definitivo('A leitura de provas no servidor não está disponível neste ambiente. Use a leitura pelo navegador.');
    }
    throw err;
  }
}

/** Soma o resultado de um lote da leitura pela imagem no total da leitura. */
function somarVisao(total, lote) {
  for (const chave of ['tried', 'fixed', 'failed', 'prompt_tokens', 'completion_tokens']) {
    total[chave] = (total[chave] || 0) + (Number(lote[chave]) || 0);
  }
  if (lote.stopped) total.stopped = true;
  return total;
}

/**
 * Lê a prova inteira e grava os itens. Roda solta, fora da requisição; nunca
 * lança — o desfecho fica na linha da leitura (status, error_message).
 */
async function run(importId, { adminId = null } = {}) {
  const pulso = setInterval(() => {
    db.query(`UPDATE exam_imports SET updated_at = now() WHERE id = $1 AND status = 'extraindo'`, [importId]).catch(() => {});
  }, PULSO_MS);
  if (pulso.unref) pulso.unref();

  try {
    const row = await carregar(importId);
    if (!row) return;
    await etapa(importId, 'baixando', { engine: 'leitor', error_message: null });

    // Leitura pela imagem: só com a configuração ligada E a IA disponível.
    // Sem chave, as questões ficam com o alerta, como sem visão.
    const visao = await examVision.configuracao();
    const comVisao = visao.enabled && visao.available;
    const totalVisao = { model: visao.model || null, tried: 0, fixed: 0, failed: 0, stopped: false, prompt_tokens: 0, completion_tokens: 0 };
    const inicio = Date.now();
    const resultado = await lerProva(row, { regioes: comVisao });
    if (!resultado.questions.length) {
      throw definitivo(
        'Nenhuma questão foi encontrada neste PDF. Se for uma prova digitalizada (foto das páginas), cole o texto da prova no campo de texto.'
      );
    }
    const ms = Date.now() - inicio;
    // depois da prova: o tipo do caderno e as questões de espanhol decidem o gabarito
    const answerKey = await garantirGabarito(row, resultado);

    const exam = row.exam_id ? { id: row.exam_id, name: row.exam_name, board: row.exam_board } : null;
    const contexto = { answerKey, exam, year: row.year, board: row.board };

    // Retomada: o que já virou item fica como está.
    const vistas = await jaLidas(importId);
    const contagem = new Map();
    const aFazer = resultado.questions.filter((q) => {
      const chave = bank.chaveDaQuestao(q.number, q.variant);
      const ordem = (contagem.get(chave) || 0) + 1;
      contagem.set(chave, ordem);
      return ordem > (vistas.get(chave) || 0);
    });

    await etapa(importId, 'classificando', {
      pages: resultado.pages,
      progress_total: resultado.questions.length,
      progress_done: resultado.questions.length - aFazer.length,
      read_report: JSON.stringify(relatorio(resultado, ms)),
    });

    const cache = new Map();
    const prefixo = prefixoDosArquivos(row);
    for (let i = 0; i < aFazer.length; i += examImport.MAX_QUESTOES_POR_LOTE) {
      const lote = aFazer.slice(i, i + examImport.MAX_QUESTOES_POR_LOTE);
      // Antes de classificar: a IA de classificação recebe o texto já lido.
      if (comVisao && !totalVisao.stopped && lote.some((q) => examVision.precisaDeVisao(q) && q.region_png)) {
        await etapa(importId, 'visao');
        somarVisao(totalVisao, await examVision.melhorar(lote, { model: visao.model, userId: adminId }));
        await etapa(importId, 'classificando');
      }
      for (const q of lote) delete q.region_png;
      const classificadas = await examImport.classify({
        questions: lote.map(paraClassificar),
        exam,
        year: row.year,
        board: row.board,
        answerKey,
        userId: adminId,
      });
      for (let k = 0; k < lote.length; k += 1) {
        const q = lote[k];
        const urls = await subirFiguras(q, { cache, prefixo });
        const payload = montarPayload(q, classificadas[k], urls, contexto);
        await db.query(
          `INSERT INTO exam_import_items (import_id, number, variant, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [importId, q.number, q.variant || null, JSON.stringify(payload)]
        );
      }
      // Sem alerta e com gabarito oficial: vai ao banco agora, sem outro clique.
      await bank.importarConfirmadasAutomaticamente(row, adminId);
      const ultima = lote[lote.length - 1];
      await db.query(
        `UPDATE exam_imports
            SET progress_done = least(progress_total, progress_done + $2),
                found_count = (SELECT count(*) FROM exam_import_items WHERE import_id = $1),
                last_number = $3
          WHERE id = $1`,
        [importId, lote.length, ultima.number]
      );
    }

    if (totalVisao.tried) {
      await db.query(
        `UPDATE exam_imports SET read_report = coalesce(read_report, '{}'::jsonb) || jsonb_build_object('vision', $2::jsonb)
          WHERE id = $1`,
        [importId, JSON.stringify(totalVisao)]
      );
    }
    await db.query(
      `UPDATE exam_imports
          SET status = 'concluida', stage = NULL, error_message = NULL, progress_done = progress_total,
              found_count = (SELECT count(*) FROM exam_import_items WHERE import_id = $1)
        WHERE id = $1`,
      [importId]
    );
  } catch (err) {
    const mensagem = String(err && err.message ? err.message : err).slice(0, 500);
    if (!err || !err.definitivo) console.error(`[exam-reading] leitura de ${importId} parou: ${mensagem}`);
    await db
      .query(`UPDATE exam_imports SET status = $2, stage = NULL, error_message = $3 WHERE id = $1`, [
        importId,
        err && err.definitivo ? 'falhou' : 'pronta',
        mensagem,
      ])
      .catch(() => {});
  } finally {
    clearInterval(pulso);
  }
}

/**
 * Dispara a leitura e volta na hora. A marca entra no mapa SEM await pelo meio:
 * dois cliques seguidos não leem a mesma prova duas vezes.
 *
 * @returns {{ started: boolean, marked: Promise<void> }} started=false quando
 *   este processo já está lendo esta prova; `marked` resolve quando a linha já
 *   diz 'extraindo' (a rota espera por ele antes de responder)
 */
function start(importId, { adminId = null } = {}) {
  if (emAndamento.has(importId)) return { started: false, marked: Promise.resolve() };
  const marcado = db.query(
    `UPDATE exam_imports
        SET status = 'extraindo', engine = 'leitor', stage = 'baixando', error_message = NULL, updated_at = now()
      WHERE id = $1`,
    [importId]
  );
  const trabalho = marcado
    .then(() => run(importId, { adminId }))
    .catch((err) => {
      console.error(`[exam-reading] leitura de ${importId} falhou: ${err.message}`);
      return db
        .query(`UPDATE exam_imports SET status = 'pronta', stage = NULL, error_message = $2 WHERE id = $1`, [
          importId,
          String(err && err.message ? err.message : err).slice(0, 500),
        ])
        .catch(() => {});
    })
    .finally(() => emAndamento.delete(importId));
  emAndamento.set(importId, trabalho);
  return { started: true, marked: marcado.then(() => {}, () => {}) };
}

function isRunning(importId) {
  return emAndamento.has(importId);
}

/** Espera a leitura em andamento deste processo terminar (testes e desligamento). */
async function waitFor(importId) {
  const trabalho = emAndamento.get(importId);
  if (trabalho) await trabalho;
}

/**
 * Lazy: 'extraindo' da leitura no servidor, sem sinal de vida há mais de dois
 * minutos e fora deste processo, é de alguém que morreu. Volta para 'pronta'
 * com o aviso, e "Continuar" retoma de onde parou.
 *
 * @returns {Promise<boolean>} true quando destravou
 */
async function releaseIfStalled(row) {
  if (!row || row.status !== 'extraindo' || row.engine !== 'leitor' || emAndamento.has(row.id)) return false;
  const parado = Date.now() - new Date(row.updated_at).getTime();
  if (parado <= PARADA_MS) return false;
  const solta = await db.one(
    `UPDATE exam_imports SET status = 'pronta', stage = NULL, error_message = $2
      WHERE id = $1 AND status = 'extraindo' RETURNING id`,
    [row.id, MSG_PARADA]
  );
  return Boolean(solta);
}

module.exports = {
  PARADA_MS,
  available,
  start,
  run,
  isRunning,
  waitFor,
  releaseIfStalled,
  baixarPdf,
  lerPdf,
  enviarFigura,
  completarPng,
  montarPayload,
  paraClassificar,
  setReaderForTests,
};

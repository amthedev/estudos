'use strict';

/**
 * Prova em PDF vira questão no banco.
 *
 *   const examImport = require('./exam-import');
 *   const lote = examImport.nextBatch(texto, cursor);        // recorte de um lote
 *   const itens = await examImport.extract({ ... });         // o lote vira questões
 *
 * O caminho inteiro, de ponta a ponta:
 *
 *   1. O navegador do administrador lê o texto do PDF (components/pdf-text.js)
 *      e sobe o texto em pedaços. O PDF nunca sai dali.
 *   2. O texto fica guardado em `exam_imports.document_text`.
 *   3. A varredura anda em lotes, UMA requisição por lote: uma prova do ENEM
 *      tem 90 questões e não cabe em uma chamada só — nem de tempo, nem de
 *      tokens de resposta.
 *   4. Cada questão encontrada vira uma linha de `exam_import_items`, no
 *      mesmo formato que a importação por planilha já entende. O administrador
 *      confere e manda para o banco.
 *
 * Por que o lote é recortado por número de questão, e não por quantidade de
 * caracteres: cortar no meio de um enunciado faz a IA transcrever metade de
 * uma questão e inventar o resto.
 *
 * Sobre o gabarito: quando o administrador cola o gabarito oficial, a resposta
 * correta vem dele. Sem gabarito, a IA está ESCOLHENDO a resposta de uma
 * questão que ela mesma transcreveu — e vai escolher com confiança. Por isso o
 * item sai marcado, e a importação em lote não leva item marcado.
 */
const db = require('../db/pool');
const ai = require('./ai');
const { getSetting } = require('./settings');
const { AppError } = require('../middleware/errors');

/** Tamanho alvo de um lote de texto. Cerca de 10 questões de prova. */
const BATCH_CHARS = 12_000;
/** Teto absoluto: sem marca de questão no texto, o lote não pode crescer sem fim. */
const BATCH_MAX_CHARS = 18_000;
const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 6000;
const RETRY_MAX_TOKENS = 10_000;
/** Texto de prova maior que isto quase certamente não é uma prova. */
const MAX_DOCUMENT_CHARS = 4_000_000;

const LETRAS = ['A', 'B', 'C', 'D', 'E'];

/**
 * Começo de questão numerada, nos formatos que as provas usam:
 *   "QUESTÃO 42", "Questão 42", "42.", "42)", "42 -"
 * Sempre no início da linha — um "42." no meio de um parágrafo é outra coisa.
 */
const INICIO_DE_QUESTAO = /^[ \t]*(?:QUEST(?:ÃO|AO)[ \t]*)?(\d{1,3})[ \t]*[.)\-–—]?[ \t]*$|^[ \t]*(?:QUEST(?:ÃO|AO)[ \t]*)(\d{1,3})\b/gim;

/** Posições onde uma questão começa, com o número que a encabeça. */
function questionMarks(text) {
  const marks = [];
  INICIO_DE_QUESTAO.lastIndex = 0;
  let match = INICIO_DE_QUESTAO.exec(text);
  while (match) {
    const numero = Number.parseInt(match[1] || match[2], 10);
    if (Number.isInteger(numero) && numero > 0 && numero <= 300) {
      marks.push({ index: match.index, number: numero });
    }
    match = INICIO_DE_QUESTAO.exec(text);
  }
  return marks;
}

/**
 * Recorta o próximo lote a partir de `cursor`, terminando sempre no começo de
 * uma questão — nunca no meio de um enunciado.
 *
 * @returns {{ text: string, start: number, end: number, first_number: number|null, last_number: number|null }|null}
 */
function nextBatch(document, cursor = 0) {
  const texto = String(document || '');
  const inicio = Math.max(0, Math.min(cursor, texto.length));
  if (inicio >= texto.length) return null;

  const resto = texto.slice(inicio);
  const marks = questionMarks(resto);

  // Sem nenhuma marca de questão adiante: leva um lote de tamanho fixo e segue.
  if (marks.length < 2) {
    const fim = Math.min(resto.length, BATCH_MAX_CHARS);
    return {
      text: resto.slice(0, fim),
      start: inicio,
      end: inicio + fim,
      first_number: marks.length ? marks[0].number : null,
      last_number: marks.length ? marks[0].number : null,
    };
  }

  // Última marca que ainda cabe no lote; pelo menos uma questão inteira sai.
  let corte = marks[marks.length - 1].index;
  for (let i = 1; i < marks.length; i += 1) {
    if (marks[i].index > BATCH_CHARS) {
      corte = marks[i].index;
      break;
    }
  }
  if (corte > BATCH_MAX_CHARS) corte = Math.min(corte, BATCH_MAX_CHARS);
  if (corte <= 0) corte = Math.min(resto.length, BATCH_MAX_CHARS);

  const trecho = resto.slice(0, corte);
  const dentro = marks.filter((m) => m.index < corte);
  return {
    text: trecho,
    start: inicio,
    end: inicio + corte,
    first_number: dentro.length ? dentro[0].number : null,
    last_number: dentro.length ? dentro[dentro.length - 1].number : null,
  };
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

/**
 * Matérias e assuntos que a IA pode usar para classificar, em uma linha cada.
 * Quando a prova é conhecida, só o que cai nela — a lista inteira são 300
 * assuntos, e mandar tudo em cada lote é caro e piora a escolha.
 */
async function taxonomy(examId) {
  const rows = await db.many(
    examId
      ? `SELECT s.slug AS subject_slug, s.name AS subject_name, t.slug AS topic_slug, t.name AS topic_name
           FROM topics t
           JOIN subjects s ON s.id = t.subject_id AND s.active
           JOIN exam_topics et ON et.topic_id = t.id AND et.exam_id = $1
          WHERE t.active
          ORDER BY s.sort_order, t.sort_order`
      : `SELECT s.slug AS subject_slug, s.name AS subject_name, t.slug AS topic_slug, t.name AS topic_name
           FROM topics t
           JOIN subjects s ON s.id = t.subject_id AND s.active
          WHERE t.active
          ORDER BY s.sort_order, t.sort_order`,
    examId ? [examId] : []
  );
  // Prova sem conteúdo programático cadastrado: melhor a lista inteira que
  // lista nenhuma, senão a IA inventa slug.
  if (!rows.length && examId) return taxonomy(null);
  return rows;
}

// ---------------------------------------------------------------------------
// Extração
// ---------------------------------------------------------------------------

/** Monta o prompt de transcrição de um lote da prova. */
function buildExtractPrompt({ batch, exam, year, board, catalog, answerKey }) {
  const system = [
    'Você transcreve questões de provas brasileiras já aplicadas para um banco de questões.',
    'Você NÃO inventa questão, NÃO reescreve enunciado e NÃO cria alternativa: copia o que está no texto,',
    'corrigindo apenas quebras de linha e hifenização que a conversão do PDF introduziu.',
    'Se uma questão estiver incompleta no trecho recebido, omita-a — ela virá no próximo trecho.',
    'Responda somente com um objeto JSON válido, sem nenhum texto fora do JSON.',
  ].join(' ');

  const lines = [];
  if (exam) lines.push(`Prova: ${exam.name}${exam.board ? ` — banca ${exam.board}` : ''}`);
  if (board) lines.push(`Banca: ${board}`);
  if (year) lines.push(`Ano: ${year}`);
  lines.push('');
  lines.push('Classifique cada questão usando EXATAMENTE um destes pares de identificadores:');
  for (const row of catalog) {
    lines.push(`- ${row.subject_slug} / ${row.topic_slug} — ${row.subject_name}: ${row.topic_name}`);
  }
  lines.push('');
  if (answerKey && Object.keys(answerKey).length) {
    lines.push('Gabarito oficial (número da questão → letra). Use SEMPRE esta letra como correta:');
    lines.push(
      Object.entries(answerKey)
        .map(([numero, letra]) => `${numero}=${letra}`)
        .join(' ')
    );
    lines.push('');
  }
  lines.push('Devolva um JSON exatamente com esta estrutura:');
  lines.push('{');
  lines.push('  "questions": [');
  lines.push('    {');
  lines.push('      "number": 42,');
  lines.push('      "statement": "o enunciado completo, com o texto de apoio quando houver",');
  lines.push('      "A": "texto da alternativa A", "B": "…", "C": "…", "D": "…", "E": "…",');
  lines.push('      "correct": "C",');
  lines.push('      "subject_slug": "matematica",');
  lines.push('      "topic_slug": "porcentagem",');
  lines.push('      "difficulty": 2,');
  lines.push('      "answer_source": "gabarito"');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('Regras obrigatórias:');
  lines.push('- "number" é o número da questão na prova, como aparece no texto.');
  lines.push('- Alternativas de A a E, no texto original. Questão com menos de duas alternativas: omita.');
  lines.push('- "answer_source": "gabarito" quando a letra veio da lista acima; "deduzida" quando você teve que resolver.');
  lines.push('- "difficulty": 1 fácil, 2 média, 3 difícil.');
  lines.push('- Enunciado com imagem indispensável (gráfico, mapa, figura) que não está no texto: omita a questão.');
  lines.push('- Não traduza, não resuma e não corrija o português da prova.');
  lines.push('');
  lines.push('Trecho da prova:');
  lines.push('---');
  lines.push(batch);
  lines.push('---');

  const user = lines.join('\n');
  return {
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());

/** Confere o que a IA devolveu e devolve a linha pronta para a conferência. */
function normalizeExtracted(raw, { answerKey, exam, year, board }) {
  const statement = text(raw && raw.statement);
  if (statement.length < 20) return null;

  const numero = Number.parseInt(raw && raw.number, 10);
  const number = Number.isInteger(numero) && numero > 0 ? numero : null;

  const options = {};
  let alternativas = 0;
  for (const letra of LETRAS) {
    const valor = text(raw && raw[letra]);
    if (valor) {
      options[letra] = valor;
      alternativas += 1;
    }
  }
  if (alternativas < 2) return null;

  // O gabarito oficial manda. A letra que a IA deduziu só vale quando não há
  // gabarito — e aí o item vai marcado para conferência.
  const oficial = answerKey && number !== null ? text(answerKey[String(number)]).toUpperCase() : '';
  const deduzida = text(raw && raw.correct).toUpperCase();
  const correct = LETRAS.includes(oficial) ? oficial : LETRAS.includes(deduzida) ? deduzida : '';
  if (!correct || !options[correct]) return null;

  const dificuldade = Number.parseInt(raw && raw.difficulty, 10);

  return {
    number,
    statement,
    ...options,
    correct,
    subject_slug: text(raw && raw.subject_slug),
    topic_slug: text(raw && raw.topic_slug),
    difficulty: dificuldade >= 1 && dificuldade <= 3 ? dificuldade : 2,
    year: year || null,
    board: board || (exam ? exam.board : null) || null,
    source: exam ? `${exam.name}${year ? ` ${year}` : ''}` : null,
    // De onde saiu a resposta. É o que decide se o item pode entrar em lote.
    answer_from_key: LETRAS.includes(oficial),
  };
}

/**
 * Transcreve um lote da prova.
 * @returns {Promise<Array<object>>} linhas no formato da importação de questões
 */
async function extract({ batch, exam, year, board, answerKey, userId }) {
  const catalog = await taxonomy(exam ? exam.id : null);
  const { messages } = buildExtractPrompt({ batch: batch.text, exam, year, board, catalog, answerKey });
  const model = (await getSetting('openrouter_model')) || undefined;

  // Cada tentativa com o próprio relógio: um controlador só para as duas faz a
  // retentativa nascer abortada (ver services/essay.js).
  let estourou = false;
  const comPrazo = async (executar) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      estourou = true;
      controller.abort();
    }, TIMEOUT_MS);
    try {
      return await executar(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  let result;
  try {
    result = await ai.json({
      messages,
      model,
      // Transcrição, não criação: criatividade aqui é erro.
      temperature: 0.1,
      maxTokens: MAX_TOKENS,
      retryMaxTokens: RETRY_MAX_TOKENS,
      userId,
      feature: 'exam_import',
      timeoutMs: TIMEOUT_MS,
      runWithSignal: comPrazo,
    });
  } catch (err) {
    if (estourou) {
      throw new AppError(503, 'ai_unavailable', 'A leitura deste trecho demorou demais. Tente continuar de onde parou.');
    }
    throw err;
  }

  const brutas = Array.isArray(result.data && result.data.questions) ? result.data.questions : [];
  return brutas.map((raw) => normalizeExtracted(raw, { answerKey, exam, year, board })).filter(Boolean);
}

/**
 * Converte um link do Google Drive no endereço que devolve o arquivo.
 *
 * O cliente guarda as provas no Drive e cola o link de compartilhamento —
 * que abre o visualizador, não o PDF. Sem esta conversão, a leitura recebia
 * uma página HTML e dizia que o arquivo não tinha texto, o que manda
 * investigar o lugar errado.
 *
 * Formatos aceitos:
 *   https://drive.google.com/file/d/<ID>/view?usp=sharing
 *   https://drive.google.com/open?id=<ID>
 *   https://docs.google.com/document/d/<ID>/edit
 *
 * @returns {string} o endereço direto, ou o original quando não é do Drive
 */
function directDownloadUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\/(drive|docs)\.google\.com\//i.test(url)) return url;

  const porCaminho = url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  const porParametro = url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id = (porCaminho && porCaminho[1]) || (porParametro && porParametro[1]);
  if (!id) return url;

  // `confirm=t` pula a tela de aviso que o Drive mostra em arquivo grande.
  return `https://drive.google.com/uc?export=download&id=${id}&confirm=t`;
}

/** O endereço aponta para o Google Drive? (muda a mensagem de erro) */
function isDriveUrl(value) {
  return /^https?:\/\/(drive|docs)\.google\.com\//i.test(String(value || '').trim());
}

/**
 * Lê um gabarito colado pelo administrador.
 * Aceita "1-A 2-B", "1) C", "01 D", um por linha ou tudo na mesma linha.
 * @returns {{ key: object, count: number }}
 */
function parseAnswerKey(input) {
  const key = {};
  const bruto = String(input || '');
  const padrao = /(\d{1,3})\s*[).:\-–—=]?\s*([A-Ea-e])(?![A-Za-z])/g;
  let match = padrao.exec(bruto);
  while (match) {
    const numero = Number.parseInt(match[1], 10);
    if (Number.isInteger(numero) && numero > 0 && numero <= 300) key[String(numero)] = match[2].toUpperCase();
    match = padrao.exec(bruto);
  }
  return { key, count: Object.keys(key).length };
}

module.exports = {
  BATCH_CHARS,
  BATCH_MAX_CHARS,
  MAX_DOCUMENT_CHARS,
  LETRAS,
  questionMarks,
  nextBatch,
  taxonomy,
  buildExtractPrompt,
  normalizeExtracted,
  extract,
  parseAnswerKey,
  directDownloadUrl,
  isDriveUrl,
};

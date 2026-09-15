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

/**
 * Tamanho alvo de um lote de texto. Cerca de cinco questões de prova.
 *
 * Medido em produção com a prova do ENEM: um lote de 12 mil caracteres gastava
 * 17,8 mil tokens e passava de 100 segundos — mais do que a borda da hospedagem
 * deixa uma requisição durar. O resultado era o pior possível: o modelo
 * respondia, a resposta era paga, e a conexão já tinha caído. Enunciado de
 * ENEM é longo (texto de apoio, citação), então é a SAÍDA que manda no tempo.
 */
const BATCH_CHARS = 18_000;
/** Teto absoluto: sem marca de questão no texto, o lote não pode crescer sem fim. */
const BATCH_MAX_CHARS = 30_000;
/**
 * Prazo da chamada.
 *
 * Era de 80 segundos porque a varredura acontecia dentro da requisição HTTP, e
 * a borda da hospedagem derruba antes disso. Agora o trabalho roda solto (ver
 * routes/admin/exam-imports.js): ninguém está esperando do outro lado, então o
 * prazo pode ser o que a transcrição realmente precisa. Com 80 segundos, o
 * modelo era interrompido no meio de trechos legítimos — e o trecho voltava
 * para a fila sem nada gravado, depois de já ter sido pago.
 */
const TIMEOUT_MS = 420_000;
/**
 * Teto da resposta.
 *
 * Apertei isto quando a varredura corria dentro da requisição e precisava
 * caber antes da borda desistir. Com o trabalho solto, o limite virou o
 * problema: questão do ENEM tem texto de apoio, citação e cinco alternativas,
 * e três delas transcritas passam com folga de 2.200 tokens. O resultado,
 * medido em produção, foi "a resposta da IA foi cortada antes de terminar" —
 * a transcrição inteira paga e jogada fora por falta de espaço para terminar.
 */
const MAX_TOKENS = 6000;
const RETRY_MAX_TOKENS = 12_000;
/** A classificação devolve poucas palavras por item, sem repetir a prova. */
const CLASSIFY_MAX_TOKENS = 1800;
const CLASSIFY_RETRY_MAX_TOKENS = 3600;
/** Teto de questões por lote, para a resposta não crescer além do prazo. */
const MAX_QUESTOES_POR_LOTE = 12;
/** Texto de prova maior que isto quase certamente não é uma prova. */
const MAX_DOCUMENT_CHARS = 4_000_000;

const LETRAS = ['A', 'B', 'C', 'D', 'E'];

/**
 * Alternativa como aparece depois da extração do PDF.
 *
 * O círculo com a letra usado pelo ENEM 2022/2023 vira "AA", "BB" etc. A
 * Vunesp e a FGV usam "(A)". Provas de outros anos chegam como "A texto".
 */
function alternativeMarker(line) {
  const value = String(line || '');
  const patterns = [
    /^\s*\(([A-E])\)\s*(.*)$/,
    /^\s*([A-E])\1\s+(.*)$/,
    /^\s*([A-E])[).:\-–—]\s*(.*)$/,
    /^\s*([A-E])\s+(.*)$/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return { letter: match[1], text: match[2] || '' };
  }
  return null;
}

/** Última sequência A, B, C, D, E do bloco: as ocorrências anteriores podem ser prosa. */
function alternativeSequence(lines) {
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = alternativeMarker(lines[index]);
    if (marker) candidates.push({ ...marker, index });
  }

  for (let end = candidates.length - 1; end >= 0; end -= 1) {
    if (candidates[end].letter !== 'E') continue;
    const sequence = { E: candidates[end] };
    let cursor = end - 1;
    let complete = true;
    for (const letter of ['D', 'C', 'B', 'A']) {
      while (cursor >= 0 && candidates[cursor].letter !== letter) cursor -= 1;
      if (cursor < 0) {
        complete = false;
        break;
      }
      sequence[letter] = candidates[cursor];
      cursor -= 1;
    }
    if (complete) {
      // Onde a alternativa E termina. O texto de apoio da próxima questão vem
      // no PDF logo depois da E, separado por uma linha em branco. Sem essa
      // separação (questão sem texto de apoio adiante), a E vai até o fim do
      // bloco — o mesmo que o parser sempre fez.
      let fim = lines.length;
      for (let i = sequence.E.index + 1; i < lines.length; i += 1) {
        if (!String(lines[i]).trim()) {
          fim = i;
          break;
        }
      }
      sequence.E.end = fim;
      return sequence;
    }
  }
  return null;
}

/** Cabeçalhos e rodapés que o PDF intercala no fim da alternativa E. */
function isPdfNoise(line) {
  const value = String(line || '').trim();
  return (
    !value ||
    /^Confidencial até o momento da aplicação\.?$/i.test(value) ||
    /^\d*[A-Z]{2,}[A-Za-z0-9-]*\d{3,}\s*\|/.test(value) ||
    /^APMBB\s+CFO\s+PM-SP\s+\d{4}$/i.test(value) ||
    /^(?:LC|CH|CN|MT)\s*-\s*\d[^a-z]*$/i.test(value) ||
    /^Caderno de Questões[^a-z]*$/i.test(value)
  );
}

/** Junta linhas quebradas pelo PDF e remove caracteres de fonte corrompida. */
function joinPdfLines(lines) {
  let result = '';
  for (const raw of lines) {
    const line = String(raw || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (isPdfNoise(line)) continue;
    if (!result) {
      result = line;
      continue;
    }
    // "transfor-" + "mação" é hifenização de fim de linha do PDF.
    if (/[-‐‑]$/.test(result) && /^[a-zà-ÿ]/i.test(line)) result = `${result.slice(0, -1)}${line}`;
    else result += ` ${line}`;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Transcreve uma questão sem IA. O texto e as alternativas já estão no PDF;
 * repetir tudo na resposta do modelo só aumentava custo, tempo e truncamento.
 */
function parseQuestionBlock(block, number = null) {
  const lines = String(block || '').split(/\r?\n/);
  const sequence = alternativeSequence(lines);
  if (!sequence) return null;

  const statement = joinPdfLines(lines.slice(0, sequence.A.index));
  if (statement.length < 20) return null;

  const parsed = { number, statement };
  for (let index = 0; index < LETRAS.length; index += 1) {
    const letter = LETRAS[index];
    const marker = sequence[letter];
    const next = index + 1 < LETRAS.length ? sequence[LETRAS[index + 1]].index : sequence.E.end;
    const option = joinPdfLines([marker.text, ...lines.slice(marker.index + 1, next)]);
    if (!option) return null;
    parsed[letter] = option;
  }
  // O que vem DEPOIS da alternativa E não pertence a esta questão: em prova de
  // linguagens é o texto de apoio (poema, trecho, tirinha) da PRÓXIMA questão,
  // que no PDF fica acima do "QUESTÃO XX" seguinte. parseBatchQuestions cola
  // esse trecho no enunciado da questão a que ele se refere.
  parsed.trailer = joinPdfLines(lines.slice(sequence.E.end));
  return parsed;
}

/**
 * Começo de questão numerada, nos formatos que as provas usam:
 *   "QUESTÃO 42", "Questão 42", "42.", "42)", "42 -"
 * Sempre no início da linha — um "42." no meio de um parágrafo é outra coisa.
 */
const INICIO_DE_QUESTAO = /^[ \t]*(?:(?:QUEST(?:ÃO|AO)[ \t]*)(\d{1,3})[ \t]*[.)\-–—]?[ \t]*|(\d{1,3})(?:[.)]|[ \t]+-)[ \t]*)$/gim;

/** Posições onde uma questão começa, com o número que a encabeça. */
function questionMarks(text) {
  const marks = [];
  INICIO_DE_QUESTAO.lastIndex = 0;
  let match = INICIO_DE_QUESTAO.exec(text);
  while (match) {
    const numero = Number.parseInt(match[1] || match[2], 10);
    if (Number.isInteger(numero) && numero > 0 && numero <= 300) {
      marks.push({ index: match.index, header_end: INICIO_DE_QUESTAO.lastIndex, number: numero });
    }
    match = INICIO_DE_QUESTAO.exec(text);
  }
  if (marks.length) return marks;

  // Vunesp/FGV: o cabeçalho é só "01" ou "1". Um número isolado também pode
  // ser página ou dado de gráfico, então ele só vira marca quando o trecho até
  // o próximo número contém uma sequência completa de alternativas (A) a (E).
  const candidates = [];
  const bare = /^[ \t]*0*(\d{1,3})[ \t]*$/gm;
  let bareMatch = bare.exec(text);
  while (bareMatch) {
    const number = Number.parseInt(bareMatch[1], 10);
    if (number > 0 && number <= 300) {
      candidates.push({ index: bareMatch.index, header_end: bare.lastIndex, number });
    }
    bareMatch = bare.exec(text);
  }

  return candidates.filter((candidate, index) => {
    const end = index + 1 < candidates.length ? candidates[index + 1].index : text.length;
    return Boolean(parseQuestionBlock(text.slice(candidate.header_end, end), candidate.number));
  });
}

/** Questões completas encontradas no lote, já com enunciado e alternativas. */
function parseBatchQuestions(batch) {
  const source = String(batch || '');
  const marks = questionMarks(source);
  const questions = [];
  // Texto de apoio que sobrou depois da alternativa E da questão anterior: no
  // PDF ele fica acima do "QUESTÃO XX" seguinte, então pertence a esta questão.
  // O que vem antes da primeira marca é o apoio da primeira questão do lote.
  let apoioPendente = marks.length ? joinPdfLines(source.slice(0, marks[0].index).split(/\r?\n/)) : '';
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const end = index + 1 < marks.length ? marks[index + 1].index : source.length;
    const parsed = parseQuestionBlock(source.slice(mark.header_end, end), mark.number);
    if (parsed) {
      const trailer = parsed.trailer || '';
      delete parsed.trailer;
      if (apoioPendente) parsed.statement = `${apoioPendente}\n\n${parsed.statement}`;
      apoioPendente = trailer;
      questions.push(parsed);
    } else {
      // Bloco sem alternativas completas (só texto de apoio, ou questão que
      // veio partida): guarda o trecho para a próxima questão em vez de perdê-lo.
      const orfao = joinPdfLines(source.slice(mark.header_end, end).split(/\r?\n/));
      if (orfao) apoioPendente = apoioPendente ? `${apoioPendente}\n\n${orfao}` : orfao;
    }
  }
  return questions;
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

  // O lote termina na primeira marca que estoura o tamanho alvo OU que passa do
  // teto de questões — o que vier primeiro. O teto de questões importa tanto
  // quanto o de caracteres: a resposta do modelo é limitada em questões, e sem
  // cortar aqui as excedentes ficariam para trás quando o cursor avançasse.
  let corte = marks[marks.length - 1].index;
  for (let i = 1; i < marks.length; i += 1) {
    if (marks[i].index > BATCH_CHARS || i >= MAX_QUESTOES_POR_LOTE) {
      corte = marks[i].index;
      break;
    }
  }
  // O corte tem que cair EM CIMA de uma marca de questão. A primeira marca
  // adiante é marks[1] (marks[0] é o começo deste lote); se até ela o texto já
  // passou do teto, é uma questão sozinha maior que o lote — texto de apoio
  // longo. Cortar no teto partiria essa questão no meio: o pedaço inicial sai
  // incompleto (o prompt manda omitir questão incompleta) e o resto vira texto
  // órfão sem marcador no próximo lote — a questão somia inteira, sem aviso.
  // Melhor deixar UM lote maior com a questão inteira do que perdê-la.
  const tetoDuro = Math.max(BATCH_MAX_CHARS, marks[1].index);
  if (corte > tetoDuro) corte = tetoDuro;
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

const ENEM_SUBJECTS = {
  linguagens: new Set([
    'lingua-portuguesa',
    'interpretacao-de-texto',
    'gramatica',
    'literatura',
    'artes',
    'educacao-fisica',
    'ingles',
    'espanhol',
    'tic',
  ]),
  humanas: new Set(['historia', 'geografia', 'filosofia', 'sociologia']),
  natureza: new Set(['biologia', 'fisica', 'quimica']),
  matematica: new Set(['matematica']),
};

/** Área do caderno pelo número da questão; o ENEM mudou a ordem em 2017. */
function enemArea(number, year) {
  if (!Number.isInteger(number)) return null;
  if (Number(year) <= 2016) {
    if (number <= 45) return 'humanas';
    if (number <= 90) return 'natureza';
    if (number <= 135) return 'linguagens';
    return 'matematica';
  }
  if (number <= 45) return 'linguagens';
  if (number <= 90) return 'humanas';
  if (number <= 135) return 'natureza';
  return 'matematica';
}

/**
 * Em um caderno do ENEM, o número já informa a grande área. Mandar os assuntos
 * das quatro áreas em toda chamada desperdiçava quase tanto quanto a questão.
 */
function relevantCatalog(catalog, questions, { exam, year }) {
  if (!exam || !/ENEM/i.test(String(exam.name || ''))) return catalog;
  const subjects = new Set();
  for (const question of questions) {
    const area = enemArea(Number(question.number), year);
    if (!area) continue;
    for (const slug of ENEM_SUBJECTS[area]) subjects.add(slug);
  }
  if (!subjects.size) return catalog;
  const filtered = catalog.filter((row) => subjects.has(row.subject_slug));
  return filtered.length ? filtered : catalog;
}

// ---------------------------------------------------------------------------
// Extração
// ---------------------------------------------------------------------------

function clipped(value, max = 2200) {
  const content = text(value).replace(/\s+/g, ' ');
  if (content.length <= max) return content;
  const side = Math.floor((max - 5) / 2);
  return `${content.slice(0, side)} […] ${content.slice(-side)}`;
}

/** Prompt compacto: o modelo classifica; não precisa devolver o PDF inteiro. */
function buildClassificationPrompt({ questions, exam, year, board, catalog, answerKey }) {
  const system = [
    'Você classifica questões de provas brasileiras por matéria, assunto e dificuldade.',
    'O texto já foi transcrito pelo sistema: NÃO o copie e NÃO o reescreva.',
    'Use somente os identificadores fornecidos e responda apenas com JSON válido.',
  ].join(' ');

  const lines = [];
  if (exam) lines.push(`Prova: ${exam.name}${exam.board ? ` — banca ${exam.board}` : ''}`);
  if (board) lines.push(`Banca: ${board}`);
  if (year) lines.push(`Ano: ${year}`);
  lines.push('');
  lines.push('Pares permitidos (matéria / assunto):');
  for (const row of catalog) {
    lines.push(`- ${row.subject_slug} / ${row.topic_slug} — ${row.subject_name}: ${row.topic_name}`);
  }
  lines.push('');
  lines.push('Devolva exatamente:');
  lines.push('{"classifications":[{"item":1,"subject_slug":"...","topic_slug":"...","difficulty":2,"correct":"C"}]}');
  lines.push('Regras:');
  lines.push('- Uma classificação para cada ITEM, mantendo o número de item recebido.');
  lines.push('- subject_slug e topic_slug devem formar exatamente um dos pares permitidos.');
  lines.push('- difficulty: 1 fácil, 2 média, 3 difícil.');
  lines.push('- Resolva cada questão e informe correct com uma letra de A a E.');
  if (answerKey && Object.keys(answerKey).length) {
    // Pedir a letra mesmo com gabarito custa um caractere por item e salva as
    // questões cujo número não aparece no gabarito — o que acontece sempre que
    // a conversão do PDF embaralha a numeração de uma prova de duas colunas.
    lines.push('- O gabarito oficial prevalece; a sua letra só é usada nas questões que faltarem nele.');
  }
  lines.push('');

  questions.forEach((question, index) => {
    lines.push(`ITEM ${index + 1} | questão ${question.number || 'sem número'}`);
    lines.push(`Enunciado: ${clipped(question.statement)}`);
    for (const letter of LETRAS) lines.push(`${letter}: ${clipped(question[letter], 650)}`);
    lines.push('');
  });

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

/** Casa a resposta da IA com o item pelo índice, sem confiar em número repetido da prova. */
function mergeClassifications(questions, raw, catalog) {
  const rows = Array.isArray(raw && raw.classifications) ? raw.classifications : [];
  const byItem = new Map();
  rows.forEach((row, index) => {
    const item = Number.parseInt(row && row.item, 10);
    byItem.set(Number.isInteger(item) && item > 0 ? item : index + 1, row || {});
  });

  const pairs = new Map(catalog.map((row) => [`${row.subject_slug}/${row.topic_slug}`, row]));
  const topics = new Map();
  for (const row of catalog) {
    const current = topics.get(row.topic_slug);
    topics.set(row.topic_slug, current === undefined ? row : null);
  }

  // Questão sem classificação NÃO é descartada.
  //
  // O enunciado e as alternativas já foram transcritos aqui, de forma
  // determinística, antes de qualquer chamada de IA. Jogar tudo fora porque o
  // modelo pulou o item, ou porque ele inventou um par matéria/assunto que não
  // existe, era perder a questão inteira sem deixar rastro: ela não virava nem
  // item de conferência. Numa prova de 80, sobravam 36. Agora ela fica, marcada
  // como pendente de classificação, e aparece em "A conferir".
  return questions.map((question, index) => {
    const classification = byItem.get(index + 1) || {};
    let pair = pairs.get(`${text(classification.subject_slug)}/${text(classification.topic_slug)}`);
    // O assunto é único na taxonomia na maioria dos casos. Se o modelo acertou
    // o assunto e só repetiu a matéria errada, corrigimos sem outra chamada.
    if (!pair) pair = topics.get(text(classification.topic_slug));
    return {
      ...question,
      subject_slug: pair ? pair.subject_slug : '',
      topic_slug: pair ? pair.topic_slug : '',
      difficulty: classification.difficulty,
      correct: classification.correct,
    };
  });
}

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
  lines.push(`- Transcreva no máximo ${MAX_QUESTOES_POR_LOTE} questões. Se houver mais no trecho, transcreva as primeiras e pare.`);
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
  const escolhida = LETRAS.includes(oficial) ? oficial : LETRAS.includes(deduzida) ? deduzida : '';
  // Sem resposta conhecida a questão continua valendo como item de conferência:
  // o enunciado e as alternativas já estão transcritos, só falta a letra, e o
  // painel deixa o administrador marcá-la. Descartar aqui apagava a questão da
  // prova inteira — inclusive quando o gabarito oficial existia mas não trazia
  // aquele número, caso comum em prova de duas colunas, em que a numeração sai
  // embaralhada da conversão do PDF.
  const correct = escolhida && options[escolhida] ? escolhida : '';

  const dificuldade = Number.parseInt(raw && raw.difficulty, 10);

  return {
    number,
    statement,
    ...options,
    correct,
    subject_slug: text(raw && raw.subject_slug),
    topic_slug: text(raw && raw.topic_slug),
    // O que ainda falta nesta questão, para a tela de conferência dizer o que
    // fazer em vez de só mostrar um item quebrado.
    needs_topic: !text(raw && raw.topic_slug),
    needs_answer: !correct,
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
  // Transcrição aceita um modelo mais simples e rápido que o do tutor. Fica
  // configurável porque é aqui que o tempo de cada lote se decide.
  const model = (await getSetting('openrouter_extract_model')) || (await getSetting('openrouter_model')) || undefined;

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

  const callJson = ({ messages, maxTokens, retryMaxTokens }) =>
    ai.json({
      messages,
      model,
      temperature: 0.1,
      maxTokens,
      retryMaxTokens,
      userId,
      feature: 'exam_import',
      timeoutMs: TIMEOUT_MS,
      runWithSignal: comPrazo,
    });

  try {
    const parsed = parseBatchQuestions(batch.text).slice(0, MAX_QUESTOES_POR_LOTE);
    if (parsed.length) {
      const compactCatalog = relevantCatalog(catalog, parsed, { exam, year });
      const { messages } = buildClassificationPrompt({
        questions: parsed,
        exam,
        year,
        board,
        catalog: compactCatalog,
        answerKey,
      });
      const result = await callJson({
        messages,
        maxTokens: CLASSIFY_MAX_TOKENS,
        retryMaxTokens: CLASSIFY_RETRY_MAX_TOKENS,
      });
      const itens = mergeClassifications(parsed, result.data, compactCatalog);

      // Uma segunda passada só com o que ficou sem assunto. O modelo costuma
      // pular itens no fim da lista, ou responder um par que não existe no
      // catálogo; perguntar de novo, com menos itens de cada vez, recupera a
      // maioria — e é mais barato que deixar a questão esperando conferência
      // manual, que é o destino de quem sai daqui sem classificação.
      const pendentes = [];
      itens.forEach((item, index) => {
        if (!item.topic_slug) pendentes.push(index);
      });
      if (pendentes.length && pendentes.length < parsed.length) {
        try {
          const segundos = pendentes.map((index) => parsed[index]);
          const { messages: outraVez } = buildClassificationPrompt({
            questions: segundos,
            exam,
            year,
            board,
            catalog: compactCatalog,
            answerKey,
          });
          const repescagem = await callJson({
            messages: outraVez,
            maxTokens: CLASSIFY_MAX_TOKENS,
            retryMaxTokens: CLASSIFY_RETRY_MAX_TOKENS,
          });
          mergeClassifications(segundos, repescagem.data, compactCatalog).forEach((corrigido, ordem) => {
            if (corrigido.topic_slug) itens[pendentes[ordem]] = corrigido;
          });
        } catch (err) {
          // A repescagem é bônus: falhar aqui não pode derrubar o lote inteiro.
          console.warn(`[exam-import] repescagem de classificação falhou: ${err.message}`);
        }
      }

      return itens.map((raw) => normalizeExtracted(raw, { answerKey, exam, year, board })).filter(Boolean);
    }

    // Reserva para arquivo fora dos padrões conhecidos. É mais caro porque o
    // modelo precisa devolver a transcrição, mas mantém compatibilidade com
    // provas coladas pelo administrador em formatos incomuns.
    const { messages } = buildExtractPrompt({ batch: batch.text, exam, year, board, catalog, answerKey });
    const result = await callJson({ messages, maxTokens: MAX_TOKENS, retryMaxTokens: RETRY_MAX_TOKENS });
    const rawQuestions = Array.isArray(result.data && result.data.questions) ? result.data.questions : [];
    return rawQuestions
      .slice(0, MAX_QUESTOES_POR_LOTE)
      .map((raw) => normalizeExtracted(raw, { answerKey, exam, year, board }))
      .filter(Boolean);
  } catch (err) {
    if (estourou) {
      throw new AppError(503, 'ai_unavailable', 'A leitura deste trecho demorou demais. Tente continuar de onde parou.');
    }
    throw err;
  }

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
  // Um par número→letra só vale com um separador EXPLÍCITO entre eles, ou com a
  // letra colada ao número. Sem essa exigência, prosa comum de folha de
  // gabarito virava resposta: "questões 46 a 90" dava 46=A, "itens 3 e 4" dava
  // 3=E, "questões 5 e 17 anuladas" dava 5=E — porque em português "a" e "e"
  // são letras válidas e o separador era opcional. Esses fantasmas iam para o
  // banco marcados como gabarito oficial, e a questão chegava ao aluno com a
  // resposta errada. Formatos reais de gabarito têm separador: "46-A", "46) A",
  // "46.A", "01 A" com dois espaços no máximo, ou "46A".
  const padrao = /(\d{1,3})(?:\s*[).:\-–—=]\s*|\s{0,2})([A-E])(?![A-Za-z])/g;
  let match = padrao.exec(bruto);
  while (match) {
    // Descarta o par cujo "separador" foi só espaço quando a letra é 'a'/'e'
    // minúscula grudada em palavra — mas como agora exigimos [A-E] MAIÚSCULO
    // após espaço, "46 a 90" (minúsculo) já não casa. Mantém-se robusto.
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
  MAX_QUESTOES_POR_LOTE,
  TIMEOUT_MS,
  LETRAS,
  questionMarks,
  alternativeMarker,
  parseQuestionBlock,
  parseBatchQuestions,
  nextBatch,
  taxonomy,
  relevantCatalog,
  buildClassificationPrompt,
  mergeClassifications,
  buildExtractPrompt,
  normalizeExtracted,
  extract,
  parseAnswerKey,
  directDownloadUrl,
  isDriveUrl,
};

'use strict';

/**
 * Leitor de provas em PDF, no servidor.
 *
 *   const { readExam } = require('./exam-reader');
 *   const prova = await readExam(buffer, { examKind: 'auto' });
 *   // → { pages, kind, questions: [...], discarded: [...], decode: [...],
 *   //     booklet_type, answer_key }  (answer_key: o gabarito que veio no
 *   //     próprio PDF, como answer-key.parseAnswerKeyLayout devolve, ou null)
 *
 * Cada questão: `{ number, variant, statement_md, alternatives: [{ letter,
 * text_md }], figures: [{ page, bbox, crop, kind, slot, png }], alerts:
 * [códigos], source_pages, regions: [{ page, x, y, w, h }] }` — `regions` é a
 * região da questão na prova, página/coluna por página/coluna. Nada é gravado aqui: quem chama decide o que vai
 * ao banco (questão sem alerta) e o que espera a conferência no painel (com
 * alerta).
 *
 * O recorte é determinístico — sem IA. As etapas:
 *   layout.js     PDF → texto com posição, imagens, desenhos (página por página)
 *   decode.js     fonte embaralhada → texto (ou alerta 'texto_ilegivel')
 *   structure.js  borda, colunas, linhas, marcas, variantes de idioma
 *   figures.js    figuras (imagem, desenho, tabela) e o texto que é delas
 *   questions.js  região, enunciado, alternativas, apoio compartilhado, alertas
 *   figures.js    recorte de cada figura renderizado em PNG (escala 2)
 *
 * Figuras no markdown: o enunciado e as alternativas trazem o marcador
 * `![Figura](figura:N)` / `![Alternativa A](figura:N)`, onde N é o índice em
 * `figures` da própria questão; quem grava sobe o `png` e troca o marcador
 * pela URL.
 */
const { openPdf, extractLayout, ReaderUnavailableError, InvalidPdfError } = require('./layout');
const { decodeLayout } = require('./decode');
const { analyze } = require('./structure');
const { readQuestions } = require('./questions');
const { renderFigures, renderRegions } = require('./figures');
const answerKeys = require('./answer-key');

/**
 * Gabarito que vem no próprio PDF da prova (a VUNESP põe a folha depois da
 * redação; a FGV, o comunicado com uma tabela por tipo de caderno): lido só
 * nas páginas que não são de questão, com o tipo do caderno da capa. Só vale
 * quando cobre ao menos metade das questões e quase só números de questão da
 * prova — tabela de números numa página de questão não é gabarito. Null
 * quando não há.
 */
function embeddedAnswerKey(layout, questions) {
  if (!questions.length) return null;
  const deQuestao = new Set(questions.flatMap((q) => q.source_pages || []));
  const primeira = Math.min(...deQuestao);
  // (depois da primeira questão: a capa tem lista numerada de instruções)
  const pages = (layout.pages || []).map((p) => p.page).filter((n) => n > primeira && !deQuestao.has(n));
  if (!pages.length) return null;
  const tipo = answerKeys.tipoDoCaderno(layout, Math.max(1, primeira - 1));
  const lido = answerKeys.parseAnswerKeyLayout(layout, { pages, tipo });
  const numeros = new Set(questions.map((q) => q.number));
  const chaves = Object.keys(lido.key).filter((k) => /^\d+$/.test(k)).map(Number);
  const daProva = chaves.filter((n) => numeros.has(n)).length;
  if (daProva < Math.max(10, 0.5 * numeros.size) || daProva < 0.9 * chaves.length) return null;
  return lido;
}

/**
 * Lê as questões de um layout já extraído (JSON). É o núcleo testável: os
 * testes montam layouts sintéticos e chamam isto direto, sem PDF.
 */
function readLayout(layout, { examKind = 'auto' } = {}) {
  const decode = decodeLayout(layout);
  const analysis = analyze(layout, { examKind });
  const { questions, discarded } = readQuestions(analysis);
  for (const q of questions) delete q._meta;
  const firstPage = questions.length ? Math.min(...questions.flatMap((q) => q.source_pages || [])) : 1;
  return {
    pages: (layout.pages || []).length,
    kind: analysis.kind,
    questions,
    discarded,
    decode,
    // tipo do caderno pela capa (a folha da FGV traz uma tabela por tipo)
    booklet_type: answerKeys.tipoDoCaderno(layout, Math.max(1, firstPage - 1)),
    answer_key: embeddedAnswerKey(layout, questions),
  };
}

/**
 * Lê uma prova em PDF (Buffer). Erros com `code`: 'leitor_indisponivel' (o
 * pdf.js/canvas não carregou neste servidor — caia no caminho antigo) e
 * 'pdf_invalido'. `figures: false` pula o render dos recortes (só posição).
 * `regions(q)`: as questões para as quais a região inteira também sai em PNG
 * (`q.region_png`) — a IA de visão lê as que vieram com alerta.
 */
async function readExam(buffer, { examKind = 'auto', onPage, figures = true, regions = null } = {}) {
  const doc = await openPdf(buffer);
  try {
    const layout = await extractLayout(doc, { onPage });
    const result = readLayout(layout, { examKind });
    if (figures) await renderFigures(doc, result.questions);
    if (typeof regions === 'function') await renderRegions(doc, result.questions, { which: regions });
    return result;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

module.exports = {
  readExam,
  readLayout,
  ReaderUnavailableError,
  InvalidPdfError,
};

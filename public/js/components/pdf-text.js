// =====================================================================
// Foco Elite — leitura do texto de um PDF, no navegador
//
//   import { extractPdfText, PdfSemTexto } from '../components/pdf-text.js';
//   const { text, pages } = await extractPdfText(file, (lida, total) => {…});
//
// Usado para transformar a prova em PDF em questões do banco. O texto é
// extraído AQUI, na máquina de quem está no painel, e só o texto sobe para
// o servidor. O PDF em si nunca é enviado à IA: um arquivo de 13 MB vira
// 18 MB em base64, e o contador de tokens da plataforma (services/ai.js)
// registraria isso como consumo real — o teto mensal é compartilhado com o
// Tutor e com a correção de redação, e uma leitura derrubaria os dois.
//
// Limite conhecido: PDF digitalizado (página escaneada como imagem) não tem
// camada de texto e não rende nada. Nesse caso `extractPdfText` lança
// PdfSemTexto, e a tela avisa em vez de devolver lixo.
//
// A biblioteca é o pdf.js, copiado para /vendor por scripts/vendor.js — sem
// CDN, sem dependência de produção.
// =====================================================================

const PDF_LIB = '/vendor/pdf.min.mjs';
const PDF_WORKER = '/vendor/pdf.worker.min.mjs';
/** Abaixo disso, o arquivo é imagem: não vale mandar para a IA. */
const MIN_CHARS_POR_PAGINA = 40;

let pdfjs = null;

/** O arquivo não tem camada de texto (prova digitalizada). */
export class PdfSemTexto extends Error {
  constructor(message = 'Este PDF não tem texto: parece ser um arquivo digitalizado (imagem).') {
    super(message);
    this.name = 'PdfSemTexto';
  }
}

/** Carrega o pdf.js uma vez e aponta o worker para o arquivo local. */
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(PDF_LIB);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  return pdfjs;
}

/**
 * Junta os pedaços de texto de uma página respeitando as quebras de linha que
 * o PDF declara. Sem isso, o número da questão gruda no enunciado e a divisão
 * em lotes perde a referência.
 */
function pageText(items) {
  const linhas = [];
  let atual = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    atual += item.str;
    if (item.hasEOL) {
      linhas.push(atual.trimEnd());
      atual = '';
    }
  }
  if (atual.trim()) linhas.push(atual.trimEnd());
  return linhas.join('\n');
}

/**
 * Lê o texto de um PDF.
 * @param {File|Blob|ArrayBuffer|string} source arquivo escolhido, ou URL do arquivo já enviado
 * @param {(lida: number, total: number) => void} [onProgress]
 * @returns {Promise<{ text: string, pages: number }>}
 * @throws {PdfSemTexto} quando o arquivo é digitalizado
 */
export async function extractPdfText(source, onProgress) {
  const lib = await loadPdfJs();

  let data;
  if (typeof source === 'string') data = { url: source };
  else if (source instanceof ArrayBuffer) data = { data: new Uint8Array(source) };
  else data = { data: new Uint8Array(await source.arrayBuffer()) };

  const doc = await lib.getDocument({ ...data, isEvalSupported: false }).promise;
  const paginas = [];
  try {
    for (let numero = 1; numero <= doc.numPages; numero += 1) {
      const page = await doc.getPage(numero);
      const content = await page.getTextContent();
      paginas.push(pageText(content.items));
      page.cleanup();
      if (typeof onProgress === 'function') onProgress(numero, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }

  const text = paginas.join('\n\n').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < doc.numPages * MIN_CHARS_POR_PAGINA) throw new PdfSemTexto();
  return { text, pages: doc.numPages };
}

/** Quebra o texto em pedaços que caibam no corpo aceito pelo servidor (2 MB). */
export function splitForUpload(text, size = 180_000) {
  const partes = [];
  for (let i = 0; i < text.length; i += size) partes.push(text.slice(i, i + size));
  return partes.length ? partes : [''];
}

// =====================================================================
// Foco Elite — Markdown seguro (ARCHITECTURE §6.2)
// md(text) → HTML sanitizado (marked com gfm + breaks, DOMPurify).
// mdInline(text) → versão sem parágrafos (títulos, legendas, alternativas).
// Usa window.marked e window.DOMPurify (public/vendor/*). Links externos abrem em
// nova aba com rel="noopener noreferrer".
// =====================================================================
import { raw, escapeHtml } from './ui.js';

const MARKED_OPTIONS = { gfm: true, breaks: true, async: false };

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button'],
  FORBID_ATTR: ['style', 'onerror', 'onload'],
  ALLOW_DATA_ATTR: false,
};

let hooked = false;

/**
 * Figura recortada de prova leva a largura de exibição no próprio endereço
 * (`/uploads/questoes/x.png#w=320`, ver server/services/exam-reading.js): o
 * PNG é renderizado em escala 2, e sem a largura uma fração de uma linha
 * aparecia com três linhas de altura. O fragmento não vai ao servidor.
 */
function figureWidth(node) {
  // fórmula recortada no meio da frase ("calor específico de 4,2 [fórmula] e
  // densidade"): fica na linha do texto, não num bloco próprio (o img da
  // base é display: block — ver .md img.md-formula em components.css)
  if (/^F[óo]rmula(?![\p{L}])/iu.test(node.getAttribute('alt') || '')) node.classList.add('md-formula');
  const match = /#w=(\d{1,4})$/.exec(node.getAttribute('src') || '');
  if (!match) return;
  const width = Math.min(Number(match[1]), 1600);
  if (width > 0) node.setAttribute('width', String(width));
}

let extended = false;

/** Marca em linha do leitor de provas: `abre` + conteúdo + `fecha` → <tag>. */
function marcaEmLinha(name, abre, regex, tag) {
  return {
    name,
    level: 'inline',
    start(src) {
      const i = src.indexOf(abre);
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const match = regex.exec(src);
      if (!match) return undefined;
      return { type: name, raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) {
      return `<${tag}>${this.parser.parseInline(token.tokens)}</${tag}>`;
    },
  };
}

/**
 * Formatação que o leitor de provas transcreve do PDF
 * (server/services/exam-reader/markup.js) e que o markdown comum não tem:
 * ++sublinhado++ ("a palavra sublinhada" do enunciado), ^{x} (expoente que
 * não existe como caractere: 3^{x}) e _{ij} (índice: d_{ij}). O texto do
 * leitor escapa "++", "^{" e "_" que vierem do próprio PDF.
 */
const MARCAS_DO_LEITOR = [
  marcaEmLinha('sublinhado', '++', /^\+\+(?=\S)([\s\S]*?\S)\+\+(?!\+)/, 'u'),
  marcaEmLinha('expoente', '^{', /^\^\{([^{}\n]{1,40})\}/, 'sup'),
  marcaEmLinha('indice', '_{', /^_\{([^{}\n]{1,40})\}/, 'sub'),
];

function getMarked() {
  const m = typeof window !== 'undefined' ? window.marked : null;
  if (!m) return null;
  if (!extended && typeof m.use === 'function') {
    extended = true;
    try {
      m.use({ extensions: MARCAS_DO_LEITOR });
    } catch (err) {
      console.warn('[markdown] marcas do leitor indisponíveis', err);
    }
  }
  return m;
}

function getPurify() {
  const p = typeof window !== 'undefined' ? window.DOMPurify : null;
  if (!p || typeof p.sanitize !== 'function') return null;
  if (!hooked) {
    hooked = true;
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'IMG') {
        figureWidth(node);
        return;
      }
      if (node.tagName !== 'A') return;
      const href = node.getAttribute('href') || '';
      if (!href) return;
      let external = false;
      try {
        const url = new URL(href, location.href);
        external = url.origin !== location.origin;
      } catch {
        external = false;
      }
      if (external) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else {
        node.removeAttribute('target');
        node.removeAttribute('rel');
      }
    });
  }
  return p;
}

/** Sanitiza uma string de HTML; sem DOMPurify, devolve o texto escapado. */
export function sanitize(htmlString, config = {}) {
  const purify = getPurify();
  if (!purify) return escapeHtml(htmlString);
  return purify.sanitize(String(htmlString ?? ''), { ...PURIFY_CONFIG, ...config });
}

/** Texto puro escapado com quebras de linha (usado quando as bibliotecas não estão disponíveis). */
function plainParagraphs(source) {
  return source
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Converte Markdown em HTML sanitizado. Devolve SafeHtml (pode ser interpolado em `html\`\``). */
export function md(text) {
  const source = text == null ? '' : String(text);
  if (!source.trim()) return raw('');
  const marked = getMarked();
  // sem marked ou sem DOMPurify não há como sanitizar HTML gerado: devolve texto escapado
  if (!marked || !getPurify()) return raw(plainParagraphs(source));
  let out;
  try {
    out = marked.parse(source, MARKED_OPTIONS);
  } catch (err) {
    console.warn('[markdown] falha ao interpretar', err);
    return raw(plainParagraphs(source));
  }
  return raw(sanitize(out));
}

/** Markdown em linha (sem <p>); útil em títulos, legendas e alternativas de questões. */
export function mdInline(text) {
  const source = text == null ? '' : String(text);
  if (!source.trim()) return raw('');
  const marked = getMarked();
  if (!marked || typeof marked.parseInline !== 'function' || !getPurify()) return raw(escapeHtml(source));
  let out;
  try {
    out = marked.parseInline(source, MARKED_OPTIONS);
  } catch (err) {
    console.warn('[markdown] falha ao interpretar (inline)', err);
    return raw(escapeHtml(source));
  }
  return raw(sanitize(out));
}

/** Remove a formatação e devolve texto puro (para prévias e trechos). */
export function mdToText(text, max = 0) {
  const htmlString = String(md(text));
  const tpl = document.createElement('template');
  tpl.innerHTML = htmlString;
  const plain = (tpl.content.textContent || '').replace(/\s+/g, ' ').trim();
  if (max > 0 && plain.length > max) return `${plain.slice(0, max - 1).trimEnd()}…`;
  return plain;
}

export default { md, mdInline, mdToText, sanitize };

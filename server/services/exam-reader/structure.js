'use strict';

/**
 * Estrutura da prova a partir do layout: o que é borda, quantas colunas cada
 * página tem, em que ordem se lê, onde começa cada questão.
 *
 *   const { analyze } = require('./structure');
 *   const estrutura = analyze(layout, { examKind: 'auto' });
 *   // → { kind, pages, lines, marks, essayPages, discarded }
 *
 * O leitor antigo cortava o texto corrido por expressão regular, e por isso o
 * cabeçalho, o rodapé e o código de barras caíam dentro de 49 de 90 enunciados.
 * Aqui a decisão é geométrica:
 *
 *   - borda: linha que se repete em muitas páginas na mesma altura (rodapé
 *     "LC - 1º dia | Caderno 1 - AZUL - Página 3", o código de barras, o fio do
 *     cabeçalho, o microtexto de segurança) — tudo acima do cabeçalho e abaixo
 *     do rodapé sai;
 *   - colunas: por página (o ENEM mistura páginas de duas colunas com páginas
 *     de questão de largura inteira), pelo fio separador ou pelo vão livre no
 *     meio; texto que atravessa o meio em 2+ linhas = página de coluna única;
 *   - linhas: mesma linha de base DENTRO da coluna (o vão entre colunas do
 *     VUNESP é de 14 pt — juntar por proximidade colava as duas colunas);
 *   - marcas: "QUESTÃO 12" no ENEM; no VUNESP/FGV, número sozinho em negrito na
 *     margem da coluna, aceito só se seguir a sequência;
 *   - variante de idioma: o cabeçalho "(opção inglês)"/"língua espanhola" liga
 *     a variante; número fora da faixa a desliga.
 *
 * Coordenadas como em layout.js (y cresce para baixo). Funções puras: recebem
 * o layout (JSON) e devolvem dados — testáveis sem PDF.
 */

const { FONTE_DE_SIMBOLO } = require('./decode');
const { M, MARCAS, tidyMarks } = require('./markup');

const MARCA_ENEM = /^QUEST[ÃA]O\s*0*(\d{1,3})$/i;
const NUMERO_SOZINHO = /^0*(\d{1,3})\.?$/;
const CODIGO_BARRAS = /^\*[A-Z0-9]+\*$/;
/** Cabeçalho de variante no ENEM: "Questões de 01 a 05 (opção inglês)". */
const FAIXA_IDIOMA = /quest[õo]es\s+de\s+0*(\d{1,3})\s+a\s+0*(\d{1,3})\s*\(?\s*op[çc][ãa]o\s+(ingl[êe]s|espanhol)/i;
/** Faixa de área sem idioma: "Questões de 06 a 45" — desliga a variante. */
const FAIXA_AREA = /^quest[õo]es\s+de\s+0*(\d{1,3})\s+a\s+0*(\d{1,3})\s*$/i;
/** Título de idioma no VUNESP/FGV (comparado sem espaços e em minúsculas). */
const TITULO_IDIOMA = /^(?:l[íi]ngua(?:estrangeira)?[-–:]?)?(inglesa|ingl[êe]s|espanhola|espanhol)$/;
/** Títulos de área do ENEM e de matéria em geral (só para classificar o descarte). */
const TITULO_AREA = /(TECNOLOGIAS|^CI[ÊE]NCIAS\s|^MATEM[ÁA]TICA|^LINGUAGENS|^REDA[ÇC][ÃA]O$|^CONHECIMENTOS\s)/i;
/** Página de redação (proposta, instruções, folha de rascunho). */
const PAGINA_REDACAO = /INSTRU[ÇC][ÕO]ES\s+PARA\s+A\s+REDA[ÇC][ÃA]O|PROPOSTA\s+DE\s+REDA[ÇC][ÃA]O|TEXTOS?\s+MOTIVADOR|RASCUNHO\s+DA\s+REDA|FOLHA\s+DE\s+REDA/i;

/**
 * Codificação da fonte Symbol (o pdf.js entrega os símbolos na área de uso
 * privado: U+F0B7 = código 0xB7 = •). Só o que aparece em prova.
 */
const SYMBOL_ENC = {
  0x20: ' ', 0x21: '!', 0x22: '∀', 0x23: '#', 0x24: '∃', 0x25: '%', 0x26: '&', 0x27: '∋', 0x28: '(', 0x29: ')',
  0x2a: '∗', 0x2b: '+', 0x2c: ',', 0x2d: '−', 0x2e: '.', 0x2f: '/', 0x30: '0', 0x31: '1', 0x32: '2', 0x33: '3',
  0x34: '4', 0x35: '5', 0x36: '6', 0x37: '7', 0x38: '8', 0x39: '9', 0x3a: ':', 0x3b: ';', 0x3c: '<', 0x3d: '=',
  0x3e: '>', 0x3f: '?', 0x40: '≅', 0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ',
  0x48: 'Η', 0x49: 'Ι', 0x4b: 'Κ', 0x4c: 'Λ', 0x4d: 'Μ', 0x4e: 'Ν', 0x4f: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ',
  0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x57: 'Ω', 0x58: 'Ξ', 0x59: 'Ψ', 0x5a: 'Ζ', 0x5b: '[', 0x5c: '∴', 0x5d: ']',
  0x5e: '⊥', 0x5f: '_', 0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η',
  0x69: 'ι', 0x6a: 'ϕ', 0x6b: 'κ', 0x6c: 'λ', 0x6d: 'μ', 0x6e: 'ν', 0x6f: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ',
  0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7a: 'ζ', 0x7b: '{', 0x7c: '|', 0x7d: '}',
  0x7e: '∼', 0xa2: '′', 0xa3: '≤', 0xa5: '∞', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°',
  0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•', 0xb8: '÷', 0xb9: '≠', 0xba: '≡',
  0xbb: '≈', 0xbc: '…', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉', 0xd0: '∠',
  0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xde: '⇒', 0xe5: '∑',
  0xf2: '∫',
};

/** A fonte Symbol de verdade (não "MT Extra", não "Segoe UI Symbol"). */
const FONTE_SYMBOL = /^(?:[A-Z]{6}\+)?Symbol(?:MT)?(?:[-,].*)?$/i;

/** Marcas do MT Extra que vão em cima da letra (seta de vetor). */
const ACENTO_MT_EXTRA = { 0x72: '\u20d7' };

/**
 * Fonte de símbolo (equação do MathType): o que tem tradução vira o símbolo;
 * o resto — pedaços de parêntese grande, códigos de controle de um
 * subconjunto sem nome de glifo — sai do texto e a linha fica marcada como
 * fórmula (a etapa de figuras recorta o trecho como imagem). Nunca vai
 * caractere de controle para o aluno.
 *
 * `asciiSymbol`: a fonte é a Symbol e veio com tabela de caracteres. O Word
 * grava a letra digitada ("a") com a fonte Symbol aplicada — o que aparece é
 * "α", mas a tabela diz "a" (o ENEM 2023 dia 2 tem "ângulo a" no lugar de
 * "ângulo α", e "a" já era a hipotenusa). Letra ASCII numa fonte Symbol é
 * sempre a letra grega da mesma posição.
 *
 * A seta de vetor do MT Extra vira o acento combinante (U+20D7) — `accent` —,
 * que readPage põe em cima da letra de baixo ("F" + seta = "F com seta").
 */
function cleanSymbolText(str, font, { asciiSymbol = false } = {}) {
  let formula = false;
  let accent = false;
  const extra = /MT-?Extra/i.test(font || '');
  let s = String(str).replace(/[\uf020-\uf0ff]/g, (c) => {
    const code = c.codePointAt(0) - 0xf000;
    if (extra) {
      if (code === 0x6c) return 'ℓ';
      if (ACENTO_MT_EXTRA[code]) {
        accent = true;
        return ACENTO_MT_EXTRA[code];
      }
      formula = true;
      return '';
    }
    if (SYMBOL_ENC[code]) return SYMBOL_ENC[code];
    formula = true;
    return '';
  });
  if (extra) {
    // o MT Extra com tabela de caracteres entrega o código ASCII ("l")
    s = s.replace(/[a-z]/g, (c) => {
      const code = c.charCodeAt(0);
      if (code === 0x6c) return 'ℓ';
      if (ACENTO_MT_EXTRA[code]) {
        accent = true;
        return ACENTO_MT_EXTRA[code];
      }
      return c;
    });
  } else if (asciiSymbol) {
    s = s.replace(/[A-Za-z]/g, (c) => SYMBOL_ENC[c.charCodeAt(0)] || c);
  }
  if (/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff\ufffd]/.test(s)) {
    formula = true;
    s = s.replace(/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff\ufffd]/g, '');
  }
  // só a seta (nada mais no item): é acento da letra de baixo
  if (accent && s.replace(/[\u20d0-\u20ff\s]/g, '') !== '') accent = false;
  return { str: s, formula, accent };
}

const SOBRESCRITO = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', '(': '⁽', ')': '⁾', '=': '⁼', n: 'ⁿ', i: 'ⁱ', o: 'º', a: 'ª', ' ': ' ',
};
const SUBSCRITO = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '–': '₋', '(': '₍', ')': '₎', '=': '₌',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ', ' ': ' ',
};

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/** Moda de valores arredondados (empate: o menor). */
function mode(values, step = 1) {
  const count = new Map();
  for (const v of values) {
    const k = Math.round(v / step) * step;
    count.set(k, (count.get(k) || 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [k, n] of count) {
    if (n > bestN || (n === bestN && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** Normaliza uma linha para comparar entre páginas (dígitos viram #). */
function normalizeRepeated(text) {
  return String(text || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

const isBold = (t) => (t.bold != null ? !!t.bold : /Bold|Black|Heavy|Semibold/i.test(t.font || ''));
const isItalic = (t) => (t.italic != null ? !!t.italic : /Italic|Oblique/i.test(t.font || ''));

/** Letras do bloco "alfanumérico matemático" (𝑀, 𝑥, 𝜋 do Cambria Math) viram a letra comum. */
function plainMathLetters(str) {
  return str.replace(/[\u{1d400}-\u{1d7ff}]/gu, (c) => c.normalize('NFKC'));
}

/**
 * Prepara os itens de uma página: completa campos, separa texto girado e
 * microtexto, tira as duplicatas (o ENEM 2022/2023 desenha cada letra de
 * alternativa duas vezes no mesmo lugar). `fonts`: as fontes do layout (diz
 * se a fonte tem tabela de caracteres).
 */
function preparePage(page, fonts = {}) {
  const texts = [];
  const rotated = [];
  const micro = [];
  const seen = new Set();
  for (const raw of page.texts || []) {
    if (!raw || typeof raw.str !== 'string' || raw.str === '') continue;
    const fs = Number(raw.fs) || Number(raw.h) || 10;
    const h = Number(raw.h) || fs;
    const base = raw.base != null ? Number(raw.base) : Number(raw.y) + h;
    const y = raw.y != null ? Number(raw.y) : base - h;
    const w = Number(raw.w) || 0;
    // as marcas de formatação do leitor (markup.js) nunca vêm do PDF
    const str = plainMathLetters(raw.str.replace(MARCAS, ''));
    if (str === '') continue;
    const t = { ...raw, str, x: Number(raw.x) || 0, y, w, h, base, fs, bold: isBold(raw), italic: isItalic(raw) };
    if (FONTE_DE_SIMBOLO.test(t.font || '') || /[\uf020-\uf0ff]/.test(t.str)) {
      const info = (raw.fontId && fonts[raw.fontId]) || {};
      const clean = cleanSymbolText(t.str, t.font, { asciiSymbol: FONTE_SYMBOL.test(t.font || '') && info.toUnicode !== false });
      if (clean.formula) t.formula = true;
      if (clean.accent) t.accent = true;
      // item que ficou vazio continua na linha, para a marca de fórmula não se perder
      t.str = clean.str;
    }
    t.x1 = t.x + w;
    t.cy = y + h / 2;
    if (raw.rot) {
      rotated.push(t);
      continue;
    }
    if (fs < 3) {
      micro.push(t);
      continue;
    }
    const key = `${Math.round(t.x * 2)}|${Math.round(t.y * 2)}|${t.str}`;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(t);
  }
  return {
    page: page.page,
    width: Number(page.width) || 595,
    height: Number(page.height) || 842,
    texts,
    rotated,
    micro,
    images: (page.images || []).map((im) => ({ ...im })),
    paths: (page.paths || []).map((p) => ({ ...p })),
  };
}

/** Agrupa itens em fileiras pela linha de base (sem olhar coluna) — só para achar borda. */
function rowsByBase(items, tol = 2) {
  const sorted = items.slice().sort((a, b) => a.base - b.base || a.x - b.x);
  const rows = [];
  for (const t of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.base - t.base) <= tol) {
      last.items.push(t);
      last.y0 = Math.min(last.y0, t.y);
      last.y1 = Math.max(last.y1, t.y + t.h);
    } else {
      rows.push({ base: t.base, y0: t.y, y1: t.y + t.h, items: [t] });
    }
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map((t) => t.str.trim()).filter(Boolean).join(' ');
  }
  return rows;
}

/** Itens que têm cara de marca de questão (não podem ser cabeçalho). */
function markLike(t) {
  const s = t.str.trim();
  return MARCA_ENEM.test(s) || (t.bold && NUMERO_SOZINHO.test(s));
}

/**
 * Bordas de cada página: `{ top, bottom }` — o corpo fica entre as duas.
 *
 * Elemento de borda = texto (fileira inteira), desenho ou imagem que se repete
 * na mesma altura (±4 pt) em ≥ 30% das páginas, na faixa de cima (20%) ou de
 * baixo (20%) — mais o código de barras, que é borda sempre. A marca da questão
 * no topo da coluna ("QUESTÃO 02" em y≈65 em quase toda página) também se
 * repete; por isso marca e número solto nunca contam, e a borda de cima nunca
 * passa da primeira marca da página.
 */
function detectBorders(pages) {
  const n = pages.length;
  const minPages = Math.max(2, Math.ceil(n * 0.3));
  const elems = [];
  for (const P of pages) {
    const H = P.height;
    const all = [...P.texts, ...P.micro].filter((t) => t.str.trim());
    for (const row of rowsByBase(all)) {
      const band = row.y1 < 0.2 * H ? 'top' : row.y0 > 0.8 * H ? 'bottom' : null;
      if (!band) continue;
      const barcode = row.items.some((t) => CODIGO_BARRAS.test(t.str.trim()));
      // número da página fica à esquerda nas pares e à direita nas ímpares
      const key = normalizeRepeated(row.text).replace(/^#\s+|\s+#$/g, '');
      if (!barcode) {
        if (MARCA_ENEM.test(row.text.trim())) continue;
        if (/^#\.?$/.test(key) && band === 'top') continue;
        if (key !== '#' && key.replace(/[#\s\W]/g, '').length < 3) continue;
      }
      elems.push({ page: P.page, band, y0: row.y0, y1: row.y1, key: `t|${key}`, always: barcode });
    }
    for (const p of [...P.paths, ...P.images]) {
      const y0 = p.y;
      const y1 = p.y + p.h;
      const band = y1 < 0.2 * H ? 'top' : y0 > 0.8 * H ? 'bottom' : null;
      if (!band) continue;
      // aba ou faixa decorativa na lateral não é cabeçalho nem rodapé
      if (p.x > 0.92 * P.width || p.x + p.w < 0.08 * P.width) continue;
      elems.push({ page: P.page, band, y0, y1, key: `g|${Math.round(p.x / 3)}|${Math.round(p.w / 3)}|${Math.round(p.h / 3)}` });
    }
  }
  const byKey = new Map();
  for (const e of elems) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  for (const list of byKey.values()) {
    for (const e of list) {
      if (e.always) {
        e.repeated = true;
        continue;
      }
      const pagesHit = new Set();
      for (const o of list) if (Math.abs(o.y0 - e.y0) <= 4) pagesHit.add(o.page);
      e.repeated = pagesHit.size >= minPages;
    }
  }
  const result = new Map();
  for (const P of pages) {
    const marks = P.texts.filter(markLike);
    const firstMark = marks.length ? Math.min(...marks.map((t) => t.y)) : Infinity;
    let top = 0;
    let bottom = P.height;
    for (const e of elems) {
      if (e.page !== P.page || !e.repeated) continue;
      if (e.band === 'top' && e.y1 <= firstMark + 1) top = Math.max(top, e.y1);
      if (e.band === 'bottom') bottom = Math.min(bottom, e.y0);
    }
    result.set(P.page, { top, bottom });
  }
  return result;
}

/**
 * Colunas de uma página. Devolve `[{ x0, x1 }]` (uma ou duas).
 * Sinais: fio separador vertical perto do meio; senão, o maior vão sem texto
 * entre 30% e 70% da largura. Duas ou mais linhas atravessando o meio = coluna
 * única (questão de largura inteira).
 */
function detectColumns(P, items, paths, top, bottom) {
  const W = P.width;
  const mid = W / 2;
  const bodyH = Math.max(1, bottom - top);
  const seps = paths.filter((p) => p.h > 0.35 * bodyH && p.w < 4 && Math.abs(p.x + p.w / 2 - mid) < 0.1 * W);
  const words = items.filter((t) => t.str.trim() && t.w > 0.5);
  // o fio de verdade é o mais comprido (a linha tracejada de cota de um
  // gráfico também é vertical e comprida, mas menor)
  const tallest = seps.length ? Math.max(...seps.map((p) => p.h)) : 0;
  const main = seps.filter((p) => p.h >= 0.85 * tallest);
  let split = main.length ? median(main.map((p) => p.x + p.w / 2)) : null;
  if (split == null) {
    const lo = Math.floor(0.3 * W);
    const hi = Math.ceil(0.7 * W);
    const cover = new Uint16Array(hi - lo + 1);
    for (const t of words) {
      const a = Math.max(lo, Math.floor(t.x));
      const b = Math.min(hi, Math.ceil(t.x1));
      for (let x = a; x <= b; x += 1) cover[x - lo] += 1;
    }
    let best = null;
    let runStart = null;
    for (let i = 0; i <= cover.length; i += 1) {
      const free = i < cover.length && cover[i] === 0;
      if (free && runStart == null) runStart = i;
      if (!free && runStart != null) {
        const len = i - runStart;
        const center = lo + runStart + len / 2;
        if (!best || len > best.len || (len === best.len && Math.abs(center - mid) < Math.abs(best.center - mid))) {
          best = { len, center };
        }
        runStart = null;
      }
    }
    split = best && best.len >= 4 ? best.center : mid;
  }
  const crossing = new Set();
  for (const t of words) {
    if (t.x < split - 8 && t.x1 > split + 8) crossing.add(Math.round(t.base / 3));
  }
  // Medido no corpus: página de duas colunas não tem NENHUMA linha atravessando
  // o vão (só capa e rascunho têm uma); a de largura inteira tem de 2 a 20.
  if (crossing.size >= 2 || !words.length) return [{ x0: 0, x1: W }];
  return [{ x0: 0, x1: split }, { x0: split, x1: W }];
}

/**
 * Monta as linhas de uma coluna: mesma linha de base (±25% do corpo) e, numa
 * segunda passada, sobrescritos/subscritos (corpo menor, base deslocada)
 * entram na linha vizinha a que estão colados.
 */
function buildLines(items) {
  const sorted = items.slice().sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const t of sorted) {
    let target = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 3; k -= 1) {
      const L = lines[k];
      if (Math.abs(L.base - t.base) <= Math.max(1.5, 0.25 * Math.max(L.fs, t.fs))) {
        target = L;
        break;
      }
    }
    if (target) {
      target.items.push(t);
      if (t.fs > target.fs) {
        target.fs = t.fs;
        target.base = t.base;
      }
    } else {
      lines.push({ base: t.base, fs: t.fs, items: [t] });
    }
  }
  // sobrescrito/subscrito: linha só de itens pequenos, colada a uma linha maior
  for (let k = 0; k < lines.length; k += 1) {
    const L = lines[k];
    if (!L || L.merged) continue;
    const near = [lines[k - 1], lines[k + 1]].filter((M) => M && !M.merged && M.fs >= L.fs / 0.8);
    for (const M of near) {
      if (Math.abs(M.base - L.base) > 0.6 * M.fs) continue;
      const mx0 = Math.min(...M.items.map((t) => t.x));
      const mx1 = Math.max(...M.items.map((t) => t.x1));
      if (L.items.every((t) => t.x >= mx0 - 4 && t.x <= mx1 + 4)) {
        M.items.push(...L.items);
        L.merged = true;
        break;
      }
    }
  }
  return lines.filter((L) => !L.merged).map(finishLine);
}

/** Calcula caixa, base dominante, estilo e texto de uma linha. */
function finishLine(L) {
  const items = L.items.slice().sort((a, b) => a.x - b.x);
  // corpo da linha = o tamanho com mais tinta (um "π" maior não muda o
  // corpo; "N" + "2(g)" + "3H" + "2(g)" tem mais letras miúdas que grandes,
  // mas o corpo é o grande)
  const weight = new Map();
  for (const t of items) {
    const k = Math.round(t.fs * 10) / 10;
    weight.set(k, (weight.get(k) || 0) + Math.max(1, t.str.trim().length) * t.fs * t.fs);
  }
  let fs = items[0].fs;
  let best = -1;
  for (const [k, n] of weight) {
    if (n > best || (n === best && k > fs)) {
      best = n;
      fs = k;
    }
  }
  const main = items.filter((t) => Math.abs(t.fs - fs) < 0.06).reduce((a, b) => (b.str.length > a.str.length ? b : a));
  const base = main.base;
  fs = main.fs;
  for (const t of items) {
    t.script = null;
    if (t.fs <= 0.85 * fs && t.str.trim()) {
      if (t.base < base - 0.15 * fs) t.script = 'sup';
      else if (t.base > base + 0.1 * fs) t.script = 'sub';
    }
  }
  const visible = items.filter((t) => t.str.trim());
  const line = {
    items,
    base,
    fs,
    x0: Math.min(...visible.map((t) => t.x), Infinity),
    x1: Math.max(...visible.map((t) => t.x1), -Infinity),
    y0: Math.min(...items.map((t) => t.y)),
    y1: Math.max(...items.map((t) => t.y + t.h)),
    bold: visible.length > 0 && visible.every((t) => t.bold || !/[\p{L}\d]/u.test(t.str)),
    italic: visible.length > 0 && visible.every((t) => t.italic || !/[\p{L}\d]/u.test(t.str)),
    illegible: items.some((t) => t.illegible),
    formula: items.some((t) => t.formula),
  };
  if (!Number.isFinite(line.x0)) {
    line.x0 = Math.min(...items.map((t) => t.x));
    line.x1 = Math.max(...items.map((t) => t.x1));
  }
  line.text = joinItems(items);
  line.rich = joinItems(items, { rich: true });
  return line;
}

/**
 * Índice/expoente em texto: o caractere Unicode quando todos existem ("²",
 * "₂", "ₐ"); senão a marca (markup.js) no texto rico — "L" + "E" vira
 * "L_{E}" e "3" + "x" vira "3^{x}" — e as letras soltas no texto puro.
 */
function scriptText(str, kind, rich = false) {
  const map = kind === 'sup' ? SOBRESCRITO : SUBSCRITO;
  const chars = [...str];
  if (chars.every((c) => map[c] != null)) return chars.map((c) => map[c]).join('');
  if (!rich || !str.trim()) return str;
  return kind === 'sup' ? `${M.SUP0}${str.trim()}${M.SUP1}` : `${M.SUB0}${str.trim()}${M.SUB1}`;
}

/**
 * Largura aproximada de um caractere, em corpos (Arial). Só serve para achar
 * em que ponto de um item cai uma palavra — o pdf.js entrega a largura do
 * item inteiro, não a de cada letra.
 */
function charWidth(c) {
  if (c === ' ') return 0.278;
  if (/[iljtfrI.,;:!'|()[\]]/.test(c)) return 0.3;
  if (/[mwMW]/.test(c)) return 0.83;
  if (/\p{Lu}/u.test(c)) return 0.68;
  if (/\d/.test(c)) return 0.556;
  if (/[\u0300-\u036f\u20d0-\u20ff]/.test(c)) return 0;
  return 0.53;
}

/** Posição estimada de cada caractere do item: `[{ c, x0, x1 }]`. */
function charBoxes(t) {
  const chars = [...t.str];
  const widths = chars.map(charWidth);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const scale = (Number(t.w) || 0) / total;
  let x = t.x;
  return chars.map((c, i) => {
    const x0 = x;
    x += widths[i] * scale;
    return { c, x0, x1: x };
  });
}

/** Pedaço de um item (caracteres de `from` até `to`, sem incluir), com a posição estimada. */
function pieceOf(t, boxes, from, to) {
  const part = boxes.slice(from, to);
  const piece = { ...t, str: part.map((b) => b.c).join(''), x: part[0].x0, w: Math.max(0.01, part[part.length - 1].x1 - part[0].x0) };
  piece.x1 = piece.x + piece.w;
  delete piece.codes;
  delete piece.ins;
  return piece;
}

/**
 * Corta um item nos espaços de índice `cuts` (o espaço sai). Devolve os
 * pedaços, cada um com a posição estimada.
 */
function splitItemAt(t, cuts) {
  const boxes = charBoxes(t);
  const out = [];
  let from = 0;
  for (const c of [...cuts].sort((a, b) => a - b)) {
    if (c > from) out.push(pieceOf(t, boxes, from, c));
    from = c + 1;
  }
  if (from < boxes.length) out.push(pieceOf(t, boxes, from, boxes.length));
  return out.filter((p) => p.str !== '');
}

/** O item em palavras (cada uma com a posição estimada). */
function splitWords(t) {
  const cuts = [];
  [...t.str].forEach((c, i) => {
    if (c === ' ') cuts.push(i);
  });
  if (!cuts.length) return [t];
  const pieces = splitItemAt(t, cuts);
  // o espaço do PDF sai do pedaço, mas não da frase: o pedaço que vinha
  // depois dele leva a marca, e joinItems põe o espaço de volta mesmo antes
  // de pontuação ("especiais !, @, #": o "!" é um dos caracteres da lista)
  for (const p of pieces) if (p.x > t.x + 0.01) p.spaceBefore = true;
  return pieces;
}

/**
 * Item que tem outro item desenhado por cima de um espaço dele (o "⋅" da
 * fonte Symbol no meio de "mL kg", a vírgula de "7,1" no meio de "7 1"):
 * corta o item nesse espaço — senão o sinal ia para o fim ("(mL kg⋅)").
 */
function splitAtInserts(items) {
  let out = items;
  const visible = items.filter((t) => t.str.trim());
  for (const t of visible) {
    if (!/\S\s+\S/.test(t.str)) continue;
    const inside = visible.filter((o) => o !== t && o.w < t.w && (o.x + o.x1) / 2 > t.x + 0.5 && (o.x + o.x1) / 2 < t.x1 - 0.5
      && Math.abs(o.base - t.base) < 0.6 * Math.max(o.fs, t.fs));
    if (!inside.length) continue;
    const boxes = charBoxes(t);
    const cuts = new Set();
    for (const o of inside) {
      const cx = (o.x + o.x1) / 2;
      let best = -1;
      let bestD = Infinity;
      boxes.forEach((b, i) => {
        if (b.c !== ' ') return;
        const d = Math.abs((b.x0 + b.x1) / 2 - cx);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0 && bestD <= 0.7 * t.fs) cuts.add(best);
    }
    if (!cuts.size) continue;
    const pieces = splitItemAt(t, cuts);
    out = out.flatMap((x) => (x === t ? pieces : [x]));
  }
  return out === items ? items : out.slice().sort((a, b) => a.x - b.x);
}

/** Sinal que fecha (sem espaço antes) e que abre (sem espaço depois). */
const FECHA = /^[”’),.;:!?»\]}]/;
const ABRE = /[“‘(«[{]$/;

/** Formatação de um item no texto rico: negrito, itálico, sublinhado. */
function styleOf(t) {
  return { b: !!t.bold, i: !!t.italic, u: t.underline || false };
}

/**
 * Junta os itens de uma linha em texto. Espaço pela geometria nos dois
 * sentidos: vão sem item de espaço vira espaço; o espaço falso que o VUNESP
 * põe depois da primeira letra ("p" + " otências") some; item empilhado sobre
 * outro ("Início" / "escada" de um rótulo em duas linhas) ganha espaço.
 *
 * `rich`: o texto leva as marcas de formatação (markup.js) — negrito, itálico
 * e sublinhado por trecho, índice/expoente sem caractere Unicode. É o texto
 * que vai para o markdown; o puro serve para comparar e classificar.
 */
function joinItems(items, { rich = false } = {}) {
  const list = splitAtInserts(items);
  let text = '';
  let prev = null;
  let pendingSpace = false;
  let firstVisible = null;
  let style = { b: false, i: false, u: false };
  // troca de formatação: fecha tudo e abre o que vale (tidyMarks junta o
  // que fecha e reabre igual)
  // o espaço do meio fica entre a marca que fecha e a que abre (sublinhado
  // de outro traço: "++eles++ ++lhe++", e markup.tidyMarks não junta)
  const setStyle = (want, space = false) => {
    if (want.b === style.b && want.i === style.i && want.u === style.u) {
      if (space) text += ' ';
      return;
    }
    if (style.u) text += M.U1;
    if (style.i) text += M.I1;
    if (style.b) text += M.B1;
    if (space) text += ' ';
    if (want.b) text += M.B0;
    if (want.i) text += M.I0;
    if (want.u) text += M.U0;
    style = { ...want };
  };
  for (const t of list) {
    const raw = rich && t.richStr != null ? t.richStr : t.str;
    if (!raw.trim()) {
      // espaço solto: decide quando vier o próximo item visível
      if (text) pendingSpace = t;
      if (!prev) prev = t;
      continue;
    }
    // (o espaço que cai em cima do próximo — a vírgula de "7,1" desenhada no
    // meio de "7 1" — também não separa)
    // espaço de largura quase nula com o próximo encostado (correção de
    // itálico: "AQ" + " " + "B" de "AQ₁B com chapéu") não separa
    // (pedaço de palavra que tinha espaço antes no PDF: splitWords)
    if (t.spaceBefore && !pendingSpace && prev && text) pendingSpace = { x1: -Infinity };
    // (nem o "espaço" de largura nula entre o índice e a letra seguinte, sem
    // vão de verdade: "C₁₂" + " " + "H₈" saía "C₁₂ H₈ Cl₆")
    // (depois de índice ou de expoente no meio da linha — "(R₃NH)⁺Cl⁻"; a
    // nota "¹ rorejar", no começo da linha, continua com o espaço)
    const tiny = pendingSpace && prev && (prev.script === 'sub' || (prev.script === 'sup' && prev !== firstVisible)) && !t.script
      && pendingSpace.w != null
      && pendingSpace.w < 0.1 * Math.max(prev.fs, t.fs) && t.x - prev.x1 < 0.1 * Math.max(prev.fs, t.fs);
    if (pendingSpace && prev && (t.x - prev.x1 < 0.01 * Math.max(prev.fs, t.fs) || pendingSpace.x1 > t.x + 0.3 || tiny)) pendingSpace = false;
    let s = t.script ? scriptText(raw, t.script, rich) : raw;
    let space = false;
    if (prev && text) {
      const gap = t.x - prev.x1;
      const fs = Math.max(prev.fs, t.fs);
      const tail = text.replace(MARCAS, '');
      const stacked = t.x < prev.x1 - 1 && Math.abs(t.base - prev.base) > 0.5 * fs && !t.script && !prev.script;
      // (e o mesmo depois de "ç", que nunca termina palavra: "graç" + " a, chamam-me")
      if (/^ \p{Ll}/u.test(s) && gap < 0.3 && /(?:^|\s)\p{L}$|\p{L}ç$/iu.test(tail)) {
        s = s.slice(1);
      } else if (t.script) {
        // índice colado na base ("M" + "₂", "28" + "th"): sem espaço no meio
        if (gap >= 0.5 * fs && !/\s$/.test(tail)) space = true;
      } else if (stacked) {
        if (!/\s$/.test(tail)) space = true;
      } else if (!/\s$/.test(tail) && !/^\s/.test(s)) {
        const closes = FECHA.test(s) && gap < (/^[!?]/.test(s) ? 0.2 : 0.3) * fs;
        const opens = ABRE.test(tail) && gap < 0.3 * fs;
        // fração que virou texto ("1/9") não cola na letra do lado ("L₀")
        const fraction = (prev.fraction && /^[\p{L}\p{N}(]/u.test(s)) || (t.fraction && /[\p{L}\p{N})]$/u.test(tail));
        if (fraction || (!closes && !opens && (pendingSpace || (gap > 0.15 * fs && !FECHA.test(s) && !ABRE.test(tail))))) space = true;
      }
    }
    pendingSpace = false;
    if (!firstVisible) firstVisible = t;
    if (rich) setStyle(styleOf(t), space);
    else if (space) text += ' ';
    text += t.script ? s.replace(/^\s+/, '') : s;
    prev = t;
  }
  if (rich) setStyle({ b: false, i: false, u: false });
  // sem espaço antes de pontuação ("HNO₃ ," → "HNO₃,"), nem entre índice e o
  // parêntese que fecha ("CO₃ )")
  // índice (ou expoente) em pedaços — "3" "×" "3", "i" "3" —, parte em
  // caractere e parte em marca: vira uma marca só ("_{3×3}", "_{i3}")
  if (rich) text = mergeScripts(text);
  text = text.replace(/\s+/g, ' ')
    .replace(/(\S) ([,.;:!?])(?=\s|$|[\ue700-\ue70b])/g, '$1$2')
    .replace(/([₀-₉ₐ-ₜ⁰-⁹ⁿⁱ⁺⁻⁼⁽⁾\ue707\ue709]) ([)\]}])/g, '$1$2')
    .trim();
  return rich ? pruneMarks(text) : text;
}

const SUB_CHARS = Object.fromEntries(Object.entries(SUBSCRITO).filter(([k]) => k !== ' ').map(([k, v]) => [v, k]));
const SUP_CHARS = Object.fromEntries(Object.entries(SOBRESCRITO).filter(([k]) => k !== ' ' && !/[oa]/.test(k)).map(([k, v]) => [v, k]));

/** Junta os caracteres de índice/expoente colados numa marca de índice/expoente. */
function mergeScripts(text) {
  const run = (chars, open, close, map) => {
    const cls = `[${Object.keys(map).join('').replace(/[\\\]\-^]/g, (c) => `\\${c}`)}]`;
    const re = new RegExp(`(${cls}*)${open}([^${close}]*)${close}(${cls}*)`, 'g');
    let out = chars;
    let prev = null;
    while (prev !== out) {
      prev = out;
      out = out.replace(re, (whole, a, inner, b) => (a || b ? `${open}${[...a].map((c) => map[c]).join('')}${inner}${[...b].map((c) => map[c]).join('')}${close}` : whole))
        .split(`${close}${open}`).join('');
    }
    return out;
  };
  return run(run(text, M.SUB0, M.SUB1, SUB_CHARS), M.SUP0, M.SUP1, SUP_CHARS);
}

/**
 * Marca de itálico só em trecho com palavra (letra solta em itálico é
 * variável de fórmula — "Q₁", "F" — e encheria o texto de asteriscos);
 * negrito e sublinhado em trecho com letra ou número.
 */
function pruneMarks(text) {
  // itálico: palavra com minúsculas ("bluetooth", "Leishmania") ou letra
  // acentuada ("é" em itálico tem sentido); nome de ponto e variável ("AQₙB",
  // "Q₁", "F") ficam sem marca
  const italicWord = (inner) => {
    const base = inner.replace(/\ue706[^\ue707]*\ue707|\ue708[^\ue709]*\ue709/g, '')
      .replace(/[\u2070-\u209f\u1d62-\u1d6a\u00b2\u00b3\u00b9\u0300-\u036f\u20d0-\u20ff]/g, '');
    return /\p{Ll}{2,}/u.test(base) || /[À-ÖØ-öø-ÿ]/.test(base);
  };
  const rules = [[M.I0, M.I1, italicWord], [M.B0, M.B1, (inner) => /[\p{L}\p{N}]/u.test(inner)], [M.U0, M.U1, (inner) => /\S/.test(inner)]];
  let s = tidyMarks(text);
  for (const [a, b, keep] of rules) {
    s = s.replace(new RegExp(`${a}([^${a}${b}]*)${b}`, 'g'), (whole, inner) => (keep(a === M.I0 ? inner : inner.replace(MARCAS, '')) ? whole : inner));
  }
  return s;
}

/**
 * Coluna de cada item de texto: pelo começo (texto) — o centro decide imagens
 * e desenhos, que às vezes sangram para o vão.
 */
function columnOfText(cols, t) {
  if (cols.length === 1) return 0;
  return t.x + 2 < cols[0].x1 ? 0 : 1;
}

function columnOfBox(cols, b) {
  if (cols.length === 1) return 0;
  return b.x + b.w / 2 < cols[0].x1 ? 0 : 1;
}

/**
 * Fração montada (MathType, LaTeX): traço horizontal curto com número em cima
 * e embaixo. Em texto corrido isso vira "1" numa linha, "4" na outra.
 *
 * Fração simples (numerador e denominador de uma linha só, sem símbolo que se
 * perdeu) vira texto na linha principal, no lugar do traço: "1/4",
 * "W/m²", "(L ⋅ atm)/(mol ⋅ K)". O resto (fração dentro de fração, parêntese
 * grande do MathType, símbolo sem tradução) fica marcado como fórmula — a
 * etapa de figuras recorta a fórmula como imagem.
 *
 * Devolve os itens novos (frações em texto) e tira de `items` os pedaços que
 * viraram texto.
 */
function markFractions(items, paths) {
  const consumed = new Set();
  const created = [];
  const bars = paths.filter((bar) => bar.h <= 1.5 && bar.w >= 3 && bar.w <= 90).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const bar of bars) {
    const x1 = bar.x + bar.w;
    // numerador e denominador cabem na largura do traço (sublinhado não: a
    // linha de baixo é inteira)
    const inside = (t) => t.x >= bar.x - 3 && t.x1 <= x1 + 3;
    const visible = items.filter((t) => t.str.trim() && !consumed.has(t) && inside(t));
    const above = visible.filter((t) => t.base <= bar.y + 1 && t.base >= bar.y - 7);
    const below = visible.filter((t) => t.y >= bar.y - 1.5 && t.y <= bar.y + 5);
    if (!above.length || !below.length) continue;
    // índice do numerador ("x²") e do denominador ("M₁"): letra menor colada
    // na linha dele, um pouco acima ou abaixo
    const scriptsOf = (list) => {
      const fsMax = Math.max(...list.map((t) => t.fs));
      const b0 = Math.min(...list.map((t) => t.base));
      const b1 = Math.max(...list.map((t) => t.base));
      return visible.filter((t) => !above.includes(t) && !below.includes(t) && t.fs <= 0.85 * fsMax
        && t.base >= b0 - 0.7 * fsMax && t.base <= b1 + 0.5 * fsMax);
    };
    above.push(...scriptsOf(above).filter((t) => t.base < bar.y));
    below.push(...scriptsOf(below).filter((t) => t.base > bar.y));
    // a linha principal passa na altura do traço ("OR = ¼ OM", "(A) ½"); no
    // sublinhado, a altura do traço é o vão entre duas linhas
    const parts = new Set([...above, ...below]);
    const cyBar = bar.y + bar.h / 2;
    const main = items.filter((t) => t.str.trim() && !parts.has(t) && !consumed.has(t) && Math.abs(t.cy - cyBar) <= 0.45 * t.fs
      && ((t.x1 <= bar.x + 2 && t.x1 >= bar.x - 40) || (t.x >= x1 - 2 && t.x <= x1 + 40)));
    if (!main.length) continue;
    const num = finishLine({ items: above });
    const den = finishLine({ items: below });
    // uma linha só em cima e embaixo (fora índice), sem buraco no meio (dois
    // traços desenhados num caminho só — "1/46 · 1/45" — dão um retângulo
    // só), e nada perdido no caminho (parêntese grande, sinal do MathType que
    // não virou texto ficam como item vazio marcado)
    const oneLine = (list, line) => list.every((t) => Math.abs(t.base - line.base) <= 0.3 * line.fs || t.script);
    const contiguous = (list) => list.slice().sort((a, b2) => a.x - b2.x)
      .every((t, i, arr) => i === 0 || t.x - Math.max(...arr.slice(0, i).map((o) => o.x1)) <= 0.6 * t.fs);
    const lossy = items.some((t) => t.formula && t.x >= bar.x - 6 && t.x1 <= x1 + 6 && t.base >= bar.y - 8 && t.y <= bar.y + 8);
    const simple = (bar.line || 0) + (bar.rect || 0) <= 1 && oneLine(above, num) && oneLine(below, den)
      && contiguous(above) && contiguous(below) && !lossy
      && num.text.length <= 24 && den.text.length <= 24 && num.text && den.text;
    if (!simple) {
      for (const t of parts) t.formula = true;
      continue;
    }
    const wrap = (txt) => (/[\s+\-−–=×⋅·/]/.test(txt.replace(MARCAS, '')) && !/^\(.*\)$/.test(txt) ? `(${txt})` : txt);
    // a letra da alternativa (fonte de símbolo) não serve de modelo para o
    // texto, nem o índice miúdo do lado ("L₀" depois de "1/9": o "₀" fica
    // mais perto da altura do traço, mas o corpo da linha é o do "L")
    const fsMain = Math.max(...main.map((t) => t.fs));
    const plain = main.filter((t) => !FONTE_DE_SIMBOLO.test(t.font || '') && t.fs >= 0.85 * fsMain);
    const pool = plain.length ? plain : main.filter((t) => t.fs >= 0.85 * fsMain);
    // o mais perto do traço na horizontal (o texto da outra coluna também
    // passa na altura do traço, 30 pt para o lado)
    const hgap = (t) => Math.max(0, bar.x - t.x1, t.x - x1);
    const ref = (pool.length ? pool : main).reduce((a, b2) => (hgap(b2) < hgap(a) - 0.5
      || (Math.abs(hgap(b2) - hgap(a)) <= 0.5 && Math.abs(b2.cy - cyBar) < Math.abs(a.cy - cyBar)) ? b2 : a));
    const fs = ref.fs;
    const t = {
      x: bar.x, y: ref.base - fs, w: bar.w, h: fs, base: ref.base, fs, font: ref.font, bold: false, italic: false,
      str: `${wrap(num.text)}/${wrap(den.text)}`,
      richStr: `${wrap(num.rich)}/${wrap(den.rich)}`,
      // altura de verdade na página (do numerador ao denominador): o recorte
      // de uma figura vizinha não pode avançar sobre ela
      fraction: { y0: Math.min(...above.map((o) => o.base - 0.8 * o.fs)), y1: Math.max(...below.map((o) => o.base + 0.2 * o.fs)) },
    };
    t.x1 = t.x + t.w;
    t.cy = t.y + t.h / 2;
    for (const p of parts) consumed.add(p);
    // o traço já virou texto: não é figura nem fórmula desenhada
    bar.fraction = true;
    created.push(t);
  }
  if (consumed.size) {
    for (let i = items.length - 1; i >= 0; i -= 1) if (consumed.has(items[i])) items.splice(i, 1);
  }
  items.push(...created);
  return created;
}

/**
 * Seta desenhada no meio de uma linha de texto (a da equação química "4 Fe +
 * 3 O₂ ⟶ 2 Fe₂O₃" é desenho, não letra): vira o caractere "→" (ou "⇌", "←")
 * no lugar dela — sem isso a equação perde a seta. Devolve os desenhos usados
 * (saem da lista de desenhos da página).
 */
function markArrows(items, paths) {
  const used = new Set();
  const thin = paths.filter((p) => p.h <= 7 && p.w <= 90 && !(p.w < 1 && p.h < 1) && !p.fraction && !p.underline && !p.blank);
  // seta num caminho só (o fio e as duas pernas da ponta: "⟶" da equação do VUNESP)
  const single = (p) => p.w >= 10 && p.h >= 1.5 && p.h <= 7 && p.w >= 2.5 * p.h && (p.line || 0) >= 3 && !p.curve && !p.rect;
  const lines = thin.filter((p) => (p.h <= 1.5 && p.w >= 8) || single(p));
  for (const line of lines) {
    if (used.has(line)) continue;
    // a seta: o fio e o que encosta nele (ponta, segundo fio da dupla seta)
    const part = thin.filter((p) => !used.has(p) && p.x <= line.x + line.w + 1.5 && p.x + p.w >= line.x - 1.5
      && p.y <= line.y + 7 && p.y + p.h >= line.y - 7 && p.w <= line.w + 3);
    const x0 = Math.min(...part.map((p) => p.x));
    const x1 = Math.max(...part.map((p) => p.x + p.w));
    const y0 = Math.min(...part.map((p) => p.y));
    const y1 = Math.max(...part.map((p) => p.y + p.h));
    if (x1 - x0 < 10 || y1 - y0 > 8) continue;
    const cy = (y0 + y1) / 2;
    const visible = items.filter((t) => t.str.trim() && Math.abs(t.cy - cy) <= 0.45 * t.fs);
    const left = visible.filter((t) => t.x1 <= x0 + 1 && x0 - t.x1 <= 15).sort((a, b) => b.x1 - a.x1)[0];
    const right = visible.filter((t) => t.x >= x1 - 1 && t.x - x1 <= 15).sort((a, b) => a.x - b.x)[0];
    if (!left || !right) continue;
    // nada de texto em cima e embaixo do fio (isso é fração)
    if (items.some((t) => t.str.trim() && t.x >= x0 - 1 && t.x1 <= x1 + 1 && (Math.abs(t.base - y0) <= 4 || Math.abs(t.y - y1) <= 4))) continue;
    // seta tem ponta (triângulo, dois risquinhos, ou o fio desenhado junto
    // com a ponta); fio sem ponta é ligação química ("S—C—C"), travessão
    const fios = part.filter((p) => p.h <= 1.5 && p.w >= 8);
    const heads = part.filter((p) => !(p.h <= 1.5 && p.w >= 8) && !single(p) && p.w <= 9 && p.h >= 1.5);
    const drawnHead = fios.some((p) => (p.line || 0) + (p.curve || 0) >= 3 && p.h > 0.8) || part.some(single);
    if (!heads.length && !drawnHead) continue;
    const ys = [...new Set(fios.map((p) => Math.round(p.y)))];
    let str = '→';
    if (ys.length >= 2 && heads.length >= 2) str = '⇌';
    else if (heads.length && heads.every((h) => h.x + h.w / 2 < (x0 + x1) / 2)) str = '←';
    const fs = left.fs;
    const t = { x: x0, y: left.base - fs, w: x1 - x0, h: fs, base: left.base, fs, font: left.font, bold: false, italic: false, str };
    t.x1 = t.x + t.w;
    t.cy = t.y + t.h / 2;
    items.push(t);
    for (const p of part) used.add(p);
  }
  return used;
}

/**
 * A palavra que o traço sublinha só em parte vira dois ou três pedaços
 * (antes, sob o traço, depois), cortados na letra em que o traço começa ou
 * acaba — só quando sobra ao menos duas letras fora dele (o traço que passa
 * um pouco da palavra, ou que para um pouco antes do fim, sublinha a palavra
 * inteira).
 */
function partOfWord(w, p, wordLike) {
  if (!w.str.trim() || !wordLike(w) || /\s/.test(w.str.trim())) return [w];
  const n = [...w.str].length;
  // a posição de cada letra é estimada (o pdf.js dá a do item inteiro) e
  // erra por alguns pontos no meio da linha: o traço que começa (ou acaba)
  // perto da borda da palavra começa (ou acaba) nela
  const avg = (w.x1 - w.x) / Math.max(1, n);
  let shift = 0;
  if (Math.abs(p.x - w.x) <= 0.6 * avg) shift = p.x - w.x;
  else if (Math.abs(p.x + p.w - w.x1) <= 0.6 * avg) shift = p.x + p.w - w.x1;
  const boxes = charBoxes(w).map((b) => ({ ...b, x0: b.x0 + shift, x1: b.x1 + shift }));
  // primeira e última letra com o centro sob o traço (com um quarto de letra de folga)
  const a = p.x - 0.25 * avg;
  const z = p.x + p.w + 0.25 * avg;
  const from = boxes.findIndex((b) => (b.x0 + b.x1) / 2 >= a && (b.x0 + b.x1) / 2 <= z);
  if (from < 0) return [w];
  let to = from;
  while (to + 1 < n && (boxes[to + 1].x0 + boxes[to + 1].x1) / 2 <= z) to += 1;
  // (aspas e pontuação em volta não contam: "“Moreover," sublinhado inteiro)
  const letters = (list) => list.filter((b) => /\p{L}/u.test(b.c)).length;
  const cuts = [];
  if (letters(boxes.slice(0, from)) >= 2) cuts.push(from);
  if (letters(boxes.slice(to + 1)) >= 2) cuts.push(to + 1);
  if (!cuts.length) return [w];
  const out = [];
  let start = 0;
  const real = charBoxes(w);
  for (const c of [...cuts, n]) {
    out.push(pieceOf(w, real, start, c));
    start = c;
  }
  // (os pedaços se tocam: nenhum espaço entre eles)
  return out.map((piece, i) => (i ? { ...piece, spaceBefore: false } : piece));
}

/** Traço horizontal fino (sublinhado, lacuna, sobrelinha). */
function hairline(p) {
  return p.h <= 1.6 && p.w >= 3 && !p.fraction && !(p.paint === 'fill' && typeof p.fc === 'string' && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(p.fc));
}

/**
 * Sublinhado: traço fino logo abaixo da linha de base de um texto, com o
 * texto cobrindo quase todo o traço. A palavra (ou o trecho) ganha
 * `underline` — vira "++palavra++" no markdown. O VUNESP e o FGV pedem "a
 * palavra sublinhada", "el vocablo destacado": sem a marca, a questão não
 * tinha resposta. O item maior que o traço é cortado nas palavras e só as
 * de cima do traço ficam marcadas. Devolve os traços usados.
 */
function markUnderlines(items, paths) {
  const used = new Set();
  let id = 0;
  let lastRule = null;
  for (const p of paths) {
    // (o traço do "º" de "3º" é estreito — nem chega a sublinhar uma letra;
    // o do "à" sublinhado sozinho, com 4,2 pt, sublinha)
    if (!hairline(p) || p.w > 420 || p.w < 3.5) continue;
    const y = p.y + p.h / 2;
    const over = items.filter((t) => t.str.trim() && y >= t.base - 0.05 * t.fs && y <= t.base + 0.4 * t.fs
      && t.x < p.x + p.w - 0.5 && t.x1 > p.x + 0.5);
    if (!over.length) continue;
    // traço curto sob a letrinha erguida colada no número ("1" + "o" = "1º"):
    // é o indicador ordinal, não sublinhado
    if (p.w < 4.5 && over.some((t) => items.some((o) => o !== t && o.str.trim() && o.fs > 1.25 * t.fs
      && Math.abs(o.x1 - t.x) < 3 && Math.abs(o.base - t.base) < o.fs))) continue;
    // o texto cobre o traço (lacuna e fio de tabela não têm texto em cima)
    const words = over.flatMap((t) => (t.x >= p.x - 1.5 && t.x1 <= p.x + p.w + 1.5 ? [t] : splitWords(t)));
    // cada palavra sublinhada fica quase inteira em cima do traço (a seta de
    // vetor da linha de baixo passa colada embaixo de um pedaço de palavra)
    const overlap = (w) => Math.max(0, Math.min(w.x1, p.x + p.w) - Math.max(w.x, p.x));
    // (o traço do "º" de "3º" é da letra, não sublinhado)
    const wordLike = (w) => /[\p{L}\p{N}]/u.test(w.str) && !/^[ºª°]+$/.test(w.str.trim());
    const inside = words.filter((w) => w.str.trim() && wordLike(w) && (w.x + w.x1) / 2 >= p.x - 1 && (w.x + w.x1) / 2 <= p.x + p.w + 1
      && overlap(w) >= 0.5 * (w.x1 - w.x));
    const covered = inside.reduce((n, w) => n + overlap(w), 0);
    if (!inside.length || covered < 0.6 * p.w) continue;
    // cada traço é um sublinhado: "eles" e "lhe" sublinhados à parte não viram
    // um trecho só (o traço emendado no anterior, na mesma altura, continua)
    const cont = lastRule && Math.abs(lastRule.y - y) < 0.6 && p.x - lastRule.x1 <= 4 && p.x - lastRule.x1 >= -1;
    if (!cont) id += 1;
    lastRule = { x1: p.x + p.w, y };
    for (const t of over) {
      let pieces = t.x >= p.x - 1.5 && t.x1 <= p.x + p.w + 1.5 ? [t] : splitWords(t);
      // traço que sublinha só um pedaço da palavra ("++mover++se", "++inculcar++las":
      // o comando pergunta pelo verbo, não pelo pronome): a palavra é
      // cortada onde o traço começa ou acaba
      pieces = pieces.flatMap((w) => partOfWord(w, p, wordLike));
      for (const w of pieces) {
        const cx = (w.x + w.x1) / 2;
        if (w.str.trim() && wordLike(w) && cx >= p.x - 1 && cx <= p.x + p.w + 1 && overlap(w) >= 0.5 * (w.x1 - w.x)) w.underline = id;
      }
      if (pieces.length > 1 || pieces[0] !== t) {
        const i = items.indexOf(t);
        if (i >= 0) items.splice(i, 1, ...pieces);
      }
    }
    p.underline = true;
    used.add(p);
  }
  return used;
}

/**
 * Lacuna: traço fino na altura da linha de base, sem texto em cima, com
 * texto colado dos lados ("possui ______ e ______."; "___ Aℓ(OH)₃ + ___
 * H₂SO₄"). Vira "____" no texto — a questão pergunta o que preenche as
 * lacunas. Traço ligado a outro desenho (eixo de gráfico, tabela) não é
 * lacuna. Devolve os traços usados.
 */
function markBlanks(items, paths) {
  const used = new Set();
  // fio fino e escuro (o enfeite do "QUESTÃO" do ENEM é fio cinza na mesma altura)
  const dark = (c) => typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)
    || (parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16)) / 3 < 140;
  const free = paths.filter((p) => hairline(p) && !p.underline && p.w >= 8 && p.w <= 200
    && (p.paint === 'fill' ? dark(p.fc) : (Number(p.lw) || 1) <= 1.5 && dark(p.sc)));
  for (const p of free) {
    const y = p.y + p.h / 2;
    // a lacuna fica na linha de base (ou logo abaixo); a ligação de uma
    // fórmula estrutural ("S—C—C") passa no meio da altura das letras
    const near = (t) => t.str.trim() && y >= t.base - 0.15 * t.fs && y <= t.base + 0.35 * t.fs;
    if (items.some((t) => t.str.trim() && Math.abs(t.base - y) <= 0.5 * t.fs && t.x < p.x + p.w - 1 && t.x1 > p.x + 1)) continue;
    // vizinhos na mesma frase (o texto da outra coluna fica do outro lado do vão)
    const left = items.filter((t) => near(t) && t.x1 <= p.x + 1 && p.x - t.x1 <= 8).sort((a, b) => b.x1 - a.x1)[0];
    const right = items.filter((t) => near(t) && t.x >= p.x + p.w - 1 && t.x - (p.x + p.w) <= 8).sort((a, b) => a.x - b.x)[0];
    // texto dos dois lados; ou lacuna no começo da linha, colada no que vem depois
    const tight = !left && right && right.x - (p.x + p.w) <= 4;
    if (!(left && right) && !tight) continue;
    // isolado: nada de desenho encostado (eixo, tique, borda de tabela)
    const touching = paths.some((o) => o !== p && o.x <= p.x + p.w + 2 && o.x + o.w >= p.x - 2 && o.y <= p.y + p.h + 2 && o.y + o.h >= p.y - 2);
    if (touching) continue;
    const ref = left || right;
    const fs = ref.fs;
    const n = Math.max(3, Math.min(12, Math.round(p.w / (0.5 * fs))));
    const t = { x: p.x, y: ref.base - fs, w: p.w, h: fs, base: ref.base, fs, font: ref.font, bold: false, italic: false, str: '_'.repeat(n), blank: true };
    t.x1 = t.x + t.w;
    t.cy = t.y + t.h / 2;
    items.push(t);
    p.blank = true;
    used.add(p);
  }
  return used;
}

/** Acento combinante de cada forma de marca desenhada em cima da letra. */
const CIRCUNFLEXO = '\u0302';
const SOBRELINHA = '\u0305';
const SETA_VETOR = '\u20d7';

/** Põe a marca combinante depois do caractere do item que fica embaixo de `cx`. */
function addCombining(t, cx, mark) {
  const boxes = charBoxes(t);
  let best = -1;
  let bestD = Infinity;
  boxes.forEach((b, i) => {
    // acento vai em letra (o tique do eixo em cima do "20" não é chapéu)
    if (!/\p{L}/u.test(b.c)) return;
    const d = cx < b.x0 ? b.x0 - cx : cx > b.x1 ? cx - b.x1 : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0 || bestD > 0.4 * t.fs) return false;
  const chars = boxes.map((b) => b.c);
  chars.splice(best + 1, 0, mark);
  t.str = chars.join('');
  delete t.codes;
  return true;
}

/**
 * Marca em cima da letra: a seta de vetor do MT Extra (item que é só o acento
 * — "F" + seta = "F com seta"), e as desenhadas — o chapéu do ângulo ("AQB com chapéu"), a seta
 * de vetor e a barra de segmento. Sem isso a seta ficava numa linha à parte
 * (marcada como fórmula: a frase inteira virava imagem) e o chapéu sumia.
 * Devolve os desenhos usados.
 */
function markAccents(items, paths) {
  const used = new Set();
  const letters = () => items.filter((t) => t.str.trim() && !t.accent && /[\p{L}\p{N}]/u.test(t.str));
  // a letra logo embaixo de uma marca (centro dela dentro da letra, e a marca
  // entre um pouco acima do topo e o meio da letra)
  const below = (cx, y0, y1) => letters().filter((t) => cx >= t.x - 0.5 && cx <= t.x1 + 0.5 && y1 <= t.base - 0.35 * t.fs && y0 >= t.base - 1.6 * t.fs)
    .sort((a, b) => Math.abs(a.base - 0.75 * a.fs - y1) - Math.abs(b.base - 0.75 * b.fs - y1))[0];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const a = items[i];
    if (!a.accent) continue;
    const cx = (a.x + a.x1) / 2;
    // o glifo do acento fica no alto da caixa dele: vale a linha de base, de
    // meia a uma linha e meia acima da da letra
    const host = letters().filter((t) => cx >= t.x - 0.5 && cx <= t.x1 + 0.5 && t.base - a.base >= 0.3 * t.fs && t.base - a.base <= 1.5 * t.fs)
      .sort((p, q) => (p.base - a.base) - (q.base - a.base))[0];
    if (host && addCombining(host, cx, a.str.replace(/[^\u20d0-\u20ff\u0300-\u036f]/g, '') || SETA_VETOR)) {
      items.splice(i, 1);
      continue;
    }
    // sem letra embaixo (a letra é um glifo de fórmula sem tradução, como o
    // "f" do MathType): a seta sai do texto — nunca vai parar na palavra do
    // lado ("sentido" + seta); a fórmula de baixo vira recorte
    items.splice(i, 1);
  }
  // a seta de vetor desenhada vem em dois pedaços (o fio e a ponta): junta os
  // pedaços pequenos que se tocam e decide pela forma do conjunto
  // (agrupamento por varredura: página de gráfico tem milhares de traços)
  const small = paths.filter((p) => !p.fraction && !p.underline && !p.blank && p.w <= 30 && p.h <= 6);
  const marks = [...unionByProximity(small.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, col: 0, p })), 1.5).values()]
    .map((g) => ({ parts: g.map((e) => e.p) }));
  for (const m of marks) {
    const x0 = Math.min(...m.parts.map((o) => o.x));
    const y0 = Math.min(...m.parts.map((o) => o.y));
    const x1 = Math.max(...m.parts.map((o) => o.x + o.w));
    const y1 = Math.max(...m.parts.map((o) => o.y + o.h));
    const isArrow = m.parts.length >= 2 && m.parts.some((o) => o.h <= 1 && o.w >= 2) && m.parts.some((o) => o.h > 1 && o.w <= 4);
    m.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, line: m.parts.reduce((n, o) => n + (o.line || 0), 0) + (isArrow ? 3 : 0), curve: m.parts.reduce((n, o) => n + (o.curve || 0), 0), arrow: isArrow };
  }
  // o que é grande (eixo, moldura, ligação de fórmula estrutural): a marca
  // encostada nele faz parte do desenho
  const large = paths.filter((p) => !p.fraction && !p.underline && !p.blank && (p.w > 30 || p.h > 6));
  for (const m of marks) {
    const p = m.box;
    if (p.w > 30 || p.h > 6 || (p.w < 2 && p.h < 2)) continue;
    if (large.some((o) => o.x <= p.x + p.w + 1 && o.x + o.w >= p.x - 1 && o.y <= p.y + p.h + 1 && o.y + o.h >= p.y - 1)) continue;
    const cx = p.x + p.w / 2;
    const host = below(cx, p.y, p.y + p.h);
    if (!host || p.w > 1.4 * host.fs * Math.max(1, [...host.str].length) || p.h > 0.45 * host.fs) continue;
    // nada de numerador em cima (texto dentro da largura do traço, colado nele)
    if (items.some((t) => t !== host && t.str.trim() && t.x >= p.x - 3 && t.x1 <= p.x + p.w + 3
      && t.base <= p.y + 0.5 && t.base >= p.y - 0.8 * t.fs)) continue;
    let mark = null;
    const nPieces = (p.line || 0) + (p.curve || 0);
    // barra de segmento: em cima de 1 a 3 maiúsculas ("AB com barra")
    const coveredCaps = charBoxes(host).filter((b) => (b.x0 + b.x1) / 2 >= p.x - 0.5 && (b.x0 + b.x1) / 2 <= p.x + p.w + 0.5);
    if (p.arrow) mark = SETA_VETOR;
    else if (p.h <= 1 && p.w >= 0.3 * host.fs && coveredCaps.length >= 1 && coveredCaps.length <= 3
      && coveredCaps.every((b) => /\p{Lu}/u.test(b.c))) mark = SOBRELINHA;
    else if (p.w >= 3 * p.h && (p.line || 0) >= 3 && !p.curve && p.w > 0.8 * host.fs) mark = SETA_VETOR;
    else if (nPieces >= 2 && p.w <= 1.2 * host.fs) mark = CIRCUNFLEXO;
    if (!mark) continue;
    if (mark === SOBRELINHA) {
      // a barra cobre as letras do segmento: cada uma ganha a sobrelinha
      const boxes = charBoxes(host);
      const chars = [];
      boxes.forEach((b) => {
        chars.push(b.c);
        const c = (b.x0 + b.x1) / 2;
        if (/\p{L}/u.test(b.c) && c >= p.x - 0.5 && c <= p.x + p.w + 0.5) chars.push(SOBRELINHA);
      });
      host.str = chars.join('');
      delete host.codes;
    } else if (!addCombining(host, mark === SETA_VETOR ? Math.max(p.x + 0.5, p.x + p.w - 0.3 * host.fs) : cx, mark)) {
      continue;
    }
    for (const o of m.parts) {
      o.accent = true;
      used.add(o);
    }
  }
  return used;
}

/**
 * Matriz do editor de equações do Word (o FGV usa): três fileiras de números
 * alinhadas em coluna, e a do meio com "[" "]" (ou "(" ")", "|") em volta. Em
 * texto isso virava "147 116 31 / M = [158 127 31] / 271 240 31". As linhas
 * da matriz ficam marcadas como fórmula — a etapa de figuras recorta a matriz.
 */
function markMatrices(lines) {
  const ABRE_MATRIZ = /^[[(|{⎡⎛]$/;
  const FECHA_MATRIZ = /^[\])|}⎤⎞]$/;
  const numericRow = (l) => l && l.items.filter((t) => t.str.trim()).every((t) => /^[\d\s.,−\-+a-zA-Z]{1,8}$/.test(t.str.trim()));
  for (let k = 0; k < lines.length; k += 1) {
    const L = lines[k];
    const vis = L.items.filter((t) => t.str.trim()).sort((a, b) => a.x - b.x);
    const open = vis.findIndex((t) => ABRE_MATRIZ.test(t.str.trim()));
    if (open < 0 || open === vis.length - 1) continue;
    const close = vis.findIndex((t, i) => i > open + 1 && FECHA_MATRIZ.test(t.str.trim()));
    if (close < 0) continue;
    const firstX = vis[open + 1].x;
    const lastX1 = vis[close - 1].x1;
    const row = (l) => numericRow(l) && l.items.some((t) => t.str.trim() && Math.abs(t.x - firstX) <= 1.5)
      && Math.max(...l.items.filter((t) => t.str.trim()).map((t) => t.x1)) <= lastX1 + 2
      && Math.abs(l.base - L.base) <= 3 * L.fs;
    const rows = [];
    for (let j = k - 1; j >= 0 && row(lines[j]) && L.base - lines[j].base <= 1.5 * L.fs * (k - j); j -= 1) rows.push(lines[j]);
    for (let j = k + 1; j < lines.length && row(lines[j]) && lines[j].base - L.base <= 1.5 * L.fs * (j - k); j += 1) rows.push(lines[j]);
    if (!rows.length) continue;
    for (const l of [L, ...rows]) {
      l.formula = true;
      l.matrix = true;
    }
  }
}

/**
 * Lê a página: separa borda, decide as colunas e monta as linhas de cada
 * coluna em ordem de leitura.
 */
function readPage(P, edges) {
  const W = P.width;
  const { top, bottom } = edges;
  const discarded = [];
  const dropped = new Map();
  const drop = (kind, t) => {
    if (!dropped.has(kind)) dropped.set(kind, []);
    dropped.get(kind).push(t);
  };
  const body = [];
  for (const t of P.texts) {
    const s = t.str.trim();
    if (CODIGO_BARRAS.test(s)) drop('codigo_barras', t);
    else if (t.cy < top) drop('cabecalho', t);
    else if (t.cy > bottom) drop('rodape', t);
    else if (t.x1 < 18 || t.x > W - 18) drop('margem', t);
    else body.push(t);
  }
  // para a auditoria: uma entrada por linha descartada, com o texto já montado
  for (const [kind, items] of dropped) {
    for (const row of rowsByBase(items.filter((t) => t.str.trim()), 3)) {
      discarded.push({ page: P.page, kind, text: joinItems(row.items), y: row.y0 });
    }
  }
  if (P.micro.length) {
    const amostra = P.micro.map((t) => t.str).join('').slice(0, 60);
    discarded.push({ page: P.page, kind: 'microtexto', text: `${amostra}… (${P.micro.length} itens)`, y: P.micro[0].y });
  }
  // desenho/imagem no corpo; aba decorativa colada na borda da página (centro a
  // menos de 25 pt da lateral) não é figura
  const inBody = (b) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return cy >= top && cy <= bottom && cx > 25 && cx < W - 25;
  };
  let paths = P.paths.filter(inBody);
  const images = P.images.filter(inBody);
  markFractions(body, paths);
  // sublinhado, lacuna, seta e acento desenhados viram texto (e saem dos desenhos)
  const consumed = new Set([...markUnderlines(body, paths), ...markBlanks(body, paths)]);
  for (const p of markArrows(body, paths)) consumed.add(p);
  for (const p of markAccents(body, paths)) consumed.add(p);
  if (consumed.size) paths = paths.filter((p) => !consumed.has(p));
  const cols = detectColumns(P, body, paths, top, bottom);
  const columns = cols.map((c, i) => ({ ...c, index: i, lines: [] }));
  const buckets = columns.map(() => []);
  for (const t of body) buckets[columnOfText(cols, t)].push(t);
  for (const col of columns) {
    col.lines = buildLines(buckets[col.index]).sort((a, b) => a.base - b.base || a.x0 - b.x0);
    markMatrices(col.lines);
    const starts = col.lines.filter((l) => l.text.length >= 3).map((l) => l.x0);
    col.margin = starts.length ? mode(starts, 1) : col.x0;
    // a moda pode cair no recuo (página cheia de alternativas longas): guarda
    // também o começo mais à esquerda que se repete
    col.left = starts.length ? percentile(starts, 0.05) : col.x0;
    const ends = col.lines.filter((l) => l.text.length > 25).map((l) => l.x1);
    col.right = ends.length ? percentile(ends, 0.85) : col.x1;
    // texto sem justificar (cada linha acaba onde a palavra coube): pouca
    // linha chega na margem direita
    col.ragged = ends.length >= 4 && ends.filter((x) => x >= col.right - 2).length / ends.length < 0.5;
  }
  return { page: P.page, width: W, height: P.height, top, bottom, columns, paths, images, rotated: P.rotated, discarded };
}

/** Texto da linha sem espaços e em minúsculas (títulos em versalete vêm em pedaços). */
const compact = (text) => String(text || '').toLowerCase().replace(/\s+/g, '');

/** Classifica as linhas de cabeçalho de seção/idioma. */
function headingOf(line) {
  const text = line.text.trim();
  let m = FAIXA_IDIOMA.exec(text);
  if (m) {
    return { type: 'idioma', variant: /ingl/i.test(m[3]) ? 'ingles' : 'espanhol', from: Number(m[1]), to: Number(m[2]) };
  }
  m = FAIXA_AREA.exec(text);
  if (m) return { type: 'faixa', from: Number(m[1]), to: Number(m[2]) };
  if (line.bold || line.fs >= 10.5) {
    const c = compact(text);
    m = TITULO_IDIOMA.exec(c);
    if (m) return { type: 'idioma', variant: /ingl/.test(m[1]) ? 'ingles' : 'espanhol', from: null, to: null };
  }
  return null;
}

/**
 * Candidatas a marca de questão. ENEM: a linha é "QUESTÃO 12". VUNESP/FGV:
 * a linha é um número sozinho, em negrito, na margem esquerda da coluna.
 */
function markCandidates(lines, kind) {
  const out = [];
  for (const line of lines) {
    if (line.type !== 'text') continue;
    const text = line.text.trim();
    if (kind === 'enem') {
      const m = MARCA_ENEM.exec(text);
      if (m) out.push({ line, number: Number(m[1]), style: 'enem' });
      continue;
    }
    // o número pode vir em pedaços ("4" + "0" no FGV): a linha inteira é o número
    const visible = line.items.filter((t) => t.str.trim());
    if (!visible.length || visible.length > 3 || !visible.every((t) => /^\d+\.?$/.test(t.str.trim()))) continue;
    const m = NUMERO_SOZINHO.exec(text.replace(/\s+/g, ''));
    if (!m || !line.bold) continue;
    if (Math.abs(line.x0 - line.margin) > 8 && line.x0 > line.left + 6) continue;
    out.push({ line, number: Number(m[1]), style: `${(visible[0].font || '').replace(/^[A-Z]{6}\+/, '')}@${Math.round(line.fs)}` });
  }
  return out;
}

/**
 * Aceita as marcas na ordem de leitura. No ENEM a marca é inequívoca: todas
 * entram (a sequência só gera alerta). No VUNESP/FGV um número solto pode ser
 * de tabela ou de gabarito: entra se for o próximo da sequência (tolerando um
 * ou dois faltando) ou o recomeço depois de um título de idioma.
 */
function acceptMarks(candidates, languageBetween, kind) {
  if (kind === 'enem') return candidates.map((c) => ({ ...c }));
  // estilo dominante entre as candidatas
  const styles = new Map();
  for (const c of candidates) styles.set(c.style, (styles.get(c.style) || 0) + 1);
  let dominant = null;
  for (const [s, n] of styles) if (!dominant || n > styles.get(dominant)) dominant = s;
  const accepted = [];
  let last = 0;
  const same = candidates.filter((c) => c.style === dominant);
  const followedBy = (c, n) => same.slice(same.indexOf(c) + 1, same.indexOf(c) + 3).some((o) => o.number === n);
  for (const c of candidates) {
    if (c.style !== dominant) continue;
    const n = c.number;
    const languageSince = languageBetween(c.line.idx, accepted.length ? accepted[accepted.length - 1].line.idx : -1);
    if (!accepted.length && (n <= 3 || followedBy(c, n + 1))) {
      // a primeira: 1 a 3, ou qualquer número que a seguinte confirme (PDF
      // com só uma parte da prova)
      accepted.push({ ...c });
      last = n;
    } else if (accepted.length && n > last && n <= last + 3) {
      accepted.push({ ...c });
      last = n;
    } else if (accepted.length && languageSince && n <= last) {
      accepted.push({ ...c });
      last = n;
    }
  }
  return accepted;
}

/**
 * Variante de idioma de cada marca. O cabeçalho de idioma liga; a faixa dele
 * (quando escrita, como no ENEM) ou o fim da numeração repetida desliga.
 * Se a prova só tem uma das línguas, ninguém é variante.
 */
function assignVariants(stream, marks) {
  let state = null;
  const maxByVariant = {};
  const markByLine = new Map(marks.map((m) => [m.line.idx, m]));
  for (const line of stream) {
    if (line.heading) {
      const h = line.heading;
      if (h.type === 'idioma') {
        const other = h.variant === 'ingles' ? 'espanhol' : 'ingles';
        state = { variant: h.variant, from: h.from, to: h.to, limit: maxByVariant[other] ?? null };
      } else if (h.type === 'faixa') {
        state = null;
      }
      continue;
    }
    const m = markByLine.get(line.idx);
    if (!m) continue;
    if (state) {
      if (state.to != null && (m.number < state.from || m.number > state.to)) state = null;
      else if (state.to == null && state.limit != null && m.number > state.limit) state = null;
    }
    m.variant = state ? state.variant : null;
    if (m.variant) maxByVariant[m.variant] = Math.max(maxByVariant[m.variant] || 0, m.number);
  }
  const present = new Set(marks.filter((m) => m.variant).map((m) => m.variant));
  if (present.size < 2) {
    for (const m of marks) m.variant = null;
    return;
  }
  // Variante só vale para os números que existem nas duas línguas.
  const nums = { ingles: new Set(), espanhol: new Set() };
  for (const m of marks) if (m.variant) nums[m.variant].add(m.number);
  for (const m of marks) {
    if (!m.variant) continue;
    const other = m.variant === 'ingles' ? 'espanhol' : 'ingles';
    if (!nums[other].has(m.number)) m.variant = null;
  }
}

/**
 * Agrupa retângulos que se tocam (com folga `gap`), na mesma coluna.
 * Varredura por x (o ENEM 2022 tem página com 3 mil desenhos) e união-busca
 * sem recursão.
 */
function unionByProximity(els, gap) {
  const order = els.map((_, i) => i).sort((a, b) => els[a].x - els[b].x);
  const parent = els.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  for (let oi = 0; oi < order.length; oi += 1) {
    const a = els[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj += 1) {
      const b = els[order[oj]];
      if (b.x > a.x + a.w + gap) break;
      if (a.col !== b.col) continue;
      if (a.y <= b.y + b.h + gap && b.y <= a.y + a.h + gap) {
        const ra = find(order[oi]);
        const rb = find(order[oj]);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const groups = new Map();
  els.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });
  return groups;
}

/** Tem palavra-chave de redação e nenhuma marca: página de redação. */
function isEssayPage(text) {
  return PAGINA_REDACAO.test(text);
}

/**
 * Análise completa do layout (já decodificado).
 * `examKind`: 'enem' | 'vunesp' | 'auto' (padrão).
 */
function analyze(layout, { examKind = 'auto' } = {}) {
  const prepared = (layout.pages || []).map((p) => preparePage(p, layout.fonts || {}));
  const edges = detectBorders(prepared);
  const pages = prepared.map((P) => readPage(P, edges.get(P.page)));
  const discarded = pages.flatMap((p) => p.discarded);

  // fluxo de leitura: página a página, coluna a coluna, de cima para baixo
  const stream = [];
  for (const p of pages) {
    for (const col of p.columns) {
      for (const line of col.lines) {
        line.type = 'text';
        line.page = p.page;
        line.col = col.index;
        line.colX0 = col.x0;
        line.colX1 = col.x1;
        line.margin = col.margin;
        line.left = col.left;
        line.right = col.right;
        line.ragged = !!col.ragged;
        line.idx = stream.length;
        stream.push(line);
      }
    }
  }

  let kind = examKind;
  if (kind !== 'enem' && kind !== 'vunesp') {
    const enemMarks = stream.filter((l) => MARCA_ENEM.test(l.text.trim())).length;
    const numberMarks = markCandidates(stream, 'vunesp').length;
    kind = enemMarks > 0 && enemMarks >= 0.5 * numberMarks ? 'enem' : 'vunesp';
  }

  for (const line of stream) {
    const h = headingOf(line);
    if (h) line.heading = h;
  }
  const headingIdx = stream.filter((l) => l.heading && l.heading.type === 'idioma').map((l) => l.idx);
  const languageBetween = (idx, prevIdx) => headingIdx.some((h) => h > prevIdx && h < idx);

  const candidates = markCandidates(stream, kind);
  const marks = acceptMarks(candidates, languageBetween, kind);
  for (const m of marks) {
    m.line.isMark = true;
    m.page = m.line.page;
    m.col = m.line.col;
  }
  assignVariants(stream, marks);

  // páginas de redação (sem marca, com as palavras da proposta)
  const pagesWithMarks = new Set(marks.map((m) => m.page));
  const essayPages = new Set();
  for (const p of pages) {
    if (pagesWithMarks.has(p.page)) continue;
    const text = stream.filter((l) => l.page === p.page).map((l) => l.text).join(' ');
    if (isEssayPage(text) || /^reda[çc][ãa]o$/i.test(compact(stream.find((l) => l.page === p.page)?.text || ''))) {
      essayPages.add(p.page);
    }
  }

  return { kind, pages, lines: stream, marks, essayPages, discarded, leading: typicalLeading(stream) };
}

/**
 * Entrelinha de cada corpo na prova: a distância mais comum entre duas
 * linhas seguidas do mesmo parágrafo (a primeira vai até a margem direita).
 * O texto justificado tem entrelinha constante (±0,1 pt); o espaço a mais
 * entre parágrafos é pequeno em algumas provas (13 pt contra 11 no FGV) — é
 * comparando com ela que se separa o parágrafo da quebra de linha.
 * Devolve `{ [corpo]: entrelinha }` (corpo arredondado a 0,25).
 */
function typicalLeading(stream) {
  const byFs = new Map();
  for (let i = 1; i < stream.length; i += 1) {
    const a = stream[i - 1];
    const b = stream[i];
    if (a.page !== b.page || a.col !== b.col || Math.abs(a.fs - b.fs) > 0.3) continue;
    const dy = b.base - a.base;
    if (dy < 0.9 * a.fs || dy > 2 * a.fs) continue;
    if (a.x1 < (a.right || a.x1) - 5) continue;
    const k = fsKey(a.fs);
    if (!byFs.has(k)) byFs.set(k, []);
    byFs.get(k).push(dy);
  }
  const out = {};
  for (const [k, list] of byFs) if (list.length >= 3) out[k] = mode(list, 0.25);
  return out;
}

/** Chave do corpo para a tabela de entrelinha. */
function fsKey(fs) {
  return Math.round(fs * 4) / 4;
}

module.exports = {
  fsKey,
  charBoxes,
  splitWords,
  splitAtInserts,
  scriptText,
  cleanSymbolText,
  markUnderlines,
  markBlanks,
  markAccents,
  markArrows,
  markFractions,
  markMatrices,
  MARCA_ENEM,
  PAGINA_REDACAO,
  TITULO_AREA,
  median,
  percentile,
  preparePage,
  detectBorders,
  detectColumns,
  buildLines,
  finishLine,
  joinItems,
  unionByProximity,
  columnOfBox,
  headingOf,
  analyze,
  compact,
};

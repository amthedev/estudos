'use strict';

/**
 * Texto ilegível por fonte com código deslocado.
 *
 *   const { decodeLayout } = require('./decode');
 *   const relatorio = decodeLayout(layout);   // corrige os itens no lugar
 *
 * Algumas provas (o PPL 2017 dia 1 do corpus: 60 de 94 questões) trazem
 * fontes sem tabela ToUnicode. O pdf.js então entrega o código do glifo como
 * se fosse o caractere, e "Confira a quantidade" vira "&RQ¿UD\u0003D\u0003TXDQWLGDGH".
 * Medido no corpus: o código é o índice do glifo no Arial (ordem padrão do
 * Macintosh) — na faixa ASCII é o caractere menos 29; acima disso, a ordem do
 * Arial (á = 105, ç = 111, ã = 109...).
 *
 * O que este módulo faz, por fonte do documento:
 *   1. junta o texto de todos os itens da fonte e mede se parece lixo
 *      (caracteres de controle, quase nenhuma palavra conhecida);
 *   2. testa a tabela de glifos do Arial e os deslocamentos de −60 a +60 e fica
 *      com o que mais parece texto (palavras frequentes de português, inglês e
 *      espanhol, letras minúsculas, pouca sujeira);
 *   3. aplica a melhor tentativa se ela for boa; se nada passar, os itens da
 *      fonte ficam marcados como ilegíveis e a questão ganha o alerta
 *      'texto_ilegivel' — nunca vai lixo para o aluno.
 *
 * Fontes de símbolo (equações, letras das alternativas, código de barras)
 * ficam de fora: o código delas não é texto.
 */

/**
 * Índice do glifo no Arial → caractere, acima da faixa ASCII. Gerado a partir
 * do cmap do Arial.ttf (o Arial Bold tem a mesma ordem). Não é a ordem Mac
 * padrão: o Arial não tem o espaço inseparável, então de 172 em diante tudo
 * anda uma posição.
 */
const ARIAL_GLYPHS = Object.freeze({
  98: 'Ä', 99: 'Å', 100: 'Ç', 101: 'É', 102: 'Ñ', 103: 'Ö', 104: 'Ü', 105: 'á', 106: 'à', 107: 'â', 108: 'ä',
  109: 'ã', 110: 'å', 111: 'ç', 112: 'é', 113: 'è', 114: 'ê', 115: 'ë', 116: 'í', 117: 'ì', 118: 'î', 119: 'ï',
  120: 'ñ', 121: 'ó', 122: 'ò', 123: 'ô', 124: 'ö', 125: 'õ', 126: 'ú', 127: 'ù', 128: 'û', 129: 'ü', 130: '†',
  131: '°', 132: '¢', 133: '£', 134: '§', 135: '•', 136: '¶', 137: 'ß', 138: '®', 139: '©', 140: '™', 141: '´',
  142: '¨', 143: '≠', 144: 'Æ', 145: 'Ø', 146: '∞', 147: '±', 148: '≤', 149: '≥', 150: '¥', 151: 'µ', 152: '∂',
  153: '∑', 154: '∏', 155: 'π', 156: '∫', 157: 'ª', 158: 'º', 159: 'Ω', 160: 'æ', 161: 'ø', 162: '¿', 163: '¡',
  164: '¬', 165: '√', 166: 'ƒ', 167: '≈', 168: '∆', 169: '«', 170: '»', 171: '…', 172: 'À', 173: 'Ã', 174: 'Õ',
  175: 'Œ', 176: 'œ', 177: '–', 178: '—', 179: '“', 180: '”', 181: '‘', 182: '’', 183: '÷', 184: '◊', 185: 'ÿ',
  186: 'Ÿ', 187: '⁄', 188: '€', 189: '‹', 190: '›', 191: 'fi', 192: 'fl', 193: '‡', 194: '∙', 195: '‚', 196: '„',
  197: '‰', 198: 'Â', 199: 'Ê', 200: 'Á', 201: 'Ë', 202: 'È', 203: 'Í', 204: 'Î', 205: 'Ï', 206: 'Ì', 207: 'Ó',
  208: 'Ô', 209: 'Ò', 210: 'Ú', 211: 'Û', 212: 'Ù', 213: 'ı', 214: 'ˆ', 215: '˜', 216: 'ˉ', 217: '˘', 218: '˙',
  219: '˚', 220: '¸', 221: '˝', 222: '˛', 223: 'ˇ', 224: 'Ł', 225: 'ł', 226: 'Š', 227: 'š', 228: 'Ž', 229: 'ž',
  230: '¦', 1973: '"',
});

/** Palavras muito frequentes (2+ letras) de português, inglês e espanhol. */
const COMUNS = new Set(`
de da do das dos em no na nos nas um uma uns umas para por pelo pela pelos pelas com sem que se ao aos as os
não mais mas como foi ser são está estão tem têm há já também só seu sua seus suas ou entre era sobre isso
este esta esse essa ele ela eles elas eu você nós me lhe muito quando onde qual quais quem até depois ainda
mesmo outro outra outros outras cada todo toda todos todas forma texto sociedade social processo brasil vida
pode podem ter fazer tempo partir anos ano dia ser sendo foram fosse seria será sido assim então porque pois
the of and to in is that for it as with was on be by are this not or from at an which have has but they
his her their its were been more can will one all would there what so if about into than other some when
el la los las del en es por con una para que se lo como más pero sus le ya fue este esta ha muy también
entre sin sobre todo cuando hay donde desde porque son ser está están tiene puede
`.split(/\s+/).filter(Boolean));

/** Fontes cujo código não é texto: símbolos de equação, letras em círculo, código de barras. */
const FONTE_DE_SIMBOLO = /Symbol|MT-?Extra|Wingding|Dingbat|Bundesbahn|Math|Euclid|Webdings|C39|Barcode|3of9|^N\d+$/i;

const LETRA = /[a-zà-öø-ÿ]/i;
const MINUSCULA = /[a-zà-öø-ÿ]/;

/**
 * Quanto um trecho parece texto de verdade, de 0 a ~0,6.
 *
 * Medido no corpus: prosa em português fica entre 0,25 e 0,45; o texto
 * embaralhado do PPL 2017, abaixo de 0,02. Um escore ingênuo (palavras de uma
 * letra, só contagem) escolhia o deslocamento errado: "a" e "e" aparecem em
 * qualquer lixo, e o mesmo texto em MAIÚSCULAS (deslocamento −3) empatava. Por
 * isso só contam palavras de 2+ letras, e a fração de minúsculas pesa.
 */
function legibilityScore(text) {
  const s = String(text || '');
  let naoBrancos = 0;
  let letras = 0;
  let minusculas = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    naoBrancos += 1;
    if (LETRA.test(ch)) {
      letras += 1;
      if (MINUSCULA.test(ch)) minusculas += 1;
    }
  }
  if (!naoBrancos) return 0;
  const palavras = s.toLowerCase().split(/[^a-zà-öø-ÿ]+/).filter((w) => w.length >= 2);
  if (!palavras.length) return 0;
  let acertos = 0;
  for (const w of palavras) if (COMUNS.has(w)) acertos += 1;
  const fracPalavras = acertos / palavras.length;
  const fracLetras = letras / naoBrancos;
  const fracMinusculas = letras ? minusculas / letras : 0;
  return fracPalavras * fracLetras * (0.4 + 0.6 * fracMinusculas);
}

/** Fração de caracteres de controle ou de substituição entre os não brancos. */
function garbageFraction(text) {
  let naoBrancos = 0;
  let lixo = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    naoBrancos += 1;
    if (c < 0x20 || c === 0xfffd || (c >= 0x7f && c < 0xa0)) lixo += 1;
  }
  return naoBrancos ? lixo / naoBrancos : 0;
}

/** O trecho é lixo de fonte (controle/substituição demais)? */
function isGarbled(text) {
  const s = String(text || '');
  if (s.replace(/\s/g, '').length < 4) return false;
  return garbageFraction(s) >= 0.03;
}

/**
 * Códigos de um trecho: os originais, quando layout.js conseguiu alinhar com a
 * lista de operadores (`item.codes`), ou os do próprio texto. `null` = espaço
 * que o pdf.js inseriu para justificar a linha — não é glifo e não se desloca
 * (senão vira "=").
 */
function codesOf(input) {
  if (Array.isArray(input)) return input;
  let str = input;
  if (input && typeof input === 'object') {
    if (Array.isArray(input.codes) && input.codes.length === [...String(input.str)].length) {
      if (!Array.isArray(input.ins) || !input.ins.length) return input.codes;
      // glifo que o texto do pdf.js perdeu (o "Ã" da fonte embaralhada): volta
      // no lugar dele
      const out = [];
      input.codes.forEach((c, i) => {
        for (const x of input.ins) if (x.at === i) out.push(...x.codes);
        out.push(c);
      });
      for (const x of input.ins) if (x.at >= input.codes.length) out.push(...x.codes);
      return out;
    }
    str = input.str;
  }
  return [...String(str || '')].map((ch) => (ch === ' ' ? null : ch.codePointAt(0)));
}

/** Começa com sinal que fecha (vai para o fim do item anterior): ")", "”", ".", ",". */
const FECHA = /^[)\]}”’».,;:!?]/;

/** Código do glifo → caractere pela ordem do Arial. */
function decodeArialGlyphs(input) {
  let out = '';
  for (const c of codesOf(input)) {
    if (c == null) out += ' ';
    else if (c <= 2) out += '';
    else if (c <= 97) out += String.fromCodePoint(c + 29);
    else out += ARIAL_GLYPHS[c] ?? '\uFFFD';
  }
  return out;
}

/** Desloca o código dos caracteres de um byte (ASCII e Latin-1). */
function shiftCodes(input, delta) {
  let out = '';
  for (const c of codesOf(input)) {
    if (c == null) {
      out += ' ';
      continue;
    }
    if (c > 0xff) {
      out += String.fromCodePoint(c);
      continue;
    }
    const n = c + delta;
    if (n === 0x20 || (n > 0x20 && n < 0x7f) || (n >= 0xa0 && n <= 0xff)) out += String.fromCodePoint(n);
    else out += '\uFFFD';
  }
  return out;
}

const AMOSTRA_MAX = 30_000;
/** Escore mínimo de uma decodificação para ser aplicada. */
const ESCORE_MINIMO = 0.12;

/** Tentativas para uma fonte: tabela do Arial e deslocamentos de −60 a +60. */
function candidates() {
  const list = [{ method: 'glifos-arial', fn: decodeArialGlyphs }];
  for (let d = -60; d <= 60; d += 1) {
    if (d === 0) continue;
    list.push({ method: `deslocamento${d > 0 ? '+' : ''}${d}`, shift: d, fn: (s) => shiftCodes(s, d) });
  }
  return list;
}

/**
 * Escolhe a melhor decodificação para um texto. Devolve
 * `{ method, score, original }` (method null = nada melhorou o bastante).
 */
function bestDecoding(sample) {
  const codes = codesOf(sample);
  const asText = codes.map((c) => (c == null ? ' ' : String.fromCodePoint(c))).join('');
  const original = legibilityScore(asText.replace(/[\x00-\x1f]/g, ' '));
  let best = { method: null, fn: null, score: original };
  for (const c of candidates()) {
    const decoded = c.fn(codes);
    // caractere de substituição conta como lixo: tira um pouco do escore
    const score = legibilityScore(decoded) * (1 - Math.min(0.5, garbageFraction(decoded) * 5));
    if (score > best.score) best = { method: c.method, fn: c.fn, score };
  }
  const ok = best.method && best.score >= ESCORE_MINIMO && best.score > original * 3;
  return { method: ok ? best.method : null, fn: ok ? best.fn : null, score: best.score, original };
}

/**
 * Corrige no lugar os itens de texto das fontes embaralhadas do layout.
 * Itens que não deu para ler ficam com `illegible: true`.
 * Devolve um relatório por fonte suspeita: `[{ font, name, method, before, after, illegible }]`.
 */
function decodeLayout(layout) {
  const porFonte = new Map();
  for (const page of layout.pages || []) {
    for (const t of page.texts || []) {
      if (!t.str) continue;
      const key = t.fontId || t.font || '';
      let g = porFonte.get(key);
      if (!g) {
        g = { key, name: t.font || '', items: [], sample: '', codes: [] };
        porFonte.set(key, g);
      }
      g.items.push(t);
      if (g.sample.length < AMOSTRA_MAX) {
        g.sample += `${t.str} `;
        g.codes.push(...codesOf(t), null);
      }
    }
  }
  const relatorio = [];
  for (const g of porFonte.values()) {
    const info = (layout.fonts && layout.fonts[g.key]) || {};
    const nome = info.name || g.name;
    if (FONTE_DE_SIMBOLO.test(nome)) continue;
    const naoBrancos = g.sample.replace(/\s/g, '').length;
    if (naoBrancos < 12) continue;
    const lixo = garbageFraction(g.sample);
    const letras = (g.sample.match(/[a-zà-öø-ÿ]/gi) || []).length;
    const escore = legibilityScore(g.sample.replace(/[\x00-\x1f]/g, ' '));
    // Suspeita: lixo de controle visível, ou muito texto sem palavra nenhuma
    // reconhecível vindo de fonte sem tabela de caracteres.
    const suspeita = lixo >= 0.03 || (letras >= 200 && escore < 0.03 && info.toUnicode === false);
    if (!suspeita) continue;
    const melhor = bestDecoding(g.codes);
    const entrada = { font: g.key, name: nome, method: melhor.method, before: round3(melhor.original), after: round3(melhor.score), illegible: false };
    if (melhor.fn) {
      let anterior = null;
      for (const t of g.items) {
        t.raw = t.str;
        t.str = melhor.fn(codesOf(t));
        t.decoded = melhor.method;
        // glifo que ficou entre dois itens: fecha o anterior ou abre este. Se
        // o fim do anterior já tem esses sinais, é o mesmo glifo desenhado de
        // novo (o PPL 2017 redesenha o fim de alguns parágrafos) — fica fora.
        if (Array.isArray(t.lead) && t.lead.length) {
          const extra = melhor.fn(t.lead);
          const repetido = anterior && [...extra].every((c) => anterior.str.slice(-4).includes(c));
          if (repetido) {
            // nada
          } else if ((FECHA.test(extra) || /^"[.,;:!?)]/.test(extra)) && anterior) anterior.str += extra;
          else t.str = extra + t.str;
        }
        if (Array.isArray(t.trail) && t.trail.length) {
          const extra = melhor.fn(t.trail);
          if (![...extra].every((c) => t.str.slice(-4).includes(c))) t.str += extra;
        }
        if (isGarbled(t.str)) t.illegible = true;
        anterior = t;
      }
    } else if (lixo >= 0.03) {
      entrada.illegible = true;
      for (const t of g.items) t.illegible = true;
    }
    relatorio.push(entrada);
  }
  return relatorio;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = {
  ARIAL_GLYPHS,
  FONTE_DE_SIMBOLO,
  legibilityScore,
  garbageFraction,
  isGarbled,
  codesOf,
  decodeArialGlyphs,
  shiftCodes,
  bestDecoding,
  decodeLayout,
};

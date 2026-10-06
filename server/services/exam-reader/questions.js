'use strict';

/**
 * Questões a partir da estrutura: região, enunciado, alternativas, apoio
 * compartilhado e alertas.
 *
 *   const { readQuestions } = require('./questions');
 *   const { questions, discarded } = readQuestions(estrutura);
 *
 * A região de uma questão vai da marca até o fim da alternativa E — na mesma
 * coluna ou continuando na próxima coluna/página — e NUNCA até a próxima marca
 * de forma cega: o que sobra entre o fim da E e a próxima marca (título de
 * área, "Questões de 46 a 90", a proposta de redação inteira) é descartado.
 * A exceção é o texto de apoio anunciado ("Leia o texto para responder às
 * questões de 23 a 27"), que entra no começo do enunciado de cada questão
 * anunciada, da mesma variante de idioma.
 *
 * O enunciado sai em markdown seguro (sem HTML): parágrafos separados por
 * linha em branco, verso e linha curta preservados com quebra simples (as telas
 * renderizam com `breaks`), "TEXTO I" e referência em linha própria.
 *
 * Figuras: esta etapa ainda não recorta nada. Onde há imagem ou desenho, o
 * texto guarda a posição com o marcador `![Figura](figura:N)` — N é o índice em
 * `figures` — e a etapa de figuras troca pelo recorte (e a integração, pela URL).
 */
const { analyze, joinItems, splitWords, median, fsKey, TITULO_AREA, MARCA_ENEM } = require('./structure');
const { charBoxes } = require('./structure');
const { isGarbled } = require('./decode');
const { detectFigures, formulaFigure, withoutFigureText } = require('./figures');
const { M, MARCAS, stripMarks, tidyMarks, toMarkdown, figureMark } = require('./markup');

const LETRAS = ['A', 'B', 'C', 'D', 'E'];

/** Anúncio de texto de apoio compartilhado (sobre o parágrafo já juntado). */
const ANUNCIO_APOIO = [
  /(?:responder|resolver|resolução)\s+(?:d?[àa]s?|para\s+as)\s+quest(?:ões|ão|oes)\s+(?:de\s+)?0*(\d{1,3})\s*(?:,|a|e|até|à)\s*0*(\d{1,3})/i,
  /^(?:texto|textos|leia|considere|observe|examine|com\s+base)\b.{0,200}?quest(?:ões|oes)\s+(?:de\s+)?0*(\d{1,3})\s*(?:a|e|até|à)\s*0*(\d{1,3})/i,
];

/** Fontes de letra de alternativa (círculo com a letra, no ENEM). */
const FONTE_LETRA = /Bundesbahn|PiStd|Dingbat|ZapfDingbats/i;

/** Uma linha é título curto em negrito ("TEXTO I", "Inspiração no lixo")? */
function isTitleLine(line) {
  return line.type === 'text' && line.bold && line.text.length <= 70 && /\p{L}/u.test(line.text) && !/[.:;,]$/.test(line.text);
}

/** "TEXTO I", "Texto II", "Text I" — título de texto, sempre em linha própria. */
const TITULO_DE_TEXTO = /^text(?:o|os)?\s+[ivx\d]+\b/i;

/**
 * Escapa o que o markdown em linha interpretaria (ênfase, link, HTML, código,
 * e as marcas do leitor: "++", "^{", "_{"). É o que basta para alternativa:
 * as telas a mostram com mdInline. As marcas de formatação do leitor
 * (markup.js) passam sem ser tocadas — viram markdown depois.
 */
function escapeInline(text) {
  let s = String(text || '');
  s = s.replace(/[\\`*_[\]<>~]/g, (c) => `\\${c}`);
  s = s.replace(/&(?=#?\w+;)/g, '\\&');
  s = s.replace(/\+\+/g, '\\+\\+').replace(/\^\{/g, '\\^{');
  return s;
}

/** Texto rico (com as marcas do leitor) → markdown em linha, escapado. */
function inlineMarkdown(rich, opts) {
  return toMarkdown(escapeInline(rich), opts);
}

/**
 * Escapa uma linha de enunciado (markdown de bloco): além do que vale em
 * linha, começo de linha que viraria lista, título ou citação. Nada de HTML
 * sai daqui.
 */
function escapeMarkdown(text) {
  let s = escapeInline(text).replace(/\|/g, '\\|');
  s = s.replace(/^(\s*)([#>+=-])/, '$1\\$2');
  s = s.replace(/^(\s*\d+)([.)])(\s|$)/, '$1\\$2$3');
  return s;
}

/**
 * Junta duas linhas do mesmo parágrafo. Hífen de fim de linha: o ENEM não
 * hifeniza (o hífen é de palavra composta: "cana-" + "de-açúcar" fica); o
 * VUNESP hifeniza muito ("impera-" + "dor" → "imperador"), e repete o hífen na
 * linha de baixo quando ele é da palavra ("alcunhando-" + "-me"). As marcas de
 * formatação na emenda (itálico que fecha numa linha e reabre na outra) não
 * atrapalham o hífen.
 */
function joinText(a, b, ctx) {
  const tailMarks = /[\ue700-\ue709]*$/.exec(a)[0];
  const headMarks = /^[\ue700-\ue709]*/.exec(b)[0];
  const x = a.slice(0, a.length - tailMarks.length);
  const y = b.slice(headMarks.length);
  const glue = (left, sep, right) => `${left}${tailMarks}${sep}${headMarks}${right}`;
  const px = stripMarks(x);
  const py = stripMarks(y);
  if (/\p{L}-$/u.test(px) && x.endsWith('-')) {
    if (y.startsWith('-')) return glue(x.slice(0, -1), '', y);
    if (!ctx.hyphenates) return glue(x, '', y);
    const last = /(\p{L}+)-$/u.exec(px)[1];
    const next = (/^\p{L}+/u.exec(py) || [''])[0];
    if (next && ctx.hyphenWords.has(`${last}-${next}`.toLowerCase())) return glue(x, '', y);
    // pronome enclítico depois de verbo ("elaboraram-" + "se"): o hífen é da palavra
    if (ENCLITICO.test(next) && last.length >= 4 && FIM_DE_VERBO.test(last)) return glue(x, '', y);
    if (/(?:https?:|www\.|\/)\S*$/i.test(px)) return glue(x, '', y);
    if (next && /^\p{Ll}/u.test(next)) return glue(x.slice(0, -1), '', y);
    return glue(x, '', y);
  }
  if (!px) return `${a}${b}`;
  if (!py) return `${a}${b}`;
  return glue(x, ' ', y);
}

/** Pronomes enclíticos e terminações verbais que os precedem ("tirá-los", "consolidou-se"). */
const ENCLITICO = /^(?:se|me|te|lhe|lhes|lo|la|los|las|nos|vos|no|na|nas)$/i;
const FIM_DE_VERBO = /(?:am|em|ou|eu|iu|ar|er|ir|ão|ei|ndo|ava|ia|[áêíô])$/i;

/** Começo de item de lista: "1.", "a)", "II.", "•", "–", "( )" ("R. R. Martin" é nome, não item). */
const LISTA = /^(?:\d{1,2}[.)]|\(\d{1,2}\)|[a-z]\)|[A-Z]\)|[IVX]{1,4}[.)–-]|[•▪●◦–-]|\(\s*\))\s/;

/** Entrelinha do corpo na prova (structure.typicalLeading), ou null. */
function leadingOf(ctx, fs) {
  return (ctx && ctx.leading && ctx.leading[fsKey(fs)]) || null;
}

/**
 * Quanto a linha passa do corpo do texto para baixo e para cima (fórmula
 * recortada no meio dela, fração montada): a matriz de 43 pt no meio da frase
 * afasta as linhas de cima e de baixo, sem ser parágrafo novo.
 */
function inkBeyond(l) {
  const figs = [
    ...(l.inlineFigs || []).map((f) => ({ y0: f.y0, y1: f.y1 })),
    ...(l.formulaBox ? [l.formulaBox] : []),
    ...(l.items || []).filter((t) => t.fraction).map((t) => t.fraction),
  ];
  const fs = l.fs || 0;
  return {
    below: Math.max(0, ...figs.map((f) => f.y1 - (l.base + 0.25 * fs))),
    above: Math.max(0, ...figs.map((f) => l.base - 0.8 * fs - f.y0)),
  };
}

/** Linha com fração montada (que virou "1/4") ou símbolo bem maior: a entrelinha em volta cresce. */
function tallLine(l) {
  if ((l.inlineFigs || []).some((f) => f.y1 - f.y0 > 1.2 * l.fs)) return true;
  if (l.formulaBox && l.formulaBox.y1 - l.formulaBox.y0 > 1.2 * l.fs) return true;
  return (l.items || []).some((t) => t.fraction || (t.str.trim() && t.fs > 1.25 * l.fs));
}

/**
 * Relação entre duas linhas seguidas: mesmo parágrafo ('join'), quebra simples
 * ('break', verso e linha curta) ou parágrafo novo ('para').
 *
 * O texto das provas é justificado: linha que vai até a margem direita da
 * coluna continua na de baixo; linha que termina antes é fim de parágrafo ou
 * verso — e o espaço entre as duas decide: entrelinha a mais que a do corpo
 * (13,4 contra 12 pt no VUNESP) é parágrafo novo. Recuo de primeira linha (17
 * pt no ENEM/VUNESP, 14 no FGV) abre parágrafo — também quando a linha de
 * cima também era recuada e cheia (um parágrafo de uma linha só, como
 * "Conheci outrora uma família..." seguido de "Havia em sua casa..."). Item de
 * lista ("II.", "( )") nunca continua a linha de cima. Referência alinhada à
 * direita quebra em linhas que começam em qualquer x, mas todas terminam na
 * margem: continua. `ctx.prevStarted`: a linha de cima abriu parágrafo.
 */
/** Largura da primeira palavra da linha (estimada pelo item). */
function firstWordWidth(line) {
  const first = (line.items || []).filter((t) => t.str.trim()).sort((a, b) => a.x - b.x)[0];
  if (!first) return 0;
  const boxes = charBoxes(first);
  const start = boxes.findIndex((b) => b.c.trim());
  let end = start;
  while (end + 1 < boxes.length && boxes[end + 1].c.trim()) end += 1;
  return start < 0 ? 0 : boxes[end].x1 - boxes[start].x0;
}

/**
 * A linha de cima foi até onde dava: chega na margem direita, ou a primeira
 * palavra da linha de baixo não caberia no que sobrou (texto alinhado à
 * esquerda, sem justificar: "...em 2010. No" / "Campeonato Mundial...").
 */
function filledLine(prev, cur, ctx = {}) {
  const right = prev.right || prev.x1;
  if (prev.x1 >= right - 5) return true;
  if (!cur || cur.page !== prev.page || cur.col !== prev.col) return false;
  // só no texto sem justificar (coluna "rasgada", referência miúda): no
  // justificado, linha que não chega na margem acabou de propósito
  const ragged = prev.ragged || (ctx.bodyFs && prev.fs < 0.92 * ctx.bodyFs);
  // (coluna justificada com um trecho alinhado à esquerda — as minibiografias
  // do ENEM 2024 Q10: a linha para a 7 pt da margem porque "Campeonato" não
  // cabia — vale o mesmo, mas só bem perto da margem)
  if (!ragged && right - prev.x1 > prev.fs) return false;
  return right - prev.x1 < firstWordWidth(cur) + 0.3 * prev.fs;
}

function relation(prev, cur, next = null, ctx = {}) {
  const sameBox = cur.page === prev.page && cur.col === prev.col;
  // até a margem (texto justificado) / ou até onde a palavra seguinte cabia
  const prevAtMargin = prev.x1 >= (prev.right || prev.x1) - 5;
  const prevFull = filledLine(prev, cur, ctx);
  const curFull = cur.x1 >= (cur.right || cur.x1) - 5;
  const indent = cur.x0 - (cur.margin ?? cur.x0);
  const firstLineIndent = indent >= 8 && indent <= 30;
  const listStart = LISTA.test(cur.text);
  if (isTitleLine(prev) && isTitleLine(cur)) {
    // título em duas linhas ("Brasil sobe cinco posições no ranking do IDH e" /
    // "está na 84ª colocação"): uma frase só
    const continues = sameBox && cur.base > prev.base && cur.base - prev.base <= 1.6 * Math.max(prev.fs, cur.fs)
      && Math.abs(prev.fs - cur.fs) <= 0.3 && !TITULO_DE_TEXTO.test(prev.text) && !TITULO_DE_TEXTO.test(cur.text)
      && !/[.:!?]$/.test(prev.text);
    return continues ? 'join' : 'para';
  }
  // título partido na vírgula ("Telemedicina é para todos," / "mas nem
  // todos estão preparados"): a linha de baixo continua em minúscula
  if (prev.bold && cur.bold && sameBox && /,$/.test(prev.text) && /^\p{Ll}/u.test(cur.text)
    && cur.base > prev.base && cur.base - prev.base <= 1.6 * Math.max(prev.fs, cur.fs)) return 'join';
  // título de obra em negrito na referência, até a margem direita, e a
  // referência continua na linha de baixo: mesma referência
  if (isTitleLine(prev) && !isTitleLine(cur) && prevFull && sameBox && Math.abs(prev.fs - cur.fs) <= 0.3
    && cur.base > prev.base && cur.base - prev.base <= 1.4 * Math.max(prev.fs, cur.fs)) return 'join';
  if (isTitleLine(prev) || isTitleLine(cur)) return 'para';
  if (Math.abs(prev.fs - cur.fs) > 1.2) return 'para';
  if (!sameBox) return prevFull && !firstLineIndent && !listStart ? 'join' : 'para';
  const dy = cur.base - prev.base;
  const fs = Math.max(prev.fs, cur.fs);
  // linha com fração montada é mais alta: a entrelinha em volta dela cresce
  // sem ser parágrafo novo
  const tall = tallLine(prev) || tallLine(cur);
  // palavra partida no fim da linha cheia ("determinan-" / "tes"): continua,
  // mesmo com um vão grande no meio (a fórmula da linha de cima empurra)
  if (prevFull && dy > 0 && dy <= 3.2 * fs && /\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(cur.text)) return 'join';
  // parágrafo com entrelinha dupla (todas as linhas em volta igualmente
  // afastadas) não é um parágrafo por linha
  const wide = ctx.localLead && ctx.localLead > 1.3 * fs && dy <= 1.08 * ctx.localLead;
  // (a fórmula no meio da frase vem com folga própria em volta; a frase que
  // continua — sem ponto e com minúscula na linha de baixo — tolera mais)
  const continues = !/[.:!?]$/.test(stripMarks(prev.text || '').trim()) && /^\p{Ll}/u.test(cur.text || '');
  const limit = tall ? Math.max(2.8 * fs, (continues ? 2.75 : 1.75) * fs + inkBeyond(prev).below + inkBeyond(cur).above) : 1.75 * fs;
  if (dy < 0 || (dy > limit && !wide)) return 'para';
  // título centrado em duas linhas ("Extração global de recursos, quatro
  // categorias principais" / "de recursos, 1970-2024, ..."): continua
  const left = cur.left ?? cur.margin ?? cur.x0;
  const mid = (left + (cur.right || cur.x1)) / 2;
  const centered = (l) => Math.abs((l.x0 + l.x1) / 2 - mid) < 4 && l.x0 > left + 6;
  if (centered(prev) && centered(cur) && dy <= 1.6 * fs) {
    return !/[.:!?]$/.test(prev.text) && /^\p{Ll}/u.test(cur.text) ? 'join' : 'break';
  }
  // entrelinha das linhas em volta (o poema tem entrelinha maior que a prosa;
  // o espaço de parágrafo é maior que o das linhas em volta)
  const lead = ctx.localLead || leadingOf(ctx, prev.fs);
  // item de lista um pouco mais espaçado que a entrelinha continua a lista
  if (listStart && !(lead && dy > 1.4 * lead)) return 'break';
  if (lead && !prevAtMargin && !tall && dy > 1.08 * lead && dy - lead > 0.1 * fs) return 'para';
  // a linha de cima foi até a margem e a frase acabou nela; o espaço a mais
  // (um quarto de corpo) é o do parágrafo — o comando da questão do ENEM
  // ("…cada vez menores." / "Em qual região espectral…") vinha colado
  // (só no corpo do texto: a referência miúda tem entrelinha própria)
  if (lead && prevAtMargin && !tall && dy > 1.18 * lead && dy - lead > 0.22 * fs && ctx.bodyFs && prev.fs >= 0.92 * ctx.bodyFs
    && /[.:!?)”"]$/.test(stripMarks(prev.text).trim()) && /^[\p{Lu}\d“"(•]/u.test(cur.text)) return 'para';
  if (listStart) return 'break';
  if (cur.x0 > prev.x0 + 8) {
    // item de lista com recuo pendurado ("1. Genética: ... são" / "um pouco
    // mais elevadas."): a linha recuada continua o item
    if (prevFull && LISTA.test(prev.text)) return 'join';
    // referência alinhada à direita (letra menor): cada linha começa onde
    // calhar e todas vão até a margem — continua
    if (prevFull && curFull && ctx.bodyFs && cur.fs < 0.92 * ctx.bodyFs) return 'join';
    if (firstLineIndent) return 'para';
    if (prevFull && curFull) return 'join';
    return 'break';
  }
  if (firstLineIndent && Math.abs(cur.x0 - prev.x0) <= 2 && ctx.prevStarted) {
    if (!prevFull) return 'para';
    if (next && next.type === 'text' && next.page === cur.page && next.col === cur.col && next.x0 < cur.x0 - 8) return 'para';
  }
  return prevFull ? 'join' : 'break';
}

/**
 * Linhas → parágrafos (texto rico). Cada parágrafo: `{ rows: [texto], title }`.
 * `textOf(line)` permite trocar o texto da linha (alternativa sem a letra) —
 * é o texto rico (com as marcas de formatação) que vai para as linhas.
 */
function toParagraphs(lines, ctx, textOf = (l) => (l.rich != null ? l.rich : l.text)) {
  const list = lines.filter((l) => stripMarks(textOf(l)).trim() || /\ue70a/.test(textOf(l)));
  const verse = verseLines(list);
  const gaps = localGaps(list);
  const out = [];
  let cur = null;
  let prev = null;
  let started = true;
  list.forEach((line, i) => {
    const text = textOf(line);
    if (!cur) {
      cur = { rows: [text], title: isTitleLine(line) };
      started = true;
    } else {
      let rel = relation(prev, line, list[i + 1] || null, { ...ctx, prevStarted: started, localLead: localLead(gaps, i, ctx, prev) });
      // dentro de poema, linha é linha; "[mother" é a continuação do verso.
      // Mas a linha cheia seguida de minúscula é frase que continua (prosa
      // curta no meio de linhas curtas)
      const prose = filledLine(prev, line, ctx) && /^\p{Ll}/u.test(line.text);
      // ("[...] I remember" na margem, depois de linha cheia, é prosa: continua)
      const bracketProse = prose || (filledLine(prev, line, ctx) && Math.abs(line.x0 - (line.margin ?? line.x0)) <= 3);
      if (((verse.has(line) && !prose) || (/^\[(?:\p{Ll}|\.\.\.)/u.test(line.text) && sameBlock(prev, line) && !bracketProse)) && !isTitleLine(prev) && !isTitleLine(line)) {
        rel = 'break';
      }
      started = rel === 'para';
      // linha que não é título juntada ao título: o parágrafo deixa de ser
      // título (o negrito fica só no trecho em negrito)
      if (rel !== 'para' && cur.title && !isTitleLine(line)) cur.title = false;
      if (rel === 'join') cur.rows[cur.rows.length - 1] = joinText(cur.rows[cur.rows.length - 1], text, ctx);
      else if (rel === 'break') cur.rows.push(text);
      else {
        out.push(cur);
        cur = { rows: [text], title: isTitleLine(line) };
      }
    }
    prev = line;
  });
  if (cur) out.push(cur);
  return out;
}

/** Duas linhas seguidas do mesmo bloco (mesma coluna, corpo e entrelinha normal). */
function sameBlock(prev, line) {
  return prev.page === line.page && prev.col === line.col && Math.abs(prev.fs - line.fs) <= 1.2
    && line.base > prev.base && line.base - prev.base <= 1.75 * Math.max(prev.fs, line.fs);
}

/** Distância entre cada linha e a anterior (null quando não são do mesmo bloco). */
function localGaps(list) {
  return list.map((line, i) => {
    const prev = list[i - 1];
    if (!prev || prev.page !== line.page || prev.col !== line.col || tallLine(prev) || tallLine(line) || Math.abs(prev.fs - line.fs) > 0.3) return null;
    const dy = line.base - prev.base;
    // (até duas linhas e meia: o texto com entrelinha dupla também tem a sua)
    return dy > 0 && dy <= 2.6 * line.fs ? { dy, fs: line.fs } : null;
  });
}

/**
 * Entrelinha em volta da linha i: a menor distância entre linhas seguidas
 * das três de cada lado (o poema tem entrelinha própria; a prosa, a do corpo).
 * Sem vizinhas, a entrelinha da prova.
 */
function localLead(gaps, i, ctx, prev) {
  // (só linhas do mesmo corpo: a referência miúda tem entrelinha própria)
  const same = (g) => g != null && Math.abs(g.fs - prev.fs) <= 0.3;
  const near = [];
  for (let j = Math.max(1, i - 3); j <= Math.min(gaps.length - 1, i + 3); j += 1) if (j !== i && same(gaps[j])) near.push(gaps[j].dy);
  if (same(gaps[i])) near.push(gaps[i].dy);
  if (near.length >= 2) return Math.min(...near);
  return leadingOf(ctx, prev.fs);
}

/**
 * Linhas de poema: num bloco de 4+ linhas seguidas (mesma coluna, mesma
 * entrelinha), prosa justificada tem quase todas as linhas até a margem
 * direita; verso, quase nenhuma. Devolve o conjunto das linhas (menos a
 * primeira de cada bloco) que devem ficar como estão. O bloco quebra onde a
 * distância entre linhas cresce (espaço de parágrafo, de estrofe).
 */
function verseLines(lines) {
  // estrofes: linhas seguidas com a mesma entrelinha
  const stanzas = [];
  let block = [];
  let minDy = Infinity;
  // (a linha que continua o verso — "[mother" — vem mais colada: não conta
  // para a entrelinha do poema)
  const wrapped = (l) => /^\[/.test(l.text || '');
  for (const line of lines) {
    const prev = block[block.length - 1];
    const dy = prev ? line.base - prev.base : 0;
    if (!prev || !sameBlock(prev, line) || (!wrapped(line) && dy > 1.2 * minDy + 0.3)) {
      if (block.length) stanzas.push({ lines: block, minDy });
      block = [];
      minDy = Infinity;
    } else if (!wrapped(line)) {
      minDy = Math.min(minDy, dy);
    }
    block.push(line);
  }
  if (block.length) stanzas.push({ lines: block, minDy });
  // poema: estrofes seguidas (o vão entre elas é de uma ou duas linhas);
  // prosa justificada tem quase todas as linhas até a margem direita, verso
  // quase nenhuma
  const out = new Set();
  let poem = [];
  const close = () => {
    const all = poem.flatMap((st) => st.lines);
    const inner = poem.flatMap((st) => st.lines.slice(0, -1));
    if (all.length >= 4 && inner.length) {
      const full = inner.filter((l, k) => l.x1 >= (l.right || l.x1) - 5 && !wrapped(all[all.indexOf(l) + 1] || {})).length;
      if (full / inner.length < 0.4) for (const st of poem) for (const l of st.lines.slice(1)) out.add(l);
    }
    poem = [];
  };
  // estrofe de prosa (quase toda linha até a margem) não entra no poema
  // (o verso longo que quebra com "[" na linha de baixo é poema, mesmo indo
  // até a margem)
  const proseStanza = (st) => {
    if (st.lines.some(wrapped)) return false;
    const inner = st.lines.slice(0, -1);
    return inner.length > 0 && inner.filter((l) => l.x1 >= (l.right || l.x1) - 5).length / inner.length >= 0.4;
  };
  for (const st of stanzas) {
    const last = poem[poem.length - 1];
    const a = last && last.lines[last.lines.length - 1];
    const b = st.lines[0];
    const lead = Math.min(last ? last.minDy : Infinity, st.minDy);
    const joins = last && !proseStanza(st) && !proseStanza(last) && a.page === b.page && a.col === b.col && Math.abs(a.fs - b.fs) <= 0.3
      && b.base > a.base && Number.isFinite(lead) && b.base - a.base <= 2.6 * lead && Math.abs(a.x0 - b.x0) <= 20;
    if (!joins) close();
    poem.push(st);
  }
  close();
  return out;
}

/**
 * Parágrafo em markdown. As marcas de formatação viram markdown depois do
 * escape; no título (a linha inteira já em negrito) o negrito de dentro sai.
 * `figure(n)`: markdown da figura n que ficou no meio da linha.
 */
function paragraphMarkdown(p, { figure } = {}) {
  const rows = p.rows
    .map((r) => (p.title ? r.split(M.B0).join('').split(M.B1).join('') : r))
    .map((r) => toMarkdown(escapeMarkdown(tidyMarks(r).trim()), { figure }))
    .filter((r) => r.trim());
  if (p.title) return rows.map((r) => `**${r}**`).join('\n');
  return rows.join('\n');
}

/** Item com cara de letra de alternativa? Devolve a letra (ou null). */
function letterOfItem(item, line) {
  const s = item.str.trim();
  if (!s) return null;
  // primeiro item visível da linha, ou com um vão grande antes (alternativas em grade)
  const before = line.items.filter((t) => t !== item && t.str.trim() && t.x1 <= item.x + 1);
  if (before.some((t) => t.x1 > item.x - 15)) return null;
  let m = /^\(([A-E])\)$/.exec(s);
  if (m) return { letter: m[1], merged: false, paren: true };
  m = /^\(([A-E])\)\s+\S/.exec(s);
  if (m && !before.length) return { letter: m[1], merged: true, paren: true };
  if (/^[A-E]$/.test(s) && (FONTE_LETRA.test(item.font || '') || item.bold)) return { letter: s, merged: false };
  return null;
}

/** Candidatas a letra numa lista de linhas: `[{ letter, item, line, merged }]`. */
function letterCandidates(lines) {
  const out = [];
  for (const line of lines) {
    if (line.type !== 'text' || line.isMark) continue;
    for (const item of line.items) {
      const l = letterOfItem(item, line);
      if (l) out.push({ ...l, item, line, x: item.x, cy: line.base - line.fs * 0.35 });
    }
  }
  out.sort((a, b) => a.line.pos - b.line.pos || a.x - b.x);
  return out;
}

/** Duas letras na mesma fileira (alternativas em grade; a letra C da 2022 Q163 fica 4 pt acima de A e B). */
function sameRow(a, b) {
  return a.line.page === b.line.page && a.line.col === b.line.col
    && Math.abs(a.line.base - b.line.base) < 0.6 * Math.max(a.line.fs, b.line.fs);
}

/** `b` está na altura de `a` ou depois, na ordem de leitura. */
function atOrAfter(b, a) {
  if (b.line.page !== a.line.page || b.line.col !== a.line.col) return b.line.pos > a.line.pos;
  return b.line.base >= a.line.base - 0.6 * a.line.fs;
}

/** Melhor sequência A→E dentro de um grupo de candidatas do mesmo estilo. */
function chainOf(cands) {
  const byLetter = Object.fromEntries(LETRAS.map((l) => [l, cands.filter((c) => c.letter === l)]));
  let best = null;
  for (let i = byLetter.A.length - 1; i >= 0; i -= 1) {
    const A = byLetter.A[i];
    const chosen = [A];
    for (const L of LETRAS.slice(1)) {
      const c = byLetter[L].find((x) => x !== A && atOrAfter(x, A));
      if (c) chosen.push(c);
    }
    if (!best || chosen.length > best.length) best = chosen;
    if (chosen.length === 5) break;
  }
  if (!best) {
    // sem A: a primeira de cada letra, em ordem
    best = [];
    let prev = null;
    for (const L of LETRAS.slice(1)) {
      const c = byLetter[L].find((x) => !prev || atOrAfter(x, prev));
      if (c) {
        best.push(c);
        prev = c;
      }
    }
  }
  return best;
}

/**
 * Escolhe a sequência A→E. A letra entre parênteses também aparece no meio do
 * enunciado ("(A) a introdução…") e uma figura pode ter rótulos "A", "B" em
 * negrito: as candidatas são agrupadas por estilo (letra em círculo do ENEM,
 * "(A)", ou a fonte), e em cada grupo vale a ÚLTIMA A que tem as outras letras
 * depois dela. Em grade, D e E ficam na fileira de A e B — por isso a
 * comparação é "na altura de A ou depois", não "depois da letra anterior".
 */
function chooseLetters(cands) {
  const groups = new Map();
  for (const c of cands) {
    const key = FONTE_LETRA.test(c.item.font || '') ? 'circulo' : c.paren ? 'parenteses' : `fonte:${c.item.font || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let best = null;
  for (const [key, list] of groups) {
    const chosen = chainOf(list);
    if (!chosen.length) continue;
    const score = chosen.length * 10 + (key.startsWith('fonte:') ? 0 : 5);
    const last = Math.max(...chosen.map((c) => c.line.pos));
    if (!best || score > best.score || (score === best.score && last > best.last)) best = { score, last, chosen };
  }
  return best ? best.chosen : [];
}

/** As letras escolhidas estão em grade (duas na mesma fileira)? */
function isGrid(letters) {
  for (let i = 0; i < letters.length; i += 1) {
    for (let j = i + 1; j < letters.length; j += 1) if (sameRow(letters[i], letters[j])) return true;
  }
  return false;
}

/** Texto da linha sem a letra (e sem o que está à esquerda dela). `rich`: com as marcas de formatação. */
function textAfterLetter(letter, x1Limit = Infinity, { rich = false } = {}) {
  const items = letter.line.items.filter((t) => t !== letter.item && t.x >= letter.item.x && t.x < x1Limit);
  const rest = letter.merged ? [{ ...letter.item, str: letter.item.str.replace(/^\s*\([A-E]\)\s*/, ''), x: letter.item.x + 1 }] : [];
  return joinItemsLite([...rest, ...items], { rich });
}

/** Junta itens já preparados, na ordem horizontal. */
function joinItemsLite(items, opts) {
  return joinItems(items.slice().sort((a, b) => a.x - b.x), opts);
}

/**
 * Linhas que continuam a última alternativa: mesma coluna, recuadas além da
 * letra, entrelinha normal, mesmo corpo. Para no primeiro sinal de outra coisa.
 */
function continuationOf(letter, span, fromPos) {
  const out = [];
  let prev = letter.line;
  for (const el of span) {
    if (el.pos <= fromPos) continue;
    if (el.type !== 'text') continue;
    if (el.page !== prev.page || el.col !== prev.col) break;
    if (el.isMark || el.heading) break;
    const dy = el.base - prev.base;
    if (dy <= 0 || dy > 1.45 * Math.max(prev.fs, el.fs)) break;
    if (el.x0 < letter.item.x + 6) break;
    if (Math.abs(el.fs - letter.line.fs) > 1.5) break;
    out.push(el);
    prev = el;
  }
  return out;
}

/** Faixa vertical de cada letra (para atribuir figura de alternativa). */
function letterSlots(letters) {
  return letters.map((L, i) => {
    // vizinhas de cima e de baixo: mesma coluna da grade (mesmo x), outra fileira
    const same = (o) => o && o.line.page === L.line.page && o.line.col === L.line.col && !sameRow(o, L) && Math.abs(o.x - L.x) < 20;
    const prevL = [...letters.slice(0, i)].reverse().find(same);
    const nextL = letters.slice(i + 1).find(same);
    const dPrev = prevL ? Math.abs(L.cy - prevL.cy) : null;
    const dNext = nextL ? Math.abs(nextL.cy - L.cy) : null;
    const d = dPrev ?? dNext ?? 3 * L.line.fs;
    return { letter: L, top: L.cy - (dPrev ?? d) / 2, bottom: L.cy + (dNext ?? d) / 2 };
  });
}

/**
 * Lê as questões. `analysis` vem de structure.analyze (ou é calculado aqui a
 * partir de um layout).
 */
function readQuestions(input, options = {}) {
  const analysis = input && input.lines ? input : analyze(input, options);
  const { pages, marks, kind, essayPages } = analysis;
  const ctx = { hyphenates: kind !== 'enem', hyphenWords: new Set(), leading: analysis.leading || {} };
  // corpo do texto (linhas longas): a referência é menor que ele
  ctx.bodyFs = median(analysis.lines.filter((l) => l.text.length > 40).map((l) => l.fs)) || null;
  for (const line of analysis.lines) {
    for (const m of line.text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) ctx.hyphenWords.add(m[0].toLowerCase());
  }

  // elementos em ordem de leitura: linhas + figuras (pela altura do topo)
  const markLinesByPage = new Map();
  for (const m of marks) {
    if (!markLinesByPage.has(m.page)) markLinesByPage.set(m.page, []);
    markLinesByPage.get(m.page).push(m.line);
  }
  const bodyFs = median(analysis.lines.filter((l) => l.text.length > 40).map((l) => l.fs)) || 10;
  // corpo do texto para as figuras: o tamanho com mais letras na prova (não
  // depende de haver linhas longas — prova curta, página de gráficos)
  const textFs = dominantFs(analysis.lines) || bodyFs;
  const pageByNumber = new Map(pages.map((p) => [p.page, p]));
  const firstMarkPage = marks.length ? Math.min(...marks.map((m) => m.page)) : Infinity;
  const elements = [];
  for (const p of pages) {
    const letterItems = [];
    for (const col of p.columns) {
      for (const line of col.lines) {
        for (const item of line.items) if (letterOfItem(item, line)) letterItems.push(item);
      }
    }
    // figuras da página; o texto que é delas (rótulo, célula de tabela) sai
    // das linhas. Capa e redação não têm questão: nada de figura (o texto
    // delas fica inteiro no descarte, para a auditoria)
    const semQuestao = p.page < firstMarkPage || essayPages.has(p.page);
    const { figures: figs, absorbed } = semQuestao ? { figures: [], absorbed: new Set() }
      : detectFigures(p, { markLines: markLinesByPage.get(p.page) || [], letterItems, bodyFs: textFs });
    for (const col of p.columns) {
      const colFigs = figs.filter((f) => f.col === col.index);
      let fi = 0;
      const pushFig = (f) => elements.push({
        type: 'figure', figure: f, page: p.page, col: col.index, x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1,
        base: f.y1, fs: 0, margin: col.margin, right: col.right, text: '',
      });
      for (const raw of col.lines) {
        const line = withoutFigureText(raw, absorbed);
        if (!line) continue;
        while (fi < colFigs.length && colFigs[fi].y0 < line.y0 - 1) pushFig(colFigs[fi++]);
        elements.push(line);
      }
      while (fi < colFigs.length) pushFig(colFigs[fi++]);
    }
  }
  elements.forEach((e, i) => { e.pos = i; });

  const used = new Set();
  const markPos = marks.map((m) => m.line.pos);
  const questions = [];
  const supports = [];
  const sobraInfo = [];

  for (let qi = 0; qi < marks.length; qi += 1) {
    const mark = marks[qi];
    const startPos = markPos[qi];
    const endPos = qi + 1 < marks.length ? markPos[qi + 1] : elements.length;
    used.add(startPos);
    const span = [];
    for (let p = startPos + 1; p < endPos; p += 1) {
      const el = elements[p];
      if (el.page > mark.page + 1) break;
      if (essayPages.has(el.page)) continue;
      span.push(el);
    }
    const cands = letterCandidates(span);
    const letters = chooseLetters(cands);
    const grid = isGrid(letters);
    const alternatives = [];
    const altLines = new Map(); // letra → linhas extras
    let regionEnd = startPos;
    let statementEnd = letters.length ? letters[0].line.pos : endPos;

    if (letters.length && !grid) {
      for (let i = 0; i < letters.length; i += 1) {
        const L = letters[i];
        const next = letters[i + 1];
        // linhas até a próxima letra — menos as que já são da próxima (o
        // numerador de uma fração montada fica acima da linha da letra)
        const closerToNext = (el) => next && el.formula && el.page === next.line.page && el.col === next.line.col
          && Math.abs((el.y0 + el.y1) / 2 - next.cy) < Math.abs((el.y0 + el.y1) / 2 - L.cy);
        const extra = next
          ? span.filter((el) => el.type === 'text' && el.pos > L.line.pos && el.pos < next.line.pos && !closerToNext(el))
          : continuationOf(L, span, L.line.pos);
        altLines.set(L, extra);
        regionEnd = Math.max(regionEnd, L.line.pos, ...extra.map((e) => e.pos));
      }
    } else if (letters.length && grid) {
      // grade: cada letra é uma célula; linhas de cima até a primeira fileira = enunciado
      statementEnd = Math.min(...letters.map((l) => l.line.pos));
      for (const L of letters) {
        const right = letters.filter((o) => o !== L && sameRow(o, L) && o.x > L.x);
        const xLimit = right.length ? Math.min(...right.map((o) => o.x)) - 1 : Infinity;
        L.xLimit = xLimit;
        const cont = continuationOf(L, span, L.line.pos).filter((el) => el.x0 < xLimit);
        altLines.set(L, cont);
        regionEnd = Math.max(regionEnd, L.line.pos, ...cont.map((e) => e.pos));
      }
    } else {
      regionEnd = span.length ? span[span.length - 1].pos : startPos;
    }

    // texto de cada alternativa (sem a letra; em grade, só a célula dela)
    const altText = new Map();
    for (const L of letters) {
      const extra = altLines.get(L) || [];
      // a primeira linha começa onde começa o texto (depois da letra): é com
      // esse x que as linhas de baixo (recuo pendurado) se alinham
      const firstItems = L.line.items.filter((t) => t !== L.item && t.str.trim() && t.x > L.item.x && t.x < (L.xLimit ?? Infinity));
      const first = {
        ...L.line,
        text: textAfterLetter(L, L.xLimit),
        rich: textAfterLetter(L, L.xLimit, { rich: true }),
        x0: firstItems.length ? Math.min(...firstItems.map((t) => t.x)) : L.line.x0,
        margin: firstItems.length ? Math.min(...firstItems.map((t) => t.x)) : L.line.margin,
      };
      const cell = (e) => e.items.filter((t) => t.x >= L.x && t.x < L.xLimit);
      const lineList = [first, ...extra.map((e) => (L.xLimit != null && L.xLimit !== Infinity
        ? { ...e, text: joinItemsLite(cell(e)), rich: joinItemsLite(cell(e), { rich: true }) } : e))];
      const paras = toParagraphs(lineList, ctx);
      const text = paras.map((p) => p.rows.map((r) => inlineMarkdown(tidyMarks(r).trim())).join(' ')).join(' ').trim();
      altText.set(L, { text, illegible: lineList.some((l) => l.illegible), formula: lineList.some((l) => l.formula) });
    }

    // figuras: alternativa (pela faixa da letra), enunciado (antes da A) ou sobra.
    // Desenho pequeno (traço, fração desenhada) só conta como figura quando é
    // tudo o que a alternativa tem.
    const slots = letterSlots(letters);
    const altFigures = new Map();
    const statementFigures = [];

    // alternativa que é fórmula montada que não virou texto (9 × 6!/(6 − 2)!,
    // função com chave): a alternativa inteira vira imagem — a faixa da letra,
    // da letra até o fim da coluna (ou até a letra vizinha, na grade). O
    // numerador que fica acima da linha da letra vem junto.
    const consumed = new Set();
    const formulaAlt = new Set();
    let formulaFailed = false;
    for (const slot of slots) {
      const L = slot.letter;
      const sameBox = (el) => el.type === 'text' && el.page === L.line.page && el.col === L.line.col;
      const xEnd = L.xLimit != null && L.xLimit !== Infinity ? L.xLimit - 1 : (L.line.colX1 ?? Infinity);
      const inBand = (el) => sameBox(el) && el.pos !== L.line.pos && (el.y0 + el.y1) / 2 >= slot.top && (el.y0 + el.y1) / 2 <= slot.bottom
        && el.x0 >= L.item.x1 - 2 && el.x0 < xEnd;
      const bandLines = span.filter(inBand);
      const formula = altText.get(L).formula || bandLines.some((el) => el.formula && el.pos < L.line.pos);
      if (!formula) continue;
      const P = pageByNumber.get(L.line.page);
      const fig = P && formulaFigure(P, { x0: L.item.x1 + 1, x1: Math.min(xEnd, P.width), y0: slot.top, y1: slot.bottom },
        { exclude: new Set([L.item]), col: L.line.col });
      if (!fig) {
        formulaFailed = true;
        continue;
      }
      const el = { type: 'figure', figure: fig, page: fig.page, col: fig.col, x0: fig.x0, x1: fig.x1, y0: fig.y0, y1: fig.y1, pos: L.line.pos };
      altFigures.set(L, [el]);
      formulaAlt.add(L);
      altText.set(L, { text: '', illegible: altText.get(L).illegible, formula: false });
      for (const b of bandLines) consumed.add(b.pos);
    }
    const altDrawn = [];
    for (const el of span) {
      if (el.type !== 'figure') continue;
      const cy = (el.y0 + el.y1) / 2;
      const slot = slots.find((s) => s.letter.line.page === el.page && s.letter.line.col === el.col
        && cy >= s.top && cy <= s.bottom && el.x0 >= s.letter.x - 4 && el.x0 < (s.letter.xLimit ?? Infinity));
      if (slot && letters.length) {
        // a alternativa já virou recorte inteiro (fórmula): o desenho está nele
        if (formulaAlt.has(slot.letter)) {
          used.add(el.pos);
          continue;
        }
        if (el.figure.small && altText.get(slot.letter).text) {
          // símbolo desenhado no meio do texto da alternativa (a raiz de
          // "11√2") que não virou recorte: o texto ficou sem ele
          if (!el.figure.rule) altDrawn.push({ el, letter: slot.letter });
          continue;
        }
        if (!altFigures.has(slot.letter)) altFigures.set(slot.letter, []);
        altFigures.get(slot.letter).push(el);
        regionEnd = Math.max(regionEnd, el.pos);
      } else if (el.pos < statementEnd && !el.figure.small) {
        statementFigures.push(el);
      }
    }
    // pedaços pequenos da mesma alternativa viram uma figura só
    for (const [L, list] of altFigures) {
      if (list.length < 2 || !list.every((f) => f.figure.small)) continue;
      const merged = { ...list[0], x0: Math.min(...list.map((f) => f.x0)), y0: Math.min(...list.map((f) => f.y0)), x1: Math.max(...list.map((f) => f.x1)), y1: Math.max(...list.map((f) => f.y1)) };
      merged.figure = { ...list[0].figure, crop: unionCrop(list.map((f) => f.figure.crop)) };
      for (const f of list) used.add(f.pos);
      altFigures.set(L, [merged]);
    }

    // enunciado; fórmula montada que não virou texto vira recorte no lugar
    const statementEls = formulaBlocks(
      span.filter((el) => el.pos < statementEnd && !consumed.has(el.pos) && (el.type === 'text' || statementFigures.includes(el))),
      pageByNumber,
      () => { formulaFailed = true; },
    );
    const figures = [];
    const figureRef = (el, label) => {
      figures.push(figureOut(el, label));
      return figures.length - 1;
    };
    const statementParts = [];
    let buffer = [];
    const inlineFigure = (n) => `![Fórmula](figura:${n})`;
    const flush = () => {
      if (buffer.length) statementParts.push(...toParagraphs(buffer, ctx).map((p) => paragraphMarkdown(p, { figure: inlineFigure })));
      buffer = [];
    };
    for (const el of statementEls) {
      for (const pos of el.covers || [el.pos]) used.add(pos);
      if (el.type === 'figure') {
        flush();
        const label = el.figure.kind === 'formula' ? 'Fórmula' : 'Figura';
        statementParts.push(`![${label}](figura:${figureRef(el, 'enunciado')})`);
      } else if (el.inlineFigs) {
        // fórmula no meio da frase: a marca local vira o índice da figura na questão
        const refs = el.inlineFigs.map((f) => figureRef(f, 'enunciado'));
        buffer.push({ ...el, rich: el.rich.replace(/\ue70a(\d+)\ue70b/g, (_, n) => figureMark(refs[Number(n)])) });
      } else {
        buffer.push(el);
      }
    }
    for (const pos of consumed) used.add(pos);
    flush();

    // alternativas
    for (const L of letters) {
      used.add(L.line.pos);
      for (const e of altLines.get(L) || []) used.add(e.pos);
      let { text } = altText.get(L);
      for (const f of altFigures.get(L) || []) {
        used.add(f.pos);
        const ref = `![Alternativa ${L.letter}](figura:${figureRef(f, L.letter)})`;
        text = text ? `${text} ${ref}` : ref;
      }
      alternatives.push({ letter: L.letter, text_md: text, illegible: altText.get(L).illegible });
    }

    const regionEls = span.filter((el) => el.pos <= regionEnd);
    const sobra = span.filter((el) => el.pos > regionEnd && !used.has(el.pos));
    const regions = regionBoxes([mark.line, ...regionEls], pageByNumber);
    const source = new Set([mark.page, ...regionEls.map((e) => e.page)]);
    const boxes = new Set([`${mark.page}:${mark.col}`, ...regionEls.map((e) => `${e.page}:${e.col}`)]);
    const statementText = statementEls.filter((e) => e.type === 'text').map((e) => e.text).join(' ');
    // desenho que sobrou no enunciado sem ir para recorte nenhum (letra em
    // contorno, símbolo desenhado): o texto pode ter perdido alguma coisa
    const insideCrop = (el) => figures.some((f) => f.page === el.page && f.crop
      && (el.x0 + el.x1) / 2 >= f.crop.x - 1 && (el.x0 + el.x1) / 2 <= f.crop.x + f.crop.w + 1
      && (el.y0 + el.y1) / 2 >= f.crop.y - 1 && (el.y0 + el.y1) / 2 <= f.crop.y + f.crop.h + 1);
    // (o enfeite do fio do cabeçalho, no alto da coluna, não conta)
    const belowTop = (el) => {
      const P = pageByNumber.get(el.page);
      return !P || el.y0 > (P.top || 0) + 6;
    };
    const drawnLeftEls = span.filter((el) => el.type === 'figure' && el.figure.small && !el.figure.rule && el.pos < statementEnd
      && !used.has(el.pos) && (el.x1 - el.x0) * (el.y1 - el.y0) >= 12 && !insideCrop(el) && belowTop(el));
    // (na alternativa: desenho do tamanho de uma letra ou mais, na altura da
    // linha da letra e entre o começo e o fim do texto dela)
    for (const { el, letter } of altDrawn) {
      const L = letter.line;
      const items = L.items.filter((t) => t !== letter.item && t.str.trim() && t.x > letter.item.x);
      if (!items.length || (el.x1 - el.x0) * (el.y1 - el.y0) < 12 || el.y1 - el.y0 < 0.5 * L.fs || insideCrop(el)) continue;
      const x0 = Math.min(...items.map((t) => t.x));
      const x1 = Math.max(...items.map((t) => t.x1));
      if ((el.x0 + el.x1) / 2 > x0 && (el.x0 + el.x1) / 2 < x1 && Math.min(el.y1, L.base + 0.2 * L.fs) - Math.max(el.y0, L.base - L.fs) > 0) drawnLeftEls.push(el);
    }
    const drawnLeft = drawnLeftEls.length;

    questions.push({
      number: mark.number,
      variant: mark.variant || null,
      statement_md: statementParts.join('\n\n'),
      alternatives,
      figures,
      alerts: [],
      source_pages: [...source].sort((a, b) => a - b),
      regions,
      _meta: {
        markPos: startPos,
        regionEnd,
        letters: letters.length,
        grid,
        boxes: boxes.size,
        statementText,
        illegible: statementEls.some((e) => e.illegible) || alternatives.some((a) => a.illegible),
        // fórmula que não virou texto nem recorte
        formula: formulaFailed || statementEls.some((e) => e.type === 'text' && e.formula) || letters.some((L) => altText.get(L).formula),
        statementFigures: statementFigures.length,
        drawnLeft,
        drawnLeftAt: drawnLeftEls.map((el) => ({ page: el.page, x: Math.round(el.x0), y: Math.round(el.y0), w: Math.round(el.x1 - el.x0), h: Math.round(el.y1 - el.y0) })),
      },
    });

    // apoio compartilhado na sobra, anunciando a(s) próxima(s) questão(ões);
    // sem anúncio, um bloco de texto corrido entre duas questões também é apoio
    // (o FGV põe o "Text I" antes das questões de inglês sem dizer quais)
    const support = findSupport(sobra, ctx) || findLooseSupport(sobra, ctx, bodyFs);
    sobraInfo.push({
      support: !!support,
      heading: sobra.some((el) => el.type === 'text' && (el.heading || TITULO_AREA.test(el.text))),
    });
    if (support) {
      for (const el of support.elements) used.add(el.pos);
      supports.push({ ...support, qi, variant: qi + 1 < marks.length ? marks[qi + 1].variant || null : null });
    }
  }

  // apoio antes da primeira questão (na mesma página dela)
  if (marks.length) {
    const first = marks[0];
    const pre = elements.filter((el) => el.pos < markPos[0] && el.page === first.page && !used.has(el.pos));
    const support = findSupport(pre, ctx) || findLooseSupport(pre, ctx, bodyFs);
    if (support) {
      for (const el of support.elements) used.add(el.pos);
      supports.push({ ...support, qi: -1, variant: first.variant || null });
    }
  }

  // anexa o apoio: anunciado → às questões da faixa (mesma variante); sem
  // anúncio → às questões seguintes até o próximo apoio, título de seção,
  // troca de idioma ou questão que traz o próprio "Text II"/"Texto II"
  for (const s of supports) {
    let targets;
    if (!s.loose) {
      targets = questions.filter((q) => q.number >= s.from && q.number <= s.to && (q.variant || null) === (s.variant || null));
    } else {
      targets = [];
      for (let j = s.qi + 1; j < questions.length && targets.length < 6; j += 1) {
        const q = questions[j];
        if ((q.variant || null) !== (s.variant || null)) break;
        if (targets.length && /^\*\*(?:text|texto)\s+[ivx\d]+\*\*/i.test(q.statement_md)) break;
        targets.push(q);
        if (sobraInfo[j] && (sobraInfo[j].support || sobraInfo[j].heading)) break;
      }
    }
    for (const q of targets) {
      const parts = [];
      for (const el of s.blocks) {
        if (el.type === 'figure') {
          q.figures.push(figureOut(el, 'apoio'));
          parts.push(`![Figura](figura:${q.figures.length - 1})`);
        } else {
          parts.push(el.md);
        }
      }
      q.statement_md = [...parts, q.statement_md].filter(Boolean).join('\n\n');
      // o apoio vem antes na região também: quem olha a imagem lê na ordem
      q.regions = [...regionBoxes(s.elements, pageByNumber), ...q.regions];
      q._meta.support = s.loose ? 'solto' : `${s.from}-${s.to}`;
      for (const p of s.pages) if (!q.source_pages.includes(p)) q.source_pages.push(p);
      q.source_pages.sort((a, b) => a - b);
    }
  }

  if (kind !== 'enem') shareEmbeddedTexts(questions);

  attachReferenceTable({ elements, used, questions, pageByNumber, essayPages });

  applyAlerts(questions);

  const discarded = [...analysis.discarded, ...classifyLeftovers(elements, used, marks, questions, essayPages)];
  for (const q of questions) {
    // o índice de figura do enunciado é relativo a `figures` da própria questão
    delete q._meta.statementText;
  }
  return { kind, questions, discarded, elements };
}

const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Tabela de consulta anunciada (Classificação Periódica)
// ---------------------------------------------------------------------------

/** "Considere a Classificação Periódica no final deste caderno.", "A Tabela Periódica a seguir deve ser usada…" */
const ANUNCIO_TABELA = /\b(classifica[çc][ãa]o|tabela)\s+peri[óo]dica\b/i;
/** A questão cita a tabela periódica (e precisa dela). */
const CITA_TABELA = /\b(?:classifica[çc][ãa]o|tabela)\s+peri[óo]dica\b/i;

const normal = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '');

/**
 * Título de matéria solto entre as questões ("Química", "Biologia", "FísiCa"):
 * linha curta, só letras, sem ponto final — o que separa as seções da prova.
 */
function subjectHeading(el) {
  if (el.type !== 'text') return false;
  const text = String(el.text || '').trim();
  return text.length >= 4 && text.length <= 45 && !/\d/.test(text) && !/[.:;,!?]$/.test(text) && /^\p{L}/u.test(text)
    && (el.heading || TITULO_AREA.test(text) || text.split(/\s+/).length <= 6);
}

/**
 * O desenho grande de uma página que não é de questão (a tabela periódica
 * inteira, girada, ou a imagem dela): a união das imagens e dos desenhos,
 * sem fio de coluna nem moldura, com o texto que fica dentro ou colado
 * (os símbolos, o título girado). Null quando a página não tem um desenho
 * que ocupe ao menos um sexto dela.
 */
function pageGraphic(P) {
  const W = P.width;
  const H = P.height;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (b) => {
    box.x0 = Math.min(box.x0, b.x);
    box.y0 = Math.min(box.y0, b.y);
    box.x1 = Math.max(box.x1, b.x + b.w);
    box.y1 = Math.max(box.y1, b.y + b.h);
  };
  let raster = false;
  let imageAngle = null;
  for (const im of P.images || []) {
    // (faixa do cabeçalho/rodapé de página inteira e fundo não contam)
    if (im.w * im.h < 2000 || (im.w > 0.9 * W && im.h < 0.15 * H) || (im.w > 0.95 * W && im.h > 0.95 * H)) continue;
    grow(im);
    raster = true;
    // imagem posta girada de lado na página (a da FGV 2025): o ângulo dela
    if (im.w * im.h >= W * H / 6 && Math.abs(Math.abs(im.angle || 0) - 90) <= 2) imageAngle = im.angle;
  }
  for (const p of P.paths || []) {
    if (p.w > 0.85 * W || p.h > 0.95 * H || (p.w <= 2.5 && p.h >= 0.3 * H)) continue;
    if (p.paint === 'fill' && typeof p.fc === 'string' && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(p.fc)) continue;
    grow(p);
  }
  if (!Number.isFinite(box.x0) || (box.x1 - box.x0) * (box.y1 - box.y0) < W * H / 6) return null;
  const texts = [...(P.columns || []).flatMap((c) => c.lines).flatMap((l) => l.items), ...(P.rotated || [])].filter((t) => t.str && t.str.trim());
  // (o título girado da tabela fica um pouco mais longe do desenho)
  const draw = { ...box };
  const nearBox = (t, d) => t.x < draw.x1 + d && t.x + t.w > draw.x0 - d && t.y < draw.y1 + d && t.y + t.h > draw.y0 - d;
  const nearText = texts.filter((t) => nearBox(t, t.rot ? 30 : 12) && t.w * t.h < 0.05 * W * H);
  for (const t of nearText) grow(t);
  const pad = 4;
  const crop = {
    x: r2(Math.max(0, box.x0 - pad)), y: r2(Math.max(0, box.y0 - pad)),
    w: r2(Math.min(W, box.x1 + pad) - Math.max(0, box.x0 - pad)), h: r2(Math.min(H, box.y1 + pad) - Math.max(0, box.y0 - pad)),
  };
  const out = { page: P.page, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, kind: raster ? 'imagem' : 'vetor', crop, small: false, text: '' };
  // tabela deitada na página em pé (o texto dela girado): o recorte é
  // endireitado — na tela, de lado, ela ficava estreita e ilegível
  const inside = nearText.filter((t) => t.rot && t.angle != null);
  const chars = (list) => list.reduce((n, t) => n + String(t.str).trim().length, 0);
  const horizontal = nearText.filter((t) => !t.rot && t.x + t.w / 2 > draw.x0 && t.x + t.w / 2 < draw.x1
    && t.y + t.h / 2 > draw.y0 && t.y + t.h / 2 < draw.y1);
  // (-90: lido de baixo para cima → gira 90° no sentido horário)
  if (box.y1 - box.y0 > 1.2 * (box.x1 - box.x0)) {
    const up = chars(inside.filter((t) => Math.abs(t.angle + 90) <= 10));
    const down = chars(inside.filter((t) => Math.abs(t.angle - 90) <= 10));
    if (chars(inside) > chars(horizontal) && up > 2 * down) out.rotate = 90;
    else if (chars(inside) > chars(horizontal) && down > 2 * up) out.rotate = -90;
    else if (imageAngle != null && !chars(horizontal)) out.rotate = imageAngle < 0 ? 90 : -90;
  }
  return out;
}

/** Texto da página inteira, sem espaço nem acento ("CLASSIFICAÇÃO PERIÓDICA" vem em letras soltas e girado). */
function pageText(P) {
  const items = [...(P.columns || []).flatMap((c) => c.lines).flatMap((l) => l.items), ...(P.rotated || [])];
  return normal(items.map((t) => t.str || '').join(''));
}

/**
 * Tabela periódica anunciada ("Considere a Classificação Periódica no final
 * deste caderno."; "A Tabela Periódica a seguir deve ser usada como apoio para
 * responder algumas questões de Química."): o anúncio e a tabela ficavam no
 * descarte, e as questões de Química que dependem dela iam ao banco sem ela.
 * A tabela — a página que não é de questão, com o título dela e um desenho
 * grande, mais perto do anúncio — vira figura de apoio no fim do enunciado
 * das questões da seção anunciada: a da matéria que o anúncio cita, ou a
 * seção em que ele está, até o próximo título de matéria. Questão que cita a
 * tabela fora da seção também recebe. Sem achar a tabela, essas questões
 * ganham o alerta 'figura_incerta' (vão à conferência).
 */
function attachReferenceTable({ elements, used, questions, pageByNumber, essayPages }) {
  const anuncios = elements.filter((el) => el.type === 'text' && !used.has(el.pos) && ANUNCIO_TABELA.test(el.text)
    && /consider|consult|utiliz|usad|apoio|final|seguir|anexo/i.test(el.text));
  if (!anuncios.length) return;
  const questionPages = new Set(questions.flatMap((q) => q.source_pages));
  for (const anuncio of anuncios) {
    const termo = ANUNCIO_TABELA.exec(anuncio.text)[1];
    const titulo = `${/tabela/i.test(termo) ? 'Tabela' : 'Classificação'} Periódica`;
    // a seção: a matéria citada ("questões de Química") ou a do anúncio
    const materia = /quest(?:ões|oes|ão)\s+de\s+([\p{L} ]{3,30}?)\s*[.,;]?$/iu.exec(anuncio.text.trim());
    let inicio = anuncio.pos;
    if (materia) {
      const alvo = normal(materia[1]);
      const cabeca = elements.find((el) => !used.has(el.pos) && subjectHeading(el) && normal(el.text) === alvo);
      if (cabeca) inicio = cabeca.pos;
    }
    const proxima = elements.find((el) => el.pos > inicio && el.pos !== anuncio.pos && !used.has(el.pos) && subjectHeading(el)
      && !ANUNCIO_TABELA.test(el.text));
    const fim = proxima ? proxima.pos : Infinity;
    const alvos = questions.filter((q) => (q._meta.markPos > inicio && q._meta.markPos < fim) || CITA_TABELA.test(q.statement_md));
    if (!alvos.length) continue;

    // a tabela: página sem questão, com "periódica" no texto e um desenho
    // grande; a mais perto do anúncio (a de depois, se empatar)
    let tabela = null;
    let melhor = Infinity;
    for (const P of pageByNumber.values()) {
      if (questionPages.has(P.page) || essayPages.has(P.page)) continue;
      if (!pageText(P).includes('periodica')) continue;
      const g = pageGraphic(P);
      if (!g) continue;
      const d = Math.abs(P.page - anuncio.page) + (P.page < anuncio.page ? 0.5 : 0);
      if (d < melhor) {
        melhor = d;
        tabela = g;
      }
    }
    used.add(anuncio.pos);
    for (const q of alvos) {
      if (!tabela) {
        q._meta.referenceMissing = true;
        continue;
      }
      if (q.figures.some((f) => f.slot === 'apoio' && f.page === tabela.page && f.kind === tabela.kind && f.crop && f.crop.x === tabela.crop.x)) continue;
      q.figures.push({
        page: tabela.page,
        bbox: { x: r2(tabela.x0), y: r2(tabela.y0), w: r2(tabela.x1 - tabela.x0), h: r2(tabela.y1 - tabela.y0) },
        crop: { ...tabela.crop },
        kind: tabela.kind,
        slot: 'apoio',
        text: titulo,
        ...(tabela.rotate ? { rotate: tabela.rotate } : {}),
      });
      q.statement_md = [q.statement_md, `![${titulo}](figura:${q.figures.length - 1})`].filter(Boolean).join('\n\n');
      if (!q.source_pages.includes(tabela.page)) q.source_pages.push(tabela.page);
      q.source_pages.sort((a, b) => a - b);
      q._meta.reference = titulo;
    }
    // o que era da tabela não é mais descarte
    if (tabela) {
      for (const el of elements) {
        if (el.page === tabela.page && !used.has(el.pos) && el.page !== anuncio.page) used.add(el.pos);
      }
    }
  }
}

/** Tamanho de letra com mais caracteres nas linhas (arredondado a 0,1). */
function dominantFs(lines) {
  const weight = new Map();
  for (const l of lines) {
    const k = Math.round(l.fs * 10) / 10;
    weight.set(k, (weight.get(k) || 0) + (l.text.match(/\p{L}/gu) || []).length);
  }
  let best = null;
  for (const [k, n] of weight) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] : null;
}

/** Caixa visível de um item (da altura da maiúscula à perna do "p"; fração inteira). */
function inkBox(t) {
  if (t.fraction) return { x0: t.x, x1: t.x1, y0: t.fraction.y0, y1: t.fraction.y1 };
  return { x0: t.x, x1: t.x1, y0: t.base - 0.8 * t.fs, y1: t.base + 0.22 * t.fs };
}

/**
 * O que é fórmula numa linha marcada: os itens de fórmula (símbolo sem
 * tradução, pedaço de fração montada), os desenhos de fórmula que
 * figures.inlineFormulas achou nela, a matriz inteira. Devolve as caixas
 * (x0, x1) — vazio quando não dá para saber (a linha inteira é a fórmula).
 */
function formulaParts(line) {
  if (line.matrix) return line.items.filter((t) => t.str.trim() || t.formula).map(inkBox);
  const boxes = line.items.filter((t) => t.formula).map(inkBox);
  for (const b of line.formulaBoxes || []) boxes.push({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 });
  return boxes;
}

/** Junta caixas que se tocam na horizontal (folga `gap`) em trechos `[{ x0, x1 }]`. */
function spansOf(boxes, gap) {
  const sorted = boxes.slice().sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.x0 <= last.x1 + gap) last.x1 = Math.max(last.x1, b.x1);
    else out.push({ x0: b.x0, x1: b.x1 });
  }
  return out;
}

/**
 * Fórmula montada no enunciado que não virou texto (fração dentro de fração,
 * parêntese grande do MathType, símbolo desenhado, matriz) vira recorte. As
 * linhas marcadas como fórmula e as coladas nelas (numerador, linha
 * principal, denominador ficam a menos de uma entrelinha uma da outra) formam
 * um bloco.
 *
 * Quando a fórmula ocupa só um trecho da linha ("com uma força F com seta, conforme
 * ilustra..."; "calor específico de 4,2 J/(g·°C) e densidade..."), só o
 * trecho vira imagem, NO MEIO da frase: o elemento continua sendo texto, com
 * a marca da figura no lugar (`inlineFigs`) — antes a linha inteira virava
 * imagem e a frase ficava partida entre parágrafo e figura, com a palavra
 * hifenizada cortada ao meio ("divisí-" / "vel"). Se o bloco tem texto fora da
 * fórmula em mais de uma linha, a fórmula é a linha inteira (como antes).
 * `onFail` avisa quando não deu para recortar (fica o alerta).
 */
function formulaBlocks(els, pageByNumber, onFail) {
  const out = [];
  let i = 0;
  const tight = (a, b) => a.type === 'text' && b.type === 'text' && a.page === b.page && a.col === b.col
    && b.base > a.base && b.base - a.base < 0.95 * Math.max(a.fs, b.fs);
  // a fórmula sobe e desce além da linha de texto: o índice, a fração que
  // virou texto, a fórmula desenhada
  const top = (b) => Math.min(b.base - 0.95 * b.fs, b.formulaBox ? b.formulaBox.y0 - 1 : Infinity,
    ...(b.items || []).filter((t) => t.str.trim()).map((t) => (t.fraction ? t.fraction.y0 : t.base - 0.95 * t.fs) - 0.5));
  const bottom = (b) => Math.max(b.base + 0.3 * b.fs, b.formulaBox ? b.formulaBox.y1 + 1 : -Infinity,
    ...(b.items || []).filter((t) => t.str.trim()).map((t) => (t.fraction ? t.fraction.y1 : t.base + 0.25 * t.fs) + 0.5));
  // para juntar linhas vale a altura justa das letras (com a entrelinha
  // normal, a de cima não encosta na de baixo); fração e fórmula desenhada
  // contam inteiras
  const inkTop = (b) => Math.min(b.base - 0.75 * b.fs, b.formulaBox ? b.formulaBox.y0 : Infinity,
    ...(b.items || []).filter((t) => t.fraction).map((t) => t.fraction.y0));
  const inkBottom = (b) => Math.max(b.base + 0.2 * b.fs, b.formulaBox ? b.formulaBox.y1 : -Infinity,
    ...(b.items || []).filter((t) => t.fraction).map((t) => t.fraction.y1));
  const visible = (l) => (l.items || []).filter((t) => t.str.trim());
  // a linha cabe na faixa horizontal da fórmula (numerador, denominador)
  const within = (l, span) => span && visible(l).every((t) => t.x >= span.x0 - 0.6 * l.fs && t.x1 <= span.x1 + 0.6 * l.fs);
  const extentOf = (lines) => {
    const parts = lines.flatMap(formulaParts);
    if (!parts.length) return null;
    return { x0: Math.min(...parts.map((b) => b.x0)), x1: Math.max(...parts.map((b) => b.x1)) };
  };
  while (i < els.length) {
    const el = els[i];
    if (el.type !== 'text' || !el.formula) {
      out.push(el);
      i += 1;
      continue;
    }
    // o bloco: para trás e para a frente, enquanto as linhas estiverem coladas
    // — linha que não é fórmula só entra se couber na faixa da fórmula (a
    // frase da linha de cima, colada no numerador alto, fica de fora)
    let start = i;
    let extent = extentOf([el]);
    // (as fileiras de uma matriz ficam a uma entrelinha uma da outra)
    const rows = (a, b) => a.type === 'text' && b.type === 'text' && a.matrix && b.matrix && a.page === b.page && a.col === b.col;
    while (start > 0 && (tight(els[start - 1], els[start]) || rows(els[start - 1], els[start])) && out[out.length - 1] === els[start - 1]
      && (els[start - 1].formula || !extent || within(els[start - 1], extent))) {
      start -= 1;
      out.pop();
      extent = extentOf(els.slice(start, i + 1)) || extent;
    }
    let end = i;
    let y1 = inkBottom(el);
    for (let k = start; k <= i; k += 1) y1 = Math.max(y1, inkBottom(els[k]));
    while (end + 1 < els.length) {
      const cur = els[end];
      const nx = els[end + 1];
      if (nx.type !== 'text' || nx.page !== el.page || nx.col !== el.col) break;
      // a linha de baixo entra se encostar na fórmula (tinta com tinta) — outra
      // fórmula na linha de baixo, sem encostar, é outro recorte
      if (!(tight(cur, nx) || inkTop(nx) < y1 - 0.5 || rows(cur, nx))) break;
      if (!nx.formula && extent && !within(nx, extent) && !(inkTop(nx) < y1 - 0.5)) break;
      end += 1;
      y1 = Math.max(y1, inkBottom(nx));
      extent = extentOf(els.slice(start, end + 1)) || extent;
    }
    const block = els.slice(start, end + 1);
    const P = pageByNumber.get(el.page);
    // a região não avança sobre a linha de cima nem sobre a de baixo
    const sameBox = (b) => b && b.type === 'text' && b.page === el.page && b.col === el.col;
    const before = sameBox(els[start - 1]) ? els[start - 1] : null;
    const after = sameBox(els[end + 1]) ? els[end + 1] : null;
    const region = {
      x0: el.colX0 ?? 0,
      x1: el.colX1 ?? (P ? P.width : Infinity),
      y0: Math.max(Math.min(...block.map(top)), before ? before.base + 0.22 * before.fs : -Infinity),
      y1: Math.min(Math.max(...block.map(bottom)), after ? after.base - 0.8 * after.fs : Infinity),
    };
    const inline = P && inlineFormula(block, region, P);
    if (inline) {
      out.push(inline);
      i = end + 1;
      continue;
    }
    const fig = P && formulaFigure(P, region, { col: el.col });
    if (!fig) {
      onFail();
      out.push(...block);
    } else {
      out.push({
        type: 'figure', figure: fig, page: fig.page, col: fig.col, x0: fig.x0, x1: fig.x1, y0: fig.y0, y1: fig.y1,
        pos: block[0].pos, covers: block.map((b) => b.pos),
      });
    }
    i = end + 1;
  }
  return out;
}

/**
 * Fórmula no meio da frase: a linha principal do bloco fica como texto e cada
 * trecho de fórmula vira um recorte no lugar dele. Devolve o elemento de
 * texto (com `inlineFigs` e a marca de cada figura no texto rico) ou null
 * quando a fórmula não é um trecho (ocupa a linha toda, ou há texto fora dela
 * em outra linha do bloco).
 */
function inlineFormula(block, region, P) {
  const visible = (l) => l.items.filter((t) => t.str.trim());
  // linha principal: a que mais tem texto fora da fórmula
  const parts = block.flatMap(formulaParts);
  if (!parts.length) return null;
  let host = null;
  let hostChars = -1;
  const rough = spansOf(parts, 0);
  const outside = (t, spans) => !spans.some((sp) => (t.x + t.x1) / 2 >= sp.x0 - 0.5 && (t.x + t.x1) / 2 <= sp.x1 + 0.5);
  for (const l of block) {
    const n = visible(l).filter((t) => outside(t, rough)).reduce((k, t) => k + t.str.trim().length, 0);
    if (n > hostChars) {
      host = l;
      hostChars = n;
    }
  }
  if (!host || hostChars < 3) return null;
  // trechos: as partes de fórmula de todas as linhas e o que as outras linhas
  // do bloco têm (numerador, denominador, fileira da matriz)
  const fs = host.fs;
  let spans = spansOf(parts, 0.6 * fs);
  // cada trecho cresce até a borda das palavras que ele toca na linha
  // principal ("4√10": o 4 e o 10 vão junto com a raiz desenhada) e pelos
  // termos da fórmula em volta ("V(x) = −x²/4 + 10x + 105"), mas não por
  // palavra de frase
  // palavra a palavra: o item do pdf.js é um pedaço grande da linha ("O gás
  // dióxido de cloro (C"), e o trecho só pode crescer até a borda da palavra
  const pieces = host.items.flatMap((t) => (t.str.trim() ? splitWords(t) : [t])).sort((a, b) => a.x - b.x);
  const hostItems = pieces.filter((t) => t.str.trim());
  // só operador solto ("=", "+", "∈") entra com espaço no meio; letra e
  // número só se estiverem colados no desenho
  const operator = (t) => /^[=+\-−–×⋅·/<>≤≥≠≈∈∉⊂∪∩→⇒]+$/.test(t.str.trim());
  // pontuação da frase colada na fórmula ("$, *, &": a vírgula depois do
  // "*" desenhado) fica no texto — antes ela ia para o recorte e sumia da frase
  const punctuation = (t) => /^[,.;:!?…]+$/.test(t.str.trim());
  for (let changed = true; changed;) {
    changed = false;
    for (const sp of spans) {
      for (const t of hostItems) {
        if (t.x >= sp.x0 && t.x1 <= sp.x1) continue;
        if (punctuation(t)) continue;
        const g = t.x1 <= sp.x0 ? sp.x0 - t.x1 : t.x >= sp.x1 ? t.x - sp.x1 : 0;
        // a fração que virou texto no meio da fórmula ("V(x) = −x²/4 − 10x +
        // 105" saía partida em dois recortes com "x²/4" no meio) e a variável
        // em itálico colada nela (o "V") também são da fórmula
        const variable = t.italic && /^\p{L}{1,2}$/u.test(t.str.trim());
        if (g <= 0.15 * fs || (g <= 0.6 * fs && (operator(t) || t.fraction)) || (g <= 0.35 * fs && variable)) {
          sp.x0 = Math.min(sp.x0, t.x);
          sp.x1 = Math.max(sp.x1, t.x1);
          changed = true;
        }
      }
    }
    if (changed) spans = spansOf(spans, 0);
  }
  // pedaços da mesma fórmula ("(", o "f" com seta e índice, ")") viram um trecho só
  spans = spansOf(spans, 0.6 * fs);
  // pontuação que fecha a frase logo depois da fórmula (o "." encostado no
  // colchete de "F⃗ₑ]."): é do texto, mesmo com o centro na borda do trecho —
  // nada da fórmula vem depois dela
  const trailing = (t) => punctuation(t) && !t.formula && spans.some((sp) => (t.x + t.x1) / 2 >= sp.x0
    && (t.x + t.x1) / 2 <= sp.x1 + 1.5
    && !hostItems.some((o) => o !== t && !punctuation(o) && o.x >= t.x1 - 0.5 && o.x <= sp.x1 + 1)
    && !parts.some((b) => b.x0 >= t.x1 - 0.5 && b.x0 <= sp.x1));
  // as outras linhas cabem nos trechos; a principal tem texto fora deles
  const inSpan = (t) => !trailing(t) && spans.find((sp) => (t.x + t.x1) / 2 >= sp.x0 - 1 && (t.x + t.x1) / 2 <= sp.x1 + 1);
  if (block.some((l) => l !== host && visible(l).some((t) => !inSpan(t)))) return null;
  const rest = hostItems.filter((t) => !inSpan(t));
  if (!rest.some((t) => /\p{L}{2,}/u.test(t.str))) return null;
  // (a pontuação da frase fica fora do recorte também)
  const keepOut = new Set(host.items.filter((t) => t.str.trim() && trailing(t)));
  // um recorte por trecho
  const figs = [];
  for (const sp of spans) {
    const fig = formulaFigure(P, { x0: sp.x0 - 1.2, x1: sp.x1 + 1.2, y0: region.y0, y1: region.y1 }, { col: host.col, keepOut });
    if (!fig) return null;
    figs.push({ type: 'figure', figure: fig, page: fig.page, col: fig.col, x0: fig.x0, x1: fig.x1, y0: fig.y0, y1: fig.y1, pos: host.pos });
  }
  // o texto: os pedaços fora da fórmula e a marca de cada figura no lugar,
  // na ordem horizontal (a matriz de outra fileira não tem pedaço na linha)
  const order = [
    ...pieces.filter((t) => !(t.str.trim() && inSpan(t))).map((t) => ({ x: t.x, t })),
    ...spans.map((sp) => ({ x: sp.x0, sp })),
  ].sort((a, b) => a.x - b.x);
  const segments = [];
  for (const o of order) {
    if (o.sp) {
      segments.push({ span: o.sp });
      continue;
    }
    // espaço dentro do trecho da fórmula não conta
    if (!o.t.str.trim() && inSpan(o.t)) continue;
    const last = segments[segments.length - 1];
    if (last && last.items) last.items.push(o.t);
    else segments.push({ items: [o.t] });
  }
  let rich = '';
  let text = '';
  for (const g of segments) {
    if (g.span) {
      const n = spans.indexOf(g.span);
      rich += ` ${figureMark(n)} `;
      text += ' ';
    } else {
      rich += joinItems(g.items, { rich: true });
      text += joinItems(g.items);
    }
  }
  rich = rich.replace(/\s+/g, ' ').replace(/(\ue70b) ([,.;:!?)\]])/g, '$1$2').replace(/([([]) (\ue70a)/g, '$1$2').trim();
  text = text.replace(/\s+/g, ' ').trim();
  return {
    ...host,
    text,
    rich,
    formula: false,
    inlineFigs: figs,
    pos: block[0].pos,
    covers: block.map((b) => b.pos),
    x0: Math.min(host.x0, ...spans.map((sp) => sp.x0)),
    x1: Math.max(host.x1, ...spans.map((sp) => sp.x1)),
  };
}

/**
 * Figura como sai na questão: `bbox` é o desenho, `crop` o recorte que vira
 * PNG (com folga), `slot` onde ela entra ('enunciado', 'apoio' ou a letra da
 * alternativa) e `uncertain` os motivos de desconfiança (alerta 'figura_incerta').
 */
function figureOut(el, slot) {
  const f = el.figure;
  const out = {
    page: el.page,
    bbox: { x: r2(el.x0), y: r2(el.y0), w: r2(el.x1 - el.x0), h: r2(el.y1 - el.y0) },
    crop: f.crop ? { ...f.crop } : { x: r2(el.x0), y: r2(el.y0), w: r2(el.x1 - el.x0), h: r2(el.y1 - el.y0) },
    kind: f.kind,
    slot,
  };
  if (f.text) out.text = f.text;
  if (f.uncertain && f.uncertain.length) out.uncertain = [...f.uncertain];
  return out;
}

/** Recorte que cobre vários recortes. */
function unionCrop(crops) {
  const list = crops.filter(Boolean);
  const x0 = Math.min(...list.map((c) => c.x));
  const y0 = Math.min(...list.map((c) => c.y));
  const x1 = Math.max(...list.map((c) => c.x + c.w));
  const y1 = Math.max(...list.map((c) => c.y + c.h));
  return { x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0) };
}

/** Folga em volta da região da questão (pontos). */
const REGION_PAD = 4;

/**
 * Retângulos da região de uma questão, um por página/coluna, na ordem de
 * leitura — é o que a IA de visão olha quando o texto não deu para ler. Cada
 * retângulo tem a largura da coluna inteira (a letra da alternativa e o recuo
 * entram) e vai da primeira à última linha que é da questão, com folga
 * pequena. Mesmo formato do `crop` das figuras: { page, x, y, w, h }.
 */
function regionBoxes(els, pageByNumber) {
  const boxes = new Map();
  for (const el of els) {
    if (!el || !Number.isFinite(el.x0) || !Number.isFinite(el.y0)) continue;
    const key = `${el.page}:${el.col}`;
    if (!boxes.has(key)) boxes.set(key, { page: el.page, col: el.col, pos: el.pos, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const b = boxes.get(key);
    const P = pageByNumber.get(el.page);
    const col = P && (P.columns || []).find((c) => c.index === el.col);
    b.x0 = Math.min(b.x0, el.x0, col && Number.isFinite(col.x0) ? col.x0 : el.x0);
    b.x1 = Math.max(b.x1, el.x1, col && Number.isFinite(col.x1) ? col.x1 : el.x1);
    b.y0 = Math.min(b.y0, el.y0);
    b.y1 = Math.max(b.y1, el.y1);
    b.pos = Math.min(b.pos, el.pos);
  }
  return [...boxes.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((b) => {
      const P = pageByNumber.get(b.page) || {};
      const width = Number(P.width) || b.x1 + REGION_PAD;
      const height = Number(P.height) || b.y1 + REGION_PAD;
      const x0 = Math.max(0, b.x0 - REGION_PAD);
      const y0 = Math.max(0, b.y0 - REGION_PAD);
      const x1 = Math.min(width, b.x1 + REGION_PAD);
      const y1 = Math.min(height, b.y1 + REGION_PAD);
      return { page: b.page, x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0) };
    })
    .filter((b) => b.w >= 1 && b.h >= 1);
}

/** Procura um anúncio de apoio na sobra; devolve o bloco a partir dele. */
function findSupport(sobra, ctx) {
  const texts = sobra.filter((el) => el.type === 'text');
  for (let i = 0; i < texts.length; i += 1) {
    const head = texts[i];
    if (!/^[\p{Lu}(“"]/u.test(head.text)) continue;
    const window = texts.slice(i, i + 4);
    const joined = toParagraphs(window, ctx, (l) => l.text).map((p) => p.rows.join(' ')).join(' ');
    for (const re of ANUNCIO_APOIO) {
      const m = re.exec(joined);
      if (!m) continue;
      // o anúncio tem que começar nesta linha (não no meio do parágrafo)
      if (m.index > head.text.length + 2) continue;
      const from = Number(m[1]);
      const to = Number(m[2]);
      if (!(to >= from && to - from <= 15)) continue;
      const elements = sobra.filter((el) => el.pos >= head.pos);
      return { from, to, elements, blocks: supportBlocks(elements, ctx), pages: [...new Set(elements.map((e) => e.page))] };
    }
  }
  return null;
}

/** Blocos de markdown de um trecho (texto em parágrafos, figura como está). */
function supportBlocks(elements, ctx) {
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length) for (const p of toParagraphs(buffer, ctx)) blocks.push({ type: 'text', md: paragraphMarkdown(p) });
    buffer = [];
  };
  for (const el of elements) {
    if (el.type === 'figure') {
      if (el.figure.small) continue;
      flush();
      blocks.push(el);
    } else {
      buffer.push(el);
    }
  }
  flush();
  return blocks;
}

/**
 * Bloco de texto corrido na sobra, sem anúncio: 3+ linhas no corpo do texto,
 * 150+ letras, ao menos 2 linhas cheias (prosa justificada). Títulos de
 * matéria/idioma antes dele ficam de fora. Rótulo de gráfico solto não passa.
 */
function findLooseSupport(sobra, ctx, bodyFs) {
  const isTitle = (el) => el.type === 'text' && (el.heading || el.fs >= bodyFs * 1.25 || TITULO_AREA.test(el.text));
  let start = 0;
  for (let i = 0; i < sobra.length; i += 1) if (isTitle(sobra[i])) start = i + 1;
  const elements = sobra.slice(start).filter((el) => el.type === 'text' || !el.figure.small);
  const texts = elements.filter((el) => el.type === 'text' && Math.abs(el.fs - bodyFs) <= 1.5);
  const letters = texts.reduce((n, el) => n + (el.text.match(/\p{L}/gu) || []).length, 0);
  const full = texts.filter((el) => el.x1 >= (el.right || el.x1) - 5 && el.text.length > 30).length;
  if (texts.length < 3 || letters < 150 || full < 2) return null;
  return { loose: true, from: null, to: null, elements, blocks: supportBlocks(elements, ctx), pages: [...new Set(elements.map((e) => e.page))] };
}

/** A questão fala de um texto/figura que deveria estar com ela. */
const CITA_APOIO = /\b(?:cartoon|cartum|charge|tirinha|tira|quadrinhos?|comic|vi[ñn]eta|text(?:o)?|imag(?:em|en|e)|figura|picture|poema|poem|speech|fala|autor|author)\b/i;

/**
 * Texto de apoio dentro de uma questão, sem anúncio (o FGV põe o "Text II" e
 * o cartum logo depois do número da 43, e a 44 pergunta sobre "the character
 * in the cartoon"): nas questões de língua estrangeira, o bloco que abre com
 * "Text II"/"Texto II" vale também para as seguintes da mesma língua que
 * citam um texto ou uma imagem e não trazem o próprio — até a próxima que
 * traz o próprio texto. O bloco é o enunciado menos o último parágrafo (o
 * comando da questão).
 */
function shareEmbeddedTexts(questions) {
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    if (!q.variant || !/^\*\*(?:text|texto)\s+[ivx\d]+\*\*/i.test(q.statement_md)) continue;
    const parts = q.statement_md.split('\n\n');
    if (parts.length < 3) continue;
    const block = parts.slice(0, -1);
    const hasBody = block.some((p) => /figura:\d+/.test(p)) || block.join(' ').length >= 150;
    if (!hasBody) continue;
    for (let j = i + 1; j < questions.length && j <= i + 3; j += 1) {
      const t = questions[j];
      if (t.variant !== q.variant || t.number !== questions[j - 1].number + 1) break;
      if (/^\*\*(?:text|texto)\s+[ivx\d]+\*\*/i.test(t.statement_md) || t._meta.support) break;
      if (t.figures.some((f) => f.slot === 'enunciado') || !CITA_APOIO.test(t.statement_md)) break;
      const remap = new Map();
      const copied = block.map((p) => p.replace(/\]\(figura:(\d+)\)/g, (m, n) => {
        const k = Number(n);
        if (!remap.has(k) && q.figures[k]) {
          t.figures.push({ ...q.figures[k], slot: 'apoio' });
          remap.set(k, t.figures.length - 1);
        }
        return remap.has(k) ? `](figura:${remap.get(k)})` : m;
      }));
      t.statement_md = [...copied, t.statement_md].join('\n\n');
      t.regions = [...q.regions, ...t.regions];
      for (const p of q.source_pages) if (!t.source_pages.includes(p)) t.source_pages.push(p);
      t.source_pages.sort((a, b) => a - b);
      t._meta.support = `texto da ${q.number}`;
    }
  }
}

/** O enunciado pede o que só a formatação mostra ("a palavra sublinhada", "o termo destacado"). */
const CITA_FORMATACAO = /\b(?:palavras?|termos?|express(?:ão|ões)|trechos?|verbos?|vocábulos?|ora(?:ção|ções)|frases?|formas?|segmentos?|conectivos?|pronomes?|palabras?|términos?|vocablos?|expresi(?:ón|ones)|fragmentos?|words?|terms?|expressions?|phrases?|verbs?)\s+(?:\S+\s+){0,2}?(?:sublinhad|destacad|grifad|subrayad|underlined|highlighted|resaltad|em destaque|em negrito|en negrita)/i;
/** O enunciado fala de lacuna. */
const CITA_LACUNA = /lacuna|espaço em branco|blank|hueco|espacio en blanco/i;
/**
 * O enunciado fala de uma imagem que tem de estar na questão: charge, cartum,
 * tirinha, quadrinho, infográfico (sempre mostrados), "o gráfico", ou a
 * figura/imagem/mapa "a seguir", "acima", "apresentado"... ("a área da
 * figura que representa o terreno" e "a escala do mapa" não pedem imagem).
 */
const CITA_FIGURA = new RegExp([
  '\\b(?:a|na|da|pela|esta|essa|nesta|nessa|desta|dessa)\\s+(?:charge|tirinha|tira)\\b',
  '\\b(?:o|no|do|pelo|este|esse|neste|nesse|deste|desse)\\s+(?:cartum|quadrinho|infogr[áa]fico|gr[áa]fico|cartaz)\\b',
  '\\b(?:figura|imagem|mapa|esquema|ilustra[çc][ãa]o|fotografia|foto|tabela)s?\\s+(?:a seguir|acima|abaixo|ao lado|apresentad|mostrad|ilustrad|indicad|reproduzid)',
  '\\b(?:observe|analise|considere|veja)\\s+(?:a|o|as|os)\\s+(?:figura|imagem|gr[áa]fico|mapa|esquema|tabela|ilustra[çc][ãa]o)',
  '\\bthe (?:cartoon|comic|picture|chart|graph)\\b',
  '\\b(?:la|el) (?:viñeta|tira|imagen|gráfico)\\b',
].join('|'), 'i');

/**
 * Palavra picotada: três ou mais pedaços de 1–2 letras seguidos que não são
 * palavras ("mast r o de uma ban de ir a"). Sinal de espaço inventado que
 * escapou da correção.
 */
function fragmented(text) {
  const curtas = new Set('a o e é à as os ao da de do em no na um se me te lhe nos já só si su la el en y es mi tu to of in is it at on an be by we he or my no so do go up us ou há vi ti tá lá cá pó nó dó fé pé ré vê lê dê cê'.split(' '));
  const tokens = stripMarks(text).replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  // pedaço: 1–2 letras minúsculas, sem pontuação, que não é palavra curta
  // comum nem unidade depois de número ("10 m", "2 kg")
  const piece = tokens.map((w, i) => /^\p{Ll}{1,2}$/u.test(w) && !curtas.has(w) && !/\d$/.test(tokens[i - 1] || ''));
  for (let i = 0; i + 5 <= piece.length; i += 1) {
    if (piece.slice(i, i + 5).filter(Boolean).length >= 3) return true;
  }
  return false;
}

/** Alertas por questão (códigos fixos; o painel traduz). */
function applyAlerts(questions) {
  const tracks = {};
  const seen = new Set();
  for (const q of questions) {
    const alerts = new Set();
    const m = q._meta;
    if (q.alternatives.length !== 5 || q.alternatives.some((a) => !a.text_md)) alerts.add('alternativas_incompletas');
    const allText = [q.statement_md, ...q.alternatives.map((a) => a.text_md)].join(' ');
    if (m.illegible || isGarbled(allText)) alerts.add('texto_ilegivel');
    // fórmula com símbolo que não vira texto: precisa do recorte (etapa de figuras)
    if (m.formula) alerts.add('figura_incerta');
    // recorte que encosta na borda, atravessa a coluna ou cobre texto de fora
    if (q.figures.some((f) => f.uncertain && f.uncertain.length)) alerts.add('figura_incerta');
    const track = q.variant === 'espanhol' ? 'es' : 'main';
    const prev = tracks[track];
    const key = `${q.number}|${q.variant || ''}`;
    if (seen.has(key)) alerts.add('numero_fora_de_sequencia');
    else if (prev != null && q.number !== prev + 1) alerts.add('numero_fora_de_sequencia');
    seen.add(key);
    tracks[track] = q.number;
    if (m.boxes >= 2 && m.letters < 5) alerts.add('regiao_quebrada');
    if (m.boxes >= 4) alerts.add('regiao_quebrada');
    const letters = (q.statement_md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').match(/\p{L}/gu) || []).length;
    if (letters < 25 && !m.statementFigures && !m.support) alerts.add('enunciado_curto');
    // desenho do enunciado que não foi para recorte nenhum
    if (m.drawnLeft) alerts.add('figura_incerta');
    // a questão cita uma imagem e não tem nenhuma
    if (!q.figures.length && CITA_FIGURA.test(q.statement_md)) alerts.add('figura_incerta');
    // a tabela periódica anunciada não foi achada
    if (m.referenceMissing) alerts.add('figura_incerta');
    // o comando depende da formatação ou da lacuna e o texto não tem a marca
    if (CITA_FORMATACAO.test(allText) && !/\+\+\S|\*\*\S[^*]*\*\*/.test(allText.replace(/^\*\*[^*\n]+\*\*$/gm, ''))) alerts.add('texto_incerto');
    if (CITA_LACUNA.test(allText) && !/(?:\\_){3}/.test(allText)) alerts.add('texto_incerto');
    if (fragmented(allText)) alerts.add('texto_incerto');
    q.alerts = [...alerts];
    for (const a of q.alternatives) delete a.illegible;
  }
}

/** O que não entrou em questão nenhuma, agrupado por página e tipo. */
function classifyLeftovers(elements, used, marks, questions, essayPages) {
  const out = [];
  if (!elements.length) return out;
  const firstMarkPos = marks.length ? marks[0].line.pos : Infinity;
  const firstMarkPage = marks.length ? marks[0].page : Infinity;
  const lastEnd = questions.length ? Math.max(...questions.map((q) => q._meta.regionEnd)) : -1;
  let cur = null;
  for (const el of elements) {
    if (el.type === 'figure' && el.figure.small) continue;
    if (used.has(el.pos)) {
      cur = null;
      continue;
    }
    const secao = el.heading || (el.type === 'text' && (TITULO_AREA.test(el.text) || MARCA_ENEM.test(el.text)));
    let kind = 'sobra';
    if (el.page < firstMarkPage) kind = 'capa';
    else if (essayPages.has(el.page)) kind = 'redacao';
    else if (secao) kind = 'secao';
    else if (el.pos < firstMarkPos) kind = 'capa';
    else if (el.pos > lastEnd) kind = 'fim';
    const text = el.type === 'figure' ? '[figura]' : el.text;
    if (cur && cur.page === el.page && cur.kind === kind) {
      cur.text += `\n${text}`;
    } else {
      cur = { page: el.page, kind, text };
      out.push(cur);
    }
  }
  return out;
}

module.exports = {
  LETRAS,
  escapeInline,
  escapeMarkdown,
  joinText,
  toParagraphs,
  letterCandidates,
  chooseLetters,
  readQuestions,
};

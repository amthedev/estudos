'use strict';

/**
 * Gabarito oficial: número da questão → letra, com a variante de idioma.
 *
 *   const answerKey = require('./answer-key');
 *   const { key, count } = answerKey.parseAnswerKeyText('1 B A\n2 B B\n6 C');   // texto colado ou do navegador
 *   const { key, count } = answerKey.parseAnswerKeyLayout(layout);              // layout.js (posição)
 *   const { key, count } = await answerKey.readAnswerKey(buffer);              // PDF do gabarito
 *   answerKey.answerFor(key, 1, 'espanhol');                                    // → 'A'
 *
 * Formato da chave (é o que fica em exam_imports.answer_key):
 *
 *   { "1": "B", "1:espanhol": "A", "6": "C", ... }
 *
 * O número puro é a letra da prova principal — no ENEM dia 1, a opção de
 * inglês das questões 1 a 5. A opção de espanhol fica em "N:espanhol". O
 * gabarito do INEP traz as duas na mesma linha ("1 B A", sob INGLÊS e
 * ESPANHOL); o parser antigo lia a primeira e jogava a segunda fora, e a
 * questão de espanhol entrava com a resposta da de inglês.
 *
 * Espanhol sem letra própria fica SEM gabarito (nunca herda a de inglês): a
 * questão espera conferência em vez de ir ao banco com a resposta errada.
 *
 * Também lidos: "46-A", "46) A", "46.A", "01 A", "46A" (separador explícito
 * ou letra colada — prosa como "questões 46 a 90" não vira resposta) e a
 * grade da VUNESP, com a linha de números e a linha de letras embaixo.
 *
 * No PDF, só contam as linhas de folha de gabarito (quase só números, letras
 * e separadores): o gabarito que vem no fim do próprio PDF da prova não pega
 * par falso das frases das questões. A folha da FGV traz uma tabela por tipo
 * de caderno e por língua ("PROVA TIPO 1 – LÍNGUA ESPANHOLA"): vale a do tipo
 * do caderno, e a de espanhol vira "N:espanhol". A folha da VUNESP traz uma
 * letra só por número, que vale para as duas línguas (`sharedLanguages`;
 * shareLanguages aplica — quem chama decide, e nunca no ENEM).
 */

const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const MAX_QUESTAO = 300;

/** Nome da entrada na chave para a questão (e variante). */
function keyName(number, variant = null) {
  return variant === 'espanhol' ? `${number}:espanhol` : String(number);
}

/**
 * A letra oficial da questão, ou null. Inglês e prova sem variante usam o
 * número puro; espanhol só a própria entrada.
 */
function answerFor(key, number, variant = null) {
  if (!key || number === null || number === undefined) return null;
  const letra = String(key[keyName(number, variant)] || '').trim().toUpperCase();
  return LETRAS.includes(letra) ? letra : null;
}

const numeroValido = (n) => Number.isInteger(n) && n > 0 && n <= MAX_QUESTAO;

/** Conta respostas e devolve o par { key, count } que as rotas já usam. */
function resultado(key) {
  return { key, count: Object.keys(key).length };
}

// ---------------------------------------------------------------------------
// Texto (colado pelo administrador ou extraído no navegador)
// ---------------------------------------------------------------------------

/**
 * Um par número→letra só vale com um separador EXPLÍCITO entre eles, ou com a
 * letra colada ao número. Sem essa exigência, prosa comum de folha de gabarito
 * virava resposta: "questões 46 a 90" dava 46=A, "itens 3 e 4" dava 3=E —
 * porque em português "a" e "e" são letras válidas. A letra é MAIÚSCULA e não
 * pode emendar em palavra ("23 ANULADA" não é 23=A).
 *
 * A segunda letra ("1 B A") só é lida como espanhol quando o texto fala em
 * espanhol — é o cabeçalho das duas colunas no gabarito do INEP. Entre o
 * número e a letra sem separador, só espaço na MESMA linha: na grade da
 * VUNESP o "03" do fim de uma linha não pode casar com o "A" da linha de baixo.
 */
const PAR = /(\d{1,3})(?:\s*[).:\-–—=]\s*|[ \t]{0,2})([A-E])(?![A-Za-zÀ-ÿ])(?:[ \t]{1,4}([A-E])(?![A-Za-zÀ-ÿ\d]))?/g;

/** Grade da VUNESP: uma linha só de números e, logo abaixo, uma só de letras. */
function gradeDeTexto(linhas, key) {
  for (let i = 0; i + 1 < linhas.length; i += 1) {
    const numeros = linhas[i].trim().split(/\s+/);
    const letras = linhas[i + 1].trim().split(/\s+/);
    if (numeros.length < 3 || numeros.length !== letras.length) continue;
    if (!numeros.every((t) => /^\d{1,3}$/.test(t)) || !letras.every((t) => /^[A-E]$/.test(t))) continue;
    numeros.forEach((t, k) => {
      const n = Number.parseInt(t, 10);
      if (numeroValido(n) && !key[String(n)]) key[String(n)] = letras[k];
    });
  }
}

/**
 * Lê um gabarito em texto.
 * @param {string} input
 * @returns {{ key: object, count: number, sharedLanguages: boolean }}
 */
function parseAnswerKeyText(input) {
  const key = {};
  const bruto = String(input || '').replace(/ /g, ' ');
  const temEspanhol = /espanhol/i.test(bruto);
  PAR.lastIndex = 0;
  let match = PAR.exec(bruto);
  while (match) {
    const numero = Number.parseInt(match[1], 10);
    if (numeroValido(numero)) {
      key[String(numero)] = match[2];
      if (match[3] && temEspanhol) key[keyName(numero, 'espanhol')] = match[3];
    }
    match = PAR.exec(bruto);
  }
  gradeDeTexto(bruto.split(/\r?\n/), key);
  // (sem falar em espanhol, a letra é uma só por número: ver shareLanguages)
  return { ...resultado(key), sharedLanguages: !temEspanhol };
}

// ---------------------------------------------------------------------------
// Layout (o PDF do gabarito lido no servidor, com posição)
// ---------------------------------------------------------------------------

/**
 * Pedaços de texto viram fichas (número ou letra) com a posição. Um item do
 * PDF pode trazer "46 D" junto: a posição de cada ficha sai da proporção do
 * caractere dentro do item.
 */
function fichasDaPagina(page) {
  const fichas = [];
  for (const t of page.texts || []) {
    if (t.rot) continue;
    const str = String(t.str || '');
    const largura = str.length ? (t.w || 0) / str.length : 0;
    const re = /\S+/g;
    let m = re.exec(str);
    while (m) {
      const token = m[0].replace(/[*]/g, '');
      const x = (t.x || 0) + largura * m.index;
      const w = largura * m[0].length;
      if (/^\d{1,3}$/.test(token)) fichas.push({ tipo: 'numero', valor: Number.parseInt(token, 10), x, w, base: t.base });
      else if (/^[A-E]$/.test(token)) fichas.push({ tipo: 'letra', valor: token, x, w, base: t.base });
      else fichas.push({ tipo: 'outro', valor: token, x, w, base: t.base });
      m = re.exec(str);
    }
  }
  return fichas;
}

/** Agrupa por linha de base (tolerância de 3 pt), de cima para baixo. */
function linhasDeFichas(fichas) {
  const ordenadas = [...fichas].sort((a, b) => a.base - b.base || a.x - b.x);
  const linhas = [];
  for (const f of ordenadas) {
    const atual = linhas[linhas.length - 1];
    if (atual && Math.abs(f.base - atual.base) <= 3) atual.fichas.push(f);
    else linhas.push({ base: f.base, fichas: [f] });
  }
  for (const l of linhas) {
    l.fichas.sort((a, b) => a.x - b.x);
    // O PDF às vezes parte o número em dois itens colados ("12" + "4" = 124).
    const juntas = [];
    for (const f of l.fichas) {
      const antes = juntas[juntas.length - 1];
      if (antes && antes.tipo === 'numero' && f.tipo === 'numero' && f.x - (antes.x + antes.w) < 1.5) {
        const valor = Number.parseInt(`${antes.valor}${f.valor}`, 10);
        juntas[juntas.length - 1] = { ...antes, valor, w: f.x + f.w - antes.x };
      } else {
        juntas.push(f);
      }
    }
    l.fichas = juntas;
  }
  return linhas;
}

/** Separador entre o número e a letra ("1 - B", "46) D"). */
const separador = (f) => f.tipo === 'outro' && /^[-–—).:=|]+$/.test(f.valor);

/**
 * Linha de folha de gabarito: quase só números, letras A–E e separadores
 * ("1 B A 46 D", "1 - B 2 - C", a fileira "11 12 13 … 20" e a de letras
 * embaixo). A frase de uma página de questão não é: lida inteira, "…é 9. A
 * mediana" virava 9 = A, "+116. A única" virava 116 = A, "(B) 20 ºC." virava
 * 20 = C — e o gabarito de uma prova com o gabarito no fim do próprio PDF saía
 * com sete letras erradas.
 */
function linhaDeGabarito(linha) {
  const { fichas } = linha;
  const numeros = fichas.filter((f) => f.tipo === 'numero').length;
  const letras = fichas.filter((f) => f.tipo === 'letra').length;
  const uteis = numeros + letras + fichas.filter(separador).length;
  return numeros + letras >= 2 && uteis >= 0.75 * fichas.length;
}

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '');

/**
 * Título de tabela do gabarito: "PROVA TIPO 1 – LÍNGUA INGLESA", "PROVA TIPO
 * 3 – LÍNGUA: ESPANHOLA" (a FGV publica uma tabela por tipo de caderno e por
 * língua, todas na mesma folha). O cabeçalho de colunas do INEP ("INGLÊS
 * ESPANHOL", as duas na mesma linha) não é título.
 */
function tituloDeTabela(linha) {
  const texto = semAcento(linha.fichas.map((f) => f.valor).join(' '));
  if (texto.length > 80) return null;
  const tipo = /TIPO(\d{1,2})/.exec(texto);
  const ingles = /LINGUA:?INGLES|INGLESA/.test(texto);
  const espanhol = /LINGUA:?ESPANHOL|ESPANHOLA/.test(texto);
  if (!tipo && ingles === espanhol) return null;
  return { tipo: tipo ? Number(tipo[1]) : null, lingua: ingles === espanhol ? null : ingles ? 'ingles' : 'espanhol' };
}

/**
 * Letras das linhas de gabarito (em ordem de leitura): em cada linha, um
 * número seguido das letras até o próximo número — a primeira letra é a da
 * prova principal e a segunda, quando a folha tem a coluna ESPANHOL, a de
 * espanhol — e a grade, com a linha de números e a de letras embaixo (que
 * pode estar no alto da página seguinte). Número sem letra (anulada) fica de
 * fora.
 */
function chaveDasLinhas(linhas) {
  const key = {};
  linhas.forEach((linha, indice) => {
    const { fichas: lf, temEspanhol } = linha;
    for (let i = 0; i < lf.length; i += 1) {
      const f = lf[i];
      if (f.tipo !== 'numero' || !numeroValido(f.valor)) continue;
      const letras = [];
      for (let j = i + 1; j < lf.length && lf[j].tipo !== 'numero'; j += 1) {
        if (lf[j].tipo === 'letra') letras.push(lf[j].valor);
        else if (separador(lf[j]) && !letras.length) continue;
        else break; // "ANULADA", "X": a questão não tem letra
      }
      if (!letras.length) continue;
      if (!key[String(f.valor)]) key[String(f.valor)] = letras[0];
      if (letras[1] && temEspanhol) key[keyName(f.valor, 'espanhol')] = letras[1];
    }

    // Grade: linha só de números com as letras na linha de baixo, alinhadas.
    const numeros = lf.filter((f) => f.tipo === 'numero' && numeroValido(f.valor));
    if (numeros.length < 3 || lf.some((f) => f.tipo === 'letra')) return;
    const abaixo = linhas[indice + 1];
    if (!abaixo) return;
    const mesmaPagina = abaixo.page === linha.page;
    // (na virada de página, só a última linha de uma com a primeira da outra)
    if (mesmaPagina ? abaixo.base - linha.base > 30 : !(linha.ultima && abaixo.primeira && abaixo.page === linha.page + 1)) return;
    const letrasAbaixo = abaixo.fichas.filter((f) => f.tipo === 'letra');
    if (letrasAbaixo.length < 3 || abaixo.fichas.some((f) => f.tipo === 'numero')) return;
    for (const n of numeros) {
      const centro = n.x + n.w / 2;
      const letra = letrasAbaixo.find((l) => Math.abs(l.x + l.w / 2 - centro) <= Math.max(8, n.w));
      if (letra && !key[String(n.valor)]) key[String(n.valor)] = letra.valor;
    }
  });
  return key;
}

/** O texto das linhas, para a leitura por texto quando a posição não rende. */
function textoDasLinhas(linhas) {
  return linhas.map((l) => l.fichas.map((f) => f.valor).join(' ')).join('\n');
}

/**
 * As linhas de gabarito do layout, em ordem de leitura, separadas pelos
 * títulos de tabela. Só páginas que têm cara de folha de gabarito (ao menos
 * três linhas de gabarito, ou 40% das linhas da página); `pages`, quando
 * vem, limita às páginas dadas.
 *
 * @returns {{ secoes: Array<{ tipo, lingua, linhas }>, mencionaEspanhol: boolean }}
 */
function secoesDoLayout(layout, { pages = null } = {}) {
  const secoes = [];
  let atual = null;
  let mencionaEspanhol = false;
  for (const page of (layout && layout.pages) || []) {
    if (pages && !pages.includes(page.page)) continue;
    const fichas = fichasDaPagina(page);
    const linhas = linhasDeFichas(fichas);
    const deGabarito = linhas.filter(linhaDeGabarito);
    if (!deGabarito.length || (deGabarito.length < 3 && deGabarito.length < 0.4 * linhas.length)) continue;
    const temEspanhol = fichas.some((f) => f.tipo === 'outro' && /^espanhol/i.test(semAcento(f.valor)));
    if (temEspanhol) mencionaEspanhol = true;
    deGabarito[0].primeira = true;
    deGabarito[deGabarito.length - 1].ultima = true;
    for (const linha of linhas) {
      const titulo = linhaDeGabarito(linha) ? null : tituloDeTabela(linha);
      if (titulo) {
        atual = { ...titulo, linhas: [] };
        secoes.push(atual);
        continue;
      }
      if (!linhaDeGabarito(linha)) continue;
      if (!atual) {
        atual = { tipo: null, lingua: null, linhas: [] };
        secoes.push(atual);
      }
      atual.linhas.push({ ...linha, page: page.page, temEspanhol });
    }
  }
  return { secoes: secoes.filter((s) => s.linhas.length), mencionaEspanhol };
}

/** A chave de uma seção: pela posição ou pelo texto, a que render mais. */
function chaveDaSecao(secao) {
  const porPosicao = chaveDasLinhas(secao.linhas);
  const porTexto = parseAnswerKeyText(textoDasLinhas(secao.linhas)).key;
  return Object.keys(porPosicao).length >= Object.keys(porTexto).length ? porPosicao : porTexto;
}

/**
 * Junta as tabelas: as do tipo do caderno (`tipo`; sem ele, o primeiro tipo
 * da folha) — a de inglês (ou sem língua) é a prova principal e a de espanhol
 * vira "N:espanhol" na faixa de questões em que as duas diferem (as questões
 * de língua; fora delas a letra é a mesma e a entrada seria só repetição).
 */
function juntarSecoes(secoes, { tipo = null } = {}) {
  const tipos = secoes.map((s) => s.tipo).filter((t) => t != null);
  const escolhido = tipos.includes(tipo) ? tipo : tipos.length ? tipos[0] : null;
  const doTipo = (s) => s.tipo == null || s.tipo === escolhido;
  const key = {};
  for (const s of secoes) {
    if (!doTipo(s) || s.lingua === 'espanhol') continue;
    for (const [k, v] of Object.entries(chaveDaSecao(s))) if (!key[k]) key[k] = v;
  }
  const espanhol = {};
  for (const s of secoes) {
    if (!doTipo(s) || s.lingua !== 'espanhol') continue;
    for (const [k, v] of Object.entries(chaveDaSecao(s))) if (/^\d+$/.test(k) && !espanhol[k]) espanhol[k] = v;
  }
  const diferentes = Object.keys(espanhol).map(Number).filter((n) => key[String(n)] && espanhol[String(n)] !== key[String(n)]);
  if (diferentes.length) {
    const de = Math.min(...diferentes);
    const ate = Math.max(...diferentes);
    for (let n = de; n <= ate; n += 1) if (espanhol[String(n)]) key[keyName(n, 'espanhol')] = espanhol[String(n)];
  }
  return { key, tipo: escolhido, tabelaEspanhol: Object.keys(espanhol).length > 0 };
}

/**
 * Lê o gabarito a partir do layout (layout.js): só as linhas de gabarito das
 * páginas de gabarito, tabela por tabela. Opções: `tipo` (o tipo do caderno,
 * quando a folha traz uma tabela por tipo) e `pages` (só estas páginas — o
 * gabarito no fim do próprio PDF da prova).
 *
 * `sharedLanguages`: a folha não fala em espanhol — uma letra só por número,
 * que vale para as duas línguas (a VUNESP publica assim). Quem chama decide
 * se aplica (nunca no ENEM, que sempre traz as duas colunas).
 *
 * @param {{ pages: Array<{ texts: Array }> }} layout
 * @returns {{ key: object, count: number, sharedLanguages: boolean, tipo: number|null }}
 */
function parseAnswerKeyLayout(layout, options = {}) {
  const { secoes, mencionaEspanhol } = secoesDoLayout(layout, options);
  const { key, tipo, tabelaEspanhol } = juntarSecoes(secoes, options);
  const temEntradaEspanhol = Object.keys(key).some((k) => k.endsWith(':espanhol'));
  // (tabela de espanhol igual à de inglês: a mesma letra vale para as duas)
  const sharedLanguages = !temEntradaEspanhol && (!mencionaEspanhol || tabelaEspanhol);
  return { ...resultado(key), sharedLanguages, tipo };
}

/** O texto das linhas do layout, para a leitura por texto quando a posição não rende. */
function textoDoLayout(layout) {
  return ((layout && layout.pages) || [])
    .map((page) => linhasDeFichas(fichasDaPagina(page)).map((l) => l.fichas.map((f) => f.valor).join(' ')).join('\n'))
    .join('\n\n');
}

/**
 * Tipo do caderno, pela capa ("NÍVEL MÉDIO TIPO 1 – BRANCA"): as páginas
 * antes da primeira questão. Null quando a capa não diz.
 */
function tipoDoCaderno(layout, ate = 2) {
  for (const page of ((layout && layout.pages) || []).slice(0, ate)) {
    const texto = semAcento((page.texts || []).map((t) => t.str).join(''));
    const m = /TIPO(\d{1,2})(?!\d)/.exec(texto);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Para prova que não é do ENEM com gabarito de uma letra só por número
 * (`sharedLanguages`): a letra vale para a opção de espanhol também. Põe a
 * entrada "N:espanhol" das questões dadas (as que têm a variante de
 * espanhol), sem mexer no que a folha já trouxe.
 */
function shareLanguages(key, numbers) {
  const out = { ...key };
  for (const n of numbers) {
    const letra = out[String(n)];
    if (letra && !out[keyName(n, 'espanhol')]) out[keyName(n, 'espanhol')] = letra;
  }
  return out;
}

/**
 * Lê o PDF do gabarito no servidor (Buffer). Erros com `code` como os do
 * leitor ('leitor_indisponivel', 'pdf_invalido').
 *
 * @returns {Promise<{ key: object, count: number, sharedLanguages: boolean, tipo: number|null }>}
 */
async function readAnswerKey(buffer, options = {}) {
  // eslint-disable-next-line global-require
  const { openPdf, extractLayout } = require('./layout');
  const doc = await openPdf(buffer);
  try {
    const layout = await extractLayout(doc);
    return parseAnswerKeyLayout(layout, options);
  } finally {
    await doc.destroy().catch(() => {});
  }
}

module.exports = {
  LETRAS,
  keyName,
  answerFor,
  parseAnswerKeyText,
  parseAnswerKeyLayout,
  textoDoLayout,
  tipoDoCaderno,
  shareLanguages,
  readAnswerKey,
};

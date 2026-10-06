'use strict';

/**
 * Formatação dentro da linha (negrito, itálico, sublinhado, índice e
 * expoente) do texto da prova até o markdown.
 *
 *   const { M, toMarkdown, stripMarks } = require('./markup');
 *
 * O texto das linhas é montado com marcas invisíveis (caracteres de uso
 * privado U+E700…) em volta de cada trecho formatado. Elas atravessam a
 * montagem dos parágrafos e o escape do markdown sem serem tocadas, e só no
 * fim viram a sintaxe que as telas entendem (public/js/core/markdown.js):
 *
 *   negrito    **palavra**        itálico   *palavra*
 *   sublinhado ++palavra++        índice    d_{ij}      expoente  3^{x}
 *
 * Índice e expoente de dígito, sinal e das letras que o Unicode tem ("x²",
 * "H₂O", "Kₐ") continuam como caractere; a marca é para o resto ("Lₑ" não
 * existe como "L_{E}", "dᵢⱼ" como "d_{ij}", "3ˣ" como "3^{x}") — sem ela,
 * "3^x = 4^z" virava "3x = 4z" e o problema mudava.
 *
 * Por que não HTML (<u>, <sub>): o leitor só emite markdown seguro; o texto
 * do PDF nunca vira tag.
 */

/** Marcas: abre/fecha de cada formatação. */
const M = Object.freeze({
  B0: '\ue700', B1: '\ue701', // negrito
  I0: '\ue702', I1: '\ue703', // itálico
  U0: '\ue704', U1: '\ue705', // sublinhado
  SUB0: '\ue706', SUB1: '\ue707', // índice
  SUP0: '\ue708', SUP1: '\ue709', // expoente
  FIG0: '\ue70a', FIG1: '\ue70b', // figura no meio da linha: \ue70a<n>\ue70b
});

/** Faixa das marcas (para limpar a entrada e o texto puro). */
const MARCAS = /[\ue700-\ue70b]/g;
const ABRE_FECHA = [[M.B0, M.B1], [M.I0, M.I1], [M.U0, M.U1]];

/** Texto sem as marcas (o "texto puro" de uma linha). */
function stripMarks(text) {
  return String(text || '').replace(/\ue70a\d+\ue70b/g, '').replace(MARCAS, '');
}

/**
 * Arruma as marcas de um parágrafo já juntado: trecho que fecha e reabre a
 * mesma formatação só com espaço no meio vira um trecho só ("**uma**
 * **frase**" → "**uma frase**"), e o espaço da borda fica de fora da marca
 * (o markdown não aceita "** palavra**").
 */
function tidyMarks(text) {
  let s = String(text || '');
  for (const [a, b] of ABRE_FECHA) {
    s = s.split(`${b}${a}`).join('');
    // (sublinhado separado por espaço é de dois traços — fica separado)
    if (a !== M.U0) s = s.replace(new RegExp(`${b}(\\s+)${a}`, 'g'), '$1');
    s = s.replace(new RegExp(`${a}(\\s+)`, 'g'), `$1${a}`);
    s = s.replace(new RegExp(`(\\s+)${b}`, 'g'), `${b}$1`);
    // trecho vazio some
    s = s.split(`${a}${b}`).join('');
  }
  // aspas e pontuação da borda ficam fora do sublinhado ("“++Moreover++,")
  s = s.replace(new RegExp(`${M.U0}([“"‘'(«]+)`, 'g'), `$1${M.U0}`)
    .replace(new RegExp(`([”"’'),.;:!?»]+)${M.U1}`, 'g'), `${M.U1}$1`);
  return s;
}

/**
 * Troca as marcas pela sintaxe do markdown. `figure(n)` devolve o markdown da
 * figura n que ficou no meio da linha (fórmula recortada).
 */
function toMarkdown(text, { figure = () => '' } = {}) {
  let s = tidyMarks(text);
  s = s.replace(/\ue70a(\d+)\ue70b/g, (_, n) => figure(Number(n)));
  return s
    .split(M.B0).join('**').split(M.B1).join('**')
    .split(M.I0).join('*').split(M.I1).join('*')
    .split(M.U0).join('++').split(M.U1).join('++')
    .split(M.SUB0).join('_{').split(M.SUB1).join('}')
    .split(M.SUP0).join('^{').split(M.SUP1).join('}');
}

/** Marcador de figura no meio da linha. */
function figureMark(n) {
  return `${M.FIG0}${n}${M.FIG1}`;
}

module.exports = {
  M,
  MARCAS,
  stripMarks,
  tidyMarks,
  toMarkdown,
  figureMark,
};

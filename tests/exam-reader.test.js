'use strict';

/**
 * Leitor de provas no servidor — núcleo, com layouts sintéticos.
 *
 *   NODE_ENV=test node --test tests/exam-reader.test.js
 *
 * O leitor antigo recebia o texto do PDF sem posição e cortava por expressão
 * regular: a capa caía na questão 1, a proposta de redação na 46, o rodapé
 * "CADERNO 2 • AMARELO" dentro de metade dos enunciados, e a fonte embaralhada
 * do PPL 2017 virava "&RQ¿UD". O núcleo novo trabalha sobre um "layout" (texto
 * com posição, imagens, desenhos) — então dá para montar páginas pequenas aqui
 * mesmo, sem PDF, e conferir cada regra. As provas reais estão em
 * exam-reader-corpus.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readLayout } = require('../server/services/exam-reader');
const { decodeLayout, decodeArialGlyphs, legibilityScore, ARIAL_GLYPHS } = require('../server/services/exam-reader/decode');
const { joinItems, buildLines } = require('../server/services/exam-reader/structure');
const { escapeMarkdown, joinText } = require('../server/services/exam-reader/questions');

// ---------------------------------------------------------------------------
// Montagem de páginas sintéticas
// ---------------------------------------------------------------------------

const W = 567;
const H = 780;

function item(str, x, base, { fs = 9.8, font = 'ArialMT', w, ...extra } = {}) {
  return { x, y: base - fs, w: w ?? str.length * fs * 0.45, h: fs, base, fs, font, str, ...extra };
}

/**
 * Uma coluna onde se escreve de cima para baixo. `linha(texto, { cheia })`:
 * linha cheia vai até a margem direita (texto justificado, continua na de baixo).
 */
function coluna(x, right, y = 70) {
  const col = {
    x, right, y, items: [], paths: [],
    linha(str, { cheia = false, recuo = 0, fs = 9.8, font = 'ArialMT', dy = 12, ...extra } = {}) {
      const x0 = col.x + recuo;
      const w = cheia ? col.right - x0 : Math.min(str.length * fs * 0.45, col.right - x0 - 20);
      col.items.push(item(str, x0, col.y + fs, { fs, font, w, ...extra }));
      col.y += dy;
      return col;
    },
    espaco(dy) {
      col.y += dy;
      return col;
    },
    /** Marca do ENEM ("QUESTÃO 07"), com o fio do ornamento à direita. */
    marca(n) {
      col.items.push(item(`QUESTÃO ${String(n).padStart(2, '0')}`, col.x, col.y + 9.8, { font: 'Arial-BoldMT', w: 62 }));
      col.paths.push({ x: col.x + 74, y: col.y + 4, w: col.right - col.x - 74, h: 0, paint: 'stroke', lw: 3.5, sc: '#c4c5c7' });
      col.y += 20;
      return col;
    },
    /** Marca do VUNESP ("07" em negrito, sozinho na linha). */
    numero(n) {
      col.items.push(item(String(n).padStart(2, '0'), col.x + 2, col.y + 9, { fs: 9, font: 'Tahoma-Bold', w: 11 }));
      col.y += 20;
      return col;
    },
    /** Alternativas do ENEM: letra em círculo (BundesbahnPi) e texto 17 pt à direita. */
    alternativas(textos, { letras = ['A', 'B', 'C', 'D', 'E'] } = {}) {
      textos.forEach((t, i) => {
        col.items.push(item(letras[i], col.x, col.y + 9.8, { font: 'BundesbahnPiStd-1', w: 9.8 }));
        col.items.push(item(t, col.x + 17, col.y + 9.8, { w: Math.min(t.length * 4.4, col.right - col.x - 30) }));
        col.y += 14.6;
      });
      col.y += 10;
      return col;
    },
    /** Alternativas do VUNESP: "(A)" separado, texto com recuo pendurado. */
    alternativasVunesp(textos) {
      textos.forEach((t, i) => {
        const partes = Array.isArray(t) ? t : [t];
        col.items.push(item(`(${'ABCDE'[i]})`, col.x, col.y + 9.5, { fs: 9.5, w: 13 }));
        partes.forEach((p, k) => {
          const ultima = k === partes.length - 1;
          col.items.push(item(p, col.x + 17, col.y + 9.5, { fs: 9.5, w: ultima ? p.length * 4.3 : col.right - col.x - 17 }));
          col.y += 12;
        });
        col.y += 8;
      });
      return col;
    },
  };
  return col;
}

/** Cabeçalho e rodapé do ENEM: código de barras, fio, rodapé com o caderno e o número da página. */
function bordaEnem(n) {
  return {
    texts: [
      item(`*010275AM${n}*`, 31, 36, { fs: 20, font: 'C39HrP36DlTt', w: 106 }),
      item(String(n), n % 2 ? 530 : 31, 748, { fs: 7, w: 4 }),
      item('–LC • 1º DIA • CADERNO 2 • AMARELO –', 214, 748, { fs: 7, w: 139 }),
    ],
    paths: [
      { x: 31, y: 57, w: 505, h: 0, paint: 'stroke', lw: 1, sc: '#000000' },
      { x: 31, y: 745, w: 505, h: 0, paint: 'stroke', lw: 1, sc: '#000000' },
    ],
  };
}

function pagina(n, colunas, { borda = bordaEnem, images = [], paths = [], texts = [] } = {}) {
  const b = borda ? borda(n) : { texts: [], paths: [] };
  return {
    page: n,
    width: W,
    height: H,
    texts: [...b.texts, ...texts, ...colunas.flatMap((c) => c.items)],
    images,
    paths: [...b.paths, ...paths, ...colunas.flatMap((c) => c.paths)],
  };
}

const ALTS = ['primeira alternativa.', 'segunda alternativa.', 'terceira alternativa.', 'quarta alternativa.', 'quinta alternativa.'];

/** Questão ENEM simples numa coluna. */
function questao(col, n, enunciado = [`Enunciado da questão ${n}, com contexto suficiente para ser lida`, 'e respondida pelo aluno sem dúvida nenhuma.'], alts = ALTS) {
  col.marca(n);
  enunciado.forEach((l, i) => col.linha(l, { cheia: i < enunciado.length - 1 }));
  col.espaco(4);
  col.alternativas(alts);
  return col;
}

function capa() {
  return {
    page: 1, width: W, height: H, images: [], paths: [],
    texts: [
      item('CADERNO DE QUESTÕES', 180, 120, { fs: 20, font: 'Arial-BoldMT', w: 220 }),
      item('LEIA ATENTAMENTE AS INSTRUÇÕES SEGUINTES', 120, 200, { fs: 12, font: 'Arial-BoldMT', w: 330 }),
      item('1. Este CADERNO DE QUESTÕES contém 90 questões numeradas de 01 a 90.', 60, 230, { w: 450 }),
      item('CADERNO 2 AMARELO', 200, 700, { fs: 16, font: 'Arial-BoldMT', w: 180 }),
    ],
  };
}

const textoDe = (q) => [q.statement_md, ...q.alternatives.map((a) => a.text_md)].join('\n');

// ---------------------------------------------------------------------------

describe('leitor de provas — borda, capa e redação', () => {
  it('tira cabeçalho, rodapé e código de barras de todos os enunciados', () => {
    const p2e = coluna(31, 278);
    const p2d = coluna(289, 536);
    questao(p2e, 1);
    questao(p2e, 2);
    questao(p2d, 3);
    const p3e = coluna(31, 278);
    const p3d = coluna(289, 536);
    questao(p3e, 4);
    questao(p3d, 5);
    const r = readLayout({ pages: [capa(), pagina(2, [p2e, p2d]), pagina(3, [p3e, p3d])] });
    assert.deepEqual(r.questions.map((q) => q.number), [1, 2, 3, 4, 5]);
    for (const q of r.questions) {
      assert.doesNotMatch(textoDe(q), /CADERNO|\*010275|AMARELO|DIA/, `questão ${q.number} com borda`);
      assert.equal(q.alternatives.length, 5);
      assert.deepEqual(q.alerts, []);
    }
    const tipos = new Set(r.discarded.map((d) => d.kind));
    assert.ok(tipos.has('codigo_barras'));
    assert.ok(tipos.has('rodape'));
  });

  it('a capa não entra na questão 1 e vai para o descarte', () => {
    const p2e = coluna(31, 278);
    p2e.linha('LINGUAGENS, CÓDIGOS E SUAS TECNOLOGIAS', { font: 'Arial-BoldMT', fs: 10 });
    p2e.linha('Questões de 01 a 45', { font: 'Arial-BoldMT', fs: 10 });
    questao(p2e, 1);
    const p3e = coluna(31, 278);
    questao(p3e, 2);
    const r = readLayout({ pages: [capa(), pagina(2, [p2e]), pagina(3, [p3e])] });
    const q1 = r.questions[0];
    assert.match(q1.statement_md, /^Enunciado da questão 1, com contexto/);
    assert.doesNotMatch(textoDe(q1), /CADERNO DE QUESTÕES|LEIA ATENTAMENTE|LINGUAGENS|Questões de 01/);
    assert.ok(r.discarded.some((d) => d.kind === 'capa' && /CADERNO DE QUESTÕES/.test(d.text)));
    assert.ok(r.discarded.some((d) => d.kind === 'secao' && /Questões de 01 a 45/.test(d.text)));
  });

  it('a proposta de redação entre a 45 e a 46 é descartada inteira', () => {
    const p2 = coluna(31, 278);
    questao(p2, 45);
    const red = coluna(31, 536);
    red.linha('INSTRUÇÕES PARA A REDAÇÃO', { font: 'Arial-BoldMT', fs: 10 });
    red.linha('1. O rascunho da redação deve ser feito no espaço apropriado e escrito a caneta.', { cheia: true });
    red.linha('TEXTO I', { font: 'Arial-BoldMT' });
    red.linha('A violência contra a mulher no Brasil persiste como um problema grave.', { cheia: true });
    red.linha('PROPOSTA DE REDAÇÃO', { font: 'Arial-BoldMT' });
    const p4 = coluna(31, 278);
    p4.linha('CIÊNCIAS HUMANAS E SUAS TECNOLOGIAS', { font: 'Arial-BoldMT', fs: 10 });
    p4.linha('Questões de 46 a 90', { font: 'Arial-BoldMT', fs: 10 });
    questao(p4, 46);
    const r = readLayout({ pages: [pagina(2, [p2]), pagina(3, [red]), pagina(4, [p4])] });
    assert.deepEqual(r.questions.map((q) => q.number), [45, 46]);
    for (const q of r.questions) assert.doesNotMatch(textoDe(q), /REDAÇÃO|violência|rascunho|CIÊNCIAS HUMANAS/);
    assert.equal(r.questions[0].alternatives[4].text_md, 'quinta alternativa.');
    assert.ok(r.discarded.some((d) => d.kind === 'redacao' && /INSTRUÇÕES PARA A REDAÇÃO/.test(d.text)));
  });

  it('a região vai até o fim da E: o que vem depois, até a próxima marca, sai', () => {
    const e = coluna(31, 278);
    questao(e, 44);
    e.linha('Texto solto que não é de questão nenhuma e fica entre as duas.', { recuo: 0 });
    const d = coluna(289, 536);
    questao(d, 45);
    const r = readLayout({ pages: [pagina(2, [e, d]), pagina(3, [coluna(31, 278)])] });
    const q44 = r.questions[0];
    assert.equal(q44.alternatives[4].text_md, 'quinta alternativa.');
    assert.doesNotMatch(textoDe(q44), /Texto solto/);
    assert.ok(r.discarded.some((x) => /Texto solto/.test(x.text)));
  });
});

describe('leitor de provas — colunas e alternativas', () => {
  it('não mistura linhas de colunas diferentes na mesma altura', () => {
    const e = coluna(31, 278);
    const d = coluna(289, 536);
    questao(e, 10, ['O texto da esquerda começa aqui e vai até a margem da coluna', 'e termina nesta linha curta.']);
    questao(d, 11, ['O texto da direita fica na mesma altura e não pode colar', 'no texto da coluna da esquerda.']);
    const r = readLayout({ pages: [pagina(2, [e, d]), pagina(3, [coluna(31, 278)])] });
    const [q10, q11] = r.questions;
    assert.equal(q10.statement_md, 'O texto da esquerda começa aqui e vai até a margem da coluna e termina nesta linha curta.');
    assert.equal(q11.statement_md, 'O texto da direita fica na mesma altura e não pode colar no texto da coluna da esquerda.');
  });

  it('questão que começa no pé da coluna esquerda continua no topo da direita', () => {
    const e = coluna(31, 278);
    questao(e, 1);
    e.y = 640;
    e.marca(2);
    e.linha('O enunciado começa embaixo, na coluna da esquerda, e segue', { cheia: true });
    e.linha('direto para a outra coluna sem ponto final no meio, porque', { cheia: true });
    const d = coluna(289, 536);
    d.linha('o texto é corrido e só termina aqui.');
    d.espaco(4);
    d.alternativas(ALTS);
    questao(d, 3);
    const r = readLayout({ pages: [pagina(2, [e, d]), pagina(3, [coluna(31, 278)])] });
    const q2 = r.questions.find((q) => q.number === 2);
    assert.equal(q2.statement_md, 'O enunciado começa embaixo, na coluna da esquerda, e segue direto para a outra coluna sem ponto final no meio, porque o texto é corrido e só termina aqui.');
    assert.equal(q2.alternatives.length, 5);
    assert.deepEqual(q2.alerts, []);
    assert.deepEqual(q2.source_pages, [2]);
  });

  it('página de coluna única: linha que atravessa o meio não é cortada', () => {
    const c = coluna(31, 536);
    questao(c, 7, ['Esta questão ocupa a largura inteira da página e a linha atravessa o vão do meio sem', 'quebrar em duas colunas.']);
    const r = readLayout({ pages: [pagina(2, [c]), pagina(3, [coluna(31, 278)])] });
    assert.equal(r.questions[0].statement_md, 'Esta questão ocupa a largura inteira da página e a linha atravessa o vão do meio sem quebrar em duas colunas.');
  });

  it('alternativas do VUNESP: "(A)" na margem, recuo pendurado e hífen de quebra', () => {
    const c = coluna(34, 291, 30);
    c.numero(1);
    c.linha('O excerto refere-se ao período de governo de dois reis', { cheia: true, fs: 9.5 });
    c.linha('portugueses. Nesse período,', { fs: 9.5 });
    c.espaco(8);
    c.alternativasVunesp([
      ['intensificou-se o trânsito comercial e elaboraram-', 'se novas noções sobre o planeta.'],
      ['empobreceram-se as sociedades europeias e consoli-', 'dou-se o desabastecimento.'],
      'adotou-se o livre cambismo.',
      'atenuaram-se os conflitos políticos.',
      'dividiu-se o continente africano.',
    ]);
    const c2 = coluna(305, 561, 30);
    c2.numero(2);
    c2.linha('Segunda questão com a letra (A) no meio do enunciado, que não é', { cheia: true, fs: 9.5 });
    c2.linha('alternativa nenhuma.', { fs: 9.5 });
    c2.espaco(8);
    c2.alternativasVunesp(['um.', 'dois.', 'três.', 'quatro.', 'cinco.']);
    const borda = (n) => ({ texts: [item('Confidencial até o momento da aplicação.', 451, 818, { fs: 6, font: 'Tahoma', w: 111 }), item(String(n), 292, 818, { fs: 9, font: 'Tahoma-Bold', w: 6 })], paths: [] });
    const r = readLayout({ pages: [{ ...pagina(2, [c, c2], { borda }), height: 842, width: 595 }, { ...pagina(3, [coluna(34, 291)], { borda }), height: 842, width: 595 }] }, { examKind: 'vunesp' });
    assert.equal(r.kind, 'vunesp');
    const [q1, q2] = r.questions;
    assert.deepEqual(q1.alternatives.map((a) => a.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(q1.alternatives[0].text_md, 'intensificou-se o trânsito comercial e elaboraram-se novas noções sobre o planeta.');
    assert.equal(q1.alternatives[1].text_md, 'empobreceram-se as sociedades europeias e consolidou-se o desabastecimento.');
    assert.equal(q2.statement_md, 'Segunda questão com a letra (A) no meio do enunciado, que não é alternativa nenhuma.');
    assert.equal(q2.alternatives[0].text_md, 'um.');
    for (const q of r.questions) assert.doesNotMatch(textoDe(q), /Confidencial/);
  });

  it('alternativas em grade (A B C / D E) e alternativa que é só figura', () => {
    const c = coluna(31, 536);
    c.marca(163);
    c.linha('Após desdobrado o papel, a figura plana obtida será');
    c.espaco(20);
    const linha1 = c.y + 9.8;
    const linha2 = linha1 + 130;
    const letras = [['A', 31, linha1], ['B', 202, linha1], ['C', 372, linha1 - 4], ['D', 31, linha2], ['E', 202, linha2]];
    const images = [];
    for (const [l, x, base] of letras) {
      c.items.push(item(l, x, base, { font: 'BundesbahnPiStd-1', w: 9.8 }));
      images.push({ x: x + 20, y: base - 50, w: 100, h: 100, kind: 'image' });
    }
    const r = readLayout({ pages: [pagina(2, [c], { images }), pagina(3, [coluna(31, 278)])] });
    const q = r.questions[0];
    assert.deepEqual(q.alternatives.map((a) => a.letter), ['A', 'B', 'C', 'D', 'E']);
    q.alternatives.forEach((a, i) => {
      assert.match(a.text_md, /^!\[Alternativa [A-E]\]\(figura:\d+\)$/);
      const fig = q.figures[Number(/figura:(\d+)/.exec(a.text_md)[1])];
      assert.equal(fig.slot, a.letter);
      assert.equal(Math.round(fig.bbox.x), Math.round(letras[i][1] + 20));
    });
    assert.ok(!q.alerts.includes('alternativas_incompletas'));
  });

  it('faltando alternativa: alerta, e a questão não é perdida', () => {
    const c = coluna(31, 278);
    questao(c, 5, undefined, ALTS.slice(0, 4));
    const r = readLayout({ pages: [pagina(2, [c]), pagina(3, [coluna(31, 278)])] });
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].alternatives.length, 4);
    assert.ok(r.questions[0].alerts.includes('alternativas_incompletas'));
  });

  it('figura do enunciado fica na posição certa entre os parágrafos', () => {
    const c = coluna(31, 278);
    c.marca(1);
    c.linha('Observe a imagem a seguir.');
    c.espaco(110);
    c.linha('Disponível em: www.exemplo.com.br. Acesso em: 1 jan. 2024.', { fs: 6, recuo: 60 });
    c.linha('A imagem mostra que');
    c.espaco(4);
    c.alternativas(ALTS);
    const images = [{ x: 40, y: 100, w: 200, h: 100, kind: 'image' }];
    const r = readLayout({ pages: [pagina(2, [c], { images }), pagina(3, [coluna(31, 278)])] });
    const q = r.questions[0];
    assert.equal(q.statement_md, 'Observe a imagem a seguir.\n\n![Figura](figura:0)\n\nDisponível em: www.exemplo.com.br. Acesso em: 1 jan. 2024.\n\nA imagem mostra que');
    assert.equal(q.figures[0].slot, 'enunciado');
    assert.equal(q.figures[0].page, 2);
  });
});

describe('leitor de provas — variantes de idioma e apoio compartilhado', () => {
  it('ENEM dia 1: questões 1 a 5 em inglês e em espanhol, sem misturar', () => {
    const p2 = coluna(31, 278);
    p2.linha('Questões de 01 a 02 (opção inglês)', { font: 'Arial-BoldMT', fs: 10 });
    questao(p2, 1, ['Read the text and answer the question about the cartoon below', 'and its meaning.']);
    questao(p2, 2);
    const p2d = coluna(289, 536);
    p2d.linha('Questões de 01 a 02 (opção espanhol)', { font: 'Arial-BoldMT', fs: 10 });
    questao(p2d, 1, ['Lee el texto y contesta la pregunta sobre la viñeta de abajo', 'y su significado.']);
    questao(p2d, 2);
    const p3 = coluna(31, 278);
    p3.linha('Questões de 03 a 45', { font: 'Arial-BoldMT', fs: 10 });
    questao(p3, 3);
    const r = readLayout({ pages: [pagina(2, [p2, p2d]), pagina(3, [p3])] });
    assert.deepEqual(r.questions.map((q) => `${q.number}${q.variant ? `-${q.variant}` : ''}`), ['1-ingles', '2-ingles', '1-espanhol', '2-espanhol', '3']);
    assert.match(r.questions[0].statement_md, /^Read the text/);
    assert.match(r.questions[2].statement_md, /^Lee el texto/);
    for (const q of r.questions) assert.ok(!q.alerts.includes('numero_fora_de_sequencia'), `${q.number} ${q.variant}`);
  });

  it('VUNESP: apoio "para responder às questões de 2 a 3" entra nas duas, e só nelas', () => {
    const borda = () => ({ texts: [], paths: [] });
    const e = coluna(34, 291, 30);
    e.numero(1);
    e.linha('Primeira questão, que não faz parte do apoio anunciado logo', { cheia: true, fs: 9.5 });
    e.linha('depois dela.', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    e.espaco(10);
    e.linha('Leia o trecho do romance para responder às questões de', { cheia: true, fs: 9.5 });
    e.linha('2 a 3.', { fs: 9.5 });
    e.espaco(6);
    e.linha('Uma noite destas, vindo da cidade para o Engenho Novo,', { cheia: true, recuo: 17, fs: 9.5 });
    e.linha('encontrei no trem da Central um rapaz aqui do bairro.', { fs: 9.5 });
    e.linha('(Machado de Assis. Dom Casmurro.)', { fs: 7.5, recuo: 120 });
    const d = coluna(305, 561, 30);
    d.numero(2);
    d.linha('No trecho, o rapaz do trem mostra-se', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['lisonjeado.', 'invejoso.', 'desconfiado.', 'ressentido.', 'distraído.']);
    d.numero(3);
    d.linha('O estilo do narrador pode ser caracterizado como', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['digressivo.', 'moralizante.', 'hiperbólico.', 'hermético.', 'impessoal.']);
    const r = readLayout({ pages: [{ ...pagina(8, [e, d], { borda }), width: 595, height: 842 }] }, { examKind: 'vunesp' });
    const [q1, q2, q3] = r.questions;
    assert.doesNotMatch(q1.statement_md, /Engenho Novo/);
    assert.equal(q1.alternatives[4].text_md, 'e.');
    for (const q of [q2, q3]) {
      assert.match(q.statement_md, /^Leia o trecho do romance para responder às questões de 2 a 3\.\n\nUma noite destas, vindo da cidade para o Engenho Novo, encontrei no trem da Central um rapaz aqui do bairro\.\n\n\(Machado de Assis\. Dom Casmurro\.\)\n\n/);
    }
    assert.match(q2.statement_md, /o rapaz do trem mostra-se$/);
    assert.match(q3.statement_md, /caracterizado como$/);
  });

  it('VUNESP: "língua inglesa" e "língua espanhola" com a mesma numeração', () => {
    const borda = () => ({ texts: [], paths: [] });
    const e = coluna(34, 291, 30);
    e.numero(38);
    e.linha('Questão de português antes das línguas estrangeiras.', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    e.linha('língua inglesa', { fs: 11, font: 'Tahoma-Bold' });
    e.numero(39);
    e.linha('What is the main idea of the text?', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    e.numero(40);
    e.linha('According to the text, the author', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    const d = coluna(305, 561, 30);
    d.linha('língua esPanHola', { fs: 11, font: 'Tahoma-Bold' });
    d.numero(39);
    d.linha('¿Cuál es la idea principal del texto?', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    d.numero(40);
    d.linha('Pregunta de español que sigue.', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    const p2 = coluna(34, 291, 30);
    p2.numero(41);
    p2.linha('Questão de matemática depois das línguas.', { fs: 9.5 });
    p2.espaco(8);
    p2.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    const r = readLayout({
      pages: [{ ...pagina(12, [e, d], { borda }), width: 595, height: 842 }, { ...pagina(13, [p2], { borda }), width: 595, height: 842 }],
    }, { examKind: 'vunesp' });
    assert.deepEqual(r.questions.map((q) => `${q.number}${q.variant ? `-${q.variant}` : ''}`), ['38', '39-ingles', '40-ingles', '39-espanhol', '40-espanhol', '41']);
    assert.ok(r.questions.every((q) => !q.alerts.includes('numero_fora_de_sequencia')));
  });

  it('número repetido sem título de idioma vira alerta (ENEM)', () => {
    const c = coluna(31, 278);
    questao(c, 10);
    questao(c, 10);
    const r = readLayout({ pages: [pagina(2, [c]), pagina(3, [coluna(31, 278)])] });
    assert.equal(r.questions.length, 2);
    assert.ok(r.questions[1].alerts.includes('numero_fora_de_sequencia'));
  });
});

describe('leitor de provas — fonte embaralhada', () => {
  /** Codifica como o PPL 2017: código = índice do glifo no Arial (ASCII − 29, acentos pela tabela). */
  const reverso = Object.fromEntries(Object.entries(ARIAL_GLYPHS).map(([k, v]) => [v, Number(k)]));
  const embaralha = (texto) => [...texto].map((ch) => {
    if (reverso[ch] && ch.codePointAt(0) > 126) return String.fromCodePoint(reverso[ch]);
    return String.fromCodePoint(ch.codePointAt(0) - 29);
  }).join('');

  const frase = 'A política de pacificação não resolve todos os problemas da favela carioca, ela é apenas um primeiro e indispensável passo para que seus moradores sejam tratados como cidadãos.';

  it('decodifica pela ordem de glifos do Arial (inclusive acentos)', () => {
    const bruto = embaralha(frase);
    assert.match(bruto, /\u0003/);
    assert.equal(decodeArialGlyphs(bruto), frase);
    assert.ok(legibilityScore(frase) > 0.2);
    assert.ok(legibilityScore(bruto) < 0.05);
  });

  it('no layout: a questão sai legível e sem alerta', () => {
    const c = coluna(31, 278);
    c.marca(71);
    const pedacos = frase.match(/.{1,55}(\s|$)/g).map((s) => s.trim());
    pedacos.forEach((p, i) => {
      c.items.push(item(embaralha(p), 31, c.y + 9.8, { w: i < pedacos.length - 1 ? 247 : 120, font: 'ArialMT', fontId: 'f3' }));
      c.y += 12;
    });
    c.items.push(item(embaralha('GOMES, L. 1889. São Paulo: Globo, 2013 (adaptado).').replace(/[\u000b\u000c]/g, ' '), 60, c.y + 6, {
      fs: 6, w: 200, font: 'ArialMT', fontId: 'f3',
      // o pdf.js troca os códigos 11 e 12 ("(" e ")") por espaço; layout.js guarda o código original
      codes: [...embaralha('GOMES, L. 1889. São Paulo: Globo, 2013 (adaptado).')].map((ch) => ch.codePointAt(0)),
    }));
    c.y += 14;
    c.alternativas(ALTS);
    const layout = {
      fonts: { f3: { name: 'ArialMT', type: 'CIDFontType0', toUnicode: false } },
      pages: [pagina(26, [c]), pagina(27, [coluna(31, 278)])],
    };
    const r = readLayout(layout);
    const q = r.questions[0];
    assert.match(q.statement_md, /^A política de pacificação não resolve todos os problemas/);
    assert.match(q.statement_md, /Globo, 2013 \(adaptado\)\.$/);
    assert.deepEqual(q.alerts, []);
    assert.equal(r.decode[0].method, 'glifos-arial');
  });

  it('deslocamento simples (fonte que não é Arial) também se resolve', () => {
    const texto = 'O texto desta questão foi gravado com uma fonte de código deslocado e precisa ser lido de novo para que o aluno entenda o que está sendo perguntado.';
    const desloc = [...texto].map((ch) => (ch === ' ' ? '\u0001' : String.fromCodePoint(ch.codePointAt(0) - 31))).join('');
    const layout = { fonts: { x: { name: 'Qualquer', toUnicode: false } }, pages: [{ page: 1, width: W, height: H, texts: [item(desloc, 31, 100, { fontId: 'x', font: 'Qualquer' })] }] };
    const rel = decodeLayout(layout);
    assert.equal(rel[0].method, 'deslocamento+31');
    assert.equal(layout.pages[0].texts[0].str.replace(/\s+/g, ' '), texto);
  });

  it('o que não dá para ler fica marcado: alerta texto_ilegivel, nunca lixo calado', () => {
    const c = coluna(31, 278);
    c.marca(3);
    const lixo = '\u0007\u0012\u0005\u0019\u0002\u0011\u0004\u0015\u0006\u0018\u0013\u0001\u0010\u0016';
    for (let i = 0; i < 4; i += 1) {
      c.items.push(item(lixo.repeat(3), 31, c.y + 9.8, { w: 247, font: 'Estranha', fontId: 'z' }));
      c.y += 12;
    }
    c.alternativas(ALTS);
    const r = readLayout({ fonts: { z: { name: 'Estranha', toUnicode: false } }, pages: [pagina(2, [c]), pagina(3, [coluna(31, 278)])] });
    assert.ok(r.questions[0].alerts.includes('texto_ilegivel'));
  });
});

describe('leitor de provas — texto da linha e markdown', () => {
  it('espaço pela geometria: vão vira espaço, espaço falso do VUNESP some', () => {
    const fs = 9.5;
    const its = [
      { x: 10, w: 5, str: 'p', fs, base: 20 },
      { x: 15, w: 40, str: ' otências', fs, base: 20 },
      { x: 61, w: 30, str: 'parágrafo)', fs, base: 20 },
    ].map((t) => ({ ...t, x1: t.x + t.w, y: t.base - fs, h: fs }));
    assert.equal(joinItems(its), 'potências parágrafo)');
  });

  it('sobrescrito e subscrito viram caracteres (sem HTML)', () => {
    const its = [
      { x: 10, w: 10, str: 'Hg', fs: 9.8, base: 20 },
      { x: 20, w: 3, str: '2', fs: 6.5, base: 22.5 },
      { x: 25, w: 20, str: ' cm', fs: 9.8, base: 20 },
      { x: 45, w: 3, str: '2', fs: 6.5, base: 16.5 },
    ].map((t) => ({ ...t, y: t.base - t.fs, h: t.fs, x1: t.x + t.w }));
    const [linha] = buildLines(its);
    assert.equal(linha.text, 'Hg₂ cm²');
  });

  it('hífen de fim de linha: ENEM mantém (palavra composta), VUNESP junta a sílaba', () => {
    const enem = { hyphenates: false, hyphenWords: new Set() };
    const vunesp = { hyphenates: true, hyphenWords: new Set(['guarda-chuva']) };
    assert.equal(joinText('caldo de cana-', 'de-açúcar', enem), 'caldo de cana-de-açúcar');
    assert.equal(joinText('o impera-', 'dor', vunesp), 'o imperador');
    assert.equal(joinText('acabou alcunhando-', '-me Dom Casmurro', vunesp), 'acabou alcunhando-me Dom Casmurro');
    assert.equal(joinText('um guarda-', 'chuva', vunesp), 'um guarda-chuva');
    assert.equal(joinText('primeira', 'segunda', vunesp), 'primeira segunda');
  });

  it('markdown seguro: nada vira HTML, lista ou link sem querer', () => {
    assert.equal(escapeMarkdown('<script>alert(1)</script>'), '\\<script\\>alert(1)\\</script\\>');
    assert.equal(escapeMarkdown('1. Genética'), '1\\. Genética');
    assert.equal(escapeMarkdown('- item'), '\\- item');
    assert.equal(escapeMarkdown('[...] texto'), '\\[...\\] texto');
    assert.equal(escapeMarkdown('a * b _c_'), 'a \\* b \\_c\\_');
  });

  it('poema: verso fica em linha própria, prosa justificada vira parágrafo', () => {
    const c = coluna(31, 278);
    c.marca(2);
    for (const v of ['No man is an island,', 'Entire of itself;', 'Every man is a piece of the continent,', 'A part of the main.']) c.linha(v, { dy: 14.6 });
    c.linha('DONNE, J. The Works of John Donne. Londres, 1839.', { fs: 6, recuo: 70 });
    c.linha('Nesse poema, a expressão destacada pelo autor ressalta a', { cheia: true });
    c.linha('ideia de');
    c.espaco(4);
    c.alternativas(ALTS);
    const r = readLayout({ pages: [pagina(2, [c]), pagina(3, [coluna(31, 278)])] });
    assert.equal(r.questions[0].statement_md, [
      'No man is an island,\nEntire of itself;\nEvery man is a piece of the continent,\nA part of the main.',
      'DONNE, J. The Works of John Donne. Londres, 1839.',
      'Nesse poema, a expressão destacada pelo autor ressalta a ideia de',
    ].join('\n\n'));
  });
});

describe('leitor de provas — figuras', () => {
  /** Índice da figura citada num trecho de markdown (`figura:N`). */
  const refs = (md) => [...String(md).matchAll(/\]\(figura:(\d+)\)/g)].map((m) => Number(m[1]));
  /** A questão de uma página só (mais a página seguinte, vazia, como nas provas). */
  const ler = (col, extra = {}) => readLayout({ pages: [pagina(2, [col], extra), pagina(3, [coluna(31, 278)])] }).questions[0];

  it('gráfico vetorial: os rótulos (eixos, título girado) vão para a figura e saem do enunciado', () => {
    const c = coluna(31, 278);
    c.marca(10);
    c.linha('O gráfico mostra a produção anual de soja de uma cooperativa.');
    const top = c.y + 8;
    const paths = [
      { x: 70, y: top, w: 0, h: 100, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      { x: 70, y: top + 100, w: 180, h: 0, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      { x: 90, y: top + 40, w: 20, h: 60, paint: 'fill', rect: 1, fc: '#333333' },
      { x: 140, y: top + 20, w: 20, h: 80, paint: 'fill', rect: 1, fc: '#333333' },
      { x: 190, y: top + 60, w: 20, h: 40, paint: 'fill', rect: 1, fc: '#333333' },
    ];
    c.items.push(
      item('100', 54, top + 4, { fs: 8 }), item('50', 58, top + 54, { fs: 8 }), item('0', 62, top + 103, { fs: 8 }),
      item('2020', 90, top + 112, { fs: 8 }), item('2021', 140, top + 112, { fs: 8 }), item('2022', 190, top + 112, { fs: 8 }),
      { x: 44, y: top + 20, w: 8, h: 60, base: top + 80, fs: 8, font: 'ArialMT', str: 'Toneladas', rot: true },
    );
    c.espaco(130);
    c.linha('Disponível em: www.exemplo.gov.br. Acesso em: 1 jan. 2024.', { fs: 6, recuo: 70 });
    c.linha('Em que ano a produção da cooperativa foi maior?');
    c.espaco(4);
    c.alternativas(['2020.', '2021.', '2022.', '2023.', '2024.']);
    const q = ler(c, { paths });
    assert.equal(q.statement_md, [
      'O gráfico mostra a produção anual de soja de uma cooperativa.',
      '![Figura](figura:0)',
      'Disponível em: www.exemplo.gov.br. Acesso em: 1 jan. 2024.',
      'Em que ano a produção da cooperativa foi maior?',
    ].join('\n\n'));
    assert.equal(q.figures.length, 1);
    const f = q.figures[0];
    assert.equal(f.kind, 'vetor');
    // o desenho cresceu até os rótulos: número do eixo, ano embaixo, título girado
    assert.ok(f.bbox.x <= 44.5 && f.bbox.y + f.bbox.h >= top + 112, JSON.stringify(f.bbox));
    assert.match(f.text, /2021/);
    assert.deepEqual(q.alternatives.map((a) => a.text_md), ['2020.', '2021.', '2022.', '2023.', '2024.']);
    assert.deepEqual(q.alerts, []);
  });

  it('tabela de fios: recortada como imagem, sem o texto das células no enunciado', () => {
    const c = coluna(31, 278);
    c.marca(11);
    c.linha('O quadro apresenta a massa de sal adicionada em cada frasco.');
    const top = c.y + 6;
    const fio = (y) => ({ x: 50, y, w: 200, h: 0, paint: 'stroke', line: 1, lw: 0.6, sc: '#000000' });
    const paths = [fio(top), fio(top + 16), fio(top + 64)];
    c.items.push(item('Frasco', 60, top + 12, { font: 'Arial-BoldMT', w: 32 }), item('Massa (g)', 170, top + 12, { font: 'Arial-BoldMT', w: 45 }));
    ['I', 'II', 'III'].forEach((n, i) => {
      c.items.push(item(n, 70, top + 28 + 12 * i, { w: 8 }), item(`0,${2 * (i + 1)}`, 180, top + 28 + 12 * i, { w: 14 }));
    });
    c.espaco(76);
    c.linha('Qual frasco recebeu a maior massa de sal?');
    c.espaco(4);
    c.alternativas(['I', 'II', 'III', 'IV', 'V']);
    const q = ler(c, { paths });
    assert.equal(q.statement_md, 'O quadro apresenta a massa de sal adicionada em cada frasco.\n\n![Figura](figura:0)\n\nQual frasco recebeu a maior massa de sal?');
    assert.equal(q.figures.length, 1);
    assert.equal(q.figures[0].kind, 'tabela');
    assert.match(q.figures[0].text, /Frasco Massa \(g\) I 0,2/);
  });

  it('moldura em volta de texto corrido não é figura: o texto do quadro continua texto', () => {
    const c = coluna(31, 278);
    c.marca(12);
    c.linha('Leia o trecho do regulamento afixado na entrada do parque:');
    const top = c.y + 2;
    c.espaco(8);
    c.linha('É proibido entrar com animais domésticos, bicicletas e', { cheia: true, recuo: 12 });
    c.linha('aparelhos de som, assim como alimentar os animais do', { cheia: true, recuo: 12 });
    c.linha('parque em qualquer horário de funcionamento.', { recuo: 12 });
    const paths = [{ x: 38, y: top, w: 236, h: c.y - top + 4, paint: 'stroke', rect: 1, lw: 0.8, sc: '#000000' }];
    c.espaco(10);
    c.linha('O regulamento tem a finalidade de');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.equal(q.figures.length, 0);
    assert.match(q.statement_md, /É proibido entrar com animais domésticos/);
  });

  it('ornamentos não viram figura: enfeite do QUESTÃO, fio de fim de coluna, separador, caixinha da letra', () => {
    const c = coluna(31, 278);
    questao(c, 13);
    c.paths.push({ x: 31, y: c.y + 4, w: 247, h: 0, paint: 'stroke', line: 1, lw: 1, sc: '#2c2e35' });
    const d = coluna(289, 536);
    d.marca(14);
    d.linha('Alternativas no formato da FGV, com a caixinha desenhada em volta de cada letra.');
    d.espaco(4);
    const y0 = d.y;
    d.alternativasVunesp(['um.', 'dois.', 'três.', 'quatro.', 'cinco.']);
    for (let i = 0; i < 5; i += 1) d.paths.push({ x: 287, y: y0 + 20 * i, w: 14, h: 11, paint: 'stroke', rect: 1, lw: 0.5, sc: '#000000' });
    const sep = { x: 283.5, y: 70, w: 0, h: 660, paint: 'stroke', line: 1, lw: 1, sc: '#2c2e35' };
    const r = readLayout({ pages: [pagina(2, [c, d], { paths: [sep] }), pagina(3, [coluna(31, 278)])] });
    assert.deepEqual(r.questions.map((q) => q.number), [13, 14]);
    for (const q of r.questions) {
      assert.deepEqual(q.figures, [], `questão ${q.number}`);
      assert.doesNotMatch(textoDe(q), /figura:/);
    }
    assert.deepEqual(r.questions[1].alternatives.map((a) => a.text_md), ['um.', 'dois.', 'três.', 'quatro.', 'cinco.']);
  });

  it('desenhos vizinhos separados só por legenda viram uma figura, com as legendas', () => {
    // questão de largura inteira (linhas atravessam o meio da página)
    const c = coluna(31, 536);
    c.marca(15);
    c.linha('À medida que as estruturas desses compostos eram elucidadas, viu-se que eram aromáticos.', { cheia: true });
    c.linha('Os compostos a seguir são encontrados em óleos vegetais.');
    const top = c.y + 8;
    const molecula = (x, y) => ({ x, y, w: 60, h: 50, paint: 'stroke', line: 6, lw: 0.7, sc: '#000000' });
    const paths = [molecula(130, top), molecula(270, top), molecula(130, top + 85), molecula(270, top + 85)];
    for (const [dy, a, b] of [[62, 'Benzaldeído', 'Anetol'], [73, '(no óleo de amêndoas)', '(no óleo de anis)'],
      [147, 'Vanilina', 'Eugenol'], [158, '(no óleo de baunilha)', '(no óleo de cravos)']]) {
      c.items.push(item(a, 125, top + dy, { fs: 9 }), item(b, 265, top + dy, { fs: 9 }));
    }
    c.espaco(170);
    c.linha('A característica estrutural comum a esses compostos é a presença de');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.equal(q.figures.length, 1);
    assert.equal(q.statement_md, 'À medida que as estruturas desses compostos eram elucidadas, viu-se que eram aromáticos. Os compostos a seguir são encontrados em óleos vegetais.\n\n![Figura](figura:0)\n\nA característica estrutural comum a esses compostos é a presença de');
    assert.match(q.figures[0].text, /Benzaldeído.*Anetol.*\(no óleo de cravos\)/);
  });

  it('alternativas que são desenhos empilhados: uma figura por letra, nunca juntas', () => {
    const c = coluna(31, 278);
    c.marca(16);
    c.linha('A planificação do cubo, conforme o tipo apresentado, é');
    c.espaco(10);
    const paths = [];
    ['A', 'B', 'C', 'D', 'E'].forEach((l, i) => {
      const cy = c.y + 30 + 62 * i;
      c.items.push(item(l, 31, cy + 3.5, { font: 'BundesbahnPiStd-1', w: 9.8 }));
      paths.push({ x: 50, y: cy - 28, w: 80, h: 56, paint: 'stroke', line: 12, lw: 0.6, sc: '#000000' });
    });
    const q = ler(c, { paths });
    assert.deepEqual(q.alternatives.map((a) => a.letter), ['A', 'B', 'C', 'D', 'E']);
    q.alternatives.forEach((a) => {
      assert.match(a.text_md, /^!\[Alternativa [A-E]\]\(figura:\d+\)$/);
      const f = q.figures[refs(a.text_md)[0]];
      assert.equal(f.slot, a.letter);
      assert.ok(f.bbox.h < 60, `alternativa ${a.letter} juntou desenhos: ${JSON.stringify(f.bbox)}`);
    });
  });

  it('o recorte tem folga, mas não avança sobre o texto vizinho', () => {
    const c = coluna(31, 278);
    c.marca(17);
    c.linha('Observe a fotografia tirada durante a expedição.');
    const base = c.y - 12 + 9.8; // linha de base da linha de cima
    const images = [{ x: 60, y: base + 3, w: 180, h: 100, kind: 'image' }];
    c.espaco(108);
    c.linha('A fotografia retrata um ambiente de');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { images });
    const { crop, bbox } = q.figures[0];
    // dos lados, folga de 4 pt; em cima, para antes da perna das letras da linha de cima
    assert.equal(crop.x, 56);
    assert.equal(crop.w, 188);
    assert.ok(crop.y >= base + 0.22 * 9.8 && crop.y <= bbox.y, JSON.stringify({ crop, base }));
    assert.deepEqual(q.alerts, []);
  });

  it('figura que atravessa para a outra coluna fica com alerta figura_incerta', () => {
    const c = coluna(31, 278);
    c.marca(18);
    c.linha('Observe o mapa da região estudada pelos pesquisadores.');
    const images = [{ x: 40, y: c.y + 4, w: 270, h: 120, kind: 'image' }];
    c.espaco(130);
    c.linha('O mapa mostra que a região');
    c.espaco(4);
    c.alternativas(ALTS);
    const d = coluna(320, 536, 300);
    d.linha('Texto de outra questão na coluna da direita, bem mais abaixo.', { cheia: true });
    const r = readLayout({ pages: [pagina(2, [c, d], { images }), pagina(3, [coluna(31, 278)])] });
    const q = r.questions[0];
    assert.deepEqual(q.figures[0].uncertain, ['atravessa_coluna']);
    assert.ok(q.alerts.includes('figura_incerta'));
  });

  it('fração simples vira texto; fórmula montada que não vira texto vira recorte da alternativa', () => {
    const c = coluna(31, 278);
    c.marca(19);
    c.linha('A probabilidade de o time vencer as duas partidas é igual a');
    c.espaco(6);
    const paths = [];
    const fracao = (letra, num, den, simbolo = false) => {
      const base = c.y + 14;
      c.items.push(item(letra, 31, base, { font: 'BundesbahnPiStd-1', w: 9.8 }));
      c.items.push(item(num, 50, base - 7, { w: 10 }));
      c.items.push(item(den, 50, base + 7, { w: 10 }));
      if (simbolo) c.items.push(item('\u0019', 62, base - 7, { font: 'SymbolMT', w: 4 }));
      paths.push({ x: 48, y: base - 3.5, w: 16, h: 0, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' });
      c.y += 30;
    };
    fracao('A', '1', '4');
    fracao('B', '1', '2', true);
    fracao('C', '3', '4');
    fracao('D', '1', '8');
    fracao('E', '5', '8');
    const q = ler(c, { paths });
    assert.equal(q.alternatives[0].text_md, '1/4');
    assert.equal(q.alternatives[2].text_md, '3/4');
    assert.match(q.alternatives[1].text_md, /^!\[Alternativa B\]\(figura:0\)$/);
    assert.equal(q.figures[0].kind, 'formula');
    assert.equal(q.figures[0].slot, 'B');
    // o recorte começa depois da letra e pega numerador e denominador
    assert.ok(q.figures[0].crop.x >= 41 && q.figures[0].crop.y <= c.y - 30 * 4 + 14 - 7 - 7, JSON.stringify(q.figures[0].crop));
    assert.ok(!q.alerts.includes('figura_incerta'));
  });

  it('seta desenhada numa equação química vira "→" no texto', () => {
    const c = coluna(31, 278);
    c.marca(20);
    c.linha('A reação de combustão completa do metano é representada por:');
    const base = c.y + 9.8;
    c.items.push(item('CH₄ + 2 O₂', 70, base, { w: 52 }), item('CO₂ + 2 H₂O', 150, base, { w: 58 }));
    const paths = [
      { x: 126, y: base - 3.5, w: 18, h: 0, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      { x: 140, y: base - 6, w: 5, h: 5, paint: 'fill', line: 2, fc: '#000000' },
    ];
    c.y += 16;
    c.linha('Nessa reação, o metano atua como');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.match(q.statement_md, /\nCH₄ \+ 2 O₂ → CO₂ \+ 2 H₂O\n/);
    assert.deepEqual(q.figures, []);
  });

  it('fórmula desenhada em curvas no meio de uma frase: só a fórmula vira recorte, no meio da frase', () => {
    const c = coluna(31, 278);
    c.marca(21);
    c.linha('Considere o número complexo dado a seguir na forma trigonométrica.', { cheia: true });
    const base = c.y + 9.8;
    c.items.push(item('Dado o número Z =', 31, base, { w: 80 }), item(', o seu afixo pertence ao', 160, base, { w: 116 }));
    const paths = [];
    for (let k = 0; k < 6; k += 1) paths.push({ x: 115 + 7 * k, y: base - 12, w: 5, h: 15, paint: 'fill', curve: 9, line: 2, fc: '#000000' });
    c.y += 20;
    c.linha('segundo quadrante do plano de Argand-Gauss, porque');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    const n = refs(q.statement_md);
    assert.equal(n.length, 1);
    // a frase continua inteira, em texto, com a imagem só da fórmula no lugar dela
    assert.match(q.statement_md, /Dado o número Z !\[Fórmula\]\(figura:0\), o seu afixo pertence ao segundo quadrante/);
    assert.equal(q.figures[0].kind, 'formula');
    assert.ok(q.figures[0].crop.x > 105 && q.figures[0].crop.x + q.figures[0].crop.w < 160, JSON.stringify(q.figures[0].crop));
    assert.ok(!q.alerts.includes('figura_incerta'));
  });
});

describe('leitor de provas — correções da avaliação nas provas reais', () => {
  const layoutMod = require('../server/services/exam-reader/layout');
  const structure = require('../server/services/exam-reader/structure');
  const markup = require('../server/services/exam-reader/markup');
  const decode = require('../server/services/exam-reader/decode');
  const md = (rich) => markup.toMarkdown(rich);
  const ler = (col, extra = {}) => readLayout({ pages: [pagina(2, [col], extra), pagina(3, [coluna(31, 278)])] }).questions[0];
  const it2 = (str, x, w, o = {}) => ({ str, x, w, x1: x + w, base: 100, fs: 10, y: 90, h: 10, cy: 95, ...o });

  it('orientação: base horizontal com "para cima" inclinado é itálico; de cabeça para baixo e girado não são texto corrido', () => {
    assert.deepEqual(layoutMod.orientation([9.65, 0, 1.87, -11.11, 0, 0]), { rotated: false, inverted: false, sheared: true });
    assert.deepEqual(layoutMod.orientation([10, 0, 0, -10, 0, 0]), { rotated: false, inverted: false, sheared: false });
    assert.deepEqual(layoutMod.orientation([-9, 0, 0, 9, 0, 0]), { rotated: false, inverted: true, sheared: false });
    assert.equal(layoutMod.orientation([0, -10, -10, 0, 0, 0]).rotated, true);
  });

  it('alinhamento com os glifos: espaço que o pdf.js inventa na palavra sai; o glifo que ele perde volta', () => {
    const g = (u, gap, run, extra = {}) => ({ u, c: u.charCodeAt(0), gap, run, sp: u === ' ', font: 'f1', ...extra });
    // linha justificada com espaçamento entre letras: "mast r o" é "mastro"
    const texts = [{ str: 'O', fontId: 'f1' }, { str: 'mast r o', fontId: 'f1' }, { str: 'de', fontId: 'f1' }];
    const glyphs = [g('O', null, 1), g(' ', 0.1, 1), ...'mastro'.split('').map((c, i) => g(c, i ? 0.106 : 0.1, 1)), g(' ', 0.1, 1), g('d', 0.1, 1), g('e', 0.1, 1)];
    layoutMod.alignGlyphs(texts, glyphs);
    assert.equal(texts[1].str, 'mastro');
    // espaço de verdade (folga grande, sem glifo) fica
    const t2 = [{ str: 'a b', fontId: 'f1' }];
    layoutMod.alignGlyphs(t2, [g('a', null, 2), g('b', 0.3, 2)]);
    assert.equal(t2[0].str, 'a b');
    // fonte sem tabela: o código 173 ("Ã" na fonte embaralhada) que o texto perdeu
    const t3 = [{ str: 'MAGALHES', fontId: 'f2' }];
    const gl = [...'MAGALH'].map((c, k) => ({ u: c, c: c.charCodeAt(0) - 29, gap: k ? 0 : null, run: 3, font: 'f2' }));
    gl.push({ u: '\u00ad', c: 173, gap: 0, run: 3, font: 'f2' }, ...[...'ES'].map((c) => ({ u: c, c: c.charCodeAt(0) - 29, gap: 0, run: 3, font: 'f2' })));
    layoutMod.alignGlyphs(t3, gl, () => true);
    assert.deepEqual(t3[0].ins, [{ at: 6, codes: [173] }]);
    assert.deepEqual(decode.codesOf(t3[0]).slice(5, 8), [72 - 29, 173, 69 - 29]);
  });

  it('fonte Symbol: letra ASCII é a grega; MT Extra: "l" é ℓ e a seta é acento', () => {
    assert.equal(structure.cleanSymbolText('a', 'SymbolMT', { asciiSymbol: true }).str, 'α');
    assert.equal(structure.cleanSymbolText('p', 'SymbolMT', { asciiSymbol: true }).str, 'π');
    assert.equal(structure.cleanSymbolText('a', 'SymbolMT', { asciiSymbol: false }).str, 'a');
    assert.equal(structure.cleanSymbolText('l', 'MT-Extra').str, 'ℓ');
    const seta = structure.cleanSymbolText('', 'MT-Extra');
    assert.equal(seta.str, '⃗');
    assert.equal(seta.accent, true);
  });

  it('juntar a linha: sinal no meio de um item vai no lugar; espaço de itálico some; índice de letra vira marca', () => {
    assert.equal(structure.joinItems([it2('mL kg', 0, 30), it2('⋅', 15, 2.5)]), 'mL⋅kg');
    assert.equal(structure.joinItems([it2('7 1', 0, 12.5), it2(',', 4.7, 2.6)]), '7,1');
    assert.equal(structure.joinItems([it2('AQ', 0, 14), it2(' ', 14, 0.2), it2('B', 13.8, 7)]), 'AQB');
    const L = structure.finishLine({ items: [it2('L', 0, 6), it2('E', 6, 4, { fs: 6, base: 102, y: 96, h: 6 }), it2('=', 12, 5), it2('3', 19, 5), it2('x', 24, 3, { fs: 6, base: 96, y: 90, h: 6 })] });
    assert.equal(md(L.rich), 'L_{E} = 3^{x}');
    // índice em pedaços, parte em caractere: uma marca só
    const M = structure.finishLine({ items: [it2('m', 0, 8), it2('i', 8, 3, { fs: 6, base: 102, y: 96, h: 6 }), it2('3', 11, 3, { fs: 6, base: 102, y: 96, h: 6 })] });
    assert.equal(md(M.rich), 'm_{i3}');
  });

  it('negrito, itálico e sublinhado dentro da linha viram markdown (variável em itálico não)', () => {
    const L = structure.finishLine({ items: [it2('troca', 0, 25), it2('indevida', 28, 38, { bold: true, italic: true, underline: 1 }), it2('entre', 69, 24), it2('Q', 96, 6, { italic: true })] });
    assert.equal(md(L.rich), 'troca ***++indevida++*** entre Q');
    // dois traços, dois sublinhados
    const U = structure.finishLine({ items: [it2('que', 0, 15), it2('eles', 18, 18, { underline: 1 }), it2('lhe', 39, 14, { underline: 2 }), it2('dão', 56, 15)] });
    assert.equal(md(U.rich), 'que ++eles++ ++lhe++ dão');
    assert.equal(markup.toMarkdown(markup.tidyMarks(`${markup.M.U0}“Moreover,${markup.M.U1}`)), '“++Moreover++,');
  });

  it('sublinhado, lacuna e acento desenhados viram texto', () => {
    // sublinhado: traço logo abaixo da palavra (só ela, no meio do item)
    const items = [{ ...it2('Assinale o termo sublinhado aqui', 0, 150) }];
    const paths = [{ x: 79, y: 101.5, w: 49, h: 0.6, paint: 'fill', fc: '#000000' }];
    structure.markUnderlines(items, paths);
    assert.equal(md(structure.joinItems(items, { rich: true })), 'Assinale o termo ++sublinhado++ aqui');
    // o traço curto da seta de vetor da linha de baixo não sublinha a palavra de cima
    const fim = [it2('fim', 0, 13)];
    structure.markUnderlines(fim, [{ x: 7, y: 102, w: 3.7, h: 0, paint: 'stroke', lw: 0.24, sc: '#000000' }]);
    assert.equal(fim[0].underline, undefined);
    // lacuna: traço na linha de base entre duas palavras
    const lac = [it2('possui', 0, 30), it2('e', 70, 5)];
    structure.markBlanks(lac, [{ x: 33, y: 100.2, w: 34, h: 0, paint: 'stroke', lw: 0.5, sc: '#000000' }]);
    assert.equal(structure.joinItems(lac.sort((a, b) => a.x - b.x)), 'possui _______ e');
    // ligação de fórmula estrutural ("S—C"): no meio da altura das letras, não é lacuna
    const lig = [it2('S', 0, 6), it2('C', 20, 7)];
    structure.markBlanks(lig, [{ x: 7, y: 96.5, w: 12, h: 0, paint: 'stroke', lw: 0.5, sc: '#000000' }]);
    assert.equal(lig.length, 2);
    // chapéu do ângulo em cima do Q
    const ang = [it2('AQ', 0, 15, { fs: 10.6, base: 100 })];
    structure.markAccents(ang, [{ x: 8, y: 88, w: 8, h: 2.2, paint: 'fill', curve: 10, line: 0, fc: '#000000' }]);
    assert.equal(ang[0].str, 'AQ̂');
    // seta de vetor do MT Extra (item que é só o acento) em cima do F
    const vet = [it2('força', 0, 25), it2('F', 28, 7, { fs: 12 }), { ...it2('⃗', 29, 5, { fs: 12, base: 89 }), accent: true }];
    structure.markAccents(vet, []);
    assert.equal(vet.find((t) => t.x === 28).str, 'F⃗');
    assert.equal(vet.length, 2);
  });

  it('seta de reação num caminho só (fio e ponta juntos) vira "→"', () => {
    const items = [it2('zCl₂ (g)', 0, 40), it2('wClO (g)', 62, 40)];
    const used = structure.markArrows(items, [{ x: 43, y: 95, w: 17, h: 4.9, paint: 'stroke', line: 3, curve: 0, lw: 0.5, sc: '#000000' }]);
    assert.equal(used.size, 1);
    assert.equal(structure.joinItems(items.sort((a, b) => a.x - b.x)), 'zCl₂ (g) → wClO (g)');
  });

  it('fração seguida de letra com índice: a fração fica na linha da letra, não na do índice', () => {
    const items = [
      it2('16', 312, 11, { base: 155.3, y: 145.5, cy: 150.4 }),
      it2('27', 312.6, 11, { base: 169.2, y: 159.5, cy: 164.3 }),
      it2('L', 325.3, 5.4, { base: 161.5, y: 151.8, cy: 156.7, italic: true }),
      it2('0', 331.6, 3.1, { fs: 5.6, base: 164, y: 158.4, h: 5.6, cy: 161.2 }),
    ];
    structure.markFractions(items, [{ x: 312.1, y: 159.1, w: 11.7, h: 0, paint: 'stroke', line: 1, lw: 0.47 }]);
    const frac = items.find((t) => t.fraction);
    assert.equal(frac.str, '16/27');
    assert.equal(frac.base, 161.5);
    const L = structure.finishLine({ items });
    assert.equal(L.text, '16/27 L₀');
  });

  it('parágrafos: recuo igual ao da linha de cima abre parágrafo; item "II." e "( )" nunca continuam a linha de cima', () => {
    const c = coluna(31, 278);
    c.marca(30);
    c.linha('Leia o trecho para responder à questão.');
    c.espaco(4);
    c.linha('Conheci outrora uma família que morava em São Clemente.', { cheia: true, recuo: 17 });
    c.linha('Havia em sua casa agradáveis reuniões de que fazia os', { cheia: true, recuo: 17 });
    c.linha('encantos uma filha, bonita moça de dezoito anos.');
    c.linha('Avalie as afirmativas:');
    c.linha('I. Está relacionado à condição geral do ambiente, no que diz', { cheia: true });
    c.linha('respeito à saúde dos seres vivos que o habitam.', { cheia: true, recuo: 14 });
    c.linha('II. Engloba uma série de fatores, como pureza do ar e da', { cheia: true });
    c.linha('água e a utilização dos recursos naturais.', { recuo: 14 });
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c);
    assert.match(q.statement_md, /São Clemente\.\n\nHavia em sua casa agradáveis reuniões de que fazia os encantos uma filha/);
    assert.match(q.statement_md, /que o habitam\.\nII\. Engloba uma série de fatores, como pureza do ar e da água e a utilização/);
  });

  it('parágrafos: espaço a mais que a entrelinha é parágrafo novo; poema mantém o verso e a estrofe', () => {
    const c = coluna(31, 278);
    c.marca(31);
    for (let i = 0; i < 4; i += 1) c.linha(`Linha de prosa número ${i + 1} que vai até a margem direita`, { cheia: true, dy: 11 });
    c.linha('e termina aqui.', { dy: 16 });
    c.linha('O comando da questão vem depois do espaço maior.', { dy: 14 });
    c.espaco(4);
    for (const v of ['Y todo esto pasó con nosotros.', 'Nosotros lo vimos,', 'nosotros lo admiramos.', 'Con esta lamentosa suerte']) c.linha(v, { dy: 11.5, recuo: 20 });
    c.espaco(3);
    for (const v of ['Gusanos pululan por calles,', 'y en las paredes', 'están salpicados los sesos.']) c.linha(v, { dy: 11.5, recuo: 20 });
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c);
    assert.match(q.statement_md, /e termina aqui\.\n\nO comando da questão/);
    assert.match(q.statement_md, /Nosotros lo vimos,\nnosotros lo admiramos\.\nCon esta lamentosa suerte\n\nGusanos pululan por calles,\ny en las paredes/);
  });

  it('título em duas linhas é um título só', () => {
    const c = coluna(31, 278);
    c.marca(32);
    c.linha('Brasil sobe cinco posições no ranking do IDH e', { font: 'Arial-BoldMT' });
    c.linha('está na 84ª colocação', { font: 'Arial-BoldMT' });
    c.espaco(4);
    c.linha('O Programa das Nações Unidas divulgou a edição deste ano do relatório anual.');
    c.espaco(4);
    c.alternativas(ALTS);
    assert.match(ler(c).statement_md, /^\*\*Brasil sobe cinco posições no ranking do IDH e está na 84ª colocação\*\*\n\n/);
  });

  it('texto desenhado em contorno (palavras em fileira) vira figura, e não sobra desenho solto', () => {
    const c = coluna(31, 536);
    c.marca(33);
    c.linha('Um atleta iniciou seu treinamento visando às competições de fim de ano. O treinamento consiste em', { cheia: true });
    c.linha('cinco tipos de treino, e ele deve seguir a sequência indicada abaixo, sem pular nenhum dia previsto no plano.', { cheia: true });
    const top = c.y + 6;
    const paths = [];
    // duas fileiras de "palavras" desenhadas: cada uma, 2 ou 3 letras em curvas
    for (let k = 0; k < 8; k += 1) {
      for (const [dy] of [[0], [16]]) {
        paths.push({ x: 60 + 50 * k, y: top + dy, w: 4.5, h: 8, paint: 'fill', curve: 12, line: 2, fc: '#000000' });
        paths.push({ x: 66 + 50 * k, y: top + dy, w: 4.5, h: 8, paint: 'fill', curve: 8, line: 4, fc: '#000000' });
      }
    }
    c.espaco(36);
    c.linha('Qual é o treino do décimo dia?');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.equal(q.figures.length, 1);
    assert.ok(q.figures[0].bbox.w > 340, JSON.stringify(q.figures[0].bbox));
    assert.match(q.statement_md, /plano\.\n\n!\[Figura\]\(figura:0\)\n\nQual é o treino/);
    assert.deepEqual(q.alerts, []);
  });

  it('o fio da coluna não entra no recorte; a linha tracejada comprida do gráfico continua sendo do gráfico', () => {
    const c = coluna(31, 278);
    const d = coluna(289, 536);
    questao(c, 34);
    d.marca(35);
    d.linha('Taxa de fecundidade', { font: 'Arial-BoldMT' });
    const top = d.y + 8;
    const paths = [
      // fio separador das colunas
      { x: 284.96, y: 68, w: 0, h: 660, paint: 'stroke', line: 1, lw: 0.7, sc: '#000000' },
      // seta de cota em cima e a linha tracejada comprida que desce dela
      { x: 316, y: top, w: 140, h: 0, paint: 'stroke', line: 1, lw: 1, sc: '#000000' },
      { x: 316, y: top, w: 0, h: 240, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      // as barras do gráfico, mais abaixo
      { x: 288, y: top + 20, w: 240, h: 200, paint: 'fill', rect: 1, fc: '#22a6a0' },
    ];
    d.espaco(250);
    d.linha('Qual fator explica a queda do indicador?');
    d.espaco(4);
    d.alternativas(ALTS);
    const r = readLayout({ pages: [pagina(2, [c, d], { paths }), pagina(3, [coluna(31, 278)])] });
    const f = r.questions[1].figures[0];
    assert.ok(f.crop.y <= top + 0.5, `a seta de cota ficou de fora: ${JSON.stringify(f.crop)}`);
    assert.ok(f.crop.x > 285.5, `o fio da coluna entrou no recorte: ${JSON.stringify(f.crop)}`);
  });

  it('legenda em duas linhas e título de eixo girado um pouco longe ficam no recorte', () => {
    const c = coluna(31, 278);
    c.marca(36);
    c.linha('Observe os monômeros representados no esquema.');
    const top = c.y + 8;
    const paths = [{ x: 80, y: top, w: 150, h: 60, paint: 'stroke', line: 8, lw: 0.6, sc: '#000000' }];
    c.items.push(item('Cloreto de vinila', 110, top + 72, { fs: 9 }), item('(cloropropeno)', 114, top + 83, { fs: 9 }));
    c.items.push({ x: 56, y: top + 5, w: 9, h: 50, base: top + 55, fs: 9, font: 'ArialMT', str: 'Concentração', rot: true });
    c.espaco(100);
    c.linha('O monômero que contém cloro é o');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.doesNotMatch(q.statement_md, /cloropropeno|Concentração/);
    assert.match(q.figures[0].text, /Cloreto de vinila \(cloropropeno\)/);
    assert.ok(q.figures[0].bbox.x <= 56, JSON.stringify(q.figures[0].bbox));
  });

  it('alertas: comando que cita o sublinhado sem a marca, palavra picotada', () => {
    const c = coluna(31, 278);
    c.marca(37);
    c.linha('No trecho “a mesma ideia”, a palavra sublinhada exerce a função de');
    c.espaco(4);
    c.alternativas(ALTS);
    assert.ok(ler(c).alerts.includes('texto_incerto'));
    const d = coluna(31, 278);
    d.marca(38);
    d.linha('O mast r o de uma ban de ir a fo i instalado ao solo de uma região plana.');
    d.espaco(4);
    d.alternativas(ALTS);
    assert.ok(ler(d).alerts.includes('texto_incerto'));
  });
});

describe('leitor de provas — PDF de verdade (mínimo, montado aqui)', () => {
  const { readExam } = require('../server/services/exam-reader');

  /**
   * Monta um PDF de uma página com fontes padrão (Helvetica), em latin1.
   * `desenho`: operadores de desenho soltos (ex.: um retângulo preenchido).
   */
  function pdfMinimo(linhas, desenho = '') {
    const conteudo = [desenho, ...linhas.map(([fonte, x, y, texto]) => `BT /${fonte} 10 Tf ${x} ${y} Td (${texto.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`)].filter(Boolean).join('\n');
    const objetos = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
      `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objetos.forEach((o, i) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  it('lê posição e texto do PDF e monta a questão', async () => {
    const pdf = pdfMinimo([
      ['F2', 40, 780, 'QUESTÃO 01'],
      ['F1', 40, 760, 'Qual é a capital do Brasil, sede dos três Poderes da República?'],
      ['F2', 40, 740, 'A'], ['F1', 57, 740, 'São Paulo.'],
      ['F2', 40, 725, 'B'], ['F1', 57, 725, 'Rio de Janeiro.'],
      ['F2', 40, 710, 'C'], ['F1', 57, 710, 'Brasília.'],
      ['F2', 40, 695, 'D'], ['F1', 57, 695, 'Salvador.'],
      ['F2', 40, 680, 'E'], ['F1', 57, 680, 'Belo Horizonte.'],
    ]);
    const r = await readExam(pdf);
    assert.equal(r.pages, 1);
    assert.equal(r.kind, 'enem');
    assert.equal(r.questions.length, 1);
    const q = r.questions[0];
    assert.equal(q.number, 1);
    assert.equal(q.statement_md, 'Qual é a capital do Brasil, sede dos três Poderes da República?');
    assert.deepEqual(q.alternatives.map((a) => `${a.letter}) ${a.text_md}`), ['A) São Paulo.', 'B) Rio de Janeiro.', 'C) Brasília.', 'D) Salvador.', 'E) Belo Horizonte.']);
    assert.deepEqual(q.alerts, []);
  });

  /** Questão com uma figura desenhada (retângulo azul de 200×100 pt) entre dois parágrafos. */
  const pdfComFigura = () => pdfMinimo([
    ['F2', 40, 780, 'QUESTÃO 01'],
    ['F1', 40, 760, 'Observe a figura a seguir, que mostra um retângulo colorido.'],
    ['F1', 40, 540, 'Qual é a cor do retângulo desenhado acima?'],
    ['F2', 40, 520, 'A'], ['F1', 57, 520, 'Azul.'],
    ['F2', 40, 505, 'B'], ['F1', 57, 505, 'Verde.'],
    ['F2', 40, 490, 'C'], ['F1', 57, 490, 'Vermelho.'],
    ['F2', 40, 475, 'D'], ['F1', 57, 475, 'Amarelo.'],
    ['F2', 40, 460, 'E'], ['F1', 57, 460, 'Preto.'],
  ], '0.1 0.3 0.9 rg 60 560 200 100 re f');

  /** Largura e altura gravadas no cabeçalho do PNG. */
  const tamanhoPng = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

  it('figura: recorte renderizado em PNG (escala 2), na posição certa do enunciado', async () => {
    const r = await readExam(pdfComFigura());
    const q = r.questions[0];
    assert.equal(q.statement_md, 'Observe a figura a seguir, que mostra um retângulo colorido.\n\n![Figura](figura:0)\n\nQual é a cor do retângulo desenhado acima?');
    assert.equal(q.figures.length, 1);
    const f = q.figures[0];
    assert.deepEqual(f.bbox, { x: 60, y: 182, w: 200, h: 100 });
    assert.deepEqual({ x: f.crop.x, w: f.crop.w }, { x: 56, w: 208 });
    assert.ok(Buffer.isBuffer(f.png));
    assert.equal(f.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(tamanhoPng(f.png), { w: Math.ceil(f.crop.w * 2), h: Math.ceil(f.crop.h * 2) });
    // o recorte é o desenho de verdade: azul no meio, branco na folga
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(f.png);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const [r1, g1, b1] = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    assert.ok(b1 > 200 && r1 < 60 && g1 < 110, `meio do recorte: ${r1},${g1},${b1}`);
    const [r2, g2, b2] = ctx.getImageData(2, 2, 1, 1).data;
    assert.deepEqual([r2, g2, b2], [255, 255, 255]);
    assert.deepEqual(q.alerts, []);
  });

  it('figuras: false pula o render (só a posição)', async () => {
    const r = await readExam(pdfComFigura(), { figures: false });
    assert.equal(r.questions[0].figures.length, 1);
    assert.equal(r.questions[0].figures[0].png, undefined);
  });

  it('scripts/ler-prova.js grava as figuras e as referencia no questoes.md', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ler-prova-'));
    try {
      const pdf = path.join(dir, 'prova.pdf');
      fs.writeFileSync(pdf, pdfComFigura());
      const out = path.join(dir, 'saida');
      execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ler-prova.js'), pdf, '--out', out], { stdio: 'pipe' });
      const png = fs.readFileSync(path.join(out, 'figuras', 'q1-1.png'));
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      const md = fs.readFileSync(path.join(out, 'questoes.md'), 'utf8');
      assert.match(md, /\n!\[Figura\]\(figuras\/q1-1\.png\)\n/);
      const json = JSON.parse(fs.readFileSync(path.join(out, 'questoes.json'), 'utf8'));
      assert.equal(json.questions[0].figures[0].file, 'figuras/q1-1.png');
      assert.equal(json.questions[0].figures[0].png, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arquivo que não é PDF: erro com código, sem derrubar nada', async () => {
    await assert.rejects(readExam(Buffer.from('isto não é um PDF')), (err) => err.code === 'pdf_invalido');
  });
});

describe('leitor de provas — correções da rodada 2 (fórmulas, pontuação, tabela de consulta)', () => {
  const refs = (md) => [...String(md).matchAll(/\]\(figura:(\d+)\)/g)].map((m) => Number(m[1]));
  const ler = (col, extra = {}) => readLayout({ pages: [pagina(2, [col], extra), pagina(3, [coluna(31, 278)])] }).questions[0];
  /** Letra (glifo) desenhada em curvas, do tamanho de um algarismo. */
  const glifo = (x, base, w = 4.6) => ({ x, y: base - 6.9, w, h: 6.9, paint: 'fill', curve: 12, line: 2, fc: '#000000' });

  it('fórmula no fim do trecho: o último desenho entra no recorte ("4√10" não vira "4√1")', () => {
    const c = coluna(31, 278);
    c.marca(54);
    c.linha('A base de uma pirâmide regular é um quadrado de área 16 cm².', { cheia: true });
    const base = c.y + 9.8;
    c.items.push(item('Sabendo que o volume da pirâmide é', 31, base, { w: 156 }), item('cm³, o volume da outra é', 222, base, { w: 52 }));
    // "4", a raiz (o traço sobe e a barra passa por cima do "10"), "1" e "0" — o "0" e a barra são os últimos
    const paths = [
      glifo(190, base),
      { x: 196, y: base - 2.8, w: 1.2, h: 0.7, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      { x: 197.2, y: base - 3.3, w: 1.7, h: 3.3, paint: 'stroke', line: 1, lw: 0.5, sc: '#000000' },
      { x: 199, y: base - 9.5, w: 13.3, h: 10.3, paint: 'stroke', line: 2, lw: 0.5, sc: '#000000' },
      glifo(202.2, base, 2.5),
      glifo(206.8, base, 4.4),
    ];
    c.y += 16;
    c.linha('igual a', { fs: 9.8 });
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.match(q.statement_md, /pirâmide é !\[Fórmula\]\(figura:0\) cm³, o volume/);
    const { crop } = q.figures[0];
    assert.ok(crop.x <= 190 && crop.x + crop.w >= 212.3, `o recorte pega do "4" à barra da raiz: ${JSON.stringify(crop)}`);
    assert.ok(crop.x + crop.w <= 222, `e não avança sobre o "cm³": ${JSON.stringify(crop)}`);
  });

  it('raiz desenhada no vão do item ("11 2"): a alternativa vira recorte, nunca "11 2"', () => {
    const c = coluna(31, 278);
    c.marca(37);
    c.linha('Qual será a medida, em metro, de cada um dos cabos a serem instalados?');
    c.espaco(4);
    const y0 = c.y;
    c.alternativas(['22', '11 2', '12', '18', '24']);
    // o item "11 2" tem o espaço largo no lugar da raiz (como o pdf.js entrega)
    const b = c.items.find((t) => t.str === '11 2');
    b.w = 21.6;
    const base = y0 + 14.6 + 9.8;
    const paths = [{ x: b.x + 9.9, y: base - 9.8, w: 11.9, h: 10.5, paint: 'fill', line: 10, fc: '#000000' }];
    const q = ler(c, { paths });
    assert.match(q.alternatives[1].text_md, /^!\[Alternativa B\]\(figura:\d+\)$/);
    const fig = q.figures[refs(q.alternatives[1].text_md)[0]];
    assert.equal(fig.slot, 'B');
    assert.equal(fig.kind, 'formula');
    assert.ok(fig.crop.x <= b.x && fig.crop.x + fig.crop.w >= b.x + 21.6, JSON.stringify(fig.crop));
    assert.equal(q.alternatives[0].text_md, '22');
  });

  it('símbolo desenhado no meio da alternativa que não vira recorte: alerta figura_incerta', () => {
    const c = coluna(31, 278);
    c.marca(38);
    c.linha('O valor encontrado para a grandeza descrita no experimento é');
    c.espaco(4);
    const y0 = c.y;
    c.alternativas(['valor igual a vinte e cinco unidades.', 'segunda alternativa.', 'terceira alternativa.', 'quarta alternativa.', 'quinta alternativa.']);
    const base = y0 + 9.8;
    // sobe além da linha (não é a letra do item), largo demais para ser
    // símbolo da alternativa e pequeno demais para ser figura: em cima do texto
    // (na altura da linha da letra: o desenho é da alternativa, não do enunciado)
    const paths = [{ x: 90, y: base - 10.3, w: 21, h: 14, paint: 'fill', curve: 6, line: 4, fc: '#000000' }];
    const q = ler(c, { paths });
    assert.ok(q.alerts.includes('figura_incerta'), JSON.stringify(q.alerts));
  });

  it('pontuação colada na fórmula fica no texto; o espaço antes do "!" da lista também', () => {
    const c = coluna(31, 278);
    c.marca(57);
    c.linha('Foi solicitado ao usuário que criasse uma senha com os caracteres:', { cheia: true });
    const base = c.y + 9.8;
    // (como no ENEM 2023 Q157: o "*" desenhado no vão entre "$," e ", &.")
    c.items.push(item('• 6 caracteres especiais !, @, #, $,', 31, base, { w: 150 }), item(', &.', 189.5, base, { w: 14.6 }));
    const paths = [{ x: 184, y: base - 7.2, w: 5.5, h: 5.2, paint: 'fill', curve: 10, line: 5, fc: '#000000' }];
    c.y += 16;
    c.linha('Três tipos de estruturas para senha foram apresentadas ao usuário.');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.match(q.statement_md, /especiais !, @, #, \$, !\[Fórmula\]\(figura:0\), &\./);
    const { crop } = q.figures[0];
    assert.ok(crop.x + crop.w <= 189.6, `a vírgula não entra no recorte: ${JSON.stringify(crop)}`);
  });

  /** Prova da VUNESP com a seção de Química que anuncia a tabela periódica do fim do caderno. */
  function provaComTabela({ comTabela = true } = {}) {
    const borda = () => ({ texts: [], paths: [] });
    const e = coluna(34, 291, 30);
    e.numero(62);
    e.linha('Questão de física, antes da seção de química do caderno.', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['a.', 'b.', 'c.', 'd.', 'e.']);
    e.espaco(10);
    e.linha('Química', { fs: 11, font: 'Tahoma-Bold' });
    e.linha('Considere a Classificação Periódica no final deste caderno.', { fs: 9.5 });
    e.espaco(6);
    e.numero(63);
    e.linha('Com base nas posições desses elementos, o de maior densidade é', { fs: 9.5 });
    e.espaco(8);
    e.alternativasVunesp(['o ósmio.', 'o iodo.', 'o bário.', 'o chumbo.', 'o ferro.']);
    const d = coluna(305, 561, 30);
    d.numero(64);
    d.linha('A fórmula do fosfeto de magnésio é', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['MgP', 'MgP₂', 'Mg₂P', 'Mg₂P₃', 'Mg₃P₂']);
    d.espaco(10);
    d.linha('Biologia', { fs: 11, font: 'Tahoma-Bold' });
    d.numero(65);
    d.linha('A organela responsável pela respiração celular é', { fs: 9.5 });
    d.espaco(8);
    d.alternativasVunesp(['o ribossomo.', 'a mitocôndria.', 'o lisossomo.', 'o núcleo.', 'o centríolo.']);
    const pages = [{ ...pagina(21, [e, d], { borda }), width: 595, height: 842 }];
    if (comTabela) {
      // a tabela, deitada na página: grade de células e o título girado (lido de baixo para cima)
      const paths = [];
      for (let i = 0; i < 18; i += 1) for (let k = 0; k < 7; k += 1) paths.push({ x: 130 + k * 50, y: 60 + i * 40, w: 50, h: 40, paint: 'stroke', rect: 1, lw: 0.5, sc: '#000000' });
      const titulo = { str: 'CLASSIFICAÇÃO PERIÓDICA', x: 100, y: 300, w: 11, h: 160, base: 311, fs: 11, font: 'Arial-BoldMT', rot: true, angle: -90 };
      pages.push({ page: 26, width: 595, height: 842, texts: [titulo], images: [], paths });
    }
    return readLayout({ pages }, { examKind: 'vunesp' });
  }

  it('tabela periódica anunciada vai para as questões da seção, endireitada; a outra seção não recebe', () => {
    const r = provaComTabela();
    const [q62, q63, q64, q65] = r.questions;
    for (const q of [q63, q64]) {
      assert.match(q.statement_md, /\n\n!\[Classificação Periódica\]\(figura:\d+\)$/, q.statement_md);
      const f = q.figures[refs(q.statement_md).pop()];
      assert.equal(f.page, 26);
      assert.equal(f.slot, 'apoio');
      assert.equal(f.rotate, 90, 'título lido de baixo para cima: o recorte gira no sentido horário');
      assert.ok(f.crop.x <= 100 && f.crop.y <= 60 && f.crop.y + f.crop.h >= 780, JSON.stringify(f.crop));
      assert.ok(!q.alerts.includes('figura_incerta'), q.alerts.join());
    }
    for (const q of [q62, q65]) assert.equal(q.figures.length, 0, `${q.number}`);
    assert.ok(!r.discarded.some((d) => /Classificação Periódica/.test(d.text)), 'o anúncio não fica no descarte');
  });

  it('tabela anunciada que não está no PDF: as questões da seção esperam a conferência', () => {
    const r = provaComTabela({ comTabela: false });
    const [, q63, q64, q65] = r.questions;
    assert.ok(q63.alerts.includes('figura_incerta') && q64.alerts.includes('figura_incerta'));
    assert.ok(!q65.alerts.includes('figura_incerta'));
  });

  it('pedaço de palavra que tinha espaço antes no PDF ganha o espaço de volta, mesmo antes de pontuação', () => {
    const { splitWords } = require('../server/services/exam-reader/structure');
    const t = { ...item('especiais !, @', 31, 100, { w: 62 }), x1: 93 };
    const pedacos = splitWords(t).map((p) => ({ ...p, x1: p.x + p.w }));
    assert.equal(joinItems(pedacos), 'especiais !, @');
    assert.equal(joinItems([{ ...item('HNO₃', 31, 100, { w: 20 }), x1: 51 }, { ...item(',', 53.5, 100, { w: 2.7 }), x1: 56.2, spaceBefore: true }]), 'HNO₃,');
  });

  it('parágrafos: o comando depois de linha cheia com espaço a mais; "(1)" e "(2)" em linhas próprias; "[...]" na margem continua', () => {
    const c = coluna(31, 278);
    c.marca(92);
    c.linha('A gravação e a leitura óptica dessas informações são realizadas', { cheia: true });
    c.linha('por um laser, possibilitando ler dados em cavidades menores.', { cheia: true, dy: 15 });
    c.linha('Em qual região espectral se situa o comprimento de onda?');
    c.espaco(4);
    c.alternativas(ALTS);
    assert.match(ler(c).statement_md, /cavidades menores\.\n\nEm qual região espectral/);

    const d = coluna(31, 278);
    d.marca(125);
    d.linha('Considere que houve o descarte indevido de dois conjuntos:', { dy: 16 });
    d.linha('(1) ácido clorídrico concentrado com cianeto de potássio;');
    d.linha('(2) ácido nítrico concentrado com sacarose.');
    d.espaco(4);
    d.alternativas(ALTS);
    assert.match(ler(d).statement_md, /potássio;\n\(2\) ácido nítrico/);

    const e = coluna(31, 278);
    e.marca(5);
    e.linha('I remember being caught speaking Spanish at recess', { cheia: true, recuo: 17 });
    e.linha('[...] I remember being sent to the corner of the classroom', { cheia: true });
    e.linha('for “talking back” to the Anglo teacher.');
    e.espaco(4);
    e.alternativas(ALTS);
    assert.match(ler(e).statement_md, /at recess \\\[\.\.\.\\\] I remember being sent/);
  });

  it('matriz alta no meio da frase: a frase continua no mesmo parágrafo, mesmo com a folga em volta dela', () => {
    const c = coluna(31, 278);
    c.marca(49);
    c.linha('Em um determinado dia, a matriz de controle de envios das lojas', { cheia: true });
    c.y += 24;
    const base = c.y + 9.8;
    c.items.push(item('de envios foi', 31, base, { w: 56 }), item('. Nos 3 dias seguintes, a loja 1', 158, base, { w: 120 }));
    // a matriz desenhada: 43 pt de altura, com folga embaixo, como as do MathType
    const paths = [];
    // (centrada na linha do texto)
    for (let k = 0; k < 9; k += 1) paths.push({ x: 95 + 18 * (k % 3), y: base - 22 + 14 * Math.floor(k / 3), w: 6, h: 8, paint: 'fill', curve: 9, line: 2, fc: '#000000' });
    paths.push({ x: 90, y: base - 24.4, w: 3, h: 43, paint: 'fill', line: 6, fc: '#000000' }, { x: 150, y: base - 24.4, w: 3, h: 43, paint: 'fill', line: 6, fc: '#000000' });
    c.y += 36;
    c.linha('enviou, a cada dia, 11 itens para cada uma das lojas 2 e 3.');
    c.espaco(4);
    c.alternativas(ALTS);
    const q = ler(c, { paths });
    assert.match(q.statement_md, /de envios foi !\[Fórmula\]\(figura:0\)\. Nos 3 dias seguintes, a loja 1 enviou, a cada dia/);
  });

  it('sublinhado de parte da palavra ("++mover++se"), do "à" sozinho, e nunca o traço do "1º"', () => {
    const structure = require('../server/services/exam-reader/structure');
    const markup = require('../server/services/exam-reader/markup');
    const t2 = (str, x, w, o = {}) => ({ str, x, w, x1: x + w, base: 100, fs: 9.5, y: 90.5, h: 9.5, cy: 95, font: 'ArialMT', ...o });
    // o item estima a posição das letras com erro de alguns pontos: o traço começa na palavra
    const a = [t2('para poder moverse por la ciudad', 0, 150)];
    const inicio = a[0].x + 52.5;
    structure.markUnderlines(a, [{ x: inicio, y: 102, w: 26.4, h: 0, paint: 'stroke', lw: 0.5, sc: '#000000' }]);
    assert.equal(markup.toMarkdown(structure.joinItems(a, { rich: true })), 'para poder ++mover++se por la ciudad');
    // aspas e vírgula em volta não fazem cortar a palavra sublinhada inteira
    const b = [t2('parágrafo “Moreover, without', 0, 130)];
    structure.markUnderlines(b, [{ x: 54.5, y: 102, w: 39.5, h: 0, paint: 'stroke', lw: 0.5, sc: '#000000' }]);
    assert.match(markup.toMarkdown(structure.joinItems(b, { rich: true })), /“\+\+Moreover\+\+, without/);
    // "à" sublinhado sozinho (traço de 4,2 pt)
    const c = [t2('até o fim', 0, 36), t2(' ', 36, 2.3), t2('à', 38.3, 4.3), t2(' ', 42.6, 2.3), t2('consequência', 44.9, 58)];
    structure.markUnderlines(c, [{ x: 38.3, y: 101.2, w: 4.2, h: 0.6, paint: 'fill', fc: '#000000' }]);
    assert.equal(markup.toMarkdown(structure.joinItems(c, { rich: true })), 'até o fim ++à++ consequência');
    // o "o" erguido colado no "1" com o traço embaixo é o ordinal "1º"
    const d = [t2('(1', 0, 8.1), t2('o', 8.1, 3.7, { fs: 5.6, base: 96, y: 90.4, h: 5.6 }), t2(' parágrafo)', 11.8, 45)];
    structure.markUnderlines(d, [{ x: 8.1, y: 97, w: 3.68, h: 0, paint: 'stroke', lw: 0.4, sc: '#000000' }]);
    assert.ok(!d.some((t) => t.underline), 'o traço do ordinal não sublinha');
  });

  it('o "espaço" de largura nula depois do índice não separa ("C₁₂H₈Cl₆"); a nota "¹ rorejar" mantém o espaço', () => {
    const i = (str, x, w, o = {}) => ({ ...item(str, x, 100, { w, ...o }), x1: x + w });
    const formula = [
      i('fórmula C', 31, 109.5), i(' ', 140.5, 0), i('12', 140.5, 6.3, { fs: 5.7, script: 'sub' }), i(' ', 146.8, 0.03),
      i('H', 147.1, 7), i(' ', 154.1, 0.07), i('8', 154.5, 3.2, { fs: 5.7, script: 'sub' }), i(' ', 157.7, 0.03), i('Cl', 158, 9.5),
    ];
    assert.equal(joinItems(formula), 'fórmula C₁₂H₈Cl');
    const nota = [i('1', 304.7, 2.9, { fs: 5.2, script: 'sup' }), i(' ', 307.6, 0.13, { fs: 5.2 }), i('rorejar: gotejar.', 308.3, 50.5, { fs: 7.5 })];
    assert.equal(joinItems(nota), '¹ rorejar: gotejar.');
  });
});

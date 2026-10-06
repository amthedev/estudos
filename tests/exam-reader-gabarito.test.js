'use strict';

/**
 * Gabarito oficial: número → letra, com inglês e espanhol separados.
 *
 *   NODE_ENV=test node --test tests/exam-reader-gabarito.test.js
 *   CORPUS_PROVAS=/pasta/com/os/pdfs NODE_ENV=test node --test tests/exam-reader-gabarito.test.js
 *
 * O gabarito do INEP traz as duas opções de idioma na mesma linha ("1 B A",
 * sob INGLÊS e ESPANHOL). O parser antigo lia a primeira letra e jogava a
 * segunda fora: a questão de espanhol entrava no banco com a resposta da de
 * inglês. Os PDFs reais ficam fora do repositório; os testes que dependem
 * deles são PULADOS quando o arquivo não existe.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const answerKeys = require('../server/services/exam-reader/answer-key');
const examImport = require('../server/services/exam-import');

const CORPUS = process.env.CORPUS_PROVAS || path.join(__dirname, '..', 'public', 'assets', 'past-exams');

/** Item de texto no formato de layout.js. */
function t(str, x, base, { w, fs = 10 } = {}) {
  return { x, y: base - fs, w: w ?? str.length * fs * 0.5, h: fs, base, fs, font: 'Arial', str };
}

describe('Gabarito em texto (colado ou extraído no navegador)', () => {
  it('folha do INEP: inglês e espanhol na mesma linha', () => {
    const texto = [
      'QUESTÃO GABARITO',
      'INGLÊS ESPANHOL',
      '1 B A',
      '2 B B',
      '3 B A',
      '4 D E',
      '5 A A',
      '6 C',
      '46 D',
    ].join('\n');
    const { key, count } = answerKeys.parseAnswerKeyText(texto);
    assert.equal(count, 12);
    assert.equal(key['1'], 'B');
    assert.equal(key['1:espanhol'], 'A');
    assert.equal(key['4:espanhol'], 'E');
    assert.equal(key['6'], 'C');
    assert.equal(key['46'], 'D');
    assert.equal(key['6:espanhol'], undefined);
  });

  it('as duas colunas da folha na mesma linha do texto ("5 B C 50 C")', () => {
    const { key } = answerKeys.parseAnswerKeyText('INGLÊS ESPANHOL\n5 B C 50 C\n6 B 51 C');
    assert.deepEqual(key, { 5: 'B', '5:espanhol': 'C', 50: 'C', 6: 'B', 51: 'C' });
  });

  it('sem a coluna de espanhol, a segunda letra não vira resposta', () => {
    const { key } = answerKeys.parseAnswerKeyText('1 B A\n2 C');
    assert.deepEqual(key, { 1: 'B', 2: 'C' });
  });

  it('questão anulada fica sem letra', () => {
    const { key } = answerKeys.parseAnswerKeyText('174 D\n175 Anulado\n176 C\n177 ANULADA');
    assert.deepEqual(key, { 174: 'D', 176: 'C' });
  });

  it('grade da VUNESP: linha de números com as letras embaixo', () => {
    const { key } = answerKeys.parseAnswerKeyText('01 02 03 04 05\nA C B D E\n06 07 08\nE E A');
    assert.deepEqual(key, { 1: 'A', 2: 'C', 3: 'B', 4: 'D', 5: 'E', 6: 'E', 7: 'E', 8: 'A' });
  });

  it('o importador usa o mesmo leitor (formatos antigos continuam valendo)', () => {
    assert.deepEqual(examImport.parseAnswerKey('1-A 2) B\n3. C\n04 D\n5 = E').key, { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' });
    assert.equal(examImport.parseAnswerKey('Linguagens e Códigos — questões 46 a 90').count, 0);
    assert.equal(examImport.parseAnswerKey('INGLÊS ESPANHOL\n1 B A').key['1:espanhol'], 'A');
  });

  it('espanhol nunca herda a letra do inglês', () => {
    const key = { 1: 'B', '1:espanhol': 'A', 2: 'C' };
    assert.equal(answerKeys.answerFor(key, 1, 'ingles'), 'B');
    assert.equal(answerKeys.answerFor(key, 1, null), 'B');
    assert.equal(answerKeys.answerFor(key, 1, 'espanhol'), 'A');
    assert.equal(answerKeys.answerFor(key, 2, 'espanhol'), null, 'sem a própria letra, fica sem gabarito');
    assert.equal(answerKeys.answerFor(key, 9, null), null);
    assert.equal(answerKeys.answerFor(null, 1, null), null);
  });
});

describe('Gabarito com posição (PDF lido no servidor)', () => {
  it('lê as colunas pela posição, junta número partido e pula anulada', () => {
    const layout = {
      pages: [
        {
          page: 1,
          width: 595,
          height: 842,
          texts: [
            t('Gabarito 2023', 440, 64),
            t('CADERNO 2', 440, 78),
            t('QUESTÃO', 88, 206), t('GABARITO', 187, 197), t('QUESTÃO', 393, 206), t('GABARITO', 459, 206),
            t('INGLÊS', 160, 215), t('ESPANHOL', 219, 215),
            t('1', 108, 230), t('B', 174, 230), t('A', 241, 230), t('46', 410, 230), t('D', 479, 230),
            t('2', 108, 243), t('B', 174, 243), t('E', 241, 243), t('47', 410, 242), t('B', 479, 242),
            t('6', 108, 291), t('C', 207, 291),
            // "124" vem em dois pedaços colados
            t('12', 124, 624, { w: 9 }), t('4', 133, 624, { w: 4.5 }), t('B', 195, 624),
            t('175', 391, 696), t('Anulado', 448, 696),
          ],
          images: [],
          paths: [],
        },
      ],
    };
    const { key } = answerKeys.parseAnswerKeyLayout(layout);
    assert.deepEqual(key, { 1: 'B', '1:espanhol': 'A', 46: 'D', 2: 'B', '2:espanhol': 'E', 47: 'B', 6: 'C', 124: 'B' });
  });

  it('grade: números numa linha, letras alinhadas na de baixo', () => {
    const layout = {
      pages: [
        {
          page: 1,
          width: 595,
          height: 842,
          texts: [
            t('01', 100, 200), t('02', 140, 200), t('03', 180, 200),
            t('C', 102, 215), t('A', 142, 215), t('E', 182, 215),
          ],
          images: [],
          paths: [],
        },
      ],
    };
    assert.deepEqual(answerKeys.parseAnswerKeyLayout(layout).key, { 1: 'C', 2: 'A', 3: 'E' });
  });
});

describe('Gabarito: só a folha de gabarito, tabela por tabela', () => {
  /** Grade de 10 em 10: linha de números e, embaixo, a de letras. */
  function grade(primeiro, letras, y0, { x0 = 60 } = {}) {
    const texts = [];
    for (let i = 0; i < letras.length; i += 10) {
      const y = y0 + (i / 10) * 30;
      letras.slice(i, i + 10).forEach((l, k) => {
        texts.push(t(String(primeiro + i + k), x0 + k * 45, y), t(l, x0 + k * 45 + 2, y + 12));
      });
    }
    return texts;
  }
  const pagina = (n, texts) => ({ page: n, width: 595, height: 842, texts, images: [], paths: [] });
  const ingles = 'EEBADDBCBDDEBBDECBDE'.split('');
  const espanhol = 'EEBADDBCBDDEBBDECEAB'.split(''); // 18, 19 e 20 diferentes
  const tipo2 = 'BAEEDDBBCDBBDEEDCEBD'.split('');

  it('folha da FGV: uma tabela por tipo e por língua — tipo 1 (ou o do caderno) e o espanhol na faixa que difere', () => {
    const layout = {
      pages: [
        pagina(1, [
          t('O Diretor de Pessoal torna público o gabarito preliminar oficial do concurso,', 40, 60, { w: 500 }),
          t('realizado em 13-7-25. A interposição de recurso deverá ser feita no site.', 40, 72, { w: 500 }),
          t('PROVA TIPO 1 – LÍNGUA INGLESA', 200, 100, { w: 180 }),
          ...grade(1, ingles, 120),
          t('PROVA TIPO 1 – LÍNGUA ESPANHOL A', 200, 200, { w: 190 }),
          ...grade(1, espanhol, 220),
        ]),
        pagina(2, [t('PROVA TIPO 2 – LÍNGUA INGLESA', 200, 100, { w: 180 }), ...grade(1, tipo2, 120)]),
      ],
    };
    const r = answerKeys.parseAnswerKeyLayout(layout);
    assert.equal(r.tipo, 1);
    for (let n = 1; n <= 20; n += 1) assert.equal(r.key[n], ingles[n - 1], `questão ${n}`);
    assert.deepEqual(Object.keys(r.key).filter((k) => k.includes(':')), ['18:espanhol', '19:espanhol', '20:espanhol']);
    assert.equal(r.key['19:espanhol'], 'A');
    assert.equal(r.sharedLanguages, false);
    assert.equal(r.count, 23);
    // caderno do tipo 2: a tabela do tipo 2
    const r2 = answerKeys.parseAnswerKeyLayout(layout, { tipo: 2 });
    for (let n = 1; n <= 20; n += 1) assert.equal(r2.key[n], tipo2[n - 1], `tipo 2, questão ${n}`);
  });

  it('frase de página de questão não vira resposta ("é 9. A mediana", "+116. A única", "(B) 20 ºC.")', () => {
    const questao = pagina(13, [
      t('A média dos valores é 9. A mediana dos valores é 8, e a moda', 40, 100, { w: 500 }),
      t('vale +116. A única alternativa correta para o problema é', 40, 112, { w: 500 }),
      t('(B) 20 ºC.', 40, 124, { w: 60 }),
      t('(D) 40 ºC.', 40, 136, { w: 60 }),
    ]);
    const folha = pagina(52, [t('1 - E 2 - E 3 - B', 60, 100, { w: 120 }), t('4 - A 5 - D 6 - D', 60, 112, { w: 120 }), t('7 - B 8 - C 9 - B', 60, 124, { w: 120 })]);
    const r = answerKeys.parseAnswerKeyLayout({ pages: [questao, folha] });
    assert.deepEqual(r.key, { 1: 'E', 2: 'E', 3: 'B', 4: 'A', 5: 'D', 6: 'D', 7: 'B', 8: 'C', 9: 'B' });
    // a folha sozinha não fala em espanhol: letra única para as duas línguas
    assert.equal(r.sharedLanguages, true);
  });

  it('grade partida na virada de página: a linha de números no pé, a de letras no alto da seguinte', () => {
    const p1 = pagina(1, [...grade(1, ingles.slice(0, 10), 100), t('11 12 13 14 15 16 17 18 19 20', 60, 800, { w: 420 })]);
    const p2 = pagina(2, [t('2', 290, 40), t('Continuação do Comunicado', 200, 60, { w: 150 }), t('D E B B D E C B D E', 62, 90, { w: 420 }), ...grade(21, ingles.slice(0, 10), 130)]);
    const { key } = answerKeys.parseAnswerKeyLayout({ pages: [p1, p2] });
    for (let n = 11; n <= 20; n += 1) assert.equal(key[n], ingles[n - 1], `questão ${n}`);
  });

  it('letra única (VUNESP): vale para a opção de espanhol só quando quem chama pede', () => {
    const lido = answerKeys.parseAnswerKeyText('39 - B 40 - D 41 - C');
    assert.equal(lido.sharedLanguages, true);
    assert.equal(answerKeys.answerFor(lido.key, 40, 'espanhol'), null, 'sozinho, o espanhol continua sem letra');
    const key = answerKeys.shareLanguages(lido.key, [39, 40]);
    assert.equal(answerKeys.answerFor(key, 40, 'espanhol'), 'D');
    assert.equal(answerKeys.answerFor(key, 41, 'espanhol'), null);
    // a folha do INEP fala em espanhol: nunca é letra única
    assert.equal(answerKeys.parseAnswerKeyText('INGLÊS ESPANHOL\n1 B A').sharedLanguages, false);
    // e o que a folha já trouxe não muda
    assert.equal(answerKeys.shareLanguages({ 1: 'B', '1:espanhol': 'A' }, [1])['1:espanhol'], 'A');
  });

  it('tipo do caderno pela capa ("NÍVEL MÉDIO TIPO 1 – BRANCA", em letras soltas)', () => {
    const capa = pagina(1, [t('N ÍVEL M ÉDIO T IPO 1 – BRANCA', 100, 100, { w: 200 })]);
    assert.equal(answerKeys.tipoDoCaderno({ pages: [capa] }), 1);
    assert.equal(answerKeys.tipoDoCaderno({ pages: [pagina(1, [t('Confira o tipo do caderno', 100, 100, { w: 200 })])] }), null);
  });
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** O que o gabarito oficial diz, conferido à mão na folha de cada prova. */
const GABARITOS = {
  'enem-2023-gabarito-dia-1': {
    total: 95,
    faixa: [1, 90],
    letras: { 1: 'B', '1:espanhol': 'A', 4: 'D', '4:espanhol': 'E', 5: 'A', '5:espanhol': 'A', 6: 'C', 45: 'C', 46: 'D', 90: 'D' },
  },
  'enem-2024-gabarito-dia-1': {
    total: 95,
    faixa: [1, 90],
    letras: { 1: 'A', '1:espanhol': 'D', 5: 'A', '5:espanhol': 'C', 6: 'D', 46: 'D' },
  },
  'enem-ppl-2017-gabarito-dia-1': {
    total: 95,
    faixa: [1, 90],
    letras: { 1: 'B', '1:espanhol': 'E', 5: 'B', '5:espanhol': 'C', 6: 'B', 46: 'D', 50: 'C' },
  },
  'enem-2022-gabarito-dia-2': { total: 89, faixa: [91, 180], anuladas: [175], letras: { 91: 'E', 124: 'B', 135: 'B', 180: 'C' } },
  'enem-2023-gabarito-dia-2': { total: 89, faixa: [91, 180], anuladas: [177], letras: { 91: 'C', 136: 'D' } },
  'enem-ppl-2017-gabarito-dia-2': { total: 90, faixa: [91, 180], letras: { 91: 'C', 136: 'C', 139: 'E' } },
};

/** O texto do PDF como o navegador extrai (components/pdf-text.js). */
async function textoComoNoNavegador(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  const paginas = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const linhas = [];
      let atual = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        atual += item.str;
        if (item.hasEOL) {
          linhas.push(atual.trimEnd());
          atual = '';
        }
      }
      if (atual.trim()) linhas.push(atual.trimEnd());
      paginas.push(linhas.join('\n'));
    }
  } finally {
    await doc.destroy();
  }
  return paginas.join('\n\n').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Gabarito dentro do PDF da prova (VUNESP e FGV), lido inteiro pelo
 * readAnswerKey: as páginas de questão e de resolução vêm antes da folha.
 */
const NO_FIM_DA_PROVA = {
  // FGV 2025: comunicado com uma tabela por tipo e língua (p52–55); a prova é do tipo 1
  'barro-branco-2025': {
    total: 86,
    letras: 'EEBADDBCBDDEBBDECBDECADECAADCEEBBBADBBDBAEECCACEDBBACEDBADBCBDDABEBCBDADEBBBCAED',
    espanhol: { 39: 'B', 40: 'A', 41: 'E', 42: 'D', 43: 'C', 44: 'A' },
    shared: false,
  },
  // VUNESP 2022: "1 - B 2 - C …" na p27, uma letra por número para as duas línguas
  'barro-branco-2022': {
    total: 80,
    letras: 'BCAEDDBECDCDABDBCAECCBDAEDEEBCDBCAACEDBDCBDCBDADCECADBEAAECEBDCBAECDBABECDCACBED',
    espanhol: {},
    shared: true,
  },
};

describe('Gabarito no fim do PDF da prova (corpus)', () => {
  for (const [nome, esperado] of Object.entries(NO_FIM_DA_PROVA)) {
    const arquivo = path.join(CORPUS, `${nome}.pdf`);
    it(`${nome}: as letras da folha, sem par falso das páginas de questão`, { skip: fs.existsSync(arquivo) ? false : 'PDF fora do corpus' }, async () => {
      const lido = await answerKeys.readAnswerKey(fs.readFileSync(arquivo));
      assert.equal(lido.count, esperado.total);
      [...esperado.letras].forEach((letra, i) => assert.equal(lido.key[i + 1], letra, `questão ${i + 1}`));
      for (const [n, letra] of Object.entries(esperado.espanhol)) assert.equal(lido.key[`${n}:espanhol`], letra, `${n} espanhol`);
      assert.equal(lido.sharedLanguages, esperado.shared);
      assert.deepEqual(Object.keys(lido.key).filter((k) => Number.parseInt(k, 10) > 80), [], 'nada de "116"');
    });
  }
});

describe('Gabaritos reais (corpus)', () => {
  for (const [nome, esperado] of Object.entries(GABARITOS)) {
    const arquivo = path.join(CORPUS, `${nome}.pdf`);
    const existe = fs.existsSync(arquivo);
    it(`${nome}: letras certas, inclusive inglês e espanhol`, { skip: existe ? false : 'PDF fora do corpus' }, async () => {
      const buffer = fs.readFileSync(arquivo);
      const lido = await answerKeys.readAnswerKey(buffer);
      assert.equal(lido.count, esperado.total);
      for (let n = esperado.faixa[0]; n <= esperado.faixa[1]; n += 1) {
        if ((esperado.anuladas || []).includes(n)) assert.equal(lido.key[n], undefined, `${n} é anulada`);
        else assert.match(lido.key[n] || '', /^[A-E]$/, `questão ${n}`);
      }
      for (const [chave, letra] of Object.entries(esperado.letras)) assert.equal(lido.key[chave], letra, chave);
      const fora = Object.keys(lido.key).filter((k) => {
        const n = Number.parseInt(k, 10);
        return n < esperado.faixa[0] || n > esperado.faixa[1];
      });
      assert.deepEqual(fora, [], 'nada fora da faixa da prova (cabeçalho, caderno, ano)');

      // O caminho do navegador (plano B) lê o mesmo gabarito.
      const pelo = examImport.parseAnswerKey(await textoComoNoNavegador(buffer));
      assert.deepEqual(pelo.key, lido.key);
    });
  }
});

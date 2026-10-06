'use strict';

/**
 * Leitor de provas no servidor — provas reais.
 *
 *   CORPUS_PROVAS=/pasta/com/os/pdfs NODE_ENV=test node --test tests/exam-reader-corpus.test.js
 *
 * As provas não vão para o repositório (são grandes, e a pasta de provas é
 * ignorada pelo git). Cada teste procura o PDF em $CORPUS_PROVAS (ou em
 * public/assets/past-exams) e é PULADO quando o arquivo não existe — a suíte
 * fica verde em qualquer máquina, e quem tem as provas confere o leitor de
 * verdade.
 *
 * O que é conferido, por prova: as questões certas, na ordem, sem faltar e sem
 * sobrar (ENEM dia 1 com as cinco de espanhol; VUNESP/FGV com 39 a 44 nas duas
 * línguas); nenhum enunciado com cabeçalho, rodapé, código de barras, capa ou
 * redação; cinco alternativas em todas; nenhum caractere de controle; e os
 * casos difíceis medidos no corpus (fonte embaralhada do PPL 2017, apoio
 * compartilhado do VUNESP, alternativas em grade e em figura), e as figuras:
 * todo marcador `figura:N` aponta para um recorte em PNG, todo recorte aparece
 * uma vez só, e o texto que é da figura (célula de tabela, rótulo de gráfico,
 * legenda de estrutura química) não se repete no enunciado.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readExam } = require('../server/services/exam-reader');

const CORPUS = process.env.CORPUS_PROVAS || path.join(__dirname, '..', 'public', 'assets', 'past-exams');

function faixa(de, ate, variant = '') {
  const out = [];
  for (let n = de; n <= ate; n += 1) out.push(`${n}${variant}`);
  return out;
}

const ENEM_DIA_1 = [...faixa(1, 5, '-ingles'), ...faixa(1, 5, '-espanhol'), ...faixa(6, 90)];
const ENEM_DIA_2 = faixa(91, 180);
const QUARTEL = [...faixa(1, 38), ...faixa(39, 44, '-ingles'), ...faixa(39, 44, '-espanhol'), ...faixa(45, 80)];

const PROVAS = {
  'enem-2023-dia-1': ENEM_DIA_1,
  'enem-2023-dia-2': ENEM_DIA_2,
  'enem-2024-dia-1': ENEM_DIA_1,
  'enem-2022-dia-2': ENEM_DIA_2,
  'enem-ppl-2017-dia-1': ENEM_DIA_1,
  'enem-ppl-2017-dia-2': ENEM_DIA_2,
  'barro-branco-2022': QUARTEL,
  'barro-branco-2024': QUARTEL,
  'barro-branco-2025': QUARTEL,
};

/** O que nunca pode aparecer em enunciado ou alternativa. */
const RUIDO = [
  /\*[A-Z]{2}\d{4}[A-Z]{2}\d+\*/, /\*\d{6}[A-Z]{2}\d+\*/, /Caderno\s+\d/i, /P[áa]gina\s+\d/i, /ENEM\s?20\d\d\s?ENEM/i,
  /Confidencial at/i, /PMeS\d/, /FGV CONHECIMENTO/, /INSTRU[ÇC][ÕO]ES PARA A REDA/i, /PROPOSTA DE REDA/i,
  /CADERNO DE QUEST/i, /LEIA ATENTAMENTE/i, /QUEST[ÃA]O\s*\d/, /(^|\n)Quest[õo]es de \d+ a \d+/i, /E SUAS TECNOLOGIAS/,
  /POL[ÍI]CIA MILITAR DO ESTADO DE S[ÃA]O PAULO/, /\d\s*º\s*DIA\b/i, /SIMULADODEVESTIBULAR/i, /RASCUNHO/,
];

const cache = new Map();
async function ler(prova) {
  if (!cache.has(prova)) {
    const inicio = Date.now();
    const r = await readExam(fs.readFileSync(path.join(CORPUS, `${prova}.pdf`)));
    r.ms = Date.now() - inicio;
    cache.set(prova, r);
  }
  return cache.get(prova);
}

function existe(prova) {
  return fs.existsSync(path.join(CORPUS, `${prova}.pdf`));
}

const chave = (q) => `${q.number}${q.variant ? `-${q.variant}` : ''}`;
const texto = (q) => [q.statement_md, ...q.alternatives.map((a) => a.text_md)].join('\n');
const acha = (r, n, variant = null) => r.questions.find((q) => q.number === n && (q.variant || null) === variant);
/** O markdown sem a formatação em linha (negrito, itálico, sublinhado). */
const semMarcas = (md) => String(md || '').replace(/\*\*|\*|\+\+/g, '');

describe('leitor de provas — corpus', () => {
  for (const [prova, esperadas] of Object.entries(PROVAS)) {
    it(`${prova}: questões certas, na ordem, limpas e com cinco alternativas`, async (t) => {
      if (!existe(prova)) {
        t.skip(`sem ${prova}.pdf em ${CORPUS}`);
        return;
      }
      const r = await ler(prova);
      assert.deepEqual(r.questions.map(chave), esperadas);
      for (const q of r.questions) {
        const tx = texto(q);
        for (const re of RUIDO) assert.doesNotMatch(tx, re, `${prova} ${chave(q)} com ruído (${re})`);
        assert.doesNotMatch(tx, /[\u0000-\u0008\u000b-\u001f�\ue000-\uf8ff]/, `${prova} ${chave(q)} com caractere de controle`);
        assert.equal(q.alternatives.length, 5, `${prova} ${chave(q)}`);
        assert.ok(q.alternatives.every((a) => a.text_md), `${prova} ${chave(q)} com alternativa vazia`);
        assert.ok(!q.alerts.includes('texto_ilegivel'), `${prova} ${chave(q)} ilegível`);
        assert.ok(q.statement_md.length > 20, `${prova} ${chave(q)} sem enunciado`);
        // figuras: cada marcador aponta para um PNG, e cada PNG aparece uma vez
        const usadas = [...tx.matchAll(/\]\(figura:(\d+)\)/g)].map((m) => Number(m[1]));
        assert.deepEqual(usadas.slice().sort((a, b) => a - b), q.figures.map((_, i) => i), `${prova} ${chave(q)} figura sem marcador ou repetida`);
        for (const f of q.figures) {
          assert.equal(f.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${prova} ${chave(q)} sem PNG`);
          // (a fórmula no meio da frase pode ser só um símbolo: "(P⃗)")
          assert.ok(f.crop.w >= 4 && f.crop.h >= 4, `${prova} ${chave(q)} recorte vazio`);
        }
      }
      assert.ok(r.ms < 20_000, `${prova} levou ${r.ms} ms`);
    });
  }

  it('ENEM 2023 dia 1: capa fora da 1, proposta de redação fora da 46', async (t) => {
    if (!existe('enem-2023-dia-1')) return t.skip('sem o PDF');
    const r = await ler('enem-2023-dia-1');
    // a legenda do cartum fica dentro do quadro do cartum: vai com a figura
    assert.match(semMarcas(acha(r, 1, 'ingles').statement_md), /^!\[Figura\]\(figura:0\)/);
    assert.match(acha(r, 1, 'ingles').figures[0].text, /Oh, you’ll love working here/);
    assert.match(semMarcas(acha(r, 1, 'espanhol').statement_md), /\S/);
    assert.notEqual(acha(r, 1, 'espanhol').statement_md, acha(r, 1, 'ingles').statement_md);
    assert.doesNotMatch(semMarcas(acha(r, 46).statement_md), /REDAÇÃO|redação/);
    assert.ok(r.discarded.some((d) => d.kind === 'redacao' && /INSTRUÇÕES PARA A REDAÇÃO/.test(d.text)));
    assert.ok(r.discarded.some((d) => d.kind === 'capa'));
    // poema: verso em linha própria
    assert.match(semMarcas(acha(r, 2, 'ingles').statement_md), /^No man is an island,\nEntire of itself;\n/);
  });

  it('PPL 2017 dia 1: a fonte embaralhada sai legível', async (t) => {
    if (!existe('enem-ppl-2017-dia-1')) return t.skip('sem o PDF');
    const r = await ler('enem-ppl-2017-dia-1');
    assert.match(semMarcas(acha(r, 71).statement_md), /política de pacificação não resolve/);
    assert.match(semMarcas(acha(r, 88).statement_md), /intervenções da urbanização/);
    assert.match(semMarcas(acha(r, 72).statement_md), /São Paulo: Globo, 2013 \(adaptado\)\./);
    for (const q of r.questions) assert.doesNotMatch(texto(q), /¿|\u0003/, `questão ${chave(q)}`);
    assert.ok(r.decode.some((d) => d.method === 'glifos-arial'));
    // alternativas que são imagens (cinco mapas), e os três mapas do enunciado numa figura só
    const q75 = acha(r, 75);
    assert.deepEqual(q75.alternatives.map((a) => a.text_md), ['A', 'B', 'C', 'D', 'E'].map((l, i) => `![Alternativa ${l}](figura:${i + 1})`));
    assert.equal(q75.figures[0].slot, 'enunciado');
    assert.ok(q75.figures[0].bbox.w > 450, 'os três mapas lado a lado viram uma figura');
  });

  it('ENEM 2022 dia 2: alternativas em figura na outra coluna e em grade', async (t) => {
    if (!existe('enem-2022-dia-2')) return t.skip('sem o PDF');
    const r = await ler('enem-2022-dia-2');
    const q158 = acha(r, 158);
    assert.deepEqual(q158.alternatives.map((a) => q158.figures[Number(/figura:(\d+)/.exec(a.text_md)[1])].slot), ['A', 'B', 'C', 'D', 'E']);
    const q163 = acha(r, 163);
    assert.deepEqual(q163.alternatives.map((a) => a.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.ok(q163.alternatives.every((a) => /^!\[Alternativa [A-E]\]\(figura:\d+\)$/.test(a.text_md)));
    // fórmula do MathType que não vira texto: cada alternativa vira recorte, nunca caractere de controle
    const q150 = acha(r, 150);
    assert.ok(q150.alternatives.every((a) => /^!\[Alternativa [A-E]\]\(figura:\d+\)$/.test(a.text_md)));
    assert.ok(q150.figures.every((f) => f.kind === 'formula'));
    // seis estruturas químicas com as legendas no meio: uma figura, e as legendas fora do texto
    const q102 = acha(r, 102);
    assert.equal(q102.figures.length, 1);
    assert.doesNotMatch(q102.statement_md, /Benzaldeído|óleo de|CH₃/);
    assert.match(q102.figures[0].text, /Benzaldeído.*Cinamaldeído/s);
    // tabela recortada como imagem, sem as células soltas no enunciado
    const q119 = acha(r, 119);
    assert.equal(q119.figures[0].kind, 'tabela');
    assert.doesNotMatch(q119.statement_md, /Corrente elétrica|Parada respiratória/);
    // equação química com a seta desenhada
    assert.match(semMarcas(acha(r, 127).statement_md), /3 O₂ \(g\) → 2 Fe₂ ?O₃/);
  });

  it('ENEM 2023 dia 2: gráficos das alternativas inteiros (eixos girados) e sem pegar a outra coluna', async (t) => {
    if (!existe('enem-2023-dia-2')) return t.skip('sem o PDF');
    const r = await ler('enem-2023-dia-2');
    const q129 = acha(r, 129);
    assert.equal(q129.figures[0].kind, 'tabela');
    assert.doesNotMatch(q129.statement_md, /Frasco|0,2 0,4/);
    for (const a of q129.alternatives) {
      const f = q129.figures[Number(/figura:(\d+)/.exec(a.text_md)[1])];
      assert.equal(f.slot, a.letter);
      assert.match(f.text, /Massa de NaC[lI] \(g\)/);
      assert.ok(f.bbox.h > 100 && f.bbox.h < 140, `${a.letter}: ${JSON.stringify(f.bbox)}`);
    }
    // foto recortada no diagramador (a imagem vai além do que aparece): o recorte é o visível
    const q114 = acha(r, 114);
    assert.ok(q114.figures[0].crop.x > 283, JSON.stringify(q114.figures[0].crop));
    // razão montada vira texto, com os índices
    assert.match(semMarcas(acha(r, 102).statement_md), /razão M₂\/M₁ informada/);
  });

  it('VUNESP 2022: o apoio anunciado entra nas questões da faixa, e só nelas', async (t) => {
    if (!existe('barro-branco-2022')) return t.skip('sem o PDF');
    const r = await ler('barro-branco-2022');
    for (const n of [23, 24, 25, 26, 27]) {
      assert.match(semMarcas(acha(r, n).statement_md), /^Leia o trecho inicial do romance Dom Casmurro, de Machado de Assis, para responder às questões de 23 a 27\./);
    }
    assert.doesNotMatch(semMarcas(acha(r, 22).statement_md), /Dom Casmurro/);
    assert.doesNotMatch(semMarcas(acha(r, 28).statement_md), /Dom Casmurro/);
    for (const n of [31, 32, 33]) {
      assert.match(semMarcas(acha(r, n).statement_md), /^Para responder às questões de 31 a 33, leia o trecho inicial da crônica/);
    }
    // inglês 39–43 têm o texto anunciado; a 44 inglês não (a faixa manda)
    assert.match(semMarcas(acha(r, 39, 'ingles').statement_md), /para responder às questões de 39 a 43/);
    assert.doesNotMatch(semMarcas(acha(r, 44, 'ingles').statement_md), /para responder às questões de 39 a 43/);
    assert.match(semMarcas(acha(r, 39, 'espanhol').statement_md), /para responder às questões de 39 a 44/);
    // hifenização do VUNESP desfeita
    assert.ok(r.questions.every((q) => !/\p{L}- \p{Ll}/u.test(texto(q))), 'sobrou hífen de quebra de linha');
  });

  it('VUNESP 2024: apoio com gráfico nas questões de inglês', async (t) => {
    if (!existe('barro-branco-2024')) return t.skip('sem o PDF');
    const r = await ler('barro-branco-2024');
    for (let n = 39; n <= 44; n += 1) {
      const q = acha(r, n, 'ingles');
      assert.match(semMarcas(q.statement_md), /^Leia o texto e o gráfico para responder às questões de 39 a 44/);
      assert.ok(q.figures.some((f) => f.slot === 'apoio'));
    }
    // alternativas da 79 (desenhos de slide) na página seguinte, uma figura por letra
    const q79 = acha(r, 79);
    assert.deepEqual(q79.figures.filter((f) => /^[A-E]$/.test(f.slot)).map((f) => `${f.slot}${f.page}`), ['A29', 'B29', 'C29', 'D29', 'E29']);
  });

  it('FGV 2025: texto de inglês sem anúncio vai para as questões que o usam', async (t) => {
    if (!existe('barro-branco-2025')) return t.skip('sem o PDF');
    const r = await ler('barro-branco-2025');
    for (const n of [39, 40, 41, 42]) assert.match(semMarcas(acha(r, n, 'ingles').statement_md), /Understanding bias in facial recognition/);
    assert.doesNotMatch(semMarcas(acha(r, 43, 'ingles').statement_md), /Understanding bias/);
    assert.match(semMarcas(acha(r, 39, 'espanhol').statement_md), /Tres de cada diez brasileños/);
    assert.ok(!r.discarded.some((d) => d.kind === 'sobra' && d.text.length > 200));
  });
});

/**
 * Defeitos que a avaliação independente achou lendo as provas página a página
 * (questão, o que saía, o que devia sair). Cada um tinha uma causa no leitor —
 * não é remendo de prova: o teste só confere que a causa não voltou.
 */
describe('leitor de provas — corpus, defeitos da avaliação', () => {
  const temProva = (t, prova) => {
    if (existe(prova)) return true;
    t.skip(`sem ${prova}.pdf em ${CORPUS}`);
    return false;
  };
  const figuraDe = (q, md) => q.figures[Number(/figura:(\d+)/.exec(md)[1])];

  it('ENEM 2023 dia 1: "¿" e título em itálico sintético no texto; gráfico com a seta de cota e sem o fio da coluna', async (t) => {
    if (!temProva(t, 'enem-2023-dia-1')) return;
    const r = await ler('enem-2023-dia-1');
    const q5 = semMarcas(acha(r, 5, 'espanhol').statement_md);
    assert.match(q5, /¿QUÉ ME PASA\?:/);
    assert.match(q5, /¿PorQUÉ ME CUESTA TANTO ESTUDIAR\?/);
    assert.doesNotMatch(q5, /(^|\n)\?(\n|$)/);
    const f55 = acha(r, 55).figures[0];
    assert.ok(f55.crop.y <= 336, `a seta 1960↔2020 fica fora: ${JSON.stringify(f55.crop)}`);
    assert.ok(f55.crop.x > 285.5, `o fio da coluna entra no recorte: ${JSON.stringify(f55.crop)}`);
  });

  it('ENEM 2023 dia 2: palavra inteira na linha justificada, α da fonte Symbol, "⋅" no lugar, fração com índice', async (t) => {
    if (!temProva(t, 'enem-2023-dia-2')) return;
    const r = await ler('enem-2023-dia-2');
    const q137 = semMarcas(texto(acha(r, 137)));
    assert.match(q137, /^O mastro de uma bandeira foi instalado perpendicularmente/);
    assert.match(q137, /ângulo α com o plano do chão/);
    assert.match(semMarcas(texto(acha(r, 110))), /ligam fortemente ao íon/);
    assert.match(semMarcas(texto(acha(r, 104))), /guardar parte da maquinaria/);
    assert.deepEqual(acha(r, 142).alternatives.map((a) => a.text_md), ['0° \\< α \\< 90°', 'α = 90°', '90° \\< α \\< 180°', 'α = 180°', '180° \\< α \\< 360°']);
    assert.deepEqual(acha(r, 143).alternatives.map((a) => a.text_md), ['min/(mL⋅kg)', 'mL/(min⋅kg)', '(min⋅mL)/kg', '(min⋅kg)/mL', '(mL⋅kg)/min']);
    assert.match(acha(r, 97).statement_md, /\(L ⋅ atm\)\/\(mol⋅K\)/);
    assert.deepEqual(acha(r, 159).alternatives.map((a) => a.text_md), ['1/9 L₀', '16/27 L₀', '32/243 L₀', '64/729 L₀', '128/(2 187) L₀']);
    // "α =" desenhado no meio da frase: recorte no lugar, a frase continua inteira
    assert.match(acha(r, 147).statement_md, /mesma medida do ângulo !\[Fórmula\]\(figura:\d+\)/);
    // vetor desenhado em cima da letra
    assert.match(semMarcas(acha(r, 102).statement_md), /mesma força F⃗, os usuários/);
    // o rótulo do eixo em duas linhas fica no recorte, não solto no enunciado
    assert.doesNotMatch(acha(r, 162).statement_md, /milhar de real/);
    // gráficos de alternativas empilhados: cada um com o seu "t (s)"
    for (const a of acha(r, 167).alternatives) {
      const f = figuraDe(acha(r, 167), a.text_md);
      assert.equal((f.text.match(/t \(s\)/g) || []).length, 1, `${a.letter}: ${f.text}`);
    }
  });

  it('ENEM 2024 dia 1: legendas lado a lado ficam com as imagens; referência e título em uma linha', async (t) => {
    if (!temProva(t, 'enem-2024-dia-1')) return;
    const r = await ler('enem-2024-dia-1');
    const q19 = acha(r, 19);
    assert.doesNotMatch(q19.statement_md, /MODIGLIANI|Anônimo/);
    assert.match(q19.figures[0].text, /Anônimo\. Cabeça de uma figura feminina\..*MODIGLIANI/s);
    assert.match(semMarcas(acha(r, 53).statement_md), /Tremor de terra de magnitude 4,8 é registrado no interior do Amazonas\. Disponível/);
    assert.match(semMarcas(acha(r, 31).statement_md), /^Telemedicina é para todos, mas nem todos estão preparados\n/);
    assert.match(semMarcas(acha(r, 4, 'espanhol').statement_md), /enrojecidos tienen sus muros\.\n\nGusanos pululan/);
  });

  it('ENEM 2022 dia 2: tabela em contorno vira figura; eixo inteiro; rótulo girado no recorte; índice de letra', async (t) => {
    if (!temProva(t, 'enem-2022-dia-2')) return;
    const r = await ler('enem-2022-dia-2');
    const q177 = acha(r, 177);
    assert.match(q177.statement_md, /esta ordem:\n\n!\[Figura\]\(figura:0\)\n\nA letra R/);
    assert.ok(q177.figures[0].crop.w > 450, JSON.stringify(q177.figures[0].crop));
    const q180 = acha(r, 180);
    assert.match(q180.figures[0].text, /30/);
    assert.doesNotMatch(q180.statement_md, /\n30\n/);
    assert.ok(acha(r, 113).figures[0].crop.x < 308, JSON.stringify(acha(r, 113).figures[0].crop));
    assert.match(semMarcas(acha(r, 108).statement_md), /com uma força F⃗, conforme ilustra a imagem/);
    assert.match(acha(r, 172).statement_md, /Indique por L_\{E\} e L_\{F\}/);
  });

  it('PPL 2017 dia 1: glifo que o pdf.js some (Ã, ")") volta no lugar', async (t) => {
    if (!temProva(t, 'enem-ppl-2017-dia-1')) return;
    const r = await ler('enem-ppl-2017-dia-1');
    assert.match(acha(r, 26).statement_md, /MAGALHÃES, L\. L\. A\./);
    assert.match(acha(r, 77).statement_md, /GUIMARÃES, A\. S\. A\./);
    assert.match(acha(r, 52).statement_md, /identificado no\(a\)$/);
  });

  it('PPL 2017 dia 2: rótulos de vértice e legenda em duas linhas dentro do recorte; vírgula no número', async (t) => {
    if (!temProva(t, 'enem-ppl-2017-dia-2')) return;
    const r = await ler('enem-ppl-2017-dia-2');
    const q179 = acha(r, 179);
    // (os nomes dos pontos no texto ficam em negrito, como na prova; o que não
    // pode é sobrar parágrafo só com a letra do vértice)
    assert.doesNotMatch(q179.statement_md, /(^|\n\n)\*\*[A-H]\*\*(\n\n|$)|Fórmula/);
    assert.equal(q179.figures.filter((f) => f.slot === 'enunciado').length, 1);
    assert.match(q179.figures[0].text, /H.*Teto/);
    assert.doesNotMatch(acha(r, 169).alternatives[0].text_md, /Início/);
    assert.doesNotMatch(acha(r, 120).statement_md, /cloropropeno/);
    assert.match(acha(r, 98).statement_md, /M = 7,1 \+ 5\(log D\)/);
    assert.match(acha(r, 98).statement_md, /\(F₁\) e da ocular \(F₂\)/);
  });

  it('VUNESP 2022: sublinhado, lacuna, expoente e índice de letra, seta da equação', async (t) => {
    if (!temProva(t, 'barro-branco-2022')) return;
    const r = await ler('barro-branco-2022');
    assert.match(acha(r, 78).statement_md, /Aluno \+\+Oficial\+\+ PM/);
    assert.match(acha(r, 26).statement_md, /no sentido que \+\+eles\+\+ \+\+lhe\+\+ dão/);
    // (o traço sublinha só o verbo, sem o pronome: "++mover++se")
    assert.deepEqual(acha(r, 43, 'espanhol').alternatives.map((a) => (/\+\+(\S+?)\+\+(\S*)/.exec(a.text_md) || []).slice(1).join('|')), ['mover|se', 'forjar|se', 'desenvolver|se', 'inculcar|las', 'recrear|']);
    assert.match(acha(r, 52).statement_md, /3\^\{x\} = 4\^\{z\} e 2 · 8\^\{z\} = 9\^\{x\}/);
    assert.match(acha(r, 49).statement_md, /D = \(d_\{ij\}\)/);
    assert.match(acha(r, 68).statement_md, /(?:\\_){4} Aℓ\(OH\)₃ \(s\) \+ (?:\\_){4} H₂SO₄ \(\*aq\*\) → (?:\\_){4} Aℓ₂\(SO₄\)₃/);
    assert.match(acha(r, 74).statement_md, /que possui (?:\\_)+ e (?:\\_)+\./);
    assert.match(acha(r, 15).statement_md, /Distribuição de (?:\\_)+ por país, 2014/);
  });

  it('VUNESP 2024: parágrafos pelo recuo; fórmula no meio da frase; texto desenhado com a foto; lacunas', async (t) => {
    if (!temProva(t, 'barro-branco-2024')) return;
    const r = await ler('barro-branco-2024');
    // o texto de apoio das questões 23 a 28 tem 18 parágrafos, mais o anúncio e a referência
    const apoio = acha(r, 23).statement_md.split('\n\n');
    assert.equal(apoio.findIndex((p) => /^Conheci outrora/.test(p)), 1);
    assert.equal(apoio.findIndex((p) => /^Até lá, porém/.test(p)), 18);
    assert.match(acha(r, 24).statement_md, /\+\+outono\+\+ da mulher/);
    assert.match(acha(r, 55).statement_md, /um polinômio divisível por \(x \+ 5\)/);
    assert.match(acha(r, 49).statement_md, /os determinantes dessas duas matrizes/);
    const q63 = semMarcas(acha(r, 63).statement_md);
    assert.match(q63, /^O gás dióxido de cloro \(CℓOₓ\) vem sendo utilizado/);
    assert.match(q63, /zCℓ₂ \(g\) → wCℓOₓ \(g\)/);
    assert.equal((q63.match(/(?:\\_){8}/g) || []).length, 3);
    assert.ok(acha(r, 59).figures[0].crop.y < 98, JSON.stringify(acha(r, 59).figures[0].crop));
    assert.ok(acha(r, 67).figures[0].crop.y + acha(r, 67).figures[0].crop.h > 215, JSON.stringify(acha(r, 67).figures[0].crop));
  });

  it('FGV 2025: sublinhado e destaque do comando; itens da lista separados; Text II também na 44; matriz numa imagem', async (t) => {
    if (!temProva(t, 'barro-branco-2025')) return;
    const r = await ler('barro-branco-2025');
    assert.deepEqual(acha(r, 31).alternatives.map((a) => (/\+\+([^+]+)\+\+/.exec(a.text_md) || [])[1]), ['por que', 'por que', 'porquê', 'porquê', 'Por que']);
    assert.match(acha(r, 24).statement_md, /troca \*\*\*\+\+indevida\+\+\*\*\* entre/);
    assert.match(acha(r, 17).statement_md, /que o habitam\.\nII\. Engloba/);
    assert.match(acha(r, 15).statement_md, /visam o desenvolvimento econômico, a alocação/);
    const q44 = acha(r, 44, 'ingles');
    assert.match(q44.statement_md, /^\*\*Text II\*\*\n\n!\[Figura\]\(figura:0\)/);
    assert.equal(q44.figures[0].slot, 'apoio');
    const q46 = acha(r, 46);
    assert.equal(q46.figures.length, 1);
    assert.match(q46.statement_md, /M = \(m_\{ij\}\)_\{3×3\}/);
  });
});

/**
 * Rodada 2 da avaliação: o último desenho da fórmula ficava fora do recorte
 * ("4√1" no lugar de "4√10", matriz sem o colchete), a raiz desenhada no vão
 * de "11 2" passava como letra do texto, a pontuação colada na fórmula sumia,
 * a tabela periódica anunciada não chegava às questões de Química e o
 * gabarito no fim do PDF da prova não era lido (ou saía com letras de frases).
 */
describe('leitor de provas — corpus, rodada 2 da avaliação', () => {
  const temProva = (t, prova) => {
    if (existe(prova)) return true;
    t.skip(`sem ${prova}.pdf em ${CORPUS}`);
    return false;
  };
  const fim = (f) => f.crop.x + f.crop.w;
  const figuraDe = (q, md) => q.figures[Number(/figura:(\d+)/.exec(md)[1])];

  it('ENEM 2023 dia 2: "11√2" recortada, "α =" inteira, "$, *, &" com a vírgula, V(x) numa fórmula só', async (t) => {
    if (!temProva(t, 'enem-2023-dia-2')) return;
    const r = await ler('enem-2023-dia-2');
    const q137 = acha(r, 137);
    for (const a of q137.alternatives.slice(0, 4)) assert.match(a.text_md, /^!\[Alternativa [A-D]\]\(figura:\d+\)$/, `${a.letter}: ${a.text_md}`);
    const b = figuraDe(q137, q137.alternatives[1].text_md);
    assert.ok(b.crop.x <= 307.1 && fim(b) >= 328.9, `B sem o "11" ou sem a raiz: ${JSON.stringify(b.crop)}`);
    const q147 = acha(r, 147);
    assert.ok(fim(figuraDe(q147, q147.statement_md)) >= 128, 'o "=" desenhado fica no recorte');
    assert.match(acha(r, 157).statement_md, /especiais !, @, #, \$, !\[Fórmula\]\(figura:0\), &\./);
    assert.match(acha(r, 160).statement_md, /pela expressão !\[Fórmula\]\(figura:0\), em que/);
    assert.match(acha(r, 170).statement_md, /para !\[Fórmula\]\(figura:0\)\./);
  });

  it('ENEM 2022 dia 2: a pontuação da frase fica fora do recorte da fórmula e no texto', async (t) => {
    if (!temProva(t, 'enem-2022-dia-2')) return;
    const r = await ler('enem-2022-dia-2');
    const q108 = acha(r, 108);
    assert.match(q108.statement_md, /forças peso !\[Fórmula\]\(figura:1\), normal !\[Fórmula\]\(figura:2\) e de atrito estático !\[Fórmula\]\(figura:3\)\.\n/);
    assert.ok(fim(q108.figures[1]) <= 218.5, `vírgula no recorte: ${JSON.stringify(q108.figures[1].crop)}`);
    assert.ok(fim(q108.figures[3]) <= 123.8, `ponto no recorte: ${JSON.stringify(q108.figures[3].crop)}`);
  });

  it('VUNESP 2024 e 2022: o recorte da fórmula vai até o último desenho (4√10, colchete, parêntese)', async (t) => {
    if (!temProva(t, 'barro-branco-2024') || !temProva(t, 'barro-branco-2022')) return;
    const r24 = await ler('barro-branco-2024');
    const q54 = acha(r24, 54);
    assert.ok(fim(figuraDe(q54, q54.statement_md.slice(q54.statement_md.indexOf('pirâmide GFCD é')))) >= 259.4, '"4√10" inteiro');
    assert.ok(fim(acha(r24, 49).figures[0]) >= 204.7, 'o "]" da matriz A');
    const r22 = await ler('barro-branco-2022');
    assert.ok(fim(acha(r22, 45).figures[1]) >= 180.3, 'o ")" de Z');
    assert.ok(fim(acha(r22, 49).figures[0]) >= 155, 'o "]" da matriz D');
  });

  it('VUNESP e FGV: a tabela periódica anunciada vai, endireitada, para as questões de Química', async (t) => {
    for (const [prova, pagina, titulo] of [['barro-branco-2022', 26, 'Classificação'], ['barro-branco-2024', 32, 'Classificação'], ['barro-branco-2025', 3, 'Tabela']]) {
      if (!temProva(t, prova)) return;
      const r = await ler(prova);
      for (let n = 63; n <= 68; n += 1) {
        const q = acha(r, n);
        const f = q.figures.find((x) => x.slot === 'apoio' && x.page === pagina);
        assert.ok(f, `${prova} ${n} sem a tabela`);
        assert.equal(f.rotate, 90, `${prova} ${n}`);
        assert.match(q.statement_md, new RegExp(`!\\[${titulo} Periódica\\]\\(figura:${q.figures.indexOf(f)}\\)$`));
      }
      for (const n of [62, 69]) assert.ok(!acha(r, n).figures.some((x) => x.page === pagina), `${prova} ${n} não é de Química`);
    }
  });

  it('gabarito no fim do PDF da prova: lido só na folha, com o tipo do caderno', async (t) => {
    if (!temProva(t, 'barro-branco-2022') || !temProva(t, 'barro-branco-2025')) return;
    const r22 = await ler('barro-branco-2022');
    assert.equal(r22.answer_key.count, 80);
    assert.equal(r22.answer_key.sharedLanguages, true);
    assert.equal(r22.answer_key.key[40], 'D');
    const r25 = await ler('barro-branco-2025');
    assert.equal(r25.booklet_type, 1);
    assert.equal(r25.answer_key.count, 86);
    assert.deepEqual([2, 3, 9, 10, 20, 25, 40].map((n) => r25.answer_key.key[n]), ['E', 'B', 'B', 'D', 'E', 'C', 'B']);
    assert.equal(r25.answer_key.key['40:espanhol'], 'A');
    assert.equal(r25.answer_key.key[116], undefined);
    for (const prova of ['enem-2023-dia-1', 'enem-2022-dia-2', 'barro-branco-2024']) {
      if (existe(prova)) assert.equal((await ler(prova)).answer_key, null, `${prova} não tem gabarito no PDF`);
    }
  });
});

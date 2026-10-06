'use strict';

/**
 * Leitura do PDF com posição — a matéria-prima do leitor de provas.
 *
 *   const { openPdf, extractLayout } = require('./layout');
 *   const doc = await openPdf(buffer);
 *   const layout = await extractLayout(doc);   // páginas com texto, imagens e desenhos
 *   await doc.destroy();
 *
 * O leitor antigo recebia o texto do navegador já sem posição, e daí em diante
 * não havia como saber o que era cabeçalho, coluna, legenda ou alternativa. Aqui
 * cada pedaço de texto sai com x, y, largura, altura, linha de base, tamanho e
 * fonte; cada imagem e cada desenho vetorial sai com o retângulo que ocupa na
 * página. O resto do leitor (structure.js, questions.js) trabalha só em cima
 * desse "layout", que é JSON puro — por isso dá para testar tudo sem PDF.
 *
 * Coordenadas: pontos PDF com origem no canto SUPERIOR esquerdo, y crescendo
 * para baixo (o contrário do PDF). `y` é o topo do item e `base` a linha de base.
 *
 * O pdfjs-dist é ESM e o projeto é CommonJS: o carregamento é por import()
 * dinâmico do build legacy, uma vez só. Se falhar (pacote ausente no servidor,
 * binário do canvas que não carrega), a função devolve um erro com código
 * 'leitor_indisponivel' — quem chama cai no caminho antigo, e o servidor segue
 * de pé.
 */
const path = require('node:path');

/** Erro de "o leitor não existe neste servidor" (não é culpa do PDF). */
class ReaderUnavailableError extends Error {
  constructor(cause) {
    super('A leitura de provas no servidor não está disponível neste ambiente.');
    this.name = 'ReaderUnavailableError';
    this.code = 'leitor_indisponivel';
    this.cause = cause;
  }
}

/** Erro de "este arquivo não abre como PDF". */
class InvalidPdfError extends Error {
  constructor(cause) {
    super('Não foi possível abrir o arquivo como PDF.');
    this.name = 'InvalidPdfError';
    this.code = 'pdf_invalido';
    this.cause = cause;
  }
}

let runtimePromise = null;

/**
 * Carrega o pdf.js e o canvas uma vez por processo.
 * Um carregamento que falhou não fica em cache: a próxima tentativa tenta de novo.
 */
function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // eslint-disable-next-line global-require
      const { createCanvas } = require('@napi-rs/canvas');
      const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
      return { pdfjs, createCanvas, pdfjsDir };
    })().catch((err) => {
      runtimePromise = null;
      throw new ReaderUnavailableError(err);
    });
  }
  return runtimePromise;
}

/**
 * Fábrica de canvas do @napi-rs/canvas. O pdf.js tem a dele, mas no Node antigo
 * ela depende de process.getBuiltinModule; com esta, o render funciona igual
 * em qualquer Node ≥ 20.
 */
function makeCanvasFactory(createCanvas) {
  return class CanvasFactory {
    create(width, height) {
      const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      return { canvas, context: canvas.getContext('2d') };
    }

    reset(pair, width, height) {
      pair.canvas.width = Math.max(1, Math.ceil(width));
      pair.canvas.height = Math.max(1, Math.ceil(height));
    }

    destroy(pair) {
      if (pair.canvas) {
        pair.canvas.width = 0;
        pair.canvas.height = 0;
      }
      pair.canvas = null;
      pair.context = null;
    }
  };
}

/**
 * Abre um PDF (Buffer ou Uint8Array). Quem abre fecha: `await doc.destroy()`.
 * O objeto devolvido é o documento do pdf.js com `runtime` pendurado (o render
 * das figuras usa o mesmo canvas).
 */
async function openPdf(buffer) {
  const runtime = await loadRuntime();
  const { pdfjs, createCanvas, pdfjsDir } = runtime;
  const CanvasFactory = makeCanvasFactory(createCanvas);
  // O pdf.js transfere (e esvazia) o ArrayBuffer que recebe: copia para não
  // estragar o Buffer de quem chamou.
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      fontExtraProperties: true,
      useSystemFonts: false,
      canvasFactory: new CanvasFactory(),
      standardFontDataUrl: `${path.join(pdfjsDir, 'standard_fonts')}/`,
      cMapUrl: `${path.join(pdfjsDir, 'cmaps')}/`,
      cMapPacked: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new InvalidPdfError(err);
  }
  doc.runtime = { ...runtime, CanvasFactory };
  return doc;
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Tira o prefixo de subconjunto ("ABCDEF+ArialMT" → "ArialMT"). */
function cleanFontName(name) {
  return String(name || '').replace(/^[A-Z]{6}\+/, '');
}

/** O pdf.js não marca negrito/itálico com confiança: o nome da fonte decide. */
function fontStyle(name) {
  const n = String(name || '');
  return {
    bold: /Bold|Black|Heavy|Semibold|Demi|,B\b/i.test(n),
    italic: /Italic|Oblique|,I\b/i.test(n),
  };
}

function bboxOf(points) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Parte do retângulo que fica dentro do recorte (null se nada). Linha reta
 * tem largura ou altura zero — vale estar na borda.
 */
function clipBox(b, clip) {
  if (!clip) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const x0 = Math.max(b.x, clip.x);
  const y0 = Math.max(b.y, clip.y);
  const x1 = Math.min(b.x + b.w, clip.x + clip.w);
  const y1 = Math.min(b.y + b.h, clip.y + clip.h);
  if (x1 < x0 - 0.01 || y1 < y0 - 0.01) return null;
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Pontos de uma curva de Bézier cúbica (o suficiente para o retângulo dela). */
function bezierPoints(p0, p1, p2, p3, n = 12) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

function colorHex(args) {
  if (!args) return null;
  if (typeof args[0] === 'string') return args[0];
  if (args.length >= 3) {
    return `#${[args[0], args[1], args[2]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

/**
 * Percorre a lista de operadores da página acumulando a matriz corrente e
 * devolve as imagens e os desenhos vetoriais com o retângulo em coordenadas de
 * página (já viradas para y crescendo para baixo), e os glifos de cada fonte
 * na ordem em que foram desenhados — com o código original e o espaço que
 * sobra antes de cada um dentro do mesmo "mostra texto" (em fração do corpo):
 * é com isso que alignGlyphs separa o espaço de verdade do espaço que o
 * pdf.js inventa numa linha justificada ("mast r o" no lugar de "mastro").
 */
function walkOperators(OPS, Util, opList, viewport) {
  const PAINT = new Map([
    [OPS.stroke, 'stroke'], [OPS.closeStroke, 'stroke'],
    [OPS.fill, 'fill'], [OPS.eoFill, 'fill'],
    [OPS.fillStroke, 'fillStroke'], [OPS.eoFillStroke, 'fillStroke'],
    [OPS.closeFillStroke, 'fillStroke'], [OPS.closeEOFillStroke, 'fillStroke'],
    [OPS.endPath, 'none'],
  ]);
  const IMAGE = new Map([
    [OPS.paintImageXObject, 'image'], [OPS.paintInlineImageXObject, 'inline'],
    [OPS.paintImageMaskXObject, 'mask'], [OPS.paintImageXObjectRepeat, 'imageRepeat'],
    [OPS.paintImageMaskXObjectRepeat, 'maskRepeat'], [OPS.paintSolidColorImageMask, 'solidMask'],
    [OPS.paintInlineImageXObjectGroup, 'inlineGroup'], [OPS.paintImageMaskXObjectGroup, 'maskGroup'],
  ]);
  const toPage = (x, y) => viewport.convertToViewportPoint(x, y);
  let ctm = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  let stroke = '#000000';
  let fill = '#000000';
  let font = null;
  // estado de texto (vale como o resto do estado gráfico: q/Q guarda e volta)
  let fontSize = 1;
  let charSpacing = 0;
  let wordSpacing = 0;
  const stack = [];
  const images = [];
  const paths = [];
  const glyphs = [];
  let run = 0;
  let pending = null;
  let formDepth = 0;
  // recorte (clip) corrente, em coordenadas de página: imagem e desenho só
  // aparecem dentro dele. Foto recortada no diagramador é maior que o que se vê
  // (a do ENEM 2023 dia 2 Q114 ia 50 pt para dentro da outra coluna).
  let clip = null;
  let clipPending = false;
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const a = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push({ ctm: ctm.slice(), lineWidth, stroke, fill, font, clip, fontSize, charSpacing, wordSpacing });
        break;
      case OPS.restore: {
        const s = stack.pop();
        if (s) ({ ctm, lineWidth, stroke, fill, font, clip, fontSize, charSpacing, wordSpacing } = s);
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        clipPending = true;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, a);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ctm: ctm.slice(), lineWidth, stroke, fill, font, clip, fontSize, charSpacing, wordSpacing });
        formDepth += 1;
        if (a && a[0]) ctm = Util.transform(ctm, a[0]);
        break;
      case OPS.paintFormXObjectEnd: {
        const s = stack.pop();
        if (s) ({ ctm, lineWidth, stroke, fill, font, clip, fontSize, charSpacing, wordSpacing } = s);
        formDepth = Math.max(0, formDepth - 1);
        break;
      }
      case OPS.setCharSpacing:
        charSpacing = Number(a[0]) || 0;
        break;
      case OPS.setWordSpacing:
        wordSpacing = Number(a[0]) || 0;
        break;
      case OPS.shadingFill:
        // degradê pintado no recorte corrente (o teto da mola, a faixa de um
        // gráfico): é desenho como outro qualquer — sem ele, a figura perdia
        // o pedaço
        if (clip && clip.w > 0.5 && clip.h > 0.5) {
          paths.push({ x: r2(clip.x), y: r2(clip.y), w: r2(clip.w), h: r2(clip.h), paint: 'fill', rect: 1, line: 0, curve: 0, lw: 0, fc: null, shading: true });
        }
        break;
      case OPS.setLineWidth:
        lineWidth = a[0];
        break;
      case OPS.setStrokeRGBColor:
        stroke = colorHex(a);
        break;
      case OPS.setFillRGBColor:
        fill = colorHex(a);
        break;
      case OPS.setFont:
        font = a[0];
        fontSize = Math.abs(Number(a[1])) || 1;
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        // cada glifo com o código original (fonte sem tabela de caracteres:
        // o texto do pdf.js troca alguns códigos por espaço — ver decode.js) e
        // a folga antes dele: espaçamento entre letras (Tc) mais o ajuste do
        // TJ, em fração do corpo
        if (fn === OPS.nextLineSetSpacingShowText) {
          wordSpacing = Number(a[0]) || 0;
          charSpacing = Number(a[1]) || 0;
        }
        if (!font) break;
        const arr = fn === OPS.nextLineSetSpacingShowText ? a[2] : a[0];
        if (!Array.isArray(arr)) break;
        run += 1;
        let adjust = 0;
        let first = true;
        let prevSpace = false;
        for (const g of arr) {
          if (typeof g === 'number') {
            adjust -= g / 1000;
            continue;
          }
          if (!g || typeof g !== 'object') continue;
          const gap = first ? null : charSpacing / fontSize + adjust + (prevSpace ? wordSpacing / fontSize : 0);
          glyphs.push({ u: g.unicode, c: g.originalCharCode, gap, run, sp: !!g.isSpace, font });
          adjust = 0;
          first = false;
          prevSpace = !!g.isSpace;
        }
        break;
      }
      case OPS.constructPath: {
        const [ops, pargs] = a;
        const pts = [];
        let nRect = 0;
        let nLine = 0;
        let nCurve = 0;
        // ponto corrente: a curva começa nele. O retângulo da curva é o da
        // própria curva, não o dos pontos de controle (a parábola de um saque
        // de vôlei tem o controle 20 pt acima do topo — e a figura subia sobre
        // a linha de texto de cima).
        let cur = [0, 0];
        for (let k = 0, j = 0; k < ops.length; k += 1) {
          switch (ops[k] | 0) {
            case OPS.rectangle: {
              const x = pargs[j];
              const y = pargs[j + 1];
              const w = pargs[j + 2];
              const h = pargs[j + 3];
              j += 4;
              pts.push([x, y], [x + w, y], [x, y + h], [x + w, y + h]);
              cur = [x, y];
              nRect += 1;
              break;
            }
            case OPS.moveTo:
              cur = [pargs[j], pargs[j + 1]];
              pts.push(cur);
              j += 2;
              break;
            case OPS.lineTo:
              cur = [pargs[j], pargs[j + 1]];
              pts.push(cur);
              j += 2;
              nLine += 1;
              break;
            case OPS.curveTo: {
              const end = [pargs[j + 4], pargs[j + 5]];
              pts.push(...bezierPoints(cur, [pargs[j], pargs[j + 1]], [pargs[j + 2], pargs[j + 3]], end));
              cur = end;
              j += 6;
              nCurve += 1;
              break;
            }
            case OPS.curveTo2: { // "v": o primeiro controle é o ponto corrente
              const end = [pargs[j + 2], pargs[j + 3]];
              pts.push(...bezierPoints(cur, cur, [pargs[j], pargs[j + 1]], end));
              cur = end;
              j += 4;
              nCurve += 1;
              break;
            }
            case OPS.curveTo3: { // "y": o segundo controle é o ponto final
              const end = [pargs[j + 2], pargs[j + 3]];
              pts.push(...bezierPoints(cur, [pargs[j], pargs[j + 1]], end, end));
              cur = end;
              j += 4;
              nCurve += 1;
              break;
            }
            default:
              break;
          }
        }
        if (!pts.length) break;
        const pagePts = pts.map(([x, y]) => {
          const [ux, uy] = Util.applyTransform([x, y], ctm);
          return toPage(ux, uy);
        });
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
        pending = { ...bboxOf(pagePts), nRect, nLine, nCurve, lw: lineWidth * scale, stroke, fill, form: formDepth };
        break;
      }
      default: {
        if (PAINT.has(fn)) {
          const paint = PAINT.get(fn);
          // o caminho do clip vale depois de pintado (W n)
          const shape = pending;
          if (pending && paint !== 'none') {
            const box = clipBox(pending, clip);
            if (!box) {
              pending = null;
              if (clipPending && shape) clip = clipBox(shape, clip) || { x: 0, y: 0, w: 0, h: 0 };
              clipPending = false;
              break;
            }
            const p = {
              x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h), paint,
              rect: pending.nRect, line: pending.nLine, curve: pending.nCurve, lw: r2(pending.lw),
            };
            if (paint !== 'fill') p.sc = pending.stroke;
            if (paint !== 'stroke') p.fc = pending.fill;
            if (pending.form) p.form = pending.form;
            paths.push(p);
          }
          if (clipPending && shape) clip = clipBox(shape, clip) || { x: 0, y: 0, w: 0, h: 0 };
          clipPending = false;
          pending = null;
        } else if (IMAGE.has(fn)) {
          const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => {
            const [ux, uy] = Util.applyTransform([x, y], ctm);
            return toPage(ux, uy);
          });
          const bb = clipBox(bboxOf(corners), clip);
          if (!bb) break;
          const img = { x: r2(bb.x), y: r2(bb.y), w: r2(bb.w), h: r2(bb.h), kind: IMAGE.get(fn) };
          if (formDepth) img.form = formDepth;
          // imagem posta girada na página (a largura dela anda na vertical): o ângulo, como o do texto girado
          const angle = Math.round((Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]) * 180) / Math.PI);
          if (Math.abs(angle) > 1) img.angle = angle;
          images.push(img);
        }
      }
    }
  }
  return { images, paths, glyphs };
}

/**
 * Orientação de um item pela matriz (em coordenadas de página, y para baixo):
 * linha de base fora da horizontal = girado (rótulo de eixo); horizontal mas
 * andando para a esquerda = de cabeça para baixo; o "para cima" inclinado com
 * a base na horizontal é itálico sintético (o título "¿QUÉ ME PASA?:" do ENEM
 * 2023 vinha assim e era tratado como texto girado — sumia do enunciado).
 */
function orientation(tx) {
  const along = Math.hypot(tx[0], tx[1]) || 1;
  const horizontal = Math.abs(tx[1]) <= 0.02 * along;
  if (!horizontal) return { rotated: true, inverted: false, sheared: false };
  if (tx[0] < 0 && tx[3] > 0) return { rotated: false, inverted: true, sheared: false };
  if (tx[0] < 0 || tx[3] > 0) return { rotated: true, inverted: false, sheared: false };
  return { rotated: false, inverted: false, sheared: Math.abs(tx[2]) > 0.05 * Math.abs(tx[3]) };
}

/** O que dá para saber da fonte (nome real, tipo, se tem tabela ToUnicode). */
function fontInfo(page, loadedName) {
  let f = null;
  try {
    f = page.commonObjs.get(loadedName);
  } catch {
    f = null;
  }
  if (!f) return { name: '', type: '', toUnicode: true, symbolic: false };
  // Sem tabela de verdade o pdf.js monta um mapa "identidade" ({firstChar,
  // lastChar}): o texto sai com o próprio código do glifo — é o caso da fonte
  // embaralhada do PPL 2017.
  let toUnicode = false;
  if (f.toUnicode && f.toUnicode._map) toUnicode = Object.keys(f.toUnicode._map).length > 0;
  return {
    name: cleanFontName(f.name),
    type: String(f.type || ''),
    subtype: String(f.subtype || ''),
    toUnicode,
    symbolic: !!f.isSymbolicFont,
  };
}

/** Folga máxima (fração do corpo) de um espaço que o pdf.js inventou dentro da palavra. */
const FOLGA_DE_LETRA = 0.13;
/** Quantos glifos à frente procurar o começo de um item (o pdf.js às vezes reordena). */
const JANELA_DE_SINCRONIA = 400;

/**
 * Alinha o texto do pdf.js com os glifos desenhados (os dois seguem a ordem
 * do conteúdo da página) e corrige o que o texto perdeu ou inventou:
 *
 *   - espaço inventado: numa linha justificada com espaçamento entre letras
 *     (o ENEM 2023 dia 2 justifica assim), a folga de algumas letras passa do
 *     limite do pdf.js e ele põe um espaço no meio da palavra — "O mast r o de
 *     uma ban de ir a fo i inst alad o". Espaço sem glifo de espaço, entre duas
 *     letras do mesmo "mostra texto" e com folga de letra (< 0,13 do corpo) sai;
 *   - fonte sem ToUnicode (a embaralhada do PPL 2017): cada caractere ganha o
 *     código original (`codes`, null onde o espaço não é glifo). O pdf.js troca
 *     por espaço os códigos "brancos" (9 a 13 — "(" e ")" nessa fonte) e some
 *     com o 173 (hífen opcional — o "Ã" nessa fonte): o glifo que o texto pulou
 *     vira `ins` ({ at, codes }); o que ficou entre dois itens vira `trail` do
 *     anterior (outra fonte depois) ou `lead` do seguinte — o decode.js decide
 *     se ele fecha o item anterior ("no(a" + ")") ou abre este.
 *
 * O alinhamento é item a item: o começo de cada item é procurado nos glifos à
 * frente (o nome de fonte que o pdf.js põe no item nem sempre é o do glifo, e
 * a ordem às vezes muda). Item que não alinha fica como o pdf.js deu.
 */
function alignGlyphs(texts, glyphs, wantCodes = () => false) {
  const isSpaceGlyph = (g) => !!g && (g.sp || (typeof g.u === 'string' && g.u !== '' && /^\s+$/.test(g.u)));
  const unicodeOf = (g) => (g && typeof g.u === 'string' ? g.u : '');
  // o glifo casa com o texto a partir da posição i? devolve quantos caracteres
  const take = (g, str, i) => {
    if (!g) return 0;
    if (/\s/.test(str[i])) return isSpaceGlyph(g) ? 1 : 0;
    const u = unicodeOf(g);
    if (!u || isSpaceGlyph(g)) return 0;
    if (str.startsWith(u, i)) return u.length;
    const n = u.normalize('NFKC');
    if (n !== u && str.startsWith(n, i)) return n.length;
    return 0;
  };
  // começo do item a partir de `from`: os primeiros caracteres visíveis casam
  // em sequência, glifo a glifo (sem pular nada — pular deixa casar no lugar
  // errado e desalinha a página inteira)
  const syncAt = (from, str) => {
    const j0 = str.search(/\S/);
    if (j0 < 0) return -1;
    const need = Math.min(4, str.slice(j0).replace(/\s/g, '').length);
    const limit = Math.min(glyphs.length, from + JANELA_DE_SINCRONIA);
    for (let p = from; p < limit; p += 1) {
      if (!take(glyphs[p], str, j0)) continue;
      let i = j0;
      let q = p;
      let ok = 0;
      while (i < str.length && ok < need) {
        if (/\s/.test(str[i]) && !isSpaceGlyph(glyphs[q])) {
          i += 1;
          continue;
        }
        const n = take(glyphs[q], str, i);
        if (!n) break;
        i += n;
        q += 1;
        // (contam os caracteres: a ligadura "ﬁ" vale "f" e "i")
        ok += /\s/.test(str[i - n]) ? 0 : n;
      }
      if (ok >= need) return p;
    }
    return -1;
  };
  let gi = 0;
  let prevItem = null;
  for (const t of texts) {
    const str = t.str;
    const start = syncAt(gi, str);
    if (start < 0) continue;
    const codesWanted = wantCodes(t.fontId);
    // glifos pulados entre o fim do item anterior e o começo deste (poucos):
    // da fonte deste, podem abri-lo; só da fonte do anterior, fecham o anterior
    const between = start - gi <= 3 ? glyphs.slice(gi, start).filter((g) => g.c != null) : [];
    const before = between.filter((g) => g.font === t.fontId);
    const trail = between.filter((g) => g.font !== t.fontId && prevItem && g.font === prevItem.fontId);
    if (trail.length && prevItem && prevItem.codes) prevItem.trail = trail.map((g) => g.c);
    gi = start;
    const chars = [];
    const ins = [];
    const drop = new Set();
    let misses = 0;
    let i = 0;
    // espaço do começo do item (antes do primeiro visível) não é glifo. Se
    // a letra de antes é do mesmo "mostra texto" e a folga é de letra, o
    // pdf.js partiu a palavra ("graç" + " a, chamam-me")
    while (i < str.length && /\s/.test(str[i]) && !isSpaceGlyph(glyphs[gi])) {
      const prev = glyphs[gi - 1];
      const next = glyphs[gi];
      if (i === 0 && str.length > 1 && /\p{L}/u.test(str[1]) && prev && next && prev.run === next.run
        && /\p{L}$/u.test(unicodeOf(prev)) && next.gap != null && next.gap < FOLGA_DE_LETRA) drop.add(0);
      chars.push(null);
      i += 1;
    }
    while (i < str.length) {
      const n = take(glyphs[gi], str, i);
      if (n) {
        for (let k = 0; k < n; k += 1) chars.push(k === 0 ? glyphs[gi].c : null);
        gi += 1;
        i += n;
        continue;
      }
      if (/\s/.test(str[i])) {
        // o glifo de espaço logo adiante (depois de um glifo que o texto não
        // tem): é espaço de verdade
        // (se o glifo daqui já é a letra seguinte, o espaço não tem glifo)
        if (!take(glyphs[gi], str, i + 1)) {
          let k = 1;
          while (k <= 3 && glyphs[gi + k] && !isSpaceGlyph(glyphs[gi + k])) k += 1;
          if (k <= 3 && glyphs[gi + k] && take(glyphs[gi + k + 1], str, i + 1)) {
            gi += k;
            continue;
          }
        }
        // espaço que não é glifo: o pdf.js mediu a folga e inventou. Só sai se o
        // glifo seguinte é mesmo a letra seguinte (alinhamento seguro)
        const prev = glyphs[gi - 1];
        const next = glyphs[gi];
        if (i > 0 && i < str.length - 1 && /\p{L}/u.test(str[i - 1]) && /\p{L}/u.test(str[i + 1])
          && prev && next && prev.run === next.run && next.gap != null && next.gap < FOLGA_DE_LETRA
          && take(next, str, i + 1) && take(prev, str, i - (unicodeOf(prev).length || 1))) {
          drop.add(i);
        }
        chars.push(null);
        i += 1;
        continue;
      }
      // glifo que não aparece no texto (o pdf.js tirou): pula até 3
      let k = 1;
      while (k <= 3 && !take(glyphs[gi + k], str, i)) k += 1;
      if (k <= 3) {
        const skipped = glyphs.slice(gi, gi + k).filter((g) => g.c != null && g.font === t.fontId).map((g) => g.c);
        if (skipped.length) ins.push({ at: chars.length - [...drop].filter((d) => d < i).length, codes: skipped });
        gi += k;
        continue;
      }
      misses += 1;
      chars.push(str.codePointAt(i));
      i += 1;
    }
    if (misses > Math.max(1, 0.1 * str.length)) continue;
    prevItem = t;
    if (drop.size) t.str = str.split('').filter((_, k) => !drop.has(k)).join('');
    if (!codesWanted) continue;
    const codes = chars.filter((_, k) => !drop.has(k));
    if (codes.length === [...t.str].length) t.codes = codes;
    if (ins.length) t.ins = ins;
    if (before.length && before.length <= 3) t.lead = before.map((g) => g.c);
  }
}

/**
 * Layout de uma página: texto, imagens e desenhos. `fonts` acumula as fontes
 * do documento (chave = id da fonte nesta abertura do PDF).
 */
async function pageLayout(doc, pageNumber, fonts) {
  const { pdfjs } = doc.runtime;
  const { OPS, Util } = pdfjs;
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const opList = await page.getOperatorList();
    const content = await page.getTextContent();
    const texts = [];
    for (const it of content.items) {
      if (!('str' in it) || it.str === '') continue;
      const tx = Util.transform(viewport.transform, it.transform);
      const { rotated, inverted, sheared } = orientation(tx);
      // corpo: a altura do "para cima"; no texto inclinado (itálico sintético,
      // a matriz tem cisalhamento) é só a componente vertical
      const fs = rotated ? Math.hypot(tx[2], tx[3]) : Math.abs(tx[3]) || Math.hypot(tx[2], tx[3]);
      const h = it.height || fs;
      if (!fonts[it.fontName]) fonts[it.fontName] = fontInfo(page, it.fontName);
      const info = fonts[it.fontName];
      const style = fontStyle(info.name);
      const t = {
        x: r2(tx[4]), y: r2(tx[5] - h), w: r2(it.width), h: r2(h), base: r2(tx[5]), fs: r2(fs),
        font: info.name || it.fontName, fontId: it.fontName, str: it.str,
      };
      if (style.bold) t.bold = true;
      if (style.italic || sheared) t.italic = true;
      if (inverted) {
        // glifo de cabeça para baixo: é assim que o diagramador faz o "¿" e o
        // "¡" do espanhol ("?" girado 180°). Ele anda para a esquerda e desce
        // da linha de base; vira o sinal certo, no lugar certo da linha.
        const s = it.str.trim();
        // reticências e traços de cabeça para baixo são os mesmos sinais
        const symmetric = /^[.\-_–—…·*~=\s]+$/.test(s);
        if (s === '?' || s === '!' || symmetric) {
          t.str = s === '?' ? '¿' : s === '!' ? '¡' : it.str;
          t.x = r2(tx[4] - it.width);
          t.base = r2(tx[5] + (symmetric ? 0.12 : 0.5) * fs);
          t.y = r2(t.base - fs);
          t.h = r2(fs);
          texts.push(t);
          continue;
        }
      }
      if (rotated || inverted) {
        // texto girado (rótulo de eixo de gráfico): o retângulo de verdade, para
        // a figura que o contém crescer até ele — no texto ele nunca entra
        t.rot = true;
        // direção da linha de base, em graus (y para baixo): -90 = lido de
        // baixo para cima (a tabela periódica deitada na página em pé)
        t.angle = Math.round((Math.atan2(tx[1], tx[0]) * 180) / Math.PI);
        const along = Math.hypot(tx[0], tx[1]) || 1;
        const up = Math.hypot(tx[2], tx[3]) || 1;
        const dx = (tx[0] / along) * it.width;
        const dy = (tx[1] / along) * it.width;
        const ux = (tx[2] / up) * h;
        const uy = (tx[3] / up) * h;
        const bb = bboxOf([[tx[4], tx[5]], [tx[4] + dx, tx[5] + dy], [tx[4] + ux, tx[5] + uy], [tx[4] + dx + ux, tx[5] + dy + uy]]);
        Object.assign(t, { x: r2(bb.x), y: r2(bb.y), w: r2(bb.w), h: r2(bb.h) });
      }
      texts.push(t);
    }
    // código original só das fontes sem tabela de caracteres (decode.js)
    const wantCodes = (id) => {
      if (!fonts[id]) fonts[id] = fontInfo(page, id);
      return fonts[id].toUnicode === false && !!fonts[id].name;
    };
    const { images, paths, glyphs } = walkOperators(OPS, Util, opList, viewport);
    alignGlyphs(texts, glyphs, wantCodes);
    return { page: pageNumber, width: r2(viewport.width), height: r2(viewport.height), texts, images, paths };
  } finally {
    page.cleanup();
  }
}

/**
 * Layout do documento inteiro, página por página (sem segurar as páginas
 * abertas). `{ pages, fonts }` — fonts por id, com nome, tipo e ToUnicode.
 */
async function extractLayout(doc, { onPage } = {}) {
  const fonts = {};
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    pages.push(await pageLayout(doc, p, fonts));
    if (onPage) onPage(p, doc.numPages);
  }
  return { pages, fonts };
}

module.exports = {
  ReaderUnavailableError,
  InvalidPdfError,
  loadRuntime,
  openPdf,
  extractLayout,
  pageLayout,
  cleanFontName,
  fontStyle,
  orientation,
  walkOperators,
  alignGlyphs,
};

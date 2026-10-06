'use strict';

/**
 * Figuras das questões: o que é figura, que texto pertence a ela, e o recorte
 * em PNG.
 *
 *   const { detectFigures, renderFigures } = require('./figures');
 *   const { figures, absorbed } = detectFigures(pagina, { markLines, letterItems, bodyFs });
 *   await renderFigures(doc, questoes);   // põe `png` (Buffer) em cada figura
 *
 * O leitor antigo não capturava imagem nenhuma: gráfico, mapa, charge e tabela
 * sumiam, e os rótulos soltos ("0 10 20 30", "Frasco I II III", "CH₃") caíam
 * no enunciado como lixo. Aqui a decisão é geométrica, por página e coluna:
 *
 *   1. imagens e desenhos vetoriais do corpo, sem os ornamentos conhecidos
 *      (fio e enfeite do "QUESTÃO", fio de coluna e de fim de coluna, caixinha
 *      da letra da alternativa, moldura, máscara branca), são unidos por
 *      proximidade dentro da coluna;
 *   2. fios horizontais empilhados com texto entre eles viram TABELA — recortada
 *      como imagem, porque o texto solto das células não se lê;
 *   3. a figura cresce com o texto que é dela: tudo o que está dentro do
 *      retângulo e, perto da borda, o que tem cara de rótulo (número de eixo,
 *      texto girado, letra miúda, legenda curta centrada, linha de várias
 *      células). Esse texto sai do enunciado — não aparece duas vezes;
 *   4. figuras vizinhas sem texto corrido entre elas viram uma só (as seis
 *      estruturas químicas da 2022 Q102 com as legendas no meio), a não ser que
 *      cada uma esteja ao lado de uma letra de alternativa diferente;
 *   5. fórmula desenhada em curvas no meio de uma frase ("Dado Z = 2√2(…), o
 *      afixo…") ou símbolo desenhado numa alternativa (a raiz de "11√2") não é
 *      figura: a linha fica marcada como fórmula e questions.js recorta a
 *      linha (ou a alternativa) inteira com formulaFigure;
 *   6. o recorte é o retângulo com uma folga pequena, que só avança sobre
 *      espaço vazio (nunca sobre texto de fora), renderizado da página em
 *      escala 2.
 *
 * Quando a figura encosta na borda do corpo, atravessa a coluna ou cobre texto
 * que não é dela, ela vai marcada (`uncertain`) e a questão ganha o alerta
 * 'figura_incerta' — a conferência no painel olha o recorte.
 *
 * Coordenadas como em layout.js (pontos, origem no canto superior esquerdo).
 * A detecção é pura (testável com layouts sintéticos); só renderFigures usa o
 * pdf.js.
 */
const { joinItems, unionByProximity, finishLine, columnOfBox } = require('./structure');

/** Folga da união de desenhos e imagens. */
const GAP = 6;
/** Distância máxima de um rótulo à borda da figura. */
const LABEL_GAP = 10;
/** Distância máxima da legenda logo abaixo da figura (fileira de legendas: um pouco mais). */
const CAPTION_GAP = 18;
const CAPTION_ROW_GAP = 28;
/** Folga do recorte em volta da figura (só sobre espaço vazio). */
const PAD = 4;
/** Escala do recorte (2 = 144 dpi). */
const SCALE = 2;

/** Referência bibliográfica: fica no texto, nunca vira rótulo de figura. */
const REFERENCIA = /Dispon[íi]vel|Acesso\s+em|www\.|https?:|\(adaptado\)|adaptado\.|^Fonte:|Adaptado\s+de|^\(?[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{2,}[A-ZÁÉÍÓÚÂÊÔÃÕÇ\s-]*,\s+[A-Z]\.|[Aa]daptado\.?\)|^\(.{3,}\b(?:1[5-9]|20)\d\d\b.*\)\.?$|,\s*(?:1[5-9]|20)\d\d\.$/;
/** "TEXTO I", "Texto II" — título do texto, fica no enunciado. */
const TITULO_TEXTO = /^text(?:o|os)?\s+[ivx\d]+\b/i;
/** Rótulo numérico de eixo, escala, cota ("10 cm", "0,5", "2010", "25%"). */
const NUMERICO = /^[\d\s.,%‰°ºª+\-−–×x/:()=<>≤≥$R]*\d[\d\s.,%‰°ºª+\-−–×x/:()=<>≤≥]*(?:\s?(?:cm|mm|km|m|g|kg|mg|L|mL|s|h|min|ºC|°C|K|N|J|W|V|A|Hz|anos?))?$/;
/** Fonte de letra de alternativa (círculo do ENEM). */
const FONTE_LETRA = /Bundesbahn|PiStd|Dingbat|ZapfDingbats/i;

/** Tem palavras de verdade (frase), não só sigla, número ou rótulo. */
const PALAVRAS = /\p{L}+[\s,]+\p{L}*\p{Ll}{3,}|\p{Ll}{3,}\p{L}*[\s,]+\p{L}{2,}/u;

/**
 * Fileira de eixo: quase tudo número ("1960 1970 … 2050", "0 5 10 … 55 x
 * (km)"), o resto palavrinha de unidade ou nome de eixo.
 */
function axisRow(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((t) => t.length > 8)) return false;
  const numeric = tokens.filter((t) => /^[\d.,%‰°+\-−–/():]+$/.test(t) && /\d/.test(t)).length;
  if (tokens.length === 1) return numeric === 1;
  return tokens.length >= 3 && numeric / tokens.length >= 0.6;
}

/** Linha de texto corrido: corpo do texto, longa, com várias palavras. */
function proseLike(s, bodyFs) {
  const text = s.text.trim();
  if (s.rot || text.length <= 45 || Math.abs(s.fs - bodyFs) > 1.2) return false;
  return (text.match(/\p{Ll}{4,}/gu) || []).length >= 4;
}

const isWhite = (c) => typeof c === 'string' && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(c);

/**
 * Caixa visível de um item de texto: da altura da maiúscula à perna do "p"
 * (a de layout.js vai do topo do corpo à linha de base, e sobrepõe a linha
 * de cima quando o rótulo da figura fica colado no texto).
 */
function visualBox(t) {
  if (t.rot) return { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h };
  if (t.fraction) return { x0: t.x, y0: t.fraction.y0, x1: t.x + t.w, y1: t.fraction.y1 };
  const fs = t.fs || t.h || 10;
  return { x0: t.x, y0: t.base - 0.78 * fs, x1: t.x + t.w, y1: t.base + 0.22 * fs };
}

function intersects(a, b, tol = 0) {
  return a.x0 < b.x1 + tol && b.x0 < a.x1 + tol && a.y0 < b.y1 + tol && b.y0 < a.y1 + tol;
}

function grow(box, b) {
  box.x0 = Math.min(box.x0, b.x0);
  box.y0 = Math.min(box.y0, b.y0);
  box.x1 = Math.max(box.x1, b.x1);
  box.y1 = Math.max(box.y1, b.y1);
}

/**
 * Pedaços de uma linha separados por vão grande (células de tabela, legendas
 * lado a lado). A letra da alternativa é sempre um pedaço só dela.
 */
function splitSegments(line, isLetter, col = null) {
  const items = line.items.filter((t) => t.str !== '').slice().sort((a, b) => a.x - b.x);
  // linha de prosa justificada (da margem até a direita da coluna): os vãos
  // largos são do alinhamento, não de células — fica inteira
  const justified = col && line.x1 >= (col.right || col.x1) - 5 && line.x0 <= (col.margin ?? col.x0) + 20
    && line.text.length >= 25 && PALAVRAS.test(line.text);
  const segs = [];
  let cur = null;
  const close = () => {
    if (cur && cur.visible.length) {
      cur.text = joinItems(cur.visible);
      if (!cur.fs) cur.fs = Math.max(...cur.visible.map((t) => t.fs));
      segs.push(cur);
    }
    cur = null;
  };
  for (const t of items) {
    const visible = t.str.trim() !== '';
    const letter = visible && isLetter(t);
    if (cur && (letter || cur.letter || (!justified && visible && cur.visible.length && t.x - cur.x1 > Math.max(8, 1.2 * Math.max(t.fs, cur.fs))))) close();
    // (o corpo do pedaço é o das letras dele, não o do espaço que veio antes)
    if (!cur) cur = { items: [], visible: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, fs: visible ? t.fs : 0, letter };
    cur.items.push(t);
    if (visible) {
      cur.visible.push(t);
      grow(cur, visualBox(t));
      cur.fs = Math.max(cur.fs, t.fs);
    }
  }
  close();
  return segs;
}

/**
 * Fórmula desenhada em curvas no meio de uma frase ("Dado Z = 2√2(cos 7π/4 +
 * i·sen 7π/4), o afixo do número com-", com as letras da fórmula em
 * desenho): não é figura. Os desenhos saem da lista de figuras, e a linha fica
 * marcada como fórmula, com a altura da fórmula — o enunciado recorta a
 * linha inteira como imagem, no lugar dela. Linha de frase = tem palavras,
 * no corpo do texto; desenho dentro da faixa dela (de um corpo e meio acima
 * a um corpo abaixo), e não só fio (traço de fração que virou texto,
 * sublinhado).
 */
function inlineFormulas(P, bodyFs, letterItems = []) {
  const letterSet = new Set(letterItems);
  const out = new Set();
  const cols = P.columns;
  // (a caixinha em volta da letra da alternativa não é fórmula)
  const boxOfLetter = (p) => p.w <= 22 && p.h <= 18 && letterItems.some((t) => t.x >= p.x - 2 && t.x1 <= p.x + p.w + 2
    && t.cy >= p.y - 2 && t.cy <= p.y + p.h + 2);
  const glyph = glyphOfText(P);
  const cand = (P.paths || []).filter((p) => !p.fraction && p.h <= 6 * bodyFs && !(p.paint === 'fill' && isWhite(p.fc)) && !boxOfLetter(p) && !glyph(p));
  if (!cand.length) return out;
  // letras de uma fórmula em curvas ficam a alguns pontos uma da outra na
  // horizontal ("D = [0 15 4]"): o agrupamento olha mais longe para os lados
  const els = cand.map((p) => ({ x: p.x - 5, y: p.y, w: p.w + 10, h: p.h, col: columnOfBox(cols, p), path: p }));
  for (const g of unionByProximity(els, 3).values()) {
    const col = cols[g[0].col];
    const box = {
      x0: Math.min(...g.map((e) => e.path.x)), y0: Math.min(...g.map((e) => e.path.y)),
      x1: Math.max(...g.map((e) => e.path.x + e.path.w)), y1: Math.max(...g.map((e) => e.path.y + e.path.h)),
    };
    if (box.y1 - box.y0 > 6 * bodyFs || box.x1 - box.x0 > 0.6 * (col.x1 - col.x0)) continue;
    // só fio horizontal: sublinhado, traço de fração — não é fórmula desenhada
    if (g.every((e) => e.h <= 1.5)) continue;
    // a linha de frase em que o desenho está encaixado: texto colado dos lados
    // (frase de verdade, não fileira de rótulos de um esquema: texto longo;
    // desenho centrado na linha — o esquema com setas desce da linha de
    // rótulos —; texto dos dois lados)
    // Na linha de alternativa ("B 11√2") vale o símbolo pequeno colado no
    // texto, de um lado só ou por cima dele (o traço da raiz cobre o "2").
    const host = col.lines.find((line, li) => {
      if (line.isMark || line.heading || Math.abs(line.fs - bodyFs) > 1.2) return false;
      const alt = line.items.some((t) => letterSet.has(t));
      if (alt && box.y1 - box.y0 > 2.5 * line.fs) return false;
      if (!alt && !PALAVRAS.test(line.text)) return false;
      // linha curta: fileira de rótulos de um esquema — a não ser que seja a
      // última linha de um parágrafo (a de cima vai até a margem, colada)
      const above = col.lines[li - 1];
      const lastOfParagraph = above && above.x1 >= (col.right || col.x1) - 5 && line.base > above.base
        && line.base - above.base <= 1.6 * line.fs && Math.abs(line.x0 - above.x0) <= 3;
      if (!alt && line.text.length < 25 && line.x1 - line.x0 < 0.5 * (col.x1 - col.x0) && !lastOfParagraph) return false;
      const y0 = line.base - 0.8 * line.fs;
      const y1 = line.base + 0.2 * line.fs;
      if (Math.min(y1, box.y1) - Math.max(y0, box.y0) <= 0) return false;
      const small = box.y1 - box.y0 <= 1.2 * line.fs;
      if (!small && Math.abs((box.y0 + box.y1) / 2 - (line.base - 0.3 * line.fs)) > 0.6 * line.fs) return false;
      const words = line.items.filter((t) => t.str.trim() && !letterSet.has(t));
      // desenho atrás das letras (fundo, marca-texto) não é fórmula — a não
      // ser um símbolo do tamanho de uma letra numa alternativa (a raiz de
      // "11√2" vem desenhada no meio do item "11 2")
      const symbol = alt && box.y1 - box.y0 <= 1.4 * line.fs && box.x1 - box.x0 <= 2 * line.fs;
      if (!symbol && words.some((t) => t.x < box.x1 - 1 && t.x1 > box.x0 + 1 && t.str.trim().length > 2)) return false;
      const left = words.some((t) => t.x1 <= box.x0 + 1 && box.x0 - t.x1 <= 20);
      const right = words.some((t) => t.x >= box.x1 - 1 && t.x - box.x1 <= 20);
      const under = words.some((t) => t.x < box.x1 - 1 && t.x1 > box.x0 + 1);
      return alt ? left || right || under : left && right;
    });
    if (!host) continue;
    for (const e of g) out.add(e.path);
    // linhas da altura do desenho (as fileiras de uma matriz, numerador e
    // denominador): todas fazem parte da fórmula
    for (const line of col.lines) {
      const cy = line.base - 0.3 * line.fs;
      if (line !== host && (cy < box.y0 - 2 || cy > box.y1 + 2)) continue;
      line.formula = true;
      const fb = line.formulaBox || { y0: Infinity, y1: -Infinity };
      line.formulaBox = { y0: Math.min(fb.y0, box.y0), y1: Math.max(fb.y1, box.y1) };
      // onde, na horizontal, está o desenho (a fórmula pode ser só um trecho da linha)
      line.formulaBoxes = [...(line.formulaBoxes || []), { ...box }];
    }
  }
  return out;
}

/**
 * Fio separador de coluna: vertical, fino, comprido, no vão entre as colunas
 * (ou na beira da página). Não basta ser comprido: a linha tracejada de
 * cota de um gráfico também é (a do ENEM 2023 Q55 tinha 234 pt e era tirada
 * do gráfico — a seta "1960 ↔ 2020" ficava de fora do recorte).
 */
function isColumnRule(p, P) {
  if (!(p.w <= 2.5 && p.h >= 0.3 * P.height)) return false;
  const cx = p.x + p.w / 2;
  if (P.columns && P.columns.length > 1 && Math.abs(cx - P.columns[0].x1) <= 12) return true;
  return cx < 0.08 * P.width || cx > 0.92 * P.width;
}

/**
 * Letras de alternativa entre as candidatas (letra em negrito sozinha): a do
 * círculo do ENEM e a "(A)" valem sempre. A letra solta vale se estiver numa
 * coluna de letras do mesmo estilo em ordem (A, B, C… de cima para baixo;
 * em grade, cada coluna em ordem) com ao menos duas seguidas, ou se tiver o
 * texto da alternativa logo depois, no mesmo corpo. Vértice de figura ("E" e
 * "A" um embaixo do outro, "C" e "B" soltos) não passa.
 */
function alternativeLetters(letterItems, P, bodyFs) {
  const strong = (t) => FONTE_LETRA.test(t.font || '') || /^\(?[A-E]\)/.test(t.str.trim());
  const ok = new Set(letterItems.filter(strong));
  const loose = letterItems.filter((t) => !strong(t));
  const groups = new Map();
  for (const t of loose) {
    const key = `${t.font || ''}|${Math.round(t.fs * 2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const list of groups.values()) {
    const clusters = [];
    for (const t of list.slice().sort((a, b) => a.x - b.x)) {
      const c = clusters.find((k) => Math.abs(k.x - t.x) <= 3);
      if (c) c.items.push(t);
      else clusters.push({ x: t.x, items: [t] });
    }
    for (const c of clusters) {
      const seq = c.items.slice().sort((a, b) => a.cy - b.cy);
      // sequências em ordem (uma questão depois da outra recomeça no A)
      let run = [seq[0]];
      const runs = [];
      for (let i = 1; i < seq.length; i += 1) {
        const prev = run[run.length - 1];
        if (seq[i].str.trim() > prev.str.trim() && seq[i].cy - prev.cy < 260) run.push(seq[i]);
        else {
          runs.push(run);
          run = [seq[i]];
        }
      }
      runs.push(run);
      for (const r of runs) if (r.length >= 2) for (const t of r) ok.add(t);
    }
  }
  // o texto da alternativa logo depois da letra, no corpo do texto
  for (const t of loose) {
    if (ok.has(t) || Math.abs(t.fs - bodyFs) > 1.2) continue;
    const line = (P.columns || []).flatMap((c) => c.lines).find((l) => l.items.includes(t));
    if (!line) continue;
    if (line.items.some((o) => o !== t && o.str.trim() && o.x >= t.x1 && o.x - t.x1 <= 24 && Math.abs(o.fs - t.fs) <= 1.2 && /\p{L}{2,}|\d/u.test(o.str))) ok.add(t);
  }
  return letterItems.filter((t) => ok.has(t));
}

/**
 * Texto desenhado em contorno (cada letra é um desenho preenchido, nenhum
 * item de texto): a tabela de treinos do ENEM 2022 Q177 inteira, "POSIÇÃO 1"
 * e "POSIÇÃO 2" sobre as fotos do VUNESP 2024 Q59, o "Tempo (min)" do eixo da
 * Q67. Cada palavra vira um grupo pequeno — e grupo pequeno não é figura: a
 * tabela sumia da questão. Grupos com cara de palavra (desenhos preenchidos
 * com curvas, da altura de uma letra) em fileira ou empilhados viram um grupo
 * só, e esse grupo é figura.
 */
function promoteDrawnText(groups, P, bodyFs) {
  const texts = (P.columns || []).flatMap((c) => c.lines).flatMap((l) => l.items).filter((t) => t.str.trim());
  const glyphLike = (g) => {
    if (g.raster || g.rulesOnly) return false;
    const w = g.x1 - g.x0;
    const h = g.y1 - g.y0;
    if (h < 0.5 * bodyFs || h > 1.7 * bodyFs || w > 14 * bodyFs) return false;
    // quase tudo letra preenchida (o pingo, a haste do "i" e o traço do "º" podem ser fio)
    if (!g.els.every((e) => e.path)) return false;
    const filled = g.els.filter((e) => e.path.paint !== 'stroke' && !e.hRule && !e.vRule);
    if (filled.length < 0.6 * g.els.length) return false;
    if (!filled.some((e) => (e.path.curve || 0) + (e.path.line || 0) >= 3)) return false;
    // não é desenho atrás de texto (marca-texto, fundo)
    return !texts.some((t) => t.x < g.x1 && t.x1 > g.x0 && t.cy > g.y0 && t.cy < g.y1);
  };
  const cand = groups.filter(glyphLike);
  if (cand.length < 2 && !cand.some((g) => g.els.length >= 6)) return groups;
  const els = cand.map((g, i) => ({ x: g.x0 - 2.2 * bodyFs, y: g.y0 - 0.6 * bodyFs, w: g.x1 - g.x0 + 4.4 * bodyFs, h: g.y1 - g.y0 + 1.2 * bodyFs, col: g.col, i }));
  const merged = new Set();
  const out = [];
  for (const members of unionByProximity(els, 0).values()) {
    const gs = members.map((e) => cand[e.i]);
    const glyphs = gs.reduce((n, g) => n + g.els.length, 0);
    if (gs.length < 3 && glyphs < 6) continue;
    for (const g of gs) merged.add(g);
    const big = groupOf(gs.flatMap((g) => g.els));
    big.drawnText = true;
    out.push(big);
  }
  if (!out.length) return groups;
  return [...groups.filter((g) => !merged.has(g)), ...out];
}

/**
 * Legendas lado a lado sob (ou sobre) figuras lado a lado: a 2024 Q19 tem
 * duas esculturas, cada uma com "TEXTO I"/"TEXTO II" em cima e três linhas de
 * legenda embaixo. Lidas linha a linha, as legendas se misturavam ("Anônimo.
 * Cabeça de uma figura feminina. MODIGLIANI, A. Cabeça de mulher.") e a obra
 * anônima parecia ser do Modigliani. Quando a figura tem partes separadas por
 * um vão na horizontal e as linhas coladas nela têm o mesmo vão, essas linhas
 * vão para a figura — o recorte mostra cada legenda sob a sua imagem.
 */
function sideBySideCaptions(figs, segments) {
  for (const f of figs) {
    if (f.small) continue;
    // vão entre as partes do desenho (imagens ou grupos lado a lado)
    const parts = f.els.map((e) => ({ x0: e.x, x1: e.x + e.w })).sort((a, b) => a.x0 - b.x0);
    const gaps = [];
    let reach = parts.length ? parts[0].x1 : 0;
    for (const p of parts.slice(1)) {
      if (p.x0 - reach >= 12) gaps.push({ x0: reach, x1: p.x0 });
      reach = Math.max(reach, p.x1);
    }
    if (!gaps.length) continue;
    const free = segments.filter((s) => !s.owner && !s.protected && !s.rot && s.col === f.col);
    const rows = new Map();
    for (const s of free) {
      if (!s.line) continue;
      if (!rows.has(s.line)) rows.set(s.line, []);
      rows.get(s.line).push(s);
    }
    // a linha se divide no vão: um pedaço de cada lado, nenhum atravessando
    const splitsAt = (segs, g) => segs.length >= 1 && segs.every((s) => s.x1 <= g.x1 + 30 || s.x0 >= g.x0 - 30)
      && segs.every((s) => !(s.x0 < g.x0 - 30 && s.x1 > g.x1 + 30))
      && segs.some((s) => (s.x0 + s.x1) / 2 < (g.x0 + g.x1) / 2) && segs.some((s) => (s.x0 + s.x1) / 2 > (g.x0 + g.x1) / 2);
    for (const dir of ['below', 'above']) {
      let edge = dir === 'below' ? f.y1 : f.y0;
      for (let k = 0; k < 6; k += 1) {
        const next = [...rows.entries()].filter(([line]) => (dir === 'below' ? line.y0 >= edge - 2 && line.y0 - edge <= 14 : line.y1 <= edge + 2 && edge - line.y1 <= 14))
          .sort(([a], [b]) => (dir === 'below' ? a.y0 - b.y0 : b.y1 - a.y1))[0];
        if (!next) break;
        const [line, segs] = next;
        const g = gaps.find((gp) => splitsAt(segs, gp));
        if (!g || segs.some((s) => s.x0 < f.x0 - 60 || s.x1 > f.x1 + 60)) break;
        for (const s of segs) take(f, s, 'legenda');
        rows.delete(line);
        edge = dir === 'below' ? line.y1 : line.y0;
      }
    }
  }
}

/**
 * O desenho é a própria letra de um item de texto (fonte Type 3: cada glifo
 * vem também como desenho — o "ℓ" do MT Extra no VUNESP 2024)? Devolve o
 * teste. Desenho inteiro dentro da caixa de um item visível.
 */
function glyphOfText(P) {
  const items = (P.columns || []).flatMap((c) => c.lines).flatMap((l) => l.items).filter((t) => t.str.trim());
  return (p) => items.some((t) => p.x >= t.x - 0.6 && p.x + p.w <= t.x1 + 0.6
    && p.y >= t.base - 1.1 * t.fs && p.y + p.h <= t.base + 0.35 * t.fs && p.w <= t.x1 - t.x + 1.2
    && !overSpace(p, t));
}

/**
 * Símbolo desenhado em cima de um ESPAÇO do item, não de uma letra dele: a
 * raiz de "11√2" vem desenhada no vão do item "11 2" (o item tem o espaço
 * largo no lugar dela). Não é a letra do texto — é o que falta nele. Só
 * desenho do tamanho de um símbolo (sublinhado e fundo de marca-texto, que
 * também caem em espaços, continuam sendo do texto).
 */
function overSpace(p, t) {
  if (!/\S\s+\S/.test(t.str)) return false;
  const fs = t.fs || t.h || 10;
  if (p.rect || p.w > 1.6 * fs || p.h < 0.5 * fs || (p.curve || 0) + (p.line || 0) < 3) return false;
  const cx = p.x + p.w / 2;
  const chars = [...t.str];
  const step = (t.x1 - t.x) / chars.length;
  const i = Math.floor((cx - t.x) / step);
  return i > 0 && i < chars.length - 1 && /\s/.test(chars[i]);
}

/**
 * Elementos gráficos da página que podem ser figura (imagens e desenhos), sem
 * os ornamentos conhecidos.
 */
function graphicElements(P, markLines, letterItems) {
  const W = P.width;
  const H = P.height;
  const cols = P.columns;
  const els = [];
  const glyph = glyphOfText(P);
  for (const p of P.paths || []) {
    if (p.w > 0.85 * W || p.h > 0.6 * H) continue; // moldura, faixa
    if (glyph(p)) continue; // a letra desenhada de um texto que já é texto
    if (isColumnRule(p, P)) continue; // separador de coluna
    if (p.paint === 'fill' && isWhite(p.fc)) continue; // máscara branca: não aparece
    if (p.paint === 'stroke' && isWhite(p.sc) && p.lw <= 2) continue;
    const cy = p.y + p.h / 2;
    // ornamento da marca: na faixa da marca (até 16 pt abaixo), começando à
    // direita do começo dela e dentro da coluna dela (o que começa na outra
    // coluna, na mesma altura, é de outra questão)
    if (p.h <= 18 && markLines.some((m) => m.page === P.page && cy >= m.y0 - 6 && cy <= m.y1 + 16
      && p.x >= m.x0 - 6 && p.x < (m.colX1 ?? W))) continue;
    // caixinha em volta da letra da alternativa
    if (p.w <= 22 && p.h <= 18 && letterItems.some((t) => t.x >= p.x - 2 && t.x1 <= p.x + p.w + 2 && t.cy >= p.y - 2 && t.cy <= p.y + p.h + 2)) continue;
    const col = columnOfBox(cols, p);
    els.push({
      x: p.x, y: p.y, w: p.w, h: p.h, col, raster: false,
      hRule: p.h <= 2.5 && p.w >= 8,
      vRule: p.w <= 2.5 && p.h >= 8,
      path: p,
    });
  }
  for (const im of P.images || []) {
    if (im.w > 0.95 * W && im.h > 0.6 * H) continue;
    if (im.w < 3 || im.h < 3) continue;
    els.push({ x: im.x, y: im.y, w: im.w, h: im.h, col: columnOfBox(cols, im), raster: true, image: im });
  }
  return els;
}

function groupOf(els) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const e of els) grow(box, { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h });
  return {
    els,
    col: els[0].col,
    ...box,
    draw: { ...box }, // só o desenho/imagem, sem os rótulos
    raster: els.some((e) => e.raster && e.w * e.h >= 150),
    vector: els.some((e) => !e.raster),
    rulesOnly: els.every((e) => e.hRule),
    labels: [],
    table: false,
  };
}

/**
 * Desenhos de alternativas empilhados quase colados (a folga entre um e outro
 * menor que a da união) caem no mesmo grupo: se há duas ou mais letras de
 * alternativa empilhadas à esquerda do grupo, cada desenho vai para a letra
 * mais perto na altura — uma figura por alternativa.
 */
function splitByLetters(els, letters, cols) {
  if (els.length < 2) return [els];
  const col = els[0].col;
  const x0 = Math.min(...els.map((e) => e.x));
  const y0 = Math.min(...els.map((e) => e.y));
  const y1 = Math.max(...els.map((e) => e.y + e.h));
  const beside = letters.filter((t) => columnOfBox(cols, t) === col && t.x1 <= x0 + 6 && x0 - t.x1 <= 150
    && t.cy >= y0 && t.cy <= y1);
  if (beside.length < 2) return [els];
  const xRef = beside[0].x;
  if (!beside.every((t) => Math.abs(t.x - xRef) < 4)) return [els];
  const parts = new Map(beside.map((t) => [t, []]));
  for (const e of els) {
    const cy = e.y + e.h / 2;
    let best = beside[0];
    for (const t of beside) if (Math.abs(t.cy - cy) < Math.abs(best.cy - cy)) best = t;
    parts.get(best).push(e);
  }
  const out = [...parts.values()].filter((p) => p.length);
  return out.length >= 2 ? out : [els];
}

/**
 * Tabelas de fios: fios horizontais (grupos só de fio) na mesma coluna, com
 * as mesmas pontas, empilhados a menos de 80 pt, com texto entre eles. Três
 * fios, ou dois com uma linha de várias células entre eles, já são tabela.
 */
function ruleTables(ruleGroups, segments) {
  const tables = [];
  const left = ruleGroups.filter((g) => g.x1 - g.x0 >= 50).sort((a, b) => a.y0 - b.y0);
  const used = new Set();
  for (const g of left) {
    if (used.has(g)) continue;
    const stack = [g];
    for (const o of left) {
      if (o === g || used.has(o) || o.col !== g.col) continue;
      const last = stack[stack.length - 1];
      if (o.y0 <= last.y0) continue;
      if (Math.abs(o.x0 - g.x0) > 4 || Math.abs(o.x1 - g.x1) > 4) continue;
      if (o.y0 - last.y1 > 80) break;
      stack.push(o);
    }
    if (stack.length < 2) continue;
    const box = { x0: g.x0, x1: g.x1, y0: stack[0].y0, y1: stack[stack.length - 1].y1 };
    const inside = segments.filter((s) => s.col === g.col && !s.rot && s.y0 >= box.y0 - 1 && s.y1 <= box.y1 + 1
      && s.x0 >= box.x0 - 4 && s.x1 <= box.x1 + 4);
    if (!inside.length) continue;
    const multi = inside.some((s) => s.cells >= 2);
    if (stack.length < 3 && !multi) continue;
    for (const s of stack) used.add(s);
    const t = groupOf(stack.flatMap((s) => s.els));
    t.table = true;
    tables.push(t);
  }
  return tables;
}

/**
 * Grupo que é só moldura (ou fundo) em volta de texto corrido: não é figura —
 * o texto do quadro continua sendo texto.
 */
function isFrame(g, segments) {
  if (g.raster) return false;
  const w = g.x1 - g.x0;
  const h = g.y1 - g.y0;
  if (w < 60 || h < 20) return false;
  const onBorder = (e) => {
    const p = { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h };
    const full = Math.abs(p.x0 - g.x0) <= 2 && Math.abs(p.x1 - g.x1) <= 2 && Math.abs(p.y0 - g.y0) <= 2 && Math.abs(p.y1 - g.y1) <= 2;
    if (full) return true; // retângulo inteiro (contorno ou fundo)
    if (e.hRule) return (Math.abs(p.y0 - g.y0) <= 2.5 || Math.abs(p.y1 - g.y1) <= 2.5) && e.w >= 0.8 * w;
    if (e.vRule) return (Math.abs(p.x0 - g.x0) <= 2.5 || Math.abs(p.x1 - g.x1) <= 2.5) && e.h >= 0.8 * h;
    return false;
  };
  if (!g.els.every(onBorder)) return false;
  const prose = segments.filter((s) => !s.rot && s.text.length >= 30 && s.x0 >= g.x0 - 6 && s.x1 <= g.x1 + 6 && s.y0 >= g.y0 - 2 && s.y1 <= g.y1 + 2);
  return prose.length >= 2;
}

/**
 * O pedaço de texto tem cara de rótulo desta figura? (Só vale para texto
 * perto da borda; o que está dentro do retângulo já é da figura.)
 */
function labelLike(s, fig, col, bodyFs) {
  if (s.rot) return true;
  // pedaço de linha de texto corrido ("Para essa academia, qual deve ser a
  // razão ... informada"): nunca é rótulo
  if (s.proseLine) return false;
  const text = s.text.trim();
  if (!text) return false;
  if (s.ref || TITULO_TEXTO.test(text)) return false;
  // fileira de números (eixo: "1960 1970 1980 … 2050", "0 5 10 … 55 x (km)")
  if (axisRow(text)) return true;
  const small = s.fs <= 0.88 * bodyFs;
  if (text.length > (small ? 70 : 32)) return false;
  if (text.length <= 14 && NUMERICO.test(text)) return true;
  if (small) return true;
  if (s.cells >= 2) return true;
  // ao lado da figura (na altura dela, ao menos em parte): rótulo ("HO",
  // "CH₃", o nome do eixo na ponta da seta)
  if (Math.min(s.y1, fig.y1) - Math.max(s.y0, fig.y0) > 0.3 * (s.y1 - s.y0)) return true;
  // em cima ou embaixo: na largura da figura (título, legenda, nome do eixo y)
  const cx = (s.x0 + s.x1) / 2;
  const over = Math.min(s.x1, fig.x1) - Math.max(s.x0, fig.x0);
  return (cx >= fig.x0 - 2 && cx <= fig.x1 + 2) || over >= 0.5 * (s.x1 - s.x0);
}

/**
 * Distância máxima do pedaço à figura: legenda logo abaixo (linha de várias
 * células, ou centrada sob a figura) pode estar um pouco mais longe.
 */
function reachOf(s, fig) {
  if (s.y0 >= fig.y1 - 1 && !s.rot) {
    // fileira de legendas lado a lado ("Vanilina   Eugenol   Cinamaldeído"):
    // cada desenho termina numa altura, a fileira é uma só
    if (s.cells >= 2) return CAPTION_ROW_GAP;
    const cx = (s.x0 + s.x1) / 2;
    const fcx = (fig.x0 + fig.x1) / 2;
    if (Math.abs(cx - fcx) <= 0.25 * (fig.x1 - fig.x0)) return CAPTION_GAP;
  }
  return LABEL_GAP;
}

/**
 * Linhas de referência bibliográfica: bloco de linhas seguidas em letra
 * menor em que alguma linha tem cara de referência ("SEGALL, L. Eternos
 * caminhantes…" / "Museu Lasar Segall, IbramMinc, São Paulo, 1919."). Nunca
 * viram legenda de figura — ficam no texto.
 */
function referenceLines(lines, bodyFs) {
  const out = new Set();
  let block = [];
  const close = () => {
    if (block.some((l) => REFERENCIA.test(l.text))) for (const l of block) out.add(l);
    block = [];
  };
  for (const line of lines) {
    const prev = block[block.length - 1];
    // só linha de texto (rótulo curto ou fileira de números de um gráfico,
    // logo acima de um "Fonte: IBGE", não é referência)
    const small = line.fs <= bodyFs - 0.5 && line.text.length >= 12 && /\p{L}{3,}/u.test(line.text);
    if (!small) {
      close();
      continue;
    }
    if (prev && !(Math.abs(prev.fs - line.fs) <= 0.6 && line.base > prev.base && line.base - prev.base <= 1.8 * line.fs)) close();
    block.push(line);
  }
  close();
  return out;
}

/** O pedaço começa na margem da coluna ou no recuo de parágrafo? */
function atProseStart(s, col) {
  const fromMargin = s.x0 - (col.margin ?? col.x0);
  return Math.abs(fromMargin) <= 3 || (fromMargin >= 11 && fromMargin <= 20) || Math.abs(s.x0 - (col.left ?? col.x0)) <= 3;
}

/** O pedaço está dentro do retângulo da figura (pelo centro, e quase inteiro)? */
function insideBox(s, fig) {
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  if (cx < fig.x0 - 1 || cx > fig.x1 + 1 || cy < fig.y0 - 1 || cy > fig.y1 + 1) return false;
  const w = s.x1 - s.x0;
  const over = Math.max(0, Math.min(s.x1, fig.x1 + 2) - Math.max(s.x0, fig.x0 - 2));
  return w <= 0 || over >= 0.6 * w;
}

/** Distância entre o pedaço e o retângulo (0 se encostam ou se cruzam). */
function distance(s, b) {
  const dx = Math.max(0, b.x0 - s.x1, s.x0 - b.x1);
  const dy = Math.max(0, b.y0 - s.y1, s.y0 - b.y1);
  return Math.max(dx, dy);
}

function take(f, s, role) {
  s.owner = f;
  s.role = role;
  f.labels.push(s);
  grow(f, s);
}

/** Distância máxima de um título de eixo girado ao gráfico (fica do lado de fora dos números do eixo). */
const ROT_GAP = 16;

/** Distância do pedaço ao desenho mais perto da figura (não ao retângulo dela). */
function elementDistance(s, f) {
  let best = Infinity;
  for (const e of f.els) {
    const d = distance(s, { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h });
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

/**
 * Distribui o texto entre as figuras da página: cada pedaço vai para a figura
 * mais perto cujo DESENHO o contém ou de quem ele tem cara de rótulo. A
 * distância é sempre ao desenho, não ao retângulo já crescido com rótulos —
 * senão a figura vai engolindo, rótulo a rótulo, os eixos do gráfico de baixo,
 * a pergunta e as alternativas. Pedaço que fica ao alcance de duas figuras
 * (o "t (s)" do fim do eixo do gráfico A, logo acima do gráfico B) vai para a
 * que tem um traço de verdade mais perto — o retângulo do gráfico B começa
 * colado no rótulo, mas o desenho dele está longe. Depois, as legendas em
 * mais de uma linha (absorbCaptions).
 */
function absorbAll(figs, segments, cols, bodyFs, letters = []) {
  const live = figs.filter((f) => !f.small);
  const covers = coverTest(segments, bodyFs);
  const letterOf = new Map(live.map((f) => [f, letterBeside(f, letters)]));
  // gráficos de alternativas empilhados: o rótulo embaixo do eixo do gráfico
  // de cima pode estar mais perto do desenho do de baixo
  const stacked = new Set([...letterOf.values()].filter(Boolean)).size >= 2;
  for (const s of segments) {
    if (s.owner || s.protected) continue;
    const cands = [];
    for (const f of live) {
      if (f.col !== s.col) continue;
      // texto corrido dentro do desenho: só de imagem (letreiro da tirinha,
      // rótulo do mapa) ou tabela; num desenho vetorial, é texto ao lado
      const inside = insideBox(s, f.draw) && (f.raster || f.table || !proseLike(s, bodyFs));
      const d = inside ? 0 : distance(s, f.draw);
      const below = stacked && letterOf.get(f) && s.y0 >= f.draw.y1 - 1 && Math.min(s.x1, f.draw.x1) - Math.max(s.x0, f.draw.x0) > 0;
      const reach = below ? CAPTION_GAP : Math.min(LABEL_GAP, reachOf(s, f.draw));
      if (!inside && (s.formula || d > reach || !labelLike(s, f.draw, cols[f.col], bodyFs) || covers(f, s))) continue;
      cands.push({ f, d, L: letterOf.get(f) });
    }
    if (!cands.length) continue;
    let best = cands.reduce((a, b) => (b.d < a.d ? b : a));
    if (cands.length > 1) {
      // figuras de alternativas diferentes, uma em cima da outra: vale a
      // faixa da letra (metade do caminho entre as duas letras)
      const lettered = cands.filter((c) => c.L);
      const cy = (s.y0 + s.y1) / 2;
      if (lettered.length >= 2 && new Set(lettered.map((c) => c.L)).size >= 2) {
        best = lettered.reduce((a, b) => (Math.abs(b.L.cy - cy) < Math.abs(a.L.cy - cy) ? b : a));
      } else {
        const scored = cands.map((c) => ({ ...c, e: c.d === 0 ? 0 : elementDistance(s, c.f) }));
        best = scored.reduce((a, b) => (b.e < a.e || (b.e === a.e && b.d < a.d) ? b : a));
      }
    }
    take(best.f, s, best.d === 0 ? 'dentro' : s.y0 >= best.f.draw.y1 - 1 ? 'legenda' : 'rotulo');
  }
  absorbCaptions(live, segments, cols, bodyFs);
}

/** Texto que nunca é rótulo: a figura não pode crescer por cima dele. */
function coverTest(segments, bodyFs) {
  const hard = segments.filter((s) => !s.rot && (s.protected || s.proseLine || s.ref || s.formula
    || s.text.length > 70 || (s.text.length > 32 && s.fs > 0.88 * bodyFs && !axisRow(s.text))));
  return (f, s) => {
    const box = { x0: Math.min(f.x0, s.x0), y0: Math.min(f.y0, s.y0), x1: Math.max(f.x1, s.x1), y1: Math.max(f.y1, s.y1) };
    return hard.some((h) => h !== s && h.owner !== f && h.col === f.col && intersects(h, box, -1.5) && !insideBox(h, f.draw));
  };
}

/**
 * Legenda embaixo dos rótulos: medida do retângulo já com os rótulos, só
 * para baixo, só na largura do desenho ("OH CH₃" / "Vanilina" / "(no óleo
 * de baunilha)"); a linha colada embaixo (ou em cima) de um rótulo que já é
 * da figura também é dela — a segunda linha do nome do eixo ("Criptomoeda A"
 * / "(milhar de real)"), da legenda ("Cloreto de vinila" / "(cloropropeno)").
 * Título de eixo girado: perto do retângulo já com os números do eixo.
 */
function absorbCaptions(live, segments, cols, bodyFs) {
  const covers = coverTest(segments, bodyFs);
  for (let round = 0; round < 3; round += 1) {
    let more = false;
    for (const s of segments) {
      if (s.owner || s.protected || s.formula || s.proseLine) continue;
      if (s.rot) {
        const f = live.find((o) => o.col === s.col && distance(s, o) <= ROT_GAP
          && Math.min(s.y1, o.y1) - Math.max(s.y0, o.y0) > 0 && !covers(o, s));
        if (f) {
          take(f, s, 'rotulo');
          more = true;
        }
        continue;
      }
      let best = null;
      for (const f of live) {
        if (f.col !== s.col) continue;
        // logo abaixo (ou acima) de um rótulo/legenda já da figura, ou colado
        // do lado de um rótulo (a carga "⁻" de "COO⁻" ficou noutra linha)
        const under = f.labels.some((l) => !l.rot && ((Math.min(s.x1, l.x1) - Math.max(s.x0, l.x0) > 0
          && ((s.y0 >= l.y1 - 1.5 && s.y0 - l.y1 <= 8) || (s.y1 <= l.y0 + 1.5 && l.y0 - s.y1 <= 8)))
          || (Math.min(s.y1, l.y1) - Math.max(s.y0, l.y0) > 0 && (Math.abs(s.x0 - l.x1) <= 4 || Math.abs(l.x0 - s.x1) <= 4))));
        if (under) {
          // continuação de rótulo: curta, não é referência nem título de
          // texto ("TEXTO II" logo acima do letreiro da charge é do enunciado)
          if (s.ref || s.text.length > 40 || TITULO_TEXTO.test(s.text.trim()) || covers(f, s)) continue;
        } else {
          if (s.y0 < f.y1 - 1 || s.y0 - f.y1 > (s.cells >= 2 ? CAPTION_ROW_GAP : CAPTION_GAP)) continue;
          const cx = (s.x0 + s.x1) / 2;
          if (s.cells < 2 && (cx < f.draw.x0 || cx > f.draw.x1)) continue;
          if (Math.min(s.x1, f.x1) - Math.max(s.x0, f.x0) <= 0) continue;
          // sem pular texto: legenda é a linha logo depois da figura
          const between = { x0: s.x0, x1: s.x1, y0: f.y1, y1: s.y0 };
          if (segments.some((o) => o !== s && o.owner !== f && o.col === s.col && intersects(o, between, -1))) continue;
          if (!labelLike(s, f.draw, cols[f.col], bodyFs) || covers(f, s)) continue;
        }
        if (!best || Math.abs(s.y0 - f.y1) < Math.abs(s.y0 - best.y1)) best = f;
      }
      if (best) {
        take(best, s, 'legenda');
        more = true;
      }
    }
    if (!more) break;
  }
}

/**
 * Traço solto colado numa figura (linha de cota "|—— L ——|" em cima do
 * desenho, seta, pedaço do eixo): parte dela — se não for enfeite de texto
 * (traço de fração tem texto em cima e embaixo; sublinhado, texto da mesma
 * largura logo em cima) e não houver texto entre os dois.
 */
function attachSmall(big, small, segments, letters) {
  let any = false;
  for (const sm of small) {
    const letter = letterBeside(sm, letters);
    const free = segments.filter((t) => !t.owner && t.col === sm.col && Math.min(t.x1, sm.x1) - Math.max(t.x0, sm.x0) > 0);
    const above = free.filter((t) => t.y1 <= sm.y0 + 2 && sm.y0 - t.y1 <= 4);
    const below = free.filter((t) => t.y0 >= sm.y1 - 2 && t.y0 - sm.y1 <= 4);
    if (above.length && below.length) continue; // fração
    if (above.some((t) => t.x1 - t.x0 >= 0.7 * (sm.x1 - sm.x0))) continue; // sublinhado
    let best = null;
    for (const f of big) {
      // perto do desenho, ou dentro do retângulo já com os rótulos (o eixo do
      // gráfico entre os pontos e os números do eixo, que já são da figura)
      // (legenda de gráfico — o traço colorido da série — fica um pouco mais longe, embaixo)
      const underIt = sm.y0 >= f.draw.y1 && sm.x0 >= f.draw.x0 - 2 && sm.x1 <= f.draw.x1 + 2;
      if (f.col !== sm.col || (distance(sm, f.draw) > (underIt ? 20 : 12) && !intersects(sm, f, -0.5))) continue;
      // cada alternativa com o seu desenho
      if (letterBeside(f, letters) !== letter) continue;
      const alignedX = Math.min(sm.x1, f.x1) - Math.max(sm.x0, f.x0) > 0;
      const alignedY = Math.min(sm.y1, f.y1) - Math.max(sm.y0, f.y0) > 0;
      if (!alignedX && !alignedY) continue;
      if (textBetween(f, sm, segments)) continue;
      if (!best || distance(sm, f.draw) < distance(sm, best.draw)) best = f;
    }
    if (!best) continue;
    grow(best, sm);
    grow(best.draw, sm);
    best.els.push(...sm.els);
    sm.merged = true;
    any = true;
  }
  return any;
}

/**
 * Fecho: o que ficou dentro do retângulo final da figura e não é texto do
 * enunciado (prosa, título, referência, letra) também é dela — a legenda da
 * fileira de baixo, o rótulo entre dois desenhos juntados.
 */
function closeOver(figs, segments) {
  for (const f of figs) {
    for (const s of segments) {
      if (s.owner || s.protected || s.proseLine || s.ref || s.col !== f.col) continue;
      if (s.text.length > 40 && !s.rot) continue;
      if (insideBox(s, f)) take(f, s, 'dentro');
    }
  }
}

/**
 * Letra de alternativa ao lado (à esquerda, na altura) da figura: figuras de
 * letras diferentes nunca se juntam.
 */
function letterBeside(fig, letters) {
  let best = null;
  for (const L of letters) {
    if (L.col !== fig.col) continue;
    if (L.cy < fig.y0 - 2 || L.cy > fig.y1 + 2) continue;
    if (L.x1 > fig.x0 + 6 || fig.x0 - L.x1 > 150) continue;
    if (!best || L.x1 > best.x1) best = L;
  }
  return best;
}

/**
 * Há texto (que não é da figura) entre as duas figuras? Seta ou sinal solto
 * ("⇒", "+", "=") entre dois desenhos lado a lado não separa: é a sequência
 * "Figura 1 ⇒ Figura 2" — uma figura só.
 */
function textBetween(a, b, segments) {
  const vertical = Math.min(a.y1, b.y1) <= Math.max(a.y0, b.y0); // uma em cima da outra
  const gap = vertical
    ? { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y1, b.y1), y1: Math.max(a.y0, b.y0) }
    : { x0: Math.min(a.x1, b.x1), x1: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), y1: Math.min(a.y1, b.y1) };
  // lado a lado: seta, sinal ou termo curto de uma equação ("+ 2 NaOH →")
  // entre os dois desenhos não separa
  return segments.some((s) => !s.owner && s.col === a.col && intersects(s, gap, -1.5)
    && (vertical || s.protected || s.proseLine || s.ref || s.text.length > 14));
}

/** Junta figuras vizinhas sem texto corrido entre elas. */
function mergeNeighbors(figs, segments, letters, cols, bodyFs) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < figs.length && !changed; i += 1) {
      for (let j = i + 1; j < figs.length && !changed; j += 1) {
        const a = figs[i];
        const b = figs[j];
        if (a.col !== b.col || a.small || b.small) continue;
        if (letterBeside(a, letters) !== letterBeside(b, letters)) continue;
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        let join = false;
        if (overlapX > 0 && overlapY > 0) join = true;
        else if (overlapX > -10 && overlapY <= 0 && -overlapY <= 30) join = !textBetween(a, b, segments);
        else if (overlapY > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && overlapX <= 0 && -overlapX <= 150) join = !textBetween(a, b, segments);
        if (!join) continue;
        grow(a, b);
        grow(a.draw, b.draw);
        a.els.push(...b.els);
        a.labels.push(...b.labels);
        for (const s of b.labels) s.owner = a;
        a.raster = a.raster || b.raster;
        a.vector = a.vector || b.vector;
        a.table = a.table || b.table;
        figs.splice(j, 1);
        absorbAll(figs, segments, cols, bodyFs, letters);
        changed = true;
      }
    }
  }
}

/**
 * Figuras de uma página (structure.readPage). Devolve `{ figures, absorbed }`:
 * figures `[{ page, col, x0, y0, x1, y1, kind, small, crop, uncertain, text }]`
 * (kind 'imagem' | 'vetor' | 'misto' | 'tabela'; small = traço, fração
 * desenhada — figura só se for tudo o que uma alternativa tem) e `absorbed`,
 * o conjunto dos itens de texto que pertencem a alguma figura.
 */
function detectFigures(P, { markLines = [], letterItems = [], bodyFs = 10 } = {}) {
  const cols = P.columns;
  // letra solta em negrito só é de alternativa se tiver cara de alternativa
  // (coluna de letras em ordem, ou o texto da alternativa logo depois): o
  // "A", "B", "C" dos vértices de um desenho é rótulo do desenho
  const altLetters = alternativeLetters(letterItems, P, bodyFs);
  const inlineGlyphs = inlineFormulas(P, bodyFs, altLetters);
  const els = graphicElements({ ...P, paths: (P.paths || []).filter((p) => !inlineGlyphs.has(p)) }, markLines, altLetters);
  const letterRows = altLetters.filter((t) => FONTE_LETRA.test(t.font || '') || /^\(?[A-E]\)/.test(t.str.trim()));
  const groups = promoteDrawnText(
    [...unionByProximity(els, GAP).values()].flatMap((g) => splitByLetters(g, letterRows, cols)).map(groupOf),
    P,
    bodyFs,
  );

  // letra de alternativa: a do círculo e a "(A)" valem sempre; letra solta em
  // negrito dentro de um desenho é rótulo do desenho ("A", "B" de um triângulo)
  const insideGroup = (t) => groups.some((g) => !g.rulesOnly && t.x >= g.x0 + 1 && t.x1 <= g.x1 - 1 && t.cy >= g.y0 + 1 && t.cy <= g.y1 - 1);
  const letters = altLetters.filter((t) => FONTE_LETRA.test(t.font || '') || /^\(?[A-E]\)/.test(t.str.trim()) || !insideGroup(t));
  const letterSet = new Set(letters);
  const letterBoxes = letters.map((t) => ({ ...visualBox(t), col: columnOfBox(cols, t), cy: t.cy }));

  // texto da página em pedaços. Protegidos (nunca viram figura): marca,
  // título, letra da alternativa e o texto logo depois dela, pedaço de
  // fórmula (o recorte da fórmula é outro).
  const segments = [];
  for (const col of cols) {
    const refLines = referenceLines(col.lines, bodyFs);
    let prevLine = null;
    let prevProse = false;
    for (const line of col.lines) {
      const segs = splitSegments(line, (t) => letterSet.has(t), col);
      const cells = segs.filter((s) => !s.letter).length;
      // fim de parágrafo: a linha curta que continua uma linha de prosa que
      // foi até a margem direita ("…a gravidade é de 10" / "m/s².")
      const continues = prevProse && prevLine && prevLine.x1 >= (col.right || col.x1) - 5
        && Math.abs(prevLine.fs - line.fs) <= 1.2 && line.base > prevLine.base
        && line.base - prevLine.base <= 1.6 * Math.max(line.fs, prevLine.fs)
        && Math.abs(line.x0 - (col.margin ?? col.x0)) <= 3;
      const prose = continues || segs.some((s) => !s.letter && (atProseStart(s, col) && Math.abs(s.fs - bodyFs) <= 1.2 && PALAVRAS.test(s.text)))
        || segs.some((s) => proseLike(s, bodyFs));
      prevLine = line;
      prevProse = prose;
      const letter = segs.find((s) => s.letter);
      for (const s of segs) {
        s.col = col.index;
        s.line = line;
        s.cells = cells;
        s.proseLine = prose;
        s.ref = refLines.has(line);
        // o texto logo depois da letra é a alternativa — a não ser que seja
        // um rótulo curto colado num desenho ("⁻S—C—C—COO⁻": a alternativa
        // é a fórmula estrutural)
        // (no corpo da letra: rótulo miúdo ao lado da letra — "Início escada"
        // da figura da alternativa A — é da figura)
        const afterLetter = letter && s !== letter && s.x0 > letter.x0 && s.x0 - letter.x1 <= 24 && Math.abs(s.fs - letter.fs) <= 1.2;
        const glued = afterLetter && s.text.length <= 6 && groups.some((g) => !g.rulesOnly && g.col === col.index
          && g.x0 - s.x1 >= -2 && g.x0 - s.x1 <= 12 && Math.min(g.y1, s.y1) - Math.max(g.y0, s.y0) > 0
          && (g.x1 - g.x0) * (g.y1 - g.y0) >= 400);
        s.protected = !!(line.isMark || line.heading || s.letter || (afterLetter && !glued));
        // pedaço de fórmula (fração montada): só entra na figura se estiver
        // DENTRO do desenho (unidade de célula de tabela, rótulo "J/(carro·m/s)")
        s.formula = s.visible.some((t) => t.formula);
        segments.push(s);
      }
    }
  }
  for (const t of P.rotated || []) {
    if (!t.str.trim() || t.fs < 3) continue;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    if (cy < P.top || cy > P.bottom || cx < 25 || cx > P.width - 25) continue;
    segments.push({ items: [t], visible: [t], ...visualBox(t), fs: t.fs, text: t.str.trim(), rot: true, cells: 1, col: columnOfBox(cols, t) });
  }

  // tabelas de fios; o resto dos grupos só de fio é ornamento (fio de fim de
  // coluna, sublinhado) ou traço de fração
  const ruleGroups = groups.filter((g) => g.rulesOnly);
  const figs = ruleTables(ruleGroups, segments);
  for (const g of groups) {
    if (g.rulesOnly) {
      const colW = cols[g.col].x1 - cols[g.col].x0;
      if (g.x1 - g.x0 >= 0.6 * colW || figs.some((t) => t.els.includes(g.els[0]))) continue;
      g.small = true;
      figs.push(g);
      continue;
    }
    if (isFrame(g, segments)) continue;
    const w = g.x1 - g.x0;
    const h = g.y1 - g.y0;
    if (Math.max(w, h) < 4) continue;
    // pequeno: traço, fração desenhada, pedaço de fórmula
    // (texto desenhado em fileira não é pequeno: é a tabela, o rótulo)
    g.small = !g.raster && !g.drawnText && (w * h < 400 || w < 12 || h < 12);
    // tabela de grade: fios horizontais longos e verticais (a ligação de uma
    // fórmula estrutural também é fio, mas curto)
    // (o fundo cinza do cabeçalho vem como retângulo ou como polígono de 4 lados)
    const boxShape = (e) => e.path && (e.path.rect || (!e.path.curve && (e.path.line || 0) <= 5 && e.path.paint !== 'stroke'));
    if (!g.raster && g.els.filter((e) => e.hRule && e.w >= 40).length >= 2 && g.els.filter((e) => e.vRule && e.h >= 10).length >= 2
      && g.els.every((e) => e.hRule || e.vRule || boxShape(e))) g.table = true;
    figs.push(g);
  }

  // rótulos (cada um com a figura mais perto) e figuras vizinhas juntas
  const big = figs.filter((f) => !f.small);
  absorbAll(big, segments, cols, bodyFs, letterBoxes);
  mergeNeighbors(big, segments, letterBoxes, cols, bodyFs);
  if (attachSmall(big, figs.filter((f) => f.small), segments, letterBoxes)) absorbAll(big, segments, cols, bodyFs, letterBoxes);
  closeOver(big, segments);
  // o que o fecho trouxe pode ter legenda embaixo
  absorbCaptions(big, segments, cols, bodyFs);
  closeOver(big, segments);
  sideBySideCaptions(big, segments);
  const small = figs.filter((f) => f.small && !f.merged && !big.some((b) => intersects(f, b, -1) && f.x0 >= b.x0 && f.x1 <= b.x1 && f.y0 >= b.y0 && f.y1 <= b.y1));
  const all = [...big, ...small];

  const absorbed = new Set();
  for (const f of big) for (const s of f.labels) for (const t of s.items) absorbed.add(t);
  // item sem texto (glifo de símbolo sem tradução: seta de vetor, parêntese
  // grande) dentro de uma figura também é dela — senão a linha vazia fica
  // marcada como fórmula
  for (const col of cols) {
    for (const line of col.lines) {
      for (const t of line.items) {
        if (t.str.trim() || absorbed.has(t)) continue;
        const b = visualBox(t);
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        if (big.some((f) => cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1)) absorbed.add(t);
      }
    }
  }

  // texto de fora (para o recorte não avançar sobre ele) e alerta
  const foreignOf = (f) => segments.filter((s) => s.owner !== f && !(s.rot && s.owner));
  const figures = all.map((f) => {
    const kind = f.table ? 'tabela' : f.raster ? (f.vector ? 'misto' : 'imagem') : 'vetor';
    const out = {
      page: P.page,
      col: f.col,
      x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1,
      kind,
      small: !!f.small,
      text: f.labels.filter((s) => !s.rot).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((s) => s.text).join(' ').slice(0, 500),
    };
    if (!f.small) {
      const { crop, covered } = cropBox(f, P, foreignOf(f), all.filter((o) => o !== f));
      out.crop = crop;
      out.uncertain = uncertainty(f, P, covered, segments);
    } else {
      out.crop = cropBox(f, P, foreignOf(f), []).crop;
      out.uncertain = [];
      // só fio (sublinhado que sobrou, traço de fração, fio de fim de coluna)
      if (f.rulesOnly) out.rule = true;
    }
    return out;
  });
  figures.sort((a, b) => a.col - b.col || a.y0 - b.y0);
  return { figures, absorbed };
}

/**
 * Recorte: o retângulo da figura com folga, que só avança sobre espaço vazio
 * — texto de fora (de outra coluna, a linha de cima, a referência embaixo) e
 * outras figuras empurram a folga de volta. `covered`: texto de fora que está
 * DENTRO da figura (vai aparecer no recorte).
 */
function cropBox(f, P, foreign, others) {
  const fig = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
  const crop = {
    x0: Math.max(0, f.x0 - PAD),
    y0: Math.max(P.top || 0, f.y0 - PAD),
    x1: Math.min(P.width, f.x1 + PAD),
    y1: Math.min(P.bottom || P.height, f.y1 + PAD),
  };
  // o fio entre as colunas fica fora do recorte (aparecia como uma linha
  // preta na borda do PNG)
  for (const r of (P.paths || []).filter((p) => isColumnRule(p, P))) {
    const rx = r.x + r.w / 2;
    const half = (Number(r.lw) || 1) / 2 + 0.6;
    if (rx <= fig.x0) crop.x0 = Math.max(crop.x0, rx + half);
    else if (rx >= fig.x1) crop.x1 = Math.min(crop.x1, rx - half);
  }
  const covered = [];
  // o texto de fora conta com o acento (a caixa da letra vai da altura da
  // maiúscula; o "Ó" da linha de baixo subia no recorte)
  const boxes = [
    ...foreign.map((b) => (b.rot ? b : { ...b, y0: b.y0 - 0.14 * (b.fs || 10) })),
    ...others.map((o) => ({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, figure: true })),
  ];
  for (const b of boxes) {
    if (!intersects(b, crop)) continue;
    // texto de fora que só raspa a borda de cima/de baixo (a caixa do texto
    // inclui a perna das letras, que quase nunca existe): sem folga desse lado
    const graze = Math.min(b.x1, fig.x1) - Math.max(b.x0, fig.x0) > 0 && (
      (b.y0 < fig.y0 && b.y1 > fig.y0 && b.y1 - fig.y0 <= 3) || (b.y1 > fig.y1 && b.y0 < fig.y1 && fig.y1 - b.y0 <= 3));
    if (graze) {
      if (b.y0 < fig.y0) crop.y0 = Math.max(crop.y0, fig.y0);
      else crop.y1 = Math.min(crop.y1, fig.y1);
      continue;
    }
    if (intersects(b, fig, -1.5)) {
      if (!b.figure) covered.push(b);
      continue;
    }
    if (b.y1 <= fig.y0 + 0.5) crop.y0 = Math.max(crop.y0, b.y1 + 0.3);
    else if (b.y0 >= fig.y1 - 0.5) crop.y1 = Math.min(crop.y1, b.y0 - 0.3);
    else if (b.x1 <= fig.x0 + 0.5) crop.x0 = Math.max(crop.x0, b.x1 + 0.3);
    else if (b.x0 >= fig.x1 - 0.5) crop.x1 = Math.min(crop.x1, b.x0 - 0.3);
  }
  const r = (n) => Math.round(n * 100) / 100;
  return { crop: { x: r(crop.x0), y: r(crop.y0), w: r(crop.x1 - crop.x0), h: r(crop.y1 - crop.y0) }, covered };
}

/**
 * Motivos para desconfiar do recorte: encosta na borda do corpo (pode
 * continuar na outra coluna/página), passa da coluna, cobre texto de fora.
 */
function uncertainty(f, P, covered, segments = []) {
  const out = [];
  // rótulo que ficou fora do recorte, colado na borda de baixo ou do lado
  // (a 2ª linha do nome do eixo, o "30" do fim do eixo, o vértice do
  // desenho), ou título de eixo girado perto do gráfico — o recorte está
  // incompleto e o texto vazou para o enunciado
  const orphan = segments.some((s) => !s.owner && !s.protected && !s.proseLine && !s.ref && s.col === f.col
    && s.text && s.text.length <= 30 && !/[.!?:;]$/.test(s.text) && !TITULO_TEXTO.test(s.text)
    && (s.rot ? distance(s, f) <= 25 && Math.min(s.y1, f.y1) - Math.max(s.y0, f.y0) > 0
      : distance(s, f) <= 8 && s.y0 >= f.y0 - 1 && (Math.min(s.x1, f.x1) - Math.max(s.x0, f.x0) > 0 || Math.min(s.y1, f.y1) - Math.max(s.y0, f.y0) > 0)));
  if (orphan) out.push('rotulo_solto');
  const col = P.columns[f.col];
  if (P.top != null && f.y0 <= P.top + 1) out.push('borda_superior');
  if (P.bottom != null && f.y1 >= P.bottom - 1) out.push('borda_inferior');
  if (P.columns.length > 1) {
    if (f.col === 0 && f.x1 > col.x1 + 8) out.push('atravessa_coluna');
    if (f.col === 1 && f.x0 < col.x0 - 8) out.push('atravessa_coluna');
  }
  // texto de fora coberto: o que não é rótulo curto (letra solta de outra
  // figura, número) e não é a letra da alternativa
  if (covered.some((s) => !s.letter && s.text && s.text.length > 3)) out.push('cobre_texto');
  return out;
}

/**
 * Recorte de fórmula montada que não virou texto (fração dentro de fração,
 * parêntese grande, chave, seta de vetor do MathType) ou de uma alternativa
 * que é fórmula: o conteúdo (texto, inclusive glifo sem tradução, e desenho)
 * com o centro dentro de `region`, com folga pequena. `exclude`: itens que
 * não entram (a letra da alternativa); `keepOut`: itens que não entram e
 * que o recorte não pode cobrir (a pontuação da frase colada na fórmula).
 * Null se a região estiver vazia.
 */
function formulaFigure(P, region, { exclude = new Set(), keepOut = new Set(), col = 0 } = {}) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const inRegion = (b) => {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    return cx >= region.x0 && cx <= region.x1 && cy >= region.y0 && cy <= region.y1;
  };
  const texts = [];
  for (const c of P.columns) for (const line of c.lines) for (const t of line.items) texts.push(t);
  let n = 0;
  const outside = [];
  for (const t of texts) {
    // (o glifo sem tradução — parêntese grande do MathType — ficou sem texto,
    // mas é parte da fórmula)
    if (exclude.has(t) || (t.str === '' && !t.formula)) continue;
    const b = visualBox(t);
    if (keepOut.has(t) || !inRegion(b)) {
      if (t.str.trim()) outside.push(b);
      continue;
    }
    if (t.str.trim() === '' && !t.formula) continue;
    grow(box, b);
    n += 1;
  }
  // desenho da fórmula (traço de fração, radical, chave): inteiro dentro da
  // região — o pé da figura de cima e o fio entre colunas, não. A tolerância
  // é a mesma dos dois lados: com 3 pt a menos na direita, o último desenho
  // da fórmula ficava de fora quando a região é o trecho justo dela (o "0" e
  // a barra da raiz de "4√10", o ")" de "2√2(cos 7π/4 + i·sen 7π/4)", o "]"
  // da matriz, o "=" de "α =") — e o aluno lia "4√1".
  for (const p of P.paths || []) {
    const b = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    // na horizontal, inteiro dentro (o fio entre colunas fica fora); na
    // vertical, pelo centro — a letra desenhada da fórmula passa um pouco da
    // linha (o recorte para na região de qualquer jeito)
    const cy = (b.y0 + b.y1) / 2;
    if (b.x0 < region.x0 - 0.5 || b.x1 > region.x1 + 0.5 || cy < region.y0 || cy > region.y1 || b.y1 - b.y0 > 3 * (region.y1 - region.y0)) continue;
    // fio vertical comprido (separador de coluna) não é fórmula
    if (b.x1 - b.x0 <= 2.5 && b.y1 - b.y0 >= 0.3 * (P.height || Infinity)) continue;
    grow(box, b);
    // fórmula só de desenho ("α =" em curvas no meio da frase) também conta
    if (!p.fraction && (p.curve || (p.line || 0) >= 2 || p.rect)) n += 1;
  }
  if (!n || !Number.isFinite(box.x0)) return null;
  const r = (v) => Math.round(v * 100) / 100;
  // folga pequena, sem sair da região (a linha de cima e a de baixo não
  // entram) e sem avançar sobre o texto de fora colado na fórmula (a vírgula
  // de "…, *, &" aparecia no recorte e no texto)
  let x0 = Math.max(region.x0, box.x0 - 2);
  const y0 = Math.max(region.y0, box.y0 - 2);
  let x1 = Math.min(region.x1, box.x1 + 2);
  const y1 = Math.min(region.y1, box.y1 + 2);
  for (const b of outside) {
    if (Math.min(b.y1, y1) - Math.max(b.y0, y0) <= 0.3 * (b.y1 - b.y0)) continue;
    const cx = (b.x0 + b.x1) / 2;
    if (cx >= box.x1 - 0.3 && b.x0 < x1) x1 = Math.max(box.x1, b.x0);
    if (cx <= box.x0 + 0.3 && b.x1 > x0) x0 = Math.min(box.x0, b.x1);
  }
  return {
    page: P.page,
    col,
    x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
    kind: 'formula',
    small: false,
    text: '',
    crop: { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) },
    uncertain: [],
  };
}

/** Linha sem os itens que viraram figura (null se não sobrou nada visível). */
function withoutFigureText(line, absorbed) {
  if (!absorbed.size || !line.items.some((t) => absorbed.has(t))) return line;
  const rest = line.items.filter((t) => !absorbed.has(t));
  if (!rest.some((t) => t.str.trim())) return null;
  const rebuilt = finishLine({ items: rest });
  const keep = ['type', 'page', 'col', 'colX0', 'colX1', 'margin', 'left', 'right', 'ragged', 'idx', 'heading', 'isMark', 'formulaBox', 'formulaBoxes', 'matrix'];
  for (const k of keep) if (line[k] !== undefined) rebuilt[k] = line[k];
  if (line.formulaBox || line.matrix) rebuilt.formula = true;
  return rebuilt;
}

/**
 * Renderiza o recorte de cada figura das questões (PNG, escala 2) e põe em
 * `figure.png`. Figura repetida (apoio compartilhado por várias questões) é
 * renderizada uma vez só. Página por página, sem segurar a página aberta.
 */
async function renderFigures(doc, questions, { scale = SCALE } = {}) {
  const { CanvasFactory, createCanvas } = doc.runtime;
  // recorte girado (`rotate`: 90 = sentido horário), para a tabela deitada na página
  const girar = (canvas, graus) => {
    const out = createCanvas(canvas.height, canvas.width);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((graus * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out.toBuffer('image/png');
  };
  const byPage = new Map();
  for (const q of questions) {
    for (const f of q.figures || []) {
      if (!f.crop || f.crop.w < 1 || f.crop.h < 1) continue;
      if (!byPage.has(f.page)) byPage.set(f.page, []);
      byPage.get(f.page).push(f);
    }
  }
  const factory = new CanvasFactory();
  let rendered = 0;
  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(pageNumber);
    const cache = new Map();
    try {
      for (const f of byPage.get(pageNumber)) {
        const { x, y, w, h } = f.crop;
        const key = `${x}|${y}|${w}|${h}|${f.rotate || 0}`;
        if (!cache.has(key)) {
          const pair = factory.create(w * scale, h * scale);
          const viewport = page.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
          try {
            // eslint-disable-next-line no-await-in-loop
            await page.render({ canvasContext: pair.context, viewport, background: '#ffffff' }).promise;
            cache.set(key, f.rotate ? girar(pair.canvas, f.rotate) : pair.canvas.toBuffer('image/png'));
            rendered += 1;
          } finally {
            factory.destroy(pair);
          }
        }
        f.png = cache.get(key);
      }
    } finally {
      page.cleanup();
    }
  }
  return { rendered };
}

/** Espaço entre dois pedaços da região na imagem montada (pixels). */
const REGION_GAP = 12;

/**
 * Renderiza a região inteira das questões escolhidas (`which(q)`) num PNG só,
 * em `q.region_png`: um pedaço por página/coluna de `q.regions`, um embaixo
 * do outro, na ordem de leitura. É a imagem que a IA de visão lê quando o
 * texto da questão não deu para ler — por isso só para quem pede: uma prova
 * inteira assim ocuparia dezenas de MB à toa.
 */
async function renderRegions(doc, questions, { scale = SCALE, which = () => true } = {}) {
  const { CanvasFactory, createCanvas } = doc.runtime;
  const factory = new CanvasFactory();
  let rendered = 0;
  for (const q of questions) {
    const boxes = (q.regions || []).filter((b) => b.w >= 1 && b.h >= 1);
    if (!boxes.length || !which(q)) continue;
    const pieces = [];
    for (const b of boxes) {
      // eslint-disable-next-line no-await-in-loop
      const page = await doc.getPage(b.page);
      const pair = factory.create(b.w * scale, b.h * scale);
      try {
        const viewport = page.getViewport({ scale, offsetX: -b.x * scale, offsetY: -b.y * scale });
        // eslint-disable-next-line no-await-in-loop
        await page.render({ canvasContext: pair.context, viewport, background: '#ffffff' }).promise;
        pieces.push(pair.canvas);
      } catch (err) {
        factory.destroy(pair);
        throw err;
      } finally {
        page.cleanup();
      }
    }
    const width = Math.max(...pieces.map((c) => c.width));
    const height = pieces.reduce((n, c) => n + c.height, 0) + REGION_GAP * (pieces.length - 1);
    const out = createCanvas(width, height);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    let y = 0;
    for (const c of pieces) {
      ctx.drawImage(c, 0, y);
      y += c.height + REGION_GAP;
      c.width = 0;
      c.height = 0;
    }
    q.region_png = out.toBuffer('image/png');
    rendered += 1;
  }
  return { rendered };
}

module.exports = {
  SCALE,
  PAD,
  detectFigures,
  formulaFigure,
  withoutFigureText,
  renderFigures,
  renderRegions,
  splitSegments,
  labelLike,
};

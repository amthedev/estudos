'use strict';

/**
 * Os assuntos de uma aula, lidos do título.
 *
 *   const lessonTopics = require('./lesson-topics');
 *
 *   await lessonTopics.identify({ subjectId, titles: ['Aula 05 — Razão e Proporção, Regra de Três e Porcentagem'] })
 *     → [{ title, via, error?, topics: [{ label, topic_id, subtopic_id, new_topic_name, topic_name, subtopic_name }] }]
 *       via: 'catalogo' (casou sem IA) | 'ia' | 'parcial' (a IA falhou; ficou o que casou sem ela) | 'nenhum'
 *
 *   await lessonTopics.findOrCreateTopic(db, subjectId, 'Juros compostos', { req, examIds })
 *     → { id, slug, name, created }
 *
 *   const lista = await lessonTopics.resolveTopics(subjectId, body.topics, { req, examIds });
 *   await db.tx((client) => lessonTopics.writeLessonTopics(client, lessonId, lista));   → { changed }
 *
 * O cliente envia as videoaulas com o título no nome do arquivo, e o título já
 * diz o que a aula cobre. Quase sempre com os nomes que JÁ existem no conteúdo
 * programático: o seed de Matemática tem "Razão e proporção", "Porcentagem" e
 * "Regra de três simples e composta". Por isso a identificação começa casando
 * o título com o catálogo da matéria, sem IA. A IA (modelo econômico, uma
 * chamada para até 30 títulos) só recebe os títulos com algum trecho sem par —
 * e mesmo ela só pode escolher slug que existe; o que não existir volta como
 * nome de assunto novo, que o painel mostra antes de gravar.
 *
 * Assunto novo é cadastrado por findOrCreateTopic, que procura antes de criar:
 * "Porcentagem" nunca vira "porcentagem-2".
 */
const db = require('../db/pool');
const ai = require('./ai');
const { AppError } = require('../middleware/errors');
const { audit } = require('../middleware/audit');
const { slugify } = require('../utils/slug');
const { ensureExamCoverage } = require('../routes/admin/content');

/** Assuntos por aula: a prática distribui três questões entre eles. */
const MAX_ASSUNTOS = 3;
/** Títulos por chamada: são curtos, e o catálogo da matéria vai uma vez só. */
const TITULOS_POR_CHAMADA = 30;
const CHAMADAS_EM_PARALELO = 4;
/**
 * Prazo da identificação inteira quando quem espera é uma tela aberta. A borda
 * (Cloudflare) corta a requisição perto dos 100 s; a gravação das aulas ainda
 * precisa caber depois disso.
 */
const PRAZO_INTERATIVO_MS = 50_000;
const TIMEOUT_CHAMADA_MS = 40_000;
/** Abaixo disso não vale começar uma chamada: ela seria cortada no meio. */
const FOLGA_MINIMA_MS = 3_000;
/**
 * Teto de saída por título: até três itens com rótulo e slugs. O raciocínio do
 * modelo econômico fica desligado fora da redação (services/ai.js), então o
 * teto é só da resposta. Não foi medido com a API real (o ambiente local roda
 * com o cliente de simulação); a segunda tentativa com o dobro cobre o corte.
 */
const TOKENS_POR_TITULO = 140;
const TOKENS_BASE = 300;
const TOKENS_TETO = 8_000;
/** Fração mínima do nome do catálogo que o trecho precisa cobrir para casar sem IA. */
const COBERTURA_MINIMA = 0.5;

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

/** Palavras que não distinguem um assunto de outro. */
const VAZIAS = new Set([
  'a', 'o', 'as', 'os', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'com', 'para', 'por', 'pelo', 'pela', 'um', 'uma', 'ao', 'aos',
]);
/** Palavras de título de vídeo, não de conteúdo. */
const RUIDO = new Set(['aula', 'videoaula', 'video', 'parte', 'modulo', 'capitulo', 'introducao']);
/** Grafias diferentes do mesmo conceito. */
const SINONIMOS = new Map([
  ['percentagem', 'porcentagem'],
  ['percentual', 'porcentagem'],
]);

/** Minúsculas, sem acento, "1º grau" em uma grafia só. */
function baseText(value) {
  return String(value || '')
    .replace(/[º°]/g, 'o')
    .replace(/ª/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bprimeiro\s+grau\b/g, '1o grau')
    .replace(/\bsegundo\s+grau\b/g, '2o grau')
    .replace(/\b(\d)\s*o?\s+grau\b/g, '$1o grau')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Plural simples para singular. Não é gramática: só precisa levar "Funções" e
 * "Função", "Proporções" e "Proporção" para a mesma forma dos dois lados.
 */
function stem(word) {
  if (word.length <= 3) return word;
  if (/(oes|aes)$/.test(word)) return `${word.slice(0, -3)}ao`;
  if (/ais$/.test(word)) return `${word.slice(0, -3)}al`;
  if (/eis$/.test(word)) return `${word.slice(0, -3)}el`;
  if (/[rz]es$/.test(word)) return word.slice(0, -2);
  if (/ns$/.test(word)) return `${word.slice(0, -2)}m`;
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function tokens(value) {
  const out = new Set();
  for (const raw of baseText(value).split(' ')) {
    if (!raw || VAZIAS.has(raw) || RUIDO.has(raw)) continue;
    let word = stem(raw);
    if (VAZIAS.has(word) || RUIDO.has(word)) continue;
    word = SINONIMOS.get(word) || word;
    out.add(word);
  }
  return out;
}

/**
 * Sinônimos óbvios de função: "1º grau" é a função afim e "2º grau" é a
 * quadrática. Só valem com "função" no trecho — "Equações do 1º grau" não é
 * função afim.
 */
function expand(set) {
  if (!set.has('funcao')) return set;
  const out = new Set(set);
  if (out.has('afim') || (out.has('1o') && out.has('grau'))) {
    out.add('afim');
    out.add('1o');
    out.add('grau');
  }
  if (out.has('quadratica') || (out.has('2o') && out.has('grau'))) {
    out.add('quadratica');
    out.add('2o');
    out.add('grau');
  }
  return out;
}

function keyOf(value) {
  return [...expand(tokens(value))].sort().join(' ');
}

/** Prefixo de vídeo: "Aula 05 —", "01 -", "Módulo 2:", "Vídeo 3)". */
const PREFIXO = /^\s*(?:(?:aula|videoaula|v[ií]deo\s*aula|v[ií]deo|m[oó]dulo|cap[ií]tulo|cap\.?|parte|epis[oó]dio|ep\.?|semana|dia|bloco|unidade)\s*(?:n[º°o.]?\s*)?\d+[a-z]?|\d{1,4}(?=[\s\-–—:.)|_]))\s*[-–—:.)|_]*\s*/i;
const PREFIXO_PALAVRA = /^\s*(?:aula|videoaula)\s*[-–—:]\s*/i;
/** Sufixo de vídeo: "— parte 1", "(Parte 2)", "- 3", "(1/2)", ".mp4". */
const SUFIXOS = [
  /\.(?:mp4|webm|mov|mkv|avi)\s*$/i,
  /\s*\(?\s*\d+\s*\/\s*\d+\s*\)?\s*$/,
  /\s*[-–—:(,]?\s*\b(?:parte|part|pt\.?|vol\.?|volume|aula|bloco)\s*\d+\s*\)?\s*$/i,
  /\s+[-–—]\s*\d+\s*$/,
  /\s*\(\s*\d+\s*\)\s*$/,
];

/** O título sem numeração de vídeo nem "parte N": só o que diz o conteúdo. */
function cleanTitle(title) {
  let value = String(title || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(PREFIXO, '').replace(PREFIXO_PALAVRA, '');
    if (next === value) break;
    value = next;
  }
  for (let i = 0; i < 3; i += 1) {
    const before = value;
    for (const pattern of SUFIXOS) value = value.replace(pattern, '');
    if (value === before) break;
  }
  return value.replace(/^[\s\-–—:.,;|]+|[\s\-–—:.,;|]+$/g, '').trim();
}

/** Nome de assunto apresentável: sem espaço sobrando nem pontuação no fim. */
function cleanTopicName(name) {
  const value = String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:.,;|"'“”]+|[\s\-–—:.,;|"'“”]+$/g, '')
    .trim()
    .slice(0, 120)
    .trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// ---------------------------------------------------------------------------
// Catálogo da matéria
// ---------------------------------------------------------------------------

async function loadSubject(subjectId) {
  const subject = await db.one('SELECT id, name FROM subjects WHERE id = $1', [subjectId]);
  if (!subject) {
    throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [
      { path: 'subject_id', message: 'Matéria não encontrada.' },
    ]);
  }
  return subject;
}

/** Variações de nome que contam como o mesmo item: o nome inteiro e a parte antes de ":" ou "(". */
function variants(name) {
  const out = [expand(tokens(name))];
  const head = String(name || '').split(/[(:]/)[0].trim();
  if (head && head !== String(name || '').trim()) {
    const short = expand(tokens(head));
    if (short.size) out.push(short);
  }
  return out.filter((set) => set.size > 0);
}

/** Índices do catálogo: por slug, por id e as variações de nome para casar. */
function buildCatalog(subject, topics, subtopics) {
  const topicsById = new Map(topics.map((t) => [t.id, t]));
  const topicsBySlug = new Map(topics.map((t) => [t.slug, t]));
  const subtopicsByKey = new Map(subtopics.map((st) => [`${st.topic_id}/${st.slug}`, st]));
  // slug de subassunto só é único dentro do assunto: sem o assunto, só vale o que não se repete
  const subtopicsBySlug = new Map();
  for (const st of subtopics) {
    subtopicsBySlug.set(st.slug, subtopicsBySlug.has(st.slug) ? null : st);
  }
  const entries = [
    ...topics.map((t) => ({ kind: 'topic', topic: t, subtopic: null, variants: variants(t.name) })),
    ...subtopics.map((st) => ({
      kind: 'subtopic',
      topic: topicsById.get(st.topic_id),
      subtopic: st,
      variants: variants(st.name),
    })),
  ];
  return { subject, topics, subtopics, topicsById, topicsBySlug, subtopicsByKey, subtopicsBySlug, entries };
}

/** Assuntos e subassuntos ATIVOS da matéria, prontos para casar e para o prompt. */
async function loadCatalog(subjectId) {
  const subject = await loadSubject(subjectId);
  const [topics, subtopics] = await Promise.all([
    db.many(
      `SELECT id, slug, name FROM topics WHERE subject_id = $1 AND active ORDER BY sort_order, name`,
      [subjectId]
    ),
    db.many(
      `SELECT st.id, st.topic_id, st.slug, st.name
         FROM subtopics st JOIN topics t ON t.id = st.topic_id
        WHERE t.subject_id = $1 AND t.active AND st.active
        ORDER BY t.sort_order, st.sort_order, st.name`,
      [subjectId]
    ),
  ]);

  return buildCatalog(subject, topics, subtopics);
}

// ---------------------------------------------------------------------------
// Casamento sem IA
// ---------------------------------------------------------------------------

/** Quanto do nome do catálogo o trecho cobre, se o trecho couber inteiro nele. */
function coverage(segment, entry) {
  let best = 0;
  for (const set of entry.variants) {
    let inside = true;
    for (const word of segment) {
      if (!set.has(word)) {
        inside = false;
        break;
      }
    }
    if (inside) best = Math.max(best, segment.size / set.size);
  }
  return best;
}

/**
 * Item do catálogo que corresponde ao trecho, ou null.
 *
 * Conservador de propósito: classificar errado em silêncio espalha o erro por
 * tentativa, caderno de erros e revisão. Na dúvida, devolve null e o título
 * vai para a IA, que vê o título inteiro. Dúvida é: trecho que cabe em mais
 * de um assunto sem ser exatamente nenhum ("2º grau" cabe em "Equações do 2º
 * grau" e em "Função quadrática (2º grau)"), ou trecho genérico demais
 * ("Gráficos" cobre um quinto de "Noção de função, domínio, imagem e gráficos").
 */
function matchSegment(value, catalog) {
  const segment = expand(tokens(value));
  if (!segment.size) return { empty: true };
  const scored = [];
  for (const entry of catalog.entries) {
    if (!entry.topic) continue;
    const score = coverage(segment, entry);
    if (score >= COBERTURA_MINIMA) scored.push({ entry, score });
  }
  if (!scored.length) return null;

  const max = Math.max(...scored.map((s) => s.score));
  if (max < 1) {
    // Casamento parcial só quando todos os candidatos são do mesmo assunto, e
    // aí a aula é do assunto inteiro: "Regra de Três" cabe no subassunto
    // "Regra de três composta", mas não é só ele.
    const topicIds = new Set(scored.map((s) => s.entry.topic.id));
    if (topicIds.size > 1) return null;
    return { kind: 'topic', topic: scored[0].entry.topic, subtopic: null, partial: true };
  }
  const exact = scored.filter((s) => s.score === 1);
  const exactTopics = exact.filter((s) => s.entry.kind === 'topic');
  if (exactTopics.length === 1) return exactTopics[0].entry;
  if (exactTopics.length > 1) return null;
  // só subassuntos com o nome exato do trecho
  const parents = new Set(exact.map((s) => s.entry.topic.id));
  if (parents.size > 1) return null;
  if (exact.length === 1) return exact[0].entry;
  return { kind: 'topic', topic: exact[0].entry.topic, subtopic: null };
}

/**
 * Trechos do título, cada um com o item do catálogo que casou (ou null).
 *
 * Vírgula, ";", "/", "+" e "&" sempre separam. " e " só separa quando o
 * pedaço inteiro não é um nome do catálogo: "Razão e Proporção" é UM assunto;
 * "Regra de Três e Porcentagem" são dois.
 */
function segmentsOf(clean, catalog) {
  const out = [];
  for (const piece of clean.split(/\s*[,;\/+&|]\s*/)) {
    const label = piece.trim();
    if (!label) continue;
    const whole = matchSegment(label, catalog);
    if (whole && whole.empty) continue;
    // Trecho com " e " só fica inteiro se casar com um nome do catálogo
    // ("Razão e Proporção", "Regra de três simples e composta"). Casamento
    // parcial não segura o trecho: "Funções de 2º grau e Gráficos" são dois
    // assuntos, e juntos casavam por aproximação só com a função quadrática.
    const temE = /\s+e\s+/i.test(label);
    if (whole && !(whole.partial && temE)) {
      out.push({ label, match: whole });
      continue;
    }
    const parts = label.split(/\s+e\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      out.push({ label, match: null });
      continue;
    }
    let i = 0;
    while (i < parts.length) {
      let found = null;
      let end = i + 1;
      // o trecho mais longo que casa, a partir de i
      for (let j = parts.length; j > i; j -= 1) {
        const joined = parts.slice(i, j).join(' e ');
        const match = matchSegment(joined, catalog);
        // juntar dois ou mais pedaços só com casamento exato (mesma regra de cima)
        if (match && !match.empty && (j === i + 1 || !match.partial)) {
          found = match;
          end = j;
          break;
        }
        if (match && match.empty && j === i + 1) {
          found = 'vazio';
          break;
        }
      }
      if (found === 'vazio') {
        i += 1;
        continue;
      }
      out.push({ label: parts.slice(i, end).join(' e '), match: found });
      i = end;
    }
  }
  return out;
}

function proposal(label, match) {
  return {
    label: label || null,
    topic_id: match.topic.id,
    subtopic_id: match.subtopic ? match.subtopic.id : null,
    new_topic_name: null,
    topic_name: match.topic.name,
    subtopic_name: match.subtopic ? match.subtopic.name : null,
  };
}

function newProposal(label, name) {
  return {
    label: label || name,
    topic_id: null,
    subtopic_id: null,
    new_topic_name: name,
    topic_name: null,
    subtopic_name: null,
  };
}

/** Sem repetir o mesmo assunto, no máximo três, na ordem em que apareceram. */
function uniqueTopics(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.topic_id ? `${item.topic_id}/${item.subtopic_id || ''}` : `novo:${keyOf(item.new_topic_name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ASSUNTOS) break;
  }
  return out;
}

function localIdentify(title, catalog) {
  const clean = cleanTitle(title);
  const segments = clean ? segmentsOf(clean, catalog) : [];
  const matched = segments.filter((s) => s.match);
  return {
    clean,
    segments,
    topics: uniqueTopics(matched.map((s) => proposal(s.label, s.match))),
    needsAi: segments.some((s) => !s.match),
  };
}

// ---------------------------------------------------------------------------
// IA, só para o que não casou
// ---------------------------------------------------------------------------

function buildPrompt(catalog, titles) {
  const system = [
    'Você identifica os assuntos de videoaulas pelo título, usando o conteúdo programático de uma matéria.',
    'Use somente os identificadores (slugs) fornecidos. Quando um trecho do título não tiver par na lista,',
    'proponha o nome de um assunto novo. Responda apenas com um objeto JSON válido.',
  ].join(' ');

  const subsByTopic = new Map();
  for (const st of catalog.subtopics) {
    if (!subsByTopic.has(st.topic_id)) subsByTopic.set(st.topic_id, []);
    subsByTopic.get(st.topic_id).push(st);
  }

  const lines = [];
  lines.push(`Matéria: ${catalog.subject.name}`);
  lines.push('');
  lines.push('Assuntos da matéria (slug — nome; subassuntos entre colchetes):');
  for (const topic of catalog.topics) {
    const subs = subsByTopic.get(topic.id) || [];
    const extra = subs.length ? ` [${subs.map((st) => `${st.slug} — ${st.name}`).join('; ')}]` : '';
    lines.push(`- ${topic.slug} — ${topic.name}${extra}`);
  }
  lines.push('');
  lines.push('Títulos:');
  titles.forEach((title, index) => lines.push(`ITEM ${index + 1} | ${title}`));
  lines.push('');
  lines.push('Devolva exatamente:');
  lines.push(
    '{"lessons":[{"item":1,"topics":[{"label":"trecho do título","topic_slug":"slug do assunto ou null","subtopic_slug":"slug do subassunto ou null","new_topic":"nome do assunto novo ou null"}]}]}'
  );
  lines.push('Regras:');
  lines.push('- Um elemento em "lessons" para cada ITEM, com o mesmo número.');
  lines.push(`- De 0 a ${MAX_ASSUNTOS} assuntos por título, na ordem em que aparecem no título.`);
  lines.push('- Ignore numeração e marcas de vídeo como "Aula 05", "Parte 2" e "Revisão".');
  lines.push('- Prefira sempre um assunto da lista. Subassunto só quando o trecho for exatamente aquele recorte.');
  lines.push('- "new_topic" só quando nenhum assunto da lista corresponder: nome curto de conteúdo programático, como "Juros compostos".');
  lines.push('- Título sem assunto reconhecível: "topics": [].');

  const user = lines.join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Valida o que a IA devolveu para um título contra o catálogo. */
function fromAi(raw, catalog) {
  const list = Array.isArray(raw && raw.topics) ? raw.topics : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = text(item.label).slice(0, 200);
    let topic = catalog.topicsBySlug.get(text(item.topic_slug)) || null;
    let subtopic = null;
    const subSlug = text(item.subtopic_slug);
    if (topic && subSlug) subtopic = catalog.subtopicsByKey.get(`${topic.id}/${subSlug}`) || null;
    if (!topic && subSlug) {
      // acertou o subassunto e errou o assunto: o subassunto diz de qual assunto é
      subtopic = catalog.subtopicsBySlug.get(subSlug) || null;
      if (subtopic) topic = catalog.topicsById.get(subtopic.topic_id) || null;
    }
    if (topic) {
      out.push(proposal(label, { topic, subtopic }));
      continue;
    }
    // "Novo" que já existe com outra grafia vira o existente: é assim que o
    // banco não ganha "Regra de três" ao lado de "Regra de três simples e composta".
    const name = cleanTopicName(text(item.new_topic) || '');
    const candidate = name || label;
    if (!candidate) continue;
    const match = matchSegment(candidate, catalog);
    if (match && !match.empty) out.push(proposal(label || candidate, match));
    else if (name.length >= 2) out.push(newProposal(label, name));
  }
  return uniqueTopics(out);
}

/** Uma chamada para um lote de títulos → Map(título limpo → topics validados). */
async function askChunk(catalog, titles, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < FOLGA_MINIMA_MS) throw new Error('A IA não respondeu a tempo.');
  const maxTokens = Math.min(TOKENS_TETO, TOKENS_BASE + TOKENS_POR_TITULO * titles.length);
  const result = await ai.json({
    messages: buildPrompt(catalog, titles),
    temperature: 0.2,
    maxTokens,
    retryMaxTokens: Math.min(TOKENS_TETO * 2, maxTokens * 2),
    // chamada da equipe: sem cota de aluno e sem moeda
    userId: null,
    feature: 'other',
    timeoutMs: Math.min(TIMEOUT_CHAMADA_MS, remaining),
    signal: AbortSignal.timeout(remaining),
  });
  const rows = Array.isArray(result.data && result.data.lessons) ? result.data.lessons : [];
  const byItem = new Map();
  rows.forEach((row, index) => {
    const item = Number.parseInt(row && row.item, 10);
    byItem.set(Number.isInteger(item) && item > 0 ? item : index + 1, row || {});
  });
  const answers = new Map();
  titles.forEach((title, index) => {
    if (byItem.has(index + 1)) answers.set(title, fromAi(byItem.get(index + 1), catalog));
  });
  return answers;
}

/** Os títulos que precisam da IA, em lotes e com prazo. Nunca lança. */
async function askAi(catalog, titles, deadline) {
  const answers = new Map();
  const errors = new Map();
  if (!ai.isConfigured()) {
    for (const title of titles) errors.set(title, 'A IA não está configurada');
    return { answers, errors };
  }
  const chunks = [];
  for (let i = 0; i < titles.length; i += TITULOS_POR_CHAMADA) chunks.push(titles.slice(i, i + TITULOS_POR_CHAMADA));

  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next];
      next += 1;
      try {
        const got = await askChunk(catalog, chunk, deadline);
        for (const [title, topics] of got) answers.set(title, topics);
        for (const title of chunk) if (!got.has(title)) errors.set(title, 'A IA não devolveu este título.');
      } catch (err) {
        const message = Date.now() >= deadline - 500
          ? 'A IA não respondeu a tempo.'
          : (err && err.message) || 'A IA não respondeu.';
        for (const title of chunk) errors.set(title, message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHAMADAS_EM_PARALELO, chunks.length) }, worker));
  return { answers, errors };
}

/**
 * Proposta de assuntos para cada título, sem gravar nada.
 *
 * @param {{ subjectId: string, titles: string[], deadlineMs?: number }} options
 * @returns {Promise<Array<{ title: string, via: string, error?: string, topics: object[] }>>}
 */
async function identify({ subjectId, titles, deadlineMs = PRAZO_INTERATIVO_MS } = {}) {
  const catalog = await loadCatalog(subjectId);
  const list = Array.isArray(titles) ? titles.map((t) => text(t)) : [];
  const local = list.map((title) => localIdentify(title, catalog));

  // O mesmo título (ou dois arquivos com o mesmo nome limpo) vai uma vez só.
  const pending = [...new Set(local.filter((r) => r.needsAi && r.clean).map((r) => r.clean))];
  const { answers, errors } = pending.length
    ? await askAi(catalog, pending, Date.now() + deadlineMs)
    : { answers: new Map(), errors: new Map() };

  return list.map((title, index) => {
    const r = local[index];
    if (!r.needsAi) return { title, via: r.topics.length ? 'catalogo' : 'nenhum', topics: r.topics };
    const fromModel = answers.get(r.clean);
    if (fromModel && fromModel.length) return { title, via: 'ia', topics: fromModel };
    const error = errors.get(r.clean);
    // A IA não achou nada (ou falhou): fica o que casou sem ela.
    const item = { title, via: r.topics.length ? 'parcial' : 'nenhum', topics: r.topics };
    if (error) item.error = error;
    return item;
  });
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

async function findTopic(client, subjectId, name, slug) {
  const direct = await client.one(
    `SELECT id, slug, name, active FROM topics
      WHERE subject_id = $1 AND (slug = $2 OR fe_unaccent(lower(name)) = fe_unaccent(lower($3)))
      ORDER BY (slug = $2) DESC, active DESC, sort_order
      LIMIT 1`,
    [subjectId, slug, name]
  );
  if (direct) return direct;
  // "Juro composto" e "Juros compostos" são o mesmo assunto
  const key = keyOf(name);
  if (!key) return null;
  const all = await client.many(
    'SELECT id, slug, name, active FROM topics WHERE subject_id = $1 ORDER BY active DESC, sort_order',
    [subjectId]
  );
  return all.find((t) => keyOf(t.name) === key) || null;
}

/**
 * O assunto da matéria com este nome; cria só quando não existe.
 *
 * Procura por slug, por nome sem acento e por nome normalizado (plural,
 * pontuação). Assunto desativado com o mesmo nome é reativado em vez de
 * duplicado: a aula que vai entrar nele precisa aparecer para o aluno.
 * O INSERT é o mesmo do painel de conteúdo; se outra requisição criar o mesmo
 * slug no meio do caminho, o ON CONFLICT devolve o dela.
 *
 * @param {{ one: Function, many: Function, query: Function }} client  pool ou transação
 * @param {{ req?: object, examIds?: string[], origem?: string }} [options]
 *   examIds: provas da aula — o assunto novo entra em exam_topics delas para
 *   não ficar fora do escopo do aluno
 */
async function findOrCreateTopic(client, subjectId, name, { req = null, examIds = [], origem = 'ia' } = {}) {
  const nome = cleanTopicName(name);
  const slug = slugify(nome);
  if (nome.length < 2 || !slug) {
    throw new AppError(400, 'validation_error', 'Informe um nome de assunto com pelo menos 2 caracteres.', [
      { path: 'new_topic_name', message: 'Nome de assunto inválido.' },
    ]);
  }

  const found = await findTopic(client, subjectId, nome, slug);
  if (found) {
    if (!found.active) {
      await client.query('UPDATE topics SET active = true WHERE id = $1', [found.id]);
      await audit(req, 'content.topic.update', 'topic', found.id, { active: true, origem, motivo: 'aula vinculada' });
    }
    return { id: found.id, slug: found.slug, name: found.name, created: false };
  }

  const order = Number(
    (await client.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM topics WHERE subject_id = $1', [subjectId])).next
  ) || 1;
  const row = await client.one(
    `INSERT INTO topics (subject_id, slug, name, description, sort_order, active)
     VALUES ($1, $2, $3, NULL, $4, true)
     ON CONFLICT (subject_id, slug) DO NOTHING
     RETURNING id, slug, name`,
    [subjectId, slug, nome, order]
  );
  if (!row) {
    const other = await findTopic(client, subjectId, nome, slug);
    if (!other) throw new AppError(409, 'conflict', 'Não foi possível cadastrar o assunto. Tente de novo.');
    return { id: other.id, slug: other.slug, name: other.name, created: false };
  }
  const exams = Array.from(new Set(examIds || []));
  await ensureExamCoverage(client, exams, { topicId: row.id, subjectId });
  await audit(req, 'content.topic.create', 'topic', row.id, { name: nome, exam_ids: exams, origem });
  return { ...row, created: true };
}

function invalid(path, message) {
  return new AppError(400, 'validation_error', message, [{ path, message }]);
}

/**
 * Confere a lista de assuntos enviada pelo painel e cadastra os novos.
 *
 * Tudo é validado ANTES de criar qualquer assunto: uma lista com um id de
 * outra matéria não pode deixar para trás um assunto novo criado à toa.
 *
 * @param {string} subjectId
 * @param {Array<{ topic_id?, subtopic_id?, new_topic_name?, label?, source? }>} items  1 a 3
 * @param {{ req?, examIds?: string[], source?: 'manual'|'ia', path?: string }} [options]
 * @returns {Promise<Array<{ topic_id, subtopic_id, label, source, topic_name, subtopic_name, created }>>}
 */
async function resolveTopics(subjectId, items, { req = null, examIds = [], source = 'manual', path = 'topics' } = {}) {
  const list = Array.isArray(items) ? items.slice(0, MAX_ASSUNTOS) : [];
  if (!list.length) throw invalid(path, 'Escolha pelo menos um assunto para a aula.');

  const topicIds = [...new Set(list.map((i) => i && i.topic_id).filter(Boolean))];
  const subIds = [...new Set(list.map((i) => i && i.subtopic_id).filter(Boolean))];
  const [topics, subs] = await Promise.all([
    topicIds.length ? db.many('SELECT id, subject_id, name FROM topics WHERE id = ANY($1::uuid[])', [topicIds]) : [],
    subIds.length
      ? db.many(
          `SELECT st.id, st.topic_id, st.name, t.subject_id, t.name AS topic_name
             FROM subtopics st JOIN topics t ON t.id = st.topic_id
            WHERE st.id = ANY($1::uuid[])`,
          [subIds]
        )
      : [],
  ]);
  const topicMap = new Map(topics.map((t) => [t.id, t]));
  const subMap = new Map(subs.map((s) => [s.id, s]));

  const plan = list.map((item, index) => {
    const at = `${path}.${index}`;
    const topicId = item && item.topic_id ? item.topic_id : null;
    const subId = item && item.subtopic_id ? item.subtopic_id : null;
    const entry = {
      label: text(item && item.label).slice(0, 200) || null,
      source: (item && item.source) || source,
      // nome novo quase sempre vem da identificação pelo título; só é do
      // painel quando o painel diz que foi digitado lá
      origem: item && item.source === 'manual' ? 'painel' : 'ia',
    };
    if (topicId) {
      const topic = topicMap.get(topicId);
      if (!topic) throw invalid(`${at}.topic_id`, 'Assunto não encontrado.');
      if (topic.subject_id !== subjectId) throw invalid(`${at}.topic_id`, 'O assunto não pertence à matéria selecionada.');
      entry.topic_id = topic.id;
      entry.topic_name = topic.name;
    }
    if (subId) {
      const sub = subMap.get(subId);
      if (!sub) throw invalid(`${at}.subtopic_id`, 'Subassunto não encontrado.');
      if (topicId && sub.topic_id !== topicId) throw invalid(`${at}.subtopic_id`, 'O subassunto não pertence ao assunto selecionado.');
      if (sub.subject_id !== subjectId) throw invalid(`${at}.subtopic_id`, 'O subassunto não pertence à matéria selecionada.');
      entry.topic_id = sub.topic_id;
      entry.topic_name = entry.topic_name || sub.topic_name;
      entry.subtopic_id = sub.id;
      entry.subtopic_name = sub.name;
    }
    if (!entry.topic_id) {
      const name = cleanTopicName(item && item.new_topic_name);
      if (name.length < 2) throw invalid(`${at}.new_topic_name`, 'Escolha um assunto ou informe o nome do assunto novo.');
      entry.new_topic_name = name;
    }
    return entry;
  });

  const out = [];
  for (const entry of plan) {
    if (entry.new_topic_name) {
      const topic = await findOrCreateTopic(db, subjectId, entry.new_topic_name, {
        req,
        examIds,
        origem: entry.origem,
      });
      entry.topic_id = topic.id;
      entry.topic_name = topic.name;
      entry.created = topic.created;
      entry.label = entry.label || entry.new_topic_name;
    }
    out.push({
      topic_id: entry.topic_id,
      subtopic_id: entry.subtopic_id || null,
      label: entry.label,
      source: entry.source === 'ia' ? 'ia' : 'manual',
      topic_name: entry.topic_name || null,
      subtopic_name: entry.subtopic_name || null,
      created: Boolean(entry.created),
    });
  }

  const seen = new Set();
  return out.filter((item) => {
    const key = `${item.topic_id}/${item.subtopic_id || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Grava os assuntos da aula na ordem e alinha o principal (lessons.topic_id)
 * com o primeiro. Assuntos diferentes dos que a aula tinha (inclusive outra
 * ordem, que muda a distribuição das questões) põem as questões da aula de
 * volta na fila.
 *
 * @param {{ query: Function, many: Function }} client  transação
 * @param {string} lessonId
 * @param {Array<{ topic_id, subtopic_id?, label?, source? }>} topics  já validados por resolveTopics
 * @returns {Promise<{ changed: boolean }>}
 */
async function writeLessonTopics(client, lessonId, topics) {
  const list = topics.slice(0, MAX_ASSUNTOS);
  if (!list.length) throw invalid('topics', 'Escolha pelo menos um assunto para a aula.');
  await client.query('SELECT id FROM lessons WHERE id = $1 FOR UPDATE', [lessonId]);
  const current = await client.many(
    'SELECT topic_id, subtopic_id FROM lesson_topics WHERE lesson_id = $1 ORDER BY position',
    [lessonId]
  );
  const same =
    current.length === list.length &&
    current.every((row, i) => row.topic_id === list[i].topic_id && (row.subtopic_id || null) === (list[i].subtopic_id || null));

  await client.query('DELETE FROM lesson_topics WHERE lesson_id = $1', [lessonId]);
  await client.query(
    `INSERT INTO lesson_topics (lesson_id, position, topic_id, subtopic_id, label, source)
     SELECT $1, t.position, t.topic_id, t.subtopic_id, t.label, t.source
       FROM unnest($2::smallint[], $3::uuid[], $4::uuid[], $5::text[], $6::text[])
         AS t(position, topic_id, subtopic_id, label, source)`,
    [
      lessonId,
      list.map((_, i) => i + 1),
      list.map((t) => t.topic_id),
      list.map((t) => t.subtopic_id || null),
      list.map((t) => t.label || null),
      list.map((t) => (t.source === 'ia' ? 'ia' : 'manual')),
    ]
  );
  if (!same) {
    await client.query(
      `UPDATE lessons
          SET topic_id = $2, subtopic_id = $3,
              questions_status = 'pending', questions_error = NULL, questions_updated_at = now(),
              -- assuntos novos são outra aula para a fila: tentativas zeradas, sem espera
              questions_attempts = 0, questions_retry_at = NULL
        WHERE id = $1`,
      [lessonId, list[0].topic_id, list[0].subtopic_id || null]
    );
  }
  return { changed: !same };
}

/** Garante os assuntos da aula no conteúdo programático das provas dela. */
async function coverLessonTopics(client, examIds, subjectId, topics) {
  const ids = Array.from(new Set(examIds || []));
  if (!ids.length) return;
  const seen = new Set();
  for (const topic of topics) {
    if (seen.has(topic.topic_id)) continue;
    seen.add(topic.topic_id);
    await ensureExamCoverage(client, ids, { topicId: topic.topic_id, subjectId });
  }
}

module.exports = {
  identify,
  findOrCreateTopic,
  resolveTopics,
  writeLessonTopics,
  coverLessonTopics,
  cleanTitle,
  MAX_ASSUNTOS,
  PRAZO_INTERATIVO_MS,
  // para os testes
  _internals: { tokens, keyOf, matchSegment, segmentsOf, buildCatalog, loadCatalog, buildPrompt, fromAi, localIdentify },
};

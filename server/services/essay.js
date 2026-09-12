'use strict';

/**
 * Correção de redação com IA e geração de temas.
 *
 *   const essay = require('../services/essay');
 *   const set    = await essay.getCriteriaSet(examId);                       // critérios DA PROVA
 *   const prompt = essay.buildCorrectionPrompt(set, exam, theme, content);   // { system, user, messages }
 *   const row    = await essay.correctEssay(essayId);                        // corrige e grava
 *   const theme  = await essay.generateTheme(examId, { userId });            // cria um tema novo
 *
 * Regra central: a correção usa SEMPRE o conjunto de critérios cadastrado para a prova da redação
 * (essay_criteria_sets.exam_id). As competências do ENEM nunca são aplicadas a outra prova. Quando a
 * prova não tem critérios cadastrados, entra um conjunto genérico de 0 a 10 e a correção é marcada
 * com `generic_criteria: true` para que o aluno e o administrador saibam disso.
 *
 * A resposta da IA nunca é gravada como veio: cada nota é conferida contra o máximo do critério
 * (clamp de 0 ao máximo), a nota final é a soma dos critérios e a nota máxima é a soma dos máximos.
 */
const db = require('../db/pool');
const ai = require('./ai');
const { getSetting } = require('./settings');
const { AppError } = require('../middleware/errors');

const CORRECTION_TIMEOUT_MS = 90_000;
const MAX_CONTENT_CHARS = 6000;
const MAX_SUPPORT_CHARS = 2500;
const MAX_LIST_ITEMS = 12;
const MAX_TEXT_CHARS = 1500;
const GENERIC_MAX_SCORE = 10;

/** Conjunto usado quando a prova ainda não tem critérios cadastrados no painel. */
const GENERIC_CRITERIA = Object.freeze([
  {
    key: 'tema',
    name: 'Adequação ao tema e ao gênero',
    max: 2,
    description: 'O texto trata exatamente do tema proposto e mantém o gênero dissertativo-argumentativo em prosa.',
    guidance: '0 — fuga ao tema ou outro gênero. 1 — tangencia o tema. 2 — trata do tema com posicionamento claro.',
  },
  {
    key: 'argumentacao',
    name: 'Argumentação e repertório',
    max: 2,
    description: 'Consistência dos argumentos e uso produtivo de repertório sociocultural.',
    guidance: '0 — sem argumentos. 1 — argumentos genéricos ou de senso comum. 2 — argumentos sustentados por dados, exemplos ou referências pertinentes.',
  },
  {
    key: 'estrutura',
    name: 'Estrutura e progressão',
    max: 2,
    description: 'Introdução com tese, desenvolvimento organizado em parágrafos e conclusão.',
    guidance: '0 — estrutura ausente. 1 — estrutura incompleta ou desequilibrada. 2 — estrutura completa e bem distribuída.',
  },
  {
    key: 'coesao',
    name: 'Coesão e coerência',
    max: 2,
    description: 'Articulação entre parágrafos e frases, uso variado de conectivos e retomadas.',
    guidance: '0 — texto desconexo. 1 — conexões repetitivas ou falhas. 2 — encadeamento claro e variado.',
  },
  {
    key: 'norma',
    name: 'Norma-padrão da língua portuguesa',
    max: 2,
    description: 'Ortografia, acentuação, concordância, regência, pontuação e registro formal.',
    guidance: '0 — desvios que comprometem a leitura. 1 — desvios frequentes. 2 — poucos desvios, sem prejuízo ao registro formal.',
  },
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Arredonda para 2 casas (mesma precisão de numeric(6,2)). */
function round2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

/** Conta palavras de um texto (ignora pontuação isolada e espaços múltiplos). */
function countWords(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  return clean.split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function trimText(value, max = MAX_TEXT_CHARS) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toStringList(value, { max = MAX_LIST_ITEMS, itemChars = 400 } = {}) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    const text = trimText(typeof item === 'string' ? item : item && (item.text || item.description), itemChars);
    if (text) list.push(text);
    if (list.length >= max) break;
  }
  return list;
}

function toGrammarErrors(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const excerpt = trimText(item.excerpt ?? item.trecho, 300);
    const fix = trimText(item.fix ?? item.correcao ?? item.correction, 300);
    const explanation = trimText(item.explanation ?? item.explicacao, 600);
    if (!excerpt && !fix) continue;
    list.push({ excerpt: excerpt || '', fix: fix || '', explanation: explanation || '' });
    if (list.length >= MAX_LIST_ITEMS) break;
  }
  return list;
}

/** Normaliza a lista de critérios vinda do banco (jsonb) descartando entradas inválidas. */
function normalizeCriteriaList(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const key = String(item.key || `c${index + 1}`).trim() || `c${index + 1}`;
    if (seen.has(key)) return;
    const max = round2(item.max);
    if (!(max > 0)) return;
    seen.add(key);
    list.push({
      key,
      name: String(item.name || key).trim(),
      max,
      description: item.description ? String(item.description) : null,
      guidance: item.guidance ? String(item.guidance) : null,
    });
  });
  return list;
}

/** Conjunto genérico de 0 a 10, usado quando a prova não tem critérios cadastrados. */
function genericCriteriaSet(exam = null) {
  return {
    id: null,
    exam_id: exam ? exam.id : null,
    exam_name: exam ? exam.name : null,
    name: 'Avaliação geral (0 a 10)',
    max_score: GENERIC_MAX_SCORE,
    genre: 'Texto dissertativo-argumentativo em prosa',
    criteria: GENERIC_CRITERIA.map((item) => ({ ...item })),
    instructions:
      'Esta prova ainda não tem critérios oficiais cadastrados na plataforma. Avalie o texto por uma escala ' +
      'geral de 0 a 10, distribuída entre os cinco critérios abaixo (2 pontos cada). Não aplique as ' +
      'competências do ENEM nem exija proposta de intervenção.',
    min_lines: 20,
    max_lines: 30,
    generic: true,
  };
}

/**
 * Conjunto de critérios da prova. Sempre devolve um conjunto utilizável:
 * o cadastrado (active) ou o genérico de 0 a 10 com `generic: true`.
 * @param {string|null} examId
 */
async function getCriteriaSet(examId) {
  const exam = examId
    ? await db.one('SELECT id, name, short_name, board, track, has_essay FROM exams WHERE id = $1', [examId])
    : null;

  const row = examId
    ? await db.one(
        `SELECT id, exam_id, name, max_score, genre, criteria, instructions, min_lines, max_lines
           FROM essay_criteria_sets
          WHERE exam_id = $1 AND active`,
        [examId]
      )
    : null;

  const criteria = row ? normalizeCriteriaList(row.criteria) : [];
  if (!row || criteria.length === 0) return genericCriteriaSet(exam);

  const sumOfMax = round2(criteria.reduce((total, item) => total + item.max, 0));
  return {
    id: row.id,
    exam_id: row.exam_id,
    exam_name: exam ? exam.name : null,
    name: row.name,
    // a nota máxima real é a soma dos critérios (o cadastro pode estar desatualizado)
    max_score: sumOfMax > 0 ? sumOfMax : round2(row.max_score),
    genre: row.genre,
    criteria,
    instructions: row.instructions || null,
    min_lines: row.min_lines,
    max_lines: row.max_lines,
    generic: false,
  };
}

/** A prova exige proposta de intervenção? Decidido pelos critérios cadastrados, não pela prova. */
function requiresIntervention(criteriaSet) {
  return (criteriaSet.criteria || []).some((item) =>
    /interven[çc]/i.test(`${item.name || ''} ${item.description || ''}`)
  );
}

// ---------------------------------------------------------------------------
// Prompt de correção
// ---------------------------------------------------------------------------
/**
 * Monta o prompt de correção a partir dos critérios DA PROVA da redação.
 * @param {object} criteriaSet conjunto devolvido por getCriteriaSet()
 * @param {object} exam        { name, short_name, board, track }
 * @param {object|null} theme  { title, prompt_text, support_texts }
 * @param {string} content     texto do aluno
 * @returns {{ system: string, user: string, messages: Array<{role: string, content: string}> }}
 */
function buildCorrectionPrompt(criteriaSet, exam, theme, content) {
  const set = criteriaSet || genericCriteriaSet(exam);
  const criteria = Array.isArray(set.criteria) ? set.criteria : [];
  const examName = (exam && exam.name) || set.exam_name || 'a prova selecionada';
  const board = exam && exam.board ? exam.board : null;
  const maxScore = round2(set.max_score) || round2(criteria.reduce((total, item) => total + Number(item.max || 0), 0));
  const text = String(content || '').slice(0, MAX_CONTENT_CHARS);
  const words = countWords(text);
  const intervention = requiresIntervention(set);

  const system = [
    `Você é um corretor de redação experiente${board ? ` e conhece a fundo o padrão da banca ${board}` : ''}.`,
    `Corrija a redação a seguir EXCLUSIVAMENTE pelos critérios oficiais de ${examName}, que estão listados no pedido.`,
    'Nunca aplique critérios de outra prova: se a lista recebida não traz as competências do ENEM (0 a 200) ou a',
    'exigência de proposta de intervenção, elas não existem nesta correção.',
    'A nota de cada critério precisa ficar entre 0 e o máximo informado para aquele critério, e a nota final é a',
    'soma dos critérios. Comente cada critério citando trechos do próprio texto do aluno e explique o que fazer',
    'para subir de faixa. Escreva tudo em português do Brasil, em tom respeitoso, direto e construtivo,',
    'como um professor que quer ver o aluno aprovado — sem elogios vazios e sem ironia.',
    'Responda somente com um objeto JSON válido, sem nenhum texto fora do JSON.',
  ].join(' ');

  const lines = [];
  lines.push(`Prova: ${examName}`);
  if (exam && exam.short_name) lines.push(`Sigla: ${exam.short_name}`);
  if (board) lines.push(`Banca: ${board}`);
  lines.push(`Conjunto de critérios: ${set.name}`);
  lines.push(`Gênero exigido: ${set.genre || 'Texto dissertativo-argumentativo em prosa'}`);
  lines.push(`Escala total: 0 a ${maxScore}`);
  if (set.min_lines || set.max_lines) {
    lines.push(`Extensão esperada: ${set.min_lines || '—'} a ${set.max_lines || '—'} linhas`);
  }
  lines.push(`Palavras no texto do aluno: ${words}`);
  if (set.generic) {
    lines.push('Atenção: esta prova ainda não tem critérios oficiais cadastrados; use o conjunto genérico abaixo.');
  }
  lines.push('');
  lines.push('Critérios oficiais desta prova — use exatamente estas chaves, estes nomes e estes máximos:');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      criteria.map((item) => ({
        key: item.key,
        name: item.name,
        max: item.max,
        description: item.description || undefined,
        guidance: item.guidance || undefined,
      })),
      null,
      2
    )
  );
  lines.push('```');

  if (set.instructions) {
    lines.push('');
    lines.push('Orientações da banca para a correção:');
    lines.push(set.instructions);
  }

  lines.push('');
  lines.push(`Tema proposto: ${(theme && theme.title) || 'não informado'}`);
  if (theme && theme.prompt_text) {
    lines.push('Proposta apresentada ao aluno:');
    lines.push(trimText(theme.prompt_text, 1200));
  }
  if (theme && theme.support_texts) {
    lines.push('Textos motivadores (resumidos):');
    lines.push(trimText(theme.support_texts, MAX_SUPPORT_CHARS));
  }

  lines.push('');
  lines.push('Redação do aluno:');
  lines.push('<redacao>');
  lines.push(text);
  lines.push('</redacao>');

  lines.push('');
  lines.push('Devolva um JSON exatamente com esta estrutura:');
  lines.push('{');
  lines.push('  "summary": "parecer geral em 3 a 5 frases",');
  lines.push('  "criteria": [{ "key": "chave do critério", "name": "nome do critério", "score": 0, "max": 0, "comment": "comentário com trechos do texto" }],');
  lines.push('  "strengths": ["pontos fortes, um por item"],');
  lines.push('  "weaknesses": ["pontos a melhorar, um por item"],');
  lines.push('  "grammar_errors": [{ "excerpt": "trecho do aluno", "fix": "reescrita correta", "explanation": "regra em uma frase" }],');
  lines.push('  "argumentation": "análise da argumentação",');
  lines.push('  "repertoire": "análise do repertório sociocultural",');
  lines.push('  "structure": "análise da estrutura e da progressão",');
  lines.push('  "cohesion": "análise da coesão e da coerência",');
  lines.push(
    intervention
      ? '  "intervention_proposal": "análise da proposta de intervenção (agente, ação, meio, finalidade e detalhamento)",'
      : '  "intervention_proposal": null,'
  );
  lines.push('  "suggestions": ["ações objetivas para a próxima redação"]');
  lines.push('}');
  lines.push('');
  lines.push('Regras obrigatórias:');
  lines.push(`- Devolva um item em "criteria" para cada critério da lista, na mesma ordem e com a mesma "key".`);
  lines.push('- "score" deve ser um número entre 0 e o "max" daquele critério; respeite as faixas descritas em "guidance".');
  lines.push(
    intervention
      ? '- Analise a proposta de intervenção em "intervention_proposal".'
      : '- Esta prova não exige proposta de intervenção: mantenha "intervention_proposal" com o valor null.'
  );
  lines.push('- Liste no máximo 8 erros gramaticais, priorizando os que mais pesam na nota.');
  lines.push('- Não invente trechos: todo trecho citado deve existir no texto do aluno.');
  // Mantém o parecer objetivo e evita JSON truncado em correções extensas.
  lines.push('');
  lines.push('Tamanho de cada campo (respeite, é o que garante a entrega da correção):');
  lines.push('- "summary": até 5 frases.');
  lines.push('- cada "comment" de critério: até 50 palavras.');
  lines.push('- "argumentation", "repertoire", "structure", "cohesion" e "intervention_proposal": até 60 palavras cada.');
  lines.push('- "strengths", "weaknesses" e "suggestions": até 4 itens cada, uma frase por item.');
  lines.push('- cada "explanation" de erro gramatical: uma frase curta.');

  const user = lines.join('\n');
  return {
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

// ---------------------------------------------------------------------------
// Validação da resposta da IA
// ---------------------------------------------------------------------------
/**
 * Confere a resposta da IA contra os critérios da prova: nota de cada critério entre 0 e o máximo,
 * nota final igual à soma dos critérios e nota máxima igual à soma dos máximos.
 * @returns {{ correction: object, score: number, max_score: number }}
 */
function normalizeCorrection(data, criteriaSet) {
  const source = data && typeof data === 'object' ? data : {};
  const set = criteriaSet || genericCriteriaSet(null);
  const definitions = Array.isArray(set.criteria) && set.criteria.length > 0 ? set.criteria : GENERIC_CRITERIA;

  const returned = Array.isArray(source.criteria) ? source.criteria : [];
  const byKey = new Map();
  const byName = new Map();
  returned.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.key !== undefined && item.key !== null) byKey.set(String(item.key).trim().toLowerCase(), item);
    if (item.name) byName.set(String(item.name).trim().toLowerCase(), item);
  });

  const criteria = definitions.map((definition, index) => {
    const max = round2(definition.max);
    const found =
      byKey.get(String(definition.key).trim().toLowerCase()) ||
      byName.get(String(definition.name || '').trim().toLowerCase()) ||
      returned[index] ||
      null;
    const rawScore = Number(found && found.score);
    const score = clamp(round2(Number.isFinite(rawScore) ? rawScore : 0), 0, max);
    return {
      key: definition.key,
      name: definition.name,
      max,
      score,
      comment: trimText(found && found.comment, 1200) || 'Sem comentário para este critério.',
    };
  });

  const score = round2(criteria.reduce((total, item) => total + item.score, 0));
  const maxScore = round2(criteria.reduce((total, item) => total + item.max, 0)) || round2(set.max_score);

  const correction = {
    summary: trimText(source.summary, MAX_TEXT_CHARS) || 'Correção concluída.',
    criteria,
    strengths: toStringList(source.strengths),
    weaknesses: toStringList(source.weaknesses),
    grammar_errors: toGrammarErrors(source.grammar_errors),
    argumentation: trimText(source.argumentation, MAX_TEXT_CHARS),
    repertoire: trimText(source.repertoire, MAX_TEXT_CHARS),
    structure: trimText(source.structure, MAX_TEXT_CHARS),
    cohesion: trimText(source.cohesion, MAX_TEXT_CHARS),
    intervention_proposal: requiresIntervention(set) ? trimText(source.intervention_proposal, MAX_TEXT_CHARS) : null,
    suggestions: toStringList(source.suggestions),
    score,
    max_score: maxScore,
    criteria_set_name: set.name,
    generic_criteria: Boolean(set.generic),
  };

  return { correction, score: clamp(score, 0, maxScore), max_score: maxScore };
}

// ---------------------------------------------------------------------------
// Correção
// ---------------------------------------------------------------------------
async function loadEssayForCorrection(essayId) {
  return db.one(
    `SELECT e.id, e.user_id, e.exam_id, e.theme_id, e.theme_title, e.content, e.word_count, e.status,
            x.name AS exam_name, x.short_name AS exam_short_name, x.board AS exam_board, x.track AS exam_track,
            t.title AS theme_db_title, t.prompt_text, t.support_texts
       FROM essays e
       JOIN exams x ON x.id = e.exam_id
       LEFT JOIN essay_themes t ON t.id = e.theme_id
      WHERE e.id = $1`,
    [essayId]
  );
}

/**
 * Corrige a redação com IA (síncrono) e grava correction/score/max_score/status/model/corrected_at.
 * Em caso de falha marca a redação como `failed` (com error_message) e relança um AppError 503.
 * @param {string} essayId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>} redação atualizada
 */
async function correctEssay(essayId, { timeoutMs = CORRECTION_TIMEOUT_MS } = {}) {
  const essay = await loadEssayForCorrection(essayId);
  if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');

  const content = String(essay.content || '').trim();
  if (!content) throw new AppError(400, 'validation_error', 'Escreva a redação antes de enviar para correção.');

  const criteriaSet = await getCriteriaSet(essay.exam_id);
  const exam = {
    id: essay.exam_id,
    name: essay.exam_name,
    short_name: essay.exam_short_name,
    board: essay.exam_board,
    track: essay.exam_track,
  };
  const theme = {
    title: essay.theme_db_title || essay.theme_title,
    prompt_text: essay.prompt_text,
    support_texts: essay.support_texts,
  };

  const { messages } = buildCorrectionPrompt(criteriaSet, exam, theme, content);
  const model = (await getSetting('openrouter_essay_model')) || undefined;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let result;
  try {
    // O segundo teto só é usado se o provedor cortar o primeiro JSON.
    result = await ai.json({
      messages,
      model,
      temperature: 0.2,
      maxTokens: 4000,
      retryMaxTokens: 8000,
      userId: essay.user_id,
      feature: 'essay',
      signal: controller.signal,
      timeoutMs,
    });
    if (result && result.aborted) {
      throw new AppError(503, 'ai_unavailable', 'A correção demorou mais que o esperado. Tente novamente em instantes.');
    }
  } catch (err) {
    const failure = timedOut
      ? new AppError(503, 'ai_unavailable', 'A correção demorou mais que o esperado. Tente novamente em instantes.')
      : err;
    await db.query(
      `UPDATE essays SET status = 'failed', error_message = $2, corrected_at = NULL WHERE id = $1`,
      [essay.id, String(failure && failure.message ? failure.message : failure).slice(0, 1000)]
    );
    throw failure instanceof AppError
      ? failure
      : new AppError(503, 'ai_unavailable', 'Não foi possível corrigir a redação agora. Tente novamente em instantes.');
  } finally {
    clearTimeout(timer);
  }

  const { correction, score, max_score: maxScore } = normalizeCorrection(result.data, criteriaSet);

  const updated = await db.one(
    `UPDATE essays
        SET status = 'corrected',
            correction = $2::jsonb,
            score = $3,
            max_score = $4,
            model = $5,
            error_message = NULL,
            corrected_at = now()
      WHERE id = $1
      RETURNING *`,
    [essay.id, JSON.stringify(correction), score, maxScore, result.model || null]
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Geração de tema
// ---------------------------------------------------------------------------
/** Monta o prompt de geração de tema no estilo da banca da prova. */
function buildThemePrompt(exam, existingTitles = []) {
  const board = exam.board ? exam.board : null;
  const system = [
    'Você é um elaborador de propostas de redação para bancas de vestibulares e concursos brasileiros.',
    'Crie propostas autorais, atuais e socialmente relevantes, sempre em português do Brasil.',
    'Os textos motivadores devem ser escritos por você, com dados plausíveis e linguagem jornalística —',
    'nunca reproduza trechos de obras protegidas por direito autoral nem invente citações atribuídas a pessoas reais.',
    'Responda somente com um objeto JSON válido, sem nenhum texto fora do JSON.',
  ].join(' ');

  const lines = [];
  lines.push(`Prova: ${exam.name}`);
  if (exam.short_name) lines.push(`Sigla: ${exam.short_name}`);
  if (board) lines.push(`Banca: ${board}`);
  lines.push(`Estilo: proposta no formato usado por ${board || exam.name}.`);
  lines.push('');
  if (existingTitles.length > 0) {
    lines.push('Temas já existentes na plataforma (crie um tema diferente destes, de outra área temática):');
    for (const title of existingTitles) lines.push(`- ${title}`);
    lines.push('');
  }
  lines.push('Devolva um JSON exatamente com esta estrutura:');
  lines.push('{');
  lines.push('  "title": "tema em uma frase, sem aspas e sem ponto final",');
  lines.push('  "prompt_text": "a proposta completa apresentada ao candidato, com as instruções da banca",');
  lines.push('  "support_texts": "dois ou três textos motivadores em markdown, separados por Texto I, Texto II e Texto III"');
  lines.push('}');
  lines.push('');
  lines.push('Regras obrigatórias:');
  lines.push('- O tema deve tratar de um problema social brasileiro contemporâneo, com recorte específico.');
  lines.push('- A proposta deve seguir a extensão e as exigências típicas da banca informada.');
  lines.push('- Os textos motivadores devem trazer pontos de vista diferentes e dar repertório ao candidato.');

  return {
    system,
    user: lines.join('\n'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: lines.join('\n') },
    ],
  };
}

/**
 * Gera um tema de redação com IA no estilo da prova e grava em essay_themes (generated_by_ai = true).
 * @param {string} examId
 * @param {{ userId?: string|null }} [options]
 * @returns {Promise<object>} tema criado
 */
async function generateTheme(examId, { userId = null } = {}) {
  const exam = await db.one(
    'SELECT id, name, short_name, board, track, has_essay FROM exams WHERE id = $1 AND active',
    [examId]
  );
  if (!exam) throw new AppError(404, 'not_found', 'Prova não encontrada.');

  const existing = await db.many(
    `SELECT title FROM essay_themes
      WHERE exam_id = $1 AND active
      ORDER BY created_at DESC
      LIMIT 12`,
    [exam.id]
  );

  const { messages } = buildThemePrompt(exam, existing.map((row) => row.title));
  const model = (await getSetting('openrouter_model')) || undefined;

  // O tema pede a proposta da banca MAIS três textos motivadores, e o próprio
  // código aceita gravar até 12 mil caracteres (4 mil da proposta, 8 mil dos
  // textos). Isso são cerca de 3.800 tokens de saída: com 1800 a resposta era
  // cortada no meio do JSON e chegava ao parser como "formato inválido".
  const result = await ai.json({
    messages,
    model,
    temperature: 0.9,
    maxTokens: 4500,
    userId,
    feature: 'essay_theme',
  });

  const data = result.data || {};
  const title = trimText(data.title, 240);
  if (!title) throw new AppError(503, 'ai_unavailable', 'A IA não devolveu um tema válido. Tente novamente.');

  const created = await db.one(
    `INSERT INTO essay_themes (exam_id, title, prompt_text, support_texts, source, year, generated_by_ai, active)
     VALUES ($1, $2, $3, $4, $5, $6, true, true)
     RETURNING *`,
    [
      exam.id,
      title,
      trimText(data.prompt_text, 4000),
      trimText(data.support_texts, 8000),
      `Tema gerado por IA no estilo de ${exam.board || exam.short_name || exam.name}`,
      new Date().getFullYear(),
    ]
  );
  return created;
}

module.exports = {
  GENERIC_CRITERIA,
  GENERIC_MAX_SCORE,
  CORRECTION_TIMEOUT_MS,
  MAX_CONTENT_CHARS,
  countWords,
  genericCriteriaSet,
  getCriteriaSet,
  requiresIntervention,
  buildCorrectionPrompt,
  buildThemePrompt,
  normalizeCorrection,
  correctEssay,
  generateTheme,
};

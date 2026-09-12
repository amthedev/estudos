'use strict';

/**
 * Integração com o OpenRouter — usada SOMENTE no backend.
 *
 *   const ai = require('../services/ai');
 *   ai.isConfigured()                       → true quando há OPENROUTER_API_KEY (ou cliente de simulação)
 *   await ai.assertAvailable()              → lança 503 ai_unavailable se não configurada ou limite mensal atingido
 *   await ai.chat({ messages, model, stream, temperature, maxTokens, userId, feature, onDelta, signal })
 *       → { content, usage: { prompt_tokens, completion_tokens, total_tokens }, model, latency_ms, aborted }
 *   await ai.json({ messages, retryMaxTokens, ... })
 *       → idem + `data` (resposta interpretada como JSON; repete uma vez se vier cortada)
 *   await ai.status()                       → { configured, mock, model, essay_model, month_tokens, month_requests, limit, limit_reached, last_error }
 *
 * Toda chamada registra uma linha em ai_usage (tokens, modelo, latência, status) e respeita o limite mensal
 * de tokens definido na configuração `openrouter_monthly_token_limit` (0 = sem limite). Ao exceder o limite,
 * a chamada é recusada com AppError 503 ai_unavailable 'Limite mensal de uso da IA atingido'.
 *
 * Simulação (OPENROUTER_MOCK=1, ou NODE_ENV=test sem chave): um cliente falso e determinístico responde em
 * português de forma plausível — inclusive em streaming e com JSON válido para a correção de redação —
 * para que testes e demonstrações funcionem sem custo e sem rede.
 */
const config = require('../config');
const db = require('../db/pool');
const { getSetting } = require('./settings');
const { AppError } = require('../middleware/errors');
const { TIMEZONE } = require('../utils/dates');

const FEATURES = new Set(['tutor', 'essay', 'essay_theme', 'other']);
const DEFAULT_TIMEOUT_MS = 90_000;
const UNAVAILABLE_MESSAGE = 'O Tutor IA ainda não foi ativado pela equipe.';
const LIMIT_MESSAGE = 'Limite mensal de uso da IA atingido';

let realClient = null;
let mockClient = null;
let clienteDeTeste = null;

/** Injeta um cliente falso (só usado pelos testes). Passe null para restaurar. */
function setClientForTests(client) {
  clienteDeTeste = client;
}

// ---------------------------------------------------------------------------
// Configuração / cliente
// ---------------------------------------------------------------------------
function isMock() {
  if (process.env.OPENROUTER_MOCK === '1') return true;
  return config.isTest && !config.openrouter.apiKey;
}

function isConfigured() {
  return isMock() || Boolean(config.openrouter.apiKey);
}

/** Cliente OpenRouter (ou o cliente de simulação). Lança 503 quando não há chave configurada. */
function getClient() {
  if (clienteDeTeste) return clienteDeTeste;
  if (isMock()) {
    if (!mockClient) mockClient = createMockClient();
    return mockClient;
  }
  if (!config.openrouter.apiKey) throw new AppError(503, 'ai_unavailable', UNAVAILABLE_MESSAGE);
  if (!realClient) {
    const { createClient } = require('./openrouter');
    realClient = createClient({
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      httpReferer: config.appUrl,
      appTitle: config.brandName,
    });
  }
  return realClient;
}

/** Chave mascarada para o painel (nunca o valor inteiro). */
function maskedKey() {
  const key = config.openrouter.apiKey;
  if (!key) return null;
  return `…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Uso mensal e limite
// ---------------------------------------------------------------------------
async function monthUsage() {
  const row = await db.one(
    `SELECT coalesce(sum(total_tokens), 0)::bigint AS tokens, count(*)::int AS requests
       FROM ai_usage
      WHERE created_at >= (date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
    [TIMEZONE]
  );
  return { tokens: Number(row ? row.tokens : 0) || 0, requests: Number(row ? row.requests : 0) || 0 };
}

async function monthlyLimit() {
  const value = Number(await getSetting('openrouter_monthly_token_limit'));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Lança 503 quando a IA não está configurada ou o limite mensal foi atingido. */
async function assertAvailable() {
  if (!isConfigured()) throw new AppError(503, 'ai_unavailable', UNAVAILABLE_MESSAGE);
  const limit = await monthlyLimit();
  if (limit > 0) {
    const { tokens } = await monthUsage();
    if (tokens >= limit) throw new AppError(503, 'ai_unavailable', LIMIT_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Registro de uso
// ---------------------------------------------------------------------------
function estimateTokens(text) {
  const length = typeof text === 'string' ? text.length : JSON.stringify(text || '').length;
  return Math.max(1, Math.ceil(length / 4));
}

function messagesText(messages) {
  return (messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
}

function normalizeUsage(usage, messages, content) {
  const prompt = Number(usage && usage.prompt_tokens);
  const completion = Number(usage && usage.completion_tokens);
  const promptTokens = Number.isFinite(prompt) && prompt >= 0 ? prompt : estimateTokens(messagesText(messages));
  const completionTokens = Number.isFinite(completion) && completion >= 0 ? completion : content ? estimateTokens(content) : 0;
  const total = Number(usage && usage.total_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number.isFinite(total) && total > 0 ? total : promptTokens + completionTokens,
  };
}

/** Grava em ai_usage. Nunca lança: falha no registro não pode derrubar a resposta ao aluno. */
async function recordUsage({ userId = null, feature = 'other', model = null, usage = null, status = 'ok', error = null, latencyMs = null }) {
  const safeFeature = FEATURES.has(feature) ? feature : 'other';
  const u = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  try {
    await db.query(
      `INSERT INTO ai_usage (user_id, feature, model, prompt_tokens, completion_tokens, total_tokens, status, error_message, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        safeFeature,
        model,
        u.prompt_tokens || 0,
        u.completion_tokens || 0,
        u.total_tokens || 0,
        status === 'error' ? 'error' : 'ok',
        error ? String(error).slice(0, 1000) : null,
        latencyMs === null ? null : Math.max(0, Math.round(latencyMs)),
      ]
    );
  } catch (err) {
    console.error('[ai] falha ao registrar uso:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------
function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.code === 'ABORT_ERR'));
}

/** Converte erros do provedor em AppError 503 com mensagem voltada ao aluno (detalhe técnico só no log). */
function mapError(err) {
  if (err instanceof AppError) return err;
  const status = err && Number(err.status);
  const name = err && err.name;
  let message = 'Não foi possível falar com a IA agora. Tente novamente em instantes.';
  if (status === 401 || status === 403) message = 'A integração com a IA está com a chave inválida. Avise a equipe.';
  else if (status === 429) message = 'A IA está sobrecarregada no momento. Tente novamente em instantes.';
  else if (status === 400) message = 'A solicitação ficou grande demais para a IA. Reduza o texto e tente novamente.';
  else if (name === 'APIConnectionTimeoutError' || (err && err.code === 'ETIMEDOUT')) {
    message = 'A IA demorou demais para responder. Tente novamente.';
  }
  console.error('[ai] erro na chamada ao OpenRouter:', err && err.message ? err.message : err);
  const mapped = new AppError(503, 'ai_unavailable', message);
  mapped.cause = err;
  return mapped;
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------
/**
 * Chat completion (com ou sem streaming).
 * @param {object} options
 * @param {Array<{role:string, content:string}>} options.messages
 * @param {string} [options.model]         padrão: setting openrouter_model
 * @param {boolean} [options.stream]       true → chama onDelta(text) a cada trecho
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {string|null} [options.userId]
 * @param {'tutor'|'essay'|'essay_theme'|'other'} [options.feature]
 * @param {(text: string) => void} [options.onDelta]
 * @param {AbortSignal} [options.signal]   cancela a chamada (ex.: aluno fechou a conversa)
 * @param {object} [options.responseFormat]  ex.: { type: 'json_object' }
 * @param {number} [options.timeoutMs]
 */
async function chat({
  messages,
  model,
  stream = false,
  temperature = 0.4,
  maxTokens = 1200,
  userId = null,
  feature = 'other',
  onDelta,
  signal,
  responseFormat,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('ai.chat: "messages" é obrigatório.');

  await assertAvailable();
  const client = getClient();
  const resolvedModel = model || (await getSetting('openrouter_model')) || config.openrouter.model;
  const started = Date.now();

  const params = { model: resolvedModel, messages, temperature, max_tokens: maxTokens };
  if (resolvedModel === 'qwen/qwen3.8-flash') {
    params.reasoning = { effort: feature === 'essay' ? 'low' : 'minimal', exclude: true };
  }
  if (responseFormat) params.response_format = responseFormat;
  const requestOptions = { signal, timeout: timeoutMs };

  let content = '';
  let usage = null;
  let aborted = false;
  // 'length' significa que o modelo bateu no max_tokens e a resposta foi
  // cortada no meio. Sem isso, uma resposta truncada chega ao parser como
  // "formato inválido", que manda investigar o lugar errado.
  let finishReason = null;
  let usedModel = resolvedModel;

  try {
    if (stream) {
      params.stream = true;
      const iterator = await client.chat.completions.create(params, requestOptions);
      for await (const chunk of iterator) {
        const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta ? chunk.choices[0].delta.content : null;
        if (delta) {
          content += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
        if (chunk && chunk.usage) usage = chunk.usage;
        if (chunk && chunk.model) usedModel = chunk.model;
        const razao = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
        if (razao) finishReason = razao;
      }
    } else {
      const completion = await client.chat.completions.create(params, requestOptions);
      const choice = completion && completion.choices && completion.choices[0];
      content = (choice && choice.message && choice.message.content) || '';
      finishReason = (choice && choice.finish_reason) || null;
      usage = (completion && completion.usage) || null;
      if (completion && completion.model) usedModel = completion.model;
    }
  } catch (err) {
    if (isAbortError(err) || (signal && signal.aborted)) {
      aborted = true;
    } else {
      const mapped = mapError(err);
      await recordUsage({
        userId,
        feature,
        model: usedModel,
        usage: normalizeUsage(null, messages, content),
        status: 'error',
        error: err && err.message ? err.message : String(err),
        latencyMs: Date.now() - started,
      });
      throw mapped;
    }
  }

  const finalUsage = normalizeUsage(usage, messages, content);
  await recordUsage({ userId, feature, model: usedModel, usage: finalUsage, status: 'ok', latencyMs: Date.now() - started });
  return {
    content,
    usage: finalUsage,
    model: usedModel,
    latency_ms: Date.now() - started,
    aborted,
    truncated: finishReason === 'length',
  };
}

/** Extrai um objeto JSON da resposta (tolera cercas ```json e texto ao redor). */
function parseJsonResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // tenta o próximo candidato
    }
  }
  return null;
}

/**
 * Chamada que exige JSON como resposta (response_format json_object).
 * Quando `retryMaxTokens` é maior que `maxTokens`, repete uma vez somente se
 * o provedor cortar a primeira resposta e o JSON ficar incompleto.
 */
async function json(options = {}) {
  const { retryMaxTokens, ...chatOptions } = options;
  const initialMaxTokens = Number(chatOptions.maxTokens);
  const retryLimit = Number(retryMaxTokens);
  const canRetry =
    Number.isFinite(retryLimit) &&
    retryLimit > 0 &&
    (!Number.isFinite(initialMaxTokens) || retryLimit > initialMaxTokens);
  const attempts = canRetry ? [chatOptions.maxTokens, Math.floor(retryLimit)] : [chatOptions.maxTokens];

  for (let index = 0; index < attempts.length; index += 1) {
    const maxTokens = attempts[index];
    const request = maxTokens === undefined ? chatOptions : { ...chatOptions, maxTokens };
    const result = await chat({ ...request, stream: false, responseFormat: { type: 'json_object' } });
    const data = parseJsonResponse(result.content);
    if (data) return { ...result, data };

    const hasNextAttempt = result.truncated && index + 1 < attempts.length;
    if (hasNextAttempt) {
      console.warn(
        `[ai] resposta JSON cortada com maxTokens=${maxTokens}; repetindo com maxTokens=${attempts[index + 1]}.`
      );
      continue;
    }

    const tamanho = String(result.content || '').length;
    console.error(
      `[ai] resposta JSON inválida (${tamanho} caracteres, truncada: ${result.truncated}):`,
      String(result.content || '').slice(0, 300)
    );
    if (result.truncated) {
      throw new AppError(
        503,
        'ai_unavailable',
        'A resposta da IA foi cortada antes de terminar. Isso costuma ser limite de tamanho: ' +
          'aumente o limite de tokens da geração ou tente de novo.'
      );
    }
    throw new AppError(503, 'ai_unavailable', 'A IA devolveu uma resposta em formato inválido. Tente novamente.');
  }

  throw new AppError(503, 'ai_unavailable', 'A IA não conseguiu concluir a resposta. Tente novamente.');
}

/** Situação da integração para o painel e para o front (sem expor segredos). */
async function status() {
  const [usage, limit, model, essayModel, lastError] = await Promise.all([
    monthUsage().catch(() => ({ tokens: 0, requests: 0 })),
    monthlyLimit(),
    getSetting('openrouter_model'),
    getSetting('openrouter_essay_model'),
    db
      .one(`SELECT error_message, created_at FROM ai_usage WHERE status = 'error' ORDER BY created_at DESC LIMIT 1`)
      .catch(() => null),
  ]);
  return {
    configured: isConfigured(),
    mock: isMock(),
    key: maskedKey(),
    model: model || config.openrouter.model,
    essay_model: essayModel || config.openrouter.essayModel,
    month_tokens: usage.tokens,
    month_requests: usage.requests,
    limit,
    limit_reached: limit > 0 && usage.tokens >= limit,
    last_error: lastError ? { message: lastError.error_message, at: lastError.created_at } : null,
  };
}

// ---------------------------------------------------------------------------
// Cliente de simulação (determinístico, em português)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lastMessage(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return typeof messages[i].content === 'string' ? messages[i].content : '';
  }
  return '';
}

function extractLine(text, label) {
  const match = String(text || '').match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
  return match ? match[1].trim() : null;
}

/** Arredonda a nota de um critério de forma plausível (ENEM: múltiplos de 40; demais: 1 casa decimal). */
function mockCriterionScore(max, factor) {
  const value = max * factor;
  if (max === 200) return Math.max(0, Math.min(200, Math.round(value / 40) * 40));
  if (max >= 20) return Math.round(value);
  return Math.round(value * 10) / 10;
}

function mockCorrection(prompt) {
  let criteria = [];
  const fenced = prompt.match(/```json\s*(\[[\s\S]*?\])\s*```/);
  if (fenced) {
    try {
      criteria = JSON.parse(fenced[1]);
    } catch {
      criteria = [];
    }
  }
  const essayMatch = prompt.match(/<redacao>\s*([\s\S]*?)\s*<\/redacao>/i);
  const essay = essayMatch ? essayMatch[1] : '';
  const words = essay.trim() ? essay.trim().split(/\s+/).length : 0;
  const tooShort = words < 40;
  const factors = [0.8, 0.6, 0.8, 0.7, 0.9, 0.75];

  const scored = criteria.map((item, index) => ({
    key: item.key,
    name: item.name,
    max: Number(item.max) || 0,
    score: tooShort ? 0 : mockCriterionScore(Number(item.max) || 0, factors[index % factors.length]),
    comment: tooShort
      ? 'O texto é curto demais para ser avaliado neste critério. Desenvolva a redação com introdução, argumentos e conclusão.'
      : `Atende ao critério "${item.name}" de forma consistente, com margem para aprofundar a análise e refinar a linguagem.`,
  }));

  return {
    summary: tooShort
      ? 'A redação está muito abaixo do tamanho mínimo esperado e não permite avaliar o desenvolvimento do tema. Escreva um texto completo antes de enviar para correção.'
      : 'Texto bem organizado, com tese clara e argumentação coerente. Os principais pontos de melhoria estão no aprofundamento dos argumentos, na variedade de conectivos e na revisão gramatical.',
    criteria: scored,
    strengths: tooShort
      ? []
      : ['Tese apresentada com clareza já na introdução.', 'Parágrafos com progressão lógica e retomada do tema.', 'Vocabulário adequado ao registro formal.'],
    weaknesses: tooShort
      ? ['Texto muito curto.', 'Ausência de desenvolvimento argumentativo.']
      : ['Argumentos poderiam ser sustentados com dados ou exemplos concretos.', 'Repetição de conectivos como "além disso" e "portanto".', 'Alguns períodos longos dificultam a leitura.'],
    grammar_errors: tooShort
      ? []
      : [
          { excerpt: 'a nível de', fix: 'em nível de', explanation: 'A expressão "a nível de" é considerada inadequada na norma-padrão; prefira "em nível de" ou reformule a frase.' },
          { excerpt: 'haviam pessoas', fix: 'havia pessoas', explanation: 'O verbo "haver" no sentido de existir é impessoal e fica sempre no singular.' },
        ],
    argumentation: tooShort
      ? 'Não há argumentação suficiente para análise.'
      : 'A argumentação parte de uma tese defensável e avança por dois eixos, mas os argumentos ficam no plano geral. Traga dados, exemplos históricos ou citações para dar concretude.',
    repertoire: tooShort
      ? 'Não identificado.'
      : 'O repertório sociocultural aparece de forma pontual. Vincule cada referência diretamente ao argumento que ela sustenta, evitando menções soltas.',
    structure: tooShort
      ? 'Estrutura incompleta.'
      : 'Introdução, desenvolvimento e conclusão estão presentes e identificáveis. O segundo parágrafo de desenvolvimento poderia ser dividido para ganhar clareza.',
    cohesion: tooShort
      ? 'Não avaliada.'
      : 'Boa articulação entre os parágrafos, com uso de conectivos e retomadas pronominais. Varie os operadores argumentativos para evitar repetição.',
    intervention_proposal: prompt.includes('proposta de intervenção')
      ? tooShort
        ? null
        : 'A proposta indica agente e ação, mas falta detalhar o meio de execução e o efeito esperado. Complete os cinco elementos: agente, ação, modo, finalidade e detalhamento.'
      : null,
    suggestions: tooShort
      ? ['Escreva ao menos 20 linhas com introdução, dois parágrafos de desenvolvimento e conclusão.']
      : ['Reescreva a conclusão retomando explicitamente a tese.', 'Substitua conectivos repetidos por alternativas como "ademais", "nesse sentido", "por conseguinte".', 'Revise a concordância verbal em períodos longos.'],
  };
}

function mockTheme(prompt) {
  const examName = extractLine(prompt, 'Prova') || 'a prova';
  const seed = (prompt.match(/Temas já existentes[\s\S]*/i) || [''])[0].length % 3;
  const titles = [
    'O impacto das redes sociais na formação da opinião pública no Brasil',
    'Caminhos para reduzir a evasão escolar no ensino médio brasileiro',
    'A mobilidade urbana como direito e desafio nas grandes cidades',
  ];
  const title = titles[seed];
  return {
    title,
    prompt_text: `A partir da leitura dos textos motivadores e com base nos conhecimentos construídos ao longo de sua formação, redija um texto dissertativo-argumentativo em norma-padrão da língua portuguesa sobre o tema "${title}". Selecione, organize e relacione argumentos e fatos de forma coerente e coesa em defesa de seu ponto de vista. Proposta elaborada no estilo de ${examName}.`,
    support_texts:
      '**Texto I**\n\nNos últimos anos, o debate público passou a ser mediado por plataformas digitais que decidem, por meio de algoritmos, o que cada pessoa vê. Pesquisadores apontam que essa lógica favorece conteúdos de forte carga emocional e reduz o contato com opiniões divergentes.\n\n**Texto II**\n\nSegundo levantamentos recentes, mais de 80% dos brasileiros com acesso à internet se informam principalmente por redes sociais, enquanto a confiança em veículos tradicionais oscila. Ao mesmo tempo, iniciativas de educação midiática nas escolas ainda são pontuais.\n\n**Texto III**\n\n"A liberdade de expressão pressupõe cidadãos capazes de distinguir informação de manipulação." (trecho adaptado de artigo de opinião)',
  };
}

function mockChatText(messages) {
  const system = lastMessage(messages, 'system');
  const question = lastMessage(messages, 'user').trim();
  const subject = extractLine(system, 'Matéria');
  const topic = extractLine(system, 'Assunto');
  const lesson = extractLine(system, 'Aula');
  const focus = topic || subject || 'o conteúdo que você está estudando';
  const shortQuestion = question.length > 140 ? `${question.slice(0, 137)}…` : question;

  const lower = question.toLowerCase();
  if (lower.includes('questão parecida') || lower.includes('crie uma questão')) {
    return [
      `Aqui vai uma questão no estilo da prova sobre ${focus}:`,
      '',
      '**Questão.** Considere a situação descrita no enunciado e analise as afirmações abaixo.',
      '',
      'a) A primeira afirmação está correta e justifica a segunda.',
      'b) A primeira afirmação está correta, mas não justifica a segunda.',
      'c) Apenas a segunda afirmação está correta.',
      'd) Ambas as afirmações estão incorretas.',
      'e) Não é possível concluir com os dados apresentados.',
      '',
      'Tente resolver e me diga qual alternativa você escolheu. Depois eu comento o raciocínio de cada uma.',
    ].join('\n');
  }

  return [
    'Boa pergunta. Vamos organizar o raciocínio em etapas.',
    '',
    '**1. O que está sendo pedido**',
    `Você perguntou: "${shortQuestion}". Em ${focus}, o ponto central é identificar o que o enunciado fornece e o que ele quer descobrir antes de aplicar qualquer fórmula ou regra.`,
    '',
    '**2. Passo a passo**',
    '1. Anote os dados do problema e o que cada um representa.',
    '2. Relacione esses dados com o conceito principal do assunto.',
    '3. Resolva por partes, conferindo unidades e sinais a cada etapa.',
    '4. Volte ao enunciado e verifique se a resposta faz sentido no contexto.',
    '',
    '**3. Como isso cai na prova**',
    `${lesson ? `A aula "${lesson}" mostra exatamente esse caminho. ` : ''}As bancas costumam cobrar esse conteúdo em situações do cotidiano, com uma alternativa que troca a relação entre as grandezas para confundir quem lê rápido.`,
    '',
    'Quer que eu monte uma questão parecida para você praticar?',
  ].join('\n');
}

function makeUsage(messages, content) {
  const promptTokens = estimateTokens(messagesText(messages));
  const completionTokens = estimateTokens(content);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function abortError() {
  const err = new Error('Chamada cancelada.');
  err.name = 'AbortError';
  return err;
}

async function* mockStream(content, usage, model, signal) {
  const pieces = content.match(/\S+\s*/g) || [];
  const chunkSize = 3;
  for (let i = 0; i < pieces.length; i += chunkSize) {
    if (signal && signal.aborted) throw abortError();
    await sleep(4);
    yield { model, choices: [{ index: 0, delta: { content: pieces.slice(i, i + chunkSize).join('') }, finish_reason: null }] };
  }
  yield { model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage };
}

function createMockClient() {
  return {
    mock: true,
    chat: {
      completions: {
        async create(params, options = {}) {
          const messages = params.messages || [];
          const wantsJson = params.response_format && params.response_format.type === 'json_object';
          const prompt = messagesText(messages);
          let content;
          if (wantsJson) {
            if (/"grammar_errors"/.test(prompt)) content = JSON.stringify(mockCorrection(prompt));
            else if (/"support_texts"/.test(prompt)) content = JSON.stringify(mockTheme(prompt));
            else content = JSON.stringify({ answer: mockChatText(messages) });
          } else {
            content = mockChatText(messages);
          }
          const model = `${params.model || 'mock'} (simulação)`;
          const usage = makeUsage(messages, content);
          if (params.stream) return mockStream(content, usage, model, options.signal);
          await sleep(5);
          if (options.signal && options.signal.aborted) throw abortError();
          return {
            id: `mock-${Date.now()}`,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage,
          };
        },
      },
    },
  };
}

module.exports = {
  isConfigured,
  isMock,
  getClient,
  assertAvailable,
  chat,
  json,
  status,
  recordUsage,
  monthUsage,
  monthlyLimit,
  parseJsonResponse,
  setClientForTests,
  UNAVAILABLE_MESSAGE,
  LIMIT_MESSAGE,
};

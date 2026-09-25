'use strict';

/**
 * Configurações administráveis (tabela settings, valores jsonb).
 *
 *   const { getSetting, setSetting, getAll } = require('../services/settings');
 *   const intervals = await getSetting('review_intervals');          // [1, 7, 30]
 *   await setSetting('require_subscription', true);
 *
 * Cache em memória de toda a tabela, com validade curta (para múltiplos processos)
 * e invalidação imediata ao gravar. Chaves ausentes no banco caem nos DEFAULTS.
 * Segredos (OpenRouter/Asaas/SMTP) NÃO ficam aqui: vêm apenas de variáveis de ambiente.
 */
const config = require('../config');
const db = require('../db/pool');

const CACHE_TTL_MS = 30 * 1000;

const TUTOR_SYSTEM_PROMPT = [
  'Você é o Tutor da plataforma Foco Elite, um professor particular paciente e objetivo que ajuda estudantes',
  'a se preparar para o ENEM, para o concurso da Academia do Barro Branco (Cadete PM-SP) e para vestibulares.',
  'Responda sempre em português do Brasil, com linguagem clara e adequada ao ensino médio.',
  'Explique o raciocínio passo a passo, use exemplos concretos e, quando útil, relacione o conteúdo com o',
  'formato das provas (como o tema costuma ser cobrado). Não entregue apenas a resposta final de exercícios:',
  'conduza o aluno até ela. Se a pergunta fugir dos estudos, redirecione com gentileza para o conteúdo.',
  'Use Markdown de forma moderada (listas, negrito, fórmulas simples). Seja direto e evite excesso de',
  'exclamações ou elogios vazios.',
].join(' ');

const DEFAULTS = Object.freeze({
  brand_name: config.brandName,
  logo_url: '/assets/brand/foco-elite-logo.png',
  support_email: 'suporte@focoelite.com.br',
  require_subscription: config.requireSubscription,
  openrouter_model: config.openrouter.model,
  openrouter_essay_model: config.openrouter.essayModel,
  // Modelo da leitura de prova em PDF. Vazio usa o mesmo do tutor.
  openrouter_extract_model: '',
  ai_student_monthly_token_limit: config.openrouter.studentMonthlyTokenLimit,
  tutor_system_prompt: TUTOR_SYSTEM_PROMPT,
  review_intervals: [1, 7, 30],
  schedule_defaults: {
    questions_block_min: 20,
    review_block_min: 15,
    essay_weekly: true,
    simulado_every_days: 14,
  },
  // O formato completo prometido ao aluno tem 80 questões. O teto continua
  // administrável, mas o padrão precisa conseguir entregar esse formato mesmo
  // enquanto o banco de provas ainda está sendo abastecido.
  // Zero desliga o complemento por IA.
  simulado_ai_questions_max: 80,
  private_lessons_enabled: true,
  payment_provider: 'asaas',
  daily_quotes: [
    'Disciplina transforma sonhos em realidade.',
    'Disciplina hoje, aprovação amanhã.',
    'Pequenas evoluções, grandes conquistas.',
  ],
});

let cache = null; // Map<key, value>
let cacheLoadedAt = 0;
let loading = null;
let warnedOnce = false;

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

async function loadCache() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const rows = await db.many('SELECT key, value FROM settings');
      cache = new Map(rows.map((row) => [row.key, row.value]));
      cacheLoadedAt = Date.now();
      warnedOnce = false;
    } catch (err) {
      if (!warnedOnce) {
        console.warn(`[settings] não foi possível ler a tabela settings (${err.message}); usando padrões.`);
        warnedOnce = true;
      }
      // mantém o cache anterior, se houver; senão trabalha só com DEFAULTS
      if (!cache) cache = new Map();
      cacheLoadedAt = Date.now();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function ensureCache() {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) await loadCache();
  return cache;
}

/** Descarta o cache (próxima leitura vai ao banco). */
function invalidateCache() {
  cache = null;
  cacheLoadedAt = 0;
}

/**
 * Lê uma configuração. Ordem: banco → fallback informado → DEFAULTS[key] → undefined.
 */
async function getSetting(key, fallback) {
  const map = await ensureCache();
  if (map.has(key)) return clone(map.get(key));
  if (fallback !== undefined) return fallback;
  return clone(DEFAULTS[key]);
}

/** Lê várias chaves de uma vez → objeto { key: value }. */
async function getMany(keys) {
  const result = {};
  for (const key of keys) result[key] = await getSetting(key);
  return result;
}

/** Grava (upsert) e atualiza o cache. Valor null remove a chave (volta ao padrão). */
async function setSetting(key, value) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Chave de configuração inválida.');
  if (value === null || value === undefined) {
    await db.query('DELETE FROM settings WHERE key = $1', [key]);
  } else {
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  invalidateCache();
  return getSetting(key);
}

/** Grava várias chaves: setMany({ brand_name: 'X', ... }). */
async function setMany(values) {
  for (const [key, value] of Object.entries(values || {})) {
    await setSetting(key, value);
  }
  return getAll();
}

/** Todas as configurações: DEFAULTS sobrescritos pelo que está no banco. */
async function getAll() {
  const map = await ensureCache();
  const result = clone(DEFAULTS);
  for (const [key, value] of map.entries()) result[key] = clone(value);
  return result;
}

module.exports = { getSetting, setSetting, getMany, setMany, getAll, invalidateCache, DEFAULTS };

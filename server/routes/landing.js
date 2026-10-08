'use strict';

/**
 * Conteúdo da página inicial (público).
 *
 *   GET /api/landing   [pub]  → tudo que a landing precisa em uma única chamada:
 *     {
 *       blocks: { hero: {...}, dores: {...}, ... },   // mapa por key, só blocos ativos
 *       exams: [...],                                  // só provas em destaque e ativas
 *       plans: [...],                                  // só planos ativos, sem ids do provedor de pagamento
 *       testimonials: [...],                           // só depoimentos ativos
 *       faqs: [{ id, question, answer }],              // só perguntas ativas
 *       brand: { name, support_email },
 *       countdown: { exam_short_name, exam_date, days_left } | null,  // ENEM com data futura
 *       coin_costs: { essay_correction, simulado_short, simulado_long, simulado_short_max_questions, practice, questions, essay_theme },
 *       activity: [{ first_name, exam_short_name, kind, tier, tier_label, at }]  // avisos reais (services/activity.js)
 *     }
 *
 * Regras:
 *   - Nada de texto de venda, preço, percentual ou depoimento fixo em código: tudo vem do banco.
 *     Se uma tabela estiver vazia, a chave chega vazia e a página omite a seção.
 *   - Identificadores internos do provedor de pagamento NUNCA saem daqui.
 *   - Os marcadores {{moedas}} (moedas por dia de cada nível) e {{custos}} (quanto custa cada ação
 *     em moedas) funcionam do mesmo jeito, com os valores das configurações do painel: a resposta
 *     da pergunta frequente nunca fica com número velho quando o custo ou as moedas mudam.
 *   - O marcador {{planos}} (usado nas respostas de perguntas frequentes e nos textos dos blocos)
 *     é substituído pela lista dos planos ativos formatada, uma linha por plano:
 *     "Mensal — R$ 44,90".
 *   - Cada plano já chega com as contas prontas (monthly_equivalent_cents, savings_cents) para
 *     que a página não precise inventar número nenhum. Os planos com nível trazem também
 *     daily_capacity: quanto as moedas do dia rendem em cada ação (redações corrigidas,
 *     simulados longos e curtos, práticas e questões), pela conta moedas ÷ custo das
 *     configurações. É o que traduz "60 moedas" em algo que o visitante entende.
 *   - A contagem regressiva usa a data da prova do ENEM cadastrada no painel (Provas → editar,
 *     "Data da próxima prova"). Sem data, ou com a data já passada, countdown chega nulo e a
 *     faixa não aparece.
 *   - Os avisos de atividade (activity) são só compra paga e upgrade aplicado, com o primeiro
 *     nome, a prova, o nível e a hora cheia. Desligados no painel, ou com menos avisos reais que
 *     o mínimo configurado, chegam como lista vazia e a página não mostra o balão. Se a consulta
 *     falhar, a landing continua de pé: a lista também chega vazia.
 *
 * Cache em memória de 60 segundos, invalidado por invalidateLandingCache() sempre que o painel
 * salva algum conteúdo da página inicial (server/routes/admin/landing.js) ou alguma configuração
 * (server/routes/admin/settings.js), e quando o aluno muda no perfil algo que os avisos mostram
 * (server/routes/auth.js).
 */
const router = require('express').Router();
const config = require('../config');
const db = require('../db/pool');
const { wrap } = require('../middleware/errors');
const settings = require('../services/settings');
const coins = require('../services/coins');
const activity = require('../services/activity');
const dates = require('../utils/dates');

const CACHE_TTL_MS = 60 * 1000;
const PLANS_MARKER = /\{\{\s*planos\s*\}\}/gi;
const MARKERS = { planos: PLANS_MARKER, moedas: /\{\{\s*moedas\s*\}\}/gi, custos: /\{\{\s*custos\s*\}\}/gi };

/** Nomes das ações pagas em moedas, na ordem em que a página explica. */
const COST_LABELS = [
  ['essay_correction', 'Correção de redação'],
  ['simulado_long', 'Simulado longo'],
  ['simulado_short', 'Simulado curto'],
  ['questions', 'Lote de questões da IA'],
  ['essay_theme', 'Tema de redação da IA'],
  ['practice', 'Prática da aula com IA'],
];

/** Colunas públicas dos planos — a lista é explícita justamente para não vazar ids do provedor. */
const PUBLIC_PLAN_COLUMNS = [
  'id', 'slug', 'name', 'description', 'price_cents', 'currency', 'interval', 'interval_count',
  'duration_months', 'bonus_months', 'compare_price_cents', 'badge', 'trial_days', 'features',
  'highlight', 'sort_order', 'tier',
].join(', ');

let cache = null; // { at: number, payload: object }
let loading = null;

/** Descarta o conteúdo em cache; a próxima requisição lê o banco de novo. */
function invalidateLandingCache() {
  cache = null;
}

// ---------------------------------------------------------------------------
// formatação e cálculos
// ---------------------------------------------------------------------------
const formatters = new Map();

function formatMoney(cents, currency = 'brl') {
  const code = String(currency || 'brl').toUpperCase();
  if (!formatters.has(code)) {
    try {
      formatters.set(code, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code }));
    } catch {
      formatters.set(code, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }));
    }
  }
  return formatters.get(code).format(Number(cents || 0) / 100);
}

/** Meses de acesso do plano (duração + bônus). Devolve null quando não dá para saber. */
function accessMonths(plan) {
  const duration = Number(plan.duration_months) > 0 ? Number(plan.duration_months) : 0;
  const bonus = Number(plan.bonus_months) > 0 ? Number(plan.bonus_months) : 0;
  const total = duration + bonus;
  return total > 0 ? total : null;
}

/**
 * Plano no formato público, com as contas já feitas a partir do banco.
 * `allowances` traz as moedas por dia e a cota do Tutor de cada nível, lidas
 * das configurações; plano sem nível (antigo) chega com as duas nulas.
 */
function publicPlan(row, allowances = {}, costs = null) {
  const price = Number(row.price_cents) || 0;
  const months = accessMonths(row);
  const compare = row.compare_price_cents === null || row.compare_price_cents === undefined
    ? null
    : Number(row.compare_price_cents);
  // economia só existe quando o preço de comparação é maior; nunca um número negativo
  const savings = compare !== null && compare > price ? compare - price : null;
  const tier = coins.TIERS.includes(row.tier) ? row.tier : null;
  const allowance = tier ? allowances[tier] : null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    price_cents: price,
    currency: row.currency,
    interval: row.interval,
    interval_count: row.interval_count,
    duration_months: row.duration_months,
    bonus_months: row.bonus_months,
    compare_price_cents: compare,
    badge: row.badge,
    trial_days: row.trial_days,
    features: Array.isArray(row.features) ? row.features : [],
    highlight: Boolean(row.highlight),
    monthly_equivalent_cents: months ? Math.round(price / months) : null,
    savings_cents: savings,
    tier,
    daily_coins: allowance ? allowance.daily_coins : null,
    daily_capacity: allowance ? coins.dailyCapacity(allowance.daily_coins, costs) : null,
    tutor_monthly_tokens: allowance ? allowance.tutor_monthly_tokens : null,
  };
}

/**
 * Lista dos planos ativos em texto, uma linha por plano: "Mensal — R$ 44,90".
 * Plano com mês de bônus diz quanto tempo de acesso dá: "… (13 meses de acesso)".
 */
function plansAsText(plans) {
  return plans.map((plan) => {
    const bonus = Number(plan.bonus_months) || 0;
    const access = bonus > 0 ? ` (${(Number(plan.duration_months) || 1) + bonus} meses de acesso)` : '';
    return `${plan.name} — ${formatMoney(plan.price_cents, plan.currency)}${access}`;
  }).join('\n');
}

/** Moedas por dia de cada nível, uma linha por nível: "Pro — 60 moedas por dia". */
function coinsAsText(allowances) {
  return coins.TIERS
    .filter((tier) => allowances && allowances[tier] && Number(allowances[tier].daily_coins) > 0)
    .map((tier) => `${coins.TIER_LABELS[tier]} — ${allowances[tier].daily_coins} moedas por dia`)
    .join('\n');
}

/** Custo de cada ação paga, uma linha por ação: "Correção de redação — 20 moedas". */
function costsAsText(costs) {
  if (!costs) return '';
  return COST_LABELS
    .filter(([key]) => Number(costs[key]) > 0)
    .map(([key, label]) => {
      const max = Number(costs.simulado_short_max_questions) > 0 ? costs.simulado_short_max_questions : null;
      const detalhe = !max ? '' : key === 'simulado_short' ? ` (até ${max} questões)` : key === 'simulado_long' ? ` (mais de ${max} questões)` : '';
      const n = Number(costs[key]);
      return `${label}${detalhe} — ${n} ${n === 1 ? 'moeda' : 'moedas'}`;
    })
    .join('\n');
}

/**
 * Contagem regressiva até a prova, contada no dia civil de São Paulo.
 *
 * Roda a cada resposta, e não dentro do cache: o cache guarda só a data da
 * prova, e os dias que faltam mudam à meia-noite. No dia da prova e depois
 * dela, devolve nulo — "faltam 0 dias" não vende nada.
 */
function countdownFrom(exam, today = dates.todayISO()) {
  if (!exam || !exam.exam_date) return null;
  const daysLeft = dates.diffDays(today, exam.exam_date);
  if (!(daysLeft > 0)) return null;
  return { exam_short_name: exam.exam_short_name, exam_date: exam.exam_date, days_left: daysLeft };
}

/**
 * Troca {{planos}}, {{moedas}} e {{custos}} pelos textos do momento. Marcador
 * sem valor some, sem deixar linhas em branco sobrando.
 */
function applyMarkers(text, values = {}) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  let result = text;
  let emptied = false;
  for (const [name, pattern] of Object.entries(MARKERS)) {
    pattern.lastIndex = 0;
    if (!pattern.test(result)) continue;
    pattern.lastIndex = 0;
    const value = values[name] || '';
    if (!value) emptied = true;
    result = result.replace(pattern, value);
  }
  return emptied ? result.replace(/\n{3,}/g, '\n\n').trim() : result;
}

/** Troca {{planos}} pela lista de preços do banco. Sem planos ativos, o marcador some. */
function applyPlansMarker(text, plansText) {
  if (typeof text !== 'string' || !PLANS_MARKER.test(text)) {
    PLANS_MARKER.lastIndex = 0;
    return text;
  }
  PLANS_MARKER.lastIndex = 0;
  const replaced = text.replace(PLANS_MARKER, plansText);
  // sem planos cadastrados o marcador deixaria linhas em branco sobrando
  return plansText ? replaced : replaced.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// leitura do banco
// ---------------------------------------------------------------------------
async function loadPayload() {
  const [blockRows, examRows, planRows, testimonialRows, faqRows, tourRows, brand, allowances, coinCosts, enem, activityItems] = await Promise.all([
    db.many(
      `SELECT key, eyebrow, title, subtitle, body, items, cta_label, cta_href, image_url, sort_order
         FROM landing_blocks
        WHERE active = true
        ORDER BY sort_order ASC, key ASC`
    ),
    db.many(
      `SELECT id, slug, name, short_name, track, logo_url, landing_headline, landing_text, landing_cta
         FROM exams
        WHERE active = true AND featured = true
        ORDER BY sort_order ASC, short_name ASC`
    ),
    db.many(
      `SELECT ${PUBLIC_PLAN_COLUMNS}
         FROM plans
        WHERE active = true
        ORDER BY sort_order ASC, price_cents ASC`
    ),
    db.many(
      `SELECT t.id, t.name, t.role, t.content, t.image_url, t.video_url, t.photo_url, t.rating,
              e.short_name AS exam_short_name
         FROM testimonials t
         LEFT JOIN exams e ON e.id = t.exam_id
        WHERE t.active = true
        ORDER BY t.sort_order ASC, t.created_at ASC`
    ),
    db.many(
      `SELECT id, question, answer
         FROM faqs
        WHERE active = true
        ORDER BY sort_order ASC, created_at ASC`
    ),
    db.many(
      `SELECT id, title, caption, image_url
         FROM platform_tour
        WHERE active = true
        ORDER BY sort_order ASC, id ASC`
    ),
    settings.getMany(['brand_name', 'support_email', 'meta_pixel_enabled', 'meta_pixel_id']),
    coins.tierAllowances(),
    coins.readCosts(),
    // A prova do ENEM é achada pelo slug; o nome curto é o plano B para uma
    // base em que o slug foi trocado no painel. Não depende de "destaque":
    // a contagem vale mesmo que o ENEM saia da vitrine de provas.
    db.one(
      `SELECT short_name AS exam_short_name, exam_date
         FROM exams
        WHERE active = true AND (slug = 'enem' OR upper(short_name) = 'ENEM')
        ORDER BY (slug = 'enem') DESC, sort_order ASC
        LIMIT 1`
    ),
    // Os avisos são acessório: se a consulta falhar, a página sai sem eles.
    activity.recentActivity().catch((err) => {
      console.warn(`[landing] avisos de atividade indisponíveis: ${err.message}`);
      return [];
    }),
  ]);

  const plans = planRows.map((row) => publicPlan(row, allowances, coinCosts));
  const plansText = plansAsText(plans);
  const markers = { planos: plansText, moedas: coinsAsText(allowances), custos: costsAsText(coinCosts) };

  const blocks = {};
  for (const row of blockRows) {
    blocks[row.key] = {
      key: row.key,
      eyebrow: row.eyebrow,
      title: applyMarkers(row.title, markers),
      subtitle: applyMarkers(row.subtitle, markers),
      body: applyMarkers(row.body, markers),
      items: Array.isArray(row.items) ? row.items : [],
      cta_label: row.cta_label,
      cta_href: row.cta_href,
      image_url: row.image_url,
      sort_order: row.sort_order,
    };
  }

  return {
    blocks,
    exams: examRows,
    plans,
    testimonials: testimonialRows,
    faqs: faqRows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: applyMarkers(row.answer, markers),
    })),
    platform_tour: tourRows,
    brand: {
      name: brand.brand_name,
      support_email: brand.support_email,
    },
    // Pixel do Meta para o navegador. Só o ID (público) e só quando ligado no
    // painel; o ID vem do painel (meta_pixel_id) ou do ambiente (META_PIXEL_ID).
    // O token da Conversions API nunca sai do servidor.
    tracking: {
      meta_pixel_id:
        brand.meta_pixel_enabled === true
          ? String(brand.meta_pixel_id || config.meta.pixelId || '').trim() || null
          : null,
    },
    // guardado cru (só a data); a conta dos dias é feita na resposta
    countdown: enem ? { exam_short_name: enem.exam_short_name, exam_date: enem.exam_date } : null,
    activity: activityItems,
    coin_costs: coinCosts,
  };
}

/** Payload do cache quando ainda válido; caso contrário lê o banco (uma leitura por vez). */
async function getLanding() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (loading) return loading;
  loading = (async () => {
    try {
      const payload = await loadPayload();
      cache = { at: Date.now(), payload };
      return payload;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

router.get(
  '/',
  wrap(async (req, res) => {
    const payload = await getLanding();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ...payload, countdown: countdownFrom(payload.countdown) });
  })
);

module.exports = {
  basePath: '/api/landing',
  router,
  invalidateLandingCache,
  formatMoney,
  plansAsText,
  applyPlansMarker,
  applyMarkers,
  coinsAsText,
  costsAsText,
  countdownFrom,
};

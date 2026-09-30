// =====================================================================
// /app/assinatura — planos, checkout, upgrade e situação do acesso. Também é
// a página para onde o aluno é levado quando o acesso está bloqueado.
// Consome GET /api/billing/plans, /status, /upgrade/quote, GET /api/coins e
// POST /checkout, /upgrade, /portal, /cancel.
//
// Os planos têm três níveis (Básico, Pro, Avançado) em três durações. A tela
// mostra um seletor de duração e os três níveis daquela duração. Quem ainda
// não assina vê os botões de compra; quem assina um nível vê o próprio plano
// marcado e, nos níveis acima com a mesma duração, o upgrade pagando só a
// diferença proporcional (o valor vem do servidor, nunca daqui). Plano sem
// nível (anterior aos níveis) cai na grade simples de antes. Upgrade já
// pedido e ainda não pago (status.pending_upgrade) aparece com o link da
// fatura, no lugar do botão.
//
// Query: ?plan=<slug> pré-seleciona a duração e destaca o cartão (vem da
// landing, passando pelo cadastro); ?upgrade=success é a volta do pagamento
// do upgrade; ?checkout=cancel, a desistência do checkout.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, pageHeader, emptyState, errorState, skeleton,
  badge, alertBox, confirm, qs, qsa, setLoading, on, tabs, progressBar,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtMoney, intervalLabel, statusLabel } from '../../core/format.js';
import { loadCoins, hasCoinLimit, tierLabel, coinCost, coinsText, simuladoShortLimit } from '../../core/coins.js';

const BLOCK_REASONS = {
  no_subscription: 'Escolha uma opção abaixo para liberar toda a plataforma.',
  expired: 'Renove para retomar os estudos. Seu progresso continua salvo.',
  past_due: 'Atualize o pagamento para reativar seu acesso.',
  unpaid: 'Regularize a cobrança em aberto para continuar estudando.',
  canceled: 'Escolha um plano para retomar seus estudos.',
  incomplete: 'Finalize a assinatura para liberar seu acesso.',
  incomplete_expired: 'Escolha um plano e tente novamente.',
  paused: 'Retome sua assinatura para voltar a estudar.',
};

const TIER_ORDER = ['basico', 'pro', 'avancado'];

/** Ações que gastam moedas, na ordem em que aparecem na carteira. */
const COST_LABELS = [
  { key: 'essay_correction', label: 'Correção de redação' },
  { key: 'simulado_short', label: 'Simulado curto' },
  { key: 'simulado_long', label: 'Simulado longo' },
  { key: 'practice', label: 'Pratique agora, com questão elaborada pela IA' },
  { key: 'questions', label: 'Elaborar questões no banco' },
  { key: 'essay_theme', label: 'Tema de redação gerado pela IA' },
];

let page = null;
let plans = [];
let status = null;
let wallet = null;
let offClick = null;
let selectedDuration = null;
let highlightedSlug = null;
let scrolledToHighlight = false;
/** Cotação do upgrade por id de plano: { amount_cents, remaining_days, period_end, min_applied } ou { error }. */
let quotes = new Map();
let loadToken = 0;
/** Chegou por ?upgrade=success (a volta da fatura do Asaas). */
let returnedFromUpgrade = false;

export default async function renderPage(ctx) {
  page = ctx;
  const token = ++loadToken;
  ctx.setTitle('Assinatura');
  renderTo(ctx.el, skeleton('page'));

  try {
    [plans, status, wallet] = await Promise.all([
      api.get('/api/billing/plans'),
      api.get('/api/billing/status'),
      loadCoins(),
    ]);
  } catch (err) {
    if (!page || token !== loadToken) return;
    renderTo(
      ctx.el,
      html`${pageHeader({ title: 'Assinatura' })}
        ${errorState({
          title: 'Não foi possível carregar os planos',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', ctx.el);
    if (btn) btn.addEventListener('click', () => renderPage(ctx));
    return;
  }
  if (!page || token !== loadToken) return;
  plans = Array.isArray(plans) ? plans : [];
  quotes = new Map();

  const query = ctx.query || {};
  if (query.checkout === 'cancel') {
    toast('Checkout cancelado. Você pode escolher outro plano quando quiser.', { type: 'info' });
  }
  returnedFromUpgrade = query.upgrade === 'success';
  if (returnedFromUpgrade) {
    toast('Pagamento recebido — seu plano muda assim que a confirmação chegar.', { type: 'success', duration: 7000 });
  }

  highlightedSlug = typeof query.plan === 'string' && query.plan ? query.plan : null;
  scrolledToHighlight = false;
  selectedDuration = initialDuration();

  paint();
  loadQuotes(token);
}

export function unmount() {
  if (offClick) offClick();
  offClick = null;
  page = null;
  plans = [];
  status = null;
  wallet = null;
  quotes = new Map();
  selectedDuration = null;
  highlightedSlug = null;
  returnedFromUpgrade = false;
  loadToken += 1;
}

// ---------------------------------------------------------------------
// Planos por nível e duração
// ---------------------------------------------------------------------
const durationOf = (plan) => Math.max(1, Number(plan.duration_months) || 1);
const hasTier = (plan) => TIER_ORDER.includes(plan.tier);
const tieredPlans = () => plans.filter(hasTier);
const otherPlans = () => plans.filter((plan) => !hasTier(plan));

/** Durações que têm plano com nível, da menor para a maior. */
function durations() {
  return [...new Set(tieredPlans().map(durationOf))].sort((a, b) => a - b);
}

function durationLabel(months) {
  return months === 1 ? 'Mensal' : `${months} meses`;
}

/** Assinatura em vigor (ativa, em teste ou em atraso dentro do período). */
function activeSubscription() {
  const sub = status && status.subscription;
  return sub && sub.is_active ? sub : null;
}

/** Assinatura em vigor de um plano com nível — a única que pode fazer upgrade. */
function tierSubscription() {
  const sub = activeSubscription();
  return sub && TIER_ORDER.includes(sub.plan_tier) ? sub : null;
}

/**
 * Duração que a tela abre mostrando: a do plano pedido em ?plan=, senão a do
 * plano atual (é onde estão os upgrades), senão 12 meses, senão a maior.
 */
function initialDuration() {
  const list = durations();
  if (!list.length) return null;
  const wanted = highlightedSlug ? tieredPlans().find((plan) => plan.slug === highlightedSlug) : null;
  if (wanted) return durationOf(wanted);
  const sub = tierSubscription();
  const subDuration = sub ? Number(sub.plan_duration_months) : null;
  if (subDuration && list.includes(subDuration)) return subDuration;
  if (list.includes(12)) return 12;
  return list[list.length - 1];
}

/** Planos de nível da duração escolhida, do Básico ao Avançado. */
function plansForDuration(months) {
  return tieredPlans()
    .filter((plan) => durationOf(plan) === months)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

/**
 * Busca no servidor quanto custa subir para cada nível acima do atual, na
 * mesma duração. São no máximo dois pedidos; a grade é repintada quando
 * chegam, e até lá o botão diz que está calculando.
 */
async function loadQuotes(token) {
  const sub = tierSubscription();
  if (!sub) return;
  const currentRank = TIER_ORDER.indexOf(sub.plan_tier);
  const targets = tieredPlans().filter(
    (plan) => durationOf(plan) === Number(sub.plan_duration_months) && TIER_ORDER.indexOf(plan.tier) > currentRank
  );
  if (!targets.length) return;
  await Promise.all(
    targets.map(async (plan) => {
      try {
        const quote = await api.get('/api/billing/upgrade/quote', { query: { plan_id: plan.id } });
        quotes.set(plan.id, quote);
      } catch (err) {
        quotes.set(plan.id, { error: (err && err.message) || 'Não foi possível calcular o upgrade agora.' });
      }
    })
  );
  if (!page || token !== loadToken) return;
  paintGrid();
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
function accessBlock() {
  const access = status.access || {};
  const subscription = status.subscription;

  if (!access.allowed) {
    // Quem está bloqueado por atraso ou por período vencido já teve assinatura:
    // sem este botão, a tela só mostrava o aviso e os cards de plano, e a
    // fatura em aberto — o caminho mais curto para voltar — ficava escondida.
    const jaTeveAssinatura = Boolean(subscription);
    return html`
      <div class="sub-access-notice" role="status">
        <span class="sub-access-icon">${icon('lock')}</span>
        <div class="sub-access-copy">
          <strong>Escolha um plano para continuar</strong>
          <span>${BLOCK_REASONS[access.reason] || 'Libere seu acesso completo à plataforma.'}</span>
        </div>
        ${jaTeveAssinatura
          ? html`<button type="button" class="btn btn-secondary" data-action="portal">
              ${icon('receipt')}<span>Ver faturas</span>
            </button>`
          : html`<span class="sub-access-direction" aria-hidden="true">${icon('chevron-down')}</span>`}
      </div>`;
  }

  if (subscription && subscription.is_active) {
    const tier = TIER_ORDER.includes(subscription.plan_tier) ? subscription.plan_tier : null;
    return html`
      <section class="card sub-current mb-6">
        <div class="card-body sub-current-body">
          <span class="icon-box green">${icon('badge-check')}</span>
          <div class="sub-current-main">
            <h2 class="card-title">Assinatura ${subscription.plan_name || ''}</h2>
            <p class="text-2 m-0">
              ${tier ? badge(`Nível ${tierLabel(tier)}`, 'blue') : ''}
              ${badge(statusLabel(subscription.status), subscription.status === 'trialing' ? 'blue' : 'green')}
              ${subscription.current_period_end
                ? html` ${subscription.status === 'trialing'
                    ? 'Teste grátis até'
                    : subscription.cancel_at_period_end
                      ? 'Acesso garantido até'
                      : 'Próxima renovação em'} ${fmtDate(subscription.current_period_end)}`
                : ''}
            </p>
            ${subscription.cancel_at_period_end
              ? subscription.payment_method === 'pix'
                ? html`<p class="text-2 m-0 mt-2">
                    Pagamento único: o acesso vale até a data acima e não renova sozinho. Para continuar,
                    faça um novo pagamento antes do fim.
                  </p>`
                : html`<p class="text-2 m-0 mt-2">
                    Esta assinatura não vai renovar: o acesso continua até o fim do período já pago. Se não
                    foi você quem cancelou, pode ter sido o cartão recusado — confira as faturas ou assine
                    novamente abaixo.
                  </p>`
              : ''}
          </div>
          <div class="sub-current-actions">
            <button type="button" class="btn btn-secondary" data-action="portal">${icon('credit-card')}<span>Ver faturas</span></button>
            ${subscription.cancel_at_period_end
              ? ''
              : html`<button type="button" class="btn btn-ghost btn-danger" data-action="cancel">
                  ${icon('x')}<span>Cancelar assinatura</span>
                </button>`}
          </div>
        </div>
      </section>`;
  }

  if (!status.require_subscription) {
    return alertBox({
      type: 'info',
      title: 'Acesso liberado',
      text: 'A plataforma está aberta para você: nenhum plano é exigido no momento. Se quiser apoiar e garantir a continuidade, os planos ficam abaixo.',
    });
  }

  return '';
}

/**
 * Assinante de plano anterior aos níveis. Enquanto legacy_until não passa, ele
 * tem tudo liberado e não gasta moeda; o upgrade pela diferença só existe entre
 * planos com nível, então aqui não há botão de upgrade.
 */
function legacyNotice() {
  const sub = activeSubscription();
  if (!sub || TIER_ORDER.includes(sub.plan_tier) || !tieredPlans().length) return '';
  const until = sub.legacy_until ? new Date(sub.legacy_until) : null;
  if (until && until.getTime() > Date.now()) {
    return alertBox({
      type: 'info',
      title: `Seu plano atual tem acesso completo até ${fmtDate(sub.legacy_until)}`,
      text: 'Até lá, você usa a plataforma sem limite de moedas. Os planos por nível, abaixo, ficam disponíveis para você quando a assinatura atual terminar.',
    });
  }
  return alertBox({
    type: 'info',
    title: 'Seu plano é anterior aos níveis',
    text: 'Ele conta como o nível Básico nas moedas do dia. Para trocar de plano, fale com o suporte.',
  });
}

/** Moedas de hoje, nível e o custo de cada ação. */
function walletBlock() {
  if (!wallet || !(status.access && status.access.allowed)) return '';

  if (wallet.unlimited) {
    const sub = activeSubscription();
    const motivo = {
      legacy: sub && sub.legacy_until ? `Seu plano atual não gasta moedas até ${fmtDate(sub.legacy_until)}.` : 'Seu plano atual não gasta moedas.',
      override: 'Seu acesso foi liberado pela equipe e não gasta moedas.',
      open: 'A plataforma está aberta e nenhuma ação gasta moedas.',
      admin: 'Contas da equipe não gastam moedas.',
    }[wallet.reason];
    if (!motivo) return '';
    return html`
      <section class="card sub-wallet">
        <div class="card-body sub-wallet-body">
          <span class="sub-wallet-icon">${icon('infinity')}</span>
          <div class="sub-wallet-main">
            <span class="sub-section-eyebrow">Suas moedas</span>
            <h2 class="sub-wallet-title">Sem limite de moedas</h2>
            <p class="sub-wallet-text">${motivo}</p>
          </div>
        </div>
      </section>`;
  }

  if (!hasCoinLimit(wallet)) return '';
  const balance = Math.max(0, Number(wallet.balance) || 0);
  const daily = Math.max(0, Number(wallet.daily) || 0);
  const granted = Math.max(0, Number(wallet.granted) || 0);
  const pct = daily + granted > 0 ? (balance / (daily + granted)) * 100 : 0;
  const costs = COST_LABELS
    .map((item) => ({ ...item, cost: Number(wallet.costs && wallet.costs[item.key]) || 0 }))
    .filter((item) => item.cost > 0);
  const limit = simuladoShortLimit(wallet);

  return html`
    <section class="card sub-wallet">
      <div class="card-body sub-wallet-body">
        <span class="sub-wallet-icon">${icon('coins')}</span>
        <div class="sub-wallet-main">
          <span class="sub-section-eyebrow">Suas moedas · nível ${wallet.tier_label || tierLabel(wallet.tier)}</span>
          <h2 class="sub-wallet-title"><strong>${balance}</strong> de ${daily + granted} moedas hoje</h2>
          ${progressBar(pct, { color: balance > 0 ? 'warning' : 'danger', size: 'sm', label: '', showValue: false })}
          <p class="sub-wallet-text">
            As moedas renovam à meia-noite e o que sobra não passa para o dia seguinte.
            ${granted ? `Hoje inclui ${coinsText(granted)} extras dadas pela equipe.` : ''}
            O Tutor IA não gasta moedas: ele tem uma cota por mês em cada nível.
          </p>
        </div>
        ${costs.length
          ? html`
            <ul class="sub-wallet-costs" aria-label="Quanto custa cada ação">
              ${costs.map((item) => html`
                <li>
                  <span>${item.key === 'simulado_short' && limit
                    ? `Simulado com até ${limit} questões`
                    : item.key === 'simulado_long' && limit
                      ? `Simulado com mais de ${limit} questões`
                      : item.label}</span>
                  ${coinCost(item.cost)}
                </li>`)}
            </ul>`
          : ''}
      </div>
    </section>`;
}

/**
 * Destaques da faixa do topo.
 *
 * Vêm dos benefícios dos planos, que o professor edita no painel — antes eram
 * quatro itens fixos no código, prometendo recursos mesmo que ele deixasse de
 * oferecer algum. Pega os do plano mais completo, que é o que tem mais itens.
 */
function heroHighlights() {
  const maisCompleto = plans.reduce(
    (melhor, plan) => {
      const lista = Array.isArray(plan.features) ? plan.features : [];
      return lista.length > melhor.length ? lista : melhor;
    },
    []
  );
  return maisCompleto.slice(0, 4);
}

function heroBlock() {
  const active = Boolean(activeSubscription());
  const destaques = heroHighlights();
  return html`
    <header class="sub-hero">
      <img
        class="sub-hero-image"
        src="/assets/platform/plataforma-multidispositivo.jpg"
        alt=""
        width="1450"
        height="1088"
      >
      <div class="sub-hero-copy">
        <div class="sub-hero-eyebrow"><span></span>Assinatura Foco Elite</div>
        <h1>${active ? 'Seu acesso está ativo.' : 'Seu plano. Seu ritmo. Acesso completo.'}</h1>
        <p>${active
          ? 'Acompanhe sua assinatura, suas moedas do dia e os níveis disponíveis.'
          : 'Escolha o nível e o período e comece sua preparação com direção.'}</p>
      </div>
    </header>
    ${destaques.length
      ? html`<div class="sub-benefits" aria-label="Recursos incluídos nos planos">
          ${destaques.map((texto) => html`<span>${icon('circle-check')}<strong>${texto}</strong></span>`)}
        </div>`
      : ''}`;
}

function billingLabel(plan) {
  const count = Math.max(1, Number(plan.interval_count) || 1);
  if (plan.interval === 'year') return count === 1 ? 'por ano' : `a cada ${count} anos`;
  if (plan.interval === 'month') return count === 1 ? 'por mês' : `a cada ${count} meses`;
  return intervalLabel(plan.interval, count);
}

function planSummary(plan) {
  const accessMonths = Math.max(1, Number(plan.access_months) || Number(plan.duration_months) || 1);
  const monthlyEquivalent = Number(plan.monthly_equivalent_cents);
  const savings = Number(plan.savings_cents);

  if (accessMonths > 1 && Number.isFinite(monthlyEquivalent) && monthlyEquivalent > 0) {
    return html`
      <div class="sub-plan-equivalent">
        <strong>${fmtMoney(monthlyEquivalent, { currency: plan.currency })}<span>/mês</span></strong>
        <span>${accessMonths} meses de acesso</span>
      </div>
      ${Number.isFinite(savings) && savings > 0
        ? html`<span class="sub-plan-saving">Economize ${fmtMoney(savings, { currency: plan.currency })}</span>`
        : ''}`;
  }

  return html`
    <div class="sub-plan-equivalent">
      <strong>Flexibilidade total</strong>
      <span>Renovação mensal</span>
    </div>`;
}

function visiblePlanFeatures(plan) {
  const accessMonths = Math.max(1, Number(plan.access_months) || Number(plan.duration_months) || 1);
  const hasSavings = Number(plan.savings_cents) > 0;
  return (Array.isArray(plan.features) ? plan.features : []).filter((feature) => {
    const text = String(feature || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (text === 'acesso completo a plataforma') return false;
    if (hasSavings && text.includes('economia')) return false;
    if (accessMonths > 1 && text.startsWith(`${accessMonths} meses de acesso`)) return false;
    return true;
  });
}

function featuresList(plan) {
  const features = visiblePlanFeatures(plan);
  if (!features.length) return '';
  return html`
    <div class="sub-plan-includes">Destaques do plano</div>
    <ul class="checklist sub-plan-features">
      ${features.map((feature) => html`<li><span class="sub-feature-check">${icon('check', { size: 14 })}</span><span>${feature}</span></li>`)}
    </ul>`;
}

function paymentMethods() {
  const methods = Array.isArray(status.payment_methods) ? status.payment_methods : ['credit_card'];
  return { card: methods.includes('credit_card'), pix: methods.includes('pix') };
}

/** O plano oferece o teste de 24h? Só para quem ainda não assina e só no cartão. */
function hasTrial(plan) {
  return Number(plan.trial_days) > 0 && paymentMethods().card && !activeSubscription();
}

function trialBlock(plan) {
  if (!hasTrial(plan)) return '';
  return html`
    <div class="sub-trial">
      ${icon('gift')}
      <div><strong>24 horas grátis</strong><span>No cartão. Cobrança após 24h.</span></div>
    </div>`;
}

/**
 * Botões de compra (cartão e Pix). Quem já tem assinatura em vigor não vê
 * compra: o servidor recusa uma segunda assinatura, e o botão só terminava
 * num erro. Para subir de nível existe o upgrade.
 */
function checkoutActions(plan) {
  if (activeSubscription()) {
    return html`<p class="sub-plan-note">${icon('info', { size: 14 })}<span>Disponível quando sua assinatura atual terminar.</span></p>`;
  }
  const disabled = !status.payments_configured;
  const { card, pix } = paymentMethods();
  const trial = hasTrial(plan);
  return html`
    ${card ? html`
      <button type="button" class="btn btn-primary btn-block sub-plan-cta" data-action="checkout" data-id="${plan.id}" data-method="credit_card" ${disabled ? 'disabled' : ''}>
        ${icon('credit-card')}<span>${trial ? 'Começar 24h grátis' : 'Assinar com cartão'}</span>${icon('arrow-right')}
      </button>
    ` : ''}
    ${pix ? html`
      <button type="button" class="btn btn-secondary btn-block sub-pix-cta" data-action="checkout" data-id="${plan.id}" data-method="pix" ${disabled ? 'disabled' : ''}>
        ${icon('zap')}<span>Pagar com Pix</span>
      </button>
      <p class="sub-payment-note">
        Pagamento único de todo o período, à vista. Não renova sozinho: quando acabar, é só
        pagar de novo.${trial ? ' O teste de 24h vale só no cartão.' : ''}
      </p>
    ` : ''}
    ${disabled ? html`<p class="hint text-center mt-2">Pagamentos indisponíveis no momento.</p>` : ''}`;
}

/** Cartão de plano sem nível (grade simples, como antes dos níveis). */
function planCard(plan) {
  const tag = plan.badge || (plan.highlight ? 'Recomendado' : hasTrial(plan) ? 'Teste disponível' : 'Plano flexível');
  const selected = highlightedSlug && plan.slug === highlightedSlug;
  return html`
    <article class="card sub-plan ${plan.highlight ? 'sub-plan-highlight' : ''} ${selected ? 'is-selected' : ''}" data-plan-slug="${plan.slug || ''}">
      <div class="card-body">
        <div class="sub-plan-head">
          <div>
            <span class="sub-plan-tag">${tag}</span>
            <h3 class="sub-plan-name">${plan.name}</h3>
          </div>
          ${plan.highlight ? html`<span class="sub-plan-star" aria-label="Plano recomendado">${icon('sparkles')}</span>` : ''}
        </div>
        <div class="sub-plan-price">
          <strong>${fmtMoney(plan.price_cents, { currency: plan.currency })}</strong>
          <span>${billingLabel(plan)}</span>
        </div>
        ${planSummary(plan)}
        ${trialBlock(plan)}
        ${featuresList(plan)}
        <div class="sub-payment-actions">${checkoutActions(plan)}</div>
      </div>
    </article>`;
}

/** "2" / "3,3" — quantas vezes o tempo de Tutor do nível de base. */
function fmtRatio(value) {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

/**
 * Tempo de Tutor IA do nível, dito sem jargão: o aluno não sabe o que é um
 * token. Compara com o menor nível da mesma duração ("2× o tempo do Básico"),
 * e os números saem das configurações do painel.
 */
function tutorLine(plan, group) {
  const tokens = Number(plan.tutor_monthly_tokens);
  if (plan.tutor_monthly_tokens === null || plan.tutor_monthly_tokens === undefined || !Number.isFinite(tokens)) return '';
  if (tokens <= 0) return 'Sem Tutor IA';
  const positives = group.filter((item) => Number(item.tutor_monthly_tokens) > 0);
  const base = positives.reduce((menor, item) => (Number(item.tutor_monthly_tokens) < Number(menor.tutor_monthly_tokens) ? item : menor), positives[0]);
  const ratio = base ? tokens / Number(base.tutor_monthly_tokens) : 1;
  if (!base || base.id === plan.id || ratio < 1.05) return 'Tutor IA com cota mensal';
  return `${fmtRatio(ratio)}× o tempo de Tutor IA do ${tierLabel(base.tier)}`;
}

/** "3 correções de redação por dia", a conta das moedas do nível pelo custo da correção. */
function essaysPerDay(daily) {
  const cost = wallet && wallet.costs ? Number(wallet.costs.essay_correction) || 0 : 0;
  if (!cost || !daily) return '';
  const n = Math.floor(daily / cost);
  if (n < 1) return '';
  return n === 1 ? 'dá para 1 correção de redação por dia' : `dá para ${n} correções de redação por dia`;
}

function upgradeNote(text) {
  return html`<p class="sub-plan-note">${icon('info', { size: 14 })}<span>${text}</span></p>`;
}

/**
 * Upgrade já pedido que espera pagamento (GET /api/billing/status). O
 * servidor só devolve o pedido que ainda vale se for pago agora.
 */
function pendingUpgrade() {
  const pending = status && status.pending_upgrade;
  return pending && pending.invoice_url && pending.to_plan && tierSubscription() ? pending : null;
}

/** Aviso no topo: o aluno voltou sem pagar, ou pagou e a confirmação ainda não chegou. */
function pendingUpgradeNotice() {
  const pending = pendingUpgrade();
  if (!pending) return '';
  const name = pending.to_plan.name || 'o novo nível';
  const amount = fmtMoney(pending.amount_cents);
  return alertBox({
    type: 'info',
    title: `Upgrade para ${name} aguardando pagamento`,
    text: returnedFromUpgrade
      ? `Se você já pagou os ${amount}, o nível muda sozinho assim que a confirmação chegar — atualize a página daqui a pouco. Se não terminou o pagamento, é só abrir a fatura.`
      : `Assim que o pagamento de ${amount} for confirmado, seu nível muda. O período do seu plano continua o mesmo.`,
    actions: html`<a class="btn btn-primary btn-sm" href="${pending.invoice_url}" rel="noopener">${icon('external-link')}<span>Abrir fatura</span></a>`,
  });
}

/** Botões do cartão de nível para quem já assina: plano atual, upgrade ou nada. */
function subscriberActions(plan) {
  const sub = activeSubscription();
  if (sub.plan_id === plan.id) {
    return html`<p class="sub-plan-note sub-plan-note-current">${icon('badge-check', { size: 14 })}<span>Este é o seu plano atual.</span></p>`;
  }
  if (!TIER_ORDER.includes(sub.plan_tier)) {
    return upgradeNote('Disponível quando sua assinatura atual terminar.');
  }
  const rank = TIER_ORDER.indexOf(plan.tier);
  const currentRank = TIER_ORDER.indexOf(sub.plan_tier);
  if (rank < currentRank) return upgradeNote('Nível abaixo do seu plano atual.');
  if (rank === currentRank) return upgradeNote('Mesmo nível do seu plano, em outra duração.');
  if (durationOf(plan) !== Number(sub.plan_duration_months)) {
    return upgradeNote(`O upgrade vale para os planos com a mesma duração do seu (${durationLabel(Number(sub.plan_duration_months) || 1).toLowerCase()}).`);
  }

  const quote = quotes.get(plan.id);
  // Upgrade para este nível já pedido e esperando pagamento: um clique novo só
  // cancelaria a fatura aberta e criaria outra igual.
  const pending = pendingUpgrade();
  if (pending && pending.to_plan && pending.to_plan.id === plan.id) {
    return html`
      <a class="btn btn-primary btn-block sub-plan-cta" href="${pending.invoice_url}" rel="noopener">
        ${icon('external-link')}<span>Abrir fatura</span>
      </a>
      <p class="sub-payment-note">
        Upgrade para ${plan.name} aguardando pagamento de ${fmtMoney(pending.amount_cents, { currency: plan.currency })}.
        O nível muda assim que o pagamento for confirmado.
      </p>`;
  }

  if (!quote) {
    return html`
      <button type="button" class="btn btn-primary btn-block sub-plan-cta" disabled>
        ${icon('loader-circle')}<span>Calculando o valor do upgrade…</span>
      </button>`;
  }
  if (quote.error) return upgradeNote(quote.error);

  const disabled = !status.payments_configured;
  return html`
    <button type="button" class="btn btn-primary btn-block sub-plan-cta sub-upgrade-cta" data-action="upgrade" data-id="${plan.id}" ${disabled ? 'disabled' : ''}>
      ${icon('arrow-up-right')}<span>Fazer upgrade — pague só ${fmtMoney(quote.amount_cents, { currency: plan.currency })}</span>
    </button>
    <p class="sub-payment-note">
      ${quote.min_applied
        ? 'Valor mínimo de cobrança do upgrade.'
        : `Diferença proporcional aos ${quote.remaining_days} ${quote.remaining_days === 1 ? 'dia que falta' : 'dias que faltam'} no seu plano.`}
      O período continua até ${fmtDate(quote.period_end)}.
      ${pending ? ` Pedir este upgrade cancela a fatura aberta do upgrade para ${pending.to_plan.name}.` : ''}
    </p>
    ${disabled ? html`<p class="hint text-center mt-2">Pagamentos indisponíveis no momento.</p>` : ''}`;
}

/** Cartão de um nível (Básico, Pro, Avançado) na duração escolhida. */
function tierCard(plan, group) {
  const sub = activeSubscription();
  const isCurrent = Boolean(sub && sub.plan_id === plan.id);
  const selected = Boolean(highlightedSlug && plan.slug === highlightedSlug);
  const compare = Number(plan.compare_price_cents);
  const daily = Number(plan.daily_coins);
  const tutor = tutorLine(plan, group);
  const essays = Number.isFinite(daily) && daily > 0 ? essaysPerDay(daily) : '';
  return html`
    <article class="card sub-plan sub-tier-plan ${plan.highlight ? 'sub-plan-highlight' : ''} ${isCurrent ? 'is-current' : ''} ${selected ? 'is-selected' : ''}"
             data-plan-slug="${plan.slug || ''}">
      <div class="card-body">
        <div class="sub-plan-head">
          <div>
            <span class="sub-plan-tag">Nível ${tierLabel(plan.tier)}</span>
            <h3 class="sub-plan-name">${plan.name}</h3>
          </div>
          ${isCurrent
            ? html`<span class="sub-plan-badge sub-plan-badge-current">${icon('badge-check', { size: 13 })}Seu plano</span>`
            : plan.badge
              ? html`<span class="sub-plan-badge">${plan.badge}</span>`
              : ''}
        </div>
        ${Number.isFinite(compare) && compare > Number(plan.price_cents)
          ? html`<div class="sub-plan-compare">de <s>${fmtMoney(compare, { currency: plan.currency })}</s> por</div>`
          : ''}
        <div class="sub-plan-price">
          <strong>${fmtMoney(plan.price_cents, { currency: plan.currency })}</strong>
          <span>${billingLabel(plan)}</span>
        </div>
        ${planSummary(plan)}
        ${(Number.isFinite(daily) && daily > 0) || tutor
          ? html`
            <ul class="sub-tier-perks">
              ${Number.isFinite(daily) && daily > 0
                ? html`<li class="sub-tier-coins">
                    ${icon('coins')}
                    <span><strong>${daily} moedas por dia</strong>${essays ? html`<small>${essays}</small>` : ''}</span>
                  </li>`
                : ''}
              ${tutor ? html`<li class="sub-tier-tutor">${icon('bot')}<span>${tutor}</span></li>` : ''}
            </ul>`
          : ''}
        ${trialBlock(plan)}
        ${featuresList(plan)}
        <div class="sub-payment-actions">
          ${sub ? subscriberActions(plan) : checkoutActions(plan)}
        </div>
      </div>
    </article>`;
}

function tierCards() {
  const group = plansForDuration(selectedDuration);
  if (!group.length) {
    return html`<p class="text-3">Nenhum plano disponível nesta duração.</p>`;
  }
  return group.map((plan) => tierCard(plan, group));
}

function trustFooter() {
  if (!(status.payments_configured && status.payment_provider !== 'none')) return '';
  return html`<footer class="sub-checkout-trust">
    <span class="sub-trust-icon">${icon('shield-check')}</span>
    <div>
      <strong>Pagamento processado pelo ${status.payment_provider_label || 'Asaas'}</strong>
      <span>Seu acesso é atualizado após a confirmação.</span>
    </div>
    ${status.support_email ? html`<a href="mailto:${status.support_email}">Precisa de ajuda?</a>` : ''}
  </footer>`;
}

function plansBlock() {
  if (!plans.length) {
    return emptyState({
      icon: 'credit-card',
      title: 'Nenhum plano disponível',
      text: 'Os planos ainda não foram publicados. Fale com o suporte para liberar seu acesso.',
    });
  }

  const active = Boolean(activeSubscription());
  const tiered = tieredPlans();

  // Sem nenhum plano com nível publicado, a tela é a grade simples de antes.
  if (!tiered.length) {
    return html`
      <section class="sub-plans-section">
        <div class="sub-section-head">
          <div>
            <span class="sub-section-eyebrow">Planos</span>
            <h2>${active ? 'Compare outras opções' : 'Escolha seu período'}</h2>
          </div>
          <p>Compare os planos e escolha o que funciona para sua rotina.</p>
        </div>
        <div class="grid grid-3 sub-plans">${plans.map(planCard)}</div>
        ${trustFooter()}
      </section>`;
  }

  const others = otherPlans();
  return html`
    <section class="sub-plans-section" id="sub-plans">
      <div class="sub-section-head">
        <div>
          <span class="sub-section-eyebrow">Planos</span>
          <h2>${tierSubscription() ? 'Suba de nível quando quiser' : 'Escolha seu nível'}</h2>
        </div>
        <p>
          As moedas pagam o que usa IA: correção de redação, simulados e questões elaboradas na hora.
          Quanto maior o nível, mais moedas por dia.
        </p>
      </div>
      ${legacyNotice()}
      ${durations().length > 1 ? html`<div class="sub-durations" data-sub-durations></div>` : ''}
      <div class="grid grid-3 sub-plans sub-tier-grid" data-sub-grid>${tierCards()}</div>
      ${others.length
        ? html`
          <div class="sub-others">
            <h3 class="sub-others-title">Outros planos</h3>
            <div class="grid grid-3 sub-plans">${others.map(planCard)}</div>
          </div>`
        : ''}
      ${trustFooter()}
    </section>`;
}

function paymentsWarning() {
  if (status.payments_configured) return '';
  if (!status.require_subscription) return '';
  return alertBox({
    type: 'danger',
    title: 'Pagamentos indisponíveis',
    text: 'A integração de pagamento ainda não foi configurada. Fale com o suporte para liberar seu acesso.',
  });
}

// ---------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------
function paint() {
  renderTo(
    page.el,
    html`
      <div class="sub-page">
        ${heroBlock()}
        ${accessBlock()}
        ${pendingUpgradeNotice()}
        ${walletBlock()}
        ${paymentsWarning()}
        ${plansBlock()}
      </div>`
  );

  mountDurationTabs();

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    const action = trigger.dataset.action;
    if (action === 'checkout') startCheckout(trigger.dataset.id, trigger.dataset.method, trigger);
    else if (action === 'upgrade') startUpgrade(trigger.dataset.id, trigger);
    else if (action === 'portal') openPortal(trigger);
    else if (action === 'cancel') cancelSubscription(trigger);
  });

  scrollToHighlight();
}

/** Seletor Mensal / 6 meses / 12 meses: troca só a grade, sem repintar a página. */
function mountDurationTabs() {
  const holder = qs('[data-sub-durations]', page.el);
  if (!holder) return;
  tabs(
    holder,
    durations().map((months) => ({ id: String(months), label: durationLabel(months) })),
    (id) => {
      selectedDuration = Number(id);
      paintGrid();
    },
    { active: String(selectedDuration), pills: true }
  );
}

function paintGrid() {
  if (!page) return;
  const grid = qs('[data-sub-grid]', page.el);
  if (grid) renderTo(grid, tierCards());
}

/** Chegando com ?plan=, leva o aluno até o cartão escolhido na landing (uma vez). */
function scrollToHighlight() {
  if (!highlightedSlug || scrolledToHighlight) return;
  const card = qsa('[data-plan-slug]', page.el).find((el) => el.dataset.planSlug === highlightedSlug);
  if (!card) return;
  scrolledToHighlight = true;
  requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
async function startCheckout(planId, paymentMethod, button) {
  setLoading(button, true);
  try {
    const session = await api.post('/api/billing/checkout', {
      plan_id: planId,
      payment_method: paymentMethod || 'credit_card',
    });
    if (session && session.url) {
      window.location.assign(session.url);
      return;
    }
    toast('Não foi possível abrir o checkout. Tente novamente.', { type: 'error' });
  } catch (err) {
    toast(err.message || 'Não foi possível iniciar a assinatura.', { type: 'error' });
  }
  setLoading(button, false);
}

/**
 * Upgrade: confirma o valor cotado e abre a cobrança da diferença no Asaas. O
 * nível só muda quando o pagamento é confirmado (webhook); até lá o aluno
 * continua no plano atual.
 */
async function startUpgrade(planId, button) {
  const plan = plans.find((item) => item.id === planId);
  const quote = quotes.get(planId);
  if (!plan || !quote || quote.error) return;

  const ok = await confirm({
    title: `Fazer upgrade para ${plan.name}`,
    message:
      `Você paga só ${fmtMoney(quote.amount_cents, { currency: plan.currency })} agora` +
      (quote.min_applied ? ' (valor mínimo de cobrança do upgrade).' : `, a diferença proporcional aos ${quote.remaining_days} dias que faltam no seu plano.`) +
      ` O período continua até ${fmtDate(quote.period_end)}, e o nível novo vale assim que o pagamento for confirmado.`,
    confirmText: 'Ir para o pagamento',
    icon: 'arrow-up-right',
  });
  if (!ok || !page) return;

  setLoading(button, true);
  try {
    const result = await api.post('/api/billing/upgrade', { plan_id: planId });
    if (result && result.url) {
      window.location.assign(result.url);
      return;
    }
    toast('Não foi possível abrir o pagamento do upgrade. Tente novamente.', { type: 'error' });
  } catch (err) {
    toast(err.message || 'Não foi possível iniciar o upgrade.', { type: 'error' });
    // A assinatura mudou desde a cotação (renovou, virou outro plano): a
    // cotação antiga não vale mais, então ela é refeita.
    if (err && err.code === 'upgrade_unavailable' && page) {
      quotes = new Map();
      paintGrid();
      loadQuotes(loadToken);
      return;
    }
  }
  setLoading(button, false);
}

async function cancelSubscription(button) {
  const ok = await confirm({
    title: 'Cancelar assinatura',
    message:
      'Seu acesso continua até o fim do período que você já pagou — nada é cobrado depois disso. ' +
      'Para voltar, é só assinar de novo.',
    danger: true,
    confirmText: 'Cancelar assinatura',
    cancelText: 'Manter',
  });
  if (!ok) return;

  setLoading(button, true);
  try {
    const res = await api.post('/api/billing/cancel', {});
    toast(res.message || 'Assinatura cancelada.', { type: 'success' });
    await renderPage(page);
  } catch (err) {
    toast(err.message || 'Não foi possível cancelar. Tente novamente.', { type: 'error' });
  } finally {
    setLoading(button, false);
  }
}

async function openPortal(button) {
  setLoading(button, true);
  try {
    const session = await api.post('/api/billing/portal', {});
    if (session && session.url) {
      window.location.assign(session.url);
      return;
    }
    // Sem fatura em aberto não é erro: o Asaas não tem portal do assinante, e
    // o servidor manda a explicação. Mostrar vermelho aqui assustava o aluno
    // que só queria conferir a cobrança.
    toast(session.message || 'Nenhuma fatura em aberto no momento.', { type: 'info' });
  } catch (err) {
    toast(err.message || 'Não foi possível abrir o portal de assinatura.', { type: 'error' });
  }
  setLoading(button, false);
}

// =====================================================================
// /app/assinatura — planos, checkout e situação do acesso. Também é a
// página para onde o aluno é levado quando o acesso está bloqueado.
// Consome GET /api/billing/plans, /status e POST /checkout, /portal.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, pageHeader, emptyState, errorState, skeleton,
  badge, alertBox, confirm, qs, setLoading, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtMoney, intervalLabel, statusLabel } from '../../core/format.js';

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

let page = null;
let plans = [];
let status = null;
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  ctx.setTitle('Assinatura');
  renderTo(ctx.el, skeleton('page'));

  try {
    [plans, status] = await Promise.all([api.get('/api/billing/plans'), api.get('/api/billing/status')]);
  } catch (err) {
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

  if (ctx.query.checkout === 'cancel') {
    toast('Checkout cancelado. Você pode escolher outro plano quando quiser.', { type: 'info' });
  }

  paint();
}

export function unmount() {
  if (offClick) offClick();
  offClick = null;
  page = null;
  plans = [];
  status = null;
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
    return html`
      <section class="card sub-current mb-6">
        <div class="card-body sub-current-body">
          <span class="icon-box green">${icon('badge-check')}</span>
          <div class="sub-current-main">
            <h2 class="card-title">Assinatura ${subscription.plan_name || ''}</h2>
            <p class="text-2 m-0">
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
  const active = Boolean(status.subscription && status.subscription.is_active);
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
          ? 'Acompanhe sua assinatura ou compare outras opções.'
          : 'Escolha o período e comece sua preparação com direção.'}</p>
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
    const text = String(feature || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (text === 'acesso completo a plataforma') return false;
    if (hasSavings && text.includes('economia')) return false;
    if (accessMonths > 1 && text.startsWith(`${accessMonths} meses de acesso`)) return false;
    return true;
  });
}

function planCard(plan) {
  const features = visiblePlanFeatures(plan);
  const disabled = !status.payments_configured;
  const methods = Array.isArray(status.payment_methods) ? status.payment_methods : ['credit_card'];
  const acceptsCard = methods.includes('credit_card');
  const acceptsPix = methods.includes('pix');
  const hasTrial = Number(plan.trial_days) > 0 && acceptsCard;
  const tag = plan.badge || (plan.highlight ? 'Recomendado' : hasTrial ? 'Teste disponível' : 'Plano flexível');
  return html`
    <article class="card sub-plan ${plan.highlight ? 'sub-plan-highlight' : ''}">
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
        ${hasTrial ? html`
          <div class="sub-trial">
            ${icon('gift')}
            <div><strong>24 horas grátis</strong><span>No cartão. Cobrança após 24h.</span></div>
          </div>` : ''}
        ${features.length
          ? html`
            <div class="sub-plan-includes">Destaques do plano</div>
            <ul class="checklist sub-plan-features">
              ${features.map((feature) => html`<li><span class="sub-feature-check">${icon('check', { size: 14 })}</span><span>${feature}</span></li>`)}
            </ul>`
          : ''}
        <div class="sub-payment-actions">
          ${acceptsCard ? html`
            <button type="button" class="btn btn-primary btn-block sub-plan-cta" data-action="checkout" data-id="${plan.id}" data-method="credit_card" ${disabled ? 'disabled' : ''}>
              ${icon('credit-card')}<span>${hasTrial ? 'Começar 24h grátis' : 'Assinar com cartão'}</span>${icon('arrow-right')}
            </button>
          ` : ''}
          ${acceptsPix ? html`
            <button type="button" class="btn btn-secondary btn-block sub-pix-cta" data-action="checkout" data-id="${plan.id}" data-method="pix" ${disabled ? 'disabled' : ''}>
              ${icon('zap')}<span>Pagar com Pix</span>
            </button>
            <p class="sub-payment-note">
              Pagamento único de todo o período, à vista. Não renova sozinho: quando acabar, é só
              pagar de novo.${hasTrial ? ' O teste de 24h vale só no cartão.' : ''}
            </p>
          ` : ''}
        </div>
        ${disabled ? html`<p class="hint text-center mt-2">Pagamentos indisponíveis no momento.</p>` : ''}
      </div>
    </article>`;
}

function plansBlock() {
  if (!plans.length) {
    return emptyState({
      icon: 'credit-card',
      title: 'Nenhum plano disponível',
      text: 'Os planos ainda não foram publicados. Fale com o suporte para liberar seu acesso.',
    });
  }
  return html`
    <section class="sub-plans-section">
      <div class="sub-section-head">
        <div>
          <span class="sub-section-eyebrow">Planos</span>
          <h2>${status.subscription && status.subscription.is_active ? 'Compare outras opções' : 'Escolha seu período'}</h2>
        </div>
        <p>Compare os planos e escolha o que funciona para sua rotina.</p>
      </div>
      <div class="grid grid-3 sub-plans">${plans.map(planCard)}</div>
      <footer class="sub-checkout-trust">
        <span class="sub-trust-icon">${icon('shield-check')}</span>
        <div>
          <strong>Pagamento processado pelo ${status.payment_provider_label || 'Asaas'}</strong>
          <span>Seu acesso é atualizado após a confirmação.</span>
        </div>
        ${status.support_email ? html`<a href="mailto:${status.support_email}">Precisa de ajuda?</a>` : ''}
      </footer>
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

function paint() {
  renderTo(
    page.el,
    html`
      <div class="sub-page">
        ${heroBlock()}
        ${accessBlock()}
        ${paymentsWarning()}
        ${plansBlock()}
      </div>`
  );

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    if (trigger.dataset.action === 'checkout') startCheckout(trigger.dataset.id, trigger.dataset.method, trigger);
    else if (trigger.dataset.action === 'portal') openPortal(trigger);
    else if (trigger.dataset.action === 'cancel') cancelSubscription(trigger);
  });
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

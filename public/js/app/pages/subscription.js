// =====================================================================
// /app/assinatura — planos, checkout e situação do acesso. Também é a
// página para onde o aluno é levado quando o acesso está bloqueado.
// Consome GET /api/billing/plans, /status e POST /checkout, /portal.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, pageHeader, emptyState, errorState, skeleton,
  badge, alertBox, qs, setLoading, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtMoney, intervalLabel, statusLabel } from '../../core/format.js';

const BLOCK_REASONS = {
  no_subscription: 'Você ainda não tem uma assinatura ativa. Escolha um plano abaixo para liberar as aulas, os simulados e a correção de redação.',
  expired: 'O período da sua assinatura terminou. Renove para voltar de onde parou — seu progresso continua salvo.',
  past_due: 'O último pagamento não foi confirmado. Atualize a forma de pagamento para reativar o acesso.',
  unpaid: 'Há uma cobrança em aberto. Regularize o pagamento para recuperar o acesso.',
  canceled: 'Sua assinatura foi cancelada. Assine novamente para retomar os estudos.',
  incomplete: 'O pagamento não foi concluído. Finalize a assinatura para liberar o acesso.',
  incomplete_expired: 'A tentativa de assinatura expirou. Escolha um plano para tentar de novo.',
  paused: 'Sua assinatura está pausada. Retome pelo portal de assinatura para voltar a estudar.',
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
    return alertBox({
      type: 'warning',
      title: 'Seu acesso está bloqueado',
      text: BLOCK_REASONS[access.reason] || 'Seu acesso está bloqueado. Escolha um plano para liberar a plataforma.',
    });
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
              ? html`<p class="text-2 m-0 mt-2">O cancelamento já está agendado: o acesso continua até o fim do período pago.</p>`
              : ''}
          </div>
          <div class="sub-current-actions">
            <button type="button" class="btn btn-secondary" data-action="portal">${icon('credit-card')}<span>Gerenciar assinatura</span></button>
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

function planCard(plan) {
  const features = Array.isArray(plan.features) ? plan.features : [];
  const disabled = !status.payments_configured;
  const methods = Array.isArray(status.payment_methods) ? status.payment_methods : ['credit_card'];
  const acceptsCard = methods.includes('credit_card');
  const acceptsPix = methods.includes('pix');
  const hasTrial = Number(plan.trial_days) > 0;
  return html`
    <article class="card sub-plan ${plan.highlight ? 'sub-plan-highlight' : ''}">
      ${plan.highlight ? html`<span class="sub-plan-flag">Mais escolhido</span>` : ''}
      <div class="card-body">
        <h3 class="sub-plan-name">${plan.name}</h3>
        ${plan.description ? html`<p class="text-2 sub-plan-desc">${plan.description}</p>` : ''}
        <div class="sub-plan-price">
          <strong>${fmtMoney(plan.price_cents, { currency: plan.currency })}</strong>
          <span class="text-3">/ ${intervalLabel(plan.interval, plan.interval_count)}</span>
        </div>
        ${hasTrial ? html`<div class="mb-3">${badge('24 horas grátis com cartão', 'blue', { icon: 'gift' })}</div>` : ''}
        ${features.length
          ? html`<ul class="checklist sub-plan-features">
              ${features.map((feature) => html`<li>${icon('check', { size: 16 })}<span>${feature}</span></li>`)}
            </ul>`
          : ''}
        <div class="sub-payment-actions">
          ${acceptsCard ? html`
            <button type="button" class="btn ${plan.highlight || hasTrial ? 'btn-primary' : 'btn-secondary'} btn-block" data-action="checkout" data-id="${plan.id}" data-method="credit_card" ${disabled ? 'disabled' : ''}>
              ${icon('credit-card')}<span>${hasTrial ? 'Testar grátis por 24h' : 'Pagar com cartão'}</span>
            </button>
            ${hasTrial ? html`<p class="sub-payment-note">${icon('clock', { size: 14 })}<span>Cadastre o cartão. Cobrança somente após 24h.</span></p>` : ''}` : ''}
          ${acceptsPix ? html`
            <button type="button" class="btn btn-secondary btn-block" data-action="checkout" data-id="${plan.id}" data-method="pix" ${disabled ? 'disabled' : ''}>
              ${icon('zap')}<span>Pagar com Pix</span>
            </button>
            ${hasTrial ? html`<p class="sub-payment-note sub-payment-note-muted">No Pix, o pagamento é imediato e não inclui teste grátis.</p>` : ''}` : ''}
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
    <section>
      <h2 class="section-title">${status.subscription && status.subscription.is_active ? 'Outros planos' : 'Escolha seu plano'}</h2>
      <div class="grid grid-3 sub-plans">${plans.map(planCard)}</div>
      <p class="text-3 text-sm mt-4">
        Pagamento seguro processado pelo ${status.payment_provider_label || 'Asaas'}.
      </p>
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
      ${pageHeader({
        title: 'Assinatura',
        subtitle: 'Acesso completo às aulas, questões, simulados, redação e tutor com IA.',
      })}
      ${accessBlock()}
      ${paymentsWarning()}
      ${plansBlock()}`
  );

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    if (trigger.dataset.action === 'checkout') startCheckout(trigger.dataset.id, trigger.dataset.method, trigger);
    else if (trigger.dataset.action === 'portal') openPortal(trigger);
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

async function openPortal(button) {
  setLoading(button, true);
  try {
    const session = await api.post('/api/billing/portal', {});
    if (session && session.url) {
      window.location.assign(session.url);
      return;
    }
    toast('Não foi possível abrir o portal de assinatura.', { type: 'error' });
  } catch (err) {
    toast(err.message || 'Não foi possível abrir o portal de assinatura.', { type: 'error' });
  }
  setLoading(button, false);
}

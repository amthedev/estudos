// =====================================================================
// Foco Elite — Painel administrativo: planos e assinaturas (/admin/planos)
//
// Planos: GET/POST/PUT/DELETE /api/admin/plans e POST /plans/:id/sync-provider.
// Assinaturas: GET /api/admin/subscriptions (paginado) e /subscriptions/summary.
// O status do provedor vem de GET /api/admin/plans/provider-status.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, modal, confirm, qs, on,
  pageHeader, errorState, skeleton, statCard, badge, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMoney, fmtNumber, fmtDate, fmtDateTime, fmtRelative, intervalLabel } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

let state = null;

const SUBSCRIPTION_STATUS = {
  trialing: { label: 'Em teste', tone: 'blue' },
  active: { label: 'Ativa', tone: 'green' },
  past_due: { label: 'Em atraso', tone: 'orange' },
  canceled: { label: 'Cancelada', tone: 'gray' },
  incomplete: { label: 'Incompleta', tone: 'orange' },
  incomplete_expired: { label: 'Expirada', tone: 'gray' },
  unpaid: { label: 'Não paga', tone: 'red' },
  paused: { label: 'Pausada', tone: 'gray' },
};

const num = (value) => fmtNumber(value ?? 0, { digits: 0 });
const providerReady = () => Boolean(state.providerStatus && state.providerStatus.configured);

// ---------------------------------------------------------------------
// Formulário de plano
// ---------------------------------------------------------------------
function planFields() {
  return [
    { type: 'section', label: 'Identificação' },
    { key: 'name', label: 'Nome do plano', type: 'text', required: true, maxLength: 80, placeholder: 'Mensal' },
    { key: 'slug', label: 'Identificador (slug)', type: 'text', maxLength: 80, placeholder: 'mensal', hint: 'Opcional: gerado a partir do nome. Use letras minúsculas, números e hífens.' },
    { key: 'description', label: 'Descrição', type: 'textarea', rows: 3, maxLength: 500, placeholder: 'O que está incluído neste plano.' },
    { type: 'section', label: 'Cobrança' },
    { key: 'price', label: 'Preço (R$)', type: 'number', required: true, min: 0, step: '0.01', placeholder: '49,90' },
    { key: 'interval', label: 'Cobrança', type: 'select', required: true, options: [{ value: 'month', label: 'Mensal' }, { value: 'year', label: 'Anual' }] },
    { key: 'interval_count', label: 'A cada', type: 'number', min: 1, max: 12, integer: true, hint: 'Quantos meses (ou anos) entre as cobranças.' },
    { key: 'trial_days', label: 'Teste grátis no cartão', type: 'number', min: 0, max: 1, integer: true, hint: 'Use 1 nos planos de 6 ou 12 meses. Pix sempre cobra na hora.' },
    { type: 'section', label: 'Acesso vendido' },
    { key: 'duration_months', label: 'Meses pagos', type: 'number', min: 1, max: 60, integer: true, hint: 'Quantos meses o aluno está pagando neste plano.' },
    { key: 'bonus_months', label: 'Meses de bônus', type: 'number', min: 0, max: 36, integer: true, hint: 'Meses extras de acesso, sem cobrança. Ex.: 3 no plano "pague 12, receba 15".' },
    { type: 'section', label: 'Exibição' },
    { key: 'compare_price', label: 'Preço de comparação (R$)', type: 'number', min: 0, step: '0.01', placeholder: '538,80', hint: 'Quanto custaria no mensal pelo mesmo período. Deixe vazio para não mostrar economia.' },
    { key: 'badge', label: 'Selo do card', type: 'text', maxLength: 40, placeholder: 'MELHOR OFERTA', hint: 'Texto curto exibido sobre o card na página inicial.' },
    { key: 'features', label: 'Recursos', type: 'tags', placeholder: 'Digite um recurso e pressione Enter' },
    { key: 'sort_order', label: 'Ordem', type: 'number', min: 0, integer: true },
    { key: 'highlight', label: 'Destacar como recomendado', type: 'switch' },
    { key: 'active', label: 'Plano ativo (visível para os alunos)', type: 'switch' },
  ];
}

function planValues(plan) {
  if (!plan) {
    return {
      name: '', slug: '', description: '', price: null, interval: 'month', interval_count: 1, trial_days: 0,
      duration_months: 1, bonus_months: 0, compare_price: null, badge: '',
      features: [], sort_order: 0, highlight: false, active: true,
    };
  }
  return {
    name: plan.name || '',
    slug: plan.slug || '',
    description: plan.description || '',
    price: (Number(plan.price_cents) || 0) / 100,
    interval: plan.interval || 'month',
    interval_count: Number(plan.interval_count) || 1,
    trial_days: Number(plan.trial_days) || 0,
    duration_months: Number(plan.duration_months) || 1,
    bonus_months: Number(plan.bonus_months) || 0,
    compare_price: plan.compare_price_cents === null || plan.compare_price_cents === undefined
      ? null
      : Number(plan.compare_price_cents) / 100,
    badge: plan.badge || '',
    features: Array.isArray(plan.features) ? plan.features : [],
    sort_order: Number(plan.sort_order) || 0,
    highlight: Boolean(plan.highlight),
    active: plan.active !== false,
  };
}

function planPayload(values) {
  const payload = {
    name: values.name,
    description: values.description ? String(values.description).trim() : null,
    price_cents: Math.round((Number(values.price) || 0) * 100),
    currency: 'brl',
    interval: values.interval || 'month',
    interval_count: Number(values.interval_count) || 1,
    trial_days: Number(values.trial_days) || 0,
    duration_months: Math.max(1, Number(values.duration_months) || 1),
    bonus_months: Math.max(0, Number(values.bonus_months) || 0),
    compare_price_cents: values.compare_price === null || values.compare_price === undefined || values.compare_price === ''
      ? null
      : Math.round(Number(values.compare_price) * 100),
    badge: String(values.badge || '').trim() || null,
    features: Array.isArray(values.features) ? values.features : [],
    highlight: Boolean(values.highlight),
    active: Boolean(values.active),
    sort_order: Number(values.sort_order) || 0,
  };
  const slug = String(values.slug || '').trim();
  if (slug) payload.slug = slug;
  return payload;
}

function openPlanForm(plan) {
  const dialog = modal({
    title: plan ? 'Editar plano' : 'Novo plano',
    subtitle: plan ? plan.name : 'Os planos aparecem na tela de assinatura do aluno.',
    size: 'lg',
    actions: [],
  });
  buildForm(dialog.body, planFields(), {
    values: planValues(plan),
    submitLabel: plan ? 'Salvar plano' : 'Criar plano',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    onSubmit: async (values) => {
      const payload = planPayload(values);
      if (plan) await api.put(`/api/admin/plans/${plan.id}`, payload);
      else await api.post('/api/admin/plans', payload);
      toast(plan ? 'Plano atualizado.' : 'Plano criado.', { type: 'success' });
      dialog.close();
      if (state.plansTable) state.plansTable.reload();
    },
  });
}

// ---------------------------------------------------------------------
// Ações de plano
// ---------------------------------------------------------------------
async function syncProvider(plan) {
  if (!providerReady()) {
    toast('Configure o Asaas no servidor para sincronizar planos.', { type: 'warning' });
    return;
  }
  try {
    const result = await api.post(`/api/admin/plans/${plan.id}/sync-provider`, {});
    toast((result && result.message) || 'Plano sincronizado com o Asaas.', { type: 'success' });
    if (state.plansTable) state.plansTable.reload();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível sincronizar com o Asaas.', { type: 'error' });
  }
}

async function togglePlan(plan) {
  const payload = { ...planPayload(planValues(plan)), active: !plan.active };
  try {
    await api.put(`/api/admin/plans/${plan.id}`, payload);
    toast(plan.active ? 'Plano desativado.' : 'Plano ativado.', { type: 'success' });
    if (state.plansTable) state.plansTable.reload();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível atualizar o plano.', { type: 'error' });
  }
}

async function removePlan(plan) {
  const ok = await confirm({
    title: 'Excluir plano',
    message: `O plano "${plan.name}" será removido. Planos com assinaturas vinculadas não podem ser excluídos — nesse caso, desative-o.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/plans/${plan.id}`);
    toast('Plano excluído.', { type: 'success' });
    if (state.plansTable) state.plansTable.reload();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível excluir o plano.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Tabelas
// ---------------------------------------------------------------------
function mountPlansTable() {
  const el = qs('#aplan-table', state.el);
  if (!el) return;
  state.plansTable = mountTable(el, {
    pageSize: 50,
    emptyText: 'Nenhum plano cadastrado',
    columns: [
      {
        key: 'name',
        label: 'Plano',
        render: (plan) => html`
          <span class="aplan-name">
            <strong>${plan.name}</strong>
            ${plan.highlight ? badge('Recomendado', 'blue', { icon: 'star' }) : ''}
            ${plan.description ? html`<span class="aplan-desc">${plan.description}</span>` : ''}
          </span>`,
      },
      {
        key: 'price_cents',
        label: 'Preço',
        nowrap: true,
        render: (plan) => html`
          <span class="aplan-price">
            <strong>${fmtMoney(plan.price_cents, { currency: plan.currency })}</strong>
            <span class="text-xs text-3">${intervalLabel(plan.interval, plan.interval_count)}</span>
          </span>`,
      },
      {
        key: 'trial_days',
        label: 'Teste',
        align: 'center',
        render: (plan) => (Number(plan.trial_days) === 1
          ? '24h no cartão'
          : html`<span class="text-3">—</span>`),
      },
      {
        key: 'active_subscriptions',
        label: 'Assinantes',
        align: 'center',
        render: (plan) => html`<span title="${num(plan.subscriptions_total)} no total">${num(plan.active_subscriptions)}</span>`,
      },
      {
        key: 'active',
        label: 'Situação',
        render: (plan) => (plan.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')),
      },
    ],
    rowActions: [
      { label: 'Editar', icon: 'square-pen', onClick: (plan) => openPlanForm(plan) },
      { label: 'Sincronizar com o Asaas', icon: 'refresh-cw', onClick: (plan) => syncProvider(plan), disabled: () => !providerReady() },
      { label: 'Ativar ou desativar', icon: 'toggle-left', onClick: (plan) => togglePlan(plan) },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: (plan) => removePlan(plan) },
    ],
    fetch: async () => {
      const plans = await api.get('/api/admin/plans');
      const items = Array.isArray(plans) ? plans : (plans.items || []);
      state.plans = items;
      return { items, total: items.length };
    },
  });
}

function mountSubscriptionsTable() {
  const el = qs('#aplan-subs', state.el);
  if (!el) return;
  state.subsTable = mountTable(el, {
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar por aluno, e-mail ou id da assinatura',
    emptyText: 'Nenhuma assinatura encontrada',
    sort: { key: 'created_at', dir: 'desc' },
    filters: [
      {
        key: 'status',
        label: 'Situação',
        options: Object.entries(SUBSCRIPTION_STATUS).map(([value, info]) => ({ value, label: info.label })),
      },
      { key: 'plan_id', label: 'Plano', options: (state.plans || []).map((plan) => ({ value: plan.id, label: plan.name })) },
    ],
    columns: [
      {
        key: 'user_name',
        label: 'Aluno',
        sortable: true,
        render: (row) => html`
          <a class="aplan-user" href="/admin/alunos/${row.user_id}">
            <strong>${row.user_name}</strong>
            <span class="text-xs text-3">${row.user_email}</span>
          </a>`,
      },
      {
        key: 'plan_name',
        label: 'Plano',
        sortable: true,
        render: (row) => (row.plan_name
          ? html`<span>${row.plan_name}<br><span class="text-xs text-3">${fmtMoney(row.plan_price_cents, { currency: row.plan_currency })} · ${intervalLabel(row.plan_interval, row.plan_interval_count)}</span></span>`
          : html`<span class="text-3">Plano removido</span>`),
      },
      {
        key: 'status',
        label: 'Situação',
        sortable: true,
        render: (row) => {
          const info = SUBSCRIPTION_STATUS[row.status] || { label: row.status, tone: 'gray' };
          return html`
            <span class="aplan-status">
              ${badge(info.label, info.tone)}
              ${row.cancel_at_period_end ? badge('Cancela no fim do período', 'orange') : ''}
            </span>`;
        },
      },
      {
        key: 'current_period_end',
        label: 'Vigência',
        sortable: true,
        nowrap: true,
        render: (row) => (row.current_period_end
          ? html`<span title="${fmtDateTime(row.current_period_end)}">até ${fmtDate(row.current_period_end)}</span>`
          : html`<span class="text-3">—</span>`),
      },
      {
        key: 'created_at',
        label: 'Início',
        sortable: true,
        nowrap: true,
        render: (row) => html`<span title="${fmtDateTime(row.created_at)}">${fmtRelative(row.created_at)}</span>`,
      },
    ],
    rowActions: [
      { label: 'Ver aluno', icon: 'eye', onClick: (row) => state.navigate(`/admin/alunos/${row.user_id}`) },
    ],
    fetch: (page, query) => api.get('/api/admin/subscriptions', { query }),
  });
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Planos e assinaturas',
    subtitle: 'Preços, período de teste e acompanhamento das assinaturas dos alunos.',
    actions: html`
      <button type="button" class="btn btn-secondary" data-action="reload">${icon('refresh-cw')}<span>Atualizar</span></button>
      <button type="button" class="btn btn-primary" data-action="new-plan">${icon('plus')}<span>Novo plano</span></button>`,
  });
}

function providerNotice() {
  const provider = state.providerStatus || {};
  if (provider.configured) {
    const mode = provider.environment === 'production' ? 'produção' : provider.environment === 'sandbox' ? 'teste' : 'indefinido';
    return html`
      <div class="aplan-provider-ok">
        ${badge(`${provider.label || 'Asaas'} em ${mode}`, provider.environment === 'production' ? 'green' : 'blue', { icon: 'credit-card' })}
        ${provider.webhook_configured ? badge('Webhook configurado', 'green') : badge('Webhook não configurado', 'orange')}
        <span class="text-xs text-3">Chave •••• ${provider.key_last4 || '----'}</span>
      </div>`;
  }
  return alertBox({
    type: 'warning',
    title: 'Asaas não configurado',
    text: 'Defina ASAAS_API_KEY no servidor para liberar checkout com cartão e Pix. Os planos podem ser cadastrados normalmente.',
    actions: html`<a class="btn btn-secondary btn-sm" href="/admin/configuracoes">${icon('settings')}<span>Ver configurações</span></a>`,
  });
}

function summaryRow() {
  const s = state.summary || {};
  return html`
    <section class="grid grid-4 aplan-summary">
      ${statCard({ label: 'Assinaturas ativas', value: num(s.active), icon: 'credit-card', tone: 'green' })}
      ${statCard({ label: 'Em teste', value: num(s.trialing), icon: 'hourglass' })}
      ${statCard({ label: 'Em atraso', value: num(s.past_due), icon: 'triangle-alert', tone: 'orange' })}
      ${statCard({ label: 'Receita mensal recorrente', value: fmtMoney(s.mrr_cents), icon: 'banknote', hint: `${num(s.total)} assinaturas registradas` })}
    </section>`;
}

function paint() {
  render(state.el, html`
    <div class="aplan-page">
      ${header()}
      ${providerNotice()}
    ${summaryRow()}
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('layers')}<span>Planos</span></h2>
        <span class="card-subtitle">Os planos ativos aparecem na tela de assinatura do aluno.</span>
      </div>
      <div class="card-body" id="aplan-table"></div>
    </section>
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('users')}<span>Assinaturas</span></h2>
        <span class="card-subtitle">Atualizadas automaticamente pelos webhooks do Asaas.</span>
      </div>
      <div class="card-body" id="aplan-subs"></div>
    </section>
    </div>`);
  mountPlansTable();
  mountSubscriptionsTable();
}

async function load() {
  render(state.el, html`${header()}${skeleton('stats', 4)}<div class="mt-6">${skeleton('table')}</div>`);
  try {
    const [summary, providerStatus, plans] = await Promise.all([
      api.get('/api/admin/subscriptions/summary').catch(() => ({})),
      api.get('/api/admin/plans/provider-status').catch(() => null),
      api.get('/api/admin/plans').catch(() => []),
    ]);
    state.summary = summary;
    state.providerStatus = providerStatus;
    state.plans = Array.isArray(plans) ? plans : (plans.items || []);
  } catch (err) {
    render(state.el, html`${header()}${errorState({ title: 'Não foi possível carregar os planos', message: err && err.message })}`);
    return;
  }
  paint();
}

export default async function renderPlans(ctx) {
  state = { el: ctx.el, navigate: ctx.navigate, plans: [], summary: null, providerStatus: null, plansTable: null, subsTable: null };
  ctx.setTitle('Planos e assinaturas');
  on(ctx.el, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    if (action === 'new-plan') openPlanForm(null);
    else if (action === 'reload' || action === 'retry') load();
  });
  await load();
}

export function unmount() {
  if (state) {
    if (state.plansTable) state.plansTable.destroy();
    if (state.subsTable) state.subsTable.destroy();
  }
  state = null;
}

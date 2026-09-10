// =====================================================================
// Foco Elite — Painel administrativo: alunos (/admin/alunos)
//
// Tabela (components/data-table.js) sobre GET /api/admin/students com busca
// por nome ou e-mail e filtros de situação, prova, onboarding e assinatura.
// Ações por linha: abrir o perfil, bloquear/desbloquear e liberar o acesso
// manualmente até uma data (POST students/:id/block|unblock|grant-access).
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, modal, confirm, qs, on,
  pageHeader, errorState, skeleton, badge, progressBar, statCard,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtRelative, fmtDate, fmtDateTime, initials, toISODate, addDays } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';

let state = null;

const SUBSCRIPTION_FILTER = [
  { value: 'active', label: 'Assinatura ativa' },
  { value: 'inactive', label: 'Assinatura vencida' },
  { value: 'none', label: 'Sem assinatura' },
  { value: 'override', label: 'Acesso liberado à mão' },
];

/** Rótulo da assinatura mostrado na tabela. */
function subscriptionCell(row) {
  if (row.subscription_active) {
    const until = row.subscription_period_end ? ` até ${fmtDate(row.subscription_period_end)}` : '';
    return html`
      <span class="astu-sub">
        ${badge(row.plan_name || 'Ativa', 'green')}
        ${until ? html`<span class="text-xs text-3">Renova${until}</span>` : ''}
      </span>`;
  }
  if (row.access_override_active) {
    return html`
      <span class="astu-sub">
        ${badge('Liberado', 'blue', { icon: 'unlock' })}
        <span class="text-xs text-3">Até ${fmtDate(row.access_override_until)}</span>
      </span>`;
  }
  if (row.subscription_status) {
    return html`
      <span class="astu-sub">
        ${badge('Vencida', 'orange')}
        <span class="text-xs text-3">${row.plan_name || row.subscription_status}</span>
      </span>`;
  }
  return badge('Sem assinatura', 'gray');
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
async function toggleBlock(row, table) {
  const blocked = row.status === 'blocked';
  const ok = await confirm({
    title: blocked ? 'Desbloquear aluno' : 'Bloquear aluno',
    message: blocked
      ? `${row.name} volta a acessar a plataforma normalmente.`
      : `${row.name} perde o acesso imediatamente e as sessões abertas são encerradas.`,
    danger: !blocked,
    confirmText: blocked ? 'Desbloquear' : 'Bloquear',
    icon: blocked ? 'unlock' : 'ban',
  });
  if (!ok) return;
  try {
    const result = await api.post(`/api/admin/students/${row.id}/${blocked ? 'unblock' : 'block'}`);
    toast(result && result.message ? result.message : 'Situação atualizada.', { type: 'success' });
    table.reload();
    loadSummary();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível atualizar a situação.', { type: 'error' });
  }
}

function grantAccess(row, table) {
  const suggested = toISODate(addDays(new Date(), 30));
  const minDate = toISODate(addDays(new Date(), 1));
  const current = row.access_override_active && row.access_override_until
    ? String(row.access_override_until).slice(0, 10)
    : suggested;
  const dialog = modal({
    title: 'Liberar acesso',
    subtitle: row.name,
    size: 'sm',
    body: html`
      <p class="text-2 mb-4">
        A liberação manual dá acesso completo mesmo sem assinatura ativa. Escolha até quando ela vale.
      </p>
      <div class="field">
        <label class="label" for="astu-grant-until">Liberar até</label>
        <input class="input" type="date" id="astu-grant-until" value="${current}" min="${minDate}">
        <p class="hint">O acesso volta a depender da assinatura no dia seguinte.</p>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      row.access_override_active
        ? {
          label: 'Remover liberação',
          variant: 'secondary',
          onClick: async () => {
            await api.post(`/api/admin/students/${row.id}/grant-access`, { until: null });
            toast('Liberação manual removida.', { type: 'success' });
            table.reload();
            loadSummary();
          },
        }
        : null,
      {
        label: 'Liberar acesso',
        variant: 'primary',
        icon: 'unlock',
        onClick: async () => {
          const input = qs('#astu-grant-until', dialog.body);
          const until = input ? input.value : '';
          if (!until) {
            toast('Escolha a data limite.', { type: 'warning' });
            return false;
          }
          await api.post(`/api/admin/students/${row.id}/grant-access`, { until });
          toast(`Acesso liberado até ${fmtDate(until)}.`, { type: 'success' });
          table.reload();
          loadSummary();
          return true;
        },
      },
    ].filter(Boolean),
  });
}

// ---------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------
function columns() {
  return [
    {
      key: 'name',
      label: 'Aluno',
      sortable: true,
      render: (row) => html`
        <a class="astu-user" href="/admin/alunos/${row.id}">
          <span class="avatar avatar-sm" aria-hidden="true">${initials(row.name)}</span>
          <span class="astu-user-main">
            <span class="astu-user-name">${row.name}</span>
            <span class="astu-user-mail">${row.email}</span>
          </span>
        </a>`,
    },
    {
      key: 'exam_short_name',
      label: 'Prova',
      render: (row) => (row.exam_short_name
        ? html`<span title="${row.exam_name || row.exam_short_name}">${row.exam_short_name}</span>`
        : html`<span class="text-3">Não escolhida</span>`),
    },
    {
      key: 'progress_pct',
      label: 'Progresso',
      sortable: true,
      width: 150,
      render: (row) => html`
        <span class="astu-progress">
          ${progressBar(Number(row.progress_pct) || 0, { size: 'sm' })}
          <span class="text-xs text-3">${fmtNumber(row.lessons_done ?? 0, { digits: 0 })} de ${fmtNumber(row.lessons_total ?? 0, { digits: 0 })} aulas</span>
        </span>`,
    },
    {
      key: 'last_seen_at',
      label: 'Último acesso',
      sortable: true,
      nowrap: true,
      render: (row) => (row.last_seen_at
        ? html`<span title="${fmtDateTime(row.last_seen_at)}">${fmtRelative(row.last_seen_at)}</span>`
        : html`<span class="text-3">Nunca entrou</span>`),
    },
    {
      key: 'status',
      label: 'Situação',
      sortable: true,
      render: (row) => {
        if (row.status === 'blocked') return badge('Bloqueado', 'red', { icon: 'ban' });
        if (!row.onboarding_completed) return badge('Onboarding pendente', 'orange');
        return badge('Ativo', 'green');
      },
    },
    { key: 'subscription_status', label: 'Assinatura', render: subscriptionCell },
  ];
}

function mount(exams) {
  const el = qs('#astu-table', state.el);
  if (!el) return;
  state.table = mountTable(el, {
    columns: columns(),
    search: true,
    searchPlaceholder: 'Buscar por nome ou e-mail',
    pageSize: 20,
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhum aluno encontrado',
    rowKey: 'id',
    filters: [
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativos' }, { value: 'blocked', label: 'Bloqueados' }] },
      { key: 'exam_id', label: 'Prova', options: exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      { key: 'onboarding', label: 'Onboarding', options: [{ value: 'true', label: 'Onboarding concluído' }, { value: 'false', label: 'Onboarding pendente' }] },
      { key: 'subscription', label: 'Assinatura', options: SUBSCRIPTION_FILTER },
    ],
    fetch: (page, query) => api.get('/api/admin/students', { query }),
    onRowClick: (row) => state.navigate(`/admin/alunos/${row.id}`),
    rowActions: [
      { label: 'Ver perfil', icon: 'eye', onClick: (row) => state.navigate(`/admin/alunos/${row.id}`) },
      { label: 'Liberar acesso', icon: 'unlock', onClick: (row, table) => grantAccess(row, table) },
      {
        label: 'Bloquear ou desbloquear',
        icon: 'ban',
        danger: true,
        onClick: (row, table) => toggleBlock(row, table),
      },
    ],
  });
}

// ---------------------------------------------------------------------
// Resumo (cartões do topo)
// ---------------------------------------------------------------------
async function loadSummary() {
  const el = state && qs('#astu-summary', state.el);
  if (!el) return;
  try {
    const data = await api.get('/api/admin/dashboard');
    render(el, html`
      ${statCard({ label: 'Alunos cadastrados', value: fmtNumber(data.students_total ?? 0, { digits: 0 }), icon: 'users' })}
      ${statCard({ label: 'Ativos em 7 dias', value: fmtNumber(data.students_active_7d ?? 0, { digits: 0 }), icon: 'activity', tone: 'green' })}
      ${statCard({ label: 'Novos no mês', value: fmtNumber(data.students_new_30d ?? 0, { digits: 0 }), icon: 'user-plus' })}
      ${statCard({ label: 'Assinaturas ativas', value: fmtNumber(data.subscriptions_active ?? 0, { digits: 0 }), icon: 'credit-card', tone: 'green', href: '/admin/planos' })}`);
  } catch {
    render(el, raw(''));
  }
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Alunos',
    subtitle: 'Acompanhe, libere e bloqueie o acesso de quem estuda na plataforma.',
    actions: html`<a class="btn btn-secondary" href="/admin/planos">${icon('credit-card')}<span>Planos e assinaturas</span></a>`,
  });
}

async function load() {
  render(state.el, html`${header()}${skeleton('table')}`);
  let exams = [];
  try {
    const response = await api.get('/api/admin/exams', { query: { status: 'active' } });
    exams = Array.isArray(response) ? response : (response.items || []);
  } catch (err) {
    // sem a lista de provas a tabela continua funcionando, apenas sem esse filtro
    console.warn('[admin/alunos] não foi possível carregar as provas', err);
  }
  render(state.el, html`
    <div class="astu-page">
      ${header()}
      <section class="grid grid-4 astu-summary" id="astu-summary">${skeleton('stats', 4)}</section>
      <section class="card astu-card"><div class="card-body" id="astu-table"></div></section>
    </div>`);
  mount(exams);
  loadSummary();
}

export default async function renderStudents(ctx) {
  state = { el: ctx.el, navigate: ctx.navigate, table: null };
  ctx.setTitle('Alunos');
  on(ctx.el, 'click', '[data-action="retry"]', () => load());
  try {
    await load();
  } catch (err) {
    render(ctx.el, html`${header()}${errorState({ title: 'Não foi possível carregar os alunos', message: err && err.message })}`);
  }
}

export function unmount() {
  if (state && state.table) state.table.destroy();
  state = null;
}

// =====================================================================
// Foco Elite — Painel administrativo: plataforma (/admin/plataforma)
//
// Saúde do servidor (GET /api/admin/platform/health), consumo de IA
// (GET /api/admin/ai/usage), últimos erros (GET /api/admin/platform/errors)
// e registro de auditoria (GET /api/admin/platform/audit). Somente leitura.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, modal, qs, on,
  pageHeader, emptyState, errorState, skeleton, statCard, badge, progressBar,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtDateShort, fmtDateTime, fmtRelative, fmtMinutes, fmtCompact } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { barChart, destroyChart, palette } from '../../core/charts.js';

let state = null;

const AI_FEATURES = {
  tutor: 'Tutor IA',
  essay: 'Correção de redação',
  essay_theme: 'Geração de temas',
  other: 'Outros',
};

const ERROR_PAGE_SIZE = 10;
const num = (value) => fmtNumber(value ?? 0, { digits: 0 });

/** Tempo no ar em formato legível a partir dos segundos devolvidos pela API. */
function uptimeLabel(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const rest = total % 86400;
  if (days > 0) return `${days} ${days === 1 ? 'dia' : 'dias'} e ${fmtMinutes(Math.round(rest / 60))}`;
  if (total < 60) return `${total} s`;
  return fmtMinutes(Math.round(total / 60));
}

// ---------------------------------------------------------------------
// Saúde
// ---------------------------------------------------------------------
function healthSection() {
  const health = state.health;
  if (!health) {
    return html`<div class="alert alert-danger" role="alert">${icon('circle-alert')}<div class="alert-body">Não foi possível ler a saúde da plataforma.</div></div>`;
  }
  const db = health.db || {};
  const memory = health.memory_mb || {};
  const counts = health.counts || {};
  return html`
    <section class="grid grid-4 aplat-health">
      ${statCard({
        label: 'Tempo no ar',
        value: uptimeLabel(health.uptime),
        hint: health.env ? `Ambiente: ${health.env}` : '',
        icon: 'activity',
        tone: health.ok ? 'green' : 'red',
      })}
      ${statCard({ label: 'Versão da aplicação', value: health.app_version || '—', hint: `Node ${health.node_version || '—'}`, icon: 'package' })}
      ${statCard({
        label: 'Banco de dados',
        value: db.size_pretty || '—',
        hint: db.ok ? `Resposta em ${num(db.latency_ms)} ms${db.server_version ? ` · ${db.server_version}` : ''}` : 'Indisponível',
        icon: 'database',
        tone: db.ok ? 'green' : 'red',
      })}
      ${statCard({
        label: 'Memória em uso',
        value: `${fmtNumber(memory.rss ?? 0, { digits: 1 })} MB`,
        hint: `Heap ${fmtNumber(memory.heap_used ?? 0, { digits: 1 })} de ${fmtNumber(memory.heap_total ?? 0, { digits: 1 })} MB`,
        icon: 'cpu',
      })}
    </section>
    <section class="card aplat-counts">
      <div class="card-header">
        <h2 class="card-title">${icon('database')}<span>Registros no banco</span></h2>
        <span class="card-subtitle">${health.platform || ''}</span>
      </div>
      <div class="card-body">
        <dl class="kv aplat-kv">
          <dt>Alunos</dt><dd>${num(counts.students)} (${num(counts.students_active)} ativos)</dd>
          <dt>Aulas</dt><dd>${num(counts.lessons)}</dd>
          <dt>Questões</dt><dd>${num(counts.questions)}</dd>
          <dt>Simulados</dt><dd>${num(counts.simulados)} modelos · ${num(counts.simulado_attempts)} tentativas</dd>
          <dt>Redações</dt><dd>${num(counts.essays)}</dd>
          <dt>Provas anteriores</dt><dd>${num(counts.past_exams)}</dd>
          <dt>Professores</dt><dd>${num(counts.teachers)} · ${num(counts.bookings_active)} aulas agendadas</dd>
          <dt>Assinaturas ativas</dt><dd>${num(counts.subscriptions_active)}</dd>
          <dt>Últimas 24 horas</dt><dd>${num(counts.errors_24h)} erros · ${num(counts.audit_24h)} ações administrativas</dd>
        </dl>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Consumo de IA
// ---------------------------------------------------------------------
function aiSection() {
  const usage = state.usage;
  if (!usage) {
    return html`
      <section class="card">
        <div class="card-header"><h2 class="card-title">${icon('bot')}<span>Consumo de IA</span></h2></div>
        <div class="card-body">${emptyState({ icon: 'bot', title: 'Sem dados de uso', text: 'As chamadas de IA ainda não foram registradas.', size: 'sm' })}</div>
      </section>`;
  }
  const totals = usage.totals || {};
  const limit = Number(usage.limit) || 0;
  const monthTokens = Number(usage.month_tokens) || 0;
  const pct = limit > 0 ? Math.min(100, Math.round((monthTokens / limit) * 100)) : 0;
  const features = usage.by_feature || [];
  const users = usage.top_users || [];
  return html`
    <section class="grid grid-4 aplat-ai-stats">
      ${statCard({ label: 'Tokens em 30 dias', value: fmtCompact(totals.tokens), hint: `${num(totals.requests)} chamadas`, icon: 'sparkles' })}
      ${statCard({ label: 'Tokens no mês', value: fmtCompact(monthTokens), hint: limit > 0 ? `de ${fmtCompact(limit)} permitidos` : 'sem limite definido', icon: 'gauge', tone: usage.limit_reached ? 'red' : 'blue' })}
      ${statCard({ label: 'Erros de IA', value: num(totals.errors), icon: 'triangle-alert', tone: Number(totals.errors) ? 'orange' : 'gray' })}
      ${statCard({ label: 'Latência média', value: `${num(totals.avg_latency_ms)} ms`, icon: 'timer' })}
    </section>
    ${limit > 0 ? html`<div class="card aplat-limit"><div class="card-body">${progressBar(pct, { color: pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : '', label: 'Uso do limite mensal de tokens' })}</div></div>` : ''}
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('chart-column')}<span>Consumo de IA por dia</span></h2>
        <span class="card-subtitle">Últimos ${num(usage.days)} dias</span>
      </div>
      <div class="card-body">
        <div class="aplat-chart"><canvas id="aplat-ai" role="img" aria-label="Tokens consumidos por dia"></canvas></div>
      </div>
    </section>
    <div class="grid grid-2 aplat-ai-tables">
      <article class="card">
        <div class="card-header"><h2 class="card-title">${icon('layers')}<span>Por funcionalidade</span></h2></div>
        <div class="card-body">
          ${features.length
            ? html`
              <div class="table-wrap">
                <table class="table table-sm">
                  <thead><tr><th scope="col">Funcionalidade</th><th scope="col" class="num">Chamadas</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Erros</th></tr></thead>
                  <tbody>${features.map((row) => html`
                    <tr>
                      <td>${AI_FEATURES[row.feature] || row.feature}</td>
                      <td class="num">${num(row.requests)}</td>
                      <td class="num">${num(row.tokens)}</td>
                      <td class="num">${Number(row.errors) ? html`<span class="text-danger">${num(row.errors)}</span>` : num(0)}</td>
                    </tr>`)}
                  </tbody>
                </table>
              </div>`
            : emptyState({ icon: 'layers', title: 'Nenhuma chamada no período', size: 'sm' })}
        </div>
      </article>
      <article class="card">
        <div class="card-header"><h2 class="card-title">${icon('users')}<span>Alunos que mais usam</span></h2></div>
        <div class="card-body">
          ${users.length
            ? html`
              <div class="table-wrap">
                <table class="table table-sm">
                  <thead><tr><th scope="col">Aluno</th><th scope="col" class="num">Chamadas</th><th scope="col" class="num">Tokens</th></tr></thead>
                  <tbody>${users.map((row) => html`
                    <tr>
                      <td><a href="/admin/alunos/${row.user_id}">${row.name}</a><br><span class="text-xs text-3">${row.email}</span></td>
                      <td class="num">${num(row.requests)}</td>
                      <td class="num">${num(row.tokens)}</td>
                    </tr>`)}
                  </tbody>
                </table>
              </div>`
            : emptyState({ icon: 'users', title: 'Nenhum aluno usou a IA no período', size: 'sm' })}
        </div>
      </article>
    </div>`;
}

function drawAiChart() {
  const usage = state.usage;
  const canvas = qs('#aplat-ai', state.el);
  if (!usage || !canvas) return;
  const days = usage.by_day || [];
  barChart(canvas, {
    labels: days.map((row) => fmtDateShort(row.date)),
    datasets: [{ label: 'Tokens', data: days.map((row) => Number(row.tokens) || 0), backgroundColor: palette.primary2, borderRadius: 4 }],
    options: { scales: { y: { ticks: { precision: 0 } } } },
  });
}

// ---------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------
function errorItem(row) {
  return html`
    <details class="aplat-error">
      <summary>
        <span class="aplat-error-head">
          ${badge(row.level || 'error', row.level === 'warn' ? 'orange' : 'red')}
          <span class="aplat-error-msg">${row.message}</span>
        </span>
        <span class="aplat-error-meta">
          ${row.method ? html`<code>${row.method} ${row.path || ''}</code>` : ''}
          <span title="${fmtDateTime(row.created_at)}">${fmtRelative(row.created_at)}</span>
        </span>
      </summary>
      <div class="aplat-error-body">
        <dl class="kv">
          <dt>Quando</dt><dd>${fmtDateTime(row.created_at)}</dd>
          <dt>Rota</dt><dd>${row.method ? `${row.method} ${row.path || ''}` : (row.path || '—')}</dd>
          <dt>Usuário</dt><dd>${row.user_name ? html`<a href="/admin/alunos/${row.user_id}">${row.user_name}</a>` : '—'}</dd>
        </dl>
        ${row.stack ? html`<pre class="aplat-stack"><code>${row.stack}</code></pre>` : html`<p class="text-3">Sem pilha registrada.</p>`}
      </div>
    </details>`;
}

function paintErrors() {
  const el = qs('#aplat-errors', state.el);
  if (!el) return;
  const { items, total, page } = state.errors;
  if (!items.length) {
    render(el, emptyState({ icon: 'circle-check', title: 'Nenhum erro registrado', text: 'Nada quebrou por aqui — os erros de servidor apareceriam nesta lista.', size: 'sm' }));
    return;
  }
  const loaded = items.length;
  render(el, html`
    <div class="aplat-errors">${items.map(errorItem)}</div>
    ${loaded < total
      ? html`<button type="button" class="btn btn-secondary btn-sm mt-4" data-action="more-errors">${icon('chevron-down')}<span>Carregar mais (${num(total - loaded)} restantes)</span></button>`
      : html`<p class="hint mt-3">Mostrando ${num(loaded)} de ${num(total)} registros.</p>`}`);
  state.errors.page = page;
}

async function loadErrors({ append = false } = {}) {
  const page = append ? state.errors.page + 1 : 1;
  try {
    const response = await api.get('/api/admin/platform/errors', { query: { page, limit: ERROR_PAGE_SIZE } });
    const items = response.items || [];
    state.errors = {
      items: append ? [...state.errors.items, ...items] : items,
      total: Number(response.total) || items.length,
      page,
    };
    paintErrors();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível carregar os erros.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------
function auditDetail(row) {
  const data = row.data && typeof row.data === 'object' ? JSON.stringify(row.data, null, 2) : String(row.data ?? '');
  modal({
    title: row.action,
    subtitle: `${row.admin_name || 'Administrador'} · ${fmtDateTime(row.created_at)}`,
    size: 'sm',
    body: html`
      <dl class="kv">
        <dt>Entidade</dt><dd>${row.entity || '—'}</dd>
        <dt>Identificador</dt><dd><code>${row.entity_id || '—'}</code></dd>
        <dt>Origem</dt><dd>${row.ip || '—'}</dd>
      </dl>
      ${data && data !== 'null' ? html`<pre class="aplat-stack mt-4"><code>${data}</code></pre>` : html`<p class="text-3 mt-4">Sem dados adicionais.</p>`}`,
    actions: [{ label: 'Fechar', variant: 'secondary' }],
  });
}

function mountAuditTable() {
  const el = qs('#aplat-audit', state.el);
  if (!el) return;
  state.auditTable = mountTable(el, {
    pageSize: 25,
    search: true,
    searchPlaceholder: 'Buscar por ação, administrador ou entidade',
    emptyText: 'Nenhuma ação registrada',
    filters: [
      { key: 'action', label: 'Ação', options: state.auditActions },
      { key: 'from', label: 'A partir de', type: 'date' },
      { key: 'to', label: 'Até', type: 'date' },
    ],
    columns: [
      { key: 'created_at', label: 'Quando', nowrap: true, render: (row) => html`<span title="${fmtDateTime(row.created_at)}">${fmtRelative(row.created_at)}</span>` },
      { key: 'admin_name', label: 'Administrador', render: (row) => (row.admin_name ? html`<span>${row.admin_name}<br><span class="text-xs text-3">${row.admin_email || ''}</span></span>` : html`<span class="text-3">—</span>`) },
      { key: 'action', label: 'Ação', render: (row) => html`<code class="aplat-action">${row.action}</code>` },
      { key: 'entity', label: 'Entidade', render: (row) => (row.entity ? html`<span>${row.entity}</span>` : html`<span class="text-3">—</span>`) },
      { key: 'ip', label: 'Origem', render: (row) => (row.ip ? html`<span class="text-xs text-3">${row.ip}</span>` : html`<span class="text-3">—</span>`) },
    ],
    rowActions: [{ label: 'Ver detalhes', icon: 'eye', onClick: (row) => auditDetail(row) }],
    fetch: (page, query) => api.get('/api/admin/platform/audit', { query }),
  });
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Plataforma',
    subtitle: 'Saúde do servidor, consumo de inteligência artificial, erros e auditoria.',
    actions: html`<button type="button" class="btn btn-secondary" data-action="reload">${icon('refresh-cw')}<span>Atualizar</span></button>`,
  });
}

function paint() {
  render(state.el, html`
    <div class="aplat-page">
      ${header()}
      ${healthSection()}
    ${aiSection()}
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('triangle-alert')}<span>Últimos erros</span></h2>
        <span class="card-subtitle">Registros gravados pelo servidor</span>
      </div>
      <div class="card-body" id="aplat-errors">${skeleton('list', 3)}</div>
    </section>
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('clipboard-list')}<span>Registro de auditoria</span></h2>
        <span class="card-subtitle">Toda escrita feita pelo painel</span>
      </div>
      <div class="card-body" id="aplat-audit"></div>
    </section>
    </div>`);
  drawAiChart();
  paintErrors();
  mountAuditTable();
}

async function load() {
  render(state.el, html`${header()}${skeleton('stats', 4)}<div class="mt-6">${skeleton('chart')}</div>`);
  const [health, usage, errors, audit] = await Promise.all([
    // /health responde 503 quando o banco está fora, mas o corpo traz o diagnóstico:
    // por isso a resposta é lida crua, sem passar pelo tratamento de erro padrão.
    api.get('/api/admin/platform/health', { raw: true }).then((res) => res.json()).catch(() => null),
    api.get('/api/admin/ai/usage', { query: { days: 30 } }).catch(() => null),
    api.get('/api/admin/platform/errors', { query: { page: 1, limit: ERROR_PAGE_SIZE } }).catch(() => ({ items: [], total: 0 })),
    api.get('/api/admin/platform/audit', { query: { page: 1, limit: 1 } }).catch(() => ({ actions: [] })),
  ]);
  if (!health && !usage) {
    render(state.el, html`${header()}${errorState({ title: 'Não foi possível carregar os dados da plataforma' })}`);
    return;
  }
  state.health = health;
  state.usage = usage;
  state.errors = { items: errors.items || [], total: Number(errors.total) || 0, page: 1 };
  state.auditActions = (audit && Array.isArray(audit.actions) ? audit.actions : []).map((action) => ({ value: action, label: action }));
  paint();
}

export default async function renderPlatform(ctx) {
  state = {
    el: ctx.el,
    health: null,
    usage: null,
    errors: { items: [], total: 0, page: 1 },
    auditActions: [],
    auditTable: null,
  };
  ctx.setTitle('Plataforma');
  on(ctx.el, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    if (action === 'more-errors') loadErrors({ append: true });
    else if (action === 'reload' || action === 'retry') load();
  });
  await load();
}

export function unmount() {
  if (state) {
    if (state.auditTable) state.auditTable.destroy();
    if (state.el) destroyChart(qs('#aplat-ai', state.el));
  }
  state = null;
}

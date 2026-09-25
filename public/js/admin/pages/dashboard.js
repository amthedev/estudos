// =====================================================================
// Foco Elite — Painel administrativo: visão geral (/admin)
//
// Tudo vem de GET /api/admin/dashboard em uma única chamada: números da
// operação (alunos, conteúdo, atividade e assinaturas), duas séries de 30
// dias (cadastros e alunos ativos por dia) e as listas de últimos alunos
// e últimas redações corrigidas.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, qs, on,
  pageHeader, emptyState, errorState, skeleton, statCard, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, fmtDateShort, fmtRelative, fmtScore, fmtDateTime, initials } from '../../core/format.js';
import { lineChart, barChart, destroyChart, palette, withAlpha } from '../../core/charts.js';

let state = null;

const num = (value) => fmtNumber(value ?? 0, { digits: 0 });

/** Rótulo e tom da situação de uma redação. */
function essayStatus(status) {
  if (status === 'corrected') return { label: 'Corrigida', tone: 'green' };
  if (status === 'submitted') return { label: 'Em correção', tone: 'orange' };
  if (status === 'failed') return { label: 'Falhou', tone: 'red' };
  return { label: 'Rascunho', tone: 'gray' };
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
function statsGrid(data) {
  const cards = [
    { label: 'Alunos cadastrados', value: num(data.students_total), icon: 'users', href: '/admin/alunos' },
    { label: 'Ativos nos últimos 7 dias', value: num(data.students_active_7d), icon: 'activity', tone: 'green', hint: 'Com acesso registrado na semana' },
    { label: 'Novos no mês', value: num(data.students_new_30d), icon: 'user-plus', hint: 'Cadastros nos últimos 30 dias' },
    { label: 'Aulas cadastradas', value: num(data.lessons_total), icon: 'play', href: '/admin/aulas' },
    { label: 'Questões cadastradas', value: num(data.questions_total), icon: 'file-text', href: '/admin/questoes' },
    { label: 'Simulados realizados', value: num(data.simulados_attempts), icon: 'target', href: '/admin/simulados' },
    { label: 'Redações corrigidas', value: num(data.essays_corrected), icon: 'pen-line', href: '/admin/redacao' },
    { label: 'Provas cadastradas', value: num(data.past_exams_total), icon: 'file', href: '/admin/provas-anteriores' },
    { label: 'Assinaturas ativas', value: num(data.subscriptions_active), icon: 'credit-card', tone: 'green', href: '/admin/planos' },
  ];
  return html`<section class="grid grid-4 adash-stats">${cards.map((card) => statCard(card))}</section>`;
}

function aiCard(data) {
  const used = Number(data.ai_month_tokens) || 0;
  const limit = Number(data.ai_month_limit) || 0;
  return html`
    <section class="card adash-ai">
      <div class="card-body">
        <div class="adash-ai-head">
          <h2 class="card-title">${icon('sparkles')}<span>Consumo de IA no mês</span></h2>
          <a class="btn btn-ghost btn-sm" href="/admin/plataforma">${icon('chart-column')}<span>Detalhar</span></a>
        </div>
        <p class="adash-ai-value">
          <strong>${num(used)}</strong>
          <span class="text-2">tokens · ${limit > 0 ? `cota de ${num(limit)} por aluno` : 'sem cota por aluno'}</span>
        </p>
      </div>
    </section>`;
}

function chartsSection() {
  return html`
    <section class="grid grid-2 adash-charts">
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('user-plus')}<span>Cadastros por dia</span></h2>
          <span class="card-subtitle">Últimos 30 dias</span>
        </div>
        <div class="card-body">
          <div class="adash-chart"><canvas id="adash-signups" aria-label="Cadastros de alunos por dia" role="img"></canvas></div>
        </div>
      </article>
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('activity')}<span>Atividade por dia</span></h2>
          <span class="card-subtitle">Alunos com estudo registrado</span>
        </div>
        <div class="card-body">
          <div class="adash-chart"><canvas id="adash-activity" aria-label="Alunos ativos por dia" role="img"></canvas></div>
        </div>
      </article>
    </section>`;
}

function studentRow(student) {
  const blocked = student.status === 'blocked';
  const meta = [
    student.exam_short_name || null,
    student.onboarding_completed ? null : 'Onboarding pendente',
  ].filter(Boolean);
  return html`
    <a class="list-item adash-row" href="/admin/alunos/${student.id}">
      <span class="avatar avatar-sm" aria-hidden="true">${initials(student.name)}</span>
      <span class="list-item-main">
        <span class="list-item-title">${student.name}</span>
        <span class="list-item-meta">
          <span class="truncate">${student.email}</span>
          ${meta.map((text) => html`<span>${text}</span>`)}
        </span>
      </span>
      <span class="list-item-end adash-row-end">
        ${blocked ? badge('Bloqueado', 'red') : badge('Ativo', 'green')}
        <span class="text-xs text-3">${fmtRelative(student.created_at)}</span>
      </span>
    </a>`;
}

function essayRow(essay) {
  const status = essayStatus(essay.status);
  const when = essay.corrected_at || essay.submitted_at || essay.created_at;
  const score = essay.status === 'corrected' && essay.score !== null && essay.score !== undefined
    ? `${fmtScore(essay.score)}${essay.max_score ? ` / ${fmtScore(essay.max_score)}` : ''}`
    : null;
  return html`
    <a class="list-item adash-row" href="/admin/alunos/${essay.user_id}">
      <span class="list-item-icon" aria-hidden="true">${icon('pen-line')}</span>
      <span class="list-item-main">
        <span class="list-item-title">${essay.theme_title || 'Tema livre'}</span>
        <span class="list-item-meta">
          <span class="truncate">${essay.user_name}</span>
          ${essay.exam_short_name ? html`<span>${essay.exam_short_name}</span>` : ''}
          <span title="${fmtDateTime(when)}">${fmtRelative(when)}</span>
        </span>
      </span>
      <span class="list-item-end adash-row-end">
        ${score ? html`<strong class="adash-score">${score}</strong>` : badge(status.label, status.tone)}
      </span>
    </a>`;
}

function listsSection(data) {
  const students = Array.isArray(data.latest_students) ? data.latest_students : [];
  const essays = Array.isArray(data.latest_essays) ? data.latest_essays : [];
  return html`
    <section class="grid grid-2 adash-lists">
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('users')}<span>Últimos alunos</span></h2>
          <a class="link-sm" href="/admin/alunos">Ver todos</a>
        </div>
        <div class="card-body">
          ${students.length
            ? html`<div class="list list-plain">${students.map(studentRow)}</div>`
            : emptyState({
              icon: 'users',
              title: 'Nenhum aluno cadastrado ainda',
              text: 'Assim que alguém criar uma conta, ela aparece aqui.',
              size: 'sm',
            })}
        </div>
      </article>
      <article class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('pen-line')}<span>Últimas redações</span></h2>
          <a class="link-sm" href="/admin/redacao">Ver redações</a>
        </div>
        <div class="card-body">
          ${essays.length
            ? html`<div class="list list-plain">${essays.map(essayRow)}</div>`
            : emptyState({
              icon: 'pen-line',
              title: 'Nenhuma redação enviada',
              text: 'As correções feitas pela IA aparecem aqui.',
              action: { label: 'Cadastrar temas', href: '/admin/redacao', icon: 'plus' },
              size: 'sm',
            })}
        </div>
      </article>
    </section>`;
}

// ---------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------
function drawCharts(data) {
  const series = data.series || {};
  const signups = Array.isArray(series.signups_by_day) ? series.signups_by_day : [];
  const activity = Array.isArray(series.activity_by_day) ? series.activity_by_day : [];

  barChart(qs('#adash-signups', state.el), {
    labels: signups.map((row) => fmtDateShort(row.date)),
    datasets: [{ label: 'Cadastros', data: signups.map((row) => Number(row.count) || 0), backgroundColor: palette.primary2, borderRadius: 4 }],
    options: { scales: { y: { ticks: { precision: 0 } } } },
  });

  lineChart(qs('#adash-activity', state.el), {
    labels: activity.map((row) => fmtDateShort(row.date)),
    datasets: [{
      label: 'Alunos ativos',
      data: activity.map((row) => Number(row.count) || 0),
      borderColor: palette.success,
      backgroundColor: withAlpha(palette.success, 0.16),
      fill: true,
      tension: 0.32,
      pointRadius: 0,
      pointHoverRadius: 4,
    }],
    options: { scales: { y: { ticks: { precision: 0 } } } },
  });
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Visão geral',
    subtitle: 'Como a plataforma está hoje: alunos, conteúdo e atividade.',
    actions: html`
      <button type="button" class="btn btn-secondary" data-action="reload">${icon('refresh-cw')}<span>Atualizar</span></button>
      <a class="btn btn-primary" href="/admin/alunos">${icon('users')}<span>Gerenciar alunos</span></a>`,
  });
}

function paint() {
  const { el, status, data, error } = state;
  if (status === 'loading') {
    render(el, html`${header()}${skeleton('stats', 4)}<div class="mt-6">${skeleton('chart')}</div>`);
    return;
  }
  if (status === 'error') {
    render(el, html`${header()}${errorState({
      title: 'Não foi possível carregar a visão geral',
      message: error || 'Verifique sua conexão e tente novamente.',
    })}`);
    return;
  }
  render(el, html`
    <div class="adash-page">
      ${header()}
      ${statsGrid(data)}
      ${aiCard(data)}
      ${chartsSection()}
      ${listsSection(data)}
    </div>`);
  drawCharts(data);
}

async function load() {
  state.status = 'loading';
  paint();
  try {
    state.data = await api.get('/api/admin/dashboard');
    state.status = 'ready';
  } catch (err) {
    state.error = err && err.message ? err.message : 'Erro inesperado.';
    state.status = 'error';
  }
  paint();
}

export default async function renderDashboard(ctx) {
  state = { el: ctx.el, status: 'loading', data: null, error: null };
  ctx.setTitle('Visão geral');
  on(ctx.el, 'click', '[data-action="reload"], [data-action="retry"]', () => load());
  await load();
}

export function unmount() {
  if (state && state.el) {
    destroyChart(qs('#adash-signups', state.el));
    destroyChart(qs('#adash-activity', state.el));
  }
  state = null;
}

// =====================================================================
// /app/desempenho — métricas, evolução semanal e mensal, acurácia por
// matéria e assunto, pontos fortes e fracos, simulados e redações recentes.
// Consome GET /api/performance.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, pageHeader, emptyState, errorState, skeleton,
  badge, statCard, progressBar, qs, debounce,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDateShort, fmtDateTime, fmtHours, fmtNumber, fmtPct, fmtScore, monthName, pluralize } from '../../core/format.js';
import { barChart, lineChart, destroyChart, palette, withAlpha } from '../../core/charts.js';

let page = null;
let data = null;
let topicFilter = '';
const canvases = [];

export default async function renderPage(ctx) {
  page = ctx;
  topicFilter = '';
  ctx.setTitle('Meu Desempenho');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  canvases.forEach((canvas) => destroyChart(canvas));
  canvases.length = 0;
  data = null;
  page = null;
  topicFilter = '';
}

async function load() {
  try {
    data = await api.get('/api/performance');
  } catch (err) {
    if (err && err.status === 404) {
      renderTo(
        page.el,
        html`${header()}
          ${emptyState({
            icon: 'chart-column',
            title: 'Desempenho ainda não disponível',
            text: 'Estamos preparando esta área. Continue estudando: as métricas aparecem assim que ficarem prontas.',
            action: { label: 'Ir para o cronograma', href: '/app/cronograma', icon: 'calendar-days' },
          })}`
      );
      return;
    }
    renderTo(
      page.el,
      html`${header()}
        ${errorState({
          title: 'Não foi possível carregar seu desempenho',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', page.el);
    if (btn) btn.addEventListener('click', () => load());
    return;
  }
  paint();
}

function header() {
  return pageHeader({
    title: 'Meu Desempenho',
    subtitle: 'Como você está evoluindo em horas de estudo, acertos e simulados.',
  });
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
function statsBlock() {
  const overall = data.overall || {};
  const hours = data.hours || {};
  const lessons = data.lessons || {};
  return html`
    <div class="grid grid-4 mb-6">
      ${statCard({
        label: 'Acurácia geral',
        value: fmtPct(overall.accuracy_pct),
        hint: overall.answered ? `${fmtNumber(overall.correct, { digits: 0 })} de ${fmtNumber(overall.answered, { digits: 0 })} questões` : 'Sem questões respondidas',
        icon: 'target',
        tone: overall.accuracy_pct >= 70 ? 'green' : overall.accuracy_pct >= 50 ? 'orange' : 'blue',
      })}
      ${statCard({ label: 'Horas estudadas', value: fmtHours(hours.total || 0), hint: `${fmtHours(hours.this_week || 0)} nesta semana`, icon: 'clock' })}
      ${statCard({
        label: 'Aulas concluídas',
        value: `${lessons.done || 0}/${lessons.total || 0}`,
        hint: `${lessons.pct || 0}% do conteúdo da sua prova`,
        icon: 'play',
        tone: 'green',
      })}
      ${statCard({ label: 'Sequência', value: pluralize(data.streak_days || 0, 'dia', 'dias'), hint: 'dias seguidos estudando', icon: 'flame', tone: 'orange' })}
    </div>`;
}

function weeklyBlock() {
  const weekly = data.weekly || [];
  const hasData = weekly.some((w) => w.minutes > 0 || w.answered > 0);
  return html`
    <section class="card mb-6">
      <div class="card-header">
        <h2 class="card-title">Semana a semana</h2>
        <span class="text-3 text-sm">Minutos estudados e acurácia</span>
      </div>
      <div class="card-body">
        ${hasData
          ? html`<div class="pf-chart"><canvas id="pf-weekly" aria-label="Minutos estudados e acurácia por semana"></canvas></div>`
          : emptyState({ icon: 'chart-column', title: 'Ainda sem histórico semanal', text: 'Conclua aulas e responda questões para começar a série.' })}
      </div>
    </section>`;
}

function monthlyBlock() {
  const monthly = data.monthly || [];
  const hasData = monthly.some((m) => m.minutes > 0 || m.answered > 0);
  if (!hasData) return '';
  return html`
    <section class="card mb-6">
      <div class="card-header">
        <h2 class="card-title">Evolução mensal</h2>
        <span class="text-3 text-sm">Últimos ${monthly.length} meses</span>
      </div>
      <div class="card-body">
        <div class="pf-chart"><canvas id="pf-monthly" aria-label="Evolução mensal de horas e acurácia"></canvas></div>
      </div>
    </section>`;
}

function subjectsBlock() {
  const rows = data.by_subject || [];
  return html`
    <section class="card mb-6">
      <div class="card-header"><h2 class="card-title">Acurácia por matéria</h2></div>
      <div class="card-body">
        ${rows.length
          ? html`<ul class="pf-bars">
              ${rows.map(
                (row) => html`
                  <li class="pf-bar">
                    <div class="pf-bar-head">
                      <span class="pf-bar-name"><span class="subject-dot" style="background:${row.color || palette.primary2}"></span>${row.name}</span>
                      <span class="pf-bar-value">${fmtPct(row.accuracy_pct)}<small>${row.correct}/${row.answered}</small></span>
                    </div>
                    <div class="pf-bar-track">
                      <div class="pf-bar-fill" style="width:${Math.max(2, Number(row.accuracy_pct) || 0)}%;background:${row.color || palette.primary2}"></div>
                    </div>
                  </li>`
              )}
            </ul>`
          : emptyState({
              icon: 'file-text',
              title: 'Nenhuma questão respondida ainda',
              text: 'Resolva questões para ver a acurácia de cada matéria.',
              action: { label: 'Ir para as questões', href: '/app/questoes', icon: 'file-text' },
            })}
      </div>
    </section>`;
}

function highlightsBlock() {
  const strengths = data.strengths || [];
  const weaknesses = data.weaknesses || [];
  if (!strengths.length && !weaknesses.length) return '';
  const card = (title, iconName, tone, rows, emptyText) => html`
    <section class="card">
      <div class="card-header"><h2 class="card-title">${icon(iconName)} ${title}</h2></div>
      <div class="card-body">
        ${rows.length
          ? html`<ul class="list list-plain pf-highlights">
              ${rows.map(
                (row) => html`
                  <li class="list-item">
                    <div class="list-item-main">
                      <span class="list-item-title">${row.name}</span>
                      <span class="list-item-meta">${row.subject_name} · ${pluralize(row.answered, 'questão', 'questões')}</span>
                    </div>
                    <div class="list-item-end">${badge(fmtPct(row.accuracy_pct), tone)}</div>
                  </li>`
              )}
            </ul>`
          : html`<p class="text-2 m-0">${emptyText}</p>`}
      </div>
    </section>`;
  return html`
    <div class="grid grid-2 mb-6">
      ${card('Pontos fortes', 'trending-up', 'green', strengths, 'Responda pelo menos 5 questões de um assunto para ele aparecer aqui.')}
      ${card('Pontos fracos', 'trending-down', 'red', weaknesses, 'Ainda não há assuntos com respostas suficientes para apontar fraquezas.')}
    </div>`;
}

function topicRows() {
  const term = topicFilter.trim().toLowerCase();
  const rows = data.by_topic || [];
  if (!term) return rows;
  return rows.filter(
    (row) => row.name.toLowerCase().includes(term) || String(row.subject_name || '').toLowerCase().includes(term)
  );
}

function topicsTableHtml() {
  const rows = topicRows();
  if (!rows.length) {
    return html`<div class="p-4">${emptyState({
      icon: 'search',
      title: 'Nenhum assunto encontrado',
      text: 'Ajuste o filtro ou responda questões de novos assuntos.',
    })}</div>`;
  }
  return html`
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Assunto</th><th>Matéria</th><th>Respondidas</th><th>Acertos</th><th>Acurácia</th></tr></thead>
        <tbody>
          ${rows.map(
            (row) => html`
              <tr>
                <td>${row.name}</td>
                <td class="text-2">${row.subject_name}</td>
                <td class="nowrap">${row.answered}</td>
                <td class="nowrap">${row.correct}</td>
                <td class="pf-cell-pct">
                  ${progressBar(row.accuracy_pct || 0, {
                    color: row.accuracy_pct >= 70 ? 'success' : row.accuracy_pct >= 50 ? 'warning' : 'danger',
                    size: 'sm',
                  })}
                  <span>${fmtPct(row.accuracy_pct)}</span>
                </td>
              </tr>`
          )}
        </tbody>
      </table>
    </div>`;
}

function topicsBlock() {
  if (!(data.by_topic || []).length) return '';
  return html`
    <section class="card mb-6">
      <div class="card-header">
        <h2 class="card-title">Desempenho por assunto</h2>
        <label class="search-box pf-search">
          <span class="sr-only">Filtrar assuntos</span>
          ${icon('search')}
          <input class="input" type="search" id="pf-topic-filter" placeholder="Filtrar por assunto ou matéria" autocomplete="off">
        </label>
      </div>
      <div id="pf-topics">${topicsTableHtml()}</div>
    </section>`;
}

function recentBlock() {
  const simulados = (data.simulados || []).slice().reverse();
  const essays = (data.essays || []).slice().reverse();
  if (!simulados.length && !essays.length) return '';
  return html`
    <div class="grid grid-2">
      <section class="card">
        <div class="card-header"><h2 class="card-title">Simulados recentes</h2><a class="link-sm" href="/app/simulados">Ver todos</a></div>
        <div class="card-body">
          ${simulados.length
            ? html`<ul class="list list-plain">
                ${simulados.map(
                  (s) => html`
                    <li class="list-item is-clickable">
                      <div class="list-item-main">
                        <a class="list-item-title link-plain" href="/app/simulados/${s.id}/resultado">${s.title}</a>
                        <span class="list-item-meta">${fmtDateTime(s.finished_at)} · ${s.correct_count} acertos, ${s.wrong_count} erros</span>
                      </div>
                      <div class="list-item-end"><strong>${fmtScore(s.score)}</strong></div>
                    </li>`
                )}
              </ul>`
            : html`<p class="text-2 m-0">Você ainda não finalizou simulados.</p>`}
        </div>
      </section>
      <section class="card">
        <div class="card-header"><h2 class="card-title">Redações corrigidas</h2><a class="link-sm" href="/app/redacao">Ver todas</a></div>
        <div class="card-body">
          ${essays.length
            ? html`<ul class="list list-plain">
                ${essays.map(
                  (e) => html`
                    <li class="list-item is-clickable">
                      <div class="list-item-main">
                        <a class="list-item-title link-plain" href="/app/redacao/${e.id}">${e.theme_title || 'Redação'}</a>
                        <span class="list-item-meta">${fmtDateTime(e.corrected_at)}</span>
                      </div>
                      <div class="list-item-end"><strong>${fmtScore(e.score)}</strong><span class="text-3 text-xs">/${fmtScore(e.max_score)}</span></div>
                    </li>`
                )}
              </ul>`
            : html`<p class="text-2 m-0">Nenhuma redação corrigida até agora.</p>`}
        </div>
      </section>
    </div>`;
}

function paint() {
  canvases.forEach((canvas) => destroyChart(canvas));
  canvases.length = 0;

  renderTo(
    page.el,
    html`
      ${header()}
      ${statsBlock()}
      ${weeklyBlock()}
      ${monthlyBlock()}
      ${subjectsBlock()}
      ${highlightsBlock()}
      ${topicsBlock()}
      ${recentBlock()}`
  );

  drawCharts();

  const filterInput = qs('#pf-topic-filter', page.el);
  if (filterInput) {
    filterInput.addEventListener(
      'input',
      debounce(() => {
        topicFilter = filterInput.value;
        renderTo(qs('#pf-topics', page.el), topicsTableHtml());
      }, 200)
    );
  }
}

function drawCharts() {
  const weekly = qs('#pf-weekly', page.el);
  if (weekly) {
    canvases.push(weekly);
    const series = data.weekly || [];
    barChart(weekly, {
      labels: series.map((w) => fmtDateShort(w.week_start)),
      datasets: [
        { label: 'Minutos', data: series.map((w) => w.minutes), backgroundColor: withAlpha(palette.primary2, 0.65), order: 2 },
        {
          type: 'line',
          label: 'Acurácia (%)',
          data: series.map((w) => (w.accuracy_pct === null ? null : w.accuracy_pct)),
          borderColor: palette.success,
          backgroundColor: palette.success,
          yAxisID: 'y1',
          spanGaps: true,
          order: 1,
        },
      ],
      options: {
        plugins: { legend: { display: true } },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Minutos', color: palette.text2 } },
          y1: {
            position: 'right',
            beginAtZero: true,
            max: 100,
            grid: { drawOnChartArea: false },
            ticks: { callback: (value) => `${value}%` },
          },
        },
      },
    });
  }

  const monthly = qs('#pf-monthly', page.el);
  if (monthly) {
    canvases.push(monthly);
    const series = data.monthly || [];
    lineChart(monthly, {
      labels: series.map((m) => {
        const [year, month] = String(m.month || m.month_start).split('-');
        return `${monthName(Number(month) - 1, { short: true })}/${String(year).slice(2)}`;
      }),
      datasets: [
        { label: 'Horas estudadas', data: series.map((m) => Math.round((m.minutes / 60) * 10) / 10), borderColor: palette.primary2, fill: true },
        {
          label: 'Acurácia (%)',
          data: series.map((m) => (m.accuracy_pct === null ? null : m.accuracy_pct)),
          borderColor: palette.success,
          yAxisID: 'y1',
          spanGaps: true,
        },
      ],
      options: {
        plugins: { legend: { display: true } },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Horas', color: palette.text2 } },
          y1: { position: 'right', beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${value}%` } },
        },
      },
    });
  }
}

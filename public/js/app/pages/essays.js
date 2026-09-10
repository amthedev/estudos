// =====================================================================
// Foco Elite — Minhas Redações (ARCHITECTURE §6.4)
//
// Cabeçalho com as estatísticas (GET /api/essays/stats), gráfico de evolução
// das notas e a lista das redações do aluno (GET /api/essays), com tema, prova,
// data, nota e situação. Rascunhos voltam para o editor; redações corrigidas
// abrem a correção detalhada.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import {
  html, render, toast, confirm, qs, on,
  pageHeader, emptyState, errorState, skeleton, badge, statCard,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { lineChart, destroyChart, palette, withAlpha } from '../../core/charts.js';
import { fmtDate, fmtDateCompact, fmtScore, fmtNumber, statusLabel, pluralize } from '../../core/format.js';

/** Situação da redação → tom do badge e ícone da linha. */
const STATUS = {
  draft: { tone: 'gray', icon: 'square-pen' },
  submitted: { tone: 'blue', icon: 'hourglass' },
  corrected: { tone: 'green', icon: 'circle-check' },
  failed: { tone: 'red', icon: 'triangle-alert' },
};

let state = null;

/** Tom da nota conforme o aproveitamento (verde/laranja/vermelho). */
function scoreTone(score, maxScore) {
  const max = Number(maxScore) || 0;
  if (!max || score === null || score === undefined) return '';
  const pct = (Number(score) / max) * 100;
  if (pct >= 70) return 'good';
  if (pct >= 50) return 'medium';
  return 'bad';
}

// ---------------------------------------------------------------------
// Blocos da tela
// ---------------------------------------------------------------------

function statsRow(stats) {
  const count = Number(stats.count) || 0;
  return html`
    <div class="grid grid-3 ess-stats">
      ${statCard({
        label: 'Redações corrigidas',
        value: fmtNumber(count, { digits: 0 }),
        hint: count ? pluralize(count, 'correção concluída', 'correções concluídas') : 'Envie a primeira para começar',
        icon: 'pen-line',
      })}
      ${statCard({
        label: 'Nota média',
        value: stats.avg === null || stats.avg === undefined ? '—' : fmtScore(stats.avg),
        hint: stats.avg_pct === null || stats.avg_pct === undefined ? 'Sem correções ainda' : `${fmtNumber(stats.avg_pct)}% do total possível`,
        icon: 'chart-line',
        tone: 'blue',
      })}
      ${statCard({
        label: 'Melhor nota',
        value: stats.best === null || stats.best === undefined ? '—' : fmtScore(stats.best),
        hint: count > 1 ? 'Seu melhor desempenho até aqui' : 'Sua marca a superar',
        icon: 'trophy',
        tone: 'green',
      })}
    </div>`;
}

function evolutionCard(stats) {
  const evolution = Array.isArray(stats.evolution) ? stats.evolution : [];
  if (evolution.length < 2) return '';
  return html`
    <section class="card ess-chart">
      <div class="card-header">
        <h2 class="card-title">${icon('chart-line')}<span>Evolução das suas notas</span></h2>
        <span class="text-xs text-3">${pluralize(evolution.length, 'correção', 'correções')}</span>
      </div>
      <div class="card-body">
        <div class="ess-chart-box"><canvas data-ess-chart aria-label="Gráfico com a evolução das notas das redações"></canvas></div>
      </div>
    </section>`;
}

function essayRow(essay) {
  const meta = STATUS[essay.status] || STATUS.draft;
  const isDraft = essay.status === 'draft';
  const href = isDraft ? `/app/redacao/nova?essay_id=${encodeURIComponent(essay.id)}` : `/app/redacao/${essay.id}`;
  const date = essay.corrected_at || essay.submitted_at || essay.created_at;
  const words = Number(essay.word_count) || 0;

  return html`
    <li class="ess-item">
      <a class="ess-item-main" href="${href}">
        <span class="ess-item-icon ${essay.status}">${icon(meta.icon)}</span>
        <span class="ess-item-body">
          <span class="ess-item-title">${essay.theme_title}</span>
          <span class="meta ess-item-meta">
            <span>${essay.exam_short_name || essay.exam_name}</span>
            <span>${fmtDate(date)}</span>
            ${words ? html`<span>${fmtNumber(words, { digits: 0 })} palavras</span>` : ''}
          </span>
        </span>
        <span class="ess-item-end">
          ${essay.status === 'corrected' && essay.score !== null
            ? html`
              <span class="ess-item-score score ${scoreTone(essay.score, essay.max_score)}">
                ${fmtScore(essay.score)}<small>/${fmtScore(essay.max_score)}</small>
              </span>`
            : ''}
          ${badge(statusLabel(essay.status), meta.tone)}
          <span class="ess-item-go" aria-hidden="true">${icon('chevron-right')}</span>
        </span>
      </a>
      ${isDraft
        ? html`
          <button type="button" class="btn btn-ghost btn-icon btn-sm ess-item-del" data-del="${essay.id}" aria-label="Excluir o rascunho ${essay.theme_title}">
            ${icon('trash-2', { size: 15 })}
          </button>`
        : ''}
    </li>`;
}

function essayList(essays) {
  if (!essays.length) {
    return emptyState({
      icon: 'pen-line',
      title: 'Você ainda não escreveu nenhuma redação',
      text: 'Escolha um tema, escreva e receba uma correção detalhada por critério, com pontos fortes e o que melhorar.',
      action: { label: 'Escrever a primeira redação', href: '/app/redacao/nova', icon: 'plus' },
    });
  }
  return html`
    <section class="card ess-list-card">
      <div class="card-header">
        <h2 class="card-title">${icon('list')}<span>Minhas Redações</span></h2>
        <span class="text-xs text-3">${pluralize(essays.length, 'redação', 'redações')}</span>
      </div>
      <ul class="ess-list">${essays.map(essayRow)}</ul>
    </section>`;
}

// ---------------------------------------------------------------------
// Renderização e dados
// ---------------------------------------------------------------------

function paint() {
  const content = qs('[data-ess-content]', state.el);
  if (!content) return;

  if (state.error) {
    render(content, errorState({ title: 'Não foi possível carregar suas redações', message: state.error.message, retry: 'reload-essays' }));
    return;
  }
  if (state.loading) {
    render(content, html`${skeleton('stats', 3)}<div class="mt-4">${skeleton('list', 4)}</div>`);
    return;
  }

  const stats = state.stats || { count: 0, avg: null, best: null, avg_pct: null, evolution: [] };
  render(
    content,
    html`
      ${statsRow(stats)}
      ${evolutionCard(stats)}
      ${essayList(state.essays)}`
  );
  drawChart(stats);
}

function drawChart(stats) {
  const canvas = qs('[data-ess-chart]', state.el);
  if (!canvas) return;
  const evolution = stats.evolution || [];
  state.chart = lineChart(canvas, {
    labels: evolution.map((point) => fmtDateCompact(point.date)),
    datasets: [
      {
        label: 'Nota',
        data: evolution.map((point) => Number(point.score) || 0),
        borderColor: palette.primary2,
        backgroundColor: withAlpha(palette.primary2, 0.16),
        fill: true,
      },
    ],
    options: {
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: Math.max(...evolution.map((point) => Number(point.max) || 0), 0) || undefined,
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (item) => {
              const point = evolution[item.dataIndex] || {};
              return ` ${fmtScore(point.score)} de ${fmtScore(point.max)} (${fmtNumber(point.pct, { digits: 0 })}%)`;
            },
          },
        },
      },
    },
  });
}

async function load() {
  const token = state.token;
  state.loading = true;
  state.error = null;
  paint();
  try {
    const [stats, essays] = await Promise.all([api.get('/api/essays/stats'), api.get('/api/essays')]);
    if (!state || state.token !== token) return;
    state.stats = stats || null;
    state.essays = Array.isArray(essays) ? essays : [];
  } catch (err) {
    if (!state || state.token !== token) return;
    state.error = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  state.loading = false;
  paint();
}

async function removeDraft(id) {
  const essay = state.essays.find((row) => row.id === id);
  const ok = await confirm({
    title: 'Excluir rascunho',
    message: essay ? `O rascunho "${essay.theme_title}" será apagado.` : 'O rascunho será apagado.',
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok || !state) return;
  try {
    await api.del(`/api/essays/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível excluir o rascunho.', { type: 'error' });
    return;
  }
  if (!state) return;
  toast('Rascunho excluído.', { type: 'success' });
  await load();
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderEssays(ctx) {
  ctx.setTitle('Redação IA');

  const token = Symbol('essays');
  state = { token, el: ctx.el, stats: null, essays: [], loading: true, error: null, chart: null, off: [] };

  render(
    ctx.el,
    html`
      ${pageHeader({
        title: 'Redação IA',
        subtitle: 'Escreva, receba a correção por critério e acompanhe a evolução das suas notas.',
        actions: html`<a class="btn btn-primary" href="/app/redacao/nova">${icon('plus')}<span>Nova redação</span></a>`,
      })}
      <div class="ess-page" data-ess-content></div>`
  );

  state.off.push(
    on(ctx.el, 'click', '[data-del]', (event, button) => {
      event.preventDefault();
      removeDraft(button.dataset.del);
    }),
    on(ctx.el, 'click', '[data-action="reload-essays"]', (event) => {
      event.preventDefault();
      load();
    })
  );

  await load();
}

export function unmount() {
  if (!state) return;
  const canvas = qs('[data-ess-chart]', state.el);
  if (canvas) destroyChart(canvas);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

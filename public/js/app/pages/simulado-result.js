// =====================================================================
// /app/simulados/:id/resultado — nota, gráficos, desempenho por matéria e
// assunto, revisão questão a questão e refazer os erros do simulado.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render as renderTo, toast, pageHeader, emptyState, errorState, skeleton,
  badge, statCard, progressBar, qs, qsa, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDateTime, fmtDuration, fmtScore, fmtMinutes, pluralize, difficultyLabel } from '../../core/format.js';
import { doughnutChart, barChart, destroyChart, palette } from '../../core/charts.js';
import { md, mdInline } from '../../core/markdown.js';
import { mountQuestionRunner } from '../../components/question-runner.js';

let page = null;
let attempt = null;
let runner = null;
const canvases = [];
let filter = 'all';
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  filter = 'all';
  ctx.setTitle('Resultado do simulado');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  canvases.forEach((c) => destroyChart(c));
  canvases.length = 0;
  if (runner) runner.destroy();
  runner = null;
  if (offClick) offClick();
  offClick = null;
  attempt = null;
  page = null;
}

async function load() {
  try {
    attempt = await api.get(`/api/simulados/attempts/${page.params.id}`);
  } catch (err) {
    renderTo(
      page.el,
      html`${pageHeader({ title: 'Resultado do simulado' })}
        ${errorState({
          title: 'Não foi possível carregar o resultado',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', page.el);
    if (btn) btn.addEventListener('click', () => load());
    return;
  }

  if (attempt.status === 'in_progress') {
    page.navigate(`/app/simulados/${attempt.id}`, { replace: true });
    return;
  }
  if (attempt.status !== 'finished') {
    renderTo(
      page.el,
      html`${pageHeader({ title: 'Resultado do simulado' })}
        ${emptyState({
          icon: 'circle-x',
          title: 'Este simulado foi descartado',
          text: 'Simulados descartados não geram resultado. Comece um novo quando quiser.',
          action: { label: 'Ir para simulados', href: '/app/simulados', icon: 'arrow-left' },
        })}`
    );
    return;
  }
  paint();
}

// ---------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------
const wrongQuestions = () => (attempt.questions || []).filter((q) => !q.is_correct);

function scoreTone(score) {
  const value = Number(score) || 0;
  if (value >= 70) return 'good';
  if (value >= 50) return 'medium';
  return 'bad';
}

function heroBlock() {
  const total = (attempt.questions || []).length || attempt.question_count || 0;
  return html`
    <section class="card sim-hero mb-6">
      <div class="card-body sim-hero-body">
        <div class="sim-hero-score">
          <span class="sim-hero-label">Nota final</span>
          <span class="score ${scoreTone(attempt.score)}">${fmtScore(attempt.score)}</span>
          <span class="sim-hero-scale">de 100</span>
          <span class="text-3 text-sm">${fmtDateTime(attempt.finished_at)}</span>
        </div>
        <div class="sim-hero-chart"><canvas id="sim-donut" aria-label="Distribuição de acertos, erros e questões em branco"></canvas></div>
        <div class="sim-hero-stats">
          ${statCard({ label: 'Acertos', value: attempt.correct_count ?? 0, hint: `de ${total} questões`, icon: 'circle-check', tone: 'green', compact: true })}
          ${statCard({ label: 'Erros', value: attempt.wrong_count ?? 0, icon: 'circle-x', tone: 'red', compact: true })}
          ${statCard({ label: 'Em branco', value: attempt.blank_count ?? 0, icon: 'minus', tone: 'gray', compact: true })}
          ${statCard({ label: 'Tempo', value: fmtDuration(attempt.time_spent_sec), hint: `limite de ${fmtMinutes(attempt.duration_min)}`, icon: 'clock', compact: true })}
        </div>
      </div>
    </section>`;
}

function subjectsBlock() {
  const rows = (attempt.breakdown && attempt.breakdown.by_subject) || [];
  if (!rows.length) return '';
  return html`
    <section class="card mb-6">
      <div class="card-header"><h2 class="card-title">Acertos por matéria</h2></div>
      <div class="card-body">
        <div class="sim-bars" style="height:${Math.max(160, rows.length * 44)}px">
          <canvas id="sim-subjects" aria-label="Percentual de acertos por matéria"></canvas>
        </div>
      </div>
    </section>`;
}

function topicsBlock() {
  const rows = (attempt.breakdown && attempt.breakdown.by_topic) || [];
  if (!rows.length) return '';
  return html`
    <section class="card mb-6">
      <div class="card-header"><h2 class="card-title">Desempenho por assunto</h2></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Assunto</th><th>Matéria</th><th>Questões</th><th>Acertos</th><th>Aproveitamento</th></tr></thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>${row.name}</td>
                  <td class="text-2">${row.subject_name}</td>
                  <td class="nowrap">${row.total}</td>
                  <td class="nowrap">${row.correct}${row.blank ? html` <span class="text-3">(${row.blank} em branco)</span>` : ''}</td>
                  <td class="sim-topic-pct">${progressBar(row.pct, { color: row.pct >= 70 ? 'success' : row.pct >= 50 ? 'warning' : 'danger', size: 'sm' })}<span>${row.pct}%</span></td>
                </tr>`
            )}
          </tbody>
        </table>
      </div>
    </section>`;
}

function optionRow(question, option) {
  const isCorrect = option.id === question.correct_option_id;
  const isSelected = option.id === question.selected_option_id;
  const cls = ['option', 'is-locked'];
  if (isCorrect) cls.push('correct');
  else if (isSelected) cls.push('wrong');
  if (isSelected) cls.push('selected');
  return html`
    <li class="${cls.join(' ')}">
      <span class="option-letter">${option.letter}</span>
      <span class="option-text">${raw(mdInline(option.text))}</span>
      <span class="option-mark">
        ${isCorrect ? html`<span class="text-success text-xs">${icon('check', { size: 14 })} Correta</span>` : ''}
        ${isSelected && !isCorrect ? html`<span class="text-danger text-xs">${icon('x', { size: 14 })} Sua resposta</span>` : ''}
      </span>
    </li>`;
}

function questionCard(question) {
  const status = question.blank ? 'blank' : question.is_correct ? 'correct' : 'wrong';
  const tone = { correct: 'green', wrong: 'red', blank: 'gray' }[status];
  const label = { correct: 'Acertou', wrong: 'Errou', blank: 'Em branco' }[status];
  return html`
    <article class="card sim-review-card" data-status="${status}">
      <div class="card-body">
        <header class="sim-review-head">
          <span class="question-number">Questão ${question.number}</span>
          ${badge(label, tone)}
          <span class="meta">
            <span>${question.subject_name}</span>
            <span>${question.topic_name}</span>
            ${question.difficulty ? html`<span>${difficultyLabel(question.difficulty)}</span>` : ''}
            ${question.year ? html`<span>${question.year}${question.board ? ` · ${question.board}` : ''}</span>` : ''}
          </span>
        </header>
        <div class="question-statement prose">${raw(md(question.statement))}</div>
        ${question.image_url ? html`<img class="question-image" src="${question.image_url}" alt="Imagem da questão ${question.number}" loading="lazy">` : ''}
        <ul class="question-options sim-review-options">
          ${(question.options || []).map((option) => optionRow(question, option))}
        </ul>
        ${question.resolution
          ? html`<div class="question-resolution">
              <h3 class="feedback-title">${icon('lightbulb', { size: 16 })} Resolução</h3>
              <div class="prose prose-sm">${raw(md(question.resolution))}</div>
            </div>`
          : ''}
        ${question.explanation
          ? html`<div class="sim-review-explanation">
              <h3 class="feedback-sub">Por que essa é a resposta</h3>
              <div class="prose prose-sm">${raw(md(question.explanation))}</div>
            </div>`
          : ''}
      </div>
    </article>`;
}

function reviewBlock() {
  const questions = attempt.questions || [];
  if (!questions.length) return '';
  const counts = {
    all: questions.length,
    wrong: questions.filter((q) => !q.is_correct && !q.blank).length,
    blank: questions.filter((q) => q.blank).length,
  };
  return html`
    <section class="sim-review" id="sim-review">
      <div class="sim-review-toolbar">
        <h2 class="section-title m-0">Revisão questão a questão</h2>
        <div class="pill-group" role="group" aria-label="Filtrar questões">
          <button type="button" class="pill ${filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">Todas (${counts.all})</button>
          <button type="button" class="pill ${filter === 'wrong' ? 'active' : ''}" data-action="filter" data-filter="wrong">Erradas (${counts.wrong})</button>
          <button type="button" class="pill ${filter === 'blank' ? 'active' : ''}" data-action="filter" data-filter="blank">Em branco (${counts.blank})</button>
        </div>
      </div>
      <div class="sim-review-list">
        ${questions.map(questionCard)}
      </div>
      <div class="sim-review-empty" hidden>
        ${emptyState({ icon: 'circle-check', title: 'Nada por aqui', text: 'Nenhuma questão neste filtro.' })}
      </div>
    </section>`;
}

function paint() {
  canvases.forEach((c) => destroyChart(c));
  canvases.length = 0;
  if (runner) {
    runner.destroy();
    runner = null;
  }

  const wrong = wrongQuestions();
  renderTo(
    page.el,
    html`
      ${pageHeader({
        title: attempt.title || 'Resultado do simulado',
        subtitle: `Finalizado em ${fmtDateTime(attempt.finished_at)} · ${pluralize((attempt.questions || []).length, 'questão', 'questões')}`,
        breadcrumb: [{ label: 'Simulados', href: '/app/simulados' }, { label: 'Resultado' }],
        actions: html`
          ${wrong.length ? html`<button type="button" class="btn btn-secondary" data-action="redo">${icon('refresh-cw')}<span>Refazer erros</span></button>` : ''}
          <a class="btn btn-primary" href="/app/simulados">${icon('plus')}<span>Novo simulado</span></a>`,
      })}
      ${heroBlock()}
      <div id="sim-redo"></div>
      ${subjectsBlock()}
      ${topicsBlock()}
      ${reviewBlock()}`
  );

  drawCharts();
  bind();
}

function drawCharts() {
  const donut = qs('#sim-donut', page.el);
  if (donut) {
    canvases.push(donut);
    doughnutChart(donut, {
      labels: ['Acertos', 'Erros', 'Em branco'],
      datasets: [
        {
          data: [attempt.correct_count || 0, attempt.wrong_count || 0, attempt.blank_count || 0],
          backgroundColor: [palette.success, palette.danger, palette.muted],
        },
      ],
      options: { plugins: { legend: { display: true } } },
    });
  }

  const subjects = qs('#sim-subjects', page.el);
  const rows = (attempt.breakdown && attempt.breakdown.by_subject) || [];
  if (subjects && rows.length) {
    canvases.push(subjects);
    barChart(subjects, {
      labels: rows.map((r) => r.name),
      datasets: [
        {
          label: 'Aproveitamento (%)',
          data: rows.map((r) => r.pct),
          backgroundColor: rows.map((r) => (r.pct >= 70 ? palette.success : r.pct >= 50 ? palette.warning : palette.danger)),
        },
      ],
      options: {
        indexAxis: 'y',
        scales: { x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } }, y: { grid: { display: false } } },
      },
    });
  }
}

function bind() {
  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    if (trigger.dataset.action === 'filter') applyFilter(trigger.dataset.filter);
    else if (trigger.dataset.action === 'redo') startRedo();
    else if (trigger.dataset.action === 'close-redo') closeRedo();
  });
}

function applyFilter(next) {
  filter = next || 'all';
  qsa('[data-action="filter"]', page.el).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  let visible = 0;
  qsa('.sim-review-card', page.el).forEach((card) => {
    const status = card.dataset.status;
    const show = filter === 'all' || (filter === 'wrong' && status === 'wrong') || (filter === 'blank' && status === 'blank');
    card.hidden = !show;
    if (show) visible += 1;
  });
  const empty = qs('.sim-review-empty', page.el);
  if (empty) empty.hidden = visible > 0;
}

// ---------------------------------------------------------------------
// Refazer erros — questões erradas e em branco em modo prática
// ---------------------------------------------------------------------
function startRedo() {
  const host = qs('#sim-redo', page.el);
  if (!host) return;
  const questions = wrongQuestions().map((q) => ({
    id: q.id,
    statement: q.statement,
    image_url: q.image_url,
    difficulty: q.difficulty,
    year: q.year,
    board: q.board,
    subject_name: q.subject_name,
    topic_name: q.topic_name,
    options: (q.options || []).map((o) => ({ id: o.id, letter: o.letter, text: o.text })),
  }));
  if (!questions.length) return;

  renderTo(
    host,
    html`
      <section class="card sim-redo mb-6">
        <div class="card-header">
          <h2 class="card-title">Refazendo os erros</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-action="close-redo">${icon('x')}<span>Fechar</span></button>
        </div>
        <div class="card-body"><div id="sim-redo-runner"></div></div>
      </section>`
  );

  if (runner) runner.destroy();
  runner = mountQuestionRunner(qs('#sim-redo-runner', page.el), {
    questions,
    mode: 'practice',
    immediateFeedback: true,
    answer: (questionId, optionId, meta) =>
      api.post(`/api/questions/${questionId}/answer`, {
        option_id: optionId,
        context: 'errors_redo',
        time_spent_sec: meta && meta.time_spent_sec ? meta.time_spent_sec : undefined,
      }),
    onFinish: (summary) => {
      toast(`Refazendo concluído: ${summary.correct} de ${summary.total} corretas.`, { type: summary.correct === summary.total ? 'success' : 'info' });
    },
  });
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeRedo() {
  if (runner) {
    runner.destroy();
    runner = null;
  }
  const host = qs('#sim-redo', page.el);
  if (host) renderTo(host, '');
}

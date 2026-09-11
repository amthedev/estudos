// =====================================================================
// Foco Elite — Revisões espaçadas (ARCHITECTURE §6.4 e §5)
//
// Seções: Atrasadas, Hoje, Próximos 7 dias, Mais adiante e Concluídas.
// "Revisar" abre o runner com as 5 questões de GET /api/reviews/:id/questions;
// cada resposta vai para POST /api/questions/:id/answer com context 'review' e
// context_id da revisão. Ao fim, POST /api/reviews/:id/complete { score }.
// Também há "Marcar como revisada" (complete sem nota) e "Pular".
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, render, toast, confirm, qs, on, setLoading,
  pageHeader, emptyState, errorState, skeleton, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtRelative, fmtPct, pluralize } from '../../core/format.js';
import { mountQuestionRunner } from '../../components/question-runner.js';

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/**
 * Rótulo e explicação de cada etapa.
 *
 * Os prazos vêm da API (`interval_days`), porque são configuráveis no painel:
 * o texto fixo em 1/7/30 mentia para o aluno assim que o professor mudasse o
 * ritmo. Todas as etapas contam a partir da aula, não da revisão anterior.
 */
function stageInfo(stage) {
  const label = `${stage}ª revisão`;
  const dias = state && Array.isArray(state.intervalDays) ? state.intervalDays[stage - 1] : null;
  if (!dias) return { label, hint: '' };
  return { label, hint: `${dias} ${dias === 1 ? 'dia' : 'dias'} depois da aula` };
}

const SECTIONS = [
  { id: 'overdue', title: 'Atrasadas', icon: 'triangle-alert', tone: 'red', empty: 'Nenhuma revisão atrasada. Muito bom.' },
  { id: 'today', title: 'Hoje', icon: 'calendar-check', tone: 'blue', empty: 'Nada para revisar hoje.' },
  { id: 'upcoming', title: 'Próximos 7 dias', icon: 'calendar-days', tone: 'gray', empty: 'Nenhuma revisão agendada para esta semana.' },
  { id: 'later', title: 'Mais adiante', icon: 'clock', tone: 'gray', empty: '' },
  { id: 'done', title: 'Concluídas', icon: 'circle-check', tone: 'green', empty: 'Suas revisões concluídas aparecem aqui.' },
];

let state = null;

const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);
const colorVar = (value) => {
  const color = safeColor(value);
  return color ? raw(` style="--rev-color:${color}"`) : '';
};

function stageBadge(stage) {
  return badge(stageInfo(stage).label, 'gray', { icon: 'refresh-cw' });
}

/** Agrupa as revisões nas seções da tela. */
function groupReviews(pending, done, today) {
  const groups = { overdue: [], today: [], upcoming: [], later: [], done: done || [] };
  const limit = addDaysISO(today, 7);
  for (const review of pending || []) {
    const due = review.due_date;
    if (due < today) groups.overdue.push(review);
    else if (due === today) groups.today.push(review);
    else if (due <= limit) groups.upcoming.push(review);
    else groups.later.push(review);
  }
  return groups;
}

/** Soma dias a uma data local 'YYYY-MM-DD'. */
function addDaysISO(iso, days) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------

function reviewRow(review, sectionId) {
  const info = stageInfo(review.stage);
  const isDone = sectionId === 'done';
  const overdue = sectionId === 'overdue';
  return html`
    <li class="rev-item ${isDone ? 'is-done' : ''}"${colorVar(review.subject_color)} data-review="${review.id}">
      <span class="rev-item-mark">${icon(isDone ? 'circle-check' : 'refresh-cw', { size: 18 })}</span>
      <div class="rev-item-main">
        <h3 class="rev-item-title">${review.topic_name}</h3>
        <p class="meta">
          ${review.subject_name ? html`<span>${review.subject_name}</span>` : ''}
          ${review.lesson_title ? html`<span>${icon('play', { size: 12 })}${review.lesson_title}</span>` : ''}
          ${info ? html`<span>${info.hint}</span>` : ''}
        </p>
        <p class="rev-item-date">
          ${isDone
            ? html`Revisada ${fmtRelative(review.completed_at)}${review.score !== null && review.score !== undefined ? html` · acertos ${fmtPct(review.score)}` : ''}`
            : html`${overdue ? 'Vencida em' : 'Prevista para'} ${fmtDate(review.due_date)} · ${fmtRelative(review.due_date)}`}
        </p>
      </div>
      <div class="rev-item-end">
        ${stageBadge(review.stage)}
        ${isDone
          ? ''
          : html`
            <button type="button" class="btn btn-primary btn-sm" data-action="start" data-id="${review.id}">
              ${icon('play')}<span>Revisar</span>
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="complete" data-id="${review.id}" title="Marcar como revisada">
              ${icon('check')}<span class="rev-btn-label">Marcar como revisada</span>
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="skip" data-id="${review.id}" title="Pular esta revisão">
              ${icon('skip-forward')}<span class="rev-btn-label">Pular</span>
            </button>`}
      </div>
    </li>`;
}

function sectionView(section, items) {
  if (!items.length && !section.empty) return '';
  return html`
    <section class="card rev-section" data-section="${section.id}">
      <div class="card-header">
        <h2 class="card-title">${icon(section.icon)}<span>${section.title}</span></h2>
        ${items.length ? badge(String(items.length), section.tone) : ''}
      </div>
      ${items.length
        ? html`<ul class="rev-list">${items.map((review) => reviewRow(review, section.id))}</ul>`
        : html`<div class="card-body"><p class="rev-empty">${section.empty}</p></div>`}
    </section>`;
}

function listView() {
  const { groups, counts } = state;
  const pendingTotal = groups.overdue.length + groups.today.length + groups.upcoming.length + groups.later.length;
  const subtitle = pendingTotal > 0
    ? `${pluralize(pendingTotal, 'revisão pendente', 'revisões pendentes')} · revisar no tempo certo é o que fixa o conteúdo.`
    : 'Nenhuma revisão pendente. Conclua aulas para agendar as próximas.';

  const hasAny = pendingTotal > 0 || groups.done.length > 0;

  return html`
    ${pageHeader({
      title: 'Revisões',
      subtitle,
      actions: html`
        <a class="btn btn-secondary" href="/app/cronograma">${icon('calendar-days')}<span>Ver no cronograma</span></a>`,
    })}
    ${counts
      ? html`
        <div class="rev-counts">
          <span class="rev-count ${counts.overdue ? 'is-alert' : ''}">${icon('triangle-alert', { size: 14 })}${counts.overdue} atrasadas</span>
          <span class="rev-count">${icon('calendar-check', { size: 14 })}${counts.today} hoje</span>
          <span class="rev-count">${icon('calendar-days', { size: 14 })}${counts.upcoming} nos próximos 7 dias</span>
          <span class="rev-count">${icon('circle-check', { size: 14 })}${counts.done} concluídas</span>
        </div>`
      : ''}
    ${hasAny
      ? html`<div class="rev-sections">${SECTIONS.map((section) => sectionView(section, groups[section.id] || []))}</div>`
      : emptyState({
          icon: 'refresh-cw',
          title: 'Você ainda não tem revisões',
          text: state && Array.isArray(state.intervalDays) && state.intervalDays.length
            ? `Ao concluir uma aula, o Foco de Elite agenda revisões em ${state.intervalDays.join(', ')} dias — é assim que o conteúdo fixa.`
            : 'Ao concluir uma aula, o Foco de Elite agenda revisões espaçadas — é assim que o conteúdo fixa.',
          action: { label: 'Ver aulas', href: '/app/aulas', icon: 'play' },
        })}`;
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------

async function completeReview(id, button, { score = null, silent = false } = {}) {
  setLoading(button, true);
  try {
    await api.post(`/api/reviews/${encodeURIComponent(id)}/complete`, score === null ? {} : { score });
    if (!silent) toast('Revisão concluída.', { type: 'success' });
    store.emit('schedule:updated', { review_id: id });
    return true;
  } catch (err) {
    setLoading(button, false);
    toast(err instanceof ApiError ? err.message : 'Não foi possível concluir a revisão.', { type: 'error' });
    return false;
  }
}

async function skipReview(ctx, id, button) {
  const ok = await confirm({
    title: 'Pular revisão',
    message: 'Esta revisão sai da sua lista e do cronograma. Você pode retomar o assunto pelas matérias quando quiser.',
    confirmText: 'Pular',
    icon: 'skip-forward',
  });
  if (!ok) return;
  setLoading(button, true);
  try {
    await api.post(`/api/reviews/${encodeURIComponent(id)}/skip`, {});
    toast('Revisão pulada.', { type: 'info' });
    store.emit('schedule:updated', { review_id: id });
    await load(ctx);
  } catch (err) {
    setLoading(button, false);
    toast(err instanceof ApiError ? err.message : 'Não foi possível pular a revisão.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Sessão de revisão (question-runner)
// ---------------------------------------------------------------------

function runnerHeader(review) {
  return html`
    <header class="rev-run-head">
      <button type="button" class="btn btn-ghost btn-sm" data-action="back">${icon('arrow-left')}<span>Voltar às revisões</span></button>
      <div class="rev-run-title">
        <h1>${review.topic_name}</h1>
        <p class="meta">
          ${review.subject_name ? html`<span>${review.subject_name}</span>` : ''}
          ${stageInfo(review.stage).hint
            ? html`<span>${stageInfo(review.stage).label} · ${stageInfo(review.stage).hint}</span>`
            : html`<span>${stageInfo(review.stage).label}</span>`}
        </p>
      </div>
    </header>`;
}

function finishView(ctx, review, summary) {
  const pct = summary.total > 0 ? Math.round((summary.correct / summary.total) * 100) : 0;
  const tone = pct >= 70 ? 'green' : pct >= 40 ? 'orange' : 'red';
  destroyRunner();
  render(
    ctx.el,
    html`
      <div class="rev-run">
        <div class="card rev-result">
          <div class="card-body">
            <span class="rev-result-icon">${icon('circle-check')}</span>
            <h1 class="rev-result-title">Revisão concluída</h1>
            <p class="rev-result-topic">${review.topic_name}</p>
            <div class="rev-result-score">${badge(`${summary.correct} de ${summary.total} acertos`, tone)}<strong>${fmtPct(pct)}</strong></div>
            <p class="rev-result-hint">
              ${pct >= 70
                ? 'Conteúdo consolidado. A próxima revisão já está agendada pelo método.'
                : 'Vale revisar a aula deste assunto antes da próxima etapa.'}
            </p>
            <div class="rev-result-actions">
              <button type="button" class="btn btn-primary" data-action="back">${icon('arrow-left')}<span>Voltar às revisões</span></button>
              ${review.lesson_id ? html`<a class="btn btn-secondary" href="/app/aulas/${review.lesson_id}">${icon('play')}<span>Rever a aula</span></a>` : ''}
            </div>
          </div>
        </div>
      </div>`
  );
}

async function startReview(ctx, review) {
  destroyRunner();
  render(ctx.el, skeleton('question'));
  let payload;
  try {
    payload = await api.get(`/api/reviews/${encodeURIComponent(review.id)}/questions`);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Não foi possível abrir a revisão.', { type: 'error' });
    await load(ctx);
    return;
  }
  if (!state) return;

  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const target = payload.review || review;

  if (!questions.length) {
    render(
      ctx.el,
      html`
        <div class="rev-run">
          ${runnerHeader(target)}
          <div class="card"><div class="card-body">
            ${emptyState({
              icon: 'file-text',
              title: 'Ainda não há questões deste assunto',
              text: 'Você pode marcar a revisão como feita depois de reler a aula e suas anotações.',
              action: { label: 'Marcar como revisada', dataAction: 'complete-empty', icon: 'check' },
            })}
          </div></div>
        </div>`
    );
    const button = qs('[data-action="complete-empty"]', ctx.el);
    if (button) {
      button.dataset.id = target.id;
      button.addEventListener('click', async () => {
        const ok = await completeReview(target.id, button);
        if (ok) await load(ctx);
      });
    }
    return;
  }

  render(ctx.el, html`<div class="rev-run">${runnerHeader(target)}<div data-runner></div></div>`);

  state.runner = mountQuestionRunner(qs('[data-runner]', ctx.el), {
    questions,
    mode: 'practice',
    immediateFeedback: true,
    showTimer: true,
    answer: (questionId, optionId, meta) =>
      api.post(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
        option_id: optionId,
        context: 'review',
        context_id: target.id,
        time_spent_sec: meta && Number.isFinite(Number(meta.time_spent_sec)) ? Number(meta.time_spent_sec) : null,
      }),
    onFinish: async (summary) => {
      const score = summary.total > 0 ? Math.round((summary.correct / summary.total) * 100) : null;
      const ok = await completeReview(target.id, null, { score, silent: true });
      if (!state) return;
      if (ok) finishView(ctx, target, summary);
    },
  });
}

// ---------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------

async function load(ctx) {
  const token = state.token;
  render(ctx.el, skeleton('page'));
  destroyRunner();
  try {
    const [pending, done] = await Promise.all([
      api.get('/api/reviews', { query: { status: 'pending', limit: 200 } }),
      api.get('/api/reviews', { query: { status: 'done', limit: 30 } }),
    ]);
    if (!state || state.token !== token) return;
    const today = pending.today || done.today;
    state.intervalDays = pending.interval_days || done.interval_days || null;
    state.counts = pending.counts || null;
    state.groups = groupReviews(pending.items || [], done.items || [], today);
    state.reviews = [...(pending.items || []), ...(done.items || [])];
    render(ctx.el, listView());
  } catch (err) {
    if (!state || state.token !== token) return;
    if (err instanceof ApiError && err.status === 404) {
      render(
        ctx.el,
        html`
          ${pageHeader({ title: 'Revisões', subtitle: 'Revisar no tempo certo é o que fixa o conteúdo.' })}
          ${emptyState({
            icon: 'hourglass',
            title: 'Revisões indisponíveis no momento',
            text: 'Não conseguimos carregar suas revisões agora. Tente novamente em instantes.',
            action: { label: 'Tentar novamente', dataAction: 'reload', icon: 'refresh-cw' },
          })}`
      );
      return;
    }
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Revisões', subtitle: 'Revisar no tempo certo é o que fixa o conteúdo.' })}
        ${errorState({
          title: 'Não foi possível carregar suas revisões',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
          retry: 'reload',
        })}`
    );
  }
}

function destroyRunner() {
  if (state && state.runner) {
    try {
      state.runner.destroy();
    } catch {
      /* runner já removido do DOM */
    }
    state.runner = null;
  }
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderReviews(ctx) {
  ctx.setTitle('Revisões');

  const token = Symbol('reviews');
  state = {
    token,
    groups: { overdue: [], today: [], upcoming: [], later: [], done: [] },
    counts: null,
    reviews: [],
    runner: null,
    off: [],
  };

  state.off.push(
    on(ctx.el, 'click', '[data-action]', async (event, button) => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (action === 'start') {
        event.preventDefault();
        const review = state.reviews.find((row) => String(row.id) === String(id));
        if (review) startReview(ctx, review);
      } else if (action === 'complete') {
        event.preventDefault();
        const ok = await completeReview(id, button);
        if (ok) await load(ctx);
      } else if (action === 'skip') {
        event.preventDefault();
        skipReview(ctx, id, button);
      } else if (action === 'back') {
        event.preventDefault();
        destroyRunner();
        load(ctx);
      } else if (action === 'reload') {
        event.preventDefault();
        load(ctx);
      }
    })
  );

  await load(ctx);
}

export function unmount() {
  if (!state) return;
  destroyRunner();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

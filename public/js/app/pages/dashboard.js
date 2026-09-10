// =====================================================================
// Foco Elite — Início do aluno (ARCHITECTURE §6.4 e §7.3)
//
// Toda a tela vem de GET /api/dashboard em uma única chamada:
// saudação, frase do dia, próxima atividade, plano de estudos, "Continue
// estudando", métricas, anéis por matéria, roteiro de hoje com check rápido,
// checklist, meta semanal, matérias difíceis e atalho para as revisões.
//
// O check rápido usa PATCH /api/schedule/items/:id { status } com atualização
// otimista: a interface muda na hora e volta ao estado anterior se a API falhar.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, render, toast, qs, qsa, on,
  pageHeader, emptyState, errorState, skeleton, progressBar, statCard, ring, badge,
} from '../../core/ui.js';
import { icon, activityIcon } from '../../core/icons.js';
import {
  firstName, fmtDateLong, fmtMinutes, fmtNumber, fmtPct, fmtScore, fmtHours,
  activityLabel, pluralize,
} from '../../core/format.js';

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Estado da renderização atual (zerado a cada entrada na página). */
let state = null;

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);

/** Estilo `--ring-color` só quando a matéria tem cor válida. */
function colorVar(name, value) {
  const color = safeColor(value);
  return color ? raw(` style="${name}:${color}"`) : '';
}

// ---------------------------------------------------------------------
// Blocos da tela
// ---------------------------------------------------------------------

function heroHeader(data) {
  const name = firstName((data.user && data.user.name) || (store.user && store.user.name) || '');
  const dateLabel = capitalize(fmtDateLong(data.greeting_date, { weekday: true }));
  const exam = data.exam;
  let examChip = '';
  if (exam) {
    const days = Number.isFinite(Number(exam.days_left)) ? Number(exam.days_left) : null;
    const daysLabel = days === null || days < 0
      ? ''
      : days === 0 ? 'é hoje' : days === 1 ? 'falta 1 dia' : `faltam ${fmtNumber(days, { digits: 0 })} dias`;
    examChip = html`
      <a class="chip chip-primary dash-exam-chip" href="/app/perfil" title="Prova escolhida no seu perfil">
        ${icon('graduation-cap')}
        <span>${exam.short_name || exam.name}</span>
        ${daysLabel ? html`<span class="chip-label">· ${daysLabel}</span>` : ''}
      </a>`;
  }
  return html`
    ${pageHeader({
      title: name ? `Olá, ${name}` : 'Olá',
      subtitle: dateLabel,
      actions: examChip,
    })}
    ${data.quote ? html`<p class="dash-quote">${icon('quote', { size: 14 })}<span>${data.quote}</span></p>` : ''}`;
}

function nextActivityCard(data) {
  const item = data.next_item;
  if (item) {
    const showTopic = item.topic_name && !String(item.title || '').includes(item.topic_name);
    const meta = [item.subject_name, showTopic ? item.topic_name : null].filter(Boolean);
    return html`
      <article class="card dash-next">
        <div class="dash-next-body">
          <div class="dash-next-tag">${badge(activityLabel(item.type), 'blue', { icon: activityIcon(item.type) })}</div>
          <h2 class="dash-next-title">${item.title}</h2>
          <p class="meta dash-next-meta">
            ${meta.map((text) => html`<span>${text}</span>`)}
            <span>${icon('clock', { size: 14 })}${fmtMinutes(item.duration_min)}</span>
            ${item.start_time ? html`<span>${icon('calendar-clock', { size: 14 })}${item.start_time}</span>` : ''}
          </p>
        </div>
        <div class="dash-next-action">
          <a class="btn btn-primary btn-lg" href="${item.href || '/app/cronograma'}">
            ${icon('play')}<span>Começar a estudar</span>
          </a>
          <a class="link-sm" href="/app/cronograma">Ver o cronograma completo</a>
        </div>
      </article>`;
  }

  const today = data.today || {};
  const hasItems = Array.isArray(today.items) && today.items.length > 0;
  let title = 'Nenhuma atividade programada para hoje';
  let text = 'Gere seu cronograma para receber um roteiro de estudos diário.';
  let action = { label: 'Montar cronograma', href: '/app/cronograma', icon: 'calendar-days' };
  if (hasItems) {
    title = 'Você concluiu tudo o que estava previsto para hoje';
    text = 'Aproveite para adiantar uma revisão ou resolver algumas questões.';
    action = { label: 'Resolver questões', href: '/app/questoes', icon: 'file-text' };
  } else if (today.is_study_day === false) {
    title = 'Hoje é dia de descanso no seu plano';
    text = 'Descansar faz parte do método. Se quiser adiantar algo, o banco de questões está liberado.';
    action = { label: 'Resolver questões', href: '/app/questoes', icon: 'file-text' };
  }
  return html`
    <article class="card dash-next dash-next-empty">
      ${emptyState({ icon: 'circle-check', title, text, action, size: 'sm' })}
    </article>`;
}

function planCard(data) {
  const pct = Number(data.plan_progress_pct) || 0;
  const stats = data.stats || {};
  return html`
    <section class="card dash-plan">
      <div class="card-body">
        <div class="dash-plan-head">
          <h2 class="card-title">${icon('target')}<span>Seu plano de estudos</span></h2>
          <strong class="dash-plan-value">${fmtPct(pct)}</strong>
        </div>
        ${progressBar(pct, { color: pct >= 100 ? 'success' : '', size: 'lg' })}
        <p class="dash-plan-hint">
          ${fmtNumber(stats.lessons_done ?? 0, { digits: 0 })} de ${fmtNumber(stats.lessons_total ?? 0, { digits: 0 })} aulas do seu conteúdo programático
        </p>
      </div>
    </section>`;
}

function continueCard(data) {
  const lesson = data.continue_lesson;
  if (!lesson) {
    return html`
      <section class="card dash-continue">
        <div class="card-header"><h2 class="card-title">${icon('play')}<span>Continue estudando</span></h2></div>
        <div class="card-body">
          ${emptyState({
            icon: 'play',
            title: 'Nenhuma aula em andamento',
            text: 'Comece uma aula e ela aparece aqui para você retomar de onde parou.',
            action: { label: 'Ver aulas', href: '/app/aulas', icon: 'library' },
            size: 'sm',
          })}
        </div>
      </section>`;
  }
  return html`
    <section class="card dash-continue">
      <div class="card-header"><h2 class="card-title">${icon('play')}<span>Continue estudando</span></h2></div>
      <div class="card-body dash-continue-body">
        <div class="dash-thumb"${colorVar('--dash-color', lesson.subject_color)}>
          ${lesson.thumbnail_url
            ? html`<img src="${lesson.thumbnail_url}" alt="" loading="lazy" width="160" height="90">`
            : html`<span class="dash-thumb-placeholder">${icon('play')}</span>`}
        </div>
        <div class="dash-continue-main">
          <p class="dash-continue-subject">${lesson.subject_name || 'Aula'}</p>
          <h3 class="dash-continue-title">${lesson.title}</h3>
          <p class="meta"><span>${icon('clock', { size: 14 })}${fmtMinutes(lesson.duration_min)}</span></p>
        </div>
        <a class="btn btn-secondary" href="${lesson.href || `/app/aulas/${lesson.id}`}">
          ${icon('play')}<span>Retomar</span>
        </a>
      </div>
    </section>`;
}

function statsGrid(data) {
  const stats = data.stats || {};
  const weekly = stats.weekly_goal || {};
  const cards = [
    statCard({
      label: 'Sequência de dias',
      value: fmtNumber(stats.streak_days ?? 0, { digits: 0 }),
      unit: Number(stats.streak_days) === 1 ? ' dia' : ' dias',
      hint: 'Dias seguidos estudando',
      icon: 'flame',
      tone: 'orange',
    }),
    statCard({
      label: 'Horas nesta semana',
      value: fmtHours(stats.hours_week ?? 0),
      hint: weekly.hours_goal ? `Meta de ${fmtHours(weekly.hours_goal)}` : 'Sem meta definida',
      icon: 'clock',
      tone: 'blue',
    }),
    statCard({
      label: 'Aulas concluídas',
      value: fmtNumber(stats.lessons_done ?? 0, { digits: 0 }),
      hint: stats.lessons_total ? `de ${fmtNumber(stats.lessons_total, { digits: 0 })} no plano` : '',
      icon: 'circle-check',
      tone: 'green',
      href: '/app/aulas',
    }),
    statCard({
      label: 'Questões respondidas',
      value: fmtNumber(stats.questions_answered ?? 0, { digits: 0 }),
      hint: 'Total no banco e nas práticas',
      icon: 'file-text',
      tone: 'blue',
      href: '/app/questoes',
    }),
    statCard({
      label: 'Taxa de acertos',
      value: fmtPct(stats.accuracy_pct),
      hint: 'Considerando todas as suas respostas',
      icon: 'target',
      tone: Number(stats.accuracy_pct) >= 60 ? 'green' : 'orange',
      href: '/app/desempenho',
    }),
    statCard({
      label: 'Redações',
      value: fmtNumber(stats.essays_count ?? 0, { digits: 0 }),
      hint: stats.essays_avg === null || stats.essays_avg === undefined
        ? 'Nenhuma nota registrada'
        : `Média ${fmtScore(stats.essays_avg)}`,
      icon: 'pen-line',
      tone: 'blue',
      href: '/app/redacao',
    }),
  ];
  return html`<div class="dash-stats">${cards}</div>`;
}

function ringsCard(data) {
  const rings = Array.isArray(data.subject_rings) ? data.subject_rings : [];
  return html`
    <section class="card dash-rings">
      <div class="card-header">
        <h2 class="card-title">${icon('chart-column')}<span>Seu progresso</span></h2>
        <a class="link-sm" href="/app/materias">Ver matérias</a>
      </div>
      <div class="card-body">
        ${rings.length
          ? html`<div class="dash-rings-grid">
              ${rings.map((subject) => html`
                <a class="dash-ring" href="/app/materias/${subject.id}"${colorVar('--ring-color', subject.color)} title="${subject.name}">
                  ${ring(subject.pct, { size: 'lg' })}
                  <span class="dash-ring-name">${subject.name}</span>
                  <span class="dash-ring-meta">${fmtNumber(subject.lessons_done, { digits: 0 })}/${fmtNumber(subject.lessons_total, { digits: 0 })} aulas</span>
                </a>`)}
            </div>`
          : emptyState({
              icon: 'library',
              title: 'Nenhuma matéria no seu plano ainda',
              text: 'Assim que seu cronograma for gerado, o progresso por matéria aparece aqui.',
              action: { label: 'Ver matérias', href: '/app/materias', icon: 'library' },
              size: 'sm',
            })}
      </div>
    </section>`;
}

function todayItemRow(item) {
  const done = item.status === 'done';
  const missed = item.status === 'missed';
  const meta = [item.subject_name, fmtMinutes(item.duration_min)].filter(Boolean);
  return html`
    <li class="dash-today-item ${done ? 'is-done' : ''} ${missed ? 'is-missed' : ''}" data-item="${item.id}"${colorVar('--dash-color', item.subject_color)}>
      <button type="button" class="dash-check" data-action="toggle" data-id="${item.id}"
        aria-pressed="${done ? 'true' : 'false'}"
        aria-label="${done ? 'Desmarcar' : 'Marcar como concluída'}: ${item.title}">
        ${icon('check', { size: 14 })}
      </button>
      <a class="dash-today-link" href="${item.href || '/app/cronograma'}">
        <span class="dash-today-icon">${icon(activityIcon(item.type), { size: 16 })}</span>
        <span class="dash-today-main">
          <span class="dash-today-title">${item.title}</span>
          <span class="meta">
            ${item.start_time ? html`<span>${item.start_time}</span>` : ''}
            ${meta.map((text) => html`<span>${text}</span>`)}
          </span>
        </span>
      </a>
    </li>`;
}

function todayCard(data) {
  const today = data.today || {};
  const items = Array.isArray(today.items) ? today.items : [];
  const total = Number(today.total_min) || 0;
  const done = Number(today.done_min) || 0;
  return html`
    <section class="card dash-today">
      <div class="card-header">
        <h2 class="card-title">${icon('calendar-days')}<span>Hoje</span></h2>
        <a class="link-sm" href="/app/cronograma">Abrir cronograma</a>
      </div>
      ${items.length
        ? html`
          <div class="card-body dash-today-body">
            <ul class="dash-today-list" data-today-list>${items.map(todayItemRow)}</ul>
          </div>
          <div class="card-footer dash-today-footer">
            <span class="dash-today-summary" data-today-summary>${fmtMinutes(done)} de ${fmtMinutes(total)} concluídos</span>
          </div>`
        : html`<div class="card-body">
            ${emptyState({
              icon: 'calendar-days',
              title: today.is_study_day === false ? 'Dia livre no seu plano' : 'Nada programado para hoje',
              text: today.is_study_day === false
                ? 'Seu cronograma reserva este dia para descanso.'
                : 'Recalcule o cronograma para receber as atividades do dia.',
              action: { label: 'Ir para o cronograma', href: '/app/cronograma', icon: 'calendar-days' },
              size: 'sm',
            })}
          </div>`}
    </section>`;
}

function checklistCard(data) {
  const checklist = data.checklist || {};
  const rows = [
    { key: 'lesson_done', label: 'Aula concluída', icon: 'play' },
    { key: 'questions_done', label: 'Questões resolvidas', icon: 'file-text' },
    { key: 'goal_reached', label: 'Meta do dia atingida', icon: 'target' },
  ];
  const doneCount = rows.filter((row) => checklist[row.key]).length;
  return html`
    <section class="card dash-checklist-card">
      <div class="card-header">
        <h2 class="card-title">${icon('list-checks')}<span>Checklist do dia</span></h2>
        <span class="text-xs text-3">${doneCount}/${rows.length}</span>
      </div>
      <div class="card-body">
        <ul class="dash-checklist">
          ${rows.map((row) => html`
            <li class="dash-checklist-item ${checklist[row.key] ? 'is-done' : ''}">
              <span class="dash-checklist-mark">${icon(checklist[row.key] ? 'check' : row.icon, { size: 14 })}</span>
              <span>${row.label}</span>
            </li>`)}
        </ul>
      </div>
    </section>`;
}

function weeklyGoalCard(data) {
  const weekly = (data.stats && data.stats.weekly_goal) || {};
  const pct = Number(weekly.pct) || 0;
  const goal = Number(weekly.hours_goal) || 0;
  const doneHours = Number(weekly.hours_done) || 0;
  return html`
    <section class="card dash-goal">
      <div class="card-header"><h2 class="card-title">${icon('trending-up')}<span>Meta semanal</span></h2></div>
      <div class="card-body">
        ${goal > 0
          ? html`
            ${progressBar(pct, { color: pct >= 100 ? 'success' : '', label: `${fmtHours(doneHours)} de ${fmtHours(goal)}` })}
            <p class="dash-goal-hint">
              ${pct >= 100
                ? 'Meta da semana batida. Siga o ritmo.'
                : `Faltam ${fmtHours(Math.max(0, goal - doneHours))} para fechar a semana.`}
            </p>`
          : html`<p class="dash-goal-hint">Defina seus dias e horas de estudo no perfil para acompanhar a meta semanal.</p>
            <a class="btn btn-secondary btn-sm mt-3" href="/app/perfil">${icon('settings')}<span>Ajustar disponibilidade</span></a>`}
      </div>
    </section>`;
}

function reviewsCard(data) {
  const count = Number(data.upcoming_reviews_count) || 0;
  return html`
    <a class="card card-hover dash-reviews" href="/app/revisoes">
      <span class="dash-reviews-icon">${icon('refresh-cw')}</span>
      <span class="dash-reviews-main">
        <strong class="dash-reviews-value">${count > 0 ? pluralize(count, 'revisão pendente', 'revisões pendentes') : 'Nenhuma revisão pendente'}</strong>
        <span class="dash-reviews-hint">${count > 0 ? 'Revisar no tempo certo é o que fixa o conteúdo.' : 'Conclua aulas para agendar novas revisões.'}</span>
      </span>
      ${icon('chevron-right')}
    </a>`;
}

function weakSubjectsCard(data) {
  const list = Array.isArray(data.weak_subjects) ? data.weak_subjects : [];
  return html`
    <section class="card dash-weak">
      <div class="card-header">
        <h2 class="card-title">${icon('triangle-alert')}<span>Maior dificuldade</span></h2>
        <a class="link-sm" href="/app/desempenho">Desempenho</a>
      </div>
      <div class="card-body">
        ${list.length
          ? html`<ul class="dash-weak-list">
              ${list.map((subject) => {
                const pct = Number(subject.accuracy_pct) || 0;
                return html`
                  <li class="dash-weak-item">
                    <a class="dash-weak-name" href="/app/materias/${subject.id}">
                      <span class="dash-dot"${colorVar('--dash-color', subject.color)}></span>
                      <span class="truncate">${subject.name}</span>
                      <strong>${fmtPct(pct)}</strong>
                    </a>
                    ${progressBar(pct, { color: pct < 40 ? 'danger' : 'warning', size: 'sm' })}
                  </li>`;
              })}
            </ul>`
          : html`<p class="dash-goal-hint">Resolva questões para descobrir onde você precisa de reforço.</p>
            <a class="btn btn-secondary btn-sm mt-3" href="/app/questoes">${icon('file-text')}<span>Resolver questões</span></a>`}
      </div>
    </section>`;
}

function view(data) {
  return html`
    ${heroHeader(data)}
    ${nextActivityCard(data)}
    ${planCard(data)}
    ${statsGrid(data)}
    <div class="grid grid-main dash-grid">
      <div class="dash-col">
        ${continueCard(data)}
        ${todayCard(data)}
        ${ringsCard(data)}
      </div>
      <div class="dash-col">
        ${checklistCard(data)}
        ${weeklyGoalCard(data)}
        ${reviewsCard(data)}
        ${weakSubjectsCard(data)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
// Interação: check rápido com atualização otimista
// ---------------------------------------------------------------------

/** Recalcula o rodapé "X de Y concluídos" a partir do estado local. */
function refreshTodaySummary(root) {
  const el = qs('[data-today-summary]', root);
  if (!el || !state) return;
  const items = state.data.today.items || [];
  const total = items.reduce((sum, item) => sum + (Number(item.duration_min) || 0), 0);
  const done = items
    .filter((item) => item.status === 'done')
    .reduce((sum, item) => sum + (Number(item.duration_min) || 0), 0);
  el.textContent = `${fmtMinutes(done)} de ${fmtMinutes(total)} concluídos`;
}

function paintItemStatus(root, item) {
  const row = qs(`.dash-today-item[data-item="${CSS.escape(String(item.id))}"]`, root);
  if (!row) return;
  const done = item.status === 'done';
  row.classList.toggle('is-done', done);
  row.classList.toggle('is-missed', item.status === 'missed');
  const button = qs('.dash-check', row);
  if (button) {
    button.setAttribute('aria-pressed', done ? 'true' : 'false');
    button.setAttribute('aria-label', `${done ? 'Desmarcar' : 'Marcar como concluída'}: ${item.title}`);
  }
}

async function toggleItem(root, id) {
  if (!state) return;
  const items = state.data.today.items || [];
  const item = items.find((row) => String(row.id) === String(id));
  if (!item || state.pending.has(id)) return;

  const previous = item.status;
  const next = previous === 'done' ? 'pending' : 'done';
  state.pending.add(id);
  item.status = next;
  paintItemStatus(root, item);
  refreshTodaySummary(root);

  try {
    const updated = await api.patch(`/api/schedule/items/${encodeURIComponent(id)}`, { status: next });
    if (!state) return;
    item.status = (updated && updated.status) || next;
    paintItemStatus(root, item);
    refreshTodaySummary(root);
    store.emit('schedule:updated', { item_id: id, status: item.status });
    if (item.status === 'done') toast('Atividade concluída.', { type: 'success' });
  } catch (err) {
    if (!state) return;
    item.status = previous;
    paintItemStatus(root, item);
    refreshTodaySummary(root);
    toast(err instanceof ApiError ? err.message : 'Não foi possível atualizar a atividade.', { type: 'error' });
  } finally {
    state.pending.delete(id);
  }
}

// ---------------------------------------------------------------------
// Estados de carregamento / erro
// ---------------------------------------------------------------------

function renderUnavailable(ctx) {
  render(
    ctx.el,
    html`
      ${pageHeader({ title: 'Início', subtitle: 'Seu painel de estudos' })}
      ${emptyState({
        icon: 'hourglass',
        title: 'Painel indisponível no momento',
        text: 'Não conseguimos montar o resumo dos seus estudos agora. Você pode seguir direto para o cronograma.',
        action: { label: 'Abrir cronograma', href: '/app/cronograma', icon: 'calendar-days' },
      })}`
  );
}

function renderError(ctx, err) {
  render(
    ctx.el,
    html`
      ${pageHeader({ title: 'Início', subtitle: 'Seu painel de estudos' })}
      ${errorState({
        title: 'Não foi possível carregar seu painel',
        message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        retry: 'reload-dashboard',
      })}`
  );
  const button = qs('[data-action="reload-dashboard"]', ctx.el);
  if (button) button.addEventListener('click', () => renderDashboard(ctx));
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

async function renderDashboard(ctx) {
  ctx.setTitle('Início');
  render(ctx.el, skeleton('page'));

  const token = Symbol('dashboard');
  state = { token, data: null, pending: new Set(), off: null };

  let data;
  try {
    data = await api.get('/api/dashboard');
  } catch (err) {
    if (!state || state.token !== token) return;
    if (err instanceof ApiError && err.status === 404) {
      renderUnavailable(ctx);
      return;
    }
    renderError(ctx, err);
    return;
  }
  if (!state || state.token !== token) return;

  data.today = data.today || { items: [], total_min: 0, done_min: 0 };
  data.today.items = Array.isArray(data.today.items) ? data.today.items : [];
  state.data = data;

  render(ctx.el, view(data));

  if (data.stats) store.setStats({ streak_days: data.stats.streak_days });

  state.off = on(ctx.el, 'click', '[data-action="toggle"]', (event, button) => {
    event.preventDefault();
    toggleItem(ctx.el, button.dataset.id);
  });
}

export default renderDashboard;

export function unmount() {
  if (state && typeof state.off === 'function') state.off();
  state = null;
}

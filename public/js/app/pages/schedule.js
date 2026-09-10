// =====================================================================
// Foco Elite — Meu Cronograma (ARCHITECTURE §6.4 e §5)
//
// Três visões: Hoje, Semana e Mês (as duas últimas com components/calendar.js).
// A lista do dia traz ícone por tipo, matéria colorida, duração e horário, com
// as ações concluir, reagendar, alterar horário, marcar como não realizada e
// excluir (somente itens criados pelo aluno).
//
// Ações de página: "Não consegui estudar hoje" (POST /api/schedule/skip-today),
// "Adicionar atividade" (POST /api/schedule/items) e "Recalcular cronograma"
// (POST /api/schedule/generate).
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, render, toast, modal, confirm, qs, qsa, on, dropdown,
  pageHeader, emptyState, errorState, skeleton, progressBar, badge, tabs,
} from '../../core/ui.js';
import { icon, activityIcon } from '../../core/icons.js';
import { fmtDateLong, fmtMinutes, fmtTime, activityLabel, pluralize } from '../../core/format.js';
import { mountCalendar, visibleRange, todayString } from '../../components/calendar.js';

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const WEEK_STARTS_ON = 1;

const VIEWS = [
  { id: 'today', label: 'Hoje', icon: 'calendar-check' },
  { id: 'week', label: 'Semana', icon: 'calendar-days' },
  { id: 'month', label: 'Mês', icon: 'calendar' },
];

/** Tipos que o aluno pode criar manualmente (os demais dependem de aula/assunto). */
const MANUAL_TYPES = ['custom', 'questions', 'essay', 'simulado'];

let state = null;

const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);
const colorVar = (value) => {
  const color = safeColor(value);
  return color ? raw(` style="--sch-color:${color}"`) : '';
};
const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

/** Intervalo visível conforme a visão atual. */
function currentRange() {
  if (state.view === 'today') return { from: state.date, to: state.date };
  return visibleRange(state.view, state.date, WEEK_STARTS_ON);
}

/** Dia selecionado (objeto normalizado), a partir dos dados carregados. */
function selectedDay() {
  const days = (state.data && state.data.days) || [];
  const found = days.find((day) => day.date === state.selected);
  return found || { date: state.selected, items: [], total_min: 0, done_min: 0, is_study_day: null };
}

function findItem(id) {
  const days = (state.data && state.data.days) || [];
  for (const day of days) {
    const item = (day.items || []).find((row) => String(row.id) === String(id));
    if (item) return item;
  }
  return null;
}

// ---------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------

/** Normaliza as duas respostas da API para { days: [...] }. */
async function fetchData() {
  if (state.view === 'today') {
    const today = await api.get('/api/schedule/today');
    return {
      days: [{
        date: today.date,
        items: Array.isArray(today.items) ? today.items : [],
        total_min: today.summary ? today.summary.total_min : 0,
        done_min: today.summary ? today.summary.done_min : 0,
        is_study_day: today.is_study_day,
      }],
      summary: today.summary || null,
      next_item: today.next_item || null,
      capacity_min: today.summary ? today.summary.capacity_min : 0,
    };
  }
  const { from, to } = currentRange();
  const range = await api.get('/api/schedule', { query: { from, to } });
  return {
    days: Array.isArray(range.days) ? range.days : [],
    summary: null,
    next_item: null,
    capacity_min: Number(range.capacity_min) || 0,
    study_days: range.study_days || [],
  };
}

async function load(ctx, { silent = false } = {}) {
  const token = state.token;
  const content = qs('[data-schedule-content]', ctx.el);
  if (content && !silent) render(content, skeleton('list', 5));
  try {
    const data = await fetchData();
    if (!state || state.token !== token) return;
    state.data = data;
    if (state.view === 'today') state.selected = data.days[0] ? data.days[0].date : todayString();
    else if (!data.days.some((day) => day.date === state.selected)) {
      const today = todayString();
      state.selected = data.days.some((day) => day.date === today) ? today : (data.days[0] ? data.days[0].date : today);
    }
    state.error = null;
  } catch (err) {
    if (!state || state.token !== token) return;
    state.error = err;
  }
  paintContent(ctx);
}

// ---------------------------------------------------------------------
// Ações sobre itens
// ---------------------------------------------------------------------

async function patchItem(ctx, id, changes, successMessage) {
  const updated = await api.patch(`/api/schedule/items/${encodeURIComponent(id)}`, changes);
  if (successMessage) toast(successMessage, { type: 'success' });
  store.emit('schedule:updated', { item_id: id });
  await load(ctx, { silent: true });
  return updated;
}

function rescheduleItem(ctx, item) {
  modal({
    title: 'Reagendar atividade',
    subtitle: item.title,
    size: 'sm',
    body: html`
      <div class="field">
        <label class="label" for="sch-new-date">Nova data</label>
        <input class="input" id="sch-new-date" type="date" value="${item.date}" min="${todayString()}">
        <p class="hint">A atividade vai para o fim da lista do dia escolhido.</p>
        <p class="error-text" data-error-for="date"></p>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Reagendar',
        variant: 'primary',
        onClick: async ({ modal: dialog }) => {
          const input = qs('#sch-new-date', dialog.body);
          const value = input ? input.value : '';
          if (!value) {
            const message = qs('[data-error-for="date"]', dialog.body);
            if (message) message.textContent = 'Escolha uma data.';
            return false;
          }
          await patchItem(ctx, item.id, { date: value }, 'Atividade reagendada.');
          return true;
        },
      },
    ],
  });
}

function changeTime(ctx, item) {
  modal({
    title: 'Definir horário',
    subtitle: item.title,
    size: 'sm',
    body: html`
      <div class="field">
        <label class="label" for="sch-time">Horário de início</label>
        <input class="input" id="sch-time" type="time" value="${item.start_time || ''}">
        <p class="hint">Deixe em branco para remover o horário.</p>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Salvar',
        variant: 'primary',
        onClick: async ({ modal: dialog }) => {
          const input = qs('#sch-time', dialog.body);
          const value = input && input.value ? input.value : null;
          await patchItem(ctx, item.id, { start_time: value }, value ? 'Horário atualizado.' : 'Horário removido.');
          return true;
        },
      },
    ],
  });
}

async function removeItem(ctx, item) {
  const ok = await confirm({
    title: 'Excluir atividade',
    message: `"${item.title}" será removida do seu cronograma.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/schedule/items/${encodeURIComponent(item.id)}`);
    toast('Atividade excluída.', { type: 'success' });
    store.emit('schedule:updated', { item_id: item.id });
    await load(ctx, { silent: true });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Não foi possível excluir a atividade.', { type: 'error' });
  }
}

/** Itens do menu "⋯" de cada atividade. */
function itemMenu(ctx, item) {
  const entries = [];
  if (item.status !== 'done') {
    entries.push({
      label: 'Marcar como concluída',
      icon: 'circle-check',
      onClick: () => patchItem(ctx, item.id, { status: 'done' }, 'Atividade concluída.').catch(reportError),
    });
  } else {
    entries.push({
      label: 'Desfazer conclusão',
      icon: 'rotate-ccw',
      onClick: () => patchItem(ctx, item.id, { status: 'pending' }, 'Atividade reaberta.').catch(reportError),
    });
  }
  entries.push({ label: 'Reagendar', icon: 'calendar-clock', onClick: () => rescheduleItem(ctx, item) });
  entries.push({ label: item.start_time ? 'Alterar horário' : 'Definir horário', icon: 'clock', onClick: () => changeTime(ctx, item) });
  if (item.status !== 'missed') {
    entries.push({
      label: 'Não realizada',
      icon: 'circle-x',
      onClick: () => patchItem(ctx, item.id, { status: 'missed' }, 'Marcada como não realizada.').catch(reportError),
    });
  }
  if (!item.generated) {
    entries.push({ divider: true });
    entries.push({ label: 'Excluir', icon: 'trash-2', danger: true, onClick: () => removeItem(ctx, item) });
  }
  return entries;
}

function reportError(err) {
  toast(err instanceof ApiError ? err.message : 'Não foi possível concluir a ação.', { type: 'error' });
}

// ---------------------------------------------------------------------
// Ações de página
// ---------------------------------------------------------------------

async function skipToday(ctx) {
  const ok = await confirm({
    title: 'Não consegui estudar hoje',
    message: 'As atividades pendentes de hoje serão redistribuídas nos seus próximos dias de estudo. Tudo bem?',
    confirmText: 'Redistribuir',
    icon: 'calendar-x',
  });
  if (!ok) return;
  try {
    const result = await api.post('/api/schedule/skip-today', {});
    const moved = Number(result && result.moved) || 0;
    toast(
      moved > 0
        ? `${pluralize(moved, 'atividade redistribuída', 'atividades redistribuídas')} para os próximos dias.`
        : 'Não havia atividades pendentes hoje.',
      { type: moved > 0 ? 'success' : 'info' }
    );
    store.emit('schedule:updated', { skipped: true });
    await load(ctx, { silent: true });
  } catch (err) {
    reportError(err);
  }
}

async function regenerate(ctx) {
  const ok = await confirm({
    title: 'Recalcular cronograma',
    message: 'Vamos montar novamente as próximas semanas a partir de hoje. As atividades já concluídas e as que você criou são preservadas.',
    confirmText: 'Recalcular',
    icon: 'refresh-cw',
  });
  if (!ok) return;
  try {
    const result = await api.post('/api/schedule/generate', {});
    const created = Number(result && result.created) || 0;
    toast(
      created > 0 ? `Cronograma atualizado com ${pluralize(created, 'atividade', 'atividades')}.` : 'Cronograma atualizado.',
      { type: 'success' }
    );
    store.emit('schedule:updated', { generated: true });
    await load(ctx, { silent: true });
  } catch (err) {
    reportError(err);
  }
}

/** Matérias do aluno para o item manual (silencioso: o campo some se falhar). */
async function loadSubjects() {
  if (state.subjects) return state.subjects;
  try {
    const list = await api.get('/api/subjects');
    state.subjects = Array.isArray(list) ? list : [];
  } catch {
    state.subjects = [];
  }
  return state.subjects;
}

async function addItem(ctx) {
  const subjects = await loadSubjects();
  if (!state) return;
  const date = state.selected || todayString();
  modal({
    title: 'Adicionar atividade',
    subtitle: 'Ela fica marcada como sua e não é apagada ao recalcular o cronograma.',
    body: html`
      <div class="sch-form">
        <div class="field">
          <label class="label" for="sch-title">Título</label>
          <input class="input" id="sch-title" type="text" maxlength="160" placeholder="Ex.: Revisar fórmulas de cinemática" autocomplete="off">
          <p class="error-text" data-error-for="title"></p>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="label" for="sch-date">Data</label>
            <input class="input" id="sch-date" type="date" value="${date}">
            <p class="error-text" data-error-for="date"></p>
          </div>
          <div class="field">
            <label class="label" for="sch-type">Tipo</label>
            <select class="select" id="sch-type">
              ${MANUAL_TYPES.map((type) => html`<option value="${type}">${activityLabel(type)}</option>`)}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="label" for="sch-duration">Duração (minutos)</label>
            <input class="input" id="sch-duration" type="number" min="5" max="600" step="5" value="30" inputmode="numeric">
            <p class="error-text" data-error-for="duration_min"></p>
          </div>
          <div class="field">
            <label class="label" for="sch-start">Horário (opcional)</label>
            <input class="input" id="sch-start" type="time">
          </div>
        </div>
        ${subjects.length
          ? html`
            <div class="field">
              <label class="label" for="sch-subject">Matéria (opcional)</label>
              <select class="select" id="sch-subject">
                <option value="">Sem matéria</option>
                ${subjects.map((subject) => html`<option value="${subject.id}">${subject.name}</option>`)}
              </select>
            </div>`
          : ''}
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Adicionar',
        variant: 'primary',
        onClick: async ({ modal: dialog }) => {
          const title = qs('#sch-title', dialog.body).value.trim();
          const itemDate = qs('#sch-date', dialog.body).value;
          const duration = Number(qs('#sch-duration', dialog.body).value);
          const type = qs('#sch-type', dialog.body).value;
          const start = qs('#sch-start', dialog.body).value;
          const subject = qs('#sch-subject', dialog.body);

          const setError = (name, message) => {
            const el = qs(`[data-error-for="${name}"]`, dialog.body);
            if (el) el.textContent = message;
          };
          setError('title', '');
          setError('date', '');
          setError('duration_min', '');
          if (title.length < 2) {
            setError('title', 'Informe um título.');
            return false;
          }
          if (!itemDate) {
            setError('date', 'Escolha uma data.');
            return false;
          }
          if (!Number.isFinite(duration) || duration < 5 || duration > 600) {
            setError('duration_min', 'Informe uma duração entre 5 e 600 minutos.');
            return false;
          }

          const body = { date: itemDate, title, type, duration_min: Math.round(duration) };
          if (start) body.start_time = start;
          if (subject && subject.value) body.subject_id = subject.value;
          await api.post('/api/schedule/items', body);
          toast('Atividade adicionada ao cronograma.', { type: 'success' });
          store.emit('schedule:updated', { created: true });
          state.selected = itemDate;
          if (state.view !== 'today') state.date = itemDate;
          await load(ctx, { silent: true });
          return true;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------
// Marcação
// ---------------------------------------------------------------------

function statusBadge(item) {
  if (item.status === 'done') return badge('Concluída', 'green', { icon: 'check' });
  if (item.status === 'missed') return badge('Não realizada', 'red');
  if (item.status === 'skipped') return badge('Adiada', 'gray');
  return '';
}

function itemRow(item) {
  const meta = [
    item.start_time ? fmtTime(item.start_time) : null,
    item.subject_name,
    fmtMinutes(item.duration_min),
    activityLabel(item.type),
  ].filter(Boolean);
  return html`
    <li class="sch-item ${item.status === 'done' ? 'is-done' : ''} ${item.status === 'missed' ? 'is-missed' : ''}"${colorVar(item.subject_color)}>
      <a class="sch-item-link" href="${item.href || '/app/cronograma'}">
        <span class="sch-item-icon">${icon(activityIcon(item.type), { size: 18 })}</span>
        <span class="sch-item-main">
          <span class="sch-item-title">${item.title}</span>
          <span class="meta">${meta.map((text) => html`<span>${text}</span>`)}</span>
          ${item.note ? html`<span class="sch-item-note">${item.note}</span>` : ''}
        </span>
      </a>
      <span class="sch-item-end">
        ${statusBadge(item)}
        ${item.generated ? '' : badge('Sua', 'blue')}
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-item-menu="${item.id}"
          aria-label="Ações de ${item.title}">${icon('ellipsis-vertical')}</button>
      </span>
    </li>`;
}

function daySummary(day) {
  const total = Number(day.total_min) || 0;
  const done = Number(day.done_min) || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const capacity = Number(state.data && state.data.capacity_min) || 0;
  return html`
    <div class="sch-summary">
      <div class="sch-summary-head">
        <div>
          <h2 class="sch-summary-title">${capitalize(fmtDateLong(day.date, { weekday: true, year: false }))}</h2>
          <p class="sch-summary-hint">
            ${total > 0
              ? `${fmtMinutes(done)} de ${fmtMinutes(total)} concluídos`
              : day.is_study_day === false ? 'Dia de descanso no seu plano' : 'Nenhuma atividade programada'}
            ${capacity > 0 && day.is_study_day !== false ? ` · capacidade de ${fmtMinutes(capacity)}` : ''}
          </p>
        </div>
        <strong class="sch-summary-pct">${pct}%</strong>
      </div>
      ${progressBar(pct, { color: pct >= 100 ? 'success' : '', size: 'sm' })}
    </div>`;
}

function dayView(day) {
  const items = Array.isArray(day.items) ? day.items : [];
  return html`
    <section class="card sch-day">
      <div class="card-body">${daySummary(day)}</div>
      ${items.length
        ? html`<ul class="sch-list" data-day-list>${items.map(itemRow)}</ul>`
        : html`<div class="card-body">
            ${emptyState({
              icon: day.is_study_day === false ? 'coffee' : 'calendar-plus',
              title: day.is_study_day === false ? 'Dia livre' : 'Sem atividades neste dia',
              text: day.is_study_day === false
                ? 'Seu plano reserva este dia para descanso. Você ainda pode adicionar algo, se quiser.'
                : 'Adicione uma atividade sua ou recalcule o cronograma.',
              action: { label: 'Adicionar atividade', dataAction: 'add-item', icon: 'plus' },
              size: 'sm',
            })}
          </div>`}
    </section>`;
}

/** Redesenha só a lista do dia selecionado (clique em um dia do calendário). */
function paintDay(ctx) {
  const holder = qs('[data-day-section]', ctx.el);
  if (!holder) return;
  destroyDropdowns();
  render(holder, dayView(selectedDay()));
  bindMenus(ctx, holder);
}

function paintContent(ctx) {
  const content = qs('[data-schedule-content]', ctx.el);
  if (!content) return;

  destroyDropdowns();
  destroyCalendar();

  if (state.error) {
    render(
      content,
      state.error instanceof ApiError && state.error.status === 404
        ? emptyState({
            icon: 'hourglass',
            title: 'Cronograma indisponível no momento',
            text: 'Não conseguimos carregar seu roteiro de estudos agora. Tente novamente em instantes.',
            action: { label: 'Tentar novamente', dataAction: 'reload-schedule', icon: 'refresh-cw' },
          })
        : errorState({
            title: 'Não foi possível carregar o cronograma',
            message: (state.error && state.error.message) || 'Verifique sua conexão e tente novamente.',
            retry: 'reload-schedule',
          })
    );
    return;
  }

  if (state.view === 'today') {
    render(content, html`<div data-day-section></div>`);
  } else {
    render(content, html`<div class="sch-calendar" data-calendar></div><div data-day-section></div>`);
    state.calendar = mountCalendar(qs('[data-calendar]', content), {
      view: state.view,
      date: state.date,
      days: (state.data && state.data.days) || [],
      weekStartsOn: WEEK_STARTS_ON,
      onItemClick: (item) => {
        if (item && item.href) ctx.navigate(item.href);
      },
      onDayClick: (date) => {
        state.selected = date;
        paintDay(ctx);
      },
      onViewChange: (view) => {
        state.view = view;
        if (state.viewTabs) state.viewTabs.set(view, { silent: true });
      },
      onNavigate: (from, to, info) => {
        state.date = info.date;
        state.selected = info.date;
        load(ctx);
      },
    });
  }

  paintDay(ctx);
}

function bindMenus(ctx, root) {
  qsa('[data-item-menu]', root).forEach((button) => {
    const item = findItem(button.dataset.itemMenu);
    if (!item) return;
    const menu = dropdown(button, itemMenu(ctx, item), { align: 'right' });
    if (menu) state.dropdowns.push(menu);
  });
}

function destroyDropdowns() {
  if (!state) return;
  state.dropdowns.forEach((menu) => {
    try {
      menu.destroy();
    } catch {
      /* menu já removido do DOM */
    }
  });
  state.dropdowns = [];
}

function destroyCalendar() {
  if (!state || !state.calendar) return;
  try {
    state.calendar.destroy();
  } catch {
    /* calendário já removido do DOM */
  }
  state.calendar = null;
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderSchedule(ctx) {
  ctx.setTitle('Meu Cronograma');

  const token = Symbol('schedule');
  state = {
    token,
    view: 'today',
    date: todayString(),
    selected: todayString(),
    data: null,
    error: null,
    subjects: null,
    calendar: null,
    viewTabs: null,
    dropdowns: [],
    off: [],
  };

  render(
    ctx.el,
    html`
      ${pageHeader({
        title: 'Meu Cronograma',
        subtitle: 'Seu roteiro de estudos, ajustado ao seu ritmo.',
        actions: html`
          <button type="button" class="btn btn-ghost" data-action="skip-today">${icon('calendar-x')}<span class="sch-action-label">Não consegui estudar hoje</span></button>
          <button type="button" class="btn btn-secondary" data-action="regenerate">${icon('refresh-cw')}<span class="sch-action-label">Recalcular</span></button>
          <button type="button" class="btn btn-primary" data-action="add-item">${icon('plus')}<span>Adicionar atividade</span></button>`,
      })}
      <div class="sch-tabs" data-schedule-tabs></div>
      <div class="sch-content" data-schedule-content>${skeleton('list', 5)}</div>`
  );

  state.viewTabs = tabs(
    qs('[data-schedule-tabs]', ctx.el),
    VIEWS,
    (id) => {
      if (id === state.view) return;
      state.view = id;
      if (id === 'today') {
        state.date = todayString();
        state.selected = state.date;
      }
      load(ctx);
    },
    { active: state.view, pills: true }
  );

  state.off.push(
    on(ctx.el, 'click', '[data-action]', (event, button) => {
      const action = button.dataset.action;
      if (action === 'skip-today') {
        event.preventDefault();
        skipToday(ctx);
      } else if (action === 'regenerate') {
        event.preventDefault();
        regenerate(ctx);
      } else if (action === 'add-item') {
        event.preventDefault();
        addItem(ctx);
      } else if (action === 'reload-schedule') {
        event.preventDefault();
        load(ctx);
      }
    })
  );

  await load(ctx);
}

export function unmount() {
  if (!state) return;
  destroyDropdowns();
  destroyCalendar();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

/**
 * Calendário do cronograma — visão semanal e mensal (ARCHITECTURE §6.3).
 *
 *   const cal = mountCalendar(el, {
 *     view: 'week' | 'month',
 *     date: 'YYYY-MM-DD',              // qualquer data dentro do período exibido (padrão: hoje)
 *     days: [{ date, items: [{ id, title, type, subject_name, subject_color, duration_min, status, start_time }], total_min, done_min }],
 *     weekStartsOn: 1,                 // 0 = domingo, 1 = segunda (padrão)
 *     onItemClick(item, day),
 *     onDayClick(date, day),
 *     onViewChange(view, { from, to }),
 *     onNavigate(from, to, { view, date }), // chamado sempre que o período visível muda (navegação ou troca de visão)
 *   });
 *   cal.update(days); cal.setView('month'); cal.setDate('2026-09-01'); cal.getRange(); cal.destroy();
 *
 * Datas são sempre strings locais `YYYY-MM-DD`; nunca passam por conversão UTC.
 * `setView`/`setDate` são silenciosos (não disparam callbacks); use `getRange()` para buscar os dados
 * do novo período. Os botões de navegação e as abas Semana/Mês disparam `onNavigate`/`onViewChange`.
 *
 * Marcação: classes canônicas de components.css (.calendar, .calendar-header, .calendar-week,
 * .calendar-col, .calendar-grid, .calendar-day, .calendar-item, .calendar-item-<tipo>, .calendar-dot)
 * com complementos de prefixo .cal- em pages/misc.css. Cada item recebe o ícone do tipo e, quando há
 * `subject_color`, a variável `--cal-color` (chip na cor da matéria).
 */
import { html, raw, render } from '../core/ui.js';
import { icon, activityIcon } from '../core/icons.js';
import { fmtMinutes, fmtTime, activityLabel, WEEKDAYS, WEEKDAYS_SHORT, MONTHS, MONTHS_SHORT } from '../core/format.js';

const join = (parts) => raw(parts.map((p) => String(p ?? '')).join(''));
const ic = (name, size = 16) => icon(name, { size });
const pad = (n) => String(n).padStart(2, '0');

export const TYPES = ['lesson', 'topic', 'questions', 'review', 'essay', 'simulado', 'custom', 'summary', 'past_exam', 'training', 'rest'];

export const TYPE_ICONS = Object.fromEntries(TYPES.map((type) => [type, activityIcon(type)]));

export const TYPE_LABELS = Object.fromEntries(TYPES.map((type) => [type, activityLabel(type)]));

const STATUS_LABELS = {
  pending: 'pendente',
  done: 'concluída',
  missed: 'não realizada',
  skipped: 'adiada',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i;

// ---------------------------------------------------------------------- datas locais
/** 'YYYY-MM-DD' (ou Date) → Date local à meia-noite. null se inválida. */
export function parseLocalDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const match = DATE_RE.exec(String(value ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(match[2]) - 1) return null;
  return date;
}

/** Date local → 'YYYY-MM-DD'. */
export function toDateString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayString() {
  return toDateString(new Date());
}

export function addDays(dateStr, amount) {
  const date = parseLocalDate(dateStr) || parseLocalDate(todayString());
  date.setDate(date.getDate() + amount);
  return toDateString(date);
}

export function addMonths(dateStr, amount) {
  const date = parseLocalDate(dateStr) || parseLocalDate(todayString());
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return toDateString(date);
}

export function startOfWeek(dateStr, weekStartsOn = 1) {
  const date = parseLocalDate(dateStr) || parseLocalDate(todayString());
  const diff = (date.getDay() - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - diff);
  return toDateString(date);
}

/** Período visível para a visão: semana completa ou grade do mês (semanas inteiras). */
export function visibleRange(view, dateStr, weekStartsOn = 1) {
  if (view === 'month') {
    const date = parseLocalDate(dateStr) || parseLocalDate(todayString());
    const first = toDateString(new Date(date.getFullYear(), date.getMonth(), 1));
    const last = toDateString(new Date(date.getFullYear(), date.getMonth() + 1, 0));
    const from = startOfWeek(first, weekStartsOn);
    const to = addDays(startOfWeek(last, weekStartsOn), 6);
    return { from, to };
  }
  const from = startOfWeek(dateStr, weekStartsOn);
  return { from, to: addDays(from, 6) };
}

function normalizeDate(value) {
  const date = parseLocalDate(value);
  return date ? toDateString(date) : null;
}

function safeColor(value) {
  const text = String(value ?? '').trim();
  return COLOR_RE.test(text) ? text : null;
}

function fmtMin(minutes) {
  return fmtMinutes(Math.max(0, Math.round(Number(minutes) || 0)));
}

function fmtHour(value) {
  return fmtTime(value, { fallback: '' });
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------- componente
export function mountCalendar(el, opts = {}) {
  if (!el) throw new Error('mountCalendar: elemento de destino obrigatório');

  const weekStartsOn = Number.isInteger(opts.weekStartsOn) ? ((opts.weekStartsOn % 7) + 7) % 7 : 1;
  const state = {
    view: opts.view === 'month' ? 'month' : 'week',
    date: normalizeDate(opts.date) || todayString(),
    days: new Map(),
  };
  let destroyed = false;

  function setDays(days) {
    state.days = new Map();
    const list = Array.isArray(days) ? days : (days && Array.isArray(days.days) ? days.days : []);
    for (const day of list) {
      const date = normalizeDate(day?.date);
      if (date) state.days.set(date, day);
    }
  }

  /** Dia normalizado (sempre devolve um objeto, mesmo sem dados). */
  function dayFor(dateStr) {
    const source = state.days.get(dateStr) || {};
    const items = Array.isArray(source.items) ? source.items.filter(Boolean) : [];
    const total = Number.isFinite(Number(source.total_min))
      ? Number(source.total_min)
      : items.reduce((sum, it) => sum + (Number(it.duration_min) || 0), 0);
    const done = Number.isFinite(Number(source.done_min))
      ? Number(source.done_min)
      : items.filter((it) => it.status === 'done').reduce((sum, it) => sum + (Number(it.duration_min) || 0), 0);
    return { ...source, date: dateStr, items, total_min: total, done_min: done };
  }

  const getRange = () => visibleRange(state.view, state.date, weekStartsOn);

  // ---------------------------------------------------------------- textos
  function titleText() {
    if (state.view === 'month') {
      const date = parseLocalDate(state.date);
      return `${capitalize(MONTHS[date.getMonth()])} de ${date.getFullYear()}`;
    }
    const { from, to } = getRange();
    const a = parseLocalDate(from);
    const b = parseLocalDate(to);
    if (a.getMonth() === b.getMonth()) {
      return `${a.getDate()} a ${b.getDate()} de ${MONTHS[a.getMonth()]} de ${a.getFullYear()}`;
    }
    if (a.getFullYear() === b.getFullYear()) {
      return `${a.getDate()} de ${MONTHS_SHORT[a.getMonth()]} a ${b.getDate()} de ${MONTHS_SHORT[b.getMonth()]} de ${a.getFullYear()}`;
    }
    return `${a.getDate()} de ${MONTHS_SHORT[a.getMonth()]} de ${a.getFullYear()} a ${b.getDate()} de ${MONTHS_SHORT[b.getMonth()]} de ${b.getFullYear()}`;
  }

  function dayLabel(dateStr) {
    const date = parseLocalDate(dateStr);
    return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} de ${MONTHS[date.getMonth()]}`;
  }

  // ---------------------------------------------------------------- views
  function headerView() {
    const isMonth = state.view === 'month';
    return html`
      <header class="calendar-header cal-header">
        <div class="calendar-nav cal-nav" role="group" aria-label="Navegação do calendário">
          <button type="button" class="btn btn-secondary btn-sm btn-icon" data-action="prev" aria-label="${isMonth ? 'Mês anterior' : 'Semana anterior'}">${ic('chevron-left')}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="today">Hoje</button>
          <button type="button" class="btn btn-secondary btn-sm btn-icon" data-action="next" aria-label="${isMonth ? 'Próximo mês' : 'Próxima semana'}">${ic('chevron-right')}</button>
        </div>
        <h3 class="calendar-title cal-title" aria-live="polite">${titleText()}</h3>
        <div class="tabs tabs-pills cal-views" role="tablist" aria-label="Modo de exibição">
          <button type="button" role="tab" class="tab${isMonth ? '' : ' active'}" aria-selected="${isMonth ? 'false' : 'true'}" data-action="view" data-view="week">Semana</button>
          <button type="button" role="tab" class="tab${isMonth ? ' active' : ''}" aria-selected="${isMonth ? 'true' : 'false'}" data-action="view" data-view="month">Mês</button>
        </div>
      </header>`;
  }

  function itemView(item, day, compact = false) {
    const type = TYPE_ICONS[item.type] ? item.type : 'custom';
    const status = STATUS_LABELS[item.status] ? item.status : 'pending';
    const color = safeColor(item.subject_color);
    const title = String(item.title || TYPE_LABELS[type]);
    const time = fmtHour(item.start_time);
    const meta = [
      item.subject_name,
      Number(item.duration_min) > 0 ? fmtMin(item.duration_min) : null,
    ].filter(Boolean);
    const classes = ['calendar-item', `calendar-item-${type}`, 'cal-item', `is-${status}`];
    if (status === 'done' || status === 'missed') classes.push(status);
    if (color) classes.push('has-color');
    if (compact) classes.push('cal-item-compact');
    const details = [time, ...meta].filter(Boolean);
    const typeLabel = TYPE_LABELS[type].toLowerCase();
    const titleLower = title.toLowerCase();
    const typePrefix = titleLower === typeLabel || titleLower.startsWith(`${typeLabel}:`) ? '' : `${TYPE_LABELS[type]}: `;
    const ariaLabel = `${typePrefix}${title}${details.length ? `, ${details.join(', ')}` : ''}, ${STATUS_LABELS[status]}`;
    let statusIcon = '';
    if (status === 'done') statusIcon = html`<span class="cal-item-status" aria-hidden="true">${ic('check', 12)}</span>`;
    else if (status === 'missed') statusIcon = html`<span class="cal-item-status" aria-hidden="true">${ic('x', 12)}</span>`;

    return html`
      <button type="button" class="${classes.join(' ')}" data-action="item" data-item-id="${item.id}" data-date="${day.date}"
        ${color ? raw(`style="--cal-color:${color}"`) : ''} title="${title} · ${STATUS_LABELS[status]}" aria-label="${ariaLabel}">
        ${ic(TYPE_ICONS[type], 12)}
        <span class="cal-item-body">
          ${time && !compact ? html`<span class="cal-item-time">${time}</span>` : ''}
          <span class="cal-item-title">${title}</span>
          ${!compact && meta.length ? html`<span class="cal-item-meta">${meta.join(' · ')}</span>` : ''}
        </span>
        ${statusIcon}
      </button>`;
  }

  function dayFooterView(day) {
    if (!(day.total_min > 0)) return html`<span class="cal-day-total is-free">Dia livre</span>`;
    const pct = Math.min(100, Math.round((day.done_min / day.total_min) * 100));
    return html`
      <div class="progress progress-sm cal-day-progress${pct >= 100 ? ' progress-success' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progresso do dia">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>
      <span class="cal-day-total">${fmtMin(day.done_min)} de ${fmtMin(day.total_min)}</span>`;
  }

  function weekView() {
    const { from } = getRange();
    const today = todayString();
    const columns = Array.from({ length: 7 }, (_, i) => {
      const dateStr = addDays(from, i);
      const day = dayFor(dateStr);
      const date = parseLocalDate(dateStr);
      const classes = ['calendar-col', 'cal-day'];
      if (dateStr === today) classes.push('is-today');
      if (dateStr < today) classes.push('is-past');
      if (!day.items.length) classes.push('is-empty');
      return html`
        <section class="${classes.join(' ')}" data-date="${dateStr}" aria-label="${dayLabel(dateStr)}">
          <button type="button" class="calendar-col-header cal-day-btn" data-action="day" data-date="${dateStr}" aria-label="${dayLabel(dateStr)}">
            <span class="wd">${WEEKDAYS_SHORT[date.getDay()]}</span>
            <span class="dn">${date.getDate()}</span>
            ${dateStr === today ? html`<span class="badge badge-blue cal-day-today">Hoje</span>` : ''}
          </button>
          <div class="calendar-day-items cal-day-items">
            ${day.items.length ? join(day.items.map((item) => itemView(item, day))) : html`<p class="cal-day-empty">Sem atividades</p>`}
          </div>
          <footer class="cal-day-footer">${dayFooterView(day)}</footer>
        </section>`;
    });
    return html`<div class="calendar-week cal-week">${join(columns)}</div>`;
  }

  function monthView() {
    const { from, to } = getRange();
    const today = todayString();
    const month = parseLocalDate(state.date).getMonth();
    const weekdays = Array.from({ length: 7 }, (_, i) => {
      const index = (weekStartsOn + i) % 7;
      return html`<div class="calendar-weekday" aria-hidden="true"><abbr title="${WEEKDAYS[index]}">${WEEKDAYS_SHORT[index]}</abbr></div>`;
    });

    const cells = [];
    for (let dateStr = from; dateStr <= to; dateStr = addDays(dateStr, 1)) {
      const day = dayFor(dateStr);
      const date = parseLocalDate(dateStr);
      const doneCount = day.items.filter((it) => it.status === 'done').length;
      const classes = ['calendar-day', 'cal-cell'];
      if (date.getMonth() !== month) classes.push('is-outside');
      if (dateStr === today) classes.push('is-today');
      if (dateStr < today) classes.push('is-past');
      if (day.items.length) classes.push('has-items');
      const summary = day.items.length
        ? `${plural(day.items.length, 'atividade', 'atividades')}${doneCount ? `, ${doneCount} ${doneCount === 1 ? 'concluída' : 'concluídas'}` : ''}`
        : 'sem atividades';
      cells.push(html`
        <div class="${classes.join(' ')}" role="button" tabindex="0" data-action="day" data-date="${dateStr}" aria-label="${dayLabel(dateStr)}, ${summary}">
          <div class="calendar-day-number">
            <span class="cal-cell-num">${date.getDate()}</span>
            ${day.total_min > 0 ? html`<span class="calendar-day-load cal-cell-total">${fmtMin(day.total_min)}</span>` : ''}
          </div>
          ${day.items.length ? html`
            <div class="calendar-dots cal-cell-dots" aria-hidden="true">
              ${join(day.items.slice(0, 6).map((it) => {
                const color = safeColor(it.subject_color);
                const status = STATUS_LABELS[it.status] ? it.status : 'pending';
                return html`<i class="calendar-dot cal-dot is-${status}${color ? ' has-color' : ''}" ${color ? raw(`style="--cal-color:${color}"`) : ''}></i>`;
              }))}
            </div>
            <div class="calendar-day-items cal-cell-items">
              ${join(day.items.slice(0, 3).map((it) => itemView(it, day, true)))}
              ${day.items.length > 3 ? html`<span class="calendar-more cal-cell-more">+${day.items.length - 3} ${day.items.length - 3 === 1 ? 'atividade' : 'atividades'}</span>` : ''}
            </div>` : ''}
        </div>`);
    }

    return html`
      <div class="cal-month">
        <div class="calendar-weekdays cal-month-weekdays">${join(weekdays)}</div>
        <div class="calendar-grid cal-month-grid">${join(cells)}</div>
      </div>`;
  }

  function view() {
    return html`
      <div class="calendar cal cal-view-${state.view}">
        ${headerView()}
        <div class="cal-body">${state.view === 'month' ? monthView() : weekView()}</div>
      </div>`;
  }

  function paint() {
    if (destroyed) return;
    render(el, view());
  }

  // ---------------------------------------------------------------- navegação
  function navigateTo(dateStr, view = state.view) {
    const before = getRange();
    state.date = dateStr;
    state.view = view;
    paint();
    const after = getRange();
    if ((before.from !== after.from || before.to !== after.to) && typeof opts.onNavigate === 'function') {
      opts.onNavigate(after.from, after.to, { view: state.view, date: state.date });
    }
  }

  function changeView(view) {
    if (view !== 'week' && view !== 'month') return;
    if (view === state.view) return;
    const previousRange = getRange();
    state.view = view;
    paint();
    const range = getRange();
    if (typeof opts.onViewChange === 'function') opts.onViewChange(view, range);
    if ((previousRange.from !== range.from || previousRange.to !== range.to) && typeof opts.onNavigate === 'function') {
      opts.onNavigate(range.from, range.to, { view: state.view, date: state.date });
    }
  }

  function triggerDay(dateStr) {
    if (!dateStr) return;
    if (typeof opts.onDayClick === 'function') opts.onDayClick(dateStr, dayFor(dateStr));
  }

  function triggerItem(itemId, dateStr) {
    const day = dayFor(dateStr);
    const item = day.items.find((it) => String(it.id) === String(itemId));
    if (item && typeof opts.onItemClick === 'function') opts.onItemClick(item, day);
  }

  // ---------------------------------------------------------------- eventos
  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !el.contains(target)) return;
    switch (target.dataset.action) {
      case 'prev':
        navigateTo(state.view === 'month' ? addMonths(state.date, -1) : addDays(state.date, -7));
        break;
      case 'next':
        navigateTo(state.view === 'month' ? addMonths(state.date, 1) : addDays(state.date, 7));
        break;
      case 'today':
        navigateTo(todayString());
        break;
      case 'view':
        changeView(target.dataset.view);
        break;
      case 'day':
        triggerDay(target.dataset.date);
        break;
      case 'item':
        event.stopPropagation();
        triggerItem(target.dataset.itemId, target.dataset.date);
        break;
      default:
        break;
    }
  }

  function onKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('[role="button"][data-action="day"]');
    if (!target || !el.contains(target) || event.target !== target) return;
    event.preventDefault();
    triggerDay(target.dataset.date);
  }

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKeydown);

  setDays(opts.days);
  paint();

  return {
    update(days) {
      setDays(days);
      paint();
    },
    setView(view) {
      if (view === 'week' || view === 'month') {
        state.view = view;
        paint();
      }
    },
    setDate(date) {
      const normalized = normalizeDate(date);
      if (normalized) {
        state.date = normalized;
        paint();
      }
    },
    getRange,
    getView: () => state.view,
    getDate: () => state.date,
    getState: () => ({ view: state.view, date: state.date, ...getRange() }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeydown);
      el.innerHTML = '';
    },
  };
}

export default mountCalendar;

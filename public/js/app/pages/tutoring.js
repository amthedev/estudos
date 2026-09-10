// =====================================================================
// /app/aulas-particulares — professores, horários livres, agendamento e
// acompanhamento das aulas marcadas.
// Consome GET /api/tutoring/teachers, /teachers/:id/slots, /bookings,
// POST /bookings e POST /bookings/:id/cancel.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, modal, confirm, pageHeader, emptyState, errorState, skeleton,
  badge, tabs, qs, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMoney, fmtMinutes, initials, statusLabel, weekdayName, pluralize } from '../../core/format.js';

const TIMEZONE = 'America/Sao_Paulo';
const RANGE_DAYS = 7;

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

let page = null;
let teachers = [];
let bookings = { upcoming: [], past: [] };
let subjectFilter = '';
let active = 'teachers';
let openTeacherId = null;
let slotsFrom = null;
let tabsApi = null;
let offClick = null;
let offChange = null;

export default async function renderPage(ctx) {
  page = ctx;
  active = ctx.query.aba === 'minhas' ? 'bookings' : 'teachers';
  subjectFilter = '';
  openTeacherId = null;
  slotsFrom = null;
  ctx.setTitle('Aulas Particulares');
  renderTo(ctx.el, skeleton('cards', 3));

  try {
    [teachers, bookings] = await Promise.all([api.get('/api/tutoring/teachers'), api.get('/api/tutoring/bookings')]);
  } catch (err) {
    if (err && err.status === 404) {
      renderTo(
        ctx.el,
        html`${header()}
          ${emptyState({
            icon: 'users',
            title: 'Aulas particulares indisponíveis',
            text: 'Este recurso não está ativo no momento. Fale com o suporte para saber mais.',
            action: { label: 'Voltar ao início', href: '/app', icon: 'arrow-left' },
          })}`
      );
      return;
    }
    renderTo(
      ctx.el,
      html`${header()}
        ${errorState({
          title: 'Não foi possível carregar as aulas particulares',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', ctx.el);
    if (btn) btn.addEventListener('click', () => renderPage(ctx));
    return;
  }

  paint();
}

export function unmount() {
  if (offClick) offClick();
  if (offChange) offChange();
  offClick = null;
  offChange = null;
  page = null;
  teachers = [];
  bookings = { upcoming: [], past: [] };
  tabsApi = null;
  openTeacherId = null;
  slotsFrom = null;
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Aulas Particulares',
    subtitle: 'Reserve um horário com um professor para destravar o que a videoaula não resolveu.',
  });
}

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

function addDaysISO(iso, amount) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount, 12));
  return date.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

const allSubjects = () => {
  const map = new Map();
  teachers.forEach((teacher) => {
    (teacher.subjects || []).forEach((subject) => {
      if (!map.has(subject.id)) map.set(subject.id, subject);
    });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
};

// ---------------------------------------------------------------------
// Professores
// ---------------------------------------------------------------------
function teacherCard(teacher) {
  const isOpen = openTeacherId === teacher.id;
  return html`
    <article class="card tu-teacher" data-teacher="${teacher.id}">
      <div class="card-body">
        <div class="tu-teacher-head">
          ${teacher.photo_url
            ? html`<img class="avatar avatar-lg avatar-square" src="${teacher.photo_url}" alt="Foto de ${teacher.name}" loading="lazy">`
            : html`<span class="avatar avatar-lg">${initials(teacher.name)}</span>`}
          <div class="tu-teacher-id">
            <h2 class="card-title">${teacher.name}</h2>
            <div class="tu-teacher-subjects">
              ${(teacher.subjects || []).map((subject) => badge(subject.name, 'gray'))}
            </div>
          </div>
          <div class="tu-teacher-price">
            <strong>${fmtMoney(teacher.slot_price_cents)}</strong>
            <span class="text-3 text-xs">por aula de ${fmtMinutes(teacher.slot_minutes)}</span>
          </div>
        </div>
        ${teacher.bio ? html`<p class="text-2 tu-teacher-bio clamp-3">${teacher.bio}</p>` : ''}
        <div class="tu-teacher-actions">
          <button type="button" class="btn ${isOpen ? 'btn-ghost' : 'btn-secondary'}" data-action="slots" data-id="${teacher.id}" aria-expanded="${isOpen ? 'true' : 'false'}">
            ${icon(isOpen ? 'chevron-up' : 'calendar-days')}<span>${isOpen ? 'Fechar horários' : 'Ver horários'}</span>
          </button>
        </div>
        <div class="tu-slots" id="tu-slots-${teacher.id}" ${isOpen ? '' : 'hidden'}></div>
      </div>
    </article>`;
}

function teachersHtml() {
  const subjects = allSubjects();
  const list = subjectFilter
    ? teachers.filter((teacher) => (teacher.subjects || []).some((subject) => subject.id === subjectFilter))
    : teachers;

  return html`
    ${subjects.length
      ? html`
          <div class="tu-filter mb-5">
            <label class="field m-0">
              <span class="label">Matéria</span>
              <select class="select" id="tu-subject">
                <option value="">Todas as matérias</option>
                ${subjects.map((subject) => html`<option value="${subject.id}" ${subject.id === subjectFilter ? 'selected' : ''}>${subject.name}</option>`)}
              </select>
            </label>
          </div>`
      : ''}
    ${list.length
      ? html`<div class="tu-teachers">${list.map(teacherCard)}</div>`
      : emptyState({
          icon: 'users',
          title: subjectFilter ? 'Nenhum professor para esta matéria' : 'Nenhum professor disponível',
          text: subjectFilter ? 'Escolha outra matéria para ver quem atende.' : 'Assim que novos professores forem cadastrados, eles aparecem aqui.',
        })}`;
}

async function toggleSlots(teacherId) {
  if (openTeacherId === teacherId) {
    openTeacherId = null;
    renderTo(qs('#tu-panel', page.el), teachersHtml());
    return;
  }
  openTeacherId = teacherId;
  slotsFrom = todayISO();
  renderTo(qs('#tu-panel', page.el), teachersHtml());
  await loadSlots(teacherId);
}

async function loadSlots(teacherId) {
  const host = qs(`#tu-slots-${teacherId}`, page.el);
  if (!host) return;
  renderTo(host, skeleton('block', 120));
  try {
    const from = slotsFrom || todayISO();
    const to = addDaysISO(from, RANGE_DAYS - 1);
    const data = await api.get(`/api/tutoring/teachers/${teacherId}/slots`, { query: { from, to } });
    renderTo(host, slotsHtml(data));
  } catch (err) {
    renderTo(host, errorState({ title: 'Não foi possível carregar os horários', message: err.message || '', retry: false }));
  }
}

function slotsHtml(data) {
  const total = (data.days || []).reduce((sum, day) => sum + day.slots.length, 0);
  const today = todayISO();
  return html`
    <div class="tu-slots-head">
      <span class="text-3 text-sm">${data.from === today ? 'Próximos 7 dias' : `${dayLabel(data.from)} a ${dayLabel(data.to)}`} · horário de Brasília</span>
      <div class="btn-group">
        <button type="button" class="btn btn-ghost btn-sm" data-action="slots-prev" data-id="${data.teacher.id}" ${data.from <= today ? 'disabled' : ''}>${icon('chevron-left')}<span class="sr-only">Semana anterior</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="slots-next" data-id="${data.teacher.id}">${icon('chevron-right')}<span class="sr-only">Próxima semana</span></button>
      </div>
    </div>
    ${total
      ? html`
          <div class="tu-days">
            ${(data.days || []).map(
              (day) => html`
                <div class="tu-day">
                  <div class="tu-day-head">
                    <span class="tu-day-weekday">${weekdayName(day.weekday, { short: true, capitalize: true })}</span>
                    <span class="tu-day-date">${dayLabel(day.date)}</span>
                  </div>
                  ${day.slots.length
                    ? html`<div class="tu-day-slots">
                        ${day.slots.map(
                          (slot) => html`
                            <button type="button" class="btn btn-secondary btn-sm tu-slot"
                              data-action="book" data-id="${data.teacher.id}" data-starts="${slot.starts_at}" data-time="${slot.time}" data-date="${day.date}">
                              ${slot.time}
                            </button>`
                        )}
                      </div>`
                    : html`<span class="tu-day-empty">—</span>`}
                </div>`
            )}
          </div>`
      : html`<p class="text-2 tu-slots-empty">Nenhum horário livre neste período. Veja a próxima semana.</p>`}`;
}

// ---------------------------------------------------------------------
// Agendamento
// ---------------------------------------------------------------------
function openBookingModal(teacherId, startsAt, dateISO, time) {
  const teacher = teachers.find((t) => t.id === teacherId);
  if (!teacher) return;
  const subjects = teacher.subjects || [];
  const weekday = new Date(`${dateISO}T12:00:00`).getDay();

  const dialog = modal({
    title: 'Confirmar aula particular',
    subtitle: `${teacher.name} · ${weekdayName(weekday, { capitalize: true })}, ${dayLabel(dateISO)} às ${time}`,
    body: html`
      <ul class="kv tu-confirm">
        <li><span>Professor</span><strong>${teacher.name}</strong></li>
        <li><span>Duração</span><strong>${fmtMinutes(teacher.slot_minutes)}</strong></li>
        <li><span>Valor</span><strong>${fmtMoney(teacher.slot_price_cents)}</strong></li>
      </ul>
      <div class="field">
        <label class="label" for="tu-subject-pick">Matéria</label>
        <select class="select" id="tu-subject-pick" name="subject_id">
          <option value="">A combinar com o professor</option>
          ${subjects.map((subject) => html`<option value="${subject.id}" ${subject.id === subjectFilter ? 'selected' : ''}>${subject.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="tu-notes">Observações (opcional)</label>
        <textarea class="textarea" id="tu-notes" name="notes" rows="3" maxlength="1000" placeholder="Conte o que você quer resolver na aula."></textarea>
      </div>
      <p class="hint">O professor confirma o horário e você recebe um aviso por e-mail. Cancelamentos até 12 horas antes.</p>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Agendar aula',
        variant: 'primary',
        icon: 'calendar-check',
        onClick: async () => {
          const payload = { teacher_id: teacherId, starts_at: startsAt };
          const subjectId = qs('[name="subject_id"]', dialog.body).value;
          if (subjectId) payload.subject_id = subjectId;
          const notes = qs('[name="notes"]', dialog.body).value.trim();
          if (notes) payload.notes = notes;
          try {
            await api.post('/api/tutoring/bookings', payload);
            bookings = await api.get('/api/tutoring/bookings');
            toast('Pedido enviado. Aguarde a confirmação do professor.', { type: 'success' });
            active = 'bookings';
            paint();
          } catch (err) {
            toast(err.message || 'Não foi possível agendar a aula.', { type: 'error' });
            return false;
          }
          return undefined;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------
// Minhas aulas
// ---------------------------------------------------------------------
const STATUS_TONES = { pending: 'orange', confirmed: 'green', cancelled: 'red', completed: 'blue', no_show: 'gray' };

function bookingRow(booking, { past = false } = {}) {
  return html`
    <li class="list-item tu-booking">
      <div class="list-item-main">
        <span class="list-item-title">${dateTimeFormat.format(new Date(booking.starts_at))}</span>
        <span class="list-item-meta">
          ${booking.teacher_name}
          ${booking.subject_name ? html` · ${booking.subject_name}` : ''}
          · ${fmtMinutes(booking.duration_min)}
          ${booking.price_cents ? html` · ${fmtMoney(booking.price_cents)}` : ''}
        </span>
        ${booking.student_notes ? html`<span class="list-item-meta text-3">“${booking.student_notes}”</span>` : ''}
        ${booking.cancel_reason ? html`<span class="list-item-meta text-3">Motivo: ${booking.cancel_reason}</span>` : ''}
      </div>
      <div class="list-item-end tu-booking-end">
        ${badge(statusLabel(booking.status), STATUS_TONES[booking.status] || 'gray')}
        ${!past && booking.status === 'confirmed' && booking.meeting_link
          ? html`<a class="btn btn-primary btn-sm" href="${booking.meeting_link}" target="_blank" rel="noopener external">${icon('video')}<span>Entrar</span></a>`
          : ''}
        ${!past && booking.can_cancel
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="cancel" data-id="${booking.id}">Cancelar</button>`
          : ''}
      </div>
    </li>`;
}

function bookingsHtml() {
  const upcoming = bookings.upcoming || [];
  const past = bookings.past || [];
  if (!upcoming.length && !past.length) {
    return emptyState({
      icon: 'calendar-days',
      title: 'Você ainda não agendou aulas',
      text: 'Escolha um professor, veja os horários livres e reserve o seu.',
      action: { label: 'Ver professores', dataAction: 'go-teachers', icon: 'users' },
    });
  }
  return html`
    <section class="card mb-6">
      <div class="card-header"><h2 class="card-title">Próximas aulas</h2></div>
      ${upcoming.length
        ? html`<ul class="list list-plain">${upcoming.map((booking) => bookingRow(booking))}</ul>`
        : html`<div class="card-body"><p class="text-2 m-0">Nenhuma aula marcada. Reserve um horário na aba Professores.</p></div>`}
    </section>
    ${past.length
      ? html`
          <section class="card">
            <div class="card-header"><h2 class="card-title">Histórico</h2><span class="text-3 text-sm">${pluralize(past.length, 'aula', 'aulas')}</span></div>
            <ul class="list list-plain">${past.map((booking) => bookingRow(booking, { past: true }))}</ul>
          </section>`
      : ''}`;
}

async function cancelBooking(id) {
  const ok = await confirm({
    title: 'Cancelar aula',
    message: 'A aula será cancelada e o horário volta a ficar livre para outros alunos. Deseja continuar?',
    danger: true,
    confirmText: 'Cancelar aula',
    cancelText: 'Voltar',
  });
  if (!ok) return;
  try {
    await api.post(`/api/tutoring/bookings/${id}/cancel`, {});
    bookings = await api.get('/api/tutoring/bookings');
    toast('Aula cancelada.', { type: 'success' });
    paint();
  } catch (err) {
    toast(err.message || 'Não foi possível cancelar a aula.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function panelHtml() {
  return active === 'teachers' ? teachersHtml() : bookingsHtml();
}

function paint() {
  renderTo(
    page.el,
    html`
      ${header()}
      <div id="tu-tabs" class="mb-5"></div>
      <div id="tu-panel">${panelHtml()}</div>`
  );

  tabsApi = tabs(
    qs('#tu-tabs', page.el),
    [
      { id: 'teachers', label: 'Professores', icon: 'users', count: teachers.length },
      { id: 'bookings', label: 'Minhas aulas', icon: 'calendar-days', count: (bookings.upcoming || []).length },
    ],
    (id) => {
      active = id;
      openTeacherId = null;
      renderTo(qs('#tu-panel', page.el), panelHtml());
    },
    { active }
  );

  bind();
}

function bind() {
  if (offChange) offChange();
  offChange = on(page.el, 'change', '#tu-subject', (event, select) => {
    subjectFilter = select.value;
    openTeacherId = null;
    renderTo(qs('#tu-panel', page.el), teachersHtml());
  });

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    const action = trigger.dataset.action;
    if (action === 'slots') toggleSlots(trigger.dataset.id);
    else if (action === 'book') openBookingModal(trigger.dataset.id, trigger.dataset.starts, trigger.dataset.date, trigger.dataset.time);
    else if (action === 'cancel') cancelBooking(trigger.dataset.id);
    else if (action === 'slots-prev') {
      slotsFrom = addDaysISO(slotsFrom || todayISO(), -RANGE_DAYS);
      if (slotsFrom < todayISO()) slotsFrom = todayISO();
      loadSlots(trigger.dataset.id);
    } else if (action === 'slots-next') {
      slotsFrom = addDaysISO(slotsFrom || todayISO(), RANGE_DAYS);
      loadSlots(trigger.dataset.id);
    } else if (action === 'go-teachers') {
      active = 'teachers';
      if (tabsApi) tabsApi.set('teachers', { silent: true });
      renderTo(qs('#tu-panel', page.el), panelHtml());
    }
  });
}

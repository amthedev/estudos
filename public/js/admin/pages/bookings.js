// =====================================================================
// Foco Elite — Painel administrativo: agendamentos (/admin/agendamentos)
//
// Tabela sobre GET /api/admin/bookings com filtros de situação, professor e
// período. As ações confirmam (pedindo o link da reunião), cancelam (pedindo
// o motivo) e marcam a aula como realizada — todas avisam o aluno por e-mail
// quando o SMTP está configurado.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, modal, qs, on,
  pageHeader, errorState, skeleton, badge, statCard,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMoney, fmtNumber, fmtDate, fmtTime, fmtRelative, fmtMinutes, weekdayName } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';

let state = null;

const STATUS = {
  pending: { label: 'Aguardando', tone: 'orange' },
  confirmed: { label: 'Confirmada', tone: 'green' },
  completed: { label: 'Realizada', tone: 'blue' },
  cancelled: { label: 'Cancelada', tone: 'gray' },
};

const num = (value) => fmtNumber(value ?? 0, { digits: 0 });
const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
function afterAction(result, fallback) {
  const email = result && result.email;
  if (email && email.error) toast(email.error, { type: 'warning' });
  toast(fallback, { type: 'success' });
  if (state.table) state.table.reload();
}

function confirmBooking(booking) {
  const dialog = modal({
    title: 'Confirmar aula',
    subtitle: `${booking.user_name} com ${booking.teacher_name}`,
    size: 'sm',
    body: html`
      <p class="text-2 mb-4">
        ${capitalize(weekdayName(new Date(booking.starts_at)))}, ${fmtDate(booking.starts_at)} às ${fmtTime(booking.starts_at)}
        · ${fmtMinutes(booking.duration_min || 0)}. O aluno recebe um e-mail com os dados da aula.
      </p>
      <div class="field">
        <label class="label" for="abook-link">Link da reunião</label>
        <input class="input" type="url" id="abook-link" placeholder="https://meet.google.com/…" value="${booking.meeting_link || ''}">
        <p class="hint">Se ficar em branco, usamos o link padrão do professor.</p>
      </div>
      <div class="field">
        <label class="label" for="abook-notes">Observações internas</label>
        <textarea class="textarea" id="abook-notes" rows="2" placeholder="Opcional">${booking.admin_notes || ''}</textarea>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Confirmar aula',
        variant: 'primary',
        icon: 'check',
        onClick: async () => {
          const link = qs('#abook-link', dialog.body).value.trim();
          const notes = qs('#abook-notes', dialog.body).value.trim();
          const result = await api.post(`/api/admin/bookings/${booking.id}/confirm`, {
            meeting_link: link || null,
            admin_notes: notes || null,
          });
          afterAction(result, 'Aula confirmada.');
          return true;
        },
      },
    ],
  });
}

function cancelBooking(booking) {
  const dialog = modal({
    title: 'Cancelar aula',
    subtitle: `${booking.user_name} com ${booking.teacher_name}`,
    size: 'sm',
    danger: true,
    body: html`
      <p class="text-2 mb-4">O aluno recebe um e-mail com o motivo e pode agendar outro horário.</p>
      <div class="field">
        <label class="label" for="abook-reason">Motivo do cancelamento</label>
        <textarea class="textarea" id="abook-reason" rows="3" maxlength="500" placeholder="Explique em poucas palavras."></textarea>
      </div>`,
    actions: [
      { label: 'Voltar', variant: 'ghost' },
      {
        label: 'Cancelar aula',
        variant: 'danger',
        icon: 'x',
        onClick: async () => {
          const reason = qs('#abook-reason', dialog.body).value.trim();
          if (reason.length < 3) {
            toast('Explique o motivo do cancelamento.', { type: 'warning' });
            return false;
          }
          const result = await api.post(`/api/admin/bookings/${booking.id}/cancel`, { reason });
          afterAction(result, 'Aula cancelada.');
          return true;
        },
      },
    ],
  });
}

function completeBooking(booking) {
  const dialog = modal({
    title: 'Marcar como realizada',
    subtitle: `${booking.user_name} com ${booking.teacher_name}`,
    size: 'sm',
    body: html`
      <p class="text-2 mb-4">Registre que a aula aconteceu. Isso não envia e-mail ao aluno.</p>
      <div class="field">
        <label class="label" for="abook-done-notes">Observações internas</label>
        <textarea class="textarea" id="abook-done-notes" rows="3" placeholder="Opcional">${booking.admin_notes || ''}</textarea>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Marcar como realizada',
        variant: 'primary',
        icon: 'circle-check',
        onClick: async () => {
          const notes = qs('#abook-done-notes', dialog.body).value.trim();
          const result = await api.post(`/api/admin/bookings/${booking.id}/complete`, { admin_notes: notes || null });
          afterAction(result, 'Aula marcada como realizada.');
          return true;
        },
      },
    ],
  });
}

function showDetail(booking) {
  const status = STATUS[booking.status] || { label: booking.status, tone: 'gray' };
  const rows = [
    { label: 'Aluno', value: `${booking.user_name} · ${booking.user_email}` },
    { label: 'Professor', value: booking.teacher_name },
    { label: 'Matéria', value: booking.subject_name || 'Não informada' },
    { label: 'Quando', value: `${fmtDate(booking.starts_at)} às ${fmtTime(booking.starts_at)} · ${fmtMinutes(booking.duration_min || 0)}` },
    { label: 'Valor', value: Number(booking.price_cents) > 0 ? fmtMoney(booking.price_cents) : 'A combinar' },
    { label: 'Link da reunião', value: booking.meeting_link || '—' },
    { label: 'Recado do aluno', value: booking.student_notes || '—' },
    { label: 'Observações internas', value: booking.admin_notes || '—' },
    { label: 'Motivo do cancelamento', value: booking.cancel_reason || '—' },
  ];
  modal({
    title: 'Detalhes do agendamento',
    subtitle: status.label,
    size: 'sm',
    body: html`<dl class="kv">${rows.map((row) => html`<dt>${row.label}</dt><dd>${row.value}</dd>`)}</dl>`,
    actions: [{ label: 'Fechar', variant: 'secondary' }],
  });
}

// ---------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------
function paintSummary(summary) {
  const el = qs('#abook-summary', state.el);
  if (!el || !summary) return;
  render(el, html`
    ${statCard({ label: 'Aguardando confirmação', value: num(summary.pending), icon: 'hourglass', tone: Number(summary.pending) ? 'orange' : 'gray' })}
    ${statCard({ label: 'Confirmadas', value: num(summary.confirmed), icon: 'calendar-check', tone: 'green' })}
    ${statCard({ label: 'Próximas aulas', value: num(summary.upcoming), icon: 'clock' })}
    ${statCard({ label: 'Realizadas', value: num(summary.completed), icon: 'circle-check', hint: `${num(summary.cancelled)} canceladas` })}`);
}

function mountBookingsTable() {
  const el = qs('#abook-table', state.el);
  if (!el) return;
  state.table = mountTable(el, {
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar por aluno ou professor',
    emptyText: 'Nenhum agendamento encontrado',
    sort: { key: 'starts_at', dir: 'desc' },
    filters: [
      { key: 'status', label: 'Situação', options: Object.entries(STATUS).map(([value, info]) => ({ value, label: info.label })) },
      { key: 'teacher_id', label: 'Professor', options: state.teachers.map((t) => ({ value: t.id, label: t.name })) },
      { key: 'from', label: 'A partir de', type: 'date' },
      { key: 'to', label: 'Até', type: 'date' },
    ],
    columns: [
      {
        key: 'user_name',
        label: 'Aluno',
        sortable: true,
        render: (row) => html`
          <a class="abook-user" href="/admin/alunos/${row.user_id}">
            <strong>${row.user_name}</strong>
            <span class="text-xs text-3">${row.user_email}</span>
          </a>`,
      },
      { key: 'teacher_name', label: 'Professor', sortable: true },
      {
        key: 'subject_name',
        label: 'Matéria',
        render: (row) => (row.subject_name ? row.subject_name : html`<span class="text-3">Não informada</span>`),
      },
      {
        key: 'starts_at',
        label: 'Data e hora',
        sortable: true,
        nowrap: true,
        render: (row) => html`
          <span class="abook-when">
            <strong>${fmtDate(row.starts_at)} · ${fmtTime(row.starts_at)}</strong>
            <span class="text-xs text-3">${capitalize(weekdayName(new Date(row.starts_at), { short: true }))} · ${fmtRelative(row.starts_at)}</span>
          </span>`,
      },
      {
        key: 'status',
        label: 'Situação',
        sortable: true,
        render: (row) => {
          const info = STATUS[row.status] || { label: row.status, tone: 'gray' };
          return badge(info.label, info.tone);
        },
      },
      {
        key: 'price_cents',
        label: 'Valor',
        align: 'right',
        nowrap: true,
        render: (row) => (Number(row.price_cents) > 0 ? fmtMoney(row.price_cents) : html`<span class="text-3">A combinar</span>`),
      },
    ],
    rowActions: [
      { label: 'Ver detalhes', icon: 'eye', onClick: (row) => showDetail(row) },
      {
        label: 'Confirmar',
        icon: 'check',
        onClick: (row) => confirmBooking(row),
        hidden: (row) => row.status === 'cancelled' || row.status === 'completed',
      },
      {
        label: 'Marcar como realizada',
        icon: 'circle-check',
        onClick: (row) => completeBooking(row),
        hidden: (row) => row.status === 'cancelled' || row.status === 'completed',
      },
      {
        label: 'Cancelar',
        icon: 'x',
        danger: true,
        onClick: (row) => cancelBooking(row),
        hidden: (row) => row.status === 'cancelled' || row.status === 'completed',
      },
    ],
    fetch: async (page, query) => {
      const response = await api.get('/api/admin/bookings', { query });
      paintSummary(response && response.summary);
      return response;
    },
  });
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Agendamentos',
    subtitle: 'Aulas particulares marcadas pelos alunos: confirme, cancele ou registre a realização.',
    actions: html`<a class="btn btn-secondary" href="/admin/professores">${icon('briefcase')}<span>Professores</span></a>`,
  });
}

async function load() {
  render(state.el, html`${header()}${skeleton('table')}`);
  try {
    const response = await api.get('/api/admin/teachers');
    state.teachers = Array.isArray(response) ? response : (response.items || []);
  } catch (err) {
    console.warn('[admin/agendamentos] não foi possível carregar os professores', err);
    state.teachers = [];
  }
  render(state.el, html`
    <div class="abook-page">
      ${header()}
      <section class="grid grid-4 abook-summary" id="abook-summary">${skeleton('stats', 4)}</section>
      <section class="card"><div class="card-body" id="abook-table"></div></section>
    </div>`);
  mountBookingsTable();
}

export default async function renderBookings(ctx) {
  state = { el: ctx.el, teachers: [], table: null };
  ctx.setTitle('Agendamentos');
  on(ctx.el, 'click', '[data-action="retry"]', () => load());
  try {
    await load();
  } catch (err) {
    render(ctx.el, html`${header()}${errorState({ title: 'Não foi possível carregar os agendamentos', message: err && err.message })}`);
  }
}

export function unmount() {
  if (state && state.table) state.table.destroy();
  state = null;
}

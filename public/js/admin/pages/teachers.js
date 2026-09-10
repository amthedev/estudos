// =====================================================================
// Foco Elite — Painel administrativo: professores (/admin/professores)
//
// Lista sobre GET /api/admin/teachers (busca, matéria e situação) com o
// cadastro completo em POST/PUT /api/admin/teachers, a disponibilidade
// semanal em PUT /api/admin/teachers/:id/availability e as ações de
// ativar, desativar e excluir.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, modal, confirm, qs, qsa, on,
  pageHeader, errorState, skeleton, badge, statCard,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMoney, fmtNumber, fmtMinutes, weekdayName, initials } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

let state = null;

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const num = (value) => fmtNumber(value ?? 0, { digits: 0 });
const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
const timeValue = (value) => String(value || '').slice(0, 5);

// ---------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------
function teacherFields() {
  return [
    { type: 'section', label: 'Dados do professor' },
    { key: 'name', label: 'Nome', type: 'text', required: true, minLength: 3, maxLength: 120 },
    { key: 'email', label: 'E-mail', type: 'email', maxLength: 160 },
    { key: 'phone', label: 'Telefone', type: 'tel', maxLength: 40, placeholder: '(11) 90000-0000' },
    { key: 'photo_url', label: 'Foto do professor', type: 'file', folder: 'geral', accept: 'image', width: 'full', placeholder: 'https://… ou envie a imagem' },
    { key: 'bio', label: 'Apresentação', type: 'textarea', rows: 4, maxLength: 4000, hint: 'Texto exibido ao aluno na hora de escolher o professor.' },
    { type: 'section', label: 'Aula particular' },
    { key: 'hourly_price', label: 'Preço por hora (R$)', type: 'number', min: 0, step: '0.01', placeholder: '0,00' },
    { key: 'slot_minutes', label: 'Duração da aula (minutos)', type: 'number', min: 15, max: 240, integer: true },
    { key: 'meeting_link', label: 'Link padrão da reunião', type: 'url', placeholder: 'https://meet.google.com/…', hint: 'Usado ao confirmar um agendamento quando nenhum outro link for informado.' },
    { key: 'subject_ids', label: 'Matérias', type: 'multiselect', options: state.subjects.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Adicionar matéria…' },
    { key: 'active', label: 'Professor ativo (aparece para os alunos)', type: 'switch' },
  ];
}

function teacherValues(teacher) {
  if (!teacher) {
    return { name: '', email: '', phone: '', photo_url: '', bio: '', hourly_price: null, slot_minutes: 60, meeting_link: '', subject_ids: [], active: true };
  }
  return {
    name: teacher.name || '',
    email: teacher.email || '',
    phone: teacher.phone || '',
    photo_url: teacher.photo_url || '',
    bio: teacher.bio || '',
    hourly_price: (Number(teacher.hourly_price_cents) || 0) / 100,
    slot_minutes: Number(teacher.slot_minutes) || 60,
    meeting_link: teacher.meeting_link || '',
    subject_ids: Array.isArray(teacher.subject_ids) ? teacher.subject_ids : [],
    active: teacher.active !== false,
  };
}

function teacherPayload(values) {
  const text = (value) => {
    const out = String(value || '').trim();
    return out === '' ? null : out;
  };
  return {
    name: values.name,
    email: text(values.email),
    phone: text(values.phone),
    photo_url: text(values.photo_url),
    bio: text(values.bio),
    hourly_price_cents: Math.round((Number(values.hourly_price) || 0) * 100),
    slot_minutes: Number(values.slot_minutes) || 60,
    meeting_link: text(values.meeting_link),
    subject_ids: Array.isArray(values.subject_ids) ? values.subject_ids : [],
    active: Boolean(values.active),
  };
}

function openTeacherForm(teacher) {
  const dialog = modal({
    title: teacher ? 'Editar professor' : 'Novo professor',
    subtitle: teacher ? teacher.name : 'Cadastre quem dará as aulas particulares.',
    size: 'lg',
    actions: [],
  });
  buildForm(dialog.body, teacherFields(), {
    values: teacherValues(teacher),
    submitLabel: teacher ? 'Salvar professor' : 'Cadastrar professor',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    onSubmit: async (values) => {
      const payload = teacherPayload(values);
      if (teacher) {
        await api.put(`/api/admin/teachers/${teacher.id}`, payload);
        toast('Professor atualizado.', { type: 'success' });
      } else {
        const created = await api.post('/api/admin/teachers', payload);
        toast('Professor cadastrado. Defina a disponibilidade semanal para liberar os horários.', { type: 'success' });
        dialog.close();
        reload();
        if (created && created.id) openAvailability(created);
        return;
      }
      dialog.close();
      reload();
    },
  });
}

// ---------------------------------------------------------------------
// Disponibilidade semanal
// ---------------------------------------------------------------------
function availabilityRow(window_ = { weekday: 1, start_time: '08:00', end_time: '12:00' }) {
  return html`
    <div class="atea-window" data-window>
      <select class="select" data-field="weekday" aria-label="Dia da semana">
        ${WEEKDAYS.map((day) => html`<option value="${day}" ${Number(window_.weekday) === day ? 'selected' : ''}>${capitalize(weekdayName(day))}</option>`)}
      </select>
      <input class="input" type="time" data-field="start_time" value="${timeValue(window_.start_time)}" aria-label="Horário inicial">
      <span class="atea-window-sep" aria-hidden="true">até</span>
      <input class="input" type="time" data-field="end_time" value="${timeValue(window_.end_time)}" aria-label="Horário final">
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove-window aria-label="Remover janela">${icon('trash-2')}</button>
    </div>`;
}

function readAvailability(root) {
  return qsa('[data-window]', root).map((row) => ({
    weekday: Number(qs('[data-field="weekday"]', row).value),
    start_time: qs('[data-field="start_time"]', row).value,
    end_time: qs('[data-field="end_time"]', row).value,
  }));
}

async function openAvailability(teacher) {
  let detail = teacher;
  try {
    detail = await api.get(`/api/admin/teachers/${teacher.id}`);
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível carregar o professor.', { type: 'error' });
    return;
  }
  const windows = Array.isArray(detail.availability) ? detail.availability : [];
  const dialog = modal({
    title: 'Disponibilidade semanal',
    subtitle: detail.name,
    size: 'lg',
    body: html`
      <p class="text-2 mb-4">
        Informe as janelas em que o professor atende. Os horários oferecidos ao aluno saem daqui,
        divididos em aulas de ${fmtMinutes(detail.slot_minutes || 60)} e descontando o que já está agendado.
      </p>
      <div class="atea-windows" id="atea-windows">${windows.length ? windows.map(availabilityRow) : ''}</div>
      <button type="button" class="btn btn-secondary btn-sm mt-3" id="atea-add-window">${icon('plus')}<span>Adicionar janela</span></button>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Salvar horários',
        variant: 'primary',
        icon: 'save',
        onClick: async () => {
          const list = readAvailability(dialog.body);
          const invalid = list.find((row) => !row.start_time || !row.end_time || row.end_time <= row.start_time);
          if (invalid) {
            toast('Cada janela precisa de um horário final depois do inicial.', { type: 'warning' });
            return false;
          }
          await api.put(`/api/admin/teachers/${detail.id}/availability`, { availability: list });
          toast('Disponibilidade salva.', { type: 'success' });
          reload();
          return true;
        },
      },
    ],
  });

  const list = qs('#atea-windows', dialog.body);
  qs('#atea-add-window', dialog.body).addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', String(availabilityRow()));
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-window]');
    if (button) button.closest('[data-window]').remove();
  });
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
async function toggleActive(teacher) {
  const path = teacher.active ? 'deactivate' : 'activate';
  try {
    await api.post(`/api/admin/teachers/${teacher.id}/${path}`, {});
    toast(teacher.active ? 'Professor desativado.' : 'Professor ativado.', { type: 'success' });
    reload();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível atualizar o professor.', { type: 'error' });
  }
}

async function removeTeacher(teacher) {
  const ok = await confirm({
    title: 'Excluir professor',
    message: `"${teacher.name}" será removido da lista de aulas particulares. Professores com aulas agendadas não podem ser excluídos — nesse caso, desative-o.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/teachers/${teacher.id}`);
    toast('Professor excluído.', { type: 'success' });
    reload();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível excluir o professor.', { type: 'error' });
  }
}

function reload() {
  if (state && state.table) state.table.reload();
  if (state) loadSummary();
}

// ---------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------
function mountTeachersTable() {
  const el = qs('#atea-table', state.el);
  if (!el) return;
  state.table = mountTable(el, {
    pageSize: 50,
    search: true,
    searchPlaceholder: 'Buscar por nome ou e-mail',
    emptyText: 'Nenhum professor cadastrado',
    filters: [
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }] },
      { key: 'subject_id', label: 'Matéria', options: state.subjects.map((s) => ({ value: s.id, label: s.name })) },
    ],
    columns: [
      {
        key: 'name',
        label: 'Professor',
        render: (row) => html`
          <span class="atea-person">
            ${row.photo_url
              ? html`<img class="avatar avatar-sm" src="${row.photo_url}" alt="" loading="lazy" width="32" height="32">`
              : html`<span class="avatar avatar-sm" aria-hidden="true">${initials(row.name)}</span>`}
            <span class="atea-person-main">
              <strong>${row.name}</strong>
              <span class="text-xs text-3">${row.email || 'Sem e-mail'}${row.phone ? ` · ${row.phone}` : ''}</span>
            </span>
          </span>`,
      },
      {
        key: 'subjects',
        label: 'Matérias',
        render: (row) => {
          const list = Array.isArray(row.subjects) ? row.subjects : [];
          if (!list.length) return html`<span class="text-3">Nenhuma</span>`;
          return html`<span class="chip-group atea-subjects">${list.slice(0, 3).map((s) => html`<span class="chip chip-sm">${s.name}</span>`)}${list.length > 3 ? html`<span class="chip chip-sm">+${list.length - 3}</span>` : ''}</span>`;
        },
      },
      {
        key: 'hourly_price_cents',
        label: 'Valor',
        nowrap: true,
        render: (row) => html`
          <span class="atea-price">
            <strong>${Number(row.hourly_price_cents) > 0 ? fmtMoney(row.hourly_price_cents) : 'A combinar'}</strong>
            <span class="text-xs text-3">aula de ${fmtMinutes(row.slot_minutes || 60)}</span>
          </span>`,
      },
      {
        key: 'availability_count',
        label: 'Horários',
        align: 'center',
        render: (row) => (Number(row.availability_count) > 0
          ? html`<span>${num(row.availability_count)} ${Number(row.availability_count) === 1 ? 'janela' : 'janelas'}</span>`
          : badge('Sem horários', 'orange')),
      },
      {
        key: 'bookings_upcoming',
        label: 'Aulas',
        align: 'center',
        render: (row) => html`<span title="${num(row.bookings_total)} no histórico">${num(row.bookings_upcoming)} agendadas</span>`,
      },
      { key: 'active', label: 'Situação', render: (row) => (row.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')) },
    ],
    rowActions: [
      { label: 'Editar', icon: 'square-pen', onClick: (row) => openTeacherForm(row) },
      { label: 'Disponibilidade', icon: 'calendar-clock', onClick: (row) => openAvailability(row) },
      { label: 'Ativar ou desativar', icon: 'toggle-left', onClick: (row) => toggleActive(row) },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: (row) => removeTeacher(row) },
    ],
    fetch: async (page, query) => {
      const response = await api.get('/api/admin/teachers', { query: { q: query.q, status: query.status, subject_id: query.subject_id } });
      const items = Array.isArray(response) ? response : (response.items || []);
      return { items, total: items.length };
    },
  });
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------
function header() {
  return pageHeader({
    title: 'Professores',
    subtitle: 'Quem atende as aulas particulares, com matérias, valores e disponibilidade.',
    actions: html`
      <a class="btn btn-secondary" href="/admin/agendamentos">${icon('calendar-check')}<span>Agendamentos</span></a>
      <button type="button" class="btn btn-primary" data-action="new-teacher">${icon('plus')}<span>Novo professor</span></button>`,
  });
}

async function loadSummary() {
  const el = state && qs('#atea-summary', state.el);
  if (!el) return;
  try {
    const response = await api.get('/api/admin/teachers');
    const items = Array.isArray(response) ? response : (response.items || []);
    const active = items.filter((t) => t.active).length;
    const withoutHours = items.filter((t) => !Number(t.availability_count)).length;
    const upcoming = items.reduce((total, t) => total + (Number(t.bookings_upcoming) || 0), 0);
    render(el, html`
      ${statCard({ label: 'Professores', value: num(items.length), icon: 'briefcase' })}
      ${statCard({ label: 'Ativos', value: num(active), icon: 'user-check', tone: 'green' })}
      ${statCard({ label: 'Sem disponibilidade', value: num(withoutHours), icon: 'calendar-x', tone: withoutHours ? 'orange' : 'gray' })}
      ${statCard({ label: 'Aulas agendadas', value: num(upcoming), icon: 'calendar-check', href: '/admin/agendamentos' })}`);
  } catch {
    render(el, html``);
  }
}

async function load() {
  render(state.el, html`${header()}${skeleton('table')}`);
  try {
    const subjects = await api.get('/api/admin/content/subjects', { query: { active: 'true' } });
    state.subjects = Array.isArray(subjects) ? subjects : (subjects.items || []);
  } catch (err) {
    console.warn('[admin/professores] não foi possível carregar as matérias', err);
    state.subjects = [];
  }
  render(state.el, html`
    <div class="atea-page">
      ${header()}
      <section class="grid grid-4 atea-summary" id="atea-summary">${skeleton('stats', 4)}</section>
      <section class="card"><div class="card-body" id="atea-table"></div></section>
    </div>`);
  mountTeachersTable();
  loadSummary();
}

export default async function renderTeachers(ctx) {
  state = { el: ctx.el, subjects: [], table: null };
  ctx.setTitle('Professores');
  on(ctx.el, 'click', '[data-action]', (event, target) => {
    const action = target.dataset.action;
    if (action === 'new-teacher') openTeacherForm(null);
    else if (action === 'retry') load();
  });
  try {
    await load();
  } catch (err) {
    render(ctx.el, html`${header()}${errorState({ title: 'Não foi possível carregar os professores', message: err && err.message })}`);
  }
}

export function unmount() {
  if (state && state.table) state.table.destroy();
  state = null;
}

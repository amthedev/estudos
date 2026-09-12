// =====================================================================
// Foco Elite — Admin › Simulados (ARCHITECTURE §6.5)
//
// Tabela e formulário dos modelos de simulado. Sem questões fixas, o simulado
// sorteia as questões na hora a partir do tipo e dos filtros escolhidos.
//
// API: GET|POST /api/admin/simulados, PUT|DELETE /api/admin/simulados/:id
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, confirm, modal, qs, on,
  pageHeader, skeleton, errorState, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, fmtNumber } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

const TYPES = [
  { value: 'exam', label: 'Prova completa', hint: 'Sorteia questões de todas as matérias da prova escolhida.' },
  { value: 'subject', label: 'Por matéria', hint: 'Sorteia questões de uma matéria.' },
  { value: 'topic', label: 'Por assunto', hint: 'Sorteia questões de um assunto.' },
  { value: 'custom', label: 'Personalizado', hint: 'Combina os filtros que você definir.' },
];

const REQUIRED_BY_TYPE = { exam: 'exam_id', subject: 'subject_id', topic: 'topic_id', custom: null };

const typeLabel = (value) => (TYPES.find((type) => type.value === value) || {}).label || value;

let state = null;

function referenceCell(row) {
  const parts = [row.exam_short_name || row.exam_name, row.subject_name, row.topic_name].filter(Boolean);
  if (!parts.length) return html`<span class="dt-muted">Todas as matérias</span>`;
  return html`<span class="sm-ref">${parts.map((part) => html`<span>${part}</span>`)}</span>`;
}

function questionsCell(row) {
  const fixed = Number(row.fixed_questions_count) || 0;
  return html`
    <span class="sm-questions">
      <strong>${fmtNumber(row.question_count || 0, { digits: 0 })}</strong>
      <span class="hint">${fixed ? `${fmtNumber(fixed, { digits: 0 })} fixas` : 'sorteadas'}</span>
    </span>`;
}

/** Mostra apenas o campo de referência exigido pelo tipo escolhido. */
function applyTypeVisibility(form, type) {
  const map = { exam_id: ['exam', 'custom'], subject_id: ['subject', 'topic', 'custom'], topic_id: ['topic', 'custom'] };
  Object.entries(map).forEach(([key, types]) => {
    const wrapper = qs(`[data-field="${key}"]`, form.el);
    if (wrapper) wrapper.hidden = !types.includes(type);
  });
}

async function loadTopicOptions(form, subjectId) {
  const select = qs('[data-key="topic_id"]', form.el);
  if (!select) return;
  const current = select.value;
  select.disabled = true;
  if (!subjectId) {
    render(select, html`<option value="">Selecione a matéria primeiro</option>`);
    select.disabled = true;
    return;
  }
  render(select, html`<option value="">Carregando…</option>`);
  let topics = [];
  try {
    topics = await api.get('/api/admin/content/topics', { query: { subject_id: subjectId } });
  } catch {
    topics = [];
  }
  render(
    select,
    html`
      <option value="">Selecione o assunto</option>
      ${topics.map((topic) => html`<option value="${topic.id}">${topic.name}</option>`)}`
  );
  select.disabled = false;
  if (topics.some((topic) => topic.id === current)) select.value = current;
}

function formFields() {
  return [
    { key: 'name', label: 'Nome do simulado', type: 'text', required: true, width: 'two-thirds', maxLength: 160, placeholder: 'Ex.: Simulado ENEM — Ciências da Natureza' },
    { key: 'type', label: 'Tipo', type: 'select', required: true, width: 'third', options: TYPES.map((type) => ({ value: type.value, label: type.label })) },
    { key: 'description', label: 'Descrição', type: 'textarea', rows: 2, maxLength: 2000, placeholder: 'O que este simulado cobra e para quem serve.' },
    { key: 'exam_id', label: 'Prova', type: 'select', width: 'half', options: state.exams.map((exam) => ({ value: exam.id, label: exam.name })) },
    { key: 'subject_id', label: 'Matéria', type: 'select', width: 'half', options: state.subjects.map((subject) => ({ value: subject.id, label: subject.name })) },
    { key: 'topic_id', label: 'Assunto', type: 'select', width: 'half', options: [] },
    { key: 'duration_min', label: 'Duração (minutos)', type: 'number', width: 'half', min: 5, max: state.max.duration_min, step: 5, default: 60 },
    { key: 'question_count', label: 'Número de questões', type: 'number', width: 'half', min: 1, max: state.max.question_count, step: 1, default: 20 },
    { key: 'active', label: 'Disponível para os alunos', type: 'switch', default: true },
  ];
}

function openForm(row) {
  const editing = Boolean(row);
  const body = document.createElement('div');
  let form = null;

  const dialog = modal({
    title: editing ? 'Editar simulado' : 'Novo simulado',
    subtitle: editing ? row.name : 'Modelos aparecem para o aluno na tela de Simulados.',
    size: 'lg',
    body,
    actions: [],
    onClose: () => {
      if (form) form.destroy();
    },
  });

  form = buildForm(body, formFields(), {
    values: editing
      ? {
        name: row.name,
        type: row.type,
        description: row.description,
        exam_id: row.exam_id,
        subject_id: row.subject_id,
        topic_id: row.topic_id,
        duration_min: row.duration_min,
        question_count: row.question_count,
        active: row.active,
      }
      : { type: 'exam', duration_min: 60, question_count: 20, active: true },
    submitLabel: editing ? 'Salvar alterações' : 'Criar simulado',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    autofocus: true,
    onChange(values, changedKey) {
      if (changedKey === 'type') applyTypeVisibility(form, values.type);
      if (changedKey === 'subject_id') loadTopicOptions(form, values.subject_id);
    },
    async onSubmit(values) {
      const payload = { ...values };
      const required = REQUIRED_BY_TYPE[payload.type];
      if (required && !payload[required]) {
        const labels = { exam_id: 'a prova', subject_id: 'a matéria', topic_id: 'o assunto' };
        form.setErrors([{ path: required, message: `Escolha ${labels[required]} deste tipo de simulado.` }]);
        return;
      }
      if (payload.type === 'exam') {
        payload.subject_id = null;
        payload.topic_id = null;
      } else if (payload.type === 'subject') {
        payload.topic_id = null;
      }
      if (editing) await api.put(`/api/admin/simulados/${row.id}`, payload);
      else await api.post('/api/admin/simulados', payload);
      toast(editing ? 'Simulado salvo.' : 'Simulado criado.', { type: 'success' });
      dialog.close();
      if (state.table) state.table.reload();
    },
  });

  applyTypeVisibility(form, editing ? row.type : 'exam');
  if (editing && row.subject_id) {
    loadTopicOptions(form, row.subject_id).then(() => {
      const select = qs('[data-key="topic_id"]', form.el);
      if (select && row.topic_id) select.value = row.topic_id;
    });
  } else {
    const select = qs('[data-key="topic_id"]', form.el);
    if (select) {
      render(select, html`<option value="">Selecione a matéria primeiro</option>`);
      select.disabled = true;
    }
  }
}

async function toggleActive(row, table) {
  try {
    await api.put(`/api/admin/simulados/${row.id}`, { active: !row.active });
    toast(row.active ? 'Simulado desativado.' : 'Simulado ativado.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação.', { type: 'error' });
  }
}

async function removeSimulado(row, table) {
  const ok = await confirm({
    title: 'Excluir simulado',
    message: `"${row.name}" será excluído. As tentativas já feitas pelos alunos continuam no histórico deles.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/simulados/${row.id}`);
    toast('Simulado excluído.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir o simulado.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Simulados',
      subtitle: 'Modelos prontos que o aluno inicia com um clique, além dos simulados que ele monta sozinho.',
      actions: html`<button type="button" class="btn btn-primary" data-act="new">${icon('plus')}<span>Novo simulado</span></button>`,
    })}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

async function renderSimuladosPage(ctx) {
  ctx.setTitle('Simulados');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-simulados');
  // Os tetos vêm da API: o formulário não pode declarar um limite que o
  // servidor recusa. Os valores abaixo só valem se a resposta não trouxer.
  state = { ctx, token, table: null, exams: [], subjects: [], off: [], max: { question_count: 90, duration_min: 330 } };

  try {
    const [exams, subjects, simulados] = await Promise.all([
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
      api.get('/api/admin/content/subjects'),
      api.get('/api/admin/simulados', { query: { limit: 1 } }).catch(() => null),
    ]);
    if (!state || state.token !== token) return;
    state.exams = exams;
    state.subjects = subjects;
    if (simulados && simulados.max) state.max = { ...state.max, ...simulados.max };
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Simulados' })}
        ${errorState({ title: 'Não foi possível carregar os simulados', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-simulados' })}`
    );
    const button = qs('[data-action="reload-simulados"]', ctx.el);
    if (button) button.addEventListener('click', () => renderSimuladosPage(ctx));
    return;
  }

  render(ctx.el, view());

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'name', label: 'Simulado', sortable: true, render: (row) => html`<div class="sm-name"><span class="sm-name-main">${row.name}</span>${row.description ? html`<span class="sm-name-sub">${row.description}</span>` : ''}</div>` },
      { key: 'type', label: 'Tipo', sortable: true, nowrap: true, render: (row) => badge(typeLabel(row.type), 'blue') },
      { key: 'exam_name', label: 'Referência', render: referenceCell },
      { key: 'duration_min', label: 'Duração', sortable: true, align: 'right', nowrap: true, render: (row) => fmtMinutes(row.duration_min) },
      { key: 'question_count', label: 'Questões', sortable: true, align: 'right', nowrap: true, render: questionsCell },
      { key: 'attempts_count', label: 'Tentativas', align: 'right', nowrap: true, render: (row) => fmtNumber(row.attempts_count || 0, { digits: 0 }) },
      { key: 'active', label: 'Situação', nowrap: true, render: (row) => (row.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')) },
    ],
    fetch: (page, query) => api.get('/api/admin/simulados', { query }),
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar pelo nome do simulado',
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhum modelo de simulado cadastrado',
    rowKey: 'id',
    filters: [
      { key: 'type', label: 'Tipo', options: TYPES.map((type) => ({ value: type.value, label: type.label })) },
      { key: 'exam_id', label: 'Prova', options: state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      { key: 'subject_id', label: 'Matéria', options: state.subjects.map((subject) => ({ value: subject.id, label: subject.name })) },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }] },
    ],
    onRowClick: (row) => openForm(row),
    rowActions: [
      { label: 'Editar simulado', icon: 'square-pen', onClick: (row) => openForm(row) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir simulado', icon: 'trash-2', danger: true, onClick: (row, table) => removeSimulado(row, table) },
    ],
  });

  state.off.push(
    on(ctx.el, 'click', '[data-act="new"]', (event) => {
      event.preventDefault();
      openForm(null);
    })
  );
}

export default renderSimuladosPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

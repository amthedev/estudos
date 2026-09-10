// =====================================================================
// Foco Elite — Admin › Vestibulares (ARCHITECTURE §6.5)
//
// Tabela dos vestibulares e concursos cadastrados. A edição completa (dados,
// matérias e pesos, conteúdo programático e redação) fica em
// /admin/vestibulares/:id.
//
// API: GET|POST /api/admin/exams, PUT|DELETE /api/admin/exams/:id
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, confirm, modal, qs, on,
  pageHeader, skeleton, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtNumber, daysUntil } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

export const TRACKS = [
  { value: 'enem', label: 'ENEM' },
  { value: 'barro_branco', label: 'Barro Branco / PM' },
  { value: 'vestibular', label: 'Vestibular' },
];

const trackLabel = (value) => (TRACKS.find((track) => track.value === value) || {}).label || value;

let state = null;

function nameCell(row) {
  return html`
    <div class="ex-name">
      <a class="ex-name-link" href="/admin/vestibulares/${row.id}">${row.name}</a>
      <span class="ex-name-meta">${row.short_name}${row.board ? ` · ${row.board}` : ''}</span>
    </div>`;
}

function dateCell(row) {
  if (!row.exam_date) return html`<span class="dt-muted">—</span>`;
  const days = daysUntil(row.exam_date);
  return html`
    <div class="ex-date">
      <span>${fmtDate(row.exam_date)}</span>
      ${Number.isFinite(days) && days >= 0 ? html`<span class="ex-date-days">${days === 0 ? 'é hoje' : `faltam ${fmtNumber(days, { digits: 0 })} dias`}</span>` : ''}
    </div>`;
}

function contentCell(row) {
  return html`
    <span class="ex-counts">
      <span title="Matérias com peso">${icon('layers', { size: 13 })}${fmtNumber(row.subjects_count || 0, { digits: 0 })}</span>
      <span title="Assuntos no conteúdo programático">${icon('list-tree', { size: 13 })}${fmtNumber(row.topics_count || 0, { digits: 0 })}</span>
      <span title="Provas anteriores">${icon('file-text', { size: 13 })}${fmtNumber(row.past_exams_count || 0, { digits: 0 })}</span>
      <span title="Alunos com esta prova no perfil">${icon('users', { size: 13 })}${fmtNumber(row.students_count || 0, { digits: 0 })}</span>
    </span>`;
}

function formFields() {
  return [
    { key: 'name', label: 'Nome do vestibular', type: 'text', required: true, width: 'two-thirds', maxLength: 120, placeholder: 'Ex.: Exame Nacional do Ensino Médio' },
    { key: 'short_name', label: 'Sigla', type: 'text', width: 'third', maxLength: 40, placeholder: 'ENEM', hint: 'Aparece em badges e filtros.' },
    { key: 'track', label: 'Trilha', type: 'select', required: true, width: 'half', options: TRACKS, hint: 'Define a experiência do aluno.' },
    { key: 'board', label: 'Banca', type: 'text', width: 'half', maxLength: 80, placeholder: 'INEP, VUNESP, FUVEST…' },
    { key: 'exam_date', label: 'Data da próxima prova', type: 'date', width: 'half' },
    { key: 'score_max', label: 'Nota máxima da prova objetiva', type: 'number', width: 'half', min: 0, max: 10000, step: 1 },
    { key: 'description', label: 'Descrição', type: 'textarea', rows: 3, maxLength: 2000, placeholder: 'Formato da prova, número de questões, o que o aluno precisa saber.' },
    { key: 'has_essay', label: 'A prova tem redação', type: 'switch', default: true },
    { key: 'essay_max_score', label: 'Escala máxima da redação', type: 'number', width: 'half', min: 0, max: 10000, step: 1, default: 1000, hint: 'ENEM: 1000. Ajuste os critérios na aba Redação do vestibular.' },
    { key: 'sort_order', label: 'Ordem na lista', type: 'number', width: 'half', min: 0, max: 100000, step: 1 },
    { key: 'active', label: 'Vestibular disponível para os alunos', type: 'switch', default: true },
  ];
}

function openForm(row, ctx) {
  const editing = Boolean(row);
  const body = document.createElement('div');
  let form = null;

  const dialog = modal({
    title: editing ? 'Editar dados do vestibular' : 'Novo vestibular',
    subtitle: editing ? row.name : 'Depois de criar, defina matérias, pesos, conteúdo programático e critérios de redação.',
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
        short_name: row.short_name,
        track: row.track,
        board: row.board,
        exam_date: row.exam_date,
        score_max: row.score_max,
        description: row.description,
        has_essay: row.has_essay,
        essay_max_score: row.essay_max_score,
        sort_order: row.sort_order,
        active: row.active,
      }
      : { has_essay: true, active: true, essay_max_score: 1000, track: 'vestibular' },
    submitLabel: editing ? 'Salvar alterações' : 'Criar vestibular',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    autofocus: true,
    async onSubmit(values) {
      const payload = { ...values };
      if (!payload.short_name) delete payload.short_name;
      const saved = editing
        ? await api.put(`/api/admin/exams/${row.id}`, payload)
        : await api.post('/api/admin/exams', payload);
      toast(editing ? 'Vestibular salvo.' : 'Vestibular criado.', { type: 'success' });
      dialog.close();
      if (!editing && ctx) ctx.navigate(`/admin/vestibulares/${saved.id}`);
      else if (state.table) state.table.reload();
    },
  });
}

async function removeExam(row, table) {
  const ok = await confirm({
    title: 'Excluir vestibular',
    message: `"${row.name}" será excluído com as matérias, o conteúdo programático e os critérios de redação vinculados.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/exams/${row.id}`);
    toast('Vestibular excluído.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir o vestibular.', { type: 'error' });
  }
}

async function toggleActive(row, table) {
  try {
    await api.put(`/api/admin/exams/${row.id}`, { active: !row.active });
    toast(row.active ? 'Vestibular desativado.' : 'Vestibular ativado.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Vestibulares',
      subtitle: 'Provas atendidas pela plataforma, com pesos por matéria, conteúdo programático e matriz de redação.',
      actions: html`<button type="button" class="btn btn-primary" data-act="new">${icon('plus')}<span>Novo vestibular</span></button>`,
    })}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

function renderExamsPage(ctx) {
  ctx.setTitle('Vestibulares');
  render(ctx.el, skeleton('page'));

  state = { ctx, table: null, off: [] };
  render(ctx.el, view());

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'name', label: 'Vestibular', render: nameCell },
      { key: 'track', label: 'Trilha', nowrap: true, render: (row) => badge(trackLabel(row.track), row.track === 'enem' ? 'blue' : row.track === 'barro_branco' ? 'orange' : 'gray') },
      { key: 'exam_date', label: 'Próxima prova', nowrap: true, render: dateCell },
      { key: 'subjects_count', label: 'Conteúdo', render: contentCell, nowrap: true },
      { key: 'has_essay', label: 'Redação', align: 'center', nowrap: true, render: (row) => (row.has_essay ? badge('Sim', 'green') : badge('Não', 'gray')) },
      { key: 'active', label: 'Situação', nowrap: true, render: (row) => (row.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')) },
    ],
    fetch: (page, query) => api.get('/api/admin/exams', { query: { q: query.q, track: query.track, status: query.status } }),
    pageSize: 100,
    search: true,
    searchPlaceholder: 'Buscar pelo nome ou sigla',
    emptyText: 'Nenhum vestibular cadastrado',
    rowKey: 'id',
    filters: [
      { key: 'track', label: 'Trilha', options: TRACKS },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }] },
    ],
    onRowClick: (row) => ctx.navigate(`/admin/vestibulares/${row.id}`),
    rowActions: [
      { label: 'Abrir vestibular', icon: 'arrow-right', onClick: (row) => ctx.navigate(`/admin/vestibulares/${row.id}`) },
      { label: 'Editar dados', icon: 'square-pen', onClick: (row) => openForm(row, null) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: (row, table) => removeExam(row, table) },
    ],
  });

  state.off.push(
    on(ctx.el, 'click', '[data-act="new"]', (event) => {
      event.preventDefault();
      openForm(null, ctx);
    })
  );
}

export default renderExamsPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

// =====================================================================
// Foco Elite — Admin › Provas anteriores (ARCHITECTURE §6.5)
//
// Filtros por prova e ano, tabela e formulário em modal (prova, ano, dia,
// título, banca, PDF, gabarito, link externo e observações).
//
// API: GET|POST|PUT|DELETE /api/admin/past-exams[/:id]
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, confirm, modal, qs, on,
  pageHeader, skeleton, errorState, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { truncate } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

let state = null;

function linksCell(row) {
  const links = [
    { url: row.pdf_url, label: 'Prova', iconName: 'file-text' },
    { url: row.answer_key_url, label: 'Gabarito', iconName: 'list-checks' },
    { url: row.external_url, label: 'Site', iconName: 'external-link' },
  ].filter((link) => link.url);
  if (!links.length) return html`<span class="dt-muted" title="Nenhum arquivo cadastrado">—</span>`;
  return html`<span class="pe-links">
    ${links.map((link) => html`
      <a class="btn btn-ghost btn-sm" href="${link.url}" target="_blank" rel="noopener noreferrer" title="Abrir ${link.label}">
        ${icon(link.iconName, { size: 14 })}<span>${link.label}</span>
      </a>`)}
  </span>`;
}

function titleCell(row) {
  return html`
    <div class="pe-title">
      <span class="pe-title-main">${row.title}</span>
      ${row.notes ? html`<span class="pe-notes">${truncate(row.notes, 90)}</span>` : ''}
    </div>`;
}

/** Campos do formulário (usado tanto na criação quanto na edição). */
function formFields() {
  return [
    {
      key: 'exam_id',
      label: 'Vestibular',
      type: 'select',
      required: true,
      width: 'half',
      options: state.exams.map((exam) => ({ value: exam.id, label: exam.name })),
    },
    { key: 'year', label: 'Ano', type: 'number', required: true, width: 'half', min: 1950, max: 2100, step: 1, placeholder: '2024' },
    { key: 'title', label: 'Título', type: 'text', required: true, width: 'two-thirds', maxLength: 200, placeholder: 'Ex.: ENEM 2024 — 1º dia (caderno azul)' },
    { key: 'day', label: 'Dia', type: 'number', width: 'third', min: 1, max: 9, step: 1, hint: 'Provas aplicadas em mais de um dia (ENEM: 1 ou 2).' },
    { key: 'board', label: 'Banca', type: 'text', width: 'half', maxLength: 80, placeholder: 'INEP, VUNESP…' },
    { key: 'pdf_url', label: 'PDF da prova', type: 'file', folder: 'provas', accept: 'document', width: 'full', maxLength: 2000, placeholder: 'Envie o arquivo, ou cole um link (inclusive do Google Drive)', hint: 'Link do Drive funciona, desde que o arquivo esteja como "qualquer pessoa com o link".' },
    { key: 'answer_key_url', label: 'PDF do gabarito', type: 'file', folder: 'provas', accept: 'document', width: 'full', maxLength: 2000, placeholder: 'Envie o arquivo, ou cole um link', hint: 'Com o gabarito aqui, a leitura das questões não precisa que ninguém digite as respostas.' },
    { key: 'external_url', label: 'Link externo', type: 'url', width: 'half', maxLength: 2000, hint: 'Página oficial com a prova, quando não houver PDF.' },
    { key: 'notes', label: 'Observações', type: 'textarea', rows: 3, maxLength: 2000, placeholder: 'Informações úteis para o aluno.' },
    { key: 'active', label: 'Prova visível para o aluno', type: 'switch', default: true },
  ];
}

function openForm(row) {
  const editing = Boolean(row);
  const body = document.createElement('div');
  let form = null;

  const dialog = modal({
    title: editing ? 'Editar prova anterior' : 'Nova prova anterior',
    subtitle: editing ? row.exam_name : 'Cadastre o PDF da prova e do gabarito para os alunos baixarem.',
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
        exam_id: row.exam_id,
        year: row.year,
        title: row.title,
        day: row.day,
        board: row.board,
        pdf_url: row.pdf_url,
        answer_key_url: row.answer_key_url,
        external_url: row.external_url,
        notes: row.notes,
        active: row.active,
      }
      : { active: true, exam_id: state.exams.length === 1 ? state.exams[0].id : null, year: new Date().getFullYear() - 1 },
    submitLabel: editing ? 'Salvar alterações' : 'Cadastrar prova',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    autofocus: true,
    async onSubmit(values) {
      const payload = { ...values };
      if (editing) await api.put(`/api/admin/past-exams/${row.id}`, payload);
      else await api.post('/api/admin/past-exams', payload);
      toast(editing ? 'Prova anterior salva.' : 'Prova anterior cadastrada.', { type: 'success' });
      dialog.close();
      if (state.table) state.table.reload();
    },
  });

}

async function removeRow(row, table) {
  const ok = await confirm({
    title: 'Excluir prova anterior',
    message: `"${row.title}" deixará de aparecer para os alunos. Esta ação não pode ser desfeita.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/past-exams/${row.id}`);
    toast('Prova anterior excluída.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir.', { type: 'error' });
  }
}

async function toggleActive(row, table) {
  try {
    await api.put(`/api/admin/past-exams/${row.id}`, { active: !row.active });
    toast(row.active ? 'Prova ocultada dos alunos.' : 'Prova liberada para os alunos.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Provas anteriores',
      subtitle: 'Cadernos de prova e gabaritos que o aluno acessa em Provas Anteriores.',
      actions: html`<button type="button" class="btn btn-primary" data-act="new">${icon('plus')}<span>Nova prova anterior</span></button>`,
    })}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

async function renderPastExamsPage(ctx) {
  ctx.setTitle('Provas anteriores');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-past-exams');
  state = { ctx, token, table: null, exams: [], years: [], off: [] };

  try {
    const [exams, first] = await Promise.all([
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
      api.get('/api/admin/past-exams', { query: { limit: 1 } }),
    ]);
    if (!state || state.token !== token) return;
    state.exams = exams;
    state.years = Array.isArray(first.years) ? first.years : [];
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Provas anteriores' })}
        ${errorState({ title: 'Não foi possível carregar as provas anteriores', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-past-exams' })}`
    );
    const button = qs('[data-action="reload-past-exams"]', ctx.el);
    if (button) button.addEventListener('click', () => renderPastExamsPage(ctx));
    return;
  }

  render(ctx.el, view());

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'exam_short_name', label: 'Prova', sortable: false, nowrap: true, render: (row) => badge(row.exam_short_name || row.exam_name, 'blue') },
      { key: 'year', label: 'Ano', sortable: true, align: 'right', nowrap: true },
      { key: 'day', label: 'Dia', align: 'center', nowrap: true, render: (row) => (row.day ? String(row.day) : html`<span class="dt-muted">—</span>`) },
      { key: 'title', label: 'Título', sortable: true, render: titleCell },
      { key: 'board', label: 'Banca', nowrap: true },
      { key: 'pdf_url', label: 'Arquivos', render: linksCell },
      { key: 'active', label: 'Situação', nowrap: true, render: (row) => (row.active ? badge('Visível', 'green') : badge('Oculta', 'gray')) },
    ],
    fetch: (page, query) => api.get('/api/admin/past-exams', { query }),
    pageSize: 25,
    search: true,
    searchPlaceholder: 'Buscar pelo título ou pela prova',
    sort: { key: 'year', dir: 'desc' },
    emptyText: 'Nenhuma prova anterior cadastrada',
    rowKey: 'id',
    filters: [
      { key: 'exam_id', label: 'Vestibular', options: state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      { key: 'year', label: 'Ano', options: state.years.map((year) => ({ value: String(year), label: String(year) })) },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Visíveis' }, { value: 'inactive', label: 'Ocultas' }] },
    ],
    onRowClick: (row) => openForm(row),
    rowActions: [
      { label: 'Editar', icon: 'square-pen', onClick: (row) => openForm(row) },
      {
        label: 'Ler as questões desta prova',
        icon: 'scan-text',
        onClick: (row) => {
          if (!row.pdf_url) {
            toast('Cadastre o PDF desta prova antes de ler as questões.', { type: 'warning' });
            return;
          }
          // Leva para a leitura já com esta prova escolhida: o arquivo já está
          // na plataforma e não precisa ser enviado de novo.
          state.ctx.navigate(`/admin/ler-prova?prova=${encodeURIComponent(row.id)}`);
        },
      },
      { label: 'Mostrar ou ocultar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: (row, table) => removeRow(row, table) },
    ],
  });

  state.off.push(
    on(ctx.el, 'click', '[data-act="new"]', (event) => {
      event.preventDefault();
      if (!state.exams.length) {
        toast('Cadastre um vestibular antes de adicionar provas anteriores.', { type: 'warning' });
        return;
      }
      openForm(null);
    })
  );
}

export default renderPastExamsPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

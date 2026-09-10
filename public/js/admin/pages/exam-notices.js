// =====================================================================
// Foco Elite — Admin › Editais
//
// O edital é o documento oficial que abre cada certame. Muda todo ano e traz
// as datas que o aluno acompanha, então aqui ele tem histórico por prova e ano,
// com rascunho, publicação e arquivamento.
//
// Publicar arquiva o edital anterior da mesma prova (só um vale por vez para o
// aluno) e leva a data da prova para o cadastro do vestibular, que é o número
// que o cronograma usa para priorizar assunto na reta final.
//
// API: GET|POST|PUT|DELETE /api/admin/exam-notices[/:id]
//      POST /api/admin/exam-notices/:id/publish | /archive
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render, toast, confirm, modal, qs, on,
  pageHeader, skeleton, errorState, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, truncate } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

let state = null;

const STATUS_LABEL = {
  draft: { label: 'Rascunho', tone: 'gray', hint: 'Só a equipe vê.' },
  published: { label: 'Publicado', tone: 'green', hint: 'É o edital que o aluno vê.' },
  archived: { label: 'Arquivado', tone: 'orange', hint: 'Fica no histórico.' },
};

function statusCell(row) {
  const info = STATUS_LABEL[row.status] || STATUS_LABEL.draft;
  return badge(info.label, info.tone);
}

function titleCell(row) {
  return html`
    <div class="en-title">
      <span class="en-title-main">${row.title}</span>
      ${row.board ? html`<span class="en-sub">${row.board}</span>` : ''}
      ${row.summary ? html`<span class="en-sub">${truncate(row.summary, 90)}</span>` : ''}
    </div>`;
}

function datesCell(row) {
  const parts = [];
  if (row.registration_end) parts.push(`Inscrições até ${fmtDate(row.registration_end)}`);
  if (row.exam_date) parts.push(`Prova em ${fmtDate(row.exam_date)}`);
  if (!parts.length) return html`<span class="dt-muted">—</span>`;
  return html`<div class="en-dates">${parts.map((text) => html`<span>${text}</span>`)}</div>`;
}

function filesCell(row) {
  const links = [
    { url: row.pdf_url, label: 'Edital', iconName: 'file-text' },
    { url: row.external_url, label: 'Site', iconName: 'external-link' },
  ].filter((link) => link.url);
  if (!links.length) return html`<span class="dt-muted" title="Nenhum arquivo cadastrado">—</span>`;
  return html`<span class="en-links">
    ${links.map((link) => html`
      <a class="btn btn-ghost btn-sm" href="${link.url}" target="_blank" rel="noopener noreferrer" title="Abrir ${link.label}">
        ${icon(link.iconName, { size: 14 })}<span>${link.label}</span>
      </a>`)}
  </span>`;
}

/** Campos do formulário, iguais na criação e na edição. */
function formFields() {
  return [
    { key: 'section_basics', label: 'Identificação', type: 'section' },
    {
      key: 'exam_id',
      label: 'Vestibular',
      type: 'select',
      required: true,
      width: 'half',
      options: state.exams.map((exam) => ({ value: exam.id, label: exam.name })),
      hint: 'Cada prova tem um edital por ano.',
    },
    { key: 'year', label: 'Ano do certame', type: 'number', required: true, width: 'half', min: 1950, max: 2100, step: 1, integer: true },
    { key: 'title', label: 'Título', type: 'text', required: true, maxLength: 200, placeholder: 'Ex.: Edital ENEM 2026' },
    { key: 'board', label: 'Banca organizadora', type: 'text', width: 'half', maxLength: 80, placeholder: 'INEP, VUNESP…' },
    { key: 'vacancies', label: 'Vagas', type: 'number', width: 'half', min: 0, step: 1, integer: true, hint: 'Deixe em branco quando o edital não informar.' },

    { key: 'section_files', label: 'Documento', type: 'section' },
    { key: 'pdf_url', label: 'PDF do edital', type: 'file', folder: 'editais', accept: 'document', maxLength: 2000, placeholder: 'https://… ou envie o arquivo' },
    { key: 'external_url', label: 'Página oficial do certame', type: 'url', maxLength: 2000, placeholder: 'https://…' },
    {
      key: 'summary',
      label: 'Resumo para o aluno',
      type: 'markdown',
      rows: 8,
      maxLength: 8000,
      hint: 'O que muda neste edital, em poucas linhas. Aparece na área do aluno.',
    },

    { key: 'section_dates', label: 'Datas', type: 'section' },
    { key: 'registration_start', label: 'Inscrições começam', type: 'date', width: 'half' },
    { key: 'registration_end', label: 'Inscrições terminam', type: 'date', width: 'half' },
    { key: 'exam_date', label: 'Data da prova', type: 'date', width: 'half', hint: 'Ao publicar, esta data vira a data oficial do vestibular e realimenta o cronograma dos alunos.' },
    { key: 'second_exam_date', label: 'Segundo dia de prova', type: 'date', width: 'half', hint: 'Só para provas aplicadas em dois dias, como o ENEM.' },
    { key: 'result_date', label: 'Resultado', type: 'date', width: 'half' },
    { key: 'fee_cents', label: 'Taxa de inscrição (em centavos)', type: 'number', width: 'half', min: 0, step: 1, integer: true, placeholder: '8500', hint: 'R$ 85,00 se escreve 8500.' },

    { key: 'notes', label: 'Anotações internas', type: 'textarea', rows: 3, maxLength: 2000, hint: 'Não aparece para o aluno.' },
  ];
}

/** Converte os campos vazios do formulário no que a API espera. */
function toPayload(values) {
  const payload = { ...values };
  for (const key of Object.keys(payload)) {
    if (key.startsWith('section_')) delete payload[key];
    else if (payload[key] === '' ) payload[key] = null;
  }
  return payload;
}

function openForm(row) {
  const editing = Boolean(row);
  const body = document.createElement('div');
  let form = null;

  const dialog = modal({
    title: editing ? 'Editar edital' : 'Novo edital',
    subtitle: editing
      ? `${row.exam_name} · ${row.year}`
      : 'Cadastre como rascunho e publique quando quiser que o aluno veja.',
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
        board: row.board,
        vacancies: row.vacancies,
        pdf_url: row.pdf_url,
        external_url: row.external_url,
        summary: row.summary,
        registration_start: row.registration_start,
        registration_end: row.registration_end,
        exam_date: row.exam_date,
        second_exam_date: row.second_exam_date,
        result_date: row.result_date,
        fee_cents: row.fee_cents,
        notes: row.notes,
      }
      : {
        exam_id: state.exams.length === 1 ? state.exams[0].id : null,
        year: new Date().getFullYear(),
      },
    submitLabel: editing ? 'Salvar alterações' : 'Cadastrar edital',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    autofocus: true,
    async onSubmit(values) {
      const payload = toPayload(values);
      if (editing) await api.put(`/api/admin/exam-notices/${row.id}`, payload);
      else await api.post('/api/admin/exam-notices', payload);
      toast(editing ? 'Edital salvo.' : 'Edital cadastrado como rascunho.', { type: 'success' });
      dialog.close();
      if (state.table) state.table.reload();
    },
  });
}

async function publish(row, table) {
  const ok = await confirm({
    title: 'Publicar edital',
    message: row.exam_date
      ? `"${row.title}" passa a ser o edital vigente de ${row.exam_name}. O edital publicado anterior vai para o histórico e a data da prova do vestibular passa a ser ${fmtDate(row.exam_date)}.`
      : `"${row.title}" passa a ser o edital vigente de ${row.exam_name} e o anterior vai para o histórico.`,
    confirmText: 'Publicar',
  });
  if (!ok) return;
  try {
    const result = await api.post(`/api/admin/exam-notices/${row.id}/publish`, {});
    toast(
      result.archived ? 'Edital publicado. O anterior foi arquivado.' : 'Edital publicado.',
      { type: 'success' }
    );
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível publicar.', { type: 'error' });
  }
}

async function archive(row, table) {
  const ok = await confirm({
    title: 'Arquivar edital',
    message: `"${row.title}" sai da área do aluno e fica só no histórico.`,
    confirmText: 'Arquivar',
  });
  if (!ok) return;
  try {
    await api.post(`/api/admin/exam-notices/${row.id}/archive`, {});
    toast('Edital arquivado.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível arquivar.', { type: 'error' });
  }
}

async function removeRow(row, table) {
  const ok = await confirm({
    title: 'Excluir edital',
    message: `"${row.title}" será removido definitivamente. Esta ação não pode ser desfeita.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/exam-notices/${row.id}`);
    toast('Edital excluído.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Editais',
      subtitle: 'Documento oficial de cada certame. O aluno vê o edital publicado da prova dele, com as datas e a contagem regressiva.',
      actions: html`<button type="button" class="btn btn-primary" data-act="new">${icon('plus')}<span>Novo edital</span></button>`,
    })}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

async function renderExamNoticesPage(ctx) {
  ctx.setTitle('Editais');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-exam-notices');
  state = { ctx, token, table: null, exams: [], years: [], off: [] };

  try {
    const [exams, first] = await Promise.all([
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
      api.get('/api/admin/exam-notices', { query: { limit: 1 } }),
    ]);
    if (!state || state.token !== token) return;
    state.exams = exams;
    state.years = Array.isArray(first.years) ? first.years : [];
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Editais' })}
        ${errorState({
          title: 'Não foi possível carregar os editais',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
          retry: 'reload-notices',
        })}`
    );
    const button = qs('[data-action="reload-notices"]', ctx.el);
    if (button) button.addEventListener('click', () => renderExamNoticesPage(ctx));
    return;
  }

  render(ctx.el, view());

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'exam_short_name', label: 'Prova', nowrap: true, render: (row) => badge(row.exam_short_name || row.exam_name, 'blue') },
      { key: 'year', label: 'Ano', sortable: true, align: 'right', nowrap: true },
      { key: 'title', label: 'Edital', sortable: true, render: titleCell },
      { key: 'exam_date', label: 'Datas', sortable: true, render: datesCell },
      { key: 'pdf_url', label: 'Arquivos', render: filesCell },
      { key: 'status', label: 'Situação', sortable: true, nowrap: true, render: statusCell },
    ],
    fetch: (page, query) => api.get('/api/admin/exam-notices', { query }),
    pageSize: 25,
    search: true,
    searchPlaceholder: 'Buscar pelo título ou pela prova',
    sort: { key: 'year', dir: 'desc' },
    emptyText: 'Nenhum edital cadastrado',
    rowKey: 'id',
    filters: [
      { key: 'exam_id', label: 'Vestibular', options: state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      { key: 'year', label: 'Ano', options: state.years.map((year) => ({ value: String(year), label: String(year) })) },
      {
        key: 'status',
        label: 'Situação',
        options: [
          { value: 'draft', label: 'Rascunho' },
          { value: 'published', label: 'Publicado' },
          { value: 'archived', label: 'Arquivado' },
        ],
      },
    ],
    onRowClick: (row) => openForm(row),
    rowActions: [
      { label: 'Editar', icon: 'square-pen', onClick: (row) => openForm(row) },
      {
        label: 'Publicar',
        icon: 'check-check',
        hidden: (row) => row.status === 'published',
        onClick: (row, table) => publish(row, table),
      },
      {
        label: 'Arquivar',
        icon: 'archive',
        hidden: (row) => row.status !== 'published',
        onClick: (row, table) => archive(row, table),
      },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: (row, table) => removeRow(row, table) },
    ],
  });

  state.off.push(
    on(ctx.el, 'click', '[data-act="new"]', (event) => {
      event.preventDefault();
      if (!state.exams.length) {
        toast('Cadastre um vestibular antes de adicionar editais.', { type: 'warning' });
        return;
      }
      openForm(null);
    })
  );
}

export default renderExamNoticesPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

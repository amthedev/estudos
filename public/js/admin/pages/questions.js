// =====================================================================
// Foco Elite — Admin › Questões (ARCHITECTURE §6.5)
//
// Tabela com o enunciado resumido, matéria e assunto, dificuldade, ano e
// banca, provas e situação, com busca e filtros. Exportação em CSV usa os
// mesmos filtros da listagem.
//
// API: GET /api/admin/questions, /questions/filters, /questions/export,
//      PUT|DELETE /api/admin/questions/:id
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, qs, on, escapeHtml,
  pageHeader, skeleton, errorState, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { difficultyLabel, difficultyTone, truncate } from '../../core/format.js';
import { mdToText } from '../../core/markdown.js';
import { mountTable } from '../../components/data-table.js';

let state = null;

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);

function statementCell(row) {
  const text = mdToText(row.excerpt || row.statement || '', 160);
  return html`
    <div class="qa-statement">
      <a class="qa-statement-link" href="/admin/questoes/${row.id}">${text || 'Questão sem enunciado'}</a>
      <span class="qa-statement-meta">
        ${row.correct_letter ? html`<span class="qa-correct" title="Alternativa correta">Gabarito ${row.correct_letter}</span>` : html`<span class="text-warning">Sem gabarito</span>`}
        <span>${row.options_count || 0} alternativas</span>
      </span>
    </div>`;
}

function classificationCell(row) {
  const color = safeColor(row.subject_color);
  return html`
    <div class="qa-class">
      <span class="qa-subject">
        <span class="subject-dot" ${color ? raw(`style="background:${escapeHtml(color)}"`) : ''} aria-hidden="true"></span>
        <span>${row.subject_name}</span>
      </span>
      <span class="qa-topic">${row.topic_name}${row.subtopic_name ? ` · ${row.subtopic_name}` : ''}</span>
    </div>`;
}

function originCell(row) {
  const parts = [row.year, row.board, row.source_exam_name].filter(Boolean);
  if (!parts.length) return html`<span class="dt-muted">—</span>`;
  return html`<span class="qa-origin">${parts.map((part) => html`<span>${part}</span>`)}</span>`;
}

function examsCell(row) {
  const exams = Array.isArray(row.exams) ? row.exams : [];
  if (!exams.length) return html`<span class="dt-muted">—</span>`;
  const visible = exams.slice(0, 3);
  const rest = exams.length - visible.length;
  return html`<span class="qa-exams">
    ${visible.map((exam) => badge(exam.short_name || exam.slug, 'blue'))}
    ${rest > 0 ? badge(`+${rest}`, 'gray') : ''}
  </span>`;
}

async function toggleActive(row, table) {
  try {
    await api.put(`/api/admin/questions/${row.id}`, { active: !row.active });
    toast(row.active ? 'Questão desativada.' : 'Questão ativada.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação da questão.', { type: 'error' });
  }
}

async function removeQuestion(row, table) {
  const ok = await confirm({
    title: 'Excluir questão',
    message: `"${truncate(mdToText(row.excerpt || '', 120), 120)}" será excluída, junto com as respostas registradas. Esta ação não pode ser desfeita.`,
    danger: true,
    confirmText: 'Excluir questão',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/questions/${row.id}`);
    toast('Questão excluída.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir a questão.', { type: 'error' });
  }
}

/** Exporta o resultado atual (mesmos filtros da tabela) em CSV. */
function exportCsv() {
  if (!state.table) return;
  const current = state.table.getState();
  const query = { format: 'csv' };
  if (current.q) query.q = current.q;
  Object.entries({ ...current.filters, ...current.params }).forEach(([key, value]) => {
    if (value != null && value !== '') query[key] = value;
  });
  window.location.assign(api.buildUrl('/api/admin/questions/export', query));
}

function view(context) {
  return html`
    ${pageHeader({
      title: 'Questões',
      subtitle: 'Banco usado em prática, simulados, revisões e caderno de erros.',
      actions: html`
        <button type="button" class="btn btn-ghost" data-act="export">${icon('download')}<span>Exportar CSV</span></button>
        <a class="btn btn-secondary" href="/admin/questoes/importar">${icon('upload')}<span>Importar</span></a>
        <a class="btn btn-primary" href="/admin/questoes/nova">${icon('plus')}<span>Nova questão</span></a>`,
    })}
    ${context ? html`
      <div class="alert alert-info qa-context" role="status">
        ${icon('filter')}
        <div class="alert-body">
          <div class="alert-text">Mostrando apenas as questões de <strong>${context}</strong>.</div>
        </div>
        <a class="btn btn-secondary btn-sm" href="/admin/questoes">Ver todas</a>
      </div>` : ''}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

async function renderQuestionsPage(ctx) {
  ctx.setTitle('Questões');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-questions');
  state = { ctx, token, table: null, off: [] };

  let filters;
  try {
    filters = await api.get('/api/admin/questions/filters');
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Questões' })}
        ${errorState({ title: 'Não foi possível carregar o banco de questões', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-questions' })}`
    );
    const button = qs('[data-action="reload-questions"]', ctx.el);
    if (button) button.addEventListener('click', () => renderQuestionsPage(ctx));
    return;
  }
  if (!state || state.token !== token) return;

  const query = ctx.query || {};
  const params = {};
  if (query.topic_id) params.topic_id = query.topic_id;
  if (query.subtopic_id) params.subtopic_id = query.subtopic_id;

  let contextLabel = '';
  if (query.topic_id) {
    try {
      const topics = await api.get('/api/admin/content/topics');
      const topic = topics.find((t) => t.id === query.topic_id);
      contextLabel = topic ? topic.name : 'um assunto';
    } catch {
      contextLabel = 'um assunto';
    }
  }
  if (!state || state.token !== token) return;

  render(ctx.el, view(contextLabel));

  const initialFilters = {};
  if (query.subject_id) initialFilters.subject_id = query.subject_id;
  if (query.exam_id) initialFilters.exam_id = query.exam_id;

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'statement', label: 'Enunciado', render: statementCell },
      { key: 'subject_name', label: 'Matéria e assunto', sortable: true, render: classificationCell },
      { key: 'difficulty', label: 'Dificuldade', sortable: true, nowrap: true, render: (row) => badge(difficultyLabel(row.difficulty), difficultyTone(row.difficulty)) },
      { key: 'year', label: 'Origem', sortable: true, nowrap: true, render: originCell },
      { key: 'exams', label: 'Provas', render: examsCell },
      { key: 'active', label: 'Situação', nowrap: true, render: (row) => (row.active ? badge('Ativa', 'green') : badge('Inativa', 'gray')) },
    ],
    fetch: (page, tableQuery) => api.get('/api/admin/questions', { query: tableQuery }),
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar no enunciado',
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhuma questão encontrada',
    rowKey: 'id',
    params,
    initialFilters,
    filters: [
      { key: 'subject_id', label: 'Matéria', options: (filters.subjects || []).map((s) => ({ value: s.id, label: s.name })) },
      { key: 'exam_id', label: 'Prova', options: (filters.exams || []).map((e) => ({ value: e.id, label: e.short_name || e.name })) },
      { key: 'difficulty', label: 'Dificuldade', options: (filters.difficulties || []).map((d) => ({ value: String(d.value), label: d.label })) },
      { key: 'year', label: 'Ano', options: (filters.years || []).map((y) => ({ value: String(y), label: String(y) })) },
      { key: 'board', label: 'Banca', options: (filters.boards || []).map((b) => ({ value: b, label: b })) },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativas' }, { value: 'inactive', label: 'Inativas' }] },
    ],
    onRowClick: (row) => ctx.navigate(`/admin/questoes/${row.id}`),
    rowActions: [
      { label: 'Editar questão', icon: 'square-pen', onClick: (row) => ctx.navigate(`/admin/questoes/${row.id}`) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir questão', icon: 'trash-2', danger: true, onClick: (row, table) => removeQuestion(row, table) },
    ],
  });

  state.off.push(
    on(ctx.el, 'click', '[data-act="export"]', (event) => {
      event.preventDefault();
      exportCsv();
    })
  );
}

export default renderQuestionsPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

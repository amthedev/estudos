// =====================================================================
// Foco Elite — Admin › Aulas (ARCHITECTURE §6.5)
//
// Tabela com miniatura, título, matéria e assunto, provas em badges, duração
// e status, com busca e filtros (matéria, prova, dificuldade e situação).
//
// API: GET /api/admin/lessons, PUT /api/admin/lessons/:id, DELETE /api/admin/lessons/:id
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, qs,
  pageHeader, skeleton, errorState, badge, escapeHtml,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, difficultyLabel, difficultyTone, truncate } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';

let state = null;

const DIFFICULTIES = [
  { value: '1', label: 'Básico' },
  { value: '2', label: 'Intermediário' },
  { value: '3', label: 'Avançado' },
];

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);

function thumbCell(row) {
  const url = String(row.thumbnail_url || '').trim();
  if (/^https?:\/\//i.test(url)) {
    return html`<span class="al-thumb"><img src="${url}" alt="" loading="lazy" width="72" height="41"></span>`;
  }
  const providerIcon = row.video_provider === 'youtube' || row.video_provider === 'vimeo' ? 'circle-play' : row.video_provider === 'external' ? 'external-link' : 'film';
  return html`<span class="al-thumb al-thumb-empty" title="${row.video_provider === 'none' ? 'Sem vídeo' : 'Sem miniatura'}">${icon(providerIcon, { size: 18 })}</span>`;
}

function titleCell(row) {
  return html`
    <div class="al-title">
      <a class="al-title-link" href="/admin/aulas/${row.id}">${row.title}</a>
      ${row.subtopic_name ? html`<span class="al-sub">${row.subtopic_name}</span>` : ''}
    </div>`;
}

function classificationCell(row) {
  const color = safeColor(row.subject_color);
  return html`
    <div class="al-class">
      <span class="al-subject">
        <span class="subject-dot" ${color ? raw(`style="background:${escapeHtml(color)}"`) : ''} aria-hidden="true"></span>
        <span>${row.subject_name}</span>
      </span>
      <span class="al-topic">${row.topic_name}</span>
    </div>`;
}

function examsCell(row) {
  const exams = Array.isArray(row.exams) ? row.exams : [];
  if (!exams.length) return html`<span class="dt-muted" title="A aula não está vinculada a nenhuma prova">—</span>`;
  const visible = exams.slice(0, 3);
  const rest = exams.length - visible.length;
  return html`<span class="al-exams">
    ${visible.map((exam) => badge(exam.short_name || exam.slug, 'blue'))}
    ${rest > 0 ? badge(`+${rest}`, 'gray') : ''}
  </span>`;
}

function statusCell(row) {
  return html`<span class="al-status">
    ${row.active ? badge('Ativa', 'green') : badge('Inativa', 'gray')}
    ${badge(difficultyLabel(row.difficulty), difficultyTone(row.difficulty))}
  </span>`;
}

async function toggleActive(row, table) {
  try {
    await api.put(`/api/admin/lessons/${row.id}`, { active: !row.active });
    toast(row.active ? 'Aula desativada.' : 'Aula ativada.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação da aula.', { type: 'error' });
  }
}

async function removeLesson(row, table) {
  const ok = await confirm({
    title: 'Excluir aula',
    message: `"${truncate(row.title, 90)}" será excluída, junto com o progresso registrado pelos alunos nela. Esta ação não pode ser desfeita.`,
    danger: true,
    confirmText: 'Excluir aula',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/lessons/${row.id}`);
    toast('Aula excluída.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir a aula.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Aulas',
      subtitle: 'Videoaulas da biblioteca, com classificação, provas em que caem e resumo em markdown.',
      actions: html`
        <a class="btn btn-secondary" href="/admin/conteudo">${icon('list-tree')}<span>Conteúdo</span></a>
        <a class="btn btn-secondary" href="/admin/aulas/importar">${icon('upload')}<span>Importar lista</span></a>
        <a class="btn btn-primary" href="/admin/aulas/nova">${icon('plus')}<span>Nova aula</span></a>`,
    })}
    <section class="card"><div class="card-body" data-table></div></section>`;
}

async function renderLessonsPage(ctx) {
  ctx.setTitle('Aulas');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-lessons');
  state = { ctx, token, table: null };

  let subjects = [];
  let exams = [];
  try {
    [subjects, exams] = await Promise.all([
      api.get('/api/admin/content/subjects'),
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
    ]);
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Aulas' })}
        ${errorState({ title: 'Não foi possível carregar as aulas', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-lessons' })}`
    );
    const button = qs('[data-action="reload-lessons"]', ctx.el);
    if (button) button.addEventListener('click', () => renderLessonsPage(ctx));
    return;
  }
  if (!state || state.token !== token) return;

  render(ctx.el, view());

  state.table = mountTable(qs('[data-table]', ctx.el), {
    columns: [
      { key: 'thumbnail_url', label: '', width: 84, render: thumbCell, className: 'al-col-thumb' },
      { key: 'title', label: 'Aula', sortable: true, render: titleCell },
      { key: 'subject_name', label: 'Matéria e assunto', sortable: true, render: classificationCell },
      { key: 'exams', label: 'Provas', render: examsCell },
      { key: 'duration_min', label: 'Duração', sortable: true, align: 'right', nowrap: true, render: (row) => escapeHtml(fmtMinutes(row.duration_min)) },
      { key: 'active', label: 'Situação', render: statusCell, nowrap: true },
    ],
    fetch: (page, query) => api.get('/api/admin/lessons', { query }),
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar pelo título da aula',
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhuma aula cadastrada',
    rowKey: 'id',
    filters: [
      { key: 'subject_id', label: 'Matéria', options: subjects.map((s) => ({ value: s.id, label: s.name })) },
      { key: 'exam_id', label: 'Prova', options: exams.map((e) => ({ value: e.id, label: e.short_name || e.name })) },
      { key: 'difficulty', label: 'Dificuldade', options: DIFFICULTIES },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativas' }, { value: 'inactive', label: 'Inativas' }] },
    ],
    onRowClick: (row) => ctx.navigate(`/admin/aulas/${row.id}`),
    rowActions: [
      { label: 'Editar aula', icon: 'square-pen', onClick: (row) => ctx.navigate(`/admin/aulas/${row.id}`) },
      { label: 'Questões deste assunto', icon: 'file-text', onClick: (row) => ctx.navigate(`/admin/questoes?topic_id=${encodeURIComponent(row.topic_id)}`) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir aula', icon: 'trash-2', danger: true, onClick: (row, table) => removeLesson(row, table) },
    ],
  });
}

export default renderLessonsPage;

export function unmount() {
  if (!state) return;
  if (state.table) state.table.destroy();
  state = null;
}

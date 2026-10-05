// =====================================================================
// Foco Elite — Admin › Aulas (ARCHITECTURE §6.5)
//
// Tabela com miniatura, título, matéria e assuntos, provas em badges,
// duração, situação e o estado das questões da aula, com busca e filtros
// (matéria, prova, dificuldade e situação).
//
// Uma aula cobre de 1 a 3 assuntos (o primeiro é o principal). As aulas de
// antes dos vários assuntos ficaram com o assunto único que tinham; marcando
// as caixas, "Reidentificar assuntos pelo título" lê o título de cada uma e
// grava os assuntos que ele traz.
//
// As três questões de cada aula são preparadas em segundo plano. A fila tenta
// de novo sozinha quando a IA falha, mas para depois de três rodadas ruins;
// "Preparar as questões de novo" (na linha ou para as marcadas) devolve a
// aula à fila, e a rodada só pede o que ainda falta.
//
// API: GET /api/admin/lessons, PUT /api/admin/lessons/:id, DELETE /api/admin/lessons/:id,
//      POST /api/admin/lessons/reidentify { ids[] }, POST /api/admin/lessons/:id/reidentify,
//      POST /api/admin/lessons/requeue-questions { ids[] }, POST /api/admin/lessons/:id/requeue-questions
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, modal, qs, qsa, on,
  pageHeader, skeleton, errorState, badge, escapeHtml, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, difficultyLabel, difficultyTone, truncate, pluralize } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';

let state = null;

const DIFFICULTIES = [
  { value: '1', label: 'Básico' },
  { value: '2', label: 'Intermediário' },
  { value: '3', label: 'Avançado' },
];

/** Teto do servidor por pedido de reidentificação. */
const MAX_REIDENTIFY = 100;
/** Teto do servidor por pedido de "Preparar as questões de novo". */
const MAX_REQUEUE = 1000;

/** As questões da aula, preparadas em segundo plano depois do cadastro. */
const QUESTIONS_STATUS = {
  none: ['Não preparadas', 'gray', 'Aula de antes da preparação automática: as questões saem na hora em que o aluno pratica.'],
  pending: ['Na fila', 'blue', 'As três questões da aula entram na preparação em instantes.'],
  generating: ['Preparando', 'orange', 'As três questões da aula estão sendo preparadas.'],
  ready: ['Prontas', 'green', 'A aula já tem as três questões da prática.'],
  failed: ['Falharam', 'red', 'A fila parou de tentar. "Preparar as questões de novo" põe a aula na fila outra vez.'],
};

/** Estados de onde "Preparar as questões de novo" tira a aula (os outros já estão na fila). */
const REQUEUEABLE = new Set(['none', 'ready', 'failed']);

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : null);

/** Os assuntos da aula, na ordem; resposta sem a lista vira o assunto principal. */
function lessonTopics(row) {
  if (Array.isArray(row.topics) && row.topics.length) return row.topics;
  return row.topic_id ? [{ topic_id: row.topic_id, topic_name: row.topic_name, subtopic_name: row.subtopic_name }] : [];
}

const topicName = (topic) => (topic.subtopic_name ? `${topic.topic_name} › ${topic.subtopic_name}` : topic.topic_name);

function pickCell(row) {
  const checked = state.selected.has(row.id);
  return html`
    <label class="al-pick" title="Marcar esta aula">
      <input type="checkbox" data-pick="${row.id}" ${checked ? raw('checked') : ''} aria-label="Marcar ${row.title}">
    </label>`;
}

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
    </div>`;
}

function classificationCell(row) {
  const color = safeColor(row.subject_color);
  const topics = lessonTopics(row);
  return html`
    <div class="al-class">
      <span class="al-subject">
        <span class="subject-dot" ${color ? raw(`style="background:${escapeHtml(color)}"`) : ''} aria-hidden="true"></span>
        <span>${row.subject_name}</span>
      </span>
      <span class="al-topics${topics.length > 1 ? ' is-multi' : ''}">
        ${topics.map((topic, index) => html`
          <span class="al-topic${index === 0 && topics.length > 1 ? ' is-main' : ''}"
                title="${index === 0 && topics.length > 1 ? 'Assunto principal' : ''}">${topicName(topic)}</span>`)}
      </span>
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

function questionsCell(row) {
  const [label, tone, tip] = QUESTIONS_STATUS[row.questions_status] || QUESTIONS_STATUS.none;
  // Na fila com motivo é a aula esperando depois de uma falha: o motivo diz quando volta.
  const comMotivo = (row.questions_status === 'failed' || row.questions_status === 'pending') && row.questions_error;
  const detail = comMotivo ? `${tip} ${row.questions_error}` : tip;
  return html`<span class="al-questions" title="${detail}">
    ${badge(label, tone)}${comMotivo && row.questions_status === 'pending' ? html`<span class="al-questions-retry">nova tentativa</span>` : ''}
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
    state.selected.delete(row.id);
    paintBulk();
    toast('Aula excluída.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir a aula.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Seleção e reidentificação pelo título
// ---------------------------------------------------------------------

/** A caixa do cabeçalho acompanha a página: marcada com todas, "meio" com algumas. */
function syncPageBox(items = state.table ? state.table.getItems() : []) {
  const box = qs('[data-pick-page]', state.ctx.el);
  if (!box) return;
  const marked = items.filter((row) => state.selected.has(row.id)).length;
  box.checked = items.length > 0 && marked === items.length;
  box.indeterminate = marked > 0 && marked < items.length;
}

function paintBulk() {
  const bar = qs('[data-bulk]', state.ctx.el);
  if (!bar) return;
  const count = state.selected.size;
  bar.hidden = count === 0;
  if (!count) {
    render(bar, '');
    return;
  }
  render(
    bar,
    html`
      <span class="al-bulk-count">${pluralize(count, 'aula marcada', 'aulas marcadas')}</span>
      <div class="al-bulk-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-bulk-act="clear">${icon('x')}<span>Desmarcar</span></button>
        <button type="button" class="btn btn-secondary btn-sm" data-bulk-act="requeue">
          ${icon('refresh-cw')}<span>Preparar as questões de novo</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-bulk-act="reidentify">
          ${icon('wand-sparkles')}<span>Reidentificar assuntos pelo título</span>
        </button>
      </div>`
  );
}

const resultLabel = {
  atualizada: 'Assuntos atualizados',
  sem_mudanca: 'Sem mudança',
  sem_assunto: 'Ficou como estava',
  erro: 'Erro',
};

function resultBody(result) {
  const parts = [
    result.updated ? pluralize(result.updated, 'aula atualizada', 'aulas atualizadas') : '',
    result.unchanged ? pluralize(result.unchanged, 'já estava certa', 'já estavam certas') : '',
    result.unidentified ? pluralize(result.unidentified, 'sem assunto no título', 'sem assunto no título') : '',
    result.failed ? pluralize(result.failed, 'com erro', 'com erro') : '',
    result.not_found ? pluralize(result.not_found, 'não encontrada', 'não encontradas') : '',
  ].filter(Boolean);
  const items = Array.isArray(result.items) ? result.items : [];
  return html`
    <p class="al-reid-summary">${parts.join(' · ')}.</p>
    ${result.updated ? html`<p class="hint">Nas aulas que mudaram de assunto, as três questões voltam a ser preparadas.</p>` : ''}
    <ul class="al-reid-list">
      ${items.map((item) => {
        const topics = item.lesson ? lessonTopics(item.lesson) : [];
        const tone = { atualizada: 'green', sem_mudanca: 'gray', sem_assunto: 'orange', erro: 'red' }[item.status] || 'gray';
        return html`
          <li>
            <div class="al-reid-head">
              <a href="/admin/aulas/${item.id}">${item.title}</a>
              ${badge(resultLabel[item.status] || item.status, tone)}
            </div>
            ${item.message
              ? html`<p class="hint">${item.message}</p>`
              : topics.length
                ? html`<p class="hint">${topics.map(topicName).join(' · ')}</p>`
                : ''}
          </li>`;
      })}
    </ul>`;
}

async function reidentifySelected(trigger) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (ids.length > MAX_REIDENTIFY) {
    toast(`Marque no máximo ${MAX_REIDENTIFY} aulas por vez: há ${ids.length} marcadas.`, { type: 'warning' });
    return;
  }
  const ok = await confirm({
    title: 'Reidentificar assuntos pelo título',
    message: `${ids.length === 1 ? 'A aula marcada fica' : `As ${ids.length} aulas marcadas ficam`} com os assuntos que o título traz (até 3), no lugar dos atuais. Aula cujo título não traz assunto fica como está. Quando os assuntos mudam, as três questões da aula voltam a ser preparadas.`,
    confirmText: 'Reidentificar',
    icon: 'wand-sparkles',
  });
  if (!ok || !state) return;
  if (trigger) setLoading(trigger, true);
  try {
    const result = await api.post('/api/admin/lessons/reidentify', { ids });
    if (!state) return;
    state.selected.clear();
    paintBulk();
    state.table?.reload();
    modal({
      title: 'Assuntos reidentificados',
      body: resultBody(result),
      size: 'lg',
      actions: [{ label: 'Fechar', variant: 'primary' }],
    });
  } catch (err) {
    if (trigger && state) setLoading(trigger, false);
    toast((err && err.message) || 'Não foi possível reidentificar os assuntos.', { type: 'error' });
  }
}

async function reidentifyOne(row, table) {
  try {
    const item = await api.post(`/api/admin/lessons/${row.id}/reidentify`, {});
    const topics = item.lesson ? lessonTopics(item.lesson) : [];
    if (item.status === 'atualizada') {
      toast(`Assuntos de "${truncate(row.title, 60)}": ${topics.map(topicName).join(', ')}.`, { type: 'success' });
    } else if (item.status === 'sem_mudanca') {
      toast('O título trouxe os mesmos assuntos que a aula já tinha.', { type: 'info' });
    } else {
      toast(item.message || 'Nenhum assunto reconhecido no título. A aula ficou como estava.', { type: item.status === 'erro' ? 'error' : 'warning' });
    }
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível reidentificar os assuntos.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Preparar as questões de novo
// ---------------------------------------------------------------------

async function requeueSelected(trigger) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (ids.length > MAX_REQUEUE) {
    toast(`Marque no máximo ${MAX_REQUEUE} aulas por vez: há ${ids.length} marcadas.`, { type: 'warning' });
    return;
  }
  if (trigger) setLoading(trigger, true);
  try {
    const result = await api.post('/api/admin/lessons/requeue-questions', { ids });
    if (!state) return;
    state.selected.clear();
    paintBulk();
    state.table?.reload();
    const parts = [
      result.queued ? `${pluralize(result.queued, 'aula voltou', 'aulas voltaram')} para a fila de questões` : '',
      result.unchanged ? `${pluralize(result.unchanged, 'já estava', 'já estavam')} na fila ou sendo preparada${result.unchanged === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    toast(`${parts.join('; ')}.`, { type: result.queued ? 'success' : 'info' });
  } catch (err) {
    if (trigger && state) setLoading(trigger, false);
    toast((err && err.message) || 'Não foi possível pôr as aulas na fila.', { type: 'error' });
  }
}

async function requeueOne(row, table) {
  if (!REQUEUEABLE.has(row.questions_status)) {
    toast('As questões desta aula já estão na fila ou sendo preparadas agora.', { type: 'info' });
    return;
  }
  try {
    await api.post(`/api/admin/lessons/${row.id}/requeue-questions`, {});
    toast(`As questões de "${truncate(row.title, 60)}" voltaram para a fila. Só o que falta é pedido à IA.`, { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível pôr a aula na fila.', { type: 'error' });
  }
}

function view() {
  return html`
    ${pageHeader({
      title: 'Aulas',
      subtitle: 'Videoaulas da biblioteca, com os assuntos de cada uma, as provas em que caem e o resumo em markdown.',
      actions: html`
        <a class="btn btn-secondary" href="/admin/conteudo">${icon('list-tree')}<span>Conteúdo</span></a>
        <a class="btn btn-secondary" href="/admin/aulas/enviar">${icon('upload')}<span>Enviar em massa</span></a>
        <a class="btn btn-primary" href="/admin/aulas/nova">${icon('plus')}<span>Nova aula</span></a>`,
    })}
    <section class="card">
      <div class="card-body">
        <div class="al-bulk" data-bulk hidden></div>
        <div data-table></div>
      </div>
    </section>`;
}

async function renderLessonsPage(ctx) {
  ctx.setTitle('Aulas');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-lessons');
  state = { ctx, token, table: null, selected: new Set(), off: [] };

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
      {
        key: 'pick',
        label: html`<label class="al-pick" title="Marcar as aulas desta página">
          <input type="checkbox" data-pick-page aria-label="Marcar as aulas desta página"></label>`,
        width: 40,
        render: pickCell,
        className: 'al-col-pick',
      },
      { key: 'thumbnail_url', label: '', width: 84, render: thumbCell, className: 'al-col-thumb' },
      { key: 'title', label: 'Aula', sortable: true, render: titleCell },
      { key: 'subject_name', label: 'Matéria e assuntos', sortable: true, render: classificationCell },
      { key: 'exams', label: 'Provas', render: examsCell },
      { key: 'questions_status', label: 'Questões', render: questionsCell, nowrap: true },
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
    onPaint: (items) => {
      if (state) syncPageBox(items);
    },
    onRowClick: (row) => ctx.navigate(`/admin/aulas/${row.id}`),
    rowActions: [
      { label: 'Editar aula', icon: 'square-pen', onClick: (row) => ctx.navigate(`/admin/aulas/${row.id}`) },
      { label: 'Reidentificar assuntos pelo título', icon: 'wand-sparkles', onClick: (row, table) => reidentifyOne(row, table) },
      { label: 'Preparar as questões de novo', icon: 'refresh-cw', onClick: (row, table) => requeueOne(row, table) },
      { label: 'Questões do assunto principal', icon: 'file-text', onClick: (row) => ctx.navigate(`/admin/questoes?topic_id=${encodeURIComponent(row.topic_id)}`) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleActive(row, table) },
      { label: 'Excluir aula', icon: 'trash-2', danger: true, onClick: (row, table) => removeLesson(row, table) },
    ],
  });

  // A marcação sobrevive à troca de página e aos filtros: dá para juntar aulas
  // de várias páginas antes de reidentificar.
  state.off.push(
    on(ctx.el, 'change', '[data-pick]', (event, box) => {
      if (box.checked) state.selected.add(box.dataset.pick);
      else state.selected.delete(box.dataset.pick);
      syncPageBox();
      paintBulk();
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[data-pick-page]', (event, box) => {
      const items = state.table.getItems();
      for (const row of items) {
        if (box.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
      }
      for (const input of qsa('[data-pick]', ctx.el)) input.checked = state.selected.has(input.dataset.pick);
      syncPageBox(items);
      paintBulk();
    })
  );
  state.off.push(
    on(ctx.el, 'click', '[data-bulk-act]', (event, button) => {
      if (button.dataset.bulkAct === 'clear') {
        state.selected.clear();
        for (const input of qsa('[data-pick]', ctx.el)) input.checked = false;
        syncPageBox();
        paintBulk();
      } else if (button.dataset.bulkAct === 'reidentify') {
        reidentifySelected(button);
      } else if (button.dataset.bulkAct === 'requeue') {
        requeueSelected(button);
      }
    })
  );
}

export default renderLessonsPage;

export function unmount() {
  if (!state) return;
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  if (state.table) state.table.destroy();
  state = null;
}

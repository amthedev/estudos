// =====================================================================
// Foco Elite — Admin › Importar aulas
//
// A equipe grava as aulas no YouTube e cadastra os links. Cadastrar uma a
// uma seria uma tarde inteira, então aqui ela cola a lista inteira, confere
// a prévia (o título, a miniatura e a duração vêm do próprio vídeo) e
// confirma tudo de uma vez dentro do assunto escolhido.
//
// API: POST /api/admin/lessons/import/preview  → metadados, sem gravar
//      POST /api/admin/lessons/import          → cria as aulas
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, qs, qsa, on,
  pageHeader, skeleton, errorState, badge, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, truncate } from '../../core/format.js';

let state = null;

const EXAMPLE = [
  'https://www.youtube.com/watch?v=XXXXXXXXXXX',
  'https://youtu.be/YYYYYYYYYYY | Porcentagem — parte 2',
  'https://vimeo.com/123456789',
].join('\n');

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------
async function loadTopics(subjectId, { keep = '' } = {}) {
  const select = qs('[name="topic_id"]', state.ctx.el);
  const subSelect = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;

  if (!subjectId) {
    state.topics = [];
    select.disabled = true;
    select.innerHTML = '<option value="">Selecione a matéria primeiro</option>';
    if (subSelect) {
      subSelect.disabled = true;
      subSelect.innerHTML = '<option value="">Selecione o assunto primeiro</option>';
    }
    return;
  }

  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  try {
    const data = await api.get(`/api/admin/content/topics`, { query: { subject_id: subjectId, limit: 500 } });
    state.topics = Array.isArray(data) ? data : data.items || [];
  } catch {
    state.topics = [];
  }
  select.disabled = false;
  select.innerHTML =
    '<option value="">Selecione o assunto</option>' +
    state.topics.map((topic) => `<option value="${topic.id}">${topic.name}</option>`).join('');
  if (keep) select.value = keep;
  await loadSubtopics(select.value);
}

async function loadSubtopics(topicId) {
  const select = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;
  if (!topicId) {
    select.disabled = true;
    select.innerHTML = '<option value="">Selecione o assunto primeiro</option>';
    return;
  }
  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  try {
    const data = await api.get('/api/admin/content/subtopics', { query: { topic_id: topicId, limit: 500 } });
    state.subtopics = Array.isArray(data) ? data : data.items || [];
  } catch {
    state.subtopics = [];
  }
  select.disabled = false;
  select.innerHTML =
    '<option value="">Sem subassunto</option>' +
    state.subtopics.map((item) => `<option value="${item.id}">${item.name}</option>`).join('');
}

/** Lê a classificação e as opções que valem para todas as aulas da lista. */
function collectSettings() {
  const el = state.ctx.el;
  const value = (name) => qs(`[name="${name}"]`, el)?.value?.trim() || '';
  return {
    subject_id: value('subject_id'),
    topic_id: value('topic_id'),
    subtopic_id: value('subtopic_id') || undefined,
    teacher_name: value('teacher_name') || undefined,
    difficulty: Number(value('difficulty')) || 2,
    duration_min: Number(value('duration_min')) || undefined,
    active: qs('[name="active"]', el)?.checked !== false,
    exam_ids: qsa('[data-exam-id]:checked', el).map((box) => box.dataset.examId),
  };
}

// ---------------------------------------------------------------------
// Prévia
// ---------------------------------------------------------------------
async function preview() {
  const text = qs('[name="links"]', state.ctx.el)?.value || '';
  if (!text.trim()) {
    toast('Cole ao menos um link de vídeo.', { type: 'warning' });
    return;
  }
  const button = qs('[data-act="preview"]', state.ctx.el);
  setLoading(button, true);
  try {
    const data = await api.post('/api/admin/lessons/import/preview', { text });
    state.preview = data;
    paintPreview();
    if (!data.ready) {
      toast('Nenhum link novo para importar. Confira a lista abaixo.', { type: 'warning' });
    }
  } catch (err) {
    toast((err && err.message) || 'Não foi possível analisar os links.', { type: 'error' });
  } finally {
    setLoading(button, false);
  }
}

function itemStatus(item) {
  if (!item.valid) return badge('Link inválido', 'red');
  if (item.duplicated_in_list) return badge('Repetido na lista', 'orange');
  if (item.already_registered) return badge('Já cadastrada', 'gray');
  return badge('Pronta', 'green');
}

function previewRow(item, index) {
  const usable = item.valid && !item.already_registered && !item.duplicated_in_list;
  return html`
    <tr class="${usable ? '' : 'li-row-off'}">
      <td class="li-check">
        <input type="checkbox" data-item="${index}" ${usable ? raw('checked') : raw('disabled')}>
      </td>
      <td class="li-thumb">
        ${item.thumbnail_url
          ? html`<img src="${item.thumbnail_url}" alt="" loading="lazy">`
          : html`<span class="li-thumb-empty">${icon('square-play')}</span>`}
      </td>
      <td>
        <input class="input li-title" type="text" data-title="${index}" value="${item.title || ''}"
               maxlength="200" placeholder="Título da aula" ${usable ? '' : raw('disabled')}>
        <span class="li-url">${truncate(item.url, 70)}</span>
        ${item.already_registered && item.existing_title
          ? html`<span class="li-url">Já cadastrada como: ${truncate(item.existing_title, 60)}</span>`
          : ''}
      </td>
      <td class="li-duration">${item.duration_min ? fmtMinutes(item.duration_min) : html`<span class="dt-muted">—</span>`}</td>
      <td class="li-status">${itemStatus(item)}</td>
    </tr>`;
}

function paintPreview() {
  const box = qs('#li-preview', state.ctx.el);
  if (!box) return;
  const data = state.preview;
  if (!data) {
    render(box, '');
    return;
  }

  render(
    box,
    html`
      <section class="card li-preview">
        <div class="card-header">
          <div>
            <h2 class="card-title">Confira antes de importar</h2>
            <p class="hint">${data.ready} de ${data.total} prontas para cadastrar. Você pode ajustar os títulos aqui.</p>
          </div>
          <button type="button" class="btn btn-primary" data-act="import" ${data.ready ? '' : raw('disabled')}>
            ${icon('check-check')}<span>Importar selecionadas</span>
          </button>
        </div>
        <div class="card-body">
          <div class="table-wrap">
            <table class="table li-table">
              <thead>
                <tr>
                  <th scope="col" class="li-check"><span class="sr-only">Importar</span></th>
                  <th scope="col"><span class="sr-only">Miniatura</span></th>
                  <th scope="col">Aula</th>
                  <th scope="col">Duração</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>${data.items.map((item, index) => previewRow(item, index))}</tbody>
            </table>
          </div>
        </div>
      </section>`
  );
}

// ---------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------
async function runImport() {
  const settings = collectSettings();
  if (!settings.subject_id || !settings.topic_id) {
    toast('Escolha a matéria e o assunto das aulas.', { type: 'warning' });
    qs('[name="subject_id"]', state.ctx.el)?.focus();
    return;
  }

  const items = [];
  for (const box of qsa('[data-item]', state.ctx.el)) {
    if (!box.checked) continue;
    const index = Number(box.dataset.item);
    const source = state.preview.items[index];
    const title = qs(`[data-title="${index}"]`, state.ctx.el)?.value?.trim() || source.title || '';
    items.push({ url: source.url, title, duration_min: source.duration_min || undefined, thumbnail_url: source.thumbnail_url || undefined });
  }
  if (!items.length) {
    toast('Selecione pelo menos uma aula.', { type: 'warning' });
    return;
  }

  const button = qs('[data-act="import"]', state.ctx.el);
  setLoading(button, true);
  try {
    const result = await api.post('/api/admin/lessons/import', { ...settings, items });
    state.result = result;
    paintResult();
    toast(
      result.imported
        ? `${result.imported} ${result.imported === 1 ? 'aula cadastrada' : 'aulas cadastradas'}.`
        : 'Nenhuma aula foi cadastrada.',
      { type: result.imported ? 'success' : 'warning' }
    );
  } catch (err) {
    toast((err && err.message) || 'Não foi possível importar.', { type: 'error' });
  } finally {
    setLoading(button, false);
  }
}

function paintResult() {
  const box = qs('#li-result', state.ctx.el);
  if (!box || !state.result) return;
  const { imported, failed, created, errors } = state.result;
  render(
    box,
    html`
      <section class="card li-result">
        <div class="card-body">
          <h2 class="card-title">${imported} ${imported === 1 ? 'aula cadastrada' : 'aulas cadastradas'}</h2>
          ${failed ? html`<p class="hint">${failed} ${failed === 1 ? 'linha não entrou' : 'linhas não entraram'}.</p>` : ''}

          ${created.length
            ? html`<ul class="li-created">
                ${created.map((item) => html`
                  <li>${icon('check-check')}<span>${item.title}</span></li>`)}
              </ul>`
            : ''}

          ${errors.length
            ? html`<ul class="li-errors">
                ${errors.map((item) => html`
                  <li>${icon('circle-alert')}<span><strong>Linha ${item.line}</strong> — ${item.message}</span></li>`)}
              </ul>`
            : ''}

          <div class="li-result-actions">
            <a class="btn btn-primary" href="/admin/aulas">${icon('play')}<span>Ver as aulas</span></a>
            <button type="button" class="btn btn-secondary" data-act="reset">${icon('plus')}<span>Importar outra lista</span></button>
          </div>
        </div>
      </section>`
  );
}

// ---------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------
function view() {
  const { subjects, exams } = state;
  return html`
    ${pageHeader({
      title: 'Importar aulas',
      subtitle: 'Cole a lista de links do YouTube ou do Vimeo. O título, a miniatura e a duração vêm do próprio vídeo.',
      breadcrumb: [{ label: 'Aulas', href: '/admin/aulas' }, { label: 'Importar' }],
      actions: html`<a class="btn btn-ghost" href="/admin/aulas">${icon('arrow-left')}<span>Voltar</span></a>`,
    })}

    <div class="li-cols">
      <section class="card">
        <div class="card-header"><h2 class="card-title">${icon('link')}<span>Links das aulas</span></h2></div>
        <div class="card-body">
          <div class="field">
            <label class="label" for="li-links">Um link por linha</label>
            <textarea class="textarea li-links" id="li-links" name="links" rows="12" spellcheck="false"
                      placeholder="${EXAMPLE}"></textarea>
            <p class="hint">
              Para dar um título à mão, escreva o link, uma barra vertical e o título.
              Linhas começadas por # são ignoradas. Até 200 aulas por vez.
            </p>
          </div>
          <button type="button" class="btn btn-secondary" data-act="preview">
            ${icon('eye')}<span>Analisar links</span>
          </button>
        </div>
      </section>

      <aside class="card">
        <div class="card-header"><h2 class="card-title">${icon('list-tree')}<span>Vale para todas</span></h2></div>
        <div class="card-body li-settings">
          <div class="field">
            <label class="label" for="li-subject">Matéria <span class="req">*</span></label>
            <select class="select" id="li-subject" name="subject_id">
              <option value="">Selecione a matéria</option>
              ${subjects.map((subject) => html`<option value="${subject.id}">${subject.name}</option>`)}
            </select>
          </div>
          <div class="field">
            <label class="label" for="li-topic">Assunto <span class="req">*</span></label>
            <select class="select" id="li-topic" name="topic_id" disabled>
              <option value="">Selecione a matéria primeiro</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="li-subtopic">Subassunto <span class="hint-inline">(opcional)</span></label>
            <select class="select" id="li-subtopic" name="subtopic_id" disabled>
              <option value="">Selecione o assunto primeiro</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="li-teacher">Professor <span class="hint-inline">(opcional)</span></label>
            <input class="input" id="li-teacher" name="teacher_name" maxlength="120" placeholder="Nome de quem grava">
          </div>
          <div class="li-row">
            <div class="field">
              <label class="label" for="li-difficulty">Dificuldade</label>
              <select class="select" id="li-difficulty" name="difficulty">
                <option value="1">Básico</option>
                <option value="2" selected>Intermediário</option>
                <option value="3">Avançado</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="li-duration">Duração padrão</label>
              <input class="input" id="li-duration" name="duration_min" type="number" min="1" max="600" step="1" value="30">
              <p class="hint">Usada só quando o vídeo não informa a duração.</p>
            </div>
          </div>
          <label class="switch-field">
            <span class="switch-title">Aulas ativas</span>
            <input type="checkbox" role="switch" class="switch" name="active" checked>
          </label>

          <div class="field">
            <span class="label">Provas em que caem</span>
            ${exams.length
              ? html`<div class="li-exams">
                  ${exams.map((exam) => html`
                    <label class="chip li-exam">
                      <input type="checkbox" data-exam-id="${exam.id}">
                      <span>${exam.short_name || exam.name}</span>
                    </label>`)}
                </div>`
              : html`<p class="hint">Nenhum vestibular cadastrado.</p>`}
          </div>
        </div>
      </aside>
    </div>

    <div id="li-preview"></div>
    <div id="li-result"></div>`;
}

async function renderLessonsImport(ctx) {
  ctx.setTitle('Importar aulas');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-lessons-import');
  state = { ctx, token, subjects: [], topics: [], subtopics: [], exams: [], preview: null, result: null, off: [] };

  try {
    const [subjects, exams] = await Promise.all([
      api.get('/api/admin/content/subjects', { query: { limit: 200 } }).then((d) => (Array.isArray(d) ? d : d.items || [])),
      api.get('/api/admin/exams').then((d) => (Array.isArray(d) ? d : d.items || [])),
    ]);
    if (!state || state.token !== token) return;
    state.subjects = subjects;
    state.exams = exams;
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Importar aulas' })}
        ${errorState({
          title: 'Não foi possível carregar as matérias',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
          retry: 'reload-import',
        })}`
    );
    const button = qs('[data-action="reload-import"]', ctx.el);
    if (button) button.addEventListener('click', () => renderLessonsImport(ctx));
    return;
  }

  render(ctx.el, view());

  // pré-seleção pela query, quando vem de um assunto específico
  const query = ctx.query || {};
  if (query.subject_id) {
    const subjectSelect = qs('[name="subject_id"]', ctx.el);
    if (subjectSelect) subjectSelect.value = query.subject_id;
    await loadTopics(query.subject_id, { keep: query.topic_id || '' });
    if (!state || state.token !== token) return;
  }

  state.off.push(
    on(ctx.el, 'change', '[name="subject_id"]', (event, select) => {
      state.preview = null;
      paintPreview();
      loadTopics(select.value);
    })
  );
  state.off.push(on(ctx.el, 'change', '[name="topic_id"]', (event, select) => loadSubtopics(select.value)));
  state.off.push(
    on(ctx.el, 'click', '[data-act]', (event, button) => {
      event.preventDefault();
      const act = button.dataset.act;
      if (act === 'preview') preview();
      else if (act === 'import') runImport();
      else if (act === 'reset') {
        state.preview = null;
        state.result = null;
        const links = qs('[name="links"]', ctx.el);
        if (links) links.value = '';
        paintPreview();
        render(qs('#li-result', ctx.el), '');
        links?.focus();
      }
    })
  );
}

export default renderLessonsImport;

export function unmount() {
  if (!state) return;
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

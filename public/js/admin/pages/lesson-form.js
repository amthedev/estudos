// =====================================================================
// Foco Elite — Admin › Nova aula / Editar aula (ARCHITECTURE §6.5)
//
// Formulário em duas colunas: à esquerda os dados e o campo de vídeo, que
// mostra a prévia com components/video-player.js assim que a URL é colada
// (POST /api/admin/lessons/parse-video); à direita a classificação encadeada
// (matéria → assunto → subassunto), dificuldade, ordem, provas em que cai e
// situação. O resumo é escrito em markdown com prévia.
//
// "Salvar e criar questões" leva para /admin/questoes/nova já com o assunto.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, qs, qsa, on,
  pageHeader, skeleton, errorState, setLoading, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtMinutes } from '../../core/format.js';
import { renderVideo } from '../../components/video-player.js';

const PARSE_DEBOUNCE_MS = 600;

const DIFFICULTIES = [
  { value: 1, label: 'Básico' },
  { value: 2, label: 'Intermediário' },
  { value: 3, label: 'Avançado' },
];

let state = null;

// ---------------------------------------------------------------------
// Leitura do formulário
// ---------------------------------------------------------------------
const val = (name) => {
  const el = qs(`[name="${name}"]`, state.ctx.el);
  return el ? String(el.value || '').trim() : '';
};

const checked = (name) => {
  const el = qs(`[name="${name}"]`, state.ctx.el);
  return Boolean(el && el.checked);
};

function selectedExamIds() {
  return qsa('[data-exam-id]:checked', state.ctx.el).map((input) => input.dataset.examId);
}

function collect() {
  const durationRaw = val('duration_min');
  const orderRaw = val('sort_order');
  return {
    title: val('title'),
    description: val('description') || null,
    teacher_name: val('teacher_name') || null,
    video_url: val('video_url') || null,
    thumbnail_url: val('thumbnail_url') || null,
    duration_min: durationRaw ? Number(durationRaw) : 30,
    summary: qs('[name="summary"]', state.ctx.el)?.value || null,
    subject_id: val('subject_id'),
    topic_id: val('topic_id'),
    subtopic_id: val('subtopic_id') || null,
    difficulty: Number(val('difficulty')) || 2,
    sort_order: orderRaw ? Number(orderRaw) : undefined,
    active: checked('active'),
    exam_ids: selectedExamIds(),
  };
}

function showErrors(err) {
  qsa('[data-error-for]', state.ctx.el).forEach((el) => {
    el.textContent = '';
  });
  qsa('.is-invalid', state.ctx.el).forEach((el) => el.classList.remove('is-invalid'));
  const details = err instanceof ApiError ? err.details : null;
  if (!Array.isArray(details)) return;
  for (const detail of details) {
    const path = Array.isArray(detail.path) ? detail.path[detail.path.length - 1] : String(detail.path || '').split('.').pop();
    const target = qs(`[data-error-for="${path}"]`, state.ctx.el);
    if (target) target.textContent = detail.message;
    const field = qs(`[name="${path}"]`, state.ctx.el);
    if (field) field.classList.add('is-invalid');
  }
}

// ---------------------------------------------------------------------
// Selects encadeados
// ---------------------------------------------------------------------
function optionsHtml(items, selected, placeholder) {
  return html`
    <option value="">${placeholder}</option>
    ${items.map((item) => html`<option value="${item.id}" ${item.id === selected ? raw('selected') : ''}>${item.name}${item.active === false ? ' (inativo)' : ''}</option>`)}`;
}

async function loadTopics(subjectId, { keep = null, keepSubtopic = null } = {}) {
  const select = qs('[name="topic_id"]', state.ctx.el);
  if (!select) return;
  if (!subjectId) {
    state.topics = [];
    render(select, optionsHtml([], null, 'Selecione a matéria primeiro'));
    select.disabled = true;
    await loadSubtopics(null);
    return;
  }
  select.disabled = true;
  render(select, html`<option value="">Carregando…</option>`);
  try {
    state.topics = await api.get('/api/admin/content/topics', { query: { subject_id: subjectId } });
  } catch {
    state.topics = [];
    toast('Não foi possível carregar os assuntos desta matéria.', { type: 'error' });
  }
  const selected = keep && state.topics.some((t) => t.id === keep) ? keep : null;
  render(select, optionsHtml(state.topics, selected, 'Selecione o assunto'));
  select.disabled = false;
  select.value = selected || '';
  await loadSubtopics(selected, { keep: keepSubtopic });
}

async function loadSubtopics(topicId, { keep = null } = {}) {
  const select = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;
  if (!topicId) {
    state.subtopics = [];
    render(select, optionsHtml([], null, 'Selecione o assunto primeiro'));
    select.disabled = true;
    return;
  }
  select.disabled = true;
  render(select, html`<option value="">Carregando…</option>`);
  try {
    state.subtopics = await api.get('/api/admin/content/subtopics', { query: { topic_id: topicId } });
  } catch {
    state.subtopics = [];
  }
  const selected = keep && state.subtopics.some((st) => st.id === keep) ? keep : null;
  render(select, optionsHtml(state.subtopics, selected, state.subtopics.length ? 'Sem subassunto' : 'Nenhum subassunto cadastrado'));
  select.disabled = false;
  select.value = selected || '';
}

// ---------------------------------------------------------------------
// Vídeo
// ---------------------------------------------------------------------
function paintVideo() {
  const box = qs('[data-video-preview]', state.ctx.el);
  const meta = qs('[data-video-meta]', state.ctx.el);
  if (!box) return;
  const url = val('video_url');
  if (!url) {
    render(box, html`
      <div class="af-video-empty">
        ${icon('film', { size: 26 })}
        <p>Cole o link do YouTube, do Vimeo ou de um arquivo de vídeo para ver a prévia aqui.</p>
      </div>`);
    if (meta) render(meta, '');
    return;
  }
  const info = state.video || {};
  renderVideo(box, {
    video_url: info.url || url,
    video_provider: info.provider || 'external',
    thumbnail_url: val('thumbnail_url') || info.thumbnail_url || null,
    title: val('title'),
  });
  if (meta) {
    const providerLabel = { youtube: 'YouTube', vimeo: 'Vimeo', external: 'Vídeo externo', none: 'Link não reconhecido' }[info.provider || 'external'];
    render(meta, html`
      ${badge(providerLabel, info.provider === 'none' ? 'orange' : 'blue', { icon: info.provider === 'none' ? 'triangle-alert' : 'circle-play' })}
      ${info.duration_min ? badge(fmtMinutes(info.duration_min), 'gray', { icon: 'clock' }) : ''}
      ${info.provider === 'none' ? html`<span class="hint">O endereço não parece um vídeo. A aula será salva sem player.</span>` : ''}`);
  }
}

async function parseVideo({ fillEmpty = true } = {}) {
  const url = val('video_url');
  const status = qs('[data-video-status]', state.ctx.el);
  if (!url) {
    state.video = null;
    if (status) status.textContent = '';
    paintVideo();
    return;
  }
  if (status) status.textContent = 'Analisando o link…';
  try {
    const info = await api.post('/api/admin/lessons/parse-video', { url });
    if (!state) return;
    state.video = info;
    if (fillEmpty) {
      const titleEl = qs('[name="title"]', state.ctx.el);
      if (titleEl && !titleEl.value.trim() && info.title) titleEl.value = info.title;
      const thumbEl = qs('[name="thumbnail_url"]', state.ctx.el);
      if (thumbEl && !thumbEl.value.trim() && info.thumbnail_url) thumbEl.value = info.thumbnail_url;
      const durationEl = qs('[name="duration_min"]', state.ctx.el);
      if (durationEl && info.duration_min && (!durationEl.value || durationEl.value === '30')) durationEl.value = String(info.duration_min);
    }
    if (status) status.textContent = '';
    paintVideo();
  } catch (err) {
    if (status) status.textContent = '';
    toast((err && err.message) || 'Não foi possível analisar o link do vídeo.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Resumo em markdown
// ---------------------------------------------------------------------
function switchSummaryTab(mode) {
  const input = qs('[name="summary"]', state.ctx.el);
  const preview = qs('[data-md-preview]', state.ctx.el);
  if (!input || !preview) return;
  const showPreview = mode === 'preview';
  qsa('[data-md-tab]', state.ctx.el).forEach((tab) => {
    const active = tab.dataset.mdTab === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (showPreview) {
    const source = input.value.trim();
    render(preview, source ? raw(md(source)) : html`<p class="hint">Nada para pré-visualizar. Escreva o resumo na aba "Escrever".</p>`);
  }
  input.hidden = showPreview;
  preview.hidden = !showPreview;
  if (!showPreview) input.focus();
}

// ---------------------------------------------------------------------
// Salvar e excluir
// ---------------------------------------------------------------------
async function save({ then = 'list' } = {}) {
  const data = collect();
  if (!data.title || data.title.length < 3) {
    const target = qs('[data-error-for="title"]', state.ctx.el);
    if (target) target.textContent = 'Informe um título com pelo menos 3 caracteres.';
    qs('[name="title"]', state.ctx.el)?.focus();
    return;
  }
  if (!data.subject_id || !data.topic_id) {
    const target = qs('[data-error-for="topic_id"]', state.ctx.el);
    if (target) target.textContent = 'Escolha a matéria e o assunto da aula.';
    qs('[name="subject_id"]', state.ctx.el)?.focus();
    toast('Classifique a aula em uma matéria e um assunto.', { type: 'warning' });
    return;
  }
  if (data.sort_order === undefined) delete data.sort_order;

  const buttons = qsa('[data-act="save"], [data-act="save-questions"]', state.ctx.el);
  buttons.forEach((button) => setLoading(button, true));
  try {
    const saved = state.id
      ? await api.put(`/api/admin/lessons/${state.id}`, data)
      : await api.post('/api/admin/lessons', data);
    toast(state.id ? 'Aula salva.' : 'Aula criada.', { type: 'success' });
    if (then === 'questions') {
      state.ctx.navigate(`/admin/questoes/nova?subject_id=${encodeURIComponent(saved.subject_id)}&topic_id=${encodeURIComponent(saved.topic_id)}${saved.subtopic_id ? `&subtopic_id=${encodeURIComponent(saved.subtopic_id)}` : ''}`);
      return;
    }
    state.ctx.navigate('/admin/aulas');
  } catch (err) {
    buttons.forEach((button) => setLoading(button, false));
    showErrors(err);
    toast((err && err.message) || 'Não foi possível salvar a aula.', { type: 'error' });
  }
}

async function removeLesson() {
  const ok = await confirm({
    title: 'Excluir aula',
    message: 'A aula e o progresso registrado pelos alunos nela serão excluídos. Esta ação não pode ser desfeita.',
    danger: true,
    confirmText: 'Excluir aula',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/lessons/${state.id}`);
    toast('Aula excluída.', { type: 'success' });
    state.ctx.navigate('/admin/aulas');
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir a aula.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------
function view() {
  const lesson = state.lesson || {};
  const editing = Boolean(state.id);
  const examIds = new Set(Array.isArray(lesson.exam_ids) ? lesson.exam_ids : []);
  const stats = lesson.progress_stats || null;

  return html`
    ${pageHeader({
      title: editing ? 'Editar aula' : 'Nova aula',
      subtitle: editing ? lesson.title : 'Cadastre a videoaula, classifique no conteúdo e escolha as provas em que ela cai.',
      breadcrumb: [{ label: 'Aulas', href: '/admin/aulas' }, { label: editing ? 'Editar' : 'Nova aula' }],
      actions: html`
        <a class="btn btn-ghost" href="/admin/aulas">${icon('arrow-left')}<span>Voltar</span></a>
        ${editing ? html`<button type="button" class="btn btn-danger" data-act="delete">${icon('trash-2')}<span>Excluir</span></button>` : ''}
        <button type="button" class="btn btn-secondary" data-act="save-questions">${icon('file-text')}<span>Salvar e criar questões</span></button>
        <button type="button" class="btn btn-primary" data-act="save">${icon('save')}<span>Salvar</span></button>`,
    })}

    <form class="af-form" novalidate autocomplete="off">
      <div class="af-cols">
        <div class="af-main">
          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('play')}<span>Dados da aula</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="af-title">Título da aula</label>
                <input class="input" id="af-title" name="title" value="${lesson.title || ''}" maxlength="200" required placeholder="Ex.: Função quadrática — gráfico e raízes">
                <p class="error-text" data-error-for="title"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="af-description">Descrição curta <span class="hint-inline">(opcional)</span></label>
                <textarea class="textarea" id="af-description" name="description" rows="2" maxlength="2000" placeholder="Uma linha sobre o que o aluno vai aprender.">${lesson.description || ''}</textarea>
                <p class="error-text" data-error-for="description"></p>
              </div>
              <div class="field">
                <label class="label" for="af-teacher">Professor <span class="hint-inline">(opcional)</span></label>
                <input class="input" id="af-teacher" name="teacher_name" value="${lesson.teacher_name || ''}" maxlength="120" placeholder="Nome de quem grava a aula">
              </div>
              <div class="field">
                <label class="label" for="af-duration">Duração (minutos)</label>
                <input class="input" id="af-duration" name="duration_min" type="number" min="1" max="600" step="1" value="${lesson.duration_min ?? 30}">
                <p class="error-text" data-error-for="duration_min"></p>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('video')}<span>Vídeo</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="af-video">Link do vídeo</label>
                <div class="af-video-input">
                  <input class="input" id="af-video" name="video_url" value="${lesson.video_url || ''}" maxlength="2000"
                    placeholder="https://www.youtube.com/watch?v=… ou https://vimeo.com/…" inputmode="url" spellcheck="false">
                  <button type="button" class="btn btn-secondary" data-act="parse-video">${icon('refresh-cw')}<span>Analisar</span></button>
                </div>
                <p class="hint" data-video-status></p>
                <p class="error-text" data-error-for="video_url"></p>
              </div>
              <div class="af-w-full af-video-box">
                <div data-video-preview></div>
                <div class="af-video-meta" data-video-meta></div>
              </div>
              <div class="field af-w-full">
                <label class="label" for="af-thumb">Miniatura <span class="hint-inline">(preenchida automaticamente quando possível)</span></label>
                <input class="input" id="af-thumb" name="thumbnail_url" value="${lesson.thumbnail_url || ''}" maxlength="2000" placeholder="https://…" inputmode="url" spellcheck="false">
                <p class="error-text" data-error-for="thumbnail_url"></p>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('notebook-pen')}<span>Resumo da aula</span></h2></div>
            <div class="card-body">
              <div class="af-md">
                <div class="tabs tabs-pills af-md-tabs" role="tablist" aria-label="Modo de edição do resumo">
                  <button type="button" role="tab" class="tab active" aria-selected="true" data-md-tab="write">${icon('pencil', { size: 14 })}<span>Escrever</span></button>
                  <button type="button" role="tab" class="tab" aria-selected="false" data-md-tab="preview">${icon('eye', { size: 14 })}<span>Prévia</span></button>
                </div>
                <textarea class="textarea af-md-input" name="summary" rows="12" spellcheck="true"
                  placeholder="Resumo em markdown: **negrito**, listas, títulos e fórmulas em texto.">${lesson.summary || ''}</textarea>
                <div class="af-md-preview md" data-md-preview hidden></div>
                <p class="hint">O resumo aparece abaixo do player, na tela da aula do aluno.</p>
              </div>
            </div>
          </section>
        </div>

        <aside class="af-side">
          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('list-tree')}<span>Classificação</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="af-subject">Matéria</label>
                <select class="select" id="af-subject" name="subject_id">
                  ${optionsHtml(state.subjects, lesson.subject_id || null, 'Selecione a matéria')}
                </select>
                <p class="error-text" data-error-for="subject_id"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="af-topic">Assunto</label>
                <select class="select" id="af-topic" name="topic_id" disabled>
                  <option value="">Selecione a matéria primeiro</option>
                </select>
                <p class="error-text" data-error-for="topic_id"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="af-subtopic">Subassunto <span class="hint-inline">(opcional)</span></label>
                <select class="select" id="af-subtopic" name="subtopic_id" disabled>
                  <option value="">Selecione o assunto primeiro</option>
                </select>
                <p class="error-text" data-error-for="subtopic_id"></p>
              </div>
              <div class="field">
                <label class="label" for="af-difficulty">Dificuldade</label>
                <select class="select" id="af-difficulty" name="difficulty">
                  ${DIFFICULTIES.map((d) => html`<option value="${d.value}" ${Number(lesson.difficulty ?? 2) === d.value ? raw('selected') : ''}>${d.label}</option>`)}
                </select>
              </div>
              <div class="field">
                <label class="label" for="af-order">Ordem no assunto</label>
                <input class="input" id="af-order" name="sort_order" type="number" min="0" max="100000" step="1" value="${lesson.sort_order ?? ''}" placeholder="Automático">
              </div>
              <label class="switch-field af-w-full">
                <span class="fm-switch-text">
                  <span class="switch-title">Aula ativa</span>
                  <span class="hint">Aulas inativas ficam invisíveis para o aluno.</span>
                </span>
                <input type="checkbox" role="switch" class="switch" name="active" ${lesson.active === false ? '' : raw('checked')}>
              </label>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('graduation-cap')}<span>Provas em que cai</span></h2></div>
            <div class="card-body">
              ${state.exams.length ? html`
                <div class="af-checks" role="group" aria-label="Provas em que a aula cai">
                  ${state.exams.map((exam) => html`
                    <label class="check">
                      <input type="checkbox" data-exam-id="${exam.id}" ${examIds.has(exam.id) ? raw('checked') : ''}>
                      <span>${exam.short_name || exam.name}</span>
                    </label>`)}
                </div>
                <p class="hint mt-3">Marcar uma prova aqui também inclui o assunto no conteúdo programático dela.</p>`
                : html`<p class="hint">Nenhum vestibular cadastrado. <a href="/admin/vestibulares">Cadastrar agora</a>.</p>`}
            </div>
          </section>

          ${stats ? html`
            <section class="card">
              <div class="card-body af-stats">
                <div><span class="af-stat-value">${stats.started ?? 0}</span><span class="af-stat-label">alunos iniciaram</span></div>
                <div><span class="af-stat-value">${stats.completed ?? 0}</span><span class="af-stat-label">concluíram</span></div>
              </div>
            </section>` : ''}
        </aside>
      </div>
    </form>`;
}

function bind(ctx) {
  state.off.push(
    on(ctx.el, 'click', '[data-act]', (event, button) => {
      const act = button.dataset.act;
      if (act === 'save') {
        event.preventDefault();
        save({ then: 'list' });
      } else if (act === 'save-questions') {
        event.preventDefault();
        save({ then: 'questions' });
      } else if (act === 'delete') {
        event.preventDefault();
        removeLesson();
      } else if (act === 'parse-video') {
        event.preventDefault();
        parseVideo({ fillEmpty: true });
      }
    })
  );

  state.off.push(
    on(ctx.el, 'click', '[data-md-tab]', (event, tab) => {
      event.preventDefault();
      switchSummaryTab(tab.dataset.mdTab);
    })
  );

  state.off.push(
    on(ctx.el, 'change', '[name="subject_id"]', (event, select) => {
      loadTopics(select.value);
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[name="topic_id"]', (event, select) => {
      loadSubtopics(select.value);
    })
  );

  state.off.push(
    on(ctx.el, 'input', '[name="video_url"]', () => {
      clearTimeout(state.videoTimer);
      state.videoTimer = setTimeout(() => parseVideo({ fillEmpty: true }), PARSE_DEBOUNCE_MS);
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[name="thumbnail_url"]', () => paintVideo())
  );
  state.off.push(
    on(ctx.el, 'submit', 'form', (event) => {
      event.preventDefault();
      save({ then: 'list' });
    })
  );
}

async function renderLessonForm(ctx) {
  const id = ctx.params && ctx.params.id && ctx.params.id !== 'nova' ? ctx.params.id : null;
  ctx.setTitle(id ? 'Editar aula' : 'Nova aula');
  render(ctx.el, skeleton('form', 6));

  const token = Symbol('admin-lesson-form');
  state = { ctx, token, id, lesson: null, subjects: [], topics: [], subtopics: [], exams: [], video: null, videoTimer: null, off: [] };

  try {
    const [subjects, exams, lesson] = await Promise.all([
      api.get('/api/admin/content/subjects'),
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
      id ? api.get(`/api/admin/lessons/${id}`) : Promise.resolve(null),
    ]);
    if (!state || state.token !== token) return;
    state.subjects = subjects;
    state.exams = exams;
    state.lesson = lesson;
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: id ? 'Editar aula' : 'Nova aula', breadcrumb: [{ label: 'Aulas', href: '/admin/aulas' }, { label: 'Formulário' }] })}
        ${errorState({ title: 'Não foi possível abrir o formulário', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-lesson-form' })}`
    );
    const button = qs('[data-action="reload-lesson-form"]', ctx.el);
    if (button) button.addEventListener('click', () => renderLessonForm(ctx));
    return;
  }

  render(ctx.el, view());
  bind(ctx);

  const query = ctx.query || {};
  const subjectId = state.lesson ? state.lesson.subject_id : query.subject_id || '';
  const topicId = state.lesson ? state.lesson.topic_id : query.topic_id || '';
  const subtopicId = state.lesson ? state.lesson.subtopic_id : query.subtopic_id || '';
  const subjectSelect = qs('[name="subject_id"]', ctx.el);
  if (subjectSelect && subjectId) subjectSelect.value = subjectId;
  if (subjectId) {
    await loadTopics(subjectId, { keep: topicId, keepSubtopic: subtopicId });
    if (!state || state.token !== token) return;
  }

  if (state.lesson && state.lesson.video_url) {
    state.video = {
      provider: state.lesson.video_provider,
      url: state.lesson.video_url,
      thumbnail_url: state.lesson.thumbnail_url,
      duration_min: state.lesson.duration_min,
    };
  }
  paintVideo();
}

export default renderLessonForm;

export function unmount() {
  if (!state) return;
  clearTimeout(state.videoTimer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

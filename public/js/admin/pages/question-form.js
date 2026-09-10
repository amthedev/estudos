// =====================================================================
// Foco Elite — Admin › Nova questão / Editar questão (ARCHITECTURE §6.5)
//
// Enunciado em markdown com prévia, URL de imagem, cinco alternativas com
// seleção da correta, resolução, explicação, classificação encadeada,
// dificuldade, origem (prova, ano, banca) e provas em que cai — com uma
// pré-visualização que mostra a questão como o aluno vai ver.
//
// API: GET|POST|PUT|DELETE /api/admin/questions[/:id], /api/admin/questions/filters
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, qs, qsa, on,
  pageHeader, skeleton, errorState, setLoading, badge,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md, mdInline } from '../../core/markdown.js';
import { difficultyLabel, difficultyTone } from '../../core/format.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const PREVIEW_DEBOUNCE_MS = 350;

const DIFFICULTIES = [
  { value: 1, label: 'Básico' },
  { value: 2, label: 'Intermediário' },
  { value: 3, label: 'Avançado' },
];

let state = null;

// ---------------------------------------------------------------------
// Leitura do formulário
// ---------------------------------------------------------------------
const field = (name) => qs(`[name="${name}"]`, state.ctx.el);
const val = (name) => {
  const el = field(name);
  return el ? String(el.value || '').trim() : '';
};
const rawVal = (name) => {
  const el = field(name);
  return el ? String(el.value || '') : '';
};

function readOptions() {
  return qsa('[data-option-letter]', state.ctx.el).map((row) => {
    const letter = row.dataset.optionLetter;
    const text = qs('textarea', row)?.value.trim() || '';
    const isCorrect = Boolean(qs('input[type="radio"]', row)?.checked);
    return { letter, text, is_correct: isCorrect };
  });
}

function collect() {
  const options = readOptions().filter((option) => option.text);
  const yearRaw = val('year');
  return {
    statement: rawVal('statement').trim(),
    image_url: val('image_url') || null,
    options,
    resolution: rawVal('resolution').trim() || null,
    explanation: rawVal('explanation').trim() || null,
    subject_id: val('subject_id'),
    topic_id: val('topic_id'),
    subtopic_id: val('subtopic_id') || null,
    difficulty: Number(val('difficulty')) || 2,
    source_exam_id: val('source_exam_id') || null,
    year: yearRaw ? Number(yearRaw) : null,
    board: val('board') || null,
    source: val('source') || null,
    active: Boolean(field('active')?.checked),
    exam_ids: qsa('[data-exam-id]:checked', state.ctx.el).map((input) => input.dataset.examId),
  };
}

function clearErrors() {
  qsa('[data-error-for]', state.ctx.el).forEach((el) => {
    el.textContent = '';
  });
  qsa('.is-invalid', state.ctx.el).forEach((el) => el.classList.remove('is-invalid'));
}

function setError(name, message) {
  const target = qs(`[data-error-for="${name}"]`, state.ctx.el);
  if (target) target.textContent = message;
  const input = field(name);
  if (input) input.classList.add('is-invalid');
}

function showApiErrors(err) {
  clearErrors();
  const details = err instanceof ApiError ? err.details : null;
  if (!Array.isArray(details)) return;
  for (const detail of details) {
    const path = Array.isArray(detail.path) ? detail.path.join('.') : String(detail.path || '');
    const last = path.split('.').filter((part) => !/^\d+$/.test(part)).pop();
    if (last === 'options' || path.includes('options')) {
      const target = qs('[data-error-for="options"]', state.ctx.el);
      if (target) target.textContent = detail.message;
      continue;
    }
    setError(last, detail.message);
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
  const select = field('topic_id');
  if (!select) return;
  if (!subjectId) {
    render(select, optionsHtml([], null, 'Selecione a matéria primeiro'));
    select.disabled = true;
    await loadSubtopics(null);
    return;
  }
  select.disabled = true;
  render(select, html`<option value="">Carregando…</option>`);
  let topics = [];
  try {
    topics = await api.get('/api/admin/content/topics', { query: { subject_id: subjectId } });
  } catch {
    toast('Não foi possível carregar os assuntos desta matéria.', { type: 'error' });
  }
  const selected = keep && topics.some((t) => t.id === keep) ? keep : null;
  render(select, optionsHtml(topics, selected, 'Selecione o assunto'));
  select.disabled = false;
  select.value = selected || '';
  await loadSubtopics(selected, { keep: keepSubtopic });
}

async function loadSubtopics(topicId, { keep = null } = {}) {
  const select = field('subtopic_id');
  if (!select) return;
  if (!topicId) {
    render(select, optionsHtml([], null, 'Selecione o assunto primeiro'));
    select.disabled = true;
    return;
  }
  select.disabled = true;
  render(select, html`<option value="">Carregando…</option>`);
  let subtopics = [];
  try {
    subtopics = await api.get('/api/admin/content/subtopics', { query: { topic_id: topicId } });
  } catch {
    subtopics = [];
  }
  const selected = keep && subtopics.some((st) => st.id === keep) ? keep : null;
  render(select, optionsHtml(subtopics, selected, subtopics.length ? 'Sem subassunto' : 'Nenhum subassunto cadastrado'));
  select.disabled = false;
  select.value = selected || '';
}

// ---------------------------------------------------------------------
// Prévias
// ---------------------------------------------------------------------
function switchStatementTab(mode) {
  const input = field('statement');
  const preview = qs('[data-statement-preview]', state.ctx.el);
  if (!input || !preview) return;
  const showPreview = mode === 'preview';
  qsa('[data-md-tab]', state.ctx.el).forEach((tab) => {
    const active = tab.dataset.mdTab === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (showPreview) {
    const source = input.value.trim();
    render(preview, source ? raw(md(source)) : html`<p class="hint">Nada para pré-visualizar.</p>`);
  }
  input.hidden = showPreview;
  preview.hidden = !showPreview;
  if (!showPreview) input.focus();
}

/** Reproduz o cartão da questão como o aluno vê (classes canônicas .question). */
function paintPreview() {
  const box = qs('[data-preview]', state.ctx.el);
  if (!box) return;
  const statement = rawVal('statement').trim();
  const image = val('image_url');
  const options = readOptions();
  const filled = options.filter((option) => option.text);
  const difficulty = Number(val('difficulty')) || 2;
  const subject = state.subjects.find((s) => s.id === val('subject_id'));

  render(
    box,
    html`
      <article class="question qf-preview">
        <header class="question-header">
          <span class="question-number">Questão</span>
          <span class="question-meta">
            ${subject ? badge(subject.name, 'blue') : ''}
            ${badge(difficultyLabel(difficulty), difficultyTone(difficulty))}
            ${val('year') ? badge(val('year'), 'gray') : ''}
            ${val('board') ? badge(val('board'), 'gray') : ''}
          </span>
        </header>
        <div class="question-body">
          ${image ? html`<img class="question-image" src="${image}" alt="Imagem da questão" loading="lazy">` : ''}
          <div class="question-statement md">${statement ? raw(md(statement)) : html`<p class="hint">O enunciado aparece aqui.</p>`}</div>
          <div class="question-options">
            ${filled.length ? filled.map((option) => html`
              <div class="option ${option.is_correct ? 'correct' : ''}">
                <span class="option-letter">${option.letter}</span>
                <span class="option-text">${raw(mdInline(option.text))}</span>
                ${option.is_correct ? html`<span class="option-mark">${icon('circle-check', { size: 18 })}</span>` : ''}
              </div>`) : html`<p class="hint">As alternativas aparecem aqui conforme você as escreve.</p>`}
          </div>
        </div>
      </article>`
  );
}

const schedulePreview = () => {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(paintPreview, PREVIEW_DEBOUNCE_MS);
};

// ---------------------------------------------------------------------
// Salvar e excluir
// ---------------------------------------------------------------------
async function save({ then = 'list' } = {}) {
  clearErrors();
  const data = collect();

  if (data.statement.length < 10) {
    setError('statement', 'O enunciado precisa ter pelo menos 10 caracteres.');
    field('statement')?.focus();
    return;
  }
  if (!data.subject_id || !data.topic_id) {
    setError('subject_id', 'Escolha a matéria e o assunto.');
    toast('Classifique a questão em uma matéria e um assunto.', { type: 'warning' });
    return;
  }
  if (data.options.length < 2) {
    const target = qs('[data-error-for="options"]', state.ctx.el);
    if (target) target.textContent = 'Escreva pelo menos duas alternativas.';
    return;
  }
  if (data.options.filter((option) => option.is_correct).length !== 1) {
    const target = qs('[data-error-for="options"]', state.ctx.el);
    if (target) target.textContent = 'Marque exatamente uma alternativa como correta.';
    return;
  }

  const buttons = qsa('[data-act="save"], [data-act="save-new"]', state.ctx.el);
  buttons.forEach((button) => setLoading(button, true));
  try {
    const saved = state.id
      ? await api.put(`/api/admin/questions/${state.id}`, data)
      : await api.post('/api/admin/questions', data);
    toast(state.id ? 'Questão salva.' : 'Questão criada.', { type: 'success' });
    if (then === 'new') {
      state.ctx.navigate(`/admin/questoes/nova?subject_id=${encodeURIComponent(saved.subject_id)}&topic_id=${encodeURIComponent(saved.topic_id)}${saved.subtopic_id ? `&subtopic_id=${encodeURIComponent(saved.subtopic_id)}` : ''}`);
      return;
    }
    state.ctx.navigate('/admin/questoes');
  } catch (err) {
    buttons.forEach((button) => setLoading(button, false));
    showApiErrors(err);
    toast((err && err.message) || 'Não foi possível salvar a questão.', { type: 'error' });
  }
}

async function removeQuestion() {
  const ok = await confirm({
    title: 'Excluir questão',
    message: 'A questão e as respostas registradas pelos alunos serão excluídas. Esta ação não pode ser desfeita.',
    danger: true,
    confirmText: 'Excluir questão',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/questions/${state.id}`);
    toast('Questão excluída.', { type: 'success' });
    state.ctx.navigate('/admin/questoes');
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir a questão.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------
function optionRow(letter, option) {
  return html`
    <div class="qf-option" data-option-letter="${letter}">
      <label class="qf-option-letter" title="Marcar a alternativa ${letter} como correta">
        <input type="radio" name="correct" value="${letter}" ${option && option.is_correct ? raw('checked') : ''}>
        <span>${letter}</span>
      </label>
      <textarea class="textarea qf-option-text" rows="2" maxlength="4000" aria-label="Texto da alternativa ${letter}"
        placeholder="Texto da alternativa ${letter}">${option ? option.text : ''}</textarea>
    </div>`;
}

function view() {
  const question = state.question || {};
  const editing = Boolean(state.id);
  const byLetter = new Map((Array.isArray(question.options) ? question.options : []).map((option) => [option.letter, option]));
  const examIds = new Set(Array.isArray(question.exam_ids) ? question.exam_ids : []);
  const stats = question.stats || null;

  return html`
    ${pageHeader({
      title: editing ? 'Editar questão' : 'Nova questão',
      subtitle: editing ? 'Revise o enunciado, o gabarito e a classificação.' : 'Cadastre o enunciado, as alternativas e classifique a questão no conteúdo.',
      breadcrumb: [{ label: 'Questões', href: '/admin/questoes' }, { label: editing ? 'Editar' : 'Nova questão' }],
      actions: html`
        <a class="btn btn-ghost" href="/admin/questoes">${icon('arrow-left')}<span>Voltar</span></a>
        ${editing ? html`<button type="button" class="btn btn-danger" data-act="delete">${icon('trash-2')}<span>Excluir</span></button>` : ''}
        <button type="button" class="btn btn-secondary" data-act="save-new">${icon('plus')}<span>Salvar e criar outra</span></button>
        <button type="button" class="btn btn-primary" data-act="save">${icon('save')}<span>Salvar</span></button>`,
    })}

    <form class="af-form" novalidate autocomplete="off">
      <div class="af-cols">
        <div class="af-main">
          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('file-text')}<span>Enunciado</span></h2></div>
            <div class="card-body af-grid">
              <div class="af-w-full">
                <div class="af-md">
                  <div class="tabs tabs-pills af-md-tabs" role="tablist" aria-label="Modo de edição do enunciado">
                    <button type="button" role="tab" class="tab active" aria-selected="true" data-md-tab="write">${icon('pencil', { size: 14 })}<span>Escrever</span></button>
                    <button type="button" role="tab" class="tab" aria-selected="false" data-md-tab="preview">${icon('eye', { size: 14 })}<span>Prévia</span></button>
                  </div>
                  <textarea class="textarea af-md-input" name="statement" rows="9" spellcheck="true"
                    placeholder="Escreva o enunciado. Aceita markdown e textos de apoio.">${question.statement || ''}</textarea>
                  <div class="af-md-preview md" data-statement-preview hidden></div>
                </div>
                <p class="error-text" data-error-for="statement"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-image">Imagem da questão <span class="hint-inline">(opcional)</span></label>
                <input class="input" id="qf-image" name="image_url" value="${question.image_url || ''}" maxlength="2000" placeholder="https://…" inputmode="url" spellcheck="false">
                <p class="error-text" data-error-for="image_url"></p>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header">
              <h2 class="card-title">${icon('list-checks')}<span>Alternativas</span></h2>
              <span class="hint">Marque o círculo da alternativa correta.</span>
            </div>
            <div class="card-body">
              <div class="qf-options">${LETTERS.map((letter) => optionRow(letter, byLetter.get(letter)))}</div>
              <p class="error-text" data-error-for="options"></p>
              <p class="hint">Deixe em branco as alternativas que não usar — a questão precisa de pelo menos duas.</p>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('lightbulb')}<span>Resolução e explicação</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="qf-resolution">Resolução passo a passo</label>
                <textarea class="textarea" id="qf-resolution" name="resolution" rows="6" maxlength="20000"
                  placeholder="Como se chega à resposta correta.">${question.resolution || ''}</textarea>
                <p class="error-text" data-error-for="resolution"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-explanation">Explicação da resposta</label>
                <textarea class="textarea" id="qf-explanation" name="explanation" rows="4" maxlength="20000"
                  placeholder="O conceito por trás da questão e por que as outras alternativas estão erradas.">${question.explanation || ''}</textarea>
                <p class="error-text" data-error-for="explanation"></p>
              </div>
            </div>
          </section>
        </div>

        <aside class="af-side">
          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('list-tree')}<span>Classificação</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="qf-subject">Matéria</label>
                <select class="select" id="qf-subject" name="subject_id">${optionsHtml(state.subjects, question.subject_id || null, 'Selecione a matéria')}</select>
                <p class="error-text" data-error-for="subject_id"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-topic">Assunto</label>
                <select class="select" id="qf-topic" name="topic_id" disabled><option value="">Selecione a matéria primeiro</option></select>
                <p class="error-text" data-error-for="topic_id"></p>
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-subtopic">Subassunto <span class="hint-inline">(opcional)</span></label>
                <select class="select" id="qf-subtopic" name="subtopic_id" disabled><option value="">Selecione o assunto primeiro</option></select>
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-difficulty">Dificuldade</label>
                <select class="select" id="qf-difficulty" name="difficulty">
                  ${DIFFICULTIES.map((d) => html`<option value="${d.value}" ${Number(question.difficulty ?? 2) === d.value ? raw('selected') : ''}>${d.label}</option>`)}
                </select>
              </div>
              <label class="switch-field af-w-full">
                <span class="fm-switch-text">
                  <span class="switch-title">Questão ativa</span>
                  <span class="hint">Questões inativas não são sorteadas.</span>
                </span>
                <input type="checkbox" role="switch" class="switch" name="active" ${question.active === false ? '' : raw('checked')}>
              </label>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('history')}<span>Origem</span></h2></div>
            <div class="card-body af-grid">
              <div class="field af-w-full">
                <label class="label" for="qf-source-exam">Prova de origem</label>
                <select class="select" id="qf-source-exam" name="source_exam_id">${optionsHtml(state.exams.map((e) => ({ id: e.id, name: e.short_name || e.name })), question.source_exam_id || null, 'Questão autoral')}</select>
              </div>
              <div class="field">
                <label class="label" for="qf-year">Ano</label>
                <input class="input" id="qf-year" name="year" type="number" min="1950" max="2100" step="1" value="${question.year ?? ''}" placeholder="2024">
                <p class="error-text" data-error-for="year"></p>
              </div>
              <div class="field">
                <label class="label" for="qf-board">Banca</label>
                <input class="input" id="qf-board" name="board" value="${question.board || ''}" maxlength="80" placeholder="INEP, VUNESP…">
              </div>
              <div class="field af-w-full">
                <label class="label" for="qf-source">Referência <span class="hint-inline">(opcional)</span></label>
                <input class="input" id="qf-source" name="source" value="${question.source || ''}" maxlength="300" placeholder="Caderno, página, adaptação…">
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('graduation-cap')}<span>Provas em que cai</span></h2></div>
            <div class="card-body">
              ${state.exams.length ? html`
                <div class="af-checks" role="group" aria-label="Provas em que a questão cai">
                  ${state.exams.map((exam) => html`
                    <label class="check">
                      <input type="checkbox" data-exam-id="${exam.id}" ${examIds.has(exam.id) ? raw('checked') : ''}>
                      <span>${exam.short_name || exam.name}</span>
                    </label>`)}
                </div>`
                : html`<p class="hint">Nenhum vestibular cadastrado. <a href="/admin/vestibulares">Cadastrar agora</a>.</p>`}
            </div>
          </section>

          ${stats && stats.attempts ? html`
            <section class="card">
              <div class="card-body af-stats">
                <div><span class="af-stat-value">${stats.attempts}</span><span class="af-stat-label">respostas</span></div>
                <div><span class="af-stat-value">${stats.accuracy_pct ?? 0}%</span><span class="af-stat-label">de acerto</span></div>
              </div>
            </section>` : ''}

          <section class="card">
            <div class="card-header"><h2 class="card-title">${icon('eye')}<span>Como o aluno vê</span></h2></div>
            <div class="card-body" data-preview></div>
          </section>
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
      } else if (act === 'save-new') {
        event.preventDefault();
        save({ then: 'new' });
      } else if (act === 'delete') {
        event.preventDefault();
        removeQuestion();
      }
    })
  );
  state.off.push(
    on(ctx.el, 'click', '[data-md-tab]', (event, tab) => {
      event.preventDefault();
      switchStatementTab(tab.dataset.mdTab);
    })
  );
  state.off.push(on(ctx.el, 'change', '[name="subject_id"]', (event, select) => loadTopics(select.value)));
  state.off.push(on(ctx.el, 'change', '[name="topic_id"]', (event, select) => loadSubtopics(select.value)));
  state.off.push(on(ctx.el, 'input', 'textarea, input', () => schedulePreview()));
  state.off.push(on(ctx.el, 'change', 'select, input', () => schedulePreview()));
  state.off.push(
    on(ctx.el, 'submit', 'form', (event) => {
      event.preventDefault();
      save({ then: 'list' });
    })
  );
}

async function renderQuestionForm(ctx) {
  const id = ctx.params && ctx.params.id && ctx.params.id !== 'nova' ? ctx.params.id : null;
  ctx.setTitle(id ? 'Editar questão' : 'Nova questão');
  render(ctx.el, skeleton('form', 6));

  const token = Symbol('admin-question-form');
  state = { ctx, token, id, question: null, subjects: [], exams: [], previewTimer: null, off: [] };

  try {
    const [subjects, exams, question] = await Promise.all([
      api.get('/api/admin/content/subjects'),
      api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || [])),
      id ? api.get(`/api/admin/questions/${id}`) : Promise.resolve(null),
    ]);
    if (!state || state.token !== token) return;
    state.subjects = subjects;
    state.exams = exams;
    state.question = question;
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: id ? 'Editar questão' : 'Nova questão', breadcrumb: [{ label: 'Questões', href: '/admin/questoes' }, { label: 'Formulário' }] })}
        ${errorState({ title: 'Não foi possível abrir o formulário', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-question-form' })}`
    );
    const button = qs('[data-action="reload-question-form"]', ctx.el);
    if (button) button.addEventListener('click', () => renderQuestionForm(ctx));
    return;
  }

  render(ctx.el, view());
  bind(ctx);

  const query = ctx.query || {};
  const question = state.question;
  const subjectId = question ? question.subject_id : query.subject_id || '';
  const topicId = question ? question.topic_id : query.topic_id || '';
  const subtopicId = question ? question.subtopic_id : query.subtopic_id || '';
  const subjectSelect = field('subject_id');
  if (subjectSelect && subjectId) subjectSelect.value = subjectId;
  if (subjectId) {
    await loadTopics(subjectId, { keep: topicId, keepSubtopic: subtopicId });
    if (!state || state.token !== token) return;
  }
  paintPreview();
}

export default renderQuestionForm;

export function unmount() {
  if (!state) return;
  clearTimeout(state.previewTimer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

// =====================================================================
// Foco Elite — /app/caderno-de-erros
// Resumo dos erros por matéria (GET /api/errors/summary), filtros e lista
// expansível: alternativa marcada contra a correta, resolução, explicação,
// anotação pessoal (PATCH /api/errors/:id) e remoção (DELETE).
// "Refazer meus erros" leva ao runner em /app/caderno-de-erros/refazer.
// =====================================================================
import { api } from '../../core/api.js';
import { html, raw, render, qs, on, toast, confirm, setLoading, pageHeader, emptyState, errorState, skeleton, progressBar, badge, statCard } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md, mdInline, mdToText } from '../../core/markdown.js';
import { fmtRelative, difficultyLabel, difficultyTone, pluralize } from '../../core/format.js';
import { accentStyle, pager } from './subjects.js';

const RESOLVED_OPTIONS = [
  { value: '', label: 'Todos os registros' },
  { value: 'false', label: 'A resolver' },
  { value: 'true', label: 'Já resolvidos' },
];

let cleanup = [];

function optionRow(option, { wrongId, correctId }) {
  const classes = ['option', 'errb-option', 'is-locked'];
  let mark = '';
  if (option.id === correctId) {
    classes.push('correct');
    mark = 'check';
  }
  if (option.id === wrongId && option.id !== correctId) {
    classes.push('wrong');
    mark = 'x';
  }
  return html`
    <div class="${classes.join(' ')}">
      <span class="option-letter" aria-hidden="true">${option.letter || '?'}</span>
      <span class="option-text">${mdInline(option.text)}</span>
      <span class="option-mark" aria-hidden="true">${mark ? icon(mark, { size: 18 }) : ''}</span>
    </div>`;
}

function errorItem(item) {
  const question = item.question || {};
  const options = Array.isArray(question.options) ? question.options : [];
  const wrongId = item.wrong_option ? item.wrong_option.id : null;
  const correctId = item.correct_option ? item.correct_option.id : null;
  return html`
    <details class="card errb-item ${item.resolved ? 'is-resolved' : ''}" ${accentStyle(item.subject_color)} data-error="${item.id}">
      <summary class="errb-summary">
        <span class="errb-summary-main">
          <span class="chip-group errb-chips">
            <span class="chip errb-chip-subject">${icon(item.subject_icon || 'book-open', { size: 14 })}${item.subject_name}</span>
            ${item.topic_name ? html`<span class="chip">${item.topic_name}</span>` : ''}
            ${question.difficulty ? badge(difficultyLabel(question.difficulty), difficultyTone(question.difficulty)) : ''}
            ${item.resolved
              ? badge('Resolvido', 'green', { icon: 'circle-check' })
              : badge(Number(item.times_wrong) > 1 ? `${item.times_wrong} erros` : 'A resolver', 'red', { icon: 'circle-x' })}
          </span>
          <span class="errb-summary-text">${mdToText(question.statement, 200)}</span>
          <span class="errb-summary-meta">${icon('clock', { size: 13 })}<span>Último erro ${fmtRelative(item.last_wrong_at)}</span></span>
        </span>
        <span class="errb-summary-toggle" aria-hidden="true">${icon('chevron-down', { size: 18 })}</span>
      </summary>
      <div class="errb-body">
        <div class="question-statement md errb-statement">${md(question.statement)}</div>
        ${question.image_url ? html`<figure class="question-image"><img src="${question.image_url}" alt="Imagem da questão" loading="lazy"></figure>` : ''}
        <div class="question-options errb-options">${options.map((option) => optionRow(option, { wrongId, correctId }))}</div>
        <p class="errb-compare">
          ${icon('circle-x', { size: 16 })}
          <span>Você marcou <strong>${item.wrong_option ? item.wrong_option.letter : '—'}</strong>. A correta é <strong>${item.correct_option ? item.correct_option.letter : '—'}</strong>.</span>
        </p>
        ${item.resolution
          ? html`<section class="feedback-section"><h4>${icon('list-checks', { size: 16 })} Resolução</h4><div class="md">${md(item.resolution)}</div></section>`
          : ''}
        ${item.explanation
          ? html`<section class="feedback-section"><h4>${icon('lightbulb', { size: 16 })} Explicação</h4><div class="md">${md(item.explanation)}</div></section>`
          : ''}
        <section class="errb-note">
          <label class="label" for="errb-note-${item.id}">Minha anotação sobre este erro</label>
          <textarea class="textarea" id="errb-note-${item.id}" data-note="${item.id}" rows="3" maxlength="2000"
            placeholder="Por que eu errei? O que não posso esquecer?">${item.notes || ''}</textarea>
          <div class="errb-note-actions">
            <a class="btn btn-ghost btn-sm" href="/app/tutor?question_id=${item.question_id}">${icon('bot', { size: 16 })}<span>Perguntar ao Tutor</span></a>
            <div class="errb-note-right">
              <button type="button" class="btn btn-ghost btn-sm errb-remove" data-action="remove" data-id="${item.id}">${icon('trash-2', { size: 16 })}<span>Remover</span></button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="save-note" data-id="${item.id}">${icon('check', { size: 16 })}<span>Salvar anotação</span></button>
            </div>
          </div>
        </section>
      </div>
    </details>`;
}

export default async function renderPage(ctx) {
  const { el } = ctx;
  const state = {
    subjectId: ctx.query.subject_id || '',
    topicId: ctx.query.topic_id || '',
    resolved: ctx.query.resolved || '',
    page: Math.max(1, Number(ctx.query.page) || 1),
    summary: null,
    result: null,
    loading: true,
    error: null,
  };

  render(
    el,
    html`
      ${pageHeader({
        title: 'Caderno de Erros',
        subtitle: 'Cada questão que você errou volta aqui até virar acerto.',
        actions: html`<a class="btn btn-primary" href="/app/caderno-de-erros/refazer" data-role="redo">${icon('refresh-cw')}<span>Refazer meus erros</span></a>`,
      })}
      <div class="errb-page">
        <div data-summary></div>
        <div data-toolbar></div>
        <div data-list></div>
      </div>`
  );
  const summaryEl = qs('[data-summary]', el);
  const toolbarEl = qs('[data-toolbar]', el);
  const listEl = qs('[data-list]', el);

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.subjectId) params.set('subject_id', state.subjectId);
    if (state.topicId) params.set('topic_id', state.topicId);
    if (state.resolved) params.set('resolved', state.resolved);
    if (state.page > 1) params.set('page', String(state.page));
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}`);
    const redo = qs('[data-role="redo"]', el);
    if (redo) {
      const redoParams = new URLSearchParams();
      if (state.subjectId) redoParams.set('subject_id', state.subjectId);
      if (state.topicId) redoParams.set('topic_id', state.topicId);
      const redoSearch = redoParams.toString();
      redo.setAttribute('href', `/app/caderno-de-erros/refazer${redoSearch ? `?${redoSearch}` : ''}`);
    }
  }

  function summaryView() {
    const summary = state.summary;
    if (!summary) return skeleton('stats', 3);
    const bySubject = Array.isArray(summary.by_subject) ? summary.by_subject : [];
    const max = bySubject.reduce((acc, row) => Math.max(acc, Number(row.total) || 0), 0);
    return html`
      <div class="grid grid-3 errb-stats">
        ${statCard({ label: 'Erros registrados', value: summary.total, icon: 'circle-x', tone: 'red' })}
        ${statCard({ label: 'A resolver', value: summary.unresolved, icon: 'target', tone: 'orange', hint: 'Questões que ainda não viraram acerto' })}
        ${statCard({ label: 'Já resolvidos', value: summary.resolved, icon: 'circle-check', tone: 'green', hint: 'Você acertou ao refazer' })}
      </div>
      ${bySubject.length
        ? html`
          <section class="card errb-bars">
            <div class="card-header"><h2 class="card-title">${icon('chart-column', { size: 18 })}<span>Onde você mais erra</span></h2></div>
            <div class="card-body">
              ${bySubject.map((row) => html`
                <div class="errb-bar" ${accentStyle(row.color)}>
                  <div class="errb-bar-head">
                    <button type="button" class="errb-bar-name" data-action="filter-subject" data-id="${row.subject_id}">
                      ${icon(row.icon || 'book-open', { size: 14 })}<span>${row.name}</span>
                    </button>
                    <span class="errb-bar-value">${pluralize(row.total, 'erro', 'erros')}${Number(row.unresolved) ? ` · ${row.unresolved} a resolver` : ''}</span>
                  </div>
                  ${progressBar(max > 0 ? (Number(row.total) / max) * 100 : 0, { color: 'danger', size: 'sm' })}
                </div>`)}
            </div>
          </section>`
        : ''}`;
  }

  function toolbarView() {
    const summary = state.summary;
    if (!summary || !summary.total) return html``;
    const subjects = Array.isArray(summary.by_subject) ? summary.by_subject : [];
    const topics = (Array.isArray(summary.by_topic) ? summary.by_topic : []).filter(
      (topic) => !state.subjectId || topic.subject_id === state.subjectId
    );
    return html`
      <div class="errb-toolbar">
        <select class="select" data-filter="subject" aria-label="Filtrar por matéria">
          <option value="">Todas as matérias</option>
          ${subjects.map((row) => html`<option value="${row.subject_id}" ${state.subjectId === row.subject_id ? raw('selected') : ''}>${row.name} (${row.total})</option>`)}
        </select>
        <select class="select" data-filter="topic" aria-label="Filtrar por assunto" ${topics.length ? '' : raw('disabled')}>
          <option value="">Todos os assuntos</option>
          ${topics.map((row) => html`<option value="${row.topic_id}" ${state.topicId === row.topic_id ? raw('selected') : ''}>${row.name} (${row.total})</option>`)}
        </select>
        <select class="select" data-filter="resolved" aria-label="Filtrar por situação">
          ${RESOLVED_OPTIONS.map((option) => html`<option value="${option.value}" ${state.resolved === option.value ? raw('selected') : ''}>${option.label}</option>`)}
        </select>
        ${state.subjectId || state.topicId || state.resolved
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="clear">${icon('rotate-ccw', { size: 16 })}<span>Limpar</span></button>`
          : ''}
      </div>`;
  }

  function listView() {
    if (state.error) return errorState({ message: state.error });
    if (state.loading) return skeleton('list', 4);
    const result = state.result || { items: [], total: 0, page: 1, pages: 1 };
    if (!result.items.length) {
      const filtered = Boolean(state.subjectId || state.topicId || state.resolved);
      return emptyState({
        icon: filtered ? 'search' : 'circle-check',
        title: filtered ? 'Nenhum erro com esses filtros' : 'Seu caderno de erros está vazio',
        text: filtered
          ? 'Ajuste os filtros para ver outros registros.'
          : 'Toda questão que você errar entra aqui automaticamente, com a resolução e a explicação.',
        action: filtered
          ? { label: 'Limpar filtros', icon: 'rotate-ccw', variant: 'secondary', dataAction: 'clear' }
          : { label: 'Resolver questões', href: '/app/questoes', icon: 'file-text' },
      });
    }
    return html`
      <div class="errb-list">${result.items.map(errorItem)}</div>
      ${pager({ page: result.page, pages: result.pages, total: result.total, unit: 'registros' })}`;
  }

  const paintSummary = () => render(summaryEl, summaryView());
  const paintToolbar = () => render(toolbarEl, toolbarView());
  const paintList = () => render(listEl, listView());

  async function loadSummary() {
    try {
      state.summary = await api.get('/api/errors/summary');
    } catch {
      state.summary = { total: 0, unresolved: 0, resolved: 0, by_subject: [], by_topic: [] };
    }
    paintSummary();
    paintToolbar();
    syncUrl();
  }

  async function loadList() {
    state.loading = true;
    state.error = null;
    paintList();
    try {
      state.result = await api.get('/api/errors', {
        query: {
          subject_id: state.subjectId || undefined,
          topic_id: state.topicId || undefined,
          resolved: state.resolved || undefined,
          page: state.page > 1 ? state.page : undefined,
        },
      });
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar o caderno de erros.';
    }
    paintList();
  }

  async function saveNote(button) {
    const id = button.dataset.id;
    const field = qs(`[data-note="${CSS.escape(id)}"]`, el);
    if (!field) return;
    setLoading(button, true);
    button.disabled = true;
    try {
      const updated = await api.patch(`/api/errors/${encodeURIComponent(id)}`, { notes: field.value.trim() || null });
      if (state.result) {
        const item = state.result.items.find((row) => row.id === id);
        if (item) item.notes = updated.notes;
      }
      toast('Anotação salva.', { type: 'success' });
    } catch (err) {
      toast((err && err.message) || 'Não foi possível salvar a anotação.', { type: 'error' });
    } finally {
      setLoading(button, false);
      button.disabled = false;
    }
  }

  async function removeItem(button) {
    const id = button.dataset.id;
    const ok = await confirm({
      title: 'Remover do caderno',
      message: 'Esta questão sai do seu caderno de erros. Se você errar de novo, ela volta.',
      danger: true,
      confirmText: 'Remover',
    });
    if (!ok) return;
    try {
      await api.del(`/api/errors/${encodeURIComponent(id)}`);
      toast('Registro removido do caderno.', { type: 'success' });
      await Promise.all([loadSummary(), loadList()]);
    } catch (err) {
      toast((err && err.message) || 'Não foi possível remover o registro.', { type: 'error' });
    }
  }

  cleanup.push(
    on(el, 'change', '[data-filter="subject"]', (event) => {
      state.subjectId = event.target.value;
      state.topicId = '';
      state.page = 1;
      syncUrl();
      paintToolbar();
      loadList();
    }),
    on(el, 'change', '[data-filter="topic"]', (event) => {
      state.topicId = event.target.value;
      state.page = 1;
      syncUrl();
      loadList();
    }),
    on(el, 'change', '[data-filter="resolved"]', (event) => {
      state.resolved = event.target.value;
      state.page = 1;
      syncUrl();
      paintToolbar();
      loadList();
    }),
    on(el, 'click', '[data-action="filter-subject"]', (event, button) => {
      state.subjectId = state.subjectId === button.dataset.id ? '' : button.dataset.id;
      state.topicId = '';
      state.page = 1;
      syncUrl();
      paintToolbar();
      loadList();
    }),
    on(el, 'click', '[data-action="clear"]', () => {
      state.subjectId = '';
      state.topicId = '';
      state.resolved = '';
      state.page = 1;
      syncUrl();
      paintToolbar();
      loadList();
    }),
    on(el, 'click', '[data-action="page"]', (event, button) => {
      const next = Number(button.dataset.page) || 1;
      if (next === state.page) return;
      state.page = next;
      syncUrl();
      loadList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    on(el, 'click', '[data-action="save-note"]', (event, button) => saveNote(button)),
    on(el, 'click', '[data-action="remove"]', (event, button) => removeItem(button)),
    on(el, 'click', '[data-action="retry"]', () => loadList())
  );

  await Promise.all([loadSummary(), loadList()]);
}

export async function unmount() {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* limpeza best-effort */
    }
  }
  cleanup = [];
}

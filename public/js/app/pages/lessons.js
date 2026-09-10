// =====================================================================
// Foco Elite — /app/aulas
// Bloco "Continuar assistindo" (GET /api/lessons/continue) e lista de aulas
// filtrável por matéria, situação e busca, paginada (GET /api/lessons).
//
// Exporta os blocos de aula reutilizados por topic.js e lesson.js
// (cartão de aula, miniatura, botão de favorito e selo de dificuldade).
// =====================================================================
import { api } from '../../core/api.js';
import { html, raw, render, qs, on, debounce, toast, pageHeader, emptyState, errorState, skeleton, badge } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, difficultyLabel, difficultyTone } from '../../core/format.js';
import { accentStyle, pager, setFavorite } from './subjects.js';

const STATUS_OPTIONS = [
  { value: '', label: 'Todas as situações' },
  { value: 'pending', label: 'Não concluídas' },
  { value: 'in_progress', label: 'Em andamento' },
  { value: 'done', label: 'Concluídas' },
];

// ---------------------------------------------------------------------
// Blocos reutilizáveis
// ---------------------------------------------------------------------

/** Selo de dificuldade da aula/questão (vazio quando não informada). */
export function difficultyBadge(level) {
  const label = difficultyLabel(level);
  if (!label || label === '—') return html``;
  return badge(label, difficultyTone(level));
}

/** Miniatura da aula: imagem cadastrada ou placeholder com a cor da matéria. */
export function lessonThumb(lesson, { href = '' } = {}) {
  const duration = Number(lesson.duration_min) || 0;
  const inner = html`
    ${lesson.thumbnail_url
      ? html`<img src="${lesson.thumbnail_url}" alt="" loading="lazy" class="lsn-thumb-img">`
      : html`<span class="lsn-thumb-empty">${icon(lesson.subject_icon || 'play', { size: 22 })}</span>`}
    ${lesson.completed ? html`<span class="lsn-thumb-done" aria-hidden="true">${icon('circle-check', { size: 16 })}</span>` : ''}
    ${duration > 0 ? html`<span class="lsn-thumb-time">${fmtMinutes(duration)}</span>` : ''}`;
  return href
    ? html`<a class="lsn-thumb" href="${href}" tabindex="-1" aria-hidden="true">${inner}</a>`
    : html`<span class="lsn-thumb">${inner}</span>`;
}

/**
 * Botão de favorito. O clique é tratado por delegação com `data-action="favorite"`.
 * `type` é o item_type da API de favoritos ('lesson', 'topic', 'question').
 */
export function favoriteButton(type, id, favorited, { label = 'aula' } = {}) {
  const active = Boolean(favorited);
  return html`
    <button type="button" class="btn btn-ghost btn-icon lsn-fav ${active ? 'is-active' : ''}"
      data-action="favorite" data-type="${type}" data-id="${id}" data-favorited="${active ? '1' : '0'}"
      aria-pressed="${active ? 'true' : 'false'}"
      aria-label="${active ? `Remover ${label} dos favoritos` : `Adicionar ${label} aos favoritos`}"
      title="${active ? 'Remover dos favoritos' : 'Favoritar'}">
      ${icon('star', { size: 18 })}
    </button>`;
}

/** Rótulo do botão principal conforme o progresso do aluno. */
function actionLabel(lesson) {
  if (lesson.completed) return 'Rever aula';
  if (lesson.status === 'in_progress') return 'Continuar';
  return 'Assistir';
}

/**
 * Cartão de aula usado na lista de aulas e nas seções de assunto.
 * `showSubject` mostra o caminho matéria › assunto (desnecessário dentro do assunto).
 */
export function lessonCard(lesson, { showSubject = true } = {}) {
  const href = `/app/aulas/${lesson.id}`;
  const path = [showSubject ? lesson.subject_name : null, showSubject ? lesson.topic_name : null, lesson.subtopic_name]
    .filter(Boolean)
    .join(' › ');
  return html`
    <article class="card lsn-card ${lesson.completed ? 'is-done' : ''}" ${accentStyle(lesson.subject_color)}>
      ${lessonThumb(lesson, { href })}
      <div class="lsn-card-body">
        ${path ? html`<div class="lsn-card-path">${path}</div>` : ''}
        <h3 class="lsn-card-title"><a href="${href}">${lesson.title}</a></h3>
        ${lesson.description ? html`<p class="lsn-card-desc clamp-2">${lesson.description}</p>` : ''}
        <div class="lsn-card-meta">
          ${difficultyBadge(lesson.difficulty)}
          ${lesson.completed
            ? badge('Concluída', 'green', { icon: 'circle-check' })
            : lesson.status === 'in_progress'
              ? badge('Em andamento', 'blue', { icon: 'play' })
              : ''}
          ${lesson.teacher_name ? html`<span class="lsn-card-teacher">${icon('user', { size: 14 })}${lesson.teacher_name}</span>` : ''}
          <span class="lsn-card-teacher">${icon('clock', { size: 14 })}${fmtMinutes(lesson.duration_min)}</span>
        </div>
      </div>
      <div class="lsn-card-actions">
        ${favoriteButton('lesson', lesson.id, lesson.favorited)}
        <a class="btn btn-primary btn-sm" href="${href}">${icon('play', { size: 16 })}<span>${actionLabel(lesson)}</span></a>
      </div>
    </article>`;
}

/**
 * Trata o clique em um botão de favorito dentro de `root`.
 * `onDone(type, id, favorited)` permite atualizar o estado da página.
 */
export function bindFavorites(root, onDone) {
  return on(root, 'click', '[data-action="favorite"]', async (event, button) => {
    event.preventDefault();
    if (button.disabled) return;
    const type = button.dataset.type;
    const id = button.dataset.id;
    const next = button.dataset.favorited !== '1';
    button.disabled = true;
    try {
      await setFavorite(type, id, next);
      button.dataset.favorited = next ? '1' : '0';
      button.classList.toggle('is-active', next);
      button.setAttribute('aria-pressed', next ? 'true' : 'false');
      toast(next ? 'Adicionado aos favoritos.' : 'Removido dos favoritos.', { type: 'success' });
      if (typeof onDone === 'function') onDone(type, id, next);
    } catch (err) {
      toast((err && err.message) || 'Não foi possível atualizar os favoritos.', { type: 'error' });
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------
let cleanup = [];

function continueCard(lesson) {
  const href = `/app/aulas/${lesson.id}`;
  return html`
    <a class="card card-hover lsn-continue-card" href="${href}" ${accentStyle(lesson.subject_color)}>
      ${lessonThumb(lesson)}
      <div class="lsn-continue-body">
        <span class="lsn-card-path">${lesson.subject_name || ''}</span>
        <strong class="lsn-continue-title clamp-2">${lesson.title}</strong>
        <span class="lsn-card-teacher">${icon('clock', { size: 14 })}${fmtMinutes(lesson.duration_min)}</span>
      </div>
    </a>`;
}

export default async function renderPage(ctx) {
  const { el } = ctx;
  const state = {
    subjectId: typeof ctx.query.subject_id === 'string' ? ctx.query.subject_id : '',
    status: typeof ctx.query.status === 'string' ? ctx.query.status : '',
    term: typeof ctx.query.q === 'string' ? ctx.query.q : '',
    page: Math.max(1, Number(ctx.query.page) || 1),
    subjects: [],
    result: null,
    continueItems: [],
    loading: true,
    error: null,
  };

  render(
    el,
    html`
      ${pageHeader({
        title: 'Aulas',
        subtitle: 'Assista às videoaulas, acompanhe o resumo e pratique logo depois.',
        actions: html`<a class="btn btn-secondary" href="/app/materias">${icon('library')}<span>Ver por matéria</span></a>`,
      })}
      <div class="lsn-continue" data-continue hidden></div>
      <div class="lsn-list-wrap" data-body></div>`
  );
  const body = qs('[data-body]', el);
  const continueEl = qs('[data-continue]', el);

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.term) params.set('q', state.term);
    if (state.subjectId) params.set('subject_id', state.subjectId);
    if (state.status) params.set('status', state.status);
    if (state.page > 1) params.set('page', String(state.page));
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}`);
  }

  function toolbarView() {
    return html`
      <div class="lsn-toolbar">
        <div class="search-box lsn-search">
          ${icon('search', { size: 16 })}
          <input type="search" class="input" data-role="search" placeholder="Buscar aula ou assunto" aria-label="Buscar aula" value="${state.term}">
        </div>
        <select class="select lsn-select" data-role="subject" aria-label="Filtrar por matéria">
          <option value="">Todas as matérias</option>
          ${state.subjects.map((subject) => html`<option value="${subject.id}" ${state.subjectId === subject.id ? raw('selected') : ''}>${subject.name}</option>`)}
        </select>
        <select class="select lsn-select" data-role="status" aria-label="Filtrar por situação">
          ${STATUS_OPTIONS.map((option) => html`<option value="${option.value}" ${state.status === option.value ? raw('selected') : ''}>${option.label}</option>`)}
        </select>
        ${state.term || state.subjectId || state.status
          ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="clear">${icon('rotate-ccw', { size: 16 })}<span>Limpar</span></button>`
          : ''}
      </div>`;
  }

  function listView() {
    if (state.error) return errorState({ message: state.error });
    if (state.loading) return skeleton('list', 5);
    const result = state.result || { items: [], total: 0, page: 1, pages: 1 };
    if (!result.items.length) {
      const filtered = Boolean(state.term || state.subjectId || state.status);
      return emptyState({
        icon: 'play',
        title: filtered ? 'Nenhuma aula encontrada' : 'Nenhuma aula disponível ainda',
        text: filtered
          ? 'Ajuste os filtros ou faça uma nova busca para encontrar outras aulas.'
          : 'Assim que novas aulas forem publicadas para a sua prova, elas aparecem aqui.',
        action: filtered
          ? { label: 'Limpar filtros', icon: 'rotate-ccw', variant: 'secondary', dataAction: 'clear' }
          : { label: 'Ver matérias', href: '/app/materias', icon: 'library', variant: 'secondary' },
      });
    }
    return html`
      <div class="lsn-list">${result.items.map((lesson) => lessonCard(lesson))}</div>
      ${pager({ page: result.page, pages: result.pages, total: result.total, unit: 'aulas' })}`;
  }

  function paintList() {
    const container = qs('[data-list]', body);
    if (container) render(container, listView());
  }

  function paintToolbar() {
    const container = qs('[data-toolbar]', body);
    if (container) render(container, toolbarView());
  }

  function paint() {
    render(body, html`<div data-toolbar></div><div data-list></div>`);
    paintToolbar();
    paintList();
  }

  function paintContinue() {
    if (!state.continueItems.length) {
      continueEl.hidden = true;
      render(continueEl, '');
      return;
    }
    continueEl.hidden = false;
    render(
      continueEl,
      html`
        <h2 class="section-title">${icon('play')}<span>Continuar assistindo</span></h2>
        <div class="lsn-continue-row">${state.continueItems.map(continueCard)}</div>`
    );
  }

  async function loadList() {
    state.loading = true;
    state.error = null;
    paintList();
    try {
      state.result = await api.get('/api/lessons', {
        query: {
          subject_id: state.subjectId || undefined,
          status: state.status || undefined,
          q: state.term || undefined,
          page: state.page > 1 ? state.page : undefined,
        },
      });
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar as aulas.';
    }
    paintList();
  }

  async function loadAside() {
    const [subjects, continueItems] = await Promise.all([
      api.get('/api/subjects').catch(() => []),
      api.get('/api/lessons/continue').catch(() => []),
    ]);
    state.subjects = Array.isArray(subjects) ? subjects.filter((s) => Number(s.lessons_total) > 0) : [];
    state.continueItems = Array.isArray(continueItems) ? continueItems : [];
    paintContinue();
    paintToolbar();
  }

  const onSearch = debounce((value) => {
    state.term = value;
    state.page = 1;
    syncUrl();
    loadList();
  }, 400);

  cleanup.push(
    on(el, 'input', '[data-role="search"]', (event) => onSearch(event.target.value)),
    on(el, 'change', '[data-role="subject"]', (event) => {
      state.subjectId = event.target.value;
      state.page = 1;
      syncUrl();
      loadList();
    }),
    on(el, 'change', '[data-role="status"]', (event) => {
      state.status = event.target.value;
      state.page = 1;
      syncUrl();
      loadList();
    }),
    on(el, 'click', '[data-action="clear"]', () => {
      state.term = '';
      state.subjectId = '';
      state.status = '';
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
    on(el, 'click', '[data-action="retry"]', () => loadList()),
    bindFavorites(el, (type, id, favorited) => {
      if (type !== 'lesson' || !state.result) return;
      const item = state.result.items.find((lesson) => lesson.id === id);
      if (item) item.favorited = favorited;
    }),
    () => onSearch.cancel()
  );

  paint();
  await Promise.all([loadList(), loadAside()]);
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

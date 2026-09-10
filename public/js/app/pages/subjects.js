// =====================================================================
// Foco Elite — /app/materias
// Biblioteca de matérias do aluno: cartões com ícone e cor da matéria,
// área, barra de progresso, aulas concluídas e acurácia.
// Filtro por área, busca por nome e alternância entre "matérias da minha
// prova" e "todas as matérias" (GET /api/subjects?all=1).
//
// Exporta também os auxiliares visuais reutilizados por subject.js,
// topic.js, lessons.js e lesson.js (cor de destaque e tom de acurácia).
// =====================================================================
import { api } from '../../core/api.js';
import { html, raw, render, qs, on, debounce, pageHeader, emptyState, errorState, skeleton, progressBar } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { store } from '../../core/store.js';

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// ---------------------------------------------------------------------
// Auxiliares compartilhados pelas telas de estudo
// ---------------------------------------------------------------------

/** Cor vinda do banco só é aceita como hexadecimal; caso contrário usa o azul do tema. */
export function safeColor(value, fallback = 'var(--primary-2)') {
  const text = String(value ?? '').trim();
  return HEX_COLOR.test(text) ? text : fallback;
}

/** Atributo `style` com a cor da matéria (usado por `--subject-color` no CSS). */
export function accentStyle(color) {
  return raw(`style="--subject-color:${safeColor(color)}"`);
}

/** Tom de cor conforme a acurácia (verde ≥ 70%, laranja ≥ 50%, vermelho abaixo). */
export function accuracyTone(pct) {
  if (pct === null || pct === undefined || pct === '') return 'gray';
  const value = Number(pct);
  if (!Number.isFinite(value)) return 'gray';
  if (value >= 70) return 'green';
  if (value >= 50) return 'orange';
  return 'red';
}

/** Texto curto de acurácia ("78% de acerto" ou "Sem questões respondidas"). */
export function accuracyText(pct, { empty = 'Sem questões respondidas' } = {}) {
  if (pct === null || pct === undefined || pct === '') return empty;
  const value = Number(pct);
  return Number.isFinite(value) ? `${Math.round(value)}% de acerto` : empty;
}

/** Cor da barra de progresso: verde quando concluído, azul enquanto anda. */
export function progressColor(pct) {
  return Number(pct) >= 100 ? 'success' : '';
}

/** "12 de 30 aulas" (ou "Nenhuma aula publicada"). */
export function lessonsRatio(done, total, { empty = 'Nenhuma aula publicada' } = {}) {
  const all = Number(total) || 0;
  if (all <= 0) return empty;
  return `${Number(done) || 0} de ${all} ${all === 1 ? 'aula' : 'aulas'}`;
}

/** Normaliza texto para busca (sem acento, minúsculo). */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Paginação simples ("Anterior / Página X de Y / Próxima").
 * Os botões emitem `data-action="page"` com `data-page`; a página trata o clique.
 */
export function pager({ page = 1, pages = 1, total = 0, unit = 'resultados' } = {}) {
  const current = Math.max(1, Number(page) || 1);
  const last = Math.max(1, Number(pages) || 1);
  if (last <= 1) return html``;
  return html`
    <nav class="pagination fe-pager" aria-label="Paginação">
      <button type="button" class="btn btn-secondary btn-sm" data-action="page" data-page="${current - 1}" ${current <= 1 ? raw('disabled') : ''}>
        ${icon('chevron-left', { size: 16 })}<span>Anterior</span>
      </button>
      <span class="fe-pager-info">Página ${current} de ${last} · ${Number(total) || 0} ${unit}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-action="page" data-page="${current + 1}" ${current >= last ? raw('disabled') : ''}>
        <span>Próxima</span>${icon('chevron-right', { size: 16 })}
      </button>
    </nav>`;
}

/**
 * Favorita ou desfavorita um item (`lesson`, `question`, `topic`, `note`).
 * Devolve o novo estado; lança ApiError em caso de falha.
 */
export async function setFavorite(itemType, itemId, favorited) {
  const payload = { item_type: itemType, item_id: itemId };
  if (favorited) await api.post('/api/favorites', payload);
  else await api.del('/api/favorites', payload);
  return favorited;
}

// ---------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------
let cleanup = [];

function subjectCard(subject) {
  const pct = Number(subject.progress_pct) || 0;
  const accuracy = subject.accuracy_pct;
  return html`
    <a class="card card-hover subj-card" href="/app/materias/${subject.id}" ${accentStyle(subject.color)}>
      <div class="subj-card-top">
        <span class="icon-box subj-icon">${icon(subject.icon || 'book-open')}</span>
        <div class="subj-card-head">
          <h2 class="subj-card-title">${subject.name}</h2>
          ${subject.area_name ? html`<span class="subj-card-area">${subject.area_name}</span>` : ''}
        </div>
      </div>
      ${subject.description ? html`<p class="subj-card-desc clamp-2">${subject.description}</p>` : ''}
      <div class="subj-card-progress">
        ${progressBar(pct, { label: 'Progresso', color: progressColor(pct) })}
      </div>
      <div class="subj-card-meta">
        <span class="subj-card-stat">${icon('play', { size: 14 })}${lessonsRatio(subject.lessons_done, subject.lessons_total)}</span>
        <span class="subj-card-stat tone-${accuracyTone(accuracy)}">${icon('target', { size: 14 })}${accuracyText(accuracy, { empty: 'Sem dados de acerto' })}</span>
      </div>
    </a>`;
}

export default async function renderPage(ctx) {
  const { el } = ctx;
  const state = {
    all: ctx.query.todas === '1',
    area: typeof ctx.query.area === 'string' ? ctx.query.area : '',
    term: typeof ctx.query.q === 'string' ? ctx.query.q : '',
    subjects: [],
    loading: true,
    error: null,
  };

  render(
    el,
    html`
      ${pageHeader({
        title: 'Matérias',
        subtitle: 'Sua biblioteca de conteúdo. Acompanhe o progresso de cada matéria e escolha o que estudar agora.',
        actions: html`<a class="btn btn-secondary" href="/app/aulas">${icon('play')}<span>Ver todas as aulas</span></a>`,
      })}
      <div class="subj-page" data-body></div>`
  );
  const body = qs('[data-body]', el);

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.term) params.set('q', state.term);
    if (state.area) params.set('area', state.area);
    if (state.all) params.set('todas', '1');
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}`);
  }

  function visibleSubjects() {
    const term = normalize(state.term);
    return state.subjects.filter((subject) => {
      if (state.area && subject.area_slug !== state.area) return false;
      if (!term) return true;
      return normalize(`${subject.name} ${subject.area_name || ''}`).includes(term);
    });
  }

  function areaOptions() {
    const seen = new Map();
    for (const subject of state.subjects) {
      if (subject.area_slug && !seen.has(subject.area_slug)) seen.set(subject.area_slug, subject.area_name || subject.area_slug);
    }
    return Array.from(seen, ([slug, name]) => ({ slug, name }));
  }

  function toolbarView() {
    const areas = areaOptions();
    const hasExam = Boolean(store.exam || (ctx.exam && ctx.exam.id));
    return html`
      <div class="subj-toolbar">
        <div class="search-box subj-search">
          ${icon('search', { size: 16 })}
          <input type="search" class="input" data-role="search" placeholder="Buscar matéria" aria-label="Buscar matéria" value="${state.term}">
        </div>
        ${areas.length > 1
          ? html`
            <select class="select subj-select" data-role="area" aria-label="Filtrar por área">
              <option value="">Todas as áreas</option>
              ${areas.map((area) => html`<option value="${area.slug}" ${state.area === area.slug ? raw('selected') : ''}>${area.name}</option>`)}
            </select>`
          : ''}
        ${hasExam
          ? html`
            <label class="check subj-toggle">
              <input type="checkbox" data-role="all" ${state.all ? raw('checked') : ''}>
              <span>Mostrar todas as matérias</span>
            </label>`
          : ''}
      </div>`;
  }

  function listView() {
    const items = visibleSubjects();
    if (!state.subjects.length) {
      return emptyState({
        icon: 'library',
        title: 'Nenhuma matéria disponível',
        text: state.all
          ? 'Ainda não há matérias cadastradas na plataforma.'
          : 'A prova escolhida ainda não tem matérias vinculadas. Veja todas as matérias disponíveis.',
        action: state.all ? null : { label: 'Ver todas as matérias', icon: 'library', dataAction: 'show-all' },
      });
    }
    if (!items.length) {
      return emptyState({
        icon: 'search',
        title: 'Nenhuma matéria encontrada',
        text: 'Ajuste a busca ou o filtro de área para ver outras matérias.',
        action: { label: 'Limpar filtros', icon: 'rotate-ccw', variant: 'secondary', dataAction: 'clear' },
      });
    }
    return html`<div class="grid grid-3 subj-grid">${items.map(subjectCard)}</div>`;
  }

  /** Repinta só a lista, preservando o foco no campo de busca. */
  function paintList() {
    const grid = qs('[data-grid]', body);
    if (grid) render(grid, listView());
  }

  function paint() {
    if (state.loading) {
      render(body, skeleton('cards', 3));
      return;
    }
    if (state.error) {
      render(body, errorState({ message: state.error }));
      return;
    }
    render(body, html`${toolbarView()}<div data-grid></div>`);
    paintList();
  }

  async function load() {
    state.loading = true;
    state.error = null;
    paint();
    try {
      const query = state.all ? { all: 1 } : undefined;
      state.subjects = await api.get('/api/subjects', { query });
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = err && err.message ? err.message : 'Não foi possível carregar suas matérias.';
    }
    paint();
  }

  const onSearch = debounce((value) => {
    state.term = value;
    syncUrl();
    paintList();
  }, 250);

  cleanup.push(
    on(el, 'input', '[data-role="search"]', (event) => onSearch(event.target.value)),
    on(el, 'change', '[data-role="area"]', (event) => {
      state.area = event.target.value;
      syncUrl();
      paintList();
    }),
    on(el, 'change', '[data-role="all"]', (event) => {
      state.all = event.target.checked;
      syncUrl();
      load();
    }),
    on(el, 'click', '[data-action="show-all"]', () => {
      state.all = true;
      syncUrl();
      load();
    }),
    on(el, 'click', '[data-action="clear"]', () => {
      state.term = '';
      state.area = '';
      syncUrl();
      paint();
    }),
    on(el, 'click', '[data-action="retry"]', () => load()),
    () => onSearch.cancel()
  );

  await load();
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

/**
 * Tabela de dados do painel administrativo (ARCHITECTURE §6.3):
 * paginação, busca, filtros, ordenação e ações por linha.
 *
 *   const table = mountTable(el, {
 *     columns: [{ key, label, render?(row, value) → HTML confiável, sortable?, width?, align?: 'left'|'center'|'right', className? }],
 *     fetch(page, query) → Promise<{ items, total }>,   // query = { page, limit, q?, sort?, dir?, ...filtros, ...params }
 *     pageSize: 20,
 *     search: true, searchPlaceholder: 'Buscar por nome ou e-mail',
 *     filters: [{ key, label, type: 'select'|'text'|'date', options: [{ value, label }] | ['a','b'] }],
 *     rowActions: [{ label, icon, onClick(row, api), danger?, hidden?(row), disabled?(row) }],
 *     onRowClick(row),
 *     emptyText: 'Nenhum aluno encontrado',
 *     sort: { key: 'created_at', dir: 'desc' },   // ordenação inicial
 *     initialFilters: { status: 'active' },
 *     params: { extra: 1 },                       // parâmetros fixos enviados a cada fetch
 *     rowKey: 'id',                               // usado como data-id nas linhas
 *   });
 *   table.reload(); table.setSearch(q); table.setFilter(key, value); table.setParams({...}); table.destroy();
 *
 * O `render` de coluna deve devolver HTML já seguro (resultado de `html` ou string escapada);
 * sem `render`, o valor bruto é escapado. `fetch` também aceita um array simples como resposta.
 * Marcação: .table/.table-wrap/.table-footer/.pagination canônicos + complementos .dt- (pages/misc.css).
 */
import { html, raw, render, emptyState, skeleton, escapeHtml } from '../core/ui.js';
import { icon } from '../core/icons.js';

const join = (parts) => raw(parts.map((p) => String(p ?? '')).join(''));
const ic = (name, size = 16) => icon(name, { size });
const numberFormat = new Intl.NumberFormat('pt-BR');

const SEARCH_DEBOUNCE_MS = 300;
const WIDTH_RE = /^\d+(\.\d+)?(px|%|rem|em|ch)?$/;

let sequence = 0;

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((opt) => (
    opt && typeof opt === 'object'
      ? { value: String(opt.value ?? ''), label: String(opt.label ?? opt.value ?? '') }
      : { value: String(opt), label: String(opt) }
  ));
}

function cssWidth(width) {
  if (width == null || width === '') return '';
  const text = typeof width === 'number' ? `${width}px` : String(width).trim();
  if (!WIDTH_RE.test(text)) return '';
  return /^\d+(\.\d+)?$/.test(text) ? `${text}px` : text;
}

function formatCell(value) {
  if (value == null || value === '') return html`<span class="dt-muted">—</span>`;
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (value instanceof Date) return value.toLocaleString('pt-BR');
  if (typeof value === 'number') return numberFormat.format(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Janela de páginas para a paginação: 1 … 4 5 6 … 20. */
function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) { set.add(2); set.add(3); set.add(4); }
  if (page >= pages - 2) { set.add(pages - 1); set.add(pages - 2); set.add(pages - 3); }
  const sorted = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('…');
    out.push(sorted[i]);
  }
  return out;
}

export function mountTable(el, opts = {}) {
  if (!el) throw new Error('mountTable: elemento de destino obrigatório');
  if (typeof opts.fetch !== 'function') throw new Error('mountTable: opts.fetch é obrigatório');

  const columns = (Array.isArray(opts.columns) ? opts.columns : []).filter(Boolean);
  const filters = (Array.isArray(opts.filters) ? opts.filters : []).filter(Boolean)
    .map((f) => ({ ...f, type: f.type || 'select', options: normalizeOptions(f.options) }));
  const rowActions = (Array.isArray(opts.rowActions) ? opts.rowActions : []).filter(Boolean);
  const pageSize = Number(opts.pageSize) > 0 ? Math.floor(Number(opts.pageSize)) : 20;
  const id = `dt-${++sequence}`;
  const emptyText = opts.emptyText || 'Nenhum registro encontrado';
  const rowKey = opts.rowKey || 'id';

  const state = {
    page: 1,
    q: '',
    sort: opts.sort?.key || null,
    dir: opts.sort?.dir === 'desc' ? 'desc' : 'asc',
    filters: { ...(opts.initialFilters || {}) },
    params: { ...(opts.params || {}) },
    items: [],
    total: 0,
    loading: false,
    loaded: false,
    error: null,
  };
  let requestSeq = 0;
  let searchTimer = null;
  let filterTimer = null;
  let destroyed = false;

  // ---------------------------------------------------------------- toolbar (renderizada uma vez)
  function filterView(filter) {
    const current = state.filters[filter.key] ?? '';
    if (filter.type === 'select') {
      return html`
        <select class="select dt-filter" data-filter="${filter.key}" aria-label="${filter.label}">
          <option value="">${filter.placeholder || filter.label}</option>
          ${join(filter.options.map((o) => html`<option value="${o.value}" ${String(current) === o.value ? raw('selected') : ''}>${o.label}</option>`))}
        </select>`;
    }
    if (filter.type === 'date') {
      return html`<input class="input dt-filter" type="date" data-filter="${filter.key}" aria-label="${filter.label}" title="${filter.label}" value="${current}">`;
    }
    return html`<input class="input dt-filter dt-filter-text" type="text" data-filter="${filter.key}" placeholder="${filter.placeholder || filter.label}" aria-label="${filter.label}" value="${current}" autocomplete="off">`;
  }

  function toolbarView() {
    const placeholder = opts.searchPlaceholder || 'Buscar…';
    return html`
      <div class="dt-toolbar">
        ${opts.search ? html`
          <label class="dt-search">
            <span class="dt-search-icon" aria-hidden="true">${ic('search')}</span>
            <input class="input dt-search-input" type="search" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off">
          </label>` : ''}
        ${filters.length ? html`<div class="dt-filters">${join(filters.map(filterView))}</div>` : ''}
        <div class="dt-toolbar-end">
          <span class="dt-count" aria-live="polite"></span>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" data-dt="reload" aria-label="Atualizar lista" title="Atualizar">${ic('refresh-cw')}</button>
        </div>
      </div>`;
  }

  render(el, html`
    <div class="dt" id="${id}">
      ${toolbarView()}
      <div class="table-wrap dt-wrap" aria-busy="false">
        <div class="dt-body"></div>
        <div class="dt-footer"></div>
        <div class="dt-loading" aria-hidden="true" hidden>${ic('loader-circle', 24)}</div>
      </div>
    </div>`);

  const wrapEl = el.querySelector('.dt-wrap');
  const bodyEl = el.querySelector('.dt-body');
  const footerEl = el.querySelector('.dt-footer');
  const loadingEl = el.querySelector('.dt-loading');
  const countEl = el.querySelector('.dt-count');
  const searchInput = el.querySelector('.dt-search-input');

  // ---------------------------------------------------------------- tabela
  function alignClass(col) {
    if (col.align === 'right') return 'num';
    if (col.align === 'center') return 'center';
    return '';
  }

  function headerCell(col) {
    const sortable = Boolean(col.sortable);
    const active = sortable && state.sort === col.key;
    let ariaSort = '';
    if (active) ariaSort = state.dir === 'asc' ? 'ascending' : 'descending';
    else if (sortable) ariaSort = 'none';
    const width = cssWidth(col.width);
    const classes = [alignClass(col)];
    if (sortable) classes.push('sortable');
    if (active) classes.push('sorted');
    if (col.className) classes.push(col.className);
    return html`
      <th scope="col" class="${classes.filter(Boolean).join(' ')}" ${width ? raw(`style="width:${width}"`) : ''} ${ariaSort ? raw(`aria-sort="${ariaSort}"`) : ''}>
        ${sortable
          ? html`<button type="button" class="dt-sort${active ? ' is-active' : ''}" data-dt="sort" data-key="${col.key}" title="Ordenar por ${col.label}">
              <span>${col.label}</span>
              <span class="dt-sort-icon" aria-hidden="true">${ic(active ? (state.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down', 14)}</span>
            </button>`
          : col.label}
      </th>`;
  }

  function cellView(col, row) {
    const value = row?.[col.key];
    let content;
    if (typeof col.render === 'function') {
      const out = col.render(row, value);
      content = out == null ? '' : raw(String(out));
    } else {
      content = formatCell(value);
    }
    const classes = [alignClass(col)];
    if (col.className) classes.push(col.className);
    if (col.nowrap) classes.push('dt-nowrap');
    return html`<td class="${classes.filter(Boolean).join(' ')}">${content}</td>`;
  }

  function actionsView(row, index) {
    const buttons = rowActions.map((action, i) => {
      if (typeof action.hidden === 'function' && action.hidden(row)) return '';
      const disabled = typeof action.disabled === 'function' ? action.disabled(row) : Boolean(action.disabled);
      const classes = ['btn', 'btn-ghost', 'btn-sm'];
      if (action.icon) classes.push('btn-icon');
      if (action.danger) classes.push('dt-action-danger');
      return html`
        <button type="button" class="${classes.join(' ')}" data-dt="action" data-action-index="${i}" data-row-index="${index}"
          aria-label="${action.label}" title="${action.label}" ${disabled ? raw('disabled') : ''}>
          ${action.icon ? ic(action.icon) : action.label}
        </button>`;
    });
    return html`<td class="actions dt-actions">${join(buttons)}</td>`;
  }

  function rowView(row, index) {
    const clickable = typeof opts.onRowClick === 'function';
    const key = row?.[rowKey];
    return html`
      <tr class="dt-row${clickable ? ' is-clickable' : ''}" data-row-index="${index}" ${key != null ? raw(`data-id="${escapeHtml(String(key))}"`) : ''} ${clickable ? raw('tabindex="0"') : ''}>
        ${join(columns.map((col) => cellView(col, row)))}
        ${rowActions.length ? actionsView(row, index) : ''}
      </tr>`;
  }

  function tableView() {
    return html`
      <table class="table dt-table${opts.compact ? ' table-sm' : ''}">
        <thead>
          <tr>
            ${join(columns.map(headerCell))}
            ${rowActions.length ? html`<th scope="col" class="actions dt-th-actions"><span class="sr-only">Ações</span></th>` : ''}
          </tr>
        </thead>
        <tbody>${join(state.items.map(rowView))}</tbody>
      </table>`;
  }

  function hasActiveFilters() {
    return Boolean(state.q) || Object.values(state.filters).some((v) => v != null && v !== '');
  }

  function bodyView() {
    if (state.error) {
      return html`
        <div class="alert alert-danger dt-error" role="alert">
          ${ic('triangle-alert', 18)}
          <div class="alert-body dt-error-text">${state.error}</div>
          <button type="button" class="btn btn-secondary btn-sm" data-dt="retry">Tentar novamente</button>
        </div>`;
    }
    if (!state.loaded) {
      return html`<div class="dt-skeleton">${skeleton('table')}</div>`;
    }
    if (!state.items.length) {
      return html`<div class="dt-empty">${emptyState({
        icon: hasActiveFilters() ? 'search' : 'inbox',
        title: emptyText,
        text: hasActiveFilters() ? 'Ajuste a busca ou os filtros para ver mais resultados.' : '',
        size: 'sm',
      })}</div>`;
    }
    return tableView();
  }

  function footerView() {
    if (!state.loaded || state.error || state.total <= 0) return html``;
    const pages = Math.max(1, Math.ceil(state.total / pageSize));
    const from = (state.page - 1) * pageSize + 1;
    const to = Math.min(state.page * pageSize, state.total);
    const numbers = pageWindow(state.page, pages).map((p) => (
      p === '…'
        ? html`<span class="dt-ellipsis" aria-hidden="true">…</span>`
        : html`<button type="button" class="btn btn-ghost btn-sm dt-page${p === state.page ? ' active' : ''}" data-dt="page" data-page="${p}"
            aria-label="Página ${p}" ${p === state.page ? raw('aria-current="page"') : ''}>${p}</button>`
    ));
    return html`
      <div class="table-footer dt-pagination">
        <span class="dt-range">Mostrando ${numberFormat.format(from)}–${numberFormat.format(to)} de ${numberFormat.format(state.total)}</span>
        ${pages > 1 ? html`
          <nav class="pagination dt-pages" aria-label="Paginação">
            <button type="button" class="btn btn-secondary btn-sm btn-icon" data-dt="page" data-page="${state.page - 1}" aria-label="Página anterior" ${state.page <= 1 ? raw('disabled') : ''}>${ic('chevron-left')}</button>
            ${join(numbers)}
            <button type="button" class="btn btn-secondary btn-sm btn-icon" data-dt="page" data-page="${state.page + 1}" aria-label="Próxima página" ${state.page >= pages ? raw('disabled') : ''}>${ic('chevron-right')}</button>
          </nav>` : ''}
      </div>`;
  }

  function paint() {
    if (destroyed) return;
    render(bodyEl, bodyView());
    render(footerEl, footerView());
    const overlay = state.loading && state.loaded && !state.error;
    wrapEl.classList.toggle('is-loading', overlay);
    wrapEl.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    loadingEl.hidden = !overlay;
    if (state.loaded && !state.error) {
      countEl.textContent = `${numberFormat.format(state.total)} ${state.total === 1 ? 'registro' : 'registros'}`;
    } else {
      countEl.textContent = '';
    }
  }

  // ---------------------------------------------------------------- dados
  function buildQuery() {
    const query = { page: state.page, limit: pageSize };
    if (state.q) query.q = state.q;
    if (state.sort) { query.sort = state.sort; query.dir = state.dir; }
    for (const [key, value] of Object.entries(state.filters)) {
      if (value != null && value !== '') query[key] = value;
    }
    for (const [key, value] of Object.entries(state.params)) {
      if (value != null && value !== '') query[key] = value;
    }
    return query;
  }

  async function load() {
    const requestId = ++requestSeq;
    state.loading = true;
    state.error = null;
    paint();
    try {
      const response = await opts.fetch(state.page, buildQuery());
      if (destroyed || requestId !== requestSeq) return;
      const items = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
      const total = Number.isFinite(Number(response?.total)) ? Number(response.total) : items.length;
      state.items = items;
      state.total = total;
      state.loaded = true;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (state.page > pages) {
        // a página atual deixou de existir (ex.: após exclusão): volta para a última válida
        state.page = pages;
        state.loading = false;
        await load();
        return;
      }
    } catch (err) {
      if (destroyed || requestId !== requestSeq) return;
      state.error = err?.message || 'Não foi possível carregar os dados.';
    }
    state.loading = false;
    paint();
  }

  function reload({ resetPage = false } = {}) {
    if (resetPage) state.page = 1;
    return load();
  }

  function setPage(page) {
    const pages = Math.max(1, Math.ceil(state.total / pageSize));
    const next = Math.min(Math.max(1, Number(page) || 1), pages);
    if (next === state.page) return;
    state.page = next;
    load();
  }

  function toggleSort(key) {
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = key; state.dir = 'asc'; }
    state.page = 1;
    load();
  }

  function setFilter(key, value) {
    const next = value == null ? '' : String(value);
    if ((state.filters[key] ?? '') === next) return;
    state.filters[key] = next;
    const control = el.querySelector(`[data-filter="${CSS.escape(String(key))}"]`);
    if (control && control.value !== next) control.value = next;
    state.page = 1;
    load();
  }

  function setSearch(q) {
    const next = String(q ?? '').trim();
    if (next === state.q) return;
    state.q = next;
    if (searchInput && searchInput.value !== next) searchInput.value = next;
    state.page = 1;
    load();
  }

  function setParams(params = {}, { reload: shouldReload = true } = {}) {
    state.params = { ...state.params, ...params };
    state.page = 1;
    if (shouldReload) load();
  }

  // ---------------------------------------------------------------- eventos
  function onClick(event) {
    const control = event.target.closest('[data-dt]');
    if (control && el.contains(control)) {
      switch (control.dataset.dt) {
        case 'reload':
        case 'retry':
          load();
          return;
        case 'sort':
          toggleSort(control.dataset.key);
          return;
        case 'page':
          if (!control.disabled) setPage(Number(control.dataset.page));
          return;
        case 'action': {
          const action = rowActions[Number(control.dataset.actionIndex)];
          const row = state.items[Number(control.dataset.rowIndex)];
          if (action && row && typeof action.onClick === 'function') action.onClick(row, api);
          return;
        }
        default:
          return;
      }
    }
    if (typeof opts.onRowClick !== 'function') return;
    if (event.target.closest('a, button, input, select, textarea, label')) return;
    const rowEl = event.target.closest('tr.dt-row');
    if (!rowEl || !el.contains(rowEl)) return;
    const row = state.items[Number(rowEl.dataset.rowIndex)];
    if (row) opts.onRowClick(row);
  }

  function onKeydown(event) {
    if (event.key !== 'Enter' || typeof opts.onRowClick !== 'function') return;
    const rowEl = event.target.closest('tr.dt-row');
    if (!rowEl || event.target !== rowEl) return;
    const row = state.items[Number(rowEl.dataset.rowIndex)];
    if (row) { event.preventDefault(); opts.onRowClick(row); }
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; setSearch(searchInput.value); }, SEARCH_DEBOUNCE_MS);
  }

  function onSearchKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = null;
      setSearch(searchInput.value);
    }
  }

  function onFilterChange(event) {
    const control = event.target.closest('[data-filter]');
    if (!control || !el.contains(control)) return;
    const key = control.dataset.filter;
    if (event.type === 'input' && control.classList.contains('dt-filter-text')) {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { filterTimer = null; setFilter(key, control.value.trim()); }, SEARCH_DEBOUNCE_MS);
      return;
    }
    if (event.type === 'change') setFilter(key, control.value);
  }

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKeydown);
  el.addEventListener('change', onFilterChange);
  el.addEventListener('input', onFilterChange);
  if (searchInput) {
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', onSearchKeydown);
  }

  const api = {
    reload,
    setFilter,
    setSearch,
    setPage,
    setParams,
    getItems: () => state.items.slice(),
    getState: () => ({
      page: state.page,
      pageSize,
      q: state.q,
      sort: state.sort,
      dir: state.dir,
      filters: { ...state.filters },
      params: { ...state.params },
      items: state.items.slice(),
      total: state.total,
      loading: state.loading,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      requestSeq += 1;
      if (searchTimer) clearTimeout(searchTimer);
      if (filterTimer) clearTimeout(filterTimer);
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeydown);
      el.removeEventListener('change', onFilterChange);
      el.removeEventListener('input', onFilterChange);
      if (searchInput) {
        searchInput.removeEventListener('input', onSearchInput);
        searchInput.removeEventListener('keydown', onSearchKeydown);
      }
      el.innerHTML = '';
    },
  };

  load();
  return api;
}

export default mountTable;

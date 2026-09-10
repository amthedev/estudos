// =====================================================================
// Foco Elite — núcleo de interface (ARCHITECTURE §6.2)
// html / raw / render / toast / modal / confirm / pageHeader / emptyState /
// skeleton / progressBar / badge / statCard / tabs / dropdown / debounce /
// qs / qsa / on — mais alguns auxiliares de formulário e estado de erro.
// =====================================================================
import { icon } from './icons.js';

const BRAND = 'Foco Elite';

// ---------------------------------------------------------------------
// HTML seguro
// ---------------------------------------------------------------------

/** Marca uma string como HTML confiável (não será escapada por `html`). */
export class SafeHtml extends String {}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto para uso em HTML. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** Envolve HTML já confiável para interpolação sem escape. */
export function raw(str) {
  if (str instanceof SafeHtml) return str;
  return new SafeHtml(str == null ? '' : String(str));
}

export function isSafe(value) {
  return value instanceof SafeHtml;
}

function toHtml(value) {
  if (value == null || value === false || value === true) return '';
  if (value instanceof SafeHtml) return String(value);
  if (Array.isArray(value)) return value.map(toHtml).join('');
  if (typeof value === 'function') return '';
  if (value instanceof Node) {
    const wrapper = document.createElement('div');
    wrapper.appendChild(value.cloneNode(true));
    return wrapper.innerHTML;
  }
  return escapeHtml(value);
}

/**
 * Tagged template: `html\`<b>${nome}</b>\``.
 * Valores interpolados são escapados; arrays são juntados; `raw()`/`html\`\``
 * são inseridos sem escape. Retorna SafeHtml (subclasse de String).
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += toHtml(values[i]);
  }
  return new SafeHtml(out);
}

/** Renderiza HTML (string, SafeHtml ou Node) em um elemento ou seletor. */
export function render(el, content) {
  const target = typeof el === 'string' ? document.querySelector(el) : el;
  if (!target) return null;
  if (content instanceof Node) {
    target.replaceChildren(content);
  } else if (Array.isArray(content)) {
    target.innerHTML = toHtml(content);
  } else {
    target.innerHTML = content == null ? '' : String(content);
  }
  return target;
}

// ---------------------------------------------------------------------
// Seletores e eventos
// ---------------------------------------------------------------------
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * on(el, 'click', '.btn', fn) → delegação; on(el, 'click', fn) → direto.
 * Retorna função que remove o listener.
 */
export function on(el, event, selector, handler, options) {
  const target = typeof el === 'string' ? document.querySelector(el) : el;
  if (!target) return () => {};
  if (typeof selector === 'function') {
    const fn = selector;
    target.addEventListener(event, fn, handler);
    return () => target.removeEventListener(event, fn, handler);
  }
  const listener = (e) => {
    const match = e.target instanceof Element ? e.target.closest(selector) : null;
    if (match && target.contains(match)) handler.call(match, e, match);
  };
  target.addEventListener(event, listener, options);
  return () => target.removeEventListener(event, listener, options);
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Toast (canto inferior direito)
// ---------------------------------------------------------------------
const TOAST_ICONS = { success: 'circle-check', error: 'circle-alert', warning: 'triangle-alert', info: 'info' };

function toastContainer() {
  let el = document.querySelector('.toast-container');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast-container';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'false');
    document.body.appendChild(el);
  }
  return el;
}

/**
 * toast('Salvo', { type: 'success' | 'error' | 'info' | 'warning', title, duration })
 */
export function toast(message, { type = 'info', title = '', duration } = {}) {
  const container = toastContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = String(html`
    <span class="toast-icon">${icon(TOAST_ICONS[type] || 'info')}</span>
    <div class="toast-body">
      ${title ? html`<div class="toast-title">${title}</div>` : ''}
      <div class="toast-text">${message}</div>
    </div>
    <button type="button" class="toast-close" aria-label="Fechar aviso">${icon('x', { size: 16 })}</button>
  `);
  const ms = duration ?? (type === 'error' ? 6000 : 4000);
  let timer = null;
  const close = () => {
    if (!el.isConnected) return;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    timer = setTimeout(close, 1500);
  });
  container.appendChild(el);
  // limite de 4 avisos simultâneos
  while (container.children.length > 4) container.firstElementChild.remove();
  if (ms > 0) timer = setTimeout(close, ms);
  return { el, close };
}

// ---------------------------------------------------------------------
// Modal acessível (Esc fecha, foco preso, fullscreen no mobile via CSS)
// ---------------------------------------------------------------------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openModals = [];

/**
 * modal({ title, subtitle, body, actions, size, closable, onClose, className })
 * actions: [{ label, variant: 'primary'|'secondary'|'ghost'|'danger', onClick(ctx), close: true, icon, id }]
 *   onClick pode retornar Promise (botão entra em carregamento) e `false` para manter aberto.
 * Retorna { el, body, close, setTitle, setLoading }.
 */
export function modal({ title = '', subtitle = '', body = '', actions = [], size = '', closable = true, onClose, className = '', danger = false } = {}) {
  const previousFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  backdrop.innerHTML = String(html`
    <div class="modal ${size ? `modal-${size}` : ''} ${danger ? 'modal-danger' : ''} ${className}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <div class="modal-header">
        <div class="modal-heading">
          <h2 class="modal-title" id="${titleId}">${title}</h2>
          ${subtitle ? html`<p class="modal-subtitle">${subtitle}</p>` : ''}
        </div>
        ${closable ? html`<button type="button" class="btn btn-ghost btn-icon modal-close" aria-label="Fechar">${icon('x')}</button>` : ''}
      </div>
      <div class="modal-body"></div>
      <div class="modal-footer"></div>
    </div>
  `);
  const dialog = backdrop.querySelector('.modal');
  const bodyEl = backdrop.querySelector('.modal-body');
  const footer = backdrop.querySelector('.modal-footer');

  if (body instanceof Node) bodyEl.appendChild(body);
  else bodyEl.innerHTML = String(body ?? '');

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.classList.add('is-closing');
    const idx = openModals.indexOf(api);
    if (idx >= 0) openModals.splice(idx, 1);
    if (!openModals.length) document.body.classList.remove('modal-open');
    setTimeout(() => backdrop.remove(), 150);
    if (typeof onClose === 'function') onClose(result);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  };

  const api = {
    el: dialog,
    backdrop,
    body: bodyEl,
    footer,
    close,
    setTitle(text) {
      dialog.querySelector('.modal-title').textContent = text;
    },
    setLoading(flag) {
      qsa('.btn', footer).forEach((b) => {
        b.disabled = !!flag;
        if (b.dataset.primary === 'true') b.classList.toggle('is-loading', !!flag);
      });
    },
  };

  actions.forEach((action, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const variant = action.variant || (i === actions.length - 1 ? 'primary' : 'secondary');
    btn.className = `btn btn-${variant}${action.className ? ` ${action.className}` : ''}`;
    if (action.id) btn.id = action.id;
    if (variant === 'primary' || variant === 'danger') btn.dataset.primary = 'true';
    btn.innerHTML = `${action.icon ? icon(action.icon) : ''}<span>${escapeHtml(action.label || 'OK')}</span>`;
    if (action.disabled) btn.disabled = true;
    btn.addEventListener('click', async () => {
      if (typeof action.onClick !== 'function') {
        if (action.close !== false) close(action.value);
        return;
      }
      try {
        const maybe = action.onClick({ close, modal: api, button: btn });
        if (maybe && typeof maybe.then === 'function') {
          setLoading(btn, true);
          api.setLoading(true);
          const result = await maybe;
          if (!closed) {
            api.setLoading(false);
            setLoading(btn, false);
          }
          if (result !== false && action.close !== false) close(result);
        } else if (maybe !== false && action.close !== false) {
          close(maybe);
        }
      } catch (err) {
        if (!closed) {
          api.setLoading(false);
          setLoading(btn, false);
        }
        toast(err && err.message ? err.message : 'Não foi possível concluir a ação.', { type: 'error' });
      }
    });
    footer.appendChild(btn);
  });

  const onKeydown = (e) => {
    if (openModals[openModals.length - 1] !== api) return;
    if (e.key === 'Escape' && closable) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = qsa(FOCUSABLE, dialog).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!focusable.length) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  if (closable) {
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) backdrop.dataset.downOutside = '1';
    });
    backdrop.addEventListener('mouseup', (e) => {
      if (e.target === backdrop && backdrop.dataset.downOutside === '1') close();
      delete backdrop.dataset.downOutside;
    });
    backdrop.querySelector('.modal-close')?.addEventListener('click', () => close());
  }
  document.addEventListener('keydown', onKeydown, true);
  document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  openModals.push(api);

  // foco inicial: primeiro campo, senão primeiro botão de ação, senão o diálogo
  requestAnimationFrame(() => {
    const target = bodyEl.querySelector(FOCUSABLE) || footer.querySelector('[data-primary="true"]') || dialog;
    target.focus({ preventScroll: true });
  });

  return api;
}

/**
 * confirm({ title, message, danger, confirmText, cancelText }) → Promise<boolean>
 */
export function confirm({ title = 'Confirmar', message = '', danger = false, confirmText, cancelText = 'Cancelar', icon: iconName } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const bodyHtml = html`
      <div class="flex gap-3 items-start">
        ${iconName || danger ? html`<span class="icon-box ${danger ? 'red' : ''}">${icon(iconName || 'triangle-alert')}</span>` : ''}
        <div class="flex-1 text-2" style="padding-top:8px">${message instanceof SafeHtml ? message : escapeHtml(message)}</div>
      </div>
    `;
    modal({
      title,
      body: bodyHtml,
      size: 'sm',
      danger,
      onClose: () => settle(false),
      actions: [
        { label: cancelText, variant: 'ghost', onClick: ({ close }) => { settle(false); close(); return false; } },
        { label: confirmText || (danger ? 'Excluir' : 'Confirmar'), variant: danger ? 'danger' : 'primary', onClick: ({ close }) => { settle(true); close(); return false; } },
      ],
    });
  });
}

// ---------------------------------------------------------------------
// Blocos de página
// ---------------------------------------------------------------------

/**
 * pageHeader({ title, subtitle, actions, breadcrumb })
 * breadcrumb: [{ label, href }] ou SafeHtml. actions: string | SafeHtml | array.
 */
export function pageHeader({ title = '', subtitle = '', actions = '', breadcrumb = null, eyebrow = '' } = {}) {
  let crumbs = '';
  if (Array.isArray(breadcrumb) && breadcrumb.length) {
    crumbs = html`<nav class="breadcrumb" aria-label="Você está aqui">${breadcrumb.map((item, i) => {
      const isLast = i === breadcrumb.length - 1;
      const node = item.href && !isLast
        ? html`<a href="${item.href}">${item.label}</a>`
        : html`<span class="${isLast ? 'current' : ''}">${item.label}</span>`;
      return html`${i > 0 ? html`<span class="breadcrumb-sep">${icon('chevron-right', { size: 14 })}</span>` : ''}${node}`;
    })}</nav>`;
  } else if (breadcrumb) {
    crumbs = raw(breadcrumb);
  }
  return html`
    <header class="page-header">
      <div class="page-header-main">
        ${crumbs}
        ${eyebrow ? html`<div class="eyebrow mb-2">${eyebrow}</div>` : ''}
        <h1 class="page-title">${title}</h1>
        ${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : ''}
      </div>
      ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
    </header>
  `;
}

/**
 * emptyState({ icon, title, text, action })
 * action: { label, href, icon, variant, id } | SafeHtml | string
 */
export function emptyState({ icon: iconName = 'inbox', title = 'Nada por aqui ainda', text = '', action = null, size = '', className = '' } = {}) {
  let actionHtml = '';
  if (action && typeof action === 'object' && !(action instanceof SafeHtml)) {
    const inner = html`${action.icon ? icon(action.icon) : ''}<span>${action.label}</span>`;
    actionHtml = action.href
      ? html`<a class="btn btn-${action.variant || 'primary'}" href="${action.href}" ${action.id ? raw(`id="${escapeHtml(action.id)}"`) : ''}>${inner}</a>`
      : html`<button type="button" class="btn btn-${action.variant || 'primary'}" ${action.id ? raw(`id="${escapeHtml(action.id)}"`) : ''} ${action.dataAction ? raw(`data-action="${escapeHtml(action.dataAction)}"`) : ''}>${inner}</button>`;
  } else if (action) {
    actionHtml = raw(action);
  }
  return html`
    <div class="empty ${size ? `empty-${size}` : ''} ${className}">
      <div class="empty-icon">${icon(iconName)}</div>
      <div class="empty-title">${title}</div>
      ${text ? html`<p class="empty-text">${text}</p>` : ''}
      ${actionHtml ? html`<div class="empty-action">${actionHtml}</div>` : ''}
    </div>
  `;
}

/**
 * errorState({ title, message, retry }) — estado de erro com "Tentar novamente".
 * retry: id/data-action do botão (o chamador liga o evento) ou `false` para omitir.
 */
export function errorState({ title = 'Não foi possível carregar', message = 'Verifique sua conexão e tente novamente.', retryLabel = 'Tentar novamente', retry = 'retry' } = {}) {
  return html`
    <div class="empty error-state" role="alert">
      <div class="empty-icon">${icon('triangle-alert')}</div>
      <div class="empty-title">${title}</div>
      <p class="empty-text">${message}</p>
      ${retry ? html`<div class="empty-action"><button type="button" class="btn btn-secondary" data-action="${retry}">${icon('refresh-cw')}<span>${retryLabel}</span></button></div>` : ''}
    </div>
  `;
}

const SKELETONS = {
  text: () => '<span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text" style="width:92%"></span><span class="skeleton skeleton-text" style="width:70%"></span>',
  title: () => '<span class="skeleton skeleton-title"></span>',
  card: () => '<div class="skeleton-card"><span class="skeleton skeleton-title" style="width:45%"></span><div class="mt-4"><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text" style="width:85%"></span><span class="skeleton skeleton-text" style="width:60%"></span></div></div>',
  cards: (n = 3) => `<div class="grid grid-${Math.min(n, 4)}">${Array.from({ length: n }, () => SKELETONS.card()).join('')}</div>`,
  stat: () => '<div class="skeleton-card"><div class="skeleton-row"><span class="skeleton skeleton-circle"></span><div class="flex-1"><span class="skeleton skeleton-text" style="width:50%"></span><span class="skeleton skeleton-title" style="width:35%;margin-top:10px"></span></div></div></div>',
  stats: (n = 4) => `<div class="grid grid-4">${Array.from({ length: n }, () => SKELETONS.stat()).join('')}</div>`,
  list: (n = 5) => `<div class="skeleton-group">${Array.from({ length: n }, () => '<div class="skeleton-row"><span class="skeleton skeleton-circle"></span><div class="flex-1"><span class="skeleton skeleton-text" style="width:60%"></span><span class="skeleton skeleton-text" style="width:35%;margin-top:8px"></span></div><span class="skeleton skeleton-btn" style="width:80px;height:30px"></span></div>').join('')}</div>`,
  table: (n = 6) => `<div class="skeleton-card"><div class="skeleton-row mb-4"><span class="skeleton skeleton-text" style="width:20%"></span><span class="skeleton skeleton-text" style="width:30%"></span><span class="skeleton skeleton-text" style="width:15%"></span><span class="skeleton skeleton-text" style="width:15%"></span></div>${Array.from({ length: n }, () => '<div class="skeleton-row mb-3"><span class="skeleton skeleton-text" style="width:20%"></span><span class="skeleton skeleton-text" style="width:30%"></span><span class="skeleton skeleton-text" style="width:15%"></span><span class="skeleton skeleton-text" style="width:15%"></span></div>').join('')}</div>`,
  chart: () => '<div class="skeleton-card"><span class="skeleton skeleton-title" style="width:30%"></span><span class="skeleton skeleton-block mt-4" style="height:240px"></span></div>',
  form: (n = 4) => `<div class="skeleton-group">${Array.from({ length: n }, () => '<div><span class="skeleton skeleton-text" style="width:25%;height:10px"></span><span class="skeleton skeleton-btn mt-2" style="width:100%;height:42px"></span></div>').join('')}</div>`,
  header: () => '<div class="mb-6"><span class="skeleton skeleton-title" style="width:280px;height:30px"></span><span class="skeleton skeleton-text mt-3" style="width:360px"></span></div>',
  page: () => `${SKELETONS.header()}${SKELETONS.stats(4)}<div class="mt-4">${SKELETONS.cards(2)}</div>`,
  block: (h = 160) => `<span class="skeleton skeleton-block" style="height:${Number(h) || 160}px"></span>`,
  question: () => '<div class="skeleton-card"><div class="skeleton-row mb-4"><span class="skeleton skeleton-text" style="width:90px;height:20px"></span><span class="skeleton skeleton-text" style="width:70px;height:20px"></span></div><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text" style="width:95%"></span><span class="skeleton skeleton-text" style="width:80%"></span><div class="mt-5 skeleton-group">' + Array.from({ length: 5 }, () => '<span class="skeleton skeleton-btn" style="width:100%;height:52px"></span>').join('') + '</div></div>',
};

/** skeleton('page' | 'card' | 'cards' | 'stat' | 'stats' | 'list' | 'table' | 'text' | 'title' | 'chart' | 'form' | 'header' | 'block' | 'question', n) */
export function skeleton(kind = 'text', arg) {
  const fn = SKELETONS[kind] || SKELETONS.text;
  return raw(`<div class="skeleton-wrap" aria-busy="true" aria-live="polite">${fn(arg)}</div>`);
}

/** progressBar(72, { color: 'success', label: 'Progresso', size: 'sm', showValue: true }) */
export function progressBar(pct, { color = '', label = '', size = '', showValue = !!label, className = '' } = {}) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const rounded = Math.round(value);
  const bar = html`
    <div class="progress ${size ? `progress-${size}` : ''} ${color ? `progress-${color}` : ''} ${className}" role="progressbar" aria-valuenow="${rounded}" aria-valuemin="0" aria-valuemax="100" ${label ? raw(`aria-label="${escapeHtml(label)}"`) : ''}>
      <div class="progress-bar" style="width:${value}%"></div>
    </div>`;
  if (!label && !showValue) return bar;
  return html`
    <div class="progress-wrap">
      <div class="progress-meta"><span>${label}</span>${showValue ? html`<strong>${rounded}%</strong>` : ''}</div>
      ${bar}
    </div>`;
}

const TONES = {
  blue: 'badge-blue', green: 'badge-green', orange: 'badge-orange', red: 'badge-red', gray: 'badge-gray',
  primary: 'badge-blue', info: 'badge-blue', success: 'badge-green', warning: 'badge-orange', danger: 'badge-red', muted: 'badge-gray', solid: 'badge-solid',
};

/** badge('Ativo', 'green') */
export function badge(text, tone = 'gray', { icon: iconName, dot = false, size = '' } = {}) {
  return html`<span class="badge ${TONES[tone] || TONES.gray} ${dot ? 'badge-dot' : ''} ${size ? `badge-${size}` : ''}">${iconName ? icon(iconName) : ''}${text}</span>`;
}

const STAT_TONES = { blue: '', primary: '', green: 'stat-green', success: 'stat-green', orange: 'stat-orange', warning: 'stat-orange', red: 'stat-red', danger: 'stat-red', gray: 'stat-gray', muted: 'stat-gray' };

/**
 * statCard({ label, value, hint, icon, tone, delta, unit, href })
 * delta: número (positivo/negativo) ou { value, label, direction: 'up'|'down'|'flat' }
 */
export function statCard({ label = '', value = '—', hint = '', icon: iconName = '', tone = 'blue', delta = null, unit = '', href = '', className = '', compact = false } = {}) {
  let deltaHtml = '';
  if (delta !== null && delta !== undefined) {
    const d = typeof delta === 'object' ? delta : { value: delta };
    const num = Number(d.value);
    const direction = d.direction || (Number.isNaN(num) ? 'flat' : num > 0 ? 'up' : num < 0 ? 'down' : 'flat');
    const text = d.label ?? (Number.isNaN(num) ? String(d.value) : `${num > 0 ? '+' : ''}${num}${d.suffix ?? '%'}`);
    const arrow = direction === 'up' ? 'trending-up' : direction === 'down' ? 'trending-down' : 'minus';
    deltaHtml = html`<span class="stat-delta ${direction}">${icon(arrow)}${text}</span>`;
  }
  const inner = html`
    ${iconName ? html`<div class="stat-icon">${icon(iconName)}</div>` : ''}
    <div class="stat-body">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}${unit ? html`<small>${unit}</small>` : ''}${deltaHtml}</div>
      ${hint ? html`<div class="stat-hint">${hint}</div>` : ''}
    </div>`;
  const cls = `stat ${STAT_TONES[tone] || ''} ${compact ? 'stat-compact' : ''} ${href ? 'card-hover' : ''} ${className}`;
  return href ? html`<a class="${cls}" href="${href}">${inner}</a>` : html`<div class="${cls}">${inner}</div>`;
}

/** ring(72, { size: 'lg', color: 'success', label: '72%' }) → anel de progresso SVG */
export function ring(pct, { size = '', color = '', label, className = '' } = {}) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 42;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  return html`
    <div class="ring ${size ? `ring-${size}` : ''} ${color ? `ring-${color}` : ''} ${className}" role="img" aria-label="${Math.round(value)}%">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-track" cx="50" cy="50" r="${r}"></circle>
        <circle class="ring-value" cx="50" cy="50" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
      <span class="ring-label">${label ?? `${Math.round(value)}%`}</span>
    </div>`;
}

// ---------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------
/**
 * tabs(el, [{ id, label, icon, count }], onChange, { active, pills })
 * Retorna { set(id), get(), el }.
 */
export function tabs(el, items = [], onChange, { active, pills = false } = {}) {
  const target = typeof el === 'string' ? document.querySelector(el) : el;
  if (!target) return null;
  let current = active ?? (items[0] && items[0].id);
  const nav = document.createElement('div');
  nav.className = `tabs ${pills ? 'tabs-pills' : ''}`;
  nav.setAttribute('role', 'tablist');
  nav.innerHTML = items.map((item) => `
    <button type="button" role="tab" class="tab ${item.id === current ? 'active' : ''}" data-tab="${escapeHtml(item.id)}" aria-selected="${item.id === current}">
      ${item.icon ? icon(item.icon) : ''}<span>${escapeHtml(item.label)}</span>
      ${item.count !== undefined && item.count !== null ? `<span class="tab-count">${escapeHtml(item.count)}</span>` : ''}
    </button>`).join('');
  target.replaceChildren(nav);

  const set = (id, { silent = false } = {}) => {
    if (!items.some((i) => i.id === id)) return;
    current = id;
    qsa('.tab', nav).forEach((b) => {
      const isActive = b.dataset.tab === String(id);
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', String(isActive));
    });
    if (!silent && typeof onChange === 'function') onChange(id);
  };
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn && btn.dataset.tab !== String(current)) set(btn.dataset.tab);
  });
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = items.findIndex((i) => i.id === current);
    const next = items[(idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    if (next) {
      set(next.id);
      nav.querySelector(`[data-tab="${CSS.escape(String(next.id))}"]`)?.focus();
    }
  });
  return {
    el: nav,
    set,
    get: () => current,
    setCount(id, count) {
      const btn = nav.querySelector(`[data-tab="${CSS.escape(String(id))}"]`);
      if (!btn) return;
      let c = btn.querySelector('.tab-count');
      if (!c) {
        c = document.createElement('span');
        c.className = 'tab-count';
        btn.appendChild(c);
      }
      c.textContent = String(count);
    },
  };
}

// ---------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------
let openDropdown = null;

/**
 * dropdown(trigger, items, { align: 'right'|'left', up, header })
 * items: [{ label, icon, onClick, href, danger, divider, active, disabled, target }]
 * Retorna { open, close, toggle, destroy, menu }.
 */
export function dropdown(trigger, items = [], { align = 'right', up = false, header = '' } = {}) {
  const btn = typeof trigger === 'string' ? document.querySelector(trigger) : trigger;
  if (!btn) return null;
  let wrapper = btn.closest('.dropdown');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'dropdown';
    btn.parentNode.insertBefore(wrapper, btn);
    wrapper.appendChild(btn);
  }
  let menu = wrapper.querySelector(':scope > .dropdown-menu');
  if (!menu) {
    menu = document.createElement('div');
    wrapper.appendChild(menu);
  }
  menu.className = `dropdown-menu ${align === 'left' ? 'dropdown-menu-left' : ''} ${up ? 'dropdown-menu-up' : ''}`;
  menu.setAttribute('role', 'menu');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  const build = () => {
    menu.innerHTML = '';
    if (header) {
      const h = document.createElement('div');
      h.className = 'dropdown-header';
      if (header instanceof SafeHtml) h.innerHTML = String(header);
      else h.textContent = header;
      menu.appendChild(h);
    }
    items.forEach((item) => {
      if (item.divider) {
        const d = document.createElement('div');
        d.className = 'dropdown-divider';
        menu.appendChild(d);
        return;
      }
      const node = document.createElement(item.href ? 'a' : 'button');
      if (item.href) {
        node.href = item.href;
        if (item.target) {
          node.target = item.target;
          node.rel = 'noopener';
        }
      } else node.type = 'button';
      node.className = `dropdown-item ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}`;
      node.setAttribute('role', 'menuitem');
      if (item.disabled) node.disabled = true;
      node.innerHTML = `${item.icon ? icon(item.icon) : ''}<span>${escapeHtml(item.label)}</span>`;
      node.addEventListener('click', (e) => {
        if (typeof item.onClick === 'function') {
          if (!item.href) e.preventDefault();
          item.onClick(e);
        }
        close();
      });
      menu.appendChild(node);
    });
  };

  const close = () => {
    if (!menu.classList.contains('open')) return;
    menu.classList.remove('open');
    wrapper.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
    if (openDropdown === api) openDropdown = null;
  };
  const open = () => {
    if (openDropdown && openDropdown !== api) openDropdown.close();
    build();
    menu.classList.add('open');
    wrapper.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    openDropdown = api;
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  };
  const toggle = () => (menu.classList.contains('open') ? close() : open());
  const onDocClick = (e) => {
    if (!wrapper.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const nodes = qsa('.dropdown-item:not([disabled])', menu);
      if (!nodes.length) return;
      e.preventDefault();
      const idx = nodes.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? nodes[(idx + 1) % nodes.length] : nodes[(idx - 1 + nodes.length) % nodes.length];
      next.focus();
    }
  };
  const onTrigger = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  };
  btn.addEventListener('click', onTrigger);

  const api = {
    open,
    close,
    toggle,
    menu,
    setItems(next) {
      items = next;
      if (menu.classList.contains('open')) build();
    },
    destroy() {
      close();
      btn.removeEventListener('click', onTrigger);
      menu.remove();
    },
  };
  return api;
}

// ---------------------------------------------------------------------
// Formulários e botões
// ---------------------------------------------------------------------

/** Liga/desliga estado de carregamento em um botão. */
export function setLoading(button, loading = true) {
  if (!button) return;
  button.classList.toggle('is-loading', !!loading);
  button.disabled = !!loading;
  button.setAttribute('aria-busy', loading ? 'true' : 'false');
}

/** Lê um formulário em objeto simples (campos múltiplos viram arrays, checkboxes soltos viram boolean). */
export function serializeForm(form) {
  const data = {};
  const fd = new FormData(form);
  const multi = new Set();
  qsa('[name]', form).forEach((field) => {
    if (field.type === 'checkbox' && qsa(`[name="${CSS.escape(field.name)}"]`, form).length > 1) multi.add(field.name);
    if (field.multiple) multi.add(field.name);
  });
  for (const [key, value] of fd.entries()) {
    if (multi.has(key)) {
      (data[key] ||= []).push(value);
    } else if (key in data) {
      data[key] = [].concat(data[key], value);
    } else {
      data[key] = value;
    }
  }
  qsa('input[type="checkbox"][name]', form).forEach((cb) => {
    if (multi.has(cb.name)) {
      data[cb.name] ||= [];
      return;
    }
    if (!(cb.name in data)) data[cb.name] = false;
    else if (data[cb.name] === 'on' || data[cb.name] === cb.value) data[cb.name] = cb.value === 'on' ? true : cb.value;
  });
  return data;
}

/** Marca erro em um campo (input + <p class="error-text" data-error-for="name">). */
export function fieldError(form, name, message) {
  const root = form || document;
  const input = root.querySelector(`[name="${CSS.escape(name)}"]`);
  const msg = root.querySelector(`[data-error-for="${CSS.escape(name)}"]`);
  if (input) {
    input.classList.toggle('is-invalid', !!message);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  if (msg) msg.textContent = message || '';
}

export function clearFieldErrors(form) {
  qsa('.is-invalid', form).forEach((n) => {
    n.classList.remove('is-invalid');
    n.removeAttribute('aria-invalid');
  });
  qsa('[data-error-for]', form).forEach((n) => {
    n.textContent = '';
  });
}

/**
 * Aplica os `details` de um ApiError de validação nos campos do formulário.
 * Aceita array de { path, message } (zod) ou objeto { campo: mensagem }.
 */
export function applyApiErrors(form, error) {
  const details = error && error.details;
  if (!details) return false;
  let applied = false;
  const set = (name, message) => {
    if (!name) return;
    fieldError(form, String(name), message);
    applied = true;
  };
  if (Array.isArray(details)) {
    details.forEach((d) => set(Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path || d.field, d.message));
  } else if (typeof details === 'object') {
    if (Array.isArray(details.issues)) details.issues.forEach((d) => set(Array.isArray(d.path) ? d.path[d.path.length - 1] : d.path, d.message));
    else if (details.fieldErrors && typeof details.fieldErrors === 'object') Object.entries(details.fieldErrors).forEach(([k, v]) => set(k, Array.isArray(v) ? v[0] : v));
    else Object.entries(details).forEach(([k, v]) => set(k, Array.isArray(v) ? v[0] : typeof v === 'string' ? v : v && v.message));
  }
  return applied;
}

/** Sinaliza um erro amigável em um bloco de página (alert + tentar novamente). */
export function alertBox({ type = 'danger', title = '', text = '', actions = '' } = {}) {
  const icons = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert' };
  return html`
    <div class="alert alert-${type}" role="${type === 'danger' ? 'alert' : 'status'}">
      ${icon(icons[type] || 'info')}
      <div class="alert-body">
        ${title ? html`<div class="alert-title">${title}</div>` : ''}
        ${text ? html`<div class="alert-text">${text}</div>` : ''}
        ${actions ? html`<div class="alert-actions">${actions}</div>` : ''}
      </div>
    </div>`;
}

/** Define o título do documento no padrão "X — Foco Elite". */
export function setDocumentTitle(title, suffix = BRAND) {
  document.title = title ? `${title} — ${suffix}` : suffix;
}

// =====================================================================
// Foco Elite — roteador SPA (ARCHITECTURE §6.1)
//
//   const router = createRouter({ routes, mount, onBeforeRoute, onAfterRoute, notFound });
//   router.start();
//   router.navigate('/app/aulas/abc', { replace: false });
//   router.current → { path, route, params, query, title }
//
// - History API; casa os padrões do manifesto na ordem (a primeira que casa vence).
//   '/app' exato casa apenas '/app' e '/app/'. Segmentos ':id' viram params.
// - Intercepta cliques em <a href> internos (mesma origem, sem target, sem modificadores)
//   cujo caminho pertence à base do roteador (ex.: '/app'). Links fora da base seguem
//   a navegação normal do navegador.
// - Ao trocar de rota: chama unmount() da página anterior (se exportado), mostra skeleton,
//   importa a página e chama render(ctx) com
//   ctx = { el, params, query, user, profile, exam, navigate, setTitle, route }.
// - import() com falha (arquivo ainda inexistente) → estado "Esta seção está sendo preparada".
// - Erro em render → alert com "Tentar novamente". Rola ao topo e aplica fade-in de 200ms.
// =====================================================================
import { html, render, skeleton, alertBox, emptyState, setDocumentTitle } from './ui.js';
import { icon } from './icons.js';

/** Normaliza um caminho: remove barra final (exceto na raiz) e garante barra inicial. */
export function normalizePath(path) {
  let p = String(path || '/').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/** Converte a query string em objeto ({ q: 'x' }; chaves repetidas viram arrays). */
export function parseQuery(search = '') {
  const out = {};
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of params.entries()) {
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** Compila '/app/aulas/:id' em { segments: [...], keys: [...] }. */
function compile(pattern) {
  const segments = normalizePath(pattern).split('/').filter(Boolean);
  return {
    segments,
    keys: segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
  };
}

/** Tenta casar um caminho normalizado com um padrão compilado; devolve params ou null. */
function matchPattern(compiled, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== compiled.segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    const seg = compiled.segments[i];
    if (seg.startsWith(':')) {
      try {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        params[seg.slice(1)] = parts[i];
      }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return params;
}

/** Detecta falha de import dinâmico (arquivo ausente / erro de rede) versus erro de código. */
function isImportFailure(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return (
    err.name === 'TypeError' && /import|module|fetch/i.test(msg)
  ) || /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Cannot find module/i.test(msg);
}

/**
 * createRouter(options)
 * @param {object} options
 * @param {Array<{ path: string, page: () => Promise<Module>, title?: string, bare?: boolean, public?: boolean }>} options.routes
 * @param {HTMLElement|string} options.mount           elemento onde as páginas são renderizadas
 * @param {(route, info) => string|false|void|Promise} [options.onBeforeRoute]  string = redireciona; false = cancela
 * @param {(route, ctx) => void} [options.onAfterRoute]
 * @param {(ctx) => void|string} [options.notFound]     renderiza a página 404 (recebe ctx)
 * @param {() => object} [options.context]              dados extras para o ctx (user, profile, exam…)
 * @param {(title: string, route) => void} [options.onTitle]
 * @param {string} [options.base]                       prefixo interceptado (inferido das rotas)
 * @param {string} [options.brand]                      sufixo do document.title
 * @param {string} [options.homePath]                   destino do botão "Voltar ao início"
 */
export function createRouter({
  routes = [],
  mount,
  onBeforeRoute,
  onAfterRoute,
  notFound,
  context,
  onTitle,
  base,
  brand = 'Foco Elite',
  homePath,
} = {}) {
  const table = routes.map((route) => ({ ...route, compiled: compile(route.path) }));
  const inferredBase = table.length ? `/${table[0].compiled.segments[0] || ''}` : '/';
  const basePath = normalizePath(base || inferredBase);
  const home = homePath || basePath;

  let mountEl = null;
  let started = false;
  let navId = 0;
  let activeModule = null;
  let current = { path: null, route: null, params: {}, query: {}, title: '' };
  let removeListeners = [];

  const getMount = () => {
    if (!mountEl) mountEl = typeof mount === 'string' ? document.querySelector(mount) : mount;
    return mountEl;
  };

  /** Verdadeiro quando o caminho pertence à área controlada por este roteador. */
  const owns = (path) => {
    const p = normalizePath(path);
    return basePath === '/' || p === basePath || p.startsWith(`${basePath}/`);
  };

  /** Encontra a primeira rota que casa (ordem do manifesto). */
  const match = (path) => {
    const p = normalizePath(path);
    for (const route of table) {
      const params = matchPattern(route.compiled, p);
      if (params) return { route, params };
    }
    return { route: null, params: {} };
  };

  const setTitle = (title, route = current.route) => {
    current.title = title || '';
    setDocumentTitle(title, brand);
    if (typeof onTitle === 'function') onTitle(title || '', route);
  };

  const restartEnter = (el) => {
    el.classList.remove('page-enter');
    // força reflow para reiniciar a animação de entrada (fade 200ms)
    void el.offsetWidth; // eslint-disable-line no-void
    el.classList.add('page-enter');
  };

  const scrollTop = () => {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  };

  /** Chama unmount() da página anterior sem deixar erros vazarem. */
  const unmountActive = async () => {
    const mod = activeModule;
    activeModule = null;
    if (mod && typeof mod.unmount === 'function') {
      try {
        await mod.unmount();
      } catch (err) {
        console.error('[router] erro em unmount()', err);
      }
    }
  };

  const renderPending = (el) => {
    render(
      el,
      emptyState({
        icon: 'hourglass',
        title: 'Esta seção está sendo preparada',
        text: 'O conteúdo desta área ainda não está disponível. Volte em breve.',
        action: html`<a class="btn btn-primary" href="${home}">${icon('arrow-left')}<span>Voltar ao início</span></a>`,
      })
    );
  };

  const renderError = (el, err, path) => {
    render(
      el,
      html`
        <div class="page-error">
          ${alertBox({
            type: 'danger',
            title: 'Não foi possível carregar esta página',
            text: (err && err.message) || 'Ocorreu um erro inesperado.',
            actions: html`
              <button type="button" class="btn btn-secondary btn-sm" data-router-retry="${path}">${icon('refresh-cw')}<span>Tentar novamente</span></button>
              <a class="btn btn-ghost btn-sm" href="${home}">Voltar ao início</a>`,
          })}
        </div>`
    );
  };

  const renderNotFound = async (ctx) => {
    if (typeof notFound === 'function') {
      const out = await notFound(ctx);
      if (out !== undefined && out !== null) render(ctx.el, out);
      return;
    }
    render(
      ctx.el,
      emptyState({
        icon: 'compass',
        title: 'Página não encontrada',
        text: 'O endereço que você acessou não existe ou foi movido.',
        action: html`<a class="btn btn-primary" href="${home}">${icon('arrow-left')}<span>Voltar ao início</span></a>`,
      })
    );
  };

  /** Resolve e renderiza o caminho informado. */
  const dispatch = async (path, search = '', { replaceOnRedirect = true } = {}) => {
    const id = ++navId;
    const el = getMount();
    if (!el) {
      console.error('[router] elemento de montagem não encontrado');
      return;
    }
    const cleanPath = normalizePath(path);
    const query = parseQuery(search);
    const { route, params } = match(cleanPath);
    const info = { path: cleanPath, params, query, route };

    if (typeof onBeforeRoute === 'function') {
      let verdict;
      try {
        verdict = await onBeforeRoute(route, info);
      } catch (err) {
        console.error('[router] erro em onBeforeRoute', err);
      }
      if (id !== navId) return;
      if (verdict === false) return;
      if (typeof verdict === 'string' && verdict && normalizePath(verdict.split('?')[0]) !== cleanPath) {
        navigate(verdict, { replace: replaceOnRedirect });
        return;
      }
    }

    await unmountActive();
    if (id !== navId) return;

    current = { path: cleanPath, route, params, query, title: route ? route.title || '' : '' };

    const extra = typeof context === 'function' ? context() || {} : context || {};
    const ctx = {
      el,
      params,
      query,
      user: extra.user ?? null,
      profile: extra.profile ?? null,
      exam: extra.exam ?? null,
      ...extra,
      navigate,
      setTitle: (title) => setTitle(title, route),
      route,
      path: cleanPath,
    };

    el.setAttribute('aria-busy', 'true');
    scrollTop();

    if (!route) {
      setTitle('Página não encontrada', null);
      render(el, '');
      try {
        await renderNotFound(ctx);
      } catch (err) {
        renderError(el, err, cleanPath + search);
      }
      el.removeAttribute('aria-busy');
      restartEnter(el);
      if (typeof onAfterRoute === 'function') onAfterRoute(null, ctx);
      return;
    }

    setTitle(route.title || '', route);
    render(el, skeleton(route.skeleton || 'page'));
    if (typeof onAfterRoute === 'function') onAfterRoute(route, ctx);

    let mod;
    try {
      mod = await route.page();
    } catch (err) {
      if (id !== navId) return;
      if (isImportFailure(err)) {
        console.warn(`[router] página ainda não disponível: ${route.path}`, err);
        renderPending(el);
      } else {
        console.error(`[router] erro ao carregar ${route.path}`, err);
        renderError(el, err, cleanPath + search);
      }
      el.removeAttribute('aria-busy');
      restartEnter(el);
      return;
    }
    if (id !== navId) return;

    const renderFn = mod && (typeof mod.default === 'function' ? mod.default : typeof mod.render === 'function' ? mod.render : null);
    if (!renderFn) {
      renderPending(el);
      el.removeAttribute('aria-busy');
      restartEnter(el);
      return;
    }

    activeModule = mod;
    try {
      render(el, '');
      await renderFn(ctx);
    } catch (err) {
      if (id !== navId) return;
      console.error(`[router] erro ao renderizar ${route.path}`, err);
      renderError(el, err, cleanPath + search);
    }
    if (id !== navId) return;
    el.removeAttribute('aria-busy');
    restartEnter(el);
  };

  /** Navegação programática. Caminhos fora da base fazem navegação completa. */
  function navigate(to, { replace = false, state = null } = {}) {
    if (!to) return;
    const url = new URL(String(to), location.origin);
    if (url.origin !== location.origin || !owns(url.pathname)) {
      if (replace) location.replace(url.href);
      else location.assign(url.href);
      return;
    }
    const target = normalizePath(url.pathname) + url.search + url.hash;
    const same = target === normalizePath(location.pathname) + location.search + location.hash;
    if (replace || same) history.replaceState(state, '', target);
    else history.pushState(state, '', target);
    dispatch(url.pathname, url.search);
  }

  /** Renderiza novamente a rota atual (ex.: "Tentar novamente"). */
  const refresh = () => dispatch(location.pathname, location.search);

  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!anchor) return;
    const target = (anchor.getAttribute('target') || '').trim();
    if (target && target !== '_self') return;
    if (anchor.hasAttribute('download')) return;
    const rel = (anchor.getAttribute('rel') || '').toLowerCase();
    if (rel.includes('external')) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    if (!owns(url.pathname)) return;
    // âncora na mesma página: deixa o navegador rolar
    if (url.hash && normalizePath(url.pathname) === normalizePath(location.pathname) && url.search === location.search) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  };

  const onRetry = (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-router-retry]') : null;
    if (!btn) return;
    e.preventDefault();
    refresh();
  };

  const onPopState = () => {
    dispatch(location.pathname, location.search, { replaceOnRedirect: true });
  };

  function start() {
    if (started) return api;
    started = true;
    document.addEventListener('click', onClick);
    document.addEventListener('click', onRetry);
    window.addEventListener('popstate', onPopState);
    removeListeners = [
      () => document.removeEventListener('click', onClick),
      () => document.removeEventListener('click', onRetry),
      () => window.removeEventListener('popstate', onPopState),
    ];
    dispatch(location.pathname, location.search);
    return api;
  }

  function stop() {
    removeListeners.forEach((fn) => fn());
    removeListeners = [];
    started = false;
  }

  const api = {
    start,
    stop,
    navigate,
    refresh,
    match: (path) => match(path),
    owns,
    routes: table,
    base: basePath,
    get current() {
      return current;
    },
    get mount() {
      return getMount();
    },
    setTitle,
  };
  return api;
}

export default createRouter;

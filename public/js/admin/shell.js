// =====================================================================
// Foco Elite — shell do painel administrativo (ARCHITECTURE §6.1 / §6.5)
// Carrega a sessão (GET /api/admin/auth/me), monta sidebar + topbar + <main id="page">
// e inicia o roteador com o manifesto de ./routes.js.
// Sem sessão de administrador → /admin/login.
// =====================================================================
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { createRouter } from '../core/router.js';
import { html, render, qs, qsa, dropdown, emptyState, alertBox, setDocumentTitle } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { initials } from '../core/format.js';
import { routes } from './routes.js';

const DEFAULT_BRAND = 'Foco de Elite';
const COLLAPSE_KEY = 'fe.admin.sidebar.collapsed';

const NAV_ITEMS = [
  { section: 'Visão geral' },
  { href: '/admin', label: 'Visão geral', icon: 'layout-dashboard', exact: true },
  { section: 'Pessoas' },
  { href: '/admin/alunos', label: 'Alunos', icon: 'users' },
  { href: '/admin/professores', label: 'Professores', icon: 'briefcase' },
  { href: '/admin/agendamentos', label: 'Agendamentos', icon: 'calendar-check' },
  { section: 'Conteúdo' },
  { href: '/admin/conteudo', label: 'Conteúdo', icon: 'list-tree' },
  { href: '/admin/aulas', label: 'Aulas', icon: 'play' },
  { href: '/admin/questoes', label: 'Questões', icon: 'file-text' },
  { href: '/admin/editais', label: 'Editais', icon: 'scroll-text' },
  { href: '/admin/provas-anteriores', label: 'Provas anteriores', icon: 'file' },
  { href: '/admin/vestibulares', label: 'Vestibulares', icon: 'graduation-cap' },
  { href: '/admin/simulados', label: 'Simulados', icon: 'target' },
  { href: '/admin/redacao', label: 'Redação', icon: 'pen-line' },
  { section: 'Operação' },
  { href: '/admin/planos', label: 'Planos', icon: 'credit-card' },
  { href: '/admin/pagina-inicial', label: 'Página inicial', icon: 'globe' },
  { href: '/admin/configuracoes', label: 'Configurações', icon: 'settings' },
  { href: '/admin/plataforma', label: 'Plataforma', icon: 'activity' },
];

const root = document.getElementById('app');
let router = null;
let shellEl = null;
let sidebarEl = null;
let backdropEl = null;
let userMenu = null;

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
const brandName = () => (store.settings && store.settings.brand_name) || DEFAULT_BRAND;

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value) {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    /* armazenamento indisponível */
  }
}

function isActive(item, path) {
  if (item.exact) return path === item.href;
  return path === item.href || path.startsWith(`${item.href}/`);
}

// ---------------------------------------------------------------------
// Inicialização e sessão
// ---------------------------------------------------------------------
function renderBoot() {
  render(
    root,
    html`
      <div class="shell-boot" role="status" aria-live="polite">
        <img src="/assets/logo-mark.svg" alt="" width="56" height="56">
        <span>Carregando o painel…</span>
      </div>`
  );
}

function renderBootError(err) {
  render(
    root,
    html`
      <div class="shell-boot">
        <img src="/assets/logo-mark.svg" alt="" width="56" height="56">
        <div class="card shell-boot-card">
          <div class="card-body">
            ${alertBox({
              type: 'danger',
              title: 'Não foi possível carregar o painel',
              text: (err && err.message) || 'Verifique sua conexão e tente novamente.',
            })}
            <div class="flex gap-2 justify-center mt-4">
              <button type="button" class="btn btn-primary" data-action="retry">${icon('refresh-cw')}<span>Tentar novamente</span></button>
              <a class="btn btn-ghost" href="/admin/login">Entrar novamente</a>
            </div>
          </div>
        </div>
      </div>`
  );
  const btn = qs('[data-action="retry"]', root);
  if (btn) btn.addEventListener('click', () => boot());
}

async function loadSession() {
  const me = await api.get('/api/admin/auth/me', { noRedirect: true });
  const admin = me && me.user ? me.user : null;
  store.admin = admin;
  store.user = admin;
  if (me && me.settings) store.settings = me.settings;
  store.emit('user:updated', { user: admin });
  return admin;
}

function redirectToLogin() {
  location.replace('/admin/login');
}

async function logout() {
  try {
    await api.post('/api/admin/auth/logout', {}, { noRedirect: true });
  } catch {
    /* mesmo com falha, encerra a sessão local */
  }
  store.clear();
  redirectToLogin();
}

// ---------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------
function navItemHtml(item) {
  if (item.section) return html`<span class="nav-section">${item.section}</span>`;
  return html`
    <a class="nav-item" href="${item.href}" data-nav="${item.href}" title="${item.label}">
      ${icon(item.icon)}
      <span class="nav-label">${item.label}</span>
    </a>`;
}

function renderShell() {
  const admin = store.admin || {};
  const collapsed = readCollapsed();
  render(
    root,
    html`
      <a class="skip-link" href="#page">Pular para o conteúdo</a>
      <div class="app-shell admin-shell ${collapsed ? 'sidebar-collapsed' : ''}" id="shell">
        <aside class="sidebar" id="sidebar" aria-label="Menu do painel">
          <div class="sidebar-brand">
            <a href="/admin" aria-label="${brandName()} — Visão geral">
              <img class="brand-full" src="/assets/logo.svg" alt="${brandName()}" width="220" height="48">
              <img class="brand-mark" src="/assets/logo-mark.svg" alt="${brandName()}" width="36" height="36">
            </a>
            <span class="badge badge-blue" title="Painel administrativo">Administrador</span>
            <button type="button" class="btn btn-icon btn-ghost sidebar-close" data-action="close-drawer" aria-label="Fechar menu">${icon('x')}</button>
          </div>
          <nav class="sidebar-scroll" aria-label="Seções do painel">
            <div class="sidebar-nav" id="sidebar-nav">${NAV_ITEMS.map(navItemHtml)}</div>
          </nav>
          <div class="sidebar-footer">
            <div class="sidebar-user" title="${admin.email || ''}">
              <span class="avatar avatar-sm" data-user-avatar>${initials(admin.name)}</span>
              <span class="sidebar-user-main">
                <span class="sidebar-user-name" data-user-name>${admin.name || ''}</span>
                <span class="sidebar-user-sub">Administrador</span>
              </span>
            </div>
            <a class="nav-item" href="/app" target="_blank" rel="noopener" title="Ver como aluno (abre em nova aba)">
              ${icon('external-link')}
              <span class="nav-label">Ver como aluno</span>
            </a>
            <button type="button" class="nav-item sidebar-collapse" data-action="toggle-collapse" aria-pressed="${collapsed ? 'true' : 'false'}" title="${collapsed ? 'Expandir menu' : 'Recolher menu'}">
              ${icon(collapsed ? 'chevrons-right' : 'chevrons-left')}
              <span class="nav-label">${collapsed ? 'Expandir menu' : 'Recolher menu'}</span>
            </button>
            <button type="button" class="nav-item" data-action="logout" title="Sair">
              ${icon('log-out')}
              <span class="nav-label">Sair</span>
            </button>
          </div>
        </aside>

        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="btn btn-icon btn-ghost topbar-menu" data-action="open-drawer" aria-label="Abrir menu" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
            <span class="topbar-title" data-topbar-title>Visão geral</span>
          </div>
          <div class="topbar-right">
            <span class="badge badge-blue hidden-mobile" title="Sessão de administrador">${icon('shield-check')}<span>Administrador</span></span>
            <a class="btn btn-secondary btn-sm hidden-mobile" href="/app" target="_blank" rel="noopener">${icon('external-link')}<span>Ver como aluno</span></a>
            <button type="button" class="avatar" id="user-menu" aria-label="Menu da conta" data-user-avatar>${initials(admin.name)}</button>
          </div>
        </header>

        <div class="app-main">
          <main id="page" class="page page-wide" tabindex="-1"></main>
        </div>
      </div>`
  );

  shellEl = qs('#shell', root);
  sidebarEl = qs('#sidebar', root);
  bindShellEvents();
}

function bindShellEvents() {
  shellEl.addEventListener('click', (e) => {
    const trigger = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!trigger) return;
    const action = trigger.dataset.action;
    if (action === 'open-drawer') openDrawer();
    else if (action === 'close-drawer') closeDrawer();
    else if (action === 'toggle-collapse') toggleCollapse();
    else if (action === 'logout') logout();
  });
  sidebarEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a[href]')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  userMenu = dropdown(qs('#user-menu', shellEl), buildUserMenu(), { align: 'right', header: userMenuHeader() });

  store.on('user:updated', () => {
    if (!store.admin) return;
    qsa('[data-user-avatar]', shellEl).forEach((el) => {
      el.textContent = initials(store.admin.name);
    });
    const name = qs('[data-user-name]', shellEl);
    if (name) name.textContent = store.admin.name || '';
    if (userMenu) userMenu.destroy();
    userMenu = dropdown(qs('#user-menu', shellEl), buildUserMenu(), { align: 'right', header: userMenuHeader() });
  });
}

function userMenuHeader() {
  const admin = store.admin || {};
  return html`<span class="name">${admin.name || ''}</span><span class="email">${admin.email || ''}</span>`;
}

function buildUserMenu() {
  return [
    { label: 'Ver como aluno', icon: 'external-link', href: '/app', target: '_blank' },
    { label: 'Configurações', icon: 'settings', href: '/admin/configuracoes' },
    { divider: true },
    { label: 'Sair', icon: 'log-out', danger: true, onClick: () => logout() },
  ];
}

function updateActiveNav(path) {
  qsa('[data-nav]', shellEl).forEach((a) => {
    const item = NAV_ITEMS.find((n) => n.href === a.dataset.nav);
    const active = item ? isActive(item, path) : false;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function setTopbarTitle(title) {
  const el = qs('[data-topbar-title]', shellEl);
  if (el) el.textContent = title || brandName();
}

// ---------------------------------------------------------------------
// Sidebar: gaveta (mobile) e recolhimento (desktop)
// ---------------------------------------------------------------------
function openDrawer() {
  if (!sidebarEl || sidebarEl.classList.contains('open')) return;
  sidebarEl.classList.add('open');
  const btn = qs('[data-action="open-drawer"]', shellEl);
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (!backdropEl) {
    backdropEl = document.createElement('div');
    backdropEl.className = 'sidebar-backdrop';
    backdropEl.addEventListener('click', closeDrawer);
  }
  shellEl.appendChild(backdropEl);
  const first = qs('.nav-item', sidebarEl);
  if (first) first.focus();
}

function closeDrawer() {
  if (!sidebarEl || !sidebarEl.classList.contains('open')) return;
  sidebarEl.classList.remove('open');
  const btn = qs('[data-action="open-drawer"]', shellEl);
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (backdropEl && backdropEl.isConnected) backdropEl.remove();
}

function toggleCollapse() {
  const collapsed = !shellEl.classList.contains('sidebar-collapsed');
  shellEl.classList.toggle('sidebar-collapsed', collapsed);
  writeCollapsed(collapsed);
  const btn = qs('[data-action="toggle-collapse"]', shellEl);
  if (btn) {
    btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    btn.title = collapsed ? 'Expandir menu' : 'Recolher menu';
    btn.innerHTML = String(html`${icon(collapsed ? 'chevrons-right' : 'chevrons-left')}<span class="nav-label">${collapsed ? 'Expandir menu' : 'Recolher menu'}</span>`);
  }
}

// ---------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------
function guard() {
  if (!store.admin) {
    redirectToLogin();
    return false;
  }
  return undefined;
}

function afterRoute(route, ctx) {
  shellEl.classList.toggle('bare', !!(route && route.bare));
  const routeKey = ctx.path.replace(/^\/admin\/?/, '').split('/')[0] || 'overview';
  shellEl.dataset.route = routeKey;
  document.body.dataset.route = routeKey;
  updateActiveNav(ctx.path);
  closeDrawer();
}

function renderNotFound(ctx) {
  ctx.setTitle('Página não encontrada');
  return emptyState({
    icon: 'compass',
    title: 'Página não encontrada',
    text: 'O endereço que você acessou não existe no painel.',
    action: html`<a class="btn btn-primary" href="/admin">${icon('arrow-left')}<span>Voltar à visão geral</span></a>`,
  });
}

function startRouter() {
  router = createRouter({
    routes,
    mount: qs('#page', root),
    base: '/admin',
    homePath: '/admin',
    brand: `${brandName()} · Admin`,
    context: () => ({ user: store.admin, admin: store.admin, profile: null, exam: null }),
    onBeforeRoute: guard,
    onAfterRoute: afterRoute,
    onTitle: (title) => setTopbarTitle(title),
    notFound: renderNotFound,
  });
  router.start();
}

async function boot() {
  setDocumentTitle('Painel administrativo', DEFAULT_BRAND);
  renderBoot();
  let admin;
  try {
    admin = await loadSession();
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      redirectToLogin();
      return;
    }
    console.error('[admin] falha ao carregar a sessão', err);
    renderBootError(err);
    return;
  }
  if (!admin) {
    redirectToLogin();
    return;
  }
  renderShell();
  startRouter();
}

boot();

export { router, boot, logout };

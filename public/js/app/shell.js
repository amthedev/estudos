// =====================================================================
// Foco Elite — shell do aluno (ARCHITECTURE §6.1)
// Carrega a sessão (GET /api/auth/me), monta sidebar, topbar, menu inferior e
// <main id="page">, e inicia o roteador com o manifesto de ./routes.js.
//
// Regras de acesso:
//   sem sessão                 → /login?next=<rota atual>
//   onboarding_completed=false → /app/onboarding (exceto se já está nela)
//   access.allowed=false       → /app/assinatura (liberadas: /app/assinatura, /app/perfil)
// Rotas com bare:true renderizam sem sidebar/topbar/menu inferior.
// =====================================================================
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { createRouter } from '../core/router.js';
import { html, render, qs, qsa, dropdown, emptyState, alertBox, setDocumentTitle, toast } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { initials, daysUntil } from '../core/format.js';
import { routes } from './routes.js';

const DEFAULT_BRAND = 'Foco de Elite';
const COLLAPSE_KEY = 'fe.sidebar.collapsed';
const ALLOWED_WITHOUT_ACCESS = new Set(['/app/assinatura', '/app/perfil']);

/** Itens do menu lateral, na ordem do §6.4. */
const NAV_ITEMS = [
  { section: 'Hoje' },
  { href: '/app', label: 'Início', icon: 'house', exact: true },
  { href: '/app/cronograma', label: 'Meu Cronograma', icon: 'calendar-days' },
  { section: 'Estudar' },
  { href: '/app/materias', label: 'Matérias', icon: 'library' },
  { href: '/app/aulas', label: 'Aulas', icon: 'play' },
  { href: '/app/questoes', label: 'Questões', icon: 'file-text' },
  { href: '/app/simulados', label: 'Simulados', icon: 'target' },
  { href: '/app/redacao', label: 'Redação IA', icon: 'pen-line' },
  { href: '/app/tutor', label: 'Tutor IA', icon: 'bot' },
  { section: 'Acompanhar' },
  { href: '/app/provas-anteriores', label: 'Provas Anteriores', icon: 'file' },
  { href: '/app/revisoes', label: 'Revisões', icon: 'refresh-cw' },
  { href: '/app/caderno-de-erros', label: 'Caderno de Erros', icon: 'circle-x' },
  { href: '/app/desempenho', label: 'Meu Desempenho', icon: 'chart-column' },
  { href: '/app/resumos', label: 'Meus Resumos', icon: 'notebook-pen' },
  { href: '/app/favoritos', label: 'Favoritos', icon: 'star' },
  { section: 'Conta e suporte' },
  { href: '/app/aulas-particulares', label: 'Aulas Particulares', icon: 'users', setting: 'private_lessons_enabled' },
  { href: '/app/perfil', label: 'Perfil', icon: 'user' },
];

/** Menu inferior (mobile). `match` lista os prefixos que mantêm o item ativo. */
const BOTTOM_ITEMS = [
  { href: '/app', label: 'Início', icon: 'house', exact: true },
  { href: '/app/cronograma', label: 'Cronograma', icon: 'calendar-days' },
  { href: '/app/materias', label: 'Estudar', icon: 'library', match: ['/app/materias', '/app/aulas', '/app/questoes'] },
  { href: '/app/tutor', label: 'Tutor IA', icon: 'bot' },
  { href: '/app/perfil', label: 'Perfil', icon: 'user' },
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

/** Verifica se um item de menu está ativo para o caminho atual. */
function isActive(item, path) {
  if (item.exact) return path === item.href;
  const prefixes = item.match || [item.href];
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

function examDateLabel() {
  const date = (store.profile && store.profile.exam_date) || (store.exam && store.exam.exam_date) || null;
  if (!date) return '';
  const days = daysUntil(date);
  if (days === null || days < 0) return '';
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  return `${days} dias`;
}

function streakValue() {
  const s = store.stats || {};
  const value = s.streak_days ?? s.streak ?? null;
  return value === null || value === undefined ? null : Number(value) || 0;
}

// ---------------------------------------------------------------------
// Telas de inicialização
// ---------------------------------------------------------------------
function renderBoot(message = 'Carregando seus estudos…') {
  render(
    root,
    html`
      <div class="shell-boot" role="status" aria-live="polite">
        <img src="/assets/brand/foco-elite-mark.png" alt="" width="1254" height="1254">
        <span>${message}</span>
      </div>`
  );
}

function renderBootError(err) {
  render(
    root,
    html`
      <div class="shell-boot">
        <img src="/assets/brand/foco-elite-mark.png" alt="" width="1254" height="1254">
        <div class="card shell-boot-card">
          <div class="card-body">
            ${alertBox({
              type: 'danger',
              title: 'Não foi possível carregar sua conta',
              text: (err && err.message) || 'Verifique sua conexão e tente novamente.',
            })}
            <div class="flex gap-2 justify-center mt-4">
              <button type="button" class="btn btn-primary" data-action="retry">${icon('refresh-cw')}<span>Tentar novamente</span></button>
              <a class="btn btn-ghost" href="/login">Entrar novamente</a>
            </div>
          </div>
        </div>
      </div>`
  );
  const btn = qs('[data-action="retry"]', root);
  if (btn) btn.addEventListener('click', () => boot());
}

// ---------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------
async function loadSession() {
  const me = await api.get('/api/auth/me', { noRedirect: true });
  store.setSession(me || {});
  return me;
}

function redirectToLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?next=${next}`);
}

async function logout() {
  try {
    await api.post('/api/auth/logout', {}, { noRedirect: true });
  } catch {
    /* mesmo com falha, encerra a sessão local */
  }
  store.clear();
  location.replace('/login');
}

// ---------------------------------------------------------------------
// Renderização do shell
// ---------------------------------------------------------------------
function navItemHtml(item) {
  if (item.section) return html`<span class="nav-section">${item.section}</span>`;
  return html`
    <a class="nav-item" href="${item.href}" data-nav="${item.href}" title="${item.label}" ${item.hidden ? 'hidden' : ''}>
      ${icon(item.icon)}
      <span class="nav-label">${item.label}</span>
    </a>`;
}

function visibleNavItems() {
  const settings = store.settings || {};
  return NAV_ITEMS.map((item) => ({
    ...item,
    hidden: item.setting ? settings[item.setting] === false : false,
  }));
}

function renderShell() {
  const user = store.user || {};
  const collapsed = readCollapsed();
  render(
    root,
    html`
      <a class="skip-link" href="#page">Pular para o conteúdo</a>
      <div class="app-shell ${collapsed ? 'sidebar-collapsed' : ''}" id="shell">
        <aside class="sidebar" id="sidebar" aria-label="Menu principal">
          <div class="sidebar-brand">
            <a href="/app" aria-label="${brandName()} — Início">
              <img class="brand-full" src="/assets/brand/foco-elite-logo.png" alt="${brandName()}" width="1983" height="793">
              <img class="brand-mark" src="/assets/brand/foco-elite-mark.png" alt="${brandName()}" width="1254" height="1254">
            </a>
            <button type="button" class="btn btn-icon btn-ghost sidebar-close" data-action="close-drawer" aria-label="Fechar menu">${icon('x')}</button>
          </div>
          <nav class="sidebar-scroll" aria-label="Seções">
            <div class="sidebar-nav" id="sidebar-nav">${visibleNavItems().map(navItemHtml)}</div>
          </nav>
          <div class="sidebar-footer">
            <a class="sidebar-user" href="/app/perfil" title="Meu perfil">
              <span class="avatar avatar-sm" data-user-avatar>${initials(user.name)}</span>
              <span class="sidebar-user-main">
                <span class="sidebar-user-name" data-user-name>${user.name || ''}</span>
                <span class="sidebar-user-sub" data-user-sub>${(store.exam && store.exam.short_name) || 'Prova não definida'}</span>
              </span>
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
            <form class="search-box topbar-search" role="search" id="global-search" autocomplete="off">
              ${icon('search')}
              <input type="search" name="q" class="input" placeholder="Buscar aulas, questões, assuntos…" aria-label="Busca global" enterkeyhint="search">
              <span class="kbd" aria-hidden="true">/</span>
            </form>
          </div>
          <div class="topbar-right">
            <a class="chip chip-exam" href="/app/perfil" data-exam-chip hidden title="Sua prova">
              ${icon('graduation-cap')}
              <span data-exam-name></span>
              <span class="chip-label" data-exam-days></span>
            </a>
            <span class="chip chip-streak" data-streak-chip hidden title="Dias seguidos de estudo">
              ${icon('flame')}
              <span data-streak-value></span>
            </span>
            <button type="button" class="avatar" id="user-menu" aria-label="Menu da conta" data-user-avatar>${initials(user.name)}</button>
          </div>
        </header>

        <div class="app-main">
          <main id="page" class="page" tabindex="-1"></main>
        </div>

        <nav class="bottom-nav" aria-label="Navegação rápida">
          ${BOTTOM_ITEMS.map(
            (item) => html`
              <a href="${item.href}" data-bottom="${item.href}" aria-label="${item.label}">
                ${icon(item.icon)}
                <span>${item.label}</span>
              </a>`
          )}
        </nav>
      </div>`
  );

  shellEl = qs('#shell', root);
  sidebarEl = qs('#sidebar', root);
  bindShellEvents();
  updateUserBits();
  updateExamChip();
  updateStreakChip();
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

  // clique em item da sidebar fecha a gaveta no mobile
  sidebarEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a[href]')) closeDrawer();
  });

  const form = qs('#global-search', shellEl);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = form.elements.q.value.trim();
    if (!q) return;
    router.navigate(`/app/busca?q=${encodeURIComponent(q)}`);
    form.elements.q.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      return;
    }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
    if (typing) return;
    const input = form.elements.q;
    if (input && input.offsetParent !== null) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  userMenu = dropdown(qs('#user-menu', shellEl), buildUserMenu(), { align: 'right', header: userMenuHeader() });

  store.on('user:updated', () => {
    if (!store.user) return; // logout em andamento
    updateUserBits();
    updateExamChip();
    // recria o menu para atualizar o cabeçalho (nome/e-mail)
    if (userMenu) userMenu.destroy();
    userMenu = dropdown(qs('#user-menu', shellEl), buildUserMenu(), { align: 'right', header: userMenuHeader() });
  });
  store.on('progress:updated', updateStreakChip);
  store.on('schedule:updated', updateExamChip);
}

function userMenuHeader() {
  const user = store.user || {};
  return html`<span class="name">${user.name || ''}</span><span class="email">${user.email || ''}</span>`;
}

function buildUserMenu() {
  return [
    { label: 'Meu perfil', icon: 'user', href: '/app/perfil' },
    { label: 'Assinatura', icon: 'credit-card', href: '/app/assinatura' },
    { label: 'Meu desempenho', icon: 'chart-column', href: '/app/desempenho' },
    { divider: true },
    { label: 'Sair', icon: 'log-out', danger: true, onClick: () => logout() },
  ];
}

function updateUserBits() {
  const user = store.user || {};
  qsa('[data-user-avatar]', shellEl).forEach((el) => {
    el.textContent = initials(user.name);
  });
  const name = qs('[data-user-name]', shellEl);
  if (name) name.textContent = user.name || '';
  const sub = qs('[data-user-sub]', shellEl);
  if (sub) sub.textContent = (store.exam && store.exam.short_name) || 'Prova não definida';
}

function updateExamChip() {
  const chip = qs('[data-exam-chip]', shellEl);
  if (!chip) return;
  const exam = store.exam;
  if (!exam) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  qs('[data-exam-name]', chip).textContent = exam.short_name || exam.name || '';
  const days = examDateLabel();
  const daysEl = qs('[data-exam-days]', chip);
  daysEl.textContent = days ? `· ${days}` : '';
  daysEl.hidden = !days;
  chip.title = days ? `${exam.name || exam.short_name} — faltam ${days}` : exam.name || exam.short_name || '';
}

function updateStreakChip() {
  const chip = qs('[data-streak-chip]', shellEl);
  if (!chip) return;
  const value = streakValue();
  if (value === null) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  qs('[data-streak-value]', chip).textContent = value === 1 ? '1 dia' : `${value} dias`;
}

function updateActiveNav(path) {
  qsa('[data-nav]', shellEl).forEach((a) => {
    const item = NAV_ITEMS.find((n) => n.href === a.dataset.nav);
    const active = item ? isActive(item, path) : false;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  qsa('[data-bottom]', shellEl).forEach((a) => {
    const item = BOTTOM_ITEMS.find((n) => n.href === a.dataset.bottom);
    const active = item ? isActive(item, path) : false;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
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
function guard(route, info) {
  if (!store.user) {
    redirectToLogin();
    return false;
  }
  const path = info.path;
  if (!store.hasAccess && route && !route.public && !ALLOWED_WITHOUT_ACCESS.has(route.path)) {
    return '/app/assinatura';
  }
  if (store.hasAccess && !store.onboarded && path !== '/app/onboarding') return '/app/onboarding';
  return undefined;
}

function afterRoute(route, ctx) {
  shellEl.classList.toggle('bare', !!(route && route.bare));
  const routeKey = ctx.path.replace(/^\/app\/?/, '').split('/')[0] || 'home';
  shellEl.dataset.route = routeKey;
  document.body.dataset.route = routeKey;
  updateActiveNav(ctx.path);
  closeDrawer();
  const input = qs('#global-search input', shellEl);
  if (input) {
    if (route && route.path === '/app/busca') input.value = typeof ctx.query.q === 'string' ? ctx.query.q : '';
    else if (document.activeElement !== input) input.value = '';
  }
}

function renderNotFound(ctx) {
  ctx.setTitle('Página não encontrada');
  return emptyState({
    icon: 'compass',
    title: 'Página não encontrada',
    text: 'O endereço que você acessou não existe ou foi movido.',
    action: html`<a class="btn btn-primary" href="/app">${icon('arrow-left')}<span>Voltar ao início</span></a>`,
  });
}

function startRouter() {
  router = createRouter({
    routes,
    mount: qs('#page', root),
    base: '/app',
    homePath: '/app',
    brand: brandName(),
    context: () => ({ user: store.user, profile: store.profile, exam: store.exam, access: store.access }),
    onBeforeRoute: guard,
    onAfterRoute: afterRoute,
    notFound: renderNotFound,
  });
  router.start();
}

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
async function boot() {
  setDocumentTitle('', DEFAULT_BRAND);
  renderBoot();
  let me;
  try {
    me = await loadSession();
  } catch (err) {
    if (err && err.status === 401) {
      redirectToLogin();
      return;
    }
    if (err && err.status === 403) {
      // conta bloqueada ou sessão inválida: encerra e volta ao login
      store.clear();
      location.replace('/login');
      return;
    }
    console.error('[shell] falha ao carregar a sessão', err);
    renderBootError(err);
    return;
  }
  if (!me || !me.user) {
    redirectToLogin();
    return;
  }
  renderShell();
  startRouter();

  // avisos vindos por query (ex.: retorno do checkout)
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') toast('Assinatura ativada. Bons estudos.', { type: 'success' });
}

boot();

export { router, boot, logout };

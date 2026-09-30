// =====================================================================
// Foco Elite — estado global (ARCHITECTURE §6.1)
// store.user, store.profile, store.exam, store.access, store.stats, store.coins
// store.on(event, fn) → unsubscribe; store.emit(event, data)
// Eventos: 'user:updated', 'progress:updated', 'schedule:updated', 'coins:updated'
// =====================================================================

const listeners = new Map();

export const store = {
  /** usuário autenticado (aluno ou admin) */
  user: null,
  /** perfil do aluno (student_profiles) */
  profile: null,
  /** prova/vestibular escolhido no onboarding */
  exam: null,
  /** { allowed, reason, subscription } */
  access: null,
  /** estatísticas leves para o shell (ex.: { streak }) — preenchidas pelo dashboard */
  stats: null,
  /** administrador autenticado (painel) */
  admin: null,
  /** configurações públicas expostas pela API (ex.: private_lessons_enabled) */
  settings: null,
  /**
   * carteira de moedas do dia (GET /api/coins ou a chave `coins` de /api/auth/me):
   * { unlimited, tier, tier_label, reason, daily, spent, granted, balance, day, resets_at, costs }
   */
  coins: null,

  /** Registra um ouvinte; devolve função para remover. */
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => store.off(event, fn);
  },

  /** Registra um ouvinte que dispara uma única vez. */
  once(event, fn) {
    const off = store.on(event, (data) => {
      off();
      fn(data);
    });
    return off;
  },

  off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  },

  /** Dispara um evento para todos os ouvintes (erros de um ouvinte não afetam os demais). */
  emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[store] erro em ouvinte de "${event}"`, err);
      }
    }
  },

  /**
   * Atualiza a sessão a partir de GET /api/auth/me
   * ({ user, profile, exam, access, coins, settings? }) e emite 'user:updated'
   * (e 'coins:updated', quando a carteira veio junto).
   */
  setSession(session = {}) {
    if ('user' in session) store.user = session.user || null;
    if ('profile' in session) store.profile = session.profile || null;
    if ('exam' in session) store.exam = session.exam || null;
    if ('access' in session) store.access = session.access || null;
    if ('settings' in session) store.settings = session.settings || null;
    if ('stats' in session) store.stats = session.stats || null;
    store.emit('user:updated', { user: store.user, profile: store.profile, exam: store.exam, access: store.access });
    if ('coins' in session) store.setCoins(session.coins);
  },

  /** Troca a carteira de moedas e emite 'coins:updated' (o chip do topo escuta). */
  setCoins(coins) {
    store.coins = coins && typeof coins === 'object' ? coins : null;
    store.emit('coins:updated', store.coins);
  },

  /** Atualiza estatísticas do shell (ex.: streak) e emite 'progress:updated'. */
  setStats(stats) {
    store.stats = { ...(store.stats || {}), ...(stats || {}) };
    store.emit('progress:updated', store.stats);
  },

  /** Limpa a sessão (logout). */
  clear() {
    store.user = null;
    store.profile = null;
    store.exam = null;
    store.access = null;
    store.stats = null;
    store.admin = null;
    store.settings = null;
    store.coins = null;
    store.emit('user:updated', null);
  },

  /** Verdadeiro quando o aluno concluiu o onboarding. */
  get onboarded() {
    return !!(store.profile && store.profile.onboarding_completed);
  },

  /** Verdadeiro quando o acesso ao conteúdo está liberado. */
  get hasAccess() {
    return !store.access || store.access.allowed !== false;
  },
};

export default store;

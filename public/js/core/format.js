// =====================================================================
// Foco Elite — formatação (ARCHITECTURE §6.2)
// fmtDate · fmtDateLong · fmtRelative · fmtMinutes · fmtPct · fmtNumber ·
// fmtMoney · weekdayName · difficultyLabel — e utilitários de data (local).
// Datas sem hora ("YYYY-MM-DD") são interpretadas no fuso local, nunca em UTC.
// =====================================================================

const LOCALE = 'pt-BR';

export const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const WEEKDAYS_MIN = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Converte string/Date/número em Date (local). "YYYY-MM-DD" vira meia-noite local. Inválido → null. */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  const str = String(value).trim();
  const m = DATE_ONLY.exec(str);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

/** Data local no formato YYYY-MM-DD. */
export function toISODate(value = new Date()) {
  const d = parseDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO() {
  return toISODate(new Date());
}

export function addDays(value, days) {
  const d = parseDate(value);
  if (!d) return null;
  const r = new Date(d);
  r.setDate(r.getDate() + Number(days || 0));
  return r;
}

export function startOfDay(value) {
  const d = parseDate(value);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Início da semana (domingo por padrão; `startOn` = 1 para segunda). */
export function startOfWeek(value, startOn = 0) {
  const d = startOfDay(value);
  if (!d) return null;
  const diff = (d.getDay() - startOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

export function startOfMonth(value) {
  const d = parseDate(value);
  return d ? new Date(d.getFullYear(), d.getMonth(), 1) : null;
}

export function endOfMonth(value) {
  const d = parseDate(value);
  return d ? new Date(d.getFullYear(), d.getMonth() + 1, 0) : null;
}

export function isSameDay(a, b) {
  const x = parseDate(a);
  const y = parseDate(b);
  return !!(x && y) && x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function isToday(value) {
  return isSameDay(value, new Date());
}

/** Diferença em dias inteiros (b - a), ignorando horas. */
export function diffDays(a, b = new Date()) {
  const x = startOfDay(a);
  const y = startOfDay(b);
  if (!x || !y) return null;
  return Math.round((y - x) / 86400000);
}

/** 09/09/2026 */
export function fmtDate(value, { fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** 09/09 (sem ano) */
export function fmtDateShort(value, { fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** 9 de setembro de 2026 · com weekday: quarta-feira, 9 de setembro de 2026 */
export function fmtDateLong(value, { weekday = false, year = true, fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  const base = `${d.getDate()} de ${MONTHS[d.getMonth()]}${year ? ` de ${d.getFullYear()}` : ''}`;
  return weekday ? `${WEEKDAYS[d.getDay()]}, ${base}` : base;
}

/** 9 set · 9 set 2026 */
export function fmtDateCompact(value, { year = false, fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ''}`;
}

/** 14:05 — aceita Date, ISO ou "HH:MM[:SS]" */
export function fmtTime(value, { fallback = '—' } = {}) {
  if (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value)) {
    const [h, m] = value.split(':');
    return `${pad(Number(h))}:${m.slice(0, 2)}`;
  }
  const d = parseDate(value);
  if (!d) return fallback;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 09/09/2026 às 14:05 */
export function fmtDateTime(value, { fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  return `${fmtDate(d)} às ${fmtTime(d)}`;
}

/** Mês por extenso: setembro de 2026 */
export function fmtMonthYear(value) {
  const d = parseDate(value);
  if (!d) return '';
  return `${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
}

/**
 * Relativo em português: "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias",
 * "em 4 dias", "amanhã", "hoje"; além de 30 dias → data curta.
 */
export function fmtRelative(value, { now = new Date(), fallback = '—' } = {}) {
  const d = parseDate(value);
  if (!d) return fallback;
  const isDateOnly = typeof value === 'string' && DATE_ONLY.test(value.trim());
  if (isDateOnly) {
    const days = diffDays(now, d);
    if (days === 0) return 'hoje';
    if (days === 1) return 'amanhã';
    if (days === -1) return 'ontem';
    if (days > 1 && days <= 30) return `em ${days} dias`;
    if (days < -1 && days >= -30) return `há ${-days} dias`;
    return fmtDate(d);
  }
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec > 0;
  const wrap = (s) => (future ? `em ${s}` : `há ${s}`);
  if (abs < 45) return 'agora';
  if (abs < 3600) return wrap(`${Math.round(abs / 60)} min`);
  if (abs < 86400) {
    const h = Math.round(abs / 3600);
    return wrap(`${h} h`);
  }
  const days = Math.abs(diffDays(now, d));
  if (days === 1) return future ? 'amanhã' : 'ontem';
  if (days <= 30) return wrap(`${days} dias`);
  return fmtDate(d);
}

/** fmtMinutes(125) → "2h 05min"; 45 → "45min"; 120 → "2h"; 0 → "0min" */
export function fmtMinutes(minutes, { long = false } = {}) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (long) {
    if (h && m) return `${h} ${h === 1 ? 'hora' : 'horas'} e ${m} min`;
    if (h) return `${h} ${h === 1 ? 'hora' : 'horas'}`;
    return `${m} min`;
  }
  if (h && m) return `${h}h ${pad(m)}min`;
  if (h) return `${h}h`;
  return `${m}min`;
}

/** Tamanho de arquivo legível: 2048 → "2 KB". */
export function fmtBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Horas decimais → "2h 30min" (ex.: hours_per_day = 2.5). */
export function fmtHours(hours) {
  return fmtMinutes(Math.round((Number(hours) || 0) * 60));
}

/** Segundos → "mm:ss" ou "h:mm:ss" (cronômetros). */
export function fmtDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** fmtPct(72.456) → "72%"; fmtPct(0.72, { fraction: true }) → "72%"; null → "—" */
export function fmtPct(value, { digits = 0, fraction = false, fallback = '—' } = {}) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return fallback;
  const n = Number(value) * (fraction ? 100 : 1);
  return `${n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** fmtNumber(1234.5) → "1.234,5" */
export function fmtNumber(value, { digits, fallback = '—' } = {}) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return fallback;
  const opts = digits === undefined ? { maximumFractionDigits: 1 } : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return Number(value).toLocaleString(LOCALE, opts);
}

/** Números compactos: 1.2 mil, 3.4 mi */
export function fmtCompact(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} mi`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} mil`;
  return n.toLocaleString(LOCALE);
}

/** fmtMoney(4990) → "R$ 49,90" (valores em centavos) */
export function fmtMoney(cents, { currency = 'BRL', fallback = '—' } = {}) {
  if (cents === null || cents === undefined || cents === '' || Number.isNaN(Number(cents))) return fallback;
  return (Number(cents) / 100).toLocaleString(LOCALE, { style: 'currency', currency: String(currency || 'BRL').toUpperCase() });
}

/** Nota numérica (redação, simulado): fmtScore(812.5) → "812,5"; inteiros sem casas. */
export function fmtScore(value, { fallback = '—' } = {}) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n.toLocaleString(LOCALE) : n.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** weekdayName(1) → "segunda-feira"; { short: true } → "seg"; { min: true } → "S" */
export function weekdayName(index, { short = false, min = false, capitalize = false } = {}) {
  let i = Number(index);
  if (index instanceof Date) i = index.getDay();
  if (Number.isNaN(i)) return '';
  i = ((i % 7) + 7) % 7;
  const name = min ? WEEKDAYS_MIN[i] : short ? WEEKDAYS_SHORT[i] : WEEKDAYS[i];
  return capitalize ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** Lista de dias [1,3,5] → "seg, qua e sex" */
export function fmtStudyDays(days = [], { short = true } = {}) {
  const list = Array.from(new Set((days || []).map(Number).filter((n) => n >= 0 && n <= 6))).sort();
  if (!list.length) return '—';
  if (list.length === 7) return 'todos os dias';
  const names = list.map((d) => weekdayName(d, { short }));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

export function monthName(index, { short = false } = {}) {
  const i = ((Number(index) % 12) + 12) % 12;
  return short ? MONTHS_SHORT[i] : MONTHS[i];
}

/** difficultyLabel(1) → "Básico", 2 → "Intermediário", 3 → "Avançado" */
export function difficultyLabel(level) {
  const map = { 1: 'Básico', 2: 'Intermediário', 3: 'Avançado', easy: 'Básico', medium: 'Intermediário', hard: 'Avançado', iniciante: 'Iniciante', intermediario: 'Intermediário', avancado: 'Avançado' };
  return map[level] || '—';
}

/** Tom de badge para dificuldade (usa as classes do design system). */
export function difficultyTone(level) {
  return { 1: 'green', 2: 'orange', 3: 'red' }[level] || 'gray';
}

/** Rótulos de status genéricos usados em várias telas. */
export function statusLabel(status) {
  const map = {
    pending: 'Pendente', done: 'Concluída', skipped: 'Pulada', missed: 'Não realizada',
    in_progress: 'Em andamento', completed: 'Concluída', finished: 'Finalizado', abandoned: 'Abandonado',
    draft: 'Rascunho', submitted: 'Enviada', corrected: 'Corrigida', failed: 'Falhou',
    active: 'Ativa', trialing: 'Em teste', past_due: 'Pagamento pendente', canceled: 'Cancelada',
    incomplete: 'Incompleta', incomplete_expired: 'Expirada', unpaid: 'Não paga', paused: 'Pausada',
    confirmed: 'Confirmada', cancelled: 'Cancelada', blocked: 'Bloqueado',
  };
  return map[status] || status || '—';
}

/** Tipos de item do cronograma / atividades. */
export function activityLabel(type) {
  const map = {
    lesson: 'Aula', topic: 'Estudo', questions: 'Questões', review: 'Revisão', essay: 'Redação',
    simulado: 'Simulado', custom: 'Personalizado', practice: 'Prática', tutor: 'Tutor', manual: 'Manual', schedule: 'Cronograma',
    summary: 'Resumo', past_exam: 'Prova anterior', training: 'Treino físico', rest: 'Descanso',
  };
  return map[type] || type || '—';
}

/** Iniciais para avatar: "Ana Maria Souza" → "AS" */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Primeiro nome: "Ana Maria Souza" → "Ana" */
export function firstName(name = '') {
  return String(name).trim().split(/\s+/)[0] || '';
}

/** pluralize(3, 'aula', 'aulas') → "3 aulas" */
export function pluralize(n, singular, plural = `${singular}s`, { withNumber = true } = {}) {
  const count = Number(n) || 0;
  const word = count === 1 ? singular : plural;
  return withNumber ? `${fmtNumber(count, { digits: 0 })} ${word}` : word;
}

/** Trunca texto com reticências. */
export function truncate(text, max = 80) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Saudação conforme a hora: "Bom dia" / "Boa tarde" / "Boa noite" */
export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** Dias até uma data (ex.: prova): positivo = futuro. */
export function daysUntil(value) {
  return diffDays(new Date(), value);
}

/** Intervalo de plano: "mês" / "ano" */
export function intervalLabel(interval, count = 1) {
  if (interval === 'year') return count > 1 ? `${count} anos` : 'ano';
  if (interval === 'month') return count > 1 ? `${count} meses` : 'mês';
  return interval || '';
}

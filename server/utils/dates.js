'use strict';

/**
 * Helpers de data. Datas "sem hora" circulam como strings 'YYYY-MM-DD' (mesmo formato do banco).
 * O "hoje" é calculado no fuso America/Sao_Paulo, independentemente do fuso do servidor.
 */
const TIMEZONE = 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Partes da data/hora de um Date no fuso de São Paulo. */
function partsInTimezone(date = new Date()) {
  const parts = {};
  for (const { type, value } of dateFormatter.formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (n) => String(n).padStart(2, '0');

function isISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Converte Date (ou string) para 'YYYY-MM-DD'. Date é interpretado no fuso de São Paulo.
 * Strings 'YYYY-MM-DD' passam direto; outras strings são parseadas como Date. Inválido → null.
 */
function toISODate(input = new Date()) {
  if (typeof input === 'string') {
    if (ISO_DATE_RE.test(input)) return input;
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) return null;
    input = parsed;
  }
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) return null;
  const { year, month, day } = partsInTimezone(input);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Hoje em São Paulo, 'YYYY-MM-DD'. */
function todayISO() {
  return toISODate(new Date());
}

/** Date (UTC ao meio-dia) a partir de 'YYYY-MM-DD' — seguro para aritmética de dias. */
function parseISODate(iso) {
  const value = toISODate(iso);
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Soma dias a uma data → 'YYYY-MM-DD'. */
function addDays(date, days) {
  const base = parseISODate(date);
  if (!base) return null;
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo … 6 = sábado). */
function weekday(date) {
  const parsed = parseISODate(date);
  return parsed ? parsed.getUTCDay() : null;
}

/** Diferença em dias inteiros: to - from. */
function diffDays(from, to) {
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Primeiro dia da semana que contém a data (weekStartsOn: 0 = domingo, 1 = segunda). */
function startOfWeek(date, weekStartsOn = 0) {
  const iso = toISODate(date);
  if (!iso) return null;
  const offset = (weekday(iso) - weekStartsOn + 7) % 7;
  return addDays(iso, -offset);
}

function endOfWeek(date, weekStartsOn = 0) {
  const start = startOfWeek(date, weekStartsOn);
  return start ? addDays(start, 6) : null;
}

function startOfMonth(date) {
  const iso = toISODate(date);
  return iso ? `${iso.slice(0, 8)}01` : null;
}

function endOfMonth(date) {
  const iso = toISODate(date);
  if (!iso) return null;
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 8)}${pad(last)}`;
}

/** Lista de dias 'YYYY-MM-DD' de from a to (inclusive). */
function eachDay(from, to) {
  const start = toISODate(from);
  const end = toISODate(to);
  if (!start || !end) return [];
  const total = diffDays(start, end);
  if (total < 0) return [];
  const days = [];
  for (let i = 0; i <= total; i += 1) days.push(addDays(start, i));
  return days;
}

/** 'DD/MM/AAAA' */
function formatBR(date) {
  const iso = toISODate(date);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** 'terça-feira, 9 de setembro de 2026' */
function formatLongBR(date) {
  const iso = toISODate(date);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAY_NAMES[weekday(iso)]}, ${d} de ${MONTH_NAMES[m - 1]} de ${y}`;
}

function weekdayName(index, { short = false } = {}) {
  const list = short ? WEEKDAY_SHORT : WEEKDAY_NAMES;
  return list[((Number(index) % 7) + 7) % 7];
}

/** Hora atual em São Paulo: { hour, minute, second, time: 'HH:MM' }. */
function nowInSaoPaulo() {
  const parts = partsInTimezone(new Date());
  return { ...parts, date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, time: `${pad(parts.hour)}:${pad(parts.minute)}` };
}

/** Verdadeiro se a data é anterior a hoje (São Paulo). */
function isPast(date) {
  const iso = toISODate(date);
  return Boolean(iso) && iso < todayISO();
}

/** Minutos → 'HH:MM' e vice-versa (horários de cronograma). */
function minutesToTime(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

function timeToMinutes(time) {
  if (typeof time !== 'string') return null;
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

module.exports = {
  TIMEZONE,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  MONTH_NAMES,
  isISODate,
  toISODate,
  todayISO,
  parseISODate,
  addDays,
  weekday,
  weekdayName,
  diffDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDay,
  formatBR,
  formatLongBR,
  nowInSaoPaulo,
  isPast,
  minutesToTime,
  timeToMinutes,
};

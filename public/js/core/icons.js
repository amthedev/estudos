// =====================================================================
// Foco Elite — ícones (ARCHITECTURE §6.2)
// icon('calendar', { size }) → <svg class="icon"><use href="/assets/icons.svg#i-calendar"/></svg>
// Nomes = Lucide. O sprite público/assets/icons.svg é gerado por scripts/build-icons.js.
// =====================================================================
import { raw, escapeHtml } from './ui.js';

export const ICONS_URL = '/assets/icons.svg';

// nomes antigos/alternativos → id existente no sprite
const ALIASES = {
  edit: 'square-pen',
  'edit-2': 'pen',
  'check-circle': 'circle-check',
  'alert-octagon': 'circle-alert',
  'bar-chart-2': 'chart-column',
  'bar-chart-4': 'chart-column',
  'more-h': 'ellipsis',
  loader: 'loader-circle',
  spinner: 'loader-circle',
  close: 'x',
  trash: 'trash-2',
  delete: 'trash-2',
  logout: 'log-out',
  login: 'log-in',
  warning: 'triangle-alert',
  error: 'circle-alert',
  success: 'circle-check',
  question: 'circle-help',
  streak: 'flame',
  schedule: 'calendar-days',
  lesson: 'play',
  questions: 'file-text',
  simulado: 'target',
  essay: 'pen-line',
  tutor: 'bot',
  review: 'refresh-cw',
  errors: 'circle-x',
  performance: 'chart-column',
  notes: 'notebook-pen',
  favorites: 'star',
  tutoring: 'users',
  profile: 'user',
  topic: 'book-open',
  custom: 'circle-dot',
};

/** Resolve o nome para o id do sprite (aplica aliases). */
export function iconName(name) {
  const key = String(name || '').trim();
  return ALIASES[key] || key || 'circle';
}

/**
 * icon('calendar', { size: 18, className: 'text-primary', label: 'Calendário' })
 * Retorna SafeHtml. Sem `label`, o ícone é decorativo (aria-hidden).
 */
export function icon(name, { size, className = '', label = '', strokeWidth } = {}) {
  const id = iconName(name);
  const style = size ? ` style="width:${Number(size)}px;height:${Number(size)}px"` : '';
  const stroke = strokeWidth ? ` stroke-width="${Number(strokeWidth)}"` : '';
  const a11y = label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true" focusable="false"';
  return raw(`<svg class="icon${className ? ` ${escapeHtml(className)}` : ''}"${style}${stroke}${a11y} data-icon="${escapeHtml(id)}"><use href="${ICONS_URL}#i-${escapeHtml(id)}"></use></svg>`);
}

/** Versão que devolve um elemento SVG real (para appendChild). */
export function iconEl(name, options = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(icon(name, options));
  return tpl.content.firstElementChild;
}

/** Troca o ícone de um <svg class="icon"> existente. */
export function swapIcon(svg, name) {
  if (!svg) return;
  const use = svg.querySelector('use');
  const id = iconName(name);
  if (use) use.setAttribute('href', `${ICONS_URL}#i-${id}`);
  svg.dataset.icon = id;
}

/** Ícone por tipo de item do cronograma / atividade. */
export function activityIcon(type) {
  const map = {
    lesson: 'play', topic: 'book-open', questions: 'file-text', review: 'refresh-cw',
    essay: 'pen-line', simulado: 'target', custom: 'circle-dot', practice: 'file-text',
    schedule: 'calendar-days', tutor: 'bot', manual: 'clock',
    // ritmo do plano de estudos: resumo do dia seguinte, prova anterior,
    // treino físico do TAF e dia de descanso
    summary: 'notebook-pen', past_exam: 'file', training: 'dumbbell', rest: 'coffee',
  };
  return map[type] || 'circle-dot';
}

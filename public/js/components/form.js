/**
 * Construtor de formulários do painel administrativo (ARCHITECTURE §6.3).
 *
 *   const form = buildForm(el, fields, {
 *     values: { title: 'Aula 1' },
 *     onSubmit(values) → Promise,        // erros da API (ApiError.details) são mapeados aos campos
 *     submitLabel: 'Salvar',
 *     submitIcon: 'save',
 *     cancel: { label: 'Cancelar', onClick() },
 *     autofocus: true,
 *     onChange(values, key),             // opcional: chamado a cada alteração de campo
 *   });
 *   form.getValues(); form.setValues({ ... }); form.setErrors({ title: 'Obrigatório' } | [{ path, message }]);
 *   form.validate(); form.clearErrors(); form.setSubmitting(bool); form.focus(key); form.destroy();
 *
 * Campo: { key, label, type, required, placeholder, hint, options, min, max, minLength, maxLength,
 *          pattern, patternMessage, step, rows, disabled, readonly, autocomplete,
 *          width: 'full'|'half'|'third'|'two-thirds', default, validate(value, values) → string|null }
 * Tipos: text, email, password, tel, textarea, number, select, multiselect (chips), checkbox/switch,
 *        date, time, url, color, markdown (textarea com prévia), tags, json, hidden,
 *        section (título de seção: { type: 'section', label, hint }).
 *
 * Mapeamento de erros da API: aceita `details` como [{ path, message }] (formato do validate.js —
 * `path` pode vir como 'body.title' ou 'options.0.text'), { campo: mensagem }, { issues: [...] } ou
 * { fieldErrors: { campo: [mensagens] } }. Mensagens sem campo correspondente aparecem no alerta geral.
 */
import { html, raw, render } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { md } from '../core/markdown.js';

const join = (parts) => raw(parts.map((p) => String(p ?? '')).join(''));
const ic = (name, size = 16) => icon(name, { size });

const INPUT_TYPES = { text: 'text', email: 'email', password: 'password', url: 'url', tel: 'tel', number: 'number', date: 'date', time: 'time', search: 'search' };
const FULL_WIDTH_TYPES = new Set(['textarea', 'markdown', 'json', 'multiselect', 'tags', 'section']);
const ARRAY_TYPES = new Set(['multiselect', 'tags']);
const NON_INPUT_TYPES = new Set(['hidden', 'section']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = '#2F80ED';

let sequence = 0;

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((opt) => (
    opt && typeof opt === 'object'
      ? { value: String(opt.value ?? ''), label: String(opt.label ?? opt.value ?? ''), raw: opt.value, disabled: Boolean(opt.disabled) }
      : { value: String(opt), label: String(opt), raw: opt, disabled: false }
  ));
}

function normalizeField(field, index) {
  const type = String(field.type || 'text').toLowerCase();
  const key = field.key != null ? String(field.key) : `section-${index}`;
  return {
    ...field,
    type: type === 'checkbox' ? 'switch' : type,
    key,
    label: field.label ?? key,
    options: normalizeOptions(field.options),
    width: field.width || (FULL_WIDTH_TYPES.has(type) ? 'full' : 'half'),
  };
}

function defaultValue(def) {
  if (def.default !== undefined) return def.default;
  if (def.type === 'switch') return false;
  if (ARRAY_TYPES.has(def.type)) return [];
  if (def.type === 'number' || def.type === 'select' || def.type === 'json') return null;
  if (def.type === 'color') return DEFAULT_COLOR;
  return '';
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function isValidUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value);
}

/** Normaliza um caminho de erro da API ('body.title', ['body','options',0,'text']) em uma chave de campo conhecida. */
function resolveErrorKey(path, keys) {
  const text = Array.isArray(path) ? path.map(String).join('.') : String(path ?? '');
  if (!text) return null;
  const candidates = [text, text.replace(/^(body|query|params)\./, '')];
  for (const candidate of candidates) {
    if (keys.has(candidate)) return candidate;
    const head = candidate.split(/[.[]/)[0];
    if (keys.has(head)) return head;
  }
  return null;
}

/** Converte qualquer formato de erro aceito em uma lista [{ path, message }]. */
function toErrorList(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) {
    return errors.filter(Boolean).map((item) => (
      typeof item === 'string'
        ? { path: '', message: item }
        : { path: item.path ?? item.field ?? '', message: String(item.message || 'Valor inválido.') }
    ));
  }
  if (typeof errors === 'object') {
    if (Array.isArray(errors.issues)) return toErrorList(errors.issues);
    if (errors.fieldErrors && typeof errors.fieldErrors === 'object') {
      return Object.entries(errors.fieldErrors).map(([path, value]) => ({
        path,
        message: String(Array.isArray(value) ? value[0] : value),
      }));
    }
    return Object.entries(errors).map(([path, value]) => ({
      path,
      message: String(Array.isArray(value) ? value[0] : (value && typeof value === 'object' ? value.message : value)),
    }));
  }
  if (typeof errors === 'string') return [{ path: '', message: errors }];
  return [];
}

export function buildForm(el, fields, opts = {}) {
  if (!el) throw new Error('buildForm: elemento de destino obrigatório');

  const formId = `fm-${++sequence}`;
  const defs = (Array.isArray(fields) ? fields : [])
    .filter((f) => f && (f.key || f.type === 'section'))
    .map(normalizeField);
  const inputDefs = defs.filter((d) => d.type !== 'section');
  const keys = new Set(inputDefs.map((d) => d.key));
  const submitLabel = opts.submitLabel || 'Salvar';
  const submitIcon = opts.submitIcon || 'save';
  const state = {
    arrays: {},        // key → string[] (multiselect, tags)
    errors: {},
    submitting: false,
  };
  let destroyed = false;

  // ---------------------------------------------------------------- renderização
  const fieldId = (def) => `${formId}-${def.key}`;

  function controlView(def, id) {
    const describedBy = [def.hint ? `${id}-hint` : null, `${id}-error`].filter(Boolean).join(' ');
    const common = html`id="${id}" name="${def.key}" data-key="${def.key}" aria-describedby="${describedBy}" ${def.disabled ? raw('disabled') : ''} ${def.readonly ? raw('readonly') : ''} ${def.required ? raw('aria-required="true"') : ''}`;
    const placeholder = def.placeholder ? html`placeholder="${def.placeholder}"` : '';

    switch (def.type) {
      case 'textarea':
        return html`<textarea class="textarea" rows="${def.rows || 4}" ${common} ${placeholder} ${def.maxLength ? html`maxlength="${def.maxLength}"` : ''}></textarea>`;
      case 'select':
        return html`
          <select class="select" ${common}>
            <option value="">${def.placeholder || 'Selecione…'}</option>
            ${join(def.options.map((o) => html`<option value="${o.value}" ${o.disabled ? raw('disabled') : ''}>${o.label}</option>`))}
          </select>`;
      case 'multiselect':
        return html`
          <div class="fm-multi" data-multi="${def.key}">
            <div class="chip-group fm-chips" data-chips="${def.key}"></div>
            <select class="select fm-multi-select" ${common} aria-label="${def.placeholder || `Adicionar ${def.label}`}">
              <option value="">${def.placeholder || 'Adicionar…'}</option>
              ${join(def.options.map((o) => html`<option value="${o.value}" ${o.disabled ? raw('disabled') : ''}>${o.label}</option>`))}
            </select>
          </div>`;
      case 'tags':
        return html`
          <div class="input fm-tags" data-tags="${def.key}">
            <span class="fm-chips" data-chips="${def.key}"></span>
            <input type="text" class="fm-tags-input" ${common} placeholder="${def.placeholder || 'Digite e pressione Enter'}" autocomplete="off">
          </div>`;
      case 'color':
        return html`
          <div class="fm-color">
            <input type="color" class="fm-color-swatch" id="${id}-swatch" data-color-swatch="${def.key}" aria-label="${def.label} (seletor de cor)" ${def.disabled ? raw('disabled') : ''}>
            <input type="text" class="input fm-color-text" ${common} placeholder="${DEFAULT_COLOR}" maxlength="7" spellcheck="false" autocomplete="off">
          </div>`;
      case 'markdown':
        return html`
          <div class="fm-md" data-md="${def.key}">
            <div class="tabs tabs-pills fm-md-tabs" role="tablist" aria-label="Modo de edição">
              <button type="button" role="tab" class="tab active" aria-selected="true" data-md-tab="write" data-md-key="${def.key}">${ic('pencil', 14)}<span>Escrever</span></button>
              <button type="button" role="tab" class="tab" aria-selected="false" data-md-tab="preview" data-md-key="${def.key}">${ic('eye', 14)}<span>Prévia</span></button>
            </div>
            <textarea class="textarea fm-md-input" rows="${def.rows || 10}" ${common} ${placeholder} spellcheck="true"></textarea>
            <div class="fm-md-preview md" data-md-preview="${def.key}" hidden></div>
            <p class="hint fm-md-hint">Aceita Markdown: **negrito**, _itálico_, listas, links, imagens e blocos de código.</p>
          </div>`;
      case 'json':
        return html`<textarea class="textarea fm-json" rows="${def.rows || 8}" ${common} placeholder="${def.placeholder || '{ }'}" spellcheck="false"></textarea>`;
      default: {
        const type = INPUT_TYPES[def.type] || 'text';
        const attrs = [];
        if (def.type === 'number') attrs.push(html`step="${def.step ?? 'any'}" inputmode="decimal"`, def.min != null ? html`min="${def.min}"` : '', def.max != null ? html`max="${def.max}"` : '');
        if (def.type === 'date' || def.type === 'time') attrs.push(def.min != null ? html`min="${def.min}"` : '', def.max != null ? html`max="${def.max}"` : '');
        if (def.maxLength) attrs.push(html`maxlength="${def.maxLength}"`);
        if (def.autocomplete) attrs.push(html`autocomplete="${def.autocomplete}"`);
        return html`<input type="${type}" class="input" ${common} ${placeholder} ${join(attrs)}>`;
      }
    }
  }

  function fieldView(def) {
    const id = fieldId(def);
    if (def.type === 'hidden') {
      return html`<input type="hidden" id="${id}" name="${def.key}" data-key="${def.key}">`;
    }
    if (def.type === 'section') {
      return html`
        <div class="fm-section fm-w-full" data-section="${def.key}">
          <h3 class="section-title">${def.label}</h3>
          ${def.hint ? html`<p class="hint">${def.hint}</p>` : ''}
        </div>`;
    }
    const widthClass = `fm-w-${def.width}`;
    if (def.type === 'switch') {
      return html`
        <div class="field fm-field fm-field-switch ${widthClass}" data-field="${def.key}">
          <label class="switch-field fm-switch" for="${id}">
            <span class="fm-switch-text">
              <span class="switch-title">${def.label}</span>
              ${def.hint ? html`<span class="hint" id="${id}-hint">${def.hint}</span>` : ''}
            </span>
            <input type="checkbox" role="switch" class="switch" id="${id}" name="${def.key}" data-key="${def.key}" aria-describedby="${def.hint ? `${id}-hint ` : ''}${id}-error" ${def.disabled ? raw('disabled') : ''}>
          </label>
          <p class="error-text fm-error" id="${id}-error" hidden></p>
        </div>`;
    }
    return html`
      <div class="field fm-field fm-field-${def.type} ${widthClass}" data-field="${def.key}">
        <label class="label" for="${id}">${def.label}${def.required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</label>
        ${controlView(def, id)}
        ${def.hint ? html`<p class="hint" id="${id}-hint">${def.hint}</p>` : ''}
        <p class="error-text fm-error" id="${id}-error" hidden></p>
      </div>`;
  }

  render(el, html`
    <form class="fm" id="${formId}" novalidate autocomplete="off">
      <div class="alert alert-danger fm-alert" role="alert" hidden>
        ${ic('circle-alert', 18)}
        <div class="alert-body fm-alert-text"></div>
      </div>
      <div class="fm-grid">${join(defs.map(fieldView))}</div>
      <div class="fm-actions">
        ${opts.cancel ? html`<button type="button" class="btn btn-secondary fm-cancel">${opts.cancel.label || 'Cancelar'}</button>` : ''}
        <button type="submit" class="btn btn-primary fm-submit">${ic(submitIcon, 18)}<span class="fm-submit-label">${submitLabel}</span></button>
      </div>
    </form>`);

  const form = el.querySelector('form.fm');
  const alertEl = form.querySelector('.fm-alert');
  const alertTextEl = form.querySelector('.fm-alert-text');
  const submitBtn = form.querySelector('.fm-submit');
  const cancelBtn = form.querySelector('.fm-cancel');

  // ---------------------------------------------------------------- acesso aos controles
  const controlOf = (def) => form.querySelector(`[data-key="${CSS.escape(def.key)}"]`);
  const fieldEl = (def) => form.querySelector(`[data-field="${CSS.escape(def.key)}"]`);
  const defOf = (key) => inputDefs.find((d) => d.key === key);

  function paintChips(def) {
    const container = form.querySelector(`[data-chips="${CSS.escape(def.key)}"]`);
    if (!container) return;
    const values = state.arrays[def.key] || [];
    const labelOf = (v) => def.options.find((o) => o.value === v)?.label ?? v;
    render(container, join(values.map((v) => html`
      <span class="chip fm-chip">
        <span class="fm-chip-label">${labelOf(v)}</span>
        <button type="button" class="chip-remove fm-chip-remove" data-remove="${v}" data-remove-key="${def.key}" aria-label="Remover ${labelOf(v)}" ${def.disabled ? raw('disabled') : ''}>${ic('x', 12)}</button>
      </span>`)));
    if (def.type === 'multiselect') {
      const select = controlOf(def);
      if (select) {
        for (const option of select.options) {
          if (option.value !== '') option.hidden = values.includes(option.value);
        }
        select.value = '';
      }
    }
  }

  function notifyChange(key) {
    if (typeof opts.onChange === 'function' && !destroyed) opts.onChange(getValues(), key);
  }

  function addArrayValue(def, value) {
    const text = String(value ?? '').trim();
    if (!text) return;
    const list = state.arrays[def.key] || (state.arrays[def.key] = []);
    if (list.includes(text)) return;
    if (def.max != null && list.length >= Number(def.max)) {
      showFieldError(def.key, `Selecione no máximo ${def.max} ${Number(def.max) === 1 ? 'item' : 'itens'}.`);
      state.errors[def.key] = `Selecione no máximo ${def.max} ${Number(def.max) === 1 ? 'item' : 'itens'}.`;
      return;
    }
    list.push(text);
    paintChips(def);
    clearError(def.key);
    notifyChange(def.key);
  }

  function removeArrayValue(def, value) {
    const list = state.arrays[def.key] || [];
    const index = list.indexOf(String(value));
    if (index >= 0) list.splice(index, 1);
    paintChips(def);
    clearError(def.key);
    notifyChange(def.key);
  }

  function setControlValue(def, value) {
    const control = controlOf(def);
    switch (def.type) {
      case 'switch':
        if (control) control.checked = Boolean(value);
        return;
      case 'multiselect':
      case 'tags':
        state.arrays[def.key] = (Array.isArray(value) ? value : (isEmpty(value) ? [] : [value]))
          .map((v) => String(v ?? '').trim()).filter(Boolean);
        paintChips(def);
        return;
      case 'json':
        if (control) {
          if (typeof value === 'string') control.value = value;
          else control.value = value == null ? '' : JSON.stringify(value, null, 2);
        }
        return;
      case 'color': {
        const text = String(value ?? '').trim();
        if (control) control.value = text.toUpperCase();
        const swatch = form.querySelector(`[data-color-swatch="${CSS.escape(def.key)}"]`);
        if (swatch && HEX_RE.test(text)) swatch.value = text.toLowerCase();
        return;
      }
      case 'select':
        if (control) {
          const match = def.options.find((o) => o.raw === value || o.value === String(value ?? ''));
          control.value = match ? match.value : '';
        }
        return;
      case 'number':
        if (control) control.value = value == null || value === '' ? '' : String(value);
        return;
      case 'date':
        if (control) control.value = value == null ? '' : String(value).slice(0, 10);
        return;
      case 'time':
        if (control) control.value = value == null ? '' : String(value).slice(0, 5);
        return;
      default:
        if (control) control.value = value == null ? '' : String(value);
    }
  }

  function readValue(def) {
    const control = controlOf(def);
    switch (def.type) {
      case 'switch':
        return Boolean(control?.checked);
      case 'number': {
        const text = String(control?.value ?? '').trim();
        if (text === '') return null;
        const n = Number(text.replace(',', '.'));
        return Number.isFinite(n) ? n : Number.NaN;
      }
      case 'select': {
        const text = String(control?.value ?? '');
        if (text === '') return null;
        const match = def.options.find((o) => o.value === text);
        return match ? match.raw : text;
      }
      case 'multiselect':
        return (state.arrays[def.key] || []).map((v) => def.options.find((o) => o.value === v)?.raw ?? v);
      case 'tags':
        return (state.arrays[def.key] || []).slice();
      case 'json': {
        const text = String(control?.value ?? '').trim();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }
      case 'textarea':
      case 'markdown':
        return String(control?.value ?? '');
      case 'color':
        return String(control?.value ?? '').trim().toUpperCase();
      default:
        return String(control?.value ?? '').trim();
    }
  }

  function getValues() {
    const values = {};
    for (const def of inputDefs) values[def.key] = readValue(def);
    return values;
  }

  function setValues(values = {}) {
    for (const def of inputDefs) {
      if (Object.prototype.hasOwnProperty.call(values, def.key)) setControlValue(def, values[def.key]);
    }
  }

  // ---------------------------------------------------------------- validação
  function validateField(def, value, all) {
    const control = controlOf(def);
    if (def.type === 'switch') {
      if (def.required && !value) return def.requiredMessage || 'Este campo é obrigatório.';
    } else if (def.required && isEmpty(value)) {
      return def.requiredMessage || 'Este campo é obrigatório.';
    }

    if (!isEmpty(value)) {
      switch (def.type) {
        case 'number':
          if (Number.isNaN(value)) return 'Informe um número válido.';
          if (def.min != null && value < Number(def.min)) return `O valor mínimo é ${def.min}.`;
          if (def.max != null && value > Number(def.max)) return `O valor máximo é ${def.max}.`;
          if (def.integer && !Number.isInteger(value)) return 'Informe um número inteiro.';
          break;
        case 'url':
          if (!isValidUrl(value)) return 'Informe uma URL válida, começando com http:// ou https://.';
          break;
        case 'email':
          if (!EMAIL_RE.test(String(value))) return 'Informe um e-mail válido.';
          break;
        case 'date':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return 'Informe uma data válida.';
          if (def.min && String(value) < String(def.min)) return `A data mínima é ${formatDate(def.min)}.`;
          if (def.max && String(value) > String(def.max)) return `A data máxima é ${formatDate(def.max)}.`;
          break;
        case 'time':
          if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(value))) return 'Informe um horário válido.';
          break;
        case 'color':
          if (!HEX_RE.test(String(value))) return 'Informe uma cor no formato #RRGGBB.';
          break;
        case 'json': {
          const text = String(control?.value ?? '').trim();
          if (typeof value === 'string' && text) {
            let reason = '';
            try { JSON.parse(text); } catch (err) { reason = err?.message || ''; }
            return `JSON inválido${reason ? `: ${reason}` : '.'}`;
          }
          break;
        }
        case 'multiselect':
        case 'tags':
          if (def.min != null && value.length < Number(def.min)) return `Selecione pelo menos ${def.min} ${Number(def.min) === 1 ? 'item' : 'itens'}.`;
          if (def.max != null && value.length > Number(def.max)) return `Selecione no máximo ${def.max} ${Number(def.max) === 1 ? 'item' : 'itens'}.`;
          break;
        case 'select':
          break;
        default: {
          const text = String(value);
          if (def.minLength && text.length < Number(def.minLength)) return `Mínimo de ${def.minLength} caracteres.`;
          if (def.maxLength && text.length > Number(def.maxLength)) return `Máximo de ${def.maxLength} caracteres.`;
          if (def.pattern) {
            const re = def.pattern instanceof RegExp ? def.pattern : new RegExp(def.pattern);
            if (!re.test(text)) return def.patternMessage || 'Formato inválido.';
          }
        }
      }
    }

    if (typeof def.validate === 'function') {
      const custom = def.validate(value, all);
      if (custom) return String(custom);
    }
    return null;
  }

  function validate(values = getValues()) {
    const errors = {};
    for (const def of inputDefs) {
      if (def.type === 'hidden') continue;
      const message = validateField(def, values[def.key], values);
      if (message) errors[def.key] = message;
    }
    return errors;
  }

  function showFieldError(key, message) {
    const def = defOf(key);
    if (!def) return;
    const wrapper = fieldEl(def);
    const errorEl = wrapper?.querySelector('.fm-error');
    const control = controlOf(def);
    if (errorEl) {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }
    if (wrapper) wrapper.classList.toggle('is-invalid', Boolean(message));
    if (control) {
      control.classList.toggle('is-invalid', Boolean(message));
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }
  }

  function clearError(key) {
    if (!state.errors[key]) return;
    delete state.errors[key];
    showFieldError(key, '');
  }

  function showGeneral(message) {
    if (!alertEl) return;
    alertEl.hidden = !message;
    alertTextEl.textContent = message || '';
  }

  function clearErrors() {
    for (const key of Object.keys(state.errors)) showFieldError(key, '');
    state.errors = {};
    showGeneral('');
  }

  /** Aceita `{ key: mensagem }`, `[{ path, message }]` (details da API), `{ issues }` ou `{ fieldErrors }`. */
  function setErrors(errors, { general } = {}) {
    const mapped = {};
    const unmatched = [];
    for (const item of toErrorList(errors)) {
      const key = resolveErrorKey(item.path, keys);
      if (key) {
        if (!mapped[key]) mapped[key] = item.message;
      } else if (item.message && !unmatched.includes(item.message)) {
        unmatched.push(item.message);
      }
    }
    for (const key of Object.keys(state.errors)) {
      if (!mapped[key]) showFieldError(key, '');
    }
    state.errors = mapped;
    for (const [key, message] of Object.entries(mapped)) showFieldError(key, message);
    let generalMessage = '';
    if (unmatched.length) generalMessage = unmatched.join(' ');
    else if (!Object.keys(mapped).length) generalMessage = general || '';
    else if (general && Object.keys(mapped).length > 1) generalMessage = general;
    showGeneral(generalMessage);
    return mapped;
  }

  function focusField(key) {
    const def = defOf(key);
    const control = def ? controlOf(def) : null;
    if (control && typeof control.focus === 'function') {
      control.focus();
      if (typeof control.scrollIntoView === 'function') control.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }
    return false;
  }

  function focusFirstInvalid() {
    for (const def of inputDefs) {
      if (state.errors[def.key] && focusField(def.key)) return;
    }
    if (alertEl && !alertEl.hidden && typeof alertEl.scrollIntoView === 'function') {
      alertEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function setSubmitting(flag) {
    state.submitting = Boolean(flag);
    form.classList.toggle('is-submitting', state.submitting);
    if (submitBtn) {
      submitBtn.disabled = state.submitting;
      submitBtn.setAttribute('aria-busy', state.submitting ? 'true' : 'false');
      render(submitBtn, html`${ic(state.submitting ? 'loader-circle' : submitIcon, 18)}<span class="fm-submit-label">${state.submitting ? 'Salvando…' : submitLabel}</span>`);
    }
    if (cancelBtn) cancelBtn.disabled = state.submitting;
  }

  function commitPendingTags() {
    for (const def of inputDefs) {
      if (def.type !== 'tags') continue;
      const input = controlOf(def);
      if (input?.value.trim()) { addArrayValue(def, input.value); input.value = ''; }
    }
  }

  // ---------------------------------------------------------------- eventos
  async function onSubmit(event) {
    event.preventDefault();
    if (state.submitting || destroyed) return;
    commitPendingTags();
    clearErrors();
    const values = getValues();
    const errors = validate(values);
    if (Object.keys(errors).length) {
      setErrors(errors);
      focusFirstInvalid();
      return;
    }
    if (typeof opts.onSubmit !== 'function') return;
    setSubmitting(true);
    try {
      await opts.onSubmit(values, api);
    } catch (err) {
      if (destroyed) return;
      const fallback = err?.message || 'Não foi possível salvar. Verifique os dados e tente novamente.';
      if (err?.details) {
        setErrors(err.details, { general: fallback });
        focusFirstInvalid();
      } else {
        showGeneral(fallback);
        focusFirstInvalid();
      }
    } finally {
      if (!destroyed) setSubmitting(false);
    }
  }

  function switchMarkdownTab(def, tab) {
    const wrapper = form.querySelector(`[data-md="${CSS.escape(def.key)}"]`);
    if (!wrapper) return;
    const textarea = wrapper.querySelector('.fm-md-input');
    const preview = wrapper.querySelector('.fm-md-preview');
    const showPreview = tab === 'preview';
    for (const button of wrapper.querySelectorAll('[data-md-tab]')) {
      const active = button.dataset.mdTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (showPreview) {
      const source = String(textarea?.value ?? '').trim();
      render(preview, source
        ? raw(md(source))
        : html`<p class="fm-md-empty">Nada para pré-visualizar. Escreva algo na aba "Escrever".</p>`);
    }
    if (textarea) textarea.hidden = showPreview;
    if (preview) preview.hidden = !showPreview;
    if (!showPreview) textarea?.focus();
  }

  function onClick(event) {
    const remove = event.target.closest('[data-remove-key]');
    if (remove && form.contains(remove)) {
      const def = defOf(remove.dataset.removeKey);
      if (def && !def.disabled) removeArrayValue(def, remove.dataset.remove);
      return;
    }
    const mdTab = event.target.closest('[data-md-tab]');
    if (mdTab && form.contains(mdTab)) {
      const def = defOf(mdTab.dataset.mdKey);
      if (def) switchMarkdownTab(def, mdTab.dataset.mdTab);
      return;
    }
    if (cancelBtn && event.target.closest('.fm-cancel') === cancelBtn) {
      event.preventDefault();
      if (typeof opts.cancel?.onClick === 'function') opts.cancel.onClick();
      return;
    }
    const tagsBox = event.target.closest('.fm-tags');
    if (tagsBox && form.contains(tagsBox) && event.target === tagsBox) {
      tagsBox.querySelector('.fm-tags-input')?.focus();
    }
  }

  function onChange(event) {
    const control = event.target;
    if (!control || !form.contains(control)) return;
    const key = control.dataset.key;
    const def = key ? defOf(key) : null;

    if (def?.type === 'multiselect' && control.classList.contains('fm-multi-select')) {
      if (control.value) addArrayValue(def, control.value);
      control.value = '';
      return;
    }
    if (control.dataset.colorSwatch) {
      const target = defOf(control.dataset.colorSwatch);
      const text = target ? controlOf(target) : null;
      if (text) text.value = control.value.toUpperCase();
      if (target) {
        clearError(target.key);
        notifyChange(target.key);
      }
      return;
    }
    if (def) {
      clearError(def.key);
      if (def.type === 'switch' || def.type === 'select' || def.type === 'date' || def.type === 'time') notifyChange(def.key);
    }
  }

  function onInput(event) {
    const control = event.target;
    if (!control || !form.contains(control)) return;
    const key = control.dataset.key;
    const def = key ? defOf(key) : null;
    if (!def) return;
    clearError(def.key);
    if (def.type === 'color') {
      const swatch = form.querySelector(`[data-color-swatch="${CSS.escape(def.key)}"]`);
      if (swatch && HEX_RE.test(control.value.trim())) swatch.value = control.value.trim().toLowerCase();
    }
    if (def.type !== 'tags') notifyChange(def.key);
  }

  function onKeydown(event) {
    const control = event.target;
    if (!control || !control.classList?.contains('fm-tags-input')) return;
    const def = defOf(control.dataset.key);
    if (!def) return;
    const hasText = Boolean(control.value.trim());
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (hasText) { addArrayValue(def, control.value); control.value = ''; }
    } else if (event.key === 'Tab' && hasText) {
      addArrayValue(def, control.value);
      control.value = '';
    } else if (event.key === 'Backspace' && !control.value) {
      const list = state.arrays[def.key] || [];
      if (list.length) removeArrayValue(def, list[list.length - 1]);
    }
  }

  function onFocusOut(event) {
    const control = event.target;
    if (!control || !form.contains(control)) return;
    const key = control.dataset.key;
    const def = key ? defOf(key) : null;
    if (!def || def.type === 'hidden') return;
    if (def.type === 'tags' && control.value?.trim()) {
      addArrayValue(def, control.value);
      control.value = '';
    }
    // validação individual ao sair do campo (só sinaliza; não bloqueia)
    const values = getValues();
    const message = validateField(def, values[def.key], values);
    if (message) {
      state.errors[def.key] = message;
      showFieldError(def.key, message);
    } else {
      clearError(def.key);
    }
  }

  form.addEventListener('submit', onSubmit);
  form.addEventListener('click', onClick);
  form.addEventListener('change', onChange);
  form.addEventListener('input', onInput);
  form.addEventListener('keydown', onKeydown);
  form.addEventListener('focusout', onFocusOut);

  // ---------------------------------------------------------------- estado inicial
  for (const def of inputDefs) {
    const initial = opts.values && Object.prototype.hasOwnProperty.call(opts.values, def.key)
      ? opts.values[def.key]
      : defaultValue(def);
    setControlValue(def, initial);
  }
  if (opts.autofocus) {
    const first = inputDefs.find((d) => !NON_INPUT_TYPES.has(d.type) && !d.disabled && !d.readonly);
    if (first) focusField(first.key);
  }

  const api = {
    el: form,
    getValues,
    setValues,
    setErrors,
    clearErrors,
    validate,
    setSubmitting,
    focus: focusField,
    submit() {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else submitBtn?.click();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('click', onClick);
      form.removeEventListener('change', onChange);
      form.removeEventListener('input', onInput);
      form.removeEventListener('keydown', onKeydown);
      form.removeEventListener('focusout', onFocusOut);
      el.innerHTML = '';
    },
  };
  return api;
}

export default buildForm;

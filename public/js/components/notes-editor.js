/**
 * Editor de anotações com salvamento automático.
 *
 *   const editor = mountNotesEditor(el, {
 *     value: '',                       // conteúdo inicial
 *     onSave(content) → Promise,       // persiste (ex.: PUT /api/lessons/:id/note)
 *     delay: 1200,                     // debounce em ms
 *     placeholder: 'Escreva suas anotações…',
 *     label: 'Anotações',              // rótulo acessível do textarea
 *     maxLength: null,                 // limite opcional de caracteres
 *     minRows: 4,
 *   });
 *   editor.flush();      // salva agora se houver alteração pendente (Promise<boolean>)
 *   editor.setValue(v);  // substitui o conteúdo sem disparar salvamento
 *   editor.getValue();
 *   editor.isDirty();
 *   editor.focus();
 *   editor.destroy();
 *
 * Comportamento: textarea que cresce com o conteúdo, contador de caracteres e indicador de estado
 * ("Alterações não salvas", "Salvando…", "Salvo às HH:MM", "Erro ao salvar" + tentar novamente).
 * Salva com debounce, ao perder o foco, com Ctrl/Cmd+S, ao ocultar a aba e — de forma síncrona,
 * sem aguardar — antes de o usuário sair da página. Opcional: `onChange(content)` a cada digitação.
 * Marcação com prefixo .ne- (estilos em pages/misc.css).
 */
import { html, render } from '../core/ui.js';
import { icon } from '../core/icons.js';

const h = html;
const ic = (name, size = 14) => icon(name, { size });
const pad = (n) => String(n).padStart(2, '0');
const numberFormat = new Intl.NumberFormat('pt-BR');

let sequence = 0;

export function mountNotesEditor(el, options = {}) {
  if (!el) throw new Error('mountNotesEditor: elemento de destino obrigatório');

  const {
    value = '',
    onSave,
    onChange,
    delay = 1200,
    placeholder = 'Escreva suas anotações sobre esta aula. Elas são salvas automaticamente.',
    label = 'Anotações',
    maxLength = null,
    minRows = 4,
  } = options;

  const id = `ne-${++sequence}`;
  const debounceMs = Math.max(200, Number(delay) || 1200);
  const limit = Number(maxLength) > 0 ? Math.floor(Number(maxLength)) : null;

  let version = 0;        // incrementa a cada alteração do usuário
  let savedVersion = 0;   // versão persistida com sucesso
  let timer = null;
  let saving = null;      // Promise do salvamento em andamento
  let lastSavedAt = null;
  let lastError = null;
  let destroyed = false;

  render(el, html`
    <div class="ne">
      <textarea id="${id}" class="textarea ne-textarea" rows="${Math.max(2, Number(minRows) || 4)}"
        placeholder="${placeholder}" aria-label="${label}" aria-describedby="${id}-status"
        ${limit ? h`maxlength="${limit}"` : ''} spellcheck="true"></textarea>
      <div class="ne-footer">
        <span class="ne-count" id="${id}-count"></span>
        <span class="ne-status" id="${id}-status" role="status" aria-live="polite"></span>
      </div>
    </div>`);

  const textarea = el.querySelector('.ne-textarea');
  const countEl = el.querySelector('.ne-count');
  const statusEl = el.querySelector('.ne-status');

  // ------------------------------------------------------------------ helpers
  const isDirty = () => version !== savedVersion;

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }

  function updateCount() {
    const length = textarea.value.length;
    const text = limit
      ? `${numberFormat.format(length)} / ${numberFormat.format(limit)} caracteres`
      : `${numberFormat.format(length)} ${length === 1 ? 'caractere' : 'caracteres'}`;
    countEl.textContent = text;
    countEl.classList.toggle('is-limit', Boolean(limit) && length >= limit);
  }

  function setStatus(kind) {
    statusEl.className = `ne-status is-${kind}`;
    switch (kind) {
      case 'dirty':
        render(statusEl, html`${ic('pencil')} <span>Alterações não salvas</span>`);
        break;
      case 'saving':
        render(statusEl, html`${ic('loader-circle')} <span>Salvando…</span>`);
        break;
      case 'saved': {
        const at = lastSavedAt ? `${pad(lastSavedAt.getHours())}:${pad(lastSavedAt.getMinutes())}` : '';
        render(statusEl, html`${ic('check')} <span>Salvo${at ? ` às ${at}` : ''}</span>`);
        break;
      }
      case 'error':
        render(statusEl, html`${ic('triangle-alert')} <span>Erro ao salvar</span>
          <button type="button" class="btn btn-ghost btn-sm ne-retry" data-action="retry">Tentar novamente</button>`);
        break;
      default:
        statusEl.textContent = '';
    }
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
  }

  /**
   * Salva o conteúdo pendente. `onSave` é chamado de forma síncrona (antes do primeiro await),
   * o que permite disparar a requisição em `beforeunload`. Nunca rejeita: devolve true/false.
   */
  function flush() {
    clearTimer();
    if (!isDirty()) return saving || Promise.resolve(true);
    if (saving) return saving.then(() => flush());

    const targetVersion = version;
    const content = textarea.value;
    setStatus('saving');

    let result;
    try {
      result = typeof onSave === 'function' ? onSave(content) : undefined;
    } catch (err) {
      result = Promise.reject(err);
    }

    saving = Promise.resolve(result)
      .then(() => {
        savedVersion = Math.max(savedVersion, targetVersion);
        lastSavedAt = new Date();
        lastError = null;
        if (destroyed) return true;
        if (isDirty()) {
          setStatus('dirty');
          schedule();
        } else {
          setStatus('saved');
        }
        return true;
      })
      .catch((err) => {
        lastError = err;
        if (!destroyed) setStatus('error');
        return false;
      })
      .finally(() => { saving = null; });
    return saving;
  }

  function setValue(next) {
    textarea.value = next == null ? '' : String(next);
    version += 1;
    savedVersion = version;
    updateCount();
    autosize();
    setStatus(lastSavedAt ? 'saved' : 'idle');
  }

  // ------------------------------------------------------------------ eventos
  function onInput() {
    version += 1;
    updateCount();
    autosize();
    setStatus('dirty');
    schedule();
    if (typeof onChange === 'function') onChange(textarea.value);
  }

  function onBlur() {
    if (isDirty()) flush();
  }

  function onKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      flush();
    }
  }

  function onStatusClick(event) {
    const button = event.target.closest('[data-action="retry"]');
    if (button) flush();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden' && isDirty()) flush();
  }

  function onBeforeUnload() {
    if (isDirty()) flush();
  }

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('keydown', onKeydown);
  statusEl.addEventListener('click', onStatusClick);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', onBeforeUnload);

  // estado inicial
  textarea.value = value == null ? '' : String(value);
  updateCount();
  autosize();
  setStatus('idle');
  // o textarea pode ter sido montado antes de ficar visível; recalcula a altura no próximo frame
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(autosize);

  function destroy() {
    if (destroyed) return;
    if (isDirty()) flush();
    destroyed = true;
    clearTimer();
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('blur', onBlur);
    textarea.removeEventListener('keydown', onKeydown);
    statusEl.removeEventListener('click', onStatusClick);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onBeforeUnload);
    el.innerHTML = '';
  }

  return {
    el: textarea,
    flush,
    destroy,
    setValue,
    getValue: () => textarea.value,
    isDirty,
    isSaving: () => saving !== null,
    getLastError: () => lastError,
    focus: () => textarea.focus(),
  };
}

export default mountNotesEditor;

// =====================================================================
// /app/resumos/:id — edição de um resumo com autosave de título e conteúdo,
// pré-visualização, favoritar, excluir e link para a aula de origem.
// Consome GET/PUT/DELETE /api/notes/:id e /api/favorites.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render as renderTo, toast, confirm, pageHeader, emptyState, errorState, skeleton,
  badge, qs, qsa, debounce, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDateTime, fmtRelative } from '../../core/format.js';
import { md } from '../../core/markdown.js';
import { mountNotesEditor } from '../../components/notes-editor.js';

let page = null;
let note = null;
let editor = null;
let titleSaver = null;
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  ctx.setTitle('Resumo');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  if (titleSaver) titleSaver.cancel();
  titleSaver = null;
  if (editor) editor.destroy();
  editor = null;
  if (offClick) offClick();
  offClick = null;
  note = null;
  page = null;
}

async function load() {
  try {
    note = await api.get(`/api/notes/${page.params.id}`);
  } catch (err) {
    if (err && err.status === 404) {
      renderTo(
        page.el,
        html`${pageHeader({ title: 'Resumo', breadcrumb: [{ label: 'Meus Resumos', href: '/app/resumos' }, { label: 'Resumo' }] })}
          ${emptyState({
            icon: 'notebook-pen',
            title: 'Resumo não encontrado',
            text: 'Ele pode ter sido excluído. Veja a lista completa dos seus resumos.',
            action: { label: 'Ver meus resumos', href: '/app/resumos', icon: 'arrow-left' },
          })}`
      );
      return;
    }
    renderTo(
      page.el,
      html`${pageHeader({ title: 'Resumo' })}
        ${errorState({
          title: 'Não foi possível abrir o resumo',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', page.el);
    if (btn) btn.addEventListener('click', () => load());
    return;
  }
  paint();
}

function paint() {
  if (editor) {
    editor.destroy();
    editor = null;
  }
  page.setTitle(note.title || 'Resumo');

  renderTo(
    page.el,
    html`
      ${pageHeader({
        title: note.title || 'Resumo sem título',
        subtitle: `Atualizado ${fmtRelative(note.updated_at)}`,
        breadcrumb: [{ label: 'Meus Resumos', href: '/app/resumos' }, { label: note.title || 'Resumo' }],
        actions: html`
          <button type="button" class="btn btn-ghost btn-icon" data-action="favorite" aria-label="${note.favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" aria-pressed="${note.favorited ? 'true' : 'false'}">
            ${icon(note.favorited ? 'star' : 'star-off')}
          </button>
          ${note.lesson_id ? html`<a class="btn btn-secondary" href="/app/aulas/${note.lesson_id}">${icon('play')}<span>Ver aula</span></a>` : ''}
          <button type="button" class="btn btn-danger" data-action="delete">${icon('trash-2')}<span>Excluir</span></button>`,
      })}

      <div class="nt-meta mb-4">
        ${note.subject_name ? badge(note.subject_name, 'blue') : ''}
        ${note.topic_name ? badge(note.topic_name, 'gray') : ''}
        ${note.lesson_title ? html`<span class="chip">${icon('play', { size: 14 })}${note.lesson_title}</span>` : ''}
        <span class="text-3 text-sm">Criado em ${fmtDateTime(note.created_at)}</span>
      </div>

      <section class="card nt-editor">
        <div class="card-body">
          <div class="field">
            <label class="label" for="nt-title">Título</label>
            <input class="input input-lg" id="nt-title" name="title" maxlength="200" value="${note.title || ''}" autocomplete="off">
          </div>
          <div class="nt-editor-tabs">
            <div class="pill-group" role="tablist" aria-label="Modo de edição">
              <button type="button" class="pill active" data-action="mode" data-mode="write" role="tab" aria-selected="true">Escrever</button>
              <button type="button" class="pill" data-action="mode" data-mode="preview" role="tab" aria-selected="false">Visualizar</button>
            </div>
          </div>
          <div id="nt-write"></div>
          <div id="nt-preview" class="prose nt-preview" hidden></div>
        </div>
      </section>`
  );

  editor = mountNotesEditor(qs('#nt-write', page.el), {
    value: note.content || '',
    label: 'Conteúdo do resumo',
    placeholder: 'Escreva o resumo. O conteúdo é salvo automaticamente.',
    maxLength: 50000,
    minRows: 12,
    onSave: async (content) => {
      const updated = await api.put(`/api/notes/${note.id}`, { content });
      note = { ...note, ...updated };
    },
  });

  bind();
}

function bind() {
  const titleInput = qs('#nt-title', page.el);
  if (titleInput) {
    titleSaver = debounce(async () => {
      const title = titleInput.value.trim();
      if (!title || title === note.title) return;
      try {
        const updated = await api.put(`/api/notes/${note.id}`, { title });
        note = { ...note, ...updated };
        page.setTitle(note.title);
        const heading = qs('.page-title', page.el);
        if (heading) heading.textContent = note.title;
      } catch (err) {
        toast(err.message || 'Não foi possível salvar o título.', { type: 'error' });
      }
    }, 900);
    titleInput.addEventListener('input', titleSaver);
    titleInput.addEventListener('blur', () => titleSaver.flush());
  }

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    const action = trigger.dataset.action;
    if (action === 'mode') setMode(trigger.dataset.mode);
    else if (action === 'favorite') toggleFavorite(trigger);
    else if (action === 'delete') removeNote();
  });
}

function setMode(mode) {
  const write = qs('#nt-write', page.el);
  const preview = qs('#nt-preview', page.el);
  if (!write || !preview) return;
  const isPreview = mode === 'preview';
  if (isPreview) {
    const content = editor ? editor.getValue() : note.content || '';
    renderTo(preview, content.trim() ? raw(md(content)) : html`<p class="text-3">Este resumo ainda está em branco.</p>`);
  }
  write.hidden = isPreview;
  preview.hidden = !isPreview;
  qsa('[data-action="mode"]', page.el).forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

async function toggleFavorite(button) {
  const body = { item_type: 'note', item_id: note.id };
  try {
    if (note.favorited) {
      await api.del('/api/favorites', body);
      note.favorited = false;
      toast('Removido dos favoritos.', { type: 'info' });
    } else {
      await api.post('/api/favorites', body);
      note.favorited = true;
      toast('Resumo favoritado.', { type: 'success' });
    }
    button.setAttribute('aria-pressed', note.favorited ? 'true' : 'false');
    button.setAttribute('aria-label', note.favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
    button.innerHTML = String(icon(note.favorited ? 'star' : 'star-off'));
  } catch (err) {
    toast(err.message || 'Não foi possível atualizar os favoritos.', { type: 'error' });
  }
}

async function removeNote() {
  const ok = await confirm({
    title: 'Excluir resumo',
    message: 'O resumo será apagado definitivamente. Deseja continuar?',
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    await api.del(`/api/notes/${note.id}`);
    toast('Resumo excluído.', { type: 'success' });
    page.navigate('/app/resumos');
  } catch (err) {
    toast(err.message || 'Não foi possível excluir o resumo.', { type: 'error' });
  }
}

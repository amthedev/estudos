// =====================================================================
// /app/resumos — lista de resumos do aluno com filtros por matéria,
// assunto e data, busca por texto e criação em modal.
// Consome GET/POST /api/notes e GET /api/subjects.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, modal, pageHeader, emptyState, errorState, skeleton,
  badge, qs, qsa, debounce, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtRelative, pluralize } from '../../core/format.js';

const LIMIT = 12;

let page = null;
let subjects = [];
let result = null;
let filters = { q: '', subject_id: '', topic_id: '', from: '', to: '', page: 1 };
let loading = false;
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  result = null;
  filters = {
    q: typeof ctx.query.q === 'string' ? ctx.query.q : '',
    subject_id: typeof ctx.query.subject_id === 'string' ? ctx.query.subject_id : '',
    topic_id: '',
    from: '',
    to: '',
    page: 1,
  };
  ctx.setTitle('Meus Resumos');
  renderTo(ctx.el, skeleton('page'));

  try {
    subjects = await api.get('/api/subjects', { query: { all: 1 } });
  } catch {
    subjects = [];
  }
  paintShell();
  await loadNotes();
}

export function unmount() {
  if (offClick) offClick();
  offClick = null;
  page = null;
  result = null;
  subjects = [];
}

// ---------------------------------------------------------------------
// Estrutura
// ---------------------------------------------------------------------
function paintShell() {
  renderTo(
    page.el,
    html`
      ${pageHeader({
        title: 'Meus Resumos',
        subtitle: 'O que você entendeu nas aulas, salvo automaticamente e organizado por matéria.',
        actions: html`<button type="button" class="btn btn-primary" data-action="new">${icon('plus')}<span>Novo resumo</span></button>`,
      })}
      <section class="card nt-filters mb-6">
        <div class="card-body nt-filters-body">
          <label class="search-box nt-search">
            <span class="sr-only">Buscar nos resumos</span>
            ${icon('search')}
            <input class="input" type="search" name="q" value="${filters.q}" placeholder="Buscar por título ou conteúdo" autocomplete="off">
          </label>
          <div class="field">
            <label class="label" for="nt-subject">Matéria</label>
            <select class="select" id="nt-subject" name="subject_id">
              <option value="">Todas</option>
              ${subjects.map((s) => html`<option value="${s.id}" ${s.id === filters.subject_id ? 'selected' : ''}>${s.name}</option>`)}
            </select>
          </div>
          <div class="field">
            <label class="label" for="nt-topic">Assunto</label>
            <select class="select" id="nt-topic" name="topic_id" ${filters.subject_id ? '' : 'disabled'}>
              <option value="">Todos</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="nt-from">De</label>
            <input class="input" type="date" id="nt-from" name="from" value="${filters.from}">
          </div>
          <div class="field">
            <label class="label" for="nt-to">Até</label>
            <input class="input" type="date" id="nt-to" name="to" value="${filters.to}">
          </div>
          <button type="button" class="btn btn-ghost btn-sm nt-clear" data-action="clear">${icon('x')}<span>Limpar</span></button>
        </div>
      </section>
      <div id="nt-list">${skeleton('cards', 3)}</div>`
  );

  bindFilters();
  if (filters.subject_id) loadTopics(filters.subject_id);
}

function bindFilters() {
  const root = page.el;
  const search = qs('[name="q"]', root);
  if (search) {
    search.addEventListener(
      'input',
      debounce(() => {
        filters.q = search.value.trim();
        filters.page = 1;
        loadNotes();
      }, 350)
    );
  }

  const subject = qs('[name="subject_id"]', root);
  if (subject) {
    subject.addEventListener('change', async () => {
      filters.subject_id = subject.value;
      filters.topic_id = '';
      filters.page = 1;
      await loadTopics(filters.subject_id);
      loadNotes();
    });
  }

  const topic = qs('[name="topic_id"]', root);
  if (topic) {
    topic.addEventListener('change', () => {
      filters.topic_id = topic.value;
      filters.page = 1;
      loadNotes();
    });
  }

  ['from', 'to'].forEach((name) => {
    const input = qs(`[name="${name}"]`, root);
    if (!input) return;
    input.addEventListener('change', () => {
      filters[name] = input.value;
      filters.page = 1;
      loadNotes();
    });
  });

  if (offClick) offClick();
  offClick = on(root, 'click', '[data-action]', (event, trigger) => {
    const action = trigger.dataset.action;
    if (action === 'new') openNewNote();
    else if (action === 'clear') clearFilters();
    else if (action === 'page') {
      filters.page = Number(trigger.dataset.page) || 1;
      loadNotes();
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'retry') loadNotes();
  });
}

function clearFilters() {
  filters = { q: '', subject_id: '', topic_id: '', from: '', to: '', page: 1 };
  const root = page.el;
  const search = qs('[name="q"]', root);
  if (search) search.value = '';
  const subject = qs('[name="subject_id"]', root);
  if (subject) subject.value = '';
  const topic = qs('[name="topic_id"]', root);
  if (topic) {
    topic.innerHTML = '<option value="">Todos</option>';
    topic.disabled = true;
  }
  qsa('input[type="date"]', root).forEach((input) => {
    input.value = '';
  });
  loadNotes();
}

async function loadTopics(subjectId) {
  const select = qs('[name="topic_id"]', page.el);
  if (!select) return;
  if (!subjectId) {
    select.innerHTML = '<option value="">Todos</option>';
    select.disabled = true;
    return;
  }
  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  try {
    const subject = await api.get(`/api/subjects/${subjectId}`);
    const topics = subject.topics || [];
    select.innerHTML = String(html`<option value="">Todos</option>${topics.map((t) => html`<option value="${t.id}">${t.name}</option>`)}`);
    select.disabled = !topics.length;
  } catch {
    select.innerHTML = '<option value="">Todos</option>';
    select.disabled = true;
  }
}

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------
async function loadNotes() {
  if (!page || loading) return;
  loading = true;
  const host = qs('#nt-list', page.el);
  if (host) renderTo(host, skeleton('cards', 3));
  const query = { page: filters.page, limit: LIMIT };
  if (filters.q) query.q = filters.q;
  if (filters.subject_id) query.subject_id = filters.subject_id;
  if (filters.topic_id) query.topic_id = filters.topic_id;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;

  try {
    result = await api.get('/api/notes', { query });
  } catch (err) {
    loading = false;
    if (!host) return;
    if (err && err.status === 404) {
      renderTo(
        host,
        emptyState({
          icon: 'notebook-pen',
          title: 'Resumos ainda não disponíveis',
          text: 'Estamos preparando esta área. Suas anotações de aula continuam salvas na página da aula.',
        })
      );
      return;
    }
    renderTo(
      host,
      errorState({
        title: 'Não foi possível carregar seus resumos',
        message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
      })
    );
    return;
  }
  loading = false;
  paintList();
}

function hasFilters() {
  return Boolean(filters.q || filters.subject_id || filters.topic_id || filters.from || filters.to);
}

function noteCard(note) {
  return html`
    <article class="card card-hover nt-card">
      <a class="nt-card-link" href="/app/resumos/${note.id}">
        <div class="nt-card-top">
          ${note.subject_name ? badge(note.subject_name, 'blue') : badge('Sem matéria', 'gray')}
          ${note.favorited ? html`<span class="nt-card-star" title="Favorito">${icon('star', { size: 16 })}</span>` : ''}
        </div>
        <h2 class="nt-card-title">${note.title}</h2>
        ${note.excerpt ? html`<p class="nt-card-text clamp-3">${note.excerpt}</p>` : html`<p class="nt-card-text text-3">Resumo em branco.</p>`}
        <div class="meta nt-card-meta">
          ${note.topic_name ? html`<span>${icon('list-tree', { size: 14 })}${note.topic_name}</span>` : ''}
          ${note.lesson_title ? html`<span>${icon('play', { size: 14 })}${note.lesson_title}</span>` : ''}
          <span>${icon('clock', { size: 14 })}${fmtRelative(note.updated_at)}</span>
        </div>
      </a>
    </article>`;
}

function paginationHtml() {
  if (!result || result.pages <= 1) return '';
  const current = result.page;
  const total = result.pages;
  const items = [];
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || Math.abs(i - current) <= 1) items.push(i);
    else if (items[items.length - 1] !== '…') items.push('…');
  }
  return html`
    <nav class="pagination" aria-label="Páginas de resumos">
      <button type="button" class="btn btn-ghost btn-sm" data-action="page" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>${icon('chevron-left')}<span>Anterior</span></button>
      ${items.map((item) =>
        item === '…'
          ? html`<span class="text-3">…</span>`
          : html`<button type="button" class="btn btn-sm ${item === current ? 'btn-secondary' : 'btn-ghost'}" data-action="page" data-page="${item}">${item}</button>`
      )}
      <button type="button" class="btn btn-ghost btn-sm" data-action="page" data-page="${current + 1}" ${current >= total ? 'disabled' : ''}><span>Próxima</span>${icon('chevron-right')}</button>
    </nav>`;
}

function paintList() {
  const host = qs('#nt-list', page.el);
  if (!host) return;
  const items = result.items || [];
  if (!items.length) {
    renderTo(
      host,
      hasFilters()
        ? emptyState({
            icon: 'search',
            title: 'Nenhum resumo encontrado',
            text: 'Ajuste a busca ou os filtros para ver outros resumos.',
            action: { label: 'Limpar filtros', dataAction: 'clear', variant: 'secondary', icon: 'x' },
          })
        : emptyState({
            icon: 'notebook-pen',
            title: 'Você ainda não tem resumos',
            text: 'Durante uma aula, abra Meu Resumo e explique com suas palavras o que entendeu.',
            action: { label: 'Criar meu primeiro resumo', dataAction: 'new', icon: 'plus' },
          })
    );
    return;
  }
  renderTo(
    host,
    html`
      <div class="nt-count text-3 text-sm mb-3">${pluralize(result.total, 'resumo', 'resumos')}</div>
      <div class="grid grid-3 nt-grid">${items.map(noteCard)}</div>
      ${paginationHtml()}`
  );
}

// ---------------------------------------------------------------------
// Novo resumo
// ---------------------------------------------------------------------
function openNewNote() {
  const dialog = modal({
    title: 'Novo resumo',
    subtitle: 'Dê um título, escolha onde ele se encaixa e escreva o essencial.',
    size: 'lg',
    body: html`
      <div class="field">
        <label class="label" for="nt-new-title">Título</label>
        <input class="input" id="nt-new-title" name="title" maxlength="200" placeholder="Ex.: Leis de Newton em uma página" autocomplete="off">
        <p class="error-text" data-error-for="title"></p>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label class="label" for="nt-new-subject">Matéria (opcional)</label>
          <select class="select" id="nt-new-subject" name="subject_id">
            <option value="">Sem matéria</option>
            ${subjects.map((s) => html`<option value="${s.id}">${s.name}</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="nt-new-topic">Assunto (opcional)</label>
          <select class="select" id="nt-new-topic" name="topic_id" disabled>
            <option value="">Escolha a matéria primeiro</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="label" for="nt-new-content">Conteúdo</label>
        <textarea class="textarea textarea-lg" id="nt-new-content" name="content" rows="8" placeholder="Escreva o resumo. Você pode usar markdown simples."></textarea>
      </div>`,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Criar resumo',
        variant: 'primary',
        onClick: async () => {
          const title = qs('[name="title"]', dialog.body).value.trim();
          if (!title) {
            const error = qs('[data-error-for="title"]', dialog.body);
            if (error) error.textContent = 'Dê um título ao resumo.';
            return false;
          }
          const payload = {
            title,
            content: qs('[name="content"]', dialog.body).value,
          };
          const subjectId = qs('[name="subject_id"]', dialog.body).value;
          const topicId = qs('[name="topic_id"]', dialog.body).value;
          if (topicId) payload.topic_id = topicId;
          else if (subjectId) payload.subject_id = subjectId;
          try {
            const note = await api.post('/api/notes', payload);
            toast('Resumo criado.', { type: 'success' });
            page.navigate(`/app/resumos/${note.id}`);
          } catch (err) {
            toast(err.message || 'Não foi possível criar o resumo.', { type: 'error' });
            return false;
          }
          return undefined;
        },
      },
    ],
  });

  const subject = qs('[name="subject_id"]', dialog.body);
  const topic = qs('[name="topic_id"]', dialog.body);
  subject.addEventListener('change', async () => {
    if (!subject.value) {
      topic.innerHTML = '<option value="">Escolha a matéria primeiro</option>';
      topic.disabled = true;
      return;
    }
    topic.disabled = true;
    topic.innerHTML = '<option value="">Carregando…</option>';
    try {
      const detail = await api.get(`/api/subjects/${subject.value}`);
      const topics = detail.topics || [];
      topic.innerHTML = String(html`<option value="">Sem assunto</option>${topics.map((t) => html`<option value="${t.id}">${t.name}</option>`)}`);
      topic.disabled = !topics.length;
    } catch {
      topic.innerHTML = '<option value="">Sem assunto</option>';
      topic.disabled = true;
    }
  });
}

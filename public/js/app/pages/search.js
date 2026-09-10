// =====================================================================
// /app/busca — resultados da busca global agrupados em aulas, questões,
// assuntos e resumos. Consome GET /api/search?q=.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render as renderTo, pageHeader, emptyState, errorState, skeleton, badge, qs } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, fmtRelative, difficultyLabel, difficultyTone, pluralize } from '../../core/format.js';

const GROUPS = [
  { key: 'lessons', label: 'Aulas', icon: 'play' },
  { key: 'questions', label: 'Questões', icon: 'file-text' },
  { key: 'topics', label: 'Assuntos', icon: 'list-tree' },
  { key: 'notes', label: 'Resumos', icon: 'notebook-pen' },
];

let page = null;
let term = '';

export default async function renderPage(ctx) {
  page = ctx;
  term = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
  ctx.setTitle(term ? `Busca: ${term}` : 'Busca');
  renderTo(ctx.el, html`${header()}${skeleton('list', 4)}`);

  if (term.length < 2) {
    renderTo(
      ctx.el,
      html`${header()}
        ${emptyState({
          icon: 'search',
          title: 'O que você quer estudar agora?',
          text: 'Digite pelo menos duas letras para buscar em aulas, questões, assuntos e nos seus resumos.',
        })}`
    );
    focusInput();
    return;
  }

  let result;
  try {
    result = await api.get('/api/search', { query: { q: term } });
  } catch (err) {
    renderTo(
      ctx.el,
      html`${header()}
        ${errorState({
          title: 'Não foi possível buscar agora',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', ctx.el);
    if (btn) btn.addEventListener('click', () => renderPage(ctx));
    bindForm();
    return;
  }

  paint(result);
}

export function unmount() {
  page = null;
  term = '';
}

function header() {
  return html`
    ${pageHeader({
      title: 'Busca',
      subtitle: term ? `Resultados para “${term}”` : 'Encontre aulas, questões, assuntos e seus resumos.',
    })}
    <form class="search-box se-form mb-6" id="se-form" role="search">
      ${icon('search')}
      <input class="input" type="search" name="q" value="${term}" placeholder="Buscar aulas, questões, assuntos e resumos" aria-label="Buscar" enterkeyhint="search" autocomplete="off">
      <button type="submit" class="btn btn-primary btn-sm">Buscar</button>
    </form>`;
}

function focusInput() {
  bindForm();
  const input = qs('#se-form input[name="q"]', page.el);
  if (input) input.focus();
}

function bindForm() {
  const form = qs('#se-form', page.el);
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = form.elements.q.value.trim();
    if (value.length < 2) return;
    page.navigate(`/app/busca?q=${encodeURIComponent(value)}`);
  });
}

function lessonRow(item) {
  return html`
    <li class="list-item is-clickable">
      <span class="list-item-icon" style="color:${item.subject_color || 'var(--primary-2)'}">${icon(item.subject_icon || 'play')}</span>
      <div class="list-item-main">
        <a class="list-item-title link-plain" href="${item.href}">${item.title}</a>
        <span class="list-item-meta">${item.subject_name} · ${item.topic_name}${item.duration_min ? ` · ${fmtMinutes(item.duration_min)}` : ''}</span>
      </div>
      <div class="list-item-end">${item.completed ? badge('Concluída', 'green') : ''}</div>
    </li>`;
}

function questionRow(item) {
  return html`
    <li class="list-item is-clickable">
      <span class="list-item-icon">${icon('file-text')}</span>
      <div class="list-item-main">
        <a class="list-item-title link-plain se-question" href="${item.href}">${item.excerpt}</a>
        <span class="list-item-meta">${item.subject_name} · ${item.topic_name}${item.year ? ` · ${item.year}` : ''}</span>
      </div>
      <div class="list-item-end">${item.difficulty ? badge(difficultyLabel(item.difficulty), difficultyTone(item.difficulty)) : ''}</div>
    </li>`;
}

function topicRow(item) {
  return html`
    <li class="list-item is-clickable">
      <span class="list-item-icon" style="color:${item.subject_color || 'var(--primary-2)'}">${icon(item.subject_icon || 'list-tree')}</span>
      <div class="list-item-main">
        <a class="list-item-title link-plain" href="${item.href}">${item.name}</a>
        <span class="list-item-meta">${item.subject_name}${item.description ? ` · ${item.description}` : ''}</span>
      </div>
      <div class="list-item-end"><span class="text-3 text-sm">${pluralize(item.lessons_total || 0, 'aula', 'aulas')}</span></div>
    </li>`;
}

function noteRow(item) {
  return html`
    <li class="list-item is-clickable">
      <span class="list-item-icon">${icon('notebook-pen')}</span>
      <div class="list-item-main">
        <a class="list-item-title link-plain" href="${item.href}">${item.title}</a>
        <span class="list-item-meta">${item.excerpt || 'Resumo em branco'}</span>
      </div>
      <div class="list-item-end"><span class="text-3 text-sm">${fmtRelative(item.updated_at)}</span></div>
    </li>`;
}

const ROWS = { lessons: lessonRow, questions: questionRow, topics: topicRow, notes: noteRow };

function paint(result) {
  const total = result.total || 0;
  if (!total) {
    renderTo(
      page.el,
      html`${header()}
        ${emptyState({
          icon: 'search',
          title: `Nada encontrado para “${term}”`,
          text: 'Tente outras palavras ou busque pelo nome do assunto.',
          action: { label: 'Ver matérias', href: '/app/materias', icon: 'library' },
        })}`
    );
    bindForm();
    return;
  }

  renderTo(
    page.el,
    html`
      ${header()}
      <p class="text-3 text-sm mb-4">${pluralize(total, 'resultado', 'resultados')} para “${term}”</p>
      <div class="se-groups">
        ${GROUPS.filter((group) => (result[group.key] || []).length).map(
          (group) => html`
            <section class="card se-group">
              <div class="card-header">
                <h2 class="card-title">${icon(group.icon)} ${group.label}</h2>
                <span class="count-badge">${(result[group.key] || []).length}</span>
              </div>
              <ul class="list list-plain">${(result[group.key] || []).map(ROWS[group.key])}</ul>
            </section>`
        )}
      </div>`
  );

  bindForm();
}

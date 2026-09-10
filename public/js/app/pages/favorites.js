// =====================================================================
// /app/favoritos — aulas, questões, assuntos e resumos salvos pelo aluno,
// em abas, com remoção direta. Consome GET/DELETE /api/favorites.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, confirm, pageHeader, emptyState, errorState, skeleton,
  badge, tabs, qs, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, fmtRelative, difficultyLabel, difficultyTone } from '../../core/format.js';

const TABS = [
  { id: 'lesson', label: 'Aulas', icon: 'play' },
  { id: 'question', label: 'Questões', icon: 'file-text' },
  { id: 'topic', label: 'Assuntos', icon: 'list-tree' },
  { id: 'note', label: 'Resumos', icon: 'notebook-pen' },
];

const EMPTY = {
  lesson: { title: 'Nenhuma aula favoritada', text: 'Use a estrela na página da aula para guardar as que quiser rever.', action: { label: 'Ver aulas', href: '/app/aulas', icon: 'play' } },
  question: { title: 'Nenhuma questão favoritada', text: 'Favorite questões marcantes no banco para revisitar antes da prova.', action: { label: 'Ir para as questões', href: '/app/questoes', icon: 'file-text' } },
  topic: { title: 'Nenhum assunto favoritado', text: 'Marque os assuntos que exigem mais atenção para chegar rápido neles.', action: { label: 'Ver matérias', href: '/app/materias', icon: 'library' } },
  note: { title: 'Nenhum resumo favoritado', text: 'Favorite os resumos que você mais consulta para achá-los na hora.', action: { label: 'Ver meus resumos', href: '/app/resumos', icon: 'notebook-pen' } },
};

let page = null;
let data = null;
let active = 'lesson';
let tabsApi = null;
let offClick = null;

export default async function renderPage(ctx) {
  page = ctx;
  active = TABS.some((t) => t.id === ctx.query.tipo) ? ctx.query.tipo : 'lesson';
  ctx.setTitle('Favoritos');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  if (offClick) offClick();
  offClick = null;
  page = null;
  data = null;
  tabsApi = null;
}

async function load() {
  try {
    data = await api.get('/api/favorites');
  } catch (err) {
    if (err && err.status === 404) {
      renderTo(
        page.el,
        html`${header()}
          ${emptyState({
            icon: 'star',
            title: 'Favoritos ainda não disponíveis',
            text: 'Estamos preparando esta área. Em breve tudo que você marcar aparece aqui.',
          })}`
      );
      return;
    }
    renderTo(
      page.el,
      html`${header()}
        ${errorState({
          title: 'Não foi possível carregar seus favoritos',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
        })}`
    );
    const btn = qs('[data-action="retry"]', page.el);
    if (btn) btn.addEventListener('click', () => load());
    return;
  }
  paint();
}

function header() {
  return pageHeader({
    title: 'Favoritos',
    subtitle: 'Tudo que você marcou para voltar depois, reunido em um lugar só.',
  });
}

function itemsOf(type) {
  return (data.items || []).filter((item) => item.item_type === type);
}

function cardFor(item) {
  const remove = html`
    <button type="button" class="btn btn-ghost btn-icon fv-remove" data-action="remove" data-type="${item.item_type}" data-id="${item.item_id}" aria-label="Remover dos favoritos">
      ${icon('star-off')}
    </button>`;

  if (item.item_type === 'lesson') {
    return html`
      <article class="card card-hover fv-card">
        <div class="fv-card-body">
          <a class="fv-card-link" href="${item.href}">
            <div class="fv-card-top">
              ${badge(item.subject_name || 'Aula', 'blue')}
              ${item.completed ? badge('Concluída', 'green', { icon: 'check' }) : ''}
            </div>
            <h2 class="fv-card-title">${item.title}</h2>
            <div class="meta">
              ${item.topic_name ? html`<span>${item.topic_name}</span>` : ''}
              ${item.duration_min ? html`<span>${icon('clock', { size: 14 })}${fmtMinutes(item.duration_min)}</span>` : ''}
              ${item.difficulty ? html`<span>${difficultyLabel(item.difficulty)}</span>` : ''}
            </div>
          </a>
          ${remove}
        </div>
      </article>`;
  }

  if (item.item_type === 'question') {
    return html`
      <article class="card card-hover fv-card">
        <div class="fv-card-body">
          <a class="fv-card-link" href="${item.href}">
            <div class="fv-card-top">
              ${badge(item.subject_name || 'Questão', 'blue')}
              ${item.difficulty ? badge(difficultyLabel(item.difficulty), difficultyTone(item.difficulty)) : ''}
            </div>
            <p class="fv-card-text clamp-3">${item.excerpt || item.title}</p>
            <div class="meta">
              ${item.topic_name ? html`<span>${item.topic_name}</span>` : ''}
              ${item.year ? html`<span>${item.year}${item.board ? ` · ${item.board}` : ''}</span>` : ''}
            </div>
          </a>
          ${remove}
        </div>
      </article>`;
  }

  if (item.item_type === 'topic') {
    return html`
      <article class="card card-hover fv-card">
        <div class="fv-card-body">
          <a class="fv-card-link" href="${item.href}">
            <div class="fv-card-top">${badge(item.subject_name || 'Assunto', 'blue')}</div>
            <h2 class="fv-card-title">${item.title}</h2>
            ${item.excerpt ? html`<p class="fv-card-text clamp-2">${item.excerpt}</p>` : ''}
            <div class="meta"><span>${icon('play', { size: 14 })}${item.lessons_total || 0} aulas</span></div>
          </a>
          ${remove}
        </div>
      </article>`;
  }

  return html`
    <article class="card card-hover fv-card">
      <div class="fv-card-body">
        <a class="fv-card-link" href="${item.href}">
          <div class="fv-card-top">${item.subject_name ? badge(item.subject_name, 'blue') : badge('Resumo', 'gray')}</div>
          <h2 class="fv-card-title">${item.title}</h2>
          ${item.excerpt ? html`<p class="fv-card-text clamp-3">${item.excerpt}</p>` : ''}
          <div class="meta"><span>${icon('clock', { size: 14 })}${fmtRelative(item.updated_at)}</span></div>
        </a>
        ${remove}
      </div>
    </article>`;
}

function listHtml() {
  const items = itemsOf(active);
  if (!items.length) {
    const config = EMPTY[active];
    return emptyState({ icon: 'star', title: config.title, text: config.text, action: config.action });
  }
  return html`<div class="grid grid-3 fv-grid">${items.map(cardFor)}</div>`;
}

function paint() {
  const counts = data.counts || {};
  renderTo(
    page.el,
    html`
      ${header()}
      <div id="fv-tabs" class="mb-5"></div>
      <div id="fv-list">${listHtml()}</div>`
  );

  tabsApi = tabs(
    qs('#fv-tabs', page.el),
    TABS.map((tab) => ({ ...tab, count: counts[tab.id] || 0 })),
    (id) => {
      active = id;
      renderTo(qs('#fv-list', page.el), listHtml());
    },
    { active }
  );

  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action="remove"]', (event, trigger) => {
    event.preventDefault();
    removeFavorite(trigger.dataset.type, trigger.dataset.id);
  });
}

async function removeFavorite(type, id) {
  const ok = await confirm({
    title: 'Remover dos favoritos',
    message: 'Este item sai da sua lista de favoritos. Você pode favoritá-lo de novo quando quiser.',
    confirmText: 'Remover',
    icon: 'star-off',
  });
  if (!ok) return;
  try {
    await api.del('/api/favorites', { item_type: type, item_id: id });
    data.items = (data.items || []).filter((item) => !(item.item_type === type && item.item_id === id));
    if (data.counts && data.counts[type]) {
      data.counts[type] -= 1;
      data.counts.total = Math.max(0, (data.counts.total || 1) - 1);
    }
    if (tabsApi) tabsApi.setCount(type, data.counts[type] || 0);
    renderTo(qs('#fv-list', page.el), listHtml());
    toast('Removido dos favoritos.', { type: 'success' });
  } catch (err) {
    toast(err.message || 'Não foi possível remover o favorito.', { type: 'error' });
  }
}

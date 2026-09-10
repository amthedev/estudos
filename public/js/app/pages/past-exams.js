// =====================================================================
// /app/provas-anteriores — provas aplicadas em anos anteriores, agrupadas
// por vestibular e ano, com PDF da prova, gabarito e link oficial.
// Consome GET /api/past-exams.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render as renderTo, pageHeader, emptyState, errorState, skeleton, tabs, qs, debounce } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pluralize } from '../../core/format.js';

let page = null;
let data = null;
let activeExam = null;
let yearQuery = '';

export default async function renderPage(ctx) {
  page = ctx;
  activeExam = null;
  yearQuery = typeof ctx.query.ano === 'string' ? ctx.query.ano : '';
  ctx.setTitle('Provas Anteriores');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  data = null;
  page = null;
  activeExam = null;
  yearQuery = '';
}

async function load() {
  try {
    data = await api.get('/api/past-exams');
  } catch (err) {
    if (err && err.status === 404) {
      renderEmptyApi();
      return;
    }
    renderTo(
      page.el,
      html`${header()}
        ${errorState({
          title: 'Não foi possível carregar as provas anteriores',
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
    title: 'Provas Anteriores',
    subtitle: 'Baixe as provas aplicadas, confira o gabarito e treine no formato real.',
  });
}

function renderEmptyApi() {
  renderTo(
    page.el,
    html`${header()}
      ${emptyState({
        icon: 'file',
        title: 'Provas anteriores ainda não disponíveis',
        text: 'Assim que as provas forem cadastradas, elas aparecem aqui separadas por vestibular e ano.',
        action: { label: 'Praticar com o banco de questões', href: '/app/questoes', icon: 'file-text' },
      })}`
  );
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function currentExam() {
  const list = data.exams || [];
  if (!list.length) return null;
  return list.find((group) => group.exam.id === activeExam) || list[0];
}

function dayLabel(item, track) {
  if (item.day) return `${item.day}º dia`;
  if (track === 'barro_branco' && item.board) return item.board;
  return '';
}

function itemRow(item, track) {
  const day = dayLabel(item, track);
  const links = [
    item.pdf_url ? { href: item.pdf_url, label: 'Prova (PDF)', icon: 'file-text', variant: 'secondary' } : null,
    item.answer_key_url ? { href: item.answer_key_url, label: 'Gabarito', icon: 'check-check', variant: 'ghost' } : null,
    item.external_url ? { href: item.external_url, label: 'Página oficial', icon: 'external-link', variant: 'ghost' } : null,
  ].filter(Boolean);

  return html`
    <li class="pex-item">
      <div class="pex-item-main">
        <span class="pex-item-title">${item.title}</span>
        <span class="meta">
          ${day ? html`<span>${day}</span>` : ''}
          ${item.board && item.board !== day ? html`<span>${item.board}</span>` : ''}
          ${item.notes ? html`<span>${item.notes}</span>` : ''}
        </span>
      </div>
      <div class="pex-item-actions">
        ${links.length
          ? links.map(
              (link) => html`<a class="btn btn-${link.variant} btn-sm" href="${link.href}" target="_blank" rel="noopener external">${icon(link.icon)}<span>${link.label}</span></a>`
            )
          : html`<span class="text-3 text-sm">Arquivos em breve</span>`}
      </div>
    </li>`;
}

function yearCard(yearGroup, track) {
  return html`
    <article class="card pex-year">
      <div class="card-header">
        <h3 class="card-title">${yearGroup.year}</h3>
        <span class="text-3 text-sm">${pluralize(yearGroup.items.length, 'arquivo', 'arquivos')}</span>
      </div>
      <ul class="list list-plain pex-list">
        ${yearGroup.items.map((item) => itemRow(item, track))}
      </ul>
    </article>`;
}

function contentHtml() {
  const group = currentExam();
  if (!group) {
    return emptyState({
      icon: 'file',
      title: 'Nenhuma prova cadastrada ainda',
      text: 'Assim que as provas anteriores forem publicadas, elas aparecem aqui por vestibular e ano.',
      action: { label: 'Ir para as questões', href: '/app/questoes', icon: 'file-text' },
    });
  }
  const term = yearQuery.trim();
  const years = term ? group.years.filter((y) => String(y.year).includes(term)) : group.years;
  if (!years.length) {
    return emptyState({
      icon: 'search',
      title: `Nenhuma prova de ${term}`,
      text: `Não encontramos provas de ${group.exam.short_name} para esse ano.`,
    });
  }
  return html`<div class="pex-years">${years.map((y) => yearCard(y, group.exam.track))}</div>`;
}

function paint() {
  const groups = data.exams || [];
  if (!activeExam && groups.length) activeExam = groups[0].exam.id;

  renderTo(
    page.el,
    html`
      ${header()}
      ${groups.length
        ? html`
            <div class="pex-toolbar">
              <div id="pex-tabs" class="pex-tabs"></div>
              <label class="search-box pex-search">
                <span class="sr-only">Buscar por ano</span>
                ${icon('search')}
                <input class="input" type="search" id="pex-year" value="${yearQuery}" placeholder="Buscar por ano" inputmode="numeric" autocomplete="off">
              </label>
            </div>`
        : ''}
      <div id="pex-content">${contentHtml()}</div>`
  );

  if (groups.length) {
    tabs(
      qs('#pex-tabs', page.el),
      groups.map((group) => ({ id: group.exam.id, label: group.exam.short_name || group.exam.name, count: group.total })),
      (id) => {
        activeExam = id;
        renderTo(qs('#pex-content', page.el), contentHtml());
      },
      { active: activeExam }
    );

    const input = qs('#pex-year', page.el);
    if (input) {
      input.addEventListener(
        'input',
        debounce(() => {
          yearQuery = input.value;
          renderTo(qs('#pex-content', page.el), contentHtml());
        }, 250)
      );
    }
  }
}

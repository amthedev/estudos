// =====================================================================
// /app/provas-anteriores — provas aplicadas em anos anteriores, agrupadas
// por vestibular e ano, com PDF da prova, gabarito e link oficial.
// Consome GET /api/past-exams.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render as renderTo, pageHeader, emptyState, errorState, skeleton, tabs, qs, debounce } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pluralize, fmtDate } from '../../core/format.js';

let page = null;
let data = null;
let activeExam = null;
let yearQuery = '';
let notice = null;

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
  notice = null;
}

async function load() {
  try {
    const [pastExams, notices] = await Promise.all([
      api.get('/api/past-exams'),
      // o edital é um complemento: se falhar, a página de provas continua de pé
      api.get('/api/notices').catch(() => null),
    ]);
    data = pastExams;
    notice = notices && notices.current ? notices.current : null;
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

/**
 * Edital vigente da prova do aluno: o documento oficial com as datas.
 * Só aparece quando a equipe publicou um edital para essa prova.
 */
function noticeCard() {
  if (!notice) return '';
  const facts = [
    notice.registration_end
      ? {
        icon: 'calendar-clock',
        label: 'Inscrições até',
        value: fmtDate(notice.registration_end),
        alert: notice.registration_open && notice.days_until_registration_end !== null && notice.days_until_registration_end <= 7,
      }
      : null,
    notice.exam_date ? { icon: 'calendar-days', label: 'Prova', value: fmtDate(notice.exam_date) } : null,
    notice.second_exam_date ? { icon: 'calendar-days', label: 'Segundo dia', value: fmtDate(notice.second_exam_date) } : null,
    notice.result_date ? { icon: 'trophy', label: 'Resultado', value: fmtDate(notice.result_date) } : null,
    notice.vacancies ? { icon: 'users', label: 'Vagas', value: String(notice.vacancies) } : null,
  ].filter(Boolean);

  const links = [
    notice.pdf_url ? { href: notice.pdf_url, label: 'Ler o edital', icon: 'file-text', variant: 'secondary' } : null,
    notice.external_url ? { href: notice.external_url, label: 'Página oficial', icon: 'external-link', variant: 'ghost' } : null,
  ].filter(Boolean);

  return html`
    <section class="card pex-notice">
      <div class="card-body">
        <div class="pex-notice-head">
          <div>
            <span class="pex-notice-eyebrow">${icon('scroll-text')}<span>Edital vigente</span></span>
            <h2 class="card-title">${notice.title}</h2>
            ${notice.board ? html`<p class="hint">${notice.board}</p>` : ''}
          </div>
          ${notice.days_until_exam !== null
            ? html`<div class="pex-notice-count">
                <strong>${notice.days_until_exam}</strong>
                <span>${pluralize(notice.days_until_exam, 'dia', 'dias', { withNumber: false })} para a prova</span>
              </div>`
            : ''}
        </div>

        ${notice.registration_open
          ? html`<p class="alert alert-warning pex-notice-alert">
              ${icon('circle-alert')}
              <span>Inscrições abertas${notice.days_until_registration_end !== null
                ? html` — ${pluralize(notice.days_until_registration_end, 'dia restante', 'dias restantes')}`
                : ''}.</span>
            </p>`
          : ''}

        ${facts.length
          ? html`<ul class="pex-notice-facts">
              ${facts.map((fact) => html`
                <li class="${fact.alert ? 'is-alert' : ''}">
                  ${icon(fact.icon)}
                  <span class="pex-fact-label">${fact.label}</span>
                  <strong>${fact.value}</strong>
                </li>`)}
            </ul>`
          : ''}

        ${links.length
          ? html`<div class="pex-notice-links">
              ${links.map((link) => html`
                <a class="btn btn-${link.variant}" href="${link.href}" target="_blank" rel="noopener noreferrer">
                  ${icon(link.icon)}<span>${link.label}</span>
                </a>`)}
            </div>`
          : ''}
      </div>
    </section>`;
}

function renderEmptyApi() {
  renderTo(
    page.el,
    html`${header()}
      ${noticeCard()}
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
      ${noticeCard()}
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

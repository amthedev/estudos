// =====================================================================
// Foco Elite — Admin › Redação (ARCHITECTURE §6.5)
//
// Três abas:
//   Temas               lista e formulário dos temas oferecidos ao aluno
//   Critérios           matriz de correção por prova, com link para a aba
//                       Redação do vestibular
//   Redações corrigidas aluno, prova, tema, nota, data e situação, abrindo a
//                       correção completa em modal
//
// API: /api/admin/essays/themes, /api/admin/essays/criteria/:examId,
//      /api/admin/essays/submissions[/:id]
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, modal, qs, on, tabs,
  pageHeader, skeleton, errorState, emptyState, badge, progressBar,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtDateTime, fmtNumber, fmtScore, truncate } from '../../core/format.js';
import { mountTable } from '../../components/data-table.js';
import { buildForm } from '../../components/form.js';

const TABS = [
  { id: 'temas', label: 'Temas', icon: 'lightbulb' },
  { id: 'criterios', label: 'Critérios', icon: 'list-checks' },
  { id: 'corrigidas', label: 'Redações corrigidas', icon: 'pen-line' },
];

const STATUS = {
  submitted: { label: 'Aguardando correção', tone: 'orange' },
  corrected: { label: 'Corrigida', tone: 'green' },
  failed: { label: 'Falha na correção', tone: 'red' },
  draft: { label: 'Rascunho', tone: 'gray' },
};

let state = null;

// ---------------------------------------------------------------------
// Aba: temas
// ---------------------------------------------------------------------
function themeFields() {
  return [
    { key: 'title', label: 'Título do tema', type: 'text', required: true, maxLength: 300, placeholder: 'Ex.: Os desafios da mobilidade urbana no Brasil' },
    {
      key: 'exam_id',
      label: 'Prova',
      type: 'select',
      width: 'half',
      options: state.exams.map((exam) => ({ value: exam.id, label: exam.name })),
      placeholder: 'Serve para todas as provas',
      hint: 'Deixe em branco para oferecer o tema a todos os alunos.',
    },
    { key: 'year', label: 'Ano', type: 'number', width: 'half', min: 1950, max: 2100, step: 1, placeholder: 'Ano em que o tema caiu' },
    { key: 'prompt_text', label: 'Proposta de redação', type: 'textarea', rows: 5, maxLength: 20000, placeholder: 'Enunciado da proposta, como aparece na prova.' },
    { key: 'support_texts', label: 'Textos motivadores', type: 'textarea', rows: 8, maxLength: 40000, placeholder: 'Textos de apoio (aceita markdown).' },
    { key: 'source', label: 'Fonte', type: 'text', maxLength: 200, placeholder: 'ENEM 2023, banca, jornal…' },
    { key: 'active', label: 'Tema disponível para os alunos', type: 'switch', default: true },
  ];
}

async function openThemeForm(row) {
  const editing = Boolean(row);
  let theme = row;
  if (editing) {
    try {
      theme = await api.get(`/api/admin/essays/themes/${row.id}`);
    } catch (err) {
      toast((err && err.message) || 'Não foi possível abrir o tema.', { type: 'error' });
      return;
    }
  }
  const body = document.createElement('div');
  let form = null;
  const dialog = modal({
    title: editing ? 'Editar tema' : 'Novo tema de redação',
    subtitle: editing ? theme.title : 'O aluno escolhe entre os temas ativos ao escrever uma redação.',
    size: 'lg',
    body,
    actions: [],
    onClose: () => {
      if (form) form.destroy();
    },
  });

  form = buildForm(body, themeFields(), {
    values: editing
      ? {
        title: theme.title,
        exam_id: theme.exam_id,
        year: theme.year,
        prompt_text: theme.prompt_text,
        support_texts: theme.support_texts,
        source: theme.source,
        active: theme.active,
      }
      : { active: true },
    submitLabel: editing ? 'Salvar tema' : 'Cadastrar tema',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    autofocus: true,
    async onSubmit(values) {
      if (editing) await api.put(`/api/admin/essays/themes/${theme.id}`, values);
      else await api.post('/api/admin/essays/themes', values);
      toast(editing ? 'Tema salvo.' : 'Tema cadastrado.', { type: 'success' });
      dialog.close();
      if (state.themesTable) state.themesTable.reload();
    },
  });
}

async function removeTheme(row, table) {
  const ok = await confirm({
    title: 'Excluir tema',
    message: `"${truncate(row.title, 100)}" será excluído. Temas já usados em redações não podem ser excluídos — desative-os.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/essays/themes/${row.id}`);
    toast('Tema excluído.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível excluir o tema.', { type: 'error' });
  }
}

async function toggleTheme(row, table) {
  try {
    await api.put(`/api/admin/essays/themes/${row.id}`, { active: !row.active });
    toast(row.active ? 'Tema desativado.' : 'Tema ativado.', { type: 'success' });
    table.reload();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar a situação do tema.', { type: 'error' });
  }
}

function mountThemesTab(container) {
  render(
    container,
    html`
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('lightbulb')}<span>Temas de redação</span></h2>
          <button type="button" class="btn btn-primary btn-sm" data-act="new-theme">${icon('plus')}<span>Novo tema</span></button>
        </div>
        <div class="card-body" data-themes-table></div>
      </section>`
  );

  state.themesTable = mountTable(qs('[data-themes-table]', container), {
    columns: [
      { key: 'title', label: 'Tema', sortable: true, render: (row) => html`<div class="es-theme"><span class="es-theme-title">${row.title}</span>${row.source ? html`<span class="es-theme-source">${row.source}</span>` : ''}</div>` },
      { key: 'exam_name', label: 'Prova', nowrap: true, render: (row) => (row.exam_id ? badge(row.exam_short_name || row.exam_name, 'blue') : html`<span class="dt-muted">Todas</span>`) },
      { key: 'year', label: 'Ano', sortable: true, align: 'right', nowrap: true },
      { key: 'generated_by_ai', label: 'Origem', nowrap: true, render: (row) => (row.generated_by_ai ? badge('Gerado por IA', 'gray', { icon: 'bot' }) : badge('Cadastrado', 'gray')) },
      { key: 'essays_count', label: 'Redações', align: 'right', nowrap: true, render: (row) => fmtNumber(row.essays_count || 0, { digits: 0 }) },
      { key: 'active', label: 'Situação', nowrap: true, render: (row) => (row.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')) },
    ],
    fetch: (page, query) => api.get('/api/admin/essays/themes', { query }),
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar pelo título do tema',
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhum tema cadastrado',
    rowKey: 'id',
    filters: [
      { key: 'exam_id', label: 'Prova', options: state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      { key: 'origin', label: 'Origem', options: [{ value: 'manual', label: 'Cadastrados' }, { value: 'ai', label: 'Gerados por IA' }] },
      { key: 'status', label: 'Situação', options: [{ value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }] },
    ],
    onRowClick: (row) => openThemeForm(row),
    rowActions: [
      { label: 'Editar tema', icon: 'square-pen', onClick: (row) => openThemeForm(row) },
      { label: 'Ativar ou desativar', icon: 'toggle-right', onClick: (row, table) => toggleTheme(row, table) },
      { label: 'Excluir tema', icon: 'trash-2', danger: true, onClick: (row, table) => removeTheme(row, table) },
    ],
  });
}

// ---------------------------------------------------------------------
// Aba: critérios por prova
// ---------------------------------------------------------------------
function criteriaTabView() {
  const rows = state.criteria;
  if (!rows.length) {
    return html`<section class="card"><div class="card-body">${emptyState({
      icon: 'graduation-cap',
      title: 'Nenhum vestibular cadastrado',
      text: 'Cadastre um vestibular para definir a matriz de correção da redação.',
      action: { label: 'Ir para Vestibulares', href: '/admin/vestibulares', icon: 'arrow-right' },
      size: 'sm',
    })}</div></section>`;
  }
  return html`
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('list-checks')}<span>Critérios de correção por prova</span></h2>
        <span class="hint">A matriz é editada na aba Redação de cada vestibular.</span>
      </div>
      <div class="card-body">
        <div class="es-criteria">
          ${rows.map((row) => html`
            <article class="es-criteria-card ${row.criteria_count ? '' : 'is-empty'}">
              <header class="es-criteria-head">
                <div>
                  <h3 class="es-criteria-title">${row.exam.name}</h3>
                  <p class="es-criteria-meta">${row.exam.board || 'Sem banca definida'} · escala ${fmtNumber(Number(row.max_score) || 0, { digits: 0 })} pontos</p>
                </div>
                ${row.exam.has_essay ? '' : badge('Prova sem redação', 'gray')}
              </header>
              ${row.criteria_count ? html`
                <ul class="es-criteria-list">
                  ${row.criteria.map((criterion) => html`
                    <li><span class="es-criterion-name">${criterion.name}</span><span class="es-criterion-max">${fmtNumber(Number(criterion.max) || 0, { digits: 0 })}</span></li>`)}
                </ul>`
                : html`<p class="hint">Nenhum critério cadastrado — a correção por IA usa a matriz padrão até você definir os critérios desta prova.</p>`}
              <footer class="es-criteria-foot">
                <a class="btn btn-secondary btn-sm" href="/admin/vestibulares/${row.exam.id}?aba=redacao">
                  ${icon('square-pen', { size: 15 })}<span>${row.criteria_count ? 'Editar critérios' : 'Definir critérios'}</span>
                </a>
              </footer>
            </article>`)}
        </div>
      </div>
    </section>`;
}

async function loadCriteria() {
  if (state.criteriaLoaded) return;
  const results = [];
  for (const exam of state.exams) {
    try {
      const data = await api.get(`/api/admin/essays/criteria/${exam.id}`);
      results.push({
        exam: data.exam || exam,
        max_score: data.max_score,
        criteria: Array.isArray(data.criteria) ? data.criteria : [],
        criteria_count: Array.isArray(data.criteria) ? data.criteria.length : 0,
      });
    } catch {
      results.push({ exam, max_score: exam.essay_max_score, criteria: [], criteria_count: 0 });
    }
  }
  state.criteria = results;
  state.criteriaLoaded = true;
}

// ---------------------------------------------------------------------
// Aba: redações corrigidas
// ---------------------------------------------------------------------
function correctionView(essay) {
  const correction = essay.correction || {};
  const criteria = Array.isArray(correction.criteria) ? correction.criteria : [];
  const maxScore = Number(essay.max_score) || 0;
  const score = Number(essay.score);
  const lists = [
    ['Pontos fortes', correction.strengths, 'circle-check', 'green'],
    ['Pontos a melhorar', correction.weaknesses, 'triangle-alert', 'orange'],
    ['Sugestões', correction.suggestions, 'lightbulb', 'blue'],
  ].filter(([, items]) => Array.isArray(items) && items.length);
  const grammar = Array.isArray(correction.grammar_errors) ? correction.grammar_errors : [];

  return html`
    <div class="es-correction">
      <header class="es-correction-head">
        <div>
          <span class="eyebrow">${essay.exam_name || 'Sem prova'}</span>
          <h3 class="es-correction-title">${essay.theme_title}</h3>
          <p class="es-correction-meta">
            ${essay.user_name} · ${essay.user_email} ·
            ${essay.corrected_at ? `corrigida em ${fmtDateTime(essay.corrected_at)}` : essay.submitted_at ? `enviada em ${fmtDateTime(essay.submitted_at)}` : fmtDateTime(essay.created_at)} ·
            ${fmtNumber(essay.word_count || 0, { digits: 0 })} palavras
          </p>
        </div>
        <div class="es-correction-score">
          <span class="es-score-value">${Number.isFinite(score) ? fmtScore(score) : '—'}</span>
          <span class="es-score-max">de ${fmtNumber(maxScore, { digits: 0 })}</span>
        </div>
      </header>

      ${essay.status === 'failed' ? html`<div class="alert alert-danger" role="alert">${icon('circle-alert')}<div class="alert-body"><div class="alert-title">A correção falhou</div><div class="alert-text">${essay.error_message || 'A IA não conseguiu concluir a correção.'}</div></div></div>` : ''}
      ${correction.summary ? html`<div class="es-summary md">${raw(md(correction.summary))}</div>` : ''}

      ${criteria.length ? html`
        <div class="es-criteria-scores">
          ${criteria.map((criterion) => {
            const value = Number(criterion.score) || 0;
            const max = Number(criterion.max) || 0;
            return html`
              <div class="es-criterion-score">
                <div class="es-criterion-row">
                  <span class="es-criterion-name">${criterion.name}</span>
                  <span class="es-criterion-value">${fmtScore(value)} / ${fmtNumber(max, { digits: 0 })}</span>
                </div>
                ${progressBar(max ? (100 * value) / max : 0, { color: 'success', size: 'sm' })}
                ${criterion.comment ? html`<p class="es-criterion-comment">${criterion.comment}</p>` : ''}
              </div>`;
          })}
        </div>` : ''}

      ${lists.map(([title, items, iconName]) => html`
        <section class="es-block">
          <h4 class="es-block-title">${icon(iconName, { size: 16 })}<span>${title}</span></h4>
          <ul class="es-list">${items.map((item) => html`<li>${item}</li>`)}</ul>
        </section>`)}

      ${grammar.length ? html`
        <section class="es-block">
          <h4 class="es-block-title">${icon('pencil', { size: 16 })}<span>Correções de escrita</span></h4>
          <div class="table-wrap">
            <table class="table table-sm">
              <thead><tr><th scope="col">Trecho</th><th scope="col">Correção</th><th scope="col">Por quê</th></tr></thead>
              <tbody>
                ${grammar.map((item) => html`<tr><td>${item.excerpt || '—'}</td><td>${item.fix || '—'}</td><td class="text-2">${item.explanation || '—'}</td></tr>`)}
              </tbody>
            </table>
          </div>
        </section>` : ''}

      <section class="es-block">
        <h4 class="es-block-title">${icon('file-text', { size: 16 })}<span>Texto do aluno</span></h4>
        <div class="es-essay-text">${essay.content || 'Sem conteúdo.'}</div>
      </section>
    </div>`;
}

async function openCorrection(row) {
  const body = document.createElement('div');
  render(body, skeleton('text'));
  const dialog = modal({
    title: 'Correção da redação',
    subtitle: row.user_name,
    size: 'xl',
    body,
    actions: [{ label: 'Fechar', variant: 'secondary' }],
  });
  try {
    const essay = await api.get(`/api/admin/essays/submissions/${row.id}`);
    render(body, correctionView(essay));
  } catch (err) {
    render(body, html`<div class="alert alert-danger" role="alert">${icon('circle-alert')}<div class="alert-body"><div class="alert-text">${(err && err.message) || 'Não foi possível carregar a correção.'}</div></div></div>`);
  }
  return dialog;
}

function mountSubmissionsTab(container) {
  render(
    container,
    html`
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('pen-line')}<span>Redações enviadas</span></h2>
          <span class="hint">Clique em uma linha para ver a correção completa.</span>
        </div>
        <div class="card-body" data-submissions-table></div>
      </section>`
  );

  state.submissionsTable = mountTable(qs('[data-submissions-table]', container), {
    columns: [
      { key: 'user_name', label: 'Aluno', sortable: true, render: (row) => html`<div class="es-student"><span>${row.user_name}</span><span class="es-student-mail">${row.user_email}</span></div>` },
      { key: 'exam_name', label: 'Prova', nowrap: true, render: (row) => (row.exam_id ? badge(row.exam_short_name || row.exam_name, 'blue') : html`<span class="dt-muted">—</span>`) },
      { key: 'theme_title', label: 'Tema', render: (row) => truncate(row.theme_title || '—', 70) },
      {
        key: 'score',
        label: 'Nota',
        sortable: true,
        align: 'right',
        nowrap: true,
        render: (row) => (row.score == null
          ? html`<span class="dt-muted">—</span>`
          : html`<strong class="es-score">${fmtScore(row.score)}</strong><span class="hint"> / ${fmtNumber(Number(row.max_score) || 0, { digits: 0 })}</span>`),
      },
      { key: 'submitted_at', label: 'Envio', sortable: true, nowrap: true, render: (row) => fmtDateTime(row.submitted_at || row.created_at) },
      { key: 'status', label: 'Situação', nowrap: true, render: (row) => badge((STATUS[row.status] || {}).label || row.status, (STATUS[row.status] || {}).tone || 'gray') },
    ],
    fetch: (page, query) => api.get('/api/admin/essays/submissions', { query }),
    pageSize: 20,
    search: true,
    searchPlaceholder: 'Buscar por aluno, e-mail ou tema',
    sort: { key: 'created_at', dir: 'desc' },
    emptyText: 'Nenhuma redação enviada',
    rowKey: 'id',
    filters: [
      { key: 'exam_id', label: 'Prova', options: state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })) },
      {
        key: 'status',
        label: 'Situação',
        options: [
          { value: 'submitted', label: 'Aguardando correção' },
          { value: 'corrected', label: 'Corrigidas' },
          { value: 'failed', label: 'Com falha' },
        ],
      },
      { key: 'from', label: 'De', type: 'date' },
      { key: 'to', label: 'Até', type: 'date' },
    ],
    onRowClick: (row) => openCorrection(row),
    rowActions: [
      { label: 'Ver correção', icon: 'eye', onClick: (row) => openCorrection(row) },
      { label: 'Abrir o aluno', icon: 'user', onClick: (row) => state.ctx.navigate(`/admin/alunos/${row.user_id}`) },
    ],
  });
}

// ---------------------------------------------------------------------
// Estrutura da página
// ---------------------------------------------------------------------
function destroyTables() {
  if (state.themesTable) {
    state.themesTable.destroy();
    state.themesTable = null;
  }
  if (state.submissionsTable) {
    state.submissionsTable.destroy();
    state.submissionsTable = null;
  }
}

async function paintTab() {
  const container = qs('[data-tab-content]', state.ctx.el);
  if (!container) return;
  destroyTables();
  if (state.tab === 'temas') {
    mountThemesTab(container);
    return;
  }
  if (state.tab === 'corrigidas') {
    mountSubmissionsTab(container);
    return;
  }
  render(container, skeleton('cards', 3));
  await loadCriteria();
  if (!state || state.tab !== 'criterios') return;
  render(container, criteriaTabView());
}

function view() {
  return html`
    ${pageHeader({
      title: 'Redação',
      subtitle: 'Temas oferecidos ao aluno, matriz de correção por prova e as redações já enviadas.',
      actions: html`<a class="btn btn-secondary" href="/admin/vestibulares">${icon('graduation-cap')}<span>Vestibulares</span></a>`,
    })}
    <div class="es-tabs" data-tabs></div>
    <div data-tab-content></div>`;
}

async function renderEssaysPage(ctx) {
  ctx.setTitle('Redação');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-essays');
  state = {
    ctx,
    token,
    exams: [],
    criteria: [],
    criteriaLoaded: false,
    themesTable: null,
    submissionsTable: null,
    tab: TABS.some((tab) => tab.id === (ctx.query || {}).aba) ? ctx.query.aba : 'temas',
    off: [],
  };

  try {
    const exams = await api.get('/api/admin/exams').then((data) => (Array.isArray(data) ? data : data.items || []));
    if (!state || state.token !== token) return;
    state.exams = exams;
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Redação' })}
        ${errorState({ title: 'Não foi possível carregar a área de redação', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-essays' })}`
    );
    const button = qs('[data-action="reload-essays"]', ctx.el);
    if (button) button.addEventListener('click', () => renderEssaysPage(ctx));
    return;
  }

  render(ctx.el, view());
  tabs(qs('[data-tabs]', ctx.el), TABS, (id) => {
    state.tab = id;
    paintTab();
  }, { active: state.tab });

  state.off.push(
    on(ctx.el, 'click', '[data-act="new-theme"]', (event) => {
      event.preventDefault();
      openThemeForm(null);
    })
  );

  await paintTab();
}

export default renderEssaysPage;

export function unmount() {
  if (!state) return;
  destroyTables();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

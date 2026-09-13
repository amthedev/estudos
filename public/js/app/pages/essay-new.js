// =====================================================================
// Foco Elite — Nova redação (ARCHITECTURE §6.4)
//
// Fluxo em três passos:
//   1. Prova — com o painel "Como sua redação será avaliada" (GET /api/essays/criteria)
//   2. Tema  — temas cadastrados (GET /api/essays/themes), geração por IA
//              (POST /api/essays/themes/generate) ou tema livre
//   3. Editor — textarea com contador de palavras e estimativa de linhas,
//              rascunho salvo automaticamente (POST /api/essays + PUT /api/essays/:id)
//              e envio para correção (POST /api/essays/:id/submit, até 90 segundos).
//
// Aceita ?essay_id= para retomar um rascunho e ?theme_id= para já vir com o tema escolhido.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, render, toast, confirm, qs, qsa, on, debounce,
  pageHeader, emptyState, errorState, skeleton, badge, alertBox, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtScore, fmtNumber, pluralize } from '../../core/format.js';

const FREE_THEME = '__livre__';
const AUTOSAVE_DELAY = 1500;
/** Estimativa de caracteres por linha da folha de redação (usada só como referência). */
const CHARS_PER_LINE = 85;
const MAX_CONTENT_CHARS = 6000;

const STEPS = [
  { id: 1, label: 'Prova' },
  { id: 2, label: 'Tema' },
  { id: 3, label: 'Escrever' },
];

/** Mensagens que se alternam durante a correção, para a espera não parecer travada. */
const WAITING_MESSAGES = [
  'Lendo sua redação do começo ao fim…',
  'Conferindo se o texto atende ao tema e ao gênero…',
  'Avaliando a argumentação e o repertório…',
  'Analisando coesão, coerência e estrutura…',
  'Montando os comentários de cada critério…',
];

let state = null;

const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;
const estimateLines = (text) => Math.ceil(String(text || '').length / CHARS_PER_LINE);

/** Título do tema escolhido no momento (tema do banco ou tema livre). */
function currentThemeTitle() {
  if (state.themeId === FREE_THEME) return String(state.freeTitle || '').trim();
  const theme = state.themes.find((row) => row.id === state.themeId);
  if (theme) return theme.title;
  // rascunho retomado antes de a lista de temas chegar
  return String(state.themeTitle || '').trim();
}

function currentTheme() {
  if (!state.themeId || state.themeId === FREE_THEME) return null;
  return state.themes.find((row) => row.id === state.themeId) || null;
}

function currentExamLabel() {
  const exam = state.exams.find((row) => row.id === state.examId);
  return exam ? exam.short_name || exam.name : 'Redação';
}

const aiAvailable = () => Boolean(state && state.aiStatus && state.aiStatus.available);

function paperLineCount() {
  const configured = Number(state && state.criteria && state.criteria.max_lines);
  if (!Number.isFinite(configured) || configured <= 0) return 30;
  return Math.min(40, Math.max(20, Math.round(configured)));
}

// ---------------------------------------------------------------------
// Estrutura da página
// ---------------------------------------------------------------------

function stepsBar() {
  return html`
    <nav class="steps ess-steps" aria-label="Etapas da nova redação">
      ${STEPS.map((step) => {
        const status = state.step === step.id ? 'active' : state.step > step.id ? 'done' : '';
        return html`
          <div class="step ${status}" ${state.step === step.id ? raw('aria-current="step"') : ''}>
            <span class="step-number">${state.step > step.id ? icon('check', { size: 15 }) : String(step.id)}</span>
            <span class="step-label">${step.label}</span>
          </div>`;
      })}
    </nav>`;
}

// ---- passo 1: prova --------------------------------------------------

function criteriaPanel() {
  const set = state.criteria;
  if (state.criteriaError) {
    return html`<aside class="card ess-criteria">${errorState({ title: 'Não foi possível carregar os critérios', message: state.criteriaError.message, retry: 'reload-criteria' })}</aside>`;
  }
  if (!set) {
    return html`<aside class="card ess-criteria"><div class="card-body">${skeleton('text')}</div></aside>`;
  }
  const lines = set.min_lines || set.max_lines
    ? set.min_lines && set.max_lines
      ? `Entre ${set.min_lines} e ${set.max_lines} linhas.`
      : set.min_lines
        ? `Mínimo de ${set.min_lines} linhas.`
        : `Máximo de ${set.max_lines} linhas.`
    : '';

  return html`
    <aside class="card ess-criteria">
      <div class="card-header">
        <h2 class="card-title">${icon('list-checks')}<span>Como sua redação será avaliada</span></h2>
      </div>
      <div class="card-body">
        <p class="ess-criteria-sub">${set.name} · até ${fmtScore(set.max_score)} pontos</p>
        <p class="hint ess-criteria-genre">${set.genre}${lines ? ` ${lines}` : ''}</p>
        <ul class="ess-criteria-list">
          ${(set.criteria || []).map((item) => html`
            <li class="ess-criteria-item">
              <div class="ess-criteria-top">
                <span class="ess-criteria-name">${item.name}</span>
                <span class="ess-criteria-max">até ${fmtScore(item.max)}</span>
              </div>
              ${item.description ? html`<p class="ess-criteria-desc">${item.description}</p>` : ''}
            </li>`)}
        </ul>
        ${set.requires_intervention
          ? html`<p class="hint ess-criteria-note">${icon('info', { size: 14 })}<span>Esta prova exige proposta de intervenção: ela será analisada à parte na correção.</span></p>`
          : ''}
        ${set.generic
          ? alertBox({ type: 'info', text: 'Esta prova ainda não tem critérios próprios cadastrados. A correção usará um modelo geral de texto dissertativo-argumentativo.' })
          : ''}
      </div>
    </aside>`;
}

function stepExam() {
  const exams = state.exams.filter((exam) => exam.has_essay !== false);
  if (!exams.length) {
    return emptyState({
      icon: 'graduation-cap',
      title: 'Nenhuma prova com redação disponível',
      text: 'Confira a prova escolhida no seu perfil ou fale com a equipe do Foco de Elite.',
      action: { label: 'Ir para o perfil', href: '/app/perfil', icon: 'user' },
    });
  }
  return html`
    <div class="ess-columns">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('graduation-cap')}<span>Para qual prova é esta redação?</span></h2>
        </div>
        <div class="card-body">
          <p class="hint mb-4">Os critérios de correção mudam conforme a banca. A prova do seu perfil já vem selecionada.</p>
          <div class="choice-grid">
            ${exams.map((exam) => html`
              <label class="choice ${state.examId === exam.id ? 'active' : ''}">
                <input type="radio" name="ess-exam" value="${exam.id}" class="sr-only" ${state.examId === exam.id ? raw('checked') : ''}>
                <span class="choice-icon">${icon('graduation-cap')}</span>
                <span class="choice-body">
                  <span class="choice-title">${exam.name}</span>
                  <span class="choice-desc">${exam.board ? `Banca ${exam.board}` : 'Redação avaliada por critérios próprios'}</span>
                </span>
              </label>`)}
          </div>
        </div>
        <div class="card-footer ess-actions">
          <a class="btn btn-ghost" href="/app/redacao">${icon('arrow-left')}<span>Cancelar</span></a>
          <button type="button" class="btn btn-primary" data-action="to-step-2" ${state.examId ? '' : raw('disabled')}>
            <span>Escolher o tema</span>${icon('arrow-right')}
          </button>
        </div>
      </section>
      ${criteriaPanel()}
    </div>`;
}

// ---- passo 2: tema ---------------------------------------------------

function themeCard(theme) {
  const selected = state.themeId === theme.id;
  return html`
    <article class="ess-theme ${selected ? 'is-selected' : ''}" data-theme-card="${theme.id}">
      <label class="ess-theme-head">
        <input type="radio" name="ess-theme" value="${theme.id}" class="sr-only" ${selected ? raw('checked') : ''}>
        <span class="ess-theme-check" aria-hidden="true">${icon('check', { size: 14 })}</span>
        <span class="ess-theme-main">
          <span class="ess-theme-title">${theme.title}</span>
          <span class="ess-theme-tags">
            ${theme.generated_by_ai ? badge('Gerado por IA', 'blue', { icon: 'sparkles' }) : ''}
            ${theme.year ? badge(String(theme.year), 'gray') : ''}
            ${theme.source ? html`<span class="ess-theme-source">${theme.source}</span>` : ''}
          </span>
        </span>
      </label>
      ${theme.prompt_text || theme.support_texts
        ? html`
          <details class="ess-theme-more" ${selected && theme.generated_by_ai ? raw('open') : ''}>
            <summary>Ver proposta e textos motivadores</summary>
            <div class="ess-theme-body">
              ${theme.prompt_text ? html`<h4 class="ess-theme-sub">Proposta</h4><div class="prose prose-sm">${md(theme.prompt_text)}</div>` : ''}
              ${theme.support_texts ? html`<h4 class="ess-theme-sub">Textos motivadores</h4><div class="prose prose-sm">${md(theme.support_texts)}</div>` : ''}
            </div>
          </details>`
        : ''}
    </article>`;
}

function stepTheme() {
  const freeSelected = state.themeId === FREE_THEME;
  return html`
    <div class="ess-columns">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">${icon('lightbulb')}<span>Sobre o que você vai escrever?</span></h2>
          <button type="button" class="btn btn-secondary btn-sm" data-action="generate-theme" ${aiAvailable() ? '' : raw('disabled')}>
            ${icon('sparkles')}<span>Gerar tema com IA</span>
          </button>
        </div>
        <div class="card-body">
          ${!aiAvailable()
            ? alertBox({ type: 'warning', title: 'A geração de temas por IA ainda não foi ativada pela equipe', text: 'Você pode escolher um dos temas cadastrados ou escrever sobre um tema livre.' })
            : ''}
          ${state.themesError
            ? errorState({ title: 'Não foi possível carregar os temas', message: state.themesError.message, retry: 'reload-themes' })
            : state.loadingThemes
              ? skeleton('list', 4)
              : html`
                <div class="ess-themes" data-ess-themes>
                  ${state.themes.length
                    ? state.themes.map(themeCard)
                    : html`<p class="hint">Nenhum tema cadastrado para esta prova ainda. Gere um tema com IA ou escreva sobre um tema livre.</p>`}
                  <article class="ess-theme ess-theme-free ${freeSelected ? 'is-selected' : ''}" data-theme-card="${FREE_THEME}">
                    <label class="ess-theme-head">
                      <input type="radio" name="ess-theme" value="${FREE_THEME}" class="sr-only" ${freeSelected ? raw('checked') : ''}>
                      <span class="ess-theme-check" aria-hidden="true">${icon('check', { size: 14 })}</span>
                      <span class="ess-theme-main">
                        <span class="ess-theme-title">Tema livre</span>
                        <span class="ess-theme-tags"><span class="ess-theme-source">Escreva o enunciado que você quer treinar</span></span>
                      </span>
                    </label>
                    <div class="ess-theme-body ess-free-field">
                      <label class="label" for="ess-free-title">Título do tema</label>
                      <input class="input" id="ess-free-title" data-ess-free-title maxlength="240"
                             placeholder="Ex.: Os desafios da mobilidade urbana nas grandes cidades brasileiras"
                             value="${state.freeTitle || ''}">
                      <p class="hint">Escreva o tema como ele apareceria na prova, com pelo menos três caracteres.</p>
                    </div>
                  </article>
                </div>`}
        </div>
        <div class="card-footer ess-actions">
          <button type="button" class="btn btn-ghost" data-action="to-step-1">${icon('arrow-left')}<span>Voltar</span></button>
          <button type="button" class="btn btn-primary" data-action="to-step-3">
            <span>Começar a escrever</span>${icon('arrow-right')}
          </button>
        </div>
      </section>
      ${criteriaPanel()}
    </div>`;
}

// ---- passo 3: editor -------------------------------------------------

function saveIndicator() {
  const map = {
    idle: { text: 'Rascunho salvo automaticamente', icon: 'save', tone: '' },
    saving: { text: 'Salvando…', icon: 'loader-circle', tone: 'is-saving' },
    saved: { text: 'Rascunho salvo', icon: 'circle-check', tone: 'is-saved' },
    error: { text: 'Não foi possível salvar', icon: 'circle-alert', tone: 'is-error' },
  };
  const current = map[state.saveState] || map.idle;
  return html`<span class="ess-save ${current.tone}" data-ess-save>${icon(current.icon, { size: 14 })}<span>${current.text}</span></span>`;
}

function counterBlock() {
  const words = countWords(state.content);
  const lines = estimateLines(state.content);
  const set = state.criteria;
  const min = set && set.min_lines ? Number(set.min_lines) : 0;
  const max = set && set.max_lines ? Number(set.max_lines) : 0;
  let tone = '';
  if (max && lines > max) tone = 'is-over';
  else if (min && lines >= min) tone = 'is-ok';
  return html`
    <div class="ess-counter ${tone}" data-ess-counter>
      <span><strong>${fmtNumber(words, { digits: 0 })}</strong> ${pluralize(words, 'palavra', 'palavras', { withNumber: false })}</span>
      <span class="ess-counter-sep" aria-hidden="true">·</span>
      <span><strong>${fmtNumber(lines, { digits: 0 })}</strong> ${pluralize(lines, 'linha', 'linhas', { withNumber: false })} (estimativa)</span>
      ${min || max
        ? html`<span class="ess-counter-target">${min && max ? `Alvo: ${min} a ${max} linhas` : min ? `Mínimo: ${min} linhas` : `Máximo: ${max} linhas`}</span>`
        : ''}
    </div>`;
}

function stepEditor() {
  const theme = currentTheme();
  const title = currentThemeTitle();
  const lineCount = paperLineCount();
  return html`
    <div class="ess-editor">
      <section class="card ess-editor-card">
        <div class="card-header ess-editor-head">
          <div class="ess-editor-theme">
            <span class="eyebrow">Tema</span>
            <h2 class="ess-editor-title">${title}</h2>
          </div>
          ${saveIndicator()}
        </div>
        ${theme && (theme.prompt_text || theme.support_texts)
          ? html`
            <details class="ess-proposal">
              <summary>${icon('file-text', { size: 15 })}<span>Ver a proposta e os textos motivadores</span></summary>
              <div class="ess-proposal-body">
                ${theme.prompt_text ? html`<h4 class="ess-theme-sub">Proposta</h4><div class="prose prose-sm">${md(theme.prompt_text)}</div>` : ''}
                ${theme.support_texts ? html`<h4 class="ess-theme-sub">Textos motivadores</h4><div class="prose prose-sm">${md(theme.support_texts)}</div>` : ''}
              </div>
            </details>`
          : ''}
        <div class="card-body ess-editor-body">
          <label class="sr-only" for="ess-content">Texto da sua redação</label>
          <div class="ess-paper-shell" style="--essay-line-count:${lineCount}">
            <div class="ess-paper">
              <div class="ess-paper-head">
                <div class="ess-paper-brand">
                  <img src="/assets/brand/foco-elite-favicon.png" alt="" width="34" height="34">
                  <span>
                    <small>Foco de Elite</small>
                    <strong>Caderno de redação</strong>
                  </span>
                </div>
                <div class="ess-paper-meta" aria-label="Informações da folha">
                  <span>${currentExamLabel()}</span>
                  <span>${lineCount} linhas</span>
                </div>
              </div>
              <div class="ess-paper-writing">
                <div class="ess-paper-numbers" aria-hidden="true">
                  ${Array.from({ length: lineCount }, (_, index) => html`<span>${index + 1}</span>`)}
                </div>
                <textarea class="ess-textarea" id="ess-content" data-ess-content maxlength="${MAX_CONTENT_CHARS}"
                          spellcheck="true" placeholder="Escreva sua redação aqui…">${state.content || ''}</textarea>
              </div>
              <div class="ess-paper-footer">
                ${counterBlock()}
              </div>
            </div>
          </div>
        </div>
        <div class="card-footer ess-actions">
          <button type="button" class="btn btn-ghost" data-action="to-step-2">${icon('arrow-left')}<span>Trocar o tema</span></button>
          <div class="ess-actions-end">
            <a class="btn btn-secondary" href="/app/redacao">${icon('save')}<span>Salvar e sair</span></a>
            <button type="button" class="btn btn-primary" data-action="submit" ${aiAvailable() ? '' : raw('disabled')}>
              ${icon('send')}<span>Enviar para correção</span>
            </button>
          </div>
        </div>
      </section>
      ${!aiAvailable()
        ? alertBox({ type: 'warning', title: 'A correção por IA ainda não foi ativada pela equipe', text: 'Seu texto continua salvo como rascunho e poderá ser enviado assim que a integração for configurada.' })
        : ''}
    </div>`;
}

/** Tela de espera da correção (o POST de submit pode levar até 90 segundos). */
function waitingScreen() {
  return html`
    <section class="card ess-waiting" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <h2 class="ess-waiting-title">Corrigindo sua redação…</h2>
      <p class="ess-waiting-text" data-ess-waiting-text>${WAITING_MESSAGES[0]}</p>
      <p class="hint">A correção completa costuma levar até um minuto e meio. Mantenha esta tela aberta.</p>
      <div class="ess-waiting-bar"><span></span></div>
    </section>`;
}

function submitError(err) {
  const id = state.essay ? state.essay.id : '';
  return html`
    <section class="card ess-waiting">
      <span class="icon-box icon-box-lg red">${icon('triangle-alert')}</span>
      <h2 class="ess-waiting-title">Não foi possível concluir a correção</h2>
      <p class="ess-waiting-text">${(err && err.message) || 'O serviço de correção não respondeu.'}</p>
      <p class="hint">Seu texto está guardado por inteiro. Você pode reenviar agora ou voltar depois pela lista de redações.</p>
      <div class="ess-state-actions">
        ${id ? html`<a class="btn btn-ghost" href="/app/redacao/${id}">${icon('file-text')}<span>Ver a redação</span></a>` : ''}
        <button type="button" class="btn btn-primary" data-action="retry-submit">${icon('refresh-cw')}<span>Tentar novamente</span></button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------

function paint() {
  const content = qs('[data-ess-step]', state.el);
  if (!content) return;

  if (state.fatalError) {
    render(content, errorState({ title: 'Não foi possível preparar a nova redação', message: state.fatalError.message, retry: 'reload-new' }));
    return;
  }
  if (state.loading) {
    render(content, skeleton('form', 4));
    return;
  }
  if (state.submitting) {
    render(content, waitingScreen());
    startWaitingMessages();
    return;
  }
  if (state.submitError) {
    render(content, submitError(state.submitError));
    return;
  }

  const stepsEl = qs('[data-ess-steps]', state.el);
  if (stepsEl) render(stepsEl, stepsBar());

  if (state.step === 1) render(content, stepExam());
  else if (state.step === 2) render(content, stepTheme());
  else render(content, stepEditor());

  if (state.step === 3) {
    const textarea = qs('[data-ess-content]', state.el);
    if (textarea) textarea.focus({ preventScroll: true });
  }
}

function stopWaitingMessages() {
  if (state && state.waitingTimer) {
    clearInterval(state.waitingTimer);
    state.waitingTimer = null;
  }
}

function startWaitingMessages() {
  stopWaitingMessages();
  let index = 0;
  state.waitingTimer = setInterval(() => {
    if (!state) return;
    index = (index + 1) % WAITING_MESSAGES.length;
    const el = qs('[data-ess-waiting-text]', state.el);
    if (el) el.textContent = WAITING_MESSAGES[index];
  }, 7000);
}

function repaintCounter() {
  const counter = qs('[data-ess-counter]', state.el);
  if (!counter) return;
  const wrapper = document.createElement('div');
  render(wrapper, counterBlock());
  const fresh = wrapper.firstElementChild;
  if (fresh) counter.replaceWith(fresh);
}

function repaintSaveIndicator() {
  const el = qs('[data-ess-save]', state.el);
  if (!el) return;
  const wrapper = document.createElement('div');
  render(wrapper, saveIndicator());
  const fresh = wrapper.firstElementChild;
  if (fresh) el.replaceWith(fresh);
}

// ---------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------

async function loadCriteria() {
  const token = state.token;
  state.criteria = null;
  state.criteriaError = null;
  paint();
  try {
    const set = await api.get('/api/essays/criteria', { query: { exam_id: state.examId } });
    if (!state || state.token !== token) return;
    state.criteria = set;
  } catch (err) {
    if (!state || state.token !== token) return;
    state.criteriaError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  paint();
}

async function loadThemes() {
  const token = state.token;
  state.loadingThemes = true;
  state.themesError = null;
  paint();
  try {
    const rows = await api.get('/api/essays/themes', { query: { exam_id: state.examId } });
    if (!state || state.token !== token) return;
    state.themes = Array.isArray(rows) ? rows : [];
    if (state.step !== 3 && state.themeId && state.themeId !== FREE_THEME && !state.themes.some((row) => row.id === state.themeId)) {
      state.themeId = null;
    }
  } catch (err) {
    if (!state || state.token !== token) return;
    state.themesError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  state.loadingThemes = false;
  paint();
}

async function generateTheme(button) {
  if (!state || state.generating) return;
  state.generating = true;
  if (button) setLoading(button, true);
  try {
    const theme = await api.post('/api/essays/themes/generate', { exam_id: state.examId });
    if (!state) return;
    state.themes = [theme, ...state.themes.filter((row) => row.id !== theme.id)];
    state.themeId = theme.id;
    toast('Tema, proposta e textos motivadores gerados. Leia tudo antes de escrever.', { type: 'success' });
    paint();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível gerar um tema agora.', { type: 'error' });
  } finally {
    if (state) state.generating = false;
    if (button) setLoading(button, false);
  }
}

/** Cria o rascunho na primeira entrada no editor, ou atualiza o tema se ele mudou. */
async function ensureDraft() {
  const themeId = state.themeId === FREE_THEME ? null : state.themeId;
  const themeTitle = currentThemeTitle();

  if (state.essay) {
    const sameTheme = (state.essay.theme_id || null) === themeId && state.essay.theme_title === themeTitle;
    if (sameTheme) return state.essay;
    const payload = themeId ? { theme_id: themeId } : { theme_id: null, theme_title: themeTitle };
    state.essay = await api.put(`/api/essays/${encodeURIComponent(state.essay.id)}`, payload);
    state.themeTitle = state.essay.theme_title || '';
    return state.essay;
  }

  const payload = { exam_id: state.examId, content: state.content || '' };
  if (themeId) payload.theme_id = themeId;
  else payload.theme_title = themeTitle;
  state.essay = await api.post('/api/essays', payload);
  state.themeTitle = state.essay.theme_title || '';
  state.savedContent = state.essay.content || '';
  return state.essay;
}

async function saveDraft() {
  if (!state || !state.essay || state.submitting || state.submitted) return;
  const token = state.token;
  const content = state.content || '';
  if (content === state.savedContent) {
    state.saveState = 'saved';
    repaintSaveIndicator();
    return;
  }
  state.saveState = 'saving';
  repaintSaveIndicator();
  try {
    await api.put(`/api/essays/${encodeURIComponent(state.essay.id)}`, { content });
    if (!state || state.token !== token) return;
    state.savedContent = content;
    state.saveState = 'saved';
  } catch (err) {
    if (!state || state.token !== token) return;
    state.saveState = 'error';
    toast(err && err.message ? err.message : 'Não foi possível salvar o rascunho.', { type: 'error' });
  }
  repaintSaveIndicator();
}

// ---------------------------------------------------------------------
// Navegação entre passos
// ---------------------------------------------------------------------

async function goToStep(step) {
  if (!state) return;
  const previousStep = state.step;
  if (step === 2 && !state.examId) {
    toast('Escolha a prova para continuar.', { type: 'warning' });
    return;
  }
  if (step === 3) {
    const title = currentThemeTitle();
    if (!state.themeId) {
      toast('Escolha um tema ou selecione "Tema livre".', { type: 'warning' });
      return;
    }
    if (state.themeId === FREE_THEME && title.length < 3) {
      toast('Escreva o título do tema livre (mínimo de três caracteres).', { type: 'warning' });
      const input = qs('[data-ess-free-title]', state.el);
      if (input) input.focus();
      return;
    }
    const button = qs('[data-action="to-step-3"]', state.el);
    if (button) setLoading(button, true);
    try {
      await ensureDraft();
    } catch (err) {
      toast(err && err.message ? err.message : 'Não foi possível criar o rascunho.', { type: 'error' });
      if (button) setLoading(button, false);
      return;
    }
    if (button) setLoading(button, false);
  }
  state.step = step;
  paint();
  if (step === 3 && previousStep !== 3) {
    const token = state.token;
    requestAnimationFrame(() => {
      if (!state || state.token !== token) return;
      const paper = qs('.ess-paper-shell', state.el);
      if (paper) paper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  if (step === 2 && !state.themes.length && !state.loadingThemes && !state.themesError) loadThemes();
}

// ---------------------------------------------------------------------
// Envio para correção
// ---------------------------------------------------------------------

async function submitEssay({ skipConfirm = false } = {}) {
  if (!state || !state.essay || state.submitting) return;
  const words = countWords(state.content);
  if (!words) {
    toast('Escreva a redação antes de enviar para correção.', { type: 'warning' });
    return;
  }

  const ok = skipConfirm || await confirm({
    title: 'Enviar para correção',
    message: `Depois de enviada, a redação não pode mais ser editada. Você escreveu ${fmtNumber(words, { digits: 0 })} ${pluralize(words, 'palavra', 'palavras', { withNumber: false })}.`,
    confirmText: 'Enviar agora',
    icon: 'send',
  });
  if (!ok || !state) return;

  state.autosave.cancel();
  await saveDraft();
  if (!state) return;

  const token = state.token;
  state.submitted = true;
  state.submitting = true;
  state.submitError = null;
  paint();

  try {
    // O envio pode voltar já corrigido (correção rápida) ou "em correção" (202),
    // e nesse caso a correção segue no servidor — a tela acompanha pelo estado,
    // em vez de segurar a conexão aberta, que a borda cortaria.
    let resultado = await api.post(`/api/essays/${encodeURIComponent(state.essay.id)}/submit`, {});
    if (!state || state.token !== token) return;
    if (resultado && resultado.status === 'submitted') {
      resultado = (await aguardarCorrecao(state.essay.id, token)) || resultado;
      if (!state || state.token !== token) return;
    }
    stopWaitingMessages();
    state.submitting = false;
    if (resultado && resultado.status === 'failed') {
      state.submitError = new ApiError({ message: resultado.error_message || 'A correção não foi concluída. Envie novamente.' });
      paint();
      return;
    }
    // Corrigida, ou ainda em correção após a espera: a tela de detalhe assume o
    // acompanhamento e oferece reenvio se travar.
    state.leaving = true;
    if (resultado && resultado.status === 'corrected') toast('Correção concluída.', { type: 'success' });
    state.navigate(`/app/redacao/${state.essay.id}`);
  } catch (err) {
    if (!state || state.token !== token) return;
    stopWaitingMessages();
    state.submitting = false;
    state.submitError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
    paint();
  }
}

/**
 * Acompanha a correção pelo estado da redação até sair de "submitted", até o
 * teto de tentativas, ou até o aluno trocar de tela (o token muda).
 */
async function aguardarCorrecao(id, token, { tentativas = 60, intervaloMs = 3000 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    await new Promise((r) => setTimeout(r, intervaloMs));
    if (!state || state.token !== token) return null;
    let atual;
    try {
      atual = await api.get(`/api/essays/${encodeURIComponent(id)}`);
    } catch {
      continue;
    }
    if (!state || state.token !== token) return null;
    if (atual && atual.status !== 'submitted') return atual;
  }
  return null;
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderEssayNew(ctx) {
  ctx.setTitle('Nova redação');

  const token = Symbol('essay-new');
  state = {
    token,
    el: ctx.el,
    navigate: ctx.navigate,
    step: 1,
    exams: [],
    examId: null,
    criteria: null,
    criteriaError: null,
    themes: [],
    themeId: null,
    themeTitle: '',
    freeTitle: '',
    loadingThemes: false,
    themesError: null,
    essay: null,
    content: '',
    savedContent: '',
    saveState: 'idle',
    submitting: false,
    submitted: false,
    submitError: null,
    generating: false,
    aiStatus: null,
    loading: true,
    fatalError: null,
    waitingTimer: null,
    leaving: false,
    autosave: null,
    off: [],
  };

  state.autosave = debounce(() => saveDraft(), AUTOSAVE_DELAY);

  render(
    ctx.el,
    html`
      ${pageHeader({
        title: 'Nova redação',
        subtitle: 'Escolha a prova e o tema, escreva com calma e envie para a correção detalhada.',
        breadcrumb: [{ label: 'Redação IA', href: '/app/redacao' }, { label: 'Nova redação' }],
      })}
      <div class="ess-steps-wrap" data-ess-steps></div>
      <div data-ess-step>${skeleton('form', 4)}</div>`
  );

  state.off.push(
    on(ctx.el, 'click', '[data-action]', (event, button) => {
      const action = button.dataset.action;
      if (action === 'to-step-1') {
        event.preventDefault();
        goToStep(1);
      } else if (action === 'to-step-2') {
        event.preventDefault();
        goToStep(2);
      } else if (action === 'to-step-3') {
        event.preventDefault();
        goToStep(3);
      } else if (action === 'generate-theme') {
        event.preventDefault();
        generateTheme(button);
      } else if (action === 'submit') {
        event.preventDefault();
        submitEssay();
      } else if (action === 'retry-submit') {
        event.preventDefault();
        state.submitError = null;
        submitEssay({ skipConfirm: true });
      } else if (action === 'reload-criteria') {
        event.preventDefault();
        loadCriteria();
      } else if (action === 'reload-themes') {
        event.preventDefault();
        loadThemes();
      } else if (action === 'reload-new') {
        event.preventDefault();
        state.navigate('/app/redacao/nova');
      }
    }),
    on(ctx.el, 'change', 'input[name="ess-exam"]', (event, input) => {
      if (state.examId === input.value) return;
      // a prova define os critérios e não muda depois que o texto começou
      if (state.essay && String(state.content || '').trim()) {
        toast('Você já começou a escrever nesta prova. Para trocar, comece uma nova redação.', { type: 'warning' });
        const previous = qs(`input[name="ess-exam"][value="${state.examId}"]`, state.el);
        if (previous) previous.checked = true;
        return;
      }
      if (state.essay) {
        // rascunho ainda em branco: descarta e recomeça na nova prova
        const discarded = state.essay.id;
        state.essay = null;
        state.savedContent = '';
        api.del(`/api/essays/${encodeURIComponent(discarded)}`).catch(() => {
          /* rascunho vazio: se a exclusão falhar, ele fica na lista como rascunho */
        });
      }
      state.examId = input.value;
      state.themes = [];
      state.themeId = null;
      state.themeTitle = '';
      qsa('[name="ess-exam"]', state.el).forEach((radio) => {
        const label = radio.closest('.choice');
        if (label) label.classList.toggle('active', radio.value === state.examId);
      });
      loadCriteria();
    }),
    on(ctx.el, 'change', 'input[name="ess-theme"]', (event, input) => {
      state.themeId = input.value;
      const chosen = state.themes.find((row) => row.id === state.themeId);
      state.themeTitle = chosen ? chosen.title : '';
      qsa('[data-theme-card]', state.el).forEach((card) => {
        card.classList.toggle('is-selected', card.dataset.themeCard === state.themeId);
      });
    }),
    on(ctx.el, 'input', '[data-ess-free-title]', (event, input) => {
      state.freeTitle = input.value;
      // escrever no campo já significa escolher o tema livre
      if (state.themeId !== FREE_THEME) {
        state.themeId = FREE_THEME;
        state.themeTitle = '';
        const radio = qs(`input[name="ess-theme"][value="${FREE_THEME}"]`, state.el);
        if (radio) radio.checked = true;
        qsa('[data-theme-card]', state.el).forEach((card) => {
          card.classList.toggle('is-selected', card.dataset.themeCard === FREE_THEME);
        });
      }
    }),
    on(ctx.el, 'input', '[data-ess-content]', (event, textarea) => {
      state.content = textarea.value;
      state.saveState = 'saving';
      repaintCounter();
      repaintSaveIndicator();
      state.autosave();
    })
  );

  // --- dados iniciais --------------------------------------------------
  const defaultExamId = (store.profile && store.profile.exam_id) || (store.exam && store.exam.id) || null;
  try {
    const [exams, aiStatus] = await Promise.all([
      api.get('/api/exams'),
      api.get('/api/tutor/status').catch(() => ({ available: false, configured: false, limit_reached: false })),
    ]);
    if (!state || state.token !== token) return;
    state.exams = Array.isArray(exams) ? exams : [];
    state.aiStatus = aiStatus;
    const withEssay = state.exams.filter((exam) => exam.has_essay !== false);
    state.examId = withEssay.some((exam) => exam.id === defaultExamId) ? defaultExamId : (withEssay[0] ? withEssay[0].id : null);
  } catch (err) {
    if (!state || state.token !== token) return;
    state.fatalError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
    state.loading = false;
    paint();
    return;
  }

  // rascunho existente (?essay_id=) — abre direto no editor
  const draftId = ctx.query && ctx.query.essay_id;
  if (draftId) {
    try {
      const essay = await api.get(`/api/essays/${encodeURIComponent(draftId)}`);
      if (!state || state.token !== token) return;
      if (essay.status !== 'draft') {
        state.navigate(`/app/redacao/${essay.id}`);
        return;
      }
      state.essay = essay;
      state.examId = essay.exam_id;
      state.content = essay.content || '';
      state.savedContent = state.content;
      state.themeId = essay.theme_id || FREE_THEME;
      state.themeTitle = essay.theme_title || '';
      state.freeTitle = essay.theme_id ? '' : essay.theme_title || '';
      state.criteria = essay.criteria_set || null;
      state.step = 3;
    } catch (err) {
      if (!state || state.token !== token) return;
      toast(err && err.message ? err.message : 'Rascunho não encontrado.', { type: 'error' });
    }
  }

  const preTheme = ctx.query && ctx.query.theme_id;
  if (preTheme && !state.essay) {
    state.themeId = preTheme;
    state.step = 2;
  }

  state.loading = false;
  paint();

  if (!state.criteria) loadCriteria();
  if (state.step === 2 || (state.step === 3 && state.themeId && state.themeId !== FREE_THEME)) loadThemes();
}

export function unmount() {
  if (!state) return;
  stopWaitingMessages();
  if (state.autosave && typeof state.autosave.cancel === 'function') state.autosave.cancel();
  // último salvamento em segundo plano ao sair do editor
  if (state.essay && !state.leaving && state.content !== state.savedContent) {
    api.put(`/api/essays/${encodeURIComponent(state.essay.id)}`, { content: state.content }).catch(() => {
      /* o aluno já saiu da tela: o erro não tem onde ser mostrado */
    });
  }
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

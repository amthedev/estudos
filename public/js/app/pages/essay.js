// =====================================================================
// Foco Elite — Correção da redação (ARCHITECTURE §6.4)
//
// GET /api/essays/:id traz a redação, a correção da IA e o conjunto de critérios
// da prova (criteria_set). A tela mostra a nota geral com anel, um card por
// critério, os pareceres (pontos fortes, pontos a melhorar, erros gramaticais,
// argumentação, repertório, estrutura, coesão, proposta de intervenção e
// sugestões) e o texto da redação ao lado.
//
// Rascunho volta para o editor; redação em correção recarrega; falha explica o
// erro e oferece o reenvio.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import {
  html, render, toast, on,
  pageHeader, emptyState, errorState, skeleton, badge, progressBar, ring, alertBox, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtDate, fmtDateTime, fmtScore, fmtNumber, fmtPct, statusLabel, pluralize } from '../../core/format.js';

let state = null;

const pctOf = (score, max) => {
  const total = Number(max) || 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, (Number(score) / total) * 100));
};

/** Verde acima de 70%, laranja acima de 50%, vermelho abaixo disso. */
function tone(pct) {
  if (pct >= 70) return 'success';
  if (pct >= 50) return 'warning';
  return 'danger';
}

// ---------------------------------------------------------------------
// Blocos da correção
// ---------------------------------------------------------------------

function scoreHero(essay) {
  const pct = pctOf(essay.score, essay.max_score);
  const correction = essay.correction || {};
  return html`
    <section class="card ess-hero">
      <div class="ess-hero-ring">
        ${ring(pct, {
          size: 'xl',
          color: tone(pct),
          label: html`
            <span class="ess-hero-score">${fmtScore(essay.score)}</span>
            <span class="ess-hero-max">/ ${fmtScore(essay.max_score)}</span>`,
        })}
      </div>
      <div class="ess-hero-body">
        <div class="ess-hero-meta">
          ${badge(statusLabel(essay.status), 'green', { icon: 'circle-check' })}
          <span>${essay.exam_short_name || essay.exam_name}</span>
          ${essay.corrected_at ? html`<span>Corrigida em ${fmtDate(essay.corrected_at)}</span>` : ''}
          <span>${fmtPct(pct)} do total</span>
        </div>
        <h2 class="ess-hero-title">${essay.theme_title}</h2>
        ${correction.summary ? html`<div class="prose ess-hero-summary">${md(correction.summary)}</div>` : ''}
        ${correction.criteria_set_name
          ? html`<p class="hint">Critérios aplicados: ${correction.criteria_set_name}${correction.generic_criteria ? ' (modelo geral)' : ''}</p>`
          : ''}
      </div>
    </section>`;
}

function criteriaCards(essay) {
  const items = (essay.correction && essay.correction.criteria) || [];
  if (!items.length) return '';
  const definitions = ((essay.criteria_set && essay.criteria_set.criteria) || []).reduce((map, item) => {
    map[item.key] = item;
    return map;
  }, {});

  return html`
    <section class="ess-block">
      <h2 class="section-title">${icon('list-checks')}<span>Nota por critério</span></h2>
      <div class="ess-criteria-cards">
        ${items.map((item) => {
          const pct = pctOf(item.score, item.max);
          const definition = definitions[item.key] || null;
          return html`
            <article class="card ess-crit">
              <div class="ess-crit-head">
                <h3 class="ess-crit-name">${item.name}</h3>
                <span class="ess-crit-score score ${pct >= 70 ? 'good' : pct >= 50 ? 'medium' : 'bad'}">
                  ${fmtScore(item.score)}<small>/${fmtScore(item.max)}</small>
                </span>
              </div>
              ${progressBar(pct, { color: tone(pct), size: 'sm' })}
              ${definition && definition.description ? html`<p class="ess-crit-def">${definition.description}</p>` : ''}
              ${item.comment ? html`<div class="prose prose-sm ess-crit-comment">${md(item.comment)}</div>` : ''}
            </article>`;
        })}
      </div>
    </section>`;
}

function listSection({ title, iconName, items, variant = '' }) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return '';
  return html`
    <section class="card ess-section">
      <div class="card-header">
        <h2 class="card-title">${icon(iconName)}<span>${title}</span></h2>
      </div>
      <div class="card-body">
        <ul class="ess-points ${variant}">
          ${rows.map((row) => html`<li><span class="ess-point-mark" aria-hidden="true">${icon(variant === 'is-strong' ? 'check' : variant === 'is-weak' ? 'arrow-up-right' : 'chevron-right', { size: 14 })}</span><span>${row}</span></li>`)}
        </ul>
      </div>
    </section>`;
}

function grammarSection(correction) {
  const errors = Array.isArray(correction.grammar_errors) ? correction.grammar_errors : [];
  if (!errors.length) return '';
  return html`
    <section class="card ess-section">
      <div class="card-header">
        <h2 class="card-title">${icon('scroll-text')}<span>Erros gramaticais</span></h2>
        <span class="text-xs text-3">${pluralize(errors.length, 'ocorrência', 'ocorrências')}</span>
      </div>
      <div class="card-body">
        <ul class="ess-grammar">
          ${errors.map((item) => html`
            <li class="ess-grammar-item">
              <div class="ess-grammar-row">
                <span class="ess-grammar-tag is-wrong">No seu texto</span>
                <q class="ess-grammar-excerpt">${item.excerpt}</q>
              </div>
              ${item.fix
                ? html`
                  <div class="ess-grammar-row">
                    <span class="ess-grammar-tag is-fix">Correção</span>
                    <span class="ess-grammar-fix">${item.fix}</span>
                  </div>`
                : ''}
              ${item.explanation ? html`<p class="ess-grammar-why">${item.explanation}</p>` : ''}
            </li>`)}
        </ul>
      </div>
    </section>`;
}

function textSection({ title, iconName, text }) {
  if (!text) return '';
  return html`
    <section class="card ess-section">
      <div class="card-header">
        <h2 class="card-title">${icon(iconName)}<span>${title}</span></h2>
      </div>
      <div class="card-body prose prose-sm">${md(text)}</div>
    </section>`;
}

function essayTextPanel(essay) {
  const words = Number(essay.word_count) || 0;
  return html`
    <aside class="ess-aside">
      <section class="card ess-text-card">
        <div class="card-header">
          <h2 class="card-title">${icon('file-text')}<span>Sua redação</span></h2>
          <span class="text-xs text-3">${fmtNumber(words, { digits: 0 })} ${pluralize(words, 'palavra', 'palavras', { withNumber: false })}</span>
        </div>
        <div class="card-body">
          <div class="ess-text">${essay.content || ''}</div>
        </div>
      </section>
      ${essay.prompt_text || essay.support_texts
        ? html`
          <details class="card ess-proposal-card">
            <summary>${icon('lightbulb', { size: 15 })}<span>Proposta e textos motivadores</span></summary>
            <div class="ess-proposal-body">
              ${essay.prompt_text ? html`<h3 class="ess-theme-sub">Proposta</h3><div class="prose prose-sm">${md(essay.prompt_text)}</div>` : ''}
              ${essay.support_texts ? html`<h3 class="ess-theme-sub">Textos motivadores</h3><div class="prose prose-sm">${md(essay.support_texts)}</div>` : ''}
            </div>
          </details>`
        : ''}
    </aside>`;
}

// ---------------------------------------------------------------------
// Situações que não são "corrigida"
// ---------------------------------------------------------------------

function draftView(essay) {
  return html`
    <section class="card ess-state">
      ${emptyState({
        icon: 'square-pen',
        title: 'Esta redação ainda é um rascunho',
        text: 'Continue de onde parou e envie para correção quando terminar.',
        action: { label: 'Continuar escrevendo', href: `/app/redacao/nova?essay_id=${encodeURIComponent(essay.id)}`, icon: 'pen-line' },
      })}
    </section>`;
}

function submittedView(essay) {
  // Passados alguns minutos ainda "em correção", o mais provável é que a
  // correção foi interrompida (reinício no meio) e ninguém está mais corrigindo.
  // Em vez de deixar o aluno preso num spinner que nunca resolve, ofereça o
  // reenvio — o backend aceita reenviar uma redação órfã.
  const desde = essay && essay.submitted_at ? Date.now() - new Date(essay.submitted_at).getTime() : 0;
  const provavelmentePresa = desde > 4 * 60 * 1000;

  if (provavelmentePresa) {
    return html`
      <section class="card ess-state">
        <span class="icon-box icon-box-lg orange">${icon('clock')}</span>
        <h2 class="ess-state-title">A correção está demorando mais que o normal</h2>
        <p class="ess-state-text">
          Costuma levar menos de dois minutos. Seu texto está guardado por inteiro —
          você pode atualizar mais uma vez ou reenviar para correção.
        </p>
        <div class="ess-state-actions">
          <button type="button" class="btn btn-ghost" data-action="reload-essay">${icon('refresh-cw')}<span>Atualizar</span></button>
          <button type="button" class="btn btn-primary" data-action="resubmit">${icon('send')}<span>Enviar novamente</span></button>
        </div>
      </section>`;
  }

  return html`
    <section class="card ess-state" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <h2 class="ess-state-title">Sua redação está em correção</h2>
      <p class="ess-state-text">A análise completa costuma levar menos de dois minutos. Atualize em instantes para ver o resultado.</p>
      <button type="button" class="btn btn-secondary" data-action="reload-essay">${icon('refresh-cw')}<span>Atualizar</span></button>
    </section>`;
}

function failedView(essay) {
  return html`
    <section class="card ess-state">
      <span class="icon-box icon-box-lg red">${icon('triangle-alert')}</span>
      <h2 class="ess-state-title">A correção não foi concluída</h2>
      <p class="ess-state-text">
        ${essay.error_message || 'O serviço de correção não respondeu na última tentativa. Seu texto está guardado por inteiro.'}
      </p>
      <p class="hint">Nada do que você escreveu foi perdido. Você pode reenviar agora mesmo.</p>
      <div class="ess-state-actions">
        <a class="btn btn-ghost" href="/app/redacao">${icon('arrow-left')}<span>Voltar</span></a>
        <button type="button" class="btn btn-primary" data-action="resubmit">${icon('send')}<span>Enviar novamente</span></button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------

function headerActions(essay) {
  if (essay.status !== 'corrected') return '';
  return html`
    <a class="btn btn-secondary" href="/app/tutor?essay_id=${encodeURIComponent(essay.id)}">
      ${icon('bot')}<span>Perguntar ao Tutor sobre esta correção</span>
    </a>
    <button type="button" class="btn btn-primary" data-action="new-version">
      ${icon('pen-line')}<span>Escrever nova versão</span>
    </button>`;
}

function paint() {
  const el = state.el;
  if (state.error) {
    render(el, html`
      ${pageHeader({ title: 'Redação', breadcrumb: [{ label: 'Redação IA', href: '/app/redacao' }, { label: 'Correção' }] })}
      ${errorState({ title: 'Não foi possível abrir esta redação', message: state.error.message, retry: 'reload-essay' })}`);
    return;
  }
  if (state.loading || !state.essay) {
    render(el, html`${skeleton('header')}${skeleton('cards', 2)}`);
    return;
  }

  const essay = state.essay;
  const correction = essay.correction || {};

  let body;
  if (essay.status === 'draft') body = draftView(essay);
  else if (essay.status === 'submitted') body = submittedView(essay);
  else if (essay.status === 'failed') body = failedView(essay);
  else {
    body = html`
      <div class="ess-result">
        <div class="ess-main">
          ${scoreHero(essay)}
          ${criteriaCards(essay)}
          ${listSection({ title: 'Pontos fortes', iconName: 'circle-check', items: correction.strengths, variant: 'is-strong' })}
          ${listSection({ title: 'Pontos a melhorar', iconName: 'trending-up', items: correction.weaknesses, variant: 'is-weak' })}
          ${grammarSection(correction)}
          ${textSection({ title: 'Argumentação', iconName: 'brain', text: correction.argumentation })}
          ${textSection({ title: 'Repertório sociocultural', iconName: 'library', text: correction.repertoire })}
          ${textSection({ title: 'Estrutura e progressão', iconName: 'layers', text: correction.structure })}
          ${textSection({ title: 'Coesão e coerência', iconName: 'git-branch', text: correction.cohesion })}
          ${textSection({ title: 'Proposta de intervenção', iconName: 'target', text: correction.intervention_proposal })}
          ${listSection({ title: 'Sugestões para a próxima redação', iconName: 'lightbulb', items: correction.suggestions })}
          ${correction.model || essay.model
            ? html`<p class="ess-model hint">Correção gerada por IA${essay.corrected_at ? ` em ${fmtDateTime(essay.corrected_at)}` : ''}. Use os comentários como orientação de estudo.</p>`
            : ''}
        </div>
        ${essayTextPanel(essay)}
      </div>`;
  }

  render(
    el,
    html`
      ${pageHeader({
        title: essay.theme_title,
        subtitle: `${essay.exam_short_name || essay.exam_name} · ${statusLabel(essay.status)}`,
        breadcrumb: [{ label: 'Redação IA', href: '/app/redacao' }, { label: 'Correção' }],
        actions: headerActions(essay),
      })}
      ${essay.status === 'corrected' && (essay.criteria_set && essay.criteria_set.generic)
        ? alertBox({ type: 'info', text: 'Esta prova ainda não tem critérios próprios cadastrados: a correção usou um modelo geral de texto dissertativo-argumentativo.' })
        : ''}
      ${body}`
  );
}

// ---------------------------------------------------------------------
// Dados e ações
// ---------------------------------------------------------------------

async function load() {
  const token = state.token;
  state.loading = true;
  state.error = null;
  paint();
  try {
    const essay = await api.get(`/api/essays/${encodeURIComponent(state.id)}`);
    if (!state || state.token !== token) return;
    state.essay = essay;
  } catch (err) {
    if (!state || state.token !== token) return;
    state.error = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  state.loading = false;
  paint();
}

async function resubmit(button) {
  if (!state || !state.essay || state.busy) return;
  state.busy = true;
  if (button) setLoading(button, true);
  try {
    const corrected = await api.post(`/api/essays/${encodeURIComponent(state.essay.id)}/submit`, {});
    if (!state) return;
    state.essay = corrected;
    toast('Correção concluída.', { type: 'success' });
    paint();
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível corrigir agora. Tente novamente em instantes.', { type: 'error' });
    if (state) await load();
  } finally {
    if (state) state.busy = false;
    if (button) setLoading(button, false);
  }
}

/** Cria um rascunho com o mesmo tema e abre o editor. */
async function newVersion(button) {
  if (!state || !state.essay || state.busy) return;
  const essay = state.essay;
  state.busy = true;
  if (button) setLoading(button, true);
  try {
    const payload = { exam_id: essay.exam_id };
    if (essay.theme_id) payload.theme_id = essay.theme_id;
    else payload.theme_title = essay.theme_title;
    const draft = await api.post('/api/essays', payload);
    if (!state) return;
    state.navigate(`/app/redacao/nova?essay_id=${encodeURIComponent(draft.id)}`);
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível criar a nova versão.', { type: 'error' });
  } finally {
    if (state) state.busy = false;
    if (button) setLoading(button, false);
  }
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderEssay(ctx) {
  ctx.setTitle('Redação');

  const token = Symbol('essay');
  state = {
    token,
    el: ctx.el,
    id: ctx.params.id,
    navigate: ctx.navigate,
    essay: null,
    loading: true,
    error: null,
    busy: false,
    off: [],
  };

  state.off.push(
    on(ctx.el, 'click', '[data-action]', (event, button) => {
      const action = button.dataset.action;
      if (action === 'reload-essay') {
        event.preventDefault();
        load();
      } else if (action === 'resubmit') {
        event.preventDefault();
        resubmit(button);
      } else if (action === 'new-version') {
        event.preventDefault();
        newVersion(button);
      }
    })
  );

  await load();
  if (state && state.essay) ctx.setTitle(state.essay.theme_title);
}

export function unmount() {
  if (!state) return;
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

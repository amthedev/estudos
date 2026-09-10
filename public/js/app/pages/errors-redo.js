// =====================================================================
// Foco Elite — /app/caderno-de-erros/refazer
// Refaz as questões do caderno de erros (POST /api/errors/redo) com
// feedback imediato. As respostas usam context 'errors_redo' e o
// context_id do registro; acertar aqui marca o erro como resolvido.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, pageHeader, emptyState, errorState, skeleton } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pluralize } from '../../core/format.js';
import { mountQuestionRunner } from '../../components/question-runner.js';
import { practiceSummary } from './practice.js';

const REDO_LIMIT = 10;

let cleanup = [];
let runner = null;

function destroyRunner() {
  if (runner && typeof runner.destroy === 'function') runner.destroy();
  runner = null;
}

export default async function renderPage(ctx) {
  const { el } = ctx;
  const filters = {
    subject_id: ctx.query.subject_id || '',
    topic_id: ctx.query.topic_id || '',
  };
  const backHref = (() => {
    const params = new URLSearchParams();
    if (filters.subject_id) params.set('subject_id', filters.subject_id);
    if (filters.topic_id) params.set('topic_id', filters.topic_id);
    const search = params.toString();
    return `/app/caderno-de-erros${search ? `?${search}` : ''}`;
  })();

  const state = { questions: [], loading: true, error: null };

  render(el, html`<div class="prc-page errb-redo" data-body></div>`);
  const body = qs('[data-body]', el);

  function headerView() {
    const subject = state.questions.length ? state.questions[0].subject_name : '';
    return pageHeader({
      title: 'Refazer meus erros',
      subtitle: filters.subject_id && subject
        ? `Questões de ${subject} que você errou. Acertar aqui marca o erro como resolvido.`
        : 'Questões que você errou, priorizando as que mais se repetem. Acertar aqui marca o erro como resolvido.',
      breadcrumb: [{ label: 'Caderno de Erros', href: backHref }, { label: 'Refazer' }],
      actions: html`<a class="btn btn-ghost" href="${backHref}">${icon('arrow-left')}<span>Voltar ao caderno</span></a>`,
    });
  }

  function showSummary(summary) {
    const holder = qs('[data-summary]', body);
    if (!holder) return;
    const byId = new Map(state.questions.map((question) => [question.id, question]));
    let solved = 0;
    for (const answer of summary.answers) {
      const question = byId.get(answer.question_id);
      if (answer.is_correct === true && question && !question.resolved) solved += 1;
    }
    const pending = summary.total - solved;
    const actions = html`
      <a class="btn btn-secondary" href="${backHref}">${icon('circle-x')}<span>Voltar ao caderno</span></a>
      <button type="button" class="btn btn-secondary" data-action="redo">${icon('refresh-cw')}<span>Refazer novamente</span></button>
      <a class="btn btn-primary" href="/app/questoes">${icon('file-text')}<span>Resolver novas questões</span></a>`;
    render(
      holder,
      practiceSummary({
        correct: summary.correct,
        wrong: summary.wrong + summary.blank,
        total: summary.total,
        title: solved > 0 ? `${pluralize(solved, 'erro resolvido', 'erros resolvidos')}` : 'Sessão concluída',
        subtitle: solved > 0
          ? pending > 0
            ? `Ainda restam ${pluralize(pending, 'questão', 'questões')} desta rodada para virar acerto.`
            : 'Você resolveu todas as questões desta rodada. Continue assim.'
          : 'Nenhum erro foi resolvido desta vez. Revise a resolução e tente de novo.',
        actions,
      })
    );
    holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function mountRunner() {
    const holder = qs('[data-runner]', body);
    if (!holder) return;
    destroyRunner();
    runner = mountQuestionRunner(holder, {
      questions: state.questions,
      immediateFeedback: true,
      showTimer: true,
      answer: (questionId, optionId, meta) => {
        const question = state.questions.find((row) => row.id === questionId);
        return api.post(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
          option_id: optionId,
          context: 'errors_redo',
          context_id: (question && question.error_id) || null,
          time_spent_sec: meta && meta.time_spent_sec ? meta.time_spent_sec : null,
        });
      },
      onFinish: (summary) => showSummary(summary),
    });
  }

  function paint() {
    if (state.loading) {
      render(body, html`${skeleton('header')}${skeleton('question')}`);
      return;
    }
    if (state.error) {
      render(body, html`${headerView()}${errorState({ message: state.error })}`);
      return;
    }
    if (!state.questions.length) {
      render(
        body,
        html`
          ${headerView()}
          ${emptyState({
            icon: 'circle-check',
            title: 'Nada para refazer agora',
            text: 'Seu caderno de erros está vazio para estes filtros. Resolva novas questões para continuar treinando.',
            action: { label: 'Ir para o banco de questões', href: '/app/questoes', icon: 'file-text' },
          })}`
      );
      return;
    }
    render(body, html`${headerView()}<div data-summary></div><div class="prc-runner" data-runner></div>`);
    mountRunner();
  }

  async function load() {
    state.loading = true;
    state.error = null;
    destroyRunner();
    paint();
    try {
      const questions = await api.post('/api/errors/redo', {
        subject_id: filters.subject_id || undefined,
        topic_id: filters.topic_id || undefined,
        limit: REDO_LIMIT,
      });
      state.questions = Array.isArray(questions) ? questions : [];
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível montar a lista de questões para refazer.';
    }
    paint();
  }

  cleanup.push(
    on(el, 'click', '[data-action="retry"]', () => load()),
    on(el, 'click', '[data-action="redo"]', () => load()),
    () => destroyRunner()
  );

  await load();
}

export async function unmount() {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* limpeza best-effort */
    }
  }
  cleanup = [];
  destroyRunner();
}

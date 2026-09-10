// =====================================================================
// Foco Elite — /app/aulas/:id/praticar
// "Pratique agora": 5 questões do assunto da aula com feedback imediato.
// As respostas vão para POST /api/questions/:id/answer com context
// 'practice' e context_id da aula; ao terminar, o cronograma é avisado
// por POST /api/schedule/after-practice.
//
// Exporta `practiceSummary`, o cartão de resultado reutilizado pelo
// refazer do caderno de erros.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, pageHeader, emptyState, errorState, skeleton, ring } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { mountQuestionRunner } from '../../components/question-runner.js';

let cleanup = [];
let runner = null;

/**
 * Cartão de resultado de uma sessão de questões.
 * `actions` recebe HTML já pronto (links/botões) exibido no rodapé.
 */
export function practiceSummary({ correct = 0, wrong = 0, total = 0, title = 'Prática concluída', subtitle = '', extra = '', actions = '' } = {}) {
  const answered = Number(correct) + Number(wrong);
  const pct = answered > 0 ? Math.round((Number(correct) / answered) * 100) : 0;
  const tone = pct >= 70 ? 'success' : pct >= 50 ? 'warning' : 'danger';
  return html`
    <section class="card prc-summary" role="status" aria-live="polite">
      <div class="prc-summary-ring">
        ${ring(pct, { size: 'lg', color: tone, label: `${pct}%` })}
        <span class="prc-summary-ring-label">de acerto</span>
      </div>
      <div class="prc-summary-body">
        <h2 class="prc-summary-title">${title}</h2>
        ${subtitle ? html`<p class="prc-summary-sub">${subtitle}</p>` : ''}
        <dl class="prc-summary-stats">
          <div class="prc-stat prc-stat-correct">
            <dt>Acertos</dt>
            <dd>${correct}</dd>
          </div>
          <div class="prc-stat prc-stat-wrong">
            <dt>Erros</dt>
            <dd>${wrong}</dd>
          </div>
          <div class="prc-stat">
            <dt>Questões</dt>
            <dd>${total}</dd>
          </div>
        </dl>
        ${extra}
        ${actions ? html`<div class="prc-summary-actions">${actions}</div>` : ''}
      </div>
    </section>`;
}

function destroyRunner() {
  if (runner && typeof runner.destroy === 'function') runner.destroy();
  runner = null;
}

export default async function renderPage(ctx) {
  const { el, params } = ctx;
  const lessonId = params.id;
  const state = { lesson: null, questions: [], loading: true, error: null };

  render(el, html`<div class="prc-page" data-body></div>`);
  const body = qs('[data-body]', el);

  function headerView() {
    const lesson = state.lesson;
    const topic = lesson ? lesson.topic_name : '';
    return pageHeader({
      title: topic ? `Pratique agora — ${topic}` : 'Pratique agora',
      subtitle: lesson
        ? `Questões do assunto da aula “${lesson.title}”. Você recebe o resultado a cada resposta.`
        : 'Questões do assunto desta aula, com correção na hora.',
      breadcrumb: lesson
        ? [
            { label: 'Aulas', href: '/app/aulas' },
            { label: lesson.title, href: `/app/aulas/${lesson.id}` },
            { label: 'Pratique agora' },
          ]
        : null,
      actions: html`<a class="btn btn-ghost" href="/app/aulas/${lessonId}">${icon('arrow-left')}<span>Voltar à aula</span></a>`,
    });
  }

  async function reportPractice(summary) {
    // O cronograma se adapta ao desempenho; uma falha aqui não pode atrapalhar a prática.
    try {
      await api.post('/api/schedule/after-practice', {
        lesson_id: lessonId,
        correct: summary.correct,
        total: summary.total,
      });
    } catch (err) {
      console.warn('[praticar] não foi possível atualizar o cronograma', err);
    }
  }

  function showSummary(summary) {
    const holder = qs('[data-summary]', body);
    if (!holder) return;
    const lesson = state.lesson || {};
    const next = lesson.next_lesson;
    const actions = html`
      <a class="btn btn-secondary" href="/app/caderno-de-erros">${icon('circle-x')}<span>Ver caderno de erros</span></a>
      <button type="button" class="btn btn-secondary" data-action="redo">${icon('refresh-cw')}<span>Refazer</span></button>
      <a class="btn btn-ghost" href="/app/aulas/${lessonId}">${icon('arrow-left')}<span>Voltar à aula</span></a>
      <a class="btn btn-primary" href="${next ? `/app/aulas/${next.id}` : '/app/cronograma'}">
        ${icon('arrow-right')}<span>${next ? 'Ir para próxima atividade' : 'Ver meu cronograma'}</span>
      </a>`;
    render(
      holder,
      practiceSummary({
        correct: summary.correct,
        wrong: summary.wrong + summary.blank,
        total: summary.total,
        title: 'Prática concluída',
        subtitle: next
          ? `Próxima atividade sugerida: ${next.title}.`
          : 'Suas revisões e o cronograma foram atualizados com este resultado.',
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
      answer: (questionId, optionId, meta) =>
        api.post(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
          option_id: optionId,
          context: 'practice',
          context_id: lessonId,
          time_spent_sec: meta && meta.time_spent_sec ? meta.time_spent_sec : null,
        }),
      onFinish: (summary) => {
        showSummary(summary);
        reportPractice(summary);
      },
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
            icon: 'file-text',
            title: 'Nenhuma questão disponível para este assunto',
            text: 'Assim que novas questões forem publicadas, elas aparecem aqui. Enquanto isso, siga para a próxima aula.',
            action: { label: 'Voltar à aula', href: `/app/aulas/${lessonId}`, icon: 'arrow-left', variant: 'secondary' },
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
      const [lesson, questions] = await Promise.all([
        api.get(`/api/lessons/${encodeURIComponent(lessonId)}`),
        api.get(`/api/lessons/${encodeURIComponent(lessonId)}/practice`),
      ]);
      state.lesson = lesson;
      state.questions = Array.isArray(questions) ? questions : [];
      state.loading = false;
      if (lesson && lesson.topic_name) ctx.setTitle(`Pratique agora — ${lesson.topic_name}`);
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar as questões desta aula.';
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

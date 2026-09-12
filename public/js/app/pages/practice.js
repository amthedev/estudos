// =====================================================================
// Foco Elite — /app/aulas/:id/praticar
// "Pratique agora": o aluno escolhe a dificuldade e recebe uma questão de
// cada assunto da aula, com correção na hora. Quando o banco não tem
// questão daquele assunto na dificuldade pedida, a IA elabora — por isso
// há uma tela de espera entre a escolha e as questões.
//
// APIs: POST /api/lessons/:id/practice { difficulty } para montar o
// conjunto, POST /api/questions/:id/answer com context 'practice' e
// context_id da aula para responder, e POST /api/schedule/after-practice
// ao terminar, para o cronograma se adaptar ao desempenho.
//
// Exporta `practiceSummary`, o cartão de resultado reutilizado pelo
// refazer do caderno de erros.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, qs, on, setLoading, pageHeader, emptyState, errorState, skeleton, ring } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { mountQuestionRunner } from '../../components/question-runner.js';

let cleanup = [];
let runner = null;
let waitingTimer = null;

const DIFFICULTIES = [
  { value: 1, label: 'Fácil', text: 'Aplicação direta do conceito, em uma etapa.' },
  { value: 2, label: 'Média', text: 'Duas ou três etapas, ou interpretação antes de aplicar.' },
  { value: 3, label: 'Difícil', text: 'Mais de um conceito, com pegadinha nas alternativas.' },
];

const WAITING_MESSAGES = [
  'Separando os assuntos da aula…',
  'Escolhendo o que cobrar de cada um…',
  'Escrevendo os enunciados e as alternativas…',
  'Conferindo o gabarito e a resolução…',
];

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

function stopWaitingMessages() {
  if (waitingTimer) clearInterval(waitingTimer);
  waitingTimer = null;
}

export default async function renderPage(ctx) {
  const { el, params } = ctx;
  const lessonId = params.id;
  const state = {
    lesson: null,
    questions: [],
    difficulty: 2,
    step: 'setup', // setup → generating → running
    loading: true,
    error: null,
    generating: null,
  };

  render(el, html`<div class="prc-page" data-body></div>`);
  const body = qs('[data-body]', el);

  function headerView() {
    const lesson = state.lesson;
    const topic = lesson ? lesson.topic_name : '';
    return pageHeader({
      title: topic ? `Pratique agora — ${topic}` : 'Pratique agora',
      subtitle: lesson
        ? `Uma questão de cada assunto da aula “${lesson.title}”, com o resultado a cada resposta.`
        : 'Questões dos assuntos desta aula, com correção na hora.',
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

  function setupView() {
    return html`
      <section class="card prc-setup">
        <div class="card-body">
          <h2 class="prc-setup-title">Qual o nível das questões?</h2>
          <p class="prc-setup-text">
            Você recebe três questões, uma de cada assunto da aula. Escolha o quanto quer ser cobrado.
          </p>
          <div class="prc-levels" role="radiogroup" aria-label="Dificuldade das questões">
            ${DIFFICULTIES.map(
              (level) => html`
                <button type="button" class="prc-level${level.value === state.difficulty ? ' is-active' : ''}"
                        role="radio" aria-checked="${level.value === state.difficulty ? 'true' : 'false'}"
                        data-action="level" data-value="${level.value}">
                  <span class="prc-level-label">${level.label}</span>
                  <span class="prc-level-text">${level.text}</span>
                </button>`
            )}
          </div>
          <div class="prc-setup-actions">
            <button type="button" class="btn btn-primary btn-lg" data-action="start">
              ${icon('target')}<span>Começar a praticar</span>
            </button>
          </div>
          <p class="hint prc-setup-hint">
            ${icon('info', { size: 14 })}
            <span>As questões vêm do banco da plataforma. Quando não há questão do assunto neste nível, a IA elabora uma na hora.</span>
          </p>
        </div>
      </section>`;
  }

  function generatingView() {
    return html`
      <section class="card prc-waiting" role="status" aria-live="polite">
        <span class="spinner spinner-lg" aria-hidden="true"></span>
        <h2 class="prc-waiting-title">Preparando suas questões…</h2>
        <p class="prc-waiting-text" data-waiting-text>${WAITING_MESSAGES[0]}</p>
        <p class="hint">Pode levar até um minuto quando as questões são elaboradas na hora. Mantenha esta tela aberta.</p>
      </section>`;
  }

  function startWaitingMessages() {
    stopWaitingMessages();
    let index = 0;
    waitingTimer = setInterval(() => {
      index = (index + 1) % WAITING_MESSAGES.length;
      const node = qs('[data-waiting-text]', body);
      if (node) node.textContent = WAITING_MESSAGES[index];
    }, 7000);
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
      <button type="button" class="btn btn-secondary" data-action="redo">${icon('refresh-cw')}<span>Praticar de novo</span></button>
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
    stopWaitingMessages();

    if (state.loading) {
      render(body, html`${skeleton('header')}${skeleton('card')}`);
      return;
    }
    if (state.error) {
      render(body, html`${headerView()}${errorState({ message: state.error })}`);
      return;
    }
    if (state.step === 'generating') {
      render(body, html`${headerView()}${generatingView()}`);
      startWaitingMessages();
      return;
    }
    if (state.step === 'setup') {
      render(body, html`${headerView()}${setupView()}`);
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
            text: 'Não foi possível montar a prática agora. Tente de novo em instantes.',
            action: { label: 'Escolher outro nível', dataAction: 'redo', icon: 'refresh-cw', variant: 'secondary' },
          })}`
      );
      return;
    }
    render(body, html`${headerView()}<div data-summary></div><div class="prc-runner" data-runner></div>`);
    mountRunner();
  }

  /** Monta o conjunto de questões na dificuldade escolhida. */
  async function start(trigger) {
    if (state.generating) return;
    state.generating = true;
    if (trigger) setLoading(trigger, true);
    state.step = 'generating';
    paint();
    try {
      const result = await api.post(`/api/lessons/${encodeURIComponent(lessonId)}/practice`, {
        difficulty: state.difficulty,
      });
      state.questions = Array.isArray(result && result.questions) ? result.questions : [];
      state.step = 'running';
    } catch (err) {
      state.step = 'setup';
      state.error = (err && err.message) || 'Não foi possível preparar as questões desta aula.';
    } finally {
      state.generating = false;
      paint();
    }
  }

  async function load() {
    state.loading = true;
    state.error = null;
    destroyRunner();
    paint();
    try {
      state.lesson = await api.get(`/api/lessons/${encodeURIComponent(lessonId)}`);
      state.loading = false;
      if (state.lesson && state.lesson.topic_name) ctx.setTitle(`Pratique agora — ${state.lesson.topic_name}`);
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar esta aula.';
    }
    paint();
  }

  cleanup.push(
    on(el, 'click', '[data-action="level"]', (event, trigger) => {
      state.difficulty = Number(trigger.dataset.value) || 2;
      paint();
    }),
    on(el, 'click', '[data-action="start"]', (event, trigger) => start(trigger)),
    on(el, 'click', '[data-action="redo"]', () => {
      state.questions = [];
      state.step = 'setup';
      state.error = null;
      destroyRunner();
      paint();
    }),
    on(el, 'click', '[data-action="retry"]', () => {
      state.error = null;
      state.step = 'setup';
      paint();
    }),
    () => destroyRunner(),
    () => stopWaitingMessages()
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
  stopWaitingMessages();
}

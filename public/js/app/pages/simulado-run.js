// =====================================================================
// /app/simulados/:id — execução do simulado (rota bare, sem sidebar).
// Cronômetro regressivo, navegação livre entre questões e cada resposta
// salva em PATCH /api/simulados/attempts/:id/answers.
// =====================================================================
import { api } from '../../core/api.js';
import { html, render as renderTo, toast, confirm, emptyState, errorState, skeleton, badge, qs } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtMinutes, pluralize } from '../../core/format.js';
import { mountQuestionRunner } from '../../components/question-runner.js';

let page = null;
let runner = null;
let attempt = null;
let finishing = false;
let answers = {};

export default async function renderPage(ctx) {
  page = ctx;
  finishing = false;
  answers = {};
  ctx.setTitle('Simulado');
  renderTo(ctx.el, skeleton('question'));
  await load();
}

export function unmount() {
  if (runner) runner.destroy();
  runner = null;
  attempt = null;
  page = null;
  finishing = false;
  answers = {};
}

async function load() {
  const id = page.params.id;
  try {
    attempt = await api.get(`/api/simulados/attempts/${id}`);
  } catch (err) {
    showError(err);
    return;
  }

  if (attempt.status === 'finished') {
    page.navigate(`/app/simulados/${id}/resultado`, { replace: true });
    return;
  }
  if (attempt.status === 'abandoned') {
    renderTo(
      page.el,
      html`<div class="sim-run">
        ${emptyState({
          icon: 'circle-x',
          title: 'Este simulado foi descartado',
          text: 'Comece um novo simulado quando quiser — o histórico continua disponível.',
          action: { label: 'Voltar aos simulados', href: '/app/simulados', icon: 'arrow-left' },
        })}
      </div>`
    );
    return;
  }
  if (!Array.isArray(attempt.questions) || !attempt.questions.length) {
    renderTo(
      page.el,
      html`<div class="sim-run">
        ${emptyState({
          icon: 'inbox',
          title: 'Este simulado ficou sem questões',
          text: 'Não foi possível montar a prova com os filtros escolhidos. Monte um novo simulado.',
          action: { label: 'Novo simulado', href: '/app/simulados', icon: 'plus' },
        })}
      </div>`
    );
    return;
  }

  paint();
}

function showError(err) {
  renderTo(
    page.el,
    html`<div class="sim-run">
      ${errorState({
        title: 'Não foi possível abrir o simulado',
        message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
      })}
      <div class="text-center mt-4"><a class="btn btn-ghost" href="/app/simulados">Voltar aos simulados</a></div>
    </div>`
  );
  const btn = qs('[data-action="retry"]', page.el);
  if (btn) btn.addEventListener('click', () => load());
}

function paint() {
  if (runner) {
    runner.destroy();
    runner = null;
  }
  page.setTitle(attempt.title || 'Simulado');
  renderTo(
    page.el,
    html`
      <div class="sim-run">
        <header class="sim-run-top">
          <div class="sim-run-id">
            <img src="/assets/brand/foco-elite-mark.png" alt="" width="1254" height="1254">
            <div>
              <h1 class="sim-run-title">${attempt.title}</h1>
              <p class="sim-run-sub">
                ${pluralize(attempt.questions.length, 'questão', 'questões')} · ${fmtMinutes(attempt.duration_min)}
                ${attempt.exam_short_name ? html` · ${attempt.exam_short_name}` : ''}
              </p>
            </div>
          </div>
          <div class="sim-run-top-end">
            ${badge('Modo simulado', 'blue', { icon: 'target' })}
            <button type="button" class="btn btn-ghost btn-sm" data-action="leave">${icon('log-out')}<span>Sair</span></button>
          </div>
        </header>
        <div class="sim-run-body" id="sim-runner"></div>
      </div>`
  );

  const host = qs('#sim-runner', page.el);
  attempt.questions.forEach((q) => {
    if (q.selected_option_id && answers[q.id] === undefined) answers[q.id] = q.selected_option_id;
  });

  runner = mountQuestionRunner(host, {
    questions: attempt.questions,
    mode: 'simulado',
    immediateFeedback: false,
    durationMin: attempt.duration_min,
    remainingSec: attempt.remaining_sec,
    answers,
    answer: saveAnswer,
    onFinish: () => finish(),
    onTimeUp: () => {
      toast('Tempo esgotado. Estamos calculando o seu resultado.', { type: 'warning' });
      finish();
    },
  });

  const leave = qs('[data-action="leave"]', page.el);
  if (leave) leave.addEventListener('click', leaveSimulado);
}

async function saveAnswer(questionId, optionId) {
  const result = await api.patch(`/api/simulados/attempts/${attempt.id}/answers`, {
    question_id: questionId,
    option_id: optionId || null,
  });
  if (optionId) answers[questionId] = optionId;
  else delete answers[questionId];
  return result;
}

async function leaveSimulado() {
  const ok = await confirm({
    title: 'Sair do simulado',
    message: 'O cronômetro continua correndo e suas respostas ficam salvas. Você pode voltar pela tela de simulados.',
    confirmText: 'Sair',
    icon: 'log-out',
  });
  if (ok) page.navigate('/app/simulados');
}

async function finish() {
  if (finishing) return;
  finishing = true;
  const host = qs('#sim-runner', page.el);
  if (host) renderTo(host, html`<div class="sim-run-finishing">${skeleton('block', 220)}<p class="text-2 text-center">Corrigindo o simulado…</p></div>`);
  try {
    await api.post(`/api/simulados/attempts/${attempt.id}/finish`, {});
    page.navigate(`/app/simulados/${attempt.id}/resultado`, { replace: true });
  } catch (err) {
    finishing = false;
    if (err && err.status === 409) {
      // já finalizado em outra aba: segue para o resultado
      page.navigate(`/app/simulados/${attempt.id}/resultado`, { replace: true });
      return;
    }
    toast(err.message || 'Não foi possível finalizar o simulado.', { type: 'error' });
    paint();
  }
}

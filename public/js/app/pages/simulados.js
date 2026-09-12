// =====================================================================
// /app/simulados — tipos de simulado, modelos do administrador, histórico
// e evolução das notas. Consome GET /api/simulados e POST /api/simulados/attempts.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, render as renderTo, toast, modal, confirm, pageHeader, emptyState, errorState,
  skeleton, badge, statCard, qs, qsa, on,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDateShort, fmtDateTime, fmtMinutes, fmtDuration, fmtScore, pluralize } from '../../core/format.js';
import { lineChart, destroyChart, palette } from '../../core/charts.js';

const TYPE_CARDS = [
  {
    type: 'exam',
    icon: 'target',
    title: 'Simulado da minha prova',
    text: 'Questões sorteadas com o peso de cada matéria da sua prova, no formato do dia oficial.',
  },
  {
    type: 'subject',
    icon: 'library',
    title: 'Por matéria',
    text: 'Concentre o treino em uma matéria específica e meça a acurácia dela.',
  },
  {
    type: 'topic',
    icon: 'list-tree',
    title: 'Por assunto',
    text: 'Fecha o foco em um único assunto — ideal depois de estudar a aula.',
  },
  {
    type: 'custom',
    icon: 'sliders-horizontal',
    title: 'Personalizado',
    text: 'Você escolhe as matérias, a dificuldade, a quantidade de questões e o tempo.',
  },
];

const DIFFICULTIES = [
  { value: 1, label: 'Básico' },
  { value: 2, label: 'Intermediário' },
  { value: 3, label: 'Avançado' },
];

let page = null;
let data = null;
let chartEl = null;
let offClick = null;

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------
export default async function renderPage(ctx) {
  page = ctx;
  ctx.setTitle('Simulados');
  renderTo(ctx.el, skeleton('page'));
  await load();
}

export function unmount() {
  if (chartEl) destroyChart(chartEl);
  chartEl = null;
  if (offClick) offClick();
  offClick = null;
  data = null;
  page = null;
}

async function load() {
  try {
    data = await api.get('/api/simulados');
  } catch (err) {
    showError(err);
    return;
  }
  paint();
}

function showError(err) {
  if (!page) return;
  renderTo(
    page.el,
    html`${pageHeader({ title: 'Simulados' })}
      ${errorState({
        title: 'Não foi possível carregar os simulados',
        message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
      })}`
  );
  const btn = qs('[data-action="retry"]', page.el);
  if (btn) btn.addEventListener('click', () => load());
}

// ---------------------------------------------------------------------
// Blocos da página
// ---------------------------------------------------------------------
function statsBlock() {
  const s = data.stats || {};
  const accuracy = s.total_questions > 0 ? Math.round((100 * s.total_correct) / s.total_questions) : null;
  return html`
    <div class="grid grid-4 mb-6">
      ${statCard({ label: 'Simulados feitos', value: s.count || 0, icon: 'target' })}
      ${statCard({ label: 'Nota média', value: s.avg_score === null || s.avg_score === undefined ? '—' : fmtScore(s.avg_score), unit: s.avg_score === null ? '' : '/100', icon: 'chart-line', tone: 'blue' })}
      ${statCard({ label: 'Melhor nota', value: s.best_score === null || s.best_score === undefined ? '—' : fmtScore(s.best_score), unit: s.best_score === null ? '' : '/100', icon: 'trophy', tone: 'green' })}
      ${statCard({
        label: 'Acertos acumulados',
        value: s.total_questions ? `${s.total_correct}/${s.total_questions}` : '—',
        hint: accuracy === null ? 'Faça um simulado para começar' : `${accuracy}% de acerto`,
        icon: 'circle-check',
        tone: 'green',
      })}
    </div>`;
}

function inProgressBlock() {
  const attempt = data.in_progress;
  if (!attempt) return '';
  const remaining = Number(attempt.remaining_sec) || 0;
  return html`
    <div class="card sim-resume mb-6">
      <div class="card-body sim-resume-body">
        <span class="icon-box orange">${icon('hourglass')}</span>
        <div class="sim-resume-main">
          <h2 class="card-title">Simulado em andamento</h2>
          <p class="text-2 m-0">
            ${attempt.title} · ${pluralize(attempt.question_count, 'questão', 'questões')} ·
            ${remaining > 0 ? html`restam ${fmtDuration(remaining)}` : 'tempo esgotado'}
          </p>
        </div>
        <div class="sim-resume-actions">
          <button type="button" class="btn btn-ghost" data-action="abandon" data-id="${attempt.id}">Descartar</button>
          <a class="btn btn-primary" href="/app/simulados/${attempt.id}">${icon('play')}<span>Continuar</span></a>
        </div>
      </div>
    </div>`;
}

function typeCardsBlock() {
  const exam = data.exam;
  return html`
    <section class="mb-6">
      <h2 class="section-title">Começar um simulado</h2>
      <div class="grid grid-4 sim-types">
        ${TYPE_CARDS.map((card) => {
          const isExam = card.type === 'exam';
          const disabled = isExam && (!exam || !exam.available_count);
          const hint = isExam && exam
            ? `${exam.short_name} · ${pluralize(exam.available_count || 0, 'questão disponível', 'questões disponíveis')}`
            : '';
          return html`
            <button type="button" class="card card-hover sim-type" data-action="config" data-type="${card.type}" ${disabled ? 'disabled' : ''}>
              <span class="icon-box">${icon(card.icon)}</span>
              <span class="sim-type-title">${card.title}</span>
              <span class="sim-type-text">${card.text}</span>
              ${hint ? html`<span class="sim-type-hint">${hint}</span>` : ''}
              ${disabled ? html`<span class="sim-type-hint">Escolha sua prova no perfil para liberar</span>` : ''}
            </button>`;
        })}
      </div>
    </section>`;
}

function templatesBlock() {
  const templates = data.templates || [];
  if (!templates.length) return '';
  return html`
    <section class="mb-6">
      <h2 class="section-title">Modelos prontos</h2>
      <div class="grid grid-2 sim-templates">
        ${templates.map(
          (t) => html`
            <article class="card sim-template">
              <div class="card-body">
                <div class="sim-template-top">
                  ${badge(t.type_label || 'Simulado', 'blue')}
                  ${t.exam_short_name ? badge(t.exam_short_name, 'gray') : ''}
                  ${t.subject_name ? badge(t.subject_name, 'gray') : ''}
                </div>
                <h3 class="card-title">${t.name}</h3>
                ${t.description ? html`<p class="text-2 clamp-3">${t.description}</p>` : ''}
                <div class="meta sim-template-meta">
                  <span>${icon('list-checks', { size: 14 })}${pluralize(t.question_count || 0, 'questão', 'questões')}</span>
                  <span>${icon('clock', { size: 14 })}${fmtMinutes(t.duration_min)}</span>
                </div>
                <div class="sim-template-actions">
                  ${t.can_start
                    ? html`<button type="button" class="btn btn-primary btn-sm" data-action="start-template" data-id="${t.id}">${icon('play')}<span>Iniciar</span></button>`
                    : html`<span class="text-3 text-sm">Sem questões suficientes no banco</span>`}
                </div>
              </div>
            </article>`
        )}
      </div>
    </section>`;
}

function chartBlock() {
  const finished = (data.history || []).filter((a) => a.status === 'finished' && a.score !== null);
  if (finished.length < 2) return '';
  return html`
    <section class="card mb-6">
      <div class="card-header"><h2 class="card-title">Evolução das notas</h2></div>
      <div class="card-body">
        <div class="sim-chart"><canvas id="sim-scores" aria-label="Notas dos simulados finalizados"></canvas></div>
      </div>
    </section>`;
}

function historyBlock() {
  const history = data.history || [];
  if (!history.length) {
    return html`
      <section class="card">
        <div class="card-body">
          ${emptyState({
            icon: 'target',
            title: 'Você ainda não fez simulados',
            text: 'Escolha um dos tipos acima para medir seu desempenho e alimentar o caderno de erros.',
          })}
        </div>
      </section>`;
  }
  return html`
    <section class="card">
      <div class="card-header"><h2 class="card-title">Histórico</h2><span class="text-3 text-sm">${pluralize(history.length, 'simulado', 'simulados')}</span></div>
      <div class="table-wrap">
        <table class="table sim-history">
          <thead>
            <tr>
              <th>Simulado</th><th>Data</th><th>Nota</th><th>Acertos</th><th>Tempo</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${history.map((a) => {
              const done = a.status === 'finished';
              return html`
                <tr>
                  <td>
                    <div class="sim-history-title">${a.title}</div>
                    <div class="text-3 text-xs">${a.exam_short_name || a.subject_name || a.topic_name || ''}</div>
                  </td>
                  <td class="nowrap">${fmtDateTime(a.started_at)}</td>
                  <td>${done ? html`<strong class="sim-history-score">${fmtScore(a.score)}</strong>` : badge('Em andamento', 'orange')}</td>
                  <td class="nowrap">${done ? html`${a.correct_count}/${a.question_count}` : '—'}</td>
                  <td class="nowrap">${done ? fmtDuration(a.time_spent_sec) : '—'}</td>
                  <td class="text-right">
                    ${done
                      ? html`<a class="btn btn-ghost btn-sm" href="/app/simulados/${a.id}/resultado">Ver resultado</a>`
                      : html`<a class="btn btn-secondary btn-sm" href="/app/simulados/${a.id}">Continuar</a>`}
                  </td>
                </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </section>`;
}

function paint() {
  if (!page) return;
  if (chartEl) destroyChart(chartEl);
  chartEl = null;

  renderTo(
    page.el,
    html`
      ${pageHeader({
        title: 'Simulados',
        subtitle: 'Treine no formato da prova, acompanhe a nota e transforme os erros em revisão.',
        actions: html`<button type="button" class="btn btn-primary" data-action="config" data-type="custom">${icon('plus')}<span>Novo simulado</span></button>`,
      })}
      ${inProgressBlock()}
      ${statsBlock()}
      ${typeCardsBlock()}
      ${templatesBlock()}
      ${chartBlock()}
      ${historyBlock()}`
  );

  drawChart();
  bind();
}

function drawChart() {
  const canvas = qs('#sim-scores', page.el);
  if (!canvas) return;
  const finished = (data.history || []).filter((a) => a.status === 'finished' && a.score !== null).slice().reverse();
  chartEl = canvas;
  lineChart(canvas, {
    labels: finished.map((a) => fmtDateShort(a.finished_at || a.started_at)),
    datasets: [
      {
        label: 'Nota',
        data: finished.map((a) => Number(a.score)),
        borderColor: palette.primary2,
        fill: true,
      },
    ],
    options: { scales: { y: { min: 0, max: 100, ticks: { callback: (v) => `${v}` } } } },
  });
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
function bind() {
  if (offClick) offClick();
  offClick = on(page.el, 'click', '[data-action]', (event, trigger) => {
    const action = trigger.dataset.action;
    if (action === 'config') openConfig(trigger.dataset.type);
    else if (action === 'start-template') startAttempt({ simulado_id: trigger.dataset.id }, trigger);
    else if (action === 'abandon') abandon(trigger.dataset.id);
  });
}

async function abandon(id) {
  const ok = await confirm({
    title: 'Descartar simulado',
    message: 'O simulado em andamento será descartado e não entrará no seu histórico. Deseja continuar?',
    danger: true,
    confirmText: 'Descartar',
  });
  if (!ok) return;
  try {
    await api.post(`/api/simulados/attempts/${id}/abandon`, {});
    toast('Simulado descartado.', { type: 'success' });
    await load();
  } catch (err) {
    toast(err.message || 'Não foi possível descartar o simulado.', { type: 'error' });
  }
}

async function startAttempt(body, button) {
  if (button) button.disabled = true;
  try {
    const attempt = await api.post('/api/simulados/attempts', body);
    page.navigate(`/app/simulados/${attempt.id}`);
    return true;
  } catch (err) {
    toast(err.message || 'Não foi possível montar o simulado.', { type: 'error' });
    if (button) button.disabled = false;
    return false;
  }
}

// ---------------------------------------------------------------------
// Modal de configuração
// ---------------------------------------------------------------------
function subjectOptions(selected = '') {
  // Matéria sem questão no banco continua na lista: o que faltar é elaborado
  // na hora. Escondê-la deixaria o aluno sem opção enquanto o banco cresce.
  return (data.catalog.subjects || []).map(
    (s) => html`<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>
        ${s.name}${s.question_count ? ` (${s.question_count})` : ''}
      </option>`
  );
}

/** Formatos do simulado da prova: completo, mini ou o que o aluno montar. */
function modeField(defaults) {
  const modes = (data.defaults && data.defaults.modes) || [];
  if (!modes.length) return '';
  return html`
    <div class="field">
      <span class="label">Formato</span>
      <div class="sim-modes" role="radiogroup" aria-label="Formato do simulado">
        ${modes.map(
          (m) => html`
            <button type="button" class="sim-mode" role="radio" aria-checked="false"
                    data-action="mode" data-mode="${m.key}"
                    data-count="${m.question_count}" data-duration="${m.duration_min}">
              <span class="sim-mode-label">${m.label}</span>
              <span class="sim-mode-text">${m.question_count} questões · ${fmtMinutes(m.duration_min)}</span>
            </button>`
        )}
        <button type="button" class="sim-mode is-active" role="radio" aria-checked="true"
                data-action="mode" data-mode=""
                data-count="${defaults.question_count}" data-duration="${defaults.duration_min}">
          <span class="sim-mode-label">Do meu jeito</span>
          <span class="sim-mode-text">Você escolhe quantas e por quanto tempo</span>
        </button>
      </div>
      <input type="hidden" name="mode" value="">
    </div>`;
}

function countAndTimeFields(defaults, max) {
  return html`
    <div class="grid grid-2">
      <div class="field">
        <label class="label" for="sim-count">Número de questões</label>
        <input class="input" type="number" id="sim-count" name="question_count" min="1" max="${max.question_count}" value="${defaults.question_count}" inputmode="numeric">
        <span class="hint">De 1 a ${max.question_count} questões.</span>
      </div>
      <div class="field">
        <label class="label" for="sim-duration">Tempo (minutos)</label>
        <input class="input" type="number" id="sim-duration" name="duration_min" min="5" max="${max.duration_min}" value="${defaults.duration_min}" inputmode="numeric">
        <span class="hint">De 5 a ${max.duration_min} minutos.</span>
      </div>
    </div>`;
}

function openConfig(type) {
  const defaults = (data.defaults && data.defaults[type]) || { question_count: 20, duration_min: 30 };
  const max = (data.defaults && data.defaults.max) || { question_count: 90, duration_min: 180 };
  const card = TYPE_CARDS.find((c) => c.type === type) || TYPE_CARDS[3];
  const exam = data.exam;

  let body;
  if (type === 'exam') {
    body = html`
      <div class="field">
        <label class="label" for="sim-exam">Prova</label>
        <select class="select" id="sim-exam" name="exam_id">
          ${(data.catalog.exams || []).map((e) => html`<option value="${e.id}" ${exam && e.id === exam.id ? 'selected' : ''}>${e.name}</option>`)}
        </select>
        <span class="hint">As questões são distribuídas pelo peso de cada matéria na prova.</span>
      </div>
      ${modeField(defaults)}
      ${countAndTimeFields(defaults, max)}`;
  } else if (type === 'subject') {
    body = html`
      <div class="field">
        <label class="label" for="sim-subject">Matéria</label>
        <select class="select" id="sim-subject" name="subject_id">
          <option value="">Selecione uma matéria</option>
          ${subjectOptions()}
        </select>
      </div>
      ${countAndTimeFields(defaults, max)}`;
  } else if (type === 'topic') {
    body = html`
      <div class="field">
        <label class="label" for="sim-subject">Matéria</label>
        <select class="select" id="sim-subject" name="subject_id">
          <option value="">Selecione uma matéria</option>
          ${subjectOptions()}
        </select>
      </div>
      <div class="field">
        <label class="label" for="sim-topic">Assunto</label>
        <select class="select" id="sim-topic" name="topic_id" disabled>
          <option value="">Escolha a matéria primeiro</option>
        </select>
      </div>
      ${countAndTimeFields(defaults, max)}`;
  } else {
    body = html`
      <div class="field">
        <label class="label" for="sim-exam">Prova (opcional)</label>
        <select class="select" id="sim-exam" name="exam_id">
          <option value="">Todas as questões do banco</option>
          ${(data.catalog.exams || []).map((e) => html`<option value="${e.id}" ${exam && e.id === exam.id ? 'selected' : ''}>${e.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <span class="label">Matérias</span>
        <div class="sim-check-grid" role="group" aria-label="Matérias do simulado">
          ${(data.catalog.subjects || [])
            .filter((s) => s.question_count > 0)
            .map(
              (s) => html`
                <label class="check">
                  <input type="checkbox" name="subject_ids" value="${s.id}">
                  <span>${s.name}</span>
                </label>`
            )}
        </div>
        <span class="hint">Sem seleção, o simulado usa todas as matérias disponíveis.</span>
      </div>
      <div class="field">
        <span class="label">Dificuldade</span>
        <div class="check-group inline">
          ${DIFFICULTIES.map(
            (d) => html`
              <label class="check">
                <input type="checkbox" name="difficulty" value="${d.value}">
                <span>${d.label}</span>
              </label>`
          )}
        </div>
      </div>
      ${countAndTimeFields(defaults, max)}`;
  }

  const dialog = modal({
    title: card.title,
    subtitle: card.text,
    body,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Iniciar simulado',
        variant: 'primary',
        icon: 'play',
        onClick: async () => {
          const payload = readConfig(type, dialog.body);
          if (!payload) return false;
          const started = await startAttempt(payload);
          return started ? undefined : false;
        },
      },
    ],
  });

  if (type === 'topic') bindTopicChain(dialog.body);
  if (type === 'exam') bindModes(dialog.body);
}

/** Um formato escolhido preenche quantidade e tempo; mexer nos campos volta para "Do meu jeito". */
function bindModes(root) {
  const hidden = qs('[name="mode"]', root);
  const count = qs('[name="question_count"]', root);
  const duration = qs('[name="duration_min"]', root);
  const buttons = qsa('[data-action="mode"]', root);
  if (!hidden || !buttons.length) return;

  const marcar = (chosen) => {
    for (const button of buttons) {
      const active = button === chosen;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      hidden.value = button.dataset.mode || '';
      if (count) count.value = button.dataset.count;
      if (duration) duration.value = button.dataset.duration;
      marcar(button);
    });
  }

  const solta = () => {
    hidden.value = '';
    marcar(buttons[buttons.length - 1]);
  };
  if (count) count.addEventListener('input', solta);
  if (duration) duration.addEventListener('input', solta);
}

async function bindTopicChain(root) {
  const subject = qs('[name="subject_id"]', root);
  const topic = qs('[name="topic_id"]', root);
  if (!subject || !topic) return;
  subject.addEventListener('change', async () => {
    const id = subject.value;
    topic.disabled = true;
    topic.innerHTML = '<option value="">Carregando assuntos…</option>';
    if (!id) {
      topic.innerHTML = '<option value="">Escolha a matéria primeiro</option>';
      return;
    }
    try {
      const result = await api.get('/api/simulados/catalog', { query: { subject_id: id } });
      const topics = (result.topics || []).filter((t) => t.question_count > 0);
      if (!topics.length) {
        topic.innerHTML = '<option value="">Nenhum assunto com questões nesta matéria</option>';
        return;
      }
      topic.innerHTML = String(
        html`<option value="">Selecione um assunto</option>
          ${topics.map((t) => html`<option value="${t.id}">${t.name} (${t.question_count})</option>`)}`
      );
      topic.disabled = false;
    } catch (err) {
      topic.innerHTML = '<option value="">Não foi possível carregar os assuntos</option>';
      toast(err.message || 'Não foi possível carregar os assuntos.', { type: 'error' });
    }
  });
}

function readConfig(type, root) {
  const num = (name) => {
    const el = qs(`[name="${name}"]`, root);
    const value = el ? Number(el.value) : NaN;
    return Number.isFinite(value) ? Math.round(value) : null;
  };
  const questionCount = num('question_count');
  const durationMin = num('duration_min');
  if (!questionCount || questionCount < 1) {
    toast('Informe quantas questões o simulado deve ter.', { type: 'warning' });
    return null;
  }
  if (!durationMin || durationMin < 5) {
    toast('Informe o tempo do simulado (mínimo de 5 minutos).', { type: 'warning' });
    return null;
  }

  const payload = { type, question_count: questionCount, duration_min: durationMin };

  if (type === 'exam') {
    const examId = qs('[name="exam_id"]', root).value;
    if (!examId) {
      toast('Escolha a prova do simulado.', { type: 'warning' });
      return null;
    }
    payload.exam_id = examId;
    const mode = qs('[name="mode"]', root);
    if (mode && mode.value) payload.mode = mode.value;
  }

  if (type === 'subject' || type === 'topic') {
    const subjectId = qs('[name="subject_id"]', root).value;
    if (!subjectId) {
      toast('Escolha a matéria do simulado.', { type: 'warning' });
      return null;
    }
    payload.subject_id = subjectId;
  }

  if (type === 'topic') {
    const topicId = qs('[name="topic_id"]', root).value;
    if (!topicId) {
      toast('Escolha o assunto do simulado.', { type: 'warning' });
      return null;
    }
    payload.topic_id = topicId;
  }

  if (type === 'custom') {
    const filters = {};
    const examId = qs('[name="exam_id"]', root).value;
    if (examId) filters.exam_id = examId;
    const subjectIds = qsa('[name="subject_ids"]:checked', root).map((el) => el.value);
    if (subjectIds.length) filters.subject_ids = subjectIds;
    const difficulty = qsa('[name="difficulty"]:checked', root).map((el) => Number(el.value));
    if (difficulty.length) filters.difficulty = difficulty;
    if (Object.keys(filters).length) payload.filters = filters;
  }

  return payload;
}

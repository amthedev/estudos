// =====================================================================
// Foco Elite — assistente de onboarding (ARCHITECTURE §6.4, rota bare)
//
// Cinco etapas: prova → disponibilidade → nível e dificuldade → dados da
// trilha → resumo. As respostas ficam em memória, então voltar uma etapa
// preserva tudo o que já foi preenchido. Cada etapa valida antes de avançar.
//
// Ao concluir: POST /api/onboarding → perfil salvo, cronograma gerado e uma
// tela curta de sucesso com a primeira atividade antes de seguir para /app.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, render, toast, qs, qsa, on, setLoading,
  skeleton, errorState, progressBar, fieldError, clearFieldErrors,
} from '../../core/ui.js';
import { icon, activityIcon } from '../../core/icons.js';
import { fmtDate, fmtHours, fmtMinutes, fmtStudyDays, weekdayName, difficultyLabel, activityLabel } from '../../core/format.js';

// As três trilhas são estruturais (a coluna `track` da prova). Nome e descrição
// vêm do vestibular cadastrado no painel: se a equipe renomear o ENEM ou trocar
// o texto do Barro Branco, o onboarding acompanha sem mexer no código.
const TRACKS = [
  { id: 'enem', icon: 'graduation-cap', fallbackTitle: 'ENEM' },
  { id: 'barro_branco', icon: 'shield', fallbackTitle: 'Academia do Barro Branco' },
  { id: 'vestibular', icon: 'school', fallbackTitle: 'Outros vestibulares' },
];

/** Título e descrição de uma trilha a partir das provas cadastradas. */
function trackInfo(track) {
  const exams = state.exams.filter((exam) => exam.track === track.id);

  if (track.id === 'vestibular') {
    const names = exams.map((exam) => exam.short_name || exam.name).filter(Boolean);
    return {
      title: 'Outros vestibulares',
      description: names.length
        ? `${names.slice(0, 4).join(', ')}${names.length > 4 ? ' e outros' : ''}.`
        : 'Escolha o vestibular que você vai prestar.',
      available: true,
    };
  }

  const exam = exams[0] || null;
  return {
    title: exam ? exam.name : track.fallbackTitle,
    description: exam && exam.description ? exam.description : '',
    available: Boolean(exam),
  };
}

const LEVELS = [
  { id: 'iniciante', title: 'Iniciante', description: 'Estou começando agora ou revendo a base.' },
  { id: 'intermediario', title: 'Intermediário', description: 'Já estudei boa parte do conteúdo.' },
  { id: 'avancado', title: 'Avançado', description: 'Estou na reta final, focando em revisão e prova.' },
];

const STEPS = [
  { id: 'exam', label: 'Prova', title: 'Para qual prova você deseja estudar?', subtitle: 'Seu cronograma é montado a partir do conteúdo programático dessa prova.' },
  { id: 'availability', label: 'Rotina', title: 'Quando você consegue estudar?', subtitle: 'Escolha os dias da semana e quanto tempo você tem por dia.' },
  { id: 'level', label: 'Nível', title: 'Como estão seus estudos hoje?', subtitle: 'Isso define o ponto de partida e o peso das revisões.' },
  { id: 'details', label: 'Objetivo', title: 'Qual é o seu objetivo?', subtitle: 'Essas informações aparecem no seu painel e ajustam a intensidade do plano.' },
  { id: 'summary', label: 'Resumo', title: 'Confira suas respostas', subtitle: 'Você pode ajustar tudo depois no seu perfil.' },
];

const OTHER_VALUE = '__other__';
const MIN_HOURS = 0.5;
const MAX_HOURS = 12;
const REDIRECT_DELAY_MS = 6000;

let state = null;

const clampHours = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 2;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(number * 2) / 2));
};

const trimmed = (value) => String(value ?? '').trim();

/** Respostas iniciais, reaproveitando o que o aluno já tiver no perfil. */
function initialAnswers(profile) {
  const p = profile || {};
  const days = Array.isArray(p.study_days) && p.study_days.length ? p.study_days.map(Number) : [1, 2, 3, 4, 5];
  return {
    track: null,
    exam_id: p.exam_id || null,
    other_exam_name: p.other_exam_name || '',
    study_days: days,
    hours_per_day: clampHours(p.hours_per_day || 2),
    level: p.level || '',
    weakest_subject_id: p.weakest_subject_id || null,
    exam_date: p.exam_date || '',
    target_course: p.target_course || '',
    target_university: p.target_university || '',
    target_score: p.target_score || '',
    main_difficulty: p.main_difficulty || '',
    performance_goal: p.performance_goal || '',
  };
}

const currentExam = () => (state.answers.exam_id ? state.exams.find((exam) => exam.id === state.answers.exam_id) || null : null);

/** Trilha efetiva: a escolhida na etapa 1 ou a da prova já selecionada. */
function effectiveTrack() {
  if (state.answers.track) return state.answers.track;
  const exam = currentExam();
  return exam ? exam.track : 'vestibular';
}

// ---------------------------------------------------------------------
// Etapas — marcação
// ---------------------------------------------------------------------

function stepExam() {
  const { answers } = state;
  const vestibulares = state.exams.filter((exam) => exam.track === 'vestibular');
  const exam = currentExam();
  const trackMissing = answers.track && answers.track !== 'vestibular' && !exam;
  return html`
    <div class="onb-tracks">
      ${TRACKS.map((track) => {
        const active = answers.track === track.id;
        const info = trackInfo(track);
        return html`
          <button type="button" class="onb-track ${active ? 'is-active' : ''} ${info.available ? '' : 'is-unavailable'}"
                  data-action="track" data-track="${track.id}" aria-pressed="${active ? 'true' : 'false'}">
            <span class="onb-track-icon">${icon(track.icon)}</span>
            <span class="onb-track-title">${info.title}</span>
            ${info.description ? html`<span class="onb-track-desc">${info.description}</span>` : ''}
            ${info.available ? '' : html`<span class="onb-track-tag">Em breve</span>`}
          </button>`;
      })}
    </div>
    <p class="error-text" data-error-for="exam_id"></p>
    ${trackMissing
      ? html`<p class="onb-note is-warning">${icon('triangle-alert', { size: 14 })}<span>Esta prova ainda não está cadastrada. Escolha "Outros vestibulares" e digite o nome.</span></p>`
      : ''}
    ${answers.track === 'vestibular'
      ? html`
        <div class="onb-fields mt-5">
          <div class="field">
            <label class="label" for="onb-exam">Qual vestibular?</label>
            <select class="select" id="onb-exam" name="exam_id" data-exam-select>
              <option value="">Selecione…</option>
              ${vestibulares.map((item) => html`
                <option value="${item.id}" ${answers.exam_id === item.id ? raw('selected') : ''}>${item.name}</option>`)}
              <option value="${OTHER_VALUE}" ${state.otherExam ? raw('selected') : ''}>Outro (digitar)</option>
            </select>
          </div>
          ${state.otherExam
            ? html`
              <div class="field">
                <label class="label" for="onb-other">Nome do vestibular</label>
                <input class="input" id="onb-other" name="other_exam_name" type="text" maxlength="120"
                  placeholder="Ex.: Vestibular da UFPR" value="${answers.other_exam_name}" autocomplete="off">
                <p class="error-text" data-error-for="other_exam_name"></p>
              </div>`
            : ''}
        </div>`
      : ''}
    ${exam && exam.exam_date
      ? html`<p class="onb-note">${icon('calendar-days', { size: 14 })}<span>Data prevista da prova: ${fmtDate(exam.exam_date)}</span></p>`
      : ''}`;
}

function stepAvailability() {
  const { answers } = state;
  const hours = clampHours(answers.hours_per_day);
  const fill = ((hours - MIN_HOURS) / (MAX_HOURS - MIN_HOURS)) * 100;
  return html`
    <div class="field">
      <span class="label">Dias da semana</span>
      <div class="pill-group onb-days" role="group" aria-label="Dias de estudo">
        ${[1, 2, 3, 4, 5, 6, 0].map((day) => html`
          <label class="pill">
            <input type="checkbox" name="study_days" value="${day}" ${answers.study_days.includes(day) ? raw('checked') : ''}>
            <span>${weekdayName(day, { short: true })}</span>
          </label>`)}
      </div>
      <p class="hint">Escolha ao menos um dia. Dias de folga também fazem parte do método.</p>
      <p class="error-text" data-error-for="study_days"></p>
    </div>

    <div class="field">
      <label class="label" for="onb-hours">Horas de estudo por dia</label>
      <div class="range-row">
        <input class="range" id="onb-hours" name="hours_per_day" type="range"
          min="${MIN_HOURS}" max="${MAX_HOURS}" step="0.5" value="${hours}"
          style="--range-fill:${fill.toFixed(1)}%"
          aria-describedby="onb-hours-value">
        <output class="range-value" id="onb-hours-value" data-hours-value>${fmtHours(hours)}</output>
      </div>
      <p class="hint" data-week-total>Total previsto: ${fmtHours(hours * answers.study_days.length)} por semana.</p>
    </div>`;
}

function stepLevel() {
  const { answers } = state;
  return html`
    <div class="field">
      <span class="label">Seu nível atual</span>
      <div class="choice-grid onb-levels">
        ${LEVELS.map((level) => html`
          <label class="choice">
            <input type="radio" name="level" value="${level.id}" ${answers.level === level.id ? raw('checked') : ''}>
            <span class="choice-icon">${icon('gauge')}</span>
            <span class="choice-body">
              <span class="choice-title">${level.title}</span>
              <span class="choice-desc">${level.description}</span>
            </span>
          </label>`)}
      </div>
      <p class="error-text" data-error-for="level"></p>
    </div>

    <div class="field">
      <label class="label" for="onb-weakest">Matéria com mais dificuldade</label>
      ${state.subjects.length
        ? html`
          <select class="select" id="onb-weakest" name="weakest_subject_id">
            <option value="">Prefiro não indicar</option>
            ${state.subjects.map((subject) => html`
              <option value="${subject.id}" ${answers.weakest_subject_id === subject.id ? raw('selected') : ''}>${subject.name}</option>`)}
          </select>
          <p class="hint">Essa matéria ganha prioridade no cronograma.</p>`
        : html`<p class="hint">${state.subjectsError
            ? 'Não foi possível carregar as matérias desta prova. Você pode indicar isso depois no perfil.'
            : 'As matérias desta prova ainda não estão cadastradas. Você pode indicar isso depois no perfil.'}</p>`}
    </div>`;
}

function stepDetails() {
  const { answers } = state;
  const track = effectiveTrack();
  const exam = currentExam();
  const examName = exam ? exam.short_name || exam.name : answers.other_exam_name || 'sua prova';

  const dateField = (label, hint) => html`
    <div class="field">
      <label class="label" for="onb-date">${label}</label>
      <input class="input" id="onb-date" name="exam_date" type="date" value="${answers.exam_date || ''}">
      <p class="hint">${hint}</p>
      <p class="error-text" data-error-for="exam_date"></p>
    </div>`;

  const textField = (name, label, placeholder, maxlength = 160) => html`
    <div class="field">
      <label class="label" for="onb-${name}">${label}</label>
      <input class="input" id="onb-${name}" name="${name}" type="text" maxlength="${maxlength}"
        placeholder="${placeholder}" value="${answers[name] || ''}" autocomplete="off">
      <p class="error-text" data-error-for="${name}"></p>
    </div>`;

  let fields;
  if (track === 'enem') {
    fields = html`
      ${textField('target_course', 'Curso que você quer', 'Ex.: Medicina')}
      ${textField('target_university', 'Universidade dos seus sonhos', 'Ex.: USP')}
      ${textField('target_score', 'Nota desejada', 'Ex.: 800 pontos', 60)}
      ${dateField('Data da prova', `Pré-preenchida com a data prevista do ${examName}.`)}`;
  } else if (track === 'barro_branco') {
    fields = html`
      ${textField('main_difficulty', 'Sua maior dificuldade hoje', 'Ex.: Matemática e Legislação', 200)}
      ${textField('performance_goal', 'Meta de desempenho', 'Ex.: acertar 80% da prova objetiva', 200)}
      ${dateField('Data prevista da prova', `Pré-preenchida com a data prevista do ${examName}.`)}`;
  } else {
    fields = html`
      ${textField('target_university', 'Universidade', 'Ex.: UNICAMP')}
      ${textField('target_course', 'Curso pretendido', 'Ex.: Engenharia Civil')}
      ${dateField('Data da prova', `Pré-preenchida com a data prevista do ${examName}.`)}`;
  }
  return html`<div class="onb-fields">${fields}</div>`;
}

function summaryRow(label, value) {
  return html`
    <div class="onb-summary-row">
      <dt>${label}</dt>
      <dd>${value || '—'}</dd>
    </div>`;
}

function stepSummary() {
  const { answers } = state;
  const exam = currentExam();
  const track = effectiveTrack();
  const subject = state.subjects.find((item) => item.id === answers.weakest_subject_id);
  const weekMinutes = Math.round(answers.hours_per_day * answers.study_days.length * 60);

  const specific = [];
  if (track === 'enem') {
    specific.push(['Curso pretendido', answers.target_course]);
    specific.push(['Universidade', answers.target_university]);
    specific.push(['Nota desejada', answers.target_score]);
  } else if (track === 'barro_branco') {
    specific.push(['Maior dificuldade', answers.main_difficulty]);
    specific.push(['Meta de desempenho', answers.performance_goal]);
  } else {
    specific.push(['Universidade', answers.target_university]);
    specific.push(['Curso pretendido', answers.target_course]);
  }

  return html`
    <dl class="onb-summary">
      ${summaryRow('Prova', exam ? exam.name : answers.other_exam_name)}
      ${summaryRow('Data da prova', answers.exam_date ? fmtDate(answers.exam_date) : '')}
      ${summaryRow('Dias de estudo', fmtStudyDays(answers.study_days, { short: false }))}
      ${summaryRow('Tempo por dia', fmtHours(answers.hours_per_day))}
      ${summaryRow('Total semanal', fmtMinutes(weekMinutes, { long: true }))}
      ${summaryRow('Nível', difficultyLabel(answers.level))}
      ${summaryRow('Matéria com mais dificuldade', subject ? subject.name : '')}
      ${specific.map(([label, value]) => summaryRow(label, value))}
    </dl>
    <p class="onb-note">${icon('info', { size: 14 })}<span>Vamos montar as próximas duas semanas de estudo. O cronograma se adapta conforme o seu desempenho.</span></p>`;
}

const STEP_VIEWS = {
  exam: stepExam,
  availability: stepAvailability,
  level: stepLevel,
  details: stepDetails,
  summary: stepSummary,
};

// ---------------------------------------------------------------------
// Coleta e validação por etapa
// ---------------------------------------------------------------------

function readField(root, name) {
  const el = qs(`[name="${CSS.escape(name)}"]`, root);
  return el ? trimmed(el.value) : '';
}

/** Copia o que está na tela para `state.answers` (chamado ao sair da etapa). */
function collectStep(root) {
  const { answers } = state;
  const step = STEPS[state.step].id;
  if (step === 'exam') {
    const select = qs('[data-exam-select]', root);
    if (select) {
      if (select.value === OTHER_VALUE) {
        state.otherExam = true;
        answers.exam_id = null;
        answers.other_exam_name = readField(root, 'other_exam_name');
      } else {
        state.otherExam = false;
        answers.exam_id = select.value || null;
        answers.other_exam_name = '';
      }
    }
  } else if (step === 'availability') {
    const days = qsa('[name="study_days"]:checked', root).map((el) => Number(el.value));
    answers.study_days = days.sort((a, b) => a - b);
    const hours = qs('[name="hours_per_day"]', root);
    if (hours) answers.hours_per_day = clampHours(hours.value);
  } else if (step === 'level') {
    const level = qs('[name="level"]:checked', root);
    answers.level = level ? level.value : '';
    const weakest = qs('[name="weakest_subject_id"]', root);
    if (weakest) answers.weakest_subject_id = weakest.value || null;
  } else if (step === 'details') {
    ['target_course', 'target_university', 'target_score', 'main_difficulty', 'performance_goal'].forEach((name) => {
      const el = qs(`[name="${name}"]`, root);
      if (el) answers[name] = trimmed(el.value);
    });
    const date = qs('[name="exam_date"]', root);
    if (date) answers.exam_date = trimmed(date.value);
  }
}

/** Valida a etapa atual; devolve true quando pode avançar. */
function validateStep(root) {
  const { answers } = state;
  const step = STEPS[state.step].id;
  clearFieldErrors(root);
  if (step === 'exam') {
    if (answers.exam_id) return true;
    if (state.otherExam) {
      if (answers.other_exam_name) return true;
      fieldError(root, 'other_exam_name', 'Informe o nome do vestibular.');
      return false;
    }
    const message = qs('[data-error-for="exam_id"]', root);
    if (message) message.textContent = 'Escolha a prova para começar.';
    return false;
  }
  if (step === 'availability') {
    if (!answers.study_days.length) {
      const message = qs('[data-error-for="study_days"]', root);
      if (message) message.textContent = 'Escolha pelo menos um dia da semana.';
      return false;
    }
    if (!(answers.hours_per_day >= MIN_HOURS)) {
      toast('Informe quanto tempo você consegue estudar por dia.', { type: 'warning' });
      return false;
    }
    return true;
  }
  if (step === 'level') {
    if (!answers.level) {
      const message = qs('[data-error-for="level"]', root);
      if (message) message.textContent = 'Escolha o nível que mais combina com você.';
      return false;
    }
    return true;
  }
  if (step === 'details') {
    if (answers.exam_date && !/^\d{4}-\d{2}-\d{2}$/.test(answers.exam_date)) {
      fieldError(root, 'exam_date', 'Informe uma data válida.');
      return false;
    }
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------

function buildPayload() {
  const { answers } = state;
  const payload = {
    study_days: answers.study_days,
    hours_per_day: answers.hours_per_day,
    level: answers.level,
  };
  if (answers.exam_id) payload.exam_id = answers.exam_id;
  else payload.other_exam_name = answers.other_exam_name;
  if (answers.weakest_subject_id) payload.weakest_subject_id = answers.weakest_subject_id;
  if (answers.exam_date) payload.exam_date = answers.exam_date;
  ['target_course', 'target_university', 'target_score', 'main_difficulty', 'performance_goal'].forEach((name) => {
    if (answers[name]) payload[name] = answers[name];
  });
  return payload;
}

/** Em qual etapa cada campo do payload é preenchido (para voltar ao erro certo). */
const FIELD_STEP = {
  exam_id: 0,
  other_exam_name: 0,
  study_days: 1,
  hours_per_day: 1,
  level: 2,
  weakest_subject_id: 2,
  exam_date: 3,
  target_course: 3,
  target_university: 3,
  target_score: 3,
  main_difficulty: 3,
  performance_goal: 3,
};

const detailName = (detail) => {
  const path = detail && detail.path;
  return Array.isArray(path) ? path[path.length - 1] : path || detail.field || '';
};

/** Leva o aluno de volta à etapa do primeiro campo inválido e marca as mensagens. */
async function showValidationErrors(ctx, err) {
  const details = Array.isArray(err.details) ? err.details : [];
  const first = details.find((detail) => FIELD_STEP[detailName(detail)] !== undefined);
  toast((first && first.message) || err.message, { type: 'error' });
  if (!first) return;
  const stepIndex = FIELD_STEP[detailName(first)];
  await goTo(ctx, stepIndex);
  const root = qs('[data-onb-body]', ctx.el);
  if (!root) return;
  details.forEach((detail) => {
    const name = detailName(detail);
    if (FIELD_STEP[name] !== stepIndex) return;
    fieldError(root, name, detail.message);
    const message = qs(`[data-error-for="${CSS.escape(name)}"]`, root);
    if (message) message.textContent = detail.message;
  });
}

async function submit(ctx, button) {
  setLoading(button, true);
  try {
    const result = await api.post('/api/onboarding', buildPayload());
    if (!state) return;
    store.setSession({ profile: result.profile, exam: result.exam || (result.profile && result.profile.exam) || null });
    renderSuccess(ctx, result);
  } catch (err) {
    setLoading(button, false);
    if (!(err instanceof ApiError)) throw err;
    if (err.isValidation) {
      await showValidationErrors(ctx, err);
      return;
    }
    toast(err.message || 'Não foi possível gerar seu cronograma. Tente novamente.', { type: 'error' });
  }
}

function renderSuccess(ctx, result) {
  const today = result.schedule_today || {};
  const items = Array.isArray(today.items) ? today.items : [];
  const first = today.next_item || items[0] || null;
  const created = Number(result.schedule_items_created) || 0;

  render(
    ctx.el,
    html`
      <div class="onb onb-done" data-step="done">
        <div class="card onb-card">
          <div class="onb-body onb-enter">
            <span class="onb-done-icon">${icon('circle-check')}</span>
            <h1 class="onb-title">Seu cronograma está pronto</h1>
            <p class="onb-subtitle">
              ${created > 0
                ? `Montamos ${created} ${created === 1 ? 'atividade' : 'atividades'} para as próximas semanas.`
                : 'Seu plano foi salvo. As atividades aparecem no seu painel.'}
            </p>
            ${first
              ? html`
                <div class="onb-first">
                  <span class="onb-first-label">Primeira atividade</span>
                  <div class="onb-first-row">
                    <span class="onb-first-icon">${icon(activityIcon(first.type))}</span>
                    <div class="onb-first-main">
                      <strong>${first.title}</strong>
                      <span class="meta">
                        <span>${activityLabel(first.type)}</span>
                        ${first.subject_name ? html`<span>${first.subject_name}</span>` : ''}
                        <span>${fmtMinutes(first.duration_min)}</span>
                      </span>
                    </div>
                  </div>
                </div>`
              : html`<p class="onb-note">${icon('info', { size: 14 })}<span>Hoje não é um dos seus dias de estudo. O plano começa no próximo dia escolhido.</span></p>`}
            <div class="onb-done-actions">
              ${first && first.href
                ? html`<a class="btn btn-primary btn-lg" href="${first.href}">${icon('play')}<span>Começar a estudar</span></a>`
                : ''}
              <a class="btn ${first && first.href ? 'btn-secondary' : 'btn-primary btn-lg'}" href="/app">${icon('house')}<span>Ir para o meu painel</span></a>
            </div>
            <p class="onb-redirect" data-redirect>Levando você ao painel em instantes…</p>
          </div>
        </div>
      </div>`
  );

  state.timer = setTimeout(() => {
    if (state) ctx.navigate('/app');
  }, REDIRECT_DELAY_MS);
}

// ---------------------------------------------------------------------
// Navegação entre etapas
// ---------------------------------------------------------------------

async function goTo(ctx, index) {
  state.step = Math.min(Math.max(index, 0), STEPS.length - 1);
  if (STEPS[state.step].id === 'level') await ensureSubjects();
  paint(ctx);
}

async function next(ctx) {
  const body = qs('[data-onb-body]', ctx.el);
  collectStep(body);
  if (!validateStep(body)) return;
  if (state.step === STEPS.length - 1) return;
  await goTo(ctx, state.step + 1);
}

function back(ctx) {
  const body = qs('[data-onb-body]', ctx.el);
  collectStep(body);
  goTo(ctx, state.step - 1);
}

/** Carrega as matérias da prova escolhida (uma vez por prova). */
async function ensureSubjects() {
  const examId = state.answers.exam_id;
  if (!examId) {
    state.subjects = [];
    state.subjectsExamId = null;
    state.subjectsError = false;
    return;
  }
  if (state.subjectsExamId === examId) return;
  try {
    const list = await api.get(`/api/exams/${encodeURIComponent(examId)}/subjects`);
    state.subjects = Array.isArray(list) ? list : [];
    state.subjectsExamId = examId;
    state.subjectsError = false;
  } catch {
    state.subjects = [];
    state.subjectsExamId = null;
    state.subjectsError = true;
  }
}

/** Seleciona a trilha na etapa 1 (e a prova correspondente quando houver só uma). */
async function selectTrack(ctx, trackId) {
  const body = qs('[data-onb-body]', ctx.el);
  collectStep(body);
  const { answers } = state;
  answers.track = trackId;
  if (trackId === 'vestibular') {
    const exam = currentExam();
    if (!exam || exam.track !== 'vestibular') answers.exam_id = null;
    state.otherExam = !answers.exam_id && !!answers.other_exam_name;
  } else {
    const exam = state.exams.find((item) => item.track === trackId) || null;
    state.otherExam = false;
    answers.exam_id = exam ? exam.id : null;
    answers.other_exam_name = '';
  }
  applyExamDate();
  paint(ctx);
}

function applyExamDate() {
  const exam = currentExam();
  if (exam && exam.exam_date && !state.examDateTouched) state.answers.exam_date = exam.exam_date;
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------

function paint(ctx) {
  const step = STEPS[state.step];
  const pct = Math.round(((state.step + 1) / STEPS.length) * 100);
  const isLast = state.step === STEPS.length - 1;

  render(
    ctx.el,
    html`
      <div class="onb" data-step="${state.step + 1}">
        <header class="onb-head">
          <img src="/assets/brand/foco-elite-logo.png" alt="Foco de Elite" width="1983" height="793">
          <p>Vamos montar o seu plano de estudos</p>
        </header>

        <div class="card onb-card">
          <div class="onb-progress">
            <ol class="steps onb-steps">
              ${STEPS.map((item, index) => html`
                <li class="step ${index === state.step ? 'active' : ''} ${index < state.step ? 'done' : ''}">
                  <span class="step-number">${index < state.step ? icon('check') : String(index + 1)}</span>
                  <span class="step-label">${item.label}</span>
                </li>`)}
            </ol>
            ${progressBar(pct, { size: 'sm', label: `Etapa ${state.step + 1} de ${STEPS.length}` })}
          </div>

          <div class="onb-body onb-enter" data-onb-body>
            <h1 class="onb-title">${step.title}</h1>
            <p class="onb-subtitle">${step.subtitle}</p>
            <div class="onb-step">${STEP_VIEWS[step.id]()}</div>
          </div>

          <footer class="onb-foot">
            <button type="button" class="btn btn-ghost" data-action="back" ${state.step === 0 ? raw('disabled') : ''}>
              ${icon('arrow-left')}<span>Voltar</span>
            </button>
            <button type="button" class="btn btn-primary btn-lg" data-action="${isLast ? 'submit' : 'next'}">
              <span>${isLast ? 'Gerar meu cronograma' : 'Continuar'}</span>${icon(isLast ? 'sparkles' : 'arrow-right')}
            </button>
          </footer>
        </div>
      </div>`
  );
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderOnboarding(ctx) {
  ctx.setTitle('Configurar estudos');
  render(ctx.el, skeleton('form', 5));

  const token = Symbol('onboarding');
  state = {
    token,
    step: 0,
    answers: initialAnswers(ctx.profile || store.profile),
    exams: [],
    subjects: [],
    subjectsExamId: null,
    subjectsError: false,
    otherExam: false,
    examDateTouched: false,
    timer: null,
    off: [],
  };

  try {
    const exams = await api.get('/api/exams');
    if (!state || state.token !== token) return;
    state.exams = Array.isArray(exams) ? exams : [];
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        <div class="onb" data-step="error">
          <header class="onb-head"><img src="/assets/brand/foco-elite-logo.png" alt="Foco de Elite" width="1983" height="793"></header>
          <div class="card onb-card"><div class="onb-body">
            ${errorState({
              title: 'Não foi possível carregar as provas',
              message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
              retry: 'reload-onboarding',
            })}
          </div></div>
        </div>`
    );
    const button = qs('[data-action="reload-onboarding"]', ctx.el);
    if (button) button.addEventListener('click', () => renderOnboarding(ctx));
    return;
  }

  // prova já escolhida antes (perfil parcial): abre a trilha correspondente
  const known = currentExam();
  if (known) {
    state.answers.track = known.track === 'enem' || known.track === 'barro_branco' ? known.track : 'vestibular';
  } else if (state.answers.other_exam_name) {
    state.answers.track = 'vestibular';
    state.otherExam = true;
  }
  applyExamDate();

  paint(ctx);

  state.off.push(
    on(ctx.el, 'click', '[data-action]', (event, button) => {
      const action = button.dataset.action;
      if (action === 'track') {
        event.preventDefault();
        selectTrack(ctx, button.dataset.track);
      } else if (action === 'next') {
        event.preventDefault();
        next(ctx);
      } else if (action === 'back') {
        event.preventDefault();
        back(ctx);
      } else if (action === 'submit') {
        event.preventDefault();
        submit(ctx, button);
      }
    })
  );

  state.off.push(
    on(ctx.el, 'change', '[data-exam-select]', (event, select) => {
      const value = select.value;
      if (value === OTHER_VALUE) {
        state.otherExam = true;
        state.answers.exam_id = null;
      } else {
        state.otherExam = false;
        state.answers.exam_id = value || null;
        state.answers.other_exam_name = '';
        applyExamDate();
      }
      paint(ctx);
      const input = qs('[name="other_exam_name"]', ctx.el);
      if (input) input.focus();
    })
  );

  // valor visível do range e total semanal em tempo real
  state.off.push(
    on(ctx.el, 'input', '[name="hours_per_day"]', (event, input) => {
      const hours = clampHours(input.value);
      state.answers.hours_per_day = hours;
      const fill = ((hours - MIN_HOURS) / (MAX_HOURS - MIN_HOURS)) * 100;
      input.style.setProperty('--range-fill', `${fill.toFixed(1)}%`);
      const output = qs('[data-hours-value]', ctx.el);
      if (output) output.textContent = fmtHours(hours);
      const total = qs('[data-week-total]', ctx.el);
      if (total) total.textContent = `Total previsto: ${fmtHours(hours * state.answers.study_days.length)} por semana.`;
    })
  );

  state.off.push(
    on(ctx.el, 'change', '[name="study_days"]', () => {
      const days = qsa('[name="study_days"]:checked', ctx.el).map((el) => Number(el.value)).sort((a, b) => a - b);
      state.answers.study_days = days;
      const total = qs('[data-week-total]', ctx.el);
      if (total) total.textContent = `Total previsto: ${fmtHours(state.answers.hours_per_day * days.length)} por semana.`;
      const message = qs('[data-error-for="study_days"]', ctx.el);
      if (message && days.length) message.textContent = '';
    })
  );

  state.off.push(
    on(ctx.el, 'change', '[name="exam_date"]', () => {
      state.examDateTouched = true;
    })
  );
}

export function unmount() {
  if (!state) return;
  clearTimeout(state.timer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

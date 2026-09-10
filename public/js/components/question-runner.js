/**
 * Runner de questões (ARCHITECTURE §6.3).
 *
 * Dois modos:
 *  - `immediateFeedback = true` (prática, revisão, caderno de erros, banco): o aluno escolhe uma
 *    alternativa, confirma em "Responder" e recebe na hora ACERTOU / ERROU, a alternativa correta,
 *    a resolução e a explicação, com os botões "Perguntar ao Tutor" e "Próxima" (ou "Concluir").
 *  - `immediateFeedback = false` (simulado): navegação livre por lista numerada, marcar e desmarcar
 *    respostas (persistidas via `answer`, sem gabarito), cronômetro regressivo com `onTimeUp` e
 *    "Finalizar" com confirmação informando quantas questões ficaram em branco.
 *
 * Uso:
 *   const runner = mountQuestionRunner(el, {
 *     questions,                       // [{ id, statement, image_url, difficulty, subject_name, topic_name, year, board, options: [{ id, letter, text }] }]
 *     mode: 'practice' | 'simulado',   // opcional; define o padrão de immediateFeedback
 *     immediateFeedback: true,
 *     answer(questionId, optionId, meta) → Promise<{ is_correct, correct_option_id, resolution, explanation }>,
 *     onFinish(summary),
 *     onAskTutor(question, answer),    // opcional; sem ele "Perguntar ao Tutor" vira link para `tutorHref`
 *     tutorHref,                       // string | (question) => string | false (oculta). Padrão: /app/tutor?question_id=<id>
 *     showTimer: true,                 // cronômetro progressivo (modo prática)
 *     durationMin: 90,                 // cronômetro regressivo (modo simulado)
 *     remainingSec, startedAt,         // opcionais para retomar um simulado em andamento
 *     onTimeUp(summary),               // opcional; sem ele o simulado é finalizado automaticamente
 *     answers: { [question_id]: option_id }, // opcional: respostas já registradas (retomada)
 *     startIndex: 0,
 *   });
 *   runner.goTo(2); runner.getSummary(); runner.finish(); runner.destroy();
 *
 * `summary = { total, correct, wrong, blank, answered, answers: [{ question_id, option_id, is_correct }] }`.
 * Atalhos de teclado: 1–5 ou A–E selecionam a alternativa; Enter confirma/avança; ← → navegam (simulado);
 * Esc fecha a lista de questões (mobile).
 *
 * Marcação: usa as classes canônicas de components.css (.question, .option, .question-feedback,
 * .qnav-btn, .question-timer, .question-progress) e complementos com prefixo .qr- (pages/misc.css).
 */
import { html, raw, render, toast, confirm, emptyState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { difficultyLabel, fmtDuration } from '../core/format.js';
import { md, mdInline } from '../core/markdown.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const WARNING_SEC = 5 * 60;
const CRITICAL_SEC = 60;
const DEFAULT_TUTOR_HREF = (question) => `/app/tutor?question_id=${encodeURIComponent(String(question.id))}`;

const join = (parts) => raw(parts.map((p) => String(p ?? '')).join(''));
const ic = (name, size = 18) => icon(name, { size });
const mdBlock = (text) => raw(md(String(text ?? '')));
const mdText = (text) => raw(mdInline(String(text ?? '')));

/** Formata segundos como mm:ss ou h:mm:ss (mantido por compatibilidade; usa fmtDuration). */
export function fmtClock(totalSec) {
  return fmtDuration(totalSec);
}

function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
}

function optionLetter(option, index) {
  return String(option?.letter || LETTERS[index] || index + 1).trim().toUpperCase();
}

function safeDifficulty(value) {
  if (!value) return '';
  const label = difficultyLabel(value);
  return label && label !== '—' ? label : '';
}

export function mountQuestionRunner(el, opts = {}) {
  if (!el) throw new Error('mountQuestionRunner: elemento de destino obrigatório');

  const questions = Array.isArray(opts.questions) ? opts.questions.filter(Boolean) : [];
  const immediate = opts.immediateFeedback !== undefined
    ? Boolean(opts.immediateFeedback)
    : opts.mode !== 'simulado';
  const durationSec = Number(opts.durationMin) > 0 ? Math.round(Number(opts.durationMin) * 60) : null;
  const countdown = durationSec !== null;
  const clampIndex = (i) => Math.min(Math.max(Number(i) || 0, 0), Math.max(questions.length - 1, 0));

  const state = {
    index: clampIndex(opts.startIndex),
    selected: null,            // alternativa pendente de confirmação (modo prática)
    answers: new Map(),        // question_id → { option_id, is_correct, result }
    pending: false,            // aguardando opts.answer
    finished: false,
    timeUp: false,
    dialogOpen: false,
    navOpen: false,
    questionStartedAt: Date.now(),
    timerStartedAt: Date.now(),
    remainingSec: null,
  };

  // Respostas já registradas (retomada de simulado).
  if (opts.answers && typeof opts.answers === 'object') {
    for (const [questionId, optionId] of Object.entries(opts.answers)) {
      if (optionId) state.answers.set(questionId, { option_id: optionId, is_correct: null, result: null });
    }
  }

  // Cronômetro regressivo: aceita remainingSec explícito ou calcula a partir de startedAt.
  if (countdown) {
    if (Number.isFinite(Number(opts.remainingSec))) {
      state.remainingSec = Math.max(0, Math.floor(Number(opts.remainingSec)));
    } else if (opts.startedAt) {
      const started = new Date(opts.startedAt).getTime();
      const elapsed = Number.isFinite(started) ? Math.floor((Date.now() - started) / 1000) : 0;
      state.remainingSec = Math.max(0, durationSec - elapsed);
    } else {
      state.remainingSec = durationSec;
    }
  }
  const showTimer = Boolean(opts.showTimer) || countdown;
  const timerEndsAt = countdown ? Date.now() + state.remainingSec * 1000 : null;

  let timerId = null;
  let destroyed = false;

  // ------------------------------------------------------------------ estado auxiliar
  const current = () => questions[state.index] || null;
  const answerOf = (q) => (q ? state.answers.get(q.id) : undefined) || null;
  const isAnswered = (q) => Boolean(answerOf(q)?.option_id);
  const answeredCount = () => questions.reduce((n, q) => n + (isAnswered(q) ? 1 : 0), 0);
  const blankCount = () => questions.length - answeredCount();
  const isLast = () => state.index >= questions.length - 1;
  const locked = () => state.finished || state.timeUp;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function getSummary() {
    const answers = questions.map((q) => {
      const a = answerOf(q);
      return {
        question_id: q.id,
        option_id: a?.option_id ?? null,
        is_correct: a && typeof a.is_correct === 'boolean' ? a.is_correct : null,
      };
    });
    const correct = answers.filter((a) => a.is_correct === true).length;
    const wrong = answers.filter((a) => a.is_correct === false).length;
    const blank = answers.filter((a) => !a.option_id).length;
    return { total: questions.length, correct, wrong, blank, answered: questions.length - blank, answers };
  }

  const elapsedSec = () => Math.floor((Date.now() - state.timerStartedAt) / 1000);
  const timeSpentSec = () => Math.max(0, Math.round((Date.now() - state.questionStartedAt) / 1000));

  // ------------------------------------------------------------------ cronômetro
  const timerText = () => fmtDuration(countdown ? state.remainingSec : elapsedSec());

  function timerClass() {
    if (!countdown) return '';
    if (state.remainingSec <= CRITICAL_SEC) return ' danger';
    if (state.remainingSec <= WARNING_SEC) return ' warning';
    return '';
  }

  function tick() {
    if (destroyed || locked()) return;
    if (countdown) state.remainingSec = Math.max(0, Math.round((timerEndsAt - Date.now()) / 1000));
    const timerEl = el.querySelector('.qr-timer');
    if (timerEl) {
      const valueEl = timerEl.querySelector('.qr-timer-value');
      if (valueEl) valueEl.textContent = timerText();
      const critical = countdown && state.remainingSec <= CRITICAL_SEC;
      const warning = countdown && !critical && state.remainingSec <= WARNING_SEC;
      timerEl.classList.toggle('warning', warning);
      timerEl.classList.toggle('danger', critical);
    }
    if (countdown && state.remainingSec <= 0) handleTimeUp();
  }

  function startTimer() {
    if (!showTimer || timerId) return;
    timerId = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  function handleTimeUp() {
    if (state.timeUp || state.finished) return;
    state.timeUp = true;
    state.navOpen = false;
    stopTimer();
    paint();
    if (typeof opts.onTimeUp === 'function') {
      opts.onTimeUp(getSummary());
    } else {
      toast('Tempo esgotado. O simulado foi finalizado automaticamente.', { type: 'warning' });
      complete();
    }
  }

  // ------------------------------------------------------------------ ações
  function complete() {
    if (state.finished) return;
    state.finished = true;
    state.navOpen = false;
    stopTimer();
    paint();
    if (typeof opts.onFinish === 'function') opts.onFinish(getSummary());
  }

  function goTo(i) {
    if (!questions.length) return;
    state.index = clampIndex(i);
    state.selected = null;
    state.pending = false;
    state.navOpen = false;
    state.questionStartedAt = Date.now();
    paint();
    focusQuestion();
  }

  function selectOption(optionId) {
    const q = current();
    if (!q || !optionId || locked() || state.pending) return;
    if (immediate) {
      if (isAnswered(q)) return;
      state.selected = optionId;
      paint();
      focusOption(optionId);
    } else {
      toggleSimuladoAnswer(q, optionId);
    }
  }

  function selectByIndex(i) {
    const option = current()?.options?.[i];
    if (option) selectOption(option.id);
  }

  async function submitAnswer() {
    const q = current();
    if (!q || !immediate || locked() || state.pending || isAnswered(q) || !state.selected) return;
    const optionId = state.selected;
    state.pending = true;
    paint();
    try {
      const result = typeof opts.answer === 'function'
        ? await opts.answer(q.id, optionId, { time_spent_sec: timeSpentSec() })
        : null;
      if (destroyed) return;
      state.answers.set(q.id, {
        option_id: optionId,
        is_correct: Boolean(result?.is_correct),
        result: result || {},
      });
      state.selected = null;
      state.pending = false;
      paint();
      focusFeedback();
    } catch (err) {
      if (destroyed) return;
      state.pending = false;
      paint();
      focusOption(optionId);
      toast(err?.message || 'Não foi possível registrar a resposta. Tente novamente.', { type: 'error' });
    }
  }

  async function toggleSimuladoAnswer(q, optionId) {
    const previous = answerOf(q)?.option_id ?? null;
    const next = previous === optionId ? null : optionId;
    setLocalAnswer(q.id, next);
    paint();
    focusOption(optionId);
    if (typeof opts.answer !== 'function') return;
    try {
      await opts.answer(q.id, next, { time_spent_sec: timeSpentSec() });
    } catch (err) {
      if (destroyed) return;
      setLocalAnswer(q.id, previous);
      paint();
      toast(err?.message || 'Não foi possível salvar a resposta. Verifique sua conexão e tente novamente.', { type: 'error' });
    }
  }

  function setLocalAnswer(questionId, optionId) {
    if (optionId) state.answers.set(questionId, { option_id: optionId, is_correct: null, result: null });
    else state.answers.delete(questionId);
  }

  async function finishSimulado() {
    if (locked() || state.dialogOpen) return;
    const blank = blankCount();
    const message = blank > 0
      ? `Você deixou ${plural(blank, 'questão', 'questões')} em branco. Ao finalizar, elas serão contadas como erro. Deseja finalizar mesmo assim?`
      : 'Todas as questões foram respondidas. Deseja finalizar o simulado e ver o resultado?';
    state.dialogOpen = true;
    let ok = false;
    try {
      ok = await confirm({ title: 'Finalizar simulado', message, danger: blank > 0, confirmText: 'Finalizar', icon: blank > 0 ? 'triangle-alert' : 'flag' });
    } finally {
      state.dialogOpen = false;
    }
    if (ok && !destroyed) complete();
  }

  /** Encerra a sessão: prática conclui direto; simulado pede confirmação. */
  function finish() {
    if (immediate) complete();
    else finishSimulado();
  }

  function next() {
    if (isLast()) {
      finish();
      return;
    }
    goTo(state.index + 1);
  }

  function prev() {
    if (state.index > 0) goTo(state.index - 1);
  }

  function askTutor() {
    const q = current();
    if (q && typeof opts.onAskTutor === 'function') opts.onAskTutor(q, answerOf(q));
  }

  function tutorHrefFor(q) {
    if (opts.tutorHref === false) return null;
    if (typeof opts.tutorHref === 'function') return opts.tutorHref(q) || null;
    if (typeof opts.tutorHref === 'string' && opts.tutorHref) return opts.tutorHref;
    return DEFAULT_TUTOR_HREF(q);
  }

  // ------------------------------------------------------------------ foco
  function focusQuestion() {
    const target = el.querySelector('.qr-question');
    if (target) target.focus({ preventScroll: false });
  }

  function focusFeedback() {
    const target = el.querySelector('.qr-feedback');
    if (target) target.focus();
  }

  function focusOption(optionId) {
    if (optionId == null) return;
    const target = el.querySelector(`.qr-option[data-option-id="${CSS.escape(String(optionId))}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ renderização
  function metaView(q) {
    const parts = [];
    if (q.subject_name || q.topic_name) {
      parts.push(html`<span class="badge badge-blue qr-meta-subject">${q.subject_name || ''}${q.subject_name && q.topic_name ? html`<span class="qr-meta-sep" aria-hidden="true">›</span>` : ''}${q.topic_name || ''}</span>`);
    }
    const difficulty = safeDifficulty(q.difficulty);
    if (difficulty) parts.push(html`<span class="badge badge-gray">${difficulty}</span>`);
    const origin = [q.board, q.year].filter(Boolean).join(' ');
    if (origin) parts.push(html`<span class="badge badge-gray">${origin}</span>`);
    return html`<div class="question-meta qr-meta">${join(parts)}</div>`;
  }

  function optionView(q, option, index) {
    const letter = optionLetter(option, index);
    const answer = answerOf(q);
    const correctId = answer?.result?.correct_option_id ?? null;
    const classes = ['option', 'qr-option'];
    let checked = false;
    let mark = '';

    if (immediate) {
      if (answer) {
        const chosen = answer.option_id === option.id;
        const isCorrect = correctId ? correctId === option.id : (chosen && answer.is_correct === true);
        if (isCorrect) { classes.push('correct'); mark = 'check'; }
        if (chosen && !isCorrect) { classes.push('wrong'); mark = 'x'; }
        if (chosen) { classes.push('is-chosen'); checked = true; }
        classes.push('is-locked');
      } else if (state.selected === option.id) {
        classes.push('selected');
        checked = true;
      }
    } else {
      if (answer?.option_id === option.id) { classes.push('selected'); checked = true; }
      if (locked()) classes.push('is-locked');
    }

    const disabled = state.pending || locked() || (immediate && Boolean(answer));
    return html`
      <button type="button" class="${classes.join(' ')}" role="radio" aria-checked="${checked ? 'true' : 'false'}"
        data-action="select" data-option-id="${option.id}" ${disabled ? raw('disabled') : ''}
        aria-label="Alternativa ${letter}">
        <span class="option-letter" aria-hidden="true">${letter}</span>
        <span class="option-text">${mdText(option.text)}</span>
        <span class="option-mark" aria-hidden="true">${mark ? ic(mark, 18) : ''}</span>
      </button>`;
  }

  function feedbackView(q) {
    const answer = answerOf(q);
    if (!immediate || !answer) return '';
    const result = answer.result || {};
    const options = Array.isArray(q.options) ? q.options : [];
    const chosen = options.find((o) => o.id === answer.option_id);
    const correct = options.find((o) => o.id === result.correct_option_id);
    const chosenLetter = chosen ? optionLetter(chosen, options.indexOf(chosen)) : '';
    const correctLetter = correct ? optionLetter(correct, options.indexOf(correct)) : '';
    const ok = answer.is_correct === true;
    let text;
    if (ok) text = correctLetter ? `A alternativa ${correctLetter} está correta.` : 'Resposta correta.';
    else if (correctLetter) text = `Você marcou ${chosenLetter || '—'}. A alternativa correta é ${correctLetter}.`;
    else text = 'Resposta incorreta.';

    return html`
      <div class="question-feedback qr-feedback ${ok ? 'correct' : 'wrong'}" role="status" aria-live="assertive" tabindex="-1">
        <div class="feedback-title">${ic(ok ? 'circle-check' : 'circle-x', 24)}<span>${ok ? 'ACERTOU' : 'ERROU'}</span></div>
        <p class="feedback-sub">${text}</p>
        ${result.resolution ? html`
          <section class="feedback-section">
            <h4>${ic('list-checks', 16)} Resolução</h4>
            <div class="question-resolution md">${mdBlock(result.resolution)}</div>
          </section>` : ''}
        ${result.explanation ? html`
          <section class="feedback-section">
            <h4>${ic('lightbulb', 16)} Explicação</h4>
            <div class="question-resolution md">${mdBlock(result.explanation)}</div>
          </section>` : ''}
      </div>`;
  }

  function tutorView(q) {
    if (typeof opts.onAskTutor === 'function') {
      return html`<button type="button" class="btn btn-secondary" data-action="tutor">${ic('bot')} Perguntar ao Tutor</button>`;
    }
    const href = tutorHrefFor(q);
    if (!href) return '';
    return html`<a class="btn btn-secondary" href="${href}">${ic('bot')} Perguntar ao Tutor</a>`;
  }

  function practiceFooter(q) {
    if (state.finished) {
      return html`
        <footer class="question-footer qr-footer">
          <span class="qr-note">${ic('circle-check', 16)} Sessão concluída.</span>
        </footer>`;
    }
    if (!isAnswered(q)) {
      const disabled = !state.selected || state.pending;
      return html`
        <footer class="question-footer qr-footer">
          <span class="qr-note qr-keys" aria-hidden="true"><span class="kbd">1</span>–<span class="kbd">5</span> selecionam · <span class="kbd">Enter</span> confirma</span>
          <div class="right">
            <button type="button" class="btn btn-primary btn-lg${state.pending ? ' is-loading' : ''}" data-action="submit" ${disabled ? raw('disabled') : ''} aria-busy="${state.pending ? 'true' : 'false'}">
              ${ic('check')}<span>${state.pending ? 'Enviando…' : 'Responder'}</span>
            </button>
          </div>
        </footer>`;
    }
    const last = isLast();
    return html`
      <footer class="question-footer qr-footer">
        ${tutorView(q)}
        <div class="right">
          <button type="button" class="btn btn-primary btn-lg" data-action="next">
            <span>${last ? 'Concluir' : 'Próxima'}</span>${ic(last ? 'flag' : 'arrow-right')}
          </button>
        </div>
      </footer>`;
  }

  function simuladoFooter(q) {
    const last = isLast();
    return html`
      <footer class="question-footer qr-footer">
        <button type="button" class="btn btn-secondary" data-action="prev" ${state.index === 0 ? raw('disabled') : ''}>
          ${ic('arrow-left')}<span>Anterior</span>
        </button>
        <div class="right">
          ${isAnswered(q) && !locked()
            ? html`<button type="button" class="btn btn-ghost" data-action="clear">${ic('rotate-ccw', 16)}<span>Desmarcar</span></button>`
            : ''}
          ${last
            ? html`<button type="button" class="btn btn-primary" data-action="finish" ${locked() ? raw('disabled') : ''}>${ic('flag')}<span>Finalizar</span></button>`
            : html`<button type="button" class="btn btn-primary" data-action="next"><span>Próxima</span>${ic('arrow-right')}</button>`}
        </div>
      </footer>`;
  }

  function questionView(q) {
    const options = Array.isArray(q.options) ? q.options : [];
    const n = state.index + 1;
    return html`
      <article class="question qr-question" tabindex="-1" aria-label="Questão ${n} de ${questions.length}">
        <header class="question-header">
          ${metaView(q)}
          <div class="question-number">Questão <strong>${n}</strong> de ${questions.length}</div>
        </header>
        <div class="question-body">
          <div class="question-statement md">${mdBlock(q.statement)}</div>
          ${q.image_url ? html`<figure class="question-image"><img src="${q.image_url}" alt="Imagem da questão ${n}" loading="lazy"></figure>` : ''}
          <div class="question-options" role="radiogroup" aria-label="Alternativas">
            ${join(options.map((o, i) => optionView(q, o, i)))}
          </div>
          ${feedbackView(q)}
        </div>
        ${immediate ? practiceFooter(q) : simuladoFooter(q)}
      </article>`;
  }

  function timerView() {
    if (!showTimer) return '';
    const label = countdown ? 'Tempo restante' : 'Tempo decorrido';
    return html`
      <div class="question-timer qr-timer${timerClass()}" role="timer" aria-label="${label}" title="${label}">
        ${ic(countdown ? 'hourglass' : 'clock', 16)}
        <span class="qr-timer-value">${timerText()}</span>
      </div>`;
  }

  function progressView() {
    const total = questions.length;
    const n = state.index + 1;
    const done = answeredCount();
    const pct = total ? Math.round((done / total) * 100) : 0;
    const hint = immediate
      ? plural(done, 'respondida', 'respondidas')
      : `${plural(done, 'respondida', 'respondidas')} · ${blankCount()} em branco`;
    return html`
      <div class="question-progress qr-progress">
        <span class="qr-progress-label">Questão ${n} de ${total}</span>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Questões respondidas">
          <div class="progress-bar" style="width:${pct}%"></div>
        </div>
        <span class="qr-progress-hint">${hint}</span>
      </div>`;
  }

  function navView() {
    const buttons = questions.map((q, i) => {
      const answered = isAnswered(q);
      const isCurrent = i === state.index;
      const classes = ['qnav-btn'];
      if (answered) classes.push('answered');
      if (isCurrent) classes.push('current');
      return html`<button type="button" class="${classes.join(' ')}" data-action="goto" data-index="${i}"
        aria-label="Questão ${i + 1}, ${answered ? 'respondida' : 'em branco'}" ${isCurrent ? raw('aria-current="true"') : ''}>${i + 1}</button>`;
    });
    return html`
      <aside class="qr-nav card${state.navOpen ? ' is-open' : ''}" aria-label="Navegação entre questões">
        <div class="qr-nav-header">
          <strong>Questões</strong>
          <span class="qr-nav-count" aria-label="${answeredCount()} de ${questions.length} respondidas">${answeredCount()}/${questions.length}</span>
          <button type="button" class="btn btn-ghost btn-sm btn-icon qr-nav-close" data-action="toggle-nav" aria-label="Fechar lista de questões">${ic('x')}</button>
        </div>
        <div class="question-nav qr-nav-grid">${join(buttons)}</div>
        <ul class="qr-legend" aria-label="Legenda">
          <li><span class="qr-legend-dot answered"></span> Respondida</li>
          <li><span class="qr-legend-dot current"></span> Atual</li>
          <li><span class="qr-legend-dot"></span> Em branco</li>
        </ul>
        <button type="button" class="btn btn-primary btn-block qr-nav-finish" data-action="finish" ${locked() ? raw('disabled') : ''}>
          ${ic('flag')}<span>Finalizar simulado</span>
        </button>
      </aside>`;
  }

  function view() {
    if (!questions.length) {
      return html`<div class="qr qr-empty">${emptyState({
        icon: 'file-text',
        title: 'Nenhuma questão disponível',
        text: 'Não há questões para este contexto no momento.',
      })}</div>`;
    }
    const q = current();
    if (immediate) {
      return html`
        <div class="qr qr-practice${state.finished ? ' is-finished' : ''}">
          <div class="qr-top">
            ${progressView()}
            ${timerView()}
          </div>
          ${questionView(q)}
        </div>`;
    }
    return html`
      <div class="qr qr-simulado${locked() ? ' is-locked' : ''}${state.navOpen ? ' is-nav-open' : ''}">
        <div class="qr-top">
          ${progressView()}
          ${timerView()}
          <button type="button" class="btn btn-secondary btn-sm qr-nav-toggle" data-action="toggle-nav" aria-expanded="${state.navOpen ? 'true' : 'false'}" aria-controls="qr-nav">
            ${ic('grid-2x2', 16)}<span>Questões</span>
          </button>
        </div>
        ${state.timeUp ? html`<div class="alert alert-warning qr-alert" role="alert">${ic('hourglass', 18)}<div class="alert-body">O tempo do simulado terminou.</div></div>` : ''}
        <div class="qr-layout">
          <div class="qr-main">${questionView(q)}</div>
          ${navView()}
          ${state.navOpen ? html`<div class="qr-nav-backdrop" data-action="toggle-nav" aria-hidden="true"></div>` : ''}
        </div>
      </div>`;
  }

  function paint() {
    if (destroyed) return;
    render(el, view());
  }

  // ------------------------------------------------------------------ eventos
  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !el.contains(target)) return;
    switch (target.dataset.action) {
      case 'select': selectOption(target.dataset.optionId); break;
      case 'submit': submitAnswer(); break;
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'goto': goTo(Number(target.dataset.index)); break;
      case 'finish': finishSimulado(); break;
      case 'tutor': askTutor(); break;
      case 'clear': {
        const q = current();
        const a = answerOf(q);
        if (q && a?.option_id && !locked()) toggleSimuladoAnswer(q, a.option_id);
        break;
      }
      case 'toggle-nav':
        state.navOpen = !state.navOpen;
        paint();
        if (state.navOpen) el.querySelector('.qnav-btn.current')?.focus();
        else el.querySelector('.qr-nav-toggle')?.focus();
        break;
      default: break;
    }
  }

  function onKeydown(event) {
    if (state.dialogOpen || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (!el.isConnected || document.body.classList.contains('modal-open')) return;

    const key = event.key;
    if (key === 'Escape' && state.navOpen) {
      event.preventDefault();
      state.navOpen = false;
      paint();
      el.querySelector('.qr-nav-toggle')?.focus();
      return;
    }
    if (locked()) return;

    const upper = key.length === 1 ? key.toUpperCase() : key;
    const letterIndex = LETTERS.indexOf(upper);
    const digit = /^[1-5]$/.test(key) ? Number(key) - 1 : -1;

    if (letterIndex >= 0 || digit >= 0) {
      event.preventDefault();
      selectByIndex(letterIndex >= 0 ? letterIndex : digit);
      return;
    }
    if (key === 'Enter') {
      const q = current();
      if (!q) return;
      // Enter em um botão/link focado deve manter o comportamento nativo do próprio controle.
      if (event.target instanceof Element && event.target.closest('a[href], button') && !event.target.closest('.qr-option')) return;
      if (immediate) {
        if (isAnswered(q)) { event.preventDefault(); next(); }
        else if (state.selected) { event.preventDefault(); submitAnswer(); }
      } else if (!isLast()) {
        event.preventDefault();
        next();
      }
      return;
    }
    if (!immediate && key === 'ArrowRight' && !isLast()) { event.preventDefault(); next(); }
    if (!immediate && key === 'ArrowLeft') { event.preventDefault(); prev(); }
  }

  el.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);

  paint();
  startTimer();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopTimer();
    el.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeydown);
    el.innerHTML = '';
  }

  return {
    destroy,
    goTo,
    next,
    prev,
    finish,
    getSummary,
    getIndex: () => state.index,
    getRemainingSec: () => (countdown ? state.remainingSec : null),
    isFinished: () => state.finished,
  };
}

export default mountQuestionRunner;

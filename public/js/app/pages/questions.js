// =====================================================================
// Foco Elite — /app/questoes
// Banco de questões com filtros encadeados (prova, matéria, assunto,
// subassunto, dificuldade, ano, banca e situação), lista paginada e
// resolução com feedback imediato em modal.
//
// APIs: /api/exams, /api/subjects?all=1, /api/subjects/:id, /api/topics/:id,
// /api/questions, /api/questions/filters, POST /api/questions/:id/answer.
//
// Exporta `questionChips` e `answeredBadge`, reutilizados pelo caderno de erros.
// =====================================================================
import { api } from '../../core/api.js';
import { html, raw, render, qs, on, debounce, modal, toast, setLoading, pageHeader, emptyState, errorState, skeleton, badge } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { mdToText } from '../../core/markdown.js';
import { difficultyLabel, difficultyTone } from '../../core/format.js';
import { mountQuestionRunner } from '../../components/question-runner.js';
import { accentStyle, pager } from './subjects.js';

const STATUS_OPTIONS = [
  { value: '', label: 'Todas as questões' },
  { value: 'unanswered', label: 'Ainda não respondidas' },
  { value: 'answered', label: 'Já respondidas' },
  { value: 'wrong', label: 'Que eu errei' },
];

const DIFFICULTY_OPTIONS = [1, 2, 3];

// ---------------------------------------------------------------------
// Blocos reutilizáveis
// ---------------------------------------------------------------------

/** Chips de contexto da questão (matéria, assunto, dificuldade, origem). */
export function questionChips(question) {
  const origin = [question.board, question.year].filter(Boolean).join(' · ');
  return html`
    <div class="chip-group qbank-chips">
      ${question.subject_name ? html`<span class="chip qbank-chip-subject">${icon(question.subject_icon || 'book-open', { size: 14 })}${question.subject_name}</span>` : ''}
      ${question.topic_name ? html`<span class="chip">${question.topic_name}</span>` : ''}
      ${question.difficulty ? badge(difficultyLabel(question.difficulty), difficultyTone(question.difficulty)) : ''}
      ${origin ? html`<span class="chip chip-sm">${origin}</span>` : ''}
    </div>`;
}

/** Indicador de "já respondida" a partir do último resultado do aluno. */
export function answeredBadge(question) {
  if (!question.user_last_result) return html``;
  const attempts = Number(question.user_attempts) || 0;
  const suffix = attempts > 1 ? ` · ${attempts} tentativas` : '';
  return question.user_last_result === 'correct'
    ? badge(`Respondida certo${suffix}`, 'green', { icon: 'circle-check' })
    : badge(`Respondida errado${suffix}`, 'red', { icon: 'circle-x' });
}

// ---------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------
let cleanup = [];
let runner = null;
let activeModal = null;

function closeRunnerModal() {
  if (runner && typeof runner.destroy === 'function') runner.destroy();
  runner = null;
  if (activeModal && typeof activeModal.close === 'function') activeModal.close();
  activeModal = null;
}

function questionItem(question, index) {
  const excerpt = mdToText(question.statement, 320);
  return html`
    <article class="card qbank-item" ${accentStyle(question.subject_color)}>
      <div class="qbank-item-head">
        ${questionChips(question)}
        ${answeredBadge(question)}
      </div>
      <p class="qbank-item-statement">${excerpt}</p>
      <div class="qbank-item-actions">
        <a class="btn btn-ghost btn-sm" href="/app/tutor?question_id=${question.id}">${icon('bot', { size: 16 })}<span>Perguntar ao Tutor</span></a>
        <button type="button" class="btn btn-secondary btn-sm" data-action="solve" data-index="${index}">
          ${icon('circle-play', { size: 16 })}<span>Resolver</span>
        </button>
      </div>
    </article>`;
}

export default async function renderPage(ctx) {
  const { el } = ctx;
  const state = {
    filters: {
      exam_id: ctx.query.exam_id || '',
      subject_id: ctx.query.subject_id || '',
      topic_id: ctx.query.topic_id || '',
      subtopic_id: ctx.query.subtopic_id || '',
      difficulty: ctx.query.difficulty || '',
      year: ctx.query.year || '',
      board: ctx.query.board || '',
      status: ctx.query.status || '',
      q: ctx.query.q || '',
    },
    page: Math.max(1, Number(ctx.query.page) || 1),
    exams: [],
    subjects: [],
    topics: [],
    subtopics: [],
    options: { years: [], boards: [] },
    result: null,
    loading: true,
    error: null,
  };

  render(
    el,
    html`
      ${pageHeader({
        title: 'Banco de questões',
        subtitle: 'Filtre por prova, matéria e assunto e resolva com correção na hora.',
        actions: html`<button type="button" class="btn btn-primary" data-action="sequence">${icon('list-checks')}<span>Resolver em sequência</span></button>`,
      })}
      <div class="qbank-page">
        <div class="card qbank-filters" data-filters></div>
        <div class="qbank-results" data-list></div>
      </div>`
  );
  const filtersEl = qs('[data-filters]', el);
  const listEl = qs('[data-list]', el);

  function syncUrl() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(state.filters)) {
      if (value) params.set(key, String(value));
    }
    if (state.page > 1) params.set('page', String(state.page));
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}`);
  }

  function hasFilters() {
    return Object.values(state.filters).some(Boolean);
  }

  function select(name, label, options, { placeholder, disabled = false } = {}) {
    const value = state.filters[name] || '';
    return html`
      <div class="field qbank-field">
        <label class="label" for="qbank-${name}">${label}</label>
        <select class="select" id="qbank-${name}" data-filter="${name}" ${disabled ? raw('disabled') : ''}>
          <option value="">${placeholder || 'Todos'}</option>
          ${options.map((option) => html`<option value="${option.value}" ${String(value) === String(option.value) ? raw('selected') : ''}>${option.label}</option>`)}
        </select>
      </div>`;
  }

  function filtersView() {
    return html`
      <div class="card-body">
        <div class="qbank-filters-head">
          <h2 class="card-title">${icon('sliders-horizontal', { size: 18 })}<span>Filtros</span></h2>
          ${hasFilters()
            ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="clear">${icon('rotate-ccw', { size: 16 })}<span>Limpar filtros</span></button>`
            : ''}
        </div>
        <div class="qbank-filters-grid">
          ${select('exam_id', 'Prova', state.exams.map((exam) => ({ value: exam.id, label: exam.short_name || exam.name })), { placeholder: 'Todas as provas' })}
          ${select('subject_id', 'Matéria', state.subjects.map((subject) => ({ value: subject.id, label: subject.name })), { placeholder: 'Todas as matérias' })}
          ${select('topic_id', 'Assunto', state.topics.map((topic) => ({ value: topic.id, label: topic.name })), {
            placeholder: state.filters.subject_id ? 'Todos os assuntos' : 'Escolha uma matéria',
            disabled: !state.filters.subject_id,
          })}
          ${select('subtopic_id', 'Subassunto', state.subtopics.map((subtopic) => ({ value: subtopic.id, label: subtopic.name })), {
            placeholder: state.filters.topic_id ? 'Todos os subassuntos' : 'Escolha um assunto',
            disabled: !state.filters.topic_id,
          })}
          ${select('difficulty', 'Dificuldade', DIFFICULTY_OPTIONS.map((level) => ({ value: level, label: difficultyLabel(level) })), { placeholder: 'Todas' })}
          ${select('year', 'Ano', state.options.years.map((year) => ({ value: year, label: year })), { placeholder: 'Todos' })}
          ${select('board', 'Banca', state.options.boards.map((board) => ({ value: board, label: board })), { placeholder: 'Todas' })}
          ${select('status', 'Situação', STATUS_OPTIONS.slice(1).map((option) => ({ value: option.value, label: option.label })), { placeholder: STATUS_OPTIONS[0].label })}
          <div class="field qbank-field qbank-field-wide">
            <label class="label" for="qbank-q">Busca no enunciado</label>
            <div class="search-box">
              ${icon('search', { size: 16 })}
              <input type="search" class="input" id="qbank-q" data-role="search" placeholder="Palavra-chave" value="${state.filters.q}">
            </div>
          </div>
        </div>
      </div>`;
  }

  function listView() {
    if (state.error) return errorState({ message: state.error });
    if (state.loading) return skeleton('list', 5);
    const result = state.result || { items: [], total: 0, page: 1, pages: 1 };
    if (!result.items.length) {
      // Filtro fechado num assunto ou numa matéria e nada no banco: em vez de
      // uma tela morta, a IA elabora as questões daquele recorte na hora.
      const podeGerar = Boolean(state.filters.topic_id || state.filters.subject_id);
      return html`
        ${emptyState({
          icon: 'file-text',
          title: 'Nenhuma questão encontrada',
          text: hasFilters()
            ? 'Nenhuma questão atende a esses filtros. Tente ampliar a busca.'
            : 'Ainda não há questões publicadas na plataforma.',
          action: hasFilters() ? { label: 'Limpar filtros', icon: 'rotate-ccw', variant: 'secondary', dataAction: 'clear' } : null,
        })}
        ${podeGerar
          ? html`
            <section class="card qbank-generate">
              <div class="card-body">
                <h3 class="qbank-generate-title">${icon('sparkles')}<span>Quer que a IA elabore agora?</span></h3>
                <p class="qbank-generate-text">
                  Ela escreve cinco questões deste recorte, com resolução comentada, e elas ficam no
                  banco para os outros alunos também.
                </p>
                <button type="button" class="btn btn-primary" data-action="generate">
                  ${icon('sparkles')}<span>Elaborar questões deste assunto</span>
                </button>
              </div>
            </section>`
          : ''}`;
    }
    return html`
      <div class="qbank-count">${result.total} ${result.total === 1 ? 'questão encontrada' : 'questões encontradas'}</div>
      <div class="qbank-list">${result.items.map((question, index) => questionItem(question, index))}</div>
      ${pager({ page: result.page, pages: result.pages, total: result.total, unit: 'questões' })}`;
  }

  /**
   * Pede à IA as questões do recorte filtrado.
   *
   * É o "caso não tiver no banco de questões, ela gera ela mesma" do combinado.
   * As questões ficam gravadas: quem filtrar o mesmo assunto depois já encontra,
   * sem nova chamada.
   */
  async function gerarQuestoes(trigger) {
    if (state.gerando) return;
    state.gerando = true;
    setLoading(trigger, true);
    try {
      const res = await api.post('/api/questions/generate', {
        topic_id: state.filters.topic_id || undefined,
        subject_id: state.filters.subject_id || undefined,
        exam_id: state.filters.exam_id || undefined,
        difficulty: state.filters.difficulty || undefined,
      });
      toast(`${res.generated} ${res.generated === 1 ? 'questão elaborada' : 'questões elaboradas'}.`, { type: 'success' });
      await loadList();
    } catch (err) {
      toast((err && err.message) || 'Não foi possível elaborar as questões agora.', { type: 'error' });
    } finally {
      state.gerando = false;
      setLoading(trigger, false);
    }
  }

  function paintFilters() {
    render(filtersEl, filtersView());
  }

  function paintList() {
    render(listEl, listView());
  }

  async function loadList() {
    state.loading = true;
    state.error = null;
    paintList();
    try {
      const query = { page: state.page > 1 ? state.page : undefined };
      for (const [key, value] of Object.entries(state.filters)) {
        if (value) query[key] = value;
      }
      state.result = await api.get('/api/questions', { query });
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = (err && err.message) || 'Não foi possível carregar as questões.';
    }
    paintList();
  }

  async function loadTopics() {
    state.topics = [];
    if (!state.filters.subject_id) return;
    try {
      const subject = await api.get(`/api/subjects/${encodeURIComponent(state.filters.subject_id)}`, { query: { all: 1 } });
      state.topics = Array.isArray(subject.topics) ? subject.topics : [];
    } catch {
      state.topics = [];
    }
  }

  async function loadSubtopics() {
    state.subtopics = [];
    if (!state.filters.topic_id) return;
    try {
      const topic = await api.get(`/api/topics/${encodeURIComponent(state.filters.topic_id)}`, { query: { all: 1 } });
      state.subtopics = Array.isArray(topic.subtopics) ? topic.subtopics : [];
    } catch {
      state.subtopics = [];
    }
  }

  async function loadFilterSources() {
    const [exams, subjects, options] = await Promise.all([
      api.get('/api/exams').catch(() => []),
      api.get('/api/subjects', { query: { all: 1 } }).catch(() => []),
      api.get('/api/questions/filters').catch(() => ({ years: [], boards: [] })),
    ]);
    state.exams = Array.isArray(exams) ? exams : [];
    state.subjects = Array.isArray(subjects) ? subjects : [];
    state.options = {
      years: Array.isArray(options.years) ? options.years : [],
      boards: Array.isArray(options.boards) ? options.boards : [],
    };
    await Promise.all([loadTopics(), loadSubtopics()]);
    paintFilters();
  }

  /** Atualiza o item da lista com o resultado de uma resposta dada no modal. */
  function markAnswered(questionId, isCorrect) {
    if (!state.result) return;
    const item = state.result.items.find((question) => question.id === questionId);
    if (!item) return;
    item.user_last_result = isCorrect ? 'correct' : 'wrong';
    item.user_attempts = (Number(item.user_attempts) || 0) + 1;
  }

  function openRunner(questions, startIndex, { title, subtitle }) {
    if (!questions.length) return;
    closeRunnerModal();
    const holder = document.createElement('div');
    holder.className = 'qbank-runner';
    let answered = false;
    activeModal = modal({
      title,
      subtitle,
      body: holder,
      size: questions.length > 1 ? 'xl' : 'lg',
      onClose: () => {
        if (runner && typeof runner.destroy === 'function') runner.destroy();
        runner = null;
        activeModal = null;
        if (answered) paintList();
      },
    });
    runner = mountQuestionRunner(holder, {
      questions,
      immediateFeedback: true,
      startIndex,
      answer: async (questionId, optionId, meta) => {
        const result = await api.post(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
          option_id: optionId,
          context: 'bank',
          time_spent_sec: meta && meta.time_spent_sec ? meta.time_spent_sec : null,
        });
        answered = true;
        markAnswered(questionId, result.is_correct);
        return result;
      },
      onFinish: (summary) => {
        if (summary.answered > 0) {
          toast(`Sessão encerrada: ${summary.correct} de ${summary.answered} corretas.`, { type: 'info' });
        }
        closeRunnerModal();
      },
    });
  }

  const onSearch = debounce((value) => {
    state.filters.q = value;
    state.page = 1;
    syncUrl();
    loadList();
  }, 400);

  cleanup.push(
    on(el, 'input', '[data-role="search"]', (event) => onSearch(event.target.value)),
    on(el, 'change', '[data-filter]', async (event, element) => {
      const name = element.dataset.filter;
      state.filters[name] = element.value;
      if (name === 'subject_id') {
        state.filters.topic_id = '';
        state.filters.subtopic_id = '';
        await loadTopics();
        state.subtopics = [];
        paintFilters();
      } else if (name === 'topic_id') {
        state.filters.subtopic_id = '';
        await loadSubtopics();
        paintFilters();
      } else {
        paintFilters();
      }
      state.page = 1;
      syncUrl();
      loadList();
    }),
    on(el, 'click', '[data-action="clear"]', async () => {
      for (const key of Object.keys(state.filters)) state.filters[key] = '';
      state.topics = [];
      state.subtopics = [];
      state.page = 1;
      syncUrl();
      paintFilters();
      loadList();
    }),
    on(el, 'click', '[data-action="page"]', (event, button) => {
      const next = Number(button.dataset.page) || 1;
      if (next === state.page) return;
      state.page = next;
      syncUrl();
      loadList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    on(el, 'click', '[data-action="solve"]', (event, button) => {
      const index = Number(button.dataset.index) || 0;
      const items = state.result ? state.result.items : [];
      const question = items[index];
      if (!question) return;
      openRunner([question], 0, { title: 'Resolver questão', subtitle: [question.subject_name, question.topic_name].filter(Boolean).join(' › ') });
    }),
    on(el, 'click', '[data-action="sequence"]', () => {
      const items = state.result ? state.result.items : [];
      if (!items.length) {
        toast('Não há questões na lista para resolver.', { type: 'warning' });
        return;
      }
      openRunner(items, 0, {
        title: 'Resolver em sequência',
        subtitle: `${items.length} ${items.length === 1 ? 'questão desta página' : 'questões desta página'}, na ordem da lista.`,
      });
    }),
    on(el, 'click', '[data-action="generate"]', (event, trigger) => gerarQuestoes(trigger)),
    on(el, 'click', '[data-action="retry"]', () => loadList()),
    () => onSearch.cancel(),
    () => closeRunnerModal()
  );

  paintFilters();
  await Promise.all([loadList(), loadFilterSources()]);
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
  closeRunnerModal();
}

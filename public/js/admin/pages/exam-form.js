// =====================================================================
// Foco Elite — Admin › Vestibular (ARCHITECTURE §6.5)
//
// Quatro abas:
//   Dados                  todos os campos da prova (PUT /api/admin/exams/:id)
//   Matérias e pesos       tabela com peso por matéria (PUT .../subjects)
//   Conteúdo programático  assuntos por matéria, com marcar todos (PUT .../topics)
//   Redação                critérios editáveis, escala, gênero e linhas
//                          (GET|PUT /api/admin/essays/criteria/:examId)
//
// Abre direto em uma aba com ?aba=dados|materias|conteudo|redacao.
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, qs, qsa, on, tabs,
  pageHeader, skeleton, errorState, emptyState, badge, setLoading, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtDate, fmtNumber } from '../../core/format.js';
import { buildForm } from '../../components/form.js';

const TABS = [
  { id: 'dados', label: 'Dados', icon: 'file-text' },
  { id: 'materias', label: 'Matérias e pesos', icon: 'layers' },
  { id: 'conteudo', label: 'Conteúdo programático', icon: 'list-tree' },
  { id: 'redacao', label: 'Redação', icon: 'pen-line' },
];

const TRACKS = [
  { value: 'enem', label: 'ENEM' },
  { value: 'barro_branco', label: 'Barro Branco / PM' },
  { value: 'vestibular', label: 'Vestibular' },
];

let state = null;

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ---------------------------------------------------------------------
// Aba: dados
// ---------------------------------------------------------------------
function mountDataTab(container) {
  const exam = state.exam;
  const box = document.createElement('div');
  box.className = 'card';
  const inner = document.createElement('div');
  inner.className = 'card-body';
  box.appendChild(inner);
  container.replaceChildren(box);

  if (state.form) state.form.destroy();
  state.form = buildForm(inner, [
    { key: 'name', label: 'Nome do vestibular', type: 'text', required: true, width: 'two-thirds', maxLength: 120 },
    { key: 'short_name', label: 'Sigla', type: 'text', width: 'third', maxLength: 40 },
    { key: 'slug', label: 'Identificador', type: 'text', width: 'half', maxLength: 80, hint: 'Usado na importação de questões (apenas letras minúsculas, números e hífens).' },
    { key: 'track', label: 'Trilha', type: 'select', required: true, width: 'half', options: TRACKS },
    { key: 'board', label: 'Banca', type: 'text', width: 'half', maxLength: 80 },
    { key: 'exam_date', label: 'Data da próxima prova', type: 'date', width: 'half' },
    { key: 'description', label: 'Descrição', type: 'textarea', rows: 4, maxLength: 2000 },
    { key: 'score_max', label: 'Nota máxima da prova objetiva', type: 'number', width: 'half', min: 0, max: 10000, step: 1 },
    { key: 'sort_order', label: 'Ordem na lista', type: 'number', width: 'half', min: 0, max: 100000, step: 1 },
    { key: 'has_essay', label: 'A prova tem redação', type: 'switch' },
    { key: 'active', label: 'Vestibular disponível para os alunos', type: 'switch' },
  ], {
    values: {
      name: exam.name,
      short_name: exam.short_name,
      slug: exam.slug,
      track: exam.track,
      board: exam.board,
      exam_date: exam.exam_date,
      description: exam.description,
      score_max: exam.score_max,
      sort_order: exam.sort_order,
      has_essay: exam.has_essay,
      active: exam.active,
    },
    submitLabel: 'Salvar dados',
    async onSubmit(values) {
      const saved = await api.put(`/api/admin/exams/${state.id}`, values);
      state.exam = { ...state.exam, ...saved };
      toast('Dados do vestibular salvos.', { type: 'success' });
      paintHeader();
    },
  });
}

// ---------------------------------------------------------------------
// Aba: matérias e pesos
// ---------------------------------------------------------------------
function subjectsTabView() {
  const rows = state.subjects;
  const available = state.allSubjects.filter((subject) => !rows.some((row) => row.subject_id === subject.id));
  return html`
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('layers')}<span>Matérias e pesos</span></h2>
        <span class="hint">O peso multiplica a prioridade da matéria no cronograma do aluno.</span>
      </div>
      <div class="card-body">
        ${rows.length ? html`
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Matéria</th>
                  <th scope="col">Área</th>
                  <th scope="col" class="num">Peso</th>
                  <th scope="col" class="num">Assuntos no edital</th>
                  <th scope="col" class="actions"><span class="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((row) => html`
                  <tr>
                    <td>
                      <span class="ex-subject">
                        <span class="subject-dot" ${row.color ? raw(`style="background:${String(row.color).replace(/[^#0-9a-fA-F]/g, '')}"`) : ''} aria-hidden="true"></span>
                        <span>${row.name}</span>
                        ${row.active === false ? badge('Inativa', 'gray') : ''}
                      </span>
                    </td>
                    <td class="text-2">${row.area_name || '—'}</td>
                    <td class="num">
                      <input class="input ex-weight" type="number" min="0" max="999.99" step="0.1" value="${row.weight ?? 1}"
                        data-weight="${row.subject_id}" aria-label="Peso de ${row.name}">
                    </td>
                    <td class="num">${fmtNumber(row.topics_in_exam || 0, { digits: 0 })} de ${fmtNumber(row.topics_total || 0, { digits: 0 })}</td>
                    <td class="actions">
                      <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="remove-subject" data-id="${row.subject_id}"
                        title="Remover matéria da prova" aria-label="Remover ${row.name}">${icon('trash-2', { size: 15 })}</button>
                    </td>
                  </tr>`)}
              </tbody>
            </table>
          </div>` : emptyState({
          icon: 'layers',
          title: 'Nenhuma matéria vinculada',
          text: 'Adicione as matérias que caem nesta prova e defina o peso de cada uma.',
          size: 'sm',
        })}

        <div class="ex-add">
          <label class="label" for="ex-add-subject">Adicionar matéria</label>
          <div class="ex-add-row">
            <select class="select" id="ex-add-subject" ${available.length ? '' : raw('disabled')}>
              <option value="">${available.length ? 'Selecione uma matéria' : 'Todas as matérias já estão na prova'}</option>
              ${available.map((subject) => html`<option value="${subject.id}">${subject.name}${subject.area_name ? ` — ${subject.area_name}` : ''}</option>`)}
            </select>
            <button type="button" class="btn btn-secondary" data-act="add-subject" ${available.length ? '' : raw('disabled')}>${icon('plus')}<span>Adicionar</span></button>
          </div>
        </div>

        <div class="ex-actions">
          <button type="button" class="btn btn-primary" data-act="save-subjects">${icon('save')}<span>Salvar matérias e pesos</span></button>
        </div>
      </div>
    </section>`;
}

function addSubject() {
  const select = qs('#ex-add-subject', state.ctx.el);
  const id = select && select.value;
  if (!id) return;
  const subject = state.allSubjects.find((item) => item.id === id);
  if (!subject) return;
  state.subjects.push({
    subject_id: subject.id,
    name: subject.name,
    color: subject.color,
    area_name: subject.area_name,
    weight: 1,
    topics_total: 0,
    topics_in_exam: 0,
    active: subject.active,
  });
  paintTab();
}

function removeSubject(id) {
  state.subjects = state.subjects.filter((row) => row.subject_id !== id);
  paintTab();
}

async function saveSubjects() {
  const button = qs('[data-act="save-subjects"]', state.ctx.el);
  const payload = state.subjects.map((row) => {
    const input = qs(`[data-weight="${row.subject_id}"]`, state.ctx.el);
    const weight = input ? Number(String(input.value).replace(',', '.')) : Number(row.weight);
    return { subject_id: row.subject_id, weight: Number.isFinite(weight) && weight >= 0 ? round2(weight) : 1 };
  });
  setLoading(button, true);
  try {
    const saved = await api.put(`/api/admin/exams/${state.id}/subjects`, { subjects: payload });
    state.subjects = saved.subjects || [];
    toast('Matérias e pesos salvos.', { type: 'success' });
    paintTab();
  } catch (err) {
    setLoading(button, false);
    toast((err && err.message) || 'Não foi possível salvar as matérias.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Aba: conteúdo programático
// ---------------------------------------------------------------------
function syllabusTabView() {
  const subjects = state.subjects;
  if (!subjects.length) {
    return html`<section class="card"><div class="card-body">${emptyState({
      icon: 'list-tree',
      title: 'Defina as matérias primeiro',
      text: 'O conteúdo programático é montado a partir das matérias vinculadas à prova.',
      action: html`<button type="button" class="btn btn-primary" data-act="go-subjects">${icon('layers')}<span>Ir para Matérias e pesos</span></button>`,
      size: 'sm',
    })}</div></section>`;
  }
  const current = state.syllabusSubject || subjects[0].subject_id;
  const topics = state.topics;
  const marked = topics.filter((topic) => topic.in_exam).length;
  return html`
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('list-tree')}<span>Conteúdo programático</span></h2>
        <span class="hint">Marque os assuntos cobrados no edital desta prova.</span>
      </div>
      <div class="card-body">
        <div class="ex-syllabus">
          <nav class="ex-syllabus-nav" aria-label="Matérias da prova">
            ${subjects.map((subject) => html`
              <button type="button" class="ex-syllabus-item ${subject.subject_id === current ? 'is-active' : ''}"
                data-act="pick-subject" data-id="${subject.subject_id}">
                <span class="ex-syllabus-name">${subject.name}</span>
                <span class="ex-syllabus-count">${fmtNumber(subject.topics_in_exam || 0, { digits: 0 })}/${fmtNumber(subject.topics_total || 0, { digits: 0 })}</span>
              </button>`)}
          </nav>
          <div class="ex-syllabus-body" data-syllabus>
            ${state.topicsLoading ? skeleton('list', 6) : topics.length ? html`
              <div class="ex-syllabus-head">
                <label class="check">
                  <input type="checkbox" data-act="toggle-all" ${marked === topics.length ? raw('checked') : ''}>
                  <span>Marcar todos os assuntos desta matéria</span>
                </label>
                <span class="hint">${fmtNumber(marked, { digits: 0 })} de ${fmtNumber(topics.length, { digits: 0 })} marcados</span>
              </div>
              <div class="ex-topics" role="group" aria-label="Assuntos da matéria">
                ${topics.map((topic) => html`
                  <label class="check ex-topic">
                    <input type="checkbox" data-topic-id="${topic.id}" ${topic.in_exam ? raw('checked') : ''}>
                    <span class="ex-topic-name">${topic.name}</span>
                    ${topic.lessons_total ? html`<span class="ex-topic-meta">${fmtNumber(topic.lessons_total, { digits: 0 })} ${topic.lessons_total === 1 ? 'aula' : 'aulas'}</span>` : ''}
                  </label>`)}
              </div>
              <div class="ex-actions">
                <button type="button" class="btn btn-primary" data-act="save-topics">${icon('save')}<span>Salvar conteúdo desta matéria</span></button>
              </div>` : emptyState({
              icon: 'list-tree',
              title: 'Nenhum assunto ativo nesta matéria',
              text: 'Cadastre assuntos em Conteúdo para montar o edital.',
              action: { label: 'Ir para Conteúdo', href: '/admin/conteudo', icon: 'arrow-right' },
              size: 'sm',
            })}
          </div>
        </div>
      </div>
    </section>`;
}

async function loadTopics(subjectId) {
  state.syllabusSubject = subjectId;
  state.topicsLoading = true;
  paintTab();
  try {
    const data = await api.get(`/api/admin/exams/${state.id}/topics`, { query: { subject_id: subjectId } });
    state.topics = Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    state.topics = [];
    toast((err && err.message) || 'Não foi possível carregar os assuntos.', { type: 'error' });
  }
  state.topicsLoading = false;
  paintTab();
}

function toggleAllTopics(checked) {
  state.topics = state.topics.map((topic) => ({ ...topic, in_exam: checked }));
  paintTab();
}

async function saveTopics() {
  const button = qs('[data-act="save-topics"]', state.ctx.el);
  const selected = qsa('[data-topic-id]:checked', state.ctx.el).map((input) => ({ topic_id: input.dataset.topicId }));
  setLoading(button, true);
  try {
    await api.put(`/api/admin/exams/${state.id}/topics`, { subject_id: state.syllabusSubject, topics: selected });
    const subject = state.subjects.find((item) => item.subject_id === state.syllabusSubject);
    if (subject) subject.topics_in_exam = selected.length;
    state.topics = state.topics.map((topic) => ({ ...topic, in_exam: selected.some((item) => item.topic_id === topic.id) }));
    toast('Conteúdo programático salvo.', { type: 'success' });
    paintTab();
  } catch (err) {
    setLoading(button, false);
    toast((err && err.message) || 'Não foi possível salvar o conteúdo programático.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Aba: redação
// ---------------------------------------------------------------------
function criteriaSum() {
  return round2(state.criteria.criteria.reduce((total, item) => total + (Number(item.max) || 0), 0));
}

function essayTabView() {
  const data = state.criteria;
  const sum = criteriaSum();
  const max = round2(data.max_score);
  const balanced = Math.abs(sum - max) < 0.011;
  return html`
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">${icon('pen-line')}<span>Matriz de correção</span></h2>
        <span class="hint">Estes critérios são enviados ao corretor por IA e exibidos ao aluno.</span>
      </div>
      <div class="card-body">
        ${state.exam.has_essay ? '' : alertBox({
          type: 'warning',
          title: 'Esta prova está marcada como "sem redação"',
          text: 'Os critérios ficam salvos, mas o aluno só envia redações quando a prova tem redação (aba Dados).',
        })}
        <div class="af-grid">
          <div class="field af-w-full">
            <label class="label" for="ec-name">Nome da matriz</label>
            <input class="input" id="ec-name" name="name" value="${data.name || ''}" maxlength="200" placeholder="Ex.: Competências do ENEM">
          </div>
          <div class="field">
            <label class="label" for="ec-max">Escala máxima</label>
            <input class="input" id="ec-max" name="max_score" type="number" min="1" max="10000" step="1" value="${data.max_score ?? 1000}">
            <p class="hint">A soma dos máximos dos critérios precisa dar exatamente este valor.</p>
          </div>
          <div class="field">
            <label class="label" for="ec-genre">Gênero do texto</label>
            <input class="input" id="ec-genre" name="genre" value="${data.genre || ''}" maxlength="200" placeholder="Texto dissertativo-argumentativo">
          </div>
          <div class="field">
            <label class="label" for="ec-min-lines">Mínimo de linhas</label>
            <input class="input" id="ec-min-lines" name="min_lines" type="number" min="0" max="200" step="1" value="${data.min_lines ?? ''}" placeholder="Ex.: 8">
          </div>
          <div class="field">
            <label class="label" for="ec-max-lines">Máximo de linhas</label>
            <input class="input" id="ec-max-lines" name="max_lines" type="number" min="0" max="400" step="1" value="${data.max_lines ?? ''}" placeholder="Ex.: 30">
          </div>
          <div class="field af-w-full">
            <label class="label" for="ec-instructions">Orientações ao corretor</label>
            <textarea class="textarea" id="ec-instructions" name="instructions" rows="4" maxlength="20000"
              placeholder="Regras da banca, o que zera a redação, tom da devolutiva.">${data.instructions || ''}</textarea>
          </div>
        </div>

        <div class="ex-criteria-head">
          <h3 class="section-title">Critérios</h3>
          <span class="${balanced ? 'text-success' : 'text-warning'}">
            ${icon(balanced ? 'circle-check' : 'triangle-alert', { size: 15 })}
            Soma dos critérios: ${fmtNumber(sum, { digits: 2 })} de ${fmtNumber(max, { digits: 2 })}
          </span>
        </div>

        ${data.criteria.length ? html`
          <div class="ex-criteria">
            ${data.criteria.map((criterion, index) => html`
              <article class="ex-criterion" data-index="${index}">
                <header class="ex-criterion-head">
                  <span class="ex-criterion-number">${index + 1}</span>
                  <input class="input ex-criterion-name" value="${criterion.name || ''}" maxlength="200" data-field="name" data-index="${index}" placeholder="Nome do critério">
                  <input class="input ex-criterion-max" type="number" min="0.01" max="10000" step="0.01" value="${criterion.max ?? ''}" data-field="max" data-index="${index}" aria-label="Pontuação máxima do critério">
                  <span class="ex-criterion-actions">
                    <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="criterion-up" data-index="${index}" title="Mover para cima" aria-label="Mover para cima" ${index === 0 ? raw('disabled') : ''}>${icon('arrow-up', { size: 15 })}</button>
                    <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="criterion-down" data-index="${index}" title="Mover para baixo" aria-label="Mover para baixo" ${index === data.criteria.length - 1 ? raw('disabled') : ''}>${icon('arrow-down', { size: 15 })}</button>
                    <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="criterion-remove" data-index="${index}" title="Remover critério" aria-label="Remover critério">${icon('trash-2', { size: 15 })}</button>
                  </span>
                </header>
                <div class="ex-criterion-body">
                  <div class="field">
                    <label class="label">Descrição para o aluno</label>
                    <textarea class="textarea" rows="2" maxlength="4000" data-field="description" data-index="${index}"
                      placeholder="O que este critério avalia.">${criterion.description || ''}</textarea>
                  </div>
                  <div class="field">
                    <label class="label">Orientação ao corretor</label>
                    <textarea class="textarea" rows="2" maxlength="8000" data-field="guidance" data-index="${index}"
                      placeholder="Como pontuar cada faixa.">${criterion.guidance || ''}</textarea>
                  </div>
                </div>
              </article>`)}
          </div>` : emptyState({
          icon: 'pen-line',
          title: 'Nenhum critério cadastrado',
          text: 'Adicione os critérios da banca — cada um com nome e pontuação máxima.',
          size: 'sm',
        })}

        <div class="ex-actions">
          <button type="button" class="btn btn-secondary" data-act="criterion-add">${icon('plus')}<span>Adicionar critério</span></button>
          <button type="button" class="btn btn-primary" data-act="save-criteria">${icon('save')}<span>Salvar matriz de redação</span></button>
        </div>
      </div>
    </section>`;
}

/** Copia o que está nos campos para o estado antes de redesenhar a aba. */
function syncCriteriaFromDom() {
  const el = state.ctx.el;
  const data = state.criteria;
  const read = (name) => {
    const input = qs(`[name="${name}"]`, el);
    return input ? input.value : null;
  };
  if (qs('[name="name"]', el)) {
    data.name = read('name') || '';
    data.genre = read('genre') || '';
    data.instructions = read('instructions') || '';
    const max = Number(read('max_score'));
    data.max_score = Number.isFinite(max) ? max : data.max_score;
    const minLines = read('min_lines');
    const maxLines = read('max_lines');
    data.min_lines = minLines === '' || minLines === null ? null : Number(minLines);
    data.max_lines = maxLines === '' || maxLines === null ? null : Number(maxLines);
  }
  qsa('[data-field][data-index]', el).forEach((input) => {
    const index = Number(input.dataset.index);
    const item = data.criteria[index];
    if (!item) return;
    const field = input.dataset.field;
    item[field] = field === 'max' ? Number(String(input.value).replace(',', '.')) : input.value;
  });
}

async function saveCriteria() {
  syncCriteriaFromDom();
  const button = qs('[data-act="save-criteria"]', state.ctx.el);
  const data = state.criteria;
  if (!data.criteria.length) {
    toast('Cadastre pelo menos um critério.', { type: 'warning' });
    return;
  }
  const payload = {
    name: (data.name || '').trim() || `Critérios de redação — ${state.exam.name}`,
    max_score: round2(data.max_score),
    genre: (data.genre || '').trim() || 'Texto dissertativo-argumentativo',
    min_lines: data.min_lines,
    max_lines: data.max_lines,
    instructions: (data.instructions || '').trim() || null,
    active: true,
    criteria: data.criteria.map((item) => ({
      key: item.key || undefined,
      name: (item.name || '').trim(),
      max: round2(item.max),
      description: (item.description || '').trim() || null,
      guidance: (item.guidance || '').trim() || null,
    })),
  };
  setLoading(button, true);
  try {
    const saved = await api.put(`/api/admin/essays/criteria/${state.id}`, payload);
    state.criteria = {
      name: saved.name,
      max_score: Number(saved.max_score),
      genre: saved.genre,
      min_lines: saved.min_lines,
      max_lines: saved.max_lines,
      instructions: saved.instructions,
      criteria: Array.isArray(saved.criteria) ? saved.criteria : [],
    };
    state.exam.essay_max_score = Number(saved.max_score);
    toast('Matriz de redação salva.', { type: 'success' });
    paintTab();
  } catch (err) {
    setLoading(button, false);
    toast((err && err.message) || 'Não foi possível salvar a matriz.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------
// Estrutura da página
// ---------------------------------------------------------------------
function paintHeader() {
  const header = qs('[data-exam-header]', state.ctx.el);
  if (!header) return;
  const exam = state.exam;
  render(
    header,
    pageHeader({
      title: exam.name,
      subtitle: `${exam.short_name}${exam.board ? ` · ${exam.board}` : ''}${exam.exam_date ? ` · prova em ${fmtDate(exam.exam_date)}` : ''}`,
      breadcrumb: [{ label: 'Vestibulares', href: '/admin/vestibulares' }, { label: exam.short_name || exam.name }],
      actions: html`
        <a class="btn btn-ghost" href="/admin/vestibulares">${icon('arrow-left')}<span>Voltar</span></a>
        ${exam.active ? badge('Ativo', 'green') : badge('Inativo', 'gray')}`,
    })
  );
}

function paintTab() {
  const container = qs('[data-tab-content]', state.ctx.el);
  if (!container) return;
  if (state.tab === 'dados') {
    mountDataTab(container);
    return;
  }
  if (state.form) {
    state.form.destroy();
    state.form = null;
  }
  if (state.tab === 'materias') render(container, subjectsTabView());
  else if (state.tab === 'conteudo') render(container, syllabusTabView());
  else render(container, essayTabView());
}

async function switchTab(id) {
  if (state.tab === 'redacao' && id !== 'redacao') syncCriteriaFromDom();
  state.tab = id;
  paintTab();
  if (id === 'conteudo' && state.subjects.length && !state.topics.length && !state.topicsLoading) {
    await loadTopics(state.syllabusSubject || state.subjects[0].subject_id);
  }
}

function bind(ctx) {
  state.off.push(
    on(ctx.el, 'click', '[data-act]', (event, button) => {
      const act = button.dataset.act;
      const index = Number(button.dataset.index);
      switch (act) {
        case 'add-subject':
          event.preventDefault();
          addSubject();
          break;
        case 'remove-subject':
          event.preventDefault();
          removeSubject(button.dataset.id);
          break;
        case 'save-subjects':
          event.preventDefault();
          saveSubjects();
          break;
        case 'go-subjects':
          event.preventDefault();
          state.tabsApi.set('materias');
          break;
        case 'pick-subject':
          event.preventDefault();
          loadTopics(button.dataset.id);
          break;
        case 'save-topics':
          event.preventDefault();
          saveTopics();
          break;
        case 'criterion-add':
          event.preventDefault();
          syncCriteriaFromDom();
          state.criteria.criteria.push({ name: '', max: 0, description: '', guidance: '' });
          paintTab();
          break;
        case 'criterion-remove':
          event.preventDefault();
          syncCriteriaFromDom();
          state.criteria.criteria.splice(index, 1);
          paintTab();
          break;
        case 'criterion-up':
          event.preventDefault();
          syncCriteriaFromDom();
          if (index > 0) state.criteria.criteria.splice(index - 1, 0, state.criteria.criteria.splice(index, 1)[0]);
          paintTab();
          break;
        case 'criterion-down':
          event.preventDefault();
          syncCriteriaFromDom();
          if (index < state.criteria.criteria.length - 1) state.criteria.criteria.splice(index + 1, 0, state.criteria.criteria.splice(index, 1)[0]);
          paintTab();
          break;
        case 'save-criteria':
          event.preventDefault();
          saveCriteria();
          break;
        default:
          break;
      }
    })
  );

  state.off.push(
    on(ctx.el, 'change', '[data-act="toggle-all"]', (event, input) => {
      toggleAllTopics(input.checked);
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[data-topic-id]', (event, input) => {
      const topic = state.topics.find((item) => item.id === input.dataset.topicId);
      if (topic) topic.in_exam = input.checked;
      const head = qs('[data-act="toggle-all"]', ctx.el);
      if (head) head.checked = state.topics.length > 0 && state.topics.every((item) => item.in_exam);
    })
  );
  state.off.push(
    on(ctx.el, 'input', '[data-field="max"], [name="max_score"]', () => {
      if (state.tab !== 'redacao') return;
      syncCriteriaFromDom();
      const label = qs('.ex-criteria-head span', ctx.el);
      if (!label) return;
      const sum = criteriaSum();
      const max = round2(state.criteria.max_score);
      const balanced = Math.abs(sum - max) < 0.011;
      label.className = balanced ? 'text-success' : 'text-warning';
      render(label, html`${icon(balanced ? 'circle-check' : 'triangle-alert', { size: 15 })}Soma dos critérios: ${fmtNumber(sum, { digits: 2 })} de ${fmtNumber(max, { digits: 2 })}`);
    })
  );
}

async function renderExamForm(ctx) {
  const id = ctx.params && ctx.params.id;
  ctx.setTitle('Vestibular');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-exam-form');
  state = {
    ctx,
    token,
    id,
    exam: null,
    subjects: [],
    allSubjects: [],
    topics: [],
    topicsLoading: false,
    syllabusSubject: null,
    criteria: { name: '', max_score: 1000, genre: '', min_lines: null, max_lines: null, instructions: '', criteria: [] },
    tab: TABS.some((tab) => tab.id === (ctx.query || {}).aba) ? ctx.query.aba : 'dados',
    tabsApi: null,
    form: null,
    off: [],
  };

  try {
    const [exam, allSubjects, criteria] = await Promise.all([
      api.get(`/api/admin/exams/${id}`),
      api.get('/api/admin/content/subjects'),
      api.get(`/api/admin/essays/criteria/${id}`).catch(() => null),
    ]);
    if (!state || state.token !== token) return;
    state.exam = exam;
    state.subjects = Array.isArray(exam.subjects) ? exam.subjects.map((row) => ({ ...row, weight: Number(row.weight) })) : [];
    state.allSubjects = allSubjects;
    if (criteria) {
      state.criteria = {
        name: criteria.name || '',
        max_score: Number(criteria.max_score) || Number(exam.essay_max_score) || 1000,
        genre: criteria.genre || 'Texto dissertativo-argumentativo',
        min_lines: criteria.min_lines,
        max_lines: criteria.max_lines,
        instructions: criteria.instructions || '',
        criteria: Array.isArray(criteria.criteria) ? criteria.criteria.map((item) => ({ ...item, max: Number(item.max) })) : [],
      };
    }
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Vestibular', breadcrumb: [{ label: 'Vestibulares', href: '/admin/vestibulares' }, { label: 'Detalhes' }] })}
        ${errorState({ title: 'Não foi possível carregar o vestibular', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-exam' })}`
    );
    const button = qs('[data-action="reload-exam"]', ctx.el);
    if (button) button.addEventListener('click', () => renderExamForm(ctx));
    return;
  }

  ctx.setTitle(state.exam.short_name || state.exam.name);
  render(
    ctx.el,
    html`
      <div data-exam-header></div>
      <div class="ex-tabs" data-tabs></div>
      <div data-tab-content></div>`
  );
  paintHeader();
  state.tabsApi = tabs(qs('[data-tabs]', ctx.el), TABS, (id2) => switchTab(id2), { active: state.tab });
  bind(ctx);
  paintTab();
  if (state.tab === 'conteudo' && state.subjects.length) await loadTopics(state.subjects[0].subject_id);
}

export default renderExamForm;

export function unmount() {
  if (!state) return;
  if (state.form) state.form.destroy();
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

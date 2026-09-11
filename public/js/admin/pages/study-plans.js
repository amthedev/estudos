// =====================================================================
// Foco Elite — Admin › Planos de estudo
//
// A sequência de assuntos que o cronograma segue. Cada plano pertence a um
// vestibular e tem uma lista ordenada de passos; o aluno anda por ela no ritmo
// da própria disponibilidade, e é daqui que sai o "o que estudar hoje".
//
// A ordem é o dado principal desta tela, por isso os passos aparecem agrupados
// por semana, na mesma leitura do plano que o professor escreveu, e a mudança
// de posição é um movimento de uma linha por vez — não uma renumeração à mão.
//
// API: GET|POST|PUT|DELETE /api/admin/study-plans[/:id]
//      POST|PUT|DELETE     /api/admin/study-plans/:id/items[/:itemId]
//      PATCH               /api/admin/study-plans/:id/items/reorder
// =====================================================================
import { api } from '../../core/api.js';
import { html, render, toast, confirm, modal, qs, on, pageHeader, skeleton, errorState, badge } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { buildForm } from '../../components/form.js';

let state = null;

const WEEKDAYS = [
  { value: 1, label: 'Segunda' },
  { value: 2, label: 'Terça' },
  { value: 3, label: 'Quarta' },
  { value: 4, label: 'Quinta' },
  { value: 5, label: 'Sexta' },
  { value: 6, label: 'Sábado' },
  { value: 0, label: 'Domingo' },
];

const KINDS = [
  { value: 'lesson', label: 'Aula' },
  { value: 'review', label: 'Revisão' },
  { value: 'essay', label: 'Redação' },
  { value: 'simulado', label: 'Simulado' },
  { value: 'past_exam', label: 'Prova anterior' },
  { value: 'training', label: 'Treino físico' },
];

// Tons da paleta do painel (ui.js): azul, verde, laranja, vermelho e cinza.
const KIND_TONE = {
  lesson: 'blue',
  review: 'gray',
  essay: 'gray',
  simulado: 'orange',
  past_exam: 'orange',
  training: 'green',
};

const kindLabel = (kind) => KINDS.find((k) => k.value === kind)?.label || 'Aula';

/** Nomes dos dias de treino, para o resumo do cabeçalho. */
function trainingSummary(plan) {
  const days = (plan.training_weekdays || []).map(Number);
  if (!days.length) return null;
  const nomes = WEEKDAYS.filter((d) => days.includes(d.value)).map((d) => d.label);
  return `${plan.training_label || 'Treino'} · ${nomes.join(', ')}`;
}

// ---------------------------------------------------------------- plano

function planFields() {
  return [
    {
      key: 'exam_id',
      label: 'Vestibular',
      type: 'select',
      required: true,
      width: 'half',
      options: state.exams.map((exam) => ({ value: exam.id, label: exam.name })),
    },
    { key: 'name', label: 'Nome do plano', type: 'text', required: true, width: 'half', placeholder: 'ENEM — um ano' },
    {
      key: 'description',
      label: 'Descrição',
      type: 'textarea',
      rows: 2,
      hint: 'Só para a equipe. O aluno não vê este texto.',
    },
    { type: 'section', label: 'Ritmo', hint: 'Como a sequência se distribui na semana do aluno.' },
    {
      key: 'lessons_per_week',
      label: 'Aulas novas por semana',
      type: 'number',
      min: 1,
      max: 21,
      step: 1,
      width: 'third',
      hint: 'Muda a semana de cada passo.',
    },
    {
      key: 'weeks',
      label: 'Duração prevista (semanas)',
      type: 'number',
      min: 1,
      max: 520,
      step: 1,
      width: 'third',
    },
    {
      key: 'exam_every_weeks',
      label: 'Prova anterior a cada',
      type: 'number',
      min: 0,
      max: 52,
      step: 1,
      width: 'third',
      hint: 'Em semanas. Use 0 para não agendar.',
    },
    { type: 'section', label: 'Treino físico', hint: 'Para provas com teste físico, como a Academia do Barro Branco.' },
    {
      key: 'training_weekdays',
      label: 'Dias de treino',
      type: 'multiselect',
      options: WEEKDAYS.map((d) => ({ value: String(d.value), label: d.label })),
      hint: 'Deixe vazio se esta prova não tem teste físico.',
    },
    { key: 'training_label', label: 'Nome da atividade', type: 'text', placeholder: 'Treino físico para o TAF' },
    { key: 'active', label: 'Plano ativo', type: 'switch', hint: 'Só um plano ativo por vestibular guia o cronograma.' },
  ];
}

function openPlanForm(plan) {
  const editing = Boolean(plan);
  const holder = document.createElement('div');

  const values = editing
    ? {
        ...plan,
        training_weekdays: (plan.training_weekdays || []).map(String),
      }
    : { lessons_per_week: 3, weeks: 52, exam_every_weeks: 4, active: true, training_weekdays: [] };

  const dialog = modal({
    title: editing ? 'Editar plano' : 'Novo plano de estudo',
    subtitle: editing ? plan.exam_name : 'A sequência que o cronograma vai seguir.',
    size: 'lg',
    body: holder,
  });

  const form = buildForm(holder, planFields(), {
    values,
    submitLabel: editing ? 'Salvar' : 'Criar plano',
    submitIcon: 'save',
    cancel: { label: 'Cancelar', onClick: () => dialog.close() },
    async onSubmit(raw) {
      const payload = {
        ...raw,
        training_weekdays: (raw.training_weekdays || []).map(Number),
      };
      const saved = editing
        ? await api.put(`/api/admin/study-plans/${plan.id}`, payload)
        : await api.post('/api/admin/study-plans', payload);
      dialog.close();
      toast(editing ? 'Plano atualizado.' : 'Plano criado.', { type: 'success' });
      await loadPlans(saved.id);
    },
  });
  state.off.push(() => form.destroy());
}

async function removePlan(plan) {
  const ok = await confirm({
    title: 'Excluir plano',
    message: `Apagar "${plan.name}"? Os passos da sequência vão junto. Cronogramas já gerados continuam existindo, mas param de avançar por este plano.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/study-plans/${plan.id}`);
    toast('Plano excluído.', { type: 'success' });
    await loadPlans(null);
  } catch (err) {
    toast(err.message || 'Não foi possível excluir.', { type: 'error' });
  }
}

// ---------------------------------------------------------------- passos

function itemFields(values = {}) {
  const subjectId = values.subject_id || '';
  const topics = subjectId ? state.topics.filter((t) => t.subject_id === subjectId) : [];
  return [
    {
      key: 'title',
      label: 'O que estudar',
      type: 'text',
      required: true,
      placeholder: 'Porcentagem, juros simples e compostos',
      hint: 'É este texto que a plataforma usa para casar o passo com uma aula cadastrada.',
    },
    {
      key: 'subject_id',
      label: 'Matéria',
      type: 'select',
      width: 'half',
      options: [{ value: '', label: 'Sem matéria' }, ...state.subjects.map((s) => ({ value: s.id, label: s.name }))],
    },
    {
      key: 'topic_id',
      label: 'Assunto',
      type: 'select',
      width: 'half',
      disabled: !subjectId,
      options: [
        { value: '', label: subjectId ? 'Sem assunto específico' : 'Escolha a matéria primeiro' },
        ...topics.map((t) => ({ value: t.id, label: t.name })),
      ],
      hint: 'Opcional. Amarra o passo a um assunto do conteúdo programático.',
    },
    {
      key: 'kind',
      label: 'Tipo',
      type: 'select',
      width: 'half',
      options: KINDS.map((k) => ({ value: k.value, label: k.label })),
    },
    { key: 'notes', label: 'Observações', type: 'textarea', rows: 2 },
  ];
}

function openItemForm(item) {
  const editing = Boolean(item);
  const holder = document.createElement('div');
  const dialog = modal({
    title: editing ? `Passo ${item.position}` : 'Novo passo',
    subtitle: state.plan.name,
    size: 'lg',
    body: holder,
  });

  let form = null;
  const mount = (values) => {
    if (form) form.destroy();
    form = buildForm(holder, itemFields(values), {
      values,
      submitLabel: editing ? 'Salvar' : 'Acrescentar ao fim',
      submitIcon: 'save',
      cancel: { label: 'Cancelar', onClick: () => dialog.close() },
      onChange(current, key) {
        // Trocar a matéria troca a lista de assuntos; sem remontar, o select
        // continuaria oferecendo assunto de outra matéria, que a API recusa.
        if (key !== 'subject_id') return;
        mount({ ...current, topic_id: '' });
      },
      async onSubmit(values2) {
        const payload = { ...values2, subject_id: values2.subject_id || null, topic_id: values2.topic_id || null };
        if (editing) await api.put(`/api/admin/study-plans/${state.plan.id}/items/${item.id}`, payload);
        else await api.post(`/api/admin/study-plans/${state.plan.id}/items`, payload);
        dialog.close();
        toast(editing ? 'Passo atualizado.' : 'Passo acrescentado.', { type: 'success' });
        await loadPlan(state.plan.id);
      },
    });
  };

  mount(editing ? { ...item, subject_id: item.subject_id || '', topic_id: item.topic_id || '', kind: item.kind } : { kind: 'lesson' });
  state.off.push(() => form && form.destroy());
}

async function removeItem(item) {
  const ok = await confirm({
    title: 'Excluir passo',
    message: `Tirar "${item.title}" da sequência? Os passos seguintes sobem uma posição.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  await api.del(`/api/admin/study-plans/${state.plan.id}/items/${item.id}`);
  toast('Passo removido.', { type: 'success' });
  await loadPlan(state.plan.id);
}

/** Move um passo uma posição para cima ou para baixo e grava a ordem inteira. */
async function moveItem(item, delta) {
  const ids = state.plan.items.map((i) => i.id);
  const from = ids.indexOf(item.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  try {
    const res = await api.patch(`/api/admin/study-plans/${state.plan.id}/items/reorder`, { ids });
    state.plan.items = res.items;
    renderPlan();
  } catch (err) {
    toast(err.message || 'Não foi possível reordenar.', { type: 'error' });
  }
}

// ---------------------------------------------------------------- desenho

function planListHtml() {
  if (!state.plans.length) {
    return html`<p class="empty-inline">Nenhum plano cadastrado. Crie o primeiro para o cronograma ter uma sequência a seguir.</p>`;
  }
  return html`<div class="sp-plans" role="tablist">
    ${state.plans.map(
      (plan) => html`
        <button
          type="button"
          role="tab"
          class="sp-plan ${state.plan && state.plan.id === plan.id ? 'is-active' : ''}"
          aria-selected="${state.plan && state.plan.id === plan.id ? 'true' : 'false'}"
          data-act="select-plan"
          data-id="${plan.id}">
          <span class="sp-plan-name">${plan.name}</span>
          <span class="sp-plan-meta">${plan.exam_short_name || plan.exam_name} · ${plan.items_total} passo(s)</span>
          ${plan.active ? '' : badge('inativo', 'gray')}
        </button>`
    )}
  </div>`;
}

function itemsHtml() {
  const items = state.plan.items;
  if (!items.length) {
    return html`<div class="empty-state">
      <p>Este plano ainda não tem passos.</p>
      <p class="muted">Acrescente o primeiro assunto da sequência — é por ele que o aluno começa.</p>
      <button type="button" class="btn btn-primary" data-act="new-item">${icon('plus', { size: 16 })}<span>Acrescentar passo</span></button>
    </div>`;
  }

  const rows = [];
  let lastWeek = null;
  items.forEach((item, index) => {
    if (item.week !== lastWeek) {
      lastWeek = item.week;
      rows.push(html`<tr class="sp-week-row"><td colspan="5">Semana ${item.week ?? '—'}</td></tr>`);
    }
    rows.push(html`
      <tr data-id="${item.id}">
        <td class="sp-pos">${item.position}</td>
        <td>
          <div class="sp-title">${item.title}</div>
          ${item.notes ? html`<div class="sp-notes">${item.notes}</div>` : ''}
        </td>
        <td>
          ${item.subject_name ? badge(item.subject_name, 'blue') : html`<span class="dt-muted">—</span>`}
          ${item.topic_name ? html`<span class="sp-topic">${item.topic_name}</span>` : ''}
        </td>
        <td>${badge(kindLabel(item.kind), KIND_TONE[item.kind] || 'gray')}</td>
        <td class="sp-actions">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="up" data-id="${item.id}"
            title="Subir" ${index === 0 ? 'disabled' : ''}>${icon('chevron-up', { size: 16 })}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="down" data-id="${item.id}"
            title="Descer" ${index === items.length - 1 ? 'disabled' : ''}>${icon('chevron-down', { size: 16 })}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="edit" data-id="${item.id}"
            title="Editar">${icon('square-pen', { size: 16 })}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-act="remove" data-id="${item.id}"
            title="Excluir">${icon('trash-2', { size: 16 })}</button>
        </td>
      </tr>`);
  });

  return html`<table class="table sp-table">
    <thead>
      <tr><th style="width:4rem">#</th><th>O que estudar</th><th>Matéria</th><th>Tipo</th><th style="width:9rem"></th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function planDetailHtml() {
  const plan = state.plan;
  if (!plan) {
    return html`<div class="card empty-state">
      <p>Escolha um plano acima para ver a sequência.</p>
    </div>`;
  }
  const treino = trainingSummary(plan);
  return html`
    <div class="card sp-detail">
      <div class="sp-detail-head">
        <div>
          <h2>${plan.name}</h2>
          <p class="muted">
            ${plan.exam_name} · ${plan.lessons_per_week} aula(s) nova(s) por semana ·
            ${plan.exam_every_weeks > 0 ? `prova anterior a cada ${plan.exam_every_weeks} semanas` : 'sem prova anterior agendada'}
            ${treino ? ` · ${treino}` : ''}
          </p>
          ${plan.description ? html`<p class="muted">${plan.description}</p>` : ''}
        </div>
        <div class="sp-detail-actions">
          <button type="button" class="btn btn-ghost" data-act="edit-plan">${icon('settings', { size: 16 })}<span>Editar plano</span></button>
          <button type="button" class="btn btn-ghost btn-danger" data-act="remove-plan">${icon('trash-2', { size: 16 })}<span>Excluir</span></button>
          <button type="button" class="btn btn-primary" data-act="new-item">${icon('plus', { size: 16 })}<span>Acrescentar passo</span></button>
        </div>
      </div>
      ${itemsHtml()}
    </div>`;
}

function renderPlan() {
  const el = qs('[data-sp-detail]', state.el);
  if (el) render(el, planDetailHtml());
  const list = qs('[data-sp-plans]', state.el);
  if (list) render(list, planListHtml());
}

async function loadPlan(id) {
  state.plan = await api.get(`/api/admin/study-plans/${id}`);
  renderPlan();
}

async function loadPlans(selectId) {
  const { items } = await api.get('/api/admin/study-plans');
  state.plans = items;
  const alvo = selectId || (state.plan && items.some((p) => p.id === state.plan.id) ? state.plan.id : items[0]?.id);
  if (alvo) await loadPlan(alvo);
  else {
    state.plan = null;
    renderPlan();
  }
}

// ---------------------------------------------------------------- página

async function renderStudyPlansPage(ctx) {
  state = { el: ctx.el, off: [], plans: [], plan: null, exams: [], subjects: [], topics: [] };

  render(
    ctx.el,
    html`${pageHeader({
      title: 'Planos de estudo',
      subtitle: 'A sequência de assuntos que o cronograma do aluno segue, semana a semana.',
      actions: html`<button type="button" class="btn btn-primary" data-act="new-plan">${icon('plus', { size: 16 })}<span>Novo plano</span></button>`,
    })}
    <div data-sp-plans></div>
    <div data-sp-detail>${skeleton('card')}</div>`
  );

  try {
    const [exams, subjects, topics] = await Promise.all([
      api.get('/api/admin/exams'),
      api.get('/api/admin/content/subjects'),
      api.get('/api/admin/content/topics'),
    ]);
    state.exams = Array.isArray(exams) ? exams : exams.items || [];
    state.subjects = subjects || [];
    state.topics = topics || [];
    await loadPlans(null);
  } catch (err) {
    render(qs('[data-sp-detail]', ctx.el), errorState({ message: err.message || 'Não foi possível carregar os planos.' }));
    return;
  }

  const byId = (id) => state.plan?.items.find((i) => i.id === id);

  state.off.push(
    on(ctx.el, 'click', '[data-act]', async (event, target) => {
      event.preventDefault();
      const act = target.dataset.act;
      const id = target.dataset.id;
      if (act === 'new-plan') {
        if (!state.exams.length) {
          toast('Cadastre um vestibular antes de criar um plano de estudo.', { type: 'warning' });
          return;
        }
        openPlanForm(null);
      } else if (act === 'select-plan') await loadPlan(id);
      else if (act === 'edit-plan') openPlanForm(state.plan);
      else if (act === 'remove-plan') await removePlan(state.plan);
      else if (act === 'new-item') openItemForm(null);
      else if (act === 'edit') openItemForm(byId(id));
      else if (act === 'remove') await removeItem(byId(id));
      else if (act === 'up') await moveItem(byId(id), -1);
      else if (act === 'down') await moveItem(byId(id), 1);
    })
  );
}

export default renderStudyPlansPage;

export function unmount() {
  if (!state) return;
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

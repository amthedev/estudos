// =====================================================================
// Foco Elite — Admin › Conteúdo (ARCHITECTURE §6.5)
//
// Árvore expansível Área → Matéria → Assunto → Subassunto com contagem de
// aulas e questões, criação e edição no próprio lugar, reordenação por setas,
// ativar/desativar, busca e um painel lateral com as provas em que o assunto
// selecionado cai (marcáveis por caixas de seleção).
//
// API: GET /api/admin/content/tree, POST|PUT|DELETE /api/admin/content/<tipo>,
//      PATCH /api/admin/content/<tipo>/reorder, PUT /api/admin/content/topics/:id/exams
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import {
  html, raw, render, toast, confirm, modal, qs, qsa, on, escapeHtml,
  pageHeader, emptyState, errorState, skeleton, badge, setLoading,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtNumber, pluralize } from '../../core/format.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#2F80ED';
const DEFAULT_ICON = 'book-open';

/** Ícones do sprite oferecidos para matérias (nomes Lucide já presentes em assets/icons.svg). */
const SUBJECT_ICONS = [
  'book-open', 'book', 'library', 'scroll-text', 'languages', 'pen-line', 'newspaper',
  'calculator', 'sigma', 'square-function', 'ruler', 'shapes', 'chart-column',
  'atom', 'flask-conical', 'dna', 'microscope', 'telescope', 'leaf', 'orbit',
  'landmark', 'globe', 'map', 'history', 'scale', 'gavel', 'brain', 'lightbulb',
  'monitor', 'cpu', 'database', 'dumbbell', 'palette', 'school', 'graduation-cap', 'target',
];

const TYPE_LABEL = {
  area: { one: 'Área', new: 'Nova área', child: 'Nova matéria' },
  subject: { one: 'Matéria', new: 'Nova matéria', child: 'Novo assunto' },
  topic: { one: 'Assunto', new: 'Novo assunto', child: 'Novo subassunto' },
  subtopic: { one: 'Subassunto', new: 'Novo subassunto', child: null },
};

const ENDPOINT = { area: 'areas', subject: 'subjects', topic: 'topics', subtopic: 'subtopics' };

let state = null;

// ---------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------
const key = (type, id) => `${type}:${id}`;
const safeColor = (value) => (HEX_COLOR.test(String(value || '').trim()) ? String(value).trim() : DEFAULT_COLOR);
const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function isExpanded(type, id) {
  return state.expanded.has(key(type, id));
}

function toggleExpanded(type, id) {
  const k = key(type, id);
  if (state.expanded.has(k)) state.expanded.delete(k);
  else state.expanded.add(k);
}

/**
 * Lista de irmãos de um nó, sempre o array REAL do estado.
 *
 * Devolver uma cópia aqui quebrava a reordenação de áreas em silêncio: o
 * servidor recebia a ordem nova e a tela continuava desenhando a antiga, que
 * vem de state.data.areas. O admin clicava em subir e nada acontecia, embora o
 * banco já tivesse mudado.
 */
function siblingsOf(type, id) {
  const { areas } = state.data;
  if (type === 'area') return areas;
  for (const area of areas) {
    if (type === 'subject') {
      const found = area.subjects.find((s) => s.id === id);
      if (found) return area.subjects;
      continue;
    }
    for (const subject of area.subjects) {
      if (type === 'topic') {
        const found = subject.topics.find((t) => t.id === id);
        if (found) return subject.topics;
        continue;
      }
      for (const topic of subject.topics) {
        const found = topic.subtopics.find((st) => st.id === id);
        if (found) return topic.subtopics;
      }
    }
  }
  return [];
}

function findNode(type, id) {
  const list = siblingsOf(type, id);
  return list.find((item) => item.id === id) || null;
}

function findTopic(id) {
  for (const area of state.data.areas) {
    for (const subject of area.subjects) {
      const topic = subject.topics.find((t) => t.id === id);
      if (topic) return { topic, subject };
    }
  }
  return null;
}

/** Um nó combina com a busca quando ele — ou algum descendente — casa com o termo. */
function matches(node, term) {
  if (!term) return true;
  if (normalize(node.name).includes(term)) return true;
  if (Array.isArray(node.subjects)) return node.subjects.some((s) => matches(s, term));
  if (Array.isArray(node.topics)) return node.topics.some((t) => matches(t, term));
  if (Array.isArray(node.subtopics)) return node.subtopics.some((st) => matches(st, term));
  return false;
}

const searchTerm = () => normalize(state.search);

/** Durante a busca, todos os nós com resultado aparecem abertos. */
function openForSearch(type, id) {
  return searchTerm() ? true : isExpanded(type, id);
}

// ---------------------------------------------------------------------
// Blocos de interface
// ---------------------------------------------------------------------
function countChip(iconName, value, singular, plural) {
  const n = Number(value) || 0;
  return html`<span class="ac-count ${n ? '' : 'is-zero'}" title="${pluralize(n, singular, plural)}">
    ${icon(iconName, { size: 13 })}<span>${fmtNumber(n, { digits: 0 })}</span>
  </span>`;
}

function actionButton(action, type, id, label, iconName, { danger = false } = {}) {
  return html`<button type="button" class="btn btn-ghost btn-sm btn-icon ${danger ? 'ac-danger' : ''}"
    data-act="${action}" data-type="${type}" data-id="${id}" title="${label}" aria-label="${label}">${icon(iconName, { size: 15 })}</button>`;
}

function moveButtons(type, id) {
  const list = siblingsOf(type, id);
  const index = list.findIndex((item) => item.id === id);
  const first = index <= 0;
  const last = index === list.length - 1;
  return html`
    <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="move-up" data-type="${type}" data-id="${id}"
      title="Mover para cima" aria-label="Mover para cima" ${first ? raw('disabled') : ''}>${icon('arrow-up', { size: 15 })}</button>
    <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="move-down" data-type="${type}" data-id="${id}"
      title="Mover para baixo" aria-label="Mover para baixo" ${last ? raw('disabled') : ''}>${icon('arrow-down', { size: 15 })}</button>`;
}

function caret(type, id, hasChildren) {
  if (!hasChildren) return html`<span class="ac-caret is-empty" aria-hidden="true"></span>`;
  const open = openForSearch(type, id);
  return html`<button type="button" class="ac-caret" data-act="toggle" data-type="${type}" data-id="${id}"
    aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? 'Recolher' : 'Expandir'}">${icon('chevron-right', { size: 16 })}</button>`;
}

function statusBadge(node) {
  return node.active === false ? badge('Inativo', 'gray') : '';
}

// ---------------------------------------------------------------------
// Formulário no próprio lugar (criação e edição)
// ---------------------------------------------------------------------
function iconPicker(value) {
  const current = SUBJECT_ICONS.includes(value) ? value : DEFAULT_ICON;
  return html`
    <div class="field ac-field">
      <span class="label">Ícone</span>
      <div class="ac-icon-picker" role="radiogroup" aria-label="Ícone da matéria">
        ${SUBJECT_ICONS.map((name) => html`
          <label class="ac-icon-option ${name === current ? 'is-active' : ''}" title="${name}">
            <input type="radio" name="icon" value="${name}" ${name === current ? raw('checked') : ''} class="sr-only">
            ${icon(name, { size: 18 })}
          </label>`)}
      </div>
    </div>`;
}

function colorField(value) {
  const color = safeColor(value);
  return html`
    <div class="field ac-field ac-field-color">
      <label class="label" for="ac-color">Cor</label>
      <div class="ac-color">
        <input type="color" id="ac-color-swatch" value="${color.toLowerCase()}" aria-label="Selecionar cor da matéria">
        <input type="text" class="input" id="ac-color" name="color" value="${color.toUpperCase()}" maxlength="7" spellcheck="false" autocomplete="off" placeholder="${DEFAULT_COLOR}">
      </div>
    </div>`;
}

function areaSelect(value) {
  return html`
    <div class="field ac-field">
      <label class="label" for="ac-area">Área</label>
      <select class="select" id="ac-area" name="area_id">
        <option value="">Sem área</option>
        ${state.data.areas.filter((a) => a.id).map((area) => html`
          <option value="${area.id}" ${area.id === value ? raw('selected') : ''}>${area.name}</option>`)}
      </select>
    </div>`;
}

/**
 * Formulário embutido na árvore.
 * @param {'area'|'subject'|'topic'|'subtopic'} type
 * @param {object|null} node        registro em edição (null = criação)
 * @param {string|null} parentId    id do pai quando é criação
 */
function inlineForm(type, node, parentId) {
  const editing = Boolean(node);
  const values = node || {};
  const title = editing ? `Editar ${TYPE_LABEL[type].one.toLowerCase()}` : TYPE_LABEL[type].new;
  return html`
    <form class="ac-form" data-form-type="${type}" data-form-id="${editing ? node.id : ''}" data-parent-id="${parentId || ''}" novalidate>
      <div class="ac-form-head">${icon(editing ? 'square-pen' : 'plus', { size: 15 })}<span>${title}</span></div>
      <div class="ac-form-grid">
        <div class="field ac-field ac-field-wide">
          <label class="label" for="ac-name">Nome</label>
          <input class="input" id="ac-name" name="name" value="${values.name || ''}" required maxlength="120"
            placeholder="${type === 'subject' ? 'Ex.: Matemática' : type === 'topic' ? 'Ex.: Funções' : type === 'subtopic' ? 'Ex.: Função quadrática' : 'Ex.: Ciências da Natureza'}" autocomplete="off">
          <p class="error-text" data-error-for="name"></p>
        </div>
        ${type === 'subject' ? areaSelect(values.area_id ?? parentId ?? null) : ''}
        ${type !== 'area' ? html`
          <div class="field ac-field ac-field-wide">
            <label class="label" for="ac-description">Descrição <span class="hint-inline">(opcional)</span></label>
            <textarea class="textarea" id="ac-description" name="description" rows="2" maxlength="2000"
              placeholder="Um resumo curto do que este item cobre.">${values.description || ''}</textarea>
          </div>` : ''}
        ${type === 'subject' ? iconPicker(values.icon) : ''}
        ${type === 'subject' ? colorField(values.color) : ''}
        ${type !== 'area' ? html`
          <label class="switch-field ac-field">
            <span class="fm-switch-text">
              <span class="switch-title">Ativo</span>
              <span class="hint">Itens inativos não aparecem para o aluno.</span>
            </span>
            <input type="checkbox" role="switch" class="switch" name="active" ${values.active === false ? '' : raw('checked')}>
          </label>` : ''}
      </div>
      <div class="ac-form-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-form">Cancelar</button>
        <button type="submit" class="btn btn-primary btn-sm">${icon('save', { size: 15 })}<span>Salvar</span></button>
      </div>
    </form>`;
}

function formSlot(type, id, parentId) {
  const { editing, creating } = state;
  if (editing && editing.type === type && editing.id === id) return inlineForm(type, findNode(type, id), null);
  if (creating && creating.type === type && (creating.parentId || null) === (parentId || null)) return inlineForm(type, null, parentId);
  return '';
}

const isEditing = (type, id) => Boolean(state.editing && state.editing.type === type && state.editing.id === id);

// ---------------------------------------------------------------------
// Árvore
// ---------------------------------------------------------------------
function subtopicRow(subtopic) {
  if (isEditing('subtopic', subtopic.id)) return html`<li class="ac-node ac-node-subtopic">${inlineForm('subtopic', subtopic, null)}</li>`;
  return html`
    <li class="ac-node ac-node-subtopic ${subtopic.active === false ? 'is-inactive' : ''}">
      <div class="ac-row">
        <span class="ac-caret is-empty" aria-hidden="true"></span>
        <span class="ac-bullet" aria-hidden="true"></span>
        <span class="ac-name">${subtopic.name}</span>
        ${statusBadge(subtopic)}
        <span class="ac-counts">
          ${countChip('play', subtopic.lessons_count, 'aula', 'aulas')}
          ${countChip('file-text', subtopic.questions_count, 'questão', 'questões')}
        </span>
        <span class="ac-actions">
          ${moveButtons('subtopic', subtopic.id)}
          ${actionButton('edit', 'subtopic', subtopic.id, 'Editar subassunto', 'square-pen')}
          ${actionButton('toggle-active', 'subtopic', subtopic.id, subtopic.active === false ? 'Ativar' : 'Desativar', subtopic.active === false ? 'toggle-left' : 'toggle-right')}
          ${actionButton('delete', 'subtopic', subtopic.id, 'Excluir subassunto', 'trash-2', { danger: true })}
        </span>
      </div>
    </li>`;
}

function topicRow(topic) {
  if (isEditing('topic', topic.id)) return html`<li class="ac-node ac-node-topic">${inlineForm('topic', topic, null)}</li>`;
  const term = searchTerm();
  const subtopics = topic.subtopics.filter((st) => matches(st, term));
  const open = openForSearch('topic', topic.id);
  const creatingHere = state.creating && state.creating.type === 'subtopic' && state.creating.parentId === topic.id;
  const examCount = Array.isArray(topic.exam_ids) ? topic.exam_ids.length : 0;
  return html`
    <li class="ac-node ac-node-topic ${topic.active === false ? 'is-inactive' : ''} ${state.selectedTopic === topic.id ? 'is-selected' : ''}">
      <div class="ac-row">
        ${caret('topic', topic.id, topic.subtopics.length > 0)}
        <button type="button" class="ac-name ac-name-btn" data-act="select-topic" data-id="${topic.id}" title="Ver as provas em que este assunto cai">${topic.name}</button>
        ${statusBadge(topic)}
        <span class="ac-counts">
          ${countChip('graduation-cap', examCount, 'prova', 'provas')}
          ${countChip('play', topic.lessons_count, 'aula', 'aulas')}
          ${countChip('file-text', topic.questions_count, 'questão', 'questões')}
        </span>
        <span class="ac-actions">
          ${moveButtons('topic', topic.id)}
          ${actionButton('create-subtopic', 'topic', topic.id, 'Novo subassunto', 'plus')}
          ${actionButton('edit', 'topic', topic.id, 'Editar assunto', 'square-pen')}
          ${actionButton('toggle-active', 'topic', topic.id, topic.active === false ? 'Ativar' : 'Desativar', topic.active === false ? 'toggle-left' : 'toggle-right')}
          ${actionButton('delete', 'topic', topic.id, 'Excluir assunto', 'trash-2', { danger: true })}
        </span>
      </div>
      ${creatingHere ? html`<div class="ac-children">${formSlot('subtopic', null, topic.id)}</div>` : ''}
      ${open && subtopics.length ? html`<ul class="ac-children">${subtopics.map(subtopicRow)}</ul>` : ''}
      ${open && !subtopics.length && !creatingHere ? html`
        <div class="ac-children ac-hint-row">Nenhum subassunto cadastrado.
          <button type="button" class="btn btn-ghost btn-sm" data-act="create-subtopic" data-type="topic" data-id="${topic.id}">${icon('plus', { size: 14 })}<span>Adicionar</span></button>
        </div>` : ''}
    </li>`;
}

function subjectRow(subject) {
  if (isEditing('subject', subject.id)) return html`<li class="ac-node ac-node-subject">${inlineForm('subject', subject, null)}</li>`;
  const term = searchTerm();
  const topics = subject.topics.filter((t) => matches(t, term));
  const open = openForSearch('subject', subject.id);
  const creatingHere = state.creating && state.creating.type === 'topic' && state.creating.parentId === subject.id;
  return html`
    <li class="ac-node ac-node-subject ${subject.active === false ? 'is-inactive' : ''}">
      <div class="ac-row">
        ${caret('subject', subject.id, subject.topics.length > 0)}
        <span class="ac-subject-icon" ${raw(`style="--ac-color:${escapeHtml(safeColor(subject.color))}"`)}>${icon(subject.icon || DEFAULT_ICON, { size: 16 })}</span>
        <span class="ac-name ac-name-strong">${subject.name}</span>
        ${statusBadge(subject)}
        <span class="ac-counts">
          ${countChip('list-tree', subject.topics_count, 'assunto', 'assuntos')}
          ${countChip('play', subject.lessons_count, 'aula', 'aulas')}
          ${countChip('file-text', subject.questions_count, 'questão', 'questões')}
        </span>
        <span class="ac-actions">
          ${moveButtons('subject', subject.id)}
          ${actionButton('create-topic', 'subject', subject.id, 'Novo assunto', 'plus')}
          ${actionButton('edit', 'subject', subject.id, 'Editar matéria', 'square-pen')}
          ${actionButton('toggle-active', 'subject', subject.id, subject.active === false ? 'Ativar' : 'Desativar', subject.active === false ? 'toggle-left' : 'toggle-right')}
          ${actionButton('delete', 'subject', subject.id, 'Excluir matéria', 'trash-2', { danger: true })}
        </span>
      </div>
      ${creatingHere ? html`<div class="ac-children">${formSlot('topic', null, subject.id)}</div>` : ''}
      ${open && topics.length ? html`<ul class="ac-children">${topics.map(topicRow)}</ul>` : ''}
      ${open && !topics.length && !creatingHere ? html`
        <div class="ac-children ac-hint-row">Nenhum assunto cadastrado.
          <button type="button" class="btn btn-ghost btn-sm" data-act="create-topic" data-type="subject" data-id="${subject.id}">${icon('plus', { size: 14 })}<span>Adicionar</span></button>
        </div>` : ''}
    </li>`;
}

function areaRow(area) {
  if (area.id && isEditing('area', area.id)) return html`<li class="ac-node ac-node-area">${inlineForm('area', area, null)}</li>`;
  const term = searchTerm();
  const subjects = area.subjects.filter((s) => matches(s, term));
  const open = area.id ? openForSearch('area', area.id) : true;
  const creatingHere = Boolean(area.id) && state.creating && state.creating.type === 'subject' && state.creating.parentId === area.id;
  return html`
    <li class="ac-node ac-node-area">
      <div class="ac-row ac-row-area">
        ${area.id ? caret('area', area.id, area.subjects.length > 0) : html`<span class="ac-caret is-empty" aria-hidden="true"></span>`}
        <span class="ac-name ac-name-area">${area.name}</span>
        <span class="ac-counts">${countChip('layers', area.subjects.length, 'matéria', 'matérias')}</span>
        ${area.id ? html`
          <span class="ac-actions">
            ${moveButtons('area', area.id)}
            ${actionButton('create-subject', 'area', area.id, 'Nova matéria nesta área', 'plus')}
            ${actionButton('edit', 'area', area.id, 'Editar área', 'square-pen')}
            ${actionButton('delete', 'area', area.id, 'Excluir área', 'trash-2', { danger: true })}
          </span>` : ''}
      </div>
      ${creatingHere ? html`<div class="ac-children">${formSlot('subject', null, area.id)}</div>` : ''}
      ${open && subjects.length ? html`<ul class="ac-children">${subjects.map(subjectRow)}</ul>` : ''}
      ${open && !subjects.length && !creatingHere ? html`
        <div class="ac-children ac-hint-row">Nenhuma matéria nesta área.
          ${area.id ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="create-subject" data-type="area" data-id="${area.id}">${icon('plus', { size: 14 })}<span>Adicionar</span></button>` : ''}
        </div>` : ''}
    </li>`;
}

function treeView() {
  const term = searchTerm();
  const areas = state.data.areas.filter((area) => !term || matches(area, term));
  const creatingArea = state.creating && state.creating.type === 'area';
  const creatingLooseSubject = state.creating && state.creating.type === 'subject' && !state.creating.parentId;
  if (!areas.length && !creatingArea && !creatingLooseSubject) {
    return term
      ? emptyState({ icon: 'search', title: 'Nada encontrado', text: `Nenhum item corresponde a "${state.search}".`, size: 'sm' })
      : emptyState({
        icon: 'list-tree',
        title: 'Nenhuma área cadastrada',
        text: 'Comece criando uma área (Linguagens, Matemática…) e depois as matérias.',
        action: html`<button type="button" class="btn btn-primary" data-act="create-area">${icon('plus')}<span>Nova área</span></button>`,
      });
  }
  return html`
    <ul class="ac-tree">
      ${creatingArea ? html`<li class="ac-node ac-node-area">${formSlot('area', null, null)}</li>` : ''}
      ${creatingLooseSubject ? html`<li class="ac-node ac-node-subject">${formSlot('subject', null, null)}</li>` : ''}
      ${areas.map(areaRow)}
    </ul>`;
}

// ---------------------------------------------------------------------
// Painel lateral — provas em que o assunto cai
// ---------------------------------------------------------------------
function sideView() {
  const exams = state.data.exams || [];
  if (!state.selectedTopic) {
    return html`
      <div class="ac-side-empty">
        ${emptyState({
          icon: 'graduation-cap',
          title: 'Provas do assunto',
          text: 'Selecione um assunto na árvore para marcar em quais provas ele cai.',
          size: 'sm',
        })}
      </div>`;
  }
  const found = findTopic(state.selectedTopic);
  if (!found) return html`<div class="ac-side-empty">${emptyState({ icon: 'graduation-cap', title: 'Assunto não encontrado', size: 'sm' })}</div>`;
  const { topic, subject } = found;
  const selected = new Set(Array.isArray(topic.exam_ids) ? topic.exam_ids : []);
  return html`
    <div class="ac-side-head">
      <div>
        <span class="eyebrow">${subject.name}</span>
        <h2 class="ac-side-title">${topic.name}</h2>
      </div>
      <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="close-side" aria-label="Fechar painel">${icon('x', { size: 16 })}</button>
    </div>
    <p class="hint">Marque as provas cujo edital cobra este assunto. O cronograma do aluno usa essa marcação.</p>
    ${exams.length ? html`
      <div class="ac-exams" role="group" aria-label="Provas em que o assunto cai">
        ${exams.map((exam) => html`
          <label class="check ac-exam ${exam.active === false ? 'is-inactive' : ''}">
            <input type="checkbox" data-exam-id="${exam.id}" ${selected.has(exam.id) ? raw('checked') : ''}>
            <span class="ac-exam-name">${exam.short_name || exam.name}</span>
            ${exam.active === false ? badge('Inativa', 'gray') : ''}
          </label>`)}
      </div>
      <div class="ac-side-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="save-exams">${icon('save', { size: 15 })}<span>Salvar provas</span></button>
      </div>` : emptyState({
      icon: 'graduation-cap',
      title: 'Nenhum vestibular cadastrado',
      text: 'Cadastre um vestibular para vincular o conteúdo programático.',
      action: { label: 'Ir para Vestibulares', href: '/admin/vestibulares', icon: 'arrow-right' },
      size: 'sm',
    })}`;
}

// ---------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------
function totalsView() {
  const t = state.data.totals || {};
  const items = [
    ['layers', t.subjects, 'matéria', 'matérias'],
    ['list-tree', t.topics, 'assunto', 'assuntos'],
    ['indent-increase', t.subtopics, 'subassunto', 'subassuntos'],
    ['play', t.lessons, 'aula', 'aulas'],
    ['file-text', t.questions, 'questão', 'questões'],
  ];
  return html`<div class="ac-totals">${items.map(([iconName, value, singular, plural]) => html`
    <span class="chip">${icon(iconName, { size: 14 })}<span>${fmtNumber(Number(value) || 0, { digits: 0 })} ${(Number(value) || 0) === 1 ? singular : plural}</span></span>`)}</div>`;
}

function view() {
  return html`
    ${pageHeader({
      title: 'Conteúdo',
      subtitle: 'Biblioteca central: áreas, matérias, assuntos e subassuntos usados por aulas, questões e cronograma.',
      actions: html`
        <button type="button" class="btn btn-secondary" data-act="create-area">${icon('plus')}<span>Nova área</span></button>
        <button type="button" class="btn btn-primary" data-act="create-subject-top">${icon('plus')}<span>Nova matéria</span></button>`,
    })}
    ${totalsView()}
    <div class="ac-layout">
      <section class="card ac-panel">
        <div class="ac-toolbar">
          <label class="dt-search ac-search">
            <span class="dt-search-icon" aria-hidden="true">${icon('search', { size: 16 })}</span>
            <input class="input dt-search-input" type="search" id="ac-search" placeholder="Buscar matéria, assunto ou subassunto"
              aria-label="Buscar no conteúdo" autocomplete="off" value="${state.search}">
          </label>
          <div class="ac-toolbar-end">
            <button type="button" class="btn btn-ghost btn-sm" data-act="expand-all">${icon('chevron-down', { size: 15 })}<span>Expandir</span></button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="collapse-all">${icon('chevron-up', { size: 15 })}<span>Recolher</span></button>
            <button type="button" class="btn btn-ghost btn-sm btn-icon" data-act="reload" title="Atualizar" aria-label="Atualizar">${icon('refresh-cw', { size: 15 })}</button>
          </div>
        </div>
        <div class="ac-tree-wrap" data-tree>${treeView()}</div>
      </section>
      <aside class="card ac-side ${state.selectedTopic ? 'is-open' : ''}" data-side>${sideView()}</aside>
    </div>`;
}

function repaint() {
  const treeEl = qs('[data-tree]', state.ctx.el);
  const sideEl = qs('[data-side]', state.ctx.el);
  if (treeEl) render(treeEl, treeView());
  if (sideEl) {
    render(sideEl, sideView());
    sideEl.classList.toggle('is-open', Boolean(state.selectedTopic));
  }
  focusForm();
}

function focusForm() {
  const input = qs('.ac-form [name="name"]', state.ctx.el);
  if (input) input.focus();
}

// ---------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------
function startCreate(type, parentId) {
  state.editing = null;
  state.creating = { type, parentId: parentId || null };
  if (type === 'subject' && parentId) state.expanded.add(key('area', parentId));
  if (type === 'topic' && parentId) state.expanded.add(key('subject', parentId));
  if (type === 'subtopic' && parentId) state.expanded.add(key('topic', parentId));
  repaint();
}

function startEdit(type, id) {
  state.creating = null;
  state.editing = { type, id };
  repaint();
}

function cancelForm() {
  state.creating = null;
  state.editing = null;
  repaint();
}

function readForm(form) {
  const type = form.dataset.formType;
  const data = { name: (form.elements.name?.value || '').trim() };
  if (type !== 'area') {
    data.description = (form.elements.description?.value || '').trim() || null;
    data.active = Boolean(form.elements.active?.checked);
  }
  if (type === 'subject') {
    data.area_id = form.elements.area_id?.value || null;
    data.icon = qs('input[name="icon"]:checked', form)?.value || DEFAULT_ICON;
    const color = (form.elements.color?.value || '').trim();
    data.color = HEX_COLOR.test(color) ? color.toUpperCase() : DEFAULT_COLOR;
  }
  return { type, data };
}

async function submitForm(form) {
  const { type, data } = readForm(form);
  const id = form.dataset.formId || null;
  const parentId = form.dataset.parentId || null;
  const submitBtn = qs('button[type="submit"]', form);

  if (data.name.length < 2) {
    const errorEl = qs('[data-error-for="name"]', form);
    if (errorEl) errorEl.textContent = 'Informe pelo menos 2 caracteres.';
    form.elements.name?.focus();
    return;
  }
  if (type === 'topic' && !id) data.subject_id = parentId;
  if (type === 'subtopic' && !id) data.topic_id = parentId;

  setLoading(submitBtn, true);
  try {
    if (id) await api.put(`/api/admin/content/${ENDPOINT[type]}/${id}`, data);
    else await api.post(`/api/admin/content/${ENDPOINT[type]}`, data);
    toast(id ? 'Alterações salvas.' : `${TYPE_LABEL[type].one} cadastrada com sucesso.`, { type: 'success' });
    state.creating = null;
    state.editing = null;
    await reload({ keepState: true });
  } catch (err) {
    setLoading(submitBtn, false);
    const details = err instanceof ApiError ? err.details : null;
    const first = Array.isArray(details) ? details[0] : null;
    const errorEl = qs('[data-error-for="name"]', form);
    if (errorEl && first && first.message) errorEl.textContent = first.message;
    toast((err && err.message) || 'Não foi possível salvar.', { type: 'error' });
  }
}

async function toggleActive(type, id) {
  const node = findNode(type, id);
  if (!node) return;
  const next = node.active === false;
  try {
    await api.put(`/api/admin/content/${ENDPOINT[type]}/${id}`, { active: next });
    node.active = next;
    toast(next ? 'Item ativado.' : 'Item desativado.', { type: 'success' });
    repaint();
  } catch (err) {
    toast((err && err.message) || 'Não foi possível alterar o status.', { type: 'error' });
  }
}

async function move(type, id, direction) {
  const list = siblingsOf(type, id);
  // A lista de áreas carrega a pseudo-área "Sem área", que não tem id e não
  // entra na ordenação: o vizinho é o próximo irmão de verdade, e a posição
  // dela na tela não muda.
  const reais = list.filter((item) => item.id);
  const index = reais.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= reais.length) return;

  const de = list.indexOf(reais[index]);
  const para = list.indexOf(reais[target]);
  [list[de], list[para]] = [list[para], list[de]];
  repaint();
  try {
    await api.patch(`/api/admin/content/${ENDPOINT[type]}/reorder`, {
      ids: list.filter((item) => item.id).map((item) => item.id),
    });
  } catch (err) {
    toast((err && err.message) || 'Não foi possível reordenar.', { type: 'error' });
    await reload({ keepState: true });
  }
}

/** Exclusão com o aviso do servidor e a oferta de desativar quando há conteúdo vinculado. */
async function remove(type, id) {
  const node = findNode(type, id);
  if (!node) return;
  const label = TYPE_LABEL[type].one.toLowerCase();
  const ok = await confirm({
    title: `Excluir ${label}`,
    message: `"${node.name}" será excluído definitivamente. Esta ação não pode ser desfeita.`,
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok) return;
  try {
    await api.del(`/api/admin/content/${ENDPOINT[type]}/${id}`);
    toast('Item excluído.', { type: 'success' });
    if (type === 'topic' && state.selectedTopic === id) state.selectedTopic = null;
    await reload({ keepState: true });
  } catch (err) {
    const conflict = err instanceof ApiError && err.status === 409;
    if (!conflict) {
      toast((err && err.message) || 'Não foi possível excluir.', { type: 'error' });
      return;
    }
    const canDisable = type !== 'area';
    modal({
      title: `Não é possível excluir esta ${label}`,
      size: 'sm',
      body: html`
        <p class="text-2">${err.message}</p>
        ${canDisable ? html`<p class="hint mt-3">Desativar mantém o histórico dos alunos e some com o item nas telas de estudo.</p>` : ''}`,
      actions: canDisable
        ? [
          { label: 'Fechar', variant: 'ghost' },
          {
            label: 'Desativar em vez de excluir',
            variant: 'primary',
            onClick: async () => {
              await api.put(`/api/admin/content/${ENDPOINT[type]}/${id}`, { active: false });
              toast('Item desativado.', { type: 'success' });
              await reload({ keepState: true });
            },
          },
        ]
        : [{ label: 'Entendi', variant: 'primary' }],
    });
  }
}

async function saveTopicExams() {
  const sideEl = qs('[data-side]', state.ctx.el);
  const button = qs('[data-act="save-exams"]', sideEl);
  const examIds = qsa('input[data-exam-id]:checked', sideEl).map((input) => input.dataset.examId);
  setLoading(button, true);
  try {
    await api.put(`/api/admin/content/topics/${state.selectedTopic}/exams`, { exam_ids: examIds });
    const found = findTopic(state.selectedTopic);
    if (found) found.topic.exam_ids = examIds;
    toast('Provas do assunto atualizadas.', { type: 'success' });
    repaint();
  } catch (err) {
    setLoading(button, false);
    toast((err && err.message) || 'Não foi possível salvar as provas.', { type: 'error' });
  }
}

function expandAll() {
  for (const area of state.data.areas) {
    if (area.id) state.expanded.add(key('area', area.id));
    for (const subject of area.subjects) {
      state.expanded.add(key('subject', subject.id));
      for (const topic of subject.topics) state.expanded.add(key('topic', topic.id));
    }
  }
  repaint();
}

// ---------------------------------------------------------------------
// Dados e ciclo de vida
// ---------------------------------------------------------------------
async function reload({ keepState = false } = {}) {
  const token = state.token;
  const data = await api.get('/api/admin/content/tree');
  if (!state || state.token !== token) return;
  state.data = normalizeTree(data);
  if (!keepState) state.expanded = new Set();
  repaint();
}

function normalizeTree(data) {
  const areas = Array.isArray(data.areas) ? data.areas : [];
  for (const area of areas) {
    area.subjects = Array.isArray(area.subjects) ? area.subjects : [];
    for (const subject of area.subjects) {
      subject.topics = Array.isArray(subject.topics) ? subject.topics : [];
      for (const topic of subject.topics) {
        topic.subtopics = Array.isArray(topic.subtopics) ? topic.subtopics : [];
        topic.exam_ids = Array.isArray(topic.exam_ids) ? topic.exam_ids : [];
      }
    }
  }
  return { areas, exams: Array.isArray(data.exams) ? data.exams : [], totals: data.totals || {} };
}

function bind(ctx) {
  const el = ctx.el;
  state.off.push(
    on(el, 'click', '[data-act]', (event, button) => {
      const act = button.dataset.act;
      const type = button.dataset.type;
      const id = button.dataset.id;
      switch (act) {
        case 'toggle':
          event.preventDefault();
          toggleExpanded(type, id);
          repaint();
          break;
        case 'select-topic':
          event.preventDefault();
          state.selectedTopic = state.selectedTopic === id ? null : id;
          repaint();
          break;
        case 'close-side':
          state.selectedTopic = null;
          repaint();
          break;
        case 'create-area':
          startCreate('area', null);
          break;
        case 'create-subject-top':
          startCreate('subject', null);
          break;
        case 'create-subject':
          startCreate('subject', id);
          break;
        case 'create-topic':
          startCreate('topic', id);
          break;
        case 'create-subtopic':
          startCreate('subtopic', id);
          break;
        case 'edit':
          startEdit(type, id);
          break;
        case 'cancel-form':
          cancelForm();
          break;
        case 'toggle-active':
          toggleActive(type, id);
          break;
        case 'move-up':
          move(type, id, -1);
          break;
        case 'move-down':
          move(type, id, 1);
          break;
        case 'delete':
          remove(type, id);
          break;
        case 'save-exams':
          saveTopicExams();
          break;
        case 'expand-all':
          expandAll();
          break;
        case 'collapse-all':
          state.expanded = new Set();
          repaint();
          break;
        case 'reload':
          reload({ keepState: true }).catch((err) => toast((err && err.message) || 'Não foi possível atualizar.', { type: 'error' }));
          break;
        default:
          break;
      }
    })
  );

  state.off.push(
    on(el, 'submit', 'form.ac-form', (event, form) => {
      event.preventDefault();
      submitForm(form);
    })
  );

  state.off.push(
    on(el, 'input', '#ac-search', (event, input) => {
      state.search = input.value;
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        const cursor = input.selectionStart;
        repaint();
        const next = qs('#ac-search', el);
        if (next) {
          next.focus();
          if (typeof cursor === 'number') next.setSelectionRange(cursor, cursor);
        }
      }, 250);
    })
  );

  // sincroniza o seletor de cor com o campo de texto do formulário de matéria
  state.off.push(
    on(el, 'input', '#ac-color-swatch', (event, swatch) => {
      const text = qs('#ac-color', el);
      if (text) text.value = swatch.value.toUpperCase();
    })
  );
  state.off.push(
    on(el, 'input', '#ac-color', (event, text) => {
      const swatch = qs('#ac-color-swatch', el);
      if (swatch && HEX_COLOR.test(text.value.trim())) swatch.value = text.value.trim().toLowerCase();
    })
  );
  state.off.push(
    on(el, 'change', '.ac-icon-picker input[name="icon"]', () => {
      qsa('.ac-icon-option', el).forEach((label) => {
        label.classList.toggle('is-active', Boolean(qs('input', label)?.checked));
      });
    })
  );
  state.off.push(
    on(el, 'keydown', 'form.ac-form', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelForm();
      }
    })
  );
}

async function renderContentPage(ctx) {
  ctx.setTitle('Conteúdo');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-content');
  state = {
    ctx,
    token,
    data: { areas: [], exams: [], totals: {} },
    expanded: new Set(),
    selectedTopic: null,
    search: '',
    editing: null,
    creating: null,
    searchTimer: null,
    off: [],
  };

  let data;
  try {
    data = await api.get('/api/admin/content/tree');
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Conteúdo' })}
        ${errorState({ title: 'Não foi possível carregar o conteúdo', message: (err && err.message) || 'Verifique sua conexão e tente novamente.', retry: 'reload-content' })}`
    );
    const button = qs('[data-action="reload-content"]', ctx.el);
    if (button) button.addEventListener('click', () => renderContentPage(ctx));
    return;
  }
  if (!state || state.token !== token) return;

  state.data = normalizeTree(data);
  render(ctx.el, view());
  bind(ctx);
}

export default renderContentPage;

export function unmount() {
  if (!state) return;
  clearTimeout(state.searchTimer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

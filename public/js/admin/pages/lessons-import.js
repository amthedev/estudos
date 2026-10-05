// =====================================================================
// Foco Elite — Admin › Enviar aulas em massa
//
// A equipe grava as videoaulas e envia os arquivos para a plataforma. Uma a
// uma seria uma tarde inteira, então aqui ela escolhe todos os arquivos de
// uma vez, define a matéria uma única vez, e a tela envia um por um
// mostrando o progresso. Título vem do nome do arquivo e é editável; a
// duração é lida do próprio vídeo no navegador.
//
// Assuntos: cada aula cobre de 1 a 3 assuntos, e o título já diz quais
// ("Aula 05 — Razão e Proporção, Regra de Três e Porcentagem"). Assim que os
// arquivos são escolhidos — e quando a matéria ou um título muda —, a tela
// pede ao servidor a leitura dos títulos e mostra os assuntos de cada aula
// como chips, com "novo" quando o assunto ainda não existe e vai ser
// cadastrado. A equipe confere e pode tirar ou trocar um chip, mas não é
// obrigada a mexer. Aula sem assunto reconhecido fica marcada e não sobe até
// ganhar um, a não ser que o lote tenha um "Assunto padrão".
//
// API: POST /api/admin/uploads                (um envio por arquivo, em fluxo)
//      POST /api/admin/lessons/analyze-titles (proposta de assuntos, sem gravar)
//      POST /api/admin/lessons/import         (cadastra todas de uma vez)
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, qs, qsa, on,
  pageHeader, skeleton, errorState, badge, confirm,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtBytes, fmtMinutes, pluralize } from '../../core/format.js';
import { uploadFile } from '../../components/file-input.js';

let state = null;

const ACCEPT = 'video/mp4,video/webm,video/quicktime';
const MAX_FILES = 200;
/** Assuntos por aula: a prática divide três questões entre eles. */
const MAX_ASSUNTOS = 3;
/**
 * Títulos por pedido de leitura. O servidor lê 30 por chamada de IA, quatro
 * chamadas por vez, dentro do prazo de uma requisição; acima disso a última
 * rodada corre o risco de estourar o prazo e voltar sem assunto.
 */
const TITULOS_POR_LEITURA = 100;
/** Espera depois de editar um título antes de ler de novo (o admin pode estar no meio da edição). */
const LEITURA_DEBOUNCE_MS = 400;

/** Título sugerido a partir do nome do arquivo: "01 - Porcentagem.mp4" → "Porcentagem". */
function titleFromFilename(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^[\s\d]+[-._)]\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Lê a duração do vídeo direto no navegador, sem depender de serviço externo. */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    probe.onloadedmetadata = () => {
      const seconds = Number(probe.duration);
      done(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null);
    };
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

// ---------------------------------------------------------------------
// Classificação do lote
// ---------------------------------------------------------------------
async function loadTopics(subjectId, { keep = '' } = {}) {
  const select = qs('[name="topic_id"]', state.ctx.el);
  const subSelect = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;

  if (!subjectId) {
    state.topics = [];
    select.disabled = true;
    select.innerHTML = '<option value="">Selecione a matéria primeiro</option>';
    if (subSelect) {
      subSelect.disabled = true;
      subSelect.innerHTML = '<option value="">Selecione o assunto primeiro</option>';
    }
    return;
  }

  const token = state.token;
  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  let topics = [];
  try {
    const data = await api.get('/api/admin/content/topics', { query: { subject_id: subjectId, limit: 500 } });
    topics = Array.isArray(data) ? data : data.items || [];
  } catch {
    topics = [];
  }
  // a matéria pode ter mudado enquanto a lista chegava
  if (!state || state.token !== token || currentSubject() !== subjectId) return;
  state.topics = topics;
  render(
    select,
    html`
      <option value="">Nenhum (cada aula com os assuntos do título)</option>
      ${topics.map((topic) => html`<option value="${topic.id}">${topic.name}${topic.active === false ? ' (inativo)' : ''}</option>`)}`
  );
  select.disabled = false;
  if (keep && topics.some((topic) => topic.id === keep)) select.value = keep;
  await loadSubtopics(select.value);
}

async function loadSubtopics(topicId) {
  const select = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;
  if (!topicId) {
    select.disabled = true;
    select.innerHTML = '<option value="">Escolha o assunto padrão primeiro</option>';
    return;
  }
  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  try {
    const data = await api.get('/api/admin/content/subtopics', { query: { topic_id: topicId, limit: 500 } });
    state.subtopics = Array.isArray(data) ? data : data.items || [];
  } catch {
    state.subtopics = [];
  }
  select.disabled = false;
  render(
    select,
    html`
      <option value="">Sem subassunto</option>
      ${state.subtopics.map((item) => html`<option value="${item.id}">${item.name}</option>`)}`
  );
}

function currentSubject() {
  return qs('[name="subject_id"]', state.ctx.el)?.value || '';
}

/** O assunto padrão do lote, quando escolhido: vale para as aulas sem assunto. */
function defaultTopic() {
  const select = qs('[name="topic_id"]', state.ctx.el);
  if (!select || !select.value) return null;
  const topic = state.topics.find((item) => item.id === select.value);
  return { id: select.value, name: topic ? topic.name : '' };
}

function collectSettings() {
  const el = state.ctx.el;
  const value = (name) => qs(`[name="${name}"]`, el)?.value?.trim() || '';
  return {
    subject_id: value('subject_id'),
    topic_id: value('topic_id') || undefined,
    subtopic_id: (value('topic_id') && value('subtopic_id')) || undefined,
    teacher_name: value('teacher_name') || undefined,
    difficulty: Number(value('difficulty')) || 2,
    duration_min: Number(value('duration_min')) || undefined,
    active: qs('[name="active"]', el)?.checked !== false,
    exam_ids: qsa('[data-exam-id]:checked', el).map((box) => box.dataset.examId),
  };
}

// ---------------------------------------------------------------------
// Assuntos de cada aula
// ---------------------------------------------------------------------

/** A matéria e o título que a leitura usou: mudou um dos dois, a leitura vale outra vez. */
const readingKey = (subjectId, title) => `${subjectId}\n${String(title || '').trim()}`;

function chipName(chip) {
  if (!chip.topic_id) return chip.new_topic_name || 'Assunto novo';
  return chip.subtopic_name ? `${chip.topic_name} › ${chip.subtopic_name}` : chip.topic_name || 'Assunto';
}

/** Um item da proposta de analyze-titles vira um chip. */
function chipFromProposal(topic) {
  return {
    topic_id: topic.topic_id || null,
    subtopic_id: topic.subtopic_id || null,
    new_topic_name: topic.topic_id ? null : topic.new_topic_name || null,
    label: topic.label || null,
    topic_name: topic.topic_name || null,
    subtopic_name: topic.subtopic_name || null,
    source: 'ia',
  };
}

/** Assunto escolhido à mão no select da linha. */
function chipFromTopic(topic, label = null) {
  return {
    topic_id: topic.id,
    subtopic_id: null,
    new_topic_name: null,
    label,
    topic_name: topic.name,
    subtopic_name: null,
    source: 'manual',
  };
}

/** O que o servidor recebe de cada chip. */
function chipPayload(chip) {
  const base = { label: chip.label || null, source: chip.source === 'manual' ? 'manual' : 'ia' };
  if (chip.topic_id) return { ...base, topic_id: chip.topic_id, subtopic_id: chip.subtopic_id || null };
  return { ...base, new_topic_name: chip.new_topic_name };
}

const isPending = (item) => item.status !== 'done';
const isReading = (item) => item.reading === 'loading';

/** Aula que ainda não pode subir: nenhum assunto e nenhum assunto padrão no lote. */
function isBlocked(item, padrao = defaultTopic()) {
  return isPending(item) && !isReading(item) && !item.topics.length && !padrao;
}

/** Precisa de uma leitura (nova ou de novo): título ou matéria mudaram e ninguém mexeu nos chips. */
function needsReading(item, subjectId) {
  return isPending(item)
    && item.status !== 'uploading'
    && !item.touched
    && Boolean(item.title.trim())
    && item.requestedKey !== readingKey(subjectId, item.title);
}

function scheduleReading() {
  if (!state) return;
  clearTimeout(state.readTimer);
  state.readTimer = setTimeout(() => {
    if (!state) return;
    state.readTimer = null;
    readTitles();
  }, LEITURA_DEBOUNCE_MS);
}

/**
 * Lê os títulos que ainda não têm leitura para a matéria escolhida e põe a
 * proposta de cada um na tabela. Nada é gravado aqui: o cadastro acontece
 * só em "Enviar e cadastrar", com os chips que estiverem na tela.
 */
async function readTitles() {
  if (!state) return;
  clearTimeout(state.readTimer);
  state.readTimer = null;
  const subjectId = currentSubject();
  if (!subjectId) {
    paintQueue();
    return;
  }
  const wanted = state.queue.filter((item) => needsReading(item, subjectId));
  if (!wanted.length) return;

  for (const item of wanted) {
    item.requestedKey = readingKey(subjectId, item.title);
    item.reading = 'loading';
    item.note = '';
  }
  paintQueue();

  const token = state.token;
  for (let start = 0; start < wanted.length; start += TITULOS_POR_LEITURA) {
    const chunk = wanted.slice(start, start + TITULOS_POR_LEITURA);
    const keys = chunk.map((item) => item.requestedKey);
    let result = null;
    let failure = '';
    try {
      result = await api.post('/api/admin/lessons/analyze-titles', {
        subject_id: subjectId,
        titles: chunk.map((item) => item.title.trim()),
      });
    } catch (err) {
      failure = (err && err.message) || 'Não deu para ler os títulos agora.';
    }
    if (!state || state.token !== token) return;

    chunk.forEach((item, index) => {
      // título ou matéria mudaram no meio do caminho: esta resposta já não vale
      if (item.requestedKey !== keys[index]) return;
      const found = result && Array.isArray(result.items) ? result.items[index] : null;
      if (!found) {
        item.reading = 'error';
        // sem leitura: o próximo gatilho (ou "Ler de novo") pede outra vez
        item.requestedKey = '';
        item.note = failure || 'Não deu para ler este título.';
        return;
      }
      item.reading = 'done';
      item.topics = (Array.isArray(found.topics) ? found.topics : []).slice(0, MAX_ASSUNTOS).map(chipFromProposal);
      item.failed = Boolean(found.error);
      if (found.via === 'parcial') item.note = 'Parte do título ficou sem assunto.';
      else if (!item.topics.length) item.note = found.error ? `Leitura incompleta: ${found.error}` : 'Nenhum assunto reconhecido no título.';
      else item.note = '';
    });
    paintQueue();
  }
}

/** Ler de novo, descartando o que foi mexido à mão na linha. */
function rereadItem(item) {
  item.touched = false;
  item.requestedKey = '';
  item.failed = false;
  readTitles();
}

/** A matéria mudou: os assuntos lidos eram da matéria anterior. */
function resetTopics() {
  for (const item of state.queue) {
    if (!isPending(item)) continue;
    item.topics = [];
    item.touched = false;
    item.requestedKey = '';
    item.reading = 'idle';
    item.note = '';
    item.failed = false;
    item.swapping = null;
  }
}

function findItem(id) {
  return state.queue.find((item) => item.id === id) || null;
}

function removeChip(item, index) {
  item.topics.splice(index, 1);
  item.touched = true;
  item.swapping = null;
  paintQueue();
}

function addChip(item, topicId) {
  const topic = state.topics.find((entry) => entry.id === topicId);
  if (!topic || item.topics.length >= MAX_ASSUNTOS) return;
  if (item.topics.some((chip) => chip.topic_id === topic.id && !chip.subtopic_id)) return;
  item.topics.push(chipFromTopic(topic));
  item.touched = true;
  paintQueue();
}

/** Troca no mesmo lugar: a ordem decide quantas questões saem de cada assunto. */
function swapChip(item, index, topicId) {
  const topic = state.topics.find((entry) => entry.id === topicId);
  item.swapping = null;
  if (topic && item.topics[index]) {
    item.topics[index] = chipFromTopic(topic, item.topics[index].label);
    item.touched = true;
  }
  paintQueue();
}

/** Assuntos da matéria que ainda cabem na aula (sem repetir os outros chips dela). */
function topicChoices(item, exceptIndex = -1) {
  const used = new Set(
    item.topics
      .filter((chip, index) => index !== exceptIndex && chip.topic_id && !chip.subtopic_id)
      .map((chip) => chip.topic_id)
  );
  return state.topics.filter((topic) => !used.has(topic.id));
}

// ---------------------------------------------------------------------
// Fila de arquivos
// ---------------------------------------------------------------------
async function addFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file && file.size);
  if (!files.length) return;

  const room = MAX_FILES - state.queue.length;
  if (room <= 0) {
    toast(`O limite é de ${MAX_FILES} vídeos por envio.`, { type: 'warning' });
    return;
  }
  const accepted = files.slice(0, room);
  if (accepted.length < files.length) {
    toast(`Só couberam ${accepted.length} vídeos: o limite é ${MAX_FILES} por vez.`, { type: 'warning' });
  }

  for (const file of accepted) {
    const item = {
      id: `f${state.sequence++}`,
      file,
      title: titleFromFilename(file.name),
      bytes: file.size,
      mime: file.type || '',
      seconds: null,
      status: 'pending', // pending | uploading | uploaded | error | done
      progress: 0,
      url: null,
      message: '',
      // assuntos: os chips na ordem do título; touched = a equipe mexeu e uma
      // nova leitura não pode passar por cima
      topics: [],
      reading: 'idle', // idle | loading | done | error
      requestedKey: '',
      note: '',
      failed: false,
      touched: false,
      swapping: null,
    };
    state.queue.push(item);
  }
  paintQueue();
  readTitles();

  // A duração é lida em segundo plano, sem travar a tela. Cada leitura que
  // chega mexe só no texto da própria linha: redesenhar a tabela inteira a
  // cada vídeo era refazer 200 linhas (com o seletor de assuntos de cada uma)
  // 200 vezes seguidas, logo quando a equipe começa a corrigir os títulos.
  for (const item of state.queue) {
    if (item.seconds !== null || item.status !== 'pending') continue;
    readDuration(item.file).then((seconds) => {
      item.seconds = seconds;
      if (state) paintMeta(item);
    });
  }
}

/** Tamanho e duração do vídeo, o texto miúdo embaixo do nome do arquivo. */
function metaText(item) {
  return `${fmtBytes(item.bytes)}${item.seconds ? ` · ${fmtMinutes(Math.max(1, Math.round(item.seconds / 60)))}` : ''}`;
}

/** Atualiza só a linha do vídeo; a linha que ainda não foi desenhada pega o valor na próxima pintura. */
function paintMeta(item) {
  const meta = qs(`[data-row="${item.id}"] .lu-meta`, state.ctx.el);
  if (meta) meta.textContent = metaText(item);
}

function removeItem(id) {
  state.queue = state.queue.filter((item) => item.id !== id);
  paintQueue();
}

function statusBadge(item, padrao) {
  if (item.status === 'done') return badge('Cadastrada', 'green');
  if (item.status === 'error') return badge('Falhou', 'red');
  if (item.status === 'uploaded') return badge('Enviado', 'blue');
  if (item.status === 'uploading') return badge(`Enviando ${item.progress}%`, 'orange');
  if (isBlocked(item, padrao)) return badge('Sem assunto', 'orange', { icon: 'triangle-alert' });
  return badge('Na fila', 'gray');
}

function topicSelect(item, { index = -1, current = '' } = {}) {
  const swap = index >= 0;
  const choices = topicChoices(item, index);
  return html`
    <select class="select lu-topic-select${swap ? '' : ' lu-topic-add'}"
            ${raw(swap ? `data-topic-pick="${item.id}" data-index="${index}"` : `data-topic-add="${item.id}"`)}
            aria-label="${swap ? `Trocar o assunto ${current}` : 'Adicionar um assunto a esta aula'}">
      <option value="">${swap ? current : '+ Assunto'}</option>
      ${choices.map((topic) => html`<option value="${topic.id}">${topic.name}${topic.active === false ? ' (inativo)' : ''}</option>`)}
    </select>`;
}

function chipView(item, chip, index, locked) {
  const name = chipName(chip);
  const isNew = !chip.topic_id;
  if (!locked && item.swapping === index) return topicSelect(item, { index, current: name });
  const tip = isNew
    ? 'Assunto novo: é cadastrado na matéria quando a aula for enviada.'
    : chip.label && chip.label !== name ? `Lido no título como “${chip.label}”` : '';
  return html`
    <span class="chip chip-sm lu-topic${isNew ? ' is-new' : ''}" title="${tip}">
      ${index === 0 && item.topics.length > 1 ? html`<span class="lu-topic-main" title="Assunto principal">1º</span>` : ''}
      ${locked
        ? html`<span class="lu-topic-name">${name}</span>`
        : html`<button type="button" class="lu-topic-name" data-topic-swap="${item.id}" data-index="${index}"
                  title="Trocar este assunto">${name}</button>`}
      ${isNew ? html`<span class="lu-topic-new">novo</span>` : ''}
      ${locked
        ? ''
        : html`<button type="button" class="chip-remove" data-topic-remove="${item.id}" data-index="${index}"
                  aria-label="Tirar ${name} desta aula" title="Tirar da aula">${icon('x', { size: 12 })}</button>`}
    </span>`;
}

function topicsCell(item, { locked, subjectId, padrao }) {
  if (!subjectId) return html`<span class="lu-topics-hint">Escolha a matéria para ler os assuntos dos títulos.</span>`;
  if (isReading(item)) {
    return html`<span class="lu-topics-loading"><span class="spinner lu-spinner" aria-hidden="true"></span>Lendo o título…</span>`;
  }
  if (item.status === 'pending' && !item.title.trim()) {
    return html`<span class="lu-topics-hint">Dê um título à aula para ler os assuntos.</span>`;
  }
  const canAdd = !locked && item.topics.length < MAX_ASSUNTOS && state.topics.length > 0;
  const blocked = isBlocked(item, padrao);
  const canReread = !locked && (item.reading === 'error' || item.failed || item.touched);
  return html`
    <div class="lu-topics">
      ${item.topics.map((chip, index) => chipView(item, chip, index, locked))}
      ${!item.topics.length && isPending(item)
        ? blocked
          ? html`<span class="lu-topics-alert">${icon('triangle-alert', { size: 14 })}Escolha o assunto desta aula</span>`
          : html`<span class="lu-topics-hint">Vai para o assunto padrão${padrao && padrao.name ? `: ${padrao.name}` : ''}.</span>`
        : ''}
      ${canAdd ? topicSelect(item) : ''}
      ${canReread
        ? html`<button type="button" class="btn btn-ghost btn-sm btn-icon lu-topics-reread" data-topic-reread="${item.id}"
                  aria-label="Ler o título de novo" title="${item.touched ? 'Ler o título de novo (desfaz as trocas desta linha)' : 'Ler o título de novo'}">
                  ${icon('refresh-cw', { size: 14 })}
                </button>`
        : ''}
      ${item.note && isPending(item) ? html`<span class="lu-topics-note">${item.note}</span>` : ''}
    </div>`;
}

function queueRow(item, context) {
  const locked = state.busy || item.status === 'uploading' || item.status === 'done';
  const blocked = isBlocked(item, context.padrao);
  return html`
    <tr data-row="${item.id}" class="${blocked ? 'lu-row-blocked' : ''}">
      <td class="lu-file">
        <span class="lu-name">${item.file.name}</span>
        <span class="lu-meta">${metaText(item)}</span>
        ${item.status === 'uploading'
          ? html`<span class="progress lu-progress"><span class="progress-bar" style="width:${item.progress}%"></span></span>`
          : ''}
        ${item.message ? html`<span class="lu-message">${item.message}</span>` : ''}
      </td>
      <td>
        <input class="input lu-title" type="text" data-title="${item.id}" value="${item.title}"
               maxlength="200" placeholder="Título da aula" ${locked ? raw('disabled') : ''}>
      </td>
      <td class="lu-topics-cell">${topicsCell(item, { ...context, locked })}</td>
      <td class="lu-status">${statusBadge(item, context.padrao)}</td>
      <td class="lu-actions">
        ${locked
          ? ''
          : html`<button type="button" class="btn btn-ghost btn-icon" data-remove="${item.id}"
                    aria-label="Tirar da lista" title="Tirar da lista">${icon('trash-2')}</button>`}
      </td>
    </tr>`;
}

/** O controle que está com o foco, para devolvê-lo depois de redesenhar a tabela. */
function focusedControl(box) {
  const el = document.activeElement;
  if (!el || !box.contains(el)) return null;
  for (const attr of ['data-title', 'data-topic-add', 'data-topic-pick']) {
    if (!el.hasAttribute(attr)) continue;
    const index = el.getAttribute('data-index');
    return {
      selector: `[${attr}="${el.getAttribute(attr)}"]${index !== null ? `[data-index="${index}"]` : ''}`,
      start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
    };
  }
  return null;
}

function paintQueue() {
  const box = qs('#lu-queue', state.ctx.el);
  if (!box) return;
  if (!state.queue.length) {
    render(box, '');
    return;
  }
  const focus = focusedControl(box);
  const subjectId = currentSubject();
  const padrao = defaultTopic();
  const total = state.queue.reduce((sum, item) => sum + item.bytes, 0);
  const pending = state.queue.filter(isPending);
  const reading = state.queue.some(isReading);
  const blocked = pending.filter((item) => isBlocked(item, padrao));
  const withFailure = pending.filter((item) => item.reading === 'error' || (item.failed && !item.touched));
  const context = { subjectId, padrao };

  render(
    box,
    html`
      <section class="card lu-queue">
        <div class="card-header">
          <div>
            <h2 class="card-title">${state.queue.length} ${state.queue.length === 1 ? 'vídeo' : 'vídeos'} na lista</h2>
            <p class="hint">${fmtBytes(total)} no total. Confira os títulos e os assuntos antes de enviar.</p>
            ${blocked.length
              ? html`<p class="lu-blocked">
                  ${icon('triangle-alert', { size: 14 })}
                  <span>${blocked.length === 1 ? '1 aula está sem assunto e só sobe' : `${blocked.length} aulas estão sem assunto e só sobem`}
                  depois de ganhar um, na própria linha ou no assunto padrão do lote.</span>
                </p>`
              : ''}
          </div>
          <div class="lu-head-actions">
            ${withFailure.length && !state.busy
              ? html`<button type="button" class="btn btn-ghost" data-act="reread" ${reading ? raw('disabled') : ''}>
                  ${icon('refresh-cw')}<span>Ler de novo ${withFailure.length === 1 ? 'o título que falhou' : `os ${withFailure.length} títulos que falharam`}</span>
                </button>`
              : ''}
            <button type="button" class="btn btn-ghost" data-act="clear" ${state.busy ? raw('disabled') : ''}>
              ${icon('trash-2')}<span>Limpar lista</span>
            </button>
            <button type="button" class="btn btn-primary" data-act="send"
                    ${state.busy || reading || !pending.length || blocked.length === pending.length ? raw('disabled') : ''}>
              ${reading ? html`<span class="spinner lu-spinner" aria-hidden="true"></span><span>Lendo os títulos…</span>` : html`${icon('upload')}<span>Enviar e cadastrar</span>`}
            </button>
          </div>
        </div>
        <div class="card-body">
          <div class="table-wrap">
            <table class="table lu-table">
              <thead>
                <tr>
                  <th scope="col">Arquivo</th>
                  <th scope="col">Título da aula</th>
                  <th scope="col">Assuntos</th>
                  <th scope="col">Situação</th>
                  <th scope="col"><span class="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>${state.queue.map((item) => queueRow(item, context))}</tbody>
            </table>
          </div>
        </div>
      </section>`
  );

  if (focus) {
    const again = qs(focus.selector, box);
    if (again && !again.disabled) {
      again.focus({ preventScroll: true });
      if (focus.start !== null && typeof again.setSelectionRange === 'function') {
        try {
          again.setSelectionRange(focus.start, focus.end);
        } catch {
          // campo que não aceita seleção
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------
async function sendAll() {
  const settings = collectSettings();
  if (!settings.subject_id) {
    toast('Escolha a matéria das aulas.', { type: 'warning' });
    qs('[name="subject_id"]', state.ctx.el)?.focus();
    return;
  }
  if (state.queue.some(isReading)) {
    toast('Espere terminar a leitura dos títulos.', { type: 'warning' });
    return;
  }
  const pendentes = state.queue.filter(isPending);
  if (!pendentes.length) return;

  const semTitulo = pendentes.find((item) => item.title.trim().length < 3);
  if (semTitulo) {
    toast('Todas as aulas precisam de um título com pelo menos 3 caracteres.', { type: 'warning' });
    qs(`[data-title="${semTitulo.id}"]`, state.ctx.el)?.focus();
    return;
  }

  // título editado há pouco: os chips ainda são da leitura do título antigo
  if (pendentes.some((item) => needsReading(item, settings.subject_id))) {
    await readTitles();
    if (!state) return;
  }

  const padrao = defaultTopic();
  const blocked = pendentes.filter((item) => isBlocked(item, padrao));
  const pending = pendentes.filter((item) => !isBlocked(item, padrao));
  if (!pending.length) {
    toast('Escolha o assunto das aulas marcadas ou um assunto padrão para o lote.', { type: 'warning' });
    qs(`[data-topic-add="${blocked[0]?.id}"]`, state.ctx.el)?.focus();
    return;
  }
  if (blocked.length) {
    const ok = await confirm({
      title: 'Aulas sem assunto',
      message:
        `${pluralize(blocked.length, 'aula está', 'aulas estão')} sem assunto e ${blocked.length === 1 ? 'fica' : 'ficam'} na lista até ganhar um. ` +
        (pending.length === 1 ? 'Enviar a outra agora?' : `Enviar as outras ${pending.length} agora?`),
      confirmText: pending.length === 1 ? 'Enviar a outra' : 'Enviar as outras',
    });
    if (!ok || !state) return;
  }

  state.busy = true;
  // trocar a matéria no meio do envio apagaria os assuntos das aulas que já subiram
  const subjectSelect = qs('[name="subject_id"]', state.ctx.el);
  if (subjectSelect) subjectSelect.disabled = true;
  paintQueue();

  // 1) envia os arquivos, um por vez, para não saturar a conexão
  for (const item of pending) {
    if (item.status === 'uploaded') continue;
    item.status = 'uploading';
    item.progress = 0;
    item.message = '';
    paintQueue();
    try {
      const saved = await uploadFile(item.file, {
        folder: 'videos',
        onProgress: (pct) => {
          item.progress = pct;
          const bar = qs(`[data-row="${item.id}"] .progress-bar`, state.ctx.el);
          const status = qs(`[data-row="${item.id}"] .lu-status`, state.ctx.el);
          if (bar) bar.style.width = `${pct}%`;
          if (status) render(status, statusBadge(item));
        },
      });
      item.url = saved.url;
      item.bytes = saved.bytes;
      item.mime = saved.content_type;
      item.status = 'uploaded';
    } catch (err) {
      item.status = 'error';
      item.message = (err && err.message) || 'Falha no envio.';
    }
    if (!state) return;
    paintQueue();
  }

  // 2) cadastra de uma vez só o que subiu. A linha que ficou sem assunto não
  // vai, mesmo com o vídeo já no servidor (um cadastro anterior falhou e
  // alguém tirou os chips): sem assunto e sem padrão, o servidor leria o
  // título e gravaria justamente os assuntos que acabaram de ser tirados —
  // o contrário do que a confirmação acima prometeu.
  const enviados = state.queue.filter((item) => item.status === 'uploaded' && !isBlocked(item, padrao));
  if (!enviados.length) {
    state.busy = false;
    if (subjectSelect) subjectSelect.disabled = false;
    paintQueue();
    toast('Nenhum vídeo chegou ao servidor.', { type: 'error' });
    return;
  }

  try {
    const result = await api.post('/api/admin/lessons/import', {
      ...settings,
      items: enviados.map((item) => ({
        video_url: item.url,
        title: item.title.trim(),
        video_seconds: item.seconds || undefined,
        video_bytes: item.bytes,
        video_mime: item.mime || undefined,
        // sem chips, a aula fica com o assunto padrão do lote
        ...(item.topics.length ? { topics: item.topics.map(chipPayload) } : {}),
      })),
    });
    if (!state) return;

    // Casado pela linha, não pelo título: o servidor identifica cada erro pela
    // posição, títulos repetidos colapsariam num Map, e o título que o servidor
    // devolve vem com os espaços aparados — um título com espaço na ponta
    // nunca casava e a aula aparecia como enviada mesmo tendo falhado.
    const falhas = new Map((result.errors || []).map((error) => [error.line, error.message]));
    // os assuntos como ficaram gravados (o "novo" já virou assunto da matéria)
    const gravadas = new Map((result.created || []).map((lesson) => [lesson.video_url, lesson]));
    enviados.forEach((item, index) => {
      const falha = falhas.get(index + 1);
      item.status = falha ? 'error' : 'done';
      item.message = falha || '';
      const lesson = gravadas.get(item.url);
      if (!falha && lesson && Array.isArray(lesson.topics)) {
        item.topics = lesson.topics.map((topic) => ({ ...topic, new_topic_name: null, source: topic.source || 'ia' }));
      }
    });
    state.result = result;
    toast(
      result.imported
        ? `${result.imported} ${result.imported === 1 ? 'aula cadastrada' : 'aulas cadastradas'}.`
        : 'Nenhuma aula foi cadastrada.',
      { type: result.imported ? 'success' : 'warning' }
    );
  } catch (err) {
    toast((err && err.message) || 'Os vídeos subiram, mas o cadastro falhou.', { type: 'error' });
  } finally {
    if (state) {
      state.busy = false;
      if (subjectSelect) subjectSelect.disabled = false;
      paintQueue();
      paintResult();
    }
  }
}

function paintResult() {
  const box = qs('#lu-result', state.ctx.el);
  if (!box || !state.result) return;
  const { imported, failed, errors, created } = state.result;
  const novos = [
    ...new Set(
      (created || []).flatMap((lesson) => (lesson.topics || []).filter((topic) => topic.created).map((topic) => topic.topic_name))
    ),
  ];
  // as que esperam assunto, inclusive a de vídeo já enviado que ficou de fora do cadastro
  const restantes = state.queue.filter((item) => isBlocked(item)).length;
  render(
    box,
    html`
      <section class="card lu-result">
        <div class="card-body">
          <h2 class="card-title">${imported} ${imported === 1 ? 'aula cadastrada' : 'aulas cadastradas'}</h2>
          ${failed ? html`<p class="hint">${failed} ${failed === 1 ? 'não entrou' : 'não entraram'}.</p>` : ''}
          ${imported
            ? html`<p class="hint">As três questões de cada aula são preparadas em segundo plano. A lista de aulas mostra quando ficam prontas.</p>`
            : ''}
          ${novos.length
            ? html`<p class="lu-new-topics">
                ${icon('sparkles', { size: 14 })}
                <span>${novos.length === 1 ? 'Assunto novo cadastrado na matéria' : 'Assuntos novos cadastrados na matéria'}: ${novos.join(', ')}.</span>
              </p>`
            : ''}
          ${restantes
            ? html`<p class="lu-blocked">${icon('triangle-alert', { size: 14 })}<span>${pluralize(restantes, 'aula ficou', 'aulas ficaram')} na lista esperando assunto.</span></p>`
            : ''}
          ${errors && errors.length
            ? html`<ul class="lu-errors">
                ${errors.map((item) => html`
                  <li>${icon('circle-alert')}<span><strong>${item.title || `Item ${item.line}`}</strong> — ${item.message}</span></li>`)}
              </ul>`
            : ''}
          <div class="lu-result-actions">
            <a class="btn btn-primary" href="/admin/aulas">${icon('play')}<span>Ver as aulas</span></a>
            <button type="button" class="btn btn-secondary" data-act="clear">${icon('plus')}<span>Enviar outro lote</span></button>
          </div>
        </div>
      </section>`
  );
}

// ---------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------
function view() {
  const { subjects, exams } = state;
  return html`
    ${pageHeader({
      title: 'Enviar aulas em massa',
      subtitle: 'Escolha vários vídeos de uma vez. A plataforma hospeda os arquivos, lê os assuntos de cada título e cadastra uma aula para cada um.',
      breadcrumb: [{ label: 'Aulas', href: '/admin/aulas' }, { label: 'Enviar em massa' }],
      actions: html`<a class="btn btn-ghost" href="/admin/aulas">${icon('arrow-left')}<span>Voltar</span></a>`,
    })}

    <div class="lu-cols">
      <section class="card">
        <div class="card-header"><h2 class="card-title">${icon('square-play')}<span>Vídeos</span></h2></div>
        <div class="card-body">
          <div class="lu-drop" data-drop tabindex="0" role="button" aria-label="Escolher os arquivos de vídeo">
            <span class="lu-drop-icon">${icon('upload')}</span>
            <p class="lu-drop-title">Arraste os vídeos aqui ou clique para escolher</p>
            <p class="hint">MP4, WEBM ou MOV, até 1 GB cada. Até ${MAX_FILES} por vez.</p>
          </div>
          <input type="file" accept="${ACCEPT}" multiple hidden data-picker>
          <p class="hint lu-drop-note">
            Os assuntos saem do nome do arquivo: “Aula 05 — Razão e Proporção, Regra de Três e Porcentagem” vira três
            assuntos dessa aula. Até ${MAX_ASSUNTOS} por aula.
          </p>
        </div>
      </section>

      <aside class="card">
        <div class="card-header"><h2 class="card-title">${icon('list-tree')}<span>Vale para todas</span></h2></div>
        <div class="card-body lu-settings">
          <div class="field">
            <label class="label" for="lu-subject">Matéria <span class="req">*</span></label>
            <select class="select" id="lu-subject" name="subject_id">
              <option value="">Selecione a matéria</option>
              ${subjects.map((subject) => html`<option value="${subject.id}">${subject.name}</option>`)}
            </select>
          </div>
          <div class="field">
            <label class="label" for="lu-topic">Assunto padrão <span class="hint-inline">(opcional)</span></label>
            <select class="select" id="lu-topic" name="topic_id" disabled>
              <option value="">Selecione a matéria primeiro</option>
            </select>
            <p class="hint">Vale só para as aulas em que o título não trouxe assunto.</p>
          </div>
          <div class="field">
            <label class="label" for="lu-subtopic">Subassunto padrão <span class="hint-inline">(opcional)</span></label>
            <select class="select" id="lu-subtopic" name="subtopic_id" disabled>
              <option value="">Escolha o assunto padrão primeiro</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="lu-teacher">Professor <span class="hint-inline">(opcional)</span></label>
            <input class="input" id="lu-teacher" name="teacher_name" maxlength="120" placeholder="Nome de quem grava">
          </div>
          <div class="lu-row">
            <div class="field">
              <label class="label" for="lu-difficulty">Dificuldade</label>
              <select class="select" id="lu-difficulty" name="difficulty">
                <option value="1">Básico</option>
                <option value="2" selected>Intermediário</option>
                <option value="3">Avançado</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="lu-duration">Duração padrão</label>
              <input class="input" id="lu-duration" name="duration_min" type="number" min="1" max="600" step="1" value="30">
              <p class="hint">Usada quando não der para ler a duração do arquivo.</p>
            </div>
          </div>
          <label class="switch-field">
            <span class="switch-title">Aulas ativas</span>
            <input type="checkbox" role="switch" class="switch" name="active" checked>
          </label>
          <div class="field">
            <span class="label">Provas em que caem</span>
            ${exams.length
              ? html`<div class="lu-exams">
                  ${exams.map((exam) => html`
                    <label class="chip lu-exam">
                      <input type="checkbox" data-exam-id="${exam.id}">
                      <span>${exam.short_name || exam.name}</span>
                    </label>`)}
                </div>`
              : html`<p class="hint">Nenhum vestibular cadastrado.</p>`}
          </div>
        </div>
      </aside>
    </div>

    <div id="lu-queue"></div>
    <div id="lu-result"></div>`;
}

async function renderLessonsImport(ctx) {
  ctx.setTitle('Enviar aulas em massa');
  render(ctx.el, skeleton('page'));

  const token = Symbol('admin-lessons-upload');
  state = {
    ctx, token, subjects: [], topics: [], subtopics: [], exams: [],
    queue: [], sequence: 1, busy: false, result: null, off: [], readTimer: null,
  };

  try {
    const [subjects, exams] = await Promise.all([
      api.get('/api/admin/content/subjects', { query: { limit: 200 } }).then((d) => (Array.isArray(d) ? d : d.items || [])),
      api.get('/api/admin/exams').then((d) => (Array.isArray(d) ? d : d.items || [])),
    ]);
    if (!state || state.token !== token) return;
    state.subjects = subjects;
    state.exams = exams;
  } catch (err) {
    if (!state || state.token !== token) return;
    render(
      ctx.el,
      html`
        ${pageHeader({ title: 'Enviar aulas em massa' })}
        ${errorState({
          title: 'Não foi possível carregar as matérias',
          message: (err && err.message) || 'Verifique sua conexão e tente novamente.',
          retry: 'reload-upload',
        })}`
    );
    const button = qs('[data-action="reload-upload"]', ctx.el);
    if (button) button.addEventListener('click', () => renderLessonsImport(ctx));
    return;
  }

  render(ctx.el, view());

  const query = ctx.query || {};
  if (query.subject_id) {
    const subjectSelect = qs('[name="subject_id"]', ctx.el);
    if (subjectSelect) subjectSelect.value = query.subject_id;
    await loadTopics(query.subject_id, { keep: query.topic_id || '' });
    if (!state || state.token !== token) return;
  }

  const picker = qs('[data-picker]', ctx.el);
  const drop = qs('[data-drop]', ctx.el);

  const onPick = () => picker?.click();
  const onFiles = () => {
    addFiles(picker.files);
    picker.value = '';
  };
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onOver = (event) => {
    stop(event);
    drop.classList.add('is-drag');
  };
  const onLeave = (event) => {
    stop(event);
    drop.classList.remove('is-drag');
  };
  const onDrop = (event) => {
    stop(event);
    drop.classList.remove('is-drag');
    addFiles(event.dataTransfer?.files);
  };
  const onKey = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPick();
    }
  };

  drop?.addEventListener('click', onPick);
  drop?.addEventListener('keydown', onKey);
  drop?.addEventListener('dragover', onOver);
  drop?.addEventListener('dragleave', onLeave);
  drop?.addEventListener('drop', onDrop);
  picker?.addEventListener('change', onFiles);
  state.off.push(() => {
    drop?.removeEventListener('click', onPick);
    drop?.removeEventListener('keydown', onKey);
    drop?.removeEventListener('dragover', onOver);
    drop?.removeEventListener('dragleave', onLeave);
    drop?.removeEventListener('drop', onDrop);
    picker?.removeEventListener('change', onFiles);
  });

  state.off.push(
    on(ctx.el, 'change', '[name="subject_id"]', async (event, select) => {
      // os assuntos lidos eram da matéria anterior: lê tudo de novo
      resetTopics();
      paintQueue();
      readTitles();
      await loadTopics(select.value);
      if (state) paintQueue();
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[name="topic_id"]', (event, select) => {
      loadSubtopics(select.value);
      // com assunto padrão, a aula sem assunto deixa de travar o envio
      paintQueue();
    })
  );
  state.off.push(on(ctx.el, 'click', '[data-remove]', (event, button) => removeItem(button.dataset.remove)));

  // título: guardado a cada tecla (a tabela é redesenhada quando chega uma
  // leitura ou uma duração) e lido de novo quando a edição termina
  state.off.push(
    on(ctx.el, 'input', '[data-title]', (event, input) => {
      const item = findItem(input.dataset.title);
      if (item) item.title = input.value;
    })
  );
  state.off.push(on(ctx.el, 'change', '[data-title]', () => scheduleReading()));

  state.off.push(
    on(ctx.el, 'click', '[data-topic-remove]', (event, button) => {
      const item = findItem(button.dataset.topicRemove);
      if (item) removeChip(item, Number(button.dataset.index));
    })
  );
  state.off.push(
    on(ctx.el, 'click', '[data-topic-swap]', (event, button) => {
      const item = findItem(button.dataset.topicSwap);
      if (!item || !state.topics.length) return;
      item.swapping = Number(button.dataset.index);
      paintQueue();
      const select = qs(`[data-topic-pick="${item.id}"][data-index="${item.swapping}"]`, ctx.el);
      if (select) {
        select.focus();
        try {
          select.showPicker?.();
        } catch {
          // navegador sem showPicker em select: o foco basta
        }
      }
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[data-topic-pick]', (event, select) => {
      const item = findItem(select.dataset.topicPick);
      if (!item) return;
      if (select.value) swapChip(item, Number(select.dataset.index), select.value);
    })
  );
  state.off.push(
    on(ctx.el, 'focusout', '[data-topic-pick]', (event, select) => {
      const item = findItem(select.dataset.topicPick);
      // saiu sem escolher: o chip volta como estava
      if (item && item.swapping === Number(select.dataset.index) && !select.value) {
        item.swapping = null;
        setTimeout(() => state && paintQueue(), 0);
      }
    })
  );
  state.off.push(
    on(ctx.el, 'keydown', '[data-topic-pick]', (event, select) => {
      if (event.key !== 'Escape') return;
      const item = findItem(select.dataset.topicPick);
      if (!item) return;
      event.preventDefault();
      item.swapping = null;
      paintQueue();
    })
  );
  state.off.push(
    on(ctx.el, 'change', '[data-topic-add]', (event, select) => {
      const item = findItem(select.dataset.topicAdd);
      if (item && select.value) addChip(item, select.value);
    })
  );
  state.off.push(
    on(ctx.el, 'click', '[data-topic-reread]', (event, button) => {
      const item = findItem(button.dataset.topicReread);
      if (item) rereadItem(item);
    })
  );

  state.off.push(
    on(ctx.el, 'click', '[data-act]', async (event, button) => {
      event.preventDefault();
      const act = button.dataset.act;
      if (act === 'send') sendAll();
      else if (act === 'reread') {
        for (const item of state.queue) {
          if (isPending(item) && (item.reading === 'error' || (item.failed && !item.touched))) {
            item.requestedKey = '';
            item.failed = false;
          }
        }
        readTitles();
      } else if (act === 'clear') {
        if (state.busy) return;
        if (state.queue.some((item) => item.status === 'done')) {
          // tira as cadastradas; as que esperam assunto continuam na lista
          state.queue = state.queue.filter(isPending);
          state.result = null;
          render(qs('#lu-result', ctx.el), '');
          paintQueue();
          return;
        }
        const ok = await confirm({ title: 'Limpar a lista', message: 'Os vídeos escolhidos serão descartados.', confirmText: 'Limpar' });
        if (!ok || !state) return;
        state.queue = [];
        paintQueue();
      }
    })
  );
}

export default renderLessonsImport;

export function unmount() {
  if (!state) return;
  clearTimeout(state.readTimer);
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

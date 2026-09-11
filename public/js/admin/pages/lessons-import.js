// =====================================================================
// Foco Elite — Admin › Enviar aulas em massa
//
// A equipe grava as videoaulas e envia os arquivos para a plataforma. Uma a
// uma seria uma tarde inteira, então aqui ela escolhe todos os arquivos de
// uma vez, define matéria e assunto uma única vez, e a tela envia um por um
// mostrando o progresso. Título vem do nome do arquivo e é editável; a
// duração é lida do próprio vídeo no navegador.
//
// API: POST /api/admin/uploads   (um envio por arquivo, em fluxo)
//      POST /api/admin/lessons/import  (cadastra todas de uma vez)
// =====================================================================
import { api } from '../../core/api.js';
import {
  html, raw, render, toast, qs, qsa, on,
  pageHeader, skeleton, errorState, badge, setLoading, confirm,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { fmtBytes, fmtMinutes } from '../../core/format.js';
import { uploadFile } from '../../components/file-input.js';

let state = null;

const ACCEPT = 'video/mp4,video/webm,video/quicktime';
const MAX_FILES = 200;

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
// Classificação
// ---------------------------------------------------------------------
async function loadTopics(subjectId, { keep = '' } = {}) {
  const select = qs('[name="topic_id"]', state.ctx.el);
  const subSelect = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;

  if (!subjectId) {
    select.disabled = true;
    select.innerHTML = '<option value="">Selecione a matéria primeiro</option>';
    if (subSelect) {
      subSelect.disabled = true;
      subSelect.innerHTML = '<option value="">Selecione o assunto primeiro</option>';
    }
    return;
  }

  select.disabled = true;
  select.innerHTML = '<option value="">Carregando…</option>';
  try {
    const data = await api.get('/api/admin/content/topics', { query: { subject_id: subjectId, limit: 500 } });
    state.topics = Array.isArray(data) ? data : data.items || [];
  } catch {
    state.topics = [];
  }
  select.disabled = false;
  select.innerHTML =
    '<option value="">Selecione o assunto</option>' +
    state.topics.map((topic) => `<option value="${topic.id}">${topic.name}</option>`).join('');
  if (keep) select.value = keep;
  await loadSubtopics(select.value);
}

async function loadSubtopics(topicId) {
  const select = qs('[name="subtopic_id"]', state.ctx.el);
  if (!select) return;
  if (!topicId) {
    select.disabled = true;
    select.innerHTML = '<option value="">Selecione o assunto primeiro</option>';
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
  select.innerHTML =
    '<option value="">Sem subassunto</option>' +
    state.subtopics.map((item) => `<option value="${item.id}">${item.name}</option>`).join('');
}

function collectSettings() {
  const el = state.ctx.el;
  const value = (name) => qs(`[name="${name}"]`, el)?.value?.trim() || '';
  return {
    subject_id: value('subject_id'),
    topic_id: value('topic_id'),
    subtopic_id: value('subtopic_id') || undefined,
    teacher_name: value('teacher_name') || undefined,
    difficulty: Number(value('difficulty')) || 2,
    duration_min: Number(value('duration_min')) || undefined,
    active: qs('[name="active"]', el)?.checked !== false,
    exam_ids: qsa('[data-exam-id]:checked', el).map((box) => box.dataset.examId),
  };
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
    };
    state.queue.push(item);
  }
  paintQueue();

  // a duração é lida em segundo plano, sem travar a tela
  for (const item of state.queue) {
    if (item.seconds !== null || item.status !== 'pending') continue;
    readDuration(item.file).then((seconds) => {
      item.seconds = seconds;
      if (state) paintQueue();
    });
  }
}

function removeItem(id) {
  state.queue = state.queue.filter((item) => item.id !== id);
  paintQueue();
}

function statusBadge(item) {
  if (item.status === 'done') return badge('Cadastrada', 'green');
  if (item.status === 'error') return badge('Falhou', 'red');
  if (item.status === 'uploaded') return badge('Enviado', 'blue');
  if (item.status === 'uploading') return badge(`Enviando ${item.progress}%`, 'orange');
  return badge('Na fila', 'gray');
}

function queueRow(item) {
  const locked = item.status === 'uploading' || item.status === 'done';
  return html`
    <tr data-row="${item.id}">
      <td class="lu-file">
        <span class="lu-name">${item.file.name}</span>
        <span class="lu-meta">
          ${fmtBytes(item.bytes)}${item.seconds ? ` · ${fmtMinutes(Math.max(1, Math.round(item.seconds / 60)))}` : ''}
        </span>
        ${item.status === 'uploading'
          ? html`<span class="progress lu-progress"><span class="progress-bar" style="width:${item.progress}%"></span></span>`
          : ''}
        ${item.message ? html`<span class="lu-message">${item.message}</span>` : ''}
      </td>
      <td>
        <input class="input lu-title" type="text" data-title="${item.id}" value="${item.title}"
               maxlength="200" placeholder="Título da aula" ${locked ? raw('disabled') : ''}>
      </td>
      <td class="lu-status">${statusBadge(item)}</td>
      <td class="lu-actions">
        ${locked
          ? ''
          : html`<button type="button" class="btn btn-ghost btn-icon" data-remove="${item.id}"
                    aria-label="Tirar da lista" title="Tirar da lista">${icon('trash-2')}</button>`}
      </td>
    </tr>`;
}

function paintQueue() {
  const box = qs('#lu-queue', state.ctx.el);
  if (!box) return;
  if (!state.queue.length) {
    render(box, '');
    return;
  }
  const total = state.queue.reduce((sum, item) => sum + item.bytes, 0);
  const pending = state.queue.filter((item) => item.status !== 'done').length;

  render(
    box,
    html`
      <section class="card lu-queue">
        <div class="card-header">
          <div>
            <h2 class="card-title">${state.queue.length} ${state.queue.length === 1 ? 'vídeo' : 'vídeos'} na lista</h2>
            <p class="hint">${fmtBytes(total)} no total. Confira os títulos antes de enviar.</p>
          </div>
          <div class="lu-head-actions">
            <button type="button" class="btn btn-ghost" data-act="clear" ${state.busy ? raw('disabled') : ''}>
              ${icon('trash-2')}<span>Limpar lista</span>
            </button>
            <button type="button" class="btn btn-primary" data-act="send" ${state.busy || !pending ? raw('disabled') : ''}>
              ${icon('upload')}<span>Enviar e cadastrar</span>
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
                  <th scope="col">Situação</th>
                  <th scope="col"><span class="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>${state.queue.map(queueRow)}</tbody>
            </table>
          </div>
        </div>
      </section>`
  );
}

// ---------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------
async function sendAll() {
  const settings = collectSettings();
  if (!settings.subject_id || !settings.topic_id) {
    toast('Escolha a matéria e o assunto das aulas.', { type: 'warning' });
    qs('[name="subject_id"]', state.ctx.el)?.focus();
    return;
  }
  const pending = state.queue.filter((item) => item.status !== 'done');
  if (!pending.length) return;

  // os títulos podem ter sido editados na tabela
  for (const item of state.queue) {
    const field = qs(`[data-title="${item.id}"]`, state.ctx.el);
    if (field) item.title = field.value.trim();
  }
  const semTitulo = pending.find((item) => item.title.length < 3);
  if (semTitulo) {
    toast('Todas as aulas precisam de um título com pelo menos 3 caracteres.', { type: 'warning' });
    qs(`[data-title="${semTitulo.id}"]`, state.ctx.el)?.focus();
    return;
  }

  state.busy = true;
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
    paintQueue();
  }

  // 2) cadastra de uma vez só o que subiu
  const enviados = state.queue.filter((item) => item.status === 'uploaded');
  if (!enviados.length) {
    state.busy = false;
    paintQueue();
    toast('Nenhum vídeo chegou ao servidor.', { type: 'error' });
    return;
  }

  try {
    const result = await api.post('/api/admin/lessons/import', {
      ...settings,
      items: enviados.map((item) => ({
        video_url: item.url,
        title: item.title,
        video_seconds: item.seconds || undefined,
        video_bytes: item.bytes,
        video_mime: item.mime || undefined,
      })),
    });

    // Casado pela linha, não pelo título: o servidor identifica cada erro pela
    // posição, títulos repetidos colapsariam num Map, e o título que o servidor
    // devolve vem com os espaços aparados — um título com espaço na ponta
    // nunca casava e a aula aparecia como enviada mesmo tendo falhado.
    const falhas = new Map((result.errors || []).map((error) => [error.line, error.message]));
    enviados.forEach((item, index) => {
      const falha = falhas.get(index + 1);
      item.status = falha ? 'error' : 'done';
      item.message = falha || '';
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
    state.busy = false;
    paintQueue();
    paintResult();
  }
}

function paintResult() {
  const box = qs('#lu-result', state.ctx.el);
  if (!box || !state.result) return;
  const { imported, failed, errors } = state.result;
  render(
    box,
    html`
      <section class="card lu-result">
        <div class="card-body">
          <h2 class="card-title">${imported} ${imported === 1 ? 'aula cadastrada' : 'aulas cadastradas'}</h2>
          ${failed ? html`<p class="hint">${failed} ${failed === 1 ? 'não entrou' : 'não entraram'}.</p>` : ''}
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
      subtitle: 'Escolha vários vídeos de uma vez. A plataforma hospeda os arquivos e cadastra uma aula para cada um.',
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
            <label class="label" for="lu-topic">Assunto <span class="req">*</span></label>
            <select class="select" id="lu-topic" name="topic_id" disabled>
              <option value="">Selecione a matéria primeiro</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="lu-subtopic">Subassunto <span class="hint-inline">(opcional)</span></label>
            <select class="select" id="lu-subtopic" name="subtopic_id" disabled>
              <option value="">Selecione o assunto primeiro</option>
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
    queue: [], sequence: 1, busy: false, result: null, off: [],
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

  state.off.push(on(ctx.el, 'change', '[name="subject_id"]', (event, select) => loadTopics(select.value)));
  state.off.push(on(ctx.el, 'change', '[name="topic_id"]', (event, select) => loadSubtopics(select.value)));
  state.off.push(on(ctx.el, 'click', '[data-remove]', (event, button) => removeItem(button.dataset.remove)));
  state.off.push(
    on(ctx.el, 'click', '[data-act]', async (event, button) => {
      event.preventDefault();
      const act = button.dataset.act;
      if (act === 'send') sendAll();
      else if (act === 'clear') {
        if (state.busy) return;
        if (state.queue.some((item) => item.status === 'done')) {
          state.queue = [];
          state.result = null;
          render(qs('#lu-result', ctx.el), '');
          paintQueue();
          return;
        }
        const ok = await confirm({ title: 'Limpar a lista', message: 'Os vídeos escolhidos serão descartados.', confirmText: 'Limpar' });
        if (!ok) return;
        state.queue = [];
        paintQueue();
      }
    })
  );
}

export default renderLessonsImport;

export function unmount() {
  if (!state) return;
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

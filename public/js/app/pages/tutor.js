// =====================================================================
// Foco Elite — Tutor IA (ARCHITECTURE §6.4)
//
// Coluna esquerda com as conversas do aluno (criar, buscar, excluir) e área de
// chat com streaming token a token via api.stream (SSE: start / delta / done / error).
//
// Contexto: os parâmetros de query lesson_id, topic_id, question_id, subject_id e
// essay_id abrem a tela já criando uma conversa amarrada àquele material — é assim
// que os botões "Perguntar ao Tutor" das outras telas chegam aqui.
//
// Quando GET /api/tutor/status devolve available=false, as conversas antigas
// continuam legíveis, mas o envio fica desabilitado com um aviso sóbrio.
// =====================================================================
import { api, ApiError } from '../../core/api.js';
import { store } from '../../core/store.js';
import {
  html, raw, escapeHtml, render, toast, confirm, qs, qsa, on,
  pageHeader, emptyState, errorState, skeleton, alertBox,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { md } from '../../core/markdown.js';
import { fmtRelative, fmtTime, initials } from '../../core/format.js';

/** Atalhos oferecidos abaixo do chat (ARCHITECTURE §6.4). */
const SUGGESTIONS = [
  'Não entendi',
  'Explique de outro jeito',
  'Dê um exemplo',
  'Crie uma questão parecida',
  'Por que essa resposta está errada?',
];

/** Parâmetros de query que amarram a conversa a um material. */
const CONTEXT_PARAMS = ['lesson_id', 'topic_id', 'question_id', 'essay_id', 'subject_id'];

const MAX_MESSAGE_CHARS = 4000;
const COMPOSER_MAX_HEIGHT = 180;
const NARROW_WIDTH = 900;

let state = null;

// ---------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------

/** Texto do aluno: escapado, com as quebras de linha preservadas. */
function plainText(content) {
  return raw(escapeHtml(String(content || '')).replace(/\n/g, '<br>'));
}

/** Ícone que representa o contexto da conversa. */
function contextIcon(conversation) {
  if (!conversation) return 'message-square';
  if (conversation.lesson_id) return 'play';
  if (conversation.question_id) return 'file-text';
  if (conversation.essay_id) return 'pen-line';
  if (conversation.topic_id) return 'book-open';
  if (conversation.subject_id) return 'library';
  return 'message-square';
}

/** Trilha "matéria › assunto › aula" da conversa, já com link quando existe destino. */
function contextTrail(conversation) {
  if (!conversation) return [];
  const trail = [];
  if (conversation.subject_name) trail.push({ label: conversation.subject_name });
  if (conversation.topic_name) trail.push({ label: conversation.topic_name });
  if (conversation.lesson_title) {
    trail.push({ label: conversation.lesson_title, href: `/app/aulas/${conversation.lesson_id}` });
  }
  if (conversation.essay_title) {
    trail.push({ label: conversation.essay_title, href: `/app/redacao/${conversation.essay_id}` });
  }
  if (!trail.length && conversation.question_id) trail.push({ label: 'Questão em discussão' });
  return trail;
}

/** Resumo curto do contexto usado na lista lateral. */
function contextLabel(conversation) {
  const trail = contextTrail(conversation);
  return trail.length ? trail[trail.length - 1].label : '';
}

/** Iniciais do aluno para o avatar das bolhas. */
function studentInitials() {
  const name = (store.user && store.user.name) || '';
  return initials(name) || 'EU';
}

function isNarrow() {
  return window.innerWidth < NARROW_WIDTH;
}

/** Mensagem do aviso quando a IA não está disponível. */
function unavailableNotice(status) {
  if (status && status.configured && status.limit_reached) {
    return {
      title: 'O limite de uso da IA deste mês foi atingido',
      text: 'O Tutor volta a responder no próximo ciclo. Se precisar antes disso, fale com a equipe do Foco de Elite.',
    };
  }
  return {
    title: 'O Tutor IA ainda não foi ativado pela equipe',
    text: 'Assim que a integração for configurada, você poderá tirar dúvidas por aqui. Suas conversas anteriores continuam disponíveis.',
  };
}

const canSend = () => Boolean(state && state.status && state.status.available);

// ---------------------------------------------------------------------
// Lista de conversas
// ---------------------------------------------------------------------

function filteredConversations() {
  const term = (state.search || '').trim().toLowerCase();
  if (!term) return state.conversations;
  return state.conversations.filter((conversation) => {
    const haystack = [
      conversation.title,
      conversation.last_message,
      conversation.subject_name,
      conversation.topic_name,
      conversation.lesson_title,
      conversation.essay_title,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });
}

function conversationItem(conversation) {
  const active = state.activeId === conversation.id;
  const context = contextLabel(conversation);
  const when = conversation.last_message_at || conversation.updated_at;
  return html`
    <li class="tut-conv ${active ? 'is-active' : ''}">
      <button type="button" class="tut-conv-open" data-conv="${conversation.id}" aria-current="${active ? 'true' : 'false'}">
        <span class="tut-conv-icon">${icon(contextIcon(conversation))}</span>
        <span class="tut-conv-body">
          <span class="tut-conv-title">${conversation.title}</span>
          <span class="tut-conv-meta">
            ${context ? html`<span class="tut-conv-context">${context}</span>` : ''}
            <span>${fmtRelative(when)}</span>
          </span>
        </span>
      </button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm tut-conv-del" data-del="${conversation.id}" aria-label="Excluir a conversa ${conversation.title}">
        ${icon('trash-2', { size: 15 })}
      </button>
    </li>`;
}

function paintList() {
  const listEl = qs('[data-tut-list]', state.el);
  if (!listEl) return;

  if (state.listError) {
    render(listEl, errorState({ title: 'Não foi possível carregar as conversas', message: state.listError.message, retry: 'reload-tutor' }));
    return;
  }
  if (state.loadingList) {
    render(listEl, skeleton('list', 4));
    return;
  }

  const items = filteredConversations();
  if (!items.length) {
    const empty = state.conversations.length
      ? emptyState({ icon: 'search', title: 'Nenhuma conversa encontrada', text: 'Tente outro termo de busca.', size: 'sm' })
      : emptyState({
        icon: 'message-square',
        title: 'Nenhuma conversa ainda',
        text: 'Comece perguntando o que ficou confuso na última aula.',
        size: 'sm',
        action: canSend() ? { label: 'Nova conversa', icon: 'plus', dataAction: 'new' } : null,
      });
    render(listEl, empty);
    return;
  }
  render(listEl, html`<ul class="tut-conv-list">${items.map(conversationItem)}</ul>`);
}

// ---------------------------------------------------------------------
// Área de chat
// ---------------------------------------------------------------------

function messageBubble(message) {
  const isUser = message.role === 'user';
  return html`
    <div class="chat-msg ${isUser ? 'user' : 'assistant'}" data-message="${message.id || ''}">
      <span class="chat-avatar">${isUser ? html`${studentInitials()}` : icon('bot')}</span>
      <div class="tut-msg">
        <div class="chat-bubble ${isUser ? '' : 'md'}">${isUser ? plainText(message.content) : md(message.content)}</div>
        ${message.created_at ? html`<div class="chat-time">${fmtTime(message.created_at)}</div>` : ''}
      </div>
    </div>`;
}

/** Bloco de boas-vindas exibido em uma conversa ainda sem mensagens. */
function chatWelcome(conversation) {
  const trail = contextTrail(conversation);
  const focus = trail.length ? trail[trail.length - 1].label : null;
  return html`
    <div class="tut-welcome">
      <span class="icon-box icon-box-lg">${icon('bot')}</span>
      <h3 class="tut-welcome-title">${focus ? `Vamos falar sobre ${focus}` : 'Qual é a sua dúvida?'}</h3>
      <p class="tut-welcome-text">
        O Tutor conhece a prova que você escolheu e o conteúdo desta conversa. Peça explicações passo a passo,
        exemplos, correções de raciocínio ou uma questão para testar o que você acabou de estudar.
      </p>
    </div>`;
}

function chatHeader(conversation) {
  const trail = contextTrail(conversation);
  return html`
    <header class="chat-header">
      <button type="button" class="btn btn-ghost btn-icon tut-back" data-action="back" aria-label="Voltar para as conversas">
        ${icon('arrow-left')}
      </button>
      <div class="tut-head-main">
        <h2 class="tut-head-title">${conversation.title}</h2>
        ${trail.length
          ? html`
            <p class="tut-head-trail">
              ${trail.map((step, index) => html`
                ${index > 0 ? html`<span class="tut-head-sep" aria-hidden="true">${icon('chevron-right', { size: 12 })}</span>` : ''}
                ${step.href ? html`<a href="${step.href}">${step.label}</a>` : html`<span>${step.label}</span>`}
              `)}
            </p>`
          : html`<p class="tut-head-trail"><span>Conversa livre</span></p>`}
      </div>
      <button type="button" class="btn btn-ghost btn-icon" data-del="${conversation.id}" aria-label="Excluir esta conversa">
        ${icon('trash-2')}
      </button>
    </header>`;
}

function chatComposer() {
  const disabled = !canSend();
  return html`
    <div class="chat-suggestions tut-suggestions" data-tut-suggestions>
      ${SUGGESTIONS.map((text) => html`
        <button type="button" class="chip tut-chip" data-suggestion="${text}" ${disabled ? raw('disabled') : ''}>${text}</button>`)}
    </div>
    <form class="chat-composer" data-tut-composer>
      <textarea
        class="textarea"
        data-tut-input
        rows="1"
        maxlength="${MAX_MESSAGE_CHARS}"
        placeholder="${disabled ? 'O envio está indisponível no momento' : 'Escreva sua dúvida…'}"
        aria-label="Sua mensagem para o Tutor"
        ${disabled ? raw('disabled') : ''}></textarea>
      <button type="submit" class="btn btn-primary btn-icon" data-tut-send aria-label="Enviar mensagem" ${disabled ? raw('disabled') : ''}>
        ${icon('send')}
      </button>
    </form>
    <p class="chat-hint">Enter envia · Shift + Enter quebra a linha</p>`;
}

function paintChat() {
  const chatEl = qs('[data-tut-chat]', state.el);
  if (!chatEl) return;

  if (state.chatError) {
    render(chatEl, html`<div class="card tut-placeholder">${errorState({ title: 'Não foi possível abrir a conversa', message: state.chatError.message, retry: 'reload-chat' })}</div>`);
    return;
  }
  if (state.loadingChat) {
    render(chatEl, html`<div class="card tut-placeholder">${skeleton('text')}</div>`);
    return;
  }

  const conversation = state.active;
  if (!conversation) {
    render(
      chatEl,
      html`
        <div class="card tut-placeholder">
          ${emptyState({
            icon: 'bot',
            title: 'Escolha uma conversa ou comece uma nova',
            text: 'O Tutor IA responde com base na sua prova, na matéria e na aula que você estiver estudando.',
            action: canSend() ? { label: 'Nova conversa', icon: 'plus', dataAction: 'new' } : null,
          })}
        </div>`
    );
    return;
  }

  const messages = conversation.messages || [];
  render(
    chatEl,
    html`
      <div class="chat tut-box">
        ${chatHeader(conversation)}
        <div class="chat-messages" data-tut-messages>
          ${messages.length ? messages.map(messageBubble) : chatWelcome(conversation)}
        </div>
        ${chatComposer()}
      </div>`
  );
  scrollToEnd();
  focusComposer();
}

function scrollToEnd({ force = true } = {}) {
  const box = qs('[data-tut-messages]', state.el);
  if (!box) return;
  if (!force) {
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distance > 160) return;
  }
  box.scrollTop = box.scrollHeight;
}

function focusComposer() {
  if (isNarrow()) return;
  const input = qs('[data-tut-input]', state.el);
  if (input && !input.disabled) input.focus({ preventScroll: true });
}

function autoGrow(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}

function setPane(pane) {
  const layout = qs('[data-tut-layout]', state.el);
  if (layout) layout.dataset.pane = pane;
}

// ---------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------

async function loadConversations() {
  const token = state.token;
  state.loadingList = true;
  state.listError = null;
  paintList();
  try {
    const rows = await api.get('/api/tutor/conversations');
    if (!state || state.token !== token) return;
    state.conversations = Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (!state || state.token !== token) return;
    state.listError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  state.loadingList = false;
  paintList();
}

async function openConversation(id, { push = true } = {}) {
  if (!id) return;
  if (state.sending) {
    toast('Aguarde o Tutor terminar de responder.', { type: 'info' });
    return;
  }
  const token = state.token;
  state.activeId = id;
  state.chatError = null;
  state.loadingChat = true;
  paintList();
  paintChat();
  setPane('chat');
  try {
    const conversation = await api.get(`/api/tutor/conversations/${encodeURIComponent(id)}`);
    if (!state || state.token !== token) return;
    state.active = conversation;
    if (push) syncUrl(id);
  } catch (err) {
    if (!state || state.token !== token) return;
    state.active = null;
    state.chatError = err instanceof ApiError ? err : new ApiError({ message: 'Erro inesperado.' });
  }
  state.loadingChat = false;
  paintList();
  paintChat();
}

/** Mantém o endereço coerente com a conversa aberta, sem redisparar o roteador. */
function syncUrl(id) {
  const target = id ? `/app/tutor/${id}` : '/app/tutor';
  if (location.pathname + location.search === target) return;
  try {
    history.replaceState(history.state, '', target);
  } catch {
    /* histórico indisponível: o endereço fica como está */
  }
}

async function createConversation(context = {}) {
  const token = state.token;
  const button = qs('[data-action="new"]', state.el);
  if (button) button.disabled = true;
  try {
    const created = await api.post('/api/tutor/conversations', context);
    if (!state || state.token !== token) return null;
    state.conversations = [created, ...state.conversations.filter((row) => row.id !== created.id)];
    state.activeId = created.id;
    state.active = { ...created, messages: created.messages || [] };
    state.chatError = null;
    syncUrl(created.id);
    paintList();
    paintChat();
    setPane('chat');
    return created;
  } catch (err) {
    if (!state || state.token !== token) return null;
    toast(err && err.message ? err.message : 'Não foi possível abrir uma nova conversa.', { type: 'error' });
    return null;
  } finally {
    if (state && state.token === token && button) button.disabled = !canSend();
  }
}

async function removeConversation(id) {
  const conversation = state.conversations.find((row) => row.id === id);
  const ok = await confirm({
    title: 'Excluir conversa',
    message: conversation
      ? `A conversa "${conversation.title}" e todas as mensagens dela serão apagadas. Esta ação não pode ser desfeita.`
      : 'A conversa e todas as mensagens dela serão apagadas.',
    danger: true,
    confirmText: 'Excluir',
  });
  if (!ok || !state) return;
  try {
    await api.del(`/api/tutor/conversations/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err && err.message ? err.message : 'Não foi possível excluir a conversa.', { type: 'error' });
    return;
  }
  if (!state) return;
  state.conversations = state.conversations.filter((row) => row.id !== id);
  if (state.activeId === id) {
    state.activeId = null;
    state.active = null;
    syncUrl(null);
    setPane('list');
  }
  toast('Conversa excluída.', { type: 'success' });
  paintList();
  paintChat();
}

// ---------------------------------------------------------------------
// Envio com streaming
// ---------------------------------------------------------------------

/** Coloca a conversa ativa no topo da lista e atualiza título/prévia. */
function touchConversation({ title, lastMessage }) {
  const index = state.conversations.findIndex((row) => row.id === state.activeId);
  if (index === -1) return;
  const conversation = { ...state.conversations[index] };
  if (title) conversation.title = title;
  if (lastMessage) conversation.last_message = lastMessage.slice(0, 180);
  conversation.last_message_at = new Date().toISOString();
  conversation.updated_at = conversation.last_message_at;
  state.conversations.splice(index, 1);
  state.conversations.unshift(conversation);
  paintList();
}

function setSending(sending) {
  state.sending = sending;
  const input = qs('[data-tut-input]', state.el);
  const send = qs('[data-tut-send]', state.el);
  const blocked = sending || !canSend();
  if (input) input.disabled = blocked;
  if (send) {
    send.disabled = blocked;
    send.classList.toggle('is-loading', sending);
  }
  qsa('[data-suggestion]', state.el).forEach((chip) => {
    chip.disabled = blocked;
  });
  if (!sending) focusComposer();
}

async function sendMessage(text) {
  const content = String(text || '').trim();
  if (!content || !state || state.sending || !state.active || !canSend()) return;

  const conversation = state.active;
  const token = state.token;
  const box = qs('[data-tut-messages]', state.el);
  if (!box) return;

  // a primeira mensagem substitui o bloco de boas-vindas
  if (!(conversation.messages || []).length) render(box, '');

  const now = new Date().toISOString();
  conversation.messages = [...(conversation.messages || []), { id: null, role: 'user', content, created_at: now }];
  box.insertAdjacentHTML('beforeend', String(messageBubble({ role: 'user', content, created_at: now })));
  box.insertAdjacentHTML(
    'beforeend',
    String(html`
      <div class="chat-msg assistant" data-tut-pending>
        <span class="chat-avatar">${icon('bot')}</span>
        <div class="tut-msg">
          <div class="chat-bubble md" data-tut-answer><span class="chat-typing" aria-label="O Tutor está escrevendo"><span></span><span></span><span></span></span></div>
        </div>
      </div>`)
  );
  scrollToEnd();

  const input = qs('[data-tut-input]', state.el);
  if (input) {
    input.value = '';
    autoGrow(input);
  }
  setSending(true);
  touchConversation({ lastMessage: content });

  let answer = '';
  let frame = 0;
  const answerEl = () => qs('[data-tut-answer]', state.el);

  const paintAnswer = () => {
    frame = 0;
    const el = answerEl();
    if (el) render(el, md(answer));
    scrollToEnd({ force: false });
  };

  // encerra a bolha em curso: sem os marcadores, o próximo envio cria a sua própria
  const finish = () => {
    const el = answerEl();
    if (el) delete el.dataset.tutAnswer;
    const pending = qs('[data-tut-pending]', state.el);
    if (pending) delete pending.dataset.tutPending;
    setSending(false);
  };

  state.stream = api.stream(
    `/api/tutor/conversations/${encodeURIComponent(conversation.id)}/messages`,
    { content },
    {
      onDelta: (chunk) => {
        if (!state || state.token !== token) return;
        answer += chunk || '';
        if (!frame) frame = requestAnimationFrame(paintAnswer);
      },
      onDone: (data) => {
        if (!state || state.token !== token) return;
        if (frame) cancelAnimationFrame(frame);
        const finalText = answer.trim();
        const pending = qs('[data-tut-pending]', state.el);
        if (!finalText) {
          if (pending) pending.remove();
        } else {
          const el = answerEl();
          if (el) render(el, md(finalText));
          if (pending) {
            if (data && data.message_id) pending.dataset.message = data.message_id;
            const column = pending.querySelector('.tut-msg');
            if (column && !column.querySelector('.chat-time')) {
              column.insertAdjacentHTML('beforeend', String(html`<div class="chat-time">${fmtTime(new Date().toISOString())}</div>`));
            }
          }
          conversation.messages.push({
            id: (data && data.message_id) || null,
            role: 'assistant',
            content: finalText,
            created_at: new Date().toISOString(),
          });
        }
        if (data && data.title) {
          conversation.title = data.title;
          const titleEl = qs('.tut-head-title', state.el);
          if (titleEl) titleEl.textContent = data.title;
        }
        touchConversation({ title: data && data.title, lastMessage: finalText });
        state.stream = null;
        finish();
        scrollToEnd({ force: false });
      },
      onError: (err) => {
        if (!state || state.token !== token) return;
        if (frame) cancelAnimationFrame(frame);
        const pending = qs('[data-tut-pending]', state.el);
        const message = (err && err.message) || 'O Tutor não conseguiu responder agora.';
        if (answer.trim()) {
          const el = answerEl();
          if (el) render(el, md(answer));
          if (pending) {
            pending.insertAdjacentHTML(
              'beforeend',
              String(html`<p class="tut-stream-error">${icon('circle-alert', { size: 14 })}<span>A resposta foi interrompida: ${message}</span></p>`)
            );
          }
        } else if (pending) {
          render(
            pending,
            html`
              <span class="chat-avatar">${icon('circle-alert')}</span>
              <div class="tut-msg">
                <div class="chat-bubble tut-bubble-error">${message}</div>
              </div>`
          );
        }
        state.stream = null;
        finish();
        toast(message, { type: 'error' });
      },
    }
  );

  try {
    await state.stream;
  } catch (err) {
    if (state && state.token === token) {
      state.stream = null;
      finish();
      toast((err && err.message) || 'O Tutor não conseguiu responder agora.', { type: 'error' });
    }
  }
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------

export default async function renderTutor(ctx) {
  ctx.setTitle('Tutor IA');

  const token = Symbol('tutor');
  state = {
    token,
    el: ctx.el,
    status: null,
    conversations: [],
    activeId: null,
    active: null,
    search: '',
    sending: false,
    stream: null,
    loadingList: true,
    loadingChat: false,
    listError: null,
    chatError: null,
    off: [],
  };

  render(
    ctx.el,
    html`
      <div class="tut-page">
      ${pageHeader({
        title: 'Tutor IA',
        subtitle: 'Tire dúvidas a qualquer hora, com o contexto da aula, da questão ou da redação que você está estudando.',
      })}
      <div data-tut-notice></div>
      <div class="tut" data-tut-layout data-pane="list">
        <aside class="tut-aside" data-tut-aside>
          <div class="tut-aside-head">
            <button type="button" class="btn btn-primary w-full" data-action="new">${icon('plus')}<span>Nova conversa</span></button>
            <div class="tut-search">
              ${icon('search', { size: 15 })}
              <input type="search" class="input input-sm" data-tut-search placeholder="Buscar conversa" aria-label="Buscar conversa">
            </div>
          </div>
          <div class="tut-list" data-tut-list>${skeleton('list', 4)}</div>
        </aside>
        <section class="tut-chat" data-tut-chat>
          <div class="card tut-placeholder">${skeleton('text')}</div>
        </section>
      </div>
      </div>`
  );

  // --- eventos ---------------------------------------------------------
  state.off.push(
    on(ctx.el, 'click', '[data-action]', (event, button) => {
      const action = button.dataset.action;
      if (action === 'new') {
        event.preventDefault();
        createConversation({});
      } else if (action === 'back') {
        event.preventDefault();
        setPane('list');
      } else if (action === 'reload-tutor') {
        event.preventDefault();
        loadConversations();
      } else if (action === 'reload-chat') {
        event.preventDefault();
        if (state.activeId) openConversation(state.activeId, { push: false });
      }
    }),
    on(ctx.el, 'click', '[data-conv]', (event, button) => {
      event.preventDefault();
      const id = button.dataset.conv;
      if (id && id !== state.activeId) openConversation(id);
      else setPane('chat');
    }),
    on(ctx.el, 'click', '[data-del]', (event, button) => {
      event.preventDefault();
      event.stopPropagation();
      removeConversation(button.dataset.del);
    }),
    on(ctx.el, 'click', '[data-suggestion]', (event, button) => {
      event.preventDefault();
      sendMessage(button.dataset.suggestion);
    }),
    on(ctx.el, 'input', '[data-tut-search]', (event, input) => {
      state.search = input.value;
      paintList();
    }),
    on(ctx.el, 'input', '[data-tut-input]', (event, input) => {
      autoGrow(input);
    }),
    on(ctx.el, 'keydown', '[data-tut-input]', (event, input) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      sendMessage(input.value);
    }),
    on(ctx.el, 'submit', '[data-tut-composer]', (event) => {
      event.preventDefault();
      const input = qs('[data-tut-input]', state.el);
      if (input) sendMessage(input.value);
    })
  );

  // --- dados -----------------------------------------------------------
  try {
    state.status = await api.get('/api/tutor/status');
  } catch {
    state.status = { available: false, configured: false, limit_reached: false };
  }
  if (!state || state.token !== token) return;

  if (!canSend()) {
    const notice = unavailableNotice(state.status);
    render(qs('[data-tut-notice]', ctx.el), alertBox({ type: 'warning', title: notice.title, text: notice.text }));
    const newButton = qs('[data-action="new"]', ctx.el);
    if (newButton) newButton.disabled = true;
  }

  await loadConversations();
  if (!state || state.token !== token) return;

  // contexto vindo da tela anterior (aula, questão, assunto, redação)
  const context = {};
  for (const key of CONTEXT_PARAMS) {
    const value = ctx.query && ctx.query[key];
    if (value) context[key] = value;
  }

  if (Object.keys(context).length > 0) {
    await createConversation(context);
    return;
  }
  if (ctx.params && ctx.params.id) {
    await openConversation(ctx.params.id, { push: false });
    return;
  }
  if (!isNarrow() && state.conversations.length) {
    await openConversation(state.conversations[0].id);
    return;
  }
  paintChat();
}

export function unmount() {
  if (!state) return;
  if (state.stream && typeof state.stream.abort === 'function') {
    try {
      state.stream.abort();
    } catch {
      /* stream já encerrado */
    }
  }
  state.off.forEach((off) => {
    if (typeof off === 'function') off();
  });
  state = null;
}

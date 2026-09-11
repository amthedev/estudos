'use strict';

/**
 * Cliente HTTP mínimo para a API de Chat Completions do OpenRouter.
 * Mantém o formato usado pelo serviço de IA sem depender de SDK de terceiros.
 */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_ERROR_MESSAGE_LENGTH = 800;

class OpenRouterError extends Error {
  constructor(message, { status = null, code = null, requestId = null } = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function compactMessage(value, fallback = 'O OpenRouter devolveu um erro sem detalhes.') {
  const text = String(value || fallback).replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function abortError(message = 'Chamada cancelada.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function timeoutError() {
  const err = new Error('O OpenRouter demorou demais para responder.');
  err.name = 'TimeoutError';
  err.code = 'ETIMEDOUT';
  return err;
}

function requestSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  let timer = null;

  const forwardAbort = () => {
    const reason = externalSignal && externalSignal.reason;
    controller.abort(reason instanceof Error ? reason : abortError());
  };

  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(timeoutError()), timeout);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
    },
  };
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelay(response, attempt) {
  const header = response && response.headers ? response.headers.get('retry-after') : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()));
  }
  return 300 * 2 ** attempt;
}

function wait(ms, signal) {
  if (signal && signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      reject(signal.reason || abortError());
    }
    if (signal) signal.addEventListener('abort', cancelled, { once: true });
  });
}

async function responseError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const detail = payload && payload.error ? payload.error : payload;
  const message = detail && typeof detail === 'object' ? detail.message : detail;
  const code = detail && typeof detail === 'object' ? detail.code : null;
  return new OpenRouterError(compactMessage(message || response.statusText), {
    status: response.status,
    code,
    requestId: response.headers.get('x-request-id'),
  });
}

async function fetchWithRetry(fetchImpl, url, init, maxRetries) {
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (init.signal && init.signal.aborted) throw init.signal.reason || err;
      if (attempt >= maxRetries) throw err;
      await wait(300 * 2 ** attempt, init.signal);
      attempt += 1;
      continue;
    }

    if (response.ok) return response;
    const err = await responseError(response);
    if (!retryableStatus(response.status) || attempt >= maxRetries) throw err;
    await wait(retryDelay(response, attempt), init.signal);
    attempt += 1;
  }
}

const DONE = Symbol('openrouter-sse-done');

function parseSseEvent(lines) {
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim();
  if (!data) return null;
  if (data === '[DONE]') return DONE;

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw new OpenRouterError('O OpenRouter devolveu um evento de streaming inválido.', { status: 502 });
  }

  if (event && event.error) {
    const detail = typeof event.error === 'object' ? event.error : { message: event.error };
    throw new OpenRouterError(compactMessage(detail.message), {
      status: Number(detail.code) || 502,
      code: detail.code || null,
    });
  }
  return event;
}

async function* parseEventStream(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new OpenRouterError('O OpenRouter não devolveu um fluxo de resposta válido.', { status: 502 });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lines = [];

  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line !== '') {
      lines.push(line);
      return null;
    }
    const event = parseSseEvent(lines);
    lines = [];
    return event;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const event = consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (event === DONE) return;
      if (event) yield event;
      newline = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer) lines.push(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
  if (lines.length) {
    const event = parseSseEvent(lines);
    if (event && event !== DONE) yield event;
  }
}

function createClient({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  httpReferer,
  appTitle,
  fetchImpl = globalThis.fetch,
  maxRetries = DEFAULT_MAX_RETRIES,
} = {}) {
  if (!apiKey) throw new Error('createOpenRouterClient: "apiKey" é obrigatória.');
  if (typeof fetchImpl !== 'function') throw new Error('Este Node.js não oferece fetch global. Use Node 20 ou superior.');

  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

  async function create(params = {}, options = {}) {
    const scoped = requestSignal(options.signal, options.timeout);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: params.stream ? 'text/event-stream' : 'application/json',
    };
    if (httpReferer) headers['HTTP-Referer'] = httpReferer;
    if (appTitle) headers['X-OpenRouter-Title'] = appTitle;

    try {
      const response = await fetchWithRetry(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
          signal: scoped.signal,
        },
        Math.max(0, Number(maxRetries) || 0)
      );

      if (params.stream) {
        return (async function* streamWithCleanup() {
          try {
            yield* parseEventStream(response.body);
          } finally {
            scoped.cleanup();
          }
        })();
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw new OpenRouterError('O OpenRouter devolveu uma resposta inválida.', { status: 502 });
      }
      if (result && result.error) {
        const detail = typeof result.error === 'object' ? result.error : { message: result.error };
        throw new OpenRouterError(compactMessage(detail.message), {
          status: Number(detail.code) || 502,
          code: detail.code || null,
        });
      }
      return result;
    } catch (err) {
      scoped.cleanup();
      throw err;
    } finally {
      if (!params.stream) scoped.cleanup();
    }
  }

  return {
    chat: {
      completions: { create },
    },
  };
}

module.exports = {
  createClient,
  OpenRouterError,
  parseEventStream,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
};

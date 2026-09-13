// =====================================================================
// Foco Elite — cliente HTTP (ARCHITECTURE §6.2)
// api.get(path, { query }) · api.post(path, body) · api.put · api.patch · api.del
// api.stream(path, body, { onDelta, onDone, onError }) para SSE
// Sempre envia X-Requested-With: FocoElite e credentials: same-origin.
// 401 em /app → /login?next=<atual>; em /admin → /admin/login.
// =====================================================================

export class ApiError extends Error {
  constructor({ status = 0, code = 'internal', message = 'Erro inesperado.', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetwork() {
    return this.status === 0;
  }

  get isValidation() {
    return this.status === 400 || this.code === 'validation_error';
  }
}

const DEFAULT_MESSAGES = {
  0: 'Não foi possível conectar ao servidor. Verifique sua conexão.',
  400: 'Dados inválidos. Revise os campos e tente novamente.',
  401: 'Sua sessão expirou. Entre novamente.',
  402: 'Este recurso exige uma assinatura ativa.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Recurso não encontrado.',
  409: 'Conflito: este registro já existe.',
  413: 'Arquivo ou conteúdo grande demais.',
  429: 'Muitas requisições em pouco tempo. Aguarde um instante.',
  500: 'Erro interno. Tente novamente em instantes.',
  502: 'Servidor indisponível no momento.',
  503: 'Serviço temporariamente indisponível.',
  // Cortes da borda (Cloudflare/proxy) em operação demorada. Sem estes textos o
  // aluno recebia a página de erro do gateway como se fosse mensagem nossa.
  504: 'O servidor demorou demais para responder. Se você pediu algo para a IA, pode ter dado certo mesmo assim — recarregue em um minuto.',
  408: 'A requisição demorou demais. Tente novamente.',
  522: 'Não foi possível falar com o servidor agora. Tente novamente em instantes.',
  524: 'O servidor demorou demais para responder. Se você pediu algo para a IA, pode ter dado certo mesmo assim — recarregue em um minuto.',
};

const DEFAULT_CODES = {
  400: 'validation_error', 401: 'unauthorized', 402: 'payment_required', 403: 'forbidden',
  404: 'not_found', 409: 'conflict', 429: 'rate_limited', 500: 'internal', 503: 'ai_unavailable',
  408: 'timeout', 504: 'timeout', 522: 'timeout', 524: 'timeout',
};

let redirecting = false;

/** Caminho de login adequado ao contexto atual (ou null quando não deve redirecionar). */
function loginRedirectFor(pathname = location.pathname) {
  if (pathname.startsWith('/admin')) {
    return pathname === '/admin/login' ? null : '/admin/login';
  }
  if (pathname.startsWith('/app')) {
    const next = encodeURIComponent(location.pathname + location.search);
    return `/login?next=${next}`;
  }
  return null;
}

/** Redireciona para o login quando a sessão expirou (só dentro de /app ou /admin). */
export function handleUnauthorized() {
  const target = loginRedirectFor();
  if (!target || redirecting) return false;
  redirecting = true;
  location.replace(target);
  return true;
}

/** Monta a query string ignorando valores vazios; arrays viram chaves repetidas. */
export function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) value.forEach((v) => v !== undefined && v !== null && v !== '' && params.append(key, String(v)));
    else params.append(key, String(value));
  });
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function buildUrl(path, query) {
  const base = path.startsWith('http') || path.startsWith('/') ? path : `/api/${path}`;
  return `${base}${buildQuery(query)}`;
}

async function parseBody(res) {
  const type = res.headers.get('content-type') || '';
  if (res.status === 204) return null;
  if (type.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text();
  return text || null;
}

/** Converte uma resposta com erro no ApiError padrão ({ error: { code, message, details } }). */
async function toApiError(res) {
  const body = await parseBody(res);
  const err = body && typeof body === 'object' && body.error ? body.error : null;
  // Página de erro de proxy é HTML curto e cabia no limite abaixo: o aluno via
  // "<html><head><title>504 Gateway Time-out..." dentro do aviso vermelho.
  const texto = typeof body === 'string' && body.length < 200 && !/<[a-z!/]/i.test(body) ? body : '';
  return new ApiError({
    status: res.status,
    code: (err && err.code) || DEFAULT_CODES[res.status] || 'internal',
    message: (err && err.message) || texto || DEFAULT_MESSAGES[res.status] || `Erro ${res.status}.`,
    details: (err && err.details) || null,
  });
}

/**
 * request(method, path, { body, query, headers, signal, noRedirect, raw })
 * - body: objeto (JSON), FormData ou string
 * - noRedirect: não redireciona em 401 (usado pelo shell e páginas de login)
 * - raw: devolve o Response sem interpretar
 */
export async function request(method, path, { body, query, headers = {}, signal, noRedirect = false, raw = false, timeout } = {}) {
  const url = buildUrl(path, query);
  const init = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'FocoElite', Accept: 'application/json', ...headers },
    signal,
  };
  if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
    if (body instanceof FormData || body instanceof Blob || typeof body === 'string') {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }

  let timer = null;
  if (timeout && !signal) {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeout);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new ApiError({ status: 0, code: 'aborted', message: timeout ? 'A requisição demorou demais. Tente novamente.' : 'Requisição cancelada.' });
    }
    throw new ApiError({ status: 0, code: 'network', message: DEFAULT_MESSAGES[0] });
  }
  clearTimeout(timer);

  if (raw) return res;

  if (!res.ok) {
    const apiErr = await toApiError(res);
    if (res.status === 401 && !noRedirect) handleUnauthorized();
    throw apiErr;
  }
  return parseBody(res);
}

/** Interpreta um bloco SSE ("event: x\ndata: {...}") em { event, data }. */
function parseSseBlock(block) {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines = [];
  let id = null;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? '' : line.slice(sep + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (!dataLines.length && event === 'message') return null;
  const rawData = dataLines.join('\n');
  let data = rawData;
  if (rawData) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = { text: rawData };
    }
  } else {
    data = {};
  }
  return { event, data, id };
}

/**
 * api.stream(path, body, { onDelta(text, data), onDone(data), onError(err), signal })
 * Lê text/event-stream via fetch + ReadableStream. Eventos: delta {text}, done {message_id, usage}, error {message}.
 * Devolve uma Promise (resolve com o payload de `done`) com método `.abort()`.
 */
export function stream(path, body, { onDelta, onDone, onError, signal, query } = {}) {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const run = async () => {
    let res;
    try {
      res = await fetch(buildUrl(path, query), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'FocoElite',
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (onDone) onDone({ aborted: true });
        return null;
      }
      const apiErr = new ApiError({ status: 0, code: 'network', message: DEFAULT_MESSAGES[0] });
      if (onError) {
        onError(apiErr);
        return null;
      }
      throw apiErr;
    }

    if (!res.ok) {
      const apiErr = await toApiError(res);
      if (res.status === 401) handleUnauthorized();
      if (onError) {
        onError(apiErr);
        return null;
      }
      throw apiErr;
    }

    // resposta JSON síncrona (servidor sem streaming): trata como done
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/event-stream')) {
      const data = await parseBody(res);
      const text = data && typeof data === 'object' ? data.content || data.text || '' : String(data || '');
      if (text && onDelta) onDelta(text, data);
      if (onDone) onDone(data && typeof data === 'object' ? data : { content: text });
      return data;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneData = null;
    let failed = null;

    const handle = (block) => {
      const evt = parseSseBlock(block);
      if (!evt) return;
      const kind = evt.event === 'message' && evt.data && evt.data.type ? evt.data.type : evt.event;
      if (kind === 'delta') {
        const text = typeof evt.data === 'string' ? evt.data : (evt.data.text ?? evt.data.content ?? evt.data.delta ?? '');
        if (onDelta) onDelta(text, evt.data);
      } else if (kind === 'done') {
        doneData = typeof evt.data === 'object' ? evt.data : {};
      } else if (kind === 'error') {
        failed = new ApiError({
          status: 200,
          code: (evt.data && evt.data.code) || 'ai_unavailable',
          message: (evt.data && evt.data.message) || 'O serviço de IA falhou ao responder.',
        });
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handle(block);
          if (failed) break;
        }
        if (failed) {
          try { await reader.cancel(); } catch { /* ignorado */ }
          break;
        }
      }
      if (!failed && buffer.trim()) handle(buffer);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (onDone) onDone({ aborted: true, ...(doneData || {}) });
        return doneData;
      }
      failed = new ApiError({ status: 0, code: 'network', message: 'A conexão foi interrompida durante a resposta.' });
    }

    if (failed) {
      if (onError) {
        onError(failed);
        return null;
      }
      throw failed;
    }
    if (onDone) onDone(doneData || {});
    return doneData || {};
  };

  const promise = run();
  promise.abort = () => controller.abort();
  return promise;
}

export const api = {
  request,
  buildUrl,
  buildQuery,
  get: (path, options = {}) => request('GET', path, options),
  post: (path, body, options = {}) => request('POST', path, { ...options, body }),
  put: (path, body, options = {}) => request('PUT', path, { ...options, body }),
  patch: (path, body, options = {}) => request('PATCH', path, { ...options, body }),
  del: (path, body, options = {}) => request('DELETE', path, { ...options, body }),
  stream,
  handleUnauthorized,
};

export default api;

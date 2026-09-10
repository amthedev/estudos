'use strict';

/**
 * Blob Storage da Square Cloud.
 *
 * É onde os arquivos da plataforma passam a morar: videoaulas, miniaturas,
 * logos, prints de depoimento e PDFs de edital e de prova. O servidor da
 * aplicação não guarda nada — ele repassa o conteúdo para o Blob e grava no
 * banco a URL pública devolvida.
 *
 * Regras da API (documentação oficial da Square Cloud):
 *   POST   https://blob.squarecloud.app/v1/objects            até 100 MB, multipart
 *   POST   https://blob.squarecloud.app/v1/objects/chunked    abre envio em partes (até 1 GiB)
 *   PUT    https://blob.squarecloud.app/v1/objects/chunked    envia uma parte (5–32 MB, máx. 205)
 *   PATCH  https://blob.squarecloud.app/v1/objects/chunked    fecha o envio
 *   DELETE https://blob.squarecloud.app/v1/objects            remove um objeto
 *   GET    https://blob.squarecloud.app/v1/objects            lista (1000 por página)
 *
 * Autenticação: cabeçalho `Authorization` com a chave da conta, sem prefixo.
 * O nome do objeto aceita apenas letras, números e sublinhado, de 3 a 32
 * caracteres — por isso o nome legível vira um identificador higienizado e o
 * nome original fica só no banco.
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const config = require('../../config');

const BASE = 'https://blob.squarecloud.app/v1/objects';

/** Acima disso o envio precisa ser em partes. */
const SINGLE_MAX = 100 * 1024 * 1024;
/**
 * Faixa aceita para cada parte, conforme a documentação: mínimo de 5 MB,
 * máximo de 32 MB (a última parte pode ser menor). O valor que vale é o que o
 * servidor devolve ao abrir o envio; estes são apenas o plano B.
 */
const CHUNK_MIN = 5 * 1024 * 1024;
const CHUNK_MAX = 32 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_CHUNKS = 205;
const MAX_OBJECT = 1024 * 1024 * 1024;
/** A API recusa arquivo menor que isto. */
const MIN_OBJECT = 512;

/** Pastas da plataforma viram prefixos no Blob. */
const PREFIX = {
  videos: 'videos',
  aulas: 'aulas',
  logos: 'logos',
  depoimentos: 'depoimentos',
  editais: 'editais',
  provas: 'provas',
  geral: 'geral',
};

function apiKey() {
  return String(process.env.SQUARECLOUD_API_KEY || config.squarecloud?.blobKey || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

/**
 * Nome aceito pelo Blob: 3 a 32 caracteres, letras, números e sublinhado.
 * Recebe o nome original do arquivo e devolve algo reconhecível na listagem.
 */
function objectName(filename, seed) {
  const base = String(filename || '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const suffix = String(seed || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'arq';
  const name = `${base || 'arquivo'}_${suffix}`;
  // garante o mínimo de 3 caracteres
  return name.length >= 3 ? name.slice(0, 32) : `arq_${suffix}`.slice(0, 32);
}

async function call(url, { method = 'GET', headers = {}, body, timeoutMs = 120000 } = {}) {
  const key = apiKey();
  if (!key) {
    const error = new Error('O armazenamento de arquivos não está configurado.');
    error.code = 'storage_not_configured';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: key, ...headers },
      body,
      signal: controller.signal,
      duplex: body instanceof Readable ? 'half' : undefined,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok || payload?.status === 'error') {
      const error = new Error(messageFor(res.status, payload));
      error.code = payload?.code || 'storage_error';
      error.status = res.status;
      throw error;
    }
    return payload?.response ?? payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('O envio do arquivo demorou demais e foi interrompido.');
      error.code = 'storage_timeout';
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Mensagens em português para o que o painel precisa entender. */
function messageFor(status, payload) {
  const code = payload?.code || '';
  // a documentação usa 401 tanto para chave inválida quanto para o limite
  // global da conta (RATE_LIMIT), que é coisa bem diferente
  if (code === 'RATE_LIMIT') return 'A conta atingiu o limite de uso da API. Tente novamente em instantes.';
  if (status === 401) return 'A chave do armazenamento de arquivos é inválida ou a conta não tem plano ativo.';
  if (status === 403) return 'A conta do armazenamento atingiu o limite contratado.';
  if (status === 413) return 'O arquivo é maior do que o armazenamento aceita.';
  if (status === 429) return 'Muitos envios ao mesmo tempo. Aguarde alguns segundos e tente de novo.';
  if (code) return `Falha no armazenamento (${code}).`;
  return 'Não foi possível gravar o arquivo no armazenamento.';
}

/**
 * Envia um arquivo inteiro (até 100 MB) em uma requisição multipart.
 * @param {Buffer} buffer
 */
async function putSingle(buffer, { name, prefix, filename, contentType }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);

  const query = new URLSearchParams({ name });
  if (prefix) query.set('prefix', prefix);

  const response = await call(`${BASE}?${query}`, { method: 'POST', body: form });
  return { id: response.id, url: response.url, bytes: response.size ?? buffer.length };
}

/**
 * Envia em partes, para arquivo acima de 100 MB (limite de 1 GiB).
 * @param {Buffer} buffer
 */
async function putChunked(buffer, { name, prefix, filename }) {
  const query = new URLSearchParams({ name, filename });
  if (prefix) query.set('prefix', prefix);

  const opened = await call(`${BASE}/chunked?${query}`, { method: 'POST' });
  const token = opened.upload;
  const chunkSize = Number(opened.chunk?.max) || CHUNK_SIZE;
  const total = Math.ceil(buffer.length / chunkSize);
  if (total > MAX_CHUNKS) {
    const error = new Error('O arquivo é grande demais para o armazenamento.');
    error.code = 'too_large';
    throw error;
  }

  try {
    // sequencial de propósito: o limite é de 6 partes simultâneas e o
    // gargalo real é a banda de saída, não a concorrência
    for (let part = 1; part <= total; part += 1) {
      const slice = buffer.subarray((part - 1) * chunkSize, part * chunkSize);
      const partQuery = new URLSearchParams({ upload: token, part: String(part) });
      await call(`${BASE}/chunked?${partQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice,
      });
    }
    const done = await call(`${BASE}/chunked`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload: token }),
    });
    return { id: done.id, url: done.url, bytes: done.size ?? buffer.length };
  } catch (err) {
    // aborta o envio pendente para não deixar partes órfãs consumindo cota
    await call(`${BASE}/chunked`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload: token }),
    }).catch(() => {});
    throw err;
  }
}

/**
 * Grava lendo em fluxo.
 *
 * Junta o conteúdo até fechar uma parte de 16 MB e manda. Se o arquivo inteiro
 * couber na primeira parte, usa o envio simples; caso contrário abre o envio
 * em partes. Assim uma videoaula de 800 MB nunca ocupa mais que uma parte de
 * memória por vez.
 *
 * @param {AsyncIterable<Buffer>} source
 * @param {{ filename?: string, folder?: string, contentType?: string, extension?: string }} options
 * @returns {Promise<{ url: string, key: string, bytes: number, reused: boolean }>}
 */
async function putStream(source, { filename, folder, contentType, extension } = {}) {
  const prefix = PREFIX[folder] || PREFIX.geral;
  const seed = crypto.randomBytes(4).toString('hex');
  const name = objectName(filename, seed);
  const safeName = filename && /\.[a-z0-9]+$/i.test(filename) ? filename : `${name}${extension || '.bin'}`;

  let pending = [];
  let pendingBytes = 0;
  let bytes = 0;
  let part = 0;
  let token = null;
  let chunkSize = CHUNK_SIZE;
  let maxParts = MAX_CHUNKS;
  let maxObject = MAX_OBJECT;

  const openChunked = async () => {
    const query = new URLSearchParams({ name, filename: safeName });
    if (prefix) query.set('prefix', prefix);
    const opened = await call(`${BASE}/chunked?${query}`, { method: 'POST' });
    token = opened.upload;
    // os limites são os que o servidor informa (chunk.min_size, max_size,
    // max_parts e max_object_size); os valores locais são só o plano B
    const limits = opened.chunk || {};
    const serverMax = Number(limits.max_size) || CHUNK_MAX;
    const serverMin = Number(limits.min_size) || CHUNK_MIN;
    chunkSize = Math.max(serverMin, Math.min(serverMax, CHUNK_MAX));
    maxParts = Number(limits.max_parts) || MAX_CHUNKS;
    maxObject = Number(limits.max_object_size) || MAX_OBJECT;
  };

  const sendPart = async (buffer) => {
    part += 1;
    if (part > maxParts) {
      const error = new Error('O arquivo é grande demais para o armazenamento.');
      error.code = 'too_large';
      throw error;
    }
    const query = new URLSearchParams({ upload: token, part: String(part) });
    await call(`${BASE}/chunked?${query}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
  };

  try {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > maxObject) {
        const error = new Error('O arquivo passa do limite de 1 GB do armazenamento.');
        error.code = 'too_large';
        throw error;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;

      while (pendingBytes >= chunkSize) {
        // abre o envio antes de fatiar: o tamanho de parte que vale é o que o
        // servidor informa, não o palpite inicial
        if (!token) {
          await openChunked();
          if (pendingBytes < chunkSize) break;
        }
        const joined = Buffer.concat(pending, pendingBytes);
        const slice = joined.subarray(0, chunkSize);
        const rest = joined.subarray(chunkSize);
        await sendPart(slice);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
      }
    }

    // coube tudo antes de fechar a primeira parte: envio simples
    if (!token) {
      const buffer = Buffer.concat(pending, pendingBytes);
      if (!buffer.length) {
        const error = new Error('Arquivo vazio.');
        error.code = 'empty_file';
        throw error;
      }
      if (buffer.length < MIN_OBJECT) {
        const error = new Error('O arquivo é pequeno demais para o armazenamento (mínimo de 512 bytes).');
        error.code = 'too_small';
        throw error;
      }
      const result = await putSingle(buffer, { name, prefix, filename: safeName, contentType });
      return { url: result.url, key: result.id, bytes: result.bytes, reused: false };
    }

    if (pendingBytes) await sendPart(Buffer.concat(pending, pendingBytes));

    const done = await call(`${BASE}/chunked`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload: token }),
    });
    return { url: done.url, key: done.id, bytes: done.size ?? bytes, reused: false };
  } catch (err) {
    if (token) {
      // aborta o envio pendente para não deixar partes órfãs ocupando cota
      await call(`${BASE}/chunked`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload: token }),
      }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Grava um arquivo já carregado em memória e devolve o endereço público.
 * @param {Buffer} buffer conteúdo completo
 * @param {{ filename?: string, folder?: string, contentType?: string, hash?: string }} options
 * @returns {Promise<{ url: string, key: string, bytes: number }>}
 */
async function put(buffer, { filename, folder, contentType, hash } = {}) {
  if (buffer.length > MAX_OBJECT) {
    const error = new Error('O arquivo passa do limite de 1 GB do armazenamento.');
    error.code = 'too_large';
    throw error;
  }
  const prefix = PREFIX[folder] || PREFIX.geral;
  const name = objectName(filename, hash);
  const safeName = filename && /\.[a-z0-9]+$/i.test(filename) ? filename : `${name}.bin`;

  const result = buffer.length > SINGLE_MAX
    ? await putChunked(buffer, { name, prefix, filename: safeName })
    : await putSingle(buffer, { name, prefix, filename: safeName, contentType });

  return { url: result.url, key: result.id, bytes: result.bytes };
}

/** Remove um objeto pelo identificador devolvido no envio. */
async function remove(key) {
  if (!key) return { ok: true };
  await call(BASE, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: key }),
  });
  return { ok: true };
}

/** Lista os objetos da conta, opcionalmente por prefixo. */
async function list({ folder, cursor } = {}) {
  const query = new URLSearchParams();
  if (folder && PREFIX[folder]) query.set('prefix', PREFIX[folder]);
  if (cursor) query.set('continuationToken', cursor);
  const response = await call(`${BASE}${query.toString() ? `?${query}` : ''}`);
  return {
    items: (response.objects || []).map((object) => ({
      key: object.id,
      bytes: object.size,
      created_at: object.created_at,
      expires_at: object.expires_at || null,
    })),
    cursor: response.continuationToken || null,
  };
}

/**
 * Consumo da conta no Blob: quantos objetos, quantos bytes e quanto do plano
 * já foi usado. O painel mostra isso em Configurações.
 */
async function stats() {
  const response = await call('https://blob.squarecloud.app/v1/account/stats');
  const usage = response?.usage || {};
  const plan = response?.plan || {};
  const billing = response?.billing || {};
  const used = Number(usage.size ?? usage.total_size ?? 0);
  const included = Number(plan.included_size ?? plan.size ?? 0);
  return {
    objects: Number(usage.objects ?? usage.count ?? 0),
    used_bytes: used,
    included_bytes: included,
    used_pct: included > 0 ? Math.min(100, Math.round((used / included) * 100)) : null,
    extra_bytes: Number(billing.extra_size ?? 0),
    estimated_cost: billing.total ?? billing.estimate ?? null,
  };
}

module.exports = {
  name: 'squarecloud',
  label: 'Square Cloud Blob',
  isConfigured,
  put,
  putStream,
  stats,
  remove,
  list,
  PREFIX,
  SINGLE_MAX,
  MAX_OBJECT,
  MIN_OBJECT,
};

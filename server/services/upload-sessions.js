'use strict';

/**
 * Envio de arquivo grande em partes, pelo painel.
 *
 * Por que existe: em produção o Cloudflare fica na frente do servidor e recusa
 * qualquer requisição com corpo acima de 100 MB. Uma videoaula de 217 MB
 * mandada de uma vez morria em 0% com "falha de conexão" — o Cloudflare
 * cortava antes de o servidor ver um byte. Aqui o navegador manda o arquivo em
 * partes pequenas, uma requisição por parte, e o servidor emenda tudo num
 * único fluxo que segue para `uploads.saveStream` (mesma checagem de tipo e de
 * tamanho, mesmo envio em partes para o Blob).
 *
 *   open({ folder, filename, contentType, size, owner })  → { id, part_size }
 *   appendPart(id, index, buffer, owner)                  → { received }
 *   complete(id, owner)                                   → o mesmo retorno de uploads.saveStream
 *   abort(id, owner)
 *
 * O envio vive na memória do processo. Se o servidor reiniciar no meio, o
 * painel recebe "o envio expirou" e começa de novo — não fica estado preso,
 * porque a sessão some junto com o processo. Sessão parada por muito tempo é
 * abortada pela varredura abaixo, e o abort descarta o envio pendente no Blob.
 */
const crypto = require('node:crypto');
const uploads = require('./uploads');

/**
 * Tamanho de cada parte que o navegador manda. Bem abaixo dos 100 MB do
 * Cloudflare e pequeno o bastante para caber nos 100 s que ele espera por
 * resposta mesmo em conexão de ~1 Mbps.
 */
const PART_SIZE = 8 * 1024 * 1024;
/** Sessão sem parte nova por este tempo é abortada. */
const IDLE_MS = 15 * 60 * 1000;

const sessions = new Map();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Fila assíncrona: as requisições das partes empurram pedaços e
 * `uploads.saveStream` consome como se fosse um único corpo de requisição.
 * Cada `push` só resolve depois que o consumidor processou o pedaço, então a
 * memória nunca guarda mais que uma parte à espera.
 */
function createFeed() {
  const queue = [];
  let wake = null;
  let ended = false;
  let failure = null;

  async function* iterate() {
    while (true) {
      if (failure) throw failure;
      if (queue.length) {
        const item = queue.shift();
        yield item.chunk;
        item.done();
        continue;
      }
      if (ended) return;
      await new Promise((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }

  return {
    iterate,
    push(chunk) {
      return new Promise((resolve) => {
        queue.push({ chunk, done: resolve });
        if (wake) wake();
      });
    },
    end() {
      ended = true;
      if (wake) wake();
    },
    fail(error) {
      failure = error;
      if (wake) wake();
    },
  };
}

function get(id, owner) {
  const session = sessions.get(String(id || ''));
  if (!session || (session.owner && owner && session.owner !== owner)) {
    throw fail('upload_not_found', 'Este envio expirou ou não existe mais. Envie o arquivo de novo.');
  }
  return session;
}

/** Abre um envio e já liga o fluxo até o armazenamento. */
function open({ folder, filename, contentType, size, owner } = {}) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) throw fail('empty_file', 'Arquivo vazio.');
  if (total > uploads.MAX_BYTES) {
    throw fail('too_large', `Arquivo muito grande. O limite é de ${Math.round(uploads.MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const id = crypto.randomBytes(16).toString('hex');
  const feed = createFeed();
  const result = uploads.saveStream(feed.iterate(), { contentType, filename, folder });
  // o erro é lido por quem aguardar a parte ou a conclusão; sem este catch um
  // envio abandonado viraria rejeição não tratada
  result.catch(() => {});

  sessions.set(id, {
    id,
    owner: owner || null,
    feed,
    result,
    size: total,
    bytes: 0,
    next: 1,
    touched: Date.now(),
  });
  return { id, part_size: PART_SIZE };
}

/**
 * Recebe a parte `index` (a partir de 1). Partes chegam em ordem; uma parte já
 * recebida que chegue de novo (o navegador repetiu após queda de conexão) é
 * aceita sem ser gravada duas vezes.
 */
async function appendPart(id, index, buffer, owner) {
  const session = get(id, owner);
  const part = Number(index);
  if (!Number.isInteger(part) || part < 1) throw fail('invalid_part', 'Parte inválida.');
  if (part < session.next) return { received: session.bytes };
  if (part > session.next) {
    throw fail('invalid_part', `Parte fora de ordem: esperava a ${session.next}, chegou a ${part}.`);
  }
  if (!buffer || !buffer.length) throw fail('invalid_part', 'Parte vazia.');
  if (buffer.length > PART_SIZE) throw fail('too_large', 'Parte maior que o permitido.');
  if (session.bytes + buffer.length > session.size) {
    throw fail('invalid_part', 'O arquivo enviado é maior do que o informado ao abrir o envio.');
  }
  if (session.busy) throw fail('invalid_part', 'A parte anterior ainda está sendo gravada.');

  session.busy = true;
  session.touched = Date.now();
  try {
    // se o armazenamento recusar (tipo errado, limite, Blob fora), a falha
    // chega aqui em vez de a requisição ficar esperando para sempre
    await Promise.race([
      session.feed.push(buffer),
      session.result.then(
        () => {
          throw fail('storage_error', 'O envio foi encerrado antes do fim do arquivo.');
        },
        (err) => {
          throw err;
        }
      ),
    ]);
  } catch (err) {
    sessions.delete(session.id);
    throw err;
  } finally {
    session.busy = false;
  }

  session.next += 1;
  session.bytes += buffer.length;
  session.touched = Date.now();
  return { received: session.bytes };
}

/** Fecha o fluxo e devolve o arquivo gravado. */
async function complete(id, owner) {
  const session = get(id, owner);
  if (session.bytes !== session.size) {
    abort(id, owner);
    throw fail('invalid_part', 'O arquivo chegou incompleto. Envie de novo.');
  }
  session.feed.end();
  try {
    return await session.result;
  } finally {
    sessions.delete(session.id);
  }
}

/** Cancela o envio; o armazenamento descarta o que já tinha recebido. */
function abort(id, owner) {
  const session = sessions.get(String(id || ''));
  if (!session || (session.owner && owner && session.owner !== owner)) return false;
  sessions.delete(session.id);
  session.feed.fail(fail('aborted', 'Envio cancelado.'));
  return true;
}

// envio abandonado no meio (aba fechada, conexão caiu de vez)
const sweeper = setInterval(() => {
  const limit = Date.now() - IDLE_MS;
  for (const session of sessions.values()) {
    if (session.touched < limit) abort(session.id);
  }
}, 60 * 1000);
sweeper.unref();

module.exports = { open, appendPart, complete, abort, PART_SIZE, IDLE_MS, _sessions: sessions };

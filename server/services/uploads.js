'use strict';

/**
 * Arquivos enviados pelo painel: videoaulas, miniaturas, logos, prints de
 * depoimento e PDFs de edital e de prova.
 *
 * Este módulo cuida do que é regra da plataforma — que tipo de arquivo entra,
 * qual o tamanho máximo de cada um e como o conteúdo é conferido — e delega o
 * armazenamento para `services/storage`, que em produção aponta para o Blob
 * Storage da Square Cloud.
 *
 * O tipo é decidido pelos primeiros bytes do arquivo, nunca pelo cabeçalho que
 * o navegador manda: renomear um executável para ".mp4" não engana a checagem.
 * SVG fica de fora de propósito, por ser XML executável.
 */
const storage = require('./storage');
const local = require('./storage/local');

/** Tipos aceitos → extensão, limite e natureza. */
const ALLOWED = Object.freeze({
  'image/png': { ext: '.png', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/jpeg': { ext: '.jpg', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/webp': { ext: '.webp', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/gif': { ext: '.gif', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'application/pdf': { ext: '.pdf', maxBytes: 20 * 1024 * 1024, kind: 'document' },
  // videoaulas: o limite acompanha o teto de 1 GB do Blob da Square Cloud
  'video/mp4': { ext: '.mp4', maxBytes: 1024 * 1024 * 1024, kind: 'video' },
  'video/webm': { ext: '.webm', maxBytes: 1024 * 1024 * 1024, kind: 'video' },
  'video/quicktime': { ext: '.mov', maxBytes: 1024 * 1024 * 1024, kind: 'video' },
});

const MAX_BYTES = Math.max(...Object.values(ALLOWED).map((rule) => rule.maxBytes));

/** Pastas por finalidade, para a equipe se achar na listagem. */
const FOLDERS = Object.freeze(['logos', 'depoimentos', 'editais', 'provas', 'aulas', 'videos', 'geral']);

/** Assinaturas de arquivo (os primeiros bytes de cada formato). */
const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

function detectMime(buffer) {
  for (const signature of SIGNATURES) {
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) return signature.mime;
  }
  // MP4 e MOV: caixa "ftyp" logo depois do tamanho, nos bytes 4 a 7
  if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  // WEBM/Matroska
  if (buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function normalizeFolder(folder) {
  const name = String(folder || 'geral').trim().toLowerCase();
  return FOLDERS.includes(name) ? name : 'geral';
}

/** Nome legível a partir do original, só para a equipe reconhecer o arquivo. */
function safeLabel(originalName, fallback) {
  const base = String(originalName || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 60);
  return base || fallback;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function guessExtension(filename) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(filename || ''));
  return match ? `.${match[1].toLowerCase()}` : '.bin';
}

/**
 * Lê o começo do fluxo para descobrir e validar o tipo, e repassa o mesmo
 * conteúdo, intacto, para o provedor de armazenamento gravar.
 */
function inspected(source, { contentType, ceiling }) {
  let head = Buffer.alloc(0);
  let mime = null;
  let rule = null;
  let bytes = 0;
  const state = {};

  async function* generator() {
    for await (const chunk of source) {
      if (!mime) {
        head = head.length ? Buffer.concat([head, chunk]) : Buffer.from(chunk);
        if (head.length >= 16) {
          mime = detectMime(head);
          rule = mime ? ALLOWED[mime] : null;
          if (!rule) {
            throw fail('unsupported_type', 'Tipo de arquivo não aceito. Envie MP4, WEBM, MOV, PNG, JPG, WEBP, GIF ou PDF.');
          }
          const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
          if (declared && ALLOWED[declared] && declared !== mime) {
            throw fail('unsupported_type', 'O conteúdo do arquivo não corresponde ao tipo informado.');
          }
          state.mime = mime;
          state.rule = rule;
        }
      }

      bytes += chunk.length;
      const limit = rule ? Math.min(rule.maxBytes, ceiling) : ceiling;
      if (bytes > limit) {
        throw fail('too_large', `Arquivo muito grande. O limite para este tipo é ${Math.round(limit / 1024 / 1024)} MB.`);
      }
      yield chunk;
    }

    // arquivo menor que 16 bytes nunca chegou a ser identificado
    if (!state.rule) {
      if (!bytes) throw fail('empty_file', 'Arquivo vazio.');
      const late = detectMime(head);
      const lateRule = late ? ALLOWED[late] : null;
      if (!lateRule) {
        throw fail('unsupported_type', 'Tipo de arquivo não aceito. Envie MP4, WEBM, MOV, PNG, JPG, WEBP, GIF ou PDF.');
      }
      state.mime = late;
      state.rule = lateRule;
    }
  }

  return { generator, state };
}

/**
 * Grava um arquivo lendo em fluxo, sem carregar tudo na memória.
 *
 * @param {AsyncIterable<Buffer>} source corpo da requisição
 * @param {{ contentType?: string, filename?: string, folder?: string, maxBytes?: number }} options
 * @returns {Promise<{ url, key, provider, folder, bytes, content_type, kind, label, reused }>}
 * @throws {Error & { code: string }} 'unsupported_type' | 'empty_file' | 'too_large' | 'storage_not_configured'
 */
async function saveStream(source, { contentType, filename, folder, maxBytes } = {}) {
  const dir = normalizeFolder(folder);
  const ceiling = Math.min(maxBytes || MAX_BYTES, MAX_BYTES);
  const { generator, state } = inspected(source, { contentType, ceiling });

  const saved = await storage.putStream(generator(), {
    folder: dir,
    filename,
    contentType,
    // o provedor precisa da extensão antes do fim do fluxo; a checagem de tipo
    // acontece nos primeiros bytes e corrige o palpite quando difere
    extension: guessExtension(filename),
  });

  const rule = state.rule || {};
  return {
    url: saved.url,
    key: saved.key,
    provider: saved.provider,
    folder: dir,
    bytes: saved.bytes,
    content_type: state.mime || null,
    kind: rule.kind || 'document',
    label: safeLabel(filename, rule.kind === 'video' ? 'videoaula' : rule.kind === 'document' ? 'documento' : 'imagem'),
    reused: Boolean(saved.reused),
  };
}

/**
 * Grava um arquivo já carregado em memória. Atalho para uso interno (seed e
 * testes); o caminho normal do painel é `saveStream`.
 */
async function save(buffer, options = {}) {
  async function* once() {
    yield buffer;
  }
  return saveStream(once(), options);
}

/** Lista o que está guardado no provedor ativo. */
async function list(options) {
  const result = await storage.list(options);
  const items = Array.isArray(result) ? result : result.items || [];
  return items.map((item) => ({ ...item, url: item.url || item.key }));
}

/** Apaga um arquivo pelo endereço ou pela chave devolvida na gravação. */
async function remove(keyOrUrl) {
  return storage.remove(keyOrUrl);
}

/** Situação do armazenamento para o painel, sem expor a chave. */
async function status() {
  return storage.status();
}

module.exports = {
  saveStream,
  save,
  list,
  remove,
  status,
  detectMime,
  ALLOWED,
  FOLDERS,
  MAX_BYTES,
  // usado por quem ainda resolve caminho de arquivo local (limpeza e testes)
  UPLOADS_DIR: local.UPLOADS_DIR,
};

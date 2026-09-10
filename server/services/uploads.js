'use strict';

/**
 * Arquivos enviados pelo painel (logos, fotos, prints de depoimento, PDFs de
 * edital e de prova).
 *
 * A equipe recebe esse material por WhatsApp e não tem onde hospedar, então o
 * arquivo é gravado no próprio servidor, em `uploads/`, e servido em `/uploads`.
 * O nome final é derivado do conteúdo (hash), o que evita colisão, evita nome
 * malicioso e faz o mesmo arquivo enviado duas vezes ocupar espaço uma só vez.
 *
 * Aceita só os tipos que o painel realmente usa. SVG fica de fora de propósito:
 * é XML executável e seria servido do mesmo domínio da aplicação.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

/** Tipos aceitos → extensão e limite de tamanho. */
const ALLOWED = Object.freeze({
  'image/png': { ext: '.png', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/jpeg': { ext: '.jpg', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/webp': { ext: '.webp', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'image/gif': { ext: '.gif', maxBytes: 5 * 1024 * 1024, kind: 'image' },
  'application/pdf': { ext: '.pdf', maxBytes: 20 * 1024 * 1024, kind: 'document' },
});

const MAX_BYTES = Math.max(...Object.values(ALLOWED).map((rule) => rule.maxBytes));

/** Pastas por finalidade, para o administrador se achar no disco. */
const FOLDERS = Object.freeze(['logos', 'depoimentos', 'editais', 'provas', 'aulas', 'geral']);

const UPLOADS_DIR = path.join(config.rootDir || path.join(__dirname, '..', '..'), 'uploads');

/**
 * Assinaturas de arquivo. O `Content-Type` vem do navegador e não é confiável:
 * conferimos os primeiros bytes antes de gravar.
 */
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
  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function normalizeFolder(folder) {
  const name = String(folder || 'geral').trim().toLowerCase();
  return FOLDERS.includes(name) ? name : 'geral';
}

/** Nome legível a partir do original, só para o administrador reconhecer o arquivo. */
function safeLabel(originalName, fallback) {
  const base = path
    .basename(String(originalName || ''))
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 60);
  return base || fallback;
}

async function ensureDir(folder) {
  const dir = path.join(UPLOADS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Grava o arquivo e devolve os dados para o painel.
 * @param {Buffer} buffer conteúdo bruto
 * @param {{ contentType?: string, filename?: string, folder?: string }} options
 * @returns {Promise<{ url, filename, folder, bytes, content_type, kind, label }>}
 * @throws {Error & { code: string }} 'unsupported_type' | 'empty_file' | 'too_large'
 */
async function save(buffer, { contentType, filename, folder } = {}) {
  if (!buffer || !buffer.length) {
    const error = new Error('Arquivo vazio.');
    error.code = 'empty_file';
    throw error;
  }

  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  // O tipo vem SEMPRE dos bytes. O cabeçalho do navegador é palpite do cliente:
  // aceitar o que ele declara deixaria passar qualquer arquivo renomeado.
  const detected = detectMime(buffer);
  const rule = detected ? ALLOWED[detected] : null;

  if (!rule) {
    const error = new Error('Tipo de arquivo não aceito. Envie PNG, JPG, WEBP, GIF ou PDF.');
    error.code = 'unsupported_type';
    throw error;
  }
  if (declared && ALLOWED[declared] && detected !== declared) {
    const error = new Error('O conteúdo do arquivo não corresponde ao tipo informado.');
    error.code = 'unsupported_type';
    throw error;
  }
  const mime = detected;
  if (buffer.length > rule.maxBytes) {
    const error = new Error(`Arquivo muito grande. O limite para este tipo é ${Math.round(rule.maxBytes / 1024 / 1024)} MB.`);
    error.code = 'too_large';
    throw error;
  }

  const dir = normalizeFolder(folder);
  const target = await ensureDir(dir);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const label = safeLabel(filename, rule.kind === 'document' ? 'documento' : 'imagem');
  const finalName = `${hash}${rule.ext}`;
  const fullPath = path.join(target, finalName);

  // mesmo conteúdo já enviado: reaproveita em vez de duplicar
  const exists = await fs
    .access(fullPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) await fs.writeFile(fullPath, buffer);

  return {
    url: `/uploads/${dir}/${finalName}`,
    filename: finalName,
    folder: dir,
    bytes: buffer.length,
    content_type: mime,
    kind: rule.kind,
    label,
    reused: exists,
  };
}

/** Lista o que está gravado, mais recente primeiro. */
async function list({ folder, limit = 100 } = {}) {
  const folders = folder ? [normalizeFolder(folder)] : FOLDERS;
  const items = [];
  for (const dir of folders) {
    const full = path.join(UPLOADS_DIR, dir);
    let names = [];
    try {
      names = await fs.readdir(full);
    } catch {
      continue; // pasta ainda não criada
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        const info = await fs.stat(path.join(full, name));
        if (!info.isFile()) continue;
        items.push({
          url: `/uploads/${dir}/${name}`,
          filename: name,
          folder: dir,
          bytes: info.size,
          created_at: info.mtime.toISOString(),
        });
      } catch {
        // arquivo removido no meio da leitura: ignora
      }
    }
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, limit);
}

/**
 * Remove um arquivo. Só aceita caminho dentro de uploads/, para não virar
 * exclusão arbitrária de disco.
 */
async function remove(url) {
  const relative = String(url || '').replace(/^\/uploads\//, '');
  const fullPath = path.resolve(UPLOADS_DIR, relative);
  if (!fullPath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    const error = new Error('Caminho inválido.');
    error.code = 'invalid_path';
    throw error;
  }
  await fs.unlink(fullPath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return { ok: true };
}

module.exports = { save, list, remove, ALLOWED, FOLDERS, MAX_BYTES, UPLOADS_DIR };

'use strict';

/**
 * Armazenamento no disco do próprio servidor.
 *
 * É a alternativa para desenvolvimento e para quem hospedar em uma máquina
 * própria: os arquivos ficam em `uploads/` e são servidos em `/uploads`. Em
 * produção na Square Cloud o provedor ativo é o Blob, e nada é gravado aqui.
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const config = require('../../config');

const UPLOADS_DIR = path.join(config.rootDir, 'uploads');

const FOLDERS = ['logos', 'depoimentos', 'editais', 'provas', 'aulas', 'videos', 'geral'];

function normalizeFolder(folder) {
  const name = String(folder || 'geral').trim().toLowerCase();
  return FOLDERS.includes(name) ? name : 'geral';
}

async function ensureDir(folder) {
  const dir = path.join(UPLOADS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function isConfigured() {
  return true;
}

/**
 * Grava lendo em fluxo. O nome final vem do resumo do conteúdo, então o mesmo
 * arquivo enviado duas vezes não ocupa espaço duas vezes.
 *
 * @param {AsyncIterable<Buffer>} source
 * @param {{ folder?: string, extension: string }} options
 * @returns {Promise<{ url: string, key: string, bytes: number, reused: boolean }>}
 */
async function putStream(source, { folder, extension }) {
  const dir = normalizeFolder(folder);
  const target = await ensureDir(dir);
  const tempPath = path.join(target, `.tmp-${crypto.randomBytes(12).toString('hex')}`);

  const hash = crypto.createHash('sha256');
  let bytes = 0;

  async function* counted() {
    for await (const chunk of source) {
      bytes += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }

  try {
    await pipeline(counted(), fsSync.createWriteStream(tempPath));
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  const digest = hash.digest('hex').slice(0, 24);
  const finalName = `${digest}${extension}`;
  const fullPath = path.join(target, finalName);
  const exists = await fs
    .access(fullPath)
    .then(() => true)
    .catch(() => false);

  if (exists) await fs.unlink(tempPath).catch(() => {});
  else await fs.rename(tempPath, fullPath);

  const url = `/uploads/${dir}/${finalName}`;
  return { url, key: url, bytes, reused: exists };
}

async function remove(key) {
  const relative = String(key || '').replace(/^\/uploads\//, '');
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

async function list({ folder, limit = 200 } = {}) {
  const folders = folder ? [normalizeFolder(folder)] : FOLDERS;
  const items = [];
  for (const dir of folders) {
    const full = path.join(UPLOADS_DIR, dir);
    let names = [];
    try {
      names = await fs.readdir(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        const info = await fs.stat(path.join(full, name));
        if (!info.isFile()) continue;
        const url = `/uploads/${dir}/${name}`;
        items.push({ url, key: url, folder: dir, bytes: info.size, created_at: info.mtime.toISOString() });
      } catch {
        // arquivo removido no meio da leitura
      }
    }
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { items: items.slice(0, limit), cursor: null };
}

module.exports = {
  name: 'local',
  label: 'Disco do servidor',
  isConfigured,
  putStream,
  remove,
  list,
  UPLOADS_DIR,
  FOLDERS,
};

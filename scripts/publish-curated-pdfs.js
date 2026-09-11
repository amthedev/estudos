'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const squarecloud = require('../server/services/storage/squarecloud');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const defaultSourceDir = path.join(publicDir, 'assets', 'past-exams');
const sourceDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultSourceDir;
const manifestPath = path.join(root, 'server', 'db', 'seed', 'data', 'curated_asset_urls.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listPdfs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listPdfs(fullPath));
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(fullPath);
  }

  return files.sort();
}

async function readManifest() {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeManifest(manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.rename(temporaryPath, manifestPath);
}

async function upload(filePath) {
  const filename = path.basename(filePath);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await squarecloud.putStream(fs.createReadStream(filePath), {
        filename,
        folder: 'provas',
        contentType: 'application/pdf',
        extension: '.pdf',
      });
    } catch (error) {
      const retryable = error.code === 'RATE_LIMIT' || error.status === 429 || error.code === 'storage_timeout';
      if (!retryable || attempt === 4) throw error;
      await sleep(attempt * 5000);
    }
  }

  throw new Error(`Nao foi possivel enviar ${filename}.`);
}

async function main() {
  if (!squarecloud.isConfigured()) {
    throw new Error('Defina SQUARECLOUD_API_KEY no .env antes de publicar os PDFs.');
  }

  const files = await listPdfs(sourceDir);
  const manifest = await readManifest();
  let uploaded = 0;

  for (const [index, filePath] of files.entries()) {
    const relativePath = path.relative(sourceDir, filePath).split(path.sep).join('/');
    const localUrl = `/assets/past-exams/${relativePath}`;
    if (manifest[localUrl]?.url) {
      console.log(`[${index + 1}/${files.length}] mantido ${localUrl}`);
      continue;
    }

    const saved = await upload(filePath);
    manifest[localUrl] = {
      url: saved.url,
      key: saved.key,
      bytes: saved.bytes,
    };
    uploaded += 1;
    await writeManifest(manifest);
    console.log(`[${index + 1}/${files.length}] enviado ${localUrl} (${saved.bytes} bytes)`);
    await sleep(300);
  }

  console.log(`Concluido: ${files.length} PDFs mapeados, ${uploaded} novos envios.`);
}

main().catch((error) => {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
});

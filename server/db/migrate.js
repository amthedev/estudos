'use strict';

/**
 * Runner de migrations.
 *
 *   node server/db/migrate.js            aplica as pendentes (server/db/migrations/*.sql, ordem lexicográfica)
 *   node server/db/migrate.js --reset    recria o schema public antes (somente NODE_ENV=test ou com --force)
 *
 * Também pode ser usado por código: const { runMigrations } = require('./migrate');
 * Cada arquivo roda dentro de uma transação e é registrado em schema_migrations.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function resetSchema(client) {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Aplica as migrations pendentes.
 * @param {{ reset?: boolean, force?: boolean, quiet?: boolean, log?: Function }} options
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function runMigrations({ reset = false, force = false, quiet = false, log = console.log } = {}) {
  const say = quiet ? () => {} : log;

  if (reset && !(config.isTest || force)) {
    throw new Error('--reset só é permitido com NODE_ENV=test ou em conjunto com --force.');
  }

  const files = listMigrationFiles();
  const applied = [];
  const skipped = [];

  const client = await db.pool.connect();
  try {
    if (reset) {
      say('[migrate] recriando schema public');
      await resetSchema(client);
    }

    await ensureMigrationsTable(client);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((row) => row.name));

    // Baseline: schema criado fora do runner (ex.: psql -f 001_init.sql) sem registro.
    // Registra a migration inicial como aplicada em vez de falhar com "relation already exists".
    if (done.size === 0 && files.length > 0) {
      const { rows: existing } = await client.query(`SELECT to_regclass('public.users') AS users_table`);
      if (existing[0] && existing[0].users_table) {
        say(`[migrate] schema já existente sem registro; registrando ${files[0]} como baseline`);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [files[0]]);
        done.add(files[0]);
      }
    }

    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      say(`[migrate] aplicando ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Falha na migration ${file}: ${err.message}`;
        throw err;
      }
      applied.push(file);
    }
  } finally {
    client.release();
  }

  if (applied.length === 0) say(`[migrate] nenhuma migration pendente (${skipped.length} já aplicada(s))`);
  else say(`[migrate] ${applied.length} migration(s) aplicada(s)`);

  return { applied, skipped };
}

module.exports = { runMigrations, listMigrationFiles, MIGRATIONS_DIR };

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  runMigrations({ reset: args.has('--reset'), force: args.has('--force') })
    .then(async () => {
      await db.closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[migrate] erro: ${err.message}`);
      await db.closePool().catch(() => {});
      process.exit(1);
    });
}

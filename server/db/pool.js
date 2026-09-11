'use strict';

/**
 * Pool de conexões PostgreSQL e helpers de consulta.
 *
 *   const { query, one, many, tx } = require('../db/pool');
 *   const rows = await many('SELECT * FROM subjects WHERE active ORDER BY sort_order');
 *   const row  = await one('SELECT * FROM users WHERE id = $1', [id]);   // null se não existir
 *   await tx(async (client) => { await client.query('...'); });          // transação
 *
 * Parsers de tipo:
 *   - DATE (1082) chega como string 'YYYY-MM-DD' (sem conversão de fuso).
 *   - NUMERIC (1700) e BIGINT (20, ex.: count(*)) chegam como Number.
 */
const { Pool, types } = require('pg');
const config = require('../config');

// DATE → string (evita o deslocamento de fuso que o Date do JS causaria)
types.setTypeParser(1082, (value) => value);
// DATE[] → string[]
types.setTypeParser(1182, types.getTypeParser(1009));
// NUMERIC → Number
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
// NUMERIC[] → Number[]
types.setTypeParser(1231, (value) => {
  const parsed = types.getTypeParser(1009)(value);
  return Array.isArray(parsed) ? parsed.map((item) => (item === null ? null : Number(item))) : parsed;
});
// BIGINT (count(*), sum de inteiros) → Number
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
types.setTypeParser(1016, types.getTypeParser(1007));

/**
 * TLS da conexão.
 *
 * O PostgreSQL gerenciado da Square Cloud recusa conexão em texto puro e exige
 * o certificado emitido para aquela instância, que entra ao mesmo tempo como
 * CA, certificado e chave do cliente — é assim no exemplo oficial deles com
 * `pg`. Sem certificado, cai no comportamento dos outros provedores: TLS
 * simples quando PGSSL estiver ligada.
 */
function sslOptions() {
  const { pgSslCert: cert, pgSslCa: ca } = config;
  if (cert || ca) {
    // O certificado do cliente da Square Cloud vem num único .pem que carrega
    // o certificado e a chave, e o `pg` aceita o mesmo conteúdo nos dois
    // campos. Com a autoridade em separado (o ca-certificate.crt que eles
    // entregam junto), o servidor é conferido de verdade; sem ela, sobra o
    // próprio certificado como âncora, que é o exemplo oficial deles.
    return { ca: ca || cert, cert: cert || undefined, key: cert || undefined };
  }
  return config.pgSsl ? { rejectUnauthorized: false } : false;
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: sslOptions(),
  max: config.isTest ? 5 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // em testes permite que o processo termine mesmo com clientes ociosos
  allowExitOnIdle: config.isTest,
});

pool.on('error', (err) => {
  console.error('[db] erro em cliente ocioso do pool:', err.message);
});

/** Executa uma consulta e devolve o resultado completo do pg. */
function query(text, params = []) {
  return pool.query(text, params);
}

/** Devolve a primeira linha ou null. */
async function one(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] ?? null;
}

/** Devolve todas as linhas (array, possivelmente vazio). */
async function many(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Executa fn dentro de uma transação. O client recebido tem query/one/many.
 * Faz ROLLBACK automático se fn lançar.
 */
async function tx(fn) {
  const client = await pool.connect();
  const wrapped = {
    query: (text, params) => client.query(text, params),
    one: async (text, params = []) => (await client.query(text, params)).rows[0] ?? null,
    many: async (text, params = []) => (await client.query(text, params)).rows,
    raw: client,
  };
  try {
    await client.query('BEGIN');
    const result = await fn(wrapped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] falha no ROLLBACK:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Encerra o pool (usado no desligamento do servidor, scripts e testes). */
async function closePool() {
  if (pool.ended) return;
  await pool.end();
}

module.exports = { pool, query, one, many, tx, closePool };

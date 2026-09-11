'use strict';

/**
 * Utilitários de teste (node:test + fetch, sem dependências extras).
 *
 *   const { createTestContext } = require('./helpers');
 *   const ctx = await createTestContext();          // recria o schema no banco de teste e sobe o app
 *   const { user, cookie } = await ctx.registerStudent();
 *   const res = await ctx.request('GET', '/api/auth/me', { cookie });
 *   await ctx.close();
 *
 * Também há atalhos de módulo (contexto compartilhado por arquivo de teste):
 *   request(), agent(cookie), registerStudent(), loginAdmin(), resetDb(), closeAll()
 */
process.env.NODE_ENV = 'test';
process.env.REQUIRE_SUBSCRIPTION = 'false';

const http = require('node:http');
const bcrypt = require('bcryptjs');
const config = require('../server/config');
const db = require('../server/db/pool');
const { runMigrations } = require('../server/db/migrate');
const { createApp } = require('../server/app');
const settings = require('../server/services/settings');
const { CSRF_HEADER_VALUE } = require('../server/app');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let counter = 0;

const DEFAULT_PASSWORD = 'Senha@12345';
const ADMIN_EMAIL = 'admin@teste.focoelite.com.br';
const ADMIN_PASSWORD = 'Admin@12345';

function parseSetCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const cookies = {};
  for (const raw of list) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index === -1) continue;
    cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return cookies;
}

function cookieHeaderFrom(cookies) {
  const pairs = Object.entries(cookies).filter(([, value]) => value !== '');
  return pairs.length ? pairs.map(([key, value]) => `${key}=${value}`).join('; ') : null;
}

/** Limpa todas as tabelas (exceto schema_migrations) e o cache de configurações. */
async function resetDb() {
  const tables = await db.many(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  if (tables.length > 0) {
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  settings.invalidateCache();
}

/**
 * Sobe um servidor efêmero com o app e devolve helpers de requisição.
 * @param {{ reset?: boolean }} [options] reset=false pula a recriação do schema
 */
async function createTestContext({ reset = true } = {}) {
  if (reset) {
    await runMigrations({ reset: true, quiet: true });
    // A aplicação publicada nasce paga; os testes abrem o acesso e ligam a
    // exigência apenas nos cenários que verificam cobrança.
    await settings.setSetting('require_subscription', false);
  }
  else settings.invalidateCache();

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: any, cookie?: string|string[], headers?: object, csrf?: boolean, raw?: boolean }} [options]
   */
  async function request(method, path, { body, cookie, headers = {}, csrf = true, raw = false } = {}) {
    const upper = method.toUpperCase();
    const reqHeaders = { accept: 'application/json', ...headers };
    if (cookie) reqHeaders.cookie = Array.isArray(cookie) ? cookie.join('; ') : cookie;
    if (csrf && MUTATING.has(upper)) reqHeaders['x-requested-with'] = CSRF_HEADER_VALUE;

    const init = { method: upper, headers: reqHeaders, redirect: 'manual' };
    if (body !== undefined) {
      if (raw) {
        init.body = body;
      } else {
        reqHeaders['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const response = await fetch(baseUrl + path, init);
    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const cookies = parseSetCookies(response.headers);
    return {
      status: response.status,
      ok: response.ok,
      body: data,
      text,
      headers: response.headers,
      cookies,
      cookie: cookieHeaderFrom(cookies),
    };
  }

  /** Cliente com cookie fixo: agent(cookie).get('/api/auth/me') */
  function agent(cookie) {
    const call = (method) => (path, body, options = {}) => request(method, path, { ...options, body, cookie });
    return {
      get: (path, options = {}) => request('GET', path, { ...options, cookie }),
      post: call('POST'),
      put: call('PUT'),
      patch: call('PATCH'),
      del: (path, body, options = {}) => request('DELETE', path, { ...options, body, cookie }),
      request: (method, path, options = {}) => request(method, path, { ...options, cookie }),
    };
  }

  /** Registra um aluno via API e devolve { user, cookie, email, password, name, agent }. */
  async function registerStudent(overrides = {}) {
    counter += 1;
    const email = overrides.email || `aluno${counter}-${Date.now()}@teste.focoelite.com.br`;
    const password = overrides.password || DEFAULT_PASSWORD;
    const name = overrides.name || `Aluno Teste ${counter}`;
    const res = await request('POST', '/api/auth/register', { body: { name, email, password } });
    if (res.status !== 201) {
      throw new Error(`registerStudent falhou (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return { user: res.body.user, cookie: res.cookie, email, password, name, agent: agent(res.cookie) };
  }

  /** Garante um admin no banco (inserção direta) e faz login → { user, cookie, email, password, agent }. */
  async function loginAdmin({ email = ADMIN_EMAIL, password = ADMIN_PASSWORD, name = 'Admin Teste' } = {}) {
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const existing = await db.one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existing) {
      await db.query(
        `UPDATE users SET password_hash = $1, role = 'admin', status = 'active', name = $2 WHERE id = $3`,
        [passwordHash, name, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO users (name, email, password_hash, role, status) VALUES ($1, $2, $3, 'admin', 'active')`,
        [name, email, passwordHash]
      );
    }
    const res = await request('POST', '/api/admin/auth/login', { body: { email, password } });
    if (res.status !== 200) {
      throw new Error(`loginAdmin falhou (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return { user: res.body.user, cookie: res.cookie, email, password, agent: agent(res.cookie) };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await db.closePool().catch(() => {});
  }

  return { app, server, baseUrl, request, agent, registerStudent, loginAdmin, resetDb, close, db };
}

// ---------------------------------------------------------------------------
// Contexto compartilhado (um por arquivo de teste — o node --test isola processos)
// ---------------------------------------------------------------------------
let shared = null;

async function getContext() {
  if (!shared) shared = createTestContext();
  return shared;
}

async function closeAll() {
  if (!shared) return;
  const ctx = await shared;
  shared = null;
  await ctx.close();
}

module.exports = {
  createTestContext,
  createApp,
  resetDb,
  closeAll,
  getContext,
  db,
  config,
  DEFAULT_PASSWORD,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  request: async (...args) => (await getContext()).request(...args),
  agent: (cookie) => ({
    get: async (...args) => (await getContext()).agent(cookie).get(...args),
    post: async (...args) => (await getContext()).agent(cookie).post(...args),
    put: async (...args) => (await getContext()).agent(cookie).put(...args),
    patch: async (...args) => (await getContext()).agent(cookie).patch(...args),
    del: async (...args) => (await getContext()).agent(cookie).del(...args),
    request: async (...args) => (await getContext()).agent(cookie).request(...args),
  }),
  registerStudent: async (...args) => (await getContext()).registerStudent(...args),
  loginAdmin: async (...args) => (await getContext()).loginAdmin(...args),
};

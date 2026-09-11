'use strict';

/**
 * Autenticação por JWT em cookies httpOnly.
 *
 *   Aluno: cookie fe_session (JWT_SECRET)        payload { sub, scope: 'student', tv }
 *   Admin: cookie fe_admin   (ADMIN_JWT_SECRET)  payload { sub, scope: 'admin',   tv }
 *
 *   router.use(requireStudent)  → req.user   (sem password_hash; rejeita bloqueados e token_version divergente)
 *   router.use(requireAdmin)    → req.admin  (somente role = 'admin')
 *   router.get('/', optionalUser, ...) → req.user ou null
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/pool');
const { AppError } = require('./errors');

const STUDENT_COOKIE = 'fe_session';
const ADMIN_COOKIE = 'fe_admin';
const SESSION_MS = config.sessionDays * 24 * 60 * 60 * 1000;
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

/** Colunas públicas do usuário (nunca password_hash). */
const USER_COLUMNS = [
  'id', 'name', 'email', 'role', 'status', 'token_version', 'avatar_url',
  'access_override_until', 'last_login_at', 'last_seen_at', 'created_at', 'updated_at',
].join(', ');

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  path: '/',
});

/** Remove campos sensíveis antes de devolver o usuário na API. */
function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, token_version, ...rest } = user;
  return rest;
}

function signToken(user, scope, secret) {
  return jwt.sign(
    { sub: user.id, scope, tv: user.token_version ?? 0 },
    secret,
    { algorithm: 'HS256', expiresIn: `${config.sessionDays}d` }
  );
}

function verifyToken(token, secret) {
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

function issueStudentCookie(res, user) {
  const token = signToken(user, 'student', config.jwtSecret);
  res.cookie(STUDENT_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MS });
  return token;
}

function issueAdminCookie(res, user) {
  const token = signToken(user, 'admin', config.adminJwtSecret);
  res.cookie(ADMIN_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MS });
  return token;
}

/**
 * Limpa cookies de sessão.
 * @param {'student'|'admin'} [scope] sem valor, limpa ambos
 */
function clearCookies(res, scope) {
  if (!scope || scope === 'student') res.clearCookie(STUDENT_COOKIE, cookieOptions());
  if (!scope || scope === 'admin') res.clearCookie(ADMIN_COOKIE, cookieOptions());
}

async function loadUser(id) {
  return db.one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

/**
 * Valida o cookie e carrega o usuário. Lança AppError em caso de falha.
 * @param {'student'|'admin'} scope
 */
async function authenticate(req, scope) {
  const cookieName = scope === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE;
  const secret = scope === 'admin' ? config.adminJwtSecret : config.jwtSecret;
  const token = req.cookies ? req.cookies[cookieName] : null;
  if (!token) throw new AppError(401, 'unauthorized', 'Faça login para continuar.');

  let payload;
  try {
    payload = verifyToken(token, secret);
  } catch {
    throw new AppError(401, 'unauthorized', 'Sessão inválida ou expirada. Entre novamente.');
  }
  if (!payload || payload.scope !== scope || typeof payload.sub !== 'string') {
    throw new AppError(401, 'unauthorized', 'Sessão inválida. Entre novamente.');
  }

  const user = await loadUser(payload.sub);
  if (!user) throw new AppError(401, 'unauthorized', 'Conta não encontrada. Entre novamente.');
  if (user.token_version !== (payload.tv ?? 0)) {
    throw new AppError(401, 'unauthorized', 'Sua sessão foi encerrada. Entre novamente.');
  }
  if (user.status !== 'active') {
    throw new AppError(403, 'forbidden', 'Sua conta está bloqueada. Fale com o suporte.');
  }
  if (scope === 'admin' && user.role !== 'admin') {
    throw new AppError(403, 'forbidden', 'Acesso restrito a administradores.');
  }
  return user;
}

function touchLastSeen(user) {
  const last = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
  if (Date.now() - last < LAST_SEEN_INTERVAL_MS) return;
  user.last_seen_at = new Date();
  db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]).catch((err) => {
    console.error('[auth] falha ao atualizar last_seen_at:', err.message);
  });
}

/** Exige aluno autenticado (cookie fe_session). Popula req.user. */
function requireStudent(req, res, next) {
  authenticate(req, 'student')
    .then((user) => {
      touchLastSeen(user);
      req.user = user;
      next();
    })
    .catch(next);
}

/** Exige administrador autenticado (cookie fe_admin). Popula req.admin. */
function requireAdmin(req, res, next) {
  authenticate(req, 'admin')
    .then((user) => {
      req.admin = user;
      next();
    })
    .catch(next);
}

/** Carrega req.user se houver sessão válida de aluno; caso contrário segue com req.user = null. */
function optionalUser(req, res, next) {
  if (!req.cookies || !req.cookies[STUDENT_COOKIE]) {
    req.user = null;
    return next();
  }
  authenticate(req, 'student')
    .then((user) => {
      touchLastSeen(user);
      req.user = user;
      next();
    })
    .catch(() => {
      req.user = null;
      next();
    });
}

module.exports = {
  STUDENT_COOKIE,
  ADMIN_COOKIE,
  USER_COLUMNS,
  requireStudent,
  requireAdmin,
  optionalUser,
  issueStudentCookie,
  issueAdminCookie,
  clearCookies,
  sanitizeUser,
  loadUser,
  authenticate,
  verifyToken,
};

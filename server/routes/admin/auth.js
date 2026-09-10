'use strict';

/**
 * Autenticação do painel administrativo.
 *
 *   POST /api/admin/auth/login  { email, password } → { user } + cookie fe_admin (somente role = 'admin')
 *   POST /api/admin/auth/logout                     → { ok }
 *   GET  /api/admin/auth/me                         → { user }
 *
 * Este router é montado SEM o guard global de admin (senão o login seria inacessível);
 * por isso /me aplica requireAdmin explicitamente.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { authLimiter } = require('../../middleware/rateLimit');
const auth = require('../../middleware/auth');

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(1, 'Informe a senha.').max(128),
});

router.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  wrap(async (req, res) => {
    const { email, password } = req.valid.body;
    const user = await db.one(
      `SELECT ${auth.USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    // mesma mensagem para e-mail inexistente, senha errada ou usuário sem papel de admin
    if (!user || !valid || user.role !== 'admin') {
      throw new AppError(401, 'unauthorized', 'Credenciais inválidas.');
    }
    if (user.status !== 'active') throw new AppError(403, 'forbidden', 'Conta bloqueada.');

    await db.query('UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = $1', [user.id]);
    user.last_login_at = new Date();
    auth.issueAdminCookie(res, user);
    res.json({ user: auth.sanitizeUser(user) });
  })
);

router.post('/logout', (req, res) => {
  auth.clearCookies(res, 'admin');
  res.json({ ok: true });
});

router.get('/me', auth.requireAdmin, (req, res) => {
  res.json({ user: auth.sanitizeUser(req.admin) });
});

module.exports = { basePath: '/api/admin/auth', router };

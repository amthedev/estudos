'use strict';

/**
 * Autenticação do painel administrativo.
 *
 *   GET  /api/admin/auth/setup-status               → { needed } — true se ainda não existe administrador
 *   POST /api/admin/auth/setup   { name, email, password }
 *                                                    → cria o primeiro administrador e já autentica
 *                                                      (só funciona uma vez; depois responde 409)
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
const config = require('../../config');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { authLimiter } = require('../../middleware/rateLimit');
const { audit } = require('../../middleware/audit');
const auth = require('../../middleware/auth');

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(1, 'Informe a senha.').max(128),
});

const setupSchema = z.object({
  name: z.string().trim().min(2, 'Informe seu nome completo.').max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(128),
});

// Trava usada só durante a configuração inicial, para duas pessoas não
// criarem o administrador ao mesmo tempo (mesma ideia de um mutex, só que
// dentro do banco). O número é arbitrário; só precisa ser sempre o mesmo.
const SETUP_LOCK_KEY = 279314;

async function countAdmins() {
  const row = await db.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
  return row.total;
}

/**
 * Configuração inicial: enquanto nenhum administrador existir, a primeira
 * pessoa a abrir o painel cria a própria conta ali mesmo — não depende de
 * variável de ambiente nem de terminal. Depois que o primeiro é criado,
 * este par de rotas nunca mais faz nada além de dizer "não é mais preciso".
 */
router.get(
  '/setup-status',
  wrap(async (req, res) => {
    res.json({ needed: (await countAdmins()) === 0 });
  })
);

router.post(
  '/setup',
  authLimiter,
  validate({ body: setupSchema }),
  wrap(async (req, res) => {
    const { name, email, password } = req.valid.body;

    const created = await db.tx(async (client) => {
      // serializa concorrência: só uma requisição por vez passa daqui
      // enquanto a transação estiver aberta
      await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);

      const existing = await client.one("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
      if (existing.total > 0) {
        throw new AppError(409, 'conflict', 'Já existe um administrador configurado. Entre normalmente.');
      }

      const emailTaken = await client.one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
      if (emailTaken) {
        throw new AppError(409, 'conflict', 'Este e-mail já está em uso.', [
          { path: 'email', message: 'Este e-mail já está em uso.' },
        ]);
      }

      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const row = await client.one(
        `INSERT INTO users (name, email, password_hash, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         RETURNING ${auth.USER_COLUMNS}`,
        [name, email, passwordHash]
      );
      return row;
    });

    await db.query('UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = $1', [created.id]);
    created.last_login_at = new Date();

    req.admin = created; // para o registro de auditoria identificar quem foi criado
    await audit(req, 'admin.setup', 'user', created.id, { email: created.email });

    auth.issueAdminCookie(res, created);
    res.status(201).json({ user: auth.sanitizeUser(created) });
  })
);

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

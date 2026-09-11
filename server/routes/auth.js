'use strict';

/**
 * Autenticação e perfil do aluno.
 *
 *   POST /api/auth/register        { name, email, password }        → { user } + cookie      [pub]
 *   POST /api/auth/login           { email, password }              → { user } + cookie      [pub]
 *   POST /api/auth/logout                                           → { ok }
 *   POST /api/auth/forgot-password { email }                        → { ok } (sempre 200)    [pub]
 *   POST /api/auth/reset-password  { token, password }              → { ok }                 [pub]
 *   GET  /api/auth/me                                               → { user, profile, exam, access }
 *   PUT  /api/profile              dados/metas/disponibilidade      → { user, profile }
 *   PUT  /api/profile/password     { current_password, new_password } → { ok }
 *
 * O basePath é '/api' porque o módulo também atende /api/profile (ver ARCHITECTURE §4).
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { authLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/auth');
const { computeAccess } = require('../middleware/access');
const { getSetting } = require('../services/settings');
const mailer = require('../services/mailer');
const { generateResetToken, sha256 } = require('../utils/tokens');
const { isISODate } = require('../utils/dates');

const RESET_TTL_MINUTES = 60;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const emailSchema = z.string().trim().toLowerCase().email().max(160);
const passwordSchema = z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(128);
const nameSchema = z.string().trim().min(2, 'Informe seu nome completo.').max(120);

const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe a senha.').max(128),
});

const forgotSchema = z.object({ email: emailSchema });

const resetSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: passwordSchema,
});

const isoDate = z.string().refine(isISODate, 'Data inválida (use AAAA-MM-DD).');
const nullable = (schema) => schema.nullable().optional();

const profileSchema = z
  .object({
    name: nameSchema.optional(),
    avatar_url: nullable(z.string().trim().url().max(500)),
    exam_id: nullable(z.string().uuid()),
    other_exam_name: nullable(z.string().trim().max(120)),
    study_days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    hours_per_day: z.number().min(0.5).max(16).optional(),
    level: z.enum(['iniciante', 'intermediario', 'avancado']).optional(),
    weakest_subject_id: nullable(z.string().uuid()),
    exam_date: nullable(isoDate),
    target_course: nullable(z.string().trim().max(120)),
    target_university: nullable(z.string().trim().max(120)),
    target_score: nullable(z.string().trim().max(60)),
    main_difficulty: nullable(z.string().trim().max(500)),
    performance_goal: nullable(z.string().trim().max(500)),
    weekly_goal_hours: nullable(z.number().min(0).max(120)),
  })
  .strict();

const passwordChangeSchema = z.object({
  current_password: z.string().min(1, 'Informe a senha atual.').max(128),
  new_password: passwordSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EXAM_COLUMNS =
  'id, slug, name, short_name, track, board, description, exam_date, has_essay, essay_max_score, score_max, active';

async function findUserByEmail(email) {
  return db.one(`SELECT ${auth.USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`, [email]);
}

async function loadProfile(userId) {
  const profile = await db.one('SELECT * FROM student_profiles WHERE user_id = $1', [userId]);
  if (!profile) return { profile: null, exam: null };
  const exam = profile.exam_id ? await db.one(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = $1`, [profile.exam_id]) : null;
  profile.study_days = Array.isArray(profile.study_days) ? profile.study_days.map(Number) : [];
  return { profile: { ...profile, exam }, exam };
}

/** Recalcula o cronograma quando o módulo de cronograma estiver disponível; nunca derruba a requisição. */
async function regenerateScheduleSafely(userId) {
  let schedule;
  try {
    schedule = require('../services/schedule');
  } catch {
    return false; // módulo ainda não existe neste ambiente
  }
  try {
    if (typeof schedule.regenerateFromTomorrow === 'function') {
      await schedule.regenerateFromTomorrow(userId);
      return true;
    }
  } catch (err) {
    console.error('[auth] falha ao regenerar o cronograma:', err.message);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cadastro e login
// ---------------------------------------------------------------------------
router.post(
  '/auth/register',
  authLimiter,
  validate({ body: registerSchema }),
  wrap(async (req, res) => {
    const { name, email, password } = req.valid.body;

    const existing = await db.one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existing) throw new AppError(409, 'conflict', 'Já existe uma conta com este e-mail.');

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const user = await db.tx(async (client) => {
      const created = await client.one(
        `INSERT INTO users (name, email, password_hash, role, last_login_at)
         VALUES ($1, $2, $3, 'student', now())
         RETURNING ${auth.USER_COLUMNS}`,
        [name, email, passwordHash]
      );
      await client.query('INSERT INTO student_profiles (user_id) VALUES ($1)', [created.id]);
      return created;
    });

    auth.issueStudentCookie(res, user);
    const access = await computeAccess(user.id);
    res.status(201).json({
      user: auth.sanitizeUser(user),
      access: { allowed: access.allowed, reason: access.reason, required: access.required },
      next: access.allowed ? '/app/onboarding' : '/app/assinatura',
    });
  })
);

router.post(
  '/auth/login',
  authLimiter,
  validate({ body: loginSchema }),
  wrap(async (req, res) => {
    const { email, password } = req.valid.body;
    const user = await findUserByEmail(email);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !valid) throw new AppError(401, 'unauthorized', 'E-mail ou senha incorretos.');
    if (user.status !== 'active') throw new AppError(403, 'forbidden', 'Sua conta está bloqueada. Fale com o suporte.');

    await db.query('UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = $1', [user.id]);
    user.last_login_at = new Date();
    auth.issueStudentCookie(res, user);
    res.json({ user: auth.sanitizeUser(user) });
  })
);

router.post('/auth/logout', (req, res) => {
  auth.clearCookies(res, 'student');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Recuperação de senha
// ---------------------------------------------------------------------------
router.post(
  '/auth/forgot-password',
  authLimiter,
  validate({ body: forgotSchema }),
  wrap(async (req, res) => {
    const { email } = req.valid.body;
    const user = await db.one('SELECT id, name, email, status FROM users WHERE lower(email) = lower($1)', [email]);

    if (user && user.status === 'active') {
      const { token, hash, expiresAt } = generateResetToken(RESET_TTL_MINUTES);
      await db.tx(async (client) => {
        await client.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);
        await client.query(
          'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
          [user.id, hash, expiresAt]
        );
      });

      const [brandName, supportEmail] = await Promise.all([getSetting('brand_name'), getSetting('support_email')]);
      const link = `${config.appUrl}/redefinir-senha?token=${encodeURIComponent(token)}`;
      const mail = mailer.passwordResetEmail({
        name: user.name,
        link,
        brandName,
        supportEmail,
        expiresMinutes: RESET_TTL_MINUTES,
      });
      await mailer.sendMail({ to: user.email, ...mail });
    }

    // resposta idêntica exista ou não a conta, para não revelar e-mails cadastrados
    res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, você receberá as instruções em instantes.' });
  })
);

router.post(
  '/auth/reset-password',
  authLimiter,
  validate({ body: resetSchema }),
  wrap(async (req, res) => {
    const { token, password } = req.valid.body;
    const reset = await db.one(
      `SELECT pr.id, pr.user_id, u.status
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [sha256(token)]
    );
    if (!reset) {
      throw new AppError(400, 'validation_error', 'Link inválido ou expirado. Solicite uma nova recuperação de senha.');
    }
    if (reset.status !== 'active') throw new AppError(403, 'forbidden', 'Sua conta está bloqueada. Fale com o suporte.');

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    await db.tx(async (client) => {
      // token_version + 1 encerra todas as sessões abertas
      await client.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [
        passwordHash,
        reset.user_id,
      ]);
      await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [reset.id]);
      await client.query('DELETE FROM password_resets WHERE user_id = $1 AND id <> $2', [reset.user_id, reset.id]);
    });

    res.json({ ok: true, message: 'Senha redefinida. Entre com a nova senha.' });
  })
);

// ---------------------------------------------------------------------------
// Sessão atual
// ---------------------------------------------------------------------------
router.get(
  '/auth/me',
  auth.requireStudent,
  wrap(async (req, res) => {
    const [{ profile, exam }, access] = await Promise.all([loadProfile(req.user.id), computeAccess(req.user.id)]);
    res.json({ user: auth.sanitizeUser(req.user), profile, exam, access });
  })
);

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------
const SCHEDULE_FIELDS = ['exam_id', 'exam_date', 'study_days', 'hours_per_day', 'level', 'weakest_subject_id'];
const PROFILE_FIELDS = [
  'exam_id', 'other_exam_name', 'study_days', 'hours_per_day', 'level', 'weakest_subject_id', 'exam_date',
  'target_course', 'target_university', 'target_score', 'main_difficulty', 'performance_goal', 'weekly_goal_hours',
];

router.put(
  '/profile',
  auth.requireStudent,
  validate({ body: profileSchema }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const userId = req.user.id;

    if (body.exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1 AND active', [body.exam_id]);
      if (!exam) throw new AppError(400, 'validation_error', 'Prova não encontrada.', [{ path: 'exam_id', message: 'Prova não encontrada.' }]);
    }
    if (body.weakest_subject_id) {
      const subject = await db.one('SELECT id FROM subjects WHERE id = $1', [body.weakest_subject_id]);
      if (!subject) throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [{ path: 'weakest_subject_id', message: 'Matéria não encontrada.' }]);
    }
    if (body.study_days) body.study_days = [...new Set(body.study_days)].sort((a, b) => a - b);

    const current = await db.one('SELECT * FROM student_profiles WHERE user_id = $1', [userId]);

    await db.tx(async (client) => {
      const userSets = [];
      const userParams = [];
      if (body.name !== undefined) {
        userParams.push(body.name);
        userSets.push(`name = $${userParams.length}`);
      }
      if (body.avatar_url !== undefined) {
        userParams.push(body.avatar_url);
        userSets.push(`avatar_url = $${userParams.length}`);
      }
      if (userSets.length > 0) {
        userParams.push(userId);
        await client.query(`UPDATE users SET ${userSets.join(', ')} WHERE id = $${userParams.length}`, userParams);
      }

      const sets = [];
      const params = [];
      for (const field of PROFILE_FIELDS) {
        if (body[field] === undefined) continue;
        params.push(body[field]);
        sets.push(`${field} = $${params.length}`);
      }
      if (!current) {
        await client.query('INSERT INTO student_profiles (user_id) VALUES ($1)', [userId]);
      }
      if (sets.length > 0) {
        params.push(userId);
        await client.query(`UPDATE student_profiles SET ${sets.join(', ')} WHERE user_id = $${params.length}`, params);
      }
    });

    // Mudou prova ou disponibilidade e o onboarding já foi feito → recalcula o cronograma
    const scheduleChanged = SCHEDULE_FIELDS.some(
      (field) => body[field] !== undefined && current && JSON.stringify(body[field]) !== JSON.stringify(current[field])
    );
    let scheduleRegenerated = false;
    if (scheduleChanged && current && current.onboarding_completed) {
      scheduleRegenerated = await regenerateScheduleSafely(userId);
    }

    const [user, { profile }] = await Promise.all([auth.loadUser(userId), loadProfile(userId)]);
    res.json({ user: auth.sanitizeUser(user), profile, schedule_regenerated: scheduleRegenerated });
  })
);

router.put(
  '/profile/password',
  auth.requireStudent,
  validate({ body: passwordChangeSchema }),
  wrap(async (req, res) => {
    const { current_password: currentPassword, new_password: newPassword } = req.valid.body;
    const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = row ? await bcrypt.compare(currentPassword, row.password_hash) : false;
    if (!valid) {
      throw new AppError(400, 'validation_error', 'Senha atual incorreta.', [
        { path: 'current_password', message: 'Senha atual incorreta.' },
      ]);
    }
    if (currentPassword === newPassword) {
      throw new AppError(400, 'validation_error', 'A nova senha deve ser diferente da atual.', [
        { path: 'new_password', message: 'A nova senha deve ser diferente da atual.' },
      ]);
    }

    const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    const user = await db.one(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING ${auth.USER_COLUMNS}`,
      [passwordHash, req.user.id]
    );
    // outras sessões caem; esta continua válida com um novo cookie
    auth.issueStudentCookie(res, user);
    res.json({ ok: true, message: 'Senha alterada.' });
  })
);

module.exports = { basePath: '/api', router };

'use strict';

/**
 * Painel administrativo — alunos.
 *
 *   GET    /api/admin/students                 lista paginada (q, status, exam_id, onboarding, subscription, sort, dir)
 *   GET    /api/admin/students/:id             usuário + perfil + assinatura/acesso + métricas + atividades + redações
 *   GET    /api/admin/students/:id/progress    progresso por matéria + atividade diária (30 dias)
 *   PUT    /api/admin/students/:id             { name?, email?, avatar_url?, profile?: {...} }
 *   POST   /api/admin/students/:id/block       bloqueia e encerra sessões (token_version + 1)
 *   POST   /api/admin/students/:id/unblock
 *   POST   /api/admin/students/:id/grant-access { until: ISO | 'YYYY-MM-DD' | null }
 *   POST   /api/admin/students/:id/reset-password { password }
 *   DELETE /api/admin/students/:id
 *
 * Só usuários com role = 'student' são tratados aqui; administradores nunca aparecem.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const config = require('../../config');
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { USER_COLUMNS, sanitizeUser } = require('../../middleware/auth');
const { computeAccess } = require('../../middleware/access');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { TIMEZONE, todayISO, addDays, eachDay, isISODate } = require('../../utils/dates');

const ACTIVITY_DAYS = 30;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const idParams = z.object({ id: z.string().uuid() });
const isoDate = z.string().refine(isISODate, 'Data inválida (use AAAA-MM-DD).');
const nullable = (schema) => schema.nullable().optional();

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  exam_id: z.string().uuid().optional(),
  onboarding: z.enum(['true', 'false']).optional(),
  subscription: z.enum(['active', 'inactive', 'none', 'override']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const profileSchema = z
  .object({
    exam_id: nullable(z.string().uuid()),
    other_exam_name: nullable(z.string().trim().max(120)),
    study_days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    // Aceitam nulo porque a tela oferece o vazio: "Não informado" no nível e o
    // campo de horas apagável. Sem nullable, limpar era recusado em silêncio.
    hours_per_day: nullable(z.number().min(0.5).max(16)),
    level: nullable(z.enum(['iniciante', 'intermediario', 'avancado'])),
    weakest_subject_id: nullable(z.string().uuid()),
    exam_date: nullable(isoDate),
    target_course: nullable(z.string().trim().max(120)),
    target_university: nullable(z.string().trim().max(120)),
    target_score: nullable(z.string().trim().max(60)),
    main_difficulty: nullable(z.string().trim().max(500)),
    performance_goal: nullable(z.string().trim().max(500)),
    weekly_goal_hours: nullable(z.number().min(0).max(120)),
    onboarding_completed: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome completo.').max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(160).optional(),
    avatar_url: nullable(z.string().trim().url().max(500)),
    profile: profileSchema.optional(),
  })
  .strict();

const grantSchema = z.object({
  until: z.union([z.string().trim().min(10).max(40), z.null()]),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(128),
});

const PROFILE_FIELDS = [
  'exam_id', 'other_exam_name', 'study_days', 'hours_per_day', 'level', 'weakest_subject_id', 'exam_date',
  'target_course', 'target_university', 'target_score', 'main_difficulty', 'performance_goal', 'weekly_goal_hours',
  'onboarding_completed',
];

const SORT_COLUMNS = {
  name: 'b.name',
  email: 'b.email',
  created_at: 'b.created_at',
  last_seen_at: 'b.last_seen_at',
  status: 'b.status',
  progress_pct: 'progress_pct',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

async function findStudent(id) {
  return db.one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND role = 'student'`, [id]);
}

async function requireStudentRow(id) {
  const user = await findStudent(id);
  if (!user) throw new AppError(404, 'not_found', 'Aluno não encontrado.');
  return user;
}

/** Sequência de dias consecutivos com estudo, terminando hoje ou ontem (São Paulo). */
function computeStreak(dates, today) {
  if (!dates.length) return 0;
  const set = new Set(dates);
  let cursor = today;
  if (!set.has(cursor)) {
    cursor = addDays(today, -1);
    if (!set.has(cursor)) return 0;
  }
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Perfil com prova e matéria fraca resolvidas. */
async function loadProfile(userId) {
  const profile = await db.one(
    `SELECT p.*, s.name AS weakest_subject_name
       FROM student_profiles p
       LEFT JOIN subjects s ON s.id = p.weakest_subject_id
      WHERE p.user_id = $1`,
    [userId]
  );
  if (!profile) return null;
  profile.study_days = Array.isArray(profile.study_days) ? profile.study_days.map(Number) : [];
  profile.exam = profile.exam_id
    ? await db.one('SELECT id, slug, name, short_name, track, exam_date, has_essay FROM exams WHERE id = $1', [profile.exam_id])
    : null;
  return profile;
}

async function loadMetrics(userId, examId) {
  const today = todayISO();
  const [counts, studyDates] = await Promise.all([
    db.one(
      `SELECT
         (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id AND l.active
           WHERE lp.user_id = $1 AND lp.status = 'completed') AS lessons_done,
         (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id AND l.active
           WHERE lp.user_id = $1 AND lp.status = 'in_progress') AS lessons_in_progress,
         (SELECT count(*) FROM lessons l
           WHERE l.active AND ($2::uuid IS NULL OR EXISTS (
             SELECT 1 FROM lesson_exams le WHERE le.lesson_id = l.id AND le.exam_id = $2::uuid))) AS lessons_total,
         (SELECT count(*) FROM question_attempts WHERE user_id = $1) AS questions_answered,
         (SELECT count(*) FROM question_attempts WHERE user_id = $1 AND is_correct) AS questions_correct,
         (SELECT coalesce(sum(minutes), 0) FROM study_logs WHERE user_id = $1) AS study_minutes,
         (SELECT count(*) FROM simulado_attempts WHERE user_id = $1 AND status = 'finished') AS simulados_finished,
         (SELECT round(avg(score)::numeric, 1) FROM simulado_attempts WHERE user_id = $1 AND status = 'finished') AS simulados_avg_score,
         (SELECT count(*) FROM essays WHERE user_id = $1) AS essays_total,
         (SELECT count(*) FROM essays WHERE user_id = $1 AND status = 'corrected') AS essays_corrected,
         (SELECT round(avg(score)::numeric, 1) FROM essays WHERE user_id = $1 AND status = 'corrected') AS essays_avg_score,
         (SELECT count(*) FROM reviews WHERE user_id = $1 AND status = 'pending' AND due_date <= $3) AS reviews_due,
         (SELECT count(*) FROM error_notebook WHERE user_id = $1 AND NOT resolved) AS errors_open,
         (SELECT count(*) FROM tutor_conversations WHERE user_id = $1) AS tutor_conversations,
         (SELECT max(created_at) FROM study_logs WHERE user_id = $1) AS last_activity_at`,
      [userId, examId || null, today]
    ),
    db.many(
      `SELECT DISTINCT study_date FROM study_logs WHERE user_id = $1 ORDER BY study_date DESC LIMIT 400`,
      [userId]
    ),
  ]);

  const answered = Number(counts.questions_answered) || 0;
  const correct = Number(counts.questions_correct) || 0;
  const total = Number(counts.lessons_total) || 0;
  const done = Number(counts.lessons_done) || 0;
  return {
    ...counts,
    accuracy_pct: answered > 0 ? Math.round((correct / answered) * 100) : null,
    progress_pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    study_hours: Math.round(((Number(counts.study_minutes) || 0) / 60) * 10) / 10,
    streak: computeStreak(studyDates.map((row) => row.study_date), today),
  };
}

async function loadStudentDetail(id) {
  const user = await requireStudentRow(id);
  const profile = await loadProfile(id);
  const examId = profile ? profile.exam_id : null;
  const [access, metrics, recentActivity, essays, bookings] = await Promise.all([
    computeAccess(id),
    loadMetrics(id, examId),
    db.many(
      `SELECT sl.id, sl.activity_type, sl.minutes, sl.study_date, sl.created_at, s.name AS subject_name
         FROM study_logs sl
         LEFT JOIN subjects s ON s.id = sl.subject_id
        WHERE sl.user_id = $1
        ORDER BY sl.created_at DESC
        LIMIT 15`,
      [id]
    ),
    db.many(
      `SELECT es.id, es.theme_title, es.status, es.score, es.max_score, es.word_count,
              es.submitted_at, es.corrected_at, es.created_at, ex.short_name AS exam_short_name
         FROM essays es
         LEFT JOIN exams ex ON ex.id = es.exam_id
        WHERE es.user_id = $1
        ORDER BY es.created_at DESC
        LIMIT 10`,
      [id]
    ),
    db.many(
      `SELECT b.id, b.starts_at, b.ends_at, b.status, t.name AS teacher_name, s.name AS subject_name
         FROM bookings b
         JOIN teachers t ON t.id = b.teacher_id
         LEFT JOIN subjects s ON s.id = b.subject_id
        WHERE b.user_id = $1
        ORDER BY b.starts_at DESC
        LIMIT 5`,
      [id]
    ),
  ]);

  return {
    user: sanitizeUser(user),
    profile,
    access,
    subscription: access.subscription,
    metrics,
    recent_activity: recentActivity,
    essays,
    bookings,
  };
}

/** Interpreta o campo `until` do grant-access: data (fim do dia em São Paulo) ou data/hora ISO. */
function parseUntil(value) {
  if (value === null) return null;
  if (isISODate(value)) return new Date(`${value}T23:59:59-03:00`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'validation_error', 'Data inválida.', [{ path: 'until', message: 'Informe uma data válida.' }]);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, SORT_COLUMNS, { defaultSort: 'created_at', defaultDir: 'desc' });

    const where = [];
    const params = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.q) {
      const p = add(likePattern(query.q.toLowerCase()));
      where.push(`(lower(fe_unaccent(b.name)) LIKE fe_unaccent(${p}) OR lower(b.email) LIKE ${p})`);
    }
    if (query.status) where.push(`b.status = ${add(query.status)}`);
    if (query.exam_id) where.push(`b.exam_id = ${add(query.exam_id)}`);
    if (query.onboarding) where.push(`coalesce(b.onboarding_completed, false) = ${add(query.onboarding === 'true')}`);
    if (query.subscription === 'active') where.push('b.subscription_active');
    else if (query.subscription === 'inactive') where.push('b.subscription_status IS NOT NULL AND NOT b.subscription_active');
    else if (query.subscription === 'none') where.push('b.subscription_status IS NULL');
    else if (query.subscription === 'override') where.push('b.access_override_active');

    const base = `
      WITH base AS (
        SELECT u.id, u.name, u.email, u.status, u.created_at, u.last_seen_at, u.last_login_at, u.access_override_until,
               (u.access_override_until IS NOT NULL AND u.access_override_until > now()) AS access_override_active,
               p.exam_id, p.onboarding_completed, p.level, e.short_name AS exam_short_name, e.name AS exam_name,
               s.status AS subscription_status, s.current_period_end AS subscription_period_end, pl.name AS plan_name,
               (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now())) AS subscription_active,
               (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id AND l.active
                 WHERE lp.user_id = u.id AND lp.status = 'completed') AS lessons_done,
               (SELECT count(*) FROM lessons l
                 WHERE l.active AND (p.exam_id IS NULL OR EXISTS (
                   SELECT 1 FROM lesson_exams le WHERE le.lesson_id = l.id AND le.exam_id = p.exam_id))) AS lessons_total
          FROM users u
          LEFT JOIN student_profiles p ON p.user_id = u.id
          LEFT JOIN exams e ON e.id = p.exam_id
          LEFT JOIN LATERAL (
            SELECT s.status, s.current_period_end, s.plan_id
              FROM subscriptions s
             WHERE s.user_id = u.id
             ORDER BY (s.status IN ('active','trialing')) DESC, s.current_period_end DESC NULLS LAST, s.created_at DESC
             LIMIT 1
          ) s ON true
          LEFT JOIN plans pl ON pl.id = s.plan_id
         WHERE u.role = 'student'
      ),
      filtered AS (
        SELECT b.*,
               CASE WHEN b.lessons_total > 0 THEN least(100, round(b.lessons_done * 100.0 / b.lessons_total)) ELSE 0 END AS progress_pct
          FROM base b
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      )`;

    const countParams = params.slice();
    const itemsSql = `${base} SELECT * FROM filtered b ORDER BY ${sort.sql} NULLS LAST, b.created_at DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    const [countRow, items] = await Promise.all([
      db.one(`${base} SELECT count(*) AS total FROM filtered`, countParams),
      db.many(itemsSql, params),
    ]);

    res.json(paginate(items, countRow ? countRow.total : 0, { page, limit }));
  })
);

// ---------------------------------------------------------------------------
// Detalhe e progresso
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    res.json(await loadStudentDetail(req.valid.params.id));
  })
);

router.get(
  '/:id/progress',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireStudentRow(id);
    const profile = await db.one('SELECT exam_id FROM student_profiles WHERE user_id = $1', [id]);
    const examId = profile ? profile.exam_id : null;
    const today = todayISO();
    const from = addDays(today, -(ACTIVITY_DAYS - 1));

    const [bySubject, minutesByDay, questionsByDay, byType] = await Promise.all([
      db.many(
        `SELECT s.id AS subject_id, s.name, s.color, s.icon,
                (SELECT count(*) FROM lessons l
                  WHERE l.subject_id = s.id AND l.active AND ($2::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM lesson_exams le WHERE le.lesson_id = l.id AND le.exam_id = $2::uuid))) AS lessons_total,
                (SELECT count(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
                  WHERE lp.user_id = $1 AND lp.status = 'completed' AND l.subject_id = s.id) AS lessons_done,
                (SELECT count(*) FROM question_attempts qa WHERE qa.user_id = $1 AND qa.subject_id = s.id) AS attempts,
                (SELECT count(*) FROM question_attempts qa WHERE qa.user_id = $1 AND qa.subject_id = s.id AND qa.is_correct) AS correct,
                (SELECT coalesce(sum(minutes), 0) FROM study_logs sl WHERE sl.user_id = $1 AND sl.subject_id = s.id) AS minutes
           FROM subjects s
          WHERE s.active AND ($2::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM exam_subjects es WHERE es.subject_id = s.id AND es.exam_id = $2::uuid))
          ORDER BY s.sort_order, s.name`,
        [id, examId]
      ),
      db.many(
        `SELECT study_date AS date, coalesce(sum(minutes), 0) AS minutes
           FROM study_logs WHERE user_id = $1 AND study_date >= $2 GROUP BY 1`,
        [id, from]
      ),
      db.many(
        `SELECT (answered_at AT TIME ZONE $3)::date AS date, count(*) AS questions,
                count(*) FILTER (WHERE is_correct) AS correct
           FROM question_attempts
          WHERE user_id = $1 AND (answered_at AT TIME ZONE $3)::date >= $2
          GROUP BY 1`,
        [id, from, TIMEZONE]
      ),
      db.many(
        `SELECT activity_type, count(*) AS entries, coalesce(sum(minutes), 0) AS minutes
           FROM study_logs WHERE user_id = $1 GROUP BY activity_type ORDER BY minutes DESC`,
        [id]
      ),
    ]);

    const minutesMap = new Map(minutesByDay.map((row) => [row.date, Number(row.minutes) || 0]));
    const questionsMap = new Map(questionsByDay.map((row) => [row.date, row]));
    const activityByDay = eachDay(from, today).map((date) => {
      const q = questionsMap.get(date);
      return {
        date,
        minutes: minutesMap.get(date) || 0,
        questions: q ? Number(q.questions) || 0 : 0,
        correct: q ? Number(q.correct) || 0 : 0,
      };
    });

    res.json({
      exam_id: examId,
      from,
      to: today,
      by_subject: bySubject.map((row) => {
        const total = Number(row.lessons_total) || 0;
        const done = Number(row.lessons_done) || 0;
        const attempts = Number(row.attempts) || 0;
        return {
          ...row,
          progress_pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
          accuracy_pct: attempts > 0 ? Math.round(((Number(row.correct) || 0) / attempts) * 100) : null,
        };
      }),
      activity_by_day: activityByDay,
      by_type: byType,
    });
  })
);

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------
router.put(
  '/:id',
  validate({ params: idParams, body: updateSchema }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const before = await requireStudentRow(id);

    if (body.email && body.email !== before.email.toLowerCase()) {
      const taken = await db.one('SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2', [body.email, id]);
      if (taken) throw new AppError(409, 'conflict', 'Já existe uma conta com este e-mail.');
    }
    const profileBody = body.profile || {};
    if (profileBody.exam_id) {
      const exam = await db.one('SELECT id FROM exams WHERE id = $1', [profileBody.exam_id]);
      if (!exam) throw new AppError(400, 'validation_error', 'Prova não encontrada.', [{ path: 'exam_id', message: 'Prova não encontrada.' }]);
    }
    if (profileBody.weakest_subject_id) {
      const subject = await db.one('SELECT id FROM subjects WHERE id = $1', [profileBody.weakest_subject_id]);
      if (!subject) throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [{ path: 'weakest_subject_id', message: 'Matéria não encontrada.' }]);
    }
    if (profileBody.study_days) profileBody.study_days = [...new Set(profileBody.study_days)].sort((a, b) => a - b);

    await db.tx(async (client) => {
      const sets = [];
      const params = [];
      for (const field of ['name', 'email', 'avatar_url']) {
        if (body[field] === undefined) continue;
        params.push(body[field]);
        sets.push(`${field} = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }

      const profileSets = [];
      const profileParams = [];
      for (const field of PROFILE_FIELDS) {
        if (profileBody[field] === undefined) continue;
        profileParams.push(profileBody[field]);
        profileSets.push(`${field} = $${profileParams.length}`);
      }
      if (profileSets.length) {
        await client.query('INSERT INTO student_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [id]);
        profileParams.push(id);
        await client.query(
          `UPDATE student_profiles SET ${profileSets.join(', ')} WHERE user_id = $${profileParams.length}`,
          profileParams
        );
      }
    });

    const diff = {};
    for (const field of ['name', 'email', 'avatar_url']) {
      if (body[field] !== undefined && body[field] !== before[field]) diff[field] = { from: before[field], to: body[field] };
    }
    if (Object.keys(profileBody).length) diff.profile = profileBody;
    await audit(req, 'student.update', 'user', id, diff);

    res.json(await loadStudentDetail(id));
  })
);

// ---------------------------------------------------------------------------
// Bloqueio / desbloqueio
// ---------------------------------------------------------------------------
router.post(
  '/:id/block',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const user = await requireStudentRow(id);
    if (user.status !== 'blocked') {
      // token_version + 1 derruba todas as sessões abertas do aluno
      await db.query(`UPDATE users SET status = 'blocked', token_version = token_version + 1 WHERE id = $1`, [id]);
    }
    await audit(req, 'student.block', 'user', id, { email: user.email });
    res.json({ user: sanitizeUser(await findStudent(id)), message: 'Aluno bloqueado. As sessões ativas foram encerradas.' });
  })
);

router.post(
  '/:id/unblock',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const user = await requireStudentRow(id);
    if (user.status !== 'active') {
      await db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [id]);
    }
    await audit(req, 'student.unblock', 'user', id, { email: user.email });
    res.json({ user: sanitizeUser(await findStudent(id)), message: 'Aluno desbloqueado.' });
  })
);

// ---------------------------------------------------------------------------
// Liberação manual de acesso
// ---------------------------------------------------------------------------
router.post(
  '/:id/grant-access',
  validate({ params: idParams, body: grantSchema }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireStudentRow(id);
    const until = parseUntil(req.valid.body.until);
    if (until && until.getTime() <= Date.now()) {
      throw new AppError(400, 'validation_error', 'A data precisa ser futura.', [{ path: 'until', message: 'A data precisa ser futura.' }]);
    }
    await db.query('UPDATE users SET access_override_until = $1 WHERE id = $2', [until, id]);
    await audit(req, 'student.grant_access', 'user', id, { until: until ? until.toISOString() : null });

    const [user, access] = await Promise.all([findStudent(id), computeAccess(id)]);
    res.json({
      user: sanitizeUser(user),
      access,
      message: until ? 'Acesso liberado manualmente.' : 'Liberação manual removida.',
    });
  })
);

// ---------------------------------------------------------------------------
// Senha e exclusão
// ---------------------------------------------------------------------------
router.post(
  '/:id/reset-password',
  validate({ params: idParams, body: resetPasswordSchema }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const user = await requireStudentRow(id);
    const passwordHash = await bcrypt.hash(req.valid.body.password, config.bcryptRounds);
    await db.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [passwordHash, id]);
    await db.query('DELETE FROM password_resets WHERE user_id = $1', [id]);
    await audit(req, 'student.reset_password', 'user', id, { email: user.email });
    res.json({ ok: true, message: 'Senha redefinida. As sessões ativas do aluno foram encerradas.' });
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const user = await requireStudentRow(id);
    await db.query(`DELETE FROM users WHERE id = $1 AND role = 'student'`, [id]);
    await audit(req, 'student.delete', 'user', id, { name: user.name, email: user.email });
    res.json({ ok: true, message: 'Aluno excluído.' });
  })
);

module.exports = { basePath: '/api/admin/students', router };

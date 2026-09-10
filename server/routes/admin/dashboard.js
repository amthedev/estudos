'use strict';

/**
 * Painel administrativo — visão geral.
 *
 *   GET /api/admin/dashboard → {
 *     students_total, students_active_7d, students_new_30d, lessons_total, questions_total,
 *     simulados_attempts, essays_corrected, past_exams_total, subscriptions_active, ai_month_tokens,
 *     ai_month_limit, series: { signups_by_day[], activity_by_day[] } (30 dias),
 *     latest_students[], latest_essays[]
 *   }
 *
 * Datas agrupadas no fuso America/Sao_Paulo (utils/dates).
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { wrap } = require('../../middleware/errors');
const { getSetting } = require('../../services/settings');
const { TIMEZONE, todayISO, addDays, startOfMonth, eachDay } = require('../../utils/dates');

const SERIES_DAYS = 30;
const LATEST_LIMIT = 8;

/** Preenche a série diária com zeros nos dias sem registro. */
function fillSeries(days, rows, key = 'count') {
  const map = new Map(rows.map((row) => [row.date, Number(row[key]) || 0]));
  return days.map((date) => ({ date, [key]: map.get(date) || 0 }));
}

router.get(
  '/',
  wrap(async (req, res) => {
    const today = todayISO();
    const from = addDays(today, -(SERIES_DAYS - 1));
    const monthStart = startOfMonth(today);

    const [totals, signups, activity, latestStudents, latestEssays, monthLimit] = await Promise.all([
      db.one(
        `SELECT
           (SELECT count(*) FROM users WHERE role = 'student') AS students_total,
           (SELECT count(*) FROM users WHERE role = 'student' AND last_seen_at >= now() - interval '7 days') AS students_active_7d,
           (SELECT count(*) FROM users WHERE role = 'student' AND created_at >= now() - interval '30 days') AS students_new_30d,
           (SELECT count(*) FROM lessons WHERE active) AS lessons_total,
           (SELECT count(*) FROM questions WHERE active) AS questions_total,
           (SELECT count(*) FROM simulado_attempts WHERE status = 'finished') AS simulados_attempts,
           (SELECT count(*) FROM essays WHERE status = 'corrected') AS essays_corrected,
           (SELECT count(*) FROM past_exams WHERE active) AS past_exams_total,
           (SELECT count(*) FROM subscriptions
             WHERE status IN ('active','trialing')
               AND (current_period_end IS NULL OR current_period_end > now())) AS subscriptions_active,
           (SELECT coalesce(sum(total_tokens), 0) FROM ai_usage
             WHERE (created_at AT TIME ZONE $1)::date >= $2) AS ai_month_tokens`,
        [TIMEZONE, monthStart]
      ),
      db.many(
        `SELECT (created_at AT TIME ZONE $1)::date AS date, count(*) AS count
           FROM users
          WHERE role = 'student' AND (created_at AT TIME ZONE $1)::date >= $2
          GROUP BY 1`,
        [TIMEZONE, from]
      ),
      db.many(
        `SELECT study_date AS date, count(DISTINCT user_id) AS count
           FROM study_logs
          WHERE study_date >= $1
          GROUP BY 1`,
        [from]
      ),
      db.many(
        `SELECT u.id, u.name, u.email, u.status, u.created_at, u.last_seen_at,
                p.onboarding_completed, e.short_name AS exam_short_name
           FROM users u
           LEFT JOIN student_profiles p ON p.user_id = u.id
           LEFT JOIN exams e ON e.id = p.exam_id
          WHERE u.role = 'student'
          ORDER BY u.created_at DESC
          LIMIT $1`,
        [LATEST_LIMIT]
      ),
      db.many(
        `SELECT es.id, es.user_id, u.name AS user_name, es.theme_title, es.status, es.score, es.max_score,
                es.submitted_at, es.corrected_at, es.created_at, ex.short_name AS exam_short_name
           FROM essays es
           JOIN users u ON u.id = es.user_id
           LEFT JOIN exams ex ON ex.id = es.exam_id
          WHERE es.status IN ('submitted','corrected','failed')
          ORDER BY coalesce(es.corrected_at, es.submitted_at, es.created_at) DESC
          LIMIT $1`,
        [LATEST_LIMIT]
      ),
      getSetting('openai_monthly_token_limit'),
    ]);

    const days = eachDay(from, today);
    res.json({
      ...totals,
      ai_month_limit: Number(monthLimit) || 0,
      series: {
        signups_by_day: fillSeries(days, signups),
        activity_by_day: fillSeries(days, activity),
      },
      latest_students: latestStudents,
      latest_essays: latestEssays,
    });
  })
);

module.exports = { basePath: '/api/admin/dashboard', router };

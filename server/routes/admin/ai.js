'use strict';

/**
 * Painel administrativo — uso da inteligência artificial.
 *
 *   GET /api/admin/ai/usage?days=30 → {
 *     days, from, to,
 *     totals:   { tokens, requests, errors, prompt_tokens, completion_tokens, avg_latency_ms },
 *     by_day:   [{ date, tokens, requests, errors }]        (série completa, com zeros)
 *     by_feature: [{ feature, requests, tokens, errors }]
 *     top_users:  [{ user_id, name, email, tokens, requests }]
 *     limit, limit_reached, month_tokens
 *   }
 *
 * A fonte é a tabela ai_usage, alimentada por services/ai.js a cada chamada (tutor, redação e
 * geração de temas). Os dias são agrupados no fuso America/Sao_Paulo.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const ai = require('../../services/ai');
const { TIMEZONE, todayISO, addDays, eachDay } = require('../../utils/dates');

const TOP_USERS_LIMIT = 10;

const usageQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

router.get(
  '/usage',
  validate({ query: usageQuery }),
  wrap(async (req, res) => {
    const days = req.valid.query.days || 30;
    const to = todayISO();
    const from = addDays(to, -(days - 1));

    const [totals, byDay, byFeature, topUsers, monthly] = await Promise.all([
      db.one(
        `SELECT coalesce(sum(total_tokens), 0)::int AS tokens,
                coalesce(sum(prompt_tokens), 0)::int AS prompt_tokens,
                coalesce(sum(completion_tokens), 0)::int AS completion_tokens,
                count(*)::int AS requests,
                count(*) FILTER (WHERE status = 'error')::int AS errors,
                coalesce(round(avg(latency_ms)), 0)::int AS avg_latency_ms
           FROM ai_usage
          WHERE (created_at AT TIME ZONE $1)::date >= $2`,
        [TIMEZONE, from]
      ),
      db.many(
        `SELECT (created_at AT TIME ZONE $1)::date AS date,
                coalesce(sum(total_tokens), 0)::int AS tokens,
                count(*)::int AS requests,
                count(*) FILTER (WHERE status = 'error')::int AS errors
           FROM ai_usage
          WHERE (created_at AT TIME ZONE $1)::date >= $2
          GROUP BY 1 ORDER BY 1`,
        [TIMEZONE, from]
      ),
      db.many(
        `SELECT feature,
                count(*)::int AS requests,
                coalesce(sum(total_tokens), 0)::int AS tokens,
                count(*) FILTER (WHERE status = 'error')::int AS errors
           FROM ai_usage
          WHERE (created_at AT TIME ZONE $1)::date >= $2
          GROUP BY feature ORDER BY tokens DESC, feature`,
        [TIMEZONE, from]
      ),
      db.many(
        `SELECT au.user_id, u.name, u.email,
                coalesce(sum(au.total_tokens), 0)::int AS tokens,
                count(*)::int AS requests
           FROM ai_usage au
           JOIN users u ON u.id = au.user_id
          WHERE (au.created_at AT TIME ZONE $1)::date >= $2
          GROUP BY au.user_id, u.name, u.email
          ORDER BY tokens DESC, requests DESC
          LIMIT $3`,
        [TIMEZONE, from, TOP_USERS_LIMIT]
      ),
      ai.monthUsage().catch(() => ({ tokens: 0, requests: 0 })),
    ]);

    const byDayMap = new Map(byDay.map((row) => [row.date, row]));
    const series = eachDay(from, to).map((date) => {
      const row = byDayMap.get(date);
      return {
        date,
        tokens: row ? row.tokens : 0,
        requests: row ? row.requests : 0,
        errors: row ? row.errors : 0,
      };
    });

    const limit = await ai.monthlyLimit();
    res.json({
      days,
      from,
      to,
      totals,
      by_day: series,
      by_feature: byFeature,
      top_users: topUsers,
      month_tokens: monthly.tokens,
      month_requests: monthly.requests,
      limit,
      limit_reached: limit > 0 && monthly.tokens >= limit,
    });
  })
);

module.exports = { basePath: '/api/admin/ai', router };

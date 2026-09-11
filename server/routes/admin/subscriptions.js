'use strict';

/**
 * Painel administrativo — assinaturas (somente leitura; a escrita vem dos webhooks do provedor).
 *
 *   GET /api/admin/subscriptions          lista paginada (q, status, plan_id, sort, dir)
 *   GET /api/admin/subscriptions/summary  { total, active, trialing, past_due, canceled, other, mrr_cents }
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');

const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'];

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(STATUSES).optional(),
  plan_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SORT_COLUMNS = {
  created_at: 's.created_at',
  current_period_end: 's.current_period_end',
  status: 's.status',
  user_name: 'u.name',
  plan_name: 'p.name',
};

const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

router.get(
  '/summary',
  wrap(async (req, res) => {
    const row = await db.one(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE s.status = 'active') AS active,
              count(*) FILTER (WHERE s.status = 'trialing') AS trialing,
              count(*) FILTER (WHERE s.status = 'past_due') AS past_due,
              count(*) FILTER (WHERE s.status = 'canceled') AS canceled,
              count(*) FILTER (WHERE s.status NOT IN ('active','trialing','past_due','canceled')) AS other,
              coalesce(sum(
                CASE WHEN s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now())
                     THEN CASE WHEN p.interval = 'year' THEN p.price_cents / (12.0 * greatest(p.interval_count, 1))
                               ELSE p.price_cents / greatest(p.interval_count, 1)::numeric END
                     ELSE 0 END), 0) AS mrr_cents
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id`
    );
    res.json({ ...row, mrr_cents: Math.round(Number(row.mrr_cents) || 0) });
  })
);

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
      where.push(`(lower(fe_unaccent(u.name)) LIKE fe_unaccent(${p}) OR lower(u.email) LIKE ${p} OR s.provider_subscription_id LIKE ${p})`);
    }
    if (query.status) where.push(`s.status = ${add(query.status)}`);
    if (query.plan_id) where.push(`s.plan_id = ${add(query.plan_id)}`);

    const fromSql = `
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN plans p ON p.id = s.plan_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

    const countParams = params.slice();
    const itemsSql = `
      SELECT s.id, s.user_id, u.name AS user_name, u.email AS user_email, u.status AS user_status,
             s.plan_id, p.name AS plan_name, p.slug AS plan_slug, p.interval AS plan_interval, p.interval_count AS plan_interval_count,
             p.price_cents AS plan_price_cents, p.currency AS plan_currency,
             s.status, s.provider, s.provider_subscription_id, s.provider_customer_id, s.payment_method,
             s.current_period_start, s.current_period_end,
             s.cancel_at_period_end, s.canceled_at, s.created_at, s.updated_at,
             (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now())) AS is_active
      ${fromSql}
      ORDER BY ${sort.sql} NULLS LAST, s.created_at DESC
      LIMIT ${add(limit)} OFFSET ${add(offset)}`;

    const [countRow, items] = await Promise.all([
      db.one(`SELECT count(*) AS total ${fromSql}`, countParams),
      db.many(itemsSql, params),
    ]);
    res.json(paginate(items, countRow ? countRow.total : 0, { page, limit }));
  })
);

module.exports = { basePath: '/api/admin/subscriptions', router };

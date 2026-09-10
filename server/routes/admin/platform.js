'use strict';

/**
 * Painel administrativo — saúde da plataforma, erros e auditoria.
 *
 *   GET /api/admin/platform/health  { uptime, node_version, app_version, db: { ok, size_pretty, latency_ms },
 *                                     memory_mb, counts }
 *   GET /api/admin/platform/errors  erros registrados (paginado; filtros q, level, from, to)
 *   GET /api/admin/platform/audit   ações administrativas (paginado; filtros q, action, entity, admin_id, from, to)
 *
 * Somente leitura: nada aqui altera dados. Os registros vêm de error_logs (gravado pelo
 * errorHandler) e de audit_logs (gravado por middleware/audit em toda escrita administrativa).
 */
const router = require('express').Router();
const os = require('node:os');
const config = require('../../config');
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const { parsePagination, paginate } = require('../../utils/pagination');

const emptyToUndefined = (value) => (value === '' ? undefined : value);

const logsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  level: z.preprocess(emptyToUndefined, z.string().trim().max(20).optional()),
  from: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  to: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const auditQuery = z.object({
  q: z.string().trim().max(200).optional(),
  action: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  entity: z.preprocess(emptyToUndefined, z.string().trim().max(60).optional()),
  admin_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  entity_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  from: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  to: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const mb = (bytes) => Math.round((Number(bytes) || 0) / 1024 / 102.4) / 10;

router.get(
  '/health',
  wrap(async (req, res) => {
    const startedAt = Date.now();
    let dbOk = true;
    let size = null;
    try {
      const row = await db.one('SELECT pg_size_pretty(pg_database_size(current_database())) AS size, version() AS version');
      size = row;
    } catch (err) {
      dbOk = false;
      console.error('[admin/platform] banco indisponível:', err.message);
    }
    const latency = Date.now() - startedAt;

    let counts = null;
    if (dbOk) {
      counts = await db.one(
        `SELECT (SELECT count(*) FROM users WHERE role = 'student')::int AS students,
                (SELECT count(*) FROM users WHERE role = 'student' AND status = 'active')::int AS students_active,
                (SELECT count(*) FROM users WHERE role = 'admin')::int AS admins,
                (SELECT count(*) FROM exams)::int AS exams,
                (SELECT count(*) FROM subjects)::int AS subjects,
                (SELECT count(*) FROM topics)::int AS topics,
                (SELECT count(*) FROM lessons)::int AS lessons,
                (SELECT count(*) FROM questions)::int AS questions,
                (SELECT count(*) FROM simulados)::int AS simulados,
                (SELECT count(*) FROM simulado_attempts)::int AS simulado_attempts,
                (SELECT count(*) FROM essays)::int AS essays,
                (SELECT count(*) FROM past_exams)::int AS past_exams,
                (SELECT count(*) FROM teachers)::int AS teachers,
                (SELECT count(*) FROM bookings WHERE status IN ('pending','confirmed'))::int AS bookings_active,
                (SELECT count(*) FROM subscriptions
                  WHERE status IN ('active','trialing')
                    AND (current_period_end IS NULL OR current_period_end > now()))::int AS subscriptions_active,
                (SELECT count(*) FROM error_logs WHERE created_at >= now() - interval '24 hours')::int AS errors_24h,
                (SELECT count(*) FROM audit_logs WHERE created_at >= now() - interval '24 hours')::int AS audit_24h`
      );
    }

    const memory = process.memoryUsage();
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      uptime: Math.round(process.uptime()),
      node_version: process.version,
      app_version: config.version,
      env: config.env,
      platform: `${os.type()} ${os.release()}`,
      db: {
        ok: dbOk,
        size_pretty: size ? size.size : null,
        server_version: size ? String(size.version).split(' ').slice(0, 2).join(' ') : null,
        latency_ms: latency,
      },
      memory_mb: { rss: mb(memory.rss), heap_used: mb(memory.heapUsed), heap_total: mb(memory.heapTotal) },
      counts,
      time: new Date().toISOString(),
    });
  })
);

router.get(
  '/errors',
  validate({ query: logsQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 25, maxLimit: 100 });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(el.message ILIKE ${like} OR el.path ILIKE ${like})`);
    }
    if (query.level) clauses.push(`el.level = ${push(query.level)}`);
    if (query.from) clauses.push(`el.created_at >= ${push(query.from)}::timestamptz`);
    if (query.to) clauses.push(`el.created_at < (${push(query.to)}::timestamptz + interval '1 day')`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [totalRow, items] = await Promise.all([
      db.one(`SELECT count(*)::int AS total FROM error_logs el ${where}`, params),
      db.many(
        `SELECT el.id, el.level, el.message, el.stack, el.path, el.method, el.user_id, u.name AS user_name, el.created_at
           FROM error_logs el
           LEFT JOIN users u ON u.id = el.user_id
           ${where}
          ORDER BY el.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginate(items, totalRow.total, { page, limit }));
  })
);

router.get(
  '/audit',
  validate({ query: auditQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 25, maxLimit: 100 });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(al.action ILIKE ${like} OR fe_unaccent(u.name) ILIKE fe_unaccent(${like}) OR al.entity ILIKE ${like})`);
    }
    if (query.action) clauses.push(`al.action = ${push(query.action)}`);
    if (query.entity) clauses.push(`al.entity = ${push(query.entity)}`);
    if (query.admin_id) clauses.push(`al.admin_id = ${push(query.admin_id)}`);
    if (query.entity_id) clauses.push(`al.entity_id = ${push(query.entity_id)}`);
    if (query.from) clauses.push(`al.created_at >= ${push(query.from)}::timestamptz`);
    if (query.to) clauses.push(`al.created_at < (${push(query.to)}::timestamptz + interval '1 day')`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [totalRow, items, actions] = await Promise.all([
      db.one(`SELECT count(*)::int AS total FROM audit_logs al LEFT JOIN users u ON u.id = al.admin_id ${where}`, params),
      db.many(
        `SELECT al.id, al.admin_id, u.name AS admin_name, u.email AS admin_email,
                al.action, al.entity, al.entity_id, al.data, al.ip, al.created_at
           FROM audit_logs al
           LEFT JOIN users u ON u.id = al.admin_id
           ${where}
          ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.many('SELECT DISTINCT action FROM audit_logs ORDER BY action'),
    ]);
    res.json({ ...paginate(items, totalRow.total, { page, limit }), actions: actions.map((row) => row.action) });
  })
);

module.exports = { basePath: '/api/admin/platform', router };

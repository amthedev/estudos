'use strict';

/**
 * Painel administrativo — assinaturas (somente leitura; a escrita vem dos webhooks do provedor).
 *
 *   GET  /api/admin/subscriptions            lista paginada (q, status, plan_id, sort, dir)
 *   GET  /api/admin/subscriptions/summary    { total, active, trialing, past_due, canceled, other, mrr_cents }
 *   GET  /api/admin/subscriptions/pendentes  pagamentos recebidos que não viraram acesso
 *   POST /api/admin/subscriptions/reprocessar reprocessa esses pagamentos
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { wrap } = require('../../middleware/errors');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { audit } = require('../../middleware/audit');
const payments = require('../../services/payments');

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

/**
 * Pagamentos que o provedor entregou e que não viraram acesso.
 *
 * O corpo de todo evento fica guardado em payment_events, inclusive os que o
 * processamento descartou — foi o que salvou um Pix pago em produção que não
 * liberou o plano. Reprocessar passa esses eventos pelo código atual.
 *
 * Fica no painel porque a hospedagem não dá terminal: sem isso, recuperar um
 * pagamento perdido dependeria de acesso ao banco.
 */
const TIPOS_DE_PAGAMENTO = ['CHECKOUT_PAID', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];

async function pagamentosSemAcesso(dias = 30) {
  return db.many(
    `SELECT e.id, e.event_id, e.type, e.payload, e.processed_at
       FROM payment_events e
      WHERE e.provider = 'asaas'
        AND e.type = ANY($1::text[])
        AND e.processed_at > now() - ($2 || ' days')::interval
      ORDER BY e.processed_at DESC`,
    [TIPOS_DE_PAGAMENTO, String(dias)]
  );
}

/** Alunos com assinatura valendo agora. */
async function comAcesso() {
  const linhas = await db.many(
    `SELECT user_id FROM subscriptions
      WHERE status IN ('active','trialing')
        AND (current_period_end IS NULL OR current_period_end > now())`
  );
  return new Set(linhas.map((linha) => linha.user_id));
}

router.get(
  '/pendentes',
  validate({ query: z.object({ dias: z.coerce.number().int().min(1).max(365).optional() }) }),
  wrap(async (req, res) => {
    const dias = req.valid.query.dias || 30;
    const eventos = await pagamentosSemAcesso(dias);
    const liberados = await comAcesso();

    // O aluno de cada evento vem do checkout, que guarda quem abriu.
    const checkouts = await db.many(
      `SELECT c.provider_checkout_id, c.user_id, c.payment_method, u.name, u.email
         FROM payment_checkouts c JOIN users u ON u.id = c.user_id
        WHERE c.provider = 'asaas'`
    );
    const porCheckout = new Map(checkouts.map((c) => [c.provider_checkout_id, c]));

    const itens = eventos.map((evento) => {
      const carga = evento.payload || {};
      const checkoutId = carga.checkout && carga.checkout.id;
      const dono = checkoutId ? porCheckout.get(checkoutId) : null;
      return {
        event_id: evento.event_id,
        type: evento.type,
        recebido_em: evento.processed_at,
        aluno: dono ? { name: dono.name, email: dono.email } : null,
        payment_method: dono ? dono.payment_method : null,
        com_acesso: dono ? liberados.has(dono.user_id) : null,
      };
    });

    res.json({
      dias,
      total: itens.length,
      sem_acesso: itens.filter((item) => item.com_acesso === false).length,
      items: itens,
    });
  })
);

router.post(
  '/reprocessar',
  validate({ body: z.object({ dias: z.coerce.number().int().min(1).max(365).optional() }) }),
  wrap(async (req, res) => {
    const dias = req.valid.body.dias || 30;
    const eventos = await pagamentosSemAcesso(dias);
    const antes = await comAcesso();

    const erros = [];
    let reprocessados = 0;
    for (const evento of eventos) {
      try {
        // Reprocessar é seguro: o crédito de cada cobrança é travado por
        // subscriptions.last_payment_id, então não soma período nem duplica.
        await db.tx(async (tx) => {
          const payload = { provider: 'asaas', event_id: evento.event_id, type: evento.type, payload: evento.payload };
          if (evento.type.startsWith('CHECKOUT_')) await payments.applyAsaasCheckoutEvent(tx, payload);
          else await payments.applyAsaasEvent(tx, payload);
        });
        reprocessados += 1;
      } catch (err) {
        erros.push({ event_id: evento.event_id, message: err.message });
      }
    }

    const depois = await comAcesso();
    const novos = [...depois].filter((id) => !antes.has(id));
    const liberados = novos.length
      ? await db.many('SELECT name, email FROM users WHERE id = ANY($1::uuid[])', [novos])
      : [];

    await audit(req, 'subscription.reprocess', 'subscription', null, {
      dias,
      eventos: eventos.length,
      reprocessados,
      liberados: liberados.length,
    });

    res.json({
      ok: true,
      eventos: eventos.length,
      reprocessados,
      erros,
      liberados,
      message: liberados.length
        ? `${liberados.length} aluno(s) passaram a ter acesso.`
        : 'Nenhum aluno novo liberado — os pagamentos já estavam em dia.',
    });
  })
);

module.exports = { basePath: '/api/admin/subscriptions', router };

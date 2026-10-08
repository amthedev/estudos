'use strict';

/**
 * Painel de vendas e marketing — só com dados do nosso banco.
 *
 *   GET /api/admin/analytics?period=30 → {
 *     period, cards: { receita, vendas, cadastros, assinantes_ativos, ticket_medio,
 *                      conversao } cada um { value, prev, delta },
 *     series: { por_dia: [{ date, receita_cents, vendas }] },
 *     por_plano: [{ plan_id, name, vendas, receita_cents }],
 *     por_metodo: [{ metodo, vendas, receita_cents }],
 *     origem: [{ fonte, campanha, cadastros, vendas, receita_cents }],
 *     funil: { cadastros, checkouts, vendas },
 *     ultimas_vendas: [{ nome, email, plano, valor_cents, metodo, fonte, pago_em }]
 *   }
 *   GET /api/admin/analytics/export?period=30&type=origem|vendas → CSV (download)
 *
 * De onde vêm os números (nada sai do banco para fora daqui):
 *   - Venda = assinatura com last_payment_at no período (pagamento de verdade,
 *     não checkout aberto). Receita = soma de plans.price_cents dessas vendas.
 *   - Origem = users.tracking->>'utm_source' / 'utm_campaign' (gravado no cadastro).
 *     Quem veio sem UTM aparece como "Direto / orgânico".
 *   - Comparação = os mesmos agregados na janela anterior de igual tamanho.
 *
 * Nada de custo de anúncio, ROAS ou cliques: isso vive na Utmify e no Meta, que
 * têm os próprios painéis. Aqui é o que o nosso banco sabe.
 *
 * Datas no fuso America/Sao_Paulo (utils/dates).
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { wrap } = require('../../middleware/errors');
const { validate, z } = require('../../middleware/validate');
const { TIMEZONE, todayISO, addDays, eachDay } = require('../../utils/dates');

const PERIODOS = [7, 30, 90];
const ULTIMAS_LIMIT = 50;
const SEM_ORIGEM = 'Direto / orgânico';

const querySchema = z.object({
  period: z.preprocess((v) => Number.parseInt(v, 10), z.number().int().refine((n) => PERIODOS.includes(n), 'Período inválido.')).optional(),
});
const exportQuery = querySchema.extend({
  type: z.enum(['origem', 'vendas']).optional(),
});

/** Preenche a série diária com zeros nos dias sem registro. */
function fillSeries(days, rows) {
  const map = new Map(rows.map((r) => [r.date, r]));
  return days.map((date) => {
    const row = map.get(date);
    return {
      date,
      receita_cents: row ? Number(row.receita_cents) || 0 : 0,
      vendas: row ? Number(row.vendas) || 0 : 0,
    };
  });
}

/** Delta percentual entre valor atual e anterior; null quando a base é zero. */
function delta(atual, anterior) {
  const a = Number(atual) || 0;
  const b = Number(anterior) || 0;
  if (b === 0) return null;
  return Math.round(((a - b) / b) * 1000) / 10; // uma casa decimal
}

/**
 * Agrega os números-chave de uma janela [de, ate). Uma venda é uma assinatura
 * cujo last_payment_at caiu na janela; a receita é o preço do plano dela.
 */
async function janela(de, ate) {
  const row = await db.one(
    `WITH vendas AS (
       SELECT s.id, s.plan_id, p.price_cents
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.last_payment_at >= $1 AND s.last_payment_at < $2
     ),
     cadastros AS (
       SELECT id FROM users
        WHERE role = 'student' AND created_at >= $1 AND created_at < $2
     )
     SELECT
       (SELECT count(*) FROM vendas) AS vendas,
       (SELECT coalesce(sum(price_cents), 0) FROM vendas) AS receita_cents,
       (SELECT count(*) FROM cadastros) AS cadastros`,
    [de, ate]
  );
  return {
    vendas: Number(row.vendas) || 0,
    receita_cents: Number(row.receita_cents) || 0,
    cadastros: Number(row.cadastros) || 0,
  };
}

/** Monta o payload inteiro do painel para um período em dias. */
async function montar(periodDays) {
  const today = todayISO();
  // janela atual: [inicio, amanhã) para incluir hoje; anterior de igual tamanho
  const inicio = addDays(today, -(periodDays - 1));
  const fimExcl = addDays(today, 1);
  const inicioAnterior = addDays(inicio, -periodDays);

  const [atual, anterior, assinantesAtivos, serie, porPlano, porMetodo, origem, checkouts, ultimas] = await Promise.all([
    janela(inicio, fimExcl),
    janela(inicioAnterior, inicio),
    db.one(
      `SELECT count(*) AS n FROM subscriptions
        WHERE status IN ('active','trialing')
          AND (current_period_end IS NULL OR current_period_end > now())`
    ),
    db.many(
      `SELECT (s.last_payment_at AT TIME ZONE $1)::date AS date,
              count(*) AS vendas,
              coalesce(sum(p.price_cents), 0) AS receita_cents
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE (s.last_payment_at AT TIME ZONE $1)::date >= $2
        GROUP BY 1`,
      [TIMEZONE, inicio]
    ),
    db.many(
      `SELECT s.plan_id, coalesce(p.name, 'Plano removido') AS name,
              count(*) AS vendas, coalesce(sum(p.price_cents), 0) AS receita_cents
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.last_payment_at >= $1 AND s.last_payment_at < $2
        GROUP BY s.plan_id, p.name
        ORDER BY receita_cents DESC`,
      [inicio, fimExcl]
    ),
    db.many(
      `SELECT coalesce(s.payment_method, 'desconhecido') AS metodo,
              count(*) AS vendas, coalesce(sum(p.price_cents), 0) AS receita_cents
         FROM subscriptions s
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.last_payment_at >= $1 AND s.last_payment_at < $2
        GROUP BY s.payment_method
        ORDER BY vendas DESC`,
      [inicio, fimExcl]
    ),
    // Origem: cadastros do período agrupados por utm_source + campanha, com
    // quantas viraram venda (assinatura com pagamento) e a receita.
    db.many(
      `SELECT
         coalesce(nullif(u.tracking->>'utm_source', ''), $3) AS fonte,
         coalesce(nullif(u.tracking->>'utm_campaign', ''), '') AS campanha,
         count(*) AS cadastros,
         count(*) FILTER (WHERE v.user_id IS NOT NULL) AS vendas,
         coalesce(sum(v.price_cents) FILTER (WHERE v.user_id IS NOT NULL), 0) AS receita_cents
       FROM users u
       LEFT JOIN LATERAL (
         SELECT s.user_id, p.price_cents
           FROM subscriptions s
           LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = u.id AND s.last_payment_at IS NOT NULL
          ORDER BY s.last_payment_at DESC
          LIMIT 1
       ) v ON true
      WHERE u.role = 'student' AND u.created_at >= $1 AND u.created_at < $2
      GROUP BY 1, 2
      ORDER BY receita_cents DESC, cadastros DESC`,
      [inicio, fimExcl, SEM_ORIGEM]
    ),
    db.one(
      `SELECT count(*) AS n FROM payment_checkouts
        WHERE created_at >= $1 AND created_at < $2`,
      [inicio, fimExcl]
    ),
    db.many(
      `SELECT u.name AS nome, u.email, coalesce(p.name, 'Plano removido') AS plano,
              coalesce(p.price_cents, 0) AS valor_cents,
              coalesce(s.payment_method, 'desconhecido') AS metodo,
              coalesce(nullif(u.tracking->>'utm_source', ''), $3) AS fonte,
              s.last_payment_at AS pago_em
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.last_payment_at >= $1 AND s.last_payment_at < $2
        ORDER BY s.last_payment_at DESC
        LIMIT $4`,
      [inicio, fimExcl, SEM_ORIGEM, ULTIMAS_LIMIT]
    ),
  ]);

  const ticket = atual.vendas > 0 ? Math.round(atual.receita_cents / atual.vendas) : 0;
  const ticketPrev = anterior.vendas > 0 ? Math.round(anterior.receita_cents / anterior.vendas) : 0;
  const conversao = atual.cadastros > 0 ? Math.round((atual.vendas / atual.cadastros) * 1000) / 10 : 0;
  const conversaoPrev = anterior.cadastros > 0 ? Math.round((anterior.vendas / anterior.cadastros) * 1000) / 10 : 0;

  const days = eachDay(inicio, today);
  return {
    period: periodDays,
    cards: {
      receita: { value: atual.receita_cents, prev: anterior.receita_cents, delta: delta(atual.receita_cents, anterior.receita_cents) },
      vendas: { value: atual.vendas, prev: anterior.vendas, delta: delta(atual.vendas, anterior.vendas) },
      cadastros: { value: atual.cadastros, prev: anterior.cadastros, delta: delta(atual.cadastros, anterior.cadastros) },
      assinantes_ativos: { value: Number(assinantesAtivos.n) || 0, prev: null, delta: null },
      ticket_medio: { value: ticket, prev: ticketPrev, delta: delta(ticket, ticketPrev) },
      conversao: { value: conversao, prev: conversaoPrev, delta: delta(conversao, conversaoPrev) },
    },
    series: { por_dia: fillSeries(days, serie) },
    por_plano: porPlano.map((r) => ({ plan_id: r.plan_id, name: r.name, vendas: Number(r.vendas) || 0, receita_cents: Number(r.receita_cents) || 0 })),
    por_metodo: porMetodo.map((r) => ({ metodo: r.metodo, vendas: Number(r.vendas) || 0, receita_cents: Number(r.receita_cents) || 0 })),
    origem: origem.map((r) => ({
      fonte: r.fonte,
      campanha: r.campanha,
      cadastros: Number(r.cadastros) || 0,
      vendas: Number(r.vendas) || 0,
      receita_cents: Number(r.receita_cents) || 0,
    })),
    funil: { cadastros: atual.cadastros, checkouts: Number(checkouts.n) || 0, vendas: atual.vendas },
    ultimas_vendas: ultimas.map((r) => ({
      nome: r.nome,
      email: r.email,
      plano: r.plano,
      valor_cents: Number(r.valor_cents) || 0,
      metodo: r.metodo,
      fonte: r.fonte,
      pago_em: r.pago_em,
    })),
  };
}

/** Escapa um campo para CSV (aspas, vírgula, quebra de linha). */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvFrom(header, rows) {
  // BOM para o Excel abrir acentuação certa; separador ';' (padrão BR).
  const linhas = [header.join(';'), ...rows.map((r) => r.map(csvCell).join(';'))];
  return `﻿${linhas.join('\r\n')}\r\n`;
}

/** Centavos → "1234,56" para o CSV (vírgula decimal, padrão BR). */
const reais = (cents) => ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',');

router.get(
  '/',
  validate({ query: querySchema }),
  wrap(async (req, res) => {
    const period = PERIODOS.includes(req.valid.query.period) ? req.valid.query.period : 30;
    res.json(await montar(period));
  })
);

router.get(
  '/export',
  validate({ query: exportQuery }),
  wrap(async (req, res) => {
    const period = PERIODOS.includes(req.valid.query.period) ? req.valid.query.period : 30;
    const type = req.valid.query.type || 'origem';
    const data = await montar(period);

    let nome;
    let csv;
    if (type === 'vendas') {
      nome = `vendas-${period}d.csv`;
      csv = csvFrom(
        ['Aluno', 'E-mail', 'Plano', 'Valor (R$)', 'Método', 'Origem', 'Pago em'],
        data.ultimas_vendas.map((v) => [v.nome, v.email, v.plano, reais(v.valor_cents), v.metodo, v.fonte, v.pago_em ? new Date(v.pago_em).toISOString() : ''])
      );
    } else {
      nome = `origem-${period}d.csv`;
      csv = csvFrom(
        ['Fonte', 'Campanha', 'Cadastros', 'Vendas', 'Receita (R$)'],
        data.origem.map((o) => [o.fonte, o.campanha, o.cadastros, o.vendas, reais(o.receita_cents)])
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(csv);
  })
);

module.exports = { basePath: '/api/admin/analytics', router };

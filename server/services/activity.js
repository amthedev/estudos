'use strict';

/**
 * Avisos de atividade real na página inicial (prova social).
 *
 *   const activity = require('../services/activity');
 *   await activity.recentActivity();
 *   // → [{ first_name, exam_short_name, kind: 'subscribed'|'upgraded', tier, tier_label, at }]
 *
 * Só entram dois fatos, e só quando aconteceram de verdade:
 *
 *   - "assinou": assinatura que já teve pagamento confirmado (last_payment_at
 *     preenchido) e segue vigente (active ou past_due). O momento é o
 *     created_at da assinatura, e não o last_payment_at, por dois motivos:
 *     o last_payment_at anda a cada renovação (e renovação não é "assinou"),
 *     e o Asaas manda a data do pagamento sem hora — ela é gravada como
 *     meio-dia UTC, que pode estar horas antes ou depois do pagamento. O
 *     created_at é o now() do banco no momento em que a compra criou a linha
 *     (SUBSCRIPTION_CREATED no cartão, pagamento do Pix) e a renovação não
 *     mexe nele. No cartão com teste de 24h ele marca a hora em que o aluno
 *     assinou; o aviso só existe depois que a primeira cobrança foi paga.
 *     O nível é o do plano COMPRADO: depois de um upgrade a assinatura guarda
 *     só o plano novo, então vale o plano de origem do primeiro upgrade
 *     aplicado. Plano antigo (sem nível) sai com tier nulo, e a landing
 *     escreve "assinou a <marca>".
 *
 *     A linha só vira aviso quando o created_at e o plano ainda contam a
 *     história da PRIMEIRA compra do aluno. Fica de fora:
 *       · quem já tinha outra assinatura paga antes desta. O inadimplente do
 *         cartão que volta pelo Pix e quem cancela e volta ganham uma linha
 *         nova, mas estão continuando, não assinando;
 *       · a linha que nasceu longe da compra. O checkout expira em 60 minutos,
 *         então a compra ao vivo cria a linha logo depois de o aluno abrir o
 *         checkout. Quando o pagamento é reprocessado pelo painel (ou o
 *         webhook chega dias depois), a linha nasce na hora do reprocesso, e
 *         o aviso diria "há menos de 1 hora" de uma compra de dias atrás;
 *       · o Pix avulso reaproveitado. Ele usa a mesma linha a cada compra
 *         (recompra depois do fim do período, recompra depois de um estorno)
 *         e troca o plano, mas mantém o created_at da primeira. Aí a data
 *         seria de uma compra e o nível de outra. A linha só vale enquanto o
 *         período em curso é o da compra que a criou e não houve cancelamento
 *         antes dele.
 *     Um aviso a menos, nunca um errado.
 *
 *   - "subiu para o <nível>": pedido de upgrade pago E aplicado (applied_at),
 *     no momento em que o plano foi trocado. Pago sem troca (o suporte ainda
 *     vai decidir) e estornado não entram, nem o de assinatura que já foi
 *     cancelada ou estornada. O pagamento da diferença também passa pelo
 *     reprocessamento do painel, e lá o applied_at vira a hora do reprocesso:
 *     troca aplicada muito depois da data do pagamento fica de fora.
 *
 * Fica sempre de fora: a equipe (role admin), conta bloqueada, quem está com
 * liberação manual em vigor (cortesia), teste de 24h não pago, compra
 * pendente (checkout aberto, assinatura incomplete) e quem desligou os
 * avisos no perfil (users.show_in_activity).
 *
 * Privacidade: sai só o primeiro nome, a prova que a pessoa estuda, o nível e
 * a hora cheia (nunca o minuto). Nada de sobrenome, e-mail, id ou valor. Nome
 * que não parece nome — vazio, uma letra só, com número, com @ ou com
 * símbolo — descarta o aviso inteiro; não se completa com outra coisa.
 *
 * Nada é inventado, repetido ou reordenado: a lista sai do banco, do mais
 * recente para o mais antigo, com no máximo MAX_ITEMS avisos. Com menos avisos
 * reais do que o mínimo configurado (activity_feed_min_events), a lista volta
 * vazia e a landing não mostra o balão.
 */
const db = require('../db/pool');
const settings = require('./settings');
const coins = require('./coins');

/** Máximo de avisos devolvidos para a página. */
const MAX_ITEMS = 20;
/** Linhas lidas do banco: sobra para os avisos descartados pelo nome. */
const FETCH_LIMIT = 100;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Do checkout aberto até a linha da assinatura nascer, na compra ao vivo. O
 * checkout expira em 60 minutos; o resto é folga para o atraso do webhook.
 */
const CHECKOUT_TO_PURCHASE_HOURS = 3;
/**
 * Folga para comparar com a data de pagamento do Asaas, que chega sem hora e
 * é gravada como meio-dia UTC: pode cair horas antes ou depois do pagamento.
 */
const PAYMENT_DATE_SLACK_HOURS = 24;

const DAYS_RANGE = { min: 1, max: 90, fallback: 14 };
const MIN_EVENTS_RANGE = { min: 1, max: MAX_ITEMS, fallback: 3 };

/** Inteiro dentro da faixa; valor inválido cai no padrão. */
function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Primeiro nome para exibir, ou null quando o nome não serve para o aviso.
 * "ana souza" → "Ana"; "ANA-CLARA" → "Ana-Clara"; "a", "joao123", "x@y" → null.
 */
function firstNameOf(fullName) {
  const token = String(fullName || '').normalize('NFC').trim().split(/\s+/)[0] || '';
  if (!token || token.length > 30) return null;
  if (/\d/.test(token) || token.includes('@')) return null;
  const letters = token.match(/\p{L}/gu) || [];
  if (letters.length < 2) return null;
  // Só letras, com hífen ou apóstrofo entre elas (Ana-Clara, D'Ávila). Símbolo
  // solto ("_bia_", "ana.") é apelido ou dado torto: melhor não mostrar.
  if (!/^\p{L}+(?:['’-]\p{L}+)*$/u.test(token)) return null;
  return token
    .split('-')
    .map((part) => part.charAt(0).toLocaleUpperCase('pt-BR') + part.slice(1).toLocaleLowerCase('pt-BR'))
    .join('-');
}

/** Momento arredondado para baixo, na hora cheia (ISO). O minuto exato não sai daqui. */
function toHour(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
}

/** Configuração dos avisos, já validada. */
async function feedSettings() {
  const values = await settings.getMany(['activity_feed_enabled', 'activity_feed_days', 'activity_feed_min_events']);
  return {
    enabled: values.activity_feed_enabled !== false,
    days: clampInt(values.activity_feed_days, DAYS_RANGE),
    minEvents: clampInt(values.activity_feed_min_events, MIN_EVENTS_RANGE),
  };
}

/** Compras pagas e upgrades aplicados da janela, do mais recente para o mais antigo. */
async function loadRows(days) {
  return db.many(
    `WITH compras AS (
       -- A primeira compra paga de cada aluno, e só se a linha ainda conta a
       -- história dela (ver o cabeçalho). Duas na mesma hora: vale uma.
       SELECT DISTINCT ON (s.user_id)
              s.user_id,
              'subscribed'::text AS kind,
              COALESCE(
                (SELECT pc.from_plan_id
                   FROM plan_changes pc
                  WHERE pc.subscription_id = s.id AND pc.applied_at IS NOT NULL
                  ORDER BY pc.applied_at ASC
                  LIMIT 1),
                s.plan_id
              ) AS plan_id,
              s.created_at AS at
         FROM subscriptions s
        WHERE s.last_payment_at IS NOT NULL
          AND s.status IN ('active', 'past_due')
          AND s.created_at >= now() - make_interval(days => $1::int)
          AND s.created_at <= now()
          -- já pagou outra assinatura antes: é volta, não compra nova
          AND NOT EXISTS (
            SELECT 1
              FROM subscriptions s0
             WHERE s0.user_id = s.user_id
               AND s0.last_payment_at IS NOT NULL
               AND s0.created_at < s.created_at
          )
          -- a linha nasceu na hora da compra, logo depois do checkout
          AND EXISTS (
            SELECT 1
              FROM payment_checkouts ck
             WHERE ck.user_id = s.user_id
               AND ck.created_at <= s.created_at
               AND ck.created_at >= s.created_at - make_interval(hours => $3::int)
          )
          -- Pix avulso reaproveita a linha: o período em curso tem que ser o
          -- da compra que a criou, sem estorno ou cancelamento antes dele
          AND (
            s.provider_subscription_id IS NOT NULL
            OR (
              s.current_period_start <= s.created_at + make_interval(hours => $4::int)
              AND (s.canceled_at IS NULL OR s.canceled_at >= s.current_period_start)
            )
          )
        ORDER BY s.user_id, s.created_at ASC
     ),
     upgrades AS (
       SELECT pc.user_id,
              'upgraded'::text AS kind,
              pc.to_plan_id AS plan_id,
              pc.applied_at AS at
         FROM plan_changes pc
         LEFT JOIN subscriptions s ON s.id = pc.subscription_id
        WHERE pc.status = 'paid'
          AND pc.applied_at IS NOT NULL
          AND pc.applied_at >= now() - make_interval(days => $1::int)
          AND pc.applied_at <= now()
          -- aplicado na hora do pagamento, e não num reprocesso dias depois
          AND pc.paid_at IS NOT NULL
          AND pc.applied_at <= pc.paid_at + make_interval(hours => $4::int)
          AND (pc.subscription_id IS NULL OR s.status IN ('active', 'past_due'))
     ),
     eventos AS (
       SELECT user_id, kind, plan_id, at FROM compras
       UNION ALL
       SELECT user_id, kind, plan_id, at FROM upgrades
     )
     SELECT e.kind, e.at, p.tier, u.name, ex.short_name AS exam_short_name
       FROM eventos e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN plans p ON p.id = e.plan_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN exams ex ON ex.id = sp.exam_id AND ex.active
      WHERE u.role = 'student'
        AND u.status = 'active'
        AND u.show_in_activity
        AND (u.access_override_until IS NULL OR u.access_override_until <= now())
      ORDER BY e.at DESC
      LIMIT $2`,
    [days, FETCH_LIMIT, CHECKOUT_TO_PURCHASE_HOURS, PAYMENT_DATE_SLACK_HOURS]
  );
}

/**
 * Avisos prontos para a página inicial. Lista vazia quando os avisos estão
 * desligados ou quando não há avisos reais suficientes na janela.
 */
async function recentActivity() {
  const config = await feedSettings();
  if (!config.enabled) return [];

  const rows = await loadRows(config.days);
  const items = [];
  for (const row of rows) {
    const firstName = firstNameOf(row.name);
    if (!firstName) continue;
    const tier = coins.TIERS.includes(row.tier) ? row.tier : null;
    // "subiu para o ..." sem nível não diz nada: fica de fora
    if (row.kind === 'upgraded' && !tier) continue;
    const at = toHour(row.at);
    if (!at) continue;
    items.push({
      first_name: firstName,
      exam_short_name: row.exam_short_name || null,
      kind: row.kind,
      tier,
      tier_label: tier ? coins.TIER_LABELS[tier] : null,
      at,
    });
    if (items.length >= MAX_ITEMS) break;
  }

  return items.length >= config.minEvents ? items : [];
}

module.exports = { recentActivity, firstNameOf, toHour, MAX_ITEMS };

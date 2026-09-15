'use strict';

/**
 * Planos de assinatura. Preços em centavos (BRL).
 *
 * O Asaas recebe preço e ciclo no momento do checkout, sem catálogo externo de planos.
 *
 * Chave de idempotência: `slug`. Planos são "administráveis": o seed só cria os que
 * faltam; para sobrescrever preço e descrição use `node server/db/seed/run.js --force`.
 */
module.exports = [
  {
    slug: 'mensal',
    name: 'Mensal',
    description: 'Acesso completo à plataforma com cobrança mensal. Cancele quando quiser.',
    price_cents: 3990,
    currency: 'brl',
    interval: 'month',
    interval_count: 1,
    duration_months: 1,
    bonus_months: 0,
    // preço cheio, só para o "de" riscado na landing
    compare_price_cents: 4990,
    trial_days: 0,
    highlight: false,
    sort_order: 1,
    features: [
      'Acesso completo à plataforma',
      'Videoaulas, resumos e questões',
      'Simulados e cronograma personalizado',
      'Redação e acompanhamento de desempenho',
      'Cancele quando quiser',
    ],
  },
  {
    slug: 'seis-meses',
    name: '6 meses',
    description: 'Seis meses de acesso completo com economia em relação ao plano mensal.',
    price_cents: 20940,
    currency: 'brl',
    interval: 'month',
    interval_count: 6,
    duration_months: 6,
    bonus_months: 0,
    // 6 meses no plano mensal custariam R$ 299,40
    compare_price_cents: 29940,
    trial_days: 1,
    highlight: false,
    sort_order: 2,
    features: [
      '6 meses de acesso completo',
      'Economia de R$ 90,00 em relação ao mensal',
      'Tudo do plano Mensal',
      'Atualizações durante todo o período',
    ],
  },
  {
    slug: 'anual',
    name: '15 meses',
    description: 'Pague por 12 meses e receba mais 3 meses de acesso como bônus.',
    price_cents: 35880,
    currency: 'brl',
    interval: 'month',
    interval_count: 12,
    // paga 12 meses e recebe 15 de acesso
    duration_months: 12,
    bonus_months: 3,
    // 15 meses no plano mensal custariam R$ 748,50
    compare_price_cents: 74850,
    badge: 'Melhor oferta',
    trial_days: 1,
    highlight: true,
    sort_order: 3,
    features: [
      '3 meses de bônus',
      '15 meses de acesso completo',
      'Economia de R$ 389,70 em relação ao mensal',
      'Tudo do plano Mensal',
      'Atualizações durante todo o período',
    ],
  },
];

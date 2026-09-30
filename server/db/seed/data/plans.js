'use strict';

/**
 * Planos de assinatura. Preços em centavos (BRL).
 *
 * O Asaas recebe preço e ciclo no momento do checkout, sem catálogo externo de planos.
 *
 * Chave de idempotência: `slug`. Planos são "administráveis": o seed só cria os que
 * faltam; para sobrescrever preço e descrição use `node server/db/seed/run.js --force`.
 *
 * São três níveis (Básico, Pro, Avançado), cada um em três durações. O que muda
 * entre os níveis é quanto o aluno pode usar a IA: as moedas por dia e a cota
 * do Tutor. Esses números NÃO ficam aqui — vêm das configurações do painel
 * (coins_daily_<nível>, tutor_tokens_<nível>) e a vitrine mostra à parte. Assim
 * o suporte ajusta a quantidade sem que o texto do plano fique desatualizado.
 *
 * Os três planos antigos (mensal, seis-meses, anual) saíram deste arquivo, mas
 * continuam no banco de produção, desativados pela migration 218: há
 * assinaturas apontando para eles.
 */
const FEATURES = {
  basico: [
    'Videoaulas completas',
    'Banco de questões',
    'Provas anteriores',
    'Cronograma de estudos',
    'Acompanhamento de desempenho',
  ],
  pro: ['Tudo do Básico', 'Mais moedas por dia', 'Maior volume de treinamento', 'Mais tempo de Tutor IA'],
  avancado: [
    'Tudo do Pro',
    'O máximo de moedas por dia',
    'Preparação intensiva',
    'Acompanhamento completo do desempenho',
  ],
};

const DESCRICOES = {
  basico: 'O essencial para estudar com constância',
  pro: 'Mais treino com IA para quem quer acelerar',
  avancado: 'O máximo da plataforma para a reta final',
};

const DURACOES = {
  1: { sufixo: 'mensal', nome: 'Mensal', texto: 'com cobrança mensal. Cancele quando quiser.' },
  6: { sufixo: '6-meses', nome: '6 meses', texto: 'por seis meses, pagos de uma vez.' },
  12: { sufixo: '12-meses', nome: '12 meses', texto: 'por doze meses, pagos de uma vez.' },
};

/** Um plano da grade: nível × duração. */
function plano(tier, nomeDoNivel, duracao, { price_cents, compare_price_cents, sort_order, destaque = false }) {
  const d = DURACOES[duracao];
  return {
    slug: `${tier}-${d.sufixo}`,
    name: `${nomeDoNivel} ${d.nome}`,
    description: `${DESCRICOES[tier]}, ${d.texto}`,
    tier,
    price_cents,
    currency: 'brl',
    interval: 'month',
    interval_count: duracao,
    duration_months: duracao,
    bonus_months: 0,
    // preço cheio, só para o "de" riscado na vitrine
    compare_price_cents,
    // as 24 horas grátis só existem no cartão dos planos de 6 e 12 meses
    trial_days: duracao === 1 ? 0 : 1,
    highlight: destaque,
    badge: destaque ? 'Mais escolhido' : null,
    sort_order,
    features: FEATURES[tier],
  };
}

module.exports = [
  plano('basico', 'Básico', 1, { price_cents: 2990, compare_price_cents: 3990, sort_order: 11 }),
  plano('basico', 'Básico', 6, { price_cents: 15990, compare_price_cents: 23940, sort_order: 12 }),
  plano('basico', 'Básico', 12, { price_cents: 27990, compare_price_cents: 47880, sort_order: 13 }),

  plano('pro', 'Pro', 1, { price_cents: 4990, compare_price_cents: 5990, sort_order: 21, destaque: true }),
  plano('pro', 'Pro', 6, { price_cents: 26990, compare_price_cents: 35940, sort_order: 22, destaque: true }),
  plano('pro', 'Pro', 12, { price_cents: 44990, compare_price_cents: 71880, sort_order: 23, destaque: true }),

  plano('avancado', 'Avançado', 1, { price_cents: 6990, compare_price_cents: 7990, sort_order: 31 }),
  plano('avancado', 'Avançado', 6, { price_cents: 36990, compare_price_cents: 47940, sort_order: 32 }),
  plano('avancado', 'Avançado', 12, { price_cents: 59990, compare_price_cents: 95880, sort_order: 33 }),
];

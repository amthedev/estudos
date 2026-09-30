'use strict';

/**
 * Ajustes de dados que rodam UMA vez em produção (chamados por
 * scripts/bootstrap.js, cada um travado por uma flag em settings).
 *
 * O seed normal só cria o que falta: não reescreve pergunta frequente nem
 * plano que já existe, para não desfazer o que a equipe muda no painel. Quando
 * uma decisão do cliente precisa trocar dado que já está no ar, a troca mora
 * aqui. Depois que rodou em produção, o ajuste pode sair deste arquivo e do
 * bootstrap — a flag já garante que ele não roda de novo.
 */
const db = require('../pool');
const { faqs } = require('./data/landing');
const plans = require('./data/plans');

/**
 * Outubro/2026 — duas decisões do Guilherme:
 *
 *  1. O plano de 12 meses passa a dar 1 mês de bônus (13 meses de acesso). Os
 *     três planos de 12 meses (Básico, Pro, Avançado) recebem bonus_months,
 *     descrição e lista de recursos do arquivo de planos. Preço e o resto do
 *     plano ficam como estão no painel.
 *  2. As perguntas frequentes antigas (que ainda falavam do plano de 15 meses e
 *     não explicavam as moedas) dão lugar às novas: as que não estão na lista
 *     nova são desativadas — não apagadas, para dar para reativar no painel —,
 *     as que já existem com a mesma pergunta recebem a resposta e a ordem
 *     novas, e as que faltam são criadas.
 *
 * Rodar de novo não duplica nada: o resultado é o mesmo.
 */
async function faqEBonusOutubro2026() {
  return db.tx(async (client) => {
    const resumo = { planos: 0, perguntasDesativadas: 0, perguntasAtualizadas: 0, perguntasCriadas: 0 };

    for (const plan of plans.filter((item) => item.tier && Number(item.bonus_months) > 0)) {
      const res = await client.query(
        `UPDATE plans SET bonus_months = $2, description = $3, features = $4::jsonb WHERE slug = $1`,
        [plan.slug, plan.bonus_months, plan.description, JSON.stringify(plan.features)]
      );
      resumo.planos += res.rowCount;
    }

    const perguntas = faqs.map((faq) => faq.question);
    const desativadas = await client.query(
      `UPDATE faqs SET active = false WHERE active = true AND NOT (question = ANY($1::text[]))`,
      [perguntas]
    );
    resumo.perguntasDesativadas = desativadas.rowCount;

    for (const faq of faqs) {
      const existente = await client.query('SELECT id FROM faqs WHERE question = $1 ORDER BY created_at ASC LIMIT 1', [faq.question]);
      if (existente.rowCount) {
        await client.query('UPDATE faqs SET answer = $2, sort_order = $3, active = true WHERE id = $1', [
          existente.rows[0].id, faq.answer, faq.sort_order ?? 0,
        ]);
        resumo.perguntasAtualizadas += 1;
      } else {
        await client.query('INSERT INTO faqs (question, answer, sort_order, active) VALUES ($1, $2, $3, true)', [
          faq.question, faq.answer, faq.sort_order ?? 0,
        ]);
        resumo.perguntasCriadas += 1;
      }
    }
    return resumo;
  });
}

module.exports = { faqEBonusOutubro2026 };

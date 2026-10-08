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

/**
 * Fotos dos aprovados enviadas pelo painel (PNG de ~2,5 MB cada no Blob) →
 * cópia em JPEG leve servida pela própria aplicação, com miniatura em
 * /assets/results/aprovados/thumbs/. A chave é o nome do arquivo no Blob.
 */
const FOTOS_APROVADOS = {
  'Cadete_em_Patio_da_Acade_199685.png': 'aprovada-barro-branco-ana',
  'Celebracao_no_campus_da__b3eb84.png': 'aprovada-medicina-beatriz',
  'Patio_da_Academia_Barro__3ff2cf.png': 'aprovado-barro-branco-pedro',
  'Retrato_em_frente_a_Medi_2958a8.png': 'aprovado-medicina-lucas',
  'Cadete_em_Frente_a_Acade_b788bd.png': 'aprovado-barro-branco-roberto',
  'Estudante_celebra_na_ent_d1a753.png': 'aprovado-medicina-guilherme',
  'Celebracao_universitaria_3f1b68.png': 'aprovada-medicina-silvia',
  'Cadete_na_Academia_Barro_421e23.png': 'aprovado-barro-branco-gustavo',
  'Calouro_de_Medicina_na_U_4a75fe.png': 'aprovado-medicina-igor',
  'Selfie_na_Academia_Barro_9beddc.png': 'aprovado-barro-branco-kaique',
  'Selfie_de_Aprovacao_na_U_3dd8e4.png': 'aprovada-medicina-camila',
  'Cadete_em_frente_a_Acade_b4f22d.png': 'aprovado-barro-branco-thiago',
  'Retrato_na_Academia_Barr_af8653.png': 'aprovada-barro-branco-julia',
};

/**
 * Outubro/2026 — Resultados da página inicial, a pedido do Guilherme:
 *
 *  1. Saem os posts de Instagram de "Aprovados" (/assets/results/posts/) e os
 *     prints antigos de "Mensagens recebidas" (/assets/results/messages/). Os
 *     arquivos saíram do repositório, então as linhas são apagadas, não
 *     desativadas. Os prints novos entram pelo seed (/assets/results/conversas/).
 *  2. As fotos dos aprovados cadastradas pelo painel, que caíam em "Mensagens
 *     recebidas", passam a ser 'foto' (bloco Aprovados) e apontam para a cópia
 *     leve. Nome, papel e ordem ficam como estão no painel.
 *
 * Rodar de novo não muda nada.
 */
async function resultadosOutubro2026() {
  return db.tx(async (client) => {
    const removidos = await client.query(
      `DELETE FROM testimonials
        WHERE image_url LIKE '/assets/results/posts/%' OR image_url LIKE '/assets/results/messages/%'`
    );

    let fotos = 0;
    for (const [arquivo, nome] of Object.entries(FOTOS_APROVADOS)) {
      const res = await client.query(
        `UPDATE testimonials SET image_url = $2, kind = 'foto'
          WHERE image_url LIKE '%/depoimentos/' || $1`,
        [arquivo, `/assets/results/aprovados/${nome}.jpg`]
      );
      fotos += res.rowCount;
    }

    return { removidos: removidos.rowCount, fotos };
  });
}

module.exports = { faqEBonusOutubro2026, resultadosOutubro2026, FOTOS_APROVADOS };

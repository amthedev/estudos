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
const { resultConversations } = require('./data/curated_assets');

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
 *     desativadas.
 *  2. As fotos dos aprovados cadastradas pelo painel, que caíam em "Mensagens
 *     recebidas", passam a ser 'foto' (bloco Aprovados) e apontam para a cópia
 *     leve. Nome, papel e ordem ficam como estão no painel.
 *  3. Entram os 12 prints novos de "Mensagens recebidas" (resultConversations).
 *     Só aqui, não no seed: um print apagado no painel não volta no deploy.
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

    let prints = 0;
    for (const print of resultConversations) {
      const res = await client.query(
        `INSERT INTO testimonials (name, role, image_url, kind, rating, exam_id, sort_order, active)
         SELECT $1, $2, $3, 'conversa', 5, (SELECT id FROM exams WHERE slug = $4), $5, true
          WHERE NOT EXISTS (SELECT 1 FROM testimonials WHERE image_url = $3)`,
        [print.name, print.role, print.image_url, print.exam, print.sort_order]
      );
      prints += res.rowCount;
    }

    return { removidos: removidos.rowCount, fotos, prints };
  });
}

const BLOB = 'https://blob.squarecloud.dev/pub/0a9f7f1de21c92b5fe36d1006d36b96186874a93';

/**
 * Vídeos de depoimento que tinham sido enviados pelo painel e se perderam com o
 * banco antigo. Os arquivos continuam no Blob; voltam DESATIVADOS, para a
 * equipe conferir cada um no painel antes de pôr no ar.
 */
const VIDEOS_DEPOIMENTO_PAINEL = [
  'depoimentos/7428F54B_5C4C_407E_9FBF__d40135.mov',
  'depoimentos/VID_20261007111501262_1a7bad.mov',
  'depoimentos/IMG_7043_b56348.mov',
  'depoimentos/copy_C3C37E0F_AC67_4AE7__484e31.mov',
  'depoimentos/Edits_GUILHERME_D_20p_20_dceb83.mp4',
];

/** Provas da FUVEST enviadas pelo painel em 2026-10-09 (PDFs seguem no Blob). */
const PROVAS_FUVEST = [
  [2015, 'provas/fuv2015_1fase_prova_V_888c31.pdf', 'provas/fuv2015_1fase_prova_gab_0a5b01.pdf'],
  [2016, 'provas/fuv2016_1fase_prova_V_9d588e.pdf', 'provas/fuv2016_1fase_prova_gab_0c4b8c.pdf'],
  [2017, 'provas/fuv2017_1fase_prova_V_8f1e76.pdf', 'provas/fuv2017_1fase_prova_gab_bd9418.pdf'],
  [2018, 'provas/fuv2018_1fase_prova_V_2823ed.pdf', 'provas/fuv2018_1fase_prova_gab_d1b0d1.pdf'],
  [2019, 'provas/fuvest_2019_primeira_fas_cc59e4.pdf', 'provas/fuv2019_gabarito_oficial_bd3ccf.pdf'],
  [2020, 'provas/fuvest_2020_primeira_fas_a553b3.pdf', 'provas/fuvest_2020_primeira_fas_6aaf82.pdf'],
  [2021, 'provas/fuvest_2021_primeira_fas_21668d.pdf', 'provas/fuvest_2021_primeira_fas_187aa8.pdf'],
  [2022, 'provas/fuvest_2022_primeira_fas_f1d0ca.pdf', 'provas/fuvest_2022_primeira_fas_155325.pdf'],
  [2023, 'provas/fuvest2023_primeira_fase_cff246.pdf', 'provas/fuvest2023_gabarito_prim_8b5240.pdf'],
];

/**
 * Outubro/2026 — o banco de produção foi perdido (plano da hospedagem venceu)
 * e o app subiu com banco novo. O seed recria o conteúdo base; isto devolve o
 * que tinha sido feito pelo painel e cujos arquivos sobreviveram no Blob:
 *
 *  1. as 13 fotos de Aprovados (cópias leves em /assets/results/aprovados/);
 *  2. os vídeos de depoimento enviados pelo painel, desativados;
 *  3. as provas anteriores da FUVEST, com PDF e gabarito.
 *
 * Só cria o que falta: rodar de novo não duplica nada.
 */
async function restauracaoOutubro2026() {
  return db.tx(async (client) => {
    const resumo = { fotos: 0, videos: 0, provas: 0 };

    let ordem = 0;
    for (const nome of Object.values(FOTOS_APROVADOS)) {
      ordem += 1;
      const [genero, ...resto] = nome.split('-');
      const primeiro = resto.pop();
      const medicina = resto.join('-') === 'medicina';
      const role = `${genero === 'aprovada' ? 'Aprovada' : 'Aprovado'} · ${medicina ? 'Medicina' : 'Barro Branco'}`;
      const imagem = `/assets/results/aprovados/${nome}.jpg`;
      const res = await client.query(
        `INSERT INTO testimonials (name, role, image_url, kind, rating, exam_id, sort_order, active)
         SELECT $1, $2, $3, 'foto', 5, (SELECT id FROM exams WHERE slug = $4), $5, true
          WHERE NOT EXISTS (SELECT 1 FROM testimonials WHERE image_url = $3)`,
        [primeiro.charAt(0).toUpperCase() + primeiro.slice(1), role, imagem, medicina ? 'enem' : 'barro-branco', ordem]
      );
      resumo.fotos += res.rowCount;
    }

    for (const caminho of VIDEOS_DEPOIMENTO_PAINEL) {
      const url = `${BLOB}/${caminho}`;
      const res = await client.query(
        `INSERT INTO testimonials (name, role, video_url, rating, sort_order, active)
         SELECT 'Aluno Foco Elite', 'Depoimento em vídeo', $1, 5, 100, false
          WHERE NOT EXISTS (SELECT 1 FROM testimonials WHERE video_url = $1)`,
        [url]
      );
      resumo.videos += res.rowCount;
    }

    for (const [ano, prova, gabarito] of PROVAS_FUVEST) {
      const res = await client.query(
        `INSERT INTO past_exams (exam_id, year, title, board, pdf_url, answer_key_url, sort_order, active)
         SELECT e.id, $1, $2, 'FUVEST', $3, $4, 0, true FROM exams e
          WHERE e.slug = 'fuvest'
            AND NOT EXISTS (SELECT 1 FROM past_exams WHERE pdf_url = $3)`,
        [ano, `FUVEST ${ano} - 1ª fase`, `${BLOB}/${prova}`, `${BLOB}/${gabarito}`]
      );
      resumo.provas += res.rowCount;
    }

    return resumo;
  });
}

module.exports = { faqEBonusOutubro2026, resultadosOutubro2026, restauracaoOutubro2026, FOTOS_APROVADOS };

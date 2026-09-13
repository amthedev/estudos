'use strict';

const publishedAssets = require('./curated_asset_urls.json');

function publishedUrl(localUrl) {
  return publishedAssets[localUrl]?.url || localUrl;
}

function publishedDocument(pdfUrl, answerKeyUrl = null) {
  return {
    pdf_url: publishedUrl(pdfUrl),
    answer_key_url: answerKeyUrl ? publishedUrl(answerKeyUrl) : null,
    legacy_pdf_url: pdfUrl,
    legacy_answer_key_url: answerKeyUrl,
  };
}

const testimonials = [
  {
    name: 'Ana Estuda',
    role: 'Aprovada em Medicina pelo ENEM/SISU',
    exam: 'enem',
    image_url: '/assets/results/posts/aprovacao-medicina-ana.png',
    sort_order: 1,
  },
  {
    name: 'Pedro Henrique',
    role: 'Cadete PM - Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/posts/aprovacao-barro-branco-pedro.png',
    sort_order: 2,
  },
  {
    name: 'Mariana',
    role: 'Aprovada no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/posts/aprovacao-barro-branco-mariana.png',
    sort_order: 3,
  },
  {
    name: 'Beatriz',
    role: 'Aprovada em Medicina pelo ENEM/SISU',
    exam: 'enem',
    image_url: '/assets/results/posts/aprovacao-medicina-beatriz.png',
    sort_order: 4,
  },
  {
    name: 'Lucas',
    role: 'Aprovado em Medicina pelo ENEM',
    exam: 'enem',
    image_url: '/assets/results/posts/aprovacao-medicina-lucas.png',
    sort_order: 5,
  },
  {
    name: 'Ana Souza',
    role: 'Medicina pelo ENEM/SISU',
    exam: 'enem',
    image_url: '/assets/results/messages/depoimento-enem-ana.png',
    sort_order: 6,
  },
  {
    name: 'Caíque Santos',
    role: 'Aprovado no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/messages/depoimento-barro-branco-caique.png',
    sort_order: 7,
  },
  {
    name: 'Rafael Costa',
    role: 'Aprovado no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/messages/depoimento-barro-branco-rafael.png',
    sort_order: 8,
  },
  {
    name: 'Mariana Lopes',
    role: 'Aprovada no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/messages/depoimento-barro-branco-mariana.png',
    sort_order: 9,
  },
  {
    name: 'Gabriela Martins',
    role: 'Aprovada em Medicina pelo ENEM',
    exam: 'enem',
    image_url: '/assets/results/messages/depoimento-enem-gabriela.png',
    sort_order: 10,
  },
  {
    name: 'Letícia Ribeiro',
    role: 'Aprovada no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/messages/depoimento-barro-branco-leticia.png',
    sort_order: 11,
  },
  {
    name: 'João Pedro',
    role: 'Aprovado em Medicina pelo ENEM',
    exam: 'enem',
    image_url: '/assets/results/messages/depoimento-enem-joao.png',
    sort_order: 12,
  },
  {
    name: 'Lucas Ferreira',
    role: 'Aprovado em Medicina pelo ENEM',
    exam: 'enem',
    image_url: '/assets/results/messages/depoimento-enem-lucas.png',
    sort_order: 13,
  },
  {
    name: 'Beatriz Almeida',
    role: 'Aprovada pelo SISU',
    exam: 'enem',
    image_url: '/assets/results/messages/depoimento-enem-beatriz.png',
    sort_order: 14,
  },
  {
    name: 'Pedro Henrique',
    role: 'Aprovado no Barro Branco',
    exam: 'barro-branco',
    image_url: '/assets/results/messages/depoimento-barro-branco-pedro.png',
    sort_order: 15,
  },
];

const enemYears = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016];

const pastExams = enemYears.flatMap((year) => [1, 2].map((day) => ({
  exam: 'enem',
  year,
  day,
  title: `Caderno de questões - ${day}º dia`,
  board: 'INEP',
  ...publishedDocument(
    `/assets/past-exams/enem/${year}/enem-${year}-dia-${day}.pdf`,
    `/assets/past-exams/enem/${year}/enem-${year}-gabarito-dia-${day}.pdf`
  ),
  notes: 'Aplicação regular',
  sort_order: day,
})));

// O acervo PPL foi combinado como três provas adicionais. Cada aplicação tem
// dois dias; usamos os cadernos azuis e os gabaritos oficiais do Inep, já
// publicados no mesmo Blob dos demais PDFs para a leitura não depender do
// certificado TLS incompleto do servidor de download do Inep.
const enemPplYears = [2024, 2023, 2022];
pastExams.push(...enemPplYears.flatMap((year) => [1, 2].map((day) => ({
  exam: 'enem',
  year,
  day,
  title: `ENEM PPL ${year} - ${day}º dia`,
  board: 'INEP',
  ...publishedDocument(
    `/assets/past-exams/enem-ppl/${year}/enem-ppl-${year}-dia-${day}.pdf`,
    `/assets/past-exams/enem-ppl/${year}/enem-ppl-${year}-gabarito-dia-${day}.pdf`
  ),
  notes: 'Reaplicação / Pessoas Privadas de Liberdade (PPL)',
  sort_order: 10 + day,
}))));

pastExams.push(
  {
    exam: 'barro-branco',
    year: 2026,
    title: 'APMBB CFO PM-SP 2026',
    board: 'VUNESP',
    ...publishedDocument('/assets/past-exams/barro-branco/barro-branco-2026.pdf'),
    notes: 'Prova e gabarito oficial',
    sort_order: 1,
  },
  {
    exam: 'barro-branco',
    year: 2025,
    title: 'APMBB CFO PM-SP 2025',
    board: 'FGV',
    ...publishedDocument('/assets/past-exams/barro-branco/barro-branco-2025.pdf'),
    notes: 'Prova com resoluções',
    sort_order: 1,
  },
  {
    exam: 'barro-branco',
    year: 2024,
    title: 'APMBB CFO PM-SP 2024',
    board: 'VUNESP',
    ...publishedDocument('/assets/past-exams/barro-branco/barro-branco-2024.pdf'),
    notes: 'Prova com gabarito',
    sort_order: 1,
  },
  {
    exam: 'barro-branco',
    year: 2023,
    title: 'APMBB CFO PM-SP 2023',
    board: 'VUNESP',
    ...publishedDocument('/assets/past-exams/barro-branco/barro-branco-2023.pdf'),
    notes: 'Prova completa',
    sort_order: 1,
  },
  {
    exam: 'barro-branco',
    year: 2022,
    title: 'APMBB CFO PM-SP 2022',
    board: 'VUNESP',
    ...publishedDocument('/assets/past-exams/barro-branco/barro-branco-2022.pdf'),
    notes: 'Prova completa',
    sort_order: 1,
  }
);

module.exports = { testimonials, pastExams };

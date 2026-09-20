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
  // Depoimentos em vídeo (aluno falando). Vídeos já enviados ao Blob; ficam na
  // seção "Quem estudou, conta", separados dos prints. Sem nome de propósito.
  {
    name: 'Aluno Foco Elite',
    role: 'Aluno aprovado · ENEM',
    exam: 'enem',
    video_url: 'https://public-blob.squarecloud.dev/0a9f7f1de21c92b5fe36d1006d36b96186874a93/depoimentos/ENEM_DEP_f0fab9.mov',
    sort_order: 16,
  },
  {
    name: 'Aluno Foco Elite',
    role: 'Aluno aprovado · ENEM',
    exam: 'enem',
    video_url: 'https://public-blob.squarecloud.dev/0a9f7f1de21c92b5fe36d1006d36b96186874a93/depoimentos/ENEM_DEP_1_861ea2.mov',
    sort_order: 17,
  },
  {
    name: 'Aluno Foco Elite',
    role: 'Aluno aprovado · Barro Branco',
    exam: 'barro-branco',
    video_url: 'https://public-blob.squarecloud.dev/0a9f7f1de21c92b5fe36d1006d36b96186874a93/depoimentos/BARRO_BRANCO_b90ad6.mp4',
    sort_order: 18,
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

// O acervo PPL vai de 2016 a 2024: nove aplicações, dois dias cada. Cada dia é
// uma prova completa de 90 questões com gabarito oficial, o que praticamente
// dobra o material disponível para o banco de questões e para o simulado.
//
// O caderno escolhido varia de ano para ano porque a numeração do Inep muda (o
// azul do 2º dia é o 5 em 2021, o 7 em 2019 e o 19 em 2018). O que importa, e
// foi conferido arquivo por arquivo, é que a prova e o gabarito de cada linha
// sejam do MESMO caderno — cadernos diferentes embaralham as alternativas, e um
// gabarito trocado entraria como gabarito errado em 90 questões de uma vez.
//
// Os PDFs ficam no mesmo Blob dos demais para a leitura não depender do
// certificado TLS incompleto do servidor de download do Inep.
const enemPplYears = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016];
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

// "Por dentro da plataforma": telas reais para o visitante ver antes de comprar.
// As imagens ficam em public/assets/platform-tour (servidas estaticamente); se um
// dia forem publicadas no Blob, o manifest de curated_asset_urls cobre via publishedUrl.
const platformTour = [
  { title: 'Início', caption: 'Seu painel com plano do dia, progresso e próximas atividades.', image_url: publishedUrl('/assets/platform-tour/inicio.webp'), sort_order: 1 },
  { title: 'Videoaulas', caption: 'Aulas por matéria, no seu ritmo, com continuação de onde parou.', image_url: publishedUrl('/assets/platform-tour/videoaulas.webp'), sort_order: 2 },
  { title: 'Cronograma', caption: 'Plano de estudos personalizado, semana a semana.', image_url: publishedUrl('/assets/platform-tour/cronograma.webp'), sort_order: 3 },
  { title: 'Banco de questões', caption: 'Milhares de questões com filtros e desempenho ao vivo.', image_url: publishedUrl('/assets/platform-tour/questoes.webp'), sort_order: 4 },
  { title: 'Simulados', caption: 'ENEM, Barro Branco e por matéria, em condições reais.', image_url: publishedUrl('/assets/platform-tour/simulados.webp'), sort_order: 5 },
  { title: 'Provas anteriores', caption: 'Resolva provas reais e acompanhe sua evolução.', image_url: publishedUrl('/assets/platform-tour/provas-anteriores.webp'), sort_order: 6 },
  { title: 'Redação', caption: 'Tema da semana, textos de apoio e envio corrigido pelos critérios do ENEM.', image_url: publishedUrl('/assets/platform-tour/redacao.webp'), sort_order: 7 },
  { title: 'Resumos', caption: 'Conteúdo objetivo para revisar e fixar o que importa.', image_url: publishedUrl('/assets/platform-tour/resumos.webp'), sort_order: 8 },
  { title: 'Anotações', caption: 'Seus cadernos por matéria, com tags e revisão.', image_url: publishedUrl('/assets/platform-tour/anotacoes.webp'), sort_order: 9 },
  { title: 'Desempenho', caption: 'Evolução, pontos fortes e o que precisa revisar.', image_url: publishedUrl('/assets/platform-tour/desempenho.webp'), sort_order: 10 },
  { title: 'Professores', caption: 'Aulas particulares para tirar dúvidas quando precisar.', image_url: publishedUrl('/assets/platform-tour/professores.webp'), sort_order: 11 },
  { title: 'Escolha sua prova', caption: 'Selecione o objetivo e receba um plano sob medida.', image_url: publishedUrl('/assets/platform-tour/escolha-prova.webp'), sort_order: 12 },
];

module.exports = { testimonials, pastExams, platformTour };

'use strict';

/**
 * Conteúdo da página inicial (landing).
 *
 * Todo texto de venda vive no banco e é editável em /admin/landing. O seed apenas
 * cria o que ainda não existe: se a equipe editar um bloco pelo painel, rodar o
 * seed de novo não sobrescreve. Use `--force-landing` para restaurar o texto original.
 *
 * Fonte: copy enviada pelo cliente em 10/09/2026.
 */

const blocks = [
  {
    key: 'hero',
    eyebrow: 'Foco de Elite',
    title: 'Pare de estudar sem direção.',
    subtitle:
      'Prepare-se para o ENEM, Barro Branco e outros vestibulares com uma plataforma criada para organizar sua rotina, mostrar o que estudar e acompanhar sua evolução até a prova.',
    cta_label: 'Começar agora',
    cta_href: '/cadastro',
    sort_order: 1,
    items: [
      { icon: 'square-play', title: 'Videoaulas' },
      { icon: 'file-text', title: 'Questões' },
      { icon: 'target', title: 'Simulados' },
      { icon: 'calendar-days', title: 'Cronograma personalizado' },
      { icon: 'chart-column', title: 'Acompanhamento de desempenho' },
      { icon: 'pen-line', title: 'Redação' },
      { icon: 'notebook-pen', title: 'Resumos' },
    ],
  },
  {
    key: 'dores',
    eyebrow: 'Reconhece isso?',
    title: 'Você estuda, mas ainda sente que está perdido?',
    body:
      'Você não precisa de mais conteúdo espalhado pela internet. Você precisa de direção.\n\nA Foco de Elite organiza sua preparação para você focar no que realmente importa: estudar, praticar, revisar e evoluir.',
    sort_order: 2,
    items: [
      { icon: 'circle-help', title: 'Não sabe qual matéria estudar primeiro?' },
      { icon: 'square-play', title: 'Assiste várias aulas, mas pratica pouco?' },
      { icon: 'calendar-x', title: 'Começa cronogramas e não consegue manter?' },
      {
        icon: 'triangle-alert',
        title: 'Tem medo de chegar perto da prova e descobrir que poderia ter se preparado melhor?',
      },
    ],
  },
  {
    key: 'objetivos',
    eyebrow: 'Escolha seu objetivo',
    title: 'Uma preparação direcionada para a sua prova',
    subtitle:
      'O conteúdo, o cronograma, as questões, os simulados e a redação se ajustam à prova que você escolher.',
    sort_order: 3,
    // Os dois primeiros cards saem das provas em destaque (exams.featured).
    // Este item acrescenta o terceiro card, dos demais vestibulares.
    items: [
      {
        icon: 'graduation-cap',
        title: 'Outros vestibulares',
        text: 'FUVEST, UNICAMP, UNESP, FGV, Mackenzie, PUC e outros vestibulares concorridos, cada um com suas matérias, seus pesos, suas provas anteriores e seus critérios de redação.',
        cta_label: 'Quero estudar para outro vestibular',
        cta_href: '/cadastro',
      },
    ],
  },
  {
    key: 'como_funciona',
    eyebrow: 'Como funciona',
    title: 'Do objetivo à rotina, em seis passos',
    sort_order: 4,
    items: [
      { icon: 'target', title: 'Escolha seu objetivo', text: 'ENEM, Barro Branco ou outro vestibular.' },
      { icon: 'calendar-days', title: 'Veja o que estudar', text: 'Acesse seu cronograma, matérias e conteúdos.' },
      { icon: 'square-play', title: 'Assista às aulas', text: 'Aprenda cada assunto de forma organizada.' },
      { icon: 'file-text', title: 'Resolva questões', text: 'Pratique o conteúdo que acabou de estudar.' },
      { icon: 'trophy', title: 'Faça simulados', text: 'Teste seus conhecimentos antes da prova.' },
      { icon: 'chart-column', title: 'Acompanhe sua evolução', text: 'Veja seu progresso e descubra onde precisa melhorar.' },
    ],
  },
  {
    key: 'planos',
    eyebrow: 'Escolha seu plano',
    title: 'Mais tempo para estudar. Menor valor por mês.',
    subtitle: 'Todos os planos dão acesso completo à plataforma.',
    sort_order: 5,
  },
  {
    key: 'tudo_em_um_lugar',
    eyebrow: 'Tudo em um só lugar',
    title: 'A preparação inteira dentro da plataforma',
    sort_order: 6,
    items: [
      { icon: 'square-play', title: 'Videoaulas' },
      { icon: 'file-text', title: 'Questões por assunto' },
      { icon: 'target', title: 'Simulados' },
      { icon: 'calendar-days', title: 'Cronograma personalizado' },
      { icon: 'pen-line', title: 'Redação' },
      { icon: 'notebook-pen', title: 'Resumos' },
      { icon: 'check-check', title: 'Controle de progresso' },
      { icon: 'chart-column', title: 'Desempenho por matéria' },
      { icon: 'graduation-cap', title: 'Área exclusiva do aluno' },
    ],
  },
  {
    key: 'depoimentos',
    eyebrow: 'Quem já estuda com a gente',
    title: 'O que dizem os alunos',
    sort_order: 7,
  },
  {
    key: 'faq',
    eyebrow: 'Perguntas frequentes',
    title: 'Tudo o que você precisa saber antes de começar',
    sort_order: 8,
  },
  {
    key: 'fechamento',
    eyebrow: 'Foco de Elite',
    title: 'A prova vai chegar. A diferença está em como você vai chegar até ela.',
    subtitle:
      'Pare de estudar sem direção. Construa uma preparação organizada e acompanhe sua evolução até a prova.',
    body: 'Disciplina. Estratégia. Evolução.',
    cta_label: 'Começar minha preparação',
    cta_href: '/cadastro',
    sort_order: 9,
  },
];

// Perguntas frequentes enviadas pelo cliente. As três primeiras citam preço:
// a resposta é montada com os planos do banco quando o texto tem {{planos}}.
const faqs = [
  {
    question: 'Quanto custa a Foco de Elite?',
    answer: 'Você pode escolher entre os planos disponíveis:\n\n{{planos}}',
    sort_order: 1,
  },
  {
    question: 'Como funciona o plano de 15 meses?',
    answer:
      'Você paga pelo equivalente ao plano anual de 12 meses e recebe mais 3 meses de acesso como bônus, totalizando 15 meses.',
    sort_order: 2,
  },
  {
    question: 'Qual plano oferece a maior vantagem?',
    answer:
      'O plano de 15 meses possui o melhor custo-benefício, por ter o menor valor equivalente por mês entre as opções.',
    sort_order: 3,
  },
  {
    question: 'A plataforma serve para ENEM e Barro Branco?',
    answer: 'Sim. Você escolhe seu objetivo e encontra uma preparação direcionada para ele.',
    sort_order: 4,
  },
  {
    question: 'Posso estudar pelo celular?',
    answer: 'Sim. A plataforma pode ser acessada pelo celular, tablet ou computador.',
    sort_order: 5,
  },
  {
    question: 'Tem videoaulas?',
    answer: 'Sim. As aulas ficam organizadas por matéria e assunto.',
    sort_order: 6,
  },
  {
    question: 'Tem questões depois das aulas?',
    answer:
      'Sim. Ao terminar uma aula você pratica questões do assunto que acabou de estudar, com resposta correta, resolução e explicação.',
    sort_order: 7,
  },
  {
    question: 'Tem simulados?',
    answer: 'Sim. Você pode realizar simulados e acompanhar seu desempenho por matéria e por assunto.',
    sort_order: 8,
  },
  {
    question: 'Tem cronograma?',
    answer:
      'Sim. A plataforma monta seu cronograma conforme a prova escolhida, os dias e horas que você tem disponíveis e o seu desempenho.',
    sort_order: 9,
  },
  {
    question: 'Tem redação para o ENEM?',
    answer:
      'Sim. A preparação para o ENEM tem uma área dedicada à redação, com correção pelos critérios da prova.',
    sort_order: 10,
  },
  {
    question: 'Consigo acompanhar meu progresso?',
    answer: 'Sim. Você acompanha atividades, matérias e desempenho dentro da plataforma.',
    sort_order: 11,
  },
];

// Textos de landing por prova em destaque (exams.featured). A logo é cadastrada
// pelo painel: o cliente vai enviar a imagem do Barro Branco.
const examLanding = [
  {
    slug: 'enem',
    featured: true,
    landing_headline: 'ENEM',
    landing_text:
      'Prepare-se para buscar uma nota mais alta com aulas, questões, simulados, redação, cronograma e acompanhamento da sua evolução.',
    landing_cta: 'Quero estudar para o ENEM',
  },
  {
    slug: 'barro-branco',
    featured: true,
    landing_headline: 'Barro Branco',
    landing_text:
      'Seu objetivo é conquistar uma vaga no Barro Branco? Tenha uma preparação organizada com conteúdos direcionados, videoaulas, questões, simulados e acompanhamento do seu desempenho. Disciplina, estratégia e constância.',
    landing_cta: 'Quero estudar para o Barro Branco',
  },
];

module.exports = { blocks, faqs, examLanding };

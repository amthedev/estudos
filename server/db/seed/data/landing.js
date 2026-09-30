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

// Perguntas frequentes (versão de outubro/2026, com os planos por nível e as
// moedas). Números nunca ficam no texto: {{planos}}, {{moedas}} e {{custos}}
// são trocados pelos valores do painel na hora de montar a página
// (server/routes/landing.js). Em produção, a troca das perguntas antigas por
// estas roda uma vez no boot (server/db/seed/ajustes.js).
const faqs = [
  {
    question: 'Quanto custa a Foco de Elite?',
    answer:
      'São três níveis — Básico, Pro e Avançado — cada um nos planos mensal, de 6 meses e de 12 meses:\n\n{{planos}}\n\n' +
      'Todos dão acesso às videoaulas, ao banco de questões, às provas anteriores e ao cronograma. O que muda entre os níveis são as moedas de cada dia, que pagam correções de redação, simulados e o que a IA cria, e a cota mensal do Tutor IA.',
    sort_order: 1,
  },
  {
    question: 'Qual a diferença entre Básico, Pro e Avançado?',
    answer:
      'O conteúdo é o mesmo nos três. O que muda são as moedas que você recebe por dia — elas pagam as correções de redação, os simulados e o que a IA cria para você:\n\n{{moedas}}\n\n' +
      'Quanto maior o plano, mais redações corrigidas e simulados você faz no mesmo dia. O Pro e o Avançado também têm uma cota maior de Tutor IA por mês.',
    sort_order: 2,
  },
  {
    question: 'O que são as moedas?',
    answer:
      'Todo dia você recebe as moedas do seu plano. Elas renovam à meia-noite (horário de Brasília) e não acumulam de um dia para o outro. As correções de redação, os simulados e o que a IA cria para você custam algumas moedas:\n\n{{custos}}\n\n' +
      'Se a ação não chegar a sair — a correção falhou, a IA não conseguiu criar nada, o simulado não foi montado —, a moeda volta para você.',
    sort_order: 3,
  },
  {
    question: 'O que posso usar sem gastar moedas?',
    answer:
      'Videoaulas, resumos, o banco de questões, as provas anteriores, o cronograma e o acompanhamento de desempenho são livres em todos os planos, sem limite.',
    sort_order: 4,
  },
  {
    question: 'Qual plano devo escolher?',
    answer:
      'Se você tem tempo até a prova e quer estudar com constância, o Básico cobre o essencial. Se quer treinar mais com redação e simulados toda semana, o Pro dá mais moedas por dia. ' +
      'Com a prova se aproximando, o Avançado é o que permite mais treino por dia: mais redações corrigidas e mais simulados no mesmo dia.',
    sort_order: 5,
  },
  {
    question: 'Como funciona o plano de 12 meses?',
    answer:
      'Você paga 12 meses e ganha 1 mês de bônus: são 13 meses de acesso, com o menor valor por mês do seu nível. ' +
      'No cartão, depois desse período a assinatura renova por mais 12 meses; no Pix, o pagamento vale para os 13 meses e não renova sozinho.',
    sort_order: 6,
  },
  {
    question: 'Posso testar antes de pagar?',
    answer:
      'Sim. Nos planos de 6 e de 12 meses pagos com cartão, você tem 24 horas grátis para conhecer a plataforma, e a primeira cobrança só acontece depois desse período. O teste vale uma vez por cadastro.',
    sort_order: 7,
  },
  {
    question: 'Como posso pagar?',
    answer:
      'Com cartão de crédito ou Pix. No cartão, a assinatura renova sozinha ao fim de cada período. No Pix, você paga o período inteiro de uma vez e ele não renova automaticamente.',
    sort_order: 8,
  },
  {
    question: 'Posso cancelar quando quiser?',
    answer:
      'Sim. Você cancela na própria plataforma, na tela de assinatura, e continua com acesso até o fim do período que já pagou.',
    sort_order: 9,
  },
  {
    question: 'Posso mudar de plano depois?',
    answer:
      'Você pode subir de nível — do Básico para o Pro ou o Avançado, ou do Pro para o Avançado, na mesma duração — pagando só a diferença proporcional aos dias que faltam do seu período, com um valor mínimo por cobrança. Nos planos com teste grátis, o upgrade fica disponível depois das 24 horas de teste. ' +
      'Para ir para um plano menor, cancele a renovação e escolha o novo plano quando o período atual terminar.',
    sort_order: 10,
  },
  {
    question: 'A plataforma serve para ENEM e Barro Branco?',
    answer: 'Sim, e também para outros vestibulares. Você escolhe seu objetivo e recebe uma preparação direcionada para ele.',
    sort_order: 11,
  },
  {
    question: 'Tem videoaulas e questões?',
    answer:
      'Sim. As aulas ficam organizadas por matéria e assunto, e depois de cada aula você pratica questões do assunto que acabou de estudar, com resposta, resolução e explicação.',
    sort_order: 12,
  },
  {
    question: 'Tem correção de redação?',
    answer:
      'Sim. Você escreve na plataforma e recebe a correção pelos critérios da redação da sua prova — no ENEM, as cinco competências —, com a nota de cada critério e o que melhorar. Cada correção usa moedas do seu plano.',
    sort_order: 13,
  },
  {
    question: 'Tem simulados?',
    answer:
      'Sim: simulado completo com as matérias da sua prova, simulados curtos e por matéria ou assunto, com o resultado por matéria. Cada simulado usa moedas do seu plano.',
    sort_order: 14,
  },
  {
    question: 'Tem Tutor IA?',
    answer:
      'Sim. O Tutor IA tira suas dúvidas a qualquer hora, inclusive sobre a aula ou a questão que você está fazendo. Ele não gasta moedas: cada plano tem uma cota própria por mês, que renova no dia 1º.',
    sort_order: 15,
  },
  {
    question: 'Tem cronograma e acompanhamento?',
    answer:
      'Sim. A plataforma monta seu cronograma conforme a prova, os dias e as horas que você tem, e mostra sua evolução por matéria, com o que precisa revisar.',
    sort_order: 16,
  },
  {
    question: 'Posso estudar pelo celular?',
    answer: 'Sim. A plataforma funciona no celular, no tablet e no computador.',
    sort_order: 17,
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

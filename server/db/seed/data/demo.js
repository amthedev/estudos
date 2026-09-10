'use strict';

/**
 * Conteúdo de demonstração (npm run seed:demo).
 *
 * Serve para a plataforma "ter vida" em um ambiente novo: aulas com resumo,
 * questões originais com resolução, um professor para aulas particulares e dois
 * modelos de simulado. Tudo é identificado de forma estável para o seed ser
 * idempotente e para o conteúdo poder ser removido depois (docs/CONTEUDO.md):
 *
 *   lessons    slug fixo (lesson.slug)
 *   questions  source = 'demo:<n> — conteúdo de demonstração'
 *   teachers   e-mail (@demo.focoelite.com.br)
 *   simulados  config.seed_key = 'demo:<chave>'
 *
 * Assuntos e subassuntos são referenciados pelos slugs de topics.js e pelo NOME
 * do subassunto (o seed deriva o slug com utils/slug).
 */

const ENEM = 'enem';
const BB = 'barro-branco';
const VEST = ['fuvest', 'unicamp', 'unesp', 'fgv', 'mackenzie', 'puc-sp'];
const ALL = [ENEM, BB, ...VEST];
const BB_VEST = [BB, ...VEST];

const TEACHER_NAME = 'Equipe Foco Elite';
const BOARD = 'Foco Elite';
const YEAR = 2026;

// ---------------------------------------------------------------------
// AULAS
// ---------------------------------------------------------------------
const lessons = [
  {
    slug: 'porcentagem-conceito-e-fator-multiplicativo',
    subject: 'matematica',
    topic: 'porcentagem',
    subtopic: 'Fator de aumento e de desconto',
    title: 'Porcentagem: do conceito ao fator multiplicativo',
    description: 'Conversão entre fração, decimal e porcentagem, fator de aumento e de desconto, variações sucessivas e variação percentual.',
    duration_min: 35,
    difficulty: 1,
    exams: ALL,
    summary: `## O que é porcentagem

Porcentagem é uma forma de expressar uma parte de um todo dividido em 100 partes iguais. Dizer que 25% dos alunos de uma turma foram aprovados significa que, a cada 100 alunos, 25 foram aprovados. O símbolo % substitui a divisão por 100: 25% = 25/100 = 0,25.

Essa relação é a chave de tudo: **toda porcentagem pode ser escrita como fração ou como número decimal**, e é na forma decimal que os cálculos ficam rápidos.

## Calculando a porcentagem de uma quantidade

Para achar 30% de 250, multiplique a quantidade pelo decimal correspondente: 250 × 0,30 = 75. Quando os números são "redondos", vale usar atalhos: 10% é dividir por 10; 50% é a metade; 25% é a quarta parte; 5% é a metade de 10%. Combine atalhos: 15% de 400 = 10% (40) + 5% (20) = 60.

## Fator multiplicativo

Aqui está o conceito que mais economiza tempo na prova. Um aumento de 20% transforma o valor em 100% + 20% = 120% do original, ou seja, multiplica por 1,20. Um desconto de 20% deixa 80% do valor, ou seja, multiplica por 0,80.

- Aumento de p%: fator = 1 + p/100
- Desconto de p%: fator = 1 − p/100

Exemplo: um produto de R$ 80,00 com desconto de 15% custa 80 × 0,85 = R$ 68,00. Não é preciso calcular o desconto e depois subtrair.

## Aumentos e descontos sucessivos

Quando há mais de uma variação, os fatores se multiplicam. Um aumento de 20% seguido de um desconto de 20% dá 1,20 × 0,80 = 0,96: o valor final é 4% menor que o original, e não igual a ele. Esse é um dos erros mais explorados pelas bancas: **porcentagens sucessivas não se somam**.

## Variação percentual

Para descobrir quanto um valor variou em porcentagem, compare a diferença com o valor inicial:

variação = (valor final − valor inicial) ÷ valor inicial × 100

Se um aluguel passou de R$ 1.200 para R$ 1.320, a variação foi (1.320 − 1.200) ÷ 1.200 = 0,10, ou 10%. Atenção ao referencial: a porcentagem é sempre calculada sobre o valor inicial, salvo quando o enunciado disser o contrário (como "lucro sobre o preço de venda").

## Lucro e prejuízo

Lucro = preço de venda − preço de custo. A porcentagem de lucro normalmente se refere ao custo: comprar por R$ 50 e vender por R$ 65 dá lucro de 15/50 = 30%. Se a questão pedir lucro sobre a venda, o referencial muda: 15/65 ≈ 23%.

## Como isso cai nas provas

No ENEM, porcentagem aparece em situações do cotidiano: reajustes, promoções, leitura de gráficos e comparação de planos. Na VUNESP (Barro Branco), é comum o encadeamento com regra de três e problemas de comércio. Em ambos, a estratégia é a mesma: transforme tudo em fator multiplicativo e verifique sobre qual valor a porcentagem está sendo calculada.

## Resumo

1. p% = p/100.
2. Aumento: multiplicar por (1 + p/100); desconto: multiplicar por (1 − p/100).
3. Variações sucessivas: multiplicar os fatores.
4. Variação percentual: diferença dividida pelo valor inicial.`,
  },
  {
    slug: 'regra-de-tres-simples-e-composta',
    subject: 'matematica',
    topic: 'regra-de-tres',
    subtopic: 'Regra de três composta',
    title: 'Regra de três simples e composta',
    description: 'Como identificar grandezas direta e inversamente proporcionais e montar a proporção correta em problemas simples e compostos.',
    duration_min: 40,
    difficulty: 2,
    exams: ALL,
    summary: `## Grandezas proporcionais

Regra de três é o método para resolver problemas em que duas ou mais grandezas variam juntas de forma proporcional. Antes de montar qualquer conta, é preciso identificar o tipo de relação entre as grandezas:

- **Diretamente proporcionais**: quando uma aumenta, a outra aumenta na mesma proporção. Mais páginas impressas exigem mais tempo; mais quilômetros consomem mais combustível.
- **Inversamente proporcionais**: quando uma aumenta, a outra diminui na mesma proporção. Mais operários terminam a obra em menos dias; maior velocidade, menor tempo de viagem.

A pergunta que resolve a classificação é: "se eu dobrar esta grandeza, a outra dobra ou cai pela metade?".

## Regra de três simples direta

Monte uma tabela com duas colunas (uma para cada grandeza) e duas linhas (situação conhecida e situação com a incógnita). Se as grandezas são diretas, multiplique em cruz.

Exemplo: 3 metros de tecido custam R$ 45. Quanto custam 8 metros?

3 m — R$ 45
8 m — x

3x = 45 × 8, logo x = 120. Resposta: R$ 120.

## Regra de três simples inversa

Quando as grandezas são inversas, inverta uma das colunas antes de multiplicar em cruz (ou multiplique em linha).

Exemplo: 4 torneiras enchem um tanque em 6 horas. Em quanto tempo 8 torneiras enchem o mesmo tanque?

Mais torneiras, menos tempo: inversa. 4 × 6 = 8 × t, logo t = 3 horas.

## Regra de três composta

Quando há três ou mais grandezas, compare cada uma delas **separadamente** com a grandeza da incógnita, decidindo se é direta ou inversa. Depois, monte uma única proporção: a incógnita é igual ao valor conhecido multiplicado pelas razões, mantendo a ordem nas grandezas diretas e invertendo nas inversas.

Exemplo: 5 máquinas produzem 600 peças em 4 dias. Quantas peças 8 máquinas produzem em 6 dias?

- Máquinas e peças: mais máquinas, mais peças (direta).
- Dias e peças: mais dias, mais peças (direta).

x = 600 × (8/5) × (6/4) = 600 × 1,6 × 1,5 = 1.440 peças.

Se a incógnita fosse o número de dias, a relação entre máquinas e dias seria inversa e a razão seria invertida.

## Erros comuns

1. Classificar toda relação como direta sem pensar. Velocidade e tempo, operários e prazo, torneiras e tempo são os casos inversos clássicos.
2. Misturar unidades: converta horas para minutos ou quilômetros para metros antes de montar a proporção.
3. Esquecer que "produção" depende de vários fatores ao mesmo tempo na regra composta.

## Como isso cai nas provas

O ENEM apresenta a regra de três dentro de contextos: dosagem de medicamento, consumo de energia, escala de mapa, rendimento de combustível. A VUNESP costuma cobrar a regra composta de forma direta, com operários, horas por dia e volume de trabalho. Em ambos, escreva as grandezas em colunas, marque com uma seta a direção de cada uma e só então faça a conta.

## Resumo

- Direta: multiplica em cruz. Inversa: inverte uma coluna.
- Composta: compare cada grandeza com a incógnita, uma de cada vez.
- Verifique se a resposta faz sentido (mais operários deveriam significar menos dias).`,
  },
  {
    slug: 'interpretacao-de-texto-como-fazer-inferencias',
    subject: 'interpretacao-de-texto',
    topic: 'inferencia-pressupostos',
    subtopic: 'Informação explícita e implícita',
    title: 'Interpretação de texto: como fazer inferências',
    description: 'Diferença entre informação explícita, pressuposto e subentendido; método para inferir sem extrapolar e armadilhas mais comuns.',
    duration_min: 30,
    difficulty: 2,
    exams: ALL,
    summary: `## O que é inferir

Inferir é chegar a uma conclusão a partir de pistas que o texto oferece, mesmo quando a informação não está escrita de forma explícita. Todo texto diz mais do que suas palavras: o autor conta com o leitor para preencher lacunas, reconhecer intenções e ligar ideias. As questões de inferência avaliam exatamente essa capacidade de ler o que está "nas entrelinhas" sem inventar o que o texto não sustenta.

## Explícito, pressuposto e subentendido

Para organizar a leitura, distinga três níveis de informação:

- **Explícito**: está literalmente no texto. "A loja abre às 9h."
- **Pressuposto**: é uma informação implícita, mas garantida por uma palavra ou expressão do próprio texto. Em "Pedro parou de fumar", o verbo *parar* pressupõe que Pedro fumava antes. Marcadores frequentes: *ainda*, *já*, *voltar a*, *continuar*, *deixar de*, *outra vez*, adjetivos e verbos que indicam mudança.
- **Subentendido**: depende do contexto e da intenção do falante; é uma insinuação que o autor pode negar. Se alguém diz "Que calor está fazendo aqui" perto de uma janela fechada, subentende-se um pedido para abri-la.

Nas provas, o pressuposto é cobrado como "informação que se depreende necessariamente do texto"; o subentendido aparece como "o que o autor sugere" ou "o efeito de sentido pretendido".

## Como fazer uma boa inferência

1. Localize o trecho de referência: a resposta correta sempre se apoia em algum elemento do texto.
2. Identifique palavras-chave que carregam pressupostos (verbos de mudança, advérbios de tempo, conectivos de oposição).
3. Relacione as partes: causa e consequência, antes e depois, contraste entre o que se esperava e o que aconteceu.
4. Teste a alternativa: pergunte se o texto sustenta aquela conclusão. Se for preciso acrescentar informação de fora, provavelmente é extrapolação.

## Armadilhas mais comuns

- **Extrapolação**: a alternativa vai além do texto ("o autor defende a proibição total"), quando o texto apenas critica.
- **Contradição sutil**: a alternativa inverte uma relação de causa ou troca o agente.
- **Generalização**: o texto fala de um caso, a alternativa fala de "todos".
- **Ironia não percebida**: quando o texto diz o contrário do que quer dizer, ler literalmente leva ao erro. Sinais de ironia: elogio em situação de fracasso, exagero evidente, contraste entre fala e ação.

## Exemplo comentado

"Depois de três reformas, a ponte voltou a ser interditada." O que se infere? Que a ponte já havia sido interditada antes (*voltou a*), que passou por três reformas que não resolveram o problema e que há um tom crítico quanto à eficácia das obras. Não se pode inferir quem é o responsável nem que a ponte será demolida: isso o texto não diz.

## Como isso cai nas provas

O ENEM explora a inferência em textos curtos: tirinhas, anúncios, trechos de crônica. As perguntas usam expressões como "depreende-se", "infere-se", "o texto sugere". A VUNESP trabalha com textos jornalísticos e literários maiores, pedindo a conclusão "correta de acordo com o texto". Em ambos, a regra é a mesma: a inferência é sempre a conclusão mais próxima do que está escrito.`,
  },
  {
    slug: 'revolucao-industrial-causas-fases-e-consequencias',
    subject: 'historia',
    topic: 'revolucao-industrial',
    subtopic: 'Primeira e Segunda Revolução Industrial',
    title: 'Revolução Industrial: causas, fases e consequências',
    description: 'Pioneirismo inglês, cercamentos, fases da industrialização, condições de trabalho e os movimentos operários que responderam a elas.',
    duration_min: 45,
    difficulty: 2,
    exams: ALL,
    summary: `## Do artesanato à fábrica

A Revolução Industrial foi a transformação do modo de produzir que começou na Inglaterra na segunda metade do século XVIII e mudou a economia, o trabalho e as cidades. Antes dela, os bens eram feitos em oficinas artesanais ou no sistema de manufatura doméstica, com ferramentas manuais e produção limitada. Com a introdução das máquinas movidas a vapor, a produção passou a ocorrer em fábricas, em larga escala, com trabalhadores assalariados cumprindo jornadas fixas.

## Por que a Inglaterra

Vários fatores se combinaram no caso inglês:

- **Capital acumulado** pelo comércio colonial, pelo tráfico de escravizados e pela agricultura comercial.
- **Cercamentos (enclosures)**: as terras comunais foram cercadas e privatizadas, expulsando camponeses que migraram para as cidades e formaram a mão de obra disponível.
- **Carvão e ferro** abundantes, matérias-primas da máquina a vapor e das ferrovias.
- **Mercado consumidor** garantido pelas colônias e pela marinha mercante mais poderosa da época.
- **Estabilidade política** após a Revolução Gloriosa (1688), com um Parlamento favorável aos interesses da burguesia.

## As fases

**Primeira Revolução Industrial (c. 1760–1850)**: energia do carvão e da máquina a vapor, indústria têxtil de algodão, ferrovias e navios a vapor. A Inglaterra praticamente sozinha.

**Segunda Revolução Industrial (c. 1850–1945)**: aço, eletricidade, petróleo, motor a combustão, indústria química e telégrafo. A produção se organiza em grandes empresas e chega à Alemanha, aos Estados Unidos, à França e ao Japão. Surgem o taylorismo e o fordismo, com a linha de montagem.

Muitos autores falam ainda de uma Terceira Revolução (informática e automação, a partir dos anos 1950) e de uma Quarta (inteligência artificial e internet das coisas), mas o núcleo das provas está nas duas primeiras.

## Consequências sociais

As cidades industriais cresceram sem planejamento: bairros operários superlotados, sem saneamento, com epidemias frequentes. Nas fábricas, jornadas de 14 a 16 horas, salários baixos, trabalho de mulheres e crianças e acidentes constantes. A sociedade se dividiu em burguesia industrial, dona dos meios de produção, e proletariado, que vendia sua força de trabalho.

## Reações dos trabalhadores

- **Ludismo** (início do século XIX): operários destruíam máquinas, vistas como causa do desemprego.
- **Cartismo** (1838–1848): movimento por direitos políticos, como o voto universal masculino, expressos na Carta do Povo enviada ao Parlamento.
- **Sindicatos (trade unions)**: organizações de trabalhadores para negociar salários e jornadas, legalizadas na Inglaterra em 1824.
- **Socialismo utópico** (Owen, Fourier, Saint-Simon) e **socialismo científico** (Marx e Engels), que analisou o capitalismo e propôs a revolução proletária.

## Como isso cai nas provas

O ENEM costuma apresentar um documento de época (relato de fábrica, gravura, trecho de lei) e pedir a relação entre a industrialização e as condições de vida ou os movimentos operários. A VUNESP privilegia a comparação entre as fases e as causas do pioneirismo inglês. Em ambos, saiba explicar o encadeamento: cercamentos, mão de obra disponível, fábricas, crescimento das cidades e movimento operário.`,
  },
  {
    slug: 'cinematica-mru-e-mruv',
    subject: 'fisica',
    topic: 'cinematica-mru-mruv',
    subtopic: 'Movimento uniformemente variado (MRUV)',
    title: 'Cinemática: MRU e MRUV',
    description: 'Posição, velocidade e aceleração; funções horárias do MRU e do MRUV, equação de Torricelli, gráficos e queda livre.',
    duration_min: 45,
    difficulty: 2,
    exams: ALL,
    summary: `## O que a cinemática estuda

Cinemática é a parte da mecânica que descreve o movimento sem se preocupar com suas causas. Os conceitos básicos são posição (onde o corpo está em relação a um referencial), deslocamento (variação da posição, Δs = s − s₀), velocidade (rapidez com que a posição varia) e aceleração (rapidez com que a velocidade varia).

Antes de resolver qualquer problema, converta as unidades para o Sistema Internacional: metros, segundos e metros por segundo. Para converter km/h em m/s, divida por 3,6; para o caminho inverso, multiplique por 3,6. Assim, 72 km/h = 20 m/s.

## Movimento retilíneo uniforme (MRU)

No MRU a velocidade é constante e a aceleração é zero. O corpo percorre distâncias iguais em tempos iguais. A função horária da posição é:

s = s₀ + v·t

Exemplo: um trem parte da posição 100 m com velocidade constante de 25 m/s. Depois de 8 s estará em s = 100 + 25 × 8 = 300 m.

No gráfico posição × tempo, o MRU é uma reta cuja inclinação é a velocidade. No gráfico velocidade × tempo, é uma reta horizontal, e a área sob ela é o deslocamento.

## Movimento uniformemente variado (MRUV)

No MRUV a aceleração é constante e diferente de zero: a velocidade muda sempre pela mesma quantidade a cada segundo. As equações são:

- v = v₀ + a·t
- s = s₀ + v₀·t + (a·t²)/2
- v² = v₀² + 2·a·Δs (equação de Torricelli, quando o tempo não é dado)

Se a aceleração tem o mesmo sinal da velocidade, o movimento é acelerado; se tem sinal contrário, é retardado (freada).

Exemplo: um carro a 30 m/s freia com aceleração de −5 m/s². Ele para quando v = 0: 0 = 30 − 5t, logo t = 6 s. A distância de frenagem, por Torricelli: 0 = 900 − 10·Δs, logo Δs = 90 m.

## Gráficos

No gráfico v × t do MRUV a curva é uma reta inclinada; a inclinação é a aceleração e a área sob a reta é o deslocamento. No gráfico s × t, a curva é uma parábola. Saber ler esses gráficos resolve boa parte das questões sem fórmula.

## Queda livre e lançamento vertical

Perto da superfície da Terra, desprezando o ar, todo corpo cai com a mesma aceleração g ≈ 10 m/s² (as provas quase sempre adotam esse valor). A queda livre é um MRUV com v₀ = 0 e a = g: h = g·t²/2 e v = g·t. Um objeto que cai de 20 m leva t = √(2 × 20 ÷ 10) = 2 s e chega ao chão a 20 m/s.

No lançamento vertical para cima, a velocidade diminui 10 m/s a cada segundo até zerar no ponto mais alto; o tempo de subida é igual ao de descida.

## Como isso cai nas provas

O ENEM prefere situações reais: velocidade média em viagens, leitura de gráficos de velocímetro, distância de frenagem e segurança no trânsito. A VUNESP cobra as funções horárias e problemas de encontro entre dois móveis. Em ambos, organize os dados (s₀, v₀, a, t) antes de escolher a equação.`,
  },
  {
    slug: 'estequiometria-calculos-a-partir-das-equacoes',
    subject: 'quimica',
    topic: 'estequiometria',
    subtopic: 'Relações mol–mol e massa–massa',
    title: 'Estequiometria: cálculos a partir das equações químicas',
    description: 'Passo a passo dos cálculos estequiométricos: mol, massa e volume; reagente limitante, pureza e rendimento.',
    duration_min: 45,
    difficulty: 3,
    exams: ALL,
    summary: `## O que é estequiometria

Estequiometria é o cálculo das quantidades de reagentes e produtos envolvidas em uma reação química. A base de tudo é a equação balanceada: os coeficientes indicam a proporção em mols entre as substâncias. Em 2 H₂ + O₂ → 2 H₂O, 2 mols de hidrogênio reagem com 1 mol de oxigênio e formam 2 mols de água. Essa proporção nunca muda; o que muda é a unidade em que a questão apresenta os dados.

## O passo a passo

1. **Escreva e balanceie a equação.** Sem balanceamento, a proporção está errada e todo o cálculo também.
2. **Converta o dado em mols.** Massa: divida pela massa molar (g/mol). Volume de gás nas CNTP: divida por 22,4 L/mol. Número de moléculas: divida por 6 × 10²³.
3. **Use a proporção dos coeficientes** para encontrar os mols da substância pedida.
4. **Converta o resultado** para a unidade solicitada: massa (multiplique pela massa molar), volume (multiplique por 22,4 L) ou número de partículas.

Exemplo: qual massa de água é produzida a partir de 4 g de H₂ com oxigênio suficiente? 4 g ÷ 2 g/mol = 2 mol de H₂. Pela proporção 2:2, formam-se 2 mol de H₂O, ou seja, 2 × 18 = 36 g.

## Reagente limitante

Quando a questão dá as quantidades de dois reagentes, um deles acaba primeiro: é o reagente limitante, e é ele que determina a quantidade de produto. Para descobri-lo, converta os dois em mols e compare com a proporção da equação. Em N₂ + 3 H₂ → 2 NH₃, 1 mol de N₂ precisa de 3 mol de H₂. Se houver 1 mol de N₂ e 4 mol de H₂, o H₂ está em excesso (sobra 1 mol) e o N₂ é o limitante: formam-se 2 mol de NH₃.

## Pureza

Reagentes reais contêm impurezas. Se um minério tem 80% de pureza, apenas 80% da massa participa da reação. Multiplique a massa total pela pureza antes de converter em mols.

## Rendimento

Nem toda reação converte 100% do reagente em produto. O rendimento é a razão entre a quantidade obtida e a quantidade teórica. Se o cálculo teórico prevê 50 g e o rendimento é 90%, obtêm-se 45 g. Quando pureza e rendimento aparecem juntos, aplique a pureza aos reagentes e o rendimento ao produto.

## Reações em sequência

Em processos com várias etapas (por exemplo, a produção de ácido sulfúrico), relacione os coeficientes das etapas para encontrar a proporção global entre o primeiro reagente e o produto final.

## Como isso cai nas provas

O ENEM contextualiza: combustíveis e emissão de CO₂, fertilizantes, tratamento de água, airbags. Os dados vêm no texto e as massas molares são fornecidas. A VUNESP cobra cálculos mais diretos, muitas vezes com pureza e rendimento no mesmo problema. Em ambos, a técnica é idêntica: balancear, converter em mols, aplicar a proporção e voltar à unidade pedida.

## Resumo

- Coeficientes = proporção em mols.
- Massa → mol → proporção → unidade pedida.
- Limitante determina o produto; pureza reduz o reagente; rendimento reduz o produto.`,
  },
];

// ---------------------------------------------------------------------
// QUESTÕES
// ---------------------------------------------------------------------
const LETTERS = ['A', 'B', 'C', 'D', 'E'];
let questionCounter = 0;

/**
 * Declara uma questão de demonstração. `options` tem exatamente 5 textos (A–E)
 * e `correct` é a letra da alternativa certa. O número sequencial vira o
 * identificador estável em `source` ('demo:07 — conteúdo de demonstração').
 */
function q(spec) {
  questionCounter += 1;
  const number = String(questionCounter).padStart(2, '0');
  if (!Array.isArray(spec.options) || spec.options.length !== 5) {
    throw new Error(`Questão demo:${number} precisa de exatamente 5 alternativas.`);
  }
  if (!LETTERS.includes(spec.correct)) {
    throw new Error(`Questão demo:${number} tem gabarito inválido: ${spec.correct}`);
  }
  return {
    source: `demo:${number} — conteúdo de demonstração`,
    board: BOARD,
    year: YEAR,
    subject: spec.subject,
    topic: spec.topic,
    subtopic: spec.subtopic || null,
    difficulty: spec.difficulty || 2,
    exams: spec.exams || ALL,
    statement: spec.statement,
    resolution: spec.resolution,
    explanation: spec.explanation,
    options: spec.options.map((text, index) => ({
      letter: LETTERS[index],
      text,
      is_correct: LETTERS[index] === spec.correct,
      sort_order: index + 1,
    })),
  };
}

const questions = [
  // ------------------------------------------------------------ Porcentagem
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Porcentagem de uma quantidade', difficulty: 1,
    statement: 'Uma loja anuncia um tênis por R$ 250,00 e oferece 12% de desconto para pagamento à vista. Qual é o valor a ser pago à vista?',
    options: ['R$ 212,00', 'R$ 220,00', 'R$ 225,00', 'R$ 230,00', 'R$ 238,00'],
    correct: 'B',
    resolution: '1. Um desconto de 12% deixa 100% − 12% = 88% do preço.\n2. Fator multiplicativo: 0,88.\n3. 250 × 0,88 = 220.\n\nValor à vista: R$ 220,00.',
    explanation: 'O caminho mais rápido é o fator de desconto (1 − 0,12 = 0,88). Calcular 12% de 250 (R$ 30,00) e subtrair leva ao mesmo resultado em dois passos. A alternativa D (R$ 230,00) corresponde a um desconto de 8%, erro típico de quem estima 12% como R$ 20,00.',
  }),
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Aumentos e descontos sucessivos', difficulty: 2,
    statement: 'O preço de um produto sofreu um aumento de 20% e, um mês depois, um desconto de 20% sobre o novo valor. Em relação ao preço original, o preço final ficou:',
    options: ['igual ao preço original.', '4% maior.', '4% menor.', '2% menor.', '40% menor.'],
    correct: 'C',
    resolution: '1. Aumento de 20%: fator 1,20.\n2. Desconto de 20%: fator 0,80.\n3. Fator acumulado: 1,20 × 0,80 = 0,96.\n4. 0,96 corresponde a 96% do original, ou seja, 4% a menos.',
    explanation: 'Porcentagens sucessivas não se somam nem se cancelam: o desconto de 20% incidiu sobre um valor maior (120%) e por isso retirou mais do que o aumento havia acrescentado. Conferindo com números: R$ 100 vira R$ 120 e depois R$ 96.',
  }),
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Variação percentual e lucro/prejuízo', difficulty: 2,
    statement: 'O salário de um funcionário passou de R$ 2.400,00 para R$ 2.640,00. Qual foi o percentual de reajuste?',
    options: ['8%', '9%', '10%', '12%', '24%'],
    correct: 'C',
    resolution: '1. Diferença: 2.640 − 2.400 = 240.\n2. Variação = 240 ÷ 2.400 = 0,10.\n3. 0,10 = 10%.',
    explanation: 'A variação percentual é sempre calculada sobre o valor inicial. Quem divide pelo valor final (240 ÷ 2.640 ≈ 9%) marca a alternativa B, que está errada.',
  }),
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Porcentagem de uma quantidade', difficulty: 1,
    statement: 'Uma escola tem 1.250 alunos, dos quais 36% estudam no período noturno. Quantos alunos estudam nos períodos diurnos?',
    options: ['450', '640', '720', '800', '864'],
    correct: 'D',
    resolution: '1. Se 36% estudam à noite, 100% − 36% = 64% estudam de dia.\n2. 64% de 1.250 = 1.250 × 0,64 = 800.',
    explanation: 'A alternativa A (450) é o número de alunos do noturno, que responde a outra pergunta. Ler o enunciado até o fim evita esse erro.',
  }),
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Variação percentual e lucro/prejuízo', difficulty: 3,
    statement: 'Um comerciante compra um produto por R$ 80,00 e deseja obter lucro de 25% sobre o preço de venda. Por quanto ele deve vender o produto?',
    options: ['R$ 100,00', 'R$ 104,00', 'R$ 106,67', 'R$ 110,00', 'R$ 120,00'],
    correct: 'C',
    resolution: '1. Seja V o preço de venda. Lucro = V − 80.\n2. O lucro deve ser 25% de V: V − 80 = 0,25V.\n3. 0,75V = 80, logo V = 80 ÷ 0,75 ≈ 106,67.',
    explanation: 'O referencial faz toda a diferença: lucro de 25% sobre o custo daria R$ 100,00 (alternativa A). Como o lucro é sobre a venda, o preço precisa ser maior. Sempre identifique sobre qual valor a porcentagem é calculada.',
  }),
  q({
    subject: 'matematica', topic: 'porcentagem', subtopic: 'Aumentos e descontos sucessivos', difficulty: 3,
    statement: 'A população de uma cidade era de 50.000 habitantes. Cresceu 10% no primeiro ano e 5% no segundo ano. Qual era a população ao fim do segundo ano?',
    options: ['57.500', '57.750', '58.000', '60.000', '65.000'],
    correct: 'B',
    resolution: '1. Fator do primeiro ano: 1,10. População: 50.000 × 1,10 = 55.000.\n2. Fator do segundo ano: 1,05. População: 55.000 × 1,05 = 57.750.',
    explanation: 'Somar os percentuais (15%) daria 57.500, alternativa A, que ignora que o segundo crescimento incide sobre a população já aumentada.',
  }),

  // ------------------------------------------------------------ Regra de três
  q({
    subject: 'matematica', topic: 'regra-de-tres', subtopic: 'Regra de três simples direta', difficulty: 1,
    statement: 'Uma impressora imprime 45 páginas em 3 minutos, em ritmo constante. Quantas páginas ela imprime em 8 minutos?',
    options: ['100', '110', '120', '135', '150'],
    correct: 'C',
    resolution: '1. Páginas e tempo são diretamente proporcionais.\n2. 45/3 = x/8, logo 3x = 360 e x = 120.\n\nOu: 45 ÷ 3 = 15 páginas por minuto; 15 × 8 = 120.',
    explanation: 'Mais tempo, mais páginas: relação direta, resolvida multiplicando em cruz ou calculando o ritmo por minuto.',
  }),
  q({
    subject: 'matematica', topic: 'regra-de-tres', subtopic: 'Regra de três simples inversa', difficulty: 2,
    statement: 'Seis operários, trabalhando no mesmo ritmo, constroem um muro em 10 dias. Em quantos dias 15 operários, no mesmo ritmo, construiriam o mesmo muro?',
    options: ['25 dias', '6 dias', '5 dias', '4 dias', '3 dias'],
    correct: 'D',
    resolution: '1. Mais operários, menos dias: grandezas inversamente proporcionais.\n2. 6 × 10 = 15 × d, logo 60 = 15d e d = 4.',
    explanation: 'Quem trata a relação como direta encontra 25 dias (alternativa A), o que não faz sentido: mais gente trabalhando deve terminar antes.',
  }),
  q({
    subject: 'matematica', topic: 'regra-de-tres', subtopic: 'Regra de três simples inversa', difficulty: 2,
    statement: 'Um ônibus, a 60 km/h, faz um trajeto em 2 horas e 30 minutos. Se a velocidade média fosse de 75 km/h, quanto tempo levaria o mesmo trajeto?',
    options: ['1 h 50 min', '2 h', '2 h 10 min', '3 h', '3 h 07 min'],
    correct: 'B',
    resolution: '1. Converta o tempo: 2 h 30 min = 150 min.\n2. Velocidade e tempo são inversamente proporcionais: 60 × 150 = 75 × t.\n3. t = 9.000 ÷ 75 = 120 min = 2 h.',
    explanation: 'A alternativa E (3 h 07 min) resulta de montar a proporção como direta. Converter para minutos antes de calcular evita erros com frações de hora.',
  }),
  q({
    subject: 'matematica', topic: 'regra-de-tres', subtopic: 'Regra de três composta', difficulty: 3,
    statement: 'Oito máquinas idênticas produzem 1.200 peças em 5 dias, funcionando 6 horas por dia. Quantas peças 10 dessas máquinas produzem em 8 dias, funcionando 9 horas por dia?',
    options: ['2.400', '2.880', '3.200', '3.600', '4.000'],
    correct: 'D',
    resolution: '1. Compare cada grandeza com "peças": mais máquinas, mais peças (direta); mais dias, mais peças (direta); mais horas, mais peças (direta).\n2. x = 1.200 × (10/8) × (8/5) × (9/6).\n3. x = 1.200 × 1,25 × 1,6 × 1,5 = 1.200 × 3 = 3.600.',
    explanation: 'Na regra composta, cada grandeza é comparada separadamente com a incógnita. Como todas são diretas, as razões entram na ordem "novo sobre antigo".',
  }),
  q({
    subject: 'matematica', topic: 'regra-de-tres', subtopic: 'Regra de três composta', difficulty: 3, exams: BB_VEST,
    statement: 'Doze trabalhadores, em 8 horas diárias, asfaltam 3 km de estrada em 15 dias. Em quantos dias 18 trabalhadores, em 6 horas diárias, asfaltam 4,5 km da mesma estrada?',
    options: ['10 dias', '12 dias', '15 dias', '18 dias', '20 dias'],
    correct: 'E',
    resolution: '1. Incógnita: dias. Mais trabalhadores, menos dias (inversa); mais horas por dia, menos dias (inversa); mais quilômetros, mais dias (direta).\n2. d = 15 × (12/18) × (8/6) × (4,5/3).\n3. 15 × (2/3) = 10; 10 × (4/3) = 40/3; (40/3) × 1,5 = 20.\n\nResposta: 20 dias.',
    explanation: 'As duas grandezas inversas (trabalhadores e horas) entram com a razão invertida; a grandeza direta (quilômetros) entra na ordem normal. Trocar apenas uma delas leva às alternativas A ou B.',
  }),

  // ------------------------------------------------------------ Interpretação de texto (inferência)
  q({
    subject: 'interpretacao-de-texto', topic: 'inferencia-pressupostos', subtopic: 'Pressupostos e marcadores', difficulty: 1,
    statement: 'Leia o aviso afixado na porta de uma padaria:\n\n> Voltamos a abrir aos domingos.\n\nA partir do aviso, é correto afirmar que a padaria',
    options: ['nunca abriu aos domingos.', 'deixou de abrir aos domingos por algum período.', 'abre apenas aos domingos.', 'vai fechar aos domingos.', 'abre todos os dias, sem exceção.'],
    correct: 'B',
    resolution: '1. A expressão "voltamos a" pressupõe que a ação já acontecia antes e foi interrompida.\n2. Logo, houve um período em que a padaria não abria aos domingos.\n3. As demais alternativas afirmam algo que o aviso não diz.',
    explanation: 'Verbos como voltar, continuar, parar e deixar de carregam pressupostos: informações implícitas garantidas pela própria palavra. A alternativa E extrapola, pois o aviso não fala dos outros dias.',
  }),
  q({
    subject: 'interpretacao-de-texto', topic: 'inferencia-pressupostos', subtopic: 'Subentendidos e contexto', difficulty: 2,
    statement: 'Leia o trecho de uma narrativa:\n\n> Marina olhou para o relógio pela terceira vez em cinco minutos, suspirou e guardou o celular na bolsa sem responder à mensagem.\n\nInfere-se do trecho que Marina',
    options: ['está atrasada para um compromisso e decidiu ir embora.', 'está impaciente ou ansiosa, provavelmente à espera de alguém ou de algo.', 'não sabe ler as horas no relógio.', 'está com o celular sem bateria.', 'recebeu uma boa notícia pela mensagem.'],
    correct: 'B',
    resolution: '1. Olhar o relógio três vezes em cinco minutos indica preocupação com o tempo.\n2. O suspiro reforça a inquietação.\n3. Guardar o celular sem responder mostra que a mensagem não é a prioridade.\n4. A conclusão sustentada pelo texto é a impaciência ou ansiedade de quem espera.',
    explanation: 'A alternativa A acrescenta informações que o texto não dá (atraso, ir embora). Uma boa inferência fica no limite do que as pistas sustentam.',
  }),
  q({
    subject: 'interpretacao-de-texto', topic: 'inferencia-pressupostos', subtopic: 'Pressupostos e marcadores', difficulty: 2,
    statement: 'Leia a manchete:\n\n> Prefeito promete, mais uma vez, concluir a obra do hospital até o fim do ano.\n\nA expressão "mais uma vez" permite concluir que',
    options: ['a obra será concluída até o fim do ano.', 'é a primeira vez que o prefeito fala sobre o hospital.', 'o prefeito já havia feito a mesma promessa anteriormente.', 'a obra do hospital ainda não começou.', 'o prefeito foi reeleito.'],
    correct: 'C',
    resolution: '1. "Mais uma vez" indica repetição de um ato.\n2. O ato repetido é a promessa de concluir a obra.\n3. Portanto, houve promessa anterior, provavelmente não cumprida, o que dá tom crítico à manchete.',
    explanation: 'A alternativa A confunde promessa com fato. As alternativas D e E não têm apoio no texto.',
  }),
  q({
    subject: 'interpretacao-de-texto', topic: 'inferencia-pressupostos', subtopic: 'Ironia e duplo sentido', difficulty: 3,
    statement: 'Leia o diálogo:\n\n> — Excelente ideia deixar a janela do carro aberta na noite de chuva — disse Paulo ao amigo, enquanto secava o banco com uma toalha.\n\nNa fala de Paulo, a expressão "excelente ideia"',
    options: ['elogia sinceramente a atitude do amigo.', 'é usada com ironia, para criticar o amigo por ter deixado a janela aberta.', 'sugere que o amigo lave o carro com mais frequência.', 'indica que Paulo ficou satisfeito por a chuva ter lavado o carro.', 'mostra que o amigo fechou a janela a tempo.'],
    correct: 'B',
    resolution: '1. O contexto (banco molhado, toalha) mostra um resultado negativo.\n2. Um elogio diante de um resultado negativo é sinal de ironia: diz-se o contrário do que se pensa.\n3. O objetivo da fala é criticar o descuido do amigo.',
    explanation: 'A ironia se reconhece pelo contraste entre a fala e a situação. Ler literalmente leva à alternativa A.',
  }),
  q({
    subject: 'interpretacao-de-texto', topic: 'inferencia-pressupostos', subtopic: 'Subentendidos e contexto', difficulty: 3,
    statement: 'Leia o trecho de um anúncio de emprego:\n\n> Candidatos com experiência comprovada em atendimento ao público terão prioridade.\n\nDo trecho, subentende-se que',
    options: ['somente candidatos com experiência podem se inscrever.', 'a experiência é o único critério de seleção.', 'candidatos sem experiência podem se candidatar, mas terão menor prioridade.', 'todos os candidatos serão tratados da mesma forma.', 'a vaga é exclusiva para quem já trabalhou na empresa.'],
    correct: 'C',
    resolution: '1. "Terão prioridade" significa serem preferidos ou avaliados antes, não exclusividade.\n2. Se há prioridade para um grupo, existe outro grupo sem prioridade: os candidatos sem experiência.\n3. Logo, estes podem se candidatar, com chances menores.',
    explanation: 'A alternativa A transforma prioridade em exigência, e a B em critério único. Subentendidos exigem atenção ao que a palavra escolhida deixa em aberto.',
  }),

  // ------------------------------------------------------------ Revolução Industrial
  q({
    subject: 'historia', topic: 'revolucao-industrial', subtopic: 'Pioneirismo inglês e cercamentos', difficulty: 1,
    statement: 'Entre os fatores que explicam o pioneirismo da Inglaterra na Revolução Industrial, no século XVIII, estão:',
    options: [
      'a abundância de mão de obra escravizada nas fábricas e a proibição do comércio exterior.',
      'o acúmulo de capital pelo comércio, as reservas de carvão e ferro, a mão de obra liberada pelos cercamentos e o mercado consumidor colonial.',
      'a ausência de colônias, que obrigou o país a produzir internamente tudo o que consumia.',
      'a liderança da nobreza feudal, interessada em preservar a servidão no campo.',
      'o financiamento das primeiras fábricas pela Igreja católica.',
    ],
    correct: 'B',
    resolution: '1. Capital: comércio colonial e tráfico atlântico.\n2. Recursos naturais: carvão e ferro.\n3. Mão de obra: camponeses expulsos pelos cercamentos.\n4. Mercado: colônias e a maior marinha mercante da época.\n5. Ambiente político favorável à burguesia após a Revolução Gloriosa.',
    explanation: 'As demais alternativas contradizem o contexto: a Inglaterra tinha amplo império colonial e sua indústria empregava trabalhadores assalariados livres, não escravizados.',
  }),
  q({
    subject: 'historia', topic: 'revolucao-industrial', subtopic: 'Pioneirismo inglês e cercamentos', difficulty: 2,
    statement: 'Os cercamentos (enclosures), ocorridos na Inglaterra entre os séculos XVI e XVIII, consistiram',
    options: [
      'na fortificação das cidades industriais contra invasões estrangeiras.',
      'na privatização de terras comunais, que expulsou camponeses e formou a mão de obra disponível para as fábricas.',
      'na construção de muros em torno das fábricas para impedir greves.',
      'na divisão do território inglês em distritos industriais planejados pelo Estado.',
      'na proibição da exportação de lã para os Países Baixos.',
    ],
    correct: 'B',
    resolution: '1. Terras de uso coletivo foram cercadas e convertidas em propriedade privada, sobretudo para a criação de ovelhas.\n2. Camponeses perderam o acesso à terra e migraram para as cidades.\n3. Formou-se um contingente de trabalhadores livres e sem propriedade, que se tornaria o proletariado industrial.',
    explanation: 'Os cercamentos ligam a mudança no campo à formação da mão de obra urbana, elo central para explicar o pioneirismo inglês.',
  }),
  q({
    subject: 'historia', topic: 'revolucao-industrial', subtopic: 'Movimentos operários: ludismo, cartismo e sindicatos', difficulty: 2,
    statement: 'No início do século XIX, grupos de trabalhadores ingleses invadiram fábricas e destruíram máquinas, responsabilizando-as pelo desemprego e pela queda dos salários. Esse movimento ficou conhecido como',
    options: ['ludismo.', 'cartismo.', 'trade-unionismo.', 'socialismo utópico.', 'fordismo.'],
    correct: 'A',
    resolution: '1. A destruição de máquinas como forma de protesto caracteriza o ludismo, nome derivado do lendário Ned Ludd.\n2. O cartismo reivindicava direitos políticos por meio da Carta do Povo.\n3. Os sindicatos (trade unions) negociavam salários; o socialismo utópico propunha comunidades ideais; o fordismo é um modelo de produção do século XX.',
    explanation: 'Ludismo e cartismo são frequentemente confundidos: o primeiro ataca as máquinas, o segundo pede voto e representação política.',
  }),
  q({
    subject: 'historia', topic: 'revolucao-industrial', subtopic: 'Primeira e Segunda Revolução Industrial', difficulty: 2,
    statement: 'A Segunda Revolução Industrial, a partir da segunda metade do século XIX, caracterizou-se',
    options: [
      'pelo uso da máquina a vapor e do tear mecânico na indústria têxtil, restrita à Inglaterra.',
      'pelo aço, pela eletricidade, pelo petróleo, pela indústria química e pelo motor a combustão, com a industrialização da Alemanha, dos Estados Unidos e do Japão.',
      'pela informática, pela robótica e pela automação dos processos produtivos.',
      'pelo retorno à produção artesanal em pequenas oficinas.',
      'pelo uso da energia nuclear como principal fonte das fábricas.',
    ],
    correct: 'B',
    resolution: '1. A primeira fase (vapor, têxtil, carvão) é a da alternativa A.\n2. A segunda fase troca o carvão pela eletricidade e pelo petróleo, e o ferro pelo aço; surgem a química industrial e o motor a combustão.\n3. A industrialização se espalha para além da Inglaterra.',
    explanation: 'Informática e automação (alternativa C) pertencem à chamada Terceira Revolução Industrial, a partir da segunda metade do século XX.',
  }),
  q({
    subject: 'historia', topic: 'revolucao-industrial', subtopic: 'Condições de trabalho e urbanização', difficulty: 3,
    statement: 'Relatórios do Parlamento inglês do século XIX descrevem jornadas de 14 a 16 horas, trabalho de crianças a partir dos seis anos e bairros operários sem esgoto. Essas condições contribuíram diretamente para',
    options: [
      'o fim imediato do trabalho infantil em toda a Europa.',
      'a organização dos trabalhadores em sindicatos, o surgimento do ludismo e do cartismo e a formulação das doutrinas socialistas críticas ao capitalismo industrial.',
      'o retorno da população das cidades ao campo e a restauração do sistema feudal.',
      'a proibição definitiva do uso de máquinas nas fábricas inglesas.',
      'a criação da Liga das Nações para regular o trabalho.',
    ],
    correct: 'B',
    resolution: '1. A exploração intensa gerou reação organizada dos trabalhadores.\n2. Primeiro vieram o ludismo e as associações de ofício; depois o cartismo e os sindicatos legalizados.\n3. No plano das ideias, o socialismo utópico e o socialismo científico de Marx e Engels criticaram o sistema.',
    explanation: 'As alternativas A, C e D descrevem resultados que não ocorreram; a Liga das Nações só surgiu em 1919, após a Primeira Guerra.',
  }),

  // ------------------------------------------------------------ Cinemática
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Movimento retilíneo uniforme (MRU)', difficulty: 1,
    statement: 'Um carro percorre uma rodovia com velocidade constante de 90 km/h. Que distância ele percorre em 20 minutos?',
    options: ['18 km', '25 km', '30 km', '45 km', '180 km'],
    correct: 'C',
    resolution: '1. 20 minutos = 1/3 de hora.\n2. Δs = v × t = 90 × (1/3) = 30 km.',
    explanation: 'A alternativa E surge de multiplicar 90 por 20 sem converter minutos em horas. Unidades coerentes são o primeiro passo em cinemática.',
  }),
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Posição, deslocamento e velocidade média', difficulty: 1,
    statement: 'A velocidade de 108 km/h corresponde, em metros por segundo, a',
    options: ['10 m/s', '20 m/s', '30 m/s', '36 m/s', '388,8 m/s'],
    correct: 'C',
    resolution: '1. Para converter km/h em m/s, divida por 3,6.\n2. 108 ÷ 3,6 = 30 m/s.',
    explanation: 'A alternativa E resulta de multiplicar por 3,6 (o caminho inverso). Lembre: 1 km = 1.000 m e 1 h = 3.600 s, então 1 km/h = 1.000/3.600 m/s = 1/3,6 m/s.',
  }),
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Movimento uniformemente variado (MRUV)', difficulty: 2,
    statement: 'Um carro parte do repouso com aceleração constante de 2 m/s². Após 8 segundos, sua velocidade e a distância percorrida são, respectivamente,',
    options: ['16 m/s e 64 m', '16 m/s e 128 m', '8 m/s e 64 m', '4 m/s e 32 m', '16 m/s e 32 m'],
    correct: 'A',
    resolution: '1. v = v₀ + a·t = 0 + 2 × 8 = 16 m/s.\n2. Δs = v₀·t + a·t²/2 = 0 + (2 × 64)/2 = 64 m.',
    explanation: 'A alternativa B (128 m) esquece de dividir por 2 na equação da posição; a E (32 m) divide duas vezes.',
  }),
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Movimento uniformemente variado (MRUV)', difficulty: 2,
    statement: 'Um motorista a 20 m/s aciona os freios e o carro passa a desacelerar a 4 m/s² até parar. Qual é a distância percorrida durante a frenagem?',
    options: ['5 m', '25 m', '40 m', '50 m', '100 m'],
    correct: 'D',
    resolution: '1. Dados: v₀ = 20 m/s, v = 0, a = −4 m/s².\n2. Torricelli: v² = v₀² + 2·a·Δs, logo 0 = 400 − 8·Δs.\n3. Δs = 400 ÷ 8 = 50 m.',
    explanation: 'Como o tempo não é dado, a equação de Torricelli é o caminho mais curto. A alternativa B (25 m) vem de esquecer o fator 2; a A (5 m) é o tempo de frenagem, não a distância.',
  }),
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Queda livre e lançamento vertical', difficulty: 3,
    statement: 'Um objeto é abandonado do alto de um prédio de 45 m de altura. Desprezando a resistência do ar e adotando g = 10 m/s², o tempo de queda e a velocidade ao atingir o solo são, respectivamente,',
    options: ['3 s e 30 m/s', '4,5 s e 45 m/s', '3 s e 15 m/s', '9 s e 90 m/s', '2 s e 20 m/s'],
    correct: 'A',
    resolution: '1. h = g·t²/2, logo 45 = 5·t², t² = 9 e t = 3 s.\n2. v = g·t = 10 × 3 = 30 m/s.',
    explanation: 'Queda livre é um MRUV com velocidade inicial zero e aceleração g. A alternativa C erra a velocidade ao usar a velocidade média (15 m/s) no lugar da final.',
  }),
  q({
    subject: 'fisica', topic: 'cinematica-mru-mruv', subtopic: 'Movimento retilíneo uniforme (MRU)', difficulty: 3, exams: BB_VEST,
    statement: 'Dois carros se movem em uma mesma estrada retilínea, um em direção ao outro. O carro A parte da posição 0 m com velocidade constante de 20 m/s, e o carro B parte, no mesmo instante, da posição 300 m com velocidade constante de 30 m/s. Em que instante e em que posição eles se encontram?',
    options: ['6 s e 120 m', '6 s e 180 m', '10 s e 200 m', '15 s e 300 m', '5 s e 100 m'],
    correct: 'A',
    resolution: '1. Funções horárias: s_A = 20t e s_B = 300 − 30t.\n2. Encontro: s_A = s_B, logo 20t = 300 − 30t, 50t = 300 e t = 6 s.\n3. Posição: s_A = 20 × 6 = 120 m.',
    explanation: 'A velocidade relativa (50 m/s) fecha a distância de 300 m em 6 s. A alternativa B confunde a posição do encontro com a distância percorrida por B (180 m).',
  }),

  // ------------------------------------------------------------ Estequiometria
  q({
    subject: 'quimica', topic: 'estequiometria', subtopic: 'Relações mol–mol e massa–massa', difficulty: 1,
    statement: 'Considere a reação de formação da água: 2 H₂ + O₂ → 2 H₂O. Quantos mols de água são produzidos a partir de 4 mols de gás hidrogênio, com oxigênio em excesso?',
    options: ['1 mol', '2 mols', '4 mols', '6 mols', '8 mols'],
    correct: 'C',
    resolution: '1. Proporção da equação: 2 mol de H₂ produzem 2 mol de H₂O (1:1).\n2. 4 mol de H₂ produzem 4 mol de H₂O.',
    explanation: 'Os coeficientes dão a proporção em mols. Como a relação entre H₂ e H₂O é 1:1, a quantidade de água é igual à de hidrogênio.',
  }),
  q({
    subject: 'quimica', topic: 'estequiometria', subtopic: 'Relações mol–mol e massa–massa', difficulty: 2,
    statement: 'Na combustão completa do metano (CH₄ + 2 O₂ → CO₂ + 2 H₂O), qual é a massa de gás carbônico produzida pela queima de 16 g de metano? Dados (g/mol): C = 12, H = 1, O = 16.',
    options: ['16 g', '22 g', '32 g', '44 g', '88 g'],
    correct: 'D',
    resolution: '1. Massa molar do CH₄ = 12 + 4 × 1 = 16 g/mol; 16 g correspondem a 1 mol.\n2. Proporção 1 CH₄ : 1 CO₂, logo forma-se 1 mol de CO₂.\n3. Massa molar do CO₂ = 12 + 2 × 16 = 44 g/mol; massa = 44 g.',
    explanation: 'Massa para mol, proporção, mol para massa. A alternativa A confunde a massa do reagente com a do produto.',
  }),
  q({
    subject: 'quimica', topic: 'estequiometria', subtopic: 'Cálculos com volume de gases', difficulty: 2,
    statement: 'Qual é o volume de gás oxigênio, medido nas CNTP, necessário para a combustão completa de 8 g de gás hidrogênio? Dados: 2 H₂ + O₂ → 2 H₂O; H = 1 g/mol; volume molar nas CNTP = 22,4 L/mol.',
    options: ['11,2 L', '22,4 L', '44,8 L', '89,6 L', '179,2 L'],
    correct: 'C',
    resolution: '1. 8 g de H₂ ÷ 2 g/mol = 4 mol de H₂.\n2. Proporção 2 H₂ : 1 O₂, logo são necessários 2 mol de O₂.\n3. 2 mol × 22,4 L/mol = 44,8 L.',
    explanation: 'A alternativa D (89,6 L) usa 4 mol de O₂, ignorando a proporção 2:1 da equação.',
  }),
  q({
    subject: 'quimica', topic: 'estequiometria', subtopic: 'Reagente limitante e em excesso', difficulty: 3,
    statement: 'Em um reator, 28 g de N₂ reagem com 9 g de H₂ para formar amônia (N₂ + 3 H₂ → 2 NH₃). Considerando N = 14 g/mol e H = 1 g/mol, a massa máxima de amônia obtida é',
    options: ['17 g', '34 g', '51 g', '37 g', '68 g'],
    correct: 'B',
    resolution: '1. Mols: N₂ = 28 ÷ 28 = 1 mol; H₂ = 9 ÷ 2 = 4,5 mol.\n2. 1 mol de N₂ precisa de 3 mol de H₂; há 4,5 mol, logo o H₂ está em excesso e o N₂ é o limitante.\n3. 1 mol de N₂ produz 2 mol de NH₃ = 2 × 17 = 34 g.',
    explanation: 'A alternativa C (51 g) resulta de calcular pelo H₂ (4,5 mol geram 3 mol de NH₃), ignorando que o N₂ acaba primeiro. O reagente limitante sempre determina o produto.',
  }),
  q({
    subject: 'quimica', topic: 'estequiometria', subtopic: 'Pureza e rendimento', difficulty: 3, exams: BB_VEST,
    statement: 'Uma amostra de 200 g de calcário com 80% de carbonato de cálcio é aquecida, decompondo-se em óxido de cálcio e gás carbônico (CaCO₃ → CaO + CO₂). Se o rendimento do processo é de 90%, a massa de óxido de cálcio obtida é, aproximadamente, (dados: Ca = 40, C = 12, O = 16 g/mol)',
    options: ['56,0 g', '80,6 g', '89,6 g', '100,8 g', '112,0 g'],
    correct: 'B',
    resolution: '1. Pureza: 200 × 0,80 = 160 g de CaCO₃.\n2. Massa molar do CaCO₃ = 100 g/mol, logo 1,6 mol.\n3. Proporção 1:1, logo 1,6 mol de CaO × 56 g/mol = 89,6 g (valor teórico).\n4. Rendimento de 90%: 89,6 × 0,90 ≈ 80,6 g.',
    explanation: 'A alternativa C é o valor teórico sem aplicar o rendimento; a D ignora a pureza. Pureza reduz o reagente; rendimento reduz o produto.',
  }),

  // ------------------------------------------------------------ Funções
  q({
    subject: 'matematica', topic: 'funcao-afim', subtopic: 'Aplicações: tarifas, velocidade e custo', difficulty: 1,
    statement: 'Uma corrida de táxi custa R$ 5,00 de bandeirada mais R$ 2,50 por quilômetro rodado. Quanto custa uma corrida de 12 km?',
    options: ['R$ 30,00', 'R$ 32,50', 'R$ 35,00', 'R$ 37,50', 'R$ 42,50'],
    correct: 'C',
    resolution: '1. Função do custo: C(x) = 5 + 2,5x, em que x é a distância em km.\n2. C(12) = 5 + 2,5 × 12 = 5 + 30 = 35.',
    explanation: 'A bandeirada é o coeficiente linear (valor fixo) e o preço por quilômetro é o coeficiente angular (taxa de variação). A alternativa A esquece a bandeirada.',
  }),
  q({
    subject: 'matematica', topic: 'funcao-afim', subtopic: 'Lei da função afim e coeficientes angular e linear', difficulty: 2,
    statement: 'Uma função afim f(x) = ax + b satisfaz f(2) = 7 e f(5) = 16. O valor de f(10) é',
    options: ['25', '28', '30', '31', '34'],
    correct: 'D',
    resolution: '1. Coeficiente angular: a = (16 − 7) ÷ (5 − 2) = 9 ÷ 3 = 3.\n2. Coeficiente linear: 7 = 3 × 2 + b, logo b = 1.\n3. f(x) = 3x + 1, portanto f(10) = 31.',
    explanation: 'Dois pontos determinam a reta: a taxa de variação vem da razão entre as diferenças, e o coeficiente linear vem da substituição de um dos pontos.',
  }),
  q({
    subject: 'matematica', topic: 'funcao-quadratica', subtopic: 'Vértice, valor máximo e mínimo', difficulty: 3,
    statement: 'A altura de uma bola lançada para cima, em metros, em função do tempo t em segundos, é dada por h(t) = −5t² + 20t. Qual é a altura máxima atingida pela bola?',
    options: ['10 m', '15 m', '20 m', '25 m', '40 m'],
    correct: 'C',
    resolution: '1. Parábola com concavidade para baixo (a = −5): o vértice é o ponto máximo.\n2. t do vértice = −b/(2a) = −20/(−10) = 2 s.\n3. h(2) = −5 × 4 + 20 × 2 = −20 + 40 = 20 m.',
    explanation: 'Também é possível usar h do vértice = −Δ/(4a) = −400/(−20) = 20. A alternativa E (40 m) é o valor de 20t no instante 2 s, sem descontar o termo quadrático.',
  }),

  // ------------------------------------------------------------ Probabilidade
  q({
    subject: 'matematica', topic: 'probabilidade', subtopic: 'Probabilidade de um evento e evento complementar', difficulty: 1,
    statement: 'Ao lançar um dado comum de seis faces, qual é a probabilidade de sair um número maior que 4?',
    options: ['1/6', '1/3', '1/2', '2/3', '5/6'],
    correct: 'B',
    resolution: '1. Espaço amostral: {1, 2, 3, 4, 5, 6}, 6 resultados.\n2. Maiores que 4: {5, 6}, 2 resultados.\n3. P = 2/6 = 1/3.',
    explanation: '"Maior que 4" não inclui o 4. Quem inclui chega a 3/6 = 1/2, alternativa C.',
  }),
  q({
    subject: 'matematica', topic: 'probabilidade', subtopic: 'Probabilidade condicional', difficulty: 2,
    statement: 'Uma urna contém 5 bolas vermelhas e 3 bolas azuis. Duas bolas são retiradas ao acaso, sem reposição. Qual é a probabilidade de ambas serem vermelhas?',
    options: ['25/64', '5/14', '3/8', '15/56', '1/2'],
    correct: 'B',
    resolution: '1. Primeira vermelha: 5/8.\n2. Segunda vermelha, dado que a primeira foi vermelha: 4/7 (sobram 4 vermelhas em 7 bolas).\n3. P = 5/8 × 4/7 = 20/56 = 5/14.',
    explanation: 'Sem reposição, a segunda retirada depende da primeira. A alternativa A (25/64) seria a resposta com reposição.',
  }),
  q({
    subject: 'matematica', topic: 'probabilidade', subtopic: 'Probabilidade da união e eventos mutuamente exclusivos', difficulty: 3,
    statement: 'Em uma turma de 40 alunos, 24 gostam de matemática, 18 gostam de física e 10 gostam das duas disciplinas. Escolhendo um aluno ao acaso, qual é a probabilidade de ele gostar de pelo menos uma das duas?',
    options: ['1/4', '3/5', '7/10', '4/5', '21/20'],
    correct: 'D',
    resolution: '1. União: 24 + 18 − 10 = 32 alunos gostam de pelo menos uma.\n2. P = 32/40 = 4/5.',
    explanation: 'Somar sem descontar a interseção dá 42/40 (alternativa E), impossível, pois probabilidade não passa de 1. A alternativa A (1/4) é a probabilidade de gostar das duas.',
  }),

  // ------------------------------------------------------------ Concordância
  q({
    subject: 'gramatica', topic: 'concordancia', subtopic: 'Verbos impessoais e casos especiais', difficulty: 1,
    statement: 'Assinale a alternativa em que a concordância verbal está de acordo com a norma-padrão.',
    options: ['Fazem dois anos que ele se formou.', 'Faz dois anos que ele se formou.', 'Houveram muitos problemas na obra.', 'Existe muitos alunos na sala.', 'Chegou os convidados atrasados.'],
    correct: 'B',
    resolution: '1. O verbo fazer indicando tempo decorrido é impessoal e fica no singular: "faz dois anos".\n2. Haver no sentido de existir também é impessoal: "houve muitos problemas".\n3. Existir é pessoal e concorda com o sujeito: "existem muitos alunos".\n4. Em "chegaram os convidados", o sujeito posposto continua exigindo concordância.',
    explanation: 'Fazer (tempo) e haver (existir) são os verbos impessoais mais cobrados: nunca vão ao plural nesses sentidos.',
  }),
  q({
    subject: 'gramatica', topic: 'concordancia', subtopic: 'Concordância com expressões partitivas e coletivos', difficulty: 2,
    statement: 'Assinale a alternativa em que a concordância verbal está correta.',
    options: ['Vossa Excelência estais enganado.', 'Os Estados Unidos anunciou novas medidas.', 'Cerca de vinte pessoas compareceram à reunião.', 'Já deu dez horas.', 'Nem o professor nem os alunos sabia do exercício.'],
    correct: 'C',
    resolution: '1. "Cerca de" seguido de numeral: o verbo concorda com o numeral ("compareceram").\n2. Pronomes de tratamento levam o verbo à 3ª pessoa: "Vossa Excelência está".\n3. Nomes próprios no plural com artigo: "Os Estados Unidos anunciaram".\n4. Dar indicando horas concorda com o número de horas: "deram dez horas".\n5. Sujeito composto com "nem... nem": verbo no plural ("sabiam").',
    explanation: 'Cada alternativa errada representa um caso especial frequente em prova: pronome de tratamento, nome próprio plural, verbo dar com horas e sujeito composto.',
  }),
  q({
    subject: 'gramatica', topic: 'concordancia', subtopic: 'Concordância nominal: regras e casos especiais', difficulty: 3,
    statement: 'Assinale a alternativa correta quanto à concordância nominal.',
    options: ['É proibido a entrada de estranhos.', 'Seguem anexo os documentos solicitados.', 'Ela mesmo resolveu o problema.', 'Bastante alunos faltaram à aula.', 'Água é bom para a saúde.'],
    correct: 'E',
    resolution: '1. "É proibido", "é bom", "é necessário" ficam invariáveis quando o substantivo vem sem artigo: "Água é bom". Com artigo, concordam: "A água é boa", "É proibida a entrada".\n2. "Anexo" é adjetivo e concorda: "seguem anexos os documentos".\n3. "Mesmo" concorda com o nome a que se refere: "ela mesma".\n4. "Bastante" como adjetivo (= muitos) vai ao plural: "bastantes alunos".',
    explanation: 'Os casos especiais de concordância nominal são frequentes na VUNESP; a regra do artigo em "é proibido / é bom" é a mais cobrada.',
  }),

  // ------------------------------------------------------------ Urbanização
  q({
    subject: 'geografia', topic: 'urbanizacao', subtopic: 'Urbanização mundial e brasileira', difficulty: 1,
    statement: 'Em Geografia, o termo urbanização designa',
    options: [
      'o crescimento da população rural em relação à urbana.',
      'o aumento da população urbana em ritmo superior ao da rural, até que a população das cidades passe a predominar.',
      'apenas o crescimento físico de uma cidade, com a construção de novos bairros.',
      'a migração da população das cidades para o campo.',
      'a verticalização das áreas centrais.',
    ],
    correct: 'B',
    resolution: '1. Urbanização é um processo demográfico: a proporção de pessoas que vivem em cidades cresce.\n2. O crescimento físico da cidade (alternativa C) é consequência, não definição.\n3. As alternativas A e D descrevem o movimento contrário.',
    explanation: 'Uma cidade pode crescer fisicamente sem que o país se urbanize; a urbanização se mede pela proporção entre população urbana e rural.',
  }),
  q({
    subject: 'geografia', topic: 'urbanizacao', subtopic: 'Urbanização mundial e brasileira', difficulty: 2,
    statement: 'Sobre a urbanização brasileira, é correto afirmar que',
    options: [
      'ocorreu no século XVIII, impulsionada pela mineração em Minas Gerais.',
      'ocorreu de forma acelerada a partir da década de 1950, impulsionada pela industrialização e pelo êxodo rural, sem planejamento adequado, o que gerou periferias sem infraestrutura.',
      'foi lenta e planejada, semelhante à dos países europeus.',
      'resultou das políticas de reforma agrária, que fixaram a população no campo.',
      'concentrou-se na região Norte, por causa da exploração da borracha.',
    ],
    correct: 'B',
    resolution: '1. Até 1950 o Brasil era majoritariamente rural.\n2. A industrialização do Centro-Sul e a mecanização do campo provocaram o êxodo rural.\n3. Em poucas décadas, a população urbana ultrapassou a rural (Censo de 1970).\n4. O ritmo acelerado e a falta de planejamento produziram favelas, loteamentos irregulares e déficit de serviços.',
    explanation: 'A urbanização brasileira é descrita como tardia (em relação à Europa), acelerada e concentrada, marcada pela metropolização e pela desigualdade.',
  }),
  q({
    subject: 'geografia', topic: 'urbanizacao', subtopic: 'Segregação socioespacial e periferização', difficulty: 3,
    statement: 'A segregação socioespacial nas metrópoles brasileiras caracteriza-se',
    options: [
      'pela distribuição igualitária de serviços públicos entre centro e periferia.',
      'pela ocupação de áreas distintas da cidade por grupos de renda diferente, com a população pobre concentrada em periferias e áreas de risco, distantes dos empregos e dos serviços.',
      'pela migração dos moradores de alta renda para as áreas rurais.',
      'pela criação de distritos industriais afastados das áreas residenciais.',
      'pelo tombamento dos centros históricos.',
    ],
    correct: 'B',
    resolution: '1. O preço do solo urbano seleciona quem pode morar onde.\n2. Grupos de maior renda ocupam áreas bem servidas; os de menor renda vão para periferias, encostas e várzeas.\n3. Resultado: longos deslocamentos, menor acesso a serviços e maior exposição a riscos ambientais.',
    explanation: 'Segregação socioespacial é a expressão territorial da desigualdade social. As demais alternativas descrevem outros processos urbanos ou situações inexistentes.',
  }),
  q({
    subject: 'geografia', topic: 'urbanizacao', subtopic: 'Rede urbana, metrópoles e megalópoles', difficulty: 2,
    statement: 'O processo pelo qual cidades vizinhas crescem até se unirem fisicamente, formando uma mancha urbana contínua, é chamado de',
    options: ['conurbação.', 'verticalização.', 'gentrificação.', 'macrocefalia urbana.', 'hierarquia urbana.'],
    correct: 'A',
    resolution: '1. Conurbação é a junção física de cidades por crescimento horizontal contínuo, base das regiões metropolitanas (como a Grande São Paulo).\n2. Verticalização é o adensamento em edifícios altos; gentrificação é a valorização que expulsa moradores antigos; macrocefalia é a concentração excessiva em uma única cidade; hierarquia urbana é a classificação das cidades pela área de influência.',
    explanation: 'Os termos são próximos e costumam aparecer juntos nas alternativas; distinga cada processo pela sua definição.',
  }),
];

// ---------------------------------------------------------------------
// PROFESSOR PARA AULAS PARTICULARES
// ---------------------------------------------------------------------
const teachers = [
  {
    email: 'ana.moreira@demo.focoelite.com.br',
    name: 'Ana Beatriz Moreira',
    phone: null,
    bio:
      'Licenciada em Matemática, com mais de dez anos de experiência em cursinhos preparatórios ' +
      'para o ENEM e para concursos militares. Trabalha a base de aritmética e funções com quem ' +
      'voltou a estudar depois de um tempo e treina resolução de questões no estilo VUNESP e INEP.',
    photo_url: null,
    hourly_price_cents: 9000,
    slot_minutes: 60,
    meeting_link: null,
    sort_order: 1,
    subjects: ['matematica', 'fisica'],
    // segunda (1) a sexta (5), 18:00–21:00
    availability: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: '18:00', end_time: '21:00' })),
  },
];

// ---------------------------------------------------------------------
// MODELOS DE SIMULADO (type 'exam', sem question_ids: sorteio pelos filtros)
// ---------------------------------------------------------------------
const simulados = [
  {
    key: 'demo:simulado-enem',
    name: 'Simulado ENEM: modelo geral',
    description:
      'Simulado no formato do ENEM com questões das quatro áreas sorteadas do banco. Recomendado a ' +
      'cada duas semanas para acompanhar a evolução e alimentar o caderno de erros.',
    type: 'exam',
    exam: 'enem',
    duration_min: 150,
    question_count: 45,
    config: { distribution: 'balanced_by_subject', shuffle_questions: true, demo: true },
  },
  {
    key: 'demo:simulado-barro-branco',
    name: 'Simulado Barro Branco: modelo VUNESP',
    description:
      'Simulado com a distribuição de matérias da prova objetiva de Aluno-Oficial da PM-SP: ' +
      'Português, Matemática, Conhecimentos Gerais, Informática e Noções de Administração Pública.',
    type: 'exam',
    exam: 'barro-branco',
    duration_min: 120,
    question_count: 40,
    config: { distribution: 'balanced_by_subject', shuffle_questions: true, demo: true },
  },
];

module.exports = {
  TEACHER_NAME,
  BOARD,
  lessons,
  questions,
  teachers,
  simulados,
};

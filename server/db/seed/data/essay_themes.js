'use strict';

/**
 * Temas de redação iniciais (tabela essay_themes).
 *
 * Cada tema tem: exam (slug da prova ou null = serve para todas), title, prompt_text
 * (a proposta completa, no formato da banca), support_texts (textos motivadores em
 * markdown, escritos pela equipe para fins didáticos — sem trechos de obras
 * protegidas) e source.
 *
 * Chave de idempotência: (exam, title).
 */

const ENEM_PROMPT = (theme) =>
  'A partir da leitura dos textos motivadores e com base nos conhecimentos construídos ao longo ' +
  'de sua formação, redija um texto dissertativo-argumentativo, em modalidade escrita formal da ' +
  `língua portuguesa, sobre o tema "${theme}", apresentando proposta de intervenção que ` +
  'respeite os direitos humanos. Selecione, organize e relacione, de forma coerente e coesa, ' +
  'argumentos e fatos para a defesa de seu ponto de vista.\n\n' +
  'Instruções: o rascunho não será corrigido; o texto definitivo deve ter no máximo 30 linhas; ' +
  'a redação com até 7 linhas receberá nota zero; cópia dos textos motivadores, fuga ao tema ' +
  'ou texto que não atenda ao tipo dissertativo-argumentativo também recebem nota zero.';

const VUNESP_PROMPT = (theme) =>
  'Com base nos textos apresentados e em seus próprios conhecimentos, escreva um texto ' +
  'dissertativo-argumentativo, em norma-padrão da língua portuguesa, sobre o tema: ' +
  `"${theme}".\n\n` +
  'Instruções: o texto deve ter entre 20 e 30 linhas, em prosa, com posicionamento claro e ' +
  'argumentos que o sustentem. Não copie os textos de apoio; utilize-os como referência. Não ' +
  'assine a redação nem inclua marcas de identificação. Textos com menos de 7 linhas, fora do ' +
  'tema ou de outro gênero recebem nota zero.';

const GENERAL_PROMPT = (theme) =>
  'Com base na leitura dos textos de apoio e em seus conhecimentos, redija um texto ' +
  'dissertativo-argumentativo, em norma-padrão da língua portuguesa, sobre o tema: ' +
  `"${theme}".\n\n` +
  'Apresente uma tese, sustente-a com argumentos organizados em parágrafos e conclua de forma ' +
  'coerente. Escreva entre 20 e 30 linhas. Não copie os textos de apoio.';

const SOURCE = 'Equipe Foco Elite — proposta autoral no estilo da banca';

module.exports = [
  // ================================================================== ENEM
  {
    exam: 'enem',
    title: 'Desafios para o cuidado com a saúde mental dos jovens no Brasil',
    prompt_text: ENEM_PROMPT('Desafios para o cuidado com a saúde mental dos jovens no Brasil'),
    support_texts: `**Texto I**

Ansiedade, depressão e automutilação deixaram de ser assuntos restritos ao consultório. Nas escolas, professores relatam alunos que não conseguem entrar em sala, que faltam em semanas de prova ou que passam noites em claro diante de telas. Especialistas apontam uma combinação de fatores: pressão por desempenho, comparação constante nas redes sociais, insegurança quanto ao futuro e uma rede de apoio que, muitas vezes, não sabe identificar os sinais de sofrimento. O resultado é um pedido de ajuda que chega tarde — quando chega.

**Texto II**

A Rede de Atenção Psicossocial do SUS prevê atendimento gratuito em Centros de Atenção Psicossocial (CAPS), inclusive unidades voltadas a crianças e adolescentes. Na prática, a distribuição desses serviços é desigual: capitais e regiões metropolitanas concentram a maior parte das equipes, enquanto municípios pequenos dependem de encaminhamentos distantes. Na escola, a presença de psicólogos e assistentes sociais, prevista em lei desde 2019, ainda está longe de ser universal.

**Texto III**

"Não é frescura." A frase, repetida por jovens em campanhas de conscientização, resume o principal obstáculo: o estigma. Falar de sofrimento psíquico ainda é visto por muitas famílias como fraqueza ou exagero, o que faz o adolescente esconder o que sente. Programas que treinam professores e familiares para reconhecer sinais de alerta e acolher sem julgamento mostram bons resultados — mas dependem de continuidade e de investimento público.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Combate à desinformação e responsabilidade compartilhada na era digital',
    prompt_text: ENEM_PROMPT('Combate à desinformação e responsabilidade compartilhada na era digital'),
    support_texts: `**Texto I**

Uma notícia falsa percorre uma rede social muito mais rápido do que a sua correção. O motivo é conhecido pelos pesquisadores de comunicação: conteúdos que provocam indignação, medo ou surpresa geram mais cliques, compartilhamentos e comentários — e os algoritmos que organizam o que vemos priorizam exatamente esse tipo de engajamento. A desinformação, portanto, não é apenas um problema de quem mente, mas do modelo de negócio que recompensa a mentira.

**Texto II**

Durante emergências de saúde pública, campanhas eleitorais e desastres ambientais, mensagens fabricadas já provocaram recusa a vacinas, linchamentos virtuais e ataques a instituições. Governos discutem regulação das plataformas; as empresas alegam defender a liberdade de expressão; e o usuário comum, no meio disso, recebe dezenas de mensagens por dia sem ferramentas para verificar o que é verdadeiro.

**Texto III**

A educação midiática — a capacidade de identificar a fonte de uma informação, checar sua data, comparar versões e desconfiar de conteúdos que confirmam apenas o que já se pensa — passou a integrar a Base Nacional Comum Curricular. Agências de checagem, bibliotecas e iniciativas comunitárias também atuam, mas ainda alcançam uma parcela pequena da população. Combater a desinformação exige, ao mesmo tempo, plataformas responsáveis, leis claras e cidadãos preparados.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Caminhos para uma mobilidade urbana sustentável e inclusiva nas cidades brasileiras',
    prompt_text: ENEM_PROMPT('Caminhos para uma mobilidade urbana sustentável e inclusiva nas cidades brasileiras'),
    support_texts: `**Texto I**

Nas grandes cidades brasileiras, o trabalhador que mora na periferia pode gastar mais de três horas por dia dentro de ônibus e trens lotados. O tempo perdido no deslocamento reduz o convívio familiar, o descanso e as oportunidades de estudo — e afeta, sobretudo, quem tem menor renda. A Política Nacional de Mobilidade Urbana, de 2012, estabeleceu a prioridade do transporte coletivo e dos modos ativos (bicicleta e caminhada) sobre o automóvel, mas a maior parte dos investimentos ainda vai para viadutos e avenidas.

**Texto II**

O carro particular ocupa, por passageiro, dezenas de vezes mais espaço viário do que um ônibus e emite muito mais poluentes. Ainda assim, ele continua sendo símbolo de sucesso e a única opção segura em bairros sem calçadas, iluminação ou transporte noturno. Cidades que ampliaram corredores exclusivos de ônibus, ciclovias conectadas e tarifas integradas registraram queda de congestionamentos e de acidentes.

**Texto III**

Mobilidade inclusiva significa que uma pessoa em cadeira de rodas, um idoso com bengala ou uma mãe com carrinho consigam chegar ao destino com autonomia. Isso envolve calçadas niveladas, veículos acessíveis, sinalização sonora e planejamento que leve em conta as diferentes formas de se mover pela cidade. Sem essa perspectiva, a mobilidade urbana reproduz as mesmas desigualdades que marcam o espaço urbano brasileiro.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Trabalho por aplicativos: direitos e proteção social no Brasil',
    prompt_text: ENEM_PROMPT('Trabalho por aplicativos: direitos e proteção social no Brasil'),
    support_texts: `**Texto I**

Motoristas e entregadores conectados a aplicativos formam hoje uma das maiores categorias de trabalhadores do país. A promessa é de liberdade: cada um escolhe quando e quanto trabalhar. Na prática, muitos passam mais de dez horas por dia nas ruas para alcançar uma renda mínima, arcam com combustível, manutenção e seguro do próprio veículo e podem ser desligados da plataforma por uma decisão automatizada, sem direito a explicação.

**Texto II**

O debate jurídico gira em torno de uma pergunta: o trabalhador de aplicativo é autônomo ou empregado? Se for empregado, tem direito a férias, 13º salário, FGTS e proteção contra acidentes; se for autônomo, recolhe sozinho sua contribuição previdenciária — e a maioria não recolhe. Países europeus criaram categorias intermediárias, com direitos mínimos garantidos independentemente do vínculo. No Brasil, propostas semelhantes seguem em discussão.

**Texto III**

Em greves organizadas por redes sociais, entregadores pediram aumento das taxas por corrida, seguro contra acidentes e pontos de apoio com banheiro e água. As manifestações revelaram um paradoxo: trabalhadores que são invisíveis para a legislação, mas essenciais para o funcionamento das cidades — como ficou evidente durante a pandemia, quando foram eles que mantiveram o comércio e a alimentação em movimento.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Envelhecimento populacional e a garantia de qualidade de vida aos idosos no Brasil',
    prompt_text: ENEM_PROMPT('Envelhecimento populacional e a garantia de qualidade de vida aos idosos no Brasil'),
    support_texts: `**Texto I**

O Brasil envelhece rápido. A queda da natalidade e o aumento da expectativa de vida fizeram a parcela de pessoas com 60 anos ou mais crescer de forma acelerada nas últimas décadas, e as projeções indicam que, em poucos anos, os idosos serão mais numerosos do que as crianças. Um país que se organizou por gerações em torno da juventude precisa agora repensar saúde, previdência, moradia, transporte e trabalho.

**Texto II**

O Estatuto da Pessoa Idosa, em vigor desde 2003, garante prioridade no atendimento, gratuidade no transporte coletivo e proteção contra abandono e violência. Mas garantir direitos no papel é diferente de assegurá-los na vida real: filas em unidades de saúde, calçadas irregulares, falta de cuidadores e a solidão de quem mora sozinho mostram que a cidade e as políticas públicas ainda não foram pensadas para quem envelhece.

**Texto III**

Envelhecer com qualidade não depende apenas de remédios. Estudos sobre longevidade apontam a importância de vínculos sociais, atividade física, participação em decisões da comunidade e sentido de utilidade. Programas de universidades abertas à terceira idade, centros de convivência e iniciativas intergeracionais nas escolas mostram que o idoso pode e deve continuar como protagonista — e não apenas como alguém a ser cuidado.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Segurança digital e proteção de dados pessoais na sociedade brasileira',
    prompt_text: ENEM_PROMPT('Segurança digital e proteção de dados pessoais na sociedade brasileira'),
    support_texts: `**Texto I**

Um clique em um link falso, uma senha repetida em vários serviços, um aplicativo que pede acesso à lista de contatos sem necessidade: as portas de entrada para golpes digitais são, na maioria das vezes, cotidianas. Fraudes por mensagens, clonagem de contas e vazamentos de bancos de dados atingem milhões de brasileiros por ano e afetam com mais força quem tem menos familiaridade com a tecnologia, como idosos e pessoas recém-incluídas no ambiente digital.

**Texto II**

A Lei Geral de Proteção de Dados (LGPD), em vigor desde 2020, estabelece que empresas e órgãos públicos só podem coletar dados pessoais com finalidade clara e consentimento, e devem protegê-los contra acessos indevidos. A Autoridade Nacional de Proteção de Dados fiscaliza e aplica sanções. Ainda assim, a cultura de "aceitar os termos sem ler" e a coleta massiva de informações por plataformas continuam a expor cidadãos a riscos que eles mal compreendem.

**Texto III**

Segurança digital não é responsabilidade apenas do usuário. Bancos, operadoras e redes sociais têm o dever de adotar autenticação segura e de responder rapidamente a incidentes; o Estado precisa investir em educação digital e em investigação de crimes cibernéticos; e a escola pode formar, desde cedo, cidadãos capazes de proteger a própria identidade e de respeitar a privacidade dos outros.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Evasão escolar no ensino médio: causas e caminhos de enfrentamento no Brasil',
    prompt_text: ENEM_PROMPT('Evasão escolar no ensino médio: causas e caminhos de enfrentamento no Brasil'),
    support_texts: `**Texto I**

Todos os anos, centenas de milhares de jovens brasileiros deixam a escola antes de concluir o ensino médio. As razões mais citadas são a necessidade de trabalhar para ajudar a família, a gravidez na adolescência, a distância entre a escola e a casa e a sensação de que o que se aprende em sala "não serve para nada". A evasão se concentra entre os mais pobres, entre estudantes negros e nas periferias — reproduzindo, na educação, as desigualdades do país.

**Texto II**

O ensino médio é a etapa mais frágil da educação básica: mais alunos por professor, currículo extenso e pouco diálogo com os projetos de vida dos estudantes. Reformas recentes tentaram flexibilizar as disciplinas e aproximar a escola do mundo do trabalho, mas a implementação desigual entre os estados gerou críticas de professores e alunos. Sem estrutura, formação docente e transporte, mudar o currículo não basta.

**Texto III**

Escolas que reduziram a evasão têm algo em comum: acompanhamento individual dos alunos com faltas frequentes, busca ativa com apoio das famílias e do conselho tutelar, oferta de refeições, e programas de bolsa que compensam a renda perdida com a permanência nos estudos. A escola em tempo integral, quando bem estruturada, também aumenta a permanência — porque transforma o estudante em alguém que pertence àquele lugar.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'enem',
    title: 'Democratização do acesso à cultura no Brasil',
    prompt_text: ENEM_PROMPT('Democratização do acesso à cultura no Brasil'),
    support_texts: `**Texto I**

A Constituição de 1988 garante a todos o pleno exercício dos direitos culturais e o acesso às fontes da cultura nacional. Na prática, museus, teatros, cinemas e bibliotecas concentram-se nas áreas centrais das grandes cidades; muitos municípios não possuem sequer uma sala de cinema ou uma livraria. Para a maioria dos brasileiros, a cultura acessível é a que chega pela televisão e pela internet.

**Texto II**

Cultura não é apenas o que se consome, mas o que se produz. Saraus de periferia, grupos de dança, rádios comunitárias, artesanato e festas populares mantêm vivas tradições e criam novas formas de expressão, muitas vezes sem qualquer apoio público. Políticas de incentivo, como leis de fomento e editais para pequenos coletivos, ampliaram esse cenário, mas ainda dependem de continuidade e de desburocratização.

**Texto III**

O preço do ingresso é apenas uma das barreiras. Transporte, horário de funcionamento, linguagem dos espaços e a sensação de "não pertencer" afastam parte do público. Iniciativas de mediação cultural, gratuidade em determinados dias, apresentações itinerantes e a integração entre escola e equipamentos culturais mostram que democratizar a cultura significa, sobretudo, aproximar as pessoas do que já lhes pertence por direito.`,
    source: SOURCE,
    year: 2026,
  },

  // ============================================================ Barro Branco (VUNESP)
  {
    exam: 'barro-branco',
    title: 'Segurança pública: dever do Estado e responsabilidade de todos',
    prompt_text: VUNESP_PROMPT('Segurança pública: dever do Estado e responsabilidade de todos'),
    support_texts: `**Texto I**

A Constituição Federal define a segurança pública como dever do Estado e direito e responsabilidade de todos, exercida para a preservação da ordem pública e da incolumidade das pessoas e do patrimônio. A redação não é casual: ao lado das polícias e do sistema de justiça, o texto constitucional coloca o cidadão como parte da solução.

**Texto II**

Iluminação de ruas, ocupação de praças, denúncias anônimas, conselhos comunitários de segurança e programas de vizinhança solidária são exemplos de como a comunidade participa da prevenção da violência. Onde há confiança entre população e polícia, a informação circula, o crime é notificado e a resposta é mais rápida. Onde há medo e desconfiança, o silêncio protege o criminoso.

**Texto III**

Críticos alertam que "responsabilidade de todos" não pode significar transferir ao cidadão a tarefa de se proteger sozinho — comprando armas, erguendo muros ou fazendo justiça com as próprias mãos. A participação social é complemento, e não substituto, de políticas públicas de segurança, educação e redução das desigualdades.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'barro-branco',
    title: 'O uso de câmeras corporais e a transparência na atividade policial',
    prompt_text: VUNESP_PROMPT('O uso de câmeras corporais e a transparência na atividade policial'),
    support_texts: `**Texto I**

As câmeras acopladas ao uniforme registram, em áudio e vídeo, a atuação do policial durante o serviço. Adotadas em diversos estados, elas foram associadas à redução tanto do número de mortes em intervenções policiais quanto das agressões sofridas pelos próprios agentes. Para defensores, o equipamento protege o cidadão e o policial que age corretamente, ao produzir prova imparcial do que ocorreu.

**Texto II**

Parte dos policiais vê as câmeras com desconfiança: teme que gravações sejam usadas apenas para punir e que a presença do equipamento gere hesitação em situações de risco. Especialistas respondem que o efeito depende das regras de uso — quando a câmera deve estar ligada, quem tem acesso às imagens, por quanto tempo são guardadas — e da forma como a corporação utiliza o material: para punir ou para treinar.

**Texto III**

Transparência é um dos pilares da confiança nas instituições. Quando a população acredita que a polícia age dentro da lei e que abusos serão apurados, colabora mais e teme menos. A tecnologia, sozinha, não muda cultura; mas pode ser um instrumento poderoso para uma polícia mais profissional, mais segura e mais respeitada.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'barro-branco',
    title: 'Ética e integridade no exercício da função pública',
    prompt_text: VUNESP_PROMPT('Ética e integridade no exercício da função pública'),
    support_texts: `**Texto I**

O servidor público administra o que não é seu: recursos, informações e poderes que pertencem à coletividade. Por isso, a Constituição submete a administração pública aos princípios da legalidade, impessoalidade, moralidade, publicidade e eficiência. A moralidade administrativa exige mais do que cumprir a lei — exige agir com honestidade, lealdade e boa-fé, mesmo quando ninguém está olhando.

**Texto II**

Pequenos desvios abrem caminho para grandes desvios. O "jeitinho" para acelerar um processo, o presente aceito de quem depende de uma decisão, o uso do cargo para favorecer um conhecido: condutas aparentemente inofensivas corroem a confiança pública e criam um ambiente em que a corrupção se normaliza. Programas de integridade, canais de denúncia e formação ética contínua são respostas institucionais a esse risco.

**Texto III**

Na carreira militar, a ética é reforçada por valores como hierarquia, disciplina, honra e respeito à dignidade humana. Um oficial da Polícia Militar toma decisões que afetam a liberdade e a vida das pessoas; sua integridade não é apenas uma virtude pessoal, mas uma condição para a legitimidade da própria instituição.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'barro-branco',
    title: 'Violência no trânsito: um problema de segurança pública e de cidadania',
    prompt_text: VUNESP_PROMPT('Violência no trânsito: um problema de segurança pública e de cidadania'),
    support_texts: `**Texto I**

O trânsito mata dezenas de brasileiros por dia. Excesso de velocidade, uso de celular ao volante, consumo de álcool e desrespeito à sinalização estão entre as principais causas, e as vítimas são, com frequência, motociclistas, pedestres e ciclistas — os usuários mais vulneráveis da via. Cada morte evitável representa uma família destruída e um custo elevado para o sistema de saúde.

**Texto II**

A fiscalização é indispensável, mas não substitui a educação. Países que reduziram drasticamente as mortes no trânsito combinaram leis rígidas, fiscalização eletrônica, engenharia de vias mais seguras e campanhas permanentes que mudaram a cultura ao volante. No Brasil, a Lei Seca mostrou que fiscalização consistente altera comportamentos — mas seu efeito diminui onde a presença do Estado é esporádica.

**Texto III**

Dirigir é um ato coletivo: cada decisão individual afeta a segurança de todos. Respeitar a faixa de pedestres, dar seta, manter distância e não dirigir cansado são gestos de cidadania. A violência no trânsito revela, em última análise, o quanto uma sociedade valoriza a vida do outro.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'barro-branco',
    title: 'Redes sociais e cidadania: participação democrática ou polarização?',
    prompt_text: VUNESP_PROMPT('Redes sociais e cidadania: participação democrática ou polarização?'),
    support_texts: `**Texto I**

Nunca foi tão fácil se manifestar publicamente. Com um celular, qualquer cidadão pode cobrar autoridades, denunciar abusos, organizar mobilizações e acompanhar decisões do poder público em tempo real. As redes sociais ampliaram o espaço da política para além dos partidos e da imprensa tradicional.

**Texto II**

O mesmo ambiente, porém, favorece a formação de bolhas: o usuário vê principalmente conteúdos com os quais já concorda e passa a enxergar quem pensa diferente como inimigo. Discussões públicas se transformam em ataques pessoais; boatos substituem argumentos; e a agressividade se torna o tom dominante. Pesquisas indicam que o debate polarizado reduz a confiança nas instituições e desestimula a participação de quem não quer se expor.

**Texto III**

Cidadania digital exige as mesmas virtudes da cidadania fora das telas: respeito, escuta, responsabilidade pelo que se diz e disposição para verificar antes de compartilhar. Escola, família e as próprias plataformas têm papel nessa formação — assim como o cidadão que escolhe, a cada postagem, contribuir para o diálogo ou para o conflito.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: 'barro-branco',
    title: 'Tecnologia e prevenção da criminalidade nas cidades',
    prompt_text: VUNESP_PROMPT('Tecnologia e prevenção da criminalidade nas cidades'),
    support_texts: `**Texto I**

Câmeras de monitoramento, reconhecimento de placas, mapas de calor de ocorrências e aplicativos de denúncia transformaram o policiamento nas últimas décadas. Com dados, é possível identificar horários e locais de maior risco, distribuir melhor as equipes e responder mais rápido. Cidades que integraram sistemas de vigilância a centrais de operações relataram queda em roubos e furtos.

**Texto II**

A vigilância em massa levanta questões sobre privacidade e discriminação. Sistemas de reconhecimento facial já produziram prisões equivocadas, com erros mais frequentes contra pessoas negras. Especialistas defendem regras claras: transparência sobre o uso dos dados, auditoria dos sistemas e supervisão humana nas decisões.

**Texto III**

Tecnologia é ferramenta, não solução. Sem investimento em policiais bem formados, em iluminação pública, em oportunidades para os jovens e em políticas sociais, as câmeras apenas deslocam o crime de um bairro para outro. Prevenir a criminalidade exige combinar inteligência, presença e confiança da comunidade.`,
    source: SOURCE,
    year: 2026,
  },

  // ============================================================ Gerais (todas as provas)
  {
    exam: null,
    title: 'O papel da educação na redução das desigualdades sociais',
    prompt_text: GENERAL_PROMPT('O papel da educação na redução das desigualdades sociais'),
    support_texts: `**Texto I**

Há forte relação entre escolaridade e renda: cada ano adicional de estudo está associado a salários maiores, menor desemprego e melhores condições de saúde. A educação é, por isso, apontada como o principal instrumento de mobilidade social — o caminho pelo qual o filho de uma família pobre pode alcançar oportunidades que seus pais não tiveram.

**Texto II**

A escola, contudo, também pode reproduzir desigualdades. Alunos de famílias com mais recursos chegam com maior repertório, estudam em instituições mais estruturadas e contam com apoio para o vestibular. Sem políticas de equidade — creches, escola em tempo integral, cotas, bolsas de permanência —, o sistema educacional tende a premiar quem já partiu na frente.

**Texto III**

Reduzir desigualdades pela educação exige investir onde a necessidade é maior: formação e valorização de professores, infraestrutura nas periferias e no campo, e currículos que dialoguem com a realidade dos estudantes. A educação não resolve sozinha a desigualdade, mas sem ela nenhuma outra política se sustenta.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: null,
    title: 'Consumo consciente e sustentabilidade no cotidiano',
    prompt_text: GENERAL_PROMPT('Consumo consciente e sustentabilidade no cotidiano'),
    support_texts: `**Texto I**

Cada produto que compramos carrega uma história invisível: matérias-primas extraídas, energia gasta, água consumida, trabalho humano e resíduos gerados. A lógica do descarte rápido — roupas usadas poucas vezes, eletrônicos trocados a cada lançamento, embalagens de uso único — pressiona os recursos naturais e enche aterros e oceanos de lixo.

**Texto II**

Consumo consciente não significa deixar de consumir, mas perguntar, antes de cada compra, se aquilo é necessário, de onde vem e para onde vai depois. Reparar em vez de substituir, preferir produtos duráveis, separar resíduos para reciclagem e valorizar produtores locais são escolhas individuais com impacto coletivo.

**Texto III**

Críticos lembram que a responsabilidade não pode recair apenas sobre o indivíduo. Empresas que projetam produtos para durar pouco, e governos que não regulam embalagens nem estruturam a coleta seletiva, têm papel decisivo. A sustentabilidade no cotidiano depende, portanto, de cidadãos conscientes, mercados responsáveis e políticas públicas consistentes.`,
    source: SOURCE,
    year: 2026,
  },
  {
    exam: null,
    title: 'Inteligência artificial: oportunidades e riscos para o mundo do trabalho',
    prompt_text: GENERAL_PROMPT('Inteligência artificial: oportunidades e riscos para o mundo do trabalho'),
    support_texts: `**Texto I**

Sistemas de inteligência artificial já redigem textos, analisam exames médicos, atendem clientes e programam computadores. Tarefas repetitivas e até algumas atividades intelectuais passaram a ser automatizadas em escala, com ganhos de produtividade que empresas comparam aos da Revolução Industrial.

**Texto II**

A história mostra que novas tecnologias destroem ocupações e criam outras, mas a transição nunca é indolor: quem perde o emprego raramente é quem ocupa as vagas novas. Trabalhadores com menos escolaridade e menos acesso à requalificação são os mais vulneráveis. Especialistas defendem políticas de formação contínua, redes de proteção social e regras para que a automação não amplie a desigualdade.

**Texto III**

A inteligência artificial não substitui, por enquanto, a criatividade, o julgamento ético e a capacidade de lidar com o inesperado. Profissões que combinam tecnologia com habilidades humanas tendem a se valorizar. A questão central não é se as máquinas vão trabalhar, mas como a sociedade distribuirá os ganhos e os custos dessa transformação.`,
    source: SOURCE,
    year: 2026,
  },
];

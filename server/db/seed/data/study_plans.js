'use strict';

/**
 * Planos de estudo de um ano, do jeito que o cliente definiu.
 *
 * Ritmo fixo da semana, igual nas duas provas:
 *   dia de aula      → videoaula nova
 *   dia seguinte     → resumo daquela aula + questões só daquele conteúdo
 *   a cada 4 semanas → o último dia vira prova anterior ou simulado
 *   domingo          → descanso, revisão dos erros ou redação
 *
 * Aqui ficam apenas as aulas novas, três por semana. Os dias de resumo e
 * questões são derivados pelo gerador do cronograma, e o encaixe nos dias da
 * semana depende da disponibilidade que o aluno informa no onboarding.
 *
 * Cada item é `[slug da matéria, título da aula]`. O slug precisa bater com
 * `subjects.js`; o título é o texto que o aluno vê e que o administrador pode
 * editar depois pelo painel.
 */

// ---------------------------------------------------------------------------
// ENEM — 52 semanas
// ---------------------------------------------------------------------------
const ENEM = [
  // mês 1
  [['matematica', 'Razão, proporção e regra de três'], ['lingua-portuguesa', 'Interpretação, compreensão e inferência'], ['historia', 'Mesopotâmia, Egito e povos antigos']],
  [['biologia', 'Água, sais minerais e carboidratos'], ['geografia', 'Cartografia, escalas e coordenadas'], ['quimica', 'Matéria, propriedades e separação de misturas']],
  [['fisica', 'Grandezas físicas, unidades e conversões'], ['literatura', 'Trovadorismo, Humanismo e Classicismo'], ['filosofia', 'Sócrates, Platão e Aristóteles']],
  [['sociologia', 'Sociedade, socialização e instituições sociais'], ['ingles', 'Interpretação, tema e informações explícitas'], ['redacao', 'Estrutura, interpretação do tema e tese']],
  // mês 2
  [['matematica', 'Porcentagem, juros simples e juros compostos'], ['lingua-portuguesa', 'Gêneros, tipos textuais e funções da linguagem'], ['historia', 'Grécia, Roma e cultura clássica']],
  [['biologia', 'Lipídios, proteínas e enzimas'], ['geografia', 'Relevo, solos e estrutura da Terra'], ['quimica', 'Modelos atômicos e distribuição eletrônica']],
  [['fisica', 'Movimento uniforme, MUV e gráficos'], ['literatura', 'Barroco, Arcadismo e contexto histórico'], ['artes', 'História da arte e movimentos artísticos']],
  [['educacao-fisica', 'Esporte, sociedade e cultura corporal'], ['redacao', 'Introdução, contextualização e tese'], ['matematica', 'Equações, inequações e sistemas']],
  // mês 3
  [['lingua-portuguesa', 'Coesão, coerência e conectivos'], ['historia', 'Feudalismo, Igreja medieval e sociedade medieval'], ['biologia', 'DNA, RNA e ácidos nucleicos']],
  [['geografia', 'Clima, vegetação e hidrografia'], ['quimica', 'Tabela periódica e propriedades periódicas'], ['fisica', 'Leis de Newton, forças e atrito']],
  [['literatura', 'Romantismo: autores e obras'], ['filosofia', 'Filosofia medieval, fé e razão'], ['sociologia', 'Cultura, identidade e diversidade']],
  [['ingles', 'Inferência, vocabulário e cognatos'], ['redacao', 'Desenvolvimento, argumentação e repertório'], ['matematica', 'Função do 1º e do 2º grau, gráficos']],
  // mês 4
  [['lingua-portuguesa', 'Classes de palavras, formação e flexões'], ['historia', 'Renascimento, Reforma e Contrarreforma'], ['biologia', 'Células e organelas']],
  [['geografia', 'Meio ambiente, impactos e sustentabilidade'], ['quimica', 'Ligação iônica, covalente e metálica'], ['fisica', 'Trabalho, potência e energia']],
  [['literatura', 'Realismo, Naturalismo e Parnasianismo'], ['filosofia', 'Racionalismo, empirismo e criticismo'], ['sociologia', 'Classes sociais, desigualdade e estratificação']],
  [['artes', 'Artes visuais, leitura de obras e linguagem artística'], ['educacao-fisica', 'Jogos, lutas e dança'], ['matematica', 'Exponencial, logaritmos e sequências']],
  // mês 5
  [['lingua-portuguesa', 'Sintaxe, termos da oração e período simples'], ['historia', 'Absolutismo, mercantilismo e expansão marítima'], ['biologia', 'Membrana, transportes e metabolismo']],
  [['geografia', 'População, demografia e migrações'], ['quimica', 'Ácidos, bases e sais'], ['fisica', 'Impulso, quantidade de movimento e conservação']],
  [['literatura', 'Simbolismo, Pré-Modernismo e autores'], ['redacao', 'Coesão, conectivos e progressão textual'], ['matematica', 'PA, PG e aplicações']],
  [['filosofia', 'Iluminismo, contratualismo e política'], ['sociologia', 'Trabalho, divisão do trabalho e capitalismo'], ['ingles', 'Pronomes, conectivos e referências textuais']],
  // mês 6
  [['lingua-portuguesa', 'Coordenação, subordinação e período composto'], ['historia', 'Iluminismo, Revolução Francesa e Era Napoleônica'], ['biologia', 'Respiração, fermentação e fotossíntese']],
  [['geografia', 'Urbanização, metropolização e problemas urbanos'], ['quimica', 'Óxidos, reações e balanceamento'], ['fisica', 'Pressão, densidade e empuxo']],
  [['literatura', 'Modernismo: 1ª, 2ª e 3ª fases'], ['redacao', 'Conclusão, proposta de intervenção e direitos humanos'], ['matematica', 'Princípio fundamental da contagem, arranjos e combinações']],
  [['artes', 'Música, teatro e dança'], ['educacao-fisica', 'Ginástica, atividade física e saúde'], ['matematica', 'Revisão semestral das matérias principais']],
  // mês 7
  [['lingua-portuguesa', 'Concordância e regência'], ['historia', 'Revolução Industrial, imperialismo e movimentos operários'], ['biologia', 'Mitose, meiose e ciclo celular']],
  [['geografia', 'Agricultura, estrutura fundiária e espaço rural'], ['quimica', 'Mol, massa molar e estequiometria'], ['fisica', 'Temperatura, calor e calorimetria']],
  [['filosofia', 'Ética, moral e liberdade'], ['sociologia', 'Estado, democracia e cidadania'], ['matematica', 'Probabilidade, condicional e problemas']],
  [['ingles', 'Tempos verbais e estruturas'], ['redacao', 'Competências 1 e 2'], ['literatura', 'Literatura contemporânea e interpretação']],
  // mês 8
  [['lingua-portuguesa', 'Crase, colocação pronominal e pontuação'], ['historia', 'Primeira Guerra, Revolução Russa e crise de 1929'], ['biologia', 'Mendel, heredogramas e genética humana']],
  [['geografia', 'Industrialização, energia e transportes'], ['quimica', 'Soluções, concentração e diluição'], ['fisica', 'Dilatação, mudanças de estado e termodinâmica']],
  [['filosofia', 'Democracia, justiça e cidadania'], ['sociologia', 'Movimentos sociais e direitos humanos'], ['matematica', 'Média, mediana e moda']],
  [['artes', 'Arte brasileira, cultura popular e patrimônio'], ['educacao-fisica', 'Corpo, estética e mídia'], ['redacao', 'Competências 3, 4 e 5']],
  // mês 9
  [['lingua-portuguesa', 'Semântica, ambiguidade e figuras de linguagem'], ['historia', 'Fascismo, Nazismo e Segunda Guerra'], ['biologia', 'Evolução, Darwin e seleção natural']],
  [['geografia', 'Globalização, capitalismo e divisão internacional do trabalho'], ['quimica', 'Termoquímica, cinética e equilíbrio'], ['fisica', 'Ondas, acústica e fenômenos ondulatórios']],
  [['filosofia', 'Filosofia contemporânea, ciência e tecnologia'], ['sociologia', 'Violência, exclusão e desigualdade'], ['matematica', 'Estatística, tabelas e gráficos']],
  [['ingles', 'Notícias, anúncios e textos culturais'], ['redacao', 'Planejamento, modelo e correção comentada'], ['historia', 'Guerra Fria, descolonização e Nova Ordem Mundial']],
  // mês 10
  [['lingua-portuguesa', 'Ortografia, acentuação e norma-padrão'], ['historia', 'Brasil Colônia, açúcar e escravidão'], ['biologia', 'Vírus, bactérias e protozoários']],
  [['geografia', 'Geopolítica, blocos econômicos e organismos internacionais'], ['quimica', 'pH, pOH e equilíbrio ácido-base'], ['fisica', 'Reflexão, refração, espelhos e lentes']],
  [['sociologia', 'Globalização, consumo e sociedade contemporânea'], ['matematica', 'Geometria plana, áreas e semelhança'], ['biologia', 'Fungos, plantas e grupos vegetais']],
  [['ingles', 'Textos científicos e culturais'], ['redacao', 'Treino de redação completa'], ['historia', 'Mineração, expansão territorial e revoltas coloniais']],
  // mês 11
  [['geografia', 'Regionalização, população e urbanização brasileira'], ['fisica', 'Carga, campo e potencial elétrico'], ['quimica', 'Pilhas, eletrólise e eletroquímica']],
  [['biologia', 'Zoologia, classificação e grupos animais'], ['matematica', 'Geometria espacial, áreas e volumes'], ['historia', 'Independência, Primeiro Reinado e Regências']],
  [['geografia', 'Agricultura, indústria e desigualdades regionais'], ['fisica', 'Corrente, resistência e Lei de Ohm'], ['quimica', 'Radioatividade, fissão e fusão']],
  [['biologia', 'Digestório, respiratório e circulatório'], ['matematica', 'Trigonometria'], ['historia', 'Segundo Reinado, café e abolição']],
  // mês 12
  [['fisica', 'Circuitos, potência e consumo'], ['quimica', 'Hidrocarbonetos e funções orgânicas'], ['biologia', 'Nervoso, endócrino e excretor']],
  [['matematica', 'Geometria analítica, reta e circunferência'], ['historia', 'República Velha, coronelismo e movimentos sociais'], ['fisica', 'Magnetismo, eletromagnetismo e indução']],
  [['quimica', 'Reações orgânicas, polímeros e combustíveis'], ['biologia', 'Imunologia, doenças e vacinas'], ['matematica', 'Matrizes, determinantes e sistemas lineares']],
  [['historia', 'Era Vargas, Estado Novo e industrialização'], ['biologia', 'Ecologia, cadeias e relações ecológicas'], ['matematica', 'Polinômios, produtos notáveis e fatoração']],
  // reta final
  [['historia', 'Ditadura Militar, redemocratização e Constituição de 1988'], ['biologia', 'Ciclos, biomas e impactos ambientais'], ['matematica', 'Números complexos']],
  [['matematica', 'Revisão completa de Matemática'], ['biologia', 'Revisão completa de Ciências da Natureza'], ['historia', 'Revisão completa de Ciências Humanas']],
  [['lingua-portuguesa', 'Revisão completa de Linguagens'], ['redacao', 'Redação completa e correção dos principais erros'], ['matematica', 'Prova anterior do ENEM — primeiro dia']],
  [['lingua-portuguesa', 'Prova anterior do ENEM — segundo dia'], ['matematica', 'Revisão dos assuntos com maior índice de erro'], ['redacao', 'Questões dos pontos fracos e relatório final']],
];

// ---------------------------------------------------------------------------
// Academia do Barro Branco — 52 semanas
// ---------------------------------------------------------------------------
const BARRO_BRANCO = [
  // mês 1
  [['matematica', 'Razão, proporção e regra de três'], ['lingua-portuguesa', 'Interpretação, compreensão e inferência'], ['historia', 'Mesopotâmia, Egito e povos antigos']],
  [['geografia', 'Cartografia, escalas e coordenadas'], ['fisica', 'Grandezas, unidades e conversões'], ['quimica', 'Matéria, propriedades e misturas']],
  [['biologia', 'Água, sais e carboidratos'], ['filosofia', 'Sócrates, Platão e Aristóteles'], ['sociologia', 'Sociedade, socialização e instituições']],
  [['informatica', 'Windows, arquivos e pastas'], ['administracao-publica', 'Direitos fundamentais, políticos e cidadania'], ['redacao', 'Estrutura, tema e tese']],
  // mês 2
  [['matematica', 'Porcentagem e juros'], ['lingua-portuguesa', 'Gêneros e tipos textuais'], ['historia', 'Grécia e Roma']],
  [['geografia', 'Relevo, solos e estrutura da Terra'], ['fisica', 'Cinemática'], ['quimica', 'Modelos atômicos e estrutura atômica']],
  [['biologia', 'Lipídios, proteínas e enzimas'], ['literatura', 'Trovadorismo, Humanismo e Classicismo'], ['ingles', 'Interpretação de texto']],
  [['educacao-fisica', 'Esporte, sociedade e cultura corporal'], ['informatica', 'Word'], ['administracao-publica', 'Administração Pública']],
  // mês 3
  [['matematica', 'Equações, inequações e sistemas'], ['lingua-portuguesa', 'Coesão, coerência e conectivos'], ['historia', 'Feudalismo, Igreja e sociedade medieval']],
  [['geografia', 'Clima, vegetação e hidrografia'], ['fisica', 'Leis de Newton, forças e atrito'], ['quimica', 'Tabela periódica']],
  [['biologia', 'DNA, RNA e ácidos nucleicos'], ['filosofia', 'Filosofia medieval'], ['sociologia', 'Cultura, identidade e diversidade']],
  [['redacao', 'Introdução'], ['literatura', 'Barroco e Arcadismo'], ['educacao-fisica', 'Barra, isometria e abdominal']],
  // mês 4
  [['matematica', 'Funções e gráficos'], ['lingua-portuguesa', 'Classes de palavras'], ['historia', 'Renascimento, Reforma e Contrarreforma']],
  [['geografia', 'Meio ambiente, impactos e sustentabilidade'], ['fisica', 'Trabalho, potência e energia'], ['quimica', 'Ligações químicas']],
  [['biologia', 'Citologia'], ['informatica', 'Excel'], ['administracao-publica', 'Segurança Pública e Polícia Militar']],
  [['ingles', 'Vocabulário e inferência'], ['redacao', 'Desenvolvimento e argumentação'], ['educacao-fisica', 'Corrida de 50 m e de 2.400 m']],
  // mês 5
  [['matematica', 'Exponencial, logaritmos e sequências'], ['lingua-portuguesa', 'Sintaxe'], ['historia', 'Absolutismo, mercantilismo e expansão marítima']],
  [['geografia', 'População, demografia e migrações'], ['fisica', 'Impulso e quantidade de movimento'], ['quimica', 'Ácidos, bases e sais']],
  [['biologia', 'Membrana e metabolismo'], ['filosofia', 'Racionalismo, empirismo e criticismo'], ['sociologia', 'Classes sociais e desigualdade']],
  [['literatura', 'Romantismo'], ['informatica', 'PowerPoint'], ['educacao-fisica', 'Natação: técnica e preparação']],
  // mês 6
  [['matematica', 'PA e PG'], ['lingua-portuguesa', 'Coordenação e subordinação'], ['historia', 'Iluminismo e Revolução Francesa']],
  [['geografia', 'Urbanização'], ['fisica', 'Hidrostática'], ['quimica', 'Óxidos, reações e balanceamento']],
  [['biologia', 'Respiração, fermentação e fotossíntese'], ['administracao-publica', 'Constituição do Estado de São Paulo'], ['redacao', 'Coesão e progressão textual']],
  [['ingles', 'Pronomes e conectivos'], ['literatura', 'Realismo, Naturalismo e Parnasianismo'], ['matematica', 'Revisão semestral']],
  // mês 7
  [['matematica', 'Análise combinatória'], ['lingua-portuguesa', 'Concordância e regência'], ['historia', 'Revolução Industrial e imperialismo']],
  [['geografia', 'Agricultura e espaço rural'], ['fisica', 'Temperatura, calor e calorimetria'], ['quimica', 'Mol e estequiometria']],
  [['biologia', 'Mitose e meiose'], ['filosofia', 'Iluminismo e contratualismo'], ['sociologia', 'Trabalho e capitalismo']],
  [['informatica', 'Internet e e-mail'], ['educacao-fisica', 'Regras do TAF e preparação física'], ['redacao', 'Conclusão']],
  // mês 8
  [['matematica', 'Probabilidade'], ['lingua-portuguesa', 'Crase, pontuação e colocação pronominal'], ['historia', 'Primeira Guerra, Revolução Russa e crise de 1929']],
  [['geografia', 'Industrialização, energia e transportes'], ['fisica', 'Termodinâmica'], ['quimica', 'Soluções']],
  [['biologia', 'Genética e Mendel'], ['administracao-publica', 'Justiça Militar e Segurança Pública'], ['literatura', 'Simbolismo e Pré-Modernismo']],
  [['ingles', 'Tempos verbais'], ['educacao-fisica', 'Barra, abdominal e evolução'], ['redacao', 'Competências 1 e 2']],
  // mês 9
  [['matematica', 'Estatística'], ['lingua-portuguesa', 'Semântica e figuras de linguagem'], ['historia', 'Fascismo, Nazismo e Segunda Guerra']],
  [['geografia', 'Globalização'], ['fisica', 'Ondas e acústica'], ['quimica', 'Termoquímica, cinética e equilíbrio']],
  [['biologia', 'Evolução'], ['filosofia', 'Ética, moral e liberdade'], ['sociologia', 'Estado, democracia e cidadania']],
  [['informatica', 'Google Drive, Documentos e Planilhas'], ['redacao', 'Competências 3, 4 e 5'], ['educacao-fisica', 'Corridas: velocidade e resistência']],
  // mês 10
  [['matematica', 'Tabelas e gráficos'], ['lingua-portuguesa', 'Ortografia e acentuação'], ['historia', 'Guerra Fria e descolonização']],
  [['geografia', 'Geopolítica e blocos econômicos'], ['fisica', 'Óptica'], ['quimica', 'pH e pOH']],
  [['biologia', 'Vírus, bactérias e protozoários'], ['administracao-publica', 'Lei de Acesso à Informação'], ['educacao-fisica', 'Simulação completa do TAF']],
  [['literatura', 'Modernismo'], ['ingles', 'Notícias, anúncios e textos culturais'], ['redacao', 'Planejamento e correção']],
  // mês 11
  [['matematica', 'Geometria plana'], ['historia', 'Brasil Colônia'], ['geografia', 'Regionalização do Brasil']],
  [['fisica', 'Campo e potencial elétrico'], ['quimica', 'Eletroquímica'], ['biologia', 'Fungos e plantas']],
  [['filosofia', 'Democracia, justiça e cidadania'], ['sociologia', 'Movimentos sociais e direitos humanos'], ['informatica', 'Gmail, Agenda e Meet']],
  [['redacao', 'Redação do Barro Branco'], ['literatura', 'Literatura contemporânea'], ['ingles', 'Interpretação de textos']],
  // mês 12
  [['matematica', 'Geometria espacial'], ['historia', 'Mineração e revoltas coloniais'], ['geografia', 'Agricultura, indústria e desigualdades']],
  [['fisica', 'Corrente, resistência e Lei de Ohm'], ['quimica', 'Radioatividade'], ['biologia', 'Zoologia']],
  [['matematica', 'Trigonometria'], ['historia', 'Independência e Regências'], ['biologia', 'Fisiologia']],
  [['fisica', 'Circuitos'], ['quimica', 'Química orgânica'], ['informatica', 'Microsoft Teams']],
  // reta final
  [['matematica', 'Geometria analítica'], ['historia', 'Segundo Reinado'], ['biologia', 'Nervoso, endócrino e excretor']],
  [['matematica', 'Matrizes e determinantes'], ['historia', 'República Velha'], ['fisica', 'Eletromagnetismo']],
  [['matematica', 'Polinômios e fatoração'], ['historia', 'Era Vargas'], ['biologia', 'Imunologia, doenças e vacinas']],
  [['matematica', 'Números complexos'], ['historia', 'Ditadura e redemocratização'], ['biologia', 'Ecologia, biomas e impactos ambientais']],
];

/** Transforma as semanas em itens numerados, do jeito que o banco guarda. */
function itens(semanas) {
  const lista = [];
  semanas.forEach((aulas, indice) => {
    aulas.forEach(([subject, title]) => {
      lista.push({ week: indice + 1, subject, title, kind: 'lesson' });
    });
  });
  return lista;
}

module.exports = [
  {
    slug: 'enem-1-ano',
    exam: 'enem',
    name: 'ENEM — um ano',
    description:
      'Sequência de um ano com três aulas novas por semana. No dia seguinte a cada aula, o aluno faz o resumo dela e questões só daquele conteúdo. A cada quatro semanas, o último dia da semana vira prova anterior ou simulado. O dia de folga fica para descanso, revisão dos erros ou redação.',
    weeks: 52,
    lessons_per_week: 3,
    exam_every_weeks: 4,
    items: itens(ENEM),
  },
  {
    slug: 'barro-branco-1-ano',
    exam: 'barro-branco',
    name: 'Academia do Barro Branco — um ano',
    description:
      'Mesmo ritmo do plano do ENEM, com o conteúdo do edital do Barro Branco: informática, administração pública e legislação entram na sequência. O treino físico para o TAF corre em paralelo três vezes por semana.',
    weeks: 52,
    lessons_per_week: 3,
    exam_every_weeks: 4,
    // treino do TAF: terça (força), quinta (corrida ou natação) e sábado (simulação)
    training_weekdays: [2, 4, 6],
    training_label: 'Treino físico para o TAF',
    items: itens(BARRO_BRANCO),
  },
];

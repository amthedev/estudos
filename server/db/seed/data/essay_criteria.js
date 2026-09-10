'use strict';

/**
 * Critérios de correção de redação por prova (tabela essay_criteria_sets).
 *
 * Cada conjunto tem: name, max_score, genre, min_lines, max_lines, instructions
 * (orientações extras enviadas ao corretor IA) e criteria: [{ key, name, max,
 * description, guidance }]. A soma dos `max` dos critérios é igual a max_score.
 *
 * O corretor IA (services/essay.js) monta o prompt a partir destes campos e
 * devolve uma nota por critério; por isso `guidance` descreve, em linguagem
 * objetiva, o que separa cada faixa de nota.
 *
 * Chave de idempotência: `exam` (um conjunto por prova). Os critérios são
 * editáveis no painel; o seed só cria os que faltam (use --force para restaurar).
 */

module.exports = {
  // ------------------------------------------------------------------ ENEM
  enem: {
    name: 'Matriz de referência do ENEM — 5 competências',
    max_score: 1000,
    genre: 'Texto dissertativo-argumentativo em prosa',
    min_lines: 8,
    max_lines: 30,
    instructions:
      'Avalie conforme a matriz oficial do ENEM: cinco competências, cada uma pontuada em seis ' +
      'níveis (0, 40, 80, 120, 160 ou 200) — a nota de cada competência deve ser obrigatoriamente ' +
      'um desses valores. A nota final é a soma das cinco (0 a 1000). ' +
      'Atribua nota zero ao texto inteiro nos casos previstos: fuga total ao tema; não atendimento ' +
      'ao tipo dissertativo-argumentativo; texto com até 7 linhas manuscritas (considere até cerca ' +
      'de 90 palavras); cópia integral dos textos motivadores; texto em branco, em língua ' +
      'estrangeira, ilegível ou com impropérios, desenhos ou parte deliberadamente desconectada ' +
      'do tema. Desrespeito aos direitos humanos na proposta de intervenção zera apenas a ' +
      'Competência 5. ' +
      'A proposta de intervenção completa deve conter cinco elementos: agente (quem faz), ação ' +
      '(o que fazer), modo ou meio (como), efeito ou finalidade (para quê) e detalhamento de ' +
      'pelo menos um deles. Valorize repertório sociocultural produtivo (legitimado e pertinente ' +
      'ao tema), projeto de texto claro e autoria. Comente cada competência com exemplos retirados ' +
      'do próprio texto e indique como subir de nível.',
    criteria: [
      {
        key: 'c1',
        name: 'Competência 1 — Domínio da modalidade escrita formal da língua portuguesa',
        max: 200,
        description:
          'Avalia ortografia, acentuação, concordância, regência, pontuação, colocação pronominal, ' +
          'uso de registro formal e convenções da escrita (paragrafação, letras maiúsculas, siglas).',
        guidance:
          '0 — desconhecimento da modalidade escrita formal. ' +
          '40 — domínio precário: muitos desvios gramaticais, de registro e de convenções da escrita, ' +
          'inclusive em estruturas simples. ' +
          '80 — domínio insuficiente: muitos desvios, ainda que o texto seja compreensível. ' +
          '120 — domínio mediano: alguns desvios gramaticais e de convenções da escrita. ' +
          '160 — bom domínio: poucos desvios, sem prejuízo ao registro formal. ' +
          '200 — domínio excelente: desvios apenas excepcionais e sem reincidência; sintaxe variada ' +
          'e registro plenamente formal.',
      },
      {
        key: 'c2',
        name: 'Competência 2 — Compreensão da proposta e desenvolvimento do tema no tipo dissertativo-argumentativo',
        max: 200,
        description:
          'Avalia se o texto trata do tema proposto (não apenas do assunto amplo), se mantém a estrutura ' +
          'dissertativo-argumentativa (tese, argumentos, conclusão) e se mobiliza repertório de outras ' +
          'áreas do conhecimento de forma produtiva.',
        guidance:
          '0 — fuga ao tema ou não atendimento à estrutura dissertativo-argumentativa. ' +
          '40 — tangencia o tema (fica no assunto amplo) ou apresenta traços constantes de outros tipos ' +
          'textuais (narração, relato, carta). ' +
          '80 — desenvolve o tema copiando os textos motivadores ou com domínio precário do tipo textual ' +
          '(argumentação embrionária). ' +
          '120 — desenvolve o tema com argumentação previsível e domínio mediano do tipo textual; ' +
          'repertório pouco produtivo ou de senso comum. ' +
          '160 — desenvolve o tema com argumentação consistente e bom domínio do tipo textual, com ' +
          'proposição, argumentação e conclusão. ' +
          '200 — argumentação consistente, repertório sociocultural produtivo (legitimado, pertinente ' +
          'e articulado à discussão) e excelente domínio do tipo textual.',
      },
      {
        key: 'c3',
        name: 'Competência 3 — Seleção, organização e interpretação de informações em defesa de um ponto de vista',
        max: 200,
        description:
          'Avalia o projeto de texto: se há um ponto de vista claro, se os argumentos foram selecionados ' +
          'e organizados de forma coerente, com progressão, e se as informações são desenvolvidas com ' +
          'autoria em vez de apenas repetir os textos motivadores.',
        guidance:
          '0 — informações, fatos e opiniões sem relação com o tema e sem defesa de ponto de vista. ' +
          '40 — informações desconexas ou pouco relacionadas ao tema, sem defesa de ponto de vista. ' +
          '80 — informações pouco relacionadas ao tema, limitadas aos textos motivadores, ' +
          'desorganizadas ou contraditórias, ainda que em defesa de um ponto de vista. ' +
          '120 — informações relacionadas ao tema, mas limitadas aos textos motivadores e pouco ' +
          'organizadas, em defesa de um ponto de vista. ' +
          '160 — informações relacionadas ao tema e organizadas, com indícios de autoria, em defesa ' +
          'de um ponto de vista. ' +
          '200 — informações relacionadas ao tema, consistentes e organizadas, configurando autoria; ' +
          'projeto de texto estratégico, com argumentos desenvolvidos até o fim.',
      },
      {
        key: 'c4',
        name: 'Competência 4 — Conhecimento dos mecanismos linguísticos necessários à argumentação',
        max: 200,
        description:
          'Avalia a coesão: articulação entre parágrafos e períodos por conectivos, pronomes, ' +
          'sinônimos e outros recursos, com variedade e sem inadequações (repetições, conectivos ' +
          'usados fora do sentido, períodos truncados).',
        guidance:
          '0 — não articula as informações. ' +
          '40 — articula as partes do texto de forma precária. ' +
          '80 — articula de forma insuficiente, com muitas inadequações e repertório limitado de ' +
          'recursos coesivos. ' +
          '120 — articula de forma mediana, com inadequações, e repertório pouco diversificado. ' +
          '160 — articula com poucas inadequações e repertório diversificado de recursos coesivos. ' +
          '200 — articula bem as partes do texto (entre e dentro dos parágrafos) e apresenta repertório ' +
          'diversificado de recursos coesivos, sem inadequações.',
      },
      {
        key: 'c5',
        name: 'Competência 5 — Proposta de intervenção para o problema, respeitando os direitos humanos',
        max: 200,
        description:
          'Avalia a proposta de intervenção: relação com o tema, articulação com a argumentação e ' +
          'completude (agente, ação, modo/meio, efeito e detalhamento), sempre respeitando os ' +
          'direitos humanos.',
        guidance:
          '0 — não apresenta proposta ou apresenta proposta sem relação com o tema/assunto; ou ' +
          'proposta que desrespeita os direitos humanos. ' +
          '40 — proposta vaga, precária ou relacionada apenas ao assunto amplo (1 elemento válido). ' +
          '80 — proposta insuficiente, relacionada ao tema mas não articulada com a discussão ' +
          '(2 elementos válidos). ' +
          '120 — proposta mediana, relacionada ao tema e articulada à discussão (3 elementos). ' +
          '160 — proposta bem elaborada, relacionada ao tema e articulada à discussão (4 elementos). ' +
          '200 — proposta muito bem elaborada e detalhada, relacionada ao tema e articulada à ' +
          'discussão (5 elementos: agente, ação, modo/meio, efeito e detalhamento).',
      },
    ],
  },

  // ------------------------------------------------------- Barro Branco (VUNESP)
  'barro-branco': {
    name: 'Redação VUNESP — Aluno-Oficial PM-SP (Barro Branco)',
    max_score: 100,
    genre: 'Texto dissertativo-argumentativo em norma-padrão',
    min_lines: 20,
    max_lines: 30,
    instructions:
      'Prova de redação no padrão VUNESP, escala de 0 a 100. NÃO se aplicam os critérios do ENEM: ' +
      'não há competências de 0 a 200 nem proposta de intervenção obrigatória — a conclusão pode ' +
      'retomar a tese, sintetizar a discussão ou apontar um encaminhamento, sem a exigência de ' +
      'agente/ação/meio/efeito. O texto deve ter entre 20 e 30 linhas (aproximadamente 220 a 380 ' +
      'palavras), ser escrito em prosa, na norma-padrão, sem título obrigatório e sem assinatura ' +
      'ou marcas de identificação. ' +
      'Considere nota zero para: fuga ao tema, texto não dissertativo-argumentativo (narração, ' +
      'poema, carta), texto com menos de 7 linhas, cópia dos textos de apoio ou texto ilegível. ' +
      'Descontar progressivamente por textos abaixo de 20 linhas. ' +
      'Valorize clareza, objetividade, progressão lógica das ideias, uso adequado dos textos de ' +
      'apoio (sem cópia) e vocabulário preciso, compatível com o perfil de um futuro oficial da ' +
      'Polícia Militar: postura ética, respeito às instituições e aos direitos fundamentais. ' +
      'Comente cada critério com trechos do texto e sugira reescritas objetivas.',
    criteria: [
      {
        key: 'tema_genero',
        name: 'Adequação ao tema e ao gênero dissertativo-argumentativo',
        max: 25,
        description:
          'O texto aborda exatamente o tema proposto (não apenas o assunto), com ponto de vista ' +
          'explícito, e mantém o caráter dissertativo-argumentativo em prosa do início ao fim.',
        guidance:
          '0 a 5 — fuga ao tema ou texto de outro gênero. 6 a 12 — tangencia o tema ou mistura ' +
          'traços narrativos/expositivos sem defender uma posição. 13 a 19 — trata do tema com ' +
          'posicionamento reconhecível, porém genérico. 20 a 25 — recorte preciso do tema, tese clara ' +
          'e sustentada em todo o texto.',
      },
      {
        key: 'estrutura',
        name: 'Estrutura e progressão (tese, desenvolvimento, conclusão)',
        max: 25,
        description:
          'Organização em introdução com tese, parágrafos de desenvolvimento com argumentos distintos ' +
          'e conclusão que fecha a discussão; progressão sem repetições nem saltos.',
        guidance:
          '0 a 5 — sem paragrafação funcional ou sem tese identificável. 6 a 12 — partes presentes, ' +
          'mas desproporcionais, com desenvolvimento circular. 13 a 19 — estrutura completa com ' +
          'progressão razoável e argumentos pouco aprofundados. 20 a 25 — projeto de texto claro, ' +
          'parágrafos equilibrados, cada argumento desenvolvido e conclusão coerente com a tese.',
      },
      {
        key: 'coesao_coerencia',
        name: 'Coesão e coerência',
        max: 20,
        description:
          'Encadeamento lógico das ideias e uso adequado e variado de conectivos, pronomes, ' +
          'retomadas e sinônimos; ausência de contradições e de ambiguidades.',
        guidance:
          '0 a 4 — ideias soltas ou contraditórias. 5 a 9 — articulação precária, conectivos repetidos ' +
          'ou mal empregados. 10 a 15 — articulação adequada com pequenas falhas. 16 a 20 — coesão ' +
          'variada e precisa entre períodos e parágrafos, texto plenamente coerente.',
      },
      {
        key: 'norma_padrao',
        name: 'Norma-padrão e adequação vocabular',
        max: 20,
        description:
          'Ortografia, acentuação, concordância, regência, pontuação, crase e colocação pronominal; ' +
          'vocabulário formal, preciso e sem gírias, clichês ou marcas de oralidade.',
        guidance:
          '0 a 4 — desvios frequentes que comprometem a leitura. 5 a 9 — muitos desvios ou registro ' +
          'informal recorrente. 10 a 15 — alguns desvios pontuais, registro adequado. 16 a 20 — ' +
          'domínio consistente da norma-padrão e vocabulário preciso.',
      },
      {
        key: 'argumentacao_repertorio',
        name: 'Argumentação e repertório',
        max: 10,
        description:
          'Qualidade e pertinência dos argumentos, uso produtivo dos textos de apoio e de ' +
          'conhecimentos próprios (fatos, dados, exemplos, princípios legais ou éticos).',
        guidance:
          '0 a 2 — argumentos de senso comum ou cópia dos textos de apoio. 3 a 5 — argumentos ' +
          'pertinentes, porém pouco fundamentados. 6 a 8 — argumentos consistentes com ao menos um ' +
          'repertório pertinente. 9 a 10 — argumentação sólida, repertório variado e bem articulado ' +
          'à tese.',
      },
    ],
  },

  // ------------------------------------------------------------------ FUVEST
  fuvest: {
    name: 'Redação FUVEST — 2ª fase',
    max_score: 50,
    genre: 'Texto dissertativo-argumentativo em prosa, com base em coletânea',
    min_lines: 15,
    max_lines: 30,
    instructions:
      'Redação da segunda fase da FUVEST, escala de 0 a 50. O candidato deve produzir um texto ' +
      'dissertativo-argumentativo em prosa, com base na coletânea, sem copiá-la, em até 30 linhas. ' +
      'Não há proposta de intervenção obrigatória. Considere nota zero para fuga ao tema, texto de ' +
      'outro gênero ou texto que não seja em prosa. Valorize leitura crítica da coletânea, ' +
      'argumentos autorais, precisão vocabular e organização das ideias. Comente cada critério com ' +
      'exemplos do texto.',
    criteria: [
      {
        key: 'desenvolvimento_tema',
        name: 'Desenvolvimento do tema',
        max: 20,
        description:
          'Compreensão da proposta e da coletânea, recorte do tema, consistência e originalidade da ' +
          'argumentação, ponto de vista sustentado.',
        guidance:
          '0 a 5 — tema tangenciado ou argumentação inconsistente. 6 a 11 — tema tratado com ' +
          'argumentos previsíveis. 12 a 16 — argumentação consistente e uso crítico da coletânea. ' +
          '17 a 20 — argumentação autoral, aprofundada e bem articulada à tese.',
      },
      {
        key: 'estrutura',
        name: 'Estrutura e organização do texto',
        max: 15,
        description:
          'Organização em parágrafos, progressão lógica, coesão entre as partes e adequação ao ' +
          'gênero dissertativo-argumentativo.',
        guidance:
          '0 a 4 — desorganizado ou sem progressão. 5 a 8 — estrutura reconhecível com falhas de ' +
          'coesão. 9 a 12 — estrutura clara com boa articulação. 13 a 15 — projeto de texto ' +
          'sólido, coesão variada e progressão precisa.',
      },
      {
        key: 'expressao',
        name: 'Expressão',
        max: 15,
        description:
          'Domínio da norma-padrão, clareza, precisão vocabular, pontuação e adequação de registro.',
        guidance:
          '0 a 4 — muitos desvios que prejudicam a leitura. 5 a 8 — desvios frequentes. 9 a 12 — ' +
          'poucos desvios, linguagem clara. 13 a 15 — expressão precisa e elegante, sem desvios ' +
          'relevantes.',
      },
    ],
  },

  // ----------------------------------------------------------------- UNICAMP
  unicamp: {
    name: 'Redação UNICAMP — 2ª fase (por proposta)',
    max_score: 12,
    genre: 'Gênero definido pela proposta (carta, artigo de opinião, manifesto, relato, texto de divulgação etc.)',
    min_lines: 12,
    max_lines: 30,
    instructions:
      'Cada proposta de redação da Unicamp vale de 0 a 12 pontos e define um gênero, uma situação de ' +
      'produção (quem escreve, para quem, com que finalidade, em que veículo) e uma coletânea de ' +
      'textos que deve ser lida e efetivamente usada. Não se aplicam os critérios do ENEM. Avalie ' +
      'se o texto cumpre o gênero e a interlocução exigidos, se articula os textos da coletânea ' +
      '(sem cópia) e se a escrita é adequada ao contexto. Considere nota zero para fuga ao tema, ' +
      'gênero diferente do solicitado ou desconsideração total da coletânea.',
    criteria: [
      {
        key: 'genero_interlocucao',
        name: 'Adequação ao gênero e à situação de interlocução',
        max: 4,
        description:
          'Cumpre as características do gênero pedido (estrutura, marcas, registro) e a situação de ' +
          'produção: enunciador, destinatário, finalidade e veículo.',
        guidance:
          '0 — gênero não atendido. 1 — traços mínimos do gênero. 2 — gênero atendido parcialmente ou ' +
          'interlocução pouco marcada. 3 — gênero e interlocução adequados. 4 — gênero e interlocução ' +
          'plenamente construídos e coerentes com a finalidade.',
      },
      {
        key: 'leitura_coletanea',
        name: 'Leitura e uso da coletânea',
        max: 4,
        description:
          'Compreensão e mobilização produtiva dos textos de apoio para construir o projeto de ' +
          'texto, com autoria e sem cópia.',
        guidance:
          '0 — coletânea ignorada ou copiada. 1 — uso superficial ou equivocado. 2 — uso parcial, ' +
          'com paráfrases próximas. 3 — uso pertinente e articulado. 4 — uso crítico, seletivo e ' +
          'integrado a conhecimentos próprios.',
      },
      {
        key: 'escrita',
        name: 'Escrita: coesão, coerência e norma-padrão',
        max: 4,
        description:
          'Organização das ideias, coesão, coerência e correção gramatical compatíveis com o gênero ' +
          'e com o registro exigido.',
        guidance:
          '0 — texto incompreensível. 1 — muitos desvios e problemas de coesão. 2 — desvios que ' +
          'prejudicam pontualmente a leitura. 3 — poucos desvios, texto coeso. 4 — escrita precisa, ' +
          'coesa e adequada ao registro.',
      },
    ],
  },

  // ------------------------------------------------------------------- UNESP
  unesp: {
    name: 'Redação UNESP — 2ª fase',
    max_score: 28,
    genre: 'Texto dissertativo-argumentativo em prosa, com base em textos de apoio',
    min_lines: 15,
    max_lines: 30,
    instructions:
      'Redação da segunda fase da Unesp (VUNESP), escala de 0 a 28. Texto dissertativo-argumentativo ' +
      'em prosa, norma-padrão, com base nos textos de apoio, em 20 a 30 linhas. Não há proposta de ' +
      'intervenção obrigatória nem competências no modelo ENEM. Considere zero para fuga ao tema, ' +
      'gênero diferente, cópia dos textos de apoio ou texto com menos de 7 linhas. Valorize ' +
      'posicionamento claro, argumentos bem fundamentados, progressão e correção.',
    criteria: [
      {
        key: 'tema_genero',
        name: 'Adequação ao tema e ao gênero',
        max: 7,
        description: 'Recorte preciso do tema, tese explícita e caráter dissertativo-argumentativo.',
        guidance:
          '0 a 1 — fuga ou tangenciamento. 2 a 3 — tema tratado de forma genérica. 4 a 5 — tema e ' +
          'gênero atendidos com clareza. 6 a 7 — recorte preciso e posicionamento sustentado.',
      },
      {
        key: 'estrutura_argumentacao',
        name: 'Estrutura e argumentação',
        max: 7,
        description: 'Introdução, desenvolvimento e conclusão articulados; argumentos consistentes e progressivos.',
        guidance:
          '0 a 1 — sem estrutura ou sem argumentos. 2 a 3 — estrutura frágil, argumentos previsíveis. ' +
          '4 a 5 — estrutura completa e argumentos pertinentes. 6 a 7 — projeto de texto claro e ' +
          'argumentação aprofundada.',
      },
      {
        key: 'coesao_coerencia',
        name: 'Coesão e coerência',
        max: 7,
        description: 'Encadeamento lógico e recursos coesivos variados, sem contradições.',
        guidance:
          '0 a 1 — ideias desconexas. 2 a 3 — articulação precária. 4 a 5 — articulação adequada com ' +
          'falhas pontuais. 6 a 7 — coesão variada e texto plenamente coerente.',
      },
      {
        key: 'norma_padrao',
        name: 'Norma-padrão e vocabulário',
        max: 7,
        description: 'Correção gramatical, pontuação, ortografia e precisão vocabular no registro formal.',
        guidance:
          '0 a 1 — desvios que comprometem a leitura. 2 a 3 — desvios frequentes. 4 a 5 — poucos ' +
          'desvios. 6 a 7 — domínio consistente da norma e vocabulário preciso.',
      },
    ],
  },

  // --------------------------------------------------------- FGV / Mackenzie / PUC-SP
  fgv: simpleModel('Redação FGV', 'em 20 a 30 linhas, com leitura crítica dos textos de apoio e argumentos fundamentados em dados e conceitos'),
  mackenzie: simpleModel('Redação Mackenzie', 'em 20 a 30 linhas, com tese clara, argumentos consistentes e conclusão coerente'),
  'puc-sp': simpleModel('Redação PUC-SP', 'em 20 a 30 linhas, com posicionamento explícito, uso reflexivo dos textos de apoio e correção gramatical'),
};

/**
 * Modelo simples (0 a 10) usado por vestibulares com redação de escala reduzida.
 * O admin pode refinar em /admin/vestibulares/:id (aba Redação).
 */
function simpleModel(name, focus) {
  return {
    name: `${name} — modelo 0 a 10`,
    max_score: 10,
    genre: 'Texto dissertativo-argumentativo em prosa',
    min_lines: 20,
    max_lines: 30,
    instructions:
      `Redação dissertativo-argumentativa ${focus}. Escala de 0 a 10, com uma casa decimal. ` +
      'Não se aplicam as competências do ENEM nem a proposta de intervenção obrigatória. ' +
      'Considere zero para fuga ao tema, gênero diferente do solicitado, cópia dos textos de apoio ' +
      'ou texto com menos de 7 linhas. Comente cada critério com exemplos do texto e indique ' +
      'melhorias concretas.',
    criteria: [
      {
        key: 'tema_argumentacao',
        name: 'Tema e argumentação',
        max: 4,
        description: 'Recorte do tema, tese clara e argumentos consistentes, com uso produtivo dos textos de apoio.',
        guidance:
          '0 a 1 — fuga ou tangenciamento, argumentos ausentes. 2 — tema atendido com argumentos ' +
          'previsíveis. 3 — argumentos pertinentes e fundamentados. 4 — argumentação autoral, ' +
          'aprofundada e articulada à tese.',
      },
      {
        key: 'estrutura_coesao',
        name: 'Estrutura e coesão',
        max: 3,
        description: 'Introdução, desenvolvimento e conclusão articulados por recursos coesivos variados.',
        guidance:
          '0 — sem estrutura reconhecível. 1 — estrutura frágil ou coesão precária. 2 — estrutura ' +
          'completa com falhas pontuais. 3 — projeto de texto claro e coesão precisa.',
      },
      {
        key: 'norma_padrao',
        name: 'Norma-padrão e expressão',
        max: 3,
        description: 'Correção gramatical, pontuação, ortografia e adequação vocabular ao registro formal.',
        guidance:
          '0 — desvios que comprometem a leitura. 1 — desvios frequentes. 2 — poucos desvios. ' +
          '3 — domínio consistente da norma e expressão precisa.',
      },
    ],
  };
}

'use strict';

/**
 * Provas / vestibulares suportados pela plataforma.
 *
 * Chave de idempotência: `slug`. O seed faz upsert por slug, então renomear uma
 * prova aqui atualiza o registro existente em vez de duplicá-lo.
 *
 * As datas de 2026 são estimativas baseadas no calendário histórico de cada
 * banca. O administrador ajusta a data real em /admin/vestibulares assim que o
 * edital é publicado — o cronograma do aluno usa a data cadastrada na prova ou a
 * data informada pelo próprio aluno no onboarding.
 */
const ESTIMATED = 'Data estimada, confirme no edital.';

module.exports = [
  {
    slug: 'enem',
    name: 'Exame Nacional do Ensino Médio',
    short_name: 'ENEM',
    track: 'enem',
    board: 'INEP',
    description:
      'Prova aplicada em dois domingos, com 180 questões objetivas divididas em quatro áreas ' +
      '(Linguagens, Ciências Humanas, Ciências da Natureza e Matemática) e redação ' +
      'dissertativo-argumentativa. A nota é calculada pela Teoria de Resposta ao Item (TRI) e ' +
      'vale para SiSU, ProUni e FIES. Primeiro dia previsto para 8 de novembro de 2026 e segundo ' +
      'dia para 15 de novembro. ' + ESTIMATED,
    exam_date: '2026-11-08',
    has_essay: true,
    essay_max_score: 1000,
    score_max: 1000,
    sort_order: 1,
  },
  {
    slug: 'barro-branco',
    name: 'Academia do Barro Branco / Cadete PM-SP',
    short_name: 'Barro Branco',
    track: 'barro_branco',
    board: 'VUNESP',
    description:
      'Concurso para Aluno-Oficial da Polícia Militar do Estado de São Paulo (Academia de ' +
      'Polícia Militar do Barro Branco), organizado pela VUNESP. A primeira fase tem prova ' +
      'objetiva de conhecimentos gerais e redação; as etapas seguintes incluem exames de ' +
      'aptidão física, saúde, psicológico e investigação social. Exige nível médio e idade ' +
      'entre 17 e 30 anos na data da inscrição. ' + ESTIMATED,
    exam_date: '2026-10-04',
    has_essay: true,
    essay_max_score: 100,
    score_max: 100,
    sort_order: 2,
  },
  {
    slug: 'fuvest',
    name: 'FUVEST — Universidade de São Paulo',
    short_name: 'FUVEST',
    track: 'vestibular',
    board: 'Fuvest',
    description:
      'Vestibular da USP. Primeira fase com 90 questões de múltipla escolha sobre todas as ' +
      'áreas; segunda fase com questões dissertativas, redação e lista de leituras obrigatórias ' +
      'de literatura. Primeira fase prevista para 22 de novembro de 2026. ' + ESTIMATED,
    exam_date: '2026-11-22',
    has_essay: true,
    essay_max_score: 50,
    score_max: 90,
    sort_order: 3,
  },
  {
    slug: 'unicamp',
    name: 'UNICAMP — Universidade Estadual de Campinas',
    short_name: 'UNICAMP',
    track: 'vestibular',
    board: 'Comvest',
    description:
      'Vestibular organizado pela Comvest. Primeira fase com 72 questões interdisciplinares; ' +
      'segunda fase dissertativa com duas propostas de redação em gêneros variados (carta, ' +
      'artigo, manifesto) e leituras obrigatórias. Primeira fase prevista para 1º de novembro ' +
      'de 2026. ' + ESTIMATED,
    exam_date: '2026-11-01',
    has_essay: true,
    essay_max_score: 12,
    score_max: 72,
    sort_order: 4,
  },
  {
    slug: 'unesp',
    name: 'UNESP — Universidade Estadual Paulista',
    short_name: 'UNESP',
    track: 'vestibular',
    board: 'VUNESP',
    description:
      'Vestibular da Unesp, aplicado pela VUNESP em duas fases: prova objetiva de conhecimentos ' +
      'gerais (90 questões) e prova dissertativa com redação. Primeira fase prevista para 15 de ' +
      'novembro de 2026. ' + ESTIMATED,
    exam_date: '2026-11-15',
    has_essay: true,
    essay_max_score: 28,
    score_max: 90,
    sort_order: 5,
  },
  {
    slug: 'fgv',
    name: 'FGV — Fundação Getulio Vargas',
    short_name: 'FGV',
    track: 'vestibular',
    board: 'FGV',
    description:
      'Vestibulares das escolas da FGV em São Paulo (Administração, Economia, Direito e ' +
      'Relações Internacionais), com forte peso em Matemática, Português, Inglês e questões ' +
      'discursivas, além de redação. Prova prevista para 29 de novembro de 2026. ' + ESTIMATED,
    exam_date: '2026-11-29',
    has_essay: true,
    essay_max_score: 10,
    score_max: null,
    sort_order: 6,
  },
  {
    slug: 'mackenzie',
    name: 'Universidade Presbiteriana Mackenzie',
    short_name: 'Mackenzie',
    track: 'vestibular',
    board: 'Mackenzie',
    description:
      'Vestibular próprio do Mackenzie, em fase única, com questões objetivas de conhecimentos ' +
      'gerais, língua estrangeira e redação dissertativa. Prova prevista para 6 de dezembro de ' +
      '2026. ' + ESTIMATED,
    exam_date: '2026-12-06',
    has_essay: true,
    essay_max_score: 10,
    score_max: null,
    sort_order: 7,
  },
  {
    slug: 'puc-sp',
    name: 'PUC-SP — Pontifícia Universidade Católica de São Paulo',
    short_name: 'PUC-SP',
    track: 'vestibular',
    board: 'PUC-SP',
    description:
      'Vestibular da PUC-SP, em fase única, com prova objetiva de conhecimentos gerais, língua ' +
      'estrangeira e redação dissertativo-argumentativa. Prova prevista para 21 de novembro de ' +
      '2026. ' + ESTIMATED,
    exam_date: '2026-11-21',
    has_essay: true,
    essay_max_score: 10,
    score_max: null,
    sort_order: 8,
  },
];

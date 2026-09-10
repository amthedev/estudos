'use strict';

/**
 * Pesos de cada matéria por prova (tabela exam_subjects).
 *
 * O motor do cronograma (services/schedule.js) usa o peso como primeiro fator da
 * pontuação de prioridade: score = peso × (1 + fraqueza) × ... — logo, uma matéria
 * com peso 1.3 recebe cerca de 30% mais tempo de estudo que uma com peso 1.0,
 * mantidas as demais condições. Matérias ausentes da lista de uma prova não entram
 * no cronograma daquela prova.
 *
 * Referência dos pesos principais:
 *   ENEM         Matemática 1.3 · Linguagens 1.0 · Natureza 1.1 · Humanas 1.0 · Redação 1.3
 *   Barro Branco Português 1.4 · Matemática 1.2 · História/Geografia 1.0 · Natureza 0.9 ·
 *                Inglês 0.8 · Informática 0.8 · Adm. Pública 1.0 · Atualidades 0.8 · Redação 1.2
 *   Vestibulares pesos por perfil genérico de curso (ajustáveis por prova no painel)
 *
 * Dentro de Linguagens do ENEM, as matérias com poucas questões (Artes, Educação
 * Física, TIC) e a língua estrangeira alternativa (Espanhol) recebem peso menor
 * para não ocupar o mesmo tempo que Língua Portuguesa no cronograma.
 *
 * Chave de idempotência: (exam, subject).
 */

const VESTIBULAR_BASE = {
  'lingua-portuguesa': 1.2,
  'interpretacao-de-texto': 1.2,
  gramatica: 1.0,
  literatura: 1.1,
  matematica: 1.1,
  historia: 1.0,
  geografia: 1.0,
  biologia: 1.0,
  fisica: 1.0,
  quimica: 1.0,
  ingles: 0.8,
  redacao: 1.3,
};

module.exports = {
  enem: {
    'lingua-portuguesa': 1.0,
    'interpretacao-de-texto': 1.0,
    gramatica: 1.0,
    literatura: 1.0,
    artes: 0.6,
    'educacao-fisica': 0.5,
    ingles: 0.8,
    espanhol: 0.5,
    tic: 0.5,
    matematica: 1.3,
    historia: 1.0,
    geografia: 1.0,
    filosofia: 1.0,
    sociologia: 1.0,
    biologia: 1.1,
    fisica: 1.1,
    quimica: 1.1,
    redacao: 1.3,
  },

  'barro-branco': {
    'lingua-portuguesa': 1.4,
    'interpretacao-de-texto': 1.4,
    gramatica: 1.4,
    matematica: 1.2,
    historia: 1.0,
    geografia: 1.0,
    filosofia: 0.8,
    sociologia: 0.8,
    fisica: 0.9,
    quimica: 0.9,
    biologia: 0.9,
    ingles: 0.8,
    informatica: 0.8,
    'administracao-publica': 1.0,
    legislacao: 0.8,
    atualidades: 0.8,
    redacao: 1.2,
  },

  // Fuvest: leituras obrigatórias pesam na 2ª fase; Filosofia e Sociologia aparecem em Humanas.
  fuvest: {
    ...VESTIBULAR_BASE,
    literatura: 1.2,
    filosofia: 0.7,
    sociologia: 0.7,
  },

  // Unicamp: prova interdisciplinar e redação em gêneros variados (duas propostas).
  unicamp: {
    ...VESTIBULAR_BASE,
    literatura: 1.2,
    filosofia: 0.7,
    sociologia: 0.7,
    redacao: 1.4,
  },

  unesp: {
    ...VESTIBULAR_BASE,
    filosofia: 0.7,
    sociologia: 0.7,
  },

  // FGV (Administração, Economia, Direito, RI): Matemática, Português e Inglês têm mais peso.
  fgv: {
    ...VESTIBULAR_BASE,
    matematica: 1.3,
    ingles: 1.0,
    literatura: 0.8,
    biologia: 0.7,
    fisica: 0.7,
    quimica: 0.7,
  },

  mackenzie: {
    ...VESTIBULAR_BASE,
  },

  'puc-sp': {
    ...VESTIBULAR_BASE,
    biologia: 0.9,
    fisica: 0.9,
    quimica: 0.9,
  },
};

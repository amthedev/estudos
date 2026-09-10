'use strict';

/**
 * Áreas do conhecimento — primeiro nível da biblioteca de conteúdo
 * (Área -> Matéria -> Assunto -> Subassunto -> Aula).
 * Chave de idempotência: `slug`.
 */
module.exports = [
  { slug: 'linguagens', name: 'Linguagens, Códigos e suas Tecnologias', sort_order: 1 },
  { slug: 'matematica', name: 'Matemática e suas Tecnologias', sort_order: 2 },
  { slug: 'ciencias-humanas', name: 'Ciências Humanas e Sociais', sort_order: 3 },
  { slug: 'ciencias-natureza', name: 'Ciências da Natureza', sort_order: 4 },
  { slug: 'redacao', name: 'Redação', sort_order: 5 },
  { slug: 'especificas', name: 'Conhecimentos Específicos', sort_order: 6 },
];

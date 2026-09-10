'use strict';

/**
 * Slugs sem acentos, em minúsculas, separados por hífen.
 *   slugify('Funções do 2º Grau — Introdução') → 'funcoes-do-2o-grau-introducao'
 */

const REPLACEMENTS = [
  [/º/g, 'o'],
  [/ª/g, 'a'],
  [/ß/g, 'ss'],
  [/æ/gi, 'ae'],
  [/œ/gi, 'oe'],
  [/ø/gi, 'o'],
  [/đ/gi, 'd'],
  [/ł/gi, 'l'],
  [/&/g, ' e '],
  [/\+/g, ' mais '],
  [/%/g, ' por cento '],
];

/**
 * @param {string} text
 * @param {{ maxLength?: number, separator?: string }} [options]
 */
function slugify(text, { maxLength = 80, separator = '-' } = {}) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of REPLACEMENTS) value = value.replace(pattern, replacement);
  value = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${escapeRegExp(separator)}+|${escapeRegExp(separator)}+$`, 'g'), '');
  if (maxLength > 0 && value.length > maxLength) {
    value = value.slice(0, maxLength).replace(new RegExp(`${escapeRegExp(separator)}+$`), '');
  }
  return value;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gera um slug único acrescentando sufixo numérico enquanto `exists(slug)` for verdadeiro.
 * @param {string} base           texto ou slug base
 * @param {(slug: string) => Promise<boolean>|boolean} exists
 */
async function uniqueSlug(base, exists, { maxLength = 80 } = {}) {
  const root = slugify(base, { maxLength }) || 'item';
  let candidate = root;
  let counter = 2;
  while (await exists(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${root.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
    counter += 1;
    if (counter > 10_000) throw new Error('Não foi possível gerar um slug único.');
  }
  return candidate;
}

/** Remove acentos preservando maiúsculas/minúsculas (útil para buscas). */
function unaccent(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

module.exports = { slugify, uniqueSlug, unaccent };

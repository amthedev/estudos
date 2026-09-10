'use strict';

/**
 * Paginação padrão da API: listas devolvem { items, total, page, limit, pages }.
 *
 *   const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20 });
 *   const rows = await many('SELECT ... LIMIT $1 OFFSET $2', [limit, offset]);
 *   res.json(paginate(rows, total, { page, limit }));
 */

function toPositiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {object} query        req.query (ou req.valid.query)
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = toPositiveInt(query.page, 1);
  const limit = Math.min(toPositiveInt(query.limit, defaultLimit), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Monta a resposta paginada.
 * @param {Array} items
 * @param {number} total
 * @param {{ page: number, limit: number }} pagination
 */
function paginate(items, total, { page, limit }) {
  const totalNumber = Number(total) || 0;
  return {
    items,
    total: totalNumber,
    page,
    limit,
    pages: limit > 0 ? Math.max(1, Math.ceil(totalNumber / limit)) : 1,
  };
}

/** Cláusula ORDER BY segura a partir de uma lista branca de colunas. */
function parseSort(query = {}, allowed, { defaultSort, defaultDir = 'asc' } = {}) {
  const requested = typeof query.sort === 'string' ? query.sort : defaultSort;
  const column = allowed[requested] ? requested : defaultSort;
  const dirRaw = typeof query.dir === 'string' ? query.dir.toLowerCase() : defaultDir;
  const dir = dirRaw === 'desc' ? 'DESC' : 'ASC';
  return { column, sql: allowed[column] ? `${allowed[column]} ${dir}` : null, dir };
}

module.exports = { parsePagination, paginate, parseSort };

'use strict';

/**
 * Provas anteriores (visão do aluno).
 *
 *   GET /api/past-exams?exam_id&year
 *     → { exams: [{ exam: { id, name, short_name, track, board },
 *                   total,
 *                   years: [{ year, items: [{ id, title, day, board, pdf_url, answer_key_url,
 *                                             external_url, notes }] }] }],
 *         total,
 *         filters: { exams: [{ id, name, short_name, track, total }], years: [2024, 2023, ...] } }
 *
 * Só entram provas anteriores ativas de vestibulares ativos. Provas ordenadas pela ordem do
 * cadastro (sort_order/nome), anos em ordem decrescente e, dentro do ano, por sort_order/dia.
 * `filters` ignora os filtros aplicados — serve para montar os seletores da tela.
 *
 * O cadastro é feito pelo administrador (/api/admin/past-exams).
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');

router.use(requireStudent, requireAccess);

const listQuery = z
  .object({
    exam_id: z.string().uuid().optional(),
    year: z.coerce.number().int().min(1950).max(2100).optional(),
  })
  .passthrough();

const ITEM_COLUMNS = `
  pe.id, pe.exam_id, pe.year, pe.day, pe.title, pe.board, pe.pdf_url, pe.answer_key_url,
  pe.external_url, pe.notes, pe.sort_order`;

/** Agrupa as linhas em provas → anos → itens, preservando a ordem do SELECT. */
function groupByExamAndYear(rows) {
  const exams = [];
  const byExam = new Map();

  for (const row of rows) {
    let group = byExam.get(row.exam_id);
    if (!group) {
      group = {
        exam: {
          id: row.exam_id,
          name: row.exam_name,
          short_name: row.exam_short_name,
          track: row.exam_track,
          board: row.exam_board,
        },
        total: 0,
        years: [],
        _years: new Map(),
      };
      byExam.set(row.exam_id, group);
      exams.push(group);
    }

    let year = group._years.get(row.year);
    if (!year) {
      year = { year: row.year, items: [] };
      group._years.set(row.year, year);
      group.years.push(year);
    }

    year.items.push({
      id: row.id,
      exam_id: row.exam_id,
      year: row.year,
      day: row.day,
      title: row.title,
      board: row.board || row.exam_board,
      pdf_url: row.pdf_url,
      answer_key_url: row.answer_key_url,
      external_url: row.external_url,
      notes: row.notes,
    });
    group.total += 1;
  }

  return exams.map(({ _years, ...group }) => group);
}

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const { exam_id: examId, year } = req.valid.query;

    const params = [];
    const where = ['pe.active', 'e.active'];
    if (examId) {
      params.push(examId);
      where.push(`pe.exam_id = $${params.length}`);
    }
    if (year) {
      params.push(year);
      where.push(`pe.year = $${params.length}`);
    }

    const [rows, examFilters, yearFilters] = await Promise.all([
      db.many(
        `SELECT ${ITEM_COLUMNS},
                e.name AS exam_name, e.short_name AS exam_short_name, e.track AS exam_track, e.board AS exam_board
           FROM past_exams pe
           JOIN exams e ON e.id = pe.exam_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.sort_order, e.name, pe.year DESC, pe.sort_order, pe.day NULLS LAST, pe.title`,
        params
      ),
      db.many(
        `SELECT e.id, e.name, e.short_name, e.track, count(*)::int AS total
           FROM past_exams pe
           JOIN exams e ON e.id = pe.exam_id
          WHERE pe.active AND e.active
          GROUP BY e.id, e.name, e.short_name, e.track, e.sort_order
          ORDER BY e.sort_order, e.name`
      ),
      db.many(
        `SELECT DISTINCT pe.year
           FROM past_exams pe
           JOIN exams e ON e.id = pe.exam_id
          WHERE pe.active AND e.active
          ORDER BY pe.year DESC`
      ),
    ]);

    const exams = groupByExamAndYear(rows);
    res.json({
      exams,
      total: rows.length,
      filters: { exams: examFilters, years: yearFilters.map((row) => row.year) },
    });
  })
);

module.exports = { basePath: '/api/past-exams', router };

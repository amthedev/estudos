'use strict';

/**
 * Editais visíveis ao aluno.
 *
 *   GET /api/notices              edital vigente da prova do aluno + editais anteriores
 *   GET /api/notices?exam_id=...  força outra prova (o aluno pode consultar antes de escolher)
 *   GET /api/notices/:id          um edital
 *
 * Rota pública: quem ainda não criou conta pode consultar o edital pela página
 * do vestibular. Só devolve editais publicados ou arquivados de provas ativas;
 * rascunho é coisa do painel.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { optionalUser } = require('../middleware/auth');
const dates = require('../utils/dates');

const SELECT_NOTICE = `
  SELECT n.id, n.exam_id, n.year, n.title, n.status, n.board, n.pdf_url, n.external_url, n.summary,
         n.published_at, n.registration_start, n.registration_end, n.exam_date, n.second_exam_date,
         n.result_date, n.vacancies, n.fee_cents, n.highlights, n.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name, e.slug AS exam_slug, e.track AS exam_track
    FROM exam_notices n
    JOIN exams e ON e.id = n.exam_id
   WHERE n.status IN ('published', 'archived') AND e.active`;

/** Dias que faltam para uma data, ou null quando a data não existe ou já passou. */
/**
 * Dias de calendário até a data, no fuso de São Paulo.
 *
 * Comparar o instante de agora com a meia-noite do alvo dava um dia a mais
 * durante a noite: às 21h de Recife, "daqui a 7 dias" virava 8, porque faltava
 * menos de um dia inteiro para a meia-noite e o Math.ceil arredondava para
 * cima. O aluno via o prazo do edital errado todas as noites. A conta certa é
 * entre datas, não entre instantes.
 */
function daysUntil(date) {
  if (!date) return null;
  const diff = dates.diffDays(dates.todayISO(), date);
  return diff !== null && diff >= 0 ? diff : null;
}

/** Acrescenta a contagem regressiva das datas que o aluno acompanha. */
function decorate(notice) {
  if (!notice) return notice;
  return {
    ...notice,
    days_until_exam: daysUntil(notice.exam_date),
    days_until_registration_end: daysUntil(notice.registration_end),
    registration_open:
      Boolean(notice.registration_start) &&
      Boolean(notice.registration_end) &&
      daysUntil(notice.registration_end) !== null &&
      daysUntil(notice.registration_start) === null,
  };
}

router.get(
  '/',
  optionalUser,
  validate({ query: z.object({ exam_id: z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional()) }) }),
  wrap(async (req, res) => {
    let examId = req.valid.query.exam_id ?? null;

    // sem prova na consulta, usa a prova do perfil do aluno logado
    if (!examId && req.user) {
      const profile = await db.one('SELECT exam_id FROM student_profiles WHERE user_id = $1', [req.user.id]);
      examId = profile?.exam_id ?? null;
    }

    const params = [];
    let where = '';
    if (examId) {
      params.push(examId);
      where = ` AND n.exam_id = $${params.length}`;
    }

    const items = await db.many(
      `${SELECT_NOTICE}${where} ORDER BY n.status = 'published' DESC, n.year DESC, n.sort_order`,
      params
    );

    const decorated = items.map(decorate);
    const current = decorated.find((notice) => notice.status === 'published') ?? null;
    res.json({
      exam_id: examId,
      current,
      items: decorated,
      previous: decorated.filter((notice) => notice.id !== current?.id),
    });
  })
);

router.get(
  '/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  wrap(async (req, res) => {
    const notice = await db.one(`${SELECT_NOTICE} AND n.id = $1`, [req.valid.params.id]);
    if (!notice) throw new AppError(404, 'not_found', 'Edital não encontrado.');
    res.json(decorate(notice));
  })
);

module.exports = { basePath: '/api/notices', router };

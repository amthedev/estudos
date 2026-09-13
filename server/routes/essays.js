'use strict';

/**
 * Redação IA — temas, critérios, rascunhos e correção do aluno.
 *
 *   GET    /api/essays/themes?exam_id      → temas da prova (mais os temas gerais)
 *   POST   /api/essays/themes/generate     { exam_id } → gera um tema com IA
 *   GET    /api/essays/criteria?exam_id    → critérios que serão usados na correção
 *   GET    /api/essays                     → redações do aluno (filtros status e exam_id)
 *   GET    /api/essays/stats               → { count, avg, best, evolution[] }
 *   POST   /api/essays                     { exam_id?, theme_id?, theme_title?, content } → rascunho
 *   PUT    /api/essays/:id                 → altera o rascunho (somente status draft)
 *   POST   /api/essays/:id/submit          → corrige com IA de forma síncrona (até 90s)
 *   GET    /api/essays/:id                 → redação + correção + critérios da prova
 *   DELETE /api/essays/:id                 → apaga o rascunho (somente status draft)
 *
 * A correção usa sempre os critérios cadastrados para a PROVA da redação (services/essay.js).
 * Toda consulta filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const essays = require('../services/essay');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { aiLimiter } = require('../middleware/rateLimit');
const { TIMEZONE } = require('../utils/dates');

const MAX_CONTENT_CHARS = essays.MAX_CONTENT_CHARS;
const MAX_THEMES = 60;
const MAX_ESSAYS = 100;
const MAX_EVOLUTION = 60;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const examQuerySchema = z.object({ exam_id: uuid.optional() });

const listQuerySchema = z.object({
  exam_id: uuid.optional(),
  status: z.enum(['draft', 'submitted', 'corrected', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ESSAYS).optional(),
});

const generateSchema = z.object({ exam_id: uuid.optional() }).default({});

const contentField = z.string().max(MAX_CONTENT_CHARS, `A redação deve ter no máximo ${MAX_CONTENT_CHARS} caracteres.`);

const createSchema = z.object({
  exam_id: uuid.optional(),
  theme_id: uuid.nullish(),
  theme_title: z.string().trim().min(3).max(240).optional(),
  content: contentField.optional(),
});

const updateSchema = z
  .object({
    theme_id: uuid.nullish(),
    theme_title: z.string().trim().min(3).max(240).optional(),
    content: contentField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nada para atualizar.' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESSAY_COLUMNS = `
  e.id, e.user_id, e.exam_id, e.theme_id, e.theme_title, e.word_count, e.status, e.score, e.max_score,
  e.model, e.error_message, e.submitted_at, e.corrected_at, e.created_at, e.updated_at,
  x.name AS exam_name, x.short_name AS exam_short_name, x.board AS exam_board`;

const ESSAY_JOINS = 'JOIN exams x ON x.id = e.exam_id';

/** Prova a usar: a informada (se ativa) ou a prova escolhida pelo aluno no perfil. */
async function resolveExamId(userId, requested) {
  if (requested) {
    const exam = await db.one('SELECT id FROM exams WHERE id = $1 AND active', [requested]);
    if (!exam) throw new AppError(404, 'not_found', 'Prova não encontrada.');
    return exam.id;
  }
  const profile = await db.one('SELECT exam_id FROM student_profiles WHERE user_id = $1', [userId]);
  if (!profile || !profile.exam_id) {
    throw new AppError(400, 'validation_error', 'Escolha a prova que você vai prestar antes de usar a redação.');
  }
  return profile.exam_id;
}

/** Tema informado pelo aluno: precisa estar ativo e valer para a prova escolhida (ou ser geral). */
async function resolveTheme(themeId, examId) {
  const theme = await db.one(
    `SELECT id, exam_id, title FROM essay_themes WHERE id = $1 AND active`,
    [themeId]
  );
  if (!theme) throw new AppError(404, 'not_found', 'Tema não encontrado.');
  if (theme.exam_id && examId && theme.exam_id !== examId) {
    throw new AppError(400, 'validation_error', 'Este tema pertence a outra prova.');
  }
  return theme;
}

async function findEssay(userId, id) {
  return db.one(`SELECT ${ESSAY_COLUMNS} FROM essays e ${ESSAY_JOINS} WHERE e.id = $1 AND e.user_id = $2`, [id, userId]);
}

async function findEssayFull(userId, id) {
  return db.one(
    `SELECT ${ESSAY_COLUMNS}, e.content, e.correction,
            t.title AS theme_db_title, t.prompt_text, t.support_texts
       FROM essays e ${ESSAY_JOINS}
       LEFT JOIN essay_themes t ON t.id = e.theme_id
      WHERE e.id = $1 AND e.user_id = $2`,
    [id, userId]
  );
}

/** Conjunto de critérios no formato exibido ao aluno. */
function publicCriteriaSet(set) {
  return {
    exam_id: set.exam_id,
    name: set.name,
    max_score: set.max_score,
    genre: set.genre,
    min_lines: set.min_lines,
    max_lines: set.max_lines,
    generic: Boolean(set.generic),
    requires_intervention: essays.requiresIntervention(set),
    criteria: (set.criteria || []).map((item) => ({
      key: item.key,
      name: item.name,
      max: item.max,
      description: item.description || null,
      guidance: item.guidance || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
router.use(requireStudent, requireAccess);

router.get(
  '/themes',
  validate({ query: examQuerySchema }),
  wrap(async (req, res) => {
    const examId = await resolveExamId(req.user.id, req.valid.query.exam_id);
    const rows = await db.many(
      `SELECT t.id, t.exam_id, t.title, t.prompt_text, t.support_texts, t.source, t.year,
              t.generated_by_ai, t.created_at,
              x.short_name AS exam_short_name
         FROM essay_themes t
         LEFT JOIN exams x ON x.id = t.exam_id
        WHERE t.active AND (t.exam_id = $1 OR t.exam_id IS NULL)
        ORDER BY t.generated_by_ai DESC, t.created_at DESC
        LIMIT $2`,
      [examId, MAX_THEMES]
    );
    res.json(rows);
  })
);

router.post(
  '/themes/generate',
  aiLimiter,
  validate({ body: generateSchema }),
  wrap(async (req, res) => {
    const examId = await resolveExamId(req.user.id, (req.valid.body || {}).exam_id);
    const theme = await essays.generateTheme(examId, { userId: req.user.id });
    res.status(201).json(theme);
  })
);

router.get(
  '/criteria',
  validate({ query: examQuerySchema }),
  wrap(async (req, res) => {
    const examId = await resolveExamId(req.user.id, req.valid.query.exam_id);
    const set = await essays.getCriteriaSet(examId);
    res.json(publicCriteriaSet(set));
  })
);

router.get(
  '/stats',
  wrap(async (req, res) => {
    const totals = await db.one(
      `SELECT count(*)::int AS count,
              avg(score) AS avg,
              max(score) AS best,
              avg(CASE WHEN max_score > 0 THEN score / max_score * 100 END) AS avg_pct
         FROM essays
        WHERE user_id = $1 AND status = 'corrected' AND score IS NOT NULL`,
      [req.user.id]
    );

    const rows = await db.many(
      `SELECT (corrected_at AT TIME ZONE $2::text)::date AS date, score, max_score
         FROM essays
        WHERE user_id = $1 AND status = 'corrected' AND score IS NOT NULL AND corrected_at IS NOT NULL
        ORDER BY corrected_at ASC
        LIMIT $3`,
      [req.user.id, TIMEZONE, MAX_EVOLUTION]
    );

    const round = (value, digits = 1) => {
      if (value === null || value === undefined) return null;
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      const factor = 10 ** digits;
      return Math.round(number * factor) / factor;
    };

    res.json({
      count: totals ? totals.count : 0,
      avg: totals ? round(totals.avg) : null,
      best: totals ? round(totals.best) : null,
      avg_pct: totals ? round(totals.avg_pct) : null,
      evolution: rows.map((row) => ({
        date: row.date,
        score: Number(row.score),
        max: Number(row.max_score),
        pct: row.max_score > 0 ? Math.round((Number(row.score) / Number(row.max_score)) * 100) : 0,
      })),
    });
  })
);

router.get(
  '/',
  validate({ query: listQuerySchema }),
  wrap(async (req, res) => {
    const { exam_id: examId, status, limit } = req.valid.query;
    const params = [req.user.id];
    const where = ['e.user_id = $1'];
    if (examId) {
      params.push(examId);
      where.push(`e.exam_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`e.status = $${params.length}`);
    }
    params.push(limit || MAX_ESSAYS);

    const rows = await db.many(
      `SELECT ${ESSAY_COLUMNS}
         FROM essays e ${ESSAY_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  })
);

router.post(
  '/',
  validate({ body: createSchema }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const examId = await resolveExamId(req.user.id, body.exam_id);

    let themeId = null;
    let themeTitle = body.theme_title || null;
    if (body.theme_id) {
      const theme = await resolveTheme(body.theme_id, examId);
      themeId = theme.id;
      themeTitle = themeTitle || theme.title;
    }
    if (!themeTitle) {
      throw new AppError(400, 'validation_error', 'Escolha um tema ou escreva o título do tema.');
    }

    const content = body.content || '';
    const created = await db.one(
      `INSERT INTO essays (user_id, exam_id, theme_id, theme_title, content, word_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING id`,
      [req.user.id, examId, themeId, themeTitle, content, essays.countWords(content)]
    );

    const essay = await findEssayFull(req.user.id, created.id);
    res.status(201).json(essay);
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const essay = await findEssayFull(req.user.id, req.valid.params.id);
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    const set = await essays.getCriteriaSet(essay.exam_id);
    res.json({ ...essay, criteria_set: publicCriteriaSet(set) });
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateSchema }),
  wrap(async (req, res) => {
    const essay = await findEssay(req.user.id, req.valid.params.id);
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    if (essay.status !== 'draft') {
      throw new AppError(409, 'conflict', 'Esta redação já foi enviada e não pode mais ser alterada.');
    }

    const body = req.valid.body;
    let themeId = essay.theme_id;
    let themeTitle = essay.theme_title;

    if (body.theme_id !== undefined) {
      if (body.theme_id === null) {
        themeId = null;
      } else {
        const theme = await resolveTheme(body.theme_id, essay.exam_id);
        themeId = theme.id;
        themeTitle = theme.title;
      }
    }
    if (body.theme_title !== undefined) themeTitle = body.theme_title;
    if (!themeTitle) throw new AppError(400, 'validation_error', 'Informe o título do tema.');

    const content = body.content !== undefined ? body.content : null;

    await db.query(
      `UPDATE essays
          SET theme_id = $2,
              theme_title = $3,
              content = COALESCE($4, content),
              word_count = CASE WHEN $4::text IS NULL THEN word_count ELSE $5 END
        WHERE id = $1 AND user_id = $6`,
      [essay.id, themeId, themeTitle, content, content === null ? 0 : essays.countWords(content), req.user.id]
    );

    res.json(await findEssayFull(req.user.id, essay.id));
  })
);

router.post(
  '/:id/submit',
  aiLimiter,
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const essay = await findEssayFull(req.user.id, req.valid.params.id);
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    if (essay.status === 'corrected') {
      throw new AppError(409, 'conflict', 'Esta redação já foi corrigida.');
    }
    if (!String(essay.content || '').trim()) {
      throw new AppError(400, 'validation_error', 'Escreva a redação antes de enviar para correção.');
    }

    // "submitted" órfã: a correção anterior foi interrompida (reinício no meio) e
    // ninguém está corrigindo esta redação agora. Sem isto, reenviar era barrado
    // e a redação ficava "em correção" para sempre. Uma correção de verdade em
    // curso dura no máximo o timeout; passado isso com folga, é órfã e pode
    // recomeçar. Uma que ainda esteja dentro da janela é barrada, para não
    // rodar duas correções ao mesmo tempo.
    if (essay.status === 'submitted') {
      const desde = essay.submitted_at ? Date.now() - new Date(essay.submitted_at).getTime() : Infinity;
      if (desde < essays.CORRECTION_TIMEOUT_MS + 30_000) {
        throw new AppError(409, 'conflict', 'Esta redação já está sendo corrigida. Aguarde um instante.');
      }
    }

    await db.query(
      `UPDATE essays SET status = 'submitted', submitted_at = now(), error_message = NULL
        WHERE id = $1 AND user_id = $2`,
      [essay.id, req.user.id]
    );

    // correção síncrona; em caso de falha o serviço marca status 'failed' e relança 503 ai_unavailable
    await essays.correctEssay(essay.id, { timeoutMs: essays.CORRECTION_TIMEOUT_MS });

    const corrected = await findEssayFull(req.user.id, essay.id);
    const set = await essays.getCriteriaSet(corrected.exam_id);
    res.json({ ...corrected, criteria_set: publicCriteriaSet(set) });
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const essay = await findEssay(req.user.id, req.valid.params.id);
    if (!essay) throw new AppError(404, 'not_found', 'Redação não encontrada.');
    if (essay.status !== 'draft') {
      throw new AppError(409, 'conflict', 'Só é possível apagar rascunhos.');
    }
    await db.query('DELETE FROM essays WHERE id = $1 AND user_id = $2', [essay.id, req.user.id]);
    res.status(204).end();
  })
);

module.exports = { basePath: '/api/essays', router };

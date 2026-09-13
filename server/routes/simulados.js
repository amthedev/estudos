'use strict';

/**
 * Simulados do aluno.
 *
 *   GET   /api/simulados                        → { templates, history, stats, catalog, defaults, in_progress }
 *   GET   /api/simulados/catalog?subject_id=    → { topics } (assuntos da matéria com questões disponíveis)
 *   POST  /api/simulados/attempts               → tentativa criada com questões (sem gabarito)
 *   GET   /api/simulados/attempts?status=       → histórico (até 50)
 *   GET   /api/simulados/attempts/:id           → tentativa + questões (+ gabarito e resolução quando finalizada)
 *   PATCH /api/simulados/attempts/:id/answers   { question_id, option_id|null }
 *   POST  /api/simulados/attempts/:id/finish    → resultado com breakdown
 *   POST  /api/simulados/attempts/:id/abandon   → marca como abandonado
 *
 * Todas as consultas filtram por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { aiLimiter } = require('../middleware/rateLimit');
const simulados = require('../services/simulados');

router.use(requireStudent, requireAccess);

const GRACE_SEC = 60;
const HISTORY_LIMIT = 20;

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const filtersSchema = z
  .object({
    exam_id: uuid.optional(),
    subject_ids: z.array(uuid).max(30).optional(),
    topic_ids: z.array(uuid).max(60).optional(),
    difficulty: z.array(z.number().int().min(1).max(3)).max(3).optional(),
    years: z.array(z.number().int().min(1900).max(2100)).max(40).optional(),
    boards: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .strict();

const createSchema = z
  .object({
    type: z.enum(['exam', 'subject', 'topic', 'custom']).optional(),
    // Formato do simulado da prova: completo (80) ou mini (20).
    mode: z.enum(['completo', 'mini']).optional(),
    simulado_id: uuid.optional(),
    exam_id: uuid.optional(),
    subject_id: uuid.optional(),
    topic_id: uuid.optional(),
    question_count: z.number().int().min(1).max(simulados.MAX_QUESTIONS).optional(),
    duration_min: z.number().int().min(5).max(simulados.MAX_DURATION).optional(),
    filters: filtersSchema.optional(),
  })
  .strict()
  .refine((body) => body.type || body.simulado_id, { message: 'Informe o tipo do simulado.', path: ['type'] });

const answerSchema = z
  .object({
    question_id: uuid,
    option_id: uuid.nullable(),
  })
  .strict();

const historyQuery = z.object({
  status: z.enum(['in_progress', 'finished', 'abandoned']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ATTEMPT_LIST_COLUMNS = `
  a.id, a.simulado_id, a.title, a.type, a.exam_id, a.subject_id, a.topic_id, a.duration_min, a.status,
  a.started_at, a.finished_at, a.time_spent_sec, a.score, a.correct_count, a.wrong_count, a.blank_count,
  coalesce(array_length(a.question_ids, 1), 0) AS question_count,
  e.short_name AS exam_short_name, s.name AS subject_name, s.color AS subject_color, t.name AS topic_name`;

const ATTEMPT_JOINS = `
  FROM simulado_attempts a
  LEFT JOIN exams e ON e.id = a.exam_id
  LEFT JOIN subjects s ON s.id = a.subject_id
  LEFT JOIN topics t ON t.id = a.topic_id`;

function remainingSec(attempt) {
  const started = new Date(attempt.started_at).getTime();
  const total = Number(attempt.duration_min) * 60;
  const elapsed = Math.floor((Date.now() - started) / 1000);
  return Math.max(0, total - elapsed);
}

/**
 * Quantos segundos passaram do prazo (negativo enquanto ainda há tempo).
 *
 * `remainingSec` nunca fica abaixo de zero, então a regra de "tempo esgotado"
 * escrita em cima dela — `remainingSec(...) + GRACE_SEC <= 0` — nunca era
 * verdadeira: um simulado cronometrado aceitava resposta dias depois do prazo,
 * e o `{ expired: true }` prometido à tela nunca chegava.
 */
function overdueSec(attempt) {
  const total = Number(attempt.duration_min) * 60;
  if (!Number.isFinite(total) || total <= 0) return -Infinity;
  const started = new Date(attempt.started_at).getTime();
  return Math.floor((Date.now() - started) / 1000) - total;
}

function serializeAttempt(row) {
  const out = { ...row };
  delete out.user_id;
  if (row.status === 'in_progress') {
    out.remaining_sec = remainingSec(row);
    out.expired = out.remaining_sec <= 0;
  }
  return out;
}

async function loadAttempt(userId, id) {
  const row = await db.one(`SELECT a.*, ${ATTEMPT_LIST_COLUMNS.replace(/^\s*a\.id,[^]*?a\.blank_count,/, '')} ${ATTEMPT_JOINS} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  if (!row) throw new AppError(404, 'not_found', 'Simulado não encontrado.');
  return row;
}

/** Questões públicas (sem gabarito) ou com correção, conforme o status. */
async function questionsFor(attempt) {
  const finished = attempt.status === 'finished';
  const rows = await simulados.loadAttemptQuestions(attempt.question_ids, { withAnswers: finished });
  const answers = attempt.answers && typeof attempt.answers === 'object' ? attempt.answers : {};
  return rows.map((q, index) => {
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => ({ id: o.id, letter: o.letter, text: o.text }));
    const base = {
      number: index + 1,
      id: q.id,
      statement: q.statement,
      image_url: q.image_url,
      difficulty: q.difficulty,
      year: q.year,
      board: q.board,
      subject_id: q.subject_id,
      subject_name: q.subject_name,
      subject_color: q.subject_color,
      topic_id: q.topic_id,
      topic_name: q.topic_name,
      options,
      selected_option_id: answers[q.id] || null,
    };
    if (!finished) return base;
    const correct = (q.options || []).find((o) => o.is_correct) || null;
    const selected = answers[q.id] || null;
    return {
      ...base,
      correct_option_id: correct ? correct.id : null,
      is_correct: Boolean(selected && correct && selected === correct.id),
      blank: !selected,
      resolution: q.resolution,
      explanation: q.explanation,
    };
  });
}

async function attemptPayload(attempt) {
  const questions = await questionsFor(attempt);
  return { ...serializeAttempt(attempt), questions };
}

async function templateAvailability(template) {
  if (Array.isArray(template.question_ids) && template.question_ids.length) {
    const row = await db.one(
      `SELECT count(*) AS total FROM questions q
         JOIN subjects s ON s.id = q.subject_id JOIN topics t ON t.id = q.topic_id
        WHERE q.id = ANY($1::uuid[]) AND q.active AND s.active AND t.active`,
      [template.question_ids]
    );
    return row ? Number(row.total) : 0;
  }
  const filters = template.config && typeof template.config === 'object' && template.config.filters ? template.config.filters : {};
  return simulados.countAvailable({
    examId: template.exam_id,
    subjectId: template.type === 'subject' ? template.subject_id : null,
    topicId: template.type === 'topic' ? template.topic_id : null,
    filters: template.type === 'custom' ? filters : {},
  });
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
router.get(
  '/',
  wrap(async (req, res) => {
    const userId = req.user.id;
    const profile = await db.one(
      `SELECT p.exam_id, e.id AS e_id, e.name AS exam_name, e.short_name, e.track
         FROM student_profiles p LEFT JOIN exams e ON e.id = p.exam_id AND e.active
        WHERE p.user_id = $1`,
      [userId]
    );
    const exam = profile && profile.e_id ? { id: profile.e_id, name: profile.exam_name, short_name: profile.short_name, track: profile.track } : null;

    const [templatesRaw, history, statsRow, exams, subjects, inProgress] = await Promise.all([
      db.many(
        `SELECT m.id, m.name, m.description, m.type, m.exam_id, m.subject_id, m.topic_id, m.duration_min,
                m.question_count, m.question_ids, m.config,
                e.short_name AS exam_short_name, e.name AS exam_name, s.name AS subject_name, s.color AS subject_color,
                t.name AS topic_name
           FROM simulados m
           LEFT JOIN exams e ON e.id = m.exam_id
           LEFT JOIN subjects s ON s.id = m.subject_id
           LEFT JOIN topics t ON t.id = m.topic_id
          WHERE m.active
          ORDER BY (m.exam_id = $1) DESC NULLS LAST, m.created_at DESC`,
        [profile ? profile.exam_id : null]
      ),
      db.many(
        `SELECT ${ATTEMPT_LIST_COLUMNS} ${ATTEMPT_JOINS}
          WHERE a.user_id = $1 AND a.status <> 'abandoned'
          ORDER BY a.started_at DESC
          LIMIT $2`,
        [userId, HISTORY_LIMIT]
      ),
      db.one(
        `SELECT count(*) AS count, round(avg(score)::numeric, 1) AS avg_score, max(score) AS best_score,
                sum(correct_count) AS total_correct, sum(coalesce(array_length(question_ids, 1), 0)) AS total_questions
           FROM simulado_attempts WHERE user_id = $1 AND status = 'finished'`,
        [userId]
      ),
      db.many('SELECT id, slug, name, short_name, track FROM exams WHERE active ORDER BY sort_order, name'),
      db.many(
        `SELECT s.id, s.name, s.color, s.icon,
                (SELECT count(*) FROM questions q JOIN topics t ON t.id = q.topic_id
                  WHERE q.subject_id = s.id AND q.active AND t.active) AS question_count,
                EXISTS (SELECT 1 FROM exam_subjects es WHERE es.subject_id = s.id AND es.exam_id = $1) AS in_exam
           FROM subjects s
          WHERE s.active
          ORDER BY in_exam DESC, s.sort_order, s.name`,
        [profile ? profile.exam_id : null]
      ),
      db.one(
        `SELECT ${ATTEMPT_LIST_COLUMNS} ${ATTEMPT_JOINS}
          WHERE a.user_id = $1 AND a.status = 'in_progress'
          ORDER BY a.started_at DESC LIMIT 1`,
        [userId]
      ),
    ]);

    // Quantas questões a IA pode acrescentar a um simulado. Zero significa que
    // o que está no banco é tudo o que existe.
    const aiFill = await simulados.aiFillLimit();

    const templates = [];
    for (const template of templatesRaw) {
      const available = await templateAvailability(template);
      const pedido = template.question_ids && template.question_ids.length
        ? template.question_ids.length
        : Number(template.question_count) || 0;
      templates.push({
        id: template.id,
        name: template.name,
        description: template.description,
        type: template.type,
        type_label: simulados.TYPE_LABELS[template.type],
        exam_id: template.exam_id,
        exam_name: template.exam_name,
        exam_short_name: template.exam_short_name,
        subject_id: template.subject_id,
        subject_name: template.subject_name,
        subject_color: template.subject_color,
        topic_id: template.topic_id,
        topic_name: template.topic_name,
        duration_min: template.duration_min,
        question_count: template.question_ids && template.question_ids.length ? template.question_ids.length : template.question_count,
        available_count: available,
        // "Pode começar" não é "tem tudo": faltando questão, a IA completa até
        // o teto. Dizer "sem questões suficientes" com uma questão no banco era
        // mentira nos dois sentidos — barrava quem podia começar e escondia o
        // quanto faltava de quem começava.
        missing: Math.max(0, pedido - available),
        can_start: available > 0 || aiFill > 0,
      });
    }

    const defaults = {
      exam: simulados.getDefaults('exam', exam ? exam.track : null),
      subject: simulados.getDefaults('subject'),
      topic: simulados.getDefaults('topic'),
      custom: simulados.getDefaults('custom'),
      max: { question_count: simulados.MAX_QUESTIONS, duration_min: simulados.MAX_DURATION },
      modes: Object.entries(simulados.EXAM_MODES).map(([key, preset]) => ({ key, ...preset })),
      ai_fill: { max: aiFill },
    };

    const examAvailable = exam ? await simulados.countAvailable({ examId: exam.id }) : 0;

    res.json({
      exam: exam ? { ...exam, available_count: examAvailable } : null,
      templates,
      history: history.map(serializeAttempt),
      in_progress: inProgress ? serializeAttempt(inProgress) : null,
      stats: {
        count: Number(statsRow ? statsRow.count : 0) || 0,
        avg_score: statsRow && statsRow.avg_score !== null ? Number(statsRow.avg_score) : null,
        best_score: statsRow && statsRow.best_score !== null ? Number(statsRow.best_score) : null,
        total_correct: Number(statsRow ? statsRow.total_correct : 0) || 0,
        total_questions: Number(statsRow ? statsRow.total_questions : 0) || 0,
      },
      catalog: {
        exams,
        subjects: subjects.map((s) => ({ ...s, question_count: Number(s.question_count) || 0 })),
      },
      defaults,
    });
  })
);

router.get(
  '/catalog',
  validate({ query: z.object({ subject_id: uuid }) }),
  wrap(async (req, res) => {
    const topics = await db.many(
      `SELECT t.id, t.name, t.sort_order,
              (SELECT count(*) FROM questions q WHERE q.topic_id = t.id AND q.active) AS question_count
         FROM topics t
        WHERE t.subject_id = $1 AND t.active
        ORDER BY t.sort_order, t.name`,
      [req.valid.query.subject_id]
    );
    res.json({ topics: topics.map((t) => ({ ...t, question_count: Number(t.question_count) || 0 })) });
  })
);

// ---------------------------------------------------------------------------
// Tentativas
// ---------------------------------------------------------------------------
router.post(
  '/attempts',
  // Montar um simulado pode acionar a IA para completar o que falta no banco.
  aiLimiter,
  validate({ body: createSchema }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const created = await simulados.buildAttempt({
      userId: req.user.id,
      type: body.type,
      mode: body.mode || null,
      simuladoId: body.simulado_id || null,
      examId: body.exam_id || null,
      subjectId: body.subject_id || null,
      topicId: body.topic_id || null,
      questionCount: body.question_count ?? null,
      durationMin: body.duration_min ?? null,
      filters: body.filters || {},
    });
    const attempt = await loadAttempt(req.user.id, created.id);
    res.status(201).json(await attemptPayload(attempt));
  })
);

router.get(
  '/attempts',
  validate({ query: historyQuery }),
  wrap(async (req, res) => {
    const { status, limit = 50 } = req.valid.query;
    const params = [req.user.id, limit];
    let where = 'a.user_id = $1';
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }
    const rows = await db.many(
      `SELECT ${ATTEMPT_LIST_COLUMNS} ${ATTEMPT_JOINS} WHERE ${where} ORDER BY a.started_at DESC LIMIT $2`,
      params
    );
    res.json(rows.map(serializeAttempt));
  })
);

router.get(
  '/attempts/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const attempt = await loadAttempt(req.user.id, req.valid.params.id);
    res.json(await attemptPayload(attempt));
  })
);

router.patch(
  '/attempts/:id/answers',
  validate({ params: idParams, body: answerSchema }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const attempt = await db.one('SELECT * FROM simulado_attempts WHERE id = $1 AND user_id = $2', [req.valid.params.id, userId]);
    if (!attempt) throw new AppError(404, 'not_found', 'Simulado não encontrado.');
    if (attempt.status !== 'in_progress') throw new AppError(409, 'conflict', 'Este simulado já foi finalizado.');
    if (overdueSec(attempt) > GRACE_SEC) {
      throw new AppError(409, 'conflict', 'O tempo do simulado terminou. Finalize para ver o resultado.', { expired: true });
    }

    const { question_id: questionId, option_id: optionId } = req.valid.body;
    if (!attempt.question_ids.includes(questionId)) {
      throw new AppError(400, 'validation_error', 'Esta questão não faz parte do simulado.');
    }
    if (optionId) {
      const option = await db.one('SELECT id FROM question_options WHERE id = $1 AND question_id = $2', [optionId, questionId]);
      if (!option) throw new AppError(400, 'validation_error', 'Alternativa inválida para esta questão.');
    }

    const updated = optionId
      ? await db.one(
          `UPDATE simulado_attempts SET answers = answers || jsonb_build_object($3::text, $4::text)
            WHERE id = $1 AND user_id = $2 RETURNING answers, question_ids`,
          [attempt.id, userId, questionId, optionId]
        )
      : await db.one(
          `UPDATE simulado_attempts SET answers = answers - $3::text
            WHERE id = $1 AND user_id = $2 RETURNING answers, question_ids`,
          [attempt.id, userId, questionId]
        );

    const answers = updated.answers || {};
    const answered = Object.keys(answers).length;
    res.json({
      ok: true,
      question_id: questionId,
      option_id: optionId || null,
      answered_count: answered,
      blank_count: Math.max(0, updated.question_ids.length - answered),
      remaining_sec: remainingSec(attempt),
    });
  })
);

router.post(
  '/attempts/:id/finish',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    await simulados.finishAttempt(req.user.id, req.valid.params.id);
    const attempt = await loadAttempt(req.user.id, req.valid.params.id);
    res.json(await attemptPayload(attempt));
  })
);

router.post(
  '/attempts/:id/abandon',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const row = await db.one(
      `UPDATE simulado_attempts SET status = 'abandoned', finished_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
        RETURNING id, status`,
      [req.valid.params.id, req.user.id]
    );
    if (!row) throw new AppError(404, 'not_found', 'Simulado em andamento não encontrado.');
    res.json({ ok: true, id: row.id, status: row.status });
  })
);

module.exports = { basePath: '/api/simulados', router };

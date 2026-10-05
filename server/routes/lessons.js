'use strict';

/**
 * Aulas (biblioteca de conteúdo — visão do aluno).
 *
 *   GET  /api/lessons                 ?subject_id&topic_id&status=done|pending|in_progress&q&page&limit&all=1 → paginado
 *   GET  /api/lessons/continue        últimas 6 aulas em andamento
 *   GET  /api/lessons/:id             aula + topics[] (assuntos na ordem, com quantas questões da prática
 *                                     cabem a cada um) + exams[] + progress + note + favorited
 *                                     + next_lesson + prev_lesson
 *   POST /api/lessons/:id/start       marca como em andamento (não desfaz conclusão)
 *   POST /api/lessons/:id/complete    conclui: study_log, revisões (services/reviews), item do cronograma
 *                                     → { progress, reviews_created, ... }
 *   POST /api/lessons/:id/practice    { difficulty } → 3 questões divididas entre os assuntos da aula
 *                                     (3 assuntos: uma de cada; 2: duas do primeiro e uma do segundo;
 *                                     1: as três dele), na dificuldade escolhida. Usa o banco primeiro e
 *                                     pede à IA o que faltar (services/question-ai) — sem gabarito.
 *                                     Chamar a IA custa moedas; sem saldo, entrega só o banco com `notice`
 *   PUT  /api/lessons/:id/note        { content } upsert da anotação da aula
 *
 * A listagem respeita o syllabus da prova do aluno (ver services/progress.js).
 */
const crypto = require('node:crypto');
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { parsePagination, paginate } = require('../utils/pagination');
const { todayISO } = require('../utils/dates');
const progress = require('../services/progress');
const questionAi = require('../services/question-ai');
const coins = require('../services/coins');
const { getQuestionsByIds } = require('../services/questions');
const { aiLimiter } = require('../middleware/rateLimit');

router.use(requireStudent, requireAccess);

const CONTINUE_LIMIT = 6;

const MOEDAS_ACABARAM_PRATICA =
  'Suas moedas de hoje acabaram, então esta prática trouxe só as questões que já estavam no banco. As moedas voltam à meia-noite.';

const flag = z
  .string()
  .optional()
  .transform((value) => value === '1' || value === 'true');

const idParams = z.object({ id: z.string().uuid() });

// A dificuldade é escolha do aluno: fácil, média ou difícil sobre o assunto da aula.
const practiceBody = z
  .object({ difficulty: z.coerce.number().int().min(1).max(3).optional() })
  .strict();

const listQuery = z
  .object({
    subject_id: z.string().uuid().optional(),
    topic_id: z.string().uuid().optional(),
    subtopic_id: z.string().uuid().optional(),
    status: z.enum(['done', 'pending', 'in_progress']).optional(),
    q: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    all: flag,
  })
  .passthrough();

const noteBody = z.object({
  content: z.string().max(50_000),
  title: z.string().trim().max(200).optional(),
});

const LESSON_LIST_COLUMNS = `
  l.id, l.slug, l.title, l.description, l.duration_min, l.difficulty, l.teacher_name, l.thumbnail_url,
  l.video_provider, l.sort_order, l.subject_id, s.name AS subject_name, s.color AS subject_color,
  s.icon AS subject_icon, l.topic_id, t.name AS topic_name, l.subtopic_id, st.name AS subtopic_name,
  lp.status, lp.started_at, lp.completed_at,
  coalesce(lp.status = 'completed', false) AS completed,
  EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = $1 AND f.item_type = 'lesson' AND f.item_id = l.id) AS favorited`;

const LESSON_LIST_FROM = `
  FROM lessons l
  JOIN subjects s ON s.id = l.subject_id AND s.active
  JOIN topics t ON t.id = l.topic_id AND t.active
  LEFT JOIN subtopics st ON st.id = l.subtopic_id
  LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1`;

const LESSON_ORDER = 'ORDER BY s.sort_order, s.name, t.sort_order, t.name, l.sort_order, l.title';

/**
 * Carrega a aula ativa ou lança 404.
 *
 * `topics` são os assuntos da aula na ordem do título (lesson_topics), cada um
 * com `practice_questions`: quantas das três questões da prática saem dele. A
 * tela usa isso para prometer o que a prática entrega de fato. Os campos
 * topic_id/topic_name continuam sendo o assunto principal (o primeiro).
 */
async function loadLesson(id) {
  const lesson = await db.one(
    `SELECT l.*, s.name AS subject_name, s.slug AS subject_slug, s.color AS subject_color, s.icon AS subject_icon,
            t.name AS topic_name, t.slug AS topic_slug, t.description AS topic_description,
            st.name AS subtopic_name,
            coalesce((
              SELECT json_agg(json_build_object(
                       'position', lt.position, 'topic_id', lt.topic_id, 'topic_name', tt.name,
                       'topic_slug', tt.slug, 'subtopic_id', lt.subtopic_id, 'subtopic_name', sst.name
                     ) ORDER BY lt.position)
                FROM lesson_topics lt
                JOIN topics tt ON tt.id = lt.topic_id AND tt.active
                LEFT JOIN subtopics sst ON sst.id = lt.subtopic_id
               WHERE lt.lesson_id = l.id
            ), '[]'::json) AS topics
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN topics t ON t.id = l.topic_id
       LEFT JOIN subtopics st ON st.id = l.subtopic_id
      WHERE l.id = $1 AND l.active`,
    [id]
  );
  if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada.');
  delete lesson.search_vector;
  // Interno da fila de geração: não é assunto do aluno.
  delete lesson.questions_status;
  delete lesson.questions_error;
  delete lesson.questions_updated_at;

  const topics = Array.isArray(lesson.topics) && lesson.topics.length
    ? lesson.topics
    : [{
        position: 1,
        topic_id: lesson.topic_id,
        topic_name: lesson.topic_name,
        topic_slug: lesson.topic_slug,
        subtopic_id: lesson.subtopic_id || null,
        subtopic_name: lesson.subtopic_name || null,
      }];
  const vagas = questionAi.distribute(topics.length);
  lesson.topics = topics.map((topic, index) => ({ ...topic, practice_questions: vagas[index] || 0 }));
  return lesson;
}

/** Normaliza o retorno de services/reviews.scheduleReviews (array, número ou objeto). */
function countReviews(result) {
  if (Array.isArray(result)) return result.length;
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object') {
    if (Array.isArray(result.reviews)) return result.reviews.length;
    if (Array.isArray(result.created)) return result.created.length;
    const n = Number(result.created ?? result.count ?? result.total ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Agenda revisões pela conclusão da aula; o módulo é de outro agente e pode não existir ainda. */
async function scheduleReviewsSafely(userId, { topicId, lessonId, subjectId }) {
  let reviews;
  try {
    reviews = require('../services/reviews');
  } catch {
    return { created: 0, available: false };
  }
  try {
    if (typeof reviews.scheduleReviews !== 'function') return { created: 0, available: false };
    const result = await reviews.scheduleReviews(userId, { topicId, lessonId, subjectId });
    return { created: countReviews(result), available: true };
  } catch (err) {
    console.error('[lessons] falha ao agendar revisões:', err.message);
    return { created: 0, available: true };
  }
}

// ---------------------------------------------------------------------------
// Listagem e "continuar assistindo"
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const query = req.valid.query;
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });

    const scope = await progress.resolveScope(userId, { all: query.all, subjectId: query.subject_id || null });
    const params = [userId];
    const where = ['l.active', progress.lessonScopeSql(scope, params)];

    if (query.subject_id) {
      params.push(query.subject_id);
      where.push(`l.subject_id = $${params.length}`);
    }
    // filtrar por assunto acha a aula também onde ele é secundário (lesson_topics),
    // igual à página do assunto
    if (query.topic_id) {
      params.push(query.topic_id);
      where.push(progress.lessonCoversTopicSql(`$${params.length}`));
    }
    if (query.subtopic_id) {
      params.push(query.subtopic_id);
      where.push(`EXISTS (SELECT 1 FROM lesson_topics lts WHERE lts.lesson_id = l.id AND lts.subtopic_id = $${params.length})`);
    }
    if (query.status === 'done') where.push(`lp.status = 'completed'`);
    else if (query.status === 'in_progress') where.push(`lp.status = 'in_progress'`);
    else if (query.status === 'pending') where.push(`(lp.status IS NULL OR lp.status <> 'completed')`);
    if (query.q) {
      params.push(query.q);
      const idx = params.length;
      params.push(`%${query.q}%`);
      // o nome de qualquer assunto da aula vale na busca, não só o do principal
      where.push(
        `(l.search_vector @@ plainto_tsquery('portuguese', fe_unaccent($${idx}))
          OR fe_unaccent(l.title) ILIKE fe_unaccent($${idx + 1})
          OR EXISTS (SELECT 1 FROM lesson_topics ltq JOIN topics tq ON tq.id = ltq.topic_id
                      WHERE ltq.lesson_id = l.id AND fe_unaccent(tq.name) ILIKE fe_unaccent($${idx + 1})))`
      );
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await db.one(`SELECT count(*) AS total ${LESSON_LIST_FROM} ${whereSql}`, params);
    const total = countRow ? countRow.total : 0;

    params.push(limit, offset);
    const items = await db.many(
      `SELECT ${LESSON_LIST_COLUMNS} ${LESSON_LIST_FROM} ${whereSql} ${LESSON_ORDER}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginate(items, total, { page, limit }));
  })
);

router.get(
  '/continue',
  wrap(async (req, res) => {
    const items = await db.many(
      `SELECT ${LESSON_LIST_COLUMNS} ${LESSON_LIST_FROM}
        WHERE l.active AND lp.status = 'in_progress'
        ORDER BY lp.started_at DESC
        LIMIT $2`,
      [req.user.id, CONTINUE_LIMIT]
    );
    res.json(items);
  })
);

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);

    const [exams, progressRow, note, favorited, neighbors, questions] = await Promise.all([
      db.many(
        `SELECT e.id, e.slug, e.name, e.short_name, e.track
           FROM lesson_exams le JOIN exams e ON e.id = le.exam_id AND e.active
          WHERE le.lesson_id = $1
          ORDER BY e.sort_order, e.name`,
        [lesson.id]
      ),
      db.one('SELECT status, started_at, completed_at FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]),
      db.one('SELECT id, title, content, updated_at FROM notes WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]),
      db.one(`SELECT 1 FROM favorites WHERE user_id = $1 AND item_type = 'lesson' AND item_id = $2`, [userId, lesson.id]),
      db.one(
        `WITH ordered AS (
           SELECT l.id,
                  lag(l.id)  OVER w AS prev_id,
                  lead(l.id) OVER w AS next_id
             FROM lessons l
             JOIN topics t ON t.id = l.topic_id AND t.active
            WHERE l.subject_id = $1 AND l.active
           WINDOW w AS (ORDER BY t.sort_order, t.name, l.sort_order, l.title)
         )
         SELECT prev_id, next_id FROM ordered WHERE id = $2`,
        [lesson.subject_id, lesson.id]
      ),
      // as questões de todos os assuntos da aula, não só do principal
      db.one('SELECT count(*) AS total FROM questions WHERE topic_id = ANY($1::uuid[]) AND active', [
        lesson.topics.map((topic) => topic.topic_id),
      ]),
    ]);

    const siblingIds = [neighbors && neighbors.prev_id, neighbors && neighbors.next_id].filter(Boolean);
    const siblings = siblingIds.length
      ? await db.many(
          `SELECT l.id, l.title, l.duration_min, l.topic_id, t.name AS topic_name
             FROM lessons l JOIN topics t ON t.id = l.topic_id
            WHERE l.id = ANY($1::uuid[])`,
          [siblingIds]
        )
      : [];
    const byId = new Map(siblings.map((row) => [row.id, row]));

    res.json({
      ...lesson,
      exams,
      progress: progressRow || null,
      note: note || null,
      favorited: Boolean(favorited),
      prev_lesson: (neighbors && byId.get(neighbors.prev_id)) || null,
      next_lesson: (neighbors && byId.get(neighbors.next_id)) || null,
      questions_available: questions ? questions.total : 0,
    });
  })
);

// ---------------------------------------------------------------------------
// Progresso
// ---------------------------------------------------------------------------
router.post(
  '/:id/start',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const lesson = await loadLesson(req.valid.params.id);
    const row = await db.one(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, started_at)
       VALUES ($1, $2, 'in_progress', now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE
         SET started_at = CASE WHEN lesson_progress.status = 'in_progress' THEN now() ELSE lesson_progress.started_at END
       RETURNING status, started_at, completed_at`,
      [req.user.id, lesson.id]
    );
    res.json({ lesson_id: lesson.id, progress: row });
  })
);

router.post(
  '/:id/complete',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);
    const today = todayISO();

    const outcome = await db.tx(async (client) => {
      const current = await client.one('SELECT status FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [userId, lesson.id]);
      const alreadyCompleted = Boolean(current && current.status === 'completed');

      const progressRow = await client.one(
        `INSERT INTO lesson_progress (user_id, lesson_id, status, started_at, completed_at)
         VALUES ($1, $2, 'completed', now(), now())
         ON CONFLICT (user_id, lesson_id) DO UPDATE
           SET status = 'completed',
               completed_at = coalesce(lesson_progress.completed_at, now())
         RETURNING status, started_at, completed_at`,
        [userId, lesson.id]
      );

      let studyMinutes = 0;
      if (!alreadyCompleted) {
        studyMinutes = Number(lesson.duration_min) || 0;
        await client.query(
          `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
           VALUES ($1, 'lesson', $2, $3, $4, $5)`,
          [userId, lesson.id, lesson.subject_id, studyMinutes, today]
        );
      }

      const scheduled = await client.query(
        `UPDATE schedule_items SET status = 'done', completed_at = now()
          WHERE user_id = $1 AND lesson_id = $2 AND status = 'pending' AND date <= $3`,
        [userId, lesson.id, today]
      );

      return { progressRow, alreadyCompleted, studyMinutes, scheduleItemsDone: scheduled.rowCount || 0 };
    });

    let reviews = { created: 0, available: false };
    if (!outcome.alreadyCompleted) {
      reviews = await scheduleReviewsSafely(userId, { topicId: lesson.topic_id, lessonId: lesson.id, subjectId: lesson.subject_id });
    }

    res.json({
      lesson_id: lesson.id,
      progress: outcome.progressRow,
      reviews_created: reviews.created,
      already_completed: outcome.alreadyCompleted,
      study_minutes: outcome.studyMinutes,
      schedule_items_done: outcome.scheduleItemsDone,
    });
  })
);

// ---------------------------------------------------------------------------
// Pratique agora
// ---------------------------------------------------------------------------
router.post(
  '/:id/practice',
  aiLimiter,
  validate({ params: idParams, body: practiceBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);
    const difficulty = questionAi.difficultyOf(req.valid.body.difficulty);

    // Três vagas divididas entre os assuntos da aula, cada uma com o assunto
    // dela. O banco vem primeiro: questão de prova vale mais que questão
    // elaborada na hora, e não gasta chamada de IA.
    const targets = await questionAi.lessonTargets(lesson);
    const candidates = await questionAi.bankCandidates({
      topicIds: targets.map((alvo) => alvo.topic_id),
      difficulty,
      userId,
    });
    const assigned = questionAi.assignCandidates(targets, candidates);
    const doBanco = assigned.filter((item) => item.question_id).length;

    const vazias = assigned.filter((item) => !item.question_id);
    const faltando = vazias.map((item) => item.target);
    let geradas = [];
    let aviso = null;
    let avisoCodigo = null;
    let semMoedas = null;
    if (faltando.length) {
      // A moeda só é cobrada quando a IA vai trabalhar: prática que sai inteira
      // do banco não custa nada. Sem saldo, a prática não é recusada — sai com
      // o que o banco tem e um aviso, do mesmo jeito que a cota diária de IA.
      // A cota diária vem antes da moeda: cobrar e logo em seguida recusar
      // deixaria um débito e um estorno no extrato a cada clique.
      let chargeId = null;
      let chamaIa = true;
      try {
        await questionAi.assertDailyQuota(userId);
        ({ chargeId } = await coins.charge(db, {
          user: req.user,
          access: req.access,
          action: 'practice',
          cost: (await coins.readCosts()).practice,
          refType: 'lesson_practice',
          refId: crypto.randomUUID(),
        }));
      } catch (err) {
        if (err.code !== 'insufficient_coins' && err.code !== 'ai_limit_reached') throw err;
        chamaIa = false;
        if (err.code === 'insufficient_coins') semMoedas = err;
        aviso = err.code === 'insufficient_coins' ? MOEDAS_ACABARAM_PRATICA : err.message;
        avisoCodigo = err.code;
      }

      if (chamaIa) {
        const exam = await db.one(
          `SELECT e.id, e.name, e.short_name, e.board
             FROM student_profiles p JOIN exams e ON e.id = p.exam_id AND e.active
            WHERE p.user_id = $1`,
          [userId]
        );
        // Quem espera é a tela, atrás de uma borda que corta perto dos 100
        // segundos. Com o prazo longo, a IA respondia depois do corte: a moeda
        // ficava cobrada e a prática não chegava a ninguém. O prazo de tela
        // cabe antes do corte, e a aba fechada para a IA — sem nada entregue,
        // a moeda volta logo abaixo.
        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', onClose);
        try {
          // Cada alvo leva o assunto dele: a questão nasce no assunto certo.
          geradas = await questionAi.generateItems({
            subject: { id: lesson.subject_id, name: lesson.subject_name },
            topic: { id: lesson.topic_id, name: lesson.topic_name, description: lesson.topic_description },
            lesson,
            exam,
            difficulty,
            targets: faltando,
            userId,
            timeoutMs: questionAi.TIMEOUT_INTERATIVO_MS,
            signal: controller.signal,
          });
        } catch (err) {
          // Prática com duas questões é melhor que prática nenhuma: a IA falhar
          // não pode derrubar o que o banco já tinha.
          console.error(`[lessons] não foi possível elaborar questões da aula ${lesson.id}: ${err.message}`);
          aviso = err.code === 'ai_limit_reached' ? err.message : null;
          avisoCodigo = aviso ? err.code : null;
        } finally {
          res.off('close', onClose);
        }
        // Nada novo saiu da IA: o aluno não recebeu o que pagou.
        if (!geradas.length) await coins.refund(chargeId, 'nenhuma questão nova elaborada');
      }
    }

    // Cada questão elaborada vai para a vaga do alvo a que ela responde, não
    // para o próximo buraco da fila: se a IA devolver duas de Porcentagem e
    // nenhuma de Regra de Três, a vaga de Regra de Três fica vazia em vez de
    // receber uma questão de outro assunto.
    for (const gerada of geradas) {
      const vaga = vazias[gerada.index];
      if (vaga && !vaga.question_id) vaga.question_id = gerada.id;
    }
    const ids = assigned.map((item) => item.question_id).filter(Boolean);
    const questions = await getQuestionsByIds(ids);

    if (!questions.length) {
      // Sem nada no banco e sem moedas para a IA, não há prática para
      // entregar: aí sim o aluno recebe a recusa das moedas, com o saldo e a
      // hora em que elas voltam.
      if (semMoedas) throw semMoedas;
      throw new AppError(
        503,
        'ai_unavailable',
        aviso || 'Não foi possível montar a prática deste assunto agora. Tente novamente em instantes.'
      );
    }

    res.json({
      questions: questions.map((question) => ({
        ...question,
        lesson_id: lesson.id,
        subject_name: question.subject_name || lesson.subject_name,
        // o assunto da própria questão: numa aula de três assuntos, cada uma tem o seu
        topic_name: question.topic_name || lesson.topic_name,
      })),
      difficulty,
      from_bank: doBanco,
      generated: Math.max(0, questions.length - doBanco),
      // o recorte de cada vaga, na ordem (subassunto quando há, senão o assunto)
      subjects: targets.map((alvo) => alvo.name),
      topics: lesson.topics.map((topic) => ({
        topic_id: topic.topic_id,
        topic_name: topic.topic_name,
        questions: topic.practice_questions,
      })),
      notice: aviso,
      // Diz à tela por que o aviso apareceu: 'insufficient_coins' pede o
      // caminho para os planos; 'ai_limit_reached', só esperar até amanhã.
      notice_code: avisoCodigo,
    });
  })
);

// ---------------------------------------------------------------------------
// Anotação da aula (autosave)
// ---------------------------------------------------------------------------
router.put(
  '/:id/note',
  validate({ params: idParams, body: noteBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const lesson = await loadLesson(req.valid.params.id);
    const { content, title } = req.valid.body;

    const note = await db.one(
      `INSERT INTO notes (user_id, lesson_id, subject_id, topic_id, title, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, lesson_id) WHERE lesson_id IS NOT NULL DO UPDATE
         SET content = EXCLUDED.content,
             title = CASE WHEN $7::boolean THEN EXCLUDED.title ELSE notes.title END,
             subject_id = EXCLUDED.subject_id,
             topic_id = EXCLUDED.topic_id
       RETURNING id, lesson_id, subject_id, topic_id, title, content, created_at, updated_at`,
      [userId, lesson.id, lesson.subject_id, lesson.topic_id, title || lesson.title, content, title !== undefined]
    );
    res.json(note);
  })
);

module.exports = { basePath: '/api/lessons', router };

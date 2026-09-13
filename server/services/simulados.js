'use strict';

/**
 * Regras de negócio dos simulados.
 *
 *   const { buildAttempt, finishAttempt, getDefaults, countAvailable } = require('../services/simulados');
 *
 *   buildAttempt({ userId, type, mode, examId, subjectId, topicId, questionCount, durationMin, filters, simuladoId })
 *     → cria simulado_attempts com as questões sorteadas e devolve a tentativa.
 *       - type 'exam': distribui as questões pelos pesos de exam_subjects, respeitando a
 *         disponibilidade (questão vinculada à prova em question_exams ou assunto no syllabus
 *         exam_topics). Sobra de uma matéria é redistribuída às demais.
 *       - mode 'completo' (80 questões) ou 'mini' (20), para o tipo 'exam'.
 *       - quando o banco não tem o suficiente, a IA elabora o que falta (services/question-ai) e
 *         as questões ficam no banco para os próximos simulados.
 *       - evita questões respondidas nos últimos 7 dias quando há questões inéditas suficientes.
 *       - embaralhamento determinístico: ordena por sha256(seed + question_id); a seed fica em
 *         config.seed para reproduzir o sorteio.
 *
 *   finishAttempt(userId, attemptId)
 *     → corrige, grava question_attempts (context 'simulado'), atualiza o caderno de erros,
 *       registra study_log e calcula score (0–100), acertos/erros/em branco e breakdown por
 *       matéria e por assunto. Aceita após o tempo esgotar (time_spent = duração).
 */
const crypto = require('node:crypto');
const db = require('../db/pool');
const { AppError } = require('../middleware/errors');
const { todayISO } = require('../utils/dates');
const questionAi = require('./question-ai');
const { getSetting } = require('./settings');

const MAX_QUESTIONS = 90;
// Um simulado completo de 80 questões no ritmo do ENEM passa de três horas.
// Com o teto em 180 minutos, o tempo era cortado em silêncio e o aluno recebia
// metade do prazo que a prova real dá.
const MAX_DURATION = 330;
const RECENT_DAYS = 7;

/** Padrões de quantidade/duração por tipo (e por trilha da prova para o tipo 'exam'). */
const DEFAULTS = Object.freeze({
  exam: Object.freeze({
    enem: Object.freeze({ question_count: 45, duration_min: 90 }),
    barro_branco: Object.freeze({ question_count: 40, duration_min: 80 }),
    vestibular: Object.freeze({ question_count: 30, duration_min: 60 }),
  }),
  subject: Object.freeze({ question_count: 20, duration_min: 30 }),
  topic: Object.freeze({ question_count: 10, duration_min: 15 }),
  custom: Object.freeze({ question_count: 20, duration_min: 30 }),
});

const TYPE_LABELS = { exam: 'Simulado da prova', subject: 'Por matéria', topic: 'Por assunto', custom: 'Personalizado' };

/**
 * Formatos de simulado da prova, do jeito que o aluno escolhe na tela:
 * o completo, para treinar fôlego, e o mini, para caber em uma sessão de
 * estudo. Sem formato escolhido valem os padrões da trilha da prova.
 */
const EXAM_MODES = Object.freeze({
  completo: Object.freeze({ label: 'Simulado completo', question_count: 80, duration_min: 240 }),
  mini: Object.freeze({ label: 'Mini simulado', question_count: 20, duration_min: 60 }),
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Padrões para um tipo (e trilha). O formato, quando informado, manda. */
function getDefaults(type, track, mode) {
  if (type === 'exam') {
    if (mode && EXAM_MODES[mode]) {
      const { question_count, duration_min } = EXAM_MODES[mode];
      return { question_count, duration_min };
    }
    return { ...(DEFAULTS.exam[track] || DEFAULTS.exam.vestibular) };
  }
  return { ...(DEFAULTS[type] || DEFAULTS.custom) };
}

function clampCount(value, fallback) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_QUESTIONS, n));
}

function clampDuration(value, fallback) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.max(5, Math.min(MAX_DURATION, n));
}

// ---------------------------------------------------------------------------
// Pool de questões
// ---------------------------------------------------------------------------

/**
 * Monta a consulta de candidatas. A regra de disponibilidade por prova vale sempre que
 * examId é informado: questão vinculada em question_exams OU assunto presente em exam_topics.
 */
function buildPoolQuery({ examId, subjectId, topicId, filters = {} } = {}) {
  const params = [];
  const where = ['q.active = true', 's.active = true', 't.active = true'];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (examId) {
    const p = add(examId);
    where.push(
      `(EXISTS (SELECT 1 FROM question_exams qe WHERE qe.question_id = q.id AND qe.exam_id = ${p})
        OR EXISTS (SELECT 1 FROM exam_topics et WHERE et.topic_id = q.topic_id AND et.exam_id = ${p}))`
    );
  }
  if (subjectId) where.push(`q.subject_id = ${add(subjectId)}`);
  if (topicId) where.push(`q.topic_id = ${add(topicId)}`);
  if (Array.isArray(filters.subject_ids) && filters.subject_ids.length) {
    where.push(`q.subject_id = ANY(${add(filters.subject_ids)}::uuid[])`);
  }
  if (Array.isArray(filters.topic_ids) && filters.topic_ids.length) {
    where.push(`q.topic_id = ANY(${add(filters.topic_ids)}::uuid[])`);
  }
  if (Array.isArray(filters.difficulty) && filters.difficulty.length) {
    where.push(`q.difficulty = ANY(${add(filters.difficulty)}::smallint[])`);
  }
  if (Array.isArray(filters.years) && filters.years.length) {
    where.push(`q.year = ANY(${add(filters.years)}::int[])`);
  }
  if (Array.isArray(filters.boards) && filters.boards.length) {
    where.push(`q.board = ANY(${add(filters.boards)}::text[])`);
  }

  const sql = `SELECT q.id, q.subject_id, q.topic_id, q.difficulty, s.sort_order AS subject_order
                 FROM questions q
                 JOIN subjects s ON s.id = q.subject_id
                 JOIN topics t ON t.id = q.topic_id
                WHERE ${where.join(' AND ')}`;
  return { sql, params };
}

async function loadPool(options) {
  const { sql, params } = buildPoolQuery(options);
  return db.many(sql, params);
}

/** Quantidade de questões disponíveis para o contexto informado. */
async function countAvailable(options) {
  const { sql, params } = buildPoolQuery(options);
  const row = await db.one(`SELECT count(*) AS total FROM (${sql}) pool`, params);
  return row ? Number(row.total) : 0;
}

/** Ids de questões respondidas pelo aluno nos últimos dias. */
async function recentlyAnswered(userId, days = RECENT_DAYS) {
  const rows = await db.many(
    `SELECT DISTINCT question_id FROM question_attempts
      WHERE user_id = $1 AND answered_at > now() - ($2::int * interval '1 day')`,
    [userId, days]
  );
  return new Set(rows.map((r) => r.question_id));
}

/**
 * Distribui `total` questões entre itens com { weight, available } proporcionalmente ao peso,
 * respeitando a disponibilidade e redistribuindo sobras.
 */
function distribute(items, total) {
  const counts = items.map(() => 0);
  let left = Math.min(total, items.reduce((sum, item) => sum + item.available, 0));
  let guard = 0;
  while (left > 0 && guard < 100) {
    guard += 1;
    const open = items
      .map((item, i) => ({ i, weight: Number(item.weight) > 0 ? Number(item.weight) : 1, room: item.available - counts[i] }))
      .filter((o) => o.room > 0);
    if (!open.length) break;
    const sumWeight = open.reduce((sum, o) => sum + o.weight, 0);
    const shares = open.map((o) => ({ ...o, exact: left * (o.weight / sumWeight) }));
    let assigned = 0;
    for (const share of shares) {
      const add = Math.min(Math.floor(share.exact), share.room);
      counts[share.i] += add;
      assigned += add;
      share.remainder = share.exact - add;
    }
    left -= assigned;
    if (left <= 0) break;
    if (assigned === 0) {
      shares.sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.i - b.i);
      for (const share of shares) {
        if (left <= 0) break;
        if (counts[share.i] < items[share.i].available) {
          counts[share.i] += 1;
          left -= 1;
        }
      }
    }
  }
  return counts;
}

/** Ordena candidatas: inéditas primeiro, depois recentes; dentro de cada grupo por hash da seed. */
function rankCandidates(candidates, seed, recent) {
  return candidates
    .map((q) => ({ ...q, rank: sha256(`${seed}:${q.id}`), fresh: !recent.has(q.id) }))
    .sort((a, b) => (a.fresh === b.fresh ? (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0) : a.fresh ? -1 : 1));
}

function shuffleByHash(list, seed) {
  return list
    .map((q) => ({ q, rank: sha256(`${seed}:order:${q.id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((item) => item.q);
}

// ---------------------------------------------------------------------------
// Seleção por tipo
// ---------------------------------------------------------------------------

async function selectForExam({ exam, questionCount, seed, recent, filters }) {
  const examSubjects = await db.many(
    `SELECT es.subject_id, es.weight, s.name, s.sort_order
       FROM exam_subjects es
       JOIN subjects s ON s.id = es.subject_id AND s.active
      WHERE es.exam_id = $1
      ORDER BY s.sort_order, s.name`,
    [exam.id]
  );
  if (!examSubjects.length) {
    throw new AppError(409, 'conflict', 'Esta prova ainda não tem matérias configuradas para gerar simulados.');
  }
  const pool = await loadPool({ examId: exam.id, filters });
  const bySubject = new Map();
  for (const q of pool) {
    if (!bySubject.has(q.subject_id)) bySubject.set(q.subject_id, []);
    bySubject.get(q.subject_id).push(q);
  }
  const items = examSubjects.map((es) => ({
    subject_id: es.subject_id,
    weight: Number(es.weight) || 1,
    available: (bySubject.get(es.subject_id) || []).length,
  }));
  const counts = distribute(items, questionCount);
  const selected = [];
  const distribution = [];
  items.forEach((item, i) => {
    const take = counts[i];
    if (take <= 0) return;
    const ranked = rankCandidates(bySubject.get(item.subject_id) || [], seed, recent);
    const chosen = ranked.slice(0, take);
    // agrupado por matéria (ordem da prova), embaralhado dentro da matéria
    selected.push(...shuffleByHash(chosen, `${seed}:${item.subject_id}`));
    distribution.push({ subject_id: item.subject_id, count: chosen.length });
  });
  return { questions: selected, distribution };
}

async function selectFromPool({ poolOptions, questionCount, seed, recent }) {
  const pool = await loadPool(poolOptions);
  const ranked = rankCandidates(pool, seed, recent).slice(0, questionCount);
  return { questions: shuffleByHash(ranked, seed), distribution: summarizeDistribution(ranked) };
}

function summarizeDistribution(questions) {
  const counts = new Map();
  for (const q of questions) counts.set(q.subject_id, (counts.get(q.subject_id) || 0) + 1);
  return Array.from(counts.entries()).map(([subject_id, count]) => ({ subject_id, count }));
}

// ---------------------------------------------------------------------------
// Complemento por IA
// ---------------------------------------------------------------------------

/** Teto de questões que a IA pode elaborar para UM simulado (configurável no painel). */
async function aiFillLimit() {
  const value = Number(await getSetting('simulado_ai_questions_max'));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_QUESTIONS, Math.floor(value));
}

/**
 * Completa o simulado com questões elaboradas por IA, até o teto do painel.
 *
 * O trabalho de escolher assuntos e chamar o modelo é de services/question-ai:
 * a mesma coisa acontece no banco de questões do aluno, e duas cópias
 * divergiriam. Aqui fica só o teto, que é regra do simulado.
 */
async function fillWithAi({ missing, examId, subjectId, topicId, filters, difficulty, userId }) {
  const teto = Math.min(missing, await aiFillLimit());
  if (teto <= 0) return [];
  return questionAi.fillPool({ examId, subjectId, topicId, filters, difficulty, count: teto, userId });
}

// ---------------------------------------------------------------------------
// Criação da tentativa
// ---------------------------------------------------------------------------

async function loadExam(examId) {
  if (!examId) return null;
  return db.one('SELECT id, slug, name, short_name, track FROM exams WHERE id = $1 AND active', [examId]);
}

async function loadProfileExam(userId) {
  return db.one(
    `SELECT e.id, e.slug, e.name, e.short_name, e.track
       FROM student_profiles p
       JOIN exams e ON e.id = p.exam_id AND e.active
      WHERE p.user_id = $1`,
    [userId]
  );
}

/**
 * @param {object} input
 * @returns {Promise<object>} tentativa criada (linha de simulado_attempts) com `distribution` em config
 */
async function buildAttempt({
  userId,
  type,
  mode = null,
  examId = null,
  subjectId = null,
  topicId = null,
  questionCount = null,
  durationMin = null,
  filters = {},
  simuladoId = null,
} = {}) {
  let template = null;
  if (simuladoId) {
    template = await db.one('SELECT * FROM simulados WHERE id = $1 AND active', [simuladoId]);
    if (!template) throw new AppError(404, 'not_found', 'Modelo de simulado não encontrado.');
    type = template.type;
    examId = examId || template.exam_id;
    subjectId = subjectId || template.subject_id;
    topicId = topicId || template.topic_id;
    if (template.config && typeof template.config === 'object' && template.config.filters) {
      filters = { ...template.config.filters, ...(filters || {}) };
    }
  }
  if (!['exam', 'subject', 'topic', 'custom'].includes(type)) {
    throw new AppError(400, 'validation_error', 'Tipo de simulado inválido.');
  }
  filters = filters && typeof filters === 'object' ? filters : {};

  // contexto (prova / matéria / assunto)
  let exam = null;
  let subject = null;
  let topic = null;

  if (type === 'exam') {
    exam = examId ? await loadExam(examId) : await loadProfileExam(userId);
    if (!exam) {
      throw new AppError(
        400,
        'validation_error',
        examId ? 'Prova não encontrada.' : 'Defina sua prova no perfil para gerar o simulado.'
      );
    }
  } else if (examId || filters.exam_id) {
    exam = await loadExam(examId || filters.exam_id);
    if (!exam) throw new AppError(400, 'validation_error', 'Prova não encontrada.');
  }

  if (type === 'topic') {
    if (!topicId) throw new AppError(400, 'validation_error', 'Escolha um assunto.');
    topic = await db.one(
      `SELECT t.id, t.name, t.subject_id, s.name AS subject_name
         FROM topics t JOIN subjects s ON s.id = t.subject_id
        WHERE t.id = $1 AND t.active AND s.active`,
      [topicId]
    );
    if (!topic) throw new AppError(400, 'validation_error', 'Assunto não encontrado.');
    subjectId = topic.subject_id;
  }
  if (type === 'subject' || subjectId) {
    if (type === 'subject' && !subjectId) throw new AppError(400, 'validation_error', 'Escolha uma matéria.');
    subject = await db.one('SELECT id, name, color FROM subjects WHERE id = $1 AND active', [subjectId]);
    if (!subject) throw new AppError(400, 'validation_error', 'Matéria não encontrada.');
  }

  // quantidade e duração
  const defaults = getDefaults(type, exam ? exam.track : null, mode);
  if (template) {
    defaults.question_count = template.question_count || defaults.question_count;
    defaults.duration_min = template.duration_min || defaults.duration_min;
  }
  let count = clampCount(questionCount, defaults.question_count);
  const duration = clampDuration(durationMin, defaults.duration_min);

  const seed = sha256(`${userId}:${type}:${simuladoId || ''}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`);
  const recent = await recentlyAnswered(userId);

  let questions = [];
  let distribution = [];
  const curatedIds = template && Array.isArray(template.question_ids) ? template.question_ids : [];

  if (curatedIds.length) {
    // modelo com questões fixas escolhidas pelo admin (mantém a ordem, salvo shuffle_questions)
    const rows = await db.many(
      `SELECT q.id, q.subject_id, q.topic_id FROM questions q
         JOIN subjects s ON s.id = q.subject_id JOIN topics t ON t.id = q.topic_id
        WHERE q.id = ANY($1::uuid[]) AND q.active AND s.active AND t.active`,
      [curatedIds]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    questions = curatedIds.map((id) => byId.get(id)).filter(Boolean);
    if (template.config && template.config.shuffle_questions) questions = shuffleByHash(questions, seed);
    count = questions.length;
    distribution = summarizeDistribution(questions);
  } else if (type === 'exam') {
    ({ questions, distribution } = await selectForExam({ exam, questionCount: count, seed, recent, filters }));
  } else {
    const poolOptions = {
      examId: exam ? exam.id : null,
      subjectId: type === 'subject' ? subject.id : type === 'topic' ? null : null,
      topicId: type === 'topic' ? topic.id : null,
      filters: type === 'custom' ? filters : {},
    };
    ({ questions, distribution } = await selectFromPool({ poolOptions, questionCount: count, seed, recent }));
  }

  // Banco curto: a IA completa. O modelo fixo do administrador é exceção — ele
  // escolheu questão por questão, e acrescentar outra desfaria a escolha dele.
  let generated = 0;
  if (!curatedIds.length && questions.length < count) {
    const novas = await fillWithAi({
      missing: count - questions.length,
      examId: exam ? exam.id : null,
      subjectId: type === 'subject' ? subject.id : null,
      topicId: type === 'topic' ? topic.id : null,
      filters: type === 'custom' ? filters : {},
      difficulty: Array.isArray(filters.difficulty) && filters.difficulty.length ? filters.difficulty[0] : 2,
      userId,
    });
    if (novas.length) {
      generated = novas.length;
      questions = shuffleByHash(questions.concat(novas), seed);
      distribution = summarizeDistribution(questions);
    }
  }

  if (!questions.length) {
    throw new AppError(409, 'conflict', 'Ainda não há questões disponíveis para este simulado. Tente outra configuração.');
  }

  let title;
  if (template) title = template.name;
  else if (type === 'exam') title = `Simulado ${exam.short_name}`;
  else if (type === 'subject') title = `Simulado de ${subject.name}`;
  else if (type === 'topic') title = `Simulado: ${topic.name}`;
  else title = 'Simulado personalizado';

  const config = {
    seed,
    type_label: TYPE_LABELS[type],
    mode: mode && EXAM_MODES[mode] ? mode : null,
    requested_count: count,
    // O que saiu pode ser menos do que o pedido quando nem o banco nem a IA
    // deram conta. Guardar os dois é o que permite explicar a diferença.
    delivered_count: questions.length,
    generated_count: generated,
    duration_min: duration,
    filters,
    distribution,
    template_id: template ? template.id : null,
  };

  return db.one(
    `INSERT INTO simulado_attempts
       (user_id, simulado_id, title, type, exam_id, subject_id, topic_id, config, question_ids, duration_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid[], $10)
     RETURNING *`,
    [
      userId,
      template ? template.id : null,
      title,
      type,
      exam ? exam.id : null,
      subject ? subject.id : null,
      topic ? topic.id : null,
      JSON.stringify(config),
      questions.map((q) => q.id),
      duration,
    ]
  );
}

// ---------------------------------------------------------------------------
// Finalização e correção
// ---------------------------------------------------------------------------

/** Questões de uma tentativa com gabarito (uso interno / resultado). */
async function loadAttemptQuestions(questionIds, { withAnswers = false } = {}) {
  if (!questionIds.length) return [];
  const rows = await db.many(
    `SELECT q.id, q.statement, q.image_url, q.difficulty, q.year, q.board, q.subject_id, q.topic_id,
            ${withAnswers ? 'q.resolution, q.explanation,' : ''}
            s.name AS subject_name, s.color AS subject_color, t.name AS topic_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', o.id, 'letter', o.letter, 'text', o.text${withAnswers ? ", 'is_correct', o.is_correct" : ''}
                     ) ORDER BY o.sort_order, o.letter)
                FROM question_options o WHERE o.question_id = q.id
            ), '[]'::json) AS options
       FROM questions q
       JOIN subjects s ON s.id = q.subject_id
       JOIN topics t ON t.id = q.topic_id
      WHERE q.id = ANY($1::uuid[])`,
    [questionIds]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return questionIds.map((id) => byId.get(id)).filter(Boolean);
}

function pct(correct, total) {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
}

function buildBreakdown(graded) {
  const subjects = new Map();
  const topics = new Map();
  for (const g of graded) {
    const s = subjects.get(g.subject_id) || {
      subject_id: g.subject_id,
      name: g.subject_name,
      color: g.subject_color,
      total: 0,
      correct: 0,
      wrong: 0,
      blank: 0,
    };
    s.total += 1;
    if (g.blank) s.blank += 1;
    else if (g.is_correct) s.correct += 1;
    else s.wrong += 1;
    subjects.set(g.subject_id, s);

    const t = topics.get(g.topic_id) || {
      topic_id: g.topic_id,
      name: g.topic_name,
      subject_id: g.subject_id,
      subject_name: g.subject_name,
      color: g.subject_color,
      total: 0,
      correct: 0,
      wrong: 0,
      blank: 0,
    };
    t.total += 1;
    if (g.blank) t.blank += 1;
    else if (g.is_correct) t.correct += 1;
    else t.wrong += 1;
    topics.set(g.topic_id, t);
  }
  const finish = (list) =>
    list
      .map((item) => ({ ...item, pct: pct(item.correct, item.total) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR'));
  return { by_subject: finish([...subjects.values()]), by_topic: finish([...topics.values()]) };
}

/** Recalcula o cronograma após o simulado, se o módulo existir. Nunca lança. */
async function regenerateScheduleSafely(userId) {
  let schedule;
  try {
    schedule = require('./schedule');
  } catch {
    return false;
  }
  try {
    if (typeof schedule.regenerateFromTomorrow === 'function') {
      await schedule.regenerateFromTomorrow(userId);
      return true;
    }
  } catch (err) {
    console.error('[simulados] falha ao recalcular o cronograma:', err.message);
  }
  return false;
}

/**
 * Finaliza e corrige a tentativa do aluno.
 * @returns {Promise<object>} tentativa atualizada (linha de simulado_attempts)
 */
async function finishAttempt(userId, attemptId) {
  const attempt = await db.one('SELECT * FROM simulado_attempts WHERE id = $1 AND user_id = $2', [attemptId, userId]);
  if (!attempt) throw new AppError(404, 'not_found', 'Simulado não encontrado.');
  if (attempt.status === 'finished') throw new AppError(409, 'conflict', 'Este simulado já foi finalizado.');
  if (attempt.status === 'abandoned') throw new AppError(409, 'conflict', 'Este simulado foi abandonado.');

  const questions = await loadAttemptQuestions(attempt.question_ids, { withAnswers: true });
  const answers = attempt.answers && typeof attempt.answers === 'object' ? attempt.answers : {};

  const graded = questions.map((q) => {
    const options = Array.isArray(q.options) ? q.options : [];
    const correct = options.find((o) => o.is_correct) || null;
    const selectedId = answers[q.id] || null;
    const selected = selectedId ? options.find((o) => o.id === selectedId) || null : null;
    const blank = !selected;
    const isCorrect = Boolean(selected && correct && selected.id === correct.id);
    return {
      question_id: q.id,
      subject_id: q.subject_id,
      subject_name: q.subject_name,
      subject_color: q.subject_color,
      topic_id: q.topic_id,
      topic_name: q.topic_name,
      selected_option_id: selected ? selected.id : null,
      correct_option_id: correct ? correct.id : null,
      blank,
      is_correct: isCorrect,
    };
  });

  const total = graded.length;
  const correctCount = graded.filter((g) => g.is_correct).length;
  const blankCount = graded.filter((g) => g.blank).length;
  const wrongCount = total - correctCount - blankCount;
  const score = pct(correctCount, total);
  const breakdown = buildBreakdown(graded);

  const startedAt = new Date(attempt.started_at).getTime();
  const durationSec = Number(attempt.duration_min) * 60;
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const timeSpentSec = Math.min(elapsedSec, durationSec);
  const answeredCount = total - blankCount;
  const perAnswerSec = answeredCount > 0 ? Math.round(timeSpentSec / answeredCount) : null;

  const updated = await db.tx(async (client) => {
    for (const g of graded) {
      if (g.blank) continue; // registra uma linha por resposta
      await client.query(
        `INSERT INTO question_attempts
           (user_id, question_id, subject_id, topic_id, selected_option_id, is_correct, context, context_id, time_spent_sec)
         VALUES ($1, $2, $3, $4, $5, $6, 'simulado', $7, $8)`,
        [userId, g.question_id, g.subject_id, g.topic_id, g.selected_option_id, g.is_correct, attempt.id, perAnswerSec]
      );
      if (!g.is_correct) {
        await client.query(
          `INSERT INTO error_notebook (user_id, question_id, subject_id, topic_id, wrong_option_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, question_id) DO UPDATE
             SET times_wrong = error_notebook.times_wrong + 1,
                 wrong_option_id = EXCLUDED.wrong_option_id,
                 resolved = false,
                 resolved_at = NULL,
                 last_wrong_at = now()`,
          [userId, g.question_id, g.subject_id, g.topic_id, g.selected_option_id]
        );
      }
    }

    await client.query(
      `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
       VALUES ($1, 'simulado', $2, $3, $4, $5)`,
      [userId, attempt.id, attempt.subject_id, Math.max(1, Math.round(timeSpentSec / 60)), todayISO()]
    );

    return client.one(
      `UPDATE simulado_attempts
          SET status = 'finished', finished_at = now(), time_spent_sec = $3, score = $4,
              correct_count = $5, wrong_count = $6, blank_count = $7, breakdown = $8::jsonb
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [attempt.id, userId, timeSpentSec, score, correctCount, wrongCount, blankCount, JSON.stringify(breakdown)]
    );
  });

  // adaptação do cronograma (não bloqueia a resposta)
  regenerateScheduleSafely(userId);

  return updated;
}

module.exports = {
  DEFAULTS,
  MAX_QUESTIONS,
  MAX_DURATION,
  EXAM_MODES,
  aiFillLimit,
  TYPE_LABELS,
  getDefaults,
  buildAttempt,
  finishAttempt,
  countAvailable,
  loadAttemptQuestions,
  distribute,
  buildPoolQuery,
};

'use strict';

/**
 * Motor do cronograma adaptativo (ARCHITECTURE §5).
 *
 *   const schedule = require('../services/schedule');
 *   await schedule.generateSchedule(userId, { from: '2026-09-10', days: 14 });
 *   await schedule.regenerateFromTomorrow(userId);      // onboarding, perfil, simulado, prática fraca
 *   await schedule.ensureScheduleAhead(userId);         // gera mais quando restam menos de 7 dias
 *   await schedule.getScheduleRange(userId, { from, to });
 *   await schedule.getToday(userId);
 *   await schedule.completeItem(userId, itemId);
 *   await schedule.skipToday(userId);
 *   await schedule.afterPractice(userId, { lessonId, correct, total });
 *
 * Regras principais:
 *   - capacidade do dia = hours_per_day × 60 (itens preservados do dia já descontam da capacidade);
 *   - prioridade: revisões devidas (até 30% do dia) → redação semanal → simulado quinzenal →
 *     aulas/assuntos por pontuação → bloco de questões;
 *   - pontuação da matéria = peso × (1 + fraqueza) × (1,25 se for a matéria fraca do perfil) ×
 *     (1 − progresso) × urgência (cresce quando faltam menos de 60 dias para a prova);
 *   - rotação de 2 a 3 matérias por dia; dentro da matéria, o próximo assunto não estudado na ordem
 *     de exam_topics (peso) + topics.sort_order;
 *   - geração 100% determinística (nenhum uso de Math.random);
 *   - regenerar preserva itens concluídos/pulados e itens manuais (generated = false).
 *
 * Todas as consultas filtram por user_id.
 */
const db = require('../db/pool');
const dates = require('../utils/dates');
const studyPlan = require('./study-plan');
const { getSetting } = require('./settings');

const DEFAULT_HORIZON_DAYS = 14;
const MAX_HORIZON_DAYS = 60;
/** Gera mais dias quando o cronograma tem menos de uma semana pela frente. */
const AHEAD_THRESHOLD_DAYS = 7;
const LESSON_EXTRA_MIN = 10;
const TOPIC_BLOCK_MIN = 40;
const ESSAY_BLOCK_MIN = 60;
const SIMULADO_BLOCK_MIN = 90;
const REVIEW_SHARE = 0.3;
const URGENCY_WINDOW_DAYS = 60;
const WEAK_ACCURACY_PCT = 60;
const PERFORMANCE_WINDOW_DAYS = 60;
/** Âncora fixa para a contagem de quinzenas (mantém o simulado no mesmo ciclo entre regerações). */
const FORTNIGHT_EPOCH = '2024-01-01';
/** Sem gerar nada, espera este intervalo antes de tentar de novo (evita reprocessar a cada request). */
const EMPTY_RETRY_MS = 6 * 60 * 60 * 1000;

const SCHEDULE_DEFAULTS = Object.freeze({
  questions_block_min: 20,
  review_block_min: 15,
  essay_weekly: true,
  simulado_every_days: 14,
});

/** Tipo do item → activity_type do study_log. */
const ACTIVITY_BY_TYPE = Object.freeze({
  lesson: 'lesson',
  topic: 'schedule',
  questions: 'questions',
  review: 'review',
  essay: 'essay',
  simulado: 'simulado',
  custom: 'manual',
});

const ITEM_COLUMNS = `
  si.id, si.date, si.position, si.type, si.title, si.subject_id, si.topic_id, si.lesson_id, si.review_id,
  si.duration_min, si.start_time, si.status, si.generated, si.note, si.completed_at, si.created_at,
  s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
  t.name AS topic_name,
  l.thumbnail_url AS lesson_thumbnail_url,
  r.due_date AS review_due_date, r.stage AS review_stage`;

const ITEM_FROM = `
  FROM schedule_items si
  LEFT JOIN subjects s ON s.id = si.subject_id
  LEFT JOIN topics t ON t.id = si.topic_id
  LEFT JOIN lessons l ON l.id = si.lesson_id
  LEFT JOIN reviews r ON r.id = si.review_id`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Configurações do cronograma (settings.schedule_defaults), com padrões seguros. */
async function getScheduleDefaults() {
  const raw = (await getSetting('schedule_defaults')) || {};
  return {
    questions_block_min: positiveInt(raw.questions_block_min, SCHEDULE_DEFAULTS.questions_block_min),
    review_block_min: positiveInt(raw.review_block_min, SCHEDULE_DEFAULTS.review_block_min),
    essay_weekly: raw.essay_weekly === undefined ? SCHEDULE_DEFAULTS.essay_weekly : Boolean(raw.essay_weekly),
    simulado_every_days: positiveInt(raw.simulado_every_days, SCHEDULE_DEFAULTS.simulado_every_days),
  };
}

/** Dias de estudo normalizados: inteiros 0–6, sem repetição, em ordem. */
function normalizeStudyDays(value) {
  const list = Array.isArray(value) ? value : [];
  const unique = new Set();
  for (const raw of list) {
    const day = Number(raw);
    if (Number.isInteger(day) && day >= 0 && day <= 6) unique.add(day);
  }
  return [...unique].sort((a, b) => a - b);
}

/** Perfil do aluno + prova escolhida (null quando o aluno ainda não tem perfil). */
async function loadProfile(userId) {
  const profile = await db.one(
    `SELECT p.user_id, p.exam_id, p.other_exam_name, p.study_days, p.hours_per_day, p.level,
            p.weakest_subject_id, p.exam_date, p.weekly_goal_hours, p.onboarding_completed, p.schedule_generated_at,
            e.name AS exam_name, e.short_name AS exam_short_name, e.track AS exam_track,
            e.has_essay AS exam_has_essay, e.exam_date AS exam_default_date
       FROM student_profiles p
       LEFT JOIN exams e ON e.id = p.exam_id
      WHERE p.user_id = $1`,
    [userId]
  );
  if (!profile) return null;
  profile.study_days = normalizeStudyDays(profile.study_days);
  profile.hours_per_day = Number(profile.hours_per_day) || 0;
  return profile;
}

/** Data efetiva da prova: a informada pelo aluno ou a padrão do vestibular. */
function effectiveExamDate(profile) {
  return dates.toISODate(profile.exam_date) || dates.toISODate(profile.exam_default_date) || null;
}

/** Capacidade diária em minutos. */
function dailyCapacity(profile) {
  const minutes = Math.round((Number(profile.hours_per_day) || 0) * 60);
  return clamp(minutes, 0, 12 * 60);
}

/** Link da tela correspondente ao item (usado pelo dashboard e pelo cronograma). */
function itemHref(item) {
  switch (item.type) {
    case 'lesson':
      return item.lesson_id ? `/app/aulas/${item.lesson_id}` : '/app/aulas';
    case 'topic':
      return item.subject_id && item.topic_id
        ? `/app/materias/${item.subject_id}/assuntos/${item.topic_id}`
        : '/app/materias';
    case 'review':
      return '/app/revisoes';
    case 'essay':
      return '/app/redacao/nova';
    case 'simulado':
      return '/app/simulados';
    case 'questions':
      if (item.topic_id) return `/app/questoes?topic_id=${item.topic_id}`;
      if (item.subject_id) return `/app/questoes?subject_id=${item.subject_id}`;
      return '/app/questoes';
    // dia de resumo: leva de volta à aula, onde ficam o resumo e as anotações
    case 'summary':
      if (item.lesson_id) return `/app/aulas/${item.lesson_id}`;
      if (item.subject_id && item.topic_id) return `/app/materias/${item.subject_id}/assuntos/${item.topic_id}`;
      return '/app/resumos';
    case 'past_exam':
      return '/app/provas-anteriores';
    case 'training':
      return '/app/cronograma';
    default:
      return '/app/cronograma';
  }
}

/** Linha do banco → item da API (com href pronto e horário em HH:MM). */
function serializeItem(row) {
  const item = {
    id: row.id,
    date: row.date,
    position: Number(row.position) || 0,
    type: row.type,
    title: row.title,
    subject_id: row.subject_id,
    subject_name: row.subject_name || null,
    subject_color: row.subject_color || null,
    subject_icon: row.subject_icon || null,
    topic_id: row.topic_id,
    topic_name: row.topic_name || null,
    lesson_id: row.lesson_id,
    lesson_thumbnail_url: row.lesson_thumbnail_url || null,
    review_id: row.review_id,
    review_due_date: row.review_due_date || null,
    review_stage: row.review_stage === null || row.review_stage === undefined ? null : Number(row.review_stage),
    duration_min: Number(row.duration_min) || 0,
    start_time: typeof row.start_time === 'string' ? row.start_time.slice(0, 5) : null,
    status: row.status,
    generated: row.generated,
    note: row.note || null,
    completed_at: row.completed_at || null,
  };
  item.href = itemHref(item);
  return item;
}

async function listItems(userId, from, to) {
  const rows = await db.many(
    `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
      WHERE si.user_id = $1 AND si.date BETWEEN $2 AND $3
      ORDER BY si.date, si.position, si.created_at`,
    [userId, from, to]
  );
  return rows.map(serializeItem);
}

async function findItem(userId, itemId) {
  const row = await db.one(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE si.user_id = $1 AND si.id = $2`, [userId, itemId]);
  return row ? serializeItem(row) : null;
}

function sumMinutes(items, filter = () => true) {
  return items.reduce((total, item) => (filter(item) ? total + (Number(item.duration_min) || 0) : total), 0);
}

/**
 * Agrupa os itens por dia dentro do intervalo, marcando os dias de estudo.
 * @returns {{ date, is_study_day, items, total_min, done_min }[]}
 */
function groupByDay(items, { from, to, studyDays }) {
  const byDate = new Map();
  for (const item of items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
  }
  return dates.eachDay(from, to).map((date) => {
    const dayItems = byDate.get(date) || [];
    return {
      date,
      weekday: dates.weekday(date),
      is_study_day: studyDays.includes(dates.weekday(date)),
      items: dayItems,
      total_min: sumMinutes(dayItems),
      done_min: sumMinutes(dayItems, (item) => item.status === 'done'),
    };
  });
}

// ---------------------------------------------------------------------------
// Dados de planejamento
// ---------------------------------------------------------------------------

/**
 * Carrega matérias (com peso), assuntos na ordem do edital, aulas pendentes e desempenho.
 * Sem prova escolhida, todas as matérias ativas entram com peso 1.
 */
async function loadPlan(userId, profile) {
  const examId = profile.exam_id || null;

  let subjects = [];
  if (examId) {
    subjects = await db.many(
      `SELECT s.id, s.name, s.color, s.icon, s.sort_order, es.weight
         FROM subjects s
         JOIN exam_subjects es ON es.subject_id = s.id AND es.exam_id = $1
        WHERE s.active
        ORDER BY s.sort_order, s.name`,
      [examId]
    );
  }
  if (subjects.length === 0) {
    subjects = await db.many(
      `SELECT s.id, s.name, s.color, s.icon, s.sort_order, 1::numeric AS weight
         FROM subjects s WHERE s.active ORDER BY s.sort_order, s.name`
    );
  }
  if (subjects.length === 0) return { subjects: [], topicsBySubject: new Map(), accuracyBySubject: new Map(), accuracyByTopic: new Map() };

  const subjectIds = subjects.map((row) => row.id);
  const useSyllabus = examId
    ? Boolean(await db.one('SELECT 1 FROM exam_topics WHERE exam_id = $1 LIMIT 1', [examId]))
    : false;

  const topics = await db.many(
    `SELECT t.id, t.subject_id, t.name, t.sort_order,
            coalesce(et.weight, 1) AS weight,
            (SELECT count(*) FROM lessons l WHERE l.topic_id = t.id AND l.active) AS lessons_total,
            (SELECT count(*) FROM lessons l
               JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1 AND lp.status = 'completed'
              WHERE l.topic_id = t.id AND l.active) AS lessons_done,
            (SELECT count(*) FROM questions q WHERE q.topic_id = t.id AND q.active) AS questions_total
       FROM topics t
       LEFT JOIN exam_topics et ON et.topic_id = t.id AND et.exam_id = $2
      WHERE t.active AND t.subject_id = ANY($3::uuid[])
        AND ($4::boolean = false OR et.exam_id IS NOT NULL)
      ORDER BY t.subject_id, coalesce(et.weight, 1) DESC, t.sort_order, t.name, t.id`,
    [userId, examId, subjectIds, useSyllabus]
  );

  const topicIds = topics.map((row) => row.id);
  const lessons = topicIds.length
    ? await db.many(
        `SELECT l.id, l.topic_id, l.subject_id, l.title, l.duration_min
           FROM lessons l
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          WHERE l.active AND l.topic_id = ANY($2::uuid[]) AND (lp.status IS NULL OR lp.status <> 'completed')
          ORDER BY l.topic_id, l.sort_order, l.title, l.id`,
        [userId, topicIds]
      )
    : [];

  const studiedTopics = await db.many(
    `SELECT DISTINCT topic_id FROM schedule_items
      WHERE user_id = $1 AND type = 'topic' AND status = 'done' AND topic_id IS NOT NULL`,
    [userId]
  );
  const studiedTopicIds = new Set(studiedTopics.map((row) => row.topic_id));

  const [accuracyTopicRows, accuracySubjectRows] = await Promise.all([
    db.many(
      `SELECT topic_id, count(*)::int AS total, count(*) FILTER (WHERE is_correct)::int AS correct
         FROM question_attempts
        WHERE user_id = $1 AND answered_at >= now() - ($2 || ' days')::interval
        GROUP BY topic_id`,
      [userId, PERFORMANCE_WINDOW_DAYS]
    ),
    db.many(
      `SELECT subject_id, count(*)::int AS total, count(*) FILTER (WHERE is_correct)::int AS correct
         FROM question_attempts
        WHERE user_id = $1 AND answered_at >= now() - ($2 || ' days')::interval
        GROUP BY subject_id`,
      [userId, PERFORMANCE_WINDOW_DAYS]
    ),
  ]);

  const toAccuracy = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      const total = Number(row.total) || 0;
      const correct = Number(row.correct) || 0;
      map.set(row[key], { total, correct, accuracy_pct: total > 0 ? Math.round((correct / total) * 100) : null });
    }
    return map;
  };

  const lessonsByTopic = new Map();
  for (const lesson of lessons) {
    if (!lessonsByTopic.has(lesson.topic_id)) lessonsByTopic.set(lesson.topic_id, []);
    lessonsByTopic.get(lesson.topic_id).push(lesson);
  }

  const topicsBySubject = new Map(subjectIds.map((id) => [id, []]));
  for (const topic of topics) {
    const list = topicsBySubject.get(topic.subject_id);
    if (!list) continue;
    list.push({
      id: topic.id,
      subject_id: topic.subject_id,
      name: topic.name,
      weight: Number(topic.weight) || 1,
      lessons_total: Number(topic.lessons_total) || 0,
      lessons_done: Number(topic.lessons_done) || 0,
      questions_total: Number(topic.questions_total) || 0,
      pending_lessons: (lessonsByTopic.get(topic.id) || []).slice(),
      studied: studiedTopicIds.has(topic.id),
      topic_block_used: false,
    });
  }

  return {
    subjects: subjects.map((row) => ({ ...row, weight: Number(row.weight) || 1 })),
    topicsBySubject,
    accuracyBySubject: toAccuracy(accuracySubjectRows, 'subject_id'),
    accuracyByTopic: toAccuracy(accuracyTopicRows, 'topic_id'),
  };
}

/** Estado por matéria durante a geração (fila de assuntos + uso no período). */
function buildSubjectStates(plan, profile, examDate, today) {
  const daysLeft = examDate ? dates.diffDays(today, examDate) : null;
  const states = [];

  for (const subject of plan.subjects) {
    const topics = plan.topicsBySubject.get(subject.id) || [];
    const lessonsTotal = topics.reduce((sum, topic) => sum + topic.lessons_total, 0);
    const lessonsDone = topics.reduce((sum, topic) => sum + topic.lessons_done, 0);
    const progress = lessonsTotal > 0 ? clamp(lessonsDone / lessonsTotal, 0, 1) : 0;

    const accuracy = plan.accuracyBySubject.get(subject.id);
    const weakness = accuracy && accuracy.accuracy_pct !== null ? clamp(1 - accuracy.accuracy_pct / 100, 0, 1) : 0.5;
    const weakBoost = profile.weakest_subject_id && profile.weakest_subject_id === subject.id ? 1.25 : 1;
    const remainingFactor = Math.max(0.1, 1 - progress);
    let urgency = 1;
    if (daysLeft !== null && daysLeft < URGENCY_WINDOW_DAYS) {
      const proximity = clamp((URGENCY_WINDOW_DAYS - Math.max(daysLeft, 0)) / URGENCY_WINDOW_DAYS, 0, 1);
      urgency = 1 + proximity * remainingFactor;
    }

    states.push({
      subject,
      topics,
      index: 0,
      used: 0,
      lastDayIndex: -1,
      score: subject.weight * (1 + weakness) * weakBoost * remainingFactor * urgency,
    });
  }

  states.sort((a, b) => b.score - a.score || a.subject.sort_order - b.subject.sort_order || a.subject.name.localeCompare(b.subject.name, 'pt-BR'));
  return states;
}

/**
 * Próximo bloco de estudo da matéria: aula pendente do assunto atual ou, quando o assunto
 * não tem aula cadastrada, um bloco "Estudar: <assunto>". Consome a fila (determinístico).
 */
function nextStudyBlock(state, { skipLessonIds }) {
  while (state.index < state.topics.length) {
    const topic = state.topics[state.index];

    while (topic.pending_lessons.length > 0) {
      const lesson = topic.pending_lessons.shift();
      if (skipLessonIds.has(lesson.id)) continue;
      return {
        type: 'lesson',
        title: lesson.title,
        subject_id: state.subject.id,
        topic_id: topic.id,
        lesson_id: lesson.id,
        duration_min: Math.max(10, (Number(lesson.duration_min) || 0) + LESSON_EXTRA_MIN),
        topic,
        // devolve o bloco à fila quando ele não cabe no dia
        undo: () => topic.pending_lessons.unshift(lesson),
      };
    }

    if (topic.lessons_total === 0 && !topic.studied && !topic.topic_block_used) {
      topic.topic_block_used = true;
      return {
        type: 'topic',
        title: `Estudar: ${topic.name}`,
        subject_id: state.subject.id,
        topic_id: topic.id,
        lesson_id: null,
        duration_min: TOPIC_BLOCK_MIN,
        topic,
        undo: () => {
          topic.topic_block_used = false;
        },
      };
    }

    state.index += 1;
  }
  return null;
}

/** Matérias do dia: 2 (ou 3 em dias longos), por pontuação, evitando repetir a véspera. */
function pickSubjectsForDay(states, dayIndex, capacity) {
  const slots = capacity >= 180 ? 3 : 2;
  const available = states.filter((state) => hasPendingWork(state));
  if (available.length === 0) return [];

  const ranked = available
    .map((state) => ({ state, weight: state.score / (1 + state.used) }))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        a.state.subject.sort_order - b.state.subject.sort_order ||
        a.state.subject.name.localeCompare(b.state.subject.name, 'pt-BR')
    );

  const fresh = ranked.filter((entry) => entry.state.lastDayIndex !== dayIndex - 1);
  const chosen = [];
  for (const entry of fresh) {
    if (chosen.length >= slots) break;
    chosen.push(entry.state);
  }
  for (const entry of ranked) {
    if (chosen.length >= slots) break;
    if (!chosen.includes(entry.state)) chosen.push(entry.state);
  }
  return chosen;
}

function hasPendingWork(state) {
  for (let i = state.index; i < state.topics.length; i += 1) {
    const topic = state.topics[i];
    if (topic.pending_lessons.length > 0) return true;
    if (topic.lessons_total === 0 && !topic.studied && !topic.topic_block_used) return true;
  }
  return false;
}

/** Lista de nomes em português: "A", "A e B", "A, B e C". */
function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/** Índice da quinzena (âncora fixa: mantém o ciclo do simulado estável entre regerações). */
function fortnightIndex(date, every) {
  const diff = dates.diffDays(FORTNIGHT_EPOCH, date);
  return Math.floor(diff / every);
}

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

async function touchGeneratedAt(userId) {
  await db.query('UPDATE student_profiles SET schedule_generated_at = now() WHERE user_id = $1', [userId]);
}

/**
 * (Re)gera o cronograma a partir de `from`, preservando itens concluídos e manuais.
 * @param {string} userId
 * @param {{ from?: string, days?: number }} [options]
 * @returns {Promise<{ from, to, created, study_days_count }>}
 */
async function generateSchedule(userId, { from, days = DEFAULT_HORIZON_DAYS } = {}) {
  const profile = await loadProfile(userId);
  const start = (from ? dates.toISODate(from) : null) || dates.todayISO();
  const horizon = clamp(positiveInt(days, DEFAULT_HORIZON_DAYS), 1, MAX_HORIZON_DAYS);
  const end = dates.addDays(start, horizon - 1);
  const empty = { from: start, to: end, created: 0, study_days_count: 0 };

  if (!profile) return empty;

  const studyDays = profile.study_days;
  const capacity = dailyCapacity(profile);
  if (studyDays.length === 0 || capacity <= 0) {
    await db.query(
      `DELETE FROM schedule_items WHERE user_id = $1 AND generated AND status = 'pending' AND date >= $2`,
      [userId, start]
    );
    await touchGeneratedAt(userId);
    return empty;
  }

  const config = await getScheduleDefaults();
  const plan = await loadPlan(userId, profile);
  const planData = await studyPlan.loadPlanForExam(profile.exam_id);
  const examDate = effectiveExamDate(profile);
  const today = dates.todayISO();
  const states = buildSubjectStates(plan, profile, examDate, today);

  const dueReviews = await db.many(
    `SELECT r.id, r.topic_id, r.due_date, r.stage, t.name AS topic_name, t.subject_id
       FROM reviews r
       JOIN topics t ON t.id = r.topic_id
      WHERE r.user_id = $1 AND r.status = 'pending' AND r.due_date <= $2
      ORDER BY r.due_date, r.stage, r.created_at, r.id`,
    [userId, end]
  );

  const studyDates = dates.eachDay(start, end).filter((date) => studyDays.includes(dates.weekday(date)));
  if (studyDates.length === 0) {
    await db.query(
      `DELETE FROM schedule_items WHERE user_id = $1 AND generated AND status = 'pending' AND date >= $2`,
      [userId, start]
    );
    await touchGeneratedAt(userId);
    return empty;
  }

  // último dia de estudo de cada semana (segunda a domingo) e de cada quinzena
  const lastStudyDayOfWeek = new Map();
  const lastStudyDayOfFortnight = new Map();
  for (const date of studyDates) {
    lastStudyDayOfWeek.set(dates.startOfWeek(date, 1), date);
    lastStudyDayOfFortnight.set(fortnightIndex(date, config.simulado_every_days), date);
  }

  // janela extra para trás: precisamos saber se a semana e a quinzena já têm redação/simulado
  const weekStart = dates.startOfWeek(start, 1);
  const fortnightBack = dates.addDays(start, -config.simulado_every_days);
  const contextFrom = weekStart < fortnightBack ? weekStart : fortnightBack;

  const examHasEssay = Boolean(profile.exam_id && profile.exam_has_essay);
  const reviewMin = config.review_block_min;
  const questionsMin = config.questions_block_min;

  const created = await db.tx(async (client) => {
    await client.query(
      `DELETE FROM schedule_items WHERE user_id = $1 AND generated AND status = 'pending' AND date >= $2`,
      [userId, start]
    );

    const preserved = await client.many(
      `SELECT id, date, type, duration_min, position, lesson_id, review_id, status
         FROM schedule_items
        WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
      [userId, contextFrom, end]
    );

    const usedMinutes = new Map();
    const maxPosition = new Map();
    const takenLessons = new Set();
    const takenReviews = new Set();
    const weeksWithEssay = new Set();
    const fortnightsWithSimulado = new Set();

    for (const row of preserved) {
      if (row.lesson_id) takenLessons.add(row.lesson_id);
      if (row.review_id) takenReviews.add(row.review_id);
      if (row.type === 'essay') weeksWithEssay.add(dates.startOfWeek(row.date, 1));
      if (row.type === 'simulado') fortnightsWithSimulado.add(fortnightIndex(row.date, config.simulado_every_days));
      if (row.date < start || row.date > end) continue;
      maxPosition.set(row.date, Math.max(maxPosition.get(row.date) || 0, Number(row.position) || 0));
      // itens pulados não ocupam a agenda do dia
      if (row.status === 'skipped') continue;
      usedMinutes.set(row.date, (usedMinutes.get(row.date) || 0) + (Number(row.duration_min) || 0));
    }

    const reviewQueue = dueReviews.filter((review) => !takenReviews.has(review.id));
    const items = [];

    // Quando a prova tem plano de estudos cadastrado, a sequência dos dias vem
    // dele: aula, resumo daquela aula com questões do conteúdo, e prova
    // anterior a cada quatro semanas. A pontuação por peso e fraqueza continua
    // valendo para provas sem plano.
    if (planData) {
      const startPosition = await studyPlan.currentPosition(userId, planData.plan.id);
      const planItems = await studyPlan.buildItems({
        planData,
        studyDates,
        capacity,
        usedMinutes,
        maxPosition,
        takenLessons,
        startPosition,
      });

      // revisões devidas entram antes do conteúdo do dia, sem estourar a carga
      const byDate = new Map();
      for (const item of planItems) {
        if (!byDate.has(item.date)) byDate.set(item.date, []);
        byDate.get(item.date).push(item);
      }
      for (const date of studyDates) {
        const doDia = byDate.get(date) || [];
        const ocupado = doDia.reduce((soma, item) => soma + (item.duration_min || 0), 0);
        let sobra = capacity - (usedMinutes.get(date) || 0) - ocupado;
        let posicao = (maxPosition.get(date) || 0) + 1000; // depois do conteúdo do dia
        while (reviewQueue.length > 0 && sobra >= reviewMin) {
          if (reviewQueue[0].due_date > date) break;
          const review = reviewQueue.shift();
          items.push({
            date,
            position: posicao,
            type: 'review',
            title: `Revisão: ${review.topic_name}`,
            subject_id: review.subject_id,
            topic_id: review.topic_id,
            lesson_id: null,
            review_id: review.id,
            plan_item_id: null,
            duration_min: reviewMin,
          });
          posicao += 1;
          sobra -= reviewMin;
        }
      }
      items.push(...planItems);
    } else {

    studyDates.forEach((date, dayIndex) => {
      let remaining = capacity - (usedMinutes.get(date) || 0);
      if (remaining <= 0) return;
      let position = (maxPosition.get(date) || 0) + 1;
      const dayItems = [];
      const push = (item) => {
        dayItems.push({ ...item, date, position });
        position += 1;
        remaining -= item.duration_min;
      };

      // 1) revisões devidas — até 30% do dia
      let reviewBudget = Math.floor(capacity * REVIEW_SHARE);
      while (reviewQueue.length > 0 && reviewBudget >= reviewMin && remaining >= reviewMin) {
        if (reviewQueue[0].due_date > date) break;
        const review = reviewQueue.shift();
        push({
          type: 'review',
          title: `Revisão: ${review.topic_name}`,
          subject_id: review.subject_id,
          topic_id: review.topic_id,
          lesson_id: null,
          review_id: review.id,
          duration_min: reviewMin,
        });
        reviewBudget -= reviewMin;
      }

      // 2) redação semanal (último dia de estudo da semana)
      const weekKey = dates.startOfWeek(date, 1);
      if (
        config.essay_weekly &&
        examHasEssay &&
        lastStudyDayOfWeek.get(weekKey) === date &&
        !weeksWithEssay.has(weekKey) &&
        remaining >= ESSAY_BLOCK_MIN
      ) {
        weeksWithEssay.add(weekKey);
        push({
          type: 'essay',
          title: 'Redação da semana',
          subject_id: null,
          topic_id: null,
          lesson_id: null,
          review_id: null,
          duration_min: ESSAY_BLOCK_MIN,
        });
      }

      // 3) simulado quinzenal (último dia de estudo da quinzena)
      const fortnight = fortnightIndex(date, config.simulado_every_days);
      const fortnightEnd = dates.addDays(FORTNIGHT_EPOCH, (fortnight + 1) * config.simulado_every_days - 1);
      if (
        lastStudyDayOfFortnight.get(fortnight) === date &&
        fortnightEnd <= end &&
        !fortnightsWithSimulado.has(fortnight) &&
        remaining >= SIMULADO_BLOCK_MIN
      ) {
        fortnightsWithSimulado.add(fortnight);
        push({
          type: 'simulado',
          title: 'Simulado quinzenal',
          subject_id: null,
          topic_id: null,
          lesson_id: null,
          review_id: null,
          duration_min: SIMULADO_BLOCK_MIN,
        });
      }

      // 4) aulas e assuntos por pontuação (2 a 3 matérias por dia)
      const daySubjects = [];
      for (const state of pickSubjectsForDay(states, dayIndex, capacity)) {
        const block = nextStudyBlock(state, { skipLessonIds: takenLessons });
        if (!block) continue;
        // reserva o bloco de questões, salvo quando o dia ainda não tem nada
        const fitsWithReserve = block.duration_min <= remaining - questionsMin;
        const fitsAlone = block.duration_min <= remaining && dayItems.length === 0;
        if (!fitsWithReserve && !fitsAlone) {
          block.undo();
          continue;
        }
        if (block.lesson_id) takenLessons.add(block.lesson_id);
        state.used += 1;
        state.lastDayIndex = dayIndex;
        daySubjects.push({ state, topic: block.topic });
        push({
          type: block.type,
          title: block.title,
          subject_id: block.subject_id,
          topic_id: block.topic_id,
          lesson_id: block.lesson_id,
          review_id: null,
          duration_min: block.duration_min,
        });
      }

      // 5) bloco de questões do dia (assunto mais fraco entre as matérias do dia)
      const hasSimulado = dayItems.some((item) => item.type === 'simulado');
      if (!hasSimulado && remaining >= questionsMin && dayItems.length > 0) {
        const target = pickQuestionsTarget(daySubjects, plan) || {
          subject_id: (dayItems.find((item) => item.subject_id) || {}).subject_id || null,
          topic_id: null,
        };
        const names = [...new Set(daySubjects.map((entry) => entry.state.subject.name))];
        push({
          type: 'questions',
          title: names.length > 0 ? `Questões: ${joinNames(names)}` : 'Bateria de questões',
          subject_id: target.subject_id,
          topic_id: target.topic_id,
          lesson_id: null,
          review_id: null,
          duration_min: questionsMin,
        });
      }

      items.push(...dayItems);
    });
    }

    for (const item of items) {
      await client.query(
        `INSERT INTO schedule_items
           (user_id, date, position, type, title, subject_id, topic_id, lesson_id, review_id, duration_min, plan_item_id, generated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
        [
          userId,
          item.date,
          item.position,
          item.type,
          item.title,
          item.subject_id || null,
          item.topic_id || null,
          item.lesson_id || null,
          item.review_id || null,
          item.duration_min,
          item.plan_item_id || null,
        ]
      );
    }

    return items.length;
  });

  await touchGeneratedAt(userId);
  return { from: start, to: end, created, study_days_count: studyDates.length };
}

/** Assunto do bloco de questões: o mais fraco do dia (acurácia < 60%), senão o primeiro estudado. */
function pickQuestionsTarget(daySubjects, plan) {
  if (daySubjects.length === 0) return null;
  let best = null;
  for (const entry of daySubjects) {
    const topic = entry.topic;
    if (!topic) continue;
    const accuracy = plan.accuracyByTopic.get(topic.id);
    const value = accuracy && accuracy.accuracy_pct !== null ? accuracy.accuracy_pct : 100;
    if (!best || value < best.value) best = { value, subject_id: entry.state.subject.id, topic_id: topic.id };
  }
  if (!best) return { subject_id: daySubjects[0].state.subject.id, topic_id: null };
  if (best.value >= WEAK_ACCURACY_PCT) {
    // sem assunto fraco medido: mantém o assunto do primeiro bloco do dia
    const first = daySubjects[0];
    return { subject_id: first.state.subject.id, topic_id: first.topic ? first.topic.id : null };
  }
  return { subject_id: best.subject_id, topic_id: best.topic_id };
}

/** Recalcula o cronograma a partir de amanhã (preserva o dia de hoje). */
async function regenerateFromTomorrow(userId, { days = DEFAULT_HORIZON_DAYS } = {}) {
  return generateSchedule(userId, { from: dates.addDays(dates.todayISO(), 1), days });
}

/**
 * Garante pelo menos uma semana de cronograma à frente. Chamado por GET /schedule e /schedule/today.
 * @returns {Promise<{ generated: boolean, result?: object }>}
 */
async function ensureScheduleAhead(userId, { days = DEFAULT_HORIZON_DAYS } = {}) {
  const profile = await loadProfile(userId);
  if (!profile || !profile.onboarding_completed || profile.study_days.length === 0) return { generated: false };

  const today = dates.todayISO();
  const row = await db.one(
    `SELECT max(date) AS last_date FROM schedule_items WHERE user_id = $1 AND date >= $2`,
    [userId, today]
  );
  const lastDate = row && row.last_date ? dates.toISODate(row.last_date) : null;

  if (!lastDate) {
    const lastRun = profile.schedule_generated_at ? new Date(profile.schedule_generated_at).getTime() : 0;
    // sem itens e com geração recente: nada mudou, não adianta reprocessar a cada requisição
    if (lastRun && Date.now() - lastRun < EMPTY_RETRY_MS) return { generated: false };
    const result = await generateSchedule(userId, { from: today, days });
    return { generated: true, result };
  }

  if (dates.diffDays(today, lastDate) >= AHEAD_THRESHOLD_DAYS) return { generated: false };
  const result = await generateSchedule(userId, { from: today, days });
  return { generated: true, result };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/** Cronograma agrupado por dia no intervalo pedido (padrão: hoje + 13 dias). */
async function getScheduleRange(userId, { from, to } = {}) {
  const profile = await loadProfile(userId);
  const studyDays = profile ? profile.study_days : [];
  const start = (from ? dates.toISODate(from) : null) || dates.todayISO();
  let end = (to ? dates.toISODate(to) : null) || dates.addDays(start, DEFAULT_HORIZON_DAYS - 1);
  if (end < start) end = start;
  if (dates.diffDays(start, end) > 120) end = dates.addDays(start, 120);

  const items = await listItems(userId, start, end);
  const days = groupByDay(items, { from: start, to: end, studyDays });
  return {
    from: start,
    to: end,
    study_days: studyDays,
    hours_per_day: profile ? profile.hours_per_day : 0,
    capacity_min: profile ? dailyCapacity(profile) : 0,
    days,
  };
}

/** Resumo do dia: itens, próxima atividade e totais. */
async function getToday(userId) {
  const profile = await loadProfile(userId);
  const today = dates.todayISO();
  const items = await listItems(userId, today, today);
  const capacity = profile ? dailyCapacity(profile) : 0;
  const totalMin = sumMinutes(items);
  const doneMin = sumMinutes(items, (item) => item.status === 'done');
  const doneCount = items.filter((item) => item.status === 'done').length;
  // O treino físico corre em paralelo ao estudo: ele não pode ser o que a
  // plataforma manda o aluno "começar a estudar". Só vira próxima atividade
  // quando não sobrou mais nada de conteúdo no dia.
  const pendentes = items.filter((item) => item.status === 'pending');
  const nextItem =
    pendentes.find((item) => item.type !== 'training' && item.type !== 'rest') || pendentes[0] || null;

  return {
    date: today,
    is_study_day: profile ? profile.study_days.includes(dates.weekday(today)) : false,
    items,
    next_item: nextItem,
    summary: {
      total_items: items.length,
      done_items: doneCount,
      pending_items: items.length - doneCount,
      total_min: totalMin,
      done_min: doneMin,
      remaining_min: Math.max(0, totalMin - doneMin),
      capacity_min: capacity,
      pct: totalMin > 0 ? Math.round((doneMin / totalMin) * 100) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Escrita (itens)
// ---------------------------------------------------------------------------

/** Cria um item manual (generated = false; sobrevive às regerações). */
async function createItem(userId, data) {
  const date = (data.date ? dates.toISODate(data.date) : null) || dates.todayISO();
  const row = await db.one(
    `INSERT INTO schedule_items
       (user_id, date, position, type, title, subject_id, topic_id, lesson_id, duration_min, start_time, note, generated)
     VALUES ($1, $2,
       (SELECT coalesce(max(position), 0) + 1 FROM schedule_items WHERE user_id = $1 AND date = $2),
       $3, $4, $5, $6, $7, $8, $9, $10, false)
     RETURNING id`,
    [
      userId,
      date,
      data.type || 'custom',
      data.title,
      data.subject_id || null,
      data.topic_id || null,
      data.lesson_id || null,
      positiveInt(data.duration_min, 30),
      data.start_time || null,
      data.note || null,
    ]
  );
  return findItem(userId, row.id);
}

/** Remove um item manual do aluno. @returns {Promise<boolean>} */
async function deleteItem(userId, itemId) {
  const result = await db.query('DELETE FROM schedule_items WHERE user_id = $1 AND id = $2 AND generated = false', [
    userId,
    itemId,
  ]);
  return (result.rowCount || 0) > 0;
}

/** Reagenda / altera horário / reordena. Campos ausentes ficam como estão. */
async function rescheduleItem(userId, itemId, { date, start_time: startTime, position } = {}) {
  const sets = [];
  const params = [userId, itemId];
  if (date !== undefined) {
    const iso = dates.toISODate(date);
    if (iso) {
      params.push(iso);
      sets.push(`date = $${params.length}`);
    }
  }
  if (startTime !== undefined) {
    params.push(startTime || null);
    sets.push(`start_time = $${params.length}`);
  }
  if (position !== undefined) {
    params.push(Math.max(0, positiveInt(position, 0)));
    sets.push(`position = $${params.length}`);
  }
  if (sets.length === 0) return findItem(userId, itemId);
  // o que o aluno reorganiza vira item fixo: a próxima regeração não pode desfazer a escolha dele
  sets.push('generated = false');
  const result = await db.query(`UPDATE schedule_items SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2`, params);
  if (!result.rowCount) return null;
  return findItem(userId, itemId);
}

/** Conclui a aula ligada ao item: progresso, study_log e revisões espaçadas. */
async function completeLessonItem(userId, item) {
  const lesson = await db.one(
    'SELECT id, subject_id, topic_id, duration_min FROM lessons WHERE id = $1 AND active',
    [item.lesson_id]
  );
  if (!lesson) return false;
  const today = dates.todayISO();

  const alreadyCompleted = await db.tx(async (client) => {
    const current = await client.one('SELECT status FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [
      userId,
      lesson.id,
    ]);
    const done = Boolean(current && current.status === 'completed');
    await client.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, started_at, completed_at)
       VALUES ($1, $2, 'completed', now(), now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE
         SET status = 'completed', completed_at = coalesce(lesson_progress.completed_at, now())`,
      [userId, lesson.id]
    );
    if (!done) {
      await client.query(
        `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
         VALUES ($1, 'lesson', $2, $3, $4, $5)`,
        [userId, lesson.id, lesson.subject_id, Number(lesson.duration_min) || 0, today]
      );
    }
    await client.query(
      `UPDATE schedule_items SET status = 'done', completed_at = now()
        WHERE user_id = $1 AND lesson_id = $2 AND status = 'pending'`,
      [userId, lesson.id]
    );
    return done;
  });

  if (!alreadyCompleted) {
    try {
      const reviews = require('./reviews');
      await reviews.scheduleReviews(userId, { topicId: lesson.topic_id, lessonId: lesson.id });
    } catch (err) {
      console.error('[schedule] falha ao agendar revisões da aula:', err.message);
    }
  }
  return true;
}

/**
 * Conclui um item do cronograma: grava study_log e propaga (revisão concluída, aula concluída).
 * @returns {Promise<object|null>} item atualizado
 */
async function completeItem(userId, itemId) {
  const item = await findItem(userId, itemId);
  if (!item) return null;
  if (item.status === 'done') return item;

  if (item.review_id) {
    try {
      const reviews = require('./reviews');
      const done = await reviews.completeReview(userId, item.review_id, {});
      if (done) return findItem(userId, itemId);
    } catch (err) {
      console.error('[schedule] falha ao concluir a revisão do item:', err.message);
    }
  }

  if (item.type === 'lesson' && item.lesson_id) {
    const handled = await completeLessonItem(userId, item);
    if (handled) return findItem(userId, itemId);
  }

  const today = dates.todayISO();
  const studyDate = item.date <= today ? item.date : today;
  await db.tx(async (client) => {
    await client.query(
      `UPDATE schedule_items SET status = 'done', completed_at = now() WHERE user_id = $1 AND id = $2`,
      [userId, itemId]
    );
    await client.query(
      `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, ACTIVITY_BY_TYPE[item.type] || 'schedule', item.id, item.subject_id || null, item.duration_min, studyDate]
    );
  });
  return findItem(userId, itemId);
}

/** Altera o status do item (done passa por completeItem). */
async function setItemStatus(userId, itemId, status) {
  if (status === 'done') return completeItem(userId, itemId);
  const item = await findItem(userId, itemId);
  if (!item) return null;
  await db.query(
    `UPDATE schedule_items SET status = $3, completed_at = CASE WHEN $3 = 'pending' THEN NULL ELSE completed_at END
      WHERE user_id = $1 AND id = $2`,
    [userId, itemId, status]
  );
  if (item.review_id && status === 'skipped') {
    try {
      const reviews = require('./reviews');
      await reviews.skipReview(userId, item.review_id);
    } catch (err) {
      console.error('[schedule] falha ao pular a revisão do item:', err.message);
    }
  }
  return findItem(userId, itemId);
}

/** Próximos dias de estudo a partir de (exclusive) uma data. Sem dias configurados, usa todos. */
function nextStudyDates(studyDays, afterDate, count) {
  const list = [];
  const days = studyDays.length > 0 ? studyDays : [0, 1, 2, 3, 4, 5, 6];
  let cursor = afterDate;
  for (let i = 0; i < 120 && list.length < count; i += 1) {
    cursor = dates.addDays(cursor, 1);
    if (days.includes(dates.weekday(cursor))) list.push(cursor);
  }
  return list;
}

/**
 * "Não consegui estudar hoje": redistribui os itens pendentes de hoje pelos próximos dias de
 * estudo, respeitando a capacidade e empurrando o excedente.
 * @returns {Promise<{ moved: number, date: string, moves: object[] }>}
 */
async function skipToday(userId) {
  const profile = await loadProfile(userId);
  const today = dates.todayISO();
  const pending = await db.many(
    `SELECT id, duration_min, position FROM schedule_items
      WHERE user_id = $1 AND date = $2 AND status = 'pending'
      ORDER BY position, created_at`,
    [userId, today]
  );
  if (pending.length === 0) return { moved: 0, date: today, moves: [] };

  const capacity = profile ? dailyCapacity(profile) : 0;
  const targets = nextStudyDates(profile ? profile.study_days : [], today, 14);
  if (targets.length === 0) return { moved: 0, date: today, moves: [] };

  const loaded = await db.many(
    `SELECT date, coalesce(sum(duration_min), 0)::int AS minutes, coalesce(max(position), 0)::int AS last_position
       FROM schedule_items
      WHERE user_id = $1 AND date = ANY($2::date[]) AND status <> 'skipped'
      GROUP BY date`,
    [userId, targets]
  );
  const usage = new Map(targets.map((date) => [date, { minutes: 0, position: 0 }]));
  for (const row of loaded) {
    const key = dates.toISODate(row.date);
    if (usage.has(key)) usage.set(key, { minutes: Number(row.minutes) || 0, position: Number(row.last_position) || 0 });
  }

  const moves = [];
  let cursor = 0;
  for (const item of pending) {
    const duration = Number(item.duration_min) || 0;
    let chosen = null;
    for (let i = cursor; i < targets.length; i += 1) {
      const date = targets[i];
      const state = usage.get(date);
      if (capacity <= 0 || state.minutes + duration <= capacity) {
        chosen = date;
        cursor = i;
        break;
      }
    }
    if (!chosen) {
      chosen = targets[targets.length - 1];
      cursor = targets.length - 1;
    }
    const state = usage.get(chosen);
    state.minutes += duration;
    state.position += 1;
    moves.push({ id: item.id, from: today, to: chosen, position: state.position });
  }

  await db.tx(async (client) => {
    for (const move of moves) {
      // generated = false: o remanejamento sobrevive à próxima regeração do cronograma
      await client.query(
        'UPDATE schedule_items SET date = $3, position = $4, generated = false WHERE user_id = $1 AND id = $2',
        [userId, move.id, move.to, move.position]
      );
    }
  });

  return { moved: moves.length, date: today, moves };
}

/**
 * Após a prática de uma aula: acurácia abaixo de 60% agenda um bloco de questões do assunto
 * no próximo dia de estudo e recalcula o cronograma a partir de amanhã.
 * @returns {Promise<{ accuracy_pct: number, reinforcement: object|null, regenerated: boolean }>}
 */
async function afterPractice(userId, { lessonId, correct, total } = {}) {
  const answered = Math.max(0, Number(total) || 0);
  const hits = Math.max(0, Number(correct) || 0);
  const accuracy = answered > 0 ? Math.round((hits / answered) * 100) : 0;

  const lesson = lessonId
    ? await db.one(
        `SELECT l.id, l.subject_id, l.topic_id, t.name AS topic_name
           FROM lessons l JOIN topics t ON t.id = l.topic_id
          WHERE l.id = $1`,
        [lessonId]
      )
    : null;

  if (answered === 0 || accuracy >= WEAK_ACCURACY_PCT || !lesson) {
    return { accuracy_pct: accuracy, reinforcement: null, regenerated: false };
  }

  const profile = await loadProfile(userId);
  const studyDays = profile ? profile.study_days : [];
  const [targetDate] = nextStudyDates(studyDays, dates.todayISO(), 1);
  const date = targetDate || dates.addDays(dates.todayISO(), 1);
  const config = await getScheduleDefaults();

  const existing = await db.one(
    `SELECT id FROM schedule_items
      WHERE user_id = $1 AND date = $2 AND type = 'questions' AND topic_id = $3 AND status = 'pending'`,
    [userId, date, lesson.topic_id]
  );

  let reinforcement = existing ? await findItem(userId, existing.id) : null;
  if (!existing) {
    reinforcement = await createItem(userId, {
      date,
      type: 'questions',
      title: `Reforço de questões: ${lesson.topic_name}`,
      subject_id: lesson.subject_id,
      topic_id: lesson.topic_id,
      duration_min: config.questions_block_min,
      note: 'Bloco agendado automaticamente após desempenho abaixo de 60% na prática.',
    });
  }

  let regenerated = false;
  try {
    await regenerateFromTomorrow(userId);
    regenerated = true;
  } catch (err) {
    console.error('[schedule] falha ao recalcular o cronograma após a prática:', err.message);
  }

  return { accuracy_pct: accuracy, reinforcement, regenerated };
}

module.exports = {
  generateSchedule,
  regenerateFromTomorrow,
  ensureScheduleAhead,
  getScheduleRange,
  getToday,
  listItems,
  findItem,
  createItem,
  deleteItem,
  rescheduleItem,
  completeItem,
  setItemStatus,
  skipToday,
  afterPractice,
  loadProfile,
  dailyCapacity,
  itemHref,
  serializeItem,
  getScheduleDefaults,
  normalizeStudyDays,
  DEFAULT_HORIZON_DAYS,
  WEAK_ACCURACY_PCT,
};

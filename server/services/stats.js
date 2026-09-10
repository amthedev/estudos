'use strict';

/**
 * Estatísticas do aluno usadas pelo dashboard, pelo cronograma e pela tela de desempenho.
 *
 *   const stats = require('../services/stats');
 *   await stats.getStreak(userId)                              // dias seguidos com estudo
 *   await stats.getHoursStudied(userId, { from, to })          // horas (decimal) no período
 *   await stats.getAccuracy(userId, { subjectId, topicId, days })
 *   await stats.getWeakSubjects(userId, examId)                // matérias com pior acurácia
 *   await stats.getWeeklyGoal(userId)                          // { hours_goal, hours_done, pct }
 *
 * Todas as consultas filtram por user_id. Datas "sem hora" seguem o fuso America/Sao_Paulo
 * (utils/dates.js); colunas timestamptz são convertidas com AT TIME ZONE quando precisam virar dia.
 */
const db = require('../db/pool');
const dates = require('../utils/dates');

const TZ = dates.TIMEZONE;
const WEAK_THRESHOLD_PCT = 70;
const MIN_ATTEMPTS = 3;
const PERFORMANCE_WINDOW_DAYS = 60;

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function pct(correct, total) {
  if (!total) return null;
  return Math.round((Number(correct) / Number(total)) * 100);
}

/**
 * Sequência de dias: dias consecutivos com pelo menos um study_log, contando de hoje
 * (ou de ontem, quando o aluno ainda não estudou hoje) para trás.
 */
async function getStreak(userId) {
  const rows = await db.many(
    `SELECT DISTINCT study_date
       FROM study_logs
      WHERE user_id = $1 AND study_date <= $2
      ORDER BY study_date DESC
      LIMIT 400`,
    [userId, dates.todayISO()]
  );
  if (rows.length === 0) return 0;
  const today = dates.todayISO();
  const yesterday = dates.addDays(today, -1);
  let cursor = rows[0].study_date === today ? today : rows[0].study_date === yesterday ? yesterday : null;
  if (!cursor) return 0;
  let streak = 0;
  for (const row of rows) {
    if (row.study_date !== cursor) break;
    streak += 1;
    cursor = dates.addDays(cursor, -1);
  }
  return streak;
}

/** Minutos estudados no período (inclusive). Sem período → total. */
async function getMinutesStudied(userId, { from, to } = {}) {
  const params = [userId];
  const where = ['user_id = $1'];
  if (from) {
    params.push(from);
    where.push(`study_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`study_date <= $${params.length}`);
  }
  const row = await db.one(`SELECT coalesce(sum(minutes), 0) AS minutes FROM study_logs WHERE ${where.join(' AND ')}`, params);
  return Number(row ? row.minutes : 0);
}

/** Horas estudadas (decimal, uma casa) no período. */
async function getHoursStudied(userId, range = {}) {
  const minutes = await getMinutesStudied(userId, range);
  return round1(minutes / 60);
}

/**
 * Acurácia em questões: { total, correct, accuracy_pct } (accuracy_pct null sem respostas).
 * Filtros opcionais: subjectId, topicId, days (janela em dias até agora).
 */
async function getAccuracy(userId, { subjectId, topicId, days } = {}) {
  const params = [userId];
  const where = ['user_id = $1'];
  if (subjectId) {
    params.push(subjectId);
    where.push(`subject_id = $${params.length}`);
  }
  if (topicId) {
    params.push(topicId);
    where.push(`topic_id = $${params.length}`);
  }
  if (days) {
    params.push(Number(days));
    where.push(`answered_at >= now() - ($${params.length} || ' days')::interval`);
  }
  const row = await db.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_correct)::int AS correct
       FROM question_attempts WHERE ${where.join(' AND ')}`,
    params
  );
  const total = row ? Number(row.total) : 0;
  const correct = row ? Number(row.correct) : 0;
  return { total, correct, accuracy_pct: pct(correct, total) };
}

/** Acurácia por assunto (últimos `days` dias) → Map(topic_id → { total, correct, accuracy_pct, subject_id }). */
async function getAccuracyByTopic(userId, { days = PERFORMANCE_WINDOW_DAYS } = {}) {
  const rows = await db.many(
    `SELECT topic_id, subject_id, count(*)::int AS total, count(*) FILTER (WHERE is_correct)::int AS correct
       FROM question_attempts
      WHERE user_id = $1 AND answered_at >= now() - ($2 || ' days')::interval
      GROUP BY topic_id, subject_id`,
    [userId, Number(days)]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.topic_id, {
      subject_id: row.subject_id,
      total: Number(row.total),
      correct: Number(row.correct),
      accuracy_pct: pct(row.correct, row.total),
    });
  }
  return map;
}

/** Acurácia por matéria (últimos `days` dias) → Map(subject_id → { total, correct, accuracy_pct }). */
async function getAccuracyBySubject(userId, { days = PERFORMANCE_WINDOW_DAYS } = {}) {
  const rows = await db.many(
    `SELECT subject_id, count(*)::int AS total, count(*) FILTER (WHERE is_correct)::int AS correct
       FROM question_attempts
      WHERE user_id = $1 AND answered_at >= now() - ($2 || ' days')::interval
      GROUP BY subject_id`,
    [userId, Number(days)]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.subject_id, { total: Number(row.total), correct: Number(row.correct), accuracy_pct: pct(row.correct, row.total) });
  }
  return map;
}

/**
 * Matérias com maior dificuldade: acurácia abaixo de 70% (mínimo de 3 respostas nos últimos 60 dias),
 * da pior para a melhor. Com examId, considera apenas matérias da prova. Máximo 5.
 * → [{ id, name, color, icon, accuracy_pct, attempts }]
 */
async function getWeakSubjects(userId, examId = null, { limit = 5 } = {}) {
  const params = [userId, PERFORMANCE_WINDOW_DAYS, MIN_ATTEMPTS, WEAK_THRESHOLD_PCT, Math.max(1, Number(limit) || 5)];
  let examJoin = '';
  if (examId) {
    params.push(examId);
    examJoin = `JOIN exam_subjects es ON es.subject_id = s.id AND es.exam_id = $${params.length}`;
  }
  const rows = await db.many(
    `WITH perf AS (
       SELECT subject_id, count(*)::int AS attempts, count(*) FILTER (WHERE is_correct)::int AS correct
         FROM question_attempts
        WHERE user_id = $1 AND answered_at >= now() - ($2 || ' days')::interval
        GROUP BY subject_id
     )
     SELECT s.id, s.name, s.color, s.icon, p.attempts,
            round(p.correct::numeric * 100 / p.attempts) AS accuracy_pct
       FROM perf p
       JOIN subjects s ON s.id = p.subject_id AND s.active
       ${examJoin}
      WHERE p.attempts >= $3 AND (p.correct::numeric * 100 / p.attempts) < $4
      ORDER BY accuracy_pct ASC, p.attempts DESC, s.sort_order ASC
      LIMIT $5`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    accuracy_pct: Number(row.accuracy_pct),
    attempts: Number(row.attempts),
  }));
}

/**
 * Meta semanal (semana de segunda a domingo, fuso de São Paulo):
 * { hours_goal, hours_done, pct, week_start, week_end }.
 * hours_goal = weekly_goal_hours do perfil ou dias de estudo × horas por dia.
 */
async function getWeeklyGoal(userId) {
  const profile = await db.one(
    'SELECT study_days, hours_per_day, weekly_goal_hours FROM student_profiles WHERE user_id = $1',
    [userId]
  );
  const today = dates.todayISO();
  const weekStart = dates.startOfWeek(today, 1);
  const weekEnd = dates.addDays(weekStart, 6);
  const minutes = await getMinutesStudied(userId, { from: weekStart, to: weekEnd });
  const studyDays = profile && Array.isArray(profile.study_days) ? profile.study_days.length : 0;
  const hoursPerDay = profile ? Number(profile.hours_per_day) || 0 : 0;
  let goal = profile && profile.weekly_goal_hours ? Number(profile.weekly_goal_hours) : studyDays * hoursPerDay;
  goal = round1(goal);
  const done = round1(minutes / 60);
  const ratio = goal > 0 ? Math.min(100, Math.round((done / goal) * 100)) : 0;
  return { hours_goal: goal, hours_done: done, pct: ratio, week_start: weekStart, week_end: weekEnd };
}

/** Minutos estudados hoje (São Paulo). */
async function getMinutesToday(userId) {
  const today = dates.todayISO();
  return getMinutesStudied(userId, { from: today, to: today });
}

/** Respostas de questões dadas hoje (São Paulo). */
async function getQuestionsAnsweredToday(userId) {
  const row = await db.one(
    `SELECT count(*)::int AS total
       FROM question_attempts
      WHERE user_id = $1 AND (answered_at AT TIME ZONE $2)::date = $3::date`,
    [userId, TZ, dates.todayISO()]
  );
  return row ? Number(row.total) : 0;
}

/** Aulas concluídas hoje (São Paulo). */
async function getLessonsCompletedToday(userId) {
  const row = await db.one(
    `SELECT count(*)::int AS total
       FROM lesson_progress
      WHERE user_id = $1 AND status = 'completed' AND completed_at IS NOT NULL
        AND (completed_at AT TIME ZONE $2)::date = $3::date`,
    [userId, TZ, dates.todayISO()]
  );
  return row ? Number(row.total) : 0;
}

module.exports = {
  getStreak,
  getMinutesStudied,
  getHoursStudied,
  getAccuracy,
  getAccuracyByTopic,
  getAccuracyBySubject,
  getWeakSubjects,
  getWeeklyGoal,
  getMinutesToday,
  getQuestionsAnsweredToday,
  getLessonsCompletedToday,
  WEAK_THRESHOLD_PCT,
  MIN_ATTEMPTS,
  PERFORMANCE_WINDOW_DAYS,
};

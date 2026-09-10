'use strict';

/**
 * Meu Desempenho — tudo que a tela /app/desempenho precisa em uma chamada.
 *
 *   GET /api/performance
 *     → {
 *         overall:    { accuracy_pct, answered, correct, wrong },
 *         by_subject: [{ id, name, color, icon, answered, correct, accuracy_pct }],
 *         by_topic:   [{ id, name, subject_id, subject_name, subject_color, answered, correct, accuracy_pct }],
 *         weekly:     [{ week_start, week_end, minutes, answered, correct, accuracy_pct }],   12 semanas
 *         monthly:    [{ month_start, month, minutes, answered, correct, accuracy_pct }],     6 meses
 *         hours:      { total, this_week, this_month },
 *         lessons:    { done, total, pct },
 *         simulados:  [{ id, title, type, score, correct_count, wrong_count, blank_count, finished_at }],
 *         essays:     [{ id, theme_title, score, max_score, corrected_at }],
 *         strengths:  [...5 assuntos com melhor acurácia (mínimo de 5 respostas)],
 *         weaknesses: [...5 assuntos com pior acurácia (mínimo de 5 respostas)],
 *         streak_days
 *       }
 *
 * `by_topic` traz os 30 assuntos com mais respostas. As séries `weekly`/`monthly`, `simulados` e
 * `essays` vêm em ordem cronológica (do mais antigo para o mais recente), prontas para gráficos de
 * evolução. Semanas começam na segunda-feira e todos os recortes de dia usam o fuso America/Sao_Paulo.
 * Toda consulta filtra por user_id = req.user.id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const dates = require('../utils/dates');
const stats = require('../services/stats');
const progress = require('../services/progress');

router.use(requireStudent, requireAccess);

const TZ = dates.TIMEZONE;
const WEEKS = 12;
const MONTHS = 6;
const TOP_TOPICS = 30;
const HIGHLIGHTS = 5;
const MIN_HIGHLIGHT_ATTEMPTS = 5;
const HISTORY_LIMIT = 12;

/** Percentual inteiro de acertos; null quando o aluno ainda não respondeu nada. */
function accuracy(correct, answered) {
  const total = Number(answered) || 0;
  if (total <= 0) return null;
  return Math.round((100 * (Number(correct) || 0)) / total);
}

/** Últimas `count` segundas-feiras (a mais antiga primeiro), incluindo a semana corrente. */
function lastWeekStarts(count) {
  const current = dates.startOfWeek(dates.todayISO(), 1);
  const list = [];
  for (let i = count - 1; i >= 0; i -= 1) list.push(dates.addDays(current, -7 * i));
  return list;
}

/** Primeiros dias dos últimos `count` meses (o mais antigo primeiro), incluindo o mês corrente. */
function lastMonthStarts(count) {
  const today = dates.todayISO();
  const [year, month] = today.split('-').map(Number);
  const list = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - i, 1, 12));
    list.push(date.toISOString().slice(0, 10));
  }
  return list;
}

/** Junta minutos estudados e respostas em uma série (semanal ou mensal) já preenchida com zeros. */
function buildSeries(starts, minutesRows, attemptRows, key) {
  const minutesBy = new Map(minutesRows.map((row) => [row.bucket, Number(row.minutes) || 0]));
  const attemptsBy = new Map(attemptRows.map((row) => [row.bucket, row]));

  return starts.map((start) => {
    const attempt = attemptsBy.get(start);
    const answered = attempt ? Number(attempt.answered) : 0;
    const correct = attempt ? Number(attempt.correct) : 0;
    const point = {
      [key]: start,
      minutes: minutesBy.get(start) || 0,
      answered,
      correct,
      accuracy_pct: accuracy(correct, answered),
    };
    if (key === 'week_start') point.week_end = dates.addDays(start, 6);
    else point.month = start.slice(0, 7);
    return point;
  });
}

router.get(
  '/',
  wrap(async (req, res) => {
    const userId = req.user.id;
    const today = dates.todayISO();
    const weekStarts = lastWeekStarts(WEEKS);
    const monthStarts = lastMonthStarts(MONTHS);
    const weeklyFrom = weekStarts[0];
    const monthlyFrom = monthStarts[0];

    // escopo de aulas: syllabus da prova escolhida no onboarding (todas quando não há prova)
    const scope = await progress.resolveScope(userId, {});
    const lessonParams = [userId];
    const lessonScope = progress.lessonScopeSql(scope, lessonParams);

    const [
      overallRow,
      bySubject,
      topicRows,
      weeklyMinutes,
      weeklyAttempts,
      monthlyMinutes,
      monthlyAttempts,
      lessonsRow,
      simuladoRows,
      essayRows,
      streakDays,
      hoursTotal,
      hoursWeek,
      hoursMonth,
    ] = await Promise.all([
      db.one(
        `SELECT count(*)::int AS answered, count(*) FILTER (WHERE is_correct)::int AS correct
           FROM question_attempts WHERE user_id = $1`,
        [userId]
      ),
      db.many(
        `SELECT s.id, s.name, s.color, s.icon,
                count(*)::int AS answered,
                count(*) FILTER (WHERE qa.is_correct)::int AS correct
           FROM question_attempts qa
           JOIN subjects s ON s.id = qa.subject_id
          WHERE qa.user_id = $1
          GROUP BY s.id, s.name, s.color, s.icon, s.sort_order
          ORDER BY count(*) DESC, s.sort_order, s.name`,
        [userId]
      ),
      db.many(
        `SELECT t.id, t.name, t.subject_id, s.name AS subject_name, s.color AS subject_color,
                count(*)::int AS answered,
                count(*) FILTER (WHERE qa.is_correct)::int AS correct
           FROM question_attempts qa
           JOIN topics t ON t.id = qa.topic_id
           JOIN subjects s ON s.id = t.subject_id
          WHERE qa.user_id = $1
          GROUP BY t.id, t.name, t.subject_id, s.name, s.color`,
        [userId]
      ),
      db.many(
        `SELECT date_trunc('week', study_date)::date AS bucket, sum(minutes)::int AS minutes
           FROM study_logs
          WHERE user_id = $1 AND study_date >= $2 AND study_date <= $3
          GROUP BY 1`,
        [userId, weeklyFrom, today]
      ),
      db.many(
        `SELECT date_trunc('week', (answered_at AT TIME ZONE $2)::date)::date AS bucket,
                count(*)::int AS answered,
                count(*) FILTER (WHERE is_correct)::int AS correct
           FROM question_attempts
          WHERE user_id = $1 AND (answered_at AT TIME ZONE $2)::date >= $3
          GROUP BY 1`,
        [userId, TZ, weeklyFrom]
      ),
      db.many(
        `SELECT date_trunc('month', study_date)::date AS bucket, sum(minutes)::int AS minutes
           FROM study_logs
          WHERE user_id = $1 AND study_date >= $2 AND study_date <= $3
          GROUP BY 1`,
        [userId, monthlyFrom, today]
      ),
      db.many(
        `SELECT date_trunc('month', (answered_at AT TIME ZONE $2)::date)::date AS bucket,
                count(*)::int AS answered,
                count(*) FILTER (WHERE is_correct)::int AS correct
           FROM question_attempts
          WHERE user_id = $1 AND (answered_at AT TIME ZONE $2)::date >= $3
          GROUP BY 1`,
        [userId, TZ, monthlyFrom]
      ),
      db.one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE lp.status = 'completed')::int AS done
           FROM lessons l
           LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          WHERE l.active AND ${lessonScope}`,
        lessonParams
      ),
      db.many(
        `SELECT id, title, type, score, correct_count, wrong_count, blank_count, finished_at
           FROM simulado_attempts
          WHERE user_id = $1 AND status = 'finished' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC
          LIMIT $2`,
        [userId, HISTORY_LIMIT]
      ),
      db.many(
        `SELECT id, theme_title, score, max_score, corrected_at
           FROM essays
          WHERE user_id = $1 AND status = 'corrected' AND corrected_at IS NOT NULL
          ORDER BY corrected_at DESC
          LIMIT $2`,
        [userId, HISTORY_LIMIT]
      ),
      stats.getStreak(userId),
      stats.getHoursStudied(userId),
      stats.getHoursStudied(userId, { from: weekStarts[weekStarts.length - 1], to: today }),
      stats.getHoursStudied(userId, { from: monthStarts[monthStarts.length - 1], to: today }),
    ]);

    const answered = overallRow ? Number(overallRow.answered) : 0;
    const correct = overallRow ? Number(overallRow.correct) : 0;

    const topics = topicRows.map((row) => ({
      id: row.id,
      name: row.name,
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      subject_color: row.subject_color,
      answered: Number(row.answered),
      correct: Number(row.correct),
      accuracy_pct: accuracy(row.correct, row.answered),
    }));

    const byVolume = topics.slice().sort((a, b) => b.answered - a.answered || a.name.localeCompare(b.name, 'pt-BR'));
    const eligible = topics.filter((topic) => topic.answered >= MIN_HIGHLIGHT_ATTEMPTS);
    const strengths = eligible
      .slice()
      .sort((a, b) => b.accuracy_pct - a.accuracy_pct || b.answered - a.answered)
      .slice(0, HIGHLIGHTS);
    const weaknesses = eligible
      .slice()
      .sort((a, b) => a.accuracy_pct - b.accuracy_pct || b.answered - a.answered)
      .slice(0, HIGHLIGHTS);

    const lessonsTotal = lessonsRow ? Number(lessonsRow.total) : 0;
    const lessonsDone = lessonsRow ? Number(lessonsRow.done) : 0;

    res.json({
      overall: {
        answered,
        correct,
        wrong: answered - correct,
        accuracy_pct: accuracy(correct, answered),
      },
      by_subject: bySubject.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        icon: row.icon,
        answered: Number(row.answered),
        correct: Number(row.correct),
        accuracy_pct: accuracy(row.correct, row.answered),
      })),
      by_topic: byVolume.slice(0, TOP_TOPICS),
      weekly: buildSeries(weekStarts, weeklyMinutes, weeklyAttempts, 'week_start'),
      monthly: buildSeries(monthStarts, monthlyMinutes, monthlyAttempts, 'month_start'),
      hours: { total: hoursTotal, this_week: hoursWeek, this_month: hoursMonth },
      lessons: { done: lessonsDone, total: lessonsTotal, pct: progress.pct(lessonsDone, lessonsTotal) },
      simulados: simuladoRows.slice().reverse(),
      essays: essayRows.slice().reverse(),
      strengths,
      weaknesses,
      streak_days: streakDays,
    });
  })
);

module.exports = { basePath: '/api/performance', router };

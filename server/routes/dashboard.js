'use strict';

/**
 * Tela Início do aluno em uma única chamada (ARCHITECTURE §4 e §6).
 *
 *   GET /api/dashboard → {
 *     user, greeting_date, quote, exam, next_item, today, plan_progress_pct, continue_lesson,
 *     subject_rings, checklist, stats, weak_subjects, upcoming_reviews_count
 *   }
 *
 * Reúne services/schedule (cronograma de hoje e próxima atividade), services/progress (progresso
 * do plano por matéria), services/stats (sequência, horas, acurácia, meta semanal) e
 * services/reviews (revisões pendentes). Tudo filtrado por user_id.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { getSetting } = require('../services/settings');
const schedule = require('../services/schedule');
const progress = require('../services/progress');
const stats = require('../services/stats');
const reviews = require('../services/reviews');
const dates = require('../utils/dates');

router.use(requireStudent, requireAccess);

/** Frases da marca (o admin pode substituir pela configuração daily_quotes). */
const DEFAULT_QUOTES = [
  'Disciplina transforma sonhos em realidade.',
  'Disciplina hoje, aprovação amanhã.',
  'Pequenas evoluções, grandes conquistas.',
];
const QUOTE_EPOCH = '2024-01-01';
const RINGS_LIMIT = 6;

/** Frase do dia: escolha determinística pela data (sem sorteio a cada requisição). */
async function getDailyQuote(today) {
  const raw = await getSetting('daily_quotes', DEFAULT_QUOTES);
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  const quotes = list.length > 0 ? list : DEFAULT_QUOTES;
  const offset = dates.diffDays(QUOTE_EPOCH, today) || 0;
  return quotes[((offset % quotes.length) + quotes.length) % quotes.length];
}

/** Progresso do plano: matérias da prova (ou todas, quando o aluno ainda não escolheu). */
async function loadPlanProgress(userId, examId) {
  let subjects = examId ? await progress.getSubjectProgress(userId, examId) : [];
  if (subjects.length === 0) subjects = await progress.getSubjectProgress(userId, null, { all: true });
  const lessonsTotal = subjects.reduce((sum, subject) => sum + Number(subject.lessons_total || 0), 0);
  const lessonsDone = subjects.reduce((sum, subject) => sum + Number(subject.lessons_done || 0), 0);
  return { subjects, lessonsTotal, lessonsDone, pct: progress.pct(lessonsDone, lessonsTotal) };
}

/** Anéis de progresso: até 6 matérias, priorizando as que já têm aulas e maior peso. */
function buildRings(subjects) {
  return subjects
    .slice()
    .sort((a, b) => {
      const aHas = Number(a.lessons_total || 0) > 0 ? 0 : 1;
      const bHas = Number(b.lessons_total || 0) > 0 ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      const aWeight = Number(a.weight || 1);
      const bWeight = Number(b.weight || 1);
      if (aWeight !== bWeight) return bWeight - aWeight;
      return Number(a.sort_order || 0) - Number(b.sort_order || 0);
    })
    .slice(0, RINGS_LIMIT)
    .map((subject) => ({
      id: subject.id,
      name: subject.name,
      color: subject.color,
      icon: subject.icon,
      pct: Number(subject.progress_pct || 0),
      lessons_done: Number(subject.lessons_done || 0),
      lessons_total: Number(subject.lessons_total || 0),
    }));
}

router.get(
  '/',
  wrap(async (req, res) => {
    const userId = req.user.id;
    const today = dates.todayISO();

    // mantém pelo menos uma semana de cronograma à frente sem quebrar a tela em caso de falha
    try {
      await schedule.ensureScheduleAhead(userId);
    } catch (err) {
      console.error('[dashboard] falha ao estender o cronograma:', err.message);
    }

    const profile = await schedule.loadProfile(userId);
    const examId = profile ? profile.exam_id : null;

    const [
      quote,
      todaySchedule,
      planProgress,
      streakDays,
      hoursTotal,
      weeklyGoal,
      accuracy,
      minutesToday,
      lessonsToday,
      questionsToday,
      weakSubjects,
      reviewCounts,
      essayRow,
      continueLesson,
    ] = await Promise.all([
      getDailyQuote(today),
      schedule.getToday(userId),
      loadPlanProgress(userId, examId),
      stats.getStreak(userId),
      stats.getHoursStudied(userId),
      stats.getWeeklyGoal(userId),
      stats.getAccuracy(userId),
      stats.getMinutesToday(userId),
      stats.getLessonsCompletedToday(userId),
      stats.getQuestionsAnsweredToday(userId),
      stats.getWeakSubjects(userId, examId),
      reviews.getCounts(userId),
      db.one(
        `SELECT count(*) FILTER (WHERE status IN ('submitted','corrected'))::int AS total,
                round(avg(score) FILTER (WHERE score IS NOT NULL), 1) AS average
           FROM essays WHERE user_id = $1`,
        [userId]
      ),
      db.one(
        `SELECT l.id, l.title, l.thumbnail_url, l.duration_min, l.subject_id, s.name AS subject_name, s.color AS subject_color
           FROM lesson_progress lp
           JOIN lessons l ON l.id = lp.lesson_id AND l.active
           JOIN subjects s ON s.id = l.subject_id
          WHERE lp.user_id = $1 AND lp.status = 'in_progress'
          ORDER BY lp.started_at DESC
          LIMIT 1`,
        [userId]
      ),
    ]);

    const examDate = profile ? dates.toISODate(profile.exam_date) || dates.toISODate(profile.exam_default_date) : null;
    const exam =
      profile && (profile.exam_id || profile.other_exam_name)
        ? {
            id: profile.exam_id,
            name: profile.exam_name || profile.other_exam_name,
            short_name: profile.exam_short_name || profile.other_exam_name,
            track: profile.exam_track || null,
            exam_date: examDate,
            days_left: examDate ? dates.diffDays(today, examDate) : null,
          }
        : null;

    const capacity = profile ? schedule.dailyCapacity(profile) : 0;
    const dailyGoalMin = todaySchedule.is_study_day ? capacity : 0;

    res.json({
      user: { id: req.user.id, name: req.user.name, avatar_url: req.user.avatar_url || null },
      greeting_date: today,
      quote,
      exam,
      next_item: todaySchedule.next_item,
      today: {
        date: todaySchedule.date,
        is_study_day: todaySchedule.is_study_day,
        items: todaySchedule.items,
        total_min: todaySchedule.summary.total_min,
        done_min: todaySchedule.summary.done_min,
      },
      plan_progress_pct: planProgress.pct,
      continue_lesson: continueLesson
        ? {
            id: continueLesson.id,
            title: continueLesson.title,
            subject_name: continueLesson.subject_name,
            subject_color: continueLesson.subject_color,
            thumbnail_url: continueLesson.thumbnail_url,
            duration_min: Number(continueLesson.duration_min) || 0,
            href: `/app/aulas/${continueLesson.id}`,
          }
        : null,
      subject_rings: buildRings(planProgress.subjects),
      checklist: {
        lesson_done: lessonsToday > 0,
        questions_done: questionsToday > 0,
        goal_reached: dailyGoalMin > 0 ? minutesToday >= dailyGoalMin : minutesToday > 0,
      },
      stats: {
        streak_days: streakDays,
        hours_total: hoursTotal,
        hours_week: weeklyGoal.hours_done,
        minutes_today: minutesToday,
        lessons_done: planProgress.lessonsDone,
        lessons_total: planProgress.lessonsTotal,
        questions_answered: accuracy.total,
        accuracy_pct: accuracy.accuracy_pct,
        essays_count: essayRow ? Number(essayRow.total) || 0 : 0,
        essays_avg: essayRow && essayRow.average !== null ? Number(essayRow.average) : null,
        overall_progress_pct: planProgress.pct,
        weekly_goal: {
          hours_goal: weeklyGoal.hours_goal,
          hours_done: weeklyGoal.hours_done,
          pct: weeklyGoal.pct,
        },
      },
      weak_subjects: weakSubjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        color: subject.color,
        accuracy_pct: subject.accuracy_pct,
      })),
      upcoming_reviews_count: reviewCounts.overdue + reviewCounts.today + reviewCounts.upcoming,
    });
  })
);

module.exports = { basePath: '/api/dashboard', router };

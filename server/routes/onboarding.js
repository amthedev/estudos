'use strict';

/**
 * Onboarding do aluno (ARCHITECTURE §4 "auth / onboarding / perfil").
 *
 *   POST /api/onboarding  → salva o perfil, marca onboarding_completed, calcula a meta semanal
 *                           e gera o cronograma → { profile, schedule_today, schedule }
 *
 * Payload: { exam_id | other_exam_name, study_days[], hours_per_day, level, weakest_subject_id?,
 *            exam_date?, target_course?, target_university?, target_score?,
 *            main_difficulty?, performance_goal? }
 *
 * Campos por trilha: ENEM (curso/universidade/nota desejada), Academia do Barro Branco
 * (maior dificuldade/objetivo de desempenho), demais vestibulares (nome da prova, universidade, curso).
 * A rota exige sessão de aluno, mas não exige assinatura: o onboarding vem antes do acesso ao conteúdo.
 */
const router = require('express').Router();
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const schedule = require('../services/schedule');
const { isISODate } = require('../utils/dates');

router.use(requireStudent);

const isoDate = z.string().refine(isISODate, { message: 'Data inválida (use AAAA-MM-DD).' });
const shortText = (max = 160) => z.string().trim().min(1).max(max);

const onboardingBody = z
  .object({
    exam_id: z.string().uuid().nullish(),
    other_exam_name: shortText(120).nullish(),
    study_days: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1, 'Escolha pelo menos um dia de estudo.')
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    hours_per_day: z.coerce.number().min(0.5, 'Mínimo de 0,5 hora por dia.').max(12, 'Máximo de 12 horas por dia.'),
    level: z.enum(['iniciante', 'intermediario', 'avancado']),
    weakest_subject_id: z.string().uuid().nullish(),
    exam_date: isoDate.nullish(),
    target_course: shortText(160).nullish(),
    target_university: shortText(160).nullish(),
    target_score: shortText(60).nullish(),
    main_difficulty: shortText(200).nullish(),
    performance_goal: shortText(200).nullish(),
  })
  .refine((value) => Boolean(value.exam_id || value.other_exam_name), {
    message: 'Escolha a prova ou informe o nome do vestibular.',
    path: ['exam_id'],
  });

const PROFILE_FIELDS = [
  'exam_id',
  'other_exam_name',
  'study_days',
  'hours_per_day',
  'level',
  'weakest_subject_id',
  'exam_date',
  'target_course',
  'target_university',
  'target_score',
  'main_difficulty',
  'performance_goal',
];

const EXAM_COLUMNS =
  'id, slug, name, short_name, track, board, description, exam_date, has_essay, essay_max_score, score_max, active';

/** Perfil completo (com a prova) no mesmo formato de GET /api/auth/me. */
async function loadProfile(userId) {
  const profile = await db.one('SELECT * FROM student_profiles WHERE user_id = $1', [userId]);
  if (!profile) return { profile: null, exam: null };
  const exam = profile.exam_id ? await db.one(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = $1`, [profile.exam_id]) : null;
  profile.study_days = Array.isArray(profile.study_days) ? profile.study_days.map(Number) : [];
  profile.hours_per_day = Number(profile.hours_per_day);
  return { profile: { ...profile, exam }, exam };
}

router.post(
  '/',
  validate({ body: onboardingBody }),
  wrap(async (req, res) => {
    const userId = req.user.id;
    const body = req.valid.body;

    let exam = null;
    if (body.exam_id) {
      exam = await db.one(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = $1 AND active`, [body.exam_id]);
      if (!exam) {
        throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
          { path: 'exam_id', message: 'Prova não encontrada.' },
        ]);
      }
    }

    if (body.weakest_subject_id) {
      const subject = await db.one('SELECT id FROM subjects WHERE id = $1 AND active', [body.weakest_subject_id]);
      if (!subject) {
        throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
          { path: 'weakest_subject_id', message: 'Matéria não encontrada.' },
        ]);
      }
    }

    // trilha "outros vestibulares" sem prova cadastrada precisa do nome digitado
    if (!exam && !body.other_exam_name) {
      throw new AppError(400, 'validation_error', 'Verifique os campos informados.', [
        { path: 'other_exam_name', message: 'Informe o nome do vestibular.' },
      ]);
    }

    const values = {
      exam_id: body.exam_id || null,
      other_exam_name: exam ? null : body.other_exam_name || null,
      study_days: body.study_days,
      hours_per_day: body.hours_per_day,
      level: body.level,
      weakest_subject_id: body.weakest_subject_id || null,
      exam_date: body.exam_date || (exam ? exam.exam_date : null) || null,
      target_course: body.target_course || null,
      target_university: body.target_university || null,
      target_score: body.target_score || null,
      main_difficulty: body.main_difficulty || null,
      performance_goal: body.performance_goal || null,
    };
    const weeklyGoalHours = Math.round(body.study_days.length * body.hours_per_day * 100) / 100;

    const columns = [...PROFILE_FIELDS, 'weekly_goal_hours'];
    const params = [userId, ...columns.map((field) => (field === 'weekly_goal_hours' ? weeklyGoalHours : values[field]))];
    const placeholders = columns.map((_, index) => `$${index + 2}`);
    const updates = columns.map((field, index) => `${field} = $${index + 2}`);

    await db.query(
      `INSERT INTO student_profiles (user_id, ${columns.join(', ')}, onboarding_completed)
       VALUES ($1, ${placeholders.join(', ')}, true)
       ON CONFLICT (user_id) DO UPDATE
          SET ${updates.join(', ')}, onboarding_completed = true`,
      params
    );

    let generated = { created: 0 };
    try {
      generated = await schedule.generateSchedule(userId, { days: schedule.DEFAULT_HORIZON_DAYS });
    } catch (err) {
      console.error('[onboarding] falha ao gerar o cronograma:', err.message);
    }

    const [{ profile }, today] = await Promise.all([loadProfile(userId), schedule.getToday(userId)]);
    res.status(201).json({
      profile,
      exam: profile ? profile.exam : null,
      schedule_today: today,
      schedule_items_created: generated.created || 0,
    });
  })
);

module.exports = { basePath: '/api/onboarding', router };

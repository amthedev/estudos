'use strict';

/**
 * Progresso do aluno na biblioteca de conteúdo.
 *
 *   const progress = require('../services/progress');
 *   const subjects = await progress.getSubjectProgress(userId, examId);            // matérias da prova
 *   const subjects = await progress.getSubjectProgress(userId, null, { all: true }); // todas as ativas
 *   const topics   = await progress.getTopicProgress(userId, subjectId, examId);    // assuntos da matéria
 *
 * Escopo (syllabus) da prova — decide quais aulas contam no progresso:
 *   1. se a prova tem aulas marcadas em lesson_exams → só essas aulas contam;
 *   2. senão, se a prova tem assuntos em exam_topics → contam as aulas desses assuntos;
 *   3. senão (ou sem prova) → todas as aulas ativas.
 * Assuntos listados: os de exam_topics quando existirem; senão todos os ativos.
 *
 * Todas as métricas por aluno (aulas concluídas, acurácia) filtram por user_id.
 */
const db = require('../db/pool');

const SUBJECT_COLUMNS = 's.id, s.slug, s.name, s.description, s.icon, s.color, s.sort_order, s.area_id';

/** Percentual inteiro (0–100) ou 0 quando não há total. */
function pct(done, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.round((100 * (Number(done) || 0)) / t);
}

/** Prova escolhida no onboarding (ou null). */
async function getStudentExamId(userId) {
  const row = await db.one('SELECT exam_id FROM student_profiles WHERE user_id = $1', [userId]);
  return row ? row.exam_id : null;
}

/** Descobre como a prova delimita o conteúdo (ver cabeçalho). */
async function getSyllabus(examId) {
  if (!examId) return { examId: null, hasTags: false, hasTopics: false };
  const row = await db.one(
    `SELECT EXISTS (SELECT 1 FROM lesson_exams WHERE exam_id = $1) AS has_tags,
            EXISTS (SELECT 1 FROM exam_topics WHERE exam_id = $1)  AS has_topics`,
    [examId]
  );
  return { examId, hasTags: Boolean(row && row.has_tags), hasTopics: Boolean(row && row.has_topics) };
}

/** Verdadeiro quando a matéria faz parte da prova (exam_subjects). */
async function subjectInExam(subjectId, examId) {
  if (!examId || !subjectId) return false;
  const row = await db.one('SELECT 1 FROM exam_subjects WHERE exam_id = $1 AND subject_id = $2', [examId, subjectId]);
  return Boolean(row);
}

/**
 * Escopo efetivo para um aluno: sem prova, com ?all=1 ou quando a matéria consultada
 * não pertence à prova, o escopo é "tudo" (evita mostrar "0 de 0 aulas").
 */
async function resolveScope(userId, { all = false, subjectId = null } = {}) {
  const examId = await getStudentExamId(userId);
  if (!examId || all) return { examId: null, hasTags: false, hasTopics: false };
  if (subjectId && !(await subjectInExam(subjectId, examId))) return { examId: null, hasTags: false, hasTopics: false };
  return getSyllabus(examId);
}

/** Cláusula SQL que limita as aulas ao escopo (adiciona o parâmetro em `params`). */
function lessonScopeSql(scope, params, alias = 'l') {
  if (!scope || !scope.examId) return 'TRUE';
  if (scope.hasTags) {
    params.push(scope.examId);
    return `EXISTS (SELECT 1 FROM lesson_exams le WHERE le.lesson_id = ${alias}.id AND le.exam_id = $${params.length})`;
  }
  if (scope.hasTopics) {
    params.push(scope.examId);
    return `EXISTS (SELECT 1 FROM exam_topics et WHERE et.topic_id = ${alias}.topic_id AND et.exam_id = $${params.length})`;
  }
  return 'TRUE';
}

/** Cláusula SQL que limita os assuntos ao syllabus da prova. */
function topicScopeSql(scope, params, alias = 't') {
  if (!scope || !scope.examId || !scope.hasTopics) return 'TRUE';
  params.push(scope.examId);
  return `EXISTS (SELECT 1 FROM exam_topics et WHERE et.topic_id = ${alias}.id AND et.exam_id = $${params.length})`;
}

/**
 * Matérias com progresso do aluno.
 * @param {string} userId
 * @param {string|null} examId   prova do aluno; com `all` ignora a lista da prova
 * @param {{ all?: boolean }} [options]
 */
async function getSubjectProgress(userId, examId, { all = false } = {}) {
  const scope = examId && !all ? await getSyllabus(examId) : { examId: null, hasTags: false, hasTopics: false };
  const params = [userId];
  const lessonScope = lessonScopeSql(scope, params);

  let joinExam = '';
  let weightSql = 'NULL::numeric AS weight';
  if (examId && !all) {
    params.push(examId);
    joinExam = `JOIN exam_subjects es ON es.subject_id = s.id AND es.exam_id = $${params.length}`;
    weightSql = 'es.weight';
  }

  const rows = await db.many(
    `SELECT ${SUBJECT_COLUMNS}, a.name AS area_name, a.slug AS area_slug, a.sort_order AS area_sort, ${weightSql},
            (SELECT count(*) FROM lessons l
              WHERE l.subject_id = s.id AND l.active AND ${lessonScope}) AS lessons_total,
            (SELECT count(*) FROM lessons l
              JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1 AND lp.status = 'completed'
              WHERE l.subject_id = s.id AND l.active AND ${lessonScope}) AS lessons_done,
            (SELECT count(*) FROM lessons l
              JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1 AND lp.status = 'in_progress'
              WHERE l.subject_id = s.id AND l.active AND ${lessonScope}) AS lessons_in_progress,
            (SELECT count(*) FROM topics t WHERE t.subject_id = s.id AND t.active) AS topics_total,
            (SELECT count(*) FROM question_attempts qa WHERE qa.user_id = $1 AND qa.subject_id = s.id) AS questions_answered,
            (SELECT round(100.0 * sum(qa.is_correct::int) / count(*))
               FROM question_attempts qa WHERE qa.user_id = $1 AND qa.subject_id = s.id) AS accuracy_pct
       FROM subjects s
       LEFT JOIN areas a ON a.id = s.area_id
       ${joinExam}
      WHERE s.active
      ORDER BY a.sort_order NULLS LAST, s.sort_order, s.name`,
    params
  );

  return rows.map((row) => {
    const { area_sort, ...subject } = row;
    return { ...subject, progress_pct: pct(subject.lessons_done, subject.lessons_total) };
  });
}

/**
 * Assuntos de uma matéria com progresso do aluno.
 * @param {string} userId
 * @param {string} subjectId
 * @param {string|null} examId   quando informado e a matéria pertence à prova, aplica o syllabus
 * @param {{ scope?: object }} [options]  escopo já resolvido (evita consultas repetidas)
 */
async function getTopicProgress(userId, subjectId, examId, { scope } = {}) {
  const effective = scope || (await resolveScope(userId, { subjectId, all: !examId }));
  const params = [userId, subjectId];
  const lessonScope = lessonScopeSql(effective, params);
  const topicScope = topicScopeSql(effective, params);

  let weightSql = 'NULL::numeric AS weight';
  if (effective.examId && effective.hasTopics) {
    params.push(effective.examId);
    weightSql = `(SELECT et.weight FROM exam_topics et WHERE et.topic_id = t.id AND et.exam_id = $${params.length}) AS weight`;
  }

  return db.many(
    `SELECT t.id, t.slug, t.name, t.description, t.sort_order, t.subject_id, ${weightSql},
            (SELECT count(*) FROM subtopics st WHERE st.topic_id = t.id AND st.active) AS subtopics_count,
            (SELECT count(*) FROM lessons l WHERE l.topic_id = t.id AND l.active AND ${lessonScope}) AS lessons_total,
            (SELECT count(*) FROM lessons l
              JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1 AND lp.status = 'completed'
              WHERE l.topic_id = t.id AND l.active AND ${lessonScope}) AS lessons_done,
            (SELECT count(*) FROM questions q WHERE q.topic_id = t.id AND q.active) AS questions_total,
            (SELECT count(*) FROM question_attempts qa WHERE qa.user_id = $1 AND qa.topic_id = t.id) AS questions_answered,
            (SELECT round(100.0 * sum(qa.is_correct::int) / count(*))
               FROM question_attempts qa WHERE qa.user_id = $1 AND qa.topic_id = t.id) AS accuracy_pct
       FROM topics t
      WHERE t.subject_id = $2 AND t.active AND ${topicScope}
      ORDER BY t.sort_order, t.name`,
    params
  ).then((rows) => rows.map((row) => ({ ...row, progress_pct: pct(row.lessons_done, row.lessons_total) })));
}

/** Acurácia (0–100 ou null) do aluno em um assunto. */
async function getTopicAccuracy(userId, topicId) {
  const row = await db.one(
    `SELECT count(*) AS answered, round(100.0 * sum(is_correct::int) / NULLIF(count(*), 0)) AS accuracy_pct
       FROM question_attempts WHERE user_id = $1 AND topic_id = $2`,
    [userId, topicId]
  );
  return { questions_answered: row ? row.answered : 0, accuracy_pct: row ? row.accuracy_pct : null };
}

module.exports = {
  pct,
  getStudentExamId,
  getSyllabus,
  subjectInExam,
  resolveScope,
  lessonScopeSql,
  topicScopeSql,
  getSubjectProgress,
  getTopicProgress,
  getTopicAccuracy,
};

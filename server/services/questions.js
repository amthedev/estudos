'use strict';

/**
 * Regras de negócio das questões (ARCHITECTURE §4 "questões").
 *
 *   const { pickQuestions, gradeAnswer, publicQuestion } = require('../services/questions');
 *
 *   pickQuestions({ userId, examId, subjectId, topicId, subtopicId, difficulty, count, excludeRecentDays })
 *     → questões sem gabarito, embaralhadas. Prioriza o subassunto informado e evita questões
 *       respondidas pelo aluno nos últimos `excludeRecentDays` dias (completa com outras se faltar).
 *
 *   gradeAnswer({ userId, questionId, optionId, context, contextId, timeSpentSec })
 *     → grava question_attempts (fonte única de desempenho), atualiza o caderno de erros
 *       (insere/incrementa times_wrong ao errar; marca resolved ao acertar em errors_redo/review)
 *       e devolve { is_correct, correct_option_id, resolution, explanation, attempt_id, notebook }.
 *
 *   publicQuestion(row) → versão segura de uma linha de questão: nunca inclui is_correct,
 *       resolution ou explanation (o gabarito só sai pela resposta de gradeAnswer).
 *
 * Reutilizado pelas rotas de questões, caderno de erros, prática pós-aula, revisões e simulados.
 */
const db = require('../db/pool');
const { AppError } = require('../middleware/errors');
const { todayISO } = require('../utils/dates');

const CONTEXTS = Object.freeze(['practice', 'bank', 'simulado', 'review', 'errors_redo']);
/** Contextos em que a resposta certa "resolve" a entrada do caderno de erros. */
const RESOLVING_CONTEXTS = new Set(['errors_redo', 'review']);
/** Contextos em que a resposta gera registro de estudo (os demais são registrados pelos próprios módulos). */
const STUDY_LOG_CONTEXTS = new Set(['bank', 'errors_redo']);
const STUDY_LOG_MAX_MINUTES = 10;

/** Campos que podem sair para o aluno. Tudo que não está aqui é descartado por publicQuestion. */
const PUBLIC_FIELDS = [
  'id', 'subject_id', 'topic_id', 'subtopic_id', 'statement', 'image_url', 'difficulty', 'year', 'board',
  'source', 'source_exam_id', 'created_at',
  'subject_name', 'subject_color', 'subject_icon', 'topic_name', 'subtopic_name', 'exams',
  'user_last_result', 'user_attempts', 'error_id', 'times_wrong', 'resolved',
];

/** Colunas públicas da questão para uso em SELECT (alias q). */
const QUESTION_COLUMNS = `
  q.id, q.subject_id, q.topic_id, q.subtopic_id, q.statement, q.image_url, q.difficulty, q.year, q.board,
  q.source, q.source_exam_id, q.created_at`;

/** Nomes da hierarquia (exige JOIN em subjects s, topics t e LEFT JOIN subtopics st). */
const NAME_COLUMNS = `
  s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon,
  t.name AS topic_name, st.name AS subtopic_name`;

/** Alternativas como JSON, sem is_correct, na ordem de exibição. */
const OPTIONS_SQL = `
  COALESCE((
    SELECT json_agg(json_build_object('id', o.id, 'letter', o.letter, 'text', o.text) ORDER BY o.sort_order, o.letter)
      FROM question_options o
     WHERE o.question_id = q.id
  ), '[]'::json) AS options`;

const BASE_JOINS = `
  JOIN subjects s ON s.id = q.subject_id
  JOIN topics t ON t.id = q.topic_id
  LEFT JOIN subtopics st ON st.id = q.subtopic_id`;

/** Embaralha (Fisher–Yates) sem alterar o array original. */
function shuffle(list) {
  const out = Array.from(list);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Converte uma linha do banco na representação pública (sem gabarito).
 * As alternativas ficam apenas com { id, letter, text }.
 */
function publicQuestion(row) {
  if (!row) return null;
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (row[field] !== undefined) out[field] = row[field];
  }
  const options = Array.isArray(row.options) ? row.options : [];
  out.options = options.map((option) => ({ id: option.id, letter: option.letter, text: option.text }));
  return out;
}

/**
 * Sorteia questões para prática/revisão/simulado.
 * @returns {Promise<object[]>} questões públicas, embaralhadas
 */
async function pickQuestions({
  userId,
  examId = null,
  subjectId = null,
  topicId = null,
  subtopicId = null,
  difficulty = null,
  count = 5,
  excludeRecentDays = 7,
  excludeIds = [],
} = {}) {
  const limit = Math.max(1, Math.min(Number(count) || 5, 100));
  const days = Math.max(0, Number(excludeRecentDays) || 0);

  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['q.active'];
  if (subjectId) where.push(`q.subject_id = ${add(subjectId)}`);
  if (topicId) where.push(`q.topic_id = ${add(topicId)}`);
  if (difficulty) where.push(`q.difficulty = ${add(Number(difficulty))}`);
  if (examId) {
    const p = add(examId);
    where.push(`(q.source_exam_id = ${p} OR EXISTS (SELECT 1 FROM question_exams qe WHERE qe.question_id = q.id AND qe.exam_id = ${p}))`);
  }
  if (Array.isArray(excludeIds) && excludeIds.length > 0) {
    where.push(`NOT (q.id = ANY(${add(excludeIds)}::uuid[]))`);
  }
  // prioridade para o subassunto pedido; depois aleatório
  const priority = subtopicId ? `(q.subtopic_id = ${add(subtopicId)}) DESC NULLS LAST,` : '';

  const baseWhere = where.join(' AND ');
  const selectSql = (extraWhere, limitParam) => `
    SELECT ${QUESTION_COLUMNS}, ${NAME_COLUMNS}, ${OPTIONS_SQL}
      FROM questions q ${BASE_JOINS}
     WHERE ${baseWhere}${extraWhere}
     ORDER BY ${priority} random()
     LIMIT ${limitParam}`;

  let rows = [];
  if (userId && days > 0) {
    const recentParams = [...params, userId, `${days} days`, limit];
    const recentWhere = ` AND NOT EXISTS (
        SELECT 1 FROM question_attempts a
         WHERE a.user_id = $${params.length + 1} AND a.question_id = q.id
           AND a.answered_at > now() - $${params.length + 2}::interval)`;
    rows = await db.many(selectSql(recentWhere, `$${params.length + 3}`), recentParams);
  }

  if (rows.length < limit) {
    // completa com questões já respondidas (ou todas, quando não há usuário/exclusão)
    const remaining = limit - rows.length;
    const picked = rows.map((row) => row.id);
    const fillParams = [...params];
    let extra = '';
    if (picked.length > 0) {
      fillParams.push(picked);
      extra = ` AND NOT (q.id = ANY($${fillParams.length}::uuid[]))`;
    }
    fillParams.push(remaining);
    const more = await db.many(selectSql(extra, `$${fillParams.length}`), fillParams);
    rows = rows.concat(more);
  }

  return shuffle(rows.map(publicQuestion));
}

/** Minutos de estudo registrados por uma resposta (1 a 10, a partir do tempo gasto). */
function minutesFromTime(timeSpentSec) {
  const seconds = Number(timeSpentSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.min(STUDY_LOG_MAX_MINUTES, Math.round(seconds / 60)));
}

/**
 * Corrige uma resposta e registra tudo em uma transação.
 * Lança AppError 404 (questão inexistente/inativa) ou 400 (alternativa de outra questão).
 */
async function gradeAnswer({ userId, questionId, optionId, context, contextId = null, timeSpentSec = null }) {
  if (!userId) throw new AppError(401, 'unauthorized', 'Faça login para continuar.');
  if (!CONTEXTS.includes(context)) {
    throw new AppError(400, 'validation_error', 'Contexto de resposta inválido.', [{ path: 'context', message: 'Contexto inválido.' }]);
  }

  return db.tx(async (client) => {
    const question = await client.one(
      `SELECT id, subject_id, topic_id, resolution, explanation FROM questions WHERE id = $1 AND active`,
      [questionId]
    );
    if (!question) throw new AppError(404, 'not_found', 'Questão não encontrada.');

    const options = await client.many(
      'SELECT id, is_correct FROM question_options WHERE question_id = $1 ORDER BY sort_order, letter',
      [questionId]
    );
    const chosen = options.find((option) => option.id === optionId);
    if (!chosen) {
      throw new AppError(400, 'validation_error', 'A alternativa informada não pertence a esta questão.', [
        { path: 'option_id', message: 'Alternativa inválida para esta questão.' },
      ]);
    }
    const correct = options.find((option) => option.is_correct) || null;
    const isCorrect = Boolean(chosen.is_correct);
    const seconds = Number.isFinite(Number(timeSpentSec)) && Number(timeSpentSec) >= 0 ? Math.round(Number(timeSpentSec)) : null;

    const attempt = await client.one(
      `INSERT INTO question_attempts
         (user_id, question_id, subject_id, topic_id, selected_option_id, is_correct, context, context_id, time_spent_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, answered_at`,
      [userId, questionId, question.subject_id, question.topic_id, optionId, isCorrect, context, contextId, seconds]
    );

    let notebook = null;
    if (!isCorrect) {
      notebook = await client.one(
        `INSERT INTO error_notebook (user_id, question_id, subject_id, topic_id, wrong_option_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, question_id) DO UPDATE SET
           times_wrong = error_notebook.times_wrong + 1,
           wrong_option_id = EXCLUDED.wrong_option_id,
           last_wrong_at = now(),
           resolved = false,
           resolved_at = NULL
         RETURNING id, times_wrong, resolved, resolved_at`,
        [userId, questionId, question.subject_id, question.topic_id, optionId]
      );
    } else if (RESOLVING_CONTEXTS.has(context)) {
      notebook = await client.one(
        `UPDATE error_notebook SET resolved = true, resolved_at = now()
          WHERE user_id = $1 AND question_id = $2 AND resolved = false
          RETURNING id, times_wrong, resolved, resolved_at`,
        [userId, questionId]
      );
    }

    if (STUDY_LOG_CONTEXTS.has(context)) {
      await client.query(
        `INSERT INTO study_logs (user_id, activity_type, ref_id, subject_id, minutes, study_date)
         VALUES ($1, 'questions', $2, $3, $4, $5)`,
        [userId, questionId, question.subject_id, minutesFromTime(seconds), todayISO()]
      );
    }

    return {
      attempt_id: attempt.id,
      is_correct: isCorrect,
      correct_option_id: correct ? correct.id : null,
      resolution: question.resolution,
      explanation: question.explanation,
      answered_at: attempt.answered_at,
      notebook,
    };
  });
}

module.exports = {
  CONTEXTS,
  QUESTION_COLUMNS,
  NAME_COLUMNS,
  OPTIONS_SQL,
  BASE_JOINS,
  publicQuestion,
  pickQuestions,
  gradeAnswer,
  shuffle,
};

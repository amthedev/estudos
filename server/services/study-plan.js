'use strict';

/**
 * Cronograma guiado pelo plano de estudos.
 *
 * O cliente definiu o ritmo da semana:
 *
 *   dia de aula      → videoaula nova, na ordem do plano
 *   dia seguinte     → resumo daquela aula + questões só daquele conteúdo
 *   a cada 4 semanas → o último dia da semana vira prova anterior
 *   dia de folga     → descanso, revisão dos erros ou redação
 *
 * A ordem das aulas vem de `study_plans` (52 semanas cadastradas por prova, e
 * editáveis no painel). O encaixe vem do aluno: quem marcou seis dias por
 * semana anda três aulas por semana; quem marcou três anda mais devagar, na
 * mesma sequência. Nada aqui inventa conteúdo — só distribui o que está
 * cadastrado pelos dias que o aluno tem.
 */
const db = require('../db/pool');
const dates = require('../utils/dates');

/** Um dia de aula e o dia seguinte de resumo formam um par. */
const LESSON_SLOT = 'lesson';
const SUMMARY_SLOT = 'summary';

const SUMMARY_MIN = 30;
const QUESTIONS_MIN = 30;
const PAST_EXAM_MIN = 120;
const TRAINING_MIN = 45;

/**
 * Plano ativo de uma prova, com os itens em ordem.
 * @returns {Promise<{plan: object, items: object[]}|null>}
 */
async function loadPlanForExam(examId) {
  if (!examId) return null;
  const plan = await db.one(
    `SELECT id, exam_id, slug, name, weeks, lessons_per_week, exam_every_weeks,
            training_weekdays, training_label
       FROM study_plans
      WHERE exam_id = $1 AND active
      ORDER BY created_at
      LIMIT 1`,
    [examId]
  );
  if (!plan) return null;

  const items = await db.many(
    `SELECT i.id, i.position, i.week, i.title, i.kind, i.subject_id, i.topic_id,
            s.name AS subject_name, s.color AS subject_color
       FROM study_plan_items i
       LEFT JOIN subjects s ON s.id = i.subject_id
      WHERE i.plan_id = $1
      ORDER BY i.position`,
    [plan.id]
  );
  return items.length ? { plan, items } : null;
}

/**
 * Em que ponto da sequência o aluno está.
 *
 * Deriva do que já foi concluído em vez de confiar em um contador: se o aluno
 * refizer o cronograma, mudar a disponibilidade ou pular dias, a posição
 * continua certa.
 */
async function currentPosition(userId, planId) {
  const row = await db.one(
    `SELECT coalesce(max(i.position), 0) AS position
       FROM schedule_items si
       JOIN study_plan_items i ON i.id = si.plan_item_id
      WHERE si.user_id = $1 AND i.plan_id = $2 AND si.status = 'done'`,
    [userId, planId]
  );
  return Number(row?.position) || 0;
}

/**
 * Procura uma aula cadastrada que corresponda ao passo do plano.
 *
 * O plano diz "Matemática — Porcentagem, juros simples e compostos". Se a
 * equipe já cadastrou uma aula desse assunto, o dia aponta para ela e o aluno
 * assiste. Se ainda não cadastrou, o dia vira um bloco de estudo do tema, com
 * o mesmo título, para o cronograma não ficar vazio esperando conteúdo.
 */
async function matchLessons(items) {
  const subjectIds = [...new Set(items.map((item) => item.subject_id).filter(Boolean))];
  if (!subjectIds.length) return new Map();

  const lessons = await db.many(
    `SELECT l.id, l.title, l.subject_id, l.topic_id, l.subtopic_id, l.duration_min, l.sort_order,
            t.name AS topic_name
       FROM lessons l
       JOIN topics t ON t.id = l.topic_id
      WHERE l.active AND l.subject_id = ANY($1::uuid[])
      ORDER BY l.subject_id, l.sort_order, l.title`,
    [subjectIds]
  );

  const bySubject = new Map();
  for (const lesson of lessons) {
    if (!bySubject.has(lesson.subject_id)) bySubject.set(lesson.subject_id, []);
    bySubject.get(lesson.subject_id).push(lesson);
  }
  return bySubject;
}

/** Palavras significativas de um título, para casar plano com aula cadastrada. */
function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
}

/** Melhor aula da matéria para o passo do plano, ou null se nenhuma servir. */
function bestLesson(planItem, candidates, used) {
  if (!candidates || !candidates.length) return null;
  const wanted = keywords(planItem.title);
  let best = null;
  let bestScore = 0;

  for (const lesson of candidates) {
    if (used.has(lesson.id)) continue;
    const haystack = keywords(`${lesson.title} ${lesson.topic_name}`);
    const score = wanted.filter((word) => haystack.includes(word)).length;
    if (score > bestScore) {
      best = lesson;
      bestScore = score;
    }
  }
  // exige ao menos uma palavra em comum: sem isso, casaria qualquer aula da matéria
  return bestScore > 0 ? best : null;
}

/**
 * Monta os itens do cronograma seguindo o plano.
 *
 * @param {object} options
 * @param {string} options.userId
 * @param {{plan: object, items: object[]}} options.planData
 * @param {string[]} options.studyDates datas de estudo já filtradas pela disponibilidade
 * @param {number} options.capacity minutos por dia
 * @param {Map<string, number>} options.usedMinutes minutos já ocupados por dia
 * @param {Map<string, number>} options.maxPosition última posição usada em cada dia
 * @param {Set<string>} options.takenLessons aulas já agendadas
 * @param {number} options.startPosition posição do plano onde continuar
 * @returns {Promise<object[]>} itens prontos para gravar
 */
async function buildItems({
  planData,
  studyDates,
  capacity,
  usedMinutes,
  maxPosition,
  takenLessons,
  startPosition,
}) {
  const { plan, items: planItems } = planData;
  const pending = planItems.filter((item) => item.position > startPosition);
  if (!pending.length) return [];

  const bySubject = await matchLessons(pending);
  const usedLessons = new Set(takenLessons);
  const trainingDays = new Set((plan.training_weekdays || []).map(Number));
  const examEvery = Math.max(0, Number(plan.exam_every_weeks) || 0);

  // último dia de estudo de cada semana, para saber onde cabe a prova anterior
  const lastOfWeek = new Map();
  for (const date of studyDates) lastOfWeek.set(dates.startOfWeek(date, 1), date);

  // semanas numeradas a partir da primeira do horizonte, para contar de 4 em 4
  const weekOrder = [...new Set(studyDates.map((date) => dates.startOfWeek(date, 1)))];
  const weekNumber = new Map(weekOrder.map((week, index) => [week, index + 1]));

  const out = [];
  let cursor = 0; // próximo passo do plano a consumir
  let slot = LESSON_SLOT; // alterna aula → resumo
  let lastScheduled = null; // o passo cuja aula acabou de ser agendada

  for (const date of studyDates) {
    let remaining = capacity - (usedMinutes.get(date) || 0);
    if (remaining <= 0) continue;
    let position = (maxPosition.get(date) || 0) + 1;

    const push = (item) => {
      out.push({ ...item, date, position });
      position += 1;
      remaining -= item.duration_min;
    };

    // Treino do TAF corre em paralelo ao estudo: não consome a carga do dia,
    // por isso entra sem descontar de `remaining`.
    if (trainingDays.has(dates.weekday(date))) {
      out.push({
        date,
        // posição alta: o treino aparece depois do conteúdo do dia, porque
        // complementa o estudo em vez de abrir a jornada
        position: position + 2000,
        type: 'training',
        title: plan.training_label || 'Treino físico',
        subject_id: null,
        topic_id: null,
        lesson_id: null,
        review_id: null,
        plan_item_id: null,
        duration_min: TRAINING_MIN,
      });
    }

    const week = dates.startOfWeek(date, 1);
    const isExamDay =
      examEvery > 0 && lastOfWeek.get(week) === date && weekNumber.get(week) % examEvery === 0;

    // A cada quatro semanas o último dia é prova anterior, no lugar do resumo.
    if (isExamDay && remaining >= PAST_EXAM_MIN) {
      push({
        type: 'past_exam',
        title: 'Prova anterior e correção',
        subject_id: null,
        topic_id: null,
        lesson_id: null,
        review_id: null,
        plan_item_id: null,
        duration_min: Math.min(PAST_EXAM_MIN, remaining + PAST_EXAM_MIN),
      });
      continue;
    }

    if (slot === LESSON_SLOT) {
      const step = pending[cursor];
      // plano concluído: os dias seguintes seguem livres para prova anterior e
      // revisões, em vez de o cronograma parar de existir
      if (!step) continue;

      const lesson = bestLesson(step, bySubject.get(step.subject_id), usedLessons);
      const duration = lesson ? Number(lesson.duration_min) || 40 : 40;
      if (duration > remaining) continue; // dia curto demais: tenta no próximo

      if (lesson) usedLessons.add(lesson.id);
      push({
        type: lesson ? 'lesson' : 'topic',
        title: lesson ? lesson.title : step.title,
        subject_id: step.subject_id,
        topic_id: lesson ? lesson.topic_id : step.topic_id,
        lesson_id: lesson ? lesson.id : null,
        review_id: null,
        plan_item_id: step.id,
        duration_min: duration,
      });

      lastScheduled = { step, lesson };
      cursor += 1;
      slot = SUMMARY_SLOT;
      continue;
    }

    // Dia de resumo: retoma exatamente o conteúdo da aula anterior.
    if (!lastScheduled) {
      slot = LESSON_SLOT;
      continue;
    }
    const { step, lesson } = lastScheduled;
    if (remaining < SUMMARY_MIN) continue;

    push({
      type: 'summary',
      title: `Resumo: ${step.title}`,
      subject_id: step.subject_id,
      topic_id: lesson ? lesson.topic_id : step.topic_id,
      lesson_id: lesson ? lesson.id : null,
      review_id: null,
      plan_item_id: step.id,
      duration_min: SUMMARY_MIN,
    });

    if (remaining >= QUESTIONS_MIN) {
      push({
        type: 'questions',
        title: `Questões: ${step.title}`,
        subject_id: step.subject_id,
        topic_id: lesson ? lesson.topic_id : step.topic_id,
        lesson_id: null,
        review_id: null,
        plan_item_id: step.id,
        duration_min: QUESTIONS_MIN,
      });
    }

    slot = LESSON_SLOT;
  }

  return out;
}

/** Quanto do plano o aluno já percorreu, para mostrar no cronograma. */
async function progress(userId, examId) {
  const planData = await loadPlanForExam(examId);
  if (!planData) return null;
  const position = await currentPosition(userId, planData.plan.id);
  const total = planData.items.length;
  return {
    plan_id: planData.plan.id,
    name: planData.plan.name,
    total,
    done: position,
    pct: total > 0 ? Math.round((position / total) * 100) : 0,
    week: planData.items.find((item) => item.position === position + 1)?.week ?? planData.plan.weeks,
    weeks: planData.plan.weeks,
  };
}

module.exports = {
  loadPlanForExam,
  currentPosition,
  buildItems,
  progress,
  SUMMARY_MIN,
  QUESTIONS_MIN,
  PAST_EXAM_MIN,
  TRAINING_MIN,
};

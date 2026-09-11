'use strict';

/**
 * Painel administrativo — planos de estudo (a sequência de assuntos de cada prova).
 *
 *   GET    /api/admin/study-plans                      lista os planos com contagem de passos
 *   GET    /api/admin/study-plans/:id                  plano + todos os passos, em ordem
 *   POST   /api/admin/study-plans                      { exam_id, name, weeks?, lessons_per_week?, ... }
 *   PUT    /api/admin/study-plans/:id                  edita (parcial)
 *   DELETE /api/admin/study-plans/:id                  409 enquanto o plano estiver ativo
 *   POST   /api/admin/study-plans/:id/items            acrescenta um passo no fim
 *   PUT    /api/admin/study-plans/:id/items/:itemId    edita um passo
 *   DELETE /api/admin/study-plans/:id/items/:itemId
 *   PATCH  /api/admin/study-plans/:id/items/reorder    { ids[] } → nova ordem completa
 *
 * É esta sequência que o gerador de cronograma segue: o aluno anda por ela no
 * ritmo da própria disponibilidade (server/services/study-plan.js). Mexer aqui
 * muda o cronograma de quem ainda não chegou naquele ponto; o que o aluno já
 * concluiu continua valendo, porque a posição dele é derivada dos itens
 * concluídos e não de um contador guardado no perfil.
 *
 * A numeração das posições é sempre 1..N sem buracos, e é reescrita por
 * `renumber` depois de apagar ou reordenar. Isso importa porque
 * (plan_id, position) é único: passar direto para a ordem nova cruzaria
 * posições ainda ocupadas no meio do caminho, então a troca é feita em duas
 * etapas, negativando antes.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { uniqueSlug } = require('../../utils/slug');

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const itemParams = z.object({ id: uuid, itemId: uuid });

const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const nullableUuid = z.preprocess(emptyToNull, uuid.nullable().optional());

const KINDS = ['lesson', 'essay', 'past_exam', 'simulado', 'review', 'training'];

const planBody = z.object({
  exam_id: uuid,
  name: z.string().trim().min(3, 'Dê um nome ao plano.').max(160),
  description: nullableText(2000),
  weeks: z.coerce.number().int().min(1).max(520).optional(),
  lessons_per_week: z.coerce.number().int().min(1).max(21).optional(),
  exam_every_weeks: z.coerce.number().int().min(0).max(52).optional(),
  training_weekdays: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),
  training_label: nullableText(160),
  active: z.boolean().optional(),
});
const planUpdate = planBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const itemBody = z.object({
  title: z.string().trim().min(2, 'Informe o que estudar neste passo.').max(300),
  subject_id: nullableUuid,
  topic_id: nullableUuid,
  week: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(520).nullable().optional()),
  kind: z.enum(KINDS).optional(),
  notes: nullableText(2000),
});
const itemUpdate = itemBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const SELECT_PLAN = `
  SELECT p.id, p.exam_id, p.slug, p.name, p.description, p.weeks, p.lessons_per_week,
         p.exam_every_weeks, p.training_weekdays, p.training_label, p.active,
         p.created_at, p.updated_at,
         e.name AS exam_name, e.short_name AS exam_short_name, e.track AS exam_track
    FROM study_plans p
    JOIN exams e ON e.id = p.exam_id`;

const ITEM_FIELDS = `
  SELECT i.id, i.plan_id, i.position, i.week, i.title, i.kind, i.subject_id, i.topic_id, i.notes,
         s.name AS subject_name, s.color AS subject_color, t.name AS topic_name
    FROM study_plan_items i
    LEFT JOIN subjects s ON s.id = i.subject_id
    LEFT JOIN topics t ON t.id = i.topic_id`;

const itemsOfPlan = (planId) => db.many(`${ITEM_FIELDS} WHERE i.plan_id = $1 ORDER BY i.position`, [planId]);
const oneItem = (itemId) => db.one(`${ITEM_FIELDS} WHERE i.id = $1`, [itemId]);

const PLAN_WRITABLE = [
  'exam_id',
  'name',
  'description',
  'weeks',
  'lessons_per_week',
  'exam_every_weeks',
  'training_weekdays',
  'training_label',
  'active',
];
const ITEM_WRITABLE = ['title', 'subject_id', 'topic_id', 'week', 'kind', 'notes'];

/**
 * Reescreve as posições como 1..N na ordem informada (ou na ordem atual, se
 * nenhuma for dada) e recalcula a semana pelo ritmo do plano.
 *
 * As posições são negativadas antes porque (plan_id, position) é único: sem
 * essa etapa, atribuir a ordem nova esbarraria em posições ainda ocupadas.
 */
async function renumber(client, planId, lessonsPerWeek, ids = null) {
  const porSemana = Math.max(1, Number(lessonsPerWeek) || 1);
  const ordem =
    ids ??
    (await client.query('SELECT id FROM study_plan_items WHERE plan_id = $1 ORDER BY position', [planId])).rows.map(
      (row) => row.id
    );
  if (!ordem.length) return;

  await client.query('UPDATE study_plan_items SET position = -position WHERE plan_id = $1', [planId]);
  await client.query(
    `UPDATE study_plan_items AS i
        SET position = o.position,
            week = ceil(o.position::numeric / $3)
       FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, position)
      WHERE i.id = o.id AND i.plan_id = $1`,
    [planId, ordem, porSemana]
  );
}

async function assertExam(examId) {
  const exam = await db.one('SELECT id FROM exams WHERE id = $1', [examId]);
  if (!exam) {
    throw new AppError(400, 'validation_error', 'Vestibular não encontrado.', [
      { path: 'exam_id', message: 'Vestibular não encontrado.' },
    ]);
  }
}

async function loadPlan(id) {
  const plan = await db.one(`${SELECT_PLAN} WHERE p.id = $1`, [id]);
  if (!plan) throw new AppError(404, 'not_found', 'Plano de estudo não encontrado.');
  return plan;
}

/** O assunto precisa pertencer à matéria informada, senão o cronograma casa errado. */
async function assertSubjectTopic(subjectId, topicId) {
  if (topicId) {
    const topic = await db.one('SELECT id, subject_id FROM topics WHERE id = $1', [topicId]);
    if (!topic) {
      throw new AppError(400, 'validation_error', 'Assunto não encontrado.', [
        { path: 'topic_id', message: 'Assunto não encontrado.' },
      ]);
    }
    if (subjectId && topic.subject_id !== subjectId) {
      throw new AppError(400, 'validation_error', 'O assunto escolhido não pertence a essa matéria.', [
        { path: 'topic_id', message: 'O assunto escolhido não pertence a essa matéria.' },
      ]);
    }
    return;
  }
  if (subjectId) {
    const subject = await db.one('SELECT id FROM subjects WHERE id = $1', [subjectId]);
    if (!subject) {
      throw new AppError(400, 'validation_error', 'Matéria não encontrada.', [
        { path: 'subject_id', message: 'Matéria não encontrada.' },
      ]);
    }
  }
}

router.get(
  '/',
  wrap(async (req, res) => {
    const [plans, counts] = await Promise.all([
      db.many(`${SELECT_PLAN} ORDER BY e.name, p.created_at`),
      db.many('SELECT plan_id, count(*)::int AS total, max(week) AS last_week FROM study_plan_items GROUP BY plan_id'),
    ]);
    const byPlan = new Map(counts.map((row) => [row.plan_id, row]));
    res.json({
      items: plans.map((plan) => ({
        ...plan,
        items_total: byPlan.get(plan.id)?.total ?? 0,
        last_week: byPlan.get(plan.id)?.last_week ?? null,
      })),
    });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const plan = await loadPlan(req.valid.params.id);
    res.json({ ...plan, items: await itemsOfPlan(plan.id) });
  })
);

router.post(
  '/',
  validate({ body: planBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    await assertExam(body.exam_id);

    const slug = await uniqueSlug(body.name, async (candidate) =>
      Boolean(await db.one('SELECT id FROM study_plans WHERE slug = $1', [candidate]))
    );

    const created = await db.one(
      `INSERT INTO study_plans (exam_id, slug, name, description, weeks, lessons_per_week,
                                exam_every_weeks, training_weekdays, training_label, active)
       VALUES ($1, $2, $3, $4, coalesce($5, 52), coalesce($6, 3), coalesce($7, 4),
               coalesce($8, '{}'::smallint[]), $9, coalesce($10, true))
       RETURNING id`,
      [
        body.exam_id,
        slug,
        body.name,
        body.description ?? null,
        body.weeks ?? null,
        body.lessons_per_week ?? null,
        body.exam_every_weeks ?? null,
        body.training_weekdays ?? null,
        body.training_label ?? null,
        body.active ?? null,
      ]
    );
    await audit(req, 'study_plan.create', 'study_plan', created.id, { name: body.name });
    res.status(201).json({ ...(await loadPlan(created.id)), items: [] });
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: planUpdate }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const antes = await loadPlan(id);
    if (body.exam_id) await assertExam(body.exam_id);

    const sets = [];
    const params = [];
    for (const field of PLAN_WRITABLE) {
      if (body[field] === undefined) continue;
      params.push(body[field]);
      sets.push(`${field} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE study_plans SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }

    // Mudar o ritmo muda a semana de cada passo: três aulas por semana ou seis
    // distribuem a mesma sequência em prazos diferentes.
    if (body.lessons_per_week !== undefined && body.lessons_per_week !== antes.lessons_per_week) {
      await db.tx((client) => renumber(client, id, body.lessons_per_week));
    }

    await audit(req, 'study_plan.update', 'study_plan', id, { changes: Object.keys(body) });
    const plan = await loadPlan(id);
    res.json({ ...plan, items: await itemsOfPlan(id) });
  })
);

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const plan = await loadPlan(id);
    // Um plano ativo pode estar guiando o cronograma de alunos agora; apagar
    // deixaria esses cronogramas sem sequência para continuar. Desativar
    // primeiro é um passo consciente.
    if (plan.active) {
      throw new AppError(
        409,
        'conflict',
        'Desative o plano antes de apagar — ele pode estar guiando o cronograma de alunos.'
      );
    }
    await db.query('DELETE FROM study_plans WHERE id = $1', [id]);
    await audit(req, 'study_plan.delete', 'study_plan', id, { name: plan.name });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/items',
  validate({ params: idParams, body: itemBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const plan = await loadPlan(id);
    await assertSubjectTopic(body.subject_id ?? null, body.topic_id ?? null);

    const last = await db.one('SELECT coalesce(max(position), 0) AS position FROM study_plan_items WHERE plan_id = $1', [
      id,
    ]);
    const position = Number(last.position) + 1;
    // Sem semana informada, ela vem do ritmo do plano.
    const week = body.week ?? Math.ceil(position / Math.max(1, Number(plan.lessons_per_week) || 1));

    const created = await db.one(
      `INSERT INTO study_plan_items (plan_id, position, week, title, kind, subject_id, topic_id, notes)
       VALUES ($1, $2, $3, $4, coalesce($5, 'lesson'), $6, $7, $8)
       RETURNING id`,
      [
        id,
        position,
        week,
        body.title,
        body.kind ?? null,
        body.subject_id ?? null,
        body.topic_id ?? null,
        body.notes ?? null,
      ]
    );
    await audit(req, 'study_plan_item.create', 'study_plan', id, { item_id: created.id, title: body.title });
    res.status(201).json(await oneItem(created.id));
  })
);

router.put(
  '/:id/items/:itemId',
  validate({ params: itemParams, body: itemUpdate }),
  wrap(async (req, res) => {
    const { id, itemId } = req.valid.params;
    const body = req.valid.body;
    await loadPlan(id);

    const existing = await db.one('SELECT id, subject_id FROM study_plan_items WHERE id = $1 AND plan_id = $2', [
      itemId,
      id,
    ]);
    if (!existing) throw new AppError(404, 'not_found', 'Passo não encontrado neste plano.');

    const subjectId = body.subject_id !== undefined ? body.subject_id : existing.subject_id;
    await assertSubjectTopic(subjectId ?? null, body.topic_id ?? null);

    const sets = [];
    const params = [];
    for (const field of ITEM_WRITABLE) {
      if (body[field] === undefined) continue;
      params.push(body[field]);
      sets.push(`${field} = $${params.length}`);
    }
    if (sets.length) {
      params.push(itemId);
      await db.query(`UPDATE study_plan_items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    await audit(req, 'study_plan_item.update', 'study_plan', id, { item_id: itemId, changes: Object.keys(body) });
    res.json(await oneItem(itemId));
  })
);

router.delete(
  '/:id/items/:itemId',
  validate({ params: itemParams }),
  wrap(async (req, res) => {
    const { id, itemId } = req.valid.params;
    const plan = await loadPlan(id);
    const item = await db.one('SELECT id, title FROM study_plan_items WHERE id = $1 AND plan_id = $2', [itemId, id]);
    if (!item) throw new AppError(404, 'not_found', 'Passo não encontrado neste plano.');

    await db.tx(async (client) => {
      await client.query('DELETE FROM study_plan_items WHERE id = $1', [itemId]);
      // Fecha o buraco na numeração: sem isso a próxima inclusão herdaria uma
      // posição já usada e esbarraria na unicidade (plan_id, position).
      await renumber(client, id, plan.lessons_per_week);
    });

    await audit(req, 'study_plan_item.delete', 'study_plan', id, { item_id: itemId, title: item.title });
    res.json({ ok: true, items: await itemsOfPlan(id) });
  })
);

router.patch(
  '/:id/items/reorder',
  validate({ params: idParams, body: z.object({ ids: z.array(uuid).min(1).max(2000) }) }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const plan = await loadPlan(id);
    const ids = Array.from(new Set(req.valid.body.ids));

    const doPlano = await db.many('SELECT id FROM study_plan_items WHERE plan_id = $1', [id]);
    const validos = new Set(doPlano.map((row) => row.id));
    if (ids.some((itemId) => !validos.has(itemId))) {
      throw new AppError(400, 'validation_error', 'A lista tem passos que não são deste plano.');
    }
    // Exigir a ordem completa evita o caso silencioso de sobrar passo fora da
    // numeração, que quebraria a sequência do cronograma.
    if (ids.length !== doPlano.length) {
      throw new AppError(
        400,
        'validation_error',
        `Envie a ordem completa: o plano tem ${doPlano.length} passo(s) e a lista trouxe ${ids.length}.`
      );
    }

    await db.tx((client) => renumber(client, id, plan.lessons_per_week, ids));
    await audit(req, 'study_plan_item.reorder', 'study_plan', id, { count: ids.length });
    res.json({ ok: true, items: await itemsOfPlan(id) });
  })
);

module.exports = { basePath: '/api/admin/study-plans', router };

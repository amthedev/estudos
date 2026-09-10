'use strict';

/**
 * Painel administrativo — professores das aulas particulares.
 *
 *   GET    /api/admin/teachers                 lista (q, subject_id, status) com matérias e agendamentos
 *   GET    /api/admin/teachers/:id             professor + matérias + disponibilidade + próximos agendamentos
 *   POST   /api/admin/teachers                 { name, email?, phone?, bio?, photo_url?, hourly_price_cents?,
 *                                                slot_minutes?, meeting_link?, active?, sort_order?,
 *                                                subject_ids?[], availability?[{weekday,start_time,end_time}] }
 *   PUT    /api/admin/teachers/:id             edita (parcial; subject_ids/availability substituem o conjunto)
 *   DELETE /api/admin/teachers/:id             409 quando há agendamentos ativos
 *   PUT    /api/admin/teachers/:id/subjects    { subject_ids: [] }
 *   PUT    /api/admin/teachers/:id/availability { availability: [{ weekday, start_time, end_time }] }
 *   POST   /api/admin/teachers/:id/activate    ativa (volta a aparecer para os alunos)
 *   POST   /api/admin/teachers/:id/deactivate  desativa (some da lista do aluno; agendamentos seguem)
 *
 * A disponibilidade são janelas semanais (weekday 0 = domingo … 6 = sábado); os horários livres
 * mostrados ao aluno saem dessas janelas, descontando os agendamentos já existentes.
 */
const router = require('express').Router();
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { nullableFileRef } = require('../../utils/validators');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);
const nullableText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const nullableUrl = nullableFileRef(2000, 'Informe um endereço válido ou envie o arquivo.');

const timeField = z
  .string()
  .trim()
  .regex(TIME_RE, 'Horário inválido (use HH:MM).')
  .transform((value) => (value.length === 5 ? `${value}:00` : value));

const availabilityItem = z
  .object({
    weekday: z.coerce.number().int().min(0, 'Dia da semana inválido.').max(6, 'Dia da semana inválido.'),
    start_time: timeField,
    end_time: timeField,
  })
  .refine((item) => item.end_time > item.start_time, {
    message: 'O horário final precisa ser depois do inicial.',
    path: ['end_time'],
  });

const availabilityField = z.array(availabilityItem).max(60);
const subjectIdsField = z.array(uuid).max(60);

const createBody = z.object({
  name: z.string().trim().min(3, 'Informe o nome do professor.').max(120),
  email: z.preprocess(emptyToNull, z.string().trim().toLowerCase().email('E-mail inválido.').max(160).nullable().optional()),
  phone: nullableText(40),
  bio: nullableText(4000),
  photo_url: nullableUrl,
  hourly_price_cents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  slot_minutes: z.coerce.number().int().min(15).max(240).optional(),
  meeting_link: nullableUrl,
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
  subject_ids: subjectIdsField.optional(),
  availability: availabilityField.optional(),
});
const updateBody = createBody.partial().refine((body) => Object.keys(body).length > 0, 'Nada para atualizar.');

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  subject_id: z.preprocess(emptyToUndefined, uuid.optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['active', 'inactive']).optional()),
});

const WRITABLE = ['name', 'email', 'phone', 'bio', 'photo_url', 'hourly_price_cents', 'slot_minutes',
  'meeting_link', 'active', 'sort_order'];

const SELECT_TEACHER = `
  SELECT t.id, t.name, t.email, t.phone, t.bio, t.photo_url, t.hourly_price_cents, t.slot_minutes,
         t.meeting_link, t.active, t.sort_order, t.created_at, t.updated_at,
         coalesce(sub.subject_ids, '{}'::uuid[]) AS subject_ids,
         coalesce(sub.subjects, '[]'::json) AS subjects,
         (SELECT count(*)::int FROM bookings b WHERE b.teacher_id = t.id) AS bookings_total,
         (SELECT count(*)::int FROM bookings b WHERE b.teacher_id = t.id AND b.status IN ('pending','confirmed')
            AND b.starts_at >= now()) AS bookings_upcoming,
         (SELECT count(*)::int FROM teacher_availability av WHERE av.teacher_id = t.id) AS availability_count
    FROM teachers t
    LEFT JOIN LATERAL (
      SELECT array_agg(s.id ORDER BY s.sort_order, s.name) AS subject_ids,
             json_agg(json_build_object('id', s.id, 'name', s.name, 'color', s.color, 'icon', s.icon)
                      ORDER BY s.sort_order, s.name) AS subjects
        FROM teacher_subjects ts JOIN subjects s ON s.id = ts.subject_id
       WHERE ts.teacher_id = t.id
    ) sub ON true`;

async function requireTeacher(id) {
  const teacher = await db.one('SELECT id, name, active FROM teachers WHERE id = $1', [id]);
  if (!teacher) throw new AppError(404, 'not_found', 'Professor não encontrado.');
  return teacher;
}

function loadAvailability(teacherId) {
  return db.many(
    `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM teacher_availability WHERE teacher_id = $1 ORDER BY weekday, start_time`,
    [teacherId]
  );
}

async function assertSubjects(subjectIds) {
  const ids = Array.from(new Set(subjectIds || []));
  if (!ids.length) return [];
  const rows = await db.many('SELECT id FROM subjects WHERE id = ANY($1::uuid[])', [ids]);
  if (rows.length !== ids.length) {
    throw new AppError(400, 'validation_error', 'Uma ou mais matérias informadas não existem.', [
      { path: 'subject_ids', message: 'Matéria não encontrada.' },
    ]);
  }
  return ids;
}

async function replaceSubjects(client, teacherId, subjectIds) {
  const ids = Array.from(new Set(subjectIds || []));
  await client.query('DELETE FROM teacher_subjects WHERE teacher_id = $1 AND NOT (subject_id = ANY($2::uuid[]))', [teacherId, ids]);
  if (!ids.length) return;
  await client.query(
    'INSERT INTO teacher_subjects (teacher_id, subject_id) SELECT $1, s FROM unnest($2::uuid[]) AS s ON CONFLICT DO NOTHING',
    [teacherId, ids]
  );
}

async function replaceAvailability(client, teacherId, availability) {
  const seen = new Set();
  await client.query('DELETE FROM teacher_availability WHERE teacher_id = $1', [teacherId]);
  for (const window of availability || []) {
    const key = `${window.weekday}|${window.start_time}|${window.end_time}`;
    if (seen.has(key)) continue; // janelas repetidas são ignoradas
    seen.add(key);
    await client.query(
      'INSERT INTO teacher_availability (teacher_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)',
      [teacherId, window.weekday, window.start_time, window.end_time]
    );
  }
}

// ---------------------------------------------------------------------------
// Listagem e leitura
// ---------------------------------------------------------------------------
router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const query = req.valid.query;
    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(fe_unaccent(t.name) ILIKE fe_unaccent(${like}) OR t.email ILIKE ${like})`);
    }
    if (query.status) clauses.push(`t.active = ${push(query.status === 'active')}`);
    if (query.subject_id) {
      clauses.push(`EXISTS (SELECT 1 FROM teacher_subjects ts2 WHERE ts2.teacher_id = t.id AND ts2.subject_id = ${push(query.subject_id)})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const items = await db.many(`${SELECT_TEACHER} ${where} ORDER BY t.sort_order, t.name`, params);
    res.json({ items, total: items.length });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const teacher = await db.one(`${SELECT_TEACHER} WHERE t.id = $1`, [id]);
    if (!teacher) throw new AppError(404, 'not_found', 'Professor não encontrado.');
    const [availability, bookings] = await Promise.all([
      loadAvailability(id),
      db.many(
        `SELECT b.id, b.user_id, u.name AS user_name, b.starts_at, b.ends_at, b.status, b.subject_id,
                s.name AS subject_name
           FROM bookings b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN subjects s ON s.id = b.subject_id
          WHERE b.teacher_id = $1
          ORDER BY b.starts_at DESC LIMIT 20`,
        [id]
      ),
    ]);
    teacher.availability = availability;
    teacher.bookings = bookings;
    res.json(teacher);
  })
);

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
router.post(
  '/',
  validate({ body: createBody }),
  wrap(async (req, res) => {
    const body = req.valid.body;
    const subjectIds = await assertSubjects(body.subject_ids);
    const order = body.sort_order ?? Number((await db.one('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM teachers')).next);

    const id = await db.tx(async (client) => {
      const row = await client.one(
        `INSERT INTO teachers (name, email, phone, bio, photo_url, hourly_price_cents, slot_minutes, meeting_link, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          body.name, body.email ?? null, body.phone ?? null, body.bio ?? null, body.photo_url ?? null,
          body.hourly_price_cents ?? 0, body.slot_minutes ?? 60, body.meeting_link ?? null,
          body.active ?? true, order,
        ]
      );
      await replaceSubjects(client, row.id, subjectIds);
      if (body.availability) await replaceAvailability(client, row.id, body.availability);
      return row.id;
    });

    const teacher = await db.one(`${SELECT_TEACHER} WHERE t.id = $1`, [id]);
    teacher.availability = await loadAvailability(id);
    await audit(req, 'teacher.create', 'teacher', id, { name: body.name, subjects: subjectIds.length });
    res.status(201).json(teacher);
  })
);

router.put(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    await requireTeacher(id);
    const subjectIds = body.subject_ids !== undefined ? await assertSubjects(body.subject_ids) : null;

    await db.tx(async (client) => {
      const sets = [];
      const params = [];
      for (const key of WRITABLE) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        params.push(body[key]);
        sets.push(`${key} = $${params.length}`);
      }
      if (sets.length) {
        params.push(id);
        await client.query(`UPDATE teachers SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (subjectIds) await replaceSubjects(client, id, subjectIds);
      if (body.availability !== undefined) await replaceAvailability(client, id, body.availability);
    });

    const teacher = await db.one(`${SELECT_TEACHER} WHERE t.id = $1`, [id]);
    teacher.availability = await loadAvailability(id);
    await audit(req, 'teacher.update', 'teacher', id, { changes: Object.keys(body) });
    res.json(teacher);
  })
);

router.put(
  '/:id/subjects',
  validate({ params: idParams, body: z.object({ subject_ids: subjectIdsField }) }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireTeacher(id);
    const subjectIds = await assertSubjects(req.valid.body.subject_ids);
    await db.tx(async (client) => replaceSubjects(client, id, subjectIds));
    const teacher = await db.one(`${SELECT_TEACHER} WHERE t.id = $1`, [id]);
    await audit(req, 'teacher.subjects', 'teacher', id, { count: subjectIds.length });
    res.json({ teacher_id: id, subject_ids: teacher.subject_ids, subjects: teacher.subjects });
  })
);

router.put(
  '/:id/availability',
  validate({ params: idParams, body: z.object({ availability: availabilityField }) }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    await requireTeacher(id);
    await db.tx(async (client) => replaceAvailability(client, id, req.valid.body.availability));
    const availability = await loadAvailability(id);
    await audit(req, 'teacher.availability', 'teacher', id, { count: availability.length });
    res.json({ teacher_id: id, availability });
  })
);

for (const [path, active, action] of [['activate', true, 'teacher.activate'], ['deactivate', false, 'teacher.deactivate']]) {
  router.post(
    `/:id/${path}`,
    validate({ params: idParams }),
    wrap(async (req, res) => {
      const { id } = req.valid.params;
      await requireTeacher(id);
      await db.query('UPDATE teachers SET active = $2 WHERE id = $1', [id, active]);
      const teacher = await db.one(`${SELECT_TEACHER} WHERE t.id = $1`, [id]);
      await audit(req, action, 'teacher', id, { active });
      res.json(teacher);
    })
  );
}

router.delete(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const teacher = await requireTeacher(id);
    const active = await db.one(
      `SELECT count(*)::int AS total FROM bookings
        WHERE teacher_id = $1 AND status IN ('pending','confirmed') AND ends_at >= now()`,
      [id]
    );
    if (active.total > 0) {
      throw new AppError(409, 'conflict', `Este professor tem ${active.total} aula(s) agendada(s). Cancele-as ou desative o professor.`, {
        bookings: active.total,
      });
    }
    await db.query('DELETE FROM teachers WHERE id = $1', [id]);
    await audit(req, 'teacher.delete', 'teacher', id, { name: teacher.name });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/teachers', router };

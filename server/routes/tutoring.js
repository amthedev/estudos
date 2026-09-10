'use strict';

/**
 * Aulas particulares (professores, horários e agendamentos do aluno).
 *
 *   GET  /api/tutoring/teachers?subject_id          → professores ativos com subjects[], preço, disponibilidade
 *   GET  /api/tutoring/teachers/:id/slots?from&to   → horários livres (fuso America/Sao_Paulo, só futuros ≥ 2h)
 *   GET  /api/tutoring/bookings                     → { upcoming, past } do aluno
 *   POST /api/tutoring/bookings                     { teacher_id, subject_id?, starts_at, notes? } → 201 booking (pending)
 *   POST /api/tutoring/bookings/:id/cancel          { reason? } → booking cancelado (até 12h antes; senão 409)
 *
 * Com a configuração private_lessons_enabled = false, todas as rotas respondem 404.
 * Todas as consultas de agendamento filtram por user_id = req.user.id.
 */
const router = require('express').Router();
const config = require('../config');
const db = require('../db/pool');
const { validate, z } = require('../middleware/validate');
const { AppError, wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const { getSetting } = require('../services/settings');
const mailer = require('../services/mailer');
const dates = require('../utils/dates');

const MIN_ADVANCE_MS = 2 * 60 * 60 * 1000; // agendar com pelo menos 2h de antecedência
const CANCEL_LIMIT_MS = 12 * 60 * 60 * 1000; // cancelar até 12h antes
const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Fuso horário: "YYYY-MM-DD" + "HH:MM" em São Paulo → instante UTC
// ---------------------------------------------------------------------------
const tzFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: dates.TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallClockAsUtc(date) {
  const parts = {};
  for (const { type, value } of tzFormatter.formatToParts(date)) parts[type] = value;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
}

/** Instante (Date) correspondente à data/hora local de São Paulo. */
function localToUtc(dateISO, time) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const minutes = dates.timeToMinutes(time) || 0;
  let guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0);
  // dois passos cobrem transições de horário de verão (não vigente hoje no Brasil)
  for (let i = 0; i < 2; i += 1) {
    const offset = wallClockAsUtc(new Date(guess)) - guess;
    guess -= offset;
  }
  return new Date(guess);
}

/** 'HH:MM' local (São Paulo) de um instante. */
function localTime(date) {
  const parts = {};
  for (const { type, value } of tzFormatter.formatToParts(date)) parts[type] = value;
  return `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const isoDate = z.string().refine(dates.isISODate, 'Data inválida (use AAAA-MM-DD).');

const teachersQuerySchema = z.object({ subject_id: uuid.optional() }).passthrough();
const slotsQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() }).passthrough();
const idParams = z.object({ id: uuid });

const createBookingSchema = z
  .object({
    teacher_id: uuid,
    subject_id: uuid.nullable().optional(),
    starts_at: z.string().datetime({ offset: true, message: 'Data e hora inválidas.' }),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const cancelBookingSchema = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEACHER_COLUMNS = 't.id, t.name, t.bio, t.photo_url, t.hourly_price_cents, t.slot_minutes, t.sort_order';

async function requirePrivateLessons(req, res, next) {
  try {
    const enabled = await getSetting('private_lessons_enabled', true);
    if (enabled === false || enabled === 'false' || enabled === 0) {
      return next(new AppError(404, 'not_found', 'As aulas particulares não estão disponíveis no momento.'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function loadTeacher(id) {
  const teacher = await db.one(
    `SELECT ${TEACHER_COLUMNS}, t.meeting_link, t.email
       FROM teachers t
      WHERE t.id = $1 AND t.active = true`,
    [id]
  );
  if (!teacher) throw new AppError(404, 'not_found', 'Professor não encontrado.');
  return teacher;
}

async function loadAvailability(teacherId) {
  return db.many(
    `SELECT weekday, start_time, end_time
       FROM teacher_availability
      WHERE teacher_id = $1
      ORDER BY weekday, start_time`,
    [teacherId]
  );
}

function priceFor(teacher) {
  return Math.round((Number(teacher.hourly_price_cents) * Number(teacher.slot_minutes)) / 60);
}

/**
 * Horários livres do professor entre from e to (datas locais, inclusive).
 * @returns {Promise<Array<{ date: string, weekday: number, slots: Array<{ starts_at: Date, ends_at: Date, time: string }> }>>}
 */
async function freeSlots(teacher, availability, from, to, { now = new Date() } = {}) {
  const slotMinutes = Math.max(15, Number(teacher.slot_minutes) || 60);
  const rangeStart = localToUtc(from, '00:00');
  const rangeEnd = new Date(localToUtc(to, '00:00').getTime() + 24 * 60 * 60 * 1000);
  const bookings = await db.many(
    `SELECT starts_at, ends_at
       FROM bookings
      WHERE teacher_id = $1 AND status IN ('pending', 'confirmed')
        AND ends_at > $2 AND starts_at < $3`,
    [teacher.id, rangeStart, rangeEnd]
  );
  const busy = bookings.map((b) => ({ start: new Date(b.starts_at).getTime(), end: new Date(b.ends_at).getTime() }));
  const minStart = now.getTime() + MIN_ADVANCE_MS;
  const byWeekday = new Map();
  for (const row of availability) {
    if (!byWeekday.has(row.weekday)) byWeekday.set(row.weekday, []);
    byWeekday.get(row.weekday).push(row);
  }

  const days = [];
  for (const date of dates.eachDay(from, to)) {
    const weekday = dates.weekday(date);
    const windows = byWeekday.get(weekday) || [];
    const slots = [];
    for (const window of windows) {
      const startMin = dates.timeToMinutes(window.start_time);
      const endMin = dates.timeToMinutes(window.end_time);
      if (startMin === null || endMin === null) continue;
      for (let cursor = startMin; cursor + slotMinutes <= endMin; cursor += slotMinutes) {
        const startsAt = localToUtc(date, dates.minutesToTime(cursor));
        const endsAt = new Date(startsAt.getTime() + slotMinutes * 60 * 1000);
        const s = startsAt.getTime();
        const e = endsAt.getTime();
        if (s < minStart) continue;
        if (busy.some((b) => b.start < e && b.end > s)) continue;
        if (slots.some((existing) => existing.starts_at.getTime() === s)) continue; // janelas sobrepostas
        slots.push({ starts_at: startsAt, ends_at: endsAt, time: localTime(startsAt) });
      }
    }
    slots.sort((a, b) => a.starts_at - b.starts_at);
    days.push({ date, weekday, slots });
  }
  return days;
}

const BOOKING_SELECT = `
  SELECT b.id, b.teacher_id, b.subject_id, b.starts_at, b.ends_at, b.status, b.student_notes,
         b.price_cents, b.cancelled_by, b.cancel_reason, b.created_at, b.updated_at,
         CASE WHEN b.status = 'confirmed' THEN b.meeting_link ELSE NULL END AS meeting_link,
         t.name AS teacher_name, t.photo_url AS teacher_photo_url,
         s.name AS subject_name, s.color AS subject_color, s.icon AS subject_icon
    FROM bookings b
    JOIN teachers t ON t.id = b.teacher_id
    LEFT JOIN subjects s ON s.id = b.subject_id`;

function decorateBooking(row, now = Date.now()) {
  if (!row) return null;
  const startsAt = new Date(row.starts_at).getTime();
  const active = row.status === 'pending' || row.status === 'confirmed';
  return {
    ...row,
    duration_min: Math.round((new Date(row.ends_at).getTime() - startsAt) / 60000),
    can_cancel: active && startsAt - now >= CANCEL_LIMIT_MS,
    is_upcoming: active && new Date(row.ends_at).getTime() > now,
  };
}

async function loadBooking(id, userId) {
  const row = await db.one(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`, [id, userId]);
  return decorateBooking(row);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** E-mail ao aluno confirmando o pedido de agendamento (aguarda confirmação do professor). */
async function sendBookingRequestedEmail({ user, booking, teacher, subjectName }) {
  const [brandName, supportEmail] = await Promise.all([getSetting('brand_name'), getSetting('support_email')]);
  const firstName = String(user.name || '').trim().split(/\s+/)[0] || 'aluno(a)';
  const when = `${dates.formatLongBR(dates.toISODate(booking.starts_at))}, às ${localTime(new Date(booking.starts_at))}`;
  const price = (Number(booking.price_cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const link = `${config.appUrl}/app/aulas-particulares`;
  const subject = `${brandName} — pedido de aula particular recebido`;
  const lines = [
    `Professor(a): ${teacher.name}`,
    subjectName ? `Matéria: ${subjectName}` : null,
    `Quando: ${when}`,
    `Duração: ${booking.duration_min} minutos`,
    `Valor: ${price}`,
  ].filter(Boolean);
  const text = [
    `Olá, ${firstName}.`,
    '',
    'Recebemos seu pedido de aula particular. Ele fica como "aguardando confirmação" até o professor confirmar; você será avisado por aqui.',
    '',
    ...lines,
    '',
    `Acompanhe em: ${link}`,
    'Cancelamentos podem ser feitos até 12 horas antes do horário marcado.',
  ].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF2F7;font-family:Inter,Arial,Helvetica,sans-serif;color:#0B1626;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EEF2F7;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #DCE3EC;">
      <tr><td style="background:#07111F;padding:20px 28px;color:#F5F7FA;font-size:18px;font-weight:700;">${escapeHtml(brandName)}</td></tr>
      <tr><td style="padding:28px;font-size:15px;line-height:1.6;">
        <p style="margin:0 0 16px;">Olá, ${escapeHtml(firstName)}.</p>
        <p style="margin:0 0 16px;">Recebemos seu pedido de aula particular. Ele fica como <strong>aguardando confirmação</strong> até o professor confirmar; você será avisado por aqui.</p>
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #E5EAF1;border-radius:8px;padding:12px 16px;font-size:14px;">
          ${lines.map((line) => `<tr><td style="padding:4px 0;">${escapeHtml(line)}</td></tr>`).join('')}
        </table>
        <p style="margin:24px 0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2F80ED;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Ver minhas aulas</a></p>
        <p style="margin:0;font-size:13px;color:#475569;">Cancelamentos podem ser feitos até 12 horas antes do horário marcado.</p>
      </td></tr>
      <tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#64748B;border-top:1px solid #E5EAF1;">${escapeHtml(supportEmail ? `Precisa de ajuda? Escreva para ${supportEmail}. Este é um e-mail automático de ${brandName}.` : `Este é um e-mail automático de ${brandName}.`)}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return mailer.sendMail({ to: user.email, subject, html, text, link });
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
router.use(requireStudent, requireAccess, requirePrivateLessons);

router.get(
  '/teachers',
  validate({ query: teachersQuerySchema }),
  wrap(async (req, res) => {
    const { subject_id: subjectId } = req.valid.query;
    const params = [];
    let filter = '';
    if (subjectId) {
      params.push(subjectId);
      filter = `AND EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.teacher_id = t.id AND ts.subject_id = $${params.length})`;
    }
    const teachers = await db.many(
      `SELECT ${TEACHER_COLUMNS},
              COALESCE((
                SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'color', s.color, 'icon', s.icon) ORDER BY s.sort_order, s.name)
                  FROM teacher_subjects ts JOIN subjects s ON s.id = ts.subject_id
                 WHERE ts.teacher_id = t.id AND s.active = true
              ), '[]'::json) AS subjects,
              COALESCE((
                SELECT json_agg(json_build_object('weekday', a.weekday, 'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI')) ORDER BY a.weekday, a.start_time)
                  FROM teacher_availability a WHERE a.teacher_id = t.id
              ), '[]'::json) AS availability
         FROM teachers t
        WHERE t.active = true ${filter}
        ORDER BY t.sort_order ASC, t.name ASC`,
      params
    );
    res.json(
      teachers.map((teacher) => ({
        ...teacher,
        slot_price_cents: priceFor(teacher),
      }))
    );
  })
);

router.get(
  '/teachers/:id/slots',
  validate({ params: idParams, query: slotsQuerySchema }),
  wrap(async (req, res) => {
    const teacher = await loadTeacher(req.valid.params.id);
    const today = dates.todayISO();
    let from = req.valid.query.from || today;
    if (from < today) from = today;
    const to = req.valid.query.to || dates.addDays(from, DEFAULT_RANGE_DAYS - 1);
    const span = dates.diffDays(from, to);
    if (span === null || span < 0) {
      throw new AppError(400, 'validation_error', 'O fim do período deve ser igual ou posterior ao início.', [
        { path: 'to', message: 'Período inválido.' },
      ]);
    }
    if (span >= MAX_RANGE_DAYS) {
      throw new AppError(400, 'validation_error', `Consulte no máximo ${MAX_RANGE_DAYS} dias por vez.`, [
        { path: 'to', message: 'Período longo demais.' },
      ]);
    }

    const availability = await loadAvailability(teacher.id);
    const days = await freeSlots(teacher, availability, from, to);
    res.json({
      teacher: {
        id: teacher.id,
        name: teacher.name,
        slot_minutes: teacher.slot_minutes,
        hourly_price_cents: teacher.hourly_price_cents,
        slot_price_cents: priceFor(teacher),
      },
      from,
      to,
      timezone: dates.TIMEZONE,
      days: days.map((day) => ({
        ...day,
        slots: day.slots.map((slot) => ({
          starts_at: slot.starts_at.toISOString(),
          ends_at: slot.ends_at.toISOString(),
          time: slot.time,
        })),
      })),
    });
  })
);

router.get(
  '/bookings',
  wrap(async (req, res) => {
    const rows = await db.many(`${BOOKING_SELECT} WHERE b.user_id = $1 ORDER BY b.starts_at DESC`, [req.user.id]);
    const now = Date.now();
    const all = rows.map((row) => decorateBooking(row, now));
    const upcoming = all.filter((b) => b.is_upcoming).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const past = all.filter((b) => !b.is_upcoming);
    res.json({ upcoming, past, total: all.length });
  })
);

router.post(
  '/bookings',
  validate({ body: createBookingSchema }),
  wrap(async (req, res) => {
    const { teacher_id: teacherId, subject_id: subjectId, starts_at: startsAtRaw, notes } = req.valid.body;
    const teacher = await loadTeacher(teacherId);

    let subject = null;
    if (subjectId) {
      subject = await db.one(
        `SELECT s.id, s.name
           FROM teacher_subjects ts JOIN subjects s ON s.id = ts.subject_id
          WHERE ts.teacher_id = $1 AND ts.subject_id = $2`,
        [teacher.id, subjectId]
      );
      if (!subject) {
        throw new AppError(400, 'validation_error', 'Este professor não atende a matéria escolhida.', [
          { path: 'subject_id', message: 'Matéria não atendida por este professor.' },
        ]);
      }
    }

    const startsAt = new Date(startsAtRaw);
    if (Number.isNaN(startsAt.getTime())) {
      throw new AppError(400, 'validation_error', 'Data e hora inválidas.', [{ path: 'starts_at', message: 'Data e hora inválidas.' }]);
    }
    if (startsAt.getTime() < Date.now() + MIN_ADVANCE_MS) {
      throw new AppError(409, 'conflict', 'Escolha um horário com pelo menos 2 horas de antecedência.');
    }

    const date = dates.toISODate(startsAt);
    const availability = await loadAvailability(teacher.id);
    const [day] = await freeSlots(teacher, availability, date, date);
    const slot = day && day.slots.find((s) => s.starts_at.getTime() === startsAt.getTime());
    if (!slot) {
      throw new AppError(409, 'conflict', 'Este horário não está disponível. Escolha outro horário livre.');
    }

    let booking;
    try {
      booking = await db.one(
        `INSERT INTO bookings (user_id, teacher_id, subject_id, starts_at, ends_at, status, student_notes, meeting_link, price_cents)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
         RETURNING id`,
        [req.user.id, teacher.id, subject ? subject.id : null, slot.starts_at, slot.ends_at, notes || null, teacher.meeting_link || null, priceFor(teacher)]
      );
    } catch (err) {
      if (err && err.code === '23505') {
        throw new AppError(409, 'conflict', 'Este horário acabou de ser reservado por outro aluno. Escolha outro.');
      }
      throw err;
    }

    const created = await loadBooking(booking.id, req.user.id);
    try {
      await sendBookingRequestedEmail({ user: req.user, booking: created, teacher, subjectName: subject ? subject.name : null });
    } catch (err) {
      console.error('[tutoring] falha ao enviar e-mail de agendamento:', err.message);
    }
    res.status(201).json(created);
  })
);

router.post(
  '/bookings/:id/cancel',
  validate({ params: idParams, body: cancelBookingSchema.optional() }),
  wrap(async (req, res) => {
    const booking = await loadBooking(req.valid.params.id, req.user.id);
    if (!booking) throw new AppError(404, 'not_found', 'Agendamento não encontrado.');
    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      throw new AppError(409, 'conflict', 'Este agendamento já foi encerrado e não pode ser cancelado.');
    }
    if (new Date(booking.starts_at).getTime() - Date.now() < CANCEL_LIMIT_MS) {
      throw new AppError(409, 'conflict', 'Cancelamentos só são permitidos até 12 horas antes da aula. Fale com o suporte.');
    }
    const reason = (req.valid.body && req.valid.body.reason) || null;
    await db.query(
      `UPDATE bookings
          SET status = 'cancelled', cancelled_by = 'student', cancel_reason = $3
        WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'confirmed')`,
      [booking.id, req.user.id, reason]
    );
    res.json(await loadBooking(booking.id, req.user.id));
  })
);

module.exports = { basePath: '/api/tutoring', router, localToUtc, freeSlots };

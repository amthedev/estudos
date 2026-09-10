'use strict';

/**
 * Painel administrativo — agendamentos de aulas particulares.
 *
 *   GET  /api/admin/bookings              lista paginada (status, teacher_id, user_id, subject_id, from, to, q)
 *   GET  /api/admin/bookings/:id          agendamento completo (aluno, professor, matéria, observações)
 *   POST /api/admin/bookings/:id/confirm  { meeting_link?, admin_notes? } → confirma e avisa o aluno por e-mail
 *   POST /api/admin/bookings/:id/cancel   { reason } → cancela (cancelled_by = 'admin') e avisa o aluno
 *   POST /api/admin/bookings/:id/complete marca a aula como realizada
 *
 * O envio de e-mail nunca derruba a operação: falhas ficam registradas no console e a resposta
 * traz `email: { sent, error? }` para o painel exibir o aviso.
 */
const router = require('express').Router();
const config = require('../../config');
const db = require('../../db/pool');
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const { parsePagination, paginate, parseSort } = require('../../utils/pagination');
const { getSetting } = require('../../services/settings');
const mailer = require('../../services/mailer');
const dates = require('../../utils/dates');

const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const emptyToUndefined = (value) => (value === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

const listQuery = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.preprocess(emptyToUndefined, z.enum(STATUSES).optional()),
  teacher_id: z.preprocess(emptyToUndefined, uuid.optional()),
  user_id: z.preprocess(emptyToUndefined, uuid.optional()),
  subject_id: z.preprocess(emptyToUndefined, uuid.optional()),
  from: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  to: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const confirmBody = z.object({
  meeting_link: z.preprocess(emptyToNull, z.string().trim().url('Informe um link válido (https://...).').max(2000).nullable().optional()),
  admin_notes: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
});

const cancelBody = z.object({
  reason: z.string().trim().min(3, 'Explique o motivo do cancelamento.').max(500),
});

const completeBody = z.object({
  admin_notes: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
});

const SORTABLE = {
  starts_at: 'b.starts_at',
  created_at: 'b.created_at',
  status: 'b.status',
  teacher_name: 't.name',
  user_name: 'u.name',
};

const SELECT_BOOKING = `
  SELECT b.id, b.user_id, u.name AS user_name, u.email AS user_email,
         b.teacher_id, t.name AS teacher_name, t.email AS teacher_email, t.photo_url AS teacher_photo_url,
         b.subject_id, s.name AS subject_name, s.color AS subject_color,
         b.starts_at, b.ends_at, b.status, b.student_notes, b.admin_notes, b.meeting_link,
         b.price_cents, b.cancelled_by, b.cancel_reason, b.created_at, b.updated_at,
         (EXTRACT(EPOCH FROM (b.ends_at - b.starts_at)) / 60)::int AS duration_min
    FROM bookings b
    JOIN users u ON u.id = b.user_id
    JOIN teachers t ON t.id = b.teacher_id
    LEFT JOIN subjects s ON s.id = b.subject_id`;

const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: dates.TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const localTime = (value) => timeFormatter.format(new Date(value));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const formatMoney = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function requireBooking(id) {
  const booking = await db.one(`${SELECT_BOOKING} WHERE b.id = $1`, [id]);
  if (!booking) throw new AppError(404, 'not_found', 'Agendamento não encontrado.');
  return booking;
}

/**
 * E-mail ao aluno sobre o agendamento. Nunca lança: devolve { sent, error? }.
 * @param {'confirmed'|'cancelled'} kind
 */
async function notifyStudent(kind, booking) {
  try {
    const [brandName, supportEmail] = await Promise.all([getSetting('brand_name'), getSetting('support_email')]);
    const firstName = String(booking.user_name || '').trim().split(/\s+/)[0] || 'aluno(a)';
    const when = `${dates.formatLongBR(dates.toISODate(booking.starts_at))}, às ${localTime(booking.starts_at)}`;
    const link = `${config.appUrl}/app/aulas-particulares`;
    const confirmed = kind === 'confirmed';

    const subject = confirmed
      ? `${brandName} — sua aula particular foi confirmada`
      : `${brandName} — sua aula particular foi cancelada`;
    const intro = confirmed
      ? 'Sua aula particular está confirmada. Guarde os dados abaixo e entre alguns minutos antes do horário.'
      : 'Sua aula particular foi cancelada. Você pode agendar um novo horário quando quiser.';
    const lines = [
      `Professor(a): ${booking.teacher_name}`,
      booking.subject_name ? `Matéria: ${booking.subject_name}` : null,
      `Quando: ${when}`,
      `Duração: ${booking.duration_min} minutos`,
      confirmed && booking.price_cents ? `Valor: ${formatMoney(booking.price_cents)}` : null,
      confirmed && booking.meeting_link ? `Link da aula: ${booking.meeting_link}` : null,
      !confirmed && booking.cancel_reason ? `Motivo: ${booking.cancel_reason}` : null,
    ].filter(Boolean);

    const text = [`Olá, ${firstName}.`, '', intro, '', ...lines, '', `Acompanhe em: ${link}`].join('\n');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF2F7;font-family:Inter,Arial,Helvetica,sans-serif;color:#0B1626;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EEF2F7;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #DCE3EC;">
      <tr><td style="background:#07111F;padding:20px 28px;color:#F5F7FA;font-size:18px;font-weight:700;">${escapeHtml(brandName)}</td></tr>
      <tr><td style="padding:28px;font-size:15px;line-height:1.6;">
        <p style="margin:0 0 16px;">Olá, ${escapeHtml(firstName)}.</p>
        <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
        <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #E5EAF1;border-radius:8px;padding:12px 16px;font-size:14px;">
          ${lines.map((line) => `<tr><td style="padding:4px 0;">${escapeHtml(line)}</td></tr>`).join('')}
        </table>
        <p style="margin:24px 0;text-align:center;"><a href="${escapeHtml(confirmed && booking.meeting_link ? booking.meeting_link : link)}" style="display:inline-block;background:#2F80ED;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">${confirmed && booking.meeting_link ? 'Entrar na aula' : 'Ver minhas aulas'}</a></p>
      </td></tr>
      <tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#64748B;border-top:1px solid #E5EAF1;">${escapeHtml(supportEmail ? `Precisa de ajuda? Escreva para ${supportEmail}. Este é um e-mail automático de ${brandName}.` : `Este é um e-mail automático de ${brandName}.`)}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;

    const result = await mailer.sendMail({
      to: booking.user_email,
      subject,
      html,
      text,
      link: confirmed && booking.meeting_link ? booking.meeting_link : link,
    });
    return { sent: Boolean(result && result.sent) };
  } catch (err) {
    console.error(`[admin/bookings] falha ao avisar o aluno (${kind}):`, err.message);
    return { sent: false, error: 'Não foi possível enviar o e-mail ao aluno.' };
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
    const { page, limit, offset } = parsePagination(query, { defaultLimit: 20, maxLimit: 100 });
    const sort = parseSort(query, SORTABLE, { defaultSort: 'starts_at', defaultDir: 'desc' });

    const clauses = [];
    const params = [];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = push(`%${query.q}%`);
      clauses.push(`(fe_unaccent(u.name) ILIKE fe_unaccent(${like}) OR u.email ILIKE ${like}
                     OR fe_unaccent(t.name) ILIKE fe_unaccent(${like}))`);
    }
    if (query.status) clauses.push(`b.status = ${push(query.status)}`);
    if (query.teacher_id) clauses.push(`b.teacher_id = ${push(query.teacher_id)}`);
    if (query.user_id) clauses.push(`b.user_id = ${push(query.user_id)}`);
    if (query.subject_id) clauses.push(`b.subject_id = ${push(query.subject_id)}`);
    if (query.from) clauses.push(`b.starts_at >= ${push(query.from)}::timestamptz`);
    if (query.to) clauses.push(`b.starts_at < (${push(query.to)}::timestamptz + interval '1 day')`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [totalRow, items, summary] = await Promise.all([
      db.one(
        `SELECT count(*)::int AS total FROM bookings b
           JOIN users u ON u.id = b.user_id JOIN teachers t ON t.id = b.teacher_id ${where}`,
        params
      ),
      db.many(
        `${SELECT_BOOKING} ${where} ORDER BY ${sort.sql}, b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.one(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE status IN ('pending','confirmed') AND starts_at >= now())::int AS upcoming
           FROM bookings`
      ),
    ]);
    res.json({ ...paginate(items, totalRow.total, { page, limit }), summary });
  })
);

router.get(
  '/:id',
  validate({ params: idParams }),
  wrap(async (req, res) => {
    res.json(await requireBooking(req.valid.params.id));
  })
);

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------
router.post(
  '/:id/confirm',
  validate({ params: idParams, body: confirmBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const body = req.valid.body;
    const booking = await requireBooking(id);
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      throw new AppError(409, 'conflict', 'Este agendamento não pode mais ser confirmado.');
    }

    const teacher = await db.one('SELECT meeting_link FROM teachers WHERE id = $1', [booking.teacher_id]);
    const meetingLink = body.meeting_link ?? booking.meeting_link ?? (teacher ? teacher.meeting_link : null);
    await db.query(
      `UPDATE bookings SET status = 'confirmed', meeting_link = $2,
              admin_notes = coalesce($3, admin_notes), cancelled_by = NULL, cancel_reason = NULL
        WHERE id = $1`,
      [id, meetingLink, body.admin_notes ?? null]
    );

    const updated = await requireBooking(id);
    const email = await notifyStudent('confirmed', updated);
    await audit(req, 'booking.confirm', 'booking', id, { meeting_link: Boolean(meetingLink), email_sent: email.sent });
    res.json({ ...updated, email });
  })
);

router.post(
  '/:id/cancel',
  validate({ params: idParams, body: cancelBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const { reason } = req.valid.body;
    const booking = await requireBooking(id);
    if (booking.status === 'cancelled') throw new AppError(409, 'conflict', 'Este agendamento já está cancelado.');
    if (booking.status === 'completed') throw new AppError(409, 'conflict', 'Uma aula já realizada não pode ser cancelada.');

    await db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = 'admin', cancel_reason = $2 WHERE id = $1`,
      [id, reason]
    );
    const updated = await requireBooking(id);
    const email = await notifyStudent('cancelled', updated);
    await audit(req, 'booking.cancel', 'booking', id, { reason, email_sent: email.sent });
    res.json({ ...updated, email });
  })
);

router.post(
  '/:id/complete',
  validate({ params: idParams, body: completeBody }),
  wrap(async (req, res) => {
    const { id } = req.valid.params;
    const booking = await requireBooking(id);
    if (booking.status === 'cancelled') throw new AppError(409, 'conflict', 'Um agendamento cancelado não pode ser marcado como realizado.');

    await db.query(
      `UPDATE bookings SET status = 'completed', admin_notes = coalesce($2, admin_notes) WHERE id = $1`,
      [id, req.valid.body.admin_notes ?? null]
    );
    const updated = await requireBooking(id);
    await audit(req, 'booking.complete', 'booking', id, { teacher_id: updated.teacher_id });
    res.json(updated);
  })
);

module.exports = { basePath: '/api/admin/bookings', router };

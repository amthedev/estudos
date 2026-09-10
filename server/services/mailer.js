'use strict';

/**
 * Envio de e-mails (nodemailer via SMTP).
 *
 *   const { sendMail, passwordResetEmail } = require('../services/mailer');
 *   const mail = passwordResetEmail({ name, link });
 *   await sendMail({ to: user.email, ...mail });
 *
 * Sem SMTP configurado (SMTP_HOST vazio), nada é enviado: o e-mail é impresso no console
 * e a função devolve { sent: false, preview: <primeiro link do e-mail> }.
 * Em testes os e-mails ficam em `outbox` para inspeção.
 */
const nodemailer = require('nodemailer');
const config = require('../config');

const outbox = [];
const OUTBOX_LIMIT = 50;
let transport = null;

function isConfigured() {
  return config.smtp.enabled;
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass || '' } : undefined,
    });
  }
  return transport;
}

function extractLink(content) {
  if (!content) return null;
  const match = String(content).match(/https?:\/\/[^\s"'<>]+/);
  return match ? match[0].replace(/[.,;)]+$/, '') : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Status para o painel (sem expor segredos). */
function smtpStatus() {
  return {
    configured: isConfigured(),
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user ? `${config.smtp.user.slice(0, 2)}…${config.smtp.user.slice(-4)}` : null,
    from: config.smtp.from,
  };
}

/**
 * Envia um e-mail.
 * @returns {Promise<{ sent: boolean, preview: string|null, messageId?: string, error?: string }>}
 */
async function sendMail({ to, subject, html, text, link }) {
  if (!to || !subject) throw new Error('sendMail exige "to" e "subject".');
  const preview = link || extractLink(text) || extractLink(html) || null;
  const record = { to, subject, html, text, link: preview, sent_at: new Date() };

  if (config.isTest) {
    outbox.push(record);
    if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  }

  if (!isConfigured()) {
    if (!config.isTest) {
      console.log(
        [
          '[mailer] SMTP não configurado — e-mail não enviado.',
          `  Para:    ${to}`,
          `  Assunto: ${subject}`,
          preview ? `  Link:    ${preview}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
    return { sent: false, preview };
  }

  try {
    const info = await getTransport().sendMail({ from: config.smtp.from, to, subject, text, html });
    return { sent: true, preview: null, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] falha ao enviar para ${to}: ${err.message}`);
    return { sent: false, preview, error: err.message };
  }
}

/** Layout base, sóbrio, compatível com clientes de e-mail. */
function layout({ brandName, title, bodyHtml, footerText }) {
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#EEF2F7;font-family:Inter,Arial,Helvetica,sans-serif;color:#0B1626;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EEF2F7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #DCE3EC;">
        <tr><td style="background:#07111F;padding:20px 28px;color:#F5F7FA;font-size:18px;font-weight:700;letter-spacing:.2px;">${escapeHtml(brandName)}</td></tr>
        <tr><td style="padding:28px;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#64748B;border-top:1px solid #E5EAF1;">${escapeHtml(footerText)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * E-mail de recuperação de senha.
 * @returns {{ subject: string, html: string, text: string, link: string }}
 */
function passwordResetEmail({ name, link, brandName = config.brandName, expiresMinutes = 60, supportEmail }) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'aluno(a)';
  const subject = `${brandName} — redefinição de senha`;
  const bodyHtml = `
    <p style="margin:0 0 16px;">Olá, ${escapeHtml(firstName)}.</p>
    <p style="margin:0 0 16px;">Recebemos um pedido para redefinir a senha da sua conta. Para escolher uma nova senha, use o botão abaixo. O link vale por ${expiresMinutes} minutos.</p>
    <p style="margin:24px 0;text-align:center;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#2F80ED;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Redefinir senha</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#475569;">Se o botão não funcionar, copie e cole este endereço no navegador:</p>
    <p style="margin:0 0 16px;font-size:13px;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:#2F80ED;">${escapeHtml(link)}</a></p>
    <p style="margin:0;font-size:13px;color:#475569;">Se você não pediu a redefinição, ignore este e-mail: sua senha continua a mesma.</p>`;
  const footerText = supportEmail
    ? `Precisa de ajuda? Escreva para ${supportEmail}. Este é um e-mail automático de ${brandName}.`
    : `Este é um e-mail automático de ${brandName}.`;
  const text = [
    `Olá, ${firstName}.`,
    '',
    `Recebemos um pedido para redefinir a senha da sua conta em ${brandName}.`,
    `Para escolher uma nova senha, acesse o link abaixo (válido por ${expiresMinutes} minutos):`,
    link,
    '',
    'Se você não pediu a redefinição, ignore este e-mail: sua senha continua a mesma.',
  ].join('\n');
  return { subject, html: layout({ brandName, title: subject, bodyHtml, footerText }), text, link };
}

module.exports = { sendMail, passwordResetEmail, isConfigured, smtpStatus, outbox, extractLink };

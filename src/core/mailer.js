// Email via SMTP (cPanel mail works: SMTP_HOST=mail.your-domain.com, port 465, a mailbox user/password).
// Disabled unless SMTP_HOST is set — the UI then tells admins to share links manually.
const knex = require('../db/knex');
const config = require('../config');
const { translator } = require('./i18n');

let transport;
function getTransport() {
  if (transport !== undefined) return transport;
  if (!process.env.SMTP_HOST) {
    transport = null;
    return transport;
  }
  try {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  } catch (e) {
    console.error('[mail] nodemailer unavailable:', e.message);
    transport = null;
  }
  return transport;
}

const enabled = () => Boolean(getTransport()) && !config.isTest;
const from = () => process.env.MAIL_FROM || `RemoteWay <${process.env.SMTP_USER || 'no-reply@localhost'}>`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout({ locale, title, body, cta, href }) {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:#f7f7f7;font-family:Tahoma,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e2e2;border-radius:14px;overflow:hidden">
<div style="background:#1acc6c;padding:18px 24px;font-weight:800;font-size:18px">Remote<span style="color:#fff">WAY</span></div>
<div style="padding:24px"><h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2><p style="line-height:1.7;margin:0 0 20px">${escapeHtml(body)}</p>
${href ? `<a href="${escapeHtml(href)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:700">${escapeHtml(cta)}</a>` : ''}
</div></div></body></html>`;
}

async function send({ to, subject, html }) {
  const t = getTransport();
  if (!t || config.isTest) return false;
  await t.sendMail({ from: from(), to, subject, html });
  return true;
}

async function sendInvitation({ email, link, organizationName, roleName, locale = 'en' }) {
  const t = translator(locale);
  return send({
    to: email,
    subject: t('mail.invite_subject', { org: organizationName }),
    html: layout({ locale, title: t('mail.invite_subject', { org: organizationName }), body: t('mail.invite_body', { org: organizationName, role: roleName }), cta: t('auth.invite_join'), href: link }),
  });
}

async function sendNotificationEmails(organizationId, userIds, type, data, link) {
  const users = await knex('users').whereIn('id', userIds).where({ status: 'active' }).select('email', 'locale');
  for (const u of users) {
    const t = translator(u.locale);
    const text = t(`notif.${type}`, data);
    await send({
      to: u.email,
      subject: `RemoteWay — ${text}`,
      html: layout({ locale: u.locale, title: text, body: t('mail.notification_body'), cta: t('mail.open'), href: link ? `${config.appUrl}${link}` : config.appUrl }),
    });
  }
}

module.exports = { enabled, send, sendInvitation, sendNotificationEmails };

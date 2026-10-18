// Sends email. Two providers, picked by environment variables (never put keys or passwords in code):
//
//  A) Gmail, free, no domain needed:
//   GMAIL_USER          the Gmail address to send from, e.g. adunachatapp@gmail.com
//   GMAIL_APP_PASSWORD  a Google "app password" (Google Account > Security > 2-Step Verification > App passwords)
//                       Limit: about 500 emails a day.
//
//  B) Resend (used when the Gmail variables are not set):
//   RESEND_API_KEY  your Resend API key. Without it, email verification is switched off.
//   EMAIL_FROM      sender, e.g. "Aduna <noreply@yourdomain.com>". Defaults to Resend's test sender
//                   onboarding@resend.dev, which can ONLY deliver to the email of your own Resend account.
//                   To email real users, verify a domain in Resend and use an address on it.
const useGmail = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const enabled = () => useGmail() || !!process.env.RESEND_API_KEY;
const from = () => process.env.EMAIL_FROM || (useGmail() ? `Aduna <${process.env.GMAIL_USER}>` : 'Aduna <onboarding@resend.dev>');

let client = null, smtp = null;
const outbox = []; // tests (NODE_ENV=test) read sent mail here instead of calling Resend

async function send({ to, subject, html, text }) {
  if (process.env.NODE_ENV === 'test') { outbox.push({ to, subject, html, text }); return; }
  if (useGmail()) {
    if (!smtp) smtp = require('nodemailer').createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '') } });
    await smtp.sendMail({ from: from(), to, subject, html, text });
    return;
  }
  if (!client) { const { Resend } = require('resend'); client = new Resend(process.env.RESEND_API_KEY); }
  const { error } = await client.emails.send({ from: from(), to, subject, html, text });
  if (error) throw new Error(error.message || 'Email could not be sent');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sendVerificationCode(to, code, username) {
  return send({
    to,
    subject: `${code} is your Aduna verification code`,
    text: `Hi ${username},\n\nYour Aduna verification code is ${code}. It expires in 15 minutes.\n\nIf you didn't create an Aduna account, you can ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px;color:#2a251e">
<h2 style="margin:0 0 12px">Verify your email</h2>
<p>Hi ${esc(username)}, enter this code in Aduna:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">${esc(code)}</p>
<p style="color:#6b6458">It expires in 15 minutes. If you didn't create an Aduna account, you can ignore this email.</p></div>`,
  });
}

module.exports = { enabled, sendVerificationCode, outbox };

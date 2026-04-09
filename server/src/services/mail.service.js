/**
 * Отправка писем (nodemailer + SMTP из config.mail)
 */

import nodemailer from 'nodemailer';
import config from '../config/index.js';
import logger from '../utils/logger.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Письмо с временным паролем после публичной регистрации аккаунта.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendNewAccountPassword({ to, fullName, accountName, password, loginUrl }) {
  const { mail } = config;
  if (!mail?.enabled) {
    logger.warn('[mail] SMTP не настроен — письмо с паролем не отправлено', { to, accountName });
    return { sent: false, reason: 'smtp_disabled' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth:
        mail.user && mail.pass
          ? {
              user: mail.user,
              pass: mail.pass,
            }
          : undefined,
    });

    const subject = `Доступ к личному кабинету: ${accountName}`;
    const greet = fullName ? `, ${fullName}` : '';
    const text =
      `Здравствуйте${greet}!\n\n` +
      `Создан личный кабинет «${accountName}».\n\n` +
      `Адрес входа: ${loginUrl}\n` +
      `Логин (email): ${to}\n` +
      `Временный пароль: ${password}\n\n` +
      `При первом входе в систему потребуется сменить пароль на новый.\n`;

    const html =
      `<p>Здравствуйте${fullName ? `, ${escapeHtml(fullName)}` : ''}!</p>` +
      `<p>Создан личный кабинет «<strong>${escapeHtml(accountName)}</strong>».</p>` +
      `<ul>` +
      `<li>Адрес входа: <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a></li>` +
      `<li>Логин (email): <strong>${escapeHtml(to)}</strong></li>` +
      `<li>Временный пароль: <strong>${escapeHtml(password)}</strong></li>` +
      `</ul>` +
      `<p>При первом входе в систему потребуется <strong>сменить пароль</strong> на новый.</p>`;

    await transporter.sendMail({
      from: mail.from,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка отправки письма регистрации', {
      error: err?.message,
      to,
    });
    return { sent: false, reason: 'send_failed' };
  }
}

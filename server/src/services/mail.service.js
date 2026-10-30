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

async function getTransporter() {
  const { mail } = config;
  if (!mail?.enabled) return null;
  return nodemailer.createTransport({
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
}

/**
 * Письмо клиенту: подписка активирована после оплаты / одобрения.
 */
export async function sendSubscriptionActivatedEmail({
  to,
  fullName,
  accountName,
  planName,
  periodLabel,
  endsAt,
  pricingUrl,
}) {
  const { mail } = config;
  if (!mail?.enabled) {
    logger.warn('[mail] SMTP не настроен — письмо об активации не отправлено', { to });
    return { sent: false, reason: 'smtp_disabled' };
  }
  try {
    const transporter = await getTransporter();
    if (!transporter) return { sent: false, reason: 'smtp_disabled' };
    const endLabel = endsAt
      ? new Date(endsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
      : '';
    const subject = `Тариф «${planName}» активирован`;
    const greet = fullName ? `, ${fullName}` : '';
    const text =
      `Здравствуйте${greet}!\n\n` +
      `Для аккаунта «${accountName || ''}» активирован тариф «${planName}»` +
      `${periodLabel ? ` (${periodLabel})` : ''}.\n` +
      `${endLabel ? `Действует до: ${endLabel}\n` : ''}` +
      `Управление подпиской: ${pricingUrl}\n`;
    const html =
      `<p>Здравствуйте${fullName ? `, ${escapeHtml(fullName)}` : ''}!</p>` +
      `<p>Для аккаунта «<strong>${escapeHtml(accountName || '')}</strong>» активирован тариф ` +
      `«<strong>${escapeHtml(planName || '')}</strong>»` +
      `${periodLabel ? ` (${escapeHtml(periodLabel)})` : ''}.</p>` +
      `${endLabel ? `<p>Действует до: <strong>${escapeHtml(endLabel)}</strong></p>` : ''}` +
      `<p><a href="${escapeHtml(pricingUrl)}">Тарифы и подписка</a></p>`;
    await transporter.sendMail({ from: mail.from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка письма об активации', { error: err?.message, to });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Уведомление поддержке о новой заявке на тариф.
 */
export async function sendSubscriptionRequestAdminEmail({
  to,
  profileName,
  planName,
  periodLabel,
  amountRub,
  requester,
  comment,
}) {
  const { mail } = config;
  if (!mail?.enabled || !to) {
    return { sent: false, reason: !to ? 'no_recipient' : 'smtp_disabled' };
  }
  try {
    const transporter = await getTransporter();
    if (!transporter) return { sent: false, reason: 'smtp_disabled' };
    const subject = `Заявка на тариф: ${profileName || ''} → ${planName}`;
    const amount =
      amountRub != null ? `${Number(amountRub).toLocaleString('ru-RU')} ₽` : '—';
    const text =
      `Новая заявка на тариф\n` +
      `Аккаунт: ${profileName}\n` +
      `Тариф: ${planName} (${periodLabel})\n` +
      `Сумма: ${amount}\n` +
      `Заявитель: ${requester || '—'}\n` +
      `Комментарий: ${comment || '—'}\n`;
    await transporter.sendMail({
      from: mail.from,
      to,
      subject,
      text,
      html: `<pre style="font-family:inherit">${escapeHtml(text)}</pre>`,
    });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка письма админу о заявке', { error: err?.message, to });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Напоминание об окончании оплаченной подписки.
 */
export async function sendSubscriptionEndingEmail({
  to,
  fullName,
  accountName,
  endsAt,
  pricingUrl,
}) {
  const { mail } = config;
  if (!mail?.enabled) {
    return { sent: false, reason: 'smtp_disabled' };
  }
  try {
    const transporter = await getTransporter();
    if (!transporter) return { sent: false, reason: 'smtp_disabled' };
    const endLabel = endsAt
      ? new Date(endsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
      : '';
    const subject = `Подписка заканчивается${accountName ? `: ${accountName}` : ''}`;
    const greet = fullName ? `, ${fullName}` : '';
    const text =
      `Здравствуйте${greet}!\n\n` +
      `Оплаченный период аккаунта «${accountName || ''}» заканчивается${endLabel ? ` ${endLabel}` : ''}.\n` +
      `Продлите тариф: ${pricingUrl}\n`;
    const html =
      `<p>Здравствуйте${fullName ? `, ${escapeHtml(fullName)}` : ''}!</p>` +
      `<p>Оплаченный период аккаунта «<strong>${escapeHtml(accountName || '')}</strong>» ` +
      `заканчивается${endLabel ? ` <strong>${escapeHtml(endLabel)}</strong>` : ''}.</p>` +
      `<p><a href="${escapeHtml(pricingUrl)}">Продлить тариф</a></p>`;
    await transporter.sendMail({ from: mail.from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка письма о конце подписки', { error: err?.message, to });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Напоминание об окончании пробного периода.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendTrialEndingEmail({ to, fullName, accountName, trialEndsAt, pricingUrl }) {
  const { mail } = config;
  if (!mail?.enabled) {
    logger.warn('[mail] SMTP не настроен — письмо о trial не отправлено', { to });
    return { sent: false, reason: 'smtp_disabled' };
  }
  try {
    const transporter = await getTransporter();
    if (!transporter) return { sent: false, reason: 'smtp_disabled' };
    const endLabel = trialEndsAt
      ? new Date(trialEndsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
      : '';
    const subject = `Пробный период заканчивается${accountName ? `: ${accountName}` : ''}`;
    const greet = fullName ? `, ${fullName}` : '';
    const text =
      `Здравствуйте${greet}!\n\n` +
      `Пробный период аккаунта «${accountName || ''}» заканчивается${endLabel ? ` ${endLabel}` : ''}.\n` +
      `Выберите тариф и оставьте заявку: ${pricingUrl}\n`;
    const html =
      `<p>Здравствуйте${fullName ? `, ${escapeHtml(fullName)}` : ''}!</p>` +
      `<p>Пробный период аккаунта «<strong>${escapeHtml(accountName || '')}</strong>» ` +
      `заканчивается${endLabel ? ` <strong>${escapeHtml(endLabel)}</strong>` : ''}.</p>` +
      `<p><a href="${escapeHtml(pricingUrl)}">Выбрать тариф</a></p>`;
    await transporter.sendMail({ from: mail.from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка отправки письма о trial', { error: err?.message, to });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Письмо со ссылкой сброса пароля.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendPasswordResetEmail({ to, fullName, resetUrl }) {
  const { mail } = config;
  if (!mail?.enabled) {
    logger.warn('[mail] SMTP не настроен — письмо сброса пароля не отправлено', { to });
    return { sent: false, reason: 'smtp_disabled' };
  }

  try {
    const transporter = await getTransporter();
    if (!transporter) return { sent: false, reason: 'smtp_disabled' };

    const subject = 'Восстановление пароля';
    const greet = fullName ? `, ${fullName}` : '';
    const text =
      `Здравствуйте${greet}!\n\n` +
      `Вы запросили сброс пароля. Перейдите по ссылке (действует 1 час):\n${resetUrl}\n\n` +
      `Если вы не запрашивали сброс — просто проигнорируйте это письмо.\n`;
    const html =
      `<p>Здравствуйте${fullName ? `, ${escapeHtml(fullName)}` : ''}!</p>` +
      `<p>Вы запросили сброс пароля. Ссылка действует <strong>1 час</strong>:</p>` +
      `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>` +
      `<p>Если вы не запрашивали сброс — просто проигнорируйте это письмо.</p>`;

    await transporter.sendMail({
      from: mail.from,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    logger.error('[mail] Ошибка отправки письма сброса пароля', {
      error: err?.message,
      to,
    });
    return { sent: false, reason: 'send_failed' };
  }
}

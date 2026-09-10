/**
 * Уведомления о приближающемся дне рождения сотрудников.
 * Раз в сутки: если до ДР ровно BIRTHDAY_NOTIFY_DAYS_BEFORE дней — пишем runtime-уведомление
 * получателям из profile.notification_settings.channels.employee_birthday_soon.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  BIRTHDAY_NOTIFY_DAYS_BEFORE,
  parseNotificationSettings,
  resolveRecipientUserIds,
} from '../utils/notificationSettings.js';
import {
  addRuntimeNotification,
  getRuntimeNotifications,
} from '../utils/runtime-notifications.js';
import { formatBirthDate } from '../utils/userBirthDate.js';

function moscowYmd(date = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const [y, m, d] = String(s).split('-').map(Number);
  return { y, m, d };
}

function addCalendarDays({ y, m, d }, days) {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

function mmdd({ m, d }) {
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function displayName(u) {
  const parts = [u.last_name, u.first_name, u.middle_name]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);
  if (parts.length) return parts.join(' ');
  const full = String(u.full_name || '').trim();
  if (full) return full;
  return String(u.email || u.phone || `Пользователь #${u.id}`).trim();
}

function formatRuDayMonth(birthYmd) {
  const s = formatBirthDate(birthYmd);
  if (!s) return '';
  const [, m, d] = s.split('-').map(Number);
  if (!m || !d) return '';
  try {
    return new Date(Date.UTC(2000, m - 1, d)).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });
  } catch {
    return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
  }
}

function notificationId(profileId, employeeId, year, recipientId) {
  return `birthday_${profileId}_${employeeId}_${year}_${recipientId}`;
}

async function existingIds(profileId) {
  const all = await getRuntimeNotifications({ profileId });
  return new Set((all || []).map((n) => String(n.id || '')));
}

async function allProfileUserIds(profileId) {
  const res = await query(`SELECT id FROM users WHERE profile_id = $1`, [profileId]);
  return (res.rows || [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function runBirthdayNotificationsForAllProfiles() {
  const today = moscowYmd();
  const target = addCalendarDays(today, BIRTHDAY_NOTIFY_DAYS_BEFORE);
  const targetMmDd = mmdd(target);
  const year = today.y;

  const profilesRes = await query(
    `SELECT id, notification_settings FROM profiles ORDER BY id ASC`
  );
  const profiles = profilesRes.rows || [];
  let profilesChecked = 0;
  let birthdaysFound = 0;
  let notificationsCreated = 0;
  let skippedExisting = 0;

  for (const row of profiles) {
    const profileId = Number(row.id);
    if (!Number.isFinite(profileId) || profileId <= 0) continue;
    const settings = parseNotificationSettings(row.notification_settings);
    const resolved = resolveRecipientUserIds(settings, 'employee_birthday_soon');
    if (Array.isArray(resolved) && !resolved.length) continue;

    const recipientIds =
      resolved == null ? await allProfileUserIds(profileId) : resolved.map(Number);
    if (!recipientIds.length) continue;
    profilesChecked += 1;

    const usersRes = await query(
      `SELECT id, email, phone, full_name, last_name, first_name, middle_name, birth_date::text AS birth_date
       FROM users
       WHERE profile_id = $1
         AND birth_date IS NOT NULL
         AND to_char(birth_date, 'MM-DD') = $2`,
      [profileId, targetMmDd]
    );
    const employees = usersRes.rows || [];
    if (!employees.length) continue;

    const have = await existingIds(profileId);
    const recipientSet = new Set(recipientIds.map(Number));

    for (const emp of employees) {
      birthdaysFound += 1;
      const empId = Number(emp.id);
      const name = displayName(emp);
      const whenLabel = formatRuDayMonth(emp.birth_date);
      const title = 'Скоро день рождения';
      const message = whenLabel
        ? `Через ${BIRTHDAY_NOTIFY_DAYS_BEFORE} дн. день рождения: ${name} (${whenLabel}).`
        : `Через ${BIRTHDAY_NOTIFY_DAYS_BEFORE} дн. день рождения: ${name}.`;

      for (const recipientId of recipientSet) {
        if (!Number.isFinite(recipientId) || recipientId <= 0) continue;
        const id = notificationId(profileId, empId, year, recipientId);
        if (have.has(id)) {
          skippedExisting += 1;
          continue;
        }
        const created = await addRuntimeNotification({
          id,
          type: 'employee_birthday_soon',
          severity: 'info',
          source: 'birthday-notifications',
          profileId,
          title,
          message,
          meta: {
            target_user_id: recipientId,
            employee_user_id: empId,
            employee_name: name,
            birth_date: formatBirthDate(emp.birth_date),
            days_before: BIRTHDAY_NOTIFY_DAYS_BEFORE,
            url: '/settings/users',
          },
        });
        if (created) {
          notificationsCreated += 1;
          have.add(id);
        }
      }
    }
  }

  const summary = {
    targetMmDd,
    daysBefore: BIRTHDAY_NOTIFY_DAYS_BEFORE,
    profilesChecked,
    birthdaysFound,
    notificationsCreated,
    skippedExisting,
  };
  if (birthdaysFound > 0 || notificationsCreated > 0) {
    logger.info('[BirthdayNotifications] done', summary);
  }
  return summary;
}

export default {
  runBirthdayNotificationsForAllProfiles,
};

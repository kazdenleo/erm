/**
 * Auth Middleware
 * Проверка JWT и ролей
 */

import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { query } from '../config/database.js';
import { profileIdFromDb } from '../utils/profileId.js';

function normalizeAccountRole(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return s || null;
}

function isAccountAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.is_profile_admin === true || user.isProfileAdmin === true) return true;
  return normalizeAccountRole(user.account_role ?? user.accountRole ?? null) === 'admin';
}

/**
 * Опциональная авторизация: если передан валидный Bearer token — заполняет req.user
 */
export async function optionalAuth(req, res, next) {
  // Dev mode: полностью отключаем авторизацию (чтобы не вводить логин/пароль).
  // В этом режиме притворяемся первым пользователем из БД (или admin-заглушкой).
  if (config.auth?.disabled) {
    try {
      const result = await query(
        `SELECT id, email, full_name, last_name, first_name, middle_name, role, profile_id, is_profile_admin, account_role,
                COALESCE(must_change_password, false) AS must_change_password, created_at
         FROM users ORDER BY id ASC LIMIT 1`
      );
      const user = result.rows[0];
      if (user) {
        req.user = {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          lastName: user.last_name ?? null,
          firstName: user.first_name ?? null,
          middleName: user.middle_name ?? null,
          role: user.role,
          profileId: profileIdFromDb(user.profile_id),
          isProfileAdmin: isAccountAdminUser(user),
          accountRole: user.account_role ?? null,
          mustChangePassword: !!(user.must_change_password === true || user.must_change_password === 1),
        };
        return next();
      }
    } catch (_) {
      // ignore and fall back
    }
    req.user = {
      id: 0,
      email: 'dev@local',
      fullName: 'Dev',
      role: 'admin',
      profileId: null,
      isProfileAdmin: true,
      mustChangePassword: false,
    };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch {
    req.user = null;
    return next();
  }
  try {
    const result = await query(
      `SELECT id, email, full_name, last_name, first_name, middle_name, role, profile_id, is_profile_admin, account_role,
              COALESCE(must_change_password, false) AS must_change_password, created_at
       FROM users WHERE id = $1`,
      [decoded.userId]
    );
    const user = result.rows[0];
    if (!user) {
      req.user = null;
      return next();
    }
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      lastName: user.last_name ?? null,
      firstName: user.first_name ?? null,
      middleName: user.middle_name ?? null,
      role: user.role,
      profileId: profileIdFromDb(user.profile_id),
      isProfileAdmin: isAccountAdminUser(user),
      accountRole: user.account_role ?? null,
      mustChangePassword: !!(user.must_change_password === true || user.must_change_password === 1),
    };
    next();
  } catch (err) {
    // Сбой БД не должен маскироваться под «нет сессии» (401) и выкидывать пользователя из приложения.
    next(err);
  }
}

/**
 * Обязательная авторизация: 401 если нет валидного пользователя
 */
export function requireAuth(req, res, next) {
  if (config.auth?.disabled) return next();
  if (!req.user) {
    return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
  }
  next();
}

/**
 * Только для администратора: 403 если не admin
 */
export function requireAdmin(req, res, next) {
  if (config.auth?.disabled) return next();
  if (!req.user) {
    return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Доступ только для администратора' });
  }
  next();
}

/** Для операций внутри аккаунта (профиля): у пользователя должен быть profile_id */
export function requireProfile(req, res, next) {
  if (config.auth?.disabled) return next();
  if (!req.user) {
    return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
  }
  if (req.user.profileId == null || req.user.profileId === '') {
    return res.status(403).json({ ok: false, message: 'Действие доступно только пользователям с привязкой к аккаунту (профилю)' });
  }
  next();
}

/** Только администратор аккаунта (управление своим профилем и пользователями профиля) */
export function requireProfileAdmin(req, res, next) {
  if (config.auth?.disabled) return next();
  if (!req.user) {
    return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
  }
  const accountRole = normalizeAccountRole(req.user.accountRole ?? req.user.account_role ?? null);
  const isAccountAdmin = req.user.role === 'admin' || !!req.user.isProfileAdmin || accountRole === 'admin';
  if (!isAccountAdmin) {
    return res.status(403).json({ ok: false, message: 'Доступ только для администратора аккаунта' });
  }
  next();
}

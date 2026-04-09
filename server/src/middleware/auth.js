/**
 * Auth Middleware
 * Проверка JWT и ролей
 */

import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { query } from '../config/database.js';
import { profileIdFromDb } from '../utils/profileId.js';

/**
 * Опциональная авторизация: если передан валидный Bearer token — заполняет req.user
 */
export async function optionalAuth(req, res, next) {
  // Dev mode: полностью отключаем авторизацию (чтобы не вводить логин/пароль).
  // В этом режиме притворяемся первым пользователем из БД (или admin-заглушкой).
  if (config.auth?.disabled) {
    try {
      const result = await query(
        `SELECT id, email, full_name, role, profile_id, is_profile_admin,
                COALESCE(must_change_password, false) AS must_change_password, created_at
         FROM users ORDER BY id ASC LIMIT 1`
      );
      const user = result.rows[0];
      if (user) {
        req.user = {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          profileId: profileIdFromDb(user.profile_id),
          isProfileAdmin: !!user.is_profile_admin,
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
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const result = await query(
      `SELECT id, email, full_name, role, profile_id, is_profile_admin,
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
      role: user.role,
      profileId: profileIdFromDb(user.profile_id),
      isProfileAdmin: !!user.is_profile_admin,
      mustChangePassword: !!(user.must_change_password === true || user.must_change_password === 1),
    };
    next();
  } catch {
    req.user = null;
    next();
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
  if (!req.user.isProfileAdmin) {
    return res.status(403).json({ ok: false, message: 'Доступ только для администратора аккаунта' });
  }
  next();
}

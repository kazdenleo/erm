/**
 * Auth Controller
 * Вход, регистрация аккаунта, текущий пользователь, смена пароля
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import config from '../config/index.js';
import repositoryFactory from '../config/repository-factory.js';
import { profileIdFromDb } from '../utils/profileId.js';
import { resolveEffectiveProfileId } from '../utils/effectiveProfile.js';
import { transaction } from '../config/database.js';
import { sendNewAccountPassword } from '../services/mail.service.js';
import { buildFullName, splitFullName } from '../utils/userName.js';

const usersRepo = repositoryFactory.getUsersRepository();
const profilesRepo = repositoryFactory.getProfilesRepository();

function userMustChangePassword(row) {
  return !!(row && (row.must_change_password === true || row.must_change_password === 1));
}

export const authController = {
  /**
   * Публичная регистрация: новый профиль + первый администратор аккаунта.
   * Пароль генерируется и отправляется на email (SMTP обязателен).
   */
  async registerAccount(req, res, next) {
    try {
      if (!config.database.usePostgreSQL) {
        return res.status(503).json({
          ok: false,
          message: 'Регистрация доступна только при использовании PostgreSQL.',
        });
      }

      const { accountName, email, phone, fullName } = req.body || {};
      const name = String(accountName || '').trim();
      const em = String(email || '').trim().toLowerCase();
      const ph = phone != null ? String(phone).trim() : '';
      const fn = String(fullName || '').trim();
      const names = splitFullName(fn);

      if (name.length < 2) {
        return res.status(400).json({ ok: false, message: 'Укажите название аккаунта' });
      }
      if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return res.status(400).json({ ok: false, message: 'Укажите корректный email' });
      }
      if (fn.length < 2) {
        return res.status(400).json({ ok: false, message: 'Укажите ФИО' });
      }

      const existing = await usersRepo.findByEmail(em);
      if (existing) {
        return res.status(400).json({ ok: false, message: 'Пользователь с таким email уже зарегистрирован' });
      }

      const plainPassword = crypto.randomBytes(18).toString('base64url');
      const passwordHash = await bcrypt.hash(plainPassword, 10);

      let profileId;
      let userId;
      try {
        const ids = await transaction(async (client) => {
          const pr = await client.query(
            `INSERT INTO profiles (name, contact_full_name, contact_email, contact_phone, tariff)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [name, fn, em, ph || null, null]
          );
          const pid = pr.rows[0].id;
          const ur = await client.query(
            `INSERT INTO users (email, password_hash, full_name, last_name, first_name, middle_name, phone, role, profile_id, is_profile_admin, must_change_password)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8, true, true)
             RETURNING id`,
            [em, passwordHash, buildFullName(names), names.lastName, names.firstName, names.middleName, ph || null, pid]
          );
          return { profileId: pid, userId: ur.rows[0].id };
        });
        profileId = ids.profileId;
        userId = ids.userId;
      } catch (e) {
        if (e.code === '23505') {
          return res.status(400).json({ ok: false, message: 'Пользователь с таким email уже зарегистрирован' });
        }
        throw e;
      }

      const loginUrl = `${String(config.clientUrl || '').replace(/\/$/, '')}/login`;
      const mailResult = await sendNewAccountPassword({
        to: em,
        fullName: fn,
        accountName: name,
        password: plainPassword,
        loginUrl,
      });

      if (!mailResult.sent) {
        try {
          await usersRepo.delete(userId);
          await profilesRepo.delete(profileId);
        } catch (_) {
          /* cleanup best effort */
        }
        if (mailResult.reason === 'smtp_disabled') {
          return res.status(503).json({
            ok: false,
            message:
              'Отправка почты не настроена. Задайте SMTP_HOST и MAIL_FROM в настройках сервера (и при необходимости SMTP_USER, SMTP_PASS).',
          });
        }
        return res.status(503).json({
          ok: false,
          message: 'Не удалось отправить письмо с паролём. Попробуйте позже или обратитесь в поддержку.',
        });
      }

      res.status(201).json({
        ok: true,
        message:
          'На указанный email отправлен временный пароль. Войдите в систему и смените пароль при первом входе.',
      });
    } catch (error) {
      next(error);
    }
  },

  async login(req, res, next) {
    try {
      const { email, password } = req.body || {};
      const emailTrim = String(email || '').trim();
      if (!emailTrim || !password) {
        return res.status(400).json({ ok: false, message: 'Укажите email и пароль' });
      }
      const user = await usersRepo.findByEmail(emailTrim);
      if (!user) {
        return res.status(401).json({ ok: false, message: 'Неверный email или пароль' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ ok: false, message: 'Неверный email или пароль' });
      }
      const token = jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
      res.json({
        ok: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.full_name,
            lastName: user.last_name ?? null,
            firstName: user.first_name ?? null,
            middleName: user.middle_name ?? null,
            role: user.role,
            profileId: profileIdFromDb(user.profile_id),
            isProfileAdmin: !!user.is_profile_admin,
            accountRole: user.account_role ?? null,
            mustChangePassword: userMustChangePassword(user),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async changePassword(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
      }
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ ok: false, message: 'Укажите текущий и новый пароль' });
      }
      const np = String(newPassword);
      if (np.length < 8) {
        return res.status(400).json({ ok: false, message: 'Новый пароль: не менее 8 символов' });
      }
      const row = await usersRepo.findByEmail(req.user.email);
      if (!row?.password_hash) {
        return res.status(400).json({ ok: false, message: 'Операция недоступна' });
      }
      const match = await bcrypt.compare(String(currentPassword), row.password_hash);
      if (!match) {
        return res.status(400).json({ ok: false, message: 'Неверный текущий пароль' });
      }
      const password_hash = await bcrypt.hash(np, 10);
      await usersRepo.update(row.id, { password_hash, must_change_password: false });
      res.json({ ok: true, message: 'Пароль изменён' });
    } catch (error) {
      next(error);
    }
  },

  async me(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
      }
      const user = await usersRepo.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ ok: false, message: 'Пользователь не найден' });
      }
      let profileId = profileIdFromDb(user.profile_id);
      if (profileId == null) {
        profileId = await resolveEffectiveProfileId(req, user);
      }
      let profile = null;
      if (profileId) {
        const profilesRepository = (await import('../config/repository-factory.js')).default.getProfilesRepository();
        profile = await profilesRepository.findById(profileId);
      }
      res.json({
        ok: true,
        data: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          lastName: user.last_name ?? null,
          firstName: user.first_name ?? null,
          middleName: user.middle_name ?? null,
          phone: user.phone ?? null,
          role: user.role,
          profileId,
          isProfileAdmin: !!user.is_profile_admin,
          accountRole: user.account_role ?? null,
          mustChangePassword: userMustChangePassword(user),
          profile: profile
            ? {
                id: profile.id,
                name: profile.name,
                contact_full_name: profile.contact_full_name ?? null,
                contact_email: profile.contact_email ?? null,
                contact_phone: profile.contact_phone ?? null,
                tariff: profile.tariff ?? null,
              }
            : null,
          features: {},
          limits: {},
        },
      });
    } catch (error) {
      next(error);
    }
  },
};

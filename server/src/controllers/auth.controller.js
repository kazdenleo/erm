/**
 * Auth Controller
 * Вход, регистрация аккаунта, текущий пользователь, смена пароля
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import config from '../config/index.js';
import repositoryFactory from '../config/repository-factory.js';
import { profileIdFromDb } from '../utils/profileId.js';
import { resolveEffectiveProfileId } from '../utils/effectiveProfile.js';
import { query, transaction } from '../config/database.js';
import { buildFullName, splitFullName } from '../utils/userName.js';
import { buildUserNavFeatures, resolveDailyLogoutForUser, resolveNavSectionsForUser } from '../utils/userNavSections.js';
import { ensurePhoneAvailable, requirePhoneFields } from '../utils/userPhone.js';
import { parseBirthDate } from '../utils/userBirthDate.js';
import { ensureEmailAvailable, parseOptionalEmail } from '../utils/userEmail.js';
import { sendPasswordResetEmail } from '../services/mail.service.js';
import logger from '../utils/logger.js';

const usersRepo = repositoryFactory.getUsersRepository();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const FORGOT_GENERIC_OK =
  'Если аккаунт найден и у него указан email — мы отправили ссылку для сброса пароля. Проверьте почту.';

function hashResetToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function clientBaseUrl() {
  return String(config.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function userMustChangePassword(row) {
  return !!(row && (row.must_change_password === true || row.must_change_password === 1));
}

/** Календарный день YYYY-M-D в локальной TZ сервера (для daily logout). */
function calendarDayKey(msOrSec) {
  const ms = msOrSec < 1e12 ? Number(msOrSec) * 1000 : Number(msOrSec);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function tokenIssuedDayKey(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.decode(authHeader.slice(7));
    if (!decoded?.iat) return null;
    return calendarDayKey(decoded.iat);
  } catch {
    return null;
  }
}

export const authController = {
  /**
   * Публичная регистрация: новый профиль + первый администратор аккаунта.
   * Вход по телефону; email необязателен. Пароль задаёт пользователь.
   */
  async registerAccount(req, res, next) {
    try {
      if (!config.database.usePostgreSQL) {
        return res.status(503).json({
          ok: false,
          message: 'Регистрация доступна только при использовании PostgreSQL.',
        });
      }

      const { accountName, email, phone, fullName, password, birthDate, birth_date: birthDateSnake } = req.body || {};
      const name = String(accountName || '').trim();
      const emailParsed = parseOptionalEmail(email);
      if (emailParsed.error) {
        return res.status(400).json({ ok: false, message: emailParsed.error });
      }
      const phoneFields = requirePhoneFields(phone);
      if (phoneFields.error) {
        return res.status(400).json({ ok: false, message: phoneFields.error });
      }
      const birthParsed = parseBirthDate(birthDate ?? birthDateSnake);
      if (birthParsed.error) {
        return res.status(400).json({ ok: false, message: birthParsed.error });
      }
      const fn = String(fullName || '').trim();
      const names = splitFullName(fn);
      const plainPassword = String(password || '');

      if (name.length < 2) {
        return res.status(400).json({ ok: false, message: 'Укажите название аккаунта' });
      }
      if (fn.length < 2) {
        return res.status(400).json({ ok: false, message: 'Укажите ФИО' });
      }
      if (plainPassword.length < 8) {
        return res.status(400).json({ ok: false, message: 'Пароль: не менее 8 символов' });
      }

      try {
        await ensurePhoneAvailable(usersRepo, phoneFields.phone_normalized);
        await ensureEmailAvailable(usersRepo, emailParsed.value);
      } catch (e) {
        return res.status(400).json({ ok: false, message: e.message });
      }

      const passwordHash = await bcrypt.hash(plainPassword, 10);
      const { newAccountTrialFields } = await import('../utils/profileSubscription.js');
      const trial = newAccountTrialFields();

      try {
        await transaction(async (client) => {
          const pr = await client.query(
            `INSERT INTO profiles (
               name, contact_full_name, contact_email, contact_phone, tariff,
               subscription_status, plan_code, trial_ends_at, subscription_ends_at,
               kits_enabled, production_enabled, fbo_enabled, pricing_strategies_enabled
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING id`,
            [
              name,
              fn,
              emailParsed.value,
              phoneFields.phone,
              trial.tariff,
              trial.subscription_status,
              trial.plan_code,
              trial.trial_ends_at,
              trial.subscription_ends_at,
              trial.kits_enabled,
              trial.production_enabled,
              trial.fbo_enabled,
              trial.pricing_strategies_enabled,
            ]
          );
          const pid = pr.rows[0].id;
          await client.query(
            `INSERT INTO users (email, password_hash, full_name, last_name, first_name, middle_name, phone, phone_normalized, birth_date, role, profile_id, is_profile_admin, must_change_password)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'user', $10, true, false)
             RETURNING id`,
            [
              emailParsed.value,
              passwordHash,
              buildFullName(names),
              names.lastName,
              names.firstName,
              names.middleName,
              phoneFields.phone,
              phoneFields.phone_normalized,
              birthParsed.value,
              pid,
            ]
          );
          return { profileId: pid };
        });
      } catch (e) {
        if (e.code === '23505') {
          const detail = String(e.detail || e.constraint || '');
          if (/phone/i.test(detail)) {
            return res.status(400).json({
              ok: false,
              message: 'Пользователь с таким телефоном уже зарегистрирован',
            });
          }
          return res.status(400).json({ ok: false, message: 'Пользователь с таким email уже зарегистрирован' });
        }
        throw e;
      }

      res.status(201).json({
        ok: true,
        message:
          'Аккаунт создан. Вам доступен пробный период 7 дней. Войдите по телефону или email и паролю.',
        trialDays: 7,
      });
    } catch (error) {
      next(error);
    }
  },

  async login(req, res, next) {
    try {
      const { email, password, login, phone } = req.body || {};
      const loginTrim = String(login || email || phone || '').trim();
      if (!loginTrim || !password) {
        return res.status(400).json({ ok: false, message: 'Укажите email или телефон и пароль' });
      }
      const user = await usersRepo.findByLogin(loginTrim);
      if (!user) {
        return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
      }
      const token = jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
      res.json({
        ok: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            phone: user.phone ?? null,
            birthDate: user.birth_date ?? null,
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
      const row = await usersRepo.findAuthById(req.user.id);
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

  /**
   * Публичный запрос ссылки сброса пароля (email или телефон).
   * Ответ всегда одинаковый — без enumeration.
   */
  async forgotPassword(req, res, next) {
    try {
      if (!config.database.usePostgreSQL) {
        return res.status(503).json({ ok: false, message: 'Восстановление пароля недоступно' });
      }
      const login = String(req.body?.login || req.body?.email || '').trim();
      if (!login) {
        return res.status(400).json({ ok: false, message: 'Укажите email или телефон' });
      }

      const user = await usersRepo.findByLogin(login);
      if (user?.id && user.email) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        await query(
          `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
          [user.id]
        );
        await query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [user.id, tokenHash, expiresAt.toISOString()]
        );
        const resetUrl = `${clientBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
        const mailResult = await sendPasswordResetEmail({
          to: user.email,
          fullName: user.full_name || user.fullName || '',
          resetUrl,
        });
        if (!mailResult.sent) {
          logger.warn('[auth] forgot-password: письмо не отправлено', {
            userId: user.id,
            reason: mailResult.reason,
          });
        }
      } else if (user?.id && !user.email) {
        logger.info('[auth] forgot-password: у пользователя нет email', { userId: user.id });
      }

      return res.status(200).json({ ok: true, message: FORGOT_GENERIC_OK });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Установка нового пароля по одноразовому токену из письма.
   */
  async resetPassword(req, res, next) {
    try {
      if (!config.database.usePostgreSQL) {
        return res.status(503).json({ ok: false, message: 'Восстановление пароля недоступно' });
      }
      const rawToken = String(req.body?.token || '').trim();
      const newPassword = String(req.body?.newPassword || req.body?.password || '');
      if (!rawToken || rawToken.length < 32) {
        return res.status(400).json({ ok: false, message: 'Некорректная или устаревшая ссылка' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ ok: false, message: 'Новый пароль: не менее 8 символов' });
      }

      const tokenHash = hashResetToken(rawToken);
      const found = await query(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
         LIMIT 1`,
        [tokenHash]
      );
      const row = found.rows[0];
      if (!row) {
        return res.status(400).json({
          ok: false,
          message: 'Ссылка недействительна или истекла. Запросите восстановление снова.',
        });
      }

      const password_hash = await bcrypt.hash(newPassword, 10);
      await transaction(async (client) => {
        await client.query(
          `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [password_hash, row.user_id]
        );
        await client.query(
          `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [row.id]
        );
        await client.query(
          `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND used_at IS NULL AND id <> $2`,
          [row.user_id, row.id]
        );
      });

      return res.status(200).json({ ok: true, message: 'Пароль обновлён. Можно войти с новым паролем.' });
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
      const dailyLogout = resolveDailyLogoutForUser(user, profile);
      if (dailyLogout) {
        const issuedDay = tokenIssuedDayKey(req);
        const today = calendarDayKey(Date.now());
        if (issuedDay && today && issuedDay !== today) {
          return res.status(401).json({
            ok: false,
            message: 'Сессия истекла: требуется повторный вход в новый день',
            code: 'DAILY_LOGOUT',
          });
        }
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
          birthDate: user.birth_date ?? null,
          role: user.role,
          profileId,
          isProfileAdmin: !!user.is_profile_admin,
          accountRole: user.account_role ?? null,
          mustChangePassword: userMustChangePassword(user),
          dailyLogout,
          profile: profile
            ? {
                id: profile.id,
                name: profile.name,
                contact_full_name: profile.contact_full_name ?? null,
                contact_email: profile.contact_email ?? null,
                contact_phone: profile.contact_phone ?? null,
                tariff: profile.tariff ?? null,
                allow_private_orders: profile.allow_private_orders === true,
                require_reserved_stock_for_assembly:
                  profile.require_reserved_stock_for_assembly === true,
                auto_send_to_assembly_on_reserve:
                  profile.auto_send_to_assembly_on_reserve === true,
                allow_manual_warehouse_stock_edit:
                  profile.allow_manual_warehouse_stock_edit === true,
                allow_stock_history_reset: profile.allow_stock_history_reset === true,
                supplier_sync_enabled: profile.supplier_sync_enabled !== false,
                product_enrichment_enabled: profile.product_enrichment_enabled === true,
                procurement_status_enabled: profile.procurement_status_enabled !== false,
                kits_enabled: profile.kits_enabled !== false,
                production_enabled: profile.production_enabled !== false,
                allow_product_supplier_binding: profile.allow_product_supplier_binding === true,
                fbs_enabled: profile.fbs_enabled !== false,
                fbo_enabled: profile.fbo_enabled === true,
                fbo_deduction_warehouse_id:
                  profile.fbo_deduction_warehouse_id != null
                    ? Number(profile.fbo_deduction_warehouse_id)
                    : null,
                manual_orders_warehouse_id:
                  profile.manual_orders_warehouse_id != null
                    ? Number(profile.manual_orders_warehouse_id)
                    : null,
                display_length_unit:
                  String(profile.display_length_unit || 'mm').trim().toLowerCase() === 'cm'
                    ? 'cm'
                    : 'mm',
                display_weight_unit:
                  String(profile.display_weight_unit || 'g').trim().toLowerCase() === 'kg'
                    ? 'kg'
                    : 'g',
                packing_display_attribute_id:
                  profile.packing_display_attribute_id != null
                    ? Number(profile.packing_display_attribute_id)
                    : null,
                subscription: (
                  await import('../utils/profileSubscription.js')
                ).subscriptionPayloadForClient(profile),
                onboarding: {
                  completed: profile.onboarding_completed_at != null,
                  completedAt: profile.onboarding_completed_at
                    ? new Date(profile.onboarding_completed_at).toISOString()
                    : null,
                },
              }
            : null,
          features: buildUserNavFeatures(resolveNavSectionsForUser(user, profile)),
          limits: {},
          access: await (async () => {
            const { resolveUserAccessScope } = await import('../utils/userAccessScope.js');
            const scope = await resolveUserAccessScope({
              id: user.id,
              role: user.role,
              is_profile_admin: user.is_profile_admin,
              account_role: user.account_role,
            });
            return {
              organizationIds: scope.organizationIds,
              warehouseIds: scope.warehouseIds,
            };
          })(),
        },
      });
    } catch (error) {
      next(error);
    }
  },
};

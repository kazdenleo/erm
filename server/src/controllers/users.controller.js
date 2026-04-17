/**
 * Users Controller
 * Управление пользователями
 */

import bcrypt from 'bcrypt';
import repositoryFactory from '../config/repository-factory.js';
import { buildFullName, normalizeUserNameFields } from '../utils/userName.js';

const usersRepo = repositoryFactory.getUsersRepository();

const SALT_ROUNDS = 10;

const ACCOUNT_ROLES = new Set(['admin', 'picker', 'warehouse_manager', 'editor']);

function normalizeAccountRole(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  if (!s) return null;
  return ACCOUNT_ROLES.has(s) ? s : null;
}

function isAccountAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.isProfileAdmin) return true;
  const ar = user.accountRole ?? user.account_role ?? null;
  return ar === 'admin';
}

function safeUserRow(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

export const usersController = {
  /** Текущий пользователь (свой профиль) */
  async getMe(req, res, next) {
    try {
      const item = await usersRepo.findById(req.user.id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
      }
      res.json({ ok: true, data: safeUserRow(item) });
    } catch (error) {
      next(error);
    }
  },

  async updateMe(req, res, next) {
    try {
      const { fullName, phone } = req.body || {};
      const names = normalizeUserNameFields(req.body || {});
      const updates = {};
      if (
        fullName !== undefined ||
        names.lastName !== null ||
        names.firstName !== null ||
        names.middleName !== null ||
        req.body?.lastName !== undefined ||
        req.body?.firstName !== undefined ||
        req.body?.middleName !== undefined
      ) {
        updates.last_name = names.lastName;
        updates.first_name = names.firstName;
        updates.middle_name = names.middleName;
        updates.full_name = buildFullName(names);
      }
      if (phone !== undefined) {
        updates.phone = String(phone).trim() === '' ? null : String(phone).trim();
      }
      if (Object.keys(updates).length === 0) {
        const cur = await usersRepo.findById(req.user.id);
        return res.json({ ok: true, data: safeUserRow(cur) });
      }
      const item = await usersRepo.update(req.user.id, updates);
      res.json({ ok: true, data: safeUserRow(item) });
    } catch (error) {
      next(error);
    }
  },

  async getAll(req, res, next) {
    try {
      const canManage = isAccountAdmin(req.user);
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Управление пользователями доступно только администратору аккаунта или системы' });
      }
      const profileId = req.query.profile_id != null ? Number(req.query.profile_id) : undefined;
      if (req.user.role !== 'admin' && profileId != null && profileId !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к этому профилю' });
      }
      const filter = req.user.role === 'admin' ? { profileId } : { profileId: req.user.profileId };
      const list = await usersRepo.findAll(filter);
      res.json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const canManage = isAccountAdmin(req.user);
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Просмотр пользователя доступен только администратору профиля или системе' });
      }
      const { id } = req.params;
      const item = await usersRepo.findById(id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
      }
      if (req.user.role !== 'admin' && Number(item.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      if (req.user.role !== 'admin' && item.role === 'admin') {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const { password_hash, ...safe } = item;
      res.json({ ok: true, data: safe });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const canManage = isAccountAdmin(req.user);
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Добавлять пользователей может только администратор профиля или системы' });
      }
      const { email, password, phone, role = 'user', profileId, isProfileAdmin, accountRole } = req.body || {};
      const names = normalizeUserNameFields(req.body || {});
      const targetAccountRole = normalizeAccountRole(accountRole) || (isProfileAdmin ? 'admin' : 'editor');
      if (!email || !password) {
        return res.status(400).json({ ok: false, message: 'Укажите email (логин) и пароль' });
      }
      // Для администратора аккаунта (не system admin) запрещаем создавать system admin и выбирать profileId,
      // но безопасно игнорируем входящие поля (фронт/кэш мог присылать profileId по старой логике).
      const requestedRole = req.user.role === 'admin' ? role : 'user';
      const requestedProfileId = req.user.role === 'admin' ? profileId : undefined;
      const existing = await usersRepo.findByEmail(email);
      if (existing) {
        return res.status(400).json({ ok: false, message: 'Пользователь с таким email уже существует' });
      }
      let effectiveRole = req.user.role === 'admin' ? (requestedRole || 'user') : 'user';
      let effectiveProfileId =
        req.user.role === 'admin'
          ? (requestedProfileId != null && requestedProfileId !== '' ? Number(requestedProfileId) : null)
          : req.user.profileId;
      let effectiveIsProfileAdmin =
        req.user.role === 'admin'
          ? !!isProfileAdmin
          : req.user.isProfileAdmin
            ? !!isProfileAdmin
            : false;
      let effectiveAccountRole =
        effectiveRole === 'admin' ? null : targetAccountRole;
      if (effectiveRole === 'admin') {
        effectiveProfileId = null;
        effectiveIsProfileAdmin = false;
        effectiveAccountRole = null;
      } else if (effectiveProfileId != null && effectiveProfileId !== '') {
        effectiveRole = 'user';
      }
      if (effectiveRole !== 'admin') {
        // account_role governs tenant permissions; keep legacy flag in sync for now
        effectiveIsProfileAdmin = effectiveAccountRole === 'admin';
      }
      if (effectiveRole === 'admin' && effectiveProfileId != null) {
        return res.status(400).json({
          ok: false,
          message: 'Администратор системы не привязывается к аккаунту',
        });
      }
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const phoneTrim =
        phone != null && String(phone).trim() !== '' ? String(phone).trim() : null;
      const item = await usersRepo.create({
        email,
        passwordHash,
        fullName: buildFullName(names),
        lastName: names.lastName,
        firstName: names.firstName,
        middleName: names.middleName,
        phone: phoneTrim,
        role: effectiveRole,
        profileId: effectiveProfileId,
        isProfileAdmin: effectiveIsProfileAdmin,
        accountRole: effectiveAccountRole,
      });
      res.status(201).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const canManage = isAccountAdmin(req.user);
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Редактировать пользователей может только администратор профиля или системы' });
      }
      const { id } = req.params;
      const existing = await usersRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
      }
      if (req.user.role !== 'admin' && Number(existing.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      if (req.user.role !== 'admin' && existing.role === 'admin') {
        return res.status(403).json({ ok: false, message: 'Редактирование администратора системы недоступно' });
      }
      const updates = { ...req.body };
      delete updates.email;
      delete updates.id;
      if (
        updates.fullName !== undefined ||
        updates.lastName !== undefined ||
        updates.firstName !== undefined ||
        updates.middleName !== undefined
      ) {
        const names = normalizeUserNameFields(updates);
        updates.last_name = names.lastName;
        updates.first_name = names.firstName;
        updates.middle_name = names.middleName;
        updates.full_name = buildFullName(names);
        delete updates.fullName;
      }
      delete updates.lastName;
      delete updates.firstName;
      delete updates.middleName;
      if (updates.isProfileAdmin !== undefined) {
        updates.is_profile_admin = updates.isProfileAdmin;
        delete updates.isProfileAdmin;
      }
      if (updates.accountRole !== undefined && updates.account_role === undefined) {
        updates.account_role = normalizeAccountRole(updates.accountRole);
        delete updates.accountRole;
      }
      if (updates.password) {
        updates.password_hash = await bcrypt.hash(updates.password, SALT_ROUNDS);
        delete updates.password;
      }
      if (
        updates.is_profile_admin !== undefined &&
        req.user.role !== 'admin' &&
        !req.user.isProfileAdmin
      ) {
        delete updates.is_profile_admin;
      }
      if (
        updates.account_role !== undefined &&
        req.user.role !== 'admin' &&
        !req.user.isProfileAdmin
      ) {
        delete updates.account_role;
      }
      if (req.user.role !== 'admin') {
        delete updates.profile_id;
        if (updates.role !== undefined && updates.role !== 'user') {
          updates.role = 'user';
        }
      } else if (updates.profileId !== undefined && updates.profile_id === undefined) {
        updates.profile_id =
          updates.profileId === null || updates.profileId === '' ? null : Number(updates.profileId);
        delete updates.profileId;
      }

      if (req.user.role === 'admin') {
        const mergedRole = updates.role !== undefined ? updates.role : existing.role;
        const mergedProfileRaw =
          updates.profile_id !== undefined ? updates.profile_id : existing.profile_id;
        const mergedProfile =
          mergedProfileRaw === null || mergedProfileRaw === '' || mergedProfileRaw === undefined
            ? null
            : Number(mergedProfileRaw);

        if (mergedRole === 'admin' && mergedProfile != null) {
          return res.status(400).json({
            ok: false,
            message: 'Администратор системы не привязывается к аккаунту',
          });
        }
        if (mergedRole === 'admin') {
          updates.profile_id = null;
          updates.is_profile_admin = false;
          updates.account_role = null;
        } else if (mergedProfile != null) {
          updates.role = 'user';
        }
      }
      if (updates.account_role !== undefined && updates.is_profile_admin === undefined) {
        updates.is_profile_admin = updates.account_role === 'admin';
      }

      const item = await usersRepo.update(id, updates);
      res.json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const canManage = req.user.role === 'admin' || req.user.isProfileAdmin;
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Удалять пользователей может только администратор профиля или системы' });
      }
      const { id } = req.params;
      const existing = await usersRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
      }
      if (req.user.role !== 'admin' && Number(existing.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      if (req.user.role !== 'admin' && existing.role === 'admin') {
        return res.status(403).json({ ok: false, message: 'Удаление администратора системы недоступно' });
      }
      const deleted = await usersRepo.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
      }
      res.json({ ok: true, message: 'Пользователь удалён' });
    } catch (error) {
      next(error);
    }
  },
};

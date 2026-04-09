/**
 * Users Controller
 * Управление пользователями
 */

import bcrypt from 'bcrypt';
import repositoryFactory from '../config/repository-factory.js';

const usersRepo = repositoryFactory.getUsersRepository();

const SALT_ROUNDS = 10;

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
      const updates = {};
      if (fullName !== undefined) {
        updates.full_name = String(fullName).trim() || null;
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
      const canManage = req.user.role === 'admin' || req.user.isProfileAdmin;
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Управление пользователями доступно только администратору профиля или системе' });
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
      const canManage = req.user.role === 'admin' || req.user.isProfileAdmin;
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
      const canManage = req.user.role === 'admin' || req.user.isProfileAdmin;
      if (!canManage) {
        return res.status(403).json({ ok: false, message: 'Добавлять пользователей может только администратор профиля или системы' });
      }
      const { email, password, fullName, phone, role = 'user', profileId, isProfileAdmin } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ ok: false, message: 'Укажите email (логин) и пароль' });
      }
      if (req.user.role !== 'admin' && (role === 'admin' || profileId != null)) {
        return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
      }
      const existing = await usersRepo.findByEmail(email);
      if (existing) {
        return res.status(400).json({ ok: false, message: 'Пользователь с таким email уже существует' });
      }
      let effectiveRole = req.user.role === 'admin' ? (role || 'user') : 'user';
      let effectiveProfileId = req.user.role === 'admin' ? (profileId != null && profileId !== '' ? Number(profileId) : null) : req.user.profileId;
      let effectiveIsProfileAdmin =
        req.user.role === 'admin'
          ? !!isProfileAdmin
          : req.user.isProfileAdmin
            ? !!isProfileAdmin
            : false;
      if (effectiveRole === 'admin') {
        effectiveProfileId = null;
        effectiveIsProfileAdmin = false;
      } else if (effectiveProfileId != null && effectiveProfileId !== '') {
        effectiveRole = 'user';
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
        fullName: fullName || null,
        phone: phoneTrim,
        role: effectiveRole,
        profileId: effectiveProfileId,
        isProfileAdmin: effectiveIsProfileAdmin,
      });
      res.status(201).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const canManage = req.user.role === 'admin' || req.user.isProfileAdmin;
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
      if (updates.fullName !== undefined) {
        updates.full_name = String(updates.fullName).trim() || null;
        delete updates.fullName;
      }
      if (updates.isProfileAdmin !== undefined) {
        updates.is_profile_admin = updates.isProfileAdmin;
        delete updates.isProfileAdmin;
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
        } else if (mergedProfile != null) {
          updates.role = 'user';
        }
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

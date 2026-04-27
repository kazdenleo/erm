/**
 * Profiles Controller
 * Управление профилями (кабинетами)
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { jsonSafeRow } from '../utils/profileId.js';

const repo = repositoryFactory.getProfilesRepository();
const inquiriesRepo = repositoryFactory.getInquiriesRepository();

/** Поля профиля, которые может менять администратор аккаунта (не тариф и не id) */
function pickAccountOwnerProfilePayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.contact_full_name !== undefined || b.contactFullName !== undefined) {
    out.contact_full_name = b.contact_full_name ?? b.contactFullName;
  }
  if (b.contact_email !== undefined || b.contactEmail !== undefined) {
    out.contact_email = b.contact_email ?? b.contactEmail;
  }
  if (b.contact_phone !== undefined || b.contactPhone !== undefined) {
    out.contact_phone = b.contact_phone ?? b.contactPhone;
  }
  if (b.allow_private_orders !== undefined || b.allowPrivateOrders !== undefined) {
    const v = b.allow_private_orders ?? b.allowPrivateOrders;
    out.allow_private_orders = v === true || v === '1' || v === 'true';
  }
  if (
    b.require_reserved_stock_for_assembly !== undefined ||
    b.requireReservedStockForAssembly !== undefined
  ) {
    const v = b.require_reserved_stock_for_assembly ?? b.requireReservedStockForAssembly;
    out.require_reserved_stock_for_assembly = v === true || v === '1' || v === 'true';
  }
  return out;
}

function normalizeProfileStatsRow(row) {
  const u = row.users_count ?? row.usersCount;
  const o = row.organizations_count ?? row.organizationsCount;
  const users = u != null && u !== '' ? Number(u) : 0;
  const orgs = o != null && o !== '' ? Number(o) : 0;
  return {
    ...row,
    users_count: users,
    organizations_count: orgs,
    usersCount: users,
    organizationsCount: orgs,
  };
}

export const profilesController = {
  /** Текущий профиль (администратор аккаунта) */
  async getMyProfile(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const item = await repo.findById(id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      res.json({ ok: true, data: jsonSafeRow(item) });
    } catch (error) {
      next(error);
    }
  },

  async updateMyProfile(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const payload = pickAccountOwnerProfilePayload(req.body);
      if (payload.name !== undefined && String(payload.name).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите название аккаунта' });
      }
      if (Object.keys(payload).length === 0) {
        const current = await repo.findById(id);
        if (!current) {
          return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
        }
        return res.json({ ok: true, data: jsonSafeRow(current) });
      }
      const item = await repo.update(id, payload);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      res.json({ ok: true, data: jsonSafeRow(item) });
    } catch (error) {
      next(error);
    }
  },

  async getAll(req, res, next) {
    try {
      const list = await repo.findAllWithStats();
      res.json({
        ok: true,
        data: list.map((row) => normalizeProfileStatsRow(jsonSafeRow(row))),
      });
    } catch (error) {
      next(error);
    }
  },

  /** Карточка аккаунта для админки продукта: контакты, счётчики, история обращений */
  async getCabinet(req, res, next) {
    try {
      const { id } = req.params;
      const profile = await repo.findById(id);
      if (!profile) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const stats = await query(
        `SELECT
          (SELECT COUNT(*)::int FROM users WHERE profile_id = $1 AND role <> 'admin') AS users_count,
          (
            SELECT COUNT(*)::int
            FROM organizations o
            WHERE o.profile_id = $1
              OR (
                o.profile_id IS NULL
                AND (SELECT COUNT(*)::int FROM profiles) = 1
                AND $1::bigint = (SELECT id FROM profiles ORDER BY id LIMIT 1)
              )
          ) AS organizations_count`,
        [id]
      );
      const inquiries = await inquiriesRepo.findAll({ profileId: id });
      const row = stats.rows[0] || {};
      const normalized = normalizeProfileStatsRow(jsonSafeRow(row));
      res.json({
        ok: true,
        data: {
          profile: jsonSafeRow(profile),
          usersCount: normalized.usersCount,
          organizationsCount: normalized.organizationsCount,
          inquiries: Array.isArray(inquiries) ? inquiries.map((r) => jsonSafeRow(r)) : inquiries,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const item = await repo.findById(id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Профиль не найден' });
      }
      res.json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const item = await repo.create(req.body);
      res.status(201).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const item = await repo.update(id, req.body);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Профиль не найден' });
      }
      res.json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await repo.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Профиль не найден' });
      }
      res.json({ ok: true, message: 'Профиль удалён' });
    } catch (error) {
      next(error);
    }
  },
};

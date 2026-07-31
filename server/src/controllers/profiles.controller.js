/**
 * Profiles Controller
 * Управление профилями (кабинетами)
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from '../services/stockMovements.service.js';
import { jsonSafeRow } from '../utils/profileId.js';
import { clearProfileFeatureFlagsCache } from '../utils/profileFeatureFlags.js';
import { normalizeProfileTimezone } from '../utils/profileTimezone.js';
import {
  CONFIGURABLE_ACCOUNT_ROLES,
  formStateToNavSections,
  normalizeAccountRoleKey,
  parseRoleNavSections,
  roleNavSectionsToFormState,
} from '../utils/userNavSections.js';

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
  if (
    b.auto_send_to_assembly_on_reserve !== undefined ||
    b.autoSendToAssemblyOnReserve !== undefined
  ) {
    const v = b.auto_send_to_assembly_on_reserve ?? b.autoSendToAssemblyOnReserve;
    out.auto_send_to_assembly_on_reserve = v === true || v === '1' || v === 'true';
  }
  if (
    b.allow_manual_warehouse_stock_edit !== undefined ||
    b.allowManualWarehouseStockEdit !== undefined
  ) {
    const v = b.allow_manual_warehouse_stock_edit ?? b.allowManualWarehouseStockEdit;
    out.allow_manual_warehouse_stock_edit = v === true || v === '1' || v === 'true';
  }
  if (
    b.allow_stock_history_reset !== undefined ||
    b.allowStockHistoryReset !== undefined
  ) {
    const v = b.allow_stock_history_reset ?? b.allowStockHistoryReset;
    out.allow_stock_history_reset = v === true || v === '1' || v === 'true';
  }
  if (
    b.procurement_status_enabled !== undefined ||
    b.procurementStatusEnabled !== undefined
  ) {
    const v = b.procurement_status_enabled ?? b.procurementStatusEnabled;
    out.procurement_status_enabled = v === true || v === '1' || v === 'true';
  }
  if (b.kits_enabled !== undefined || b.kitsEnabled !== undefined) {
    const v = b.kits_enabled ?? b.kitsEnabled;
    out.kits_enabled = v === true || v === '1' || v === 'true';
  }
  if (b.production_enabled !== undefined || b.productionEnabled !== undefined) {
    const v = b.production_enabled ?? b.productionEnabled;
    out.production_enabled = v === true || v === '1' || v === 'true';
  }
  if (
    b.allow_product_supplier_binding !== undefined ||
    b.allowProductSupplierBinding !== undefined
  ) {
    const v = b.allow_product_supplier_binding ?? b.allowProductSupplierBinding;
    out.allow_product_supplier_binding = v === true || v === '1' || v === 'true';
  }
  if (b.display_length_unit !== undefined || b.displayLengthUnit !== undefined) {
    const v = String(b.display_length_unit ?? b.displayLengthUnit ?? 'mm')
      .trim()
      .toLowerCase();
    out.display_length_unit = v === 'cm' ? 'cm' : 'mm';
  }
  if (b.display_weight_unit !== undefined || b.displayWeightUnit !== undefined) {
    const v = String(b.display_weight_unit ?? b.displayWeightUnit ?? 'g')
      .trim()
      .toLowerCase();
    out.display_weight_unit = v === 'kg' ? 'kg' : 'g';
  }
  if (b.timezone !== undefined || b.timeZone !== undefined) {
    out.timezone = normalizeProfileTimezone(b.timezone ?? b.timeZone);
  }
  if (b.manual_orders_warehouse_id !== undefined || b.manualOrdersWarehouseId !== undefined) {
    const raw = b.manual_orders_warehouse_id ?? b.manualOrdersWarehouseId;
    if (raw == null || raw === '') {
      out.manual_orders_warehouse_id = null;
    } else {
      const n = Number(raw);
      out.manual_orders_warehouse_id = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  if (b.fbs_enabled !== undefined || b.fbsEnabled !== undefined) {
    const v = b.fbs_enabled ?? b.fbsEnabled;
    out.fbs_enabled = v === true || v === '1' || v === 'true';
  }
  if (b.fbo_enabled !== undefined || b.fboEnabled !== undefined) {
    const v = b.fbo_enabled ?? b.fboEnabled;
    out.fbo_enabled = v === true || v === '1' || v === 'true';
  }
  if (b.fbo_deduction_warehouse_id !== undefined || b.fboDeductionWarehouseId !== undefined) {
    const raw = b.fbo_deduction_warehouse_id ?? b.fboDeductionWarehouseId;
    if (raw == null || raw === '') {
      out.fbo_deduction_warehouse_id = null;
    } else {
      const n = Number(raw);
      out.fbo_deduction_warehouse_id = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return out;
}

async function validateFboDeductionWarehouse(profileId, payload, currentProfile) {
  const fboEnabled =
    payload.fbo_enabled !== undefined
      ? payload.fbo_enabled === true
      : currentProfile?.fbo_enabled === true;
  let whId =
    payload.fbo_deduction_warehouse_id !== undefined
      ? payload.fbo_deduction_warehouse_id
      : currentProfile?.fbo_deduction_warehouse_id ?? null;
  if (!fboEnabled) {
    if (payload.fbo_enabled === false) {
      payload.fbo_deduction_warehouse_id = null;
    }
    return null;
  }
  if (whId == null || whId === '') {
    return 'Укажите склад списания остатков для поставок FBO';
  }
  const wid = Number(whId);
  if (!Number.isFinite(wid) || wid <= 0) {
    return 'Укажите склад списания остатков для поставок FBO';
  }
  const wh = await query(
    `SELECT id FROM warehouses WHERE id = $1 AND profile_id = $2 AND type = 'warehouse' LIMIT 1`,
    [wid, profileId]
  );
  if (!wh.rows[0]) {
    return 'Выбранный склад FBO не найден или недоступен для этого аккаунта';
  }
  return null;
}

async function validateManualOrdersWarehouse(profileId, payload, currentProfile) {
  const allowPrivate =
    payload.allow_private_orders !== undefined
      ? payload.allow_private_orders === true
      : currentProfile?.allow_private_orders === true;
  let whId =
    payload.manual_orders_warehouse_id !== undefined
      ? payload.manual_orders_warehouse_id
      : currentProfile?.manual_orders_warehouse_id ?? null;
  if (!allowPrivate) {
    if (payload.allow_private_orders === false) {
      payload.manual_orders_warehouse_id = null;
    }
    return null;
  }
  if (whId == null || whId === '') {
    return 'Укажите склад списания остатков для ручных заказов';
  }
  const wid = Number(whId);
  if (!Number.isFinite(wid) || wid <= 0) {
    return 'Укажите склад списания остатков для ручных заказов';
  }
  const wh = await query(
    `SELECT id FROM warehouses WHERE id = $1 AND profile_id = $2 AND type = 'warehouse' LIMIT 1`,
    [wid, profileId]
  );
  if (!wh.rows[0]) {
    return 'Выбранный склад не найден или недоступен для этого аккаунта';
  }
  return null;
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

  /** Настройки видимости разделов по ролям аккаунта */
  async getRoleNavSections(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const item = await repo.findById(id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const stored = parseRoleNavSections(item.role_nav_sections);
      const roles = {};
      for (const role of CONFIGURABLE_ACCOUNT_ROLES) {
        roles[role] = {
          configured: Object.prototype.hasOwnProperty.call(stored, role),
          navSections: roleNavSectionsToFormState(item.role_nav_sections, role),
        };
      }
      res.json({ ok: true, data: { roles } });
    } catch (error) {
      next(error);
    }
  },

  async updateRoleNavSection(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const role = normalizeAccountRoleKey(req.params.role);
      if (!role || !CONFIGURABLE_ACCOUNT_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, message: 'Неизвестная роль' });
      }
      const current = await repo.findById(id);
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const all = parseRoleNavSections(current.role_nav_sections);
      const { navSections, useDefaultPreset } = req.body || {};
      if (useDefaultPreset) {
        delete all[role];
      } else {
        all[role] = formStateToNavSections(navSections);
      }
      const item = await repo.update(id, { role_nav_sections: all });
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      res.json({
        ok: true,
        data: {
          role,
          configured: Object.prototype.hasOwnProperty.call(all, role),
          navSections: roleNavSectionsToFormState(item.role_nav_sections, role),
        },
      });
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
      const current = await repo.findById(id);
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      if (Object.keys(payload).length === 0) {
        return res.json({ ok: true, data: jsonSafeRow(current) });
      }
      const manualWhError = await validateManualOrdersWarehouse(id, payload, current);
      if (manualWhError) {
        return res.status(400).json({ ok: false, message: manualWhError });
      }
      const fboWhError = await validateFboDeductionWarehouse(id, payload, current);
      if (fboWhError) {
        return res.status(400).json({ ok: false, message: fboWhError });
      }
      const item = await repo.update(id, payload);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      clearProfileFeatureFlagsCache(id);
      res.json({ ok: true, data: jsonSafeRow(item) });
    } catch (error) {
      next(error);
    }
  },

  /** Массовый сброс истории остатков по всем товарам аккаунта. */
  async resetAllStockHistory(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const result = await stockMovementsService.resetAllStockHistoryForProfile(id);
      res.json({ ok: true, data: result });
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

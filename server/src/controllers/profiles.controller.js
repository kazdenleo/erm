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
import { normalizePartsApiKeys } from '../config/partsapi.config.js';
import { normalizePartsIndexKeys } from '../config/partsindex.config.js';
import { parseCardQualitySettings } from '../utils/cardQualitySettings.js';
import {
  mergeNotificationSettings,
  notificationSettingsForClient,
  parseNotificationSettings,
  resolveTelegramSendTarget,
} from '../utils/notificationSettings.js';
import { parseEmployeeMetricsSettings } from '../utils/employeeMetricsSettings.js';
import {
  CONFIGURABLE_ACCOUNT_ROLES,
  formStateToNavSections,
  normalizeAccountRoleKey,
  parseRoleFlags,
  parseRoleNavSections,
  roleNavSectionsToFormState,
} from '../utils/userNavSections.js';

const repo = repositoryFactory.getProfilesRepository();
const inquiriesRepo = repositoryFactory.getInquiriesRepository();

function withoutTelegramToken(row) {
  if (!row || typeof row !== 'object') return row;
  const raw = row.notification_settings ?? row.notificationSettings;
  if (raw == null) return row;
  const pub = notificationSettingsForClient(raw);
  const next = { ...row };
  if (row.notification_settings !== undefined) next.notification_settings = pub;
  if (row.notificationSettings !== undefined) next.notificationSettings = pub;
  return next;
}

function presentProfile(row) {
  return withoutTelegramToken(jsonSafeRow(row));
}

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
  if (b.purchase_receipt_mode !== undefined || b.purchaseReceiptMode !== undefined) {
    const v = String(b.purchase_receipt_mode ?? b.purchaseReceiptMode ?? 'scanner')
      .trim()
      .toLowerCase();
    out.purchase_receipt_mode = v === 'manual' ? 'manual' : 'scanner';
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
  if (
    b.packing_display_attribute_id !== undefined ||
    b.packingDisplayAttributeId !== undefined
  ) {
    const raw = b.packing_display_attribute_id ?? b.packingDisplayAttributeId;
    if (raw == null || raw === '') {
      out.packing_display_attribute_id = null;
    } else {
      const n = Number(raw);
      out.packing_display_attribute_id = Number.isFinite(n) && n > 0 ? n : null;
    }
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
  if (b.partsapi_keys !== undefined || b.partsapiKeys !== undefined) {
    out.partsapi_keys = normalizePartsApiKeys(b.partsapi_keys ?? b.partsapiKeys);
  }
  if (b.partsindex_keys !== undefined || b.partsindexKeys !== undefined) {
    out.partsindex_keys = normalizePartsIndexKeys(b.partsindex_keys ?? b.partsindexKeys);
  }
  if (b.card_quality_settings !== undefined || b.cardQualitySettings !== undefined) {
    out.card_quality_settings = parseCardQualitySettings(b.card_quality_settings ?? b.cardQualitySettings);
  }
  if (b.notification_settings !== undefined || b.notificationSettings !== undefined) {
    out.notification_settings = parseNotificationSettings(
      b.notification_settings ?? b.notificationSettings
    );
  }
  if (b.employee_metrics_settings !== undefined || b.employeeMetricsSettings !== undefined) {
    out.employee_metrics_settings = parseEmployeeMetricsSettings(
      b.employee_metrics_settings ?? b.employeeMetricsSettings
    );
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
  const pr = row.products_count ?? row.productsCount;
  const sb = row.storage_bytes ?? row.storageBytes;
  const users = u != null && u !== '' ? Number(u) : 0;
  const orgs = o != null && o !== '' ? Number(o) : 0;
  const products = pr != null && pr !== '' ? Number(pr) : 0;
  const storageBytes = sb != null && sb !== '' ? Number(sb) : 0;
  return {
    ...row,
    users_count: users,
    organizations_count: orgs,
    products_count: products,
    storage_bytes: storageBytes,
    usersCount: users,
    organizationsCount: orgs,
    productsCount: products,
    storageBytes,
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
      res.json({ ok: true, data: presentProfile(item) });
    } catch (error) {
      next(error);
    }
  },

  /** Проверочное сообщение в Telegram по сохранённым или переданным токену и chat id. */
  async testTelegram(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const current = await repo.findById(id);
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const { token, chatIds } = resolveTelegramSendTarget(
        current.notification_settings,
        req.body || {}
      );
      if (!token) {
        return res.status(400).json({ ok: false, message: 'Укажите токен бота' });
      }
      if (!chatIds.length) {
        return res.status(400).json({ ok: false, message: 'Укажите chat id' });
      }
      const { sendTelegramMessage } = await import('../services/telegramNotify.service.js');
      const result = await sendTelegramMessage(
        token,
        chatIds[0],
        '<b>ERM</b>\nПроверка уведомлений: связь с Telegram работает.'
      );
      if (!result.ok) {
        return res.status(400).json({ ok: false, message: `Telegram: ${result.error}` });
      }
      res.json({ ok: true, message: 'Сообщение отправлено' });
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
      const flags = parseRoleFlags(item.role_nav_sections);
      const roles = {};
      for (const role of CONFIGURABLE_ACCOUNT_ROLES) {
        roles[role] = {
          configured: Object.prototype.hasOwnProperty.call(stored, role),
          navSections: roleNavSectionsToFormState(item.role_nav_sections, role),
          dailyLogout: flags[role]?.dailyLogout === true,
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
      const flags = parseRoleFlags(current.role_nav_sections);
      const { navSections, useDefaultPreset, dailyLogout } = req.body || {};
      if (useDefaultPreset) {
        delete all[role];
        delete flags[role];
      } else {
        all[role] = formStateToNavSections(navSections);
        flags[role] = {
          dailyLogout: dailyLogout === true,
        };
      }
      const payload = { ...all, roleFlags: flags };
      const item = await repo.update(id, { role_nav_sections: payload });
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const savedFlags = parseRoleFlags(item.role_nav_sections);
      res.json({
        ok: true,
        data: {
          role,
          configured: Object.prototype.hasOwnProperty.call(parseRoleNavSections(item.role_nav_sections), role),
          navSections: roleNavSectionsToFormState(item.role_nav_sections, role),
          dailyLogout: savedFlags[role]?.dailyLogout === true,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /** Завершить первичный онбординг (организация / склад / МП). */
  async completeOnboarding(req, res, next) {
    try {
      const id = req.user.profileId;
      if (id == null || id === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const current = await repo.findById(id);
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      if (current.onboarding_completed_at) {
        return res.json({
          ok: true,
          data: {
            completed: true,
            completedAt: new Date(current.onboarding_completed_at).toISOString(),
          },
        });
      }
      const orgs = repositoryFactory.getOrganizationsRepository();
      const orgList = orgs ? await orgs.findAll({ profileId: id }) : [];
      if (!Array.isArray(orgList) || orgList.length === 0) {
        return res.status(400).json({
          ok: false,
          message: 'Сначала создайте организацию в мастере настройки',
        });
      }
      const item = await repo.update(id, {
        onboarding_completed_at: new Date().toISOString(),
      });
      return res.json({
        ok: true,
        data: {
          completed: true,
          completedAt: item?.onboarding_completed_at
            ? new Date(item.onboarding_completed_at).toISOString()
            : new Date().toISOString(),
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
      // Ключи PartsIndex/PartsAPI — только администратор аккаунта, не системный admin платформы.
      if (
        (payload.partsapi_keys !== undefined || payload.partsindex_keys !== undefined) &&
        req.user?.role === 'admin'
      ) {
        return res.status(403).json({
          ok: false,
          message: 'Ключи обогащения задаёт администратор аккаунта, не системный администратор',
        });
      }
      if (payload.name !== undefined && String(payload.name).trim() === '') {
        return res.status(400).json({ ok: false, message: 'Укажите название аккаунта' });
      }
      const current = await repo.findById(id);
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      if (payload.notification_settings) {
        payload.notification_settings = mergeNotificationSettings(
          current.notification_settings,
          payload.notification_settings
        );
      }
      if (Object.keys(payload).length === 0) {
        return res.json({ ok: true, data: presentProfile(current) });
      }
      const { getEffectivePlanForProfile, clampFeatureFlagsToPlan } = await import(
        '../utils/planLimits.js'
      );
      const plan = await getEffectivePlanForProfile(id);
      const clamped = clampFeatureFlagsToPlan(payload, plan);
      if (clamped.rejected.length) {
        return res.status(403).json({
          ok: false,
          code: 'PLAN_FEATURE',
          message: `Модуль недоступен на тарифе «${plan?.name || ''}». Выберите тариф выше на странице «Тарифы».`,
          rejected: clamped.rejected,
        });
      }
      const safePayload = clamped.payload;
      const manualWhError = await validateManualOrdersWarehouse(id, safePayload, current);
      if (manualWhError) {
        return res.status(400).json({ ok: false, message: manualWhError });
      }
      const fboWhError = await validateFboDeductionWarehouse(id, safePayload, current);
      if (fboWhError) {
        return res.status(400).json({ ok: false, message: fboWhError });
      }
      const item = await repo.update(id, safePayload);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      clearProfileFeatureFlagsCache(id);
      const quality = parseCardQualitySettings(item.card_quality_settings ?? payload.card_quality_settings);
      if (quality.showInCardWork) {
        setTimeout(() => {
          import('../services/marketplaceCardQuality.service.js')
            .then((mod) => mod.default.refreshForProfile(id))
            .catch((e) => console.warn('[CardQuality] refresh after settings save failed', e?.message || e));
        }, 0);
      }
      res.json({ ok: true, data: presentProfile(item) });
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
        data: list.map((row) => normalizeProfileStatsRow(presentProfile(row))),
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
      const row = await repo.getCabinetStats(id);
      const inquiries = await inquiriesRepo.findAll({ profileId: id });
      const normalized = normalizeProfileStatsRow(jsonSafeRow(row));
      res.json({
        ok: true,
        data: {
          profile: presentProfile(profile),
          usersCount: normalized.usersCount,
          organizationsCount: normalized.organizationsCount,
          productsCount: normalized.productsCount,
          storageBytes: normalized.storageBytes,
          inquiries: Array.isArray(inquiries) ? inquiries.map((r) => jsonSafeRow(r)) : inquiries,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /** Подробная разбивка размера данных аккаунта */
  async getStorageBreakdown(req, res, next) {
    try {
      const { id } = req.params;
      const profile = await repo.findById(id);
      if (!profile) {
        return res.status(404).json({ ok: false, message: 'Аккаунт не найден' });
      }
      const breakdown = await repo.getStorageBreakdown(id);
      res.json({
        ok: true,
        data: {
          profileId: Number(profile.id),
          profileName: profile.name,
          totalBytes: breakdown.total_bytes,
          categories: breakdown.categories,
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
      res.json({ ok: true, data: withoutTelegramToken(item) });
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
      const body = req.body && typeof req.body === 'object' ? { ...req.body } : {};
      const hasSub =
        body.subscription_status !== undefined ||
        body.subscriptionStatus !== undefined ||
        body.plan_code !== undefined ||
        body.planCode !== undefined ||
        body.trial_ends_at !== undefined ||
        body.trialEndsAt !== undefined ||
        body.subscription_ends_at !== undefined ||
        body.subscriptionEndsAt !== undefined;
      let beforeSub = null;
      if (hasSub) {
        const { buildSubscriptionUpdatePayload } = await import(
          '../utils/profileSubscription.js'
        );
        const { clearSubscriptionAccessCache } = await import(
          '../middleware/subscriptionAccess.js'
        );
        beforeSub = await repo.findById(id);
        Object.assign(
          body,
          buildSubscriptionUpdatePayload({
            status: body.subscription_status ?? body.subscriptionStatus,
            planCode: body.plan_code ?? body.planCode,
            trialEndsAt: body.trial_ends_at ?? body.trialEndsAt,
            subscriptionEndsAt: body.subscription_ends_at ?? body.subscriptionEndsAt,
            applyFeatureFlags: body.applyFeatureFlags !== false,
          })
        );
        clearSubscriptionAccessCache(id);
      }
      const item = await repo.update(id, body);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Профиль не найден' });
      }
      if (hasSub && beforeSub) {
        try {
          const { recordManualSubscriptionChange } = await import(
            '../services/subscriptionBilling.service.js'
          );
          await recordManualSubscriptionChange({
            profileId: id,
            actorUserId: req.user?.id ?? null,
            before: beforeSub,
            after: item,
          });
        } catch (e) {
          console.warn('[profiles] subscription audit failed:', e?.message || e);
        }
      }
      clearProfileFeatureFlagsCache(id);
      res.json({ ok: true, data: withoutTelegramToken(item) });
    } catch (error) {
      if (error?.statusCode === 400) {
        return res.status(400).json({ ok: false, message: error.message });
      }
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

/**
 * Marketplace Cabinets Controller
 * Кабинеты маркетплейсов для организаций (Озон/Яндекс — несколько, ВБ — один на организацию)
 * При сохранении кабинета конфиг синхронизируется в таблицу integrations, чтобы проверка токена и тарифы использовали те же данные.
 */

import * as repo from '../repositories/marketplace_cabinets.repository.pg.js';
import organizationsRepository from '../repositories/organizations.repository.pg.js';
import integrationsService from '../services/integrations.service.js';

const VALID_TYPES = ['ozon', 'wildberries', 'yandex'];

function parseCabinetConfig(config) {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
}

function withPreservedFieldLimits(incomingConfig, existingConfig) {
  const next = parseCabinetConfig(incomingConfig);
  const prev = parseCabinetConfig(existingConfig);
  if (next.field_limits === undefined && prev.field_limits !== undefined) {
    next.field_limits = prev.field_limits;
  }
  return next;
}

function inheritFieldLimits(incomingConfig, siblingCabinets) {
  const next = parseCabinetConfig(incomingConfig);
  if (next.field_limits !== undefined) return next;
  const source = (siblingCabinets || []).find((c) => parseCabinetConfig(c.config).field_limits);
  if (!source) return next;
  next.field_limits = parseCabinetConfig(source.config).field_limits;
  return next;
}

/**
 * Сохраняет кабинет в integrations с теми же profile_id + organization_id, что и у организации.
 * Без этих полей saveMarketplaceConfig в PostgreSQL не находит запись (findByCode) и дубли в integrations не сходят с UI.
 */
async function syncCabinetToIntegrations(organizationId, marketplaceType, cabinetConfig) {
  const oid = organizationId != null && String(organizationId).trim() !== '' ? Number(organizationId) : null;
  if (oid == null || Number.isNaN(oid)) return null;
  const org = await organizationsRepository.findById(oid);
  const profileId = org?.profile_id;
  if (profileId == null || profileId === '') {
    console.warn(
      '[Marketplace Cabinets] У организации нет profile_id — пропуск синхронизации в integrations. organization_id=',
      oid
    );
    return null;
  }
  return integrationsService.saveMarketplaceConfig(marketplaceType, cabinetConfig, {
    profileId,
    organizationId: oid
  });
}

export const marketplaceCabinetsController = {
  async list(req, res, next) {
    try {
      const organizationId = req.params.organizationId;
      const type = req.query.type || null;
      const list = await repo.findAll(organizationId, type ? { marketplaceType: type } : {});
      res.json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const cabinet = await repo.findById(id);
      if (!cabinet) {
        return res.status(404).json({ ok: false, message: 'Кабинет не найден' });
      }
      res.json({ ok: true, data: cabinet });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const organizationId = req.params.organizationId;
      const { marketplace_type, name, config, is_active, sort_order } = req.body;
      if (!marketplace_type || !VALID_TYPES.includes(marketplace_type)) {
        return res.status(400).json({ ok: false, message: 'Укажите тип маркетплейса: ozon, wildberries или yandex' });
      }
      if (marketplace_type === 'wildberries') {
        const count = await repo.countByOrganizationAndType(organizationId, 'wildberries');
        if (count >= 1) {
          return res.status(400).json({ ok: false, message: 'Для организации разрешён только один кабинет Wildberries' });
        }
      }
      const siblings = await repo.findAll(organizationId, { marketplaceType: marketplace_type });
      const cabinetConfig = inheritFieldLimits(config || {}, siblings);
      let cabinet = await repo.create({
        organization_id: organizationId,
        marketplace_type,
        name: name || (marketplace_type === 'ozon' ? 'Ozon' : marketplace_type === 'yandex' ? 'Яндекс.Маркет' : 'Wildberries'),
        config: cabinetConfig,
        is_active: is_active !== false,
        sort_order: sort_order ?? 0
      });
      try {
        const syncResult = await syncCabinetToIntegrations(organizationId, marketplace_type, cabinetConfig);
        if (syncResult?.config && cabinet?.id) {
          await repo.update(cabinet.id, { config: syncResult.config });
          cabinet = await repo.findById(cabinet.id);
        }
      } catch (syncErr) {
        console.warn('[Marketplace Cabinets] Sync to integrations failed:', syncErr?.message);
      }
      res.status(201).json({ ok: true, data: cabinet });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const cabinet = await repo.findById(id);
      if (!cabinet) {
        return res.status(404).json({ ok: false, message: 'Кабинет не найден' });
      }
      const body = { ...req.body };
      if (body.config !== undefined) {
        body.config = withPreservedFieldLimits(body.config, cabinet.config);
      }
      let updated = await repo.update(id, body);
      const configToSync = updated?.config ?? cabinet?.config;
      if (configToSync && updated?.marketplace_type) {
        try {
          const syncResult = await syncCabinetToIntegrations(
            cabinet.organization_id,
            updated.marketplace_type,
            configToSync
          );
          if (syncResult?.config && updated?.id) {
            updated = await repo.update(id, { config: syncResult.config });
          }
        } catch (syncErr) {
          console.warn('[Marketplace Cabinets] Sync to integrations failed:', syncErr?.message);
        }
      }
      res.json({ ok: true, data: updated });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await repo.deleteById(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Кабинет не найден' });
      }
      res.json({ ok: true, message: 'Кабинет удалён' });
    } catch (error) {
      next(error);
    }
  }
};

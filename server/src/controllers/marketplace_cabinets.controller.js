/**
 * Marketplace Cabinets Controller
 * Кабинеты маркетплейсов для организаций (Озон/Яндекс — несколько, ВБ — один на организацию)
 * При сохранении кабинета конфиг синхронизируется в таблицу integrations, чтобы проверка токена и тарифы использовали те же данные.
 */

import * as repo from '../repositories/marketplace_cabinets.repository.pg.js';
import integrationsService from '../services/integrations.service.js';

const VALID_TYPES = ['ozon', 'wildberries', 'yandex'];

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
      const cabinetConfig = config || {};
      let cabinet = await repo.create({
        organization_id: organizationId,
        marketplace_type,
        name: name || (marketplace_type === 'ozon' ? 'Ozon' : marketplace_type === 'yandex' ? 'Яндекс.Маркет' : 'Wildberries'),
        config: cabinetConfig,
        is_active: is_active !== false,
        sort_order: sort_order ?? 0
      });
      try {
        const syncResult = await integrationsService.saveMarketplaceConfig(marketplace_type, cabinetConfig);
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
      let updated = await repo.update(id, req.body);
      const configToSync = updated?.config ?? cabinet?.config;
      if (configToSync && updated?.marketplace_type) {
        try {
          const syncResult = await integrationsService.saveMarketplaceConfig(updated.marketplace_type, configToSync);
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

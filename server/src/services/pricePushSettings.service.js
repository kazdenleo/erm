/**
 * Настройки отправки цен на маркетплейсы (profile + организации).
 */

import repositoryFactory from '../config/repository-factory.js';
import organizationsRepository from '../repositories/organizations.repository.pg.js';
import {
  filtersFromPricePushSettings,
  mergePricePushSettings,
  parsePricePushSettings,
} from '../utils/pricePushSettings.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

class PricePushSettingsService {
  async _loadProfile(profileId) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      throw httpError('Настройки доступны только при работе с PostgreSQL', 400);
    }
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) throw httpError('Не указан профиль', 400);
    const repo = repositoryFactory.getProfilesRepository();
    const row = await repo.findById(pid);
    if (!row) throw httpError('Аккаунт не найден', 404);
    return row;
  }

  async getForProfile(profileId) {
    const row = await this._loadProfile(profileId);
    const settings = parsePricePushSettings(row.price_push_settings ?? row.pricePushSettings);
    const orgs = await organizationsRepository.findAll({ profileId });
    return {
      scope: settings.scope,
      categoryIds: settings.categoryIds,
      productIds: settings.productIds,
      organizations: (orgs || []).map((o) => ({
        id: o.id,
        name: o.name,
        autoPushMarketplacePrices: o.auto_push_marketplace_prices === true,
      })),
    };
  }

  async saveForProfile(profileId, incoming) {
    const repo = repositoryFactory.getProfilesRepository();
    const row = await this._loadProfile(profileId);
    const next = mergePricePushSettings(row.price_push_settings ?? row.pricePushSettings, incoming || {});
    const saved = await repo.update(profileId, { price_push_settings: next });
    const settings = parsePricePushSettings(saved?.price_push_settings ?? next);
    return {
      scope: settings.scope,
      categoryIds: settings.categoryIds,
      productIds: settings.productIds,
    };
  }

  async buildPushFiltersForProfile(profileId) {
    const row = await this._loadProfile(profileId);
    return filtersFromPricePushSettings(row.price_push_settings ?? row.pricePushSettings, profileId);
  }
}

export default new PricePushSettingsService();

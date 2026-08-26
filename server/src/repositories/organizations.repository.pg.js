/**
 * Organizations Repository (PostgreSQL)
 * Репозиторий для работы с организациями
 */

import { query } from '../config/database.js';

class OrganizationsRepositoryPG {
  async findAll(filters = {}) {
    const { profileId } = filters;
    if (profileId != null) {
      const result = await query(
        'SELECT * FROM organizations WHERE profile_id = $1 ORDER BY name',
        [profileId]
      );
      return result.rows;
    }
    const result = await query(
      'SELECT * FROM organizations ORDER BY name'
    );
    return result.rows;
  }

  async findById(id) {
    const result = await query(
      'SELECT * FROM organizations WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async create(data) {
    const name = data.name || data;
    const inn = (typeof data === 'object' && data.inn != null) ? data.inn : null;
    const address = (typeof data === 'object' && data.address != null) ? data.address : null;
    const taxSystem = (typeof data === 'object' && data.tax_system != null && data.tax_system !== '') ? data.tax_system : null;
    const vat = (typeof data === 'object' && data.vat != null && data.vat !== '') ? data.vat : null;
    const articlePrefix = (typeof data === 'object' && data.article_prefix != null && String(data.article_prefix).trim() !== '') ? String(data.article_prefix).trim() : null;
    const profileId = (typeof data === 'object' && data.profile_id != null && data.profile_id !== '') ? data.profile_id : null;
    const skipMpStock =
      typeof data === 'object' &&
      (data.skip_marketplace_stock_sync === true ||
        data.skip_marketplace_stock_sync === 'true' ||
        data.skip_marketplace_stock_sync === 1 ||
        data.skip_marketplace_stock_sync === '1' ||
        data.skipMarketplaceStockSync === true ||
        data.skipMarketplaceStockSync === 'true' ||
        data.skipMarketplaceStockSync === 1 ||
        data.skipMarketplaceStockSync === '1');
    const autoPushPrices =
      typeof data === 'object' &&
      (data.auto_push_marketplace_prices === true ||
        data.auto_push_marketplace_prices === 'true' ||
        data.auto_push_marketplace_prices === 1 ||
        data.auto_push_marketplace_prices === '1' ||
        data.autoPushMarketplacePrices === true ||
        data.autoPushMarketplacePrices === 'true' ||
        data.autoPushMarketplacePrices === 1 ||
        data.autoPushMarketplacePrices === '1');
    const dailyPullCards =
      typeof data === 'object' &&
      (data.daily_pull_marketplace_cards === true ||
        data.daily_pull_marketplace_cards === 'true' ||
        data.daily_pull_marketplace_cards === 1 ||
        data.daily_pull_marketplace_cards === '1' ||
        data.dailyPullMarketplaceCards === true ||
        data.dailyPullMarketplaceCards === 'true' ||
        data.dailyPullMarketplaceCards === 1 ||
        data.dailyPullMarketplaceCards === '1');
    const nightlyImportData =
      typeof data === 'object' &&
      (data.nightly_import_marketplace_data === true ||
        data.nightly_import_marketplace_data === 'true' ||
        data.nightly_import_marketplace_data === 1 ||
        data.nightly_import_marketplace_data === '1' ||
        data.nightlyImportMarketplaceData === true ||
        data.nightlyImportMarketplaceData === 'true' ||
        data.nightlyImportMarketplaceData === 1 ||
        data.nightlyImportMarketplaceData === '1');
    const result = await query(
      `INSERT INTO organizations (name, inn, address, tax_system, vat, article_prefix, profile_id, skip_marketplace_stock_sync, auto_push_marketplace_prices, daily_pull_marketplace_cards, nightly_import_marketplace_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        name,
        inn,
        address,
        taxSystem,
        vat,
        articlePrefix,
        profileId,
        skipMpStock,
        autoPushPrices,
        dailyPullCards,
        nightlyImportData
      ]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const updates = typeof data === 'object' ? data : { name: data };
    const fields = [];
    const params = [];
    let i = 1;
    if (updates.name !== undefined) {
      fields.push(`name = $${i++}`);
      params.push(updates.name);
    }
    if (updates.inn !== undefined) {
      fields.push(`inn = $${i++}`);
      params.push(updates.inn);
    }
    if (updates.address !== undefined) {
      fields.push(`address = $${i++}`);
      params.push(updates.address);
    }
    if (updates.tax_system !== undefined) {
      fields.push(`tax_system = $${i++}`);
      params.push(updates.tax_system === '' || updates.tax_system == null ? null : updates.tax_system);
    }
    if (updates.vat !== undefined) {
      fields.push(`vat = $${i++}`);
      params.push(updates.vat === '' || updates.vat == null ? null : updates.vat);
    }
    if (updates.article_prefix !== undefined) {
      fields.push(`article_prefix = $${i++}`);
      const val = updates.article_prefix == null || String(updates.article_prefix).trim() === '' ? null : String(updates.article_prefix).trim();
      params.push(val);
    }
    if (updates.profile_id !== undefined) {
      fields.push(`profile_id = $${i++}`);
      params.push(updates.profile_id === '' || updates.profile_id == null ? null : updates.profile_id);
    }
    if (
      updates.skip_marketplace_stock_sync !== undefined ||
      updates.skipMarketplaceStockSync !== undefined
    ) {
      const v = updates.skip_marketplace_stock_sync ?? updates.skipMarketplaceStockSync;
      fields.push(`skip_marketplace_stock_sync = $${i++}`);
      params.push(v === true || v === 'true' || v === 1 || v === '1');
    }
    if (
      updates.auto_push_marketplace_prices !== undefined ||
      updates.autoPushMarketplacePrices !== undefined
    ) {
      const v = updates.auto_push_marketplace_prices ?? updates.autoPushMarketplacePrices;
      fields.push(`auto_push_marketplace_prices = $${i++}`);
      params.push(v === true || v === 'true' || v === 1 || v === '1');
    }
    if (
      updates.daily_pull_marketplace_cards !== undefined ||
      updates.dailyPullMarketplaceCards !== undefined
    ) {
      const v = updates.daily_pull_marketplace_cards ?? updates.dailyPullMarketplaceCards;
      fields.push(`daily_pull_marketplace_cards = $${i++}`);
      params.push(v === true || v === 'true' || v === 1 || v === '1');
    }
    if (
      updates.nightly_import_marketplace_data !== undefined ||
      updates.nightlyImportMarketplaceData !== undefined
    ) {
      const v = updates.nightly_import_marketplace_data ?? updates.nightlyImportMarketplaceData;
      fields.push(`nightly_import_marketplace_data = $${i++}`);
      params.push(v === true || v === 'true' || v === 1 || v === '1');
    }
    if (fields.length === 0) return await this.findById(id);
    params.push(id);
    const result = await query(
      `UPDATE organizations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async delete(id) {
    const result = await query('DELETE FROM organizations WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new OrganizationsRepositoryPG();

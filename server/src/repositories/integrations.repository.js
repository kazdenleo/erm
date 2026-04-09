/**
 * Integrations Repository
 * Слой доступа к данным для настроек интеграций (маркетплейсы + поставщики)
 */

import { readData, writeData } from '../utils/storage.js';

class IntegrationsRepository {
  /**
   * Получить настройки маркетплейса или поставщика
   */
  async getConfig(type) {
    const config = await readData(type);
    return config || {};
  }

  /**
   * Сохранить настройки маркетплейса или поставщика
   */
  async saveConfig(type, config) {
    await writeData(type, config);
    return true;
  }

  /**
   * Получить настройки всех маркетплейсов
   */
  async getAllMarketplaces() {
    const [ozon, wb, ym] = await Promise.all([
      this.getConfig('ozon'),
      this.getConfig('wildberries'),
      this.getConfig('yandex')
    ]);
    return { ozon, wildberries: wb, yandex: ym };
  }

  /**
   * Получить настройки всех поставщиков
   */
  async getAllSuppliers() {
    const [mikado, moskvorechie] = await Promise.all([
      this.getConfig('mikado'),
      this.getConfig('moskvorechie')
    ]);
    return { mikado, moskvorechie };
  }
}

export default new IntegrationsRepository();


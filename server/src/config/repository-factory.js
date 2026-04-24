/**
 * Repository Factory
 * Фабрика для выбора репозиториев (старое файловое хранилище или PostgreSQL)
 */

import { getEnv } from './env.js';

// Старые репозитории (файловое хранилище)
import productsRepositoryOld from '../repositories/products.repository.js';
import ordersRepositoryOld from '../repositories/orders.repository.js';
import suppliersRepositoryOld from '../repositories/suppliers.repository.js';
import warehousesRepositoryOld from '../repositories/warehouses.repository.js';
import integrationsRepositoryOld from '../repositories/integrations.repository.js';
import certificatesRepositoryOld from '../repositories/certificates.repository.js';

// Новые репозитории (PostgreSQL)
import productsRepositoryPG from '../repositories/products.repository.pg.js';
import ordersRepositoryPG from '../repositories/orders.repository.pg.js';
import suppliersRepositoryPG from '../repositories/suppliers.repository.pg.js';
import warehousesRepositoryPG from '../repositories/warehouses.repository.pg.js';
import integrationsRepositoryPG from '../repositories/integrations.repository.pg.js';
import certificatesRepositoryPG from '../repositories/certificates.repository.pg.js';
import supplierStocksRepositoryPG from '../repositories/supplier_stocks.repository.pg.js';
import brandsRepositoryPG from '../repositories/brands.repository.pg.js';
import categoriesRepositoryPG from '../repositories/categories.repository.pg.js';
import categoryMappingsRepositoryPG from '../repositories/category_mappings.repository.pg.js';
import warehouseMappingsRepositoryPG from '../repositories/warehouse_mappings.repository.pg.js';
import cacheEntriesRepositoryPG from '../repositories/cache_entries.repository.pg.js';
import stockMovementsRepositoryPG from '../repositories/stock_movements.repository.pg.js';
import warehouseReceiptsRepositoryPG from '../repositories/warehouse_receipts.repository.pg.js';
import organizationsRepositoryPG from '../repositories/organizations.repository.pg.js';
import profilesRepositoryPG from '../repositories/profiles.repository.pg.js';
import usersRepositoryPG from '../repositories/users.repository.pg.js';
import inquiriesRepositoryPG from '../repositories/inquiries.repository.pg.js';
import marketplaceInventorySnapshotsRepositoryPG from '../repositories/marketplaceInventorySnapshots.repository.pg.js';

// Определяем, использовать ли PostgreSQL
const USE_POSTGRESQL = getEnv('USE_POSTGRESQL', 'true').toLowerCase() === 'true';

/**
 * Фабрика репозиториев
 */
class RepositoryFactory {
  constructor() {
    this.usePostgreSQL = USE_POSTGRESQL;
  }
  
  /**
   * Получить репозиторий продуктов
   */
  getProductsRepository() {
    return this.usePostgreSQL ? productsRepositoryPG : productsRepositoryOld;
  }
  
  /**
   * Получить репозиторий заказов
   */
  getOrdersRepository() {
    return this.usePostgreSQL ? ordersRepositoryPG : ordersRepositoryOld;
  }
  
  /**
   * Получить репозиторий поставщиков
   */
  getSuppliersRepository() {
    return this.usePostgreSQL ? suppliersRepositoryPG : suppliersRepositoryOld;
  }
  
  /**
   * Получить репозиторий складов
   */
  getWarehousesRepository() {
    return this.usePostgreSQL ? warehousesRepositoryPG : warehousesRepositoryOld;
  }
  
  /**
   * Получить репозиторий интеграций
   */
  getIntegrationsRepository() {
    return this.usePostgreSQL ? integrationsRepositoryPG : integrationsRepositoryOld;
  }

  /**
   * Получить репозиторий сертификатов
   */
  getCertificatesRepository() {
    return this.usePostgreSQL ? certificatesRepositoryPG : certificatesRepositoryOld;
  }
  
  /**
   * Получить репозиторий остатков поставщиков (только PostgreSQL)
   */
  getSupplierStocksRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Supplier stocks repository is only available with PostgreSQL');
    }
    return supplierStocksRepositoryPG;
  }

  /**
   * Снапшоты остатков на складах маркетплейсов / в пути (только PostgreSQL)
   */
  getMarketplaceInventorySnapshotsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Marketplace inventory snapshots repository is only available with PostgreSQL');
    }
    return marketplaceInventorySnapshotsRepositoryPG;
  }
  
  /**
   * Получить репозиторий брендов (только PostgreSQL)
   */
  getBrandsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Brands repository is only available with PostgreSQL');
    }
    return brandsRepositoryPG;
  }
  
  /**
   * Получить репозиторий категорий (только PostgreSQL)
   */
  getCategoriesRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Categories repository is only available with PostgreSQL');
    }
    return categoriesRepositoryPG;
  }
  
  /**
   * Получить репозиторий маппингов категорий (только PostgreSQL)
   */
  getCategoryMappingsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Category mappings repository is only available with PostgreSQL');
    }
    return categoryMappingsRepositoryPG;
  }
  
  /**
   * Получить репозиторий маппингов складов (только PostgreSQL)
   */
  getWarehouseMappingsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Warehouse mappings repository is only available with PostgreSQL');
    }
    return warehouseMappingsRepositoryPG;
  }
  
  /**
   * Получить репозиторий кэша (только PostgreSQL)
   */
  getCacheEntriesRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Cache entries repository is only available with PostgreSQL');
    }
    return cacheEntriesRepositoryPG;
  }

  /**
   * Получить репозиторий движений остатков (только PostgreSQL)
   */
  getStockMovementsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Stock movements repository is only available with PostgreSQL');
    }
    return stockMovementsRepositoryPG;
  }

  getWarehouseReceiptsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Warehouse receipts repository is only available with PostgreSQL');
    }
    return warehouseReceiptsRepositoryPG;
  }

  getOrganizationsRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Organizations repository is only available with PostgreSQL');
    }
    return organizationsRepositoryPG;
  }

  getProfilesRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Profiles repository is only available with PostgreSQL');
    }
    return profilesRepositoryPG;
  }

  getUsersRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Users repository is only available with PostgreSQL');
    }
    return usersRepositoryPG;
  }

  getInquiriesRepository() {
    if (!this.usePostgreSQL) {
      throw new Error('Inquiries repository is only available with PostgreSQL');
    }
    return inquiriesRepositoryPG;
  }

  /**
   * Универсальный метод для получения репозитория по имени
   */
  getRepository(name) {
    const repositories = {
      products: this.getProductsRepository(),
      orders: this.getOrdersRepository(),
      suppliers: this.getSuppliersRepository(),
      warehouses: this.getWarehousesRepository(),
      integrations: this.getIntegrationsRepository(),
      supplier_stocks: this.getSupplierStocksRepository(),
      brands: this.getBrandsRepository(),
      categories: this.getCategoriesRepository(),
      category_mappings: this.getCategoryMappingsRepository(),
      warehouse_mappings: this.getWarehouseMappingsRepository(),
      cache_entries: this.getCacheEntriesRepository(),
      stock_movements: this.getStockMovementsRepository(),
      warehouse_receipts: this.getWarehouseReceiptsRepository(),
      organizations: this.getOrganizationsRepository(),
      profiles: this.getProfilesRepository(),
      users: this.getUsersRepository(),
      inquiries: this.getInquiriesRepository(),
      certificates: this.getCertificatesRepository()
    };
    
    return repositories[name] || null;
  }
  
  /**
   * Проверить, используется ли PostgreSQL
   */
  isUsingPostgreSQL() {
    return this.usePostgreSQL;
  }
}

export default new RepositoryFactory();


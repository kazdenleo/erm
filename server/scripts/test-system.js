/**
 * System Test Script
 * Скрипт для тестирования работы системы с PostgreSQL
 */

import repositoryFactory from '../src/config/repository-factory.js';
import { query } from '../src/config/database.js';
import { isRedisAvailable } from '../src/config/redis.js';

console.log('========================================');
console.log('  ТЕСТИРОВАНИЕ СИСТЕМЫ');
console.log('========================================\n');

async function testDatabaseConnection() {
  console.log('1. Тестирование подключения к PostgreSQL...');
  try {
    const result = await query('SELECT version()');
    console.log('   ✓ Подключение к PostgreSQL успешно');
    console.log(`   ✓ Версия: ${result.rows[0].version.split(' ')[0]} ${result.rows[0].version.split(' ')[1]}`);
    return true;
  } catch (error) {
    console.error('   ✗ Ошибка подключения к PostgreSQL:', error.message);
    return false;
  }
}

async function testRepositories() {
  console.log('\n2. Тестирование репозиториев...');
  const results = {
    products: false,
    orders: false,
    suppliers: false,
    warehouses: false,
    integrations: false,
    supplier_stocks: false,
    brands: false,
    categories: false,
    category_mappings: false,
    warehouse_mappings: false,
    cache_entries: false
  };

  try {
    // Products
    const productsRepo = repositoryFactory.getProductsRepository();
    const products = await productsRepo.findAll({ limit: 1 });
    results.products = true;
    console.log(`   ✓ Products repository: ${products.length} записей (тест)`);

    // Orders
    const ordersRepo = repositoryFactory.getOrdersRepository();
    const orders = await ordersRepo.findAll({ limit: 1 });
    results.orders = true;
    console.log(`   ✓ Orders repository: ${orders.length} записей (тест)`);

    // Suppliers
    const suppliersRepo = repositoryFactory.getSuppliersRepository();
    const suppliers = await suppliersRepo.findAll({ limit: 1 });
    results.suppliers = true;
    console.log(`   ✓ Suppliers repository: ${suppliers.length} записей (тест)`);

    // Warehouses
    const warehousesRepo = repositoryFactory.getWarehousesRepository();
    const warehouses = await warehousesRepo.findAll({ limit: 1 });
    results.warehouses = true;
    console.log(`   ✓ Warehouses repository: ${warehouses.length} записей (тест)`);

    // Integrations
    const integrationsRepo = repositoryFactory.getIntegrationsRepository();
    const integrations = await integrationsRepo.findAll({ limit: 1 });
    results.integrations = true;
    console.log(`   ✓ Integrations repository: ${integrations.length} записей (тест)`);

    // Supplier Stocks
    if (repositoryFactory.isUsingPostgreSQL()) {
      const supplierStocksRepo = repositoryFactory.getSupplierStocksRepository();
      const stocks = await supplierStocksRepo.findAll({ limit: 1 });
      results.supplier_stocks = true;
      console.log(`   ✓ Supplier Stocks repository: ${stocks.length} записей (тест)`);

      // Brands
      const brandsRepo = repositoryFactory.getBrandsRepository();
      const brands = await brandsRepo.findAll({ limit: 1 });
      results.brands = true;
      console.log(`   ✓ Brands repository: ${brands.length} записей (тест)`);

      // Categories
      const categoriesRepo = repositoryFactory.getCategoriesRepository();
      const categories = await categoriesRepo.findAll({ limit: 1 });
      results.categories = true;
      console.log(`   ✓ Categories repository: ${categories.length} записей (тест)`);

      // Category Mappings
      const categoryMappingsRepo = repositoryFactory.getCategoryMappingsRepository();
      const categoryMappings = await categoryMappingsRepo.findAll({ limit: 1 });
      results.category_mappings = true;
      console.log(`   ✓ Category Mappings repository: ${categoryMappings.length} записей (тест)`);

      // Warehouse Mappings
      const warehouseMappingsRepo = repositoryFactory.getWarehouseMappingsRepository();
      const warehouseMappings = await warehouseMappingsRepo.findAll({ limit: 1 });
      results.warehouse_mappings = true;
      console.log(`   ✓ Warehouse Mappings repository: ${warehouseMappings.length} записей (тест)`);

      // Cache Entries
      const cacheEntriesRepo = repositoryFactory.getCacheEntriesRepository();
      const cacheEntries = await cacheEntriesRepo.findAll({ limit: 1 });
      results.cache_entries = true;
      console.log(`   ✓ Cache Entries repository: ${cacheEntries.length} записей (тест)`);
    }

    return results;
  } catch (error) {
    console.error('   ✗ Ошибка тестирования репозиториев:', error.message);
    return results;
  }
}

async function testDataCounts() {
  console.log('\n3. Проверка количества данных в БД...');
  try {
    const tables = [
      'products',
      'orders',
      'suppliers',
      'warehouses',
      'supplier_stocks',
      'integrations',
      'brands',
      'categories',
      'category_mappings',
      'warehouse_mappings',
      'cache_entries'
    ];

    for (const table of tables) {
      try {
        const result = await query(`SELECT COUNT(*) as count FROM ${table}`);
        const count = parseInt(result.rows[0].count);
        console.log(`   ✓ ${table}: ${count} записей`);
      } catch (error) {
        console.log(`   ✗ ${table}: ошибка - ${error.message}`);
      }
    }
  } catch (error) {
    console.error('   ✗ Ошибка проверки данных:', error.message);
  }
}

async function testRedis() {
  console.log('\n4. Тестирование Redis...');
  try {
    // Не ждем долго, так как Redis опционален
    const available = await Promise.race([
      isRedisAvailable(),
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]);
    if (available) {
      console.log('   ✓ Redis доступен');
    } else {
      console.log('   ⚠ Redis недоступен (опционально - приложение работает без него)');
    }
    return available;
  } catch (error) {
    console.log('   ⚠ Redis недоступен (опционально - приложение работает без него)');
    return false;
  }
}

async function testRepositoryFactory() {
  console.log('\n5. Проверка фабрики репозиториев...');
  try {
    const usingPG = repositoryFactory.isUsingPostgreSQL();
    console.log(`   ✓ Используется: ${usingPG ? 'PostgreSQL' : 'Файловое хранилище'}`);
    return usingPG;
  } catch (error) {
    console.error('   ✗ Ошибка:', error.message);
    return false;
  }
}

async function testServices() {
  console.log('\n6. Тестирование сервисов...');
  try {
    // Тест products service
    const productsService = await import('../src/services/products.service.js');
    const products = await productsService.default.getAll({ limit: 1 });
    console.log(`   ✓ Products service: работает`);

    // Тест suppliers service
    const suppliersService = await import('../src/services/suppliers.service.js');
    const suppliers = await suppliersService.default.getAll();
    console.log(`   ✓ Suppliers service: работает (${suppliers.length} записей)`);

    // Тест orders service
    const ordersService = await import('../src/services/orders.service.js');
    const orders = await ordersService.default.getAll({ limit: 1 });
    console.log(`   ✓ Orders service: работает`);

    // Тест warehouses service
    const warehousesService = await import('../src/services/warehouses.service.js');
    const warehouses = await warehousesService.default.getAll();
    console.log(`   ✓ Warehouses service: работает (${warehouses.length} записей)`);

    // Тест integrations service
    const integrationsService = await import('../src/services/integrations.service.js');
    const integrations = await integrationsService.default.getAll();
    console.log(`   ✓ Integrations service: работает (${integrations.length} записей)`);

    return true;
  } catch (error) {
    console.error('   ✗ Ошибка тестирования сервисов:', error.message);
    console.error('   Stack:', error.stack);
    return false;
  }
}

async function runTests() {
  const results = {
    database: false,
    repositories: false,
    redis: false,
    factory: false,
    services: false
  };

  // Тест 1: Подключение к БД
  results.database = await testDatabaseConnection();

  // Тест 2: Репозитории
  const repoResults = await testRepositories();
  results.repositories = Object.values(repoResults).every(r => r === true);

  // Тест 3: Количество данных
  await testDataCounts();

  // Тест 4: Redis
  results.redis = await testRedis();

  // Тест 5: Фабрика репозиториев
  results.factory = await testRepositoryFactory();

  // Тест 6: Сервисы
  results.services = await testServices();

  // Итоги
  console.log('\n========================================');
  console.log('  РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ');
  console.log('========================================');
  console.log(`PostgreSQL:     ${results.database ? '✓' : '✗'}`);
  console.log(`Репозитории:    ${results.repositories ? '✓' : '✗'}`);
  console.log(`Redis:          ${results.redis ? '✓' : '⚠ (опционально)'}`);
  console.log(`Фабрика:        ${results.factory ? '✓' : '✗'}`);
  console.log(`Сервисы:        ${results.services ? '✓' : '✗'}`);
  console.log('========================================\n');

  const allCritical = results.database && results.repositories && results.factory && results.services;
  
  if (allCritical) {
    console.log('✓ Все критические компоненты работают!');
    process.exit(0);
  } else {
    console.log('✗ Обнаружены проблемы с критическими компонентами');
    process.exit(1);
  }
}

// Запуск тестов
runTests().catch(error => {
  console.error('\n✗ Критическая ошибка при тестировании:', error);
  process.exit(1);
});


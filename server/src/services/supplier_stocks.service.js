/**
 * Supplier Stocks Service
 * Сервис для работы с остатками поставщиков в PostgreSQL
 */

import repositoryFactory from '../config/repository-factory.js';
import { canonicalSupplierApiCode } from '../repositories/suppliers.repository.pg.js';

async function resolveSupplierByCode(suppliersRepo, supplierRef) {
  const code = canonicalSupplierApiCode(supplierRef);
  if (!code) return null;
  if (typeof suppliersRepo.findByCode === 'function') {
    return suppliersRepo.findByCode(code);
  }
  if (typeof suppliersRepo.findByName === 'function') {
    return suppliersRepo.findByName(supplierRef);
  }
  return null;
}

class SupplierStocksService {
  /**
   * Получить остатки по поставщику и SKU
   */
  async getBySupplierAndProduct(supplierName, sku) {
    const repository = repositoryFactory.getRepository('supplier_stocks');
    if (!repository) {
      throw new Error('Supplier stocks repository not available');
    }

    const suppliersRepo = repositoryFactory.getRepository('suppliers');
    const supplier = await resolveSupplierByCode(suppliersRepo, supplierName);
    if (!supplier) {
      return null;
    }

    // Получаем product_id по SKU
    const productsRepo = repositoryFactory.getRepository('products');
    const product = await productsRepo.findBySku(sku);
    if (!product) {
      return null;
    }

    return await repository.findBySupplierAndProduct(supplier.id, product.id);
  }

  /**
   * Создать или обновить остатки
   */
  async upsert(supplierName, sku, data) {
    const repository = repositoryFactory.getRepository('supplier_stocks');
    if (!repository) {
      throw new Error('Supplier stocks repository not available');
    }

    const suppliersRepo = repositoryFactory.getRepository('suppliers');
    const supplier = await resolveSupplierByCode(suppliersRepo, supplierName);
    if (!supplier) {
      throw new Error(`Supplier ${supplierName} not found`);
    }

    // Получаем product_id по SKU
    const productsRepo = repositoryFactory.getRepository('products');
    const product = await productsRepo.findBySku(sku);
    if (!product) {
      throw new Error(`Product with SKU ${sku} not found`);
    }

    console.log(`[Supplier Stocks Service] Upserting stock: supplier_id=${supplier.id} (type: ${typeof supplier.id}), product_id=${product.id} (type: ${typeof product.id}), sku=${sku}`);

    // Преобразуем ID в числа для правильного сравнения в PostgreSQL
    const supplierId = typeof supplier.id === 'string' ? parseInt(supplier.id, 10) : supplier.id;
    const productId = typeof product.id === 'string' ? parseInt(product.id, 10) : product.id;
    
    console.log(`[Supplier Stocks Service] Upserting stock: supplier_id=${supplierId} (type: ${typeof supplierId}), product_id=${productId} (type: ${typeof productId}), sku=${sku}`);

    const stockData = {
      supplier_id: supplierId,
      product_id: productId,
      stock: data.stock != null ? Number(data.stock) || 0 : 0,
      price:
        data.price != null && data.price !== ''
          ? Number(data.price)
          : null,
      delivery_days: data.deliveryDays || data.delivery_days || 0,
      stock_name: data.stockName || data.stock_name || null,
      source: data.source || 'api',
      warehouses: data.warehouses ? JSON.stringify(data.warehouses) : null,
      cached_at: data.cached_at || new Date()
    };

    return await repository.upsert(stockData);
  }

  /**
   * Получить все остатки по поставщику
   */
  async getBySupplier(supplierName) {
    const repository = repositoryFactory.getRepository('supplier_stocks');
    if (!repository) {
      throw new Error('Supplier stocks repository not available');
    }

    const suppliersRepo = repositoryFactory.getRepository('suppliers');
    const supplier = await resolveSupplierByCode(suppliersRepo, supplierName);
    if (!supplier) {
      return [];
    }

    return await repository.findBySupplier(supplier.id);
  }

  /**
   * Удалить устаревшие кэши (старше указанного времени)
   */
  async deleteOldCache(maxAgeHours = 24) {
    const repository = repositoryFactory.getRepository('supplier_stocks');
    if (!repository) {
      throw new Error('Supplier stocks repository not available');
    }

    return await repository.clearOldCache(maxAgeHours);
  }
}

export default new SupplierStocksService();

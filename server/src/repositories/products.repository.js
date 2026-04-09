/**
 * Products Repository
 * Слой доступа к данным для товаров
 */

import { readData, writeData } from '../utils/storage.js';

class ProductsRepository {
  async getProductIdsGroupedByUserCategory() {
    const products = await this.findAll();
    const out = {};
    for (const p of products) {
      const cid = p.user_category_id ?? p.categoryId;
      if (cid == null || cid === '') continue;
      const k = String(cid);
      if (!out[k]) out[k] = [];
      const id = typeof p.id === 'string' ? parseInt(p.id, 10) : Number(p.id);
      if (Number.isFinite(id)) out[k].push(id);
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a - b);
    }
    return out;
  }

  async findAll() {
    let products = await readData('products');
    if (!Array.isArray(products)) {
      products = products?.products || [];
    }
    return products;
  }

  async findById(id) {
    const products = await this.findAll();
    return products.find(p => String(p.id) === String(id));
  }

  async create(productData) {
    const products = await this.findAll();
    const newProduct = {
      ...productData,
      id: productData.id || Date.now() + Math.random(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    products.push(newProduct);
    await writeData('products', products);
    return newProduct;
  }

  async update(id, updates) {
    const products = await this.findAll();
    const index = products.findIndex(p => String(p.id) === String(id));
    if (index === -1) {
      return null;
    }
    products[index] = {
      ...products[index],
      ...updates,
      id: products[index].id,
      createdAt: products[index].createdAt,
      updatedAt: new Date().toISOString()
    };
    await writeData('products', products);
    return products[index];
  }

  async delete(id) {
    const products = await this.findAll();
    const index = products.findIndex(p => String(p.id) === String(id));
    if (index === -1) {
      return null;
    }
    const deleted = products.splice(index, 1)[0];
    await writeData('products', products);
    return deleted;
  }

  async replaceAll(products) {
    if (!Array.isArray(products)) {
      throw new Error('Expected products array');
    }
    await writeData('products', products);
    return { count: products.length };
  }
}

export default new ProductsRepository();



/**
 * Certificates Repository (file storage)
 */

import { readData, writeData } from '../utils/storage.js';

function matchesProfile(item, profileId) {
  if (profileId == null || profileId === '') return true;
  return Number(item?.profile_id ?? item?.profileId) === Number(profileId);
}

function normalizeIdList(raw) {
  const arr = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
  return arr
    .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
    .filter((n) => Number.isFinite(n) && n > 0);
}

class CertificatesRepository {
  async findAll(options = {}) {
    const list = await readData('certificates');
    const arr = Array.isArray(list) ? list : [];
    const profileId = options.profileId ?? options.profile_id;
    let filtered = arr.filter((c) => matchesProfile(c, profileId));
    const brandId = options.brandId ?? options.brand_id;
    if (brandId != null && brandId !== '') {
      filtered = filtered.filter((c) => String(c.brand_id) === String(brandId));
    }
    const productId = options.productId ?? options.product_id;
    if (productId != null && productId !== '') {
      filtered = filtered.filter((c) => {
        const ids = normalizeIdList(c.product_ids ?? c.productIds);
        return ids.some((id) => String(id) === String(productId));
      });
    }
    return filtered;
  }

  async findById(id, options = {}) {
    const list = await this.findAll(options);
    return list.find((c) => String(c.id) === String(id)) || null;
  }

  async create(data) {
    const list = await readData('certificates');
    const all = Array.isArray(list) ? list : [];
    const now = new Date().toISOString();
    const productIds = normalizeIdList(data.product_ids ?? data.productIds);
    const categoryIds = normalizeIdList(
      data.user_category_ids ??
        data.userCategoryIds ??
        (data.user_category_id != null ? [data.user_category_id] : [])
    );
    const item = {
      id: Date.now().toString(),
      certificate_number: String(data.certificate_number || '').trim(),
      brand_id: data.brand_id ?? null,
      user_category_id: data.user_category_id ?? categoryIds[0] ?? null,
      user_category_ids: categoryIds,
      product_ids: productIds,
      products: productIds.map((id) => ({ id, sku: null, name: null })),
      document_type: data.document_type || 'certificate',
      photo_url: data.photo_url ?? null,
      valid_from: data.valid_from || null,
      valid_to: data.valid_to || null,
      profile_id: data.profile_id ?? data.profileId ?? null,
      created_at: now,
      updated_at: now,
    };
    all.push(item);
    const ok = await writeData('certificates', all);
    if (!ok) throw new Error('Не удалось сохранить сертификат');
    return item;
  }

  async update(id, updates, options = {}) {
    const list = await readData('certificates');
    const all = Array.isArray(list) ? list : [];
    const profileId = options.profileId ?? options.profile_id;
    const idx = all.findIndex((c) => String(c.id) === String(id) && matchesProfile(c, profileId));
    if (idx === -1) return null;
    const next = { ...all[idx], ...updates, updated_at: new Date().toISOString() };
    if (
      Object.prototype.hasOwnProperty.call(updates, 'product_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'productIds')
    ) {
      const productIds = normalizeIdList(updates.product_ids ?? updates.productIds);
      next.product_ids = productIds;
      next.products = productIds.map((pid) => ({ id: pid, sku: null, name: null }));
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'user_category_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'userCategoryIds')
    ) {
      const categoryIds = normalizeIdList(updates.user_category_ids ?? updates.userCategoryIds);
      next.user_category_ids = categoryIds;
      next.user_category_id = categoryIds[0] ?? null;
    }
    all[idx] = next;
    const ok = await writeData('certificates', all);
    if (!ok) throw new Error('Не удалось обновить сертификат');
    return all[idx];
  }

  async delete(id, options = {}) {
    const list = await readData('certificates');
    const all = Array.isArray(list) ? list : [];
    const profileId = options.profileId ?? options.profile_id;
    const next = all.filter((c) => !(String(c.id) === String(id) && matchesProfile(c, profileId)));
    if (next.length === all.length) return false;
    const ok = await writeData('certificates', next);
    if (!ok) throw new Error('Не удалось удалить сертификат');
    return true;
  }

  async findProductsWithoutCertificate() {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
}

export default new CertificatesRepository();

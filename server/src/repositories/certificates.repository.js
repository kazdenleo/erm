/**
 * Certificates Repository (file storage)
 */

import { readData, writeData } from '../utils/storage.js';

class CertificatesRepository {
  async findAll() {
    const list = await readData('certificates');
    return Array.isArray(list) ? list : [];
  }

  async findById(id) {
    const list = await this.findAll();
    return list.find((c) => String(c.id) === String(id)) || null;
  }

  async create(data) {
    const list = await this.findAll();
    const now = new Date().toISOString();
    const categoryIds = Array.isArray(data.user_category_ids)
      ? data.user_category_ids
          .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
          .filter((n) => Number.isFinite(n) && n > 0)
      : (data.user_category_id != null ? [Number(data.user_category_id)] : []);
    const item = {
      id: Date.now().toString(),
      certificate_number: String(data.certificate_number || '').trim(),
      brand_id: data.brand_id ?? null,
      user_category_id: data.user_category_id ?? null,
      user_category_ids: categoryIds,
      document_type: data.document_type || 'certificate',
      photo_url: data.photo_url ?? null,
      valid_from: data.valid_from ?? null,
      valid_to: data.valid_to ?? null,
      created_at: now,
      updated_at: now,
    };
    list.push(item);
    const ok = await writeData('certificates', list);
    if (!ok) throw new Error('Не удалось сохранить сертификат');
    return item;
  }

  async update(id, updates) {
    const list = await this.findAll();
    const idx = list.findIndex((c) => String(c.id) === String(id));
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...updates, updated_at: new Date().toISOString() };
    const ok = await writeData('certificates', list);
    if (!ok) throw new Error('Не удалось обновить сертификат');
    return list[idx];
  }

  async delete(id) {
    const list = await this.findAll();
    const next = list.filter((c) => String(c.id) !== String(id));
    if (next.length === list.length) return false;
    const ok = await writeData('certificates', next);
    if (!ok) throw new Error('Не удалось удалить сертификат');
    return true;
  }
}

export default new CertificatesRepository();


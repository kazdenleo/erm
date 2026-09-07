/**
 * Certificates Repository (file storage)
 */

import { readData, writeData } from '../utils/storage.js';

function matchesProfile(item, profileId) {
  if (profileId == null || profileId === '') return true;
  return Number(item?.profile_id ?? item?.profileId) === Number(profileId);
}

class CertificatesRepository {
  async findAll(options = {}) {
    const list = await readData('certificates');
    const arr = Array.isArray(list) ? list : [];
    const profileId = options.profileId ?? options.profile_id;
    return arr.filter((c) => matchesProfile(c, profileId));
  }

  async findById(id, options = {}) {
    const list = await this.findAll(options);
    return list.find((c) => String(c.id) === String(id)) || null;
  }

  async create(data) {
    const list = await readData('certificates');
    const all = Array.isArray(list) ? list : [];
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
    all[idx] = { ...all[idx], ...updates, updated_at: new Date().toISOString() };
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
}

export default new CertificatesRepository();

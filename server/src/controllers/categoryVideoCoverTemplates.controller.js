/**
 * HTTP: шаблоны видеообложки Ozon (категория / общий)
 */

import { categoryVideoCoverTemplatesRepository } from '../repositories/categoryVideoCoverTemplates.repository.pg.js';
import {
  defaultVideoCoverSettings,
  normalizeVideoCoverSettings,
} from '../utils/videoCoverTemplate.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { query } from '../config/database.js';

function requireProfileId(tid) {
  if (tid === TENANT_LIST_EMPTY) {
    const err = new Error('Нет доступа');
    err.statusCode = 403;
    throw err;
  }
  if (tid == null) {
    const err = new Error('Общий шаблон доступен в рамках профиля');
    err.statusCode = 400;
    throw err;
  }
  return tid;
}

function emptySharedTemplate() {
  return {
    user_category_id: null,
    category_name: 'Общий шаблон',
    shared: true,
    settings: defaultVideoCoverSettings(),
  };
}

async function assertCategoryBelongsToProfile(categoryId, profileId) {
  const result = await query(
    'SELECT id, profile_id, name FROM user_categories WHERE id = $1::bigint',
    [categoryId]
  );
  if (!result.rows.length) {
    const err = new Error('Категория не найдена');
    err.statusCode = 404;
    throw err;
  }
  const row = result.rows[0];
  if (profileId != null && row.profile_id != null && String(row.profile_id) !== String(profileId)) {
    const err = new Error('Категория не найдена');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

class CategoryVideoCoverTemplatesController {
  async getAll(req, res) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY) {
      return res.json({ success: true, data: [] });
    }
    const list = await categoryVideoCoverTemplatesRepository.findAllByProfile(tid);
    res.json({ success: true, data: list });
  }

  async getShared(req, res) {
    const tid = requireProfileId(tenantListProfileId(req));
    const row = await categoryVideoCoverTemplatesRepository.findSharedByProfile(tid);
    res.json({ success: true, data: row || emptySharedTemplate() });
  }

  async upsertShared(req, res) {
    const tid = requireProfileId(tenantListProfileId(req));
    const settings = normalizeVideoCoverSettings(req.body?.settings);
    const row = await categoryVideoCoverTemplatesRepository.upsertShared({
      profileId: tid,
      settings,
    });
    res.json({ success: true, data: row });
  }

  async deleteShared(req, res) {
    const tid = requireProfileId(tenantListProfileId(req));
    await categoryVideoCoverTemplatesRepository.deleteShared(tid);
    res.json({ success: true, data: emptySharedTemplate() });
  }

  async getByCategoryId(req, res) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY) {
      const err = new Error('Нет доступа');
      err.statusCode = 403;
      throw err;
    }
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      const err = new Error('Некорректный id категории');
      err.statusCode = 400;
      throw err;
    }
    const cat = await assertCategoryBelongsToProfile(categoryId, tid);
    // Только свой шаблон категории (без подмешивания общего) — для редактора.
    const row = await categoryVideoCoverTemplatesRepository.findByCategoryId(categoryId, tid);
    res.json({
      success: true,
      data: row || {
        user_category_id: categoryId,
        category_name: cat?.name || null,
        settings: defaultVideoCoverSettings(),
        source: 'default',
        saved: false,
      },
      saved: Boolean(row),
    });
  }

  async upsert(req, res) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY) {
      const err = new Error('Нет доступа');
      err.statusCode = 403;
      throw err;
    }
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      const err = new Error('Некорректный id категории');
      err.statusCode = 400;
      throw err;
    }
    await assertCategoryBelongsToProfile(categoryId, tid);
    const settings = normalizeVideoCoverSettings(req.body?.settings);
    const row = await categoryVideoCoverTemplatesRepository.upsert({
      userCategoryId: categoryId,
      profileId: tid,
      settings,
    });
    res.json({ success: true, data: row });
  }

  async delete(req, res) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY) {
      const err = new Error('Нет доступа');
      err.statusCode = 403;
      throw err;
    }
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      const err = new Error('Некорректный id категории');
      err.statusCode = 400;
      throw err;
    }
    await assertCategoryBelongsToProfile(categoryId, tid);
    await categoryVideoCoverTemplatesRepository.deleteByCategoryId(categoryId, tid);
    res.json({ success: true });
  }
}

export default new CategoryVideoCoverTemplatesController();

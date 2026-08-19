/**
 * HTTP: шаблоны Rich-контента по категориям
 */

import { categoryRichContentTemplatesRepository } from '../repositories/categoryRichContentTemplates.repository.pg.js';
import {
  defaultRichContentModules,
  normalizeRichContentModules,
  syncCharacteristicsFields,
} from '../utils/richContentTemplate.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { query } from '../config/database.js';
import integrationsService from '../services/integrations.service.js';
import {
  parseUserCategoryMarketplaceMappings,
  extractOzonDescTypeForCache,
} from '../services/productsExport.service.js';
import { shouldSkipOzonAttrForRichTable } from '../utils/marketplaceRichContent.js';

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
    modules: defaultRichContentModules(),
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

async function loadCategoryMpAttributes(categoryId, marketplace) {
  const r = await query(`SELECT marketplace_mappings FROM user_categories WHERE id = $1`, [categoryId]);
  const mm = parseUserCategoryMarketplaceMappings(r.rows[0]?.marketplace_mappings);
  if (marketplace === 'wb') {
    const m = String(mm?.wb ?? mm?.wb_subject_id ?? '').trim().match(/^(\d+)/);
    const subjectId = m ? Number(m[1]) : 0;
    if (!subjectId) return [];
    const list = await integrationsService.getWildberriesCategoryAttributes(subjectId, {});
    return Array.isArray(list) ? list : [];
  }
  if (marketplace === 'ym') {
    const catId = String(mm?.ym ?? mm?.yandex ?? '').trim();
    if (!/^\d+$/.test(catId)) return [];
    const list = await integrationsService.getYandexCategoryContentParameters(catId, {});
    return Array.isArray(list) ? list : [];
  }
  const { descId, typeId } = extractOzonDescTypeForCache(mm || {});
  if (descId <= 0 || typeId <= 0) return [];
  const list = await integrationsService.getOzonCategoryAttributes(descId, typeId, {});
  return Array.isArray(list) ? list : [];
}

function attrKeyName(item) {
  const id = item?.id ?? item?.attribute_id ?? item?.charcID ?? item?.characteristic_id ?? item?.parameterId;
  const name = item?.name ?? item?.charcName ?? item?.characteristic_name ?? item?.parameterName ?? '';
  return {
    key: id != null ? String(id) : String(name),
    label: String(name || id || '').trim(),
    required: Boolean(item?.is_required ?? item?.required),
  };
}

class CategoryRichContentTemplatesController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const data = await categoryRichContentTemplatesRepository.findAllByProfile(tid);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getByCategoryId(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      const categoryId = Number(req.params.categoryId);
      if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id категории' });
      }
      const cat = await assertCategoryBelongsToProfile(categoryId, tid);
      const own = await categoryRichContentTemplatesRepository.findByCategoryId(categoryId, tid);
      if (own) {
        return res.status(200).json({ ok: true, data: own, saved: true, source: 'category' });
      }
      return res.status(200).json({
        ok: true,
        data: {
          user_category_id: categoryId,
          category_name: cat.name,
          modules: defaultRichContentModules(),
        },
        saved: false,
        source: 'default',
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async upsert(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      const categoryId = Number(req.params.categoryId);
      if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id категории' });
      }
      await assertCategoryBelongsToProfile(categoryId, tid);
      const template = await categoryRichContentTemplatesRepository.upsert({
        userCategoryId: categoryId,
        profileId: tid,
        modules: normalizeRichContentModules(req.body?.modules),
      });
      return res.status(200).json({ ok: true, data: template });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async syncFields(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      const categoryId = Number(req.params.categoryId);
      if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id категории' });
      }
      await assertCategoryBelongsToProfile(categoryId, tid);
      const marketplace = String(req.body?.marketplace || req.query?.marketplace || 'ozon').toLowerCase();
      const mp = ['ozon', 'wb', 'ym'].includes(marketplace) ? marketplace : 'ozon';
      let attrs = [];
      try {
        attrs = await loadCategoryMpAttributes(categoryId, mp);
      } catch {
        attrs = [];
      }
      const available = attrs
        .map(attrKeyName)
        .filter((f) => f.key && f.label && !shouldSkipOzonAttrForRichTable(f.key, f.label));
      const current = Array.isArray(req.body?.modules)
        ? req.body.modules
        : (await categoryRichContentTemplatesRepository.findByCategoryId(categoryId, tid))?.modules;
      const modules = syncCharacteristicsFields(current, available);
      return res.status(200).json({
        ok: true,
        data: { modules, available },
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async getShared(req, res, next) {
    try {
      const tid = requireProfileId(tenantListProfileId(req));
      const template = await categoryRichContentTemplatesRepository.findSharedByProfile(tid);
      return res.status(200).json({
        ok: true,
        data: template || emptySharedTemplate(),
        saved: Boolean(template),
        source: template ? 'shared' : 'default',
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async upsertShared(req, res, next) {
    try {
      const tid = requireProfileId(tenantListProfileId(req));
      const template = await categoryRichContentTemplatesRepository.upsertShared({
        profileId: tid,
        modules: normalizeRichContentModules(req.body?.modules),
      });
      return res.status(200).json({ ok: true, data: template, source: 'shared' });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async unify(req, res, next) {
    try {
      const tid = requireProfileId(tenantListProfileId(req));
      const template = await categoryRichContentTemplatesRepository.upsertShared({
        profileId: tid,
        modules: normalizeRichContentModules(req.body?.modules),
      });
      const removed = await categoryRichContentTemplatesRepository.deleteAllCategoryTemplates(tid);
      return res.status(200).json({
        ok: true,
        data: template,
        source: 'shared',
        removedCategoryTemplates: removed,
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async deleteShared(req, res, next) {
    try {
      const tid = requireProfileId(tenantListProfileId(req));
      const deleted = await categoryRichContentTemplatesRepository.deleteSharedByProfile(tid);
      return res.status(200).json({ ok: true, deleted });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      const categoryId = Number(req.params.categoryId);
      if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id категории' });
      }
      await assertCategoryBelongsToProfile(categoryId, tid);
      const deleted = await categoryRichContentTemplatesRepository.deleteByCategoryId(categoryId, tid);
      return res.status(200).json({ ok: true, deleted });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async uploadBackground(req, res, next) {
    try {
      const filename = req.file?.filename || '';
      if (!filename) {
        return res.status(400).json({ ok: false, message: 'Файл не получен. Отправьте изображение в поле file.' });
      }
      return res.status(200).json({
        ok: true,
        data: { url: `/uploads/rich-content/${filename}` },
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new CategoryRichContentTemplatesController();

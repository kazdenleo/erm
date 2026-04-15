/**
 * User Categories Controller
 * HTTP контроллер для пользовательских категорий
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from '../services/integrations.service.js';
import { resolveOzonDescTypePair } from '../services/productsExport.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

/** Нормализация JSONB marketplace_mappings (иногда приходит строкой). */
function parseMarketplaceMappings(raw) {
  let mm = raw;
  if (mm == null) return {};
  if (typeof mm === 'string') {
    try {
      mm = JSON.parse(mm || '{}');
    } catch (_) {
      mm = {};
    }
  }
  if (typeof mm !== 'object' || Array.isArray(mm)) return {};
  return mm;
}

class UserCategoriesController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const params = [];
      let profileFilter = '';
      if (tid != null) {
        profileFilter = `WHERE EXISTS (
          SELECT 1 FROM products p WHERE p.user_category_id = uc.id AND p.profile_id = $1::bigint
        )`;
        params.push(tid);
      }
      const result = await query(
        `SELECT uc.*,
         COALESCE(
           (SELECT json_agg(ca.attribute_id) FROM category_attributes ca WHERE ca.user_category_id = uc.id),
           '[]'::json
         ) AS attribute_ids
         FROM user_categories uc ${profileFilter} ORDER BY uc.name`,
        params
      );
      const rows = (result.rows || []).map((row) => {
        let ids = row.attribute_ids;
        if (ids == null) ids = [];
        if (typeof ids === 'string') ids = JSON.parse(ids);
        if (!Array.isArray(ids)) ids = [];
        const { attribute_ids, ...rest } = row;
        return { ...rest, attribute_ids: ids };
      });
      return res.status(200).json({ ok: true, data: rows });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const result = await query(
        'SELECT * FROM user_categories WHERE id = $1',
        [id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      
      const category = result.rows[0];
      const attrResult = await query(
        'SELECT attribute_id FROM category_attributes WHERE user_category_id = $1',
        [id]
      );
      category.attribute_ids = (attrResult.rows || []).map((r) => r.attribute_id);

      const mm = parseMarketplaceMappings(category.marketplace_mappings);
      category.marketplace_mappings = mm;

      // Обогащение Ozon: если сохранён только уровень категории (ozon без "_"), но есть ozon_display —
      // ищем в таблице categories тип товара по пути и подставляем description_category_id + type_id,
      // чтобы в карточке товара подтягивались атрибуты Ozon.
      if (mm.ozon != null && String(mm.ozon).indexOf('_') === -1 && mm.ozon_display) {
        const pathNorm = String(mm.ozon_display).replace(/\s*[›>]\s*/g, ' > ').replace(/\s+/g, ' ').trim();
        if (pathNorm) {
          try {
            const typeRow = await query(
              `SELECT marketplace_category_id AS id FROM categories
               WHERE marketplace = 'ozon'
                 AND marketplace_category_id::text LIKE '%\_%'
                 AND TRIM(REPLACE(REPLACE(REPLACE(COALESCE(path,''), ' › ', ' > '), '›', ' > '), '  ', ' ')) = $1
               LIMIT 1`,
              [pathNorm]
            );
            if (typeRow?.rows?.length > 0) {
              const compositeId = String(typeRow.rows[0].id);
              const idx = compositeId.indexOf('_');
              if (idx > 0) {
                const descId = compositeId.slice(0, idx).trim();
                const typeId = compositeId.slice(idx + 1).trim();
                mm.ozon = compositeId;
                mm.ozon_description_category_id = descId ? Number(descId) || descId : null;
                mm.ozon_type_id = typeId ? Number(typeId) || null : null;
                logger.debug('[User Categories] Enriched Ozon type from path', { categoryId: id, path: pathNorm, compositeId, ozon_type_id: mm.ozon_type_id });
              }
            }
          } catch (err) {
            logger.debug('[User Categories] Ozon type lookup by path failed', { categoryId: id, path: pathNorm, message: err?.message });
          }
        }
      }

      return res.status(200).json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/user-categories/:id/marketplace-attributes
   * Вернуть атрибуты маркетплейса по сопоставлению из user_categories.marketplace_mappings
   * Query:
   * - marketplace: 'ozon'|'wb'|'ym' (обязательно)
   * - force_refresh=1|true (опционально)
   */
  async getMarketplaceAttributes(req, res, next) {
    try {
      const { id } = req.params;
      const marketplace = String(req.query.marketplace || '').trim().toLowerCase();
      const forceRefresh = req.query.force_refresh === '1' || req.query.force_refresh === 'true' || req.query.force === '1' || req.query.force === 'true';

      if (!marketplace || !['ozon', 'wb', 'ym'].includes(marketplace)) {
        return res.status(400).json({ ok: false, error: 'Укажите marketplace: ozon|wb|ym' });
      }

      const result = await query('SELECT id, marketplace_mappings FROM user_categories WHERE id = $1', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Категория не найдена' });
      }

      const mm = parseMarketplaceMappings(result.rows[0].marketplace_mappings);

      if (marketplace === 'ozon') {
        // Поддерживаем форматы:
        // - mm.ozon = "descId_typeId"
        // - mm.ozon_description_category_id + mm.ozon_type_id
        // - mm.ozonDescriptionCategoryId + mm.ozonTypeId (исторические/фронтовые ключи)
        const composite = mm.ozon != null ? String(mm.ozon).trim() : '';
        const descIdFromFields =
          mm.ozon_description_category_id ??
          mm.ozonDescriptionCategoryId ??
          mm.ozon_descriptionCategoryId ??
          null;
        const typeIdFromFields =
          mm.ozon_type_id ??
          mm.ozonTypeId ??
          mm.ozon_typeId ??
          null;

        let descId = descIdFromFields != null ? Number(descIdFromFields) : 0;
        let typeId = typeIdFromFields != null ? Number(typeIdFromFields) : 0;

        if ((!descId || !typeId) && composite && composite.includes('_')) {
          const [a, b] = composite.split('_');
          const d = Number(String(a || '').trim());
          const t = Number(String(b || '').trim());
          if (Number.isFinite(d) && d > 0) descId = d;
          if (Number.isFinite(t) && t > 0) typeId = t;
        }

        if (!descId || !typeId) {
          let flatOzon = [];
          try {
            flatOzon = await integrationsService.getOzonCategories({ dbOnly: true });
            if (!flatOzon.length) {
              flatOzon = await integrationsService.getOzonCategories({ forceRefresh: false });
            }
          } catch (e) {
            logger.warn('[User Categories] marketplace-attributes: flat Ozon categories', e?.message);
          }
          const pair = resolveOzonDescTypePair(mm, flatOzon);
          if (pair.descId > 0) descId = pair.descId;
          if (pair.typeId > 0) typeId = pair.typeId;
        }

        if (!descId || !typeId) {
          return res.status(400).json({
            ok: false,
            error: 'Для Ozon не задан тип товара. В сопоставлении категории сохраните Ozon как "descId_typeId" (тип товара).'
          });
        }

        const list = await integrationsService.getOzonCategoryAttributes(descId, typeId, { forceRefresh });
        return res.status(200).json({
          ok: true,
          data: Array.isArray(list) ? list : [],
          ozon_pair: { description_category_id: descId, type_id: typeId }
        });
      }

      if (marketplace === 'wb') {
        const subjectIdRaw =
          mm?.wb ??
          mm?.wb_subject_id ??
          mm?.wbSubjectId ??
          null;
        const subjectId = subjectIdRaw != null ? Number(subjectIdRaw) : 0;
        if (!subjectId || subjectId <= 0) {
          return res.status(400).json({ ok: false, error: 'Для WB не задан subjectId в сопоставлении категории (marketplace_mappings.wb).' });
        }
        const list = await integrationsService.getWildberriesCategoryAttributes(subjectId, { forceRefresh });
        return res.status(200).json({ ok: true, data: Array.isArray(list) ? list : [] });
      }

      if (marketplace === 'ym') {
        const ymIdRaw = mm?.ym ?? mm?.yandex ?? null;
        const ymCategoryIdStr = ymIdRaw != null ? String(ymIdRaw).trim().replace(/\s+/g, '') : '';
        if (!ymCategoryIdStr || !/^\d+$/.test(ymCategoryIdStr)) {
          return res.status(400).json({
            ok: false,
            error: 'Для Яндекс.Маркета не задан id категории в сопоставлении (marketplace_mappings.ym). Выберите листовую категорию Маркета в настройках категории ERP.'
          });
        }
        try {
          const list = await integrationsService.getYandexCategoryContentParameters(ymCategoryIdStr, { forceRefresh });
          return res.status(200).json({ ok: true, data: Array.isArray(list) ? list : [] });
        } catch (e) {
          logger.warn('[User Categories] Yandex category parameters failed', { userCategoryId: id, ymCategoryId: ymCategoryIdStr, err: e?.message });
          return res.status(502).json({
            ok: false,
            error: e?.message || 'Не удалось загрузить характеристики категории Яндекс.Маркета.'
          });
        }
      }

      const mappedId = mm?.[marketplace] ?? null;
      logger.debug('[User Categories] marketplace-attributes unknown marketplace', { userCategoryId: id, marketplace, mappedId });
      return res.status(400).json({ ok: false, error: `Неизвестный marketplace: ${marketplace}` });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { name, description, parent_id, attribute_ids, certificate_number, certificate_valid_from, certificate_valid_to } = req.body;
      
      if (!name) {
        return res.status(400).json({ ok: false, message: 'Название категории обязательно' });
      }
      
      const result = await query(
        `INSERT INTO user_categories (name, description, parent_id, certificate_number, certificate_valid_from, certificate_valid_to)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          name,
          description || null,
          parent_id || null,
          certificate_number || null,
          certificate_valid_from || null,
          certificate_valid_to || null
        ]
      );
      
      const category = result.rows[0];
      const ids = Array.isArray(attribute_ids) ? attribute_ids : [];
      for (const aid of ids) {
        const numId = typeof aid === 'number' ? aid : parseInt(aid, 10);
        if (numId && !isNaN(numId)) {
          await query(
            'INSERT INTO category_attributes (user_category_id, attribute_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [category.id, numId]
          );
        }
      }
      category.attribute_ids = ids.map((aid) => (typeof aid === 'number' ? aid : parseInt(aid, 10))).filter((n) => !isNaN(n) && n > 0);
      
      return res.status(201).json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, parent_id, marketplace_mappings, attribute_ids, certificate_number, certificate_valid_from, certificate_valid_to } = req.body;
      
      const updateFields = [];
      const params = [];
      let paramIndex = 1;
      
      if (name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`);
        params.push(name);
      }
      
      if (description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        params.push(description);
      }
      
      if (parent_id !== undefined) {
        updateFields.push(`parent_id = $${paramIndex++}`);
        params.push(parent_id);
      }
      
      if (marketplace_mappings !== undefined) {
        const mm = typeof marketplace_mappings === 'object' && marketplace_mappings !== null ? marketplace_mappings : {};
        const normalized = {
          ...mm,
          wb: mm.wb != null ? mm.wb : null,
          ozon: mm.ozon != null ? String(mm.ozon) : null,
          ym: mm.ym != null ? mm.ym : null,
          ...(mm.ozon_display != null ? { ozon_display: mm.ozon_display } : {}),
          ...(mm.ozon_description_category_id != null ? { ozon_description_category_id: mm.ozon_description_category_id } : {}),
          ...(mm.ozon_type_id != null ? { ozon_type_id: mm.ozon_type_id } : {})
        };
        updateFields.push(`marketplace_mappings = $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(normalized));
      }

      if (certificate_number !== undefined) {
        updateFields.push(`certificate_number = $${paramIndex++}`);
        params.push(certificate_number || null);
      }

      if (certificate_valid_from !== undefined) {
        updateFields.push(`certificate_valid_from = $${paramIndex++}`);
        params.push(certificate_valid_from || null);
      }

      if (certificate_valid_to !== undefined) {
        updateFields.push(`certificate_valid_to = $${paramIndex++}`);
        params.push(certificate_valid_to || null);
      }
      
      if (updateFields.length === 0 && attribute_ids === undefined) {
        return res.status(400).json({ ok: false, message: 'Нет полей для обновления' });
      }
      
      if (updateFields.length > 0) {
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
        params.push(id);
        const result = await query(
          `UPDATE user_categories SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
          params
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ ok: false, message: 'Категория не найдена' });
        }
      }
      
      if (attribute_ids !== undefined) {
        await query('DELETE FROM category_attributes WHERE user_category_id = $1', [id]);
        const ids = Array.isArray(attribute_ids) ? attribute_ids : [];
        for (const aid of ids) {
          const numId = typeof aid === 'number' ? aid : parseInt(aid, 10);
          if (numId && !isNaN(numId)) {
            await query(
              'INSERT INTO category_attributes (user_category_id, attribute_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [id, numId]
            );
          }
        }
      }
      
      const catResult = await query('SELECT * FROM user_categories WHERE id = $1', [id]);
      if (catResult.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      const category = catResult.rows[0];
      const attrResult = await query(
        'SELECT attribute_id FROM category_attributes WHERE user_category_id = $1',
        [id]
      );
      category.attribute_ids = (attrResult.rows || []).map((r) => r.attribute_id);
      
      return res.status(200).json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const result = await query(
        'DELETE FROM user_categories WHERE id = $1 RETURNING id',
        [id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      
      return res.status(200).json({ ok: true, message: 'Категория удалена' });
    } catch (error) {
      next(error);
    }
  }
}

export default new UserCategoriesController();


/**
 * Product Attributes Controller
 * Атрибуты товаров и привязка к категориям
 */

import { query } from '../config/database.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { normalizeMpLinks } from '../utils/attributeMpLinks.js';
import { COMPUTED_ATTR_TYPE, isSystemPriceAttrKey, validateFormula } from '../utils/attributeFormula.js';
import {
  EDITABLE_ATTR_TYPE,
  normalizeShowRelatedFields,
} from '../utils/editableAttribute.js';
import {
  isSystemCardAttrKey,
  isSystemMainFieldAttrKey,
} from '../utils/systemMainFieldAttributes.js';

const VALID_TYPES = [
  'text',
  'checkbox',
  'number',
  'date',
  'dictionary',
  COMPUTED_ATTR_TYPE,
  EDITABLE_ATTR_TYPE,
];

function normalizeFormula(type, formula) {
  if (type !== COMPUTED_ATTR_TYPE) return null;
  const src = formula == null ? '' : String(formula).trim();
  return src;
}

class ProductAttributesController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      // Таблица product_attributes — общий справочник (без profile_id). Разделение по аккаунтам — в
      // product_attribute_values через products.profile_id. Старый фильтр «только уже используемые у
      // этого профиля» скрывал только что созданные атрибуты до привязки к категории/товару.
      const result = await query(
        `SELECT * FROM product_attributes
         ORDER BY
           CASE WHEN system_key IS NULL OR btrim(system_key) = '' THEN 1 ELSE 0 END,
           name`
      );
      return res.status(200).json({ ok: true, data: result.rows || [] });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const result = await query(
        'SELECT * FROM product_attributes WHERE id = $1',
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Атрибут не найден' });
      }
      return res.status(200).json({ ok: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { name, type, dictionary_values, mp_links, formula, show_related_fields } = req.body;
      if (!name || !type) {
        return res.status(400).json({ ok: false, message: 'Название и тип атрибута обязательны' });
      }
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, message: `Тип должен быть один из: ${VALID_TYPES.join(', ')}` });
      }
      const formulaVal = normalizeFormula(type, formula);
      if (type === COMPUTED_ATTR_TYPE && formulaVal) {
        const formulaError = validateFormula(formulaVal);
        if (formulaError) {
          return res.status(400).json({ ok: false, message: formulaError });
        }
      }
      const dictVal = type === 'dictionary' ? (Array.isArray(dictionary_values) ? dictionary_values : []) : [];
      const links = normalizeMpLinks(mp_links);
      const showRelated = normalizeShowRelatedFields(type, show_related_fields);
      const result = await query(
        `INSERT INTO product_attributes (name, type, dictionary_values, mp_links, formula, show_related_fields)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         RETURNING *`,
        [name.trim(), type, JSON.stringify(dictVal), JSON.stringify(links), formulaVal, showRelated]
      );
      return res.status(201).json({ ok: true, data: result.rows[0] });
    } catch (error) {
      if (
        String(error?.message || '').includes('formula') ||
        String(error?.message || '').includes('show_related_fields') ||
        String(error?.message || '').includes('product_attributes_type_check')
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Нужна миграция атрибутов (183_computed_product_attributes / 187_editable_product_attributes).',
        });
      }
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, type, dictionary_values, mp_links, formula, show_related_fields } = req.body;
      const check = await query(
        'SELECT id, system_key, type, show_related_fields FROM product_attributes WHERE id = $1',
        [id]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Атрибут не найден' });
      }
      const existing = check.rows[0];
      const systemKey = existing.system_key || null;
      const nextType = type !== undefined ? type : existing.type;
      if (type !== undefined && isSystemPriceAttrKey(systemKey) && type !== COMPUTED_ATTR_TYPE) {
        return res.status(400).json({
          ok: false,
          message: 'Системные поля цены должны оставаться вычисляемыми. Можно задать формулу или вводить значение в карточке.',
        });
      }
      if (name !== undefined && isSystemCardAttrKey(systemKey)) {
        return res.status(400).json({
          ok: false,
          message: 'Название системного поля карточки менять нельзя',
        });
      }
      const updates = [];
      const params = [];
      let idx = 1;
      if (name !== undefined) {
        updates.push(`name = $${idx++}`);
        params.push(name.trim());
      }
      if (type !== undefined) {
        if (!VALID_TYPES.includes(type)) {
          return res.status(400).json({ ok: false, message: `Тип должен быть один из: ${VALID_TYPES.join(', ')}` });
        }
        if (isSystemMainFieldAttrKey(systemKey) && type === 'dictionary') {
          return res.status(400).json({
            ok: false,
            message: 'Для системных полей карточки тип «Словарь» не используется',
          });
        }
        updates.push(`type = $${idx++}`);
        params.push(type);
      }
      if (dictionary_values !== undefined) {
        const dictVal = Array.isArray(dictionary_values) ? dictionary_values : [];
        updates.push(`dictionary_values = $${idx++}::jsonb`);
        params.push(JSON.stringify(dictVal));
      }
      if (mp_links !== undefined) {
        updates.push(`mp_links = $${idx++}::jsonb`);
        params.push(JSON.stringify(normalizeMpLinks(mp_links)));
      }
      if (formula !== undefined || type !== undefined) {
        const formulaVal = normalizeFormula(nextType, formula !== undefined ? formula : '');
        if (nextType === COMPUTED_ATTR_TYPE && formulaVal) {
          const formulaError = validateFormula(formulaVal);
          if (formulaError) {
            return res.status(400).json({ ok: false, message: formulaError });
          }
        }
        updates.push(`formula = $${idx++}`);
        params.push(formulaVal);
      }
      if (show_related_fields !== undefined || type !== undefined) {
        const showRelated = normalizeShowRelatedFields(
          nextType,
          show_related_fields !== undefined ? show_related_fields : existing.show_related_fields
        );
        updates.push(`show_related_fields = $${idx++}`);
        params.push(showRelated);
      }
      if (updates.length > 0) {
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        params.push(id);
        await query(
          `UPDATE product_attributes SET ${updates.join(', ')} WHERE id = $${idx}`,
          params
        );
      }
      const result = await query('SELECT * FROM product_attributes WHERE id = $1', [id]);
      return res.status(200).json({ ok: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const check = await query('SELECT id, system_key FROM product_attributes WHERE id = $1', [id]);
      if (check.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Атрибут не найден' });
      }
      if (isSystemCardAttrKey(check.rows[0].system_key)) {
        return res.status(400).json({
          ok: false,
          message: 'Системный атрибут карточки нельзя удалить',
        });
      }
      const result = await query(
        'DELETE FROM product_attributes WHERE id = $1 RETURNING id',
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Атрибут не найден' });
      }
      return res.status(200).json({ ok: true, message: 'Атрибут удалён' });
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductAttributesController();

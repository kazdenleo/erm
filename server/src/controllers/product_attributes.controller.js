/**
 * Product Attributes Controller
 * Атрибуты товаров и привязка к категориям
 */

import { query } from '../config/database.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const VALID_TYPES = ['text', 'checkbox', 'number', 'date', 'dictionary'];

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
      const result = await query('SELECT * FROM product_attributes ORDER BY name');
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
      const { name, type, dictionary_values } = req.body;
      if (!name || !type) {
        return res.status(400).json({ ok: false, message: 'Название и тип атрибута обязательны' });
      }
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, message: `Тип должен быть один из: ${VALID_TYPES.join(', ')}` });
      }
      const dictVal = type === 'dictionary' ? (Array.isArray(dictionary_values) ? dictionary_values : []) : [];
      const result = await query(
        `INSERT INTO product_attributes (name, type, dictionary_values)
         VALUES ($1, $2, $3::jsonb)
         RETURNING *`,
        [name.trim(), type, JSON.stringify(dictVal)]
      );
      return res.status(201).json({ ok: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, type, dictionary_values } = req.body;
      const check = await query('SELECT id FROM product_attributes WHERE id = $1', [id]);
      if (check.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Атрибут не найден' });
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
        updates.push(`type = $${idx++}`);
        params.push(type);
      }
      if (dictionary_values !== undefined) {
        const dictVal = Array.isArray(dictionary_values) ? dictionary_values : [];
        updates.push(`dictionary_values = $${idx++}::jsonb`);
        params.push(JSON.stringify(dictVal));
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

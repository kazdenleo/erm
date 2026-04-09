/**
 * Suppliers Controller
 * HTTP контроллер для поставщиков
 */

import suppliersService from '../services/suppliers.service.js';

class SuppliersController {
  async getAll(req, res, next) {
    try {
      const suppliers = await suppliersService.getAll();
      console.log('[SuppliersController] getAll - suppliers count:', suppliers.length);
      console.log('[SuppliersController] getAll - suppliers type:', Array.isArray(suppliers) ? 'array' : typeof suppliers);
      
      if (!Array.isArray(suppliers)) {
        console.error('[SuppliersController] getAll - suppliers is not an array:', suppliers);
        return res.status(200).json({ ok: true, data: [] });
      }
      
      if (suppliers.length > 0) {
        console.log('[SuppliersController] getAll - first supplier:', { id: suppliers[0].id, name: suppliers[0].name });
      }
      
      // Проверяем, что данные можно сериализовать
      let serialized;
      try {
        serialized = JSON.stringify(suppliers);
        console.log('[SuppliersController] getAll - serialization successful, length:', serialized.length);
      } catch (serializeError) {
        console.error('[SuppliersController] JSON serialization error:', serializeError);
        console.error('[SuppliersController] Serialization error stack:', serializeError.stack);
        // Пробуем очистить проблемные поля
        const cleanedSuppliers = suppliers.map(s => {
          const { api_config, ...rest } = s;
          return rest;
        });
        return res.status(200).json({ ok: true, data: cleanedSuppliers });
      }
      
      // Убеждаемся, что мы отправляем правильный формат
      console.log('[SuppliersController] Sending response with', suppliers.length, 'suppliers');
      const response = { ok: true, data: suppliers };
      console.log('[SuppliersController] Response structure:', { ok: response.ok, dataLength: response.data.length });
      
      return res.status(200).json(response);
    } catch (error) {
      console.error('[SuppliersController] getAll error:', error);
      console.error('[SuppliersController] getAll error stack:', error.stack);
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const supplier = await suppliersService.getById(id);
      return res.status(200).json({ ok: true, data: supplier });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const supplier = await suppliersService.create(req.body);
      return res.status(200).json({ ok: true, data: supplier });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const supplier = await suppliersService.update(id, req.body);
      return res.status(200).json({ ok: true, data: supplier });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const supplier = await suppliersService.delete(id);
      return res.status(200).json({ ok: true, data: supplier });
    } catch (error) {
      next(error);
    }
  }
}

export default new SuppliersController();



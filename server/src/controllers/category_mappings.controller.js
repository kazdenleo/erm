/**
 * Category Mappings Controller
 * HTTP контроллер для маппингов категорий
 */

import repositoryFactory from '../config/repository-factory.js';

const repository = repositoryFactory.getCategoryMappingsRepository();

class CategoryMappingsController {
  async getAll(req, res, next) {
    try {
      const { productId, marketplace } = req.query;
      console.log('[Category Mappings Controller] GET /category-mappings', {
        productId,
        marketplace,
        query: req.query
      });
      const mappings = await repository.findAll({ productId, marketplace });
      console.log('[Category Mappings Controller] Found mappings:', mappings.length);
      return res.status(200).json({ ok: true, data: mappings });
    } catch (error) {
      console.error('[Category Mappings Controller] Error in getAll:', {
        message: error.message,
        stack: error.stack,
        code: error.code,
        query: req.query
      });
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const mapping = await repository.findById(id);
      
      if (!mapping) {
        return res.status(404).json({ ok: false, message: 'Маппинг не найден' });
      }
      
      return res.status(200).json({ ok: true, data: mapping });
    } catch (error) {
      next(error);
    }
  }

  async getByProduct(req, res, next) {
    try {
      const { productId } = req.params;
      console.log('[Category Mappings Controller] ========================================');
      console.log('[Category Mappings Controller] GET /category-mappings/product/:productId');
      console.log('[Category Mappings Controller] Request received:', {
        productId,
        productIdType: typeof productId,
        params: req.params,
        url: req.url,
        method: req.method,
        headers: {
          'if-none-match': req.headers['if-none-match'],
          'if-modified-since': req.headers['if-modified-since']
        }
      });
      console.log('[Category Mappings Controller] ========================================');
      const mappings = await repository.findByProduct(productId);
      console.log('[Category Mappings Controller] Found mappings for product:', {
        productId,
        mappingsCount: mappings.length,
        mappings: mappings
      });
      // Устанавливаем заголовки для предотвращения кэширования при отладке
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return res.status(200).json({ ok: true, data: mappings });
    } catch (error) {
      console.error('[Category Mappings Controller] Error in getByProduct:', {
        productId: req.params.productId,
        message: error.message,
        stack: error.stack,
        code: error.code
      });
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { product_id, marketplace, category_id } = req.body;
      
      console.log('[Category Mappings Controller] Create request:', {
        product_id,
        marketplace,
        category_id,
        category_id_type: typeof category_id
      });
      
      if (!product_id || !marketplace || !category_id) {
        console.error('[Category Mappings Controller] Missing required fields:', {
          hasProductId: !!product_id,
          hasMarketplace: !!marketplace,
          hasCategoryId: !!category_id
        });
        return res.status(400).json({ ok: false, message: 'Необходимы product_id, marketplace и category_id' });
      }
      
      const mapping = await repository.create({ product_id, marketplace, category_id });
      console.log('[Category Mappings Controller] Mapping created successfully:', mapping);
      return res.status(201).json({ ok: true, data: mapping });
    } catch (error) {
      console.error('[Category Mappings Controller] Error creating mapping:', {
        message: error.message,
        stack: error.stack,
        code: error.code
      });
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const updates = req.body;
      
      console.log('[Category Mappings Controller] Update request:', {
        id,
        updates,
        category_id_type: typeof updates.category_id
      });
      
      const mapping = await repository.update(id, updates);
      if (!mapping) {
        console.warn('[Category Mappings Controller] Mapping not found for update:', id);
        return res.status(404).json({ ok: false, message: 'Маппинг не найден' });
      }
      
      console.log('[Category Mappings Controller] Mapping updated successfully:', mapping);
      return res.status(200).json({ ok: true, data: mapping });
    } catch (error) {
      console.error('[Category Mappings Controller] Error updating mapping:', {
        message: error.message,
        stack: error.stack,
        code: error.code
      });
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await repository.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Маппинг не найден' });
      }
      
      return res.status(200).json({ ok: true, message: 'Маппинг удален' });
    } catch (error) {
      next(error);
    }
  }
}

export default new CategoryMappingsController();


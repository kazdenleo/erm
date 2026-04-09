/**
 * Products Controller
 * HTTP контроллер для товаров
 */

import productsService from '../services/products.service.js';
import { normalizeProductExportOptions } from '../services/productsExport.service.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

/** Латинский fallback для Content-Disposition filename= (кириллица в заголовке ломает Node) */
function asciiContentDispositionFilename(name, fallback = 'file.xlsx') {
  const s = String(name || '');
  const ascii = s.replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_').trim() || fallback;
  return ascii.slice(0, 180);
}

function setAttachmentXlsx(res, filename) {
  const asciiName = asciiContentDispositionFilename(filename, 'products.xlsx');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

class ProductsController {
  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    this._rootDir = path.resolve(path.dirname(__filename), '../../');
  }
  async exportExcel(req, res, next) {
    try {
      const filters = {};
      if (req.query.organizationId != null && String(req.query.organizationId).trim() !== '') {
        filters.organizationId = String(req.query.organizationId).trim();
      }
      if (req.query.categoryId != null && String(req.query.categoryId).trim() !== '') {
        filters.categoryId = String(req.query.categoryId).trim();
      }
      if (req.query.search != null && String(req.query.search).trim() !== '') {
        filters.search = String(req.query.search).trim();
      }
      if (req.user?.profileId != null && req.user.profileId !== '') {
        filters.profileId = req.user.profileId;
      }
      filters.exportOptions = normalizeProductExportOptions({
        includeMp: req.query.includeMp,
        mpFields: req.query.mpFields,
        mpOzon: req.query.mpOzon,
        mpWb: req.query.mpWb,
        mpYm: req.query.mpYm
      });
      const { buffer, productCount } = await productsService.exportToExcel(filters);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `products_export_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setAttachmentXlsx(res, filename);
      res.setHeader('X-Products-Exported', String(productCount ?? 0));
      // Порядок колонок: системные → WB → Ozon → Яндекс (см. buildProductSheetColumns)
      res.setHeader('X-Products-Export-Column-Order', 'system,wb,ozon,ym');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }

  async downloadImportTemplateExcel(req, res, next) {
    try {
      const filters = {};
      if (req.query.categoryId != null && String(req.query.categoryId).trim() !== '') {
        filters.categoryId = String(req.query.categoryId).trim();
      }
      if (req.user?.profileId != null && req.user.profileId !== '') {
        filters.profileId = req.user.profileId;
      }
      filters.exportOptions = normalizeProductExportOptions({
        includeMp: req.query.includeMp,
        mpFields: req.query.mpFields,
        mpOzon: req.query.mpOzon,
        mpWb: req.query.mpWb,
        mpYm: req.query.mpYm
      });
      const { buffer, categoryId, categoryName } = await productsService.exportImportTemplateExcel(filters);
      res.setHeader('X-Products-Export-Column-Order', 'system,wb,ozon,ym');
      const date = new Date().toISOString().slice(0, 10);
      const safeSlug = (categoryName || 'all')
        .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 40) || 'all';
      const filename = categoryId
        ? `products_import_template_${safeSlug}_${date}.xlsx`
        : `products_import_template_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setAttachmentXlsx(res, filename);
      res.setHeader('X-Template-Category-Id', categoryId || '');
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }

  async importExcel(req, res, next) {
    try {
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Файл не получен. Отправьте multipart с полем file (.xlsx).' });
      }
      const profileId = req.user?.profileId;
      const summary = await productsService.importFromExcel(file.buffer, { profileId });
      return res.status(200).json({ ok: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  async getAll(req, res, next) {
    try {
      const options = {};
      if (req.user?.profileId != null && req.user.profileId !== '') {
        options.profileId = req.user.profileId;
      }
      if (req.query.organizationId != null && req.query.organizationId !== '') {
        options.organizationId = req.query.organizationId;
      }
      if (req.query.brandId != null && req.query.brandId !== '') options.brandId = req.query.brandId;
      if (req.query.categoryId != null && req.query.categoryId !== '') options.categoryId = req.query.categoryId;
      if (req.query.search != null && req.query.search !== '') options.search = req.query.search;
      if (req.query.productType != null && String(req.query.productType).trim() !== '') {
        options.productType = String(req.query.productType).trim();
      }
      if (req.query.warehouseId != null && String(req.query.warehouseId).trim() !== '') {
        options.warehouseId = String(req.query.warehouseId).trim();
      }
      if (req.query.limit != null) options.limit = parseInt(req.query.limit, 10);
      if (req.query.offset != null) options.offset = parseInt(req.query.offset, 10);
      const products = await productsService.getAll(options);
      // Явно копируем в обычные объекты и гарантированно передаём сохранённые цены (на случай нестандартной сериализации row из pg)
      const data = products.map(p => {
        const row = { ...p };
        row.storedMinPriceOzon = p.storedMinPriceOzon != null ? Number(p.storedMinPriceOzon) : null;
        row.storedMinPriceWb = p.storedMinPriceWb != null ? Number(p.storedMinPriceWb) : null;
        row.storedMinPriceYm = p.storedMinPriceYm != null ? Number(p.storedMinPriceYm) : null;
        row.storedMinPriceUpdatedAt = p.storedMinPriceUpdatedAt ?? null;
        row.storedCalculationDetailsOzon = p.storedCalculationDetailsOzon ?? null;
        row.storedCalculationDetailsWb = p.storedCalculationDetailsWb ?? null;
        row.storedCalculationDetailsYm = p.storedCalculationDetailsYm ?? null;
        return row;
      });
      const withPrices = data.filter(p => p.storedMinPriceOzon != null || p.storedMinPriceWb != null || p.storedMinPriceYm != null).length;
      if (data.length > 0 && (withPrices > 0 || data.length <= 10)) {
        console.log(`[Products Controller] GET /products: ${data.length} products, ${withPrices} with stored min prices`);
      }
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** Лёгкий ответ для UI категорий: { [user_category_id]: productId[] } без полных карточек товаров */
  async getProductIdsGroupedByUserCategory(req, res, next) {
    try {
      const grouped = await productsService.getProductIdsGroupedByUserCategory();
      return res.status(200).json({ ok: true, data: grouped });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getByIdWithDetails(id);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар не найден' });
      }
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async getByBarcode(req, res, next) {
    try {
      const { barcode } = req.params;
      const product = await productsService.getByBarcode(barcode);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар с таким штрихкодом не найден' });
      }
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const product = await productsService.create(req.body);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      console.error('[Products Controller] Create error:', error?.message, error?.code, error?.stack);
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.update(id, req.body);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.delete(id);
      return res.status(200).json({ ok: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async replaceAll(req, res, next) {
    try {
      const result = await productsService.replaceAll(req.body);
      return res.status(200).json({ ok: true, data: { message: 'Товары обновлены', ...result } });
    } catch (error) {
      next(error);
    }
  }

  async refreshSupplierStocks(req, res, next) {
    try {
      const { productId } = req.query;
      const productIdNum = productId ? parseInt(productId, 10) : null;
      
      console.log(`[Products Controller] Refreshing supplier stocks${productIdNum ? ` for product ID: ${productIdNum}` : ' for all products'}`);
      
      const result = await productsService.refreshSupplierStocks(productIdNum);
      return res.status(200).json({ 
        ok: true, 
        data: {
          message: productIdNum 
            ? `Остатки обновлены для товара` 
            : `Остатки обновлены для ${result.success} товаров`,
          ...result
        }
      });
    } catch (error) {
      console.error('[Products Controller] Refresh supplier stocks error:', error?.message);
      next(error);
    }
  }

  async getImages(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getById(id);
      const images = Array.isArray(product?.images) ? product.images : (product?.images ? product.images : []);
      return res.status(200).json({ ok: true, data: Array.isArray(images) ? images : [] });
    } catch (error) {
      next(error);
    }
  }

  async uploadImages(req, res, next) {
    try {
      const { id } = req.params;
      const product = await productsService.getById(id);
      const current = Array.isArray(product?.images) ? [...product.images] : [];
      const files = Array.isArray(req.files) ? req.files : [];
      const hadAny = current.length > 0;
      const added = files.map((f, i) => {
        const filename = f?.filename || path.basename(f?.path || '');
        const rel = `/uploads/products/${String(id)}/${filename}`;
        return {
          id: filename,
          url: rel,
          filename,
          originalname: f?.originalname || '',
          primary: !hadAny && i === 0,
          marketplaces: { ozon: true, wb: true, ym: true },
          created_at: new Date().toISOString()
        };
      });
      const nextImages = [...current, ...added];
      const updated = await productsService.update(id, { images: nextImages });
      return res.status(200).json({ ok: true, data: updated?.images ?? nextImages });
    } catch (error) {
      next(error);
    }
  }

  async updateImages(req, res, next) {
    try {
      const { id } = req.params;
      const body = req.body || {};
      const images = Array.isArray(body.images) ? body.images : null;
      if (!images) return res.status(400).json({ ok: false, error: 'Ожидается images: массив' });
      const updated = await productsService.update(id, { images });
      return res.status(200).json({ ok: true, data: updated?.images ?? images });
    } catch (error) {
      next(error);
    }
  }

  async deleteImage(req, res, next) {
    try {
      const { id, imageId } = req.params;
      const product = await productsService.getById(id);
      const current = Array.isArray(product?.images) ? [...product.images] : [];
      const nextImages = current.filter((img) => String(img?.id || img?.filename || '') !== String(imageId));
      if (nextImages.length > 0 && !nextImages.some((img) => img.primary === true)) {
        nextImages[0] = { ...nextImages[0], primary: true };
      }

      // try delete file from disk
      const filePath = path.resolve(this._rootDir, 'uploads', 'products', String(id), String(imageId));
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}

      const updated = await productsService.update(id, { images: nextImages });
      return res.status(200).json({ ok: true, data: updated?.images ?? nextImages });
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductsController();



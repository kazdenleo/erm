/**
 * Обогащение карточек товаров (PartsAPI) + импорт пачки парсера
 */

import * as productEnrichmentService from '../services/productEnrichment.service.js';
import * as catalogBundleImportService from '../services/catalogBundleImport.service.js';
import { resolveEffectiveProfileId } from '../utils/effectiveProfile.js';

class ProductEnrichmentController {
  async status(req, res, next) {
    try {
      const profileId =
        (await resolveEffectiveProfileId(req, req.user)) ??
        (req.user?.profileId != null ? Number(req.user.profileId) : null);
      const data = await productEnrichmentService.getEnrichmentStatusForProfile(profileId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async enrich(req, res, next) {
    try {
      const productId = req.params.id;
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const apply = req.body?.apply !== false && req.query?.dryRun !== '1';
      const result = await productEnrichmentService.enrichProductById(productId, {
        profileId,
        apply,
        dryRun: req.body?.dryRun === true || req.query?.dryRun === '1',
      });
      res.json({
        success: true,
        data: result.product,
        preview: result.preview,
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }

  async enrichBulk(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) {
        return res.status(400).json({
          success: false,
          error: 'Передайте items: [{ brand, sku }, ...]',
          message: 'Передайте items: [{ brand, sku }, ...]',
        });
      }
      if (items.length > 500) {
        return res.status(400).json({
          success: false,
          error: 'За один раз не больше 500 позиций',
          message: 'За один раз не больше 500 позиций',
        });
      }
      const apply = req.body?.apply !== false;
      const data = await productEnrichmentService.enrichProductsByBrandSkuList(items, {
        profileId,
        apply,
      });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[productEnrichment] enrichBulk:', error?.message || error, error?.stack);
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }

  async createFromEnrichment(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) {
        return res.status(400).json({
          success: false,
          error: 'Передайте items для создания',
          message: 'Передайте items для создания',
        });
      }
      const data = await productEnrichmentService.createProductsFromEnrichmentItems(items, {
        profileId,
      });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[productEnrichment] createFromEnrichment:', error?.message || error, error?.stack);
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }

  async catalogBundlePreview(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({
          success: false,
          error: 'Загрузите ZIP-файл (поле file)',
          message: 'Загрузите ZIP-файл (поле file)',
        });
      }
      const data = await catalogBundleImportService.uploadAndPreview(file.buffer, { profileId });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[productEnrichment] catalogBundlePreview:', error?.message || error, error?.stack);
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }

  async catalogBundleFolderPreview(req, res, next) {
    const incomingDir = req._catalogIncomingDir;
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({
          success: false,
          error: 'Выберите папку с Excel и фото',
          message: 'Выберите папку с Excel и фото',
        });
      }
      const pathsRaw = req.body?.paths;
      const paths = Array.isArray(pathsRaw)
        ? pathsRaw
        : pathsRaw != null && pathsRaw !== ''
          ? [pathsRaw]
          : [];
      if (paths.length !== files.length) {
        return res.status(400).json({
          success: false,
          error: 'Не совпали список файлов и путей папки',
          message: 'Не совпали список файлов и путей папки',
        });
      }
      const byIdx = new Map();
      for (const f of files) {
        const idx = Number(f.filename);
        if (Number.isFinite(idx)) byIdx.set(idx, f);
      }
      const diskFiles = [];
      for (let i = 0; i < paths.length; i++) {
        const f = byIdx.get(i) || files[i];
        if (!f?.path) continue;
        diskFiles.push({
          path: f.path,
          relativePath: String(paths[i] || f.originalname || ''),
        });
      }
      const data = await catalogBundleImportService.uploadAndPreviewFromFolderFiles(diskFiles, {
        profileId,
      });
      res.json({ success: true, data });
    } catch (error) {
      console.error(
        '[productEnrichment] catalogBundleFolderPreview:',
        error?.message || error,
        error?.stack
      );
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    } finally {
      // подчистить staging, если сервис не забрал файлы
      if (incomingDir) {
        try {
          const fs = await import('fs');
          fs.rmSync(incomingDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  async catalogBundleCreate(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const sessionId = String(req.body?.sessionId || '').trim();
      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Нужен sessionId',
          message: 'Нужен sessionId',
        });
      }
      const data = await catalogBundleImportService.createFromSession({
        sessionId,
        profileId,
        mapping: req.body?.mapping || {},
        defaults: req.body?.defaults || {},
        selectedIndexes: Array.isArray(req.body?.selectedIndexes)
          ? req.body.selectedIndexes
          : undefined,
        selectedSkus: Array.isArray(req.body?.selectedSkus) ? req.body.selectedSkus : undefined,
      });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[productEnrichment] catalogBundleCreate:', error?.message || error, error?.stack);
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }
}

export default new ProductEnrichmentController();

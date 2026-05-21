/**
 * HTTP: шаблоны этикеток по категориям
 */

import { categoryLabelTemplatesRepository } from '../repositories/categoryLabelTemplates.repository.pg.js';
import productLabelsService, { defaultLabelElements } from '../services/productLabels.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { query } from '../config/database.js';

function normalizeElements(body) {
  if (!Array.isArray(body?.elements)) return defaultLabelElements();
  if (body.elements.length === 0) return [];
  return body.elements.map((el, idx) => ({
    id: el.id || `${el.type}-${idx}`,
    type: el.type,
    enabled: el.enabled !== false,
    fontSize:
      el.fontSize != null
        ? Math.min(24, Math.max(6, Number(el.fontSize)))
        : undefined,
    textFontSize:
      el.textFontSize != null
        ? Math.min(14, Math.max(6, Number(el.textFontSize)))
        : undefined,
    titleFontSize:
      el.titleFontSize != null
        ? Math.min(20, Math.max(6, Number(el.titleFontSize)))
        : undefined,
    bold: el.bold === true,
    heightMm: el.heightMm != null ? Number(el.heightMm) : undefined,
    showText: el.showText !== false,
    showName: el.showName !== false,
    showTitle: el.showTitle !== false,
    showQuantity: el.showQuantity !== false,
    showSku: el.showSku !== false,
    titleFontSize: el.titleFontSize != null ? Number(el.titleFontSize) : undefined,
    attributeId: el.attributeId != null ? Number(el.attributeId) : undefined,
    fieldKey: el.fieldKey != null ? String(el.fieldKey) : undefined,
  }));
}

async function assertCategoryBelongsToProfile(categoryId, profileId) {
  const result = await query(
    'SELECT id, profile_id FROM user_categories WHERE id = $1::bigint',
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

class CategoryLabelTemplatesController {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const data = await categoryLabelTemplatesRepository.findAllByProfile(tid);
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
      await assertCategoryBelongsToProfile(categoryId, tid);
      const template = await categoryLabelTemplatesRepository.findByCategoryId(categoryId, tid);
      return res.status(200).json({
        ok: true,
        data: template || {
          user_category_id: categoryId,
          size_preset: '58x40',
          margin_top_mm: 2,
          margin_right_mm: 2,
          margin_bottom_mm: 2,
          margin_left_mm: 2,
          line_gap_mm: 1,
          elements: defaultLabelElements(),
        },
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

      const body = req.body || {};
      const sizePreset = String(body.size_preset || body.sizePreset || '58x40').trim();
      const template = await categoryLabelTemplatesRepository.upsert({
        userCategoryId: categoryId,
        profileId: tid,
        sizePreset,
        widthMm: body.width_mm ?? body.widthMm ?? null,
        heightMm: body.height_mm ?? body.heightMm ?? null,
        marginTopMm: Number(body.margin_top_mm ?? body.marginTopMm ?? 2),
        marginRightMm: Number(body.margin_right_mm ?? body.marginRightMm ?? 2),
        marginBottomMm: Number(body.margin_bottom_mm ?? body.marginBottomMm ?? 2),
        marginLeftMm: Number(body.margin_left_mm ?? body.marginLeftMm ?? 2),
        lineGapMm: Number(body.line_gap_mm ?? body.lineGapMm ?? 1),
        elements: normalizeElements(body),
      });
      return res.status(200).json({ ok: true, data: template });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async preview(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      const categoryId = Number(req.params.categoryId);
      if (!Number.isFinite(categoryId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id категории' });
      }
      await assertCategoryBelongsToProfile(categoryId, tid);

      const productId = req.query?.productId ?? req.query?.product_id ?? null;
      const scaleRaw = req.query?.scale ?? req.query?.previewScale;
      const previewScale = scaleRaw != null ? Number(scaleRaw) : 4;
      const result = await productLabelsService.renderPreview(req.body || {}, {
        categoryId,
        productId,
        previewScale: Number.isFinite(previewScale) ? previewScale : 4,
      });
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(result.buffer);
    } catch (error) {
      const code = error.statusCode || 500;
      if (code < 500) {
        return res.status(code).json({ ok: false, message: error.message });
      }
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
      const deleted = await categoryLabelTemplatesRepository.deleteByCategoryId(categoryId, tid);
      return res.status(200).json({ ok: true, deleted });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }
}

export default new CategoryLabelTemplatesController();

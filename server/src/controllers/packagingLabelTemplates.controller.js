/**
 * HTTP: шаблон этикетки ШК упаковки
 */

import { packagingLabelTemplatesRepository } from '../repositories/packagingLabelTemplates.repository.pg.js';
import productLabelsService, { defaultPackagingLabelElements } from '../services/productLabels.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function normalizeElements(body) {
  if (!Array.isArray(body?.elements)) return defaultPackagingLabelElements();
  if (body.elements.length === 0) return [];
  return body.elements.map((el, idx) => ({
    id: el.id || `${el.type}-${idx}`,
    type: el.type,
    enabled: el.enabled !== false,
    fontSize:
      el.fontSize != null ? Math.min(24, Math.max(6, Number(el.fontSize))) : undefined,
    textFontSize:
      el.textFontSize != null ? Math.min(14, Math.max(6, Number(el.textFontSize))) : undefined,
    bold: el.bold === true,
    heightMm: el.heightMm != null ? Number(el.heightMm) : undefined,
    widthMm: el.widthMm != null ? Number(el.widthMm) : undefined,
    showText: el.showText !== false,
    showName: el.showName !== false,
    align: (() => {
      const a = String(el.align ?? el.textAlign ?? '').trim().toLowerCase();
      if (a === 'center' || a === 'middle') return 'center';
      if (a === 'right' || a === 'end') return 'right';
      if (a === 'left' || a === 'start') return 'left';
      return undefined;
    })(),
  }));
}

function requireProfileId(req) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY) {
    const err = new Error('Нет профиля');
    err.statusCode = 403;
    throw err;
  }
  if (tid == null) {
    const err = new Error('Для шаблона упаковки нужен профиль пользователя');
    err.statusCode = 400;
    throw err;
  }
  return tid;
}

function defaultTemplatePayload() {
  return {
    size_preset: '58x40',
    margin_top_mm: 2,
    margin_right_mm: 2,
    margin_bottom_mm: 2,
    margin_left_mm: 2,
    line_gap_mm: 1,
    elements: defaultPackagingLabelElements(),
  };
}

class PackagingLabelTemplatesController {
  async get(req, res, next) {
    try {
      const tid = requireProfileId(req);
      const template = await packagingLabelTemplatesRepository.findByProfileId(tid);
      return res.status(200).json({
        ok: true,
        data: template || { profile_id: tid, ...defaultTemplatePayload() },
        saved: Boolean(template),
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async upsert(req, res, next) {
    try {
      const tid = requireProfileId(req);
      const body = req.body || {};
      const sizePreset = String(body.size_preset || body.sizePreset || '58x40').trim();
      const template = await packagingLabelTemplatesRepository.upsert({
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
      return res.status(200).json({ ok: true, data: template, saved: true });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async preview(req, res, next) {
    try {
      requireProfileId(req);
      const productId = req.query?.productId ?? req.query?.product_id ?? null;
      const barcode = req.query?.barcode ?? req.body?.barcode ?? null;
      const units = req.query?.units ?? req.query?.units_per_box ?? req.body?.units_per_box ?? null;
      const scaleRaw = req.query?.scale ?? req.query?.previewScale;
      const previewScale = scaleRaw != null ? Number(scaleRaw) : 4;
      const result = await productLabelsService.renderPackagingPreview(req.body || {}, {
        productId,
        barcode,
        unitsPerBox: units,
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
      const tid = requireProfileId(req);
      const deleted = await packagingLabelTemplatesRepository.deleteByProfileId(tid);
      return res.status(200).json({ ok: true, deleted });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }
}

export default new PackagingLabelTemplatesController();

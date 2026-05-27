/**
 * HTTP: печать этикеток товаров
 */

import productLabelsService from '../services/productLabels.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function resolveProfileIdForLabel(req) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY || tid == null) return null;
  return tid;
}

function parseCopiesQuery(raw) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

class ProductLabelsController {
  async getLabel(req, res, next) {
    try {
      const productId = req.params.id ?? req.params.productId;
      const format = String(req.query?.format || 'png').toLowerCase() === 'pdf' ? 'pdf' : 'png';
      const copies = parseCopiesQuery(req.query?.copies);
      const result = await productLabelsService.renderProductLabel(productId, {
        format,
        copies,
        profileId: resolveProfileIdForLabel(req),
        marketplace: req.query?.marketplace ?? null,
      });
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-store');
      if (result.widthMm != null) {
        res.setHeader('X-Label-Width-Mm', String(result.widthMm));
      }
      if (result.heightMm != null) {
        res.setHeader('X-Label-Height-Mm', String(result.heightMm));
      }
      res.setHeader('Access-Control-Expose-Headers', 'X-Label-Width-Mm, X-Label-Height-Mm');
      return res.send(result.buffer);
    } catch (error) {
      const code = error.statusCode || 500;
      if (code < 500) {
        return res.status(code).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  async getLabelPrint(req, res, next) {
    try {
      const productId = req.params.id ?? req.params.productId;
      const html = productLabelsService.buildPrintHtml(productId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(html);
    } catch (error) {
      next(error);
    }
  }
}

export default new ProductLabelsController();

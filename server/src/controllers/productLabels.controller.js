/**
 * HTTP: печать этикеток товаров
 */

import productLabelsService from '../services/productLabels.service.js';

class ProductLabelsController {
  async getLabel(req, res, next) {
    try {
      const productId = req.params.id ?? req.params.productId;
      const format = String(req.query?.format || 'png').toLowerCase() === 'pdf' ? 'pdf' : 'png';
      const result = await productLabelsService.renderProductLabel(productId, { format });
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

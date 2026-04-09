/**
 * Shipments Controller
 * Поставки FBS: локальные (Ozon, Яндекс) и на WB — создание на маркетплейсе, добавление заказов, QR-стикер при закрытии WB.
 */

import fs from 'fs';
import shipmentsService from '../services/shipments.service.js';

class ShipmentsController {
  async getAll(req, res, next) {
    try {
      const data = await shipmentsService.getShipments();
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const shipment = await shipmentsService.getShipmentById(id);
      if (!shipment) {
        return res.status(404).json({ ok: false, message: 'Поставка не найдена' });
      }
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { marketplace, name } = req.body || {};
      const shipment = await shipmentsService.createShipment({ marketplace, name });
      return res.status(201).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async addOrders(req, res, next) {
    try {
      const { id } = req.params;
      const { orderIds } = req.body || {};
      const shipment = await shipmentsService.addOrdersToShipment(id, orderIds);
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async close(req, res, next) {
    try {
      const { id } = req.params;
      const shipment = await shipmentsService.closeShipment(id);
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async removeOrders(req, res, next) {
    try {
      const { id } = req.params;
      const { orderIds } = req.body || {};
      const shipment = await shipmentsService.removeOrdersFromShipment(id, orderIds);
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async getQrSticker(req, res, next) {
    try {
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id);
      if (!filePath) {
        return res.status(404).json({ ok: false, message: 'QR-стикер поставки не найден' });
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `inline; filename="supply-qr-${id}.png"`);
      return fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      next(error);
    }
  }

  /**
   * HTML-страница с этикеткой поставки и автозапуском печати.
   * GET /shipments/:id/qr-sticker/print
   */
  async getQrStickerPrint(req, res, next) {
    try {
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id);
      if (!filePath) {
        return res.status(404).json({ ok: false, message: 'Этикетка поставки не найдена. Закройте поставку WB — этикетка запросится автоматически.' });
      }
      const baseUrl = `${req.protocol}://${req.get('host') || ''}`.replace(/\/$/, '');
      const apiBase = req.baseUrl || '/api/shipments';
      const stickerUrl = `${baseUrl}${apiBase}/${encodeURIComponent(id)}/qr-sticker`;
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Этикетка поставки ${id}</title>
  <style>
    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <img id="stickerImg" src="${stickerUrl.replace(/"/g, '&quot;')}" alt="Этикетка поставки" />
  <script>
    (function(){
      var done = false;
      function doPrint() {
        if (done) return;
        done = true;
        window.print();
      }
      document.getElementById('stickerImg').onload = doPrint;
      window.setTimeout(doPrint, 1500);
    })();
  </script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (error) {
      next(error);
    }
  }
}

export default new ShipmentsController();

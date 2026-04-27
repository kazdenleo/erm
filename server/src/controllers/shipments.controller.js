/**
 * Shipments Controller
 * Поставки FBS: локальные (Ozon, Яндекс) и на WB — создание на маркетплейсе, добавление заказов, QR-стикер при закрытии WB.
 */

import fs from 'fs';
import shipmentsService from '../services/shipments.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function shipmentsProfileOpts(req) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY) return { blocked: true };
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? String(orgHeader).trim() : null;
  return { profileId: tid != null ? tid : null, organizationId };
}

/** Абсолютный URL PNG стикера поставки для <img> (учитывает req.baseUrl `/api` vs `/api/shipments`). */
function wbSupplyQrStickerImageUrl(req, shipmentId) {
  const bu = req.baseUrl || '/api';
  const basePath = bu.endsWith('/shipments') ? bu : `${bu.replace(/\/$/, '')}/shipments`;
  const proto = req.protocol || 'http';
  const host = req.get('host') || '';
  return `${proto}://${host}${basePath}/${encodeURIComponent(shipmentId)}/qr-sticker`;
}

class ShipmentsController {
  async getAll(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(200).json({
          ok: true,
          data: {
            marketplaces: shipmentsService.getMarketplaces(),
            list: { ozon: [], wildberries: [], yandex: [] }
          }
        });
      }
      const data = await shipmentsService.getShipments({ profileId: sp.profileId, organizationId: sp.organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(404).json({ ok: false, message: 'Поставка не найдена' });
      }
      const { id } = req.params;
      const shipment = await shipmentsService.getShipmentById(id, { profileId: sp.profileId, organizationId: sp.organizationId });
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
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(403).json({ ok: false, message: 'Действие доступно только с привязкой к аккаунту' });
      }
      const { marketplace, name } = req.body || {};
      const shipment = await shipmentsService.createShipment({ marketplace, name, profileId: sp.profileId, organizationId: sp.organizationId });
      return res.status(201).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async addOrders(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(403).json({ ok: false, message: 'Действие доступно только с привязкой к аккаунту' });
      }
      const { id } = req.params;
      const { orderIds } = req.body || {};
      const shipment = await shipmentsService.addOrdersToShipment(id, orderIds, { profileId: sp.profileId, organizationId: sp.organizationId });
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async close(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(403).json({ ok: false, message: 'Действие доступно только с привязкой к аккаунту' });
      }
      const { id } = req.params;
      const shipment = await shipmentsService.closeShipment(id, { profileId: sp.profileId, organizationId: sp.organizationId });
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async removeOrders(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(403).json({ ok: false, message: 'Действие доступно только с привязкой к аккаунту' });
      }
      const { id } = req.params;
      const { orderIds } = req.body || {};
      const shipment = await shipmentsService.removeOrdersFromShipment(id, orderIds, { profileId: sp.profileId, organizationId: sp.organizationId });
      return res.status(200).json({ ok: true, data: shipment });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async getQrSticker(req, res, next) {
    try {
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(404).json({ ok: false, message: 'QR-стикер поставки не найден' });
      }
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id, { profileId: sp.profileId, organizationId: sp.organizationId });
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
      const sp = shipmentsProfileOpts(req);
      if (sp.blocked) {
        return res.status(404).json({ ok: false, message: 'Этикетка поставки не найдена. Закройте поставку WB — этикетка запросится автоматически.' });
      }
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id, { profileId: sp.profileId, organizationId: sp.organizationId });
      if (!filePath) {
        return res.status(404).json({ ok: false, message: 'Этикетка поставки не найдена. Закройте поставку WB — этикетка запросится автоматически.' });
      }
      const stickerUrl = wbSupplyQrStickerImageUrl(req, id);
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

  /**
   * Публичная отдача PNG — без Authorization (window.open / <img> не отправляют Bearer).
   * GET /shipments/:id/qr-sticker
   */
  async getQrStickerPublic(req, res, next) {
    try {
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id, { profileId: null });
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
   * Публичная страница печати — без Authorization.
   * GET /shipments/:id/qr-sticker/print
   */
  async getQrStickerPrintPublic(req, res, next) {
    try {
      const { id } = req.params;
      const filePath = await shipmentsService.getQrStickerFilePath(id, { profileId: null });
      if (!filePath) {
        return res.status(404).json({ ok: false, message: 'Этикетка поставки не найдена. Закройте поставку WB — этикетка запросится автоматически.' });
      }
      const stickerUrl = wbSupplyQrStickerImageUrl(req, id);
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

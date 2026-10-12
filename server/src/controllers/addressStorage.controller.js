/**
 * Адресное хранение: HTTP-слой. Все операции со складом — после проверки аккаунта и доступа к складу.
 */

import { query } from '../config/database.js';
import addressStorageService from '../services/addressStorage.service.js';
import { buildLocationLabelsPdf } from '../services/addressStorageLabels.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { getRequestAccessScope, isWarehouseAllowed } from '../utils/userAccessScope.js';

function forbidden(message = 'Нет доступа') {
  const e = new Error(message);
  e.statusCode = 403;
  return e;
}

async function requestScope(req) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY) throw forbidden('Нет доступа к данным аккаунта');
  const scope = await getRequestAccessScope(req);
  return { profileId: tid, warehouseIds: scope.warehouseIds ?? null, scope };
}

/** Склад из :warehouseId, принадлежащий аккаунту и доступный пользователю. */
async function requireWarehouse(req) {
  const { profileId, scope } = await requestScope(req);
  const wid = Number(req.params.warehouseId);
  if (!Number.isInteger(wid) || wid < 1) throw forbidden('Склад не найден');
  const r = await query(
    `SELECT id, name, address, profile_id FROM warehouses
     WHERE id = $1 AND supplier_id IS NULL ${profileId != null ? 'AND profile_id = $2' : ''}`,
    profileId != null ? [wid, profileId] : [wid]
  );
  if (!r.rows[0] || !isWarehouseAllowed(scope, wid)) {
    const e = new Error('Склад не найден');
    e.statusCode = 404;
    throw e;
  }
  return { warehouseId: wid, profileId, warehouse: r.rows[0] };
}

function send(res, data) {
  return res.status(200).json({ ok: true, data });
}

class AddressStorageController {
  async listWarehouses(req, res) {
    const { profileId, warehouseIds } = await requestScope(req);
    return send(res, await addressStorageService.listWarehouses({ profileId, warehouseIds }));
  }

  async getSettings(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.getSettings(warehouseId));
  }

  async saveSettings(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.saveSettings(warehouseId, req.body || {}));
  }

  async listLocations(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.listLocations(warehouseId));
  }

  async createLocation(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.createLocation(warehouseId, req.body || {}));
  }

  async generateLocations(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.generateLocations(warehouseId, req.body || {}));
  }

  async updateLocation(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.updateLocation(warehouseId, Number(req.params.locationId), req.body || {})
    );
  }

  async bulkUpdateLocations(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    const { ids, patch } = req.body || {};
    return send(res, await addressStorageService.bulkUpdateLocations(warehouseId, ids, patch || {}));
  }

  async deleteLocations(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    const { ids, force } = req.body || {};
    return send(res, await addressStorageService.deleteLocations(warehouseId, ids, { force: force === true }));
  }

  async renumberRoute(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.renumberRoute(warehouseId, req.body || {}));
  }

  async labels(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number));
    const settings = await addressStorageService.getSettings(warehouseId);
    const all = await addressStorageService.listLocations(warehouseId);
    const list = ids.size ? all.filter((l) => ids.has(l.id)) : all;
    if (!list.length) {
      return res.status(400).json({ ok: false, message: 'Нет ячеек для печати' });
    }
    if (list.length > 2000) {
      return res.status(400).json({ ok: false, message: 'За раз можно напечатать не больше 2000 этикеток' });
    }
    const pdf = await buildLocationLabelsPdf(list, settings);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="locations-${warehouseId}.pdf"`);
    return res.status(200).send(pdf);
  }

  async searchProducts(req, res) {
    const { warehouseId, profileId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.searchProducts(warehouseId, { q: req.query.q, profileId, limit: req.query.limit })
    );
  }

  async assignProduct(req, res) {
    const { warehouseId, profileId } = await requireWarehouse(req);
    const { productId, locationId } = req.body || {};
    return send(
      res,
      await addressStorageService.assignProduct(warehouseId, Number(productId), locationId ?? null, { profileId })
    );
  }

  async importAssignments(req, res) {
    const { warehouseId, profileId } = await requireWarehouse(req);
    return send(res, await addressStorageService.importAssignments(warehouseId, req.body?.text, { profileId }));
  }

  async resolveScan(req, res) {
    const { warehouseId, profileId } = await requireWarehouse(req);
    const data = await addressStorageService.resolveScan(warehouseId, req.query.code, { profileId });
    if (!data) return res.status(404).json({ ok: false, message: 'Не найдено ни ячейки, ни товара' });
    return send(res, data);
  }

  async moveStock(req, res) {
    const { warehouseId, profileId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.moveStock(warehouseId, req.body || {}, { userId: req.user?.id ?? null, profileId })
    );
  }

  async placeUnplacedToAssigned(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.placeUnplacedToAssigned(warehouseId, { userId: req.user?.id ?? null })
    );
  }

  async listPending(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.listPending(warehouseId, { kind: req.query.kind, limit: req.query.limit })
    );
  }

  async listMovements(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(
      res,
      await addressStorageService.listMovements(warehouseId, {
        limit: req.query.limit,
        productId: req.query.productId,
      })
    );
  }

  async getHeatmap(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.getHeatmap(warehouseId, { days: req.query.days }));
  }

  async getLayout(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.getLayout(warehouseId));
  }

  async saveLayout(req, res) {
    const { warehouseId } = await requireWarehouse(req);
    return send(res, await addressStorageService.saveLayout(warehouseId, req.body || {}));
  }

  async productLocations(req, res) {
    const { profileId, warehouseIds } = await requestScope(req);
    return send(
      res,
      await addressStorageService.getProductLocations(Number(req.params.productId), { profileId, warehouseIds })
    );
  }

  async lookup(req, res) {
    const { profileId, warehouseIds } = await requestScope(req);
    return send(
      res,
      await addressStorageService.lookupProducts(req.body?.productIds, { profileId, warehouseIds })
    );
  }
}

export default new AddressStorageController();

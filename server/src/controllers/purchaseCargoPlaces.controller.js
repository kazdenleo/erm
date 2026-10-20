/**
 * Purchase Cargo Places Controller
 * Приёмка грузомест по закупке и товара из них.
 */

import purchaseCargoPlacesService from '../services/purchaseCargoPlaces.service.js';
import { EMPLOYEE_EVENT, logEmployeeEvent } from '../services/employeeActivity.service.js';

function ctx(req) {
  return { profileId: req.user?.profileId ?? null, userId: req.user?.id ?? null };
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      const data = await fn(req);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode >= 400 && e.statusCode < 500) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          ...(typeof e.code === 'string' ? { code: e.code } : {}),
          ...(e.data ? { data: e.data } : {}),
        });
      }
      return next(e);
    }
  };
}

function logScan(req, { receiptId = null, quantity = 0, code = null, error = null }) {
  logEmployeeEvent({
    user: req.user,
    eventType: EMPLOYEE_EVENT.RECEIPT_SCAN,
    isError: Boolean(error),
    entityType: 'purchase_receipt',
    entityId: receiptId,
    quantity: error ? 0 : quantity,
    meta: {
      code: code != null ? String(code).slice(0, 120) : null,
      cargoPlaceId: req.params.placeId ?? null,
      message: error ? String(error).slice(0, 300) : undefined,
    },
  });
}

class PurchaseCargoPlacesController {
  listPurchases = handle((req) =>
    purchaseCargoPlacesService.listPurchases({ profileId: ctx(req).profileId, search: req.query.search })
  );

  getPurchase = handle((req) =>
    purchaseCargoPlacesService.getPurchaseState(req.params.purchaseId, ctx(req))
  );

  setExpected = handle((req) =>
    purchaseCargoPlacesService.setExpectedCount(
      req.params.purchaseId,
      { expectedCargoPlaces: req.body?.expectedCargoPlaces },
      ctx(req)
    )
  );

  acceptPlace = handle((req) =>
    purchaseCargoPlacesService.acceptPlace(
      req.params.purchaseId,
      {
        barcode: req.body?.barcode,
        force: req.body?.force === true,
        forceExceed: req.body?.forceExceed === true,
      },
      ctx(req)
    )
  );

  getPlace = handle((req) => purchaseCargoPlacesService.getPlace(req.params.placeId, ctx(req)));

  removePlace = handle((req) => purchaseCargoPlacesService.removePlace(req.params.placeId, ctx(req)));

  openPlace = handle((req) => purchaseCargoPlacesService.openPlace(req.params.placeId, ctx(req)));

  closePlace = handle((req) => purchaseCargoPlacesService.closePlace(req.params.placeId, ctx(req)));

  addItem = handle(async (req) => {
    const { code, productId, quantity } = req.body || {};
    try {
      const data = await purchaseCargoPlacesService.addItem(req.params.placeId, { code, productId, quantity }, ctx(req));
      logScan(req, { receiptId: data.receiptId, quantity: data.added, code: code ?? productId });
      return data;
    } catch (e) {
      if (e.code !== 'CARGO_PLACE_BARCODE') logScan(req, { code: code ?? productId, error: e.message });
      throw e;
    }
  });

  setItemQuantity = handle((req) =>
    purchaseCargoPlacesService.setItemQuantity(
      req.params.placeId,
      { productId: req.body?.productId, quantity: req.body?.quantity },
      ctx(req)
    )
  );
}

export default new PurchaseCargoPlacesController();

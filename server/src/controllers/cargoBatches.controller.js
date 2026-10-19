/**
 * Приёмка грузомест без закупки.
 */

import cargoBatchesService from '../services/cargoBatches.service.js';
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

function logScan(req, { batchId = null, quantity = 0, code = null, error = null }) {
  logEmployeeEvent({
    user: req.user,
    eventType: EMPLOYEE_EVENT.RECEIPT_SCAN,
    isError: Boolean(error),
    entityType: 'cargo_batch',
    entityId: batchId,
    quantity: error ? 0 : quantity,
    meta: {
      code: code != null ? String(code).slice(0, 120) : null,
      cargoPlaceId: req.params.placeId ?? null,
      message: error ? String(error).slice(0, 300) : undefined,
    },
  });
}

class CargoBatchesController {
  list = handle((req) =>
    cargoBatchesService.listBatches({ profileId: ctx(req).profileId, status: req.query.status })
  );

  create = handle((req) =>
    cargoBatchesService.createBatch(
      {
        warehouseId: req.body?.warehouseId,
        organizationId: req.body?.organizationId,
        expectedPlaces: req.body?.expectedPlaces,
        note: req.body?.note,
      },
      ctx(req)
    )
  );

  get = handle((req) => cargoBatchesService.getBatch(req.params.batchId, ctx(req)));

  setExpected = handle((req) =>
    cargoBatchesService.setExpected(
      req.params.batchId,
      { expectedPlaces: req.body?.expectedPlaces },
      ctx(req)
    )
  );

  acceptPlace = handle((req) =>
    cargoBatchesService.acceptPlace(
      req.params.batchId,
      { barcode: req.body?.barcode, force: req.body?.force === true },
      ctx(req)
    )
  );

  getPlace = handle((req) => cargoBatchesService.getPlace(req.params.placeId, ctx(req)));

  removePlace = handle((req) => cargoBatchesService.removePlace(req.params.placeId, ctx(req)));

  openPlace = handle((req) => cargoBatchesService.openPlace(req.params.placeId, ctx(req)));

  closePlace = handle((req) => cargoBatchesService.closePlace(req.params.placeId, ctx(req)));

  addItem = handle(async (req) => {
    try {
      const data = await cargoBatchesService.addItem(
        req.params.placeId,
        {
          code: req.body?.code,
          productId: req.body?.productId,
          quantity: req.body?.quantity,
        },
        ctx(req)
      );
      logScan(req, {
        batchId: data.batchId,
        quantity: data.added,
        code: req.body?.code,
      });
      return data;
    } catch (e) {
      logScan(req, { code: req.body?.code, error: e.message });
      throw e;
    }
  });

  setItemQuantity = handle((req) =>
    cargoBatchesService.setItemQuantity(
      req.params.placeId,
      { productId: req.body?.productId, quantity: req.body?.quantity },
      ctx(req)
    )
  );

  complete = handle((req) =>
    cargoBatchesService.complete(
      req.params.batchId,
      { supplierId: req.body?.supplierId, organizationId: req.body?.organizationId },
      ctx(req)
    )
  );
}

export default new CargoBatchesController();

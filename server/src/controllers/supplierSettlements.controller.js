/**
 * Взаиморасчёты с поставщиками: балансы, журнал операций, ручные оплаты и корректировки
 */

import settlementsRepo from '../repositories/supplier_settlements.repository.pg.js';
import suppliersRepo from '../repositories/suppliers.repository.pg.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function sendError(res, error, next) {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ ok: false, message: error.message });
  }
  return next(error);
}

class SupplierSettlementsController {
  /** Поставщик в рамках профиля пользователя → req.settlementSupplier */
  async requireSupplier(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ ok: false, message: 'Некорректный поставщик' });
      }
      const supplier = await suppliersRepo.findById(id, tid);
      if (!supplier) return res.status(404).json({ ok: false, message: 'Поставщик не найден' });
      req.settlementSupplier = supplier;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  async listBalances(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) return res.status(200).json({ ok: true, data: [] });
      const data = await settlementsRepo.listBalances(tid);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async getLedger(req, res, next) {
    try {
      const s = req.settlementSupplier;
      const ledger = await settlementsRepo.getLedger(s.id);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true,
        data: {
          supplier: { id: Number(s.id), name: s.name, isActive: s.isActive !== false },
          ...ledger,
        },
      });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async createEntry(req, res, next) {
    try {
      const s = req.settlementSupplier;
      const body = req.body || {};
      const data = await settlementsRepo.createEntry({
        profileId: s.profile_id,
        supplierId: s.id,
        userId: req.user?.id,
        kind: body.kind,
        amount: body.amount,
        targetBalance: body.targetBalance,
        date: body.date,
        comment: body.comment,
      });
      return res.status(201).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async deleteEntry(req, res, next) {
    try {
      const ok = await settlementsRepo.deleteEntry(req.settlementSupplier.id, req.params.entryId);
      if (!ok) return res.status(404).json({ ok: false, message: 'Операция не найдена' });
      return res.status(200).json({ ok: true });
    } catch (error) {
      return sendError(res, error, next);
    }
  }
}

export default new SupplierSettlementsController();

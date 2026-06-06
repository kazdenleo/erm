/**
 * Ручная отправка заказа поставщику (тестовая кнопка «Заказать» в списке заказов).
 */

import repositoryFactory from '../config/repository-factory.js';
import autoProcurementService from './autoProcurement.service.js';
import { trySubmitPurchaseToSupplier } from './supplierOrderPlacement.service.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

class OrderSupplierOrderService {
  async placeOrderForMarketplaceOrder(marketplace, orderId, { profileId, userId = null } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Отправка поставщику доступна только при PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const profilesRepo = repositoryFactory.getProfilesRepository?.();
    const profileRow =
      profilesRepo && typeof profilesRepo.findById === 'function'
        ? await profilesRepo.findById(pid)
        : null;
    if (!isProfileSupplierSyncEnabled(profileRow)) {
      const err = new Error('Работа с поставщиками отключена для этого аккаунта');
      err.statusCode = 403;
      throw err;
    }

    const proc = await autoProcurementService.runForMarketplaceOrder(marketplace, orderId, {
      profileId: pid,
      userId,
      manualTest: true,
    });

    if (!proc?.ok) {
      const err = new Error(proc?.message || 'Не удалось оформить заказ у поставщика');
      err.statusCode =
        proc?.error === 'order_not_found'
          ? 404
          : proc?.error === 'already_in_purchase'
            ? 409
            : 400;
      err.details = proc;
      throw err;
    }

    const supplierApi = await trySubmitPurchaseToSupplier({
      purchaseId: proc.purchaseId,
      supplierId: proc.supplierId,
      profileId: pid,
    });

    return {
      ...proc,
      supplierApi,
      message: proc.appendedToExisting
        ? `Позиции добавлены в открытую закупку №${proc.purchaseId} (${proc.supplierName || 'поставщик'})`
        : `Создана закупка №${proc.purchaseId} у ${proc.supplierName || 'поставщика'}`,
    };
  }
}

export default new OrderSupplierOrderService();

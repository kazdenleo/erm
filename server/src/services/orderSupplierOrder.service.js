/**
 * Ручная отправка заказа в закупку (кнопка «Отправить в закупку»).
 */

import repositoryFactory from '../config/repository-factory.js';
import orderProcurementPlanner from './orderProcurementPlanner.service.js';
import { isProfileSupplierSyncEnabled } from '../utils/profileSupplierSync.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

class OrderSupplierOrderService {
  /** @deprecated Используйте sendToProcurement — оставлено для совместимости. */
  async placeOrderForMarketplaceOrder(marketplace, orderId, opts = {}) {
    return this.sendToProcurement(marketplace, orderId, opts);
  }

  async sendToProcurement(marketplace, orderId, { profileId, userId = null } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Отправка в закупку доступна только при PostgreSQL');
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

    const proc = await orderProcurementPlanner.runForMarketplaceOrder(marketplace, orderId, {
      profileId: pid,
      userId,
    });

    if (!proc?.ok) {
      const err = new Error(proc?.message || 'Не удалось отправить заказ в закупку');
      err.statusCode =
        proc?.error === 'order_not_found'
          ? 404
          : proc?.error === 'already_in_purchase'
            ? 409
            : proc?.error === 'manual_required'
              ? 422
              : proc?.error === 'product_not_resolved' || proc?.error === 'no_demand'
                ? 400
                : 400;
      err.details = proc;
      throw err;
    }

    return proc;
  }

  async getProcurementLines(marketplace, orderId, { profileId } = {}) {
    return orderProcurementPlanner.listFulfillmentLinesForMarketplaceOrder(marketplace, orderId, {
      profileId: normalizeProfileId(profileId),
    });
  }

  async manualProcure(marketplace, orderId, opts = {}) {
    const pid = normalizeProfileId(opts.profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Ручная закупка доступна только при PostgreSQL');
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

    const result = await orderProcurementPlanner.manualProcureForMarketplaceOrder(
      marketplace,
      orderId,
      { ...opts, profileId: pid }
    );

    if (!result?.ok) {
      const err = new Error(result?.message || 'Не удалось оформить ручную закупку');
      err.statusCode =
        result?.error === 'order_not_found'
          ? 404
          : result?.error === 'line_not_found' || result?.error === 'qty_exceeds_deficit'
            ? 400
            : 400;
      err.details = result;
      throw err;
    }

    return result;
  }
}

export default new OrderSupplierOrderService();

/**
 * База клиентов для частных заказов
 */

import customersRepo from '../repositories/customers.repository.pg.js';
import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const profilesRepo = repositoryFactory.getProfilesRepository();

function sendError(res, error, next) {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ ok: false, message: error.message });
  }
  return next(error);
}

class CustomersController {
  /** Доступ только при включённых частных заказах в настройках аккаунта. */
  async requirePrivateOrders(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const prof = await profilesRepo.findById(tid);
      if (!prof || prof.allow_private_orders !== true) {
        return res.status(403).json({
          ok: false,
          message: 'Работа с частными заказами отключена в общих настройках аккаунта.',
        });
      }
      req.customersProfileId = tid;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  async list(req, res, next) {
    try {
      const { items, total } = await customersRepo.list(req.customersProfileId, {
        search: req.query?.search,
        sort: req.query?.sort,
        dir: req.query?.dir,
        limit: req.query?.limit,
        offset: req.query?.offset,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: items, meta: { total } });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async getOne(req, res, next) {
    try {
      const data = await customersRepo.findByIdAndProfile(req.params.customerId, req.customersProfileId);
      if (!data) return res.status(404).json({ ok: false, message: 'Клиент не найден' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async getOrders(req, res, next) {
    try {
      const customer = await customersRepo.findByIdAndProfile(req.params.customerId, req.customersProfileId);
      if (!customer) return res.status(404).json({ ok: false, message: 'Клиент не найден' });
      const data = await customersRepo.listOrders(customer.id, req.customersProfileId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async create(req, res, next) {
    try {
      const data = await customersRepo.create(req.customersProfileId, req.body || {});
      return res.status(201).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async update(req, res, next) {
    try {
      const data = await customersRepo.update(req.params.customerId, req.customersProfileId, req.body || {});
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      return sendError(res, error, next);
    }
  }

  async remove(req, res, next) {
    try {
      const ok = await customersRepo.delete(req.params.customerId, req.customersProfileId);
      if (!ok) return res.status(404).json({ ok: false, message: 'Клиент не найден' });
      return res.status(200).json({ ok: true });
    } catch (error) {
      return sendError(res, error, next);
    }
  }
}

export default new CustomersController();

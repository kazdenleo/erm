/**
 * Brands Controller
 * Контроллер для управления брендами
 */

import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const brandsRepository = repositoryFactory.getBrandsRepository();

export const brandsController = {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.json({ ok: true, data: [] });
      }
      const brands = await brandsRepository.findAll(tid != null ? { profileId: tid } : {});
      res.json({ ok: true, data: brands });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const brand = await brandsRepository.findById(id);
      if (!brand) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      res.json({ ok: true, data: brand });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const brandData = req.body;
      const brand = await brandsRepository.create(brandData, { profileId: tid });
      res.status(201).json({ ok: true, data: brand });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      const cur = await brandsRepository.findById(id);
      if (!cur) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      if (Number(cur.profile_id) !== Number(tid)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const updates = req.body;
      const brand = await brandsRepository.update(id, updates);
      if (!brand) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      res.json({ ok: true, data: brand });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      const cur = await brandsRepository.findById(id);
      if (!cur) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      if (Number(cur.profile_id) !== Number(tid)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const deleted = await brandsRepository.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      res.json({ ok: true, message: 'Бренд удален' });
    } catch (error) {
      next(error);
    }
  }
};


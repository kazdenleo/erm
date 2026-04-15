/**
 * Organizations Controller
 * Управление организациями
 */

import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const repo = repositoryFactory.getOrganizationsRepository();

export const organizationsController = {
  async getAll(req, res, next) {
    try {
      const filters = {};
      if (req.user && req.user.role !== 'admin') {
        const tid = tenantListProfileId(req);
        if (tid === TENANT_LIST_EMPTY) {
          return res.json({ ok: true, data: [] });
        }
        filters.profileId = tid;
      }
      const list = await repo.findAll(filters);
      res.json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const item = await repo.findById(id);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Организация не найдена' });
      }
      if (req.user && req.user.role !== 'admin' && item.profile_id != null && Number(item.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к этой организации' });
      }
      res.json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const body = { ...req.body };
      if (req.user && req.user.role !== 'admin') {
        body.profile_id = req.user.profileId;
      }
      const item = await repo.create(body);
      res.status(201).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const existing = await repo.findById(id);
      if (!existing) {
        return res.status(404).json({ ok: false, message: 'Организация не найдена' });
      }
      if (req.user && req.user.role !== 'admin' && existing.profile_id != null && Number(existing.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к этой организации' });
      }
      const item = await repo.update(id, req.body);
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Организация не найдена' });
      }
      res.json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const existing = await repo.findById(id);
      if (!existing) {
        return res.status(404).json({ ok: false, message: 'Организация не найдена' });
      }
      if (req.user && req.user.role !== 'admin' && existing.profile_id != null && Number(existing.profile_id) !== req.user.profileId) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к этой организации' });
      }
      const deleted = await repo.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Организация не найдена' });
      }
      res.json({ ok: true, message: 'Организация удалена' });
    } catch (error) {
      next(error);
    }
  }
};

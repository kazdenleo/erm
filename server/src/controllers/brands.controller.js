/**
 * Brands Controller
 * Контроллер для управления брендами
 */

import repositoryFactory from '../config/repository-factory.js';

const brandsRepository = repositoryFactory.getBrandsRepository();

export const brandsController = {
  async getAll(req, res, next) {
    try {
      const brands = await brandsRepository.findAll();
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
      const brandData = req.body;
      const brand = await brandsRepository.create(brandData);
      res.status(201).json({ ok: true, data: brand });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const { id } = req.params;
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
      const { id } = req.params;
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


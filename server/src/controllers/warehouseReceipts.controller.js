/**
 * Warehouse Receipts Controller
 * Оформление приёмок на склад
 */

import warehouseReceiptsService from '../services/warehouseReceipts.service.js';

class WarehouseReceiptsController {
  async list(req, res, next) {
    try {
      const limit = req.query.limit ? Math.min(500, parseInt(req.query.limit, 10)) : 100;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const result = await warehouseReceiptsService.getList({ limit, offset });
      return res.status(200).json({ ok: true, data: result.list, total: result.total });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok: false, message: 'Некорректный ID' });
      const receipt = await warehouseReceiptsService.getByIdWithLines(id);
      if (!receipt) return res.status(404).json({ ok: false, message: 'Приёмка не найдена' });
      return res.status(200).json({ ok: true, data: receipt });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { documentType, organizationId, supplierId, lines } = req.body || {};
      const linesArr = Array.isArray(lines) ? lines : [];
      if (documentType === 'return') {
        const result = await warehouseReceiptsService.createReturn({
          organizationId: organizationId || null,
          supplierId: supplierId || null,
          lines: linesArr
        });
        return res.status(200).json({ ok: true, data: result });
      }
      if (documentType === 'customer_return') {
        const result = await warehouseReceiptsService.createCustomerReturn({
          organizationId: organizationId || null,
          lines: linesArr
        });
        return res.status(200).json({ ok: true, data: result });
      }
      const result = await warehouseReceiptsService.createReceipt({
        organizationId: organizationId || null,
        supplierId: supplierId || null,
        lines: linesArr
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok: false, message: 'Некорректный ID' });
      const result = await warehouseReceiptsService.deleteReceipt(id);
      if (!result) return res.status(404).json({ ok: false, message: 'Документ не найден' });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export default new WarehouseReceiptsController();

/**
 * Stock Problems Controller
 */

import { getProblemOrders, refreshProblemOrdersFlags } from '../services/stockProblems.service.js';

class StockProblemsController {
  async getProblemOrders(req, res, next) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const data = await getProblemOrders({ limit });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async refreshFlags(req, res, next) {
    try {
      const data = await refreshProblemOrdersFlags();
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 501) {
        return res.status(501).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new StockProblemsController();


/**
 * Stock Problems Controller
 */

import { getProblemOrders, refreshProblemOrdersFlags } from '../services/stockProblems.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class StockProblemsController {
  async getProblemOrders(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const data = await getProblemOrders({
        limit,
        ...(tid != null ? { profileId: tid } : {})
      });
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


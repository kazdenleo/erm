/**
 * GET /api/search?q=...
 */

import globalSearchService from '../services/globalSearch.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class GlobalSearchController {
  async search(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Профиль не определён' });
      }
      const q = req.query?.q ?? req.query?.search ?? '';
      const limit = req.query?.limit;
      const data = await globalSearchService.search(tid, q, { limit });
      return res.json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }
}

export default new GlobalSearchController();

/**
 * Заявки на возврат с маркетплейсов: список из БД + sync + решение продавца.
 */

import {
  getMarketplaceReturnClaimById,
  getMarketplaceReturnClaimsStats,
  listMarketplaceReturnClaims,
  submitMarketplaceReturnClaimDecision,
  syncMarketplaceReturnClaims,
} from '../services/marketplaceReturnClaims.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import logger from '../utils/logger.js';

class MarketplaceReturnClaimsController {
  parseOrganizationId(req) {
    const raw = req.get('x-organization-id') || req.get('X-Organization-Id');
    if (raw == null) return null;
    const s = String(raw).trim();
    return s === '' ? null : s;
  }

  async getOne(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: null });
      }
      const refreshRaw = req.query?.refresh;
      const refresh =
        refreshRaw == null || refreshRaw === ''
          ? true
          : !['0', 'false', 'no'].includes(String(refreshRaw).trim().toLowerCase());
      const item = await getMarketplaceReturnClaimById(tid, req.params.id, { refresh });
      if (!item) {
        return res.status(404).json({ ok: false, message: 'Заявка не найдена' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: item });
    } catch (error) {
      next(error);
    }
  }

  async getList(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      const items = await listMarketplaceReturnClaims(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: items });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
          ok: true,
          data: {
            pendingCount: 0,
            counts: { all: 0, pending: 0, done: 0 },
            countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
          },
        });
      }
      const data = await getMarketplaceReturnClaimsStats(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async sync(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const onlyRaw = req.query?.marketplace;
      const only =
        onlyRaw != null && String(onlyRaw).trim() !== '' ? String(onlyRaw).trim().toLowerCase() : null;
      logger.info('[ReturnClaims] sync', { profileId: pid, only });
      const data = await syncMarketplaceReturnClaims(pid, { only });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  async decide(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const data = await submitMarketplaceReturnClaimDecision(pid, req.params.id, body);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }
}

export default new MarketplaceReturnClaimsController();

/**
 * Правила автоответа на отзывы
 */

import reviewAutoReplyRulesRepo from '../repositories/review_auto_reply_rules.repository.pg.js';
import { processReviewAutoReplies } from '../services/marketplaceReviews.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class ReviewAutoReplyRulesController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const data = await reviewAutoReplyRulesRepo.listByProfile(tid);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async saveAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const rules = req.body?.rules ?? req.body;
      const data = await reviewAutoReplyRulesRepo.replaceAll(tid, rules);
      let autoReply = null;
      try {
        autoReply = await processReviewAutoReplies(tid, { limit: 80 });
      } catch (e) {
        autoReply = { answered: 0, errors: [e?.message || String(e)] };
      }
      return res.status(200).json({ ok: true, data, autoReply });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  /** Ручной прогон автоответов по текущим правилам. */
  async runNow(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const data = await processReviewAutoReplies(pid, { limit: 80 });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }
}

export default new ReviewAutoReplyRulesController();

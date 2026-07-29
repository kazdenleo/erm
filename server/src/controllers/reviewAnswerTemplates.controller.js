/**
 * Шаблоны ответов на отзывы
 */

import reviewReplyTemplatesRepo from '../repositories/review_reply_templates.repository.pg.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class ReviewAnswerTemplatesController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const data = await reviewReplyTemplatesRepo.listByProfile(tid);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const data = await reviewReplyTemplatesRepo.create(tid, {
        title: req.body?.title,
        body: req.body?.body,
        sortOrder: req.body?.sortOrder ?? req.body?.sort_order,
      });
      return res.status(201).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const data = await reviewReplyTemplatesRepo.update(req.params.templateId, tid, {
        title: req.body?.title,
        body: req.body?.body,
        sortOrder: req.body?.sortOrder ?? req.body?.sort_order,
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  }

  async remove(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к профилю' });
      }
      const ok = await reviewReplyTemplatesRepo.delete(req.params.templateId, tid);
      if (!ok) return res.status(404).json({ ok: false, message: 'Шаблон не найден' });
      return res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
}

export default new ReviewAnswerTemplatesController();

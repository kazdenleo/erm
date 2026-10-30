import { listSubscriptionPlansPublic, TRIAL_DAYS } from '../constants/subscriptionPlans.js';
import { buildOfferDocument, buildPrivacyDocument } from '../constants/legalDocuments.js';
import * as subscriptionBilling from '../services/subscriptionBilling.service.js';
import { profileIdFromDb } from '../utils/profileId.js';
import { getPlanUsage } from '../utils/planLimits.js';
import { isYookassaConfigured } from '../services/yookassa.service.js';

function requireProfileId(req, res) {
  const pid = profileIdFromDb(req.user?.profileId ?? req.user?.profile_id);
  if (pid == null) {
    res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
    return null;
  }
  return pid;
}

class BillingController {
  async listPlans(_req, res) {
    const online = isYookassaConfigured();
    return res.status(200).json({
      ok: true,
      data: {
        trialDays: TRIAL_DAYS,
        onlinePaymentsEnabled: online,
        paymentNote: online
          ? 'Можно оплатить онлайн (ЮKassa) или оставить заявку на счёт / перевод.'
          : 'Оставьте заявку на тариф — после оплаты (счёт / перевод) администратор активирует доступ. Онлайн-оплата включается переменными YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.',
        plans: listSubscriptionPlansPublic(),
      },
    });
  }

  async myUsage(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const data = await getPlanUsage(profileId);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      return next(error);
    }
  }

  async getOffer(_req, res) {
    return res.status(200).json({ ok: true, data: buildOfferDocument() });
  }

  async getPrivacy(_req, res) {
    return res.status(200).json({ ok: true, data: buildPrivacyDocument() });
  }

  async createRequest(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const { planCode, plan_code, period, comment, commentText } = req.body || {};
      const row = await subscriptionBilling.createSubscriptionRequest({
        profileId,
        userId: req.user.id,
        planCode: planCode ?? plan_code,
        period,
        commentText: comment ?? commentText,
      });
      return res.status(201).json({
        ok: true,
        data: subscriptionBilling.presentRequest(row),
        message:
          'Заявка принята. Мы активируем тариф после оплаты — детали можно уточнить в поддержке.',
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          ok: false,
          message: error.message,
          data: error.data ? subscriptionBilling.presentRequest(error.data) : undefined,
        });
      }
      return next(error);
    }
  }

  async createCheckout(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const { planCode, plan_code, period } = req.body || {};
      const row = await subscriptionBilling.createOnlineCheckout({
        profileId,
        userId: req.user.id,
        planCode: planCode ?? plan_code,
        period,
      });
      const data = subscriptionBilling.presentRequest(row);
      return res.status(201).json({
        ok: true,
        data,
        confirmationUrl: data.confirmationUrl,
        message: 'Перейдите по ссылке для оплаты',
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          ok: false,
          code: error.code,
          message: error.message,
          data: error.data ? subscriptionBilling.presentRequest(error.data) : undefined,
        });
      }
      return next(error);
    }
  }

  async syncMyPayment(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const rows = await subscriptionBilling.listMyRequests(profileId);
      const pendingPay = rows.find(
        (r) =>
          r.status === 'pending' &&
          r.payment_provider === 'yookassa' &&
          r.external_payment_id
      );
      if (!pendingPay?.external_payment_id) {
        return res.status(200).json({
          ok: true,
          data: { synced: false, requests: rows.map(subscriptionBilling.presentRequest) },
        });
      }
      const result = await subscriptionBilling.applySucceededPayment(
        pendingPay.external_payment_id,
        { source: 'return_sync' }
      );
      const refreshed = await subscriptionBilling.listMyRequests(profileId);
      return res.status(200).json({
        ok: true,
        data: {
          synced: !!result?.ok,
          result,
          requests: refreshed.map(subscriptionBilling.presentRequest),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async yookassaWebhook(req, res, next) {
    try {
      const out = await subscriptionBilling.handleYookassaNotification(req.body || {});
      // ЮKassa ждёт 200, иначе ретраи
      return res.status(200).json({ ok: true, data: out });
    } catch (error) {
      return next(error);
    }
  }

  async listMyRequests(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const rows = await subscriptionBilling.listMyRequests(profileId);
      return res.status(200).json({
        ok: true,
        data: rows.map(subscriptionBilling.presentRequest),
      });
    } catch (error) {
      return next(error);
    }
  }

  async cancelMyRequest(req, res, next) {
    try {
      const profileId = requireProfileId(req, res);
      if (profileId == null) return;
      const rows = await subscriptionBilling.cancelMyPendingRequest(profileId, req.user.id);
      return res.status(200).json({
        ok: true,
        data: rows.map(subscriptionBilling.presentRequest),
        message: rows.length ? 'Заявка отменена' : 'Открытых заявок нет',
      });
    } catch (error) {
      return next(error);
    }
  }

  async adminListRequests(req, res, next) {
    try {
      const status = req.query.status || null;
      const rows = await subscriptionBilling.listAdminRequests({
        status: status === 'all' ? null : status || 'pending',
        limit: req.query.limit,
      });
      return res.status(200).json({
        ok: true,
        data: rows.map(subscriptionBilling.presentRequest),
      });
    } catch (error) {
      return next(error);
    }
  }

  async adminApprove(req, res, next) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id' });
      }
      const out = await subscriptionBilling.approveRequest(id, {
        adminUserId: req.user.id,
        adminNote: req.body?.adminNote ?? req.body?.admin_note,
      });
      return res.status(200).json({
        ok: true,
        data: {
          request: subscriptionBilling.presentRequest(out.request),
          profile: out.profile,
        },
        message: 'Тариф активирован',
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      return next(error);
    }
  }

  async adminReject(req, res, next) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, message: 'Некорректный id' });
      }
      const row = await subscriptionBilling.rejectRequest(id, {
        adminUserId: req.user.id,
        adminNote: req.body?.adminNote ?? req.body?.admin_note,
      });
      return res.status(200).json({
        ok: true,
        data: subscriptionBilling.presentRequest(row),
        message: 'Заявка отклонена',
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      return next(error);
    }
  }

  async adminAudit(req, res, next) {
    try {
      const profileId = Number(req.params.profileId);
      if (!Number.isFinite(profileId)) {
        return res.status(400).json({ ok: false, message: 'Некорректный profileId' });
      }
      const rows = await subscriptionBilling.getSubscriptionAudit(profileId, {
        limit: req.query.limit,
      });
      return res.status(200).json({ ok: true, data: rows });
    } catch (error) {
      return next(error);
    }
  }
}

export default new BillingController();

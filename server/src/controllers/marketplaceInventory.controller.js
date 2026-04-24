import {
  getLatestMarketplaceInventorySummary,
  runMarketplaceInventoryDailySnapshot
} from '../services/marketplaceInventorySnapshots.service.js';
import repositoryFactory from '../config/repository-factory.js';

const MARKETPLACES = ['ozon', 'wildberries', 'yandex'];

function normMp(mp) {
  const m = String(mp || '').toLowerCase().trim();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m;
}

function stateLabel(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'mp_warehouse') return 'На складах МП';
  if (s === 'to_customer') return 'В пути к клиенту';
  if (s === 'returning') return 'Возвраты / обратно';
  return s;
}

const COMPARISON_NOTE =
  'Колонка «В пути к клиенту» в таблице — из последнего снапшота по API МП (WB: сумма inWayToClient по отчёту складов; Ozon: товары в FBS-постингах с логистическими статусами). Поле ermOrdersInDelivery — ваши заказы «В доставке» в ERM; расхождение обычно нормально. Срез ответа МП после «Обновить» — в mpApiDiagnostics.';

async function buildInventorySummaryPayload(req) {
  const profileId = req.user?.profileId ?? null;
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? Number(orgHeader) : null;
  const invRepo = repositoryFactory.getMarketplaceInventorySnapshotsRepository();
  const out = [];
  for (const mp of MARKETPLACES) {
    const m = normMp(mp);
    const data = await getLatestMarketplaceInventorySummary({ marketplace: m, profileId, organizationId });
    const costs = Array.isArray(data?.costs) ? data.costs : [];
    let ermInDelivery = null;
    if (profileId != null && String(profileId).trim() !== '') {
      const row = await invRepo.getToCustomerFromOrders({ profileId, marketplace: m }).catch(() => null);
      if (row) {
        ermInDelivery = {
          qty: Number(row.qty_sum ?? 0) || 0,
          costSum: row.cost_sum != null ? Number(row.cost_sum) : 0,
          matchedProducts: Number(row.matched_products ?? 0) || 0,
          note:
            'Это сумма quantity по заказам в ERM со статусом in_transit или shipped — для сравнения с колонкой «В пути к клиенту», которая считается из API маркетплейса (другая метрика).',
        };
      }
    }
    out.push({
      marketplace: m,
      snapshot: data?.snapshot ?? null,
      totals: data?.totals ?? [],
      costs: costs.map((r) => ({
        state: r.state,
        label: stateLabel(r.state),
        qty: Number(r.qty_sum ?? r.qty ?? 0) || 0,
        costSum: r.cost_sum != null ? Number(r.cost_sum) : 0,
        matchedProducts: Number(r.matched_products ?? 0) || 0,
      })),
      ermOrdersInDelivery: ermInDelivery,
    });
  }
  return { ok: true, data: out, comparisonNote: COMPARISON_NOTE };
}

export async function getSummary(req, res) {
  const canManage =
    req.user?.role === 'admin' ||
    !!(req.user?.isProfileAdmin ?? req.user?.is_profile_admin) ||
    String(req.user?.accountRole ?? req.user?.account_role ?? '').toLowerCase() === 'admin';
  if (!canManage) {
    return res.status(403).json({ ok: false, message: 'Доступно только администратору аккаунта' });
  }

  const payload = await buildInventorySummaryPayload(req);
  return res.json(payload);
}

export async function runNow(req, res) {
  const canManage =
    req.user?.role === 'admin' ||
    !!(req.user?.isProfileAdmin ?? req.user?.is_profile_admin) ||
    String(req.user?.accountRole ?? req.user?.account_role ?? '').toLowerCase() === 'admin';
  if (!canManage) {
    return res.status(403).json({ ok: false, message: 'Доступно только администратору аккаунта' });
  }

  const profileId = req.user?.profileId ?? null;
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  const organizationId = orgHeader != null && String(orgHeader).trim() !== '' ? Number(orgHeader) : null;
  const snapResult = await runMarketplaceInventoryDailySnapshot({ profileId, organizationId });
  const mpApiDiagnostics = {};
  for (const c of snapResult?.created || []) {
    if (c?.marketplace && c?.diagnostics) mpApiDiagnostics[c.marketplace] = c.diagnostics;
  }
  const payload = await buildInventorySummaryPayload(req);
  return res.json({ ...payload, mpApiDiagnostics });
}


/**
 * Показатели сотрудников: сборка FBS и FBO, упаковка FBO, ошибки скана, приёмка, инвентаризация, задачи.
 *
 * Время работы — сумма промежутков между соседними сканами сотрудника. Промежуток длиннее порога простоя
 * считается перерывом (сотрудник отошёл) и не засчитывается: отсчёт стоит до следующего скана.
 *
 * FBS: отметки «Собран» (orders.assembled_*, вся история) + сканы из employee_activity_events.
 * FBO-сборка: fbo_supply_item_scans. Упаковка FBO: employee_activity_events (fbo_packing_scan).
 * Приёмка: время от создания до закрытия документа (без остановки на паузы) ÷ принятые штуки.
 */

import { query } from '../config/database.js';
import { requireAnalyticsProfile, resolvePeriod, round2 } from '../utils/analyticsCommon.js';

const FBS_IDLE_SEC = 3 * 60;
const FBO_COLLECT_IDLE_SEC = 60;
const FBO_PACKING_IDLE_SEC = 3 * 60;

const ROLE_LABELS = {
  admin: 'Администратор',
  picker: 'Сборщик',
  warehouse_manager: 'Руководитель склада',
  editor: 'Редактор',
};

function userDisplayName(u) {
  const fio = [u.last_name, u.first_name].filter(Boolean).join(' ').trim();
  return fio || u.full_name || u.email || u.phone || `Пользователь #${u.id}`;
}

function periodBoundsSql() {
  return `($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'`;
}

function periodEndSql() {
  return `(($3::date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow'`;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Активное время по сканам одного сотрудника.
 * @param {{ t: number, units: number }[]} marks — units: сколько единиц работы закрывает отметка (заказ / штука)
 * @returns {{ activeSec: number, timedUnits: number }} timedUnits — единицы, перед которыми не было перерыва
 */
function activeTime(marks, idleSec) {
  const sorted = [...marks].filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
  let activeSec = 0;
  let timedUnits = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gapSec = (sorted[i].t - sorted[i - 1].t) / 1000;
    if (gapSec <= idleSec) {
      activeSec += gapSec;
      timedUnits += sorted[i].units;
    }
  }
  return { activeSec, timedUnits };
}

function perUnit(activeSec, timedUnits) {
  return timedUnits > 0 ? Math.round(activeSec / timedUnits) : null;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Время приёмки на штуку. avgSec — всё время ÷ все штуки (крупная приёмка весит больше),
 * medianSec — медиана «время ÷ штуки» по приёмкам. Приёмки без принятых штук не учитываются.
 * @param {{ d: number, units: number }[]} list
 */
function receiptPerUnit(list) {
  if (!list.length) return { avgSec: null, medianSec: null };
  const sumD = list.reduce((s, x) => s + x.d, 0);
  const sumU = list.reduce((s, x) => s + x.units, 0);
  return { avgSec: round1(sumD / sumU), medianSec: round1(median(list.map((x) => x.d / x.units))) };
}

const MSK_OFFSET_MS = 3 * 3600 * 1000;

function mskDay(t) {
  return new Date(t + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** По дням (МСК): qty — объём за день, sec — время на единицу за день. Перерыв через полночь не считается. */
function dailyActive(marks, idleSec) {
  const byDay = new Map();
  for (const m of marks) {
    if (!Number.isFinite(m.t)) continue;
    const d = mskDay(m.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(m);
  }
  const out = {};
  for (const [d, list] of byDay) {
    const { activeSec, timedUnits } = activeTime(list, idleSec);
    out[d] = { qty: list.reduce((s, m) => s + (Number(m.qty) || 0), 0), sec: perUnit(activeSec, timedUnits) };
  }
  return out;
}

class EmployeeMetricsService {
  async getMetrics({ profileId, dateFrom = null, dateTo = null } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days } = resolvePeriod(dateFrom, dateTo, 28);
    const params = [pid, fromYmd, toYmd];
    const from = periodBoundsSql();
    const to = periodEndSql();

    const [
      usersRes,
      assemblyRes,
      eventsRes,
      eventMarksRes,
      fboScansRes,
      receiptsRes,
      inventoryRes,
      tasksRes,
      trackingRes,
    ] = await Promise.all([
      query(
        `SELECT id, email, phone, full_name, first_name, last_name, account_role, role
           FROM users WHERE profile_id = $1`,
        [pid]
      ),
      query(
        `SELECT o.assembled_by_user_id AS user_id,
                COALESCE(NULLIF(o.order_group_id, ''), o.marketplace || ':' || o.order_id) AS order_key,
                MIN(o.assembled_at) AS assembled_at,
                SUM(GREATEST(COALESCE(o.quantity, 1), 1))::int AS qty
           FROM orders o
          WHERE o.profile_id = $1
            AND o.assembled_by_user_id IS NOT NULL
            AND o.assembled_at >= ${from} AND o.assembled_at < ${to}
          GROUP BY 1, 2`,
        params
      ),
      query(
        `SELECT user_id, event_type,
                COUNT(*) FILTER (WHERE NOT is_error)::int AS ok_count,
                COUNT(*) FILTER (WHERE is_error)::int AS error_count,
                COALESCE(SUM(quantity) FILTER (WHERE NOT is_error), 0)::int AS qty
           FROM employee_activity_events
          WHERE profile_id = $1 AND created_at >= ${from} AND created_at < ${to}
          GROUP BY 1, 2`,
        params
      ),
      query(
        `SELECT user_id, event_type, created_at, quantity, is_error
           FROM employee_activity_events
          WHERE profile_id = $1
            AND event_type IN ('assembly_scan', 'assembly_collected', 'fbo_packing_scan')
            AND created_at >= ${from} AND created_at < ${to}`,
        params
      ),
      query(
        `SELECT s.user_id, s.created_at, s.fbo_supply_id
           FROM fbo_supply_item_scans s
           JOIN fbo_supplies f ON f.id = s.fbo_supply_id AND f.profile_id = $1
          WHERE s.user_id IS NOT NULL
            AND s.created_at >= ${from} AND s.created_at < ${to}`,
        params
      ),
      query(
        `SELECT pr.created_by_user_id AS user_id,
                to_char(pr.completed_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
                EXTRACT(EPOCH FROM (pr.completed_at - pr.created_at)) AS duration_sec,
                COALESCE(it.scanned, 0)::int AS units,
                COALESCE(it.diff_lines, 0)::int AS diff_lines
           FROM purchase_receipts pr
           JOIN purchases pu ON pu.id = pr.purchase_id AND pu.profile_id = $1
           LEFT JOIN LATERAL (
             SELECT SUM(GREATEST(COALESCE(i.scanned_quantity, 0), 0)) AS scanned,
                    COUNT(*) FILTER (
                      WHERE i.expected_quantity IS NOT NULL
                        AND COALESCE(i.scanned_quantity, 0) <> i.expected_quantity
                    ) AS diff_lines
               FROM purchase_receipt_items i
              WHERE i.receipt_id = pr.id
           ) it ON TRUE
          WHERE pr.status = 'completed'
            AND pr.created_by_user_id IS NOT NULL
            AND pr.completed_at >= ${from} AND pr.completed_at < ${to}`,
        params
      ),
      query(
        `SELECT created_by_user_id AS user_id,
                COUNT(*)::int AS sessions,
                COALESCE(SUM(lines_count), 0)::int AS lines
           FROM inventory_sessions
          WHERE profile_id = $1 AND created_by_user_id IS NOT NULL
            AND created_at >= ${from} AND created_at < ${to}
          GROUP BY 1`,
        params
      ),
      query(
        `SELECT completed_by_id AS user_id, COUNT(*)::int AS tasks
           FROM employee_tasks
          WHERE profile_id = $1 AND completed_by_id IS NOT NULL
            AND completed_at >= ${from} AND completed_at < ${to}
          GROUP BY 1`,
        params
      ),
      query(
        `SELECT MIN(created_at) FILTER (WHERE event_type IN ('assembly_scan', 'assembly_collected')) AS fbs_since,
                MIN(created_at) FILTER (WHERE event_type = 'fbo_packing_scan') AS packing_since,
                MIN(created_at) AS since
           FROM employee_activity_events WHERE profile_id = $1`,
        [pid]
      ),
    ]);

    const byUser = new Map();
    const ensure = (userId) => {
      const id = Number(userId);
      if (!byUser.has(id)) {
        byUser.set(id, {
          userId: id,
          name: `Пользователь #${id}`,
          role: null,
          fbs: { orders: 0, units: 0, marks: [] },
          fboCollect: { units: 0, supplies: new Set(), marks: [] },
          packing: { units: 0, supplies: 0, marks: [] },
          scans: { assemblyOk: 0, assemblyErrors: 0, receiptOk: 0, receiptErrors: 0, receiptUnits: 0, packingErrors: 0 },
          receipts: { receipts: 0, units: 0, diffLines: 0, timed: [], byDay: {} },
          inventory: { sessions: 0, lines: 0 },
          tasks: 0,
        });
      }
      return byUser.get(id);
    };

    const userInfo = new Map((usersRes.rows || []).map((u) => [Number(u.id), u]));
    const ts = (v) => new Date(v).getTime();

    for (const row of assemblyRes.rows || []) {
      const u = ensure(row.user_id);
      u.fbs.orders += 1;
      u.fbs.units += Number(row.qty) || 0;
      u.fbs.marks.push({ t: ts(row.assembled_at), units: 1, qty: 1 });
    }
    for (const row of eventMarksRes.rows || []) {
      const u = ensure(row.user_id);
      if (row.event_type === 'fbo_packing_scan') {
        const q = row.is_error ? 0 : Number(row.quantity) || 0;
        u.packing.marks.push({ t: ts(row.created_at), units: Math.max(q, 0), qty: q });
      } else {
        u.fbs.marks.push({ t: ts(row.created_at), units: 0, qty: 0 });
      }
    }
    for (const row of fboScansRes.rows || []) {
      const u = ensure(row.user_id);
      u.fboCollect.units += 1;
      u.fboCollect.supplies.add(String(row.fbo_supply_id));
      u.fboCollect.marks.push({ t: ts(row.created_at), units: 1, qty: 1 });
    }
    for (const row of eventsRes.rows || []) {
      const u = ensure(row.user_id);
      if (row.event_type === 'assembly_scan') {
        u.scans.assemblyOk += Number(row.ok_count) || 0;
        u.scans.assemblyErrors += Number(row.error_count) || 0;
      } else if (row.event_type === 'receipt_scan') {
        u.scans.receiptOk += Number(row.ok_count) || 0;
        u.scans.receiptErrors += Number(row.error_count) || 0;
        u.scans.receiptUnits += Number(row.qty) || 0;
      } else if (row.event_type === 'fbo_packing_scan') {
        u.packing.units += Number(row.qty) || 0;
        u.scans.packingErrors += Number(row.error_count) || 0;
      }
    }
    for (const row of receiptsRes.rows || []) {
      const u = ensure(row.user_id);
      u.receipts.receipts += 1;
      u.receipts.units += Number(row.units) || 0;
      u.receipts.diffLines += Number(row.diff_lines) || 0;
      const d = Number(row.duration_sec);
      const units = Number(row.units) || 0;
      const timed = Number.isFinite(d) && d > 0 && units > 0 ? { d, units } : null;
      if (timed) u.receipts.timed.push(timed);
      if (row.day) {
        const day = (u.receipts.byDay[row.day] ||= { qty: 0, timed: [] });
        day.qty += units;
        if (timed) day.timed.push(timed);
      }
    }
    for (const row of inventoryRes.rows || []) {
      const u = ensure(row.user_id);
      u.inventory.sessions = Number(row.sessions) || 0;
      u.inventory.lines = Number(row.lines) || 0;
    }
    for (const row of tasksRes.rows || []) {
      ensure(row.user_id).tasks = Number(row.tasks) || 0;
    }

    const totals = {
      fbs: { activeSec: 0, timedUnits: 0 },
      fboCollect: { activeSec: 0, timedUnits: 0 },
      packing: { activeSec: 0, timedUnits: 0 },
      receiptsTimed: [],
    };
    const allDays = new Set();

    const employees = [...byUser.values()]
      .map((u) => {
        const info = userInfo.get(u.userId);
        if (info) {
          u.name = userDisplayName(info);
          u.role = ROLE_LABELS[info.account_role] || (info.role === 'admin' ? 'Администратор' : null);
        }
        const fbsTime = activeTime(u.fbs.marks, FBS_IDLE_SEC);
        const collectTime = activeTime(u.fboCollect.marks, FBO_COLLECT_IDLE_SEC);
        const packingTime = activeTime(u.packing.marks, FBO_PACKING_IDLE_SEC);
        for (const [key, t] of [
          ['fbs', fbsTime],
          ['fboCollect', collectTime],
          ['packing', packingTime],
        ]) {
          totals[key].activeSec += t.activeSec;
          totals[key].timedUnits += t.timedUnits;
        }
        totals.receiptsTimed.push(...u.receipts.timed);
        const receiptDaily = {};
        for (const [d, v] of Object.entries(u.receipts.byDay)) {
          receiptDaily[d] = { qty: v.qty, sec: receiptPerUnit(v.timed).avgSec };
        }
        const receiptTime = receiptPerUnit(u.receipts.timed);
        const daily = {
          fbs: dailyActive(u.fbs.marks, FBS_IDLE_SEC),
          fboCollect: dailyActive(u.fboCollect.marks, FBO_COLLECT_IDLE_SEC),
          packing: dailyActive(u.packing.marks, FBO_PACKING_IDLE_SEC),
          receipts: receiptDaily,
        };
        Object.values(daily).forEach((m) => Object.keys(m).forEach((d) => allDays.add(d)));

        const assemblyScans = u.scans.assemblyOk + u.scans.assemblyErrors;
        const receiptScans = u.scans.receiptOk + u.scans.receiptErrors;
        return {
          userId: u.userId,
          name: u.name,
          role: u.role,
          assembly: {
            orders: u.fbs.orders,
            units: u.fbs.units,
            activeHours: round2(fbsTime.activeSec / 3600),
            secPerOrder: perUnit(fbsTime.activeSec, fbsTime.timedUnits),
            ordersPerHour: fbsTime.activeSec > 0 ? round2(fbsTime.timedUnits / (fbsTime.activeSec / 3600)) : null,
            scans: assemblyScans,
            errors: u.scans.assemblyErrors,
            errorRate: assemblyScans > 0 ? round2((u.scans.assemblyErrors / assemblyScans) * 100) : null,
          },
          daily,
          fboCollect: {
            units: u.fboCollect.units,
            supplies: u.fboCollect.supplies.size,
            activeHours: round2(collectTime.activeSec / 3600),
            secPerUnit: perUnit(collectTime.activeSec, collectTime.timedUnits),
          },
          packing: {
            units: Math.max(u.packing.units, 0),
            activeHours: round2(packingTime.activeSec / 3600),
            secPerUnit: perUnit(packingTime.activeSec, packingTime.timedUnits),
            errors: u.scans.packingErrors,
          },
          receipts: {
            receipts: u.receipts.receipts,
            units: Math.max(u.receipts.units, 0),
            scannedUnits: u.scans.receiptUnits,
            diffLines: u.receipts.diffLines,
            secPerUnit: receiptTime.avgSec,
            medianSecPerUnit: receiptTime.medianSec,
            scans: receiptScans,
            errors: u.scans.receiptErrors,
            errorRate: receiptScans > 0 ? round2((u.scans.receiptErrors / receiptScans) * 100) : null,
          },
          inventory: u.inventory,
          tasks: u.tasks,
        };
      })
      .filter(
        (e) =>
          e.assembly.orders > 0 ||
          e.assembly.scans > 0 ||
          e.fboCollect.units > 0 ||
          e.packing.units > 0 ||
          e.receipts.receipts > 0 ||
          e.receipts.scans > 0 ||
          e.inventory.sessions > 0 ||
          e.tasks > 0
      )
      .sort((a, b) => b.assembly.orders - a.assembly.orders || b.fboCollect.units - a.fboCollect.units);

    const summary = employees.reduce(
      (acc, e) => {
        acc.ordersAssembled += e.assembly.orders;
        acc.unitsAssembled += e.assembly.units;
        acc.assemblyErrors += e.assembly.errors;
        acc.assemblyScans += e.assembly.scans;
        acc.fboCollectUnits += e.fboCollect.units;
        acc.packingUnits += e.packing.units;
        acc.receipts += e.receipts.receipts;
        acc.unitsReceived += e.receipts.units;
        acc.receiptErrors += e.receipts.errors;
        acc.inventorySessions += e.inventory.sessions;
        return acc;
      },
      {
        employees: employees.length,
        ordersAssembled: 0,
        unitsAssembled: 0,
        assemblyErrors: 0,
        assemblyScans: 0,
        fboCollectUnits: 0,
        packingUnits: 0,
        receipts: 0,
        unitsReceived: 0,
        receiptErrors: 0,
        inventorySessions: 0,
      }
    );
    summary.assemblyErrorRate =
      summary.assemblyScans > 0 ? round2((summary.assemblyErrors / summary.assemblyScans) * 100) : null;
    summary.fbsSecPerOrder = perUnit(totals.fbs.activeSec, totals.fbs.timedUnits);
    summary.fbsActiveHours = round2(totals.fbs.activeSec / 3600);
    summary.fboCollectSecPerUnit = perUnit(totals.fboCollect.activeSec, totals.fboCollect.timedUnits);
    summary.fboCollectActiveHours = round2(totals.fboCollect.activeSec / 3600);
    summary.packingSecPerUnit = perUnit(totals.packing.activeSec, totals.packing.timedUnits);
    summary.packingActiveHours = round2(totals.packing.activeSec / 3600);
    const receiptTotal = receiptPerUnit(totals.receiptsTimed);
    summary.receiptSecPerUnit = receiptTotal.avgSec;
    summary.receiptMedianSecPerUnit = receiptTotal.medianSec;

    const tracking = trackingRes.rows?.[0] || {};
    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      idleThresholdsSec: { fbs: FBS_IDLE_SEC, fboCollect: FBO_COLLECT_IDLE_SEC, packing: FBO_PACKING_IDLE_SEC },
      trackingSince: tracking.since || null,
      fbsScansSince: tracking.fbs_since || null,
      packingSince: tracking.packing_since || null,
      days: [...allDays].sort(),
      summary,
      employees,
    };
  }
}

export default new EmployeeMetricsService();

/**
 * Показатели сотрудников: сборка (заказы, штуки, темп), ошибки скана, приёмка, инвентаризация, задачи.
 *
 * Сборка и приёмка — из документов (orders.assembled_*, purchase_receipts), доступны за всю историю.
 * Ошибки скана и точное время сборки заказа — из employee_activity_events (с момента включения журнала).
 */

import { query } from '../config/database.js';
import { requireAnalyticsProfile, resolvePeriod, round2 } from '../utils/analyticsCommon.js';

/** Паузы дольше этого между соседними сборками считаем перерывом, а не работой. */
const MAX_WORK_GAP_SEC = 20 * 60;
const MAX_RECEIPT_DURATION_SEC = 8 * 3600;

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

/** Темп сборки по последовательности отметок «Собран» одного сотрудника. */
function assemblyPace(timestampsMs) {
  const ts = [...timestampsMs].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i += 1) {
    const gapSec = (ts[i] - ts[i - 1]) / 1000;
    if (gapSec > 0 && gapSec <= MAX_WORK_GAP_SEC) gaps.push(gapSec);
  }
  const activeSec = gaps.reduce((s, g) => s + g, 0);
  return {
    activeHours: round2(activeSec / 3600),
    medianSecPerOrder: gaps.length ? Math.round(median(gaps)) : null,
    ordersPerHour: activeSec > 0 ? round2(gaps.length / (activeSec / 3600)) : null,
  };
}

class EmployeeMetricsService {
  async getMetrics({ profileId, dateFrom = null, dateTo = null } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days } = resolvePeriod(dateFrom, dateTo, 28);
    const params = [pid, fromYmd, toYmd];
    const from = periodBoundsSql();
    const to = periodEndSql();

    const [usersRes, assemblyRes, eventsRes, precisionRes, receiptsRes, inventoryRes, tasksRes, trackingRes] =
      await Promise.all([
        query(
          `SELECT id, email, phone, full_name, first_name, last_name, account_role, role
             FROM users WHERE profile_id = $1`,
          [pid]
        ),
        query(
          `SELECT o.assembled_by_user_id AS user_id,
                  COALESCE(NULLIF(o.order_group_id, ''), o.marketplace || ':' || o.order_id) AS order_key,
                  MIN(o.assembled_at) AS assembled_at,
                  SUM(GREATEST(COALESCE(o.quantity, 1), 1))::int AS qty,
                  to_char(MIN(o.assembled_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day
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
          `WITH s AS (
             SELECT user_id, entity_id, MIN(created_at) AS first_scan
               FROM employee_activity_events
              WHERE profile_id = $1 AND event_type = 'assembly_scan' AND NOT is_error
                AND entity_id IS NOT NULL
                AND created_at >= ${from} - interval '1 day' AND created_at < ${to}
              GROUP BY 1, 2
           ),
           c AS (
             SELECT user_id, entity_id, MIN(created_at) AS collected_at
               FROM employee_activity_events
              WHERE profile_id = $1 AND event_type = 'assembly_collected'
                AND created_at >= ${from} AND created_at < ${to}
              GROUP BY 1, 2
           )
           SELECT c.user_id,
                  COUNT(*)::int AS orders,
                  percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (c.collected_at - s.first_scan))
                  ) AS median_sec
             FROM c JOIN s ON s.user_id = c.user_id AND s.entity_id = c.entity_id
            WHERE c.collected_at >= s.first_scan
              AND c.collected_at - s.first_scan < interval '1 hour'
            GROUP BY 1`,
          params
        ),
        query(
          `SELECT pr.created_by_user_id AS user_id,
                  COUNT(DISTINCT pr.id)::int AS receipts,
                  COALESCE(SUM(it.scanned), 0)::int AS units,
                  COALESCE(SUM(it.diff_lines), 0)::int AS diff_lines,
                  percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY LEAST(EXTRACT(EPOCH FROM (pr.completed_at - pr.started_at)), ${MAX_RECEIPT_DURATION_SEC})
                  ) FILTER (WHERE pr.started_at IS NOT NULL AND pr.completed_at > pr.started_at) AS median_sec
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
              AND pr.completed_at >= ${from} AND pr.completed_at < ${to}
            GROUP BY 1`,
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
        query(`SELECT MIN(created_at) AS since FROM employee_activity_events WHERE profile_id = $1`, [pid]),
      ]);

    const byUser = new Map();
    const ensure = (userId) => {
      const id = Number(userId);
      if (!byUser.has(id)) {
        byUser.set(id, {
          userId: id,
          name: `Пользователь #${id}`,
          role: null,
          assembly: { orders: 0, units: 0, timestamps: [], byDay: {} },
          scans: { assemblyOk: 0, assemblyErrors: 0, receiptOk: 0, receiptErrors: 0, receiptUnits: 0 },
          precise: { orders: 0, medianSec: null },
          receipts: { receipts: 0, units: 0, diffLines: 0, medianSec: null },
          inventory: { sessions: 0, lines: 0 },
          tasks: 0,
        });
      }
      return byUser.get(id);
    };

    const userInfo = new Map((usersRes.rows || []).map((u) => [Number(u.id), u]));

    for (const row of assemblyRes.rows || []) {
      const u = ensure(row.user_id);
      u.assembly.orders += 1;
      u.assembly.units += Number(row.qty) || 0;
      const t = new Date(row.assembled_at).getTime();
      if (Number.isFinite(t)) u.assembly.timestamps.push(t);
      if (row.day) u.assembly.byDay[row.day] = (u.assembly.byDay[row.day] || 0) + 1;
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
      }
    }
    for (const row of precisionRes.rows || []) {
      const u = ensure(row.user_id);
      u.precise.orders = Number(row.orders) || 0;
      u.precise.medianSec = row.median_sec != null ? Math.round(Number(row.median_sec)) : null;
    }
    for (const row of receiptsRes.rows || []) {
      const u = ensure(row.user_id);
      u.receipts.receipts = Number(row.receipts) || 0;
      u.receipts.units = Number(row.units) || 0;
      u.receipts.diffLines = Number(row.diff_lines) || 0;
      u.receipts.medianSec = row.median_sec != null ? Math.round(Number(row.median_sec)) : null;
    }
    for (const row of inventoryRes.rows || []) {
      const u = ensure(row.user_id);
      u.inventory.sessions = Number(row.sessions) || 0;
      u.inventory.lines = Number(row.lines) || 0;
    }
    for (const row of tasksRes.rows || []) {
      ensure(row.user_id).tasks = Number(row.tasks) || 0;
    }

    const allDays = new Set();
    const employees = [...byUser.values()]
      .map((u) => {
        const info = userInfo.get(u.userId);
        if (info) {
          u.name = userDisplayName(info);
          u.role = ROLE_LABELS[info.account_role] || (info.role === 'admin' ? 'Администратор' : null);
        }
        const pace = assemblyPace(u.assembly.timestamps);
        const assemblyScans = u.scans.assemblyOk + u.scans.assemblyErrors;
        const receiptScans = u.scans.receiptOk + u.scans.receiptErrors;
        Object.keys(u.assembly.byDay).forEach((d) => allDays.add(d));
        return {
          userId: u.userId,
          name: u.name,
          role: u.role,
          assembly: {
            orders: u.assembly.orders,
            units: u.assembly.units,
            activeHours: pace.activeHours,
            ordersPerHour: pace.ordersPerHour,
            medianSecPerOrder: u.precise.medianSec ?? pace.medianSecPerOrder,
            paceSource: u.precise.medianSec != null ? 'scan' : pace.medianSecPerOrder != null ? 'gaps' : null,
            scans: assemblyScans,
            errors: u.scans.assemblyErrors,
            errorRate: assemblyScans > 0 ? round2((u.scans.assemblyErrors / assemblyScans) * 100) : null,
            byDay: u.assembly.byDay,
          },
          receipts: {
            receipts: u.receipts.receipts,
            units: Math.max(u.receipts.units, 0),
            scannedUnits: u.scans.receiptUnits,
            diffLines: u.receipts.diffLines,
            medianSec: u.receipts.medianSec,
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
          e.receipts.receipts > 0 ||
          e.receipts.scans > 0 ||
          e.inventory.sessions > 0 ||
          e.tasks > 0
      )
      .sort((a, b) => b.assembly.orders - a.assembly.orders || b.receipts.units - a.receipts.units);

    const summary = employees.reduce(
      (acc, e) => {
        acc.ordersAssembled += e.assembly.orders;
        acc.unitsAssembled += e.assembly.units;
        acc.assemblyErrors += e.assembly.errors;
        acc.assemblyScans += e.assembly.scans;
        acc.receipts += e.receipts.receipts;
        acc.unitsReceived += e.receipts.units;
        acc.inventorySessions += e.inventory.sessions;
        return acc;
      },
      {
        employees: employees.length,
        ordersAssembled: 0,
        unitsAssembled: 0,
        assemblyErrors: 0,
        assemblyScans: 0,
        receipts: 0,
        unitsReceived: 0,
        inventorySessions: 0,
      }
    );
    summary.assemblyErrorRate =
      summary.assemblyScans > 0 ? round2((summary.assemblyErrors / summary.assemblyScans) * 100) : null;

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      trackingSince: trackingRes.rows?.[0]?.since || null,
      days: [...allDays].sort(),
      summary,
      employees,
    };
  }
}

export default new EmployeeMetricsService();

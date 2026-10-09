/**
 * Показатели сотрудников: сборка FBS и FBO, упаковка FBO, ошибки скана, приёмка, инвентаризация, задачи.
 *
 * Время работы — сумма промежутков между соседними сканами сотрудника. Промежуток длиннее порога простоя
 * считается перерывом (сотрудник отошёл) и не засчитывается: отсчёт стоит до следующего скана.
 *
 * FBS: отметки «Собран» (orders.assembled_*, вся история) + сканы из employee_activity_events.
 * FBO-сборка: fbo_supply_item_scans; скан комплектующей — доля комплекта (1 / штук в составе),
 * скан комплекта целиком — 1 шт. Упаковка FBO: employee_activity_events (fbo_packing_scan).
 * Общая норма упаковки (без сотрудников, в т. ч. до появления журнала): по грузоместам поставки —
 * у строки «товар в коробке» есть время первого (created_at) и последнего (updated_at) скана.
 * Приёмка делится на FBO (склад закупки с is_fbo_stock) и FBS (остальные склады и закупки без склада).
 * Одну приёмку могут сканировать несколько человек параллельно:
 * — трудозатраты по сотрудникам: журнал receipt_scan (с 08.10.2026); для приёмок без журнала — оценка по
 *   purchase_receipt_items.scan_meta.byUser (время последнего скана строки каждым сотрудником), штуки строки
 *   делятся поровну между сканировавшими её;
 * — срок приёмки: от создания до закрытия документа ÷ принятые штуки (при параллельной работе меньше).
 */

import { query } from '../config/database.js';
import { requireAnalyticsProfile, resolvePeriod, round2 } from '../utils/analyticsCommon.js';
import { parseEmployeeMetricsSettings } from '../utils/employeeMetricsSettings.js';

/**
 * Для оценок по коробкам и строкам приёмки промежуточных сканов не видно, поэтому порог перерыва
 * не меньше 10 мин (и не меньше порога из настроек).
 */
const ESTIMATE_MIN_IDLE_SEC = 10 * 60;

async function loadIdleSettings(profileId) {
  try {
    const res = await query('SELECT employee_metrics_settings FROM profiles WHERE id = $1 LIMIT 1', [profileId]);
    return parseEmployeeMetricsSettings(res.rows?.[0]?.employee_metrics_settings).idleSec;
  } catch (e) {
    if (String(e?.message || '').includes('employee_metrics_settings')) {
      return parseEmployeeMetricsSettings(null).idleSec;
    }
    throw e;
  }
}

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

/**
 * По дням (МСК): qty — объём за день, sec — время на единицу за день. Перерыв через полночь не считается.
 * @param {{ marks: object[], idleSec: number }[]} sources — отметки с разными порогами перерыва
 */
function dailyActive(sources) {
  const acc = new Map();
  for (const { marks, idleSec } of sources) {
    const byDay = new Map();
    for (const m of marks) {
      if (!Number.isFinite(m.t)) continue;
      const d = mskDay(m.t);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(m);
    }
    for (const [d, list] of byDay) {
      const t = activeTime(list, idleSec);
      const day = acc.get(d) || { qty: 0, activeSec: 0, timedUnits: 0 };
      day.qty += list.reduce((s, m) => s + (Number(m.qty) || 0), 0);
      day.activeSec += t.activeSec;
      day.timedUnits += t.timedUnits;
      acc.set(d, day);
    }
  }
  const out = {};
  for (const [d, v] of acc) {
    out[d] = { qty: round1(v.qty), sec: perUnit(v.activeSec, v.timedUnits) };
  }
  return out;
}

const RECEIPT_KINDS = ['fbs', 'fbo'];

function newReceiptAcc() {
  return { created: 0, ids: new Set(), units: 0, diffLines: 0, journalMarks: [], lineMarks: [], estimated: false };
}

/** Журнал сканов и оценка по строкам приёмки — разные пороги перерыва. */
function receiptSources(acc, idle) {
  return [
    { marks: acc.journalMarks, idleSec: idle.receipts },
    { marks: acc.lineMarks, idleSec: idle.receiptLines },
  ];
}

function sourcesTime(sources) {
  return sources
    .map((s) => activeTime(s.marks, s.idleSec))
    .reduce((a, t) => ({ activeSec: a.activeSec + t.activeSec, timedUnits: a.timedUnits + t.timedUnits }), {
      activeSec: 0,
      timedUnits: 0,
    });
}

const secPerUnit1 = (t) => (t.timedUnits > 0 ? round1(t.activeSec / t.timedUnits) : null);

/**
 * Норма упаковки по грузоместам. Каждая строка «товар в коробке» даёт две отметки: первый скан (1 шт)
 * и последний (остальные штуки). Время считается по каждой поставке отдельно — разные поставки могут
 * упаковывать параллельно.
 */
function boxPackingNorm(rows, idleSec) {
  const bySupply = new Map();
  for (const row of rows) {
    const qty = Number(row.quantity) || 0;
    const created = new Date(row.created_at).getTime();
    const updated = new Date(row.updated_at).getTime();
    if (qty <= 0 || !Number.isFinite(created)) continue;
    const key = String(row.fbo_supply_id);
    if (!bySupply.has(key)) bySupply.set(key, []);
    const marks = bySupply.get(key);
    marks.push({ t: created, units: 1 });
    if (qty > 1 && Number.isFinite(updated)) marks.push({ t: Math.max(updated, created), units: qty - 1 });
  }
  let activeSec = 0;
  let timedUnits = 0;
  let units = 0;
  for (const marks of bySupply.values()) {
    const t = activeTime(marks, idleSec);
    activeSec += t.activeSec;
    timedUnits += t.timedUnits;
    units += marks.reduce((s, m) => s + m.units, 0);
  }
  return { secPerUnit: timedUnits > 0 ? round1(activeSec / timedUnits) : null, units, supplies: bySupply.size };
}

class EmployeeMetricsService {
  async getMetrics({ profileId, dateFrom = null, dateTo = null } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days } = resolvePeriod(dateFrom, dateTo, 28);
    const configured = await loadIdleSettings(pid);
    const idle = {
      ...configured,
      packingBoxes: Math.max(ESTIMATE_MIN_IDLE_SEC, configured.packing),
      receiptLines: Math.max(ESTIMATE_MIN_IDLE_SEC, configured.receipts),
    };
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
      receiptLinesRes,
      receiptEventsRes,
      inventoryRes,
      tasksRes,
      trackingRes,
      boxContentsRes,
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
        `SELECT s.user_id, s.created_at, s.fbo_supply_id,
                CASE
                  WHEN kit.pieces IS NULL OR s.scanned_product_id = i.product_id THEN 1
                  ELSE 1.0 / GREATEST(kit.pieces, 1)
                END AS unit_weight
           FROM fbo_supply_item_scans s
           JOIN fbo_supplies f ON f.id = s.fbo_supply_id AND f.profile_id = $1
           JOIN fbo_supply_items i ON i.id = s.fbo_supply_item_id
           LEFT JOIN LATERAL (
             SELECT SUM(kc.quantity) AS pieces FROM kit_components kc WHERE kc.kit_product_id = i.product_id
           ) kit ON TRUE
          WHERE s.user_id IS NOT NULL
            AND s.created_at >= ${from} AND s.created_at < ${to}`,
        params
      ),
      query(
        `SELECT pr.id, pr.created_by_user_id AS user_id, COALESCE(w.is_fbo_stock, FALSE) AS is_fbo,
                to_char(pr.completed_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
                EXTRACT(EPOCH FROM (pr.completed_at - pr.created_at)) AS duration_sec,
                COALESCE(it.scanned, 0)::int AS units,
                COALESCE(it.diff_lines, 0)::int AS diff_lines
           FROM purchase_receipts pr
           JOIN purchases pu ON pu.id = pr.purchase_id AND pu.profile_id = $1
           LEFT JOIN warehouses w ON w.id = pu.warehouse_id
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
            AND pr.completed_at >= ${from} AND pr.completed_at < ${to}`,
        params
      ),
      query(
        `SELECT i.receipt_id, i.scanned_quantity,
                CASE WHEN jsonb_typeof(i.scan_meta->'byUser') = 'object' THEN i.scan_meta->'byUser' END AS by_user
           FROM purchase_receipt_items i
           JOIN purchase_receipts pr ON pr.id = i.receipt_id
           JOIN purchases pu ON pu.id = pr.purchase_id AND pu.profile_id = $1
          WHERE pr.status = 'completed' AND COALESCE(i.scanned_quantity, 0) > 0
            AND pr.completed_at >= ${from} AND pr.completed_at < ${to}`,
        params
      ),
      query(
        `SELECT e.entity_id AS receipt_id, e.user_id, e.created_at, e.quantity
           FROM employee_activity_events e
           JOIN purchase_receipts pr ON pr.id::text = e.entity_id
           JOIN purchases pu ON pu.id = pr.purchase_id AND pu.profile_id = $1
          WHERE e.event_type = 'receipt_scan' AND e.entity_type = 'purchase_receipt' AND NOT e.is_error
            AND e.user_id IS NOT NULL
            AND pr.status = 'completed' AND pr.completed_at >= ${from} AND pr.completed_at < ${to}`,
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
      query(
        `SELECT cu.fbo_supply_id, cc.created_at, cc.updated_at, cc.quantity
           FROM fbo_supply_cargo_contents cc
           JOIN fbo_supply_cargo_units cu ON cu.id = cc.cargo_unit_id
           JOIN fbo_supplies f ON f.id = cu.fbo_supply_id AND f.profile_id = $1
          WHERE cc.created_at >= ${from} AND cc.created_at < ${to}`,
        params
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
          receipts: { fbs: newReceiptAcc(), fbo: newReceiptAcc() },
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
      const w = Number(row.unit_weight) || 1;
      u.fboCollect.units += w;
      u.fboCollect.supplies.add(String(row.fbo_supply_id));
      u.fboCollect.marks.push({ t: ts(row.created_at), units: w, qty: w });
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
    const receiptLead = { fbs: [], fbo: [] };
    const receiptCount = { fbs: { receipts: 0, units: 0 }, fbo: { receipts: 0, units: 0 } };
    const receiptMeta = new Map();
    for (const row of receiptsRes.rows || []) {
      const kind = row.is_fbo ? 'fbo' : 'fbs';
      const d = Number(row.duration_sec);
      const units = Number(row.units) || 0;
      receiptCount[kind].receipts += 1;
      receiptCount[kind].units += units;
      if (Number.isFinite(d) && d > 0 && units > 0) receiptLead[kind].push({ d, units });
      receiptMeta.set(String(row.id), { kind, creator: row.user_id || null });
      if (!row.user_id) continue;
      const acc = ensure(row.user_id).receipts[kind];
      acc.created += 1;
      acc.diffLines += Number(row.diff_lines) || 0;
    }
    const journalReceipts = new Set();
    for (const row of receiptEventsRes.rows || []) {
      const rid = String(row.receipt_id);
      const meta = receiptMeta.get(rid);
      if (!meta) continue;
      const acc = ensure(row.user_id).receipts[meta.kind];
      const q = Number(row.quantity) || 0;
      journalReceipts.add(rid);
      acc.ids.add(rid);
      acc.units += q;
      acc.journalMarks.push({ t: ts(row.created_at), units: Math.max(q, 0), qty: q });
    }
    for (const row of receiptLinesRes.rows || []) {
      const rid = String(row.receipt_id);
      const meta = receiptMeta.get(rid);
      if (!meta || journalReceipts.has(rid)) continue;
      const qty = Number(row.scanned_quantity) || 0;
      const marks = Object.entries(row.by_user || {})
        .map(([uid, t]) => [Number(uid), Number(t)])
        .filter(([uid, t]) => uid > 0 && Number.isFinite(t) && t > 0);
      if (!marks.length) {
        if (!meta.creator) continue;
        const acc = ensure(meta.creator).receipts[meta.kind];
        acc.ids.add(rid);
        acc.units += qty;
        continue;
      }
      const share = qty / marks.length;
      for (const [uid, t] of marks) {
        const acc = ensure(uid).receipts[meta.kind];
        acc.ids.add(rid);
        acc.units += share;
        acc.estimated = true;
        acc.lineMarks.push({ t, units: share, qty: share });
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
      receiptsFbs: { activeSec: 0, timedUnits: 0 },
      receiptsFbo: { activeSec: 0, timedUnits: 0 },
    };
    const allDays = new Set();

    const employees = [...byUser.values()]
      .map((u) => {
        const info = userInfo.get(u.userId);
        if (info) {
          u.name = userDisplayName(info);
          u.role = ROLE_LABELS[info.account_role] || (info.role === 'admin' ? 'Администратор' : null);
        }
        const fbsTime = activeTime(u.fbs.marks, idle.fbs);
        const collectTime = activeTime(u.fboCollect.marks, idle.fboCollect);
        const packingTime = activeTime(u.packing.marks, idle.packing);
        const receiptTime = {
          fbs: sourcesTime(receiptSources(u.receipts.fbs, idle)),
          fbo: sourcesTime(receiptSources(u.receipts.fbo, idle)),
        };
        for (const [key, t] of [
          ['fbs', fbsTime],
          ['fboCollect', collectTime],
          ['packing', packingTime],
          ['receiptsFbs', receiptTime.fbs],
          ['receiptsFbo', receiptTime.fbo],
        ]) {
          totals[key].activeSec += t.activeSec;
          totals[key].timedUnits += t.timedUnits;
        }
        const daily = {
          fbs: dailyActive([{ marks: u.fbs.marks, idleSec: idle.fbs }]),
          fboCollect: dailyActive([{ marks: u.fboCollect.marks, idleSec: idle.fboCollect }]),
          packing: dailyActive([{ marks: u.packing.marks, idleSec: idle.packing }]),
          receiptsFbs: dailyActive(receiptSources(u.receipts.fbs, idle)),
          receiptsFbo: dailyActive(receiptSources(u.receipts.fbo, idle)),
        };
        const receiptOut = (kind) => {
          const acc = u.receipts[kind];
          return {
            receipts: acc.ids.size,
            created: acc.created,
            units: Math.max(Math.round(acc.units), 0),
            diffLines: acc.diffLines,
            activeHours: round2(receiptTime[kind].activeSec / 3600),
            secPerUnit: secPerUnit1(receiptTime[kind]),
            estimated: acc.estimated,
          };
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
            units: Math.round(u.fboCollect.units),
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
            fbs: receiptOut('fbs'),
            fbo: receiptOut('fbo'),
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
          e.receipts.fbs.receipts > 0 ||
          e.receipts.fbo.receipts > 0 ||
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
    const boxNorm = boxPackingNorm(boxContentsRes.rows || [], idle.packingBoxes);
    summary.packingBoxSecPerUnit = boxNorm.secPerUnit;
    summary.packingBoxUnits = boxNorm.units;
    summary.packingBoxSupplies = boxNorm.supplies;
    summary.receiptsByKind = Object.fromEntries(
      RECEIPT_KINDS.map((kind) => {
        const t = totals[kind === 'fbo' ? 'receiptsFbo' : 'receiptsFbs'];
        const leadList = receiptLead[kind];
        const lead = receiptPerUnit(leadList);
        return [
          kind,
          {
            receipts: receiptCount[kind].receipts,
            units: receiptCount[kind].units,
            secPerUnit: secPerUnit1(t),
            activeHours: round2(t.activeSec / 3600),
            leadSecPerUnit: lead.avgSec,
            leadMedianSecPerUnit: lead.medianSec,
            leadAvgHours: leadList.length
              ? round2(leadList.reduce((s, r) => s + r.d, 0) / leadList.length / 3600)
              : null,
          },
        ];
      })
    );

    const tracking = trackingRes.rows?.[0] || {};
    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      idleThresholdsSec: idle,
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

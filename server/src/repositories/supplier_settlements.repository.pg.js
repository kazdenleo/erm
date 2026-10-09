/**
 * Взаиморасчёты с поставщиками.
 * Баланс = наш долг поставщику: приёмки (+) − возвраты поставщику (−) + ручные операции (оплаты < 0, корректировки ±).
 */

import { query } from '../config/database.js';

const ENTRY_KINDS = new Set(['payment', 'adjustment']);
const MAX_ABS_AMOUNT = 1e12;

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function toMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Складские документы поставщиков с суммой по себестоимости строк.
 * Поставщик берётся из шапки документа, а для приёмок по закупке без поставщика — из закупки.
 */
const SUPPLIER_DOCUMENTS_SQL = `
  SELECT COALESCE(r.supplier_id, pr_link.supplier_id) AS supplier_id,
         r.id,
         COALESCE(NULLIF(r.document_type, ''), 'receipt') AS document_type,
         r.created_at,
         r.receipt_number,
         la.amount,
         la.lines_count,
         la.missing_cost_lines
  FROM warehouse_receipts r
  LEFT JOIN LATERAL (
    SELECT pur.supplier_id
    FROM purchase_receipts pr
    JOIN purchases pur ON pur.id = pr.purchase_id
    WHERE pr.warehouse_receipt_id = r.id AND pur.supplier_id IS NOT NULL
    ORDER BY pr.id DESC
    LIMIT 1
  ) pr_link ON r.supplier_id IS NULL
  JOIN LATERAL (
    SELECT COUNT(*)::int AS lines_count,
           COALESCE(SUM(l.quantity::numeric * COALESCE(l.cost, p.cost, 0)::numeric), 0) AS amount,
           COUNT(*) FILTER (WHERE COALESCE(l.cost, p.cost) IS NULL)::int AS missing_cost_lines
    FROM warehouse_receipt_lines l
    LEFT JOIN products p ON p.id = l.product_id
    WHERE l.receipt_id = r.id
  ) la ON la.lines_count > 0
  WHERE COALESCE(NULLIF(r.document_type, ''), 'receipt') IN ('receipt', 'return')
    AND COALESCE(r.supplier_id, pr_link.supplier_id) = ANY($1::bigint[])
`;

function summarize({ received = 0, returned = 0, paid = 0, adjusted = 0 }) {
  const s = {
    received: toMoney(received),
    returned: toMoney(returned),
    paid: toMoney(paid),
    adjusted: toMoney(adjusted),
  };
  s.balance = toMoney(s.received - s.returned - s.paid + s.adjusted);
  return s;
}

class SupplierSettlementsRepositoryPG {
  /**
   * Балансы по всем поставщикам профиля.
   * @param {number|null} profileId null — без фильтра по профилю (глобальный админ)
   */
  async listBalances(profileId) {
    const pid = toId(profileId);
    const suppliersRes = await query(
      `SELECT id, name, is_active FROM suppliers ${pid ? 'WHERE profile_id = $1' : ''} ORDER BY name`,
      pid ? [pid] : []
    );
    const suppliers = suppliersRes.rows || [];
    if (suppliers.length === 0) return [];
    const ids = suppliers.map((s) => Number(s.id));

    const [docsRes, entriesRes] = await Promise.all([
      query(
        `SELECT d.supplier_id,
                SUM(d.amount) FILTER (WHERE d.document_type = 'receipt') AS received,
                SUM(d.amount) FILTER (WHERE d.document_type = 'return') AS returned,
                MAX(d.created_at) AS last_at
         FROM (${SUPPLIER_DOCUMENTS_SQL}) d
         GROUP BY d.supplier_id`,
        [ids]
      ),
      query(
        `SELECT supplier_id,
                -SUM(amount) FILTER (WHERE kind = 'payment') AS paid,
                SUM(amount) FILTER (WHERE kind = 'adjustment') AS adjusted,
                MAX(occurred_at) AS last_at
         FROM supplier_settlement_entries
         WHERE supplier_id = ANY($1::bigint[])
         GROUP BY supplier_id`,
        [ids]
      ),
    ]);

    const docsBySupplier = new Map((docsRes.rows || []).map((r) => [Number(r.supplier_id), r]));
    const entriesBySupplier = new Map((entriesRes.rows || []).map((r) => [Number(r.supplier_id), r]));

    return suppliers.map((s) => {
      const id = Number(s.id);
      const d = docsBySupplier.get(id) || {};
      const e = entriesBySupplier.get(id) || {};
      const lastTimes = [d.last_at, e.last_at].filter(Boolean).map((t) => new Date(t).getTime());
      return {
        supplierId: id,
        supplierName: s.name,
        isActive: s.is_active !== false,
        ...summarize({ received: d.received, returned: d.returned, paid: e.paid, adjusted: e.adjusted }),
        lastOperationAt: lastTimes.length ? new Date(Math.max(...lastTimes)).toISOString() : null,
      };
    });
  }

  /** Сводка и журнал операций по одному поставщику (новые сверху, с остатком после операции). */
  async getLedger(supplierId) {
    const sid = toId(supplierId);
    if (!sid) throw httpError('Некорректный поставщик');

    const [docsRes, entriesRes] = await Promise.all([
      query(`${SUPPLIER_DOCUMENTS_SQL} ORDER BY r.created_at, r.id`, [[sid]]),
      query(
        `SELECT e.id, e.kind, e.amount, e.occurred_at, e.comment, e.created_at,
                u.full_name AS created_by_name, u.email AS created_by_email
         FROM supplier_settlement_entries e
         LEFT JOIN users u ON u.id = e.created_by_user_id
         WHERE e.supplier_id = $1
         ORDER BY e.occurred_at, e.id`,
        [sid]
      ),
    ]);

    const operations = [];
    for (const d of docsRes.rows || []) {
      const amount = toMoney(d.amount);
      operations.push({
        key: `doc-${d.id}`,
        type: d.document_type,
        occurredAt: d.created_at,
        amount: d.document_type === 'return' ? -amount : amount,
        documentId: Number(d.id),
        documentNumber: d.receipt_number || null,
        linesCount: Number(d.lines_count) || 0,
        missingCostLines: Number(d.missing_cost_lines) || 0,
        entryId: null,
        comment: '',
        createdBy: null,
      });
    }
    for (const e of entriesRes.rows || []) {
      operations.push({
        key: `entry-${e.id}`,
        type: e.kind,
        occurredAt: e.occurred_at,
        amount: toMoney(e.amount),
        documentId: null,
        documentNumber: null,
        linesCount: 0,
        missingCostLines: 0,
        entryId: Number(e.id),
        comment: e.comment || '',
        createdBy: e.created_by_name || e.created_by_email || null,
        createdAt: e.created_at,
      });
    }

    operations.sort((a, b) => {
      const dt = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      return dt !== 0 ? dt : a.key.localeCompare(b.key);
    });

    const totals = { received: 0, returned: 0, paid: 0, adjusted: 0 };
    let running = 0;
    for (const op of operations) {
      running = toMoney(running + op.amount);
      op.balanceAfter = running;
      if (op.type === 'receipt') totals.received += op.amount;
      else if (op.type === 'return') totals.returned -= op.amount;
      else if (op.type === 'payment') totals.paid -= op.amount;
      else totals.adjusted += op.amount;
    }

    return {
      summary: summarize(totals),
      operations: operations.reverse(),
    };
  }

  async getBalance(supplierId) {
    const { summary } = await this.getLedger(supplierId);
    return summary.balance;
  }

  /**
   * Ручная операция.
   * payment: amount > 0 — сколько оплатили поставщику (долг уменьшается).
   * adjustment: amount — изменение баланса (±) либо targetBalance — итоговый баланс после корректировки.
   */
  async createEntry({ profileId, supplierId, userId = null, kind, amount, targetBalance, date, comment }) {
    const pid = toId(profileId);
    const sid = toId(supplierId);
    if (!pid || !sid) throw httpError('Некорректный поставщик');

    const k = String(kind || '').trim();
    if (!ENTRY_KINDS.has(k)) throw httpError('Неизвестный тип операции');

    let delta;
    if (k === 'adjustment' && targetBalance != null && targetBalance !== '') {
      const target = Number(targetBalance);
      if (!Number.isFinite(target) || Math.abs(target) >= MAX_ABS_AMOUNT) {
        throw httpError('Некорректный итоговый баланс');
      }
      delta = toMoney(toMoney(target) - (await this.getBalance(sid)));
      if (delta === 0) throw httpError('Баланс уже равен указанной сумме');
    } else {
      const n = Number(amount);
      if (!Number.isFinite(n) || Math.abs(n) >= MAX_ABS_AMOUNT) throw httpError('Некорректная сумма');
      delta = toMoney(n);
      if (delta === 0) throw httpError('Сумма не может быть нулевой');
      if (k === 'payment') {
        if (delta < 0) throw httpError('Сумма оплаты должна быть положительной');
        delta = -delta;
      }
    }

    const dateStr = date == null ? '' : String(date).trim();
    if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('Некорректная дата');

    const text = String(comment ?? '').trim().slice(0, 1000);
    const uid = toId(userId);

    // Выбранная дата + текущее время, чтобы операции одного дня шли в порядке ввода.
    const res = await query(
      `INSERT INTO supplier_settlement_entries
         (profile_id, supplier_id, kind, amount, occurred_at, comment, created_by_user_id)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $5::date IS NULL THEN CURRENT_TIMESTAMP ELSE ($5::date + LOCALTIME)::timestamptz END,
               $6, $7)
       RETURNING id`,
      [pid, sid, k, delta, dateStr || null, text, uid]
    );
    return { id: Number(res.rows[0].id), amount: delta };
  }

  async deleteEntry(supplierId, entryId) {
    const sid = toId(supplierId);
    const eid = toId(entryId);
    if (!sid || !eid) return false;
    const res = await query(
      'DELETE FROM supplier_settlement_entries WHERE id = $1 AND supplier_id = $2 RETURNING id',
      [eid, sid]
    );
    return res.rows.length > 0;
  }
}

export default new SupplierSettlementsRepositoryPG();

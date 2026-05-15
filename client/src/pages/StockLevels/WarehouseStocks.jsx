/**
 * Остатки на складе — складской учёт, поступление, списание, инвентаризация
 */

import React, { useState, useEffect, useMemo, useLayoutEffect, useCallback, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useCategories } from '../../hooks/useCategories';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { stockMovementsApi } from '../../services/stockMovements.api';
import { supplierStocksApi } from '../../services/supplierStocks.api';
import { productsApi } from '../../services/products.api';
import { marketplaceStockApi } from '../../services/marketplaceStock.api';
import { buildStockRowsWithKits } from '../../utils/kitStockMetrics';
import { WarehouseOperations } from './WarehouseOperations';
import { warehouseOpFromSearch, WAREHOUSE_VALID_OPS } from './warehouseTabs';
import './StockLevels.css';

const MOVEMENT_TYPE_LABELS = {
  receipt: 'Поступление',
  incoming: 'В пути',
  writeoff: 'Списание',
  shipment: 'Отгрузка',
  reserve: 'Резерв',
  unreserve: 'Снятие резерва',
  inventory: 'Инвентаризация',
  manual: 'Ручное изменение',
  transfer: 'Перемещение',
  return_to_supplier: 'Возврат поставщику',
  customer_return: 'Возврат от клиента'
};

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function parseMovementMeta(m) {
  const raw = m?.meta;
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/** Снимок «в пути / резерв / наличие» из строки журнала (учёт старых записей без incoming_after). */
function snapshotFromMovement(m) {
  const hasNew =
    (m.incoming_after != null && m.incoming_after !== '') ||
    (m.reserved_after != null && m.reserved_after !== '');
  const inc =
    m.incoming_after != null && m.incoming_after !== ''
      ? Number(m.incoming_after)
      : m.type === 'incoming' && m.balance_after != null && !hasNew
        ? Number(m.balance_after)
        : null;
  const res = m.reserved_after != null && m.reserved_after !== '' ? Number(m.reserved_after) : null;
  const bal =
    m.balance_after != null && m.balance_after !== ''
      ? Number(m.balance_after)
      : null;
  if (movementTypeLower(m) === 'incoming' && !hasNew) {
    return { inc, res: res != null && !Number.isNaN(res) ? res : null, bal: null };
  }
  return {
    inc: inc != null && !Number.isNaN(inc) ? inc : null,
    res: res != null && !Number.isNaN(res) ? res : null,
    bal: bal != null && !Number.isNaN(bal) ? bal : null,
  };
}

function formatAfterDelta(after, prev) {
  if (after == null || Number.isNaN(after)) return '—';
  if (prev == null || Number.isNaN(prev)) return String(after);
  const d = after - prev;
  if (d === 0) return String(after);
  return `${after}(${d > 0 ? '+' : ''}${d})`;
}

/** Если в журнале нет более старой строки — восстанавливаем «до» из quantity_change и типа. */
function inferPrevForDelta(after, prev, m, column) {
  if (prev != null && !Number.isNaN(prev)) return prev;
  if (after == null || Number.isNaN(after) || m == null) return null;
  const qc = Number(m.quantity_change);
  if (!Number.isFinite(qc)) return null;
  if (column === 'inc' && movementTypeLower(m) === 'incoming') {
    return after - qc;
  }
  if (column === 'res' && movementTypeLower(m) === 'reserve' && qc < 0) {
    return after + qc;
  }
  if (column === 'res' && movementTypeLower(m) === 'unreserve' && qc > 0) {
    return after - qc;
  }
  if (
    column === 'bal' &&
    movementTypeLower(m) !== 'incoming' &&
    movementTypeLower(m) !== 'reserve' &&
    movementTypeLower(m) !== 'unreserve'
  ) {
    return after - qc;
  }
  return null;
}

function formatAfterDeltaSmart(after, prev, m, column) {
  const eff = inferPrevForDelta(after, prev, m, column);
  return formatAfterDelta(after, eff);
}

const HISTORY_REASON_MAX_LEN = 96;

/** Ключ «одно время» как в колонке истории (ru-RU, без секунд) — иначе два резерва в одну минуту не схлопываются. */
function reserveTimeGroupKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function movementTypeLower(m) {
  const t = m?.type ?? m?.movement_type ?? m?.movementType;
  return t != null ? String(t).trim().toLowerCase() : '';
}

function movementCreatedAt(m) {
  return m?.created_at ?? m?.createdAt ?? null;
}

/** Не показывать в истории остатков: техническое incoming после приёмки (уменьшение «в пути» уже видно в строке приёмки). */
function isHiddenStockHistoryMovement(m) {
  if (movementTypeLower(m) !== 'incoming') return false;
  const r = String(m.reason || '').trim();
  return /списание\s+incoming\s+по\s+при[её]мке/i.test(r);
}

function extractOrderIdFromReserveMovement(m) {
  const meta = parseMovementMeta(m);
  const fromMeta = meta.orderId != null && String(meta.orderId).trim() !== '' ? String(meta.orderId).trim() : '';
  if (fromMeta) return fromMeta;
  const r = /^Резерв по заказу\s+(.+)$/i.exec(String(m.reason || '').trim());
  return r ? r[1].trim() : '';
}

function marketplacePathFromMeta(meta) {
  const mp = String(meta.marketplace || 'ozon').toLowerCase();
  if (mp === 'wb' || mp === 'wildberries') return 'wildberries';
  if (mp === 'ym' || mp === 'yandex') return 'yandex';
  return 'ozon';
}

/** Список заказов из движений резерва (для модалки). */
function reserveOrdersFromMovements(movements) {
  const out = [];
  for (const m of movements) {
    const meta = parseMovementMeta(m);
    const orderId = extractOrderIdFromReserveMovement(m);
    if (!orderId) continue;
    const qty = Math.max(0, -Number(m.quantity_change) || 0);
    out.push({
      orderDbId: meta.order_id != null ? Number(meta.order_id) : null,
      marketplace: marketplacePathFromMeta(meta),
      orderId,
      reservedQty: qty || 1,
    });
  }
  return out;
}

function truncateReserveReason(orderIds) {
  const prefix = `Резерв (${orderIds.length} зак.): `;
  const joined = orderIds.join(', ');
  let text = prefix + joined;
  if (text.length <= HISTORY_REASON_MAX_LEN) return text;
  const budget = HISTORY_REASON_MAX_LEN - prefix.length - 14;
  let shortened = joined.slice(0, Math.max(8, budget));
  const lastComma = shortened.lastIndexOf(',');
  if (lastComma > 6) shortened = shortened.slice(0, lastComma);
  const shown = shortened.split(',').map((s) => s.trim()).filter(Boolean).length;
  const hidden = Math.max(0, orderIds.length - shown);
  return `${prefix}${shortened}…${hidden > 0 ? ` ещё ${hidden}` : ''}`;
}

function normalizeReasonForOutboundCheck(reasonRaw) {
  let r = String(reasonRaw || '').trim();
  if (r.startsWith('Сборка:')) r = `Отгрузка${r.slice('Сборка'.length)}`;
  return r;
}

/** Снятие резерва / отгрузка со склада при отметке «Собран» — строки журнала схлопываем в одну. */
function isOutboundShipmentBatchReason(reasonRaw) {
  const r = normalizeReasonForOutboundCheck(reasonRaw);
  return /^Отгрузка:\s*(снятие резерва|списание наличия|отгрузка)\s+по заказу/i.test(r);
}

function isOutboundBatchMovement(m) {
  const t = movementTypeLower(m);
  if (t !== 'unreserve' && t !== 'shipment') return false;
  return isOutboundShipmentBatchReason(m.reason);
}

function extractOrderIdFromOutboundMovement(m) {
  const meta = parseMovementMeta(m);
  const fromMeta = meta.orderId != null && String(meta.orderId).trim() !== '' ? String(meta.orderId).trim() : '';
  if (fromMeta) return fromMeta;
  const r = /\bпо заказу\s+(.+)$/i.exec(normalizeReasonForOutboundCheck(m.reason));
  return r ? r[1].trim() : '';
}

function truncateOutboundOrdersLine(orderIds) {
  const prefix = 'Отгрузка по заказам ';
  const joined = orderIds.join(', ');
  let text = prefix + joined;
  if (text.length <= HISTORY_REASON_MAX_LEN) return text;
  const budget = HISTORY_REASON_MAX_LEN - prefix.length - 14;
  let shortened = joined.slice(0, Math.max(8, budget));
  const lastComma = shortened.lastIndexOf(',');
  if (lastComma > 6) shortened = shortened.slice(0, lastComma);
  const shown = shortened.split(',').map((s) => s.trim()).filter(Boolean).length;
  const hidden = Math.max(0, orderIds.length - shown);
  return `${prefix}${shortened}…${hidden > 0 ? ` ещё ${hidden}` : ''}`;
}

/** Уникальные номера заказов в порядке появления в пачке (список уже id DESC). */
function orderIdsFromOutboundMovements(movements) {
  const seen = new Set();
  const out = [];
  for (const m of movements) {
    const oid = extractOrderIdFromOutboundMovement(m);
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    out.push(oid);
  }
  return out;
}

/** Подсветка дельты в скобках: + зелёным, − красным. */
function renderStockHistoryQtyCell(smartStr) {
  const s = smartStr == null ? '' : String(smartStr);
  if (s === '' || s === '—') return s;
  const open = s.lastIndexOf('(');
  if (open < 0) return s;
  const close = s.lastIndexOf(')');
  if (close <= open) return s;
  const inner = s.slice(open + 1, close);
  if (!/^[+-]?\d+$/.test(inner)) return s;
  const base = s.slice(0, open);
  const paren = s.slice(open);
  const isNeg = inner.startsWith('-');
  const cls = isNeg ? 'stock-change-minus' : 'stock-change-plus';
  return (
    <>
      {base}
      <span className={cls}>{paren}</span>
    </>
  );
}

/**
 * Резервы и отгрузка (unreserve+shipment из «Отгрузка: …») с одной минутой в колонке «Дата и время»
 * схлопываем в одну строку; в группе movements отсортированы по id DESC.
 */
function buildHistoryDisplayRows(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const sortBlock = (arr) => {
    arr.sort((a, b) => {
      const ida = Number(a.id);
      const idb = Number(b.id);
      if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return idb - ida;
      return 0;
    });
  };

  const reserveByKey = new Map();
  const outboundByKey = new Map();
  for (const m of list) {
    const key = reserveTimeGroupKey(movementCreatedAt(m));
    if (!key) continue;
    if (movementTypeLower(m) === 'reserve') {
      if (!reserveByKey.has(key)) reserveByKey.set(key, []);
      reserveByKey.get(key).push(m);
    } else if (isOutboundBatchMovement(m)) {
      if (!outboundByKey.has(key)) outboundByKey.set(key, []);
      outboundByKey.get(key).push(m);
    }
  }
  for (const arr of reserveByKey.values()) sortBlock(arr);
  for (const arr of outboundByKey.values()) sortBlock(arr);

  const emittedReserve = new Set();
  const emittedOutbound = new Set();
  const out = [];
  for (const m of list) {
    const key = reserveTimeGroupKey(movementCreatedAt(m));
    if (movementTypeLower(m) === 'reserve') {
      if (!key || emittedReserve.has(key)) continue;
      emittedReserve.add(key);
      const block = reserveByKey.get(key) || [m];
      if (block.length >= 2) out.push({ kind: 'reserveGroup', movements: block });
      else out.push({ kind: 'single', m: block[0] });
      continue;
    }
    if (isOutboundBatchMovement(m)) {
      if (!key) {
        out.push({ kind: 'single', m });
        continue;
      }
      if (emittedOutbound.has(key)) continue;
      const block = outboundByKey.get(key) || [m];
      if (block.length >= 2) {
        emittedOutbound.add(key);
        out.push({ kind: 'outboundGroup', movements: block });
      } else {
        out.push({ kind: 'single', m });
      }
      continue;
    }
    out.push({ kind: 'single', m });
  }
  return out;
}

/** Снимок после отображаемой строки (список журнала в DESC). */
function snapshotAfterDisplayItem(item) {
  if (item.kind === 'reserveGroup' || item.kind === 'outboundGroup') {
    return snapshotFromMovement(item.movements[0]);
  }
  return snapshotFromMovement(item.m);
}

function sumMovementsQuantityChange(movements) {
  return movements.reduce((s, x) => s + Number(x.quantity_change || 0), 0);
}

/**
 * Дополняем снимок для отображения: у резервов в БД часто нет incoming_after/reserved_after;
 * одиночный «Резерв по заказу» — те же правила, что у сгруппированных резервов;
 * при приёмке по закупке при ненулевом резерве «наличие» = 0; пачка отгрузки — «в пути» 0, резерв 0.
 */
function enrichHistoryRowSnapshot(item, cur, prevLineBelow) {
  const out = {
    inc: cur.inc != null && !Number.isNaN(Number(cur.inc)) ? Number(cur.inc) : cur.inc,
    res: cur.res != null && !Number.isNaN(Number(cur.res)) ? Number(cur.res) : cur.res,
    bal: cur.bal != null && !Number.isNaN(Number(cur.bal)) ? Number(cur.bal) : cur.bal,
  };

  const reserveMs =
    item.kind === 'reserveGroup'
      ? item.movements
      : item.kind === 'single' && movementTypeLower(item.m) === 'reserve'
        ? [item.m]
        : null;

  if (reserveMs && reserveMs.length) {
    const sumQc = sumMovementsQuantityChange(reserveMs);
    if (out.inc == null && prevLineBelow != null && prevLineBelow.inc != null && !Number.isNaN(prevLineBelow.inc)) {
      out.inc = prevLineBelow.inc;
    }
    if (out.res == null && prevLineBelow != null && prevLineBelow.res != null && Number.isFinite(sumQc)) {
      out.res = prevLineBelow.res - sumQc;
    }
    if (out.bal == null && prevLineBelow != null && prevLineBelow.bal != null && !Number.isNaN(prevLineBelow.bal)) {
      out.bal = prevLineBelow.bal;
    }
    if (out.bal == null || Number.isNaN(Number(out.bal))) out.bal = 0;
    return out;
  }

  if (item.kind === 'outboundGroup') {
    if (out.inc == null || Number.isNaN(Number(out.inc))) out.inc = 0;
    if (out.res == null || Number.isNaN(Number(out.res))) out.res = 0;
    if (out.bal == null || Number.isNaN(Number(out.bal))) out.bal = 0;
    return out;
  }

  if (item.kind === 'single') {
    const m = item.m;
    const t = movementTypeLower(m);
    const reason = String(m.reason || '');
    if (t === 'incoming' && /закупк/i.test(reason) && /ожидан/i.test(reason)) {
      if (out.res == null || Number.isNaN(Number(out.res))) out.res = 0;
      if (out.bal == null || Number.isNaN(Number(out.bal))) out.bal = 0;
    }
    if (t === 'receipt' && /при[её]мка\s+по\s+закупке/i.test(reason)) {
      if (out.inc == null || Number.isNaN(Number(out.inc))) {
        const raw = m.incoming_after != null && m.incoming_after !== '' ? Number(m.incoming_after) : 0;
        out.inc = Number.isFinite(raw) ? raw : 0;
      }
      if (out.res == null && prevLineBelow != null && prevLineBelow.res != null) {
        out.res = prevLineBelow.res;
      }
      if (out.res == null && m.reserved_after != null && m.reserved_after !== '') {
        const rv = Number(m.reserved_after);
        out.res = Number.isFinite(rv) ? rv : null;
      }
      if (out.res != null && out.res > 0) {
        out.bal = 0;
      } else if (out.bal == null && m.balance_after != null && m.balance_after !== '') {
        out.bal = Number(m.balance_after);
      }
    }
  }

  return out;
}

/** Снимки строк истории с enrich; индекс 0 — самая новая строка, prev для строки i = enriched[i+1]. */
function buildHistoryDisplaySnapshots(displayRows) {
  if (!Array.isArray(displayRows) || displayRows.length === 0) return [];
  const n = displayRows.length;
  const enriched = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const item = displayRows[i];
    const raw = snapshotAfterDisplayItem(item);
    const prevLineBelow = i + 1 < n ? enriched[i + 1] : null;
    enriched[i] = enrichHistoryRowSnapshot(item, raw, prevLineBelow);
  }
  return enriched;
}

/** Синтетическое движение для inferPrevForDelta в сгруппированных строках. */
function movementForDeltaInference(item, column) {
  const reserveMs =
    item.kind === 'reserveGroup'
      ? item.movements
      : item.kind === 'single' && movementTypeLower(item.m) === 'reserve'
        ? [item.m]
        : null;
  if (reserveMs && reserveMs.length) {
    if (column === 'res') {
      const sumQc = reserveMs.reduce((s, x) => s + Number(x.quantity_change || 0), 0);
      return { ...reserveMs[0], quantity_change: sumQc };
    }
    return reserveMs[0];
  }
  if (item.kind === 'outboundGroup') {
    const ms = item.movements;
    if (!ms.length) return null;
    if (column === 'res') {
      const sumQc = ms
        .filter((x) => movementTypeLower(x) === 'unreserve')
        .reduce((s, x) => s + Number(x.quantity_change || 0), 0);
      const head = ms.find((x) => movementTypeLower(x) === 'unreserve') || ms[0];
      return { ...head, type: 'unreserve', quantity_change: sumQc };
    }
    if (column === 'bal') {
      const sumQc = ms
        .filter((x) => movementTypeLower(x) === 'shipment')
        .reduce((s, x) => s + Number(x.quantity_change || 0), 0);
      const head = ms.find((x) => movementTypeLower(x) === 'shipment') || ms[0];
      return { ...head, type: 'shipment', quantity_change: sumQc };
    }
    return ms[0];
  }
  return item.m;
}

/** Текст причины в истории: если есть reason — только он, иначе тип операции. Сторно помечается в meta.storno. */
function formatMovementReason(m) {
  const meta = parseMovementMeta(m);
  const isStorno = meta.storno === true || meta.storno === 'true';
  let reason = (m.reason && m.reason.trim()) ? m.reason.trim() : '';
  if (reason.startsWith('Сборка:')) {
    reason = `Отгрузка${reason.slice('Сборка'.length)}`;
  }
  if (reason) {
    if (isStorno && !/^сторно/i.test(reason)) return `Сторно: ${reason}`;
    return reason;
  }
  const typeLabel = (MOVEMENT_TYPE_LABELS[movementTypeLower(m)] || movementTypeLower(m)) || '—';
  if (isStorno) return `Сторно (${typeLabel})`;
  return typeLabel;
}

/** Ссылка для перехода из истории остатков: поступление → приёмка, резерв → заказ, списание → вкладка списания */
function getMovementLink(m) {
  const meta = parseMovementMeta(m);
  const reasonText = formatMovementReason(m);
  const t = movementTypeLower(m);
  if ((t === 'receipt' || t === 'customer_return') && meta.receipt_id != null) {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=receipts_list' },
      state: { openReceiptId: meta.receipt_id },
      label: reasonText
    };
  }
  if (t === 'reserve' && meta.orderId != null && String(meta.orderId).trim() !== '') {
    const orderId = String(meta.orderId).trim();
    const mp = String(meta.marketplace || 'ozon').toLowerCase();
    const pathMp =
      mp === 'wb' || mp === 'wildberries' ? 'wildberries' : mp === 'ym' || mp === 'yandex' ? 'yandex' : 'ozon';
    return { to: `/orders/${pathMp}/${encodeURIComponent(orderId)}`, state: null, label: reasonText };
  }
  if (t === 'writeoff') {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=writeoff' },
      state: { openTab: 'writeoff' },
      label: reasonText
    };
  }
  if (t === 'shipment' && meta.orderId != null && String(meta.orderId).trim() !== '') {
    const orderId = String(meta.orderId).trim();
    const mp = String(meta.marketplace || 'ozon').toLowerCase();
    const pathMp =
      mp === 'wb' || mp === 'wildberries' ? 'wildberries' : mp === 'ym' || mp === 'yandex' ? 'yandex' : 'ozon';
    return { to: `/orders/${pathMp}/${encodeURIComponent(orderId)}`, state: null, label: reasonText };
  }
  return null;
}

const STOCK_WAREHOUSE_LS = 'stockLevelsWarehouseId';

function buildSupplierBreakdownMap(rows) {
  const map = {};
  for (const row of rows || []) {
    const pid = String(row.product_id ?? row.productId ?? '');
    if (!pid) continue;
    const stock = Number(row.stock) || 0;
    if (stock <= 0) continue;
    if (!map[pid]) map[pid] = [];
    map[pid].push({
      supplierId: String(row.supplier_id ?? row.supplierId ?? ''),
      supplier: row.supplier_name || row.supplier_code || 'Поставщик',
      name: row.stock_name || row.supplier_name || row.supplier_code || '—',
      stock,
      price: row.price != null && row.price !== '' ? Number(row.price) : null,
      deliveryDays: Number(row.delivery_days ?? row.deliveryDays ?? 0) || 0
    });
  }
  return map;
}

function warehouseSupplierId(w) {
  const sid = w?.supplierId ?? w?.supplier_id;
  if (sid == null || sid === '') return null;
  return String(sid);
}

function isSupplierWarehouseRecord(w) {
  if (!w) return false;
  const sid = warehouseSupplierId(w);
  if (!sid) return false;
  const t = String(w.type || '').toLowerCase();
  const mainId = String(w.mainWarehouseId ?? w.main_warehouse_id ?? '').trim();
  return t === 'supplier' || Boolean(mainId);
}

/** Подписи складов поставщиков для всплывающего списка (данные уже отфильтрованы API при наличии mainWarehouseId). */
function enrichSupplierDetailsLabels(details, warehouses, mainWarehouseId) {
  if (!Array.isArray(details) || details.length === 0) return [];

  const mwId =
    mainWarehouseId != null && String(mainWarehouseId).trim() !== ''
      ? String(mainWarehouseId).trim()
      : null;

  const warehouseLabelBySupplierId = {};
  for (const w of warehouses || []) {
    if (!isSupplierWarehouseRecord(w)) continue;
    const attachedMainId = String(w.mainWarehouseId ?? w.main_warehouse_id ?? '').trim();
    if (!attachedMainId) continue;
    if (mwId && attachedMainId !== mwId) continue;
    const supplierId = warehouseSupplierId(w);
    if (!supplierId) continue;
    if (!warehouseLabelBySupplierId[supplierId]) {
      warehouseLabelBySupplierId[supplierId] = w.address || w.name || '';
    }
  }

  return details.map((d) => ({
    ...d,
    name: warehouseLabelBySupplierId[String(d.supplierId)] || d.name
  }));
}

function SupplierStockCell({ total, details }) {
  const hasSuppliers = Array.isArray(details) && details.length > 0;
  const totalStock = hasSuppliers
    ? details.reduce((s, d) => s + (Number(d.stock) || 0), 0)
    : Number(total) || 0;
  const [isHovered, setIsHovered] = useState(false);
  const [showAbove, setShowAbove] = useState(false);
  const containerRef = useRef(null);

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setShowAbove(window.innerHeight - rect.bottom < 300);
    }
  };

  if (totalStock <= 0) {
    return <span className="muted">—</span>;
  }

  return (
    <div
      ref={containerRef}
      className="stock-cell-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="stock-main-value">
        {totalStock} <span className="stock-main-caret">{showAbove ? '▲' : '▼'}</span>
      </span>
      {isHovered && hasSuppliers && (
        <div
          className={`stock-details-dropdown ${showAbove ? 'dropdown-above' : ''}`}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div className="dropdown-header">Остатки по поставщикам</div>
          {details.map((detail, idx) => (
            <div key={idx} className="dropdown-item">
              <div className="dropdown-item-main">
                <div className="dropdown-item-title" title={detail.name}>
                  {detail.name}
                </div>
                <div className="dropdown-item-sub">
                  {detail.supplier}
                  {detail.deliveryDays ? ` • ${detail.deliveryDays}д` : ''}
                </div>
              </div>
              <div className="dropdown-item-meta">
                <span className="dropdown-item-stock">{detail.stock}</span>
                {detail.price != null && Number.isFinite(detail.price) ? (
                  <span className="dropdown-item-price">{detail.price}₽</span>
                ) : null}
              </div>
            </div>
          ))}
          <div className="dropdown-footer">
            <span>Итого:</span>
            <span>{totalStock}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function WarehouseStocks() {
  const { products, loading: productsLoading, error: productsError, loadProducts } = useProducts();
  const { warehouses, loading: warehousesLoading, error: warehousesError } = useWarehouses();
  const [stockWarehouseId, setStockWarehouseId] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(STOCK_WAREHOUSE_LS) || '' : '';
    } catch {
      return '';
    }
  });
  const { organizations = [] } = useOrganizations();
  const { categories = [] } = useCategories();
  const [filterOrganizationId, setFilterOrganizationId] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterProductType, setFilterProductType] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterSearchDebounced, setFilterSearchDebounced] = useState('');
  const [historyProduct, setHistoryProduct] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reserveModalOpen, setReserveModalOpen] = useState(false);
  const [reserveOrders, setReserveOrders] = useState([]);
  const [reserveLoading, setReserveLoading] = useState(false);
  /** Список заказов из сгруппированной строки журнала (без запроса к API). */
  const [reserveListOverride, setReserveListOverride] = useState(null);
  const [supplierBreakdownByProductId, setSupplierBreakdownByProductId] = useState({});
  const [supplierStocksRefreshing, setSupplierStocksRefreshing] = useState(false);
  const [mpStockSyncing, setMpStockSyncing] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = useMemo(
    () => warehouseOpFromSearch(new URLSearchParams(location.search || '')),
    [location.search]
  );

  const handleWarehouseTabChange = useCallback(
    (tab) => {
      if (tab === 'table') {
        navigate('/stock-levels/warehouse', { replace: true });
      } else {
        navigate(`/stock-levels/warehouse?op=${encodeURIComponent(tab)}`, { replace: true });
      }
    },
    [navigate]
  );

  useLayoutEffect(() => {
    if (location.pathname !== '/stock-levels/warehouse') return;
    const s = location.state;
    const sp = new URLSearchParams(location.search || '');
    if (s?.openReceiptId != null && sp.get('op') !== 'receipts_list') {
      navigate('/stock-levels/warehouse?op=receipts_list', { replace: true, state: s });
      return;
    }
    if (s?.openTab && WAREHOUSE_VALID_OPS.has(s.openTab) && sp.get('op') !== s.openTab) {
      navigate(`/stock-levels/warehouse?op=${encodeURIComponent(s.openTab)}`, { replace: true, state: s });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  const buildListParams = useCallback(
    (extra = {}) => {
      const search = (extra.search !== undefined ? extra.search : filterSearchDebounced).trim();
      const productType = extra.productType !== undefined ? extra.productType : filterProductType;
      return {
        ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
        ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
        ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {}),
        ...(productType ? { productType } : {}),
        ...(search ? { search } : {}),
        ...extra
      };
    },
    [
      filterOrganizationId,
      filterCategoryId,
      stockWarehouseId,
      filterProductType,
      filterSearchDebounced
    ]
  );

  const applyFilters = () => {
    setFilterSearchDebounced(filterSearch.trim());
    loadProducts(buildListParams({ silent: false }));
  };

  useEffect(() => {
    const t = setTimeout(() => setFilterSearchDebounced(filterSearch.trim()), 400);
    return () => clearTimeout(t);
  }, [filterSearch]);

  useEffect(() => {
    loadProducts(buildListParams({ silent: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реакция на debounced search и тип товара
  }, [filterSearchDebounced, filterProductType]);

  const handlePushStocksToMarketplaces = async () => {
    if (!filterOrganizationId) {
      window.alert('Выберите организацию в фильтре — остатки отправляются в кабинет этой организации.');
      return;
    }
    const ok = window.confirm(
      'Отправить на маркетплейсы остатки из колонки «Доступно» (наличие на складе + поставщики) для товаров в таблице? Учитываются только товары, связанные с МП, и настроенные сопоставления складов.'
    );
    if (!ok) return;
    setMpStockSyncing(true);
    try {
      const productIds = rows.map((r) => r.product?.id).filter((id) => id != null && id !== '');
      const res = await marketplaceStockApi.syncBulk({
        organizationId: filterOrganizationId,
        productIds: productIds.length > 0 ? productIds : undefined,
        warehouseId: stockWarehouseId || null
      });
      const data = res?.data ?? res;
      const pushed = data?.pushed ?? 0;
      const failed = data?.failed ?? 0;
      if (data?.skipped && data?.reason === 'skip_marketplace_stock_sync') {
        window.alert('Отправка отключена в настройках организации или категории товара.');
        return;
      }
      window.alert(
        `Готово.\nУспешно обновлено на МП: ${pushed}\nОшибок: ${failed}` +
          (data?.message ? `\n\n${data.message}` : '')
      );
    } catch (e) {
      window.alert(`Ошибка: ${e.response?.data?.message || e.message || 'Не удалось отправить остатки'}`);
    } finally {
      setMpStockSyncing(false);
    }
  };

  const handleRefreshWarehouseAndSupplierStocks = async () => {
    const ok = window.confirm(
      'Запустить обновление остатков у поставщиков (Микадо, Москворечье) для всех товаров? Синхронизация идёт в фоне 10–30 минут.'
    );
    if (!ok) return;
    setSupplierStocksRefreshing(true);
    try {
      const res = await productsApi.refreshSupplierStocks();
      const msg =
        res?.data?.message ||
        'Синхронизация запущена. Через несколько минут нажмите «Обновить склад» или обновите страницу.';
      window.alert(msg);
      if (!res?.data?.inProgress) {
        await loadProducts(buildListParams({ silent: true }));
      }
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось запустить обновление';
      window.alert(`Ошибка: ${msg}`);
    } finally {
      setSupplierStocksRefreshing(false);
    }
  };

  const handleOrganizationFilterChange = (e) => {
    const v = e.target.value;
    setFilterOrganizationId(v);
    loadProducts(buildListParams({ organizationId: v || undefined, silent: true }));
  };

  const handleCategoryFilterChange = (e) => {
    const v = e.target.value;
    setFilterCategoryId(v);
    loadProducts(buildListParams({ categoryId: v || undefined, silent: true }));
  };

  const handleProductTypeFilterChange = (e) => {
    setFilterProductType(e.target.value);
  };

  const ownWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId
      ),
    [warehouses]
  );

  const handleStockWarehouseChange = (e) => {
    const v = e.target.value;
    setStockWarehouseId(v);
    try {
      if (v) localStorage.setItem(STOCK_WAREHOUSE_LS, v);
      else localStorage.removeItem(STOCK_WAREHOUSE_LS);
    } catch {
      /* ignore */
    }
    loadProducts(buildListParams({ warehouseId: v || undefined, silent: true }));
  };

  /** Подгрузка остатков по конкретному складу (инвентаризация без подстановки «первого склада» при «Все склады»). */
  const reloadProductsWithWarehouse = useCallback(
    (warehouseId) => {
      const w = warehouseId != null && warehouseId !== '' ? String(warehouseId) : '';
      loadProducts(buildListParams({ warehouseId: w || undefined, silent: true }));
    },
    [loadProducts, buildListParams]
  );

  useEffect(() => {
    if (activeTab !== 'table' || !products.length) {
      setSupplierBreakdownByProductId({});
      return undefined;
    }
    let cancelled = false;
    const ids = products.map((p) => p.id).filter((id) => id != null);
    if (!ids.length) {
      setSupplierBreakdownByProductId({});
      return undefined;
    }

    const mainWarehouseId =
      stockWarehouseId != null && String(stockWarehouseId).trim() !== ''
        ? String(stockWarehouseId).trim()
        : null;

    const chunkSize = 80;
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    (async () => {
      try {
        const allRows = [];
        for (const chunk of chunks) {
          if (cancelled) return;
          const res = await supplierStocksApi.getBreakdown(chunk, { mainWarehouseId });
          const rows = res?.data ?? (Array.isArray(res) ? res : []);
          if (Array.isArray(rows)) allRows.push(...rows);
        }
        if (cancelled) return;
        setSupplierBreakdownByProductId(buildSupplierBreakdownMap(allRows));
      } catch {
        if (!cancelled) setSupplierBreakdownByProductId({});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [products, activeTab, stockWarehouseId]);

  useEffect(() => {
    if (!historyProduct) {
      setHistoryList([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    stockMovementsApi.getHistory(historyProduct.id, { limit: 100 })
      .then(res => {
        if (cancelled) return;
        const list = res?.data ?? res ?? [];
        setHistoryList(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setHistoryList([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [historyProduct]);

  const displayHistoryRows = useMemo(() => {
    const visible = historyList.filter((m) => !isHiddenStockHistoryMovement(m));
    return buildHistoryDisplayRows(visible);
  }, [historyList]);

  const historyDisplaySnapshots = useMemo(
    () => buildHistoryDisplaySnapshots(displayHistoryRows),
    [displayHistoryRows]
  );

  useEffect(() => {
    if (!reserveModalOpen || !historyProduct?.id) {
      setReserveOrders([]);
      return;
    }
    if (reserveListOverride != null) {
      setReserveLoading(false);
      return;
    }
    let cancelled = false;
    setReserveLoading(true);
    stockMovementsApi
      .getReservedOrders(historyProduct.id)
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res ?? [];
        setReserveOrders(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setReserveOrders([]);
      })
      .finally(() => {
        if (!cancelled) setReserveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reserveModalOpen, reserveListOverride, historyProduct?.id]);

  const selectedWarehouse = stockWarehouseId
    ? ownWarehouses.find((w) => String(w.id) === stockWarehouseId)
    : null;
  const mainWarehouseName = selectedWarehouse
    ? selectedWarehouse.address || selectedWarehouse.name || 'Склад'
    : 'Все склады (сумма)';

  const rows = useMemo(
    () =>
      buildStockRowsWithKits(products, (product) => {
        const onHand = Number(product.quantity ?? 0) || 0;
        const incoming = Number(product.incoming_quantity ?? product.incomingQuantity ?? 0) || 0;
        const reserved = Number(product.reserved_quantity ?? product.reservedQuantity ?? 0) || 0;
        const allDetails = supplierBreakdownByProductId[String(product.id)] || [];
        const supplierDetails = enrichSupplierDetailsLabels(
          allDetails,
          warehouses,
          stockWarehouseId || null
        );
        const suppliers = supplierDetails.reduce((s, d) => s + (Number(d.stock) || 0), 0);
        const available = onHand + suppliers;
        return { onHand, incoming, reserved, suppliers, supplierDetails, available };
      }),
    [products, supplierBreakdownByProductId, warehouses, stockWarehouseId]
  );

  if (productsLoading || warehousesLoading) {
    return <div className="loading">Загрузка остатков на складе...</div>;
  }
  if (productsError) {
    return <div className="error">Ошибка загрузки товаров: {productsError}</div>;
  }
  if (warehousesError) {
    return <div className="error">Ошибка загрузки складов: {warehousesError}</div>;
  }

  return (
    <>
      <p className="stock-levels-description">
        Складской учёт: реальные остатки на вашем складе. Поступление и списание — по скану штрихкода или артикулу; инвентаризация — ввод фактических остатков.
      </p>

      <WarehouseOperations
        products={products}
        mainWarehouseName={mainWarehouseName}
        inventoryWarehouseId={stockWarehouseId || ''}
        reloadProductsWithWarehouse={reloadProductsWithWarehouse}
        onRefresh={loadProducts}
        loading={productsLoading}
        activeTab={activeTab}
        onTabChange={handleWarehouseTabChange}
        openReceiptId={location.state?.openReceiptId}
        hideTabs
      />

      {activeTab === 'table' && (
        <>
          <div className="stock-levels-filters">
            <label className="stock-levels-filter-label">
              <span>Склад (остаток):</span>
              <select
                value={stockWarehouseId}
                onChange={handleStockWarehouseChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все склады (сумма)</option>
                {ownWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Организация:</span>
              <select
                value={filterOrganizationId}
                onChange={handleOrganizationFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>{org.name || org.id}</option>
                ))}
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Категория:</span>
              <select
                value={filterCategoryId}
                onChange={handleCategoryFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name || cat.id}</option>
                ))}
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Тип товара:</span>
              <select
                value={filterProductType}
                onChange={handleProductTypeFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                <option value="product">Товар</option>
                <option value="kit">Комплект</option>
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Поиск:</span>
              <input
                type="search"
                className="stock-levels-filter-input"
                placeholder="Артикул, название, штрихкод"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
              />
            </label>
          </div>
          <div className="stock-levels-table-wrapper" style={{ marginTop: '16px', width: '100%' }}>
            <table className="stock-levels-table table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Товар</th>
                  <th>В пути</th>
                  <th>Резерв</th>
                  <th>Наличие</th>
                  <th>Поставщики</th>
                  <th>Доступно</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.product.sku || row.product.id}
                    className="stock-levels-row-clickable"
                    onClick={() => setHistoryProduct(row.product)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setHistoryProduct(row.product)}
                  >
                    <td className="sku-cell">{row.product.sku || '—'}</td>
                    <td className="name-cell">{row.product.name || 'Без названия'}</td>
                    <td>{row.incoming}</td>
                    <td className="stock-levels-reserved-cell">{row.reserved}</td>
                    <td className="main-warehouse-cell">{row.onHand}</td>
                    <td className="supplier-stock-cell" onClick={(e) => e.stopPropagation()}>
                      <SupplierStockCell total={row.suppliers} details={row.supplierDetails} />
                    </td>
                    <td>{row.available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="stock-levels-history-hint">Нажмите на строку товара, чтобы открыть историю изменений остатков.</p>

          <div className="actions" style={{ marginTop: '16px' }}>
            <Button variant="secondary" onClick={applyFilters} disabled={supplierStocksRefreshing || mpStockSyncing}>
              Обновить склад
            </Button>
            <Button
              variant="primary"
              onClick={handleRefreshWarehouseAndSupplierStocks}
              disabled={supplierStocksRefreshing || mpStockSyncing || productsLoading}
              style={{ marginLeft: 8 }}
            >
              {supplierStocksRefreshing ? 'Обновление поставщиков…' : 'Обновить остатки поставщиков'}
            </Button>
            <Button
              variant="secondary"
              onClick={handlePushStocksToMarketplaces}
              disabled={mpStockSyncing || supplierStocksRefreshing || productsLoading}
              style={{ marginLeft: 8 }}
              title="Отправить значения из колонки «Доступно» на Ozon, Wildberries и Яндекс.Маркет"
            >
              {mpStockSyncing ? 'Отправка на МП…' : 'Отправить на маркетплейсы'}
            </Button>
          </div>
        </>
      )}

      <Modal
        isOpen={!!historyProduct}
        onClose={() => {
          setHistoryProduct(null);
          setReserveModalOpen(false);
          setReserveListOverride(null);
        }}
        title={historyProduct ? `История остатков: ${historyProduct.name || historyProduct.sku || '—'}` : 'История остатков'}
        size="large"
      >
        {historyLoading ? (
          <div className="loading">Загрузка истории…</div>
        ) : historyList.length === 0 ? (
          <p className="stock-levels-history-empty">Нет записей об изменениях остатков.</p>
        ) : (
          <div className="stock-levels-history-table-wrap">
            <table className="stock-levels-table table stock-levels-history-table">
              <thead>
                <tr>
                  <th>Дата и время</th>
                  <th>Причина</th>
                  <th>В пути</th>
                  <th>Резерв</th>
                  <th>Наличие</th>
                </tr>
              </thead>
              <tbody>
                {displayHistoryRows.map((item, idx) => {
                  const cur = historyDisplaySnapshots[idx];
                  const prev = idx + 1 < historyDisplaySnapshots.length ? historyDisplaySnapshots[idx + 1] : null;
                  const mInferInc = movementForDeltaInference(item, 'inc');
                  const mInferRes = movementForDeltaInference(item, 'res');
                  const mInferBal = movementForDeltaInference(item, 'bal');
                  const incCell = formatAfterDeltaSmart(cur.inc, prev?.inc, mInferInc, 'inc');
                  const resCell = formatAfterDeltaSmart(cur.res, prev?.res, mInferRes, 'res');
                  const balCell = formatAfterDeltaSmart(cur.bal, prev?.bal, mInferBal, 'bal');

                  if (item.kind === 'outboundGroup') {
                    const oids = orderIdsFromOutboundMovements(item.movements);
                    const reasonText = truncateOutboundOrdersLine(oids);
                    const createdAt = movementCreatedAt(item.movements[0]);
                    const rowKey = item.movements.map((x) => x.id).join('-');
                    return (
                      <tr key={rowKey} className="stock-levels-history-row-outbound-group">
                        <td>{formatDateTime(createdAt)}</td>
                        <td>{reasonText}</td>
                        <td>{renderStockHistoryQtyCell(incCell)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setReserveListOverride(null);
                              setReserveModalOpen(true);
                            }}
                            title="Заказы с резервом этого товара (текущее состояние)"
                          >
                            {renderStockHistoryQtyCell(resCell)}
                          </button>
                        </td>
                        <td>{renderStockHistoryQtyCell(balCell)}</td>
                      </tr>
                    );
                  }

                  if (item.kind === 'reserveGroup') {
                    const orderIds = item.movements
                      .map((x) => extractOrderIdFromReserveMovement(x))
                      .filter(Boolean);
                    const reasonText = truncateReserveReason(orderIds);
                    const createdAt = movementCreatedAt(item.movements[0]);
                    const rowKey = item.movements.map((x) => x.id).join('-');
                    const pinned = reserveOrdersFromMovements(item.movements);
                    return (
                      <tr
                        key={rowKey}
                        className="stock-levels-row-clickable stock-levels-history-row-reserve-group"
                        role="button"
                        tabIndex={0}
                        title="Нажмите, чтобы открыть список заказов из этой записи"
                        onClick={() => {
                          setReserveListOverride(pinned);
                          setReserveModalOpen(true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setReserveListOverride(pinned);
                            setReserveModalOpen(true);
                          }
                        }}
                      >
                        <td>{formatDateTime(createdAt)}</td>
                        <td>{reasonText}</td>
                        <td>{renderStockHistoryQtyCell(incCell)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setReserveListOverride(null);
                              setReserveModalOpen(true);
                            }}
                            title="Заказы с резервом этого товара (текущее состояние)"
                          >
                            {renderStockHistoryQtyCell(resCell)}
                          </button>
                        </td>
                        <td>{renderStockHistoryQtyCell(balCell)}</td>
                      </tr>
                    );
                  }

                  const m = item.m;
                  const link = getMovementLink(m);
                  const reasonText = link ? link.label : formatMovementReason(m);
                  return (
                    <tr key={m.id}>
                      <td>{formatDateTime(movementCreatedAt(m))}</td>
                      <td>
                        {link ? (
                          <Link
                            to={link.to}
                            state={link.state}
                            className="stock-levels-history-link"
                            onClick={() => setHistoryProduct(null)}
                          >
                            {reasonText}
                          </Link>
                        ) : (
                          reasonText
                        )}
                      </td>
                      <td>{renderStockHistoryQtyCell(incCell)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setReserveListOverride(null);
                            setReserveModalOpen(true);
                          }}
                          title="Заказы с резервом этого товара (текущее состояние)"
                        >
                          {renderStockHistoryQtyCell(resCell)}
                        </button>
                      </td>
                      <td>{renderStockHistoryQtyCell(balCell)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={reserveModalOpen}
        onClose={() => {
          setReserveModalOpen(false);
          setReserveListOverride(null);
        }}
        title="Резерв под заказы"
        size="medium"
      >
        {reserveListOverride != null ? (
          reserveListOverride.length === 0 ? (
            <p className="text-muted mb-0">В этой записи журнала не удалось извлечь номера заказов.</p>
          ) : (
            <>
              <p className="text-muted small mb-2">Заказы из выбранной записи журнала (не текущее состояние склада).</p>
              <ul className="list-group">
                {reserveListOverride.map((o, i) => (
                  <li
                    key={`${o.orderDbId}-${o.orderId}-${i}`}
                    className="list-group-item d-flex justify-content-between align-items-center"
                  >
                    <Link
                      to={`/orders/${o.marketplace}/${encodeURIComponent(o.orderId)}`}
                      className="stock-levels-history-link"
                      onClick={() => {
                        setReserveModalOpen(false);
                        setReserveListOverride(null);
                        setHistoryProduct(null);
                      }}
                    >
                      {o.marketplace} · {o.orderId}
                    </Link>
                    <span className="badge bg-secondary rounded-pill">{o.reservedQty}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : reserveLoading ? (
          <div className="loading">Загрузка…</div>
        ) : reserveOrders.length === 0 ? (
          <p className="text-muted mb-0">Нет активного резерва по заказам или резерв не привязан к заказам в журнале.</p>
        ) : (
          <ul className="list-group">
            {reserveOrders.map((o) => (
              <li key={`${o.orderDbId}-${o.orderId}`} className="list-group-item d-flex justify-content-between align-items-center">
                <Link
                  to={`/orders/${o.marketplace}/${encodeURIComponent(o.orderId)}`}
                  className="stock-levels-history-link"
                  onClick={() => {
                    setReserveModalOpen(false);
                    setHistoryProduct(null);
                  }}
                >
                  {o.marketplace} · {o.orderId}
                </Link>
                <span className="badge bg-secondary rounded-pill">{o.reservedQty}</span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

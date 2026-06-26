/**
 * Остатки на складе — складской учёт, поступление, списание, инвентаризация
 */

import React, { useState, useEffect, useMemo, useLayoutEffect, useCallback, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useCategories } from '../../hooks/useCategories';
import { useBrands } from '../../hooks/useBrands';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { stockMovementsApi } from '../../services/stockMovements.api';
import { ordersApi } from '../../services/orders.api';
import { supplierStocksApi } from '../../services/supplierStocks.api';
import { productsApi } from '../../services/products.api';
import { marketplaceStockApi } from '../../services/marketplaceStock.api';
import { warehouseMappingsApi } from '../../services/warehouseMappings.api';
import {
  buildStockRowsWithKits,
  stockTableAvailable,
  isKitProduct,
  manualWarehouseStockEditBlockedReason,
  isKitStockHistoryMovement,
  parseKitDisplayMetrics,
  formatKitAvailableDisplay,
  kitIncomingFromComponentsAmount
} from '../../utils/kitStockMetrics';
import { isProfileKitsEnabled, isProfileProductSupplierBindingEnabled } from '../../utils/profileFlags.js';
import { useSuppliers } from '../../hooks/useSuppliers';
import { onNavigationClick } from '../../utils/navigationClick.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import { authApi } from '../../services/auth.api.js';
import { WarehouseOperations } from './WarehouseOperations';
import { warehouseOpFromSearch, WAREHOUSE_VALID_OPS } from './warehouseTabs';
import { getOrderStatusLabel } from '../../constants/orderStatuses';
import './StockLevels.css';

const STOCK_LIST_PAGE_SIZES = [50, 100, 200];
const STOCK_LIST_PAGE_SIZE_LS = 'stockListPageSize';
const STOCK_IN_STOCK_ONLY_LS = 'stockListInStockOnly';
const STOCK_RESERVED_ONLY_LS = 'stockListReservedOnly';
const STOCK_AVAILABLE_ONLY_LS = 'stockListAvailableOnly';

function isStockResetFlagEnabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

const MOVEMENT_TYPE_LABELS = {
  receipt: 'Поступление',
  incoming: 'В пути',
  writeoff: 'Списание',
  shipment: 'Отгрузка',
  reserve: 'Резерв',
  unreserve: 'Снятие резерва',
  inventory: 'Инвентаризация',
  manual: 'Ручное изменение',
  opening_balance: 'Начальный остаток',
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

function movementNum(m, snakeKey) {
  if (!m) return null;
  const camelKey = snakeKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const raw = m[snakeKey] ?? m[camelKey];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Снимок «в пути / резерв / наличие» из строки журнала (учёт старых записей без incoming_after). */
function warehouseBalanceFromMovement(m, warehouseFilterId) {
  if (!m || warehouseFilterId == null || String(warehouseFilterId).trim() === '') return null;
  const meta = parseMovementMeta(m);
  const whRaw = m.warehouse_id ?? m.warehouseId ?? meta.warehouse_id ?? meta.warehouseId;
  if (whRaw == null || String(whRaw) !== String(warehouseFilterId)) return null;
  const after = meta.warehouse_balance_after ?? meta.warehouseBalanceAfter;
  if (after == null || after === '') return null;
  const n = Number(after);
  return Number.isFinite(n) ? n : null;
}

function snapshotFromMovement(m, warehouseFilterId = null) {
  const incDb = movementNum(m, 'incoming_after');
  const resDb = movementNum(m, 'reserved_after');
  const balDb = movementNum(m, 'balance_after');
  const whBal = warehouseBalanceFromMovement(m, warehouseFilterId);
  const hasNew = incDb != null || resDb != null;
  const t = movementTypeLower(m);

  let inc = incDb;
  if (inc == null && t === 'incoming' && balDb != null && !hasNew) {
    inc = balDb;
  }
  let res = resDb;
  let bal = whBal != null ? whBal : balDb;

  if (t === 'incoming' && !hasNew) {
    return { inc, res: res != null ? res : null, bal: null };
  }
  if (t === 'reserve' || t === 'unreserve') {
    return {
      inc: inc != null ? inc : null,
      res: res != null ? res : null,
      bal: bal != null ? bal : null,
    };
  }
  return {
    inc: inc != null ? inc : null,
    res: res != null ? res : null,
    bal: bal != null ? bal : null,
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
    return after + qc;
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

/** Доступно к продаже после операции: наличие + в пути − резерв (как в таблице остатков). */
function availableFromSnapshot(snap) {
  if (!snap) return null;
  const bal = snap.bal != null && !Number.isNaN(Number(snap.bal)) ? Number(snap.bal) : null;
  const inc = snap.inc != null && !Number.isNaN(Number(snap.inc)) ? Number(snap.inc) : null;
  const res = snap.res != null && !Number.isNaN(Number(snap.res)) ? Number(snap.res) : null;
  if (bal == null && inc == null && res == null) return null;
  return (bal ?? 0) + (inc ?? 0) - (res ?? 0);
}

function formatAvailableHistoryCell(curSnap, prevSnap) {
  if (curSnap?._kitAvailableWhole != null && curSnap?._kitAvailableTotal != null) {
    const after = formatKitAvailableDisplay({
      whole_available: curSnap._kitAvailableWhole,
      marketplace_available: curSnap._kitAvailableTotal,
      assemblable_from_components: 0
    });
    if (prevSnap?._kitAvailableTotal == null || Number.isNaN(Number(prevSnap._kitAvailableTotal))) {
      return after;
    }
    const d = curSnap._kitAvailableTotal - prevSnap._kitAvailableTotal;
    if (d === 0) return after;
    return `${curSnap._kitAvailableWhole} (${curSnap._kitAvailableTotal}(${d > 0 ? '+' : ''}${d}))`;
  }
  const after = availableFromSnapshot(curSnap);
  const prev = availableFromSnapshot(prevSnap);
  return formatAfterDelta(after, prev);
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
  const mp = String(meta.marketplace || '').trim().toLowerCase();
  if (!mp) return null;
  if (mp === 'wb' || mp === 'wildberries') return 'wildberries';
  if (mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket') return 'yandex';
  if (mp === 'manual') return 'manual';
  return mp;
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
  const unreserveByKey = new Map();
  const outboundByKey = new Map();
  for (const m of list) {
    const key = reserveTimeGroupKey(movementCreatedAt(m));
    if (!key) continue;
    if (movementTypeLower(m) === 'reserve') {
      if (!reserveByKey.has(key)) reserveByKey.set(key, []);
      reserveByKey.get(key).push(m);
    } else if (movementTypeLower(m) === 'unreserve' && !isOutboundBatchMovement(m)) {
      if (!unreserveByKey.has(key)) unreserveByKey.set(key, []);
      unreserveByKey.get(key).push(m);
    } else if (isOutboundBatchMovement(m)) {
      if (!outboundByKey.has(key)) outboundByKey.set(key, []);
      outboundByKey.get(key).push(m);
    }
  }
  for (const arr of reserveByKey.values()) sortBlock(arr);
  for (const arr of unreserveByKey.values()) sortBlock(arr);
  for (const arr of outboundByKey.values()) sortBlock(arr);

  const emittedReserve = new Set();
  const emittedUnreserve = new Set();
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
    if (movementTypeLower(m) === 'unreserve' && !isOutboundBatchMovement(m)) {
      if (!key || emittedUnreserve.has(key)) continue;
      emittedUnreserve.add(key);
      const block = unreserveByKey.get(key) || [m];
      if (block.length >= 2) out.push({ kind: 'unreserveGroup', movements: block });
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
function snapshotAfterDisplayItem(item, warehouseFilterId = null) {
  if (
    item.kind === 'reserveGroup' ||
    item.kind === 'unreserveGroup' ||
    item.kind === 'outboundGroup'
  ) {
    return snapshotFromMovement(item.movements[0], warehouseFilterId);
  }
  return snapshotFromMovement(item.m, warehouseFilterId);
}

function sumMovementsQuantityChange(movements) {
  return movements.reduce((s, x) => s + Number(x.quantity_change || 0), 0);
}

/** Для истории комплекта: резерв в целых комплектах, не сумма штук комплектующих. */
function kitReserveUnitsFromMovements(movements) {
  let units = 0;
  for (const m of movements || []) {
    const meta = parseMovementMeta(m);
    const fromMeta =
      Number(meta.kit_units) ||
      Number(meta.kit_reserve_preallocated) ||
      Number(meta.kit_reserve_from_whole) ||
      0;
    if (fromMeta > 0) {
      units += fromMeta;
      continue;
    }
    if (meta.kit_component_reserve === true) continue;
    const qc = Number(m.quantity_change) || 0;
    if (qc < 0) units += Math.abs(qc);
    else if (qc > 0) units -= qc;
  }
  return Math.max(0, units);
}

/**
 * Дополняем снимок для отображения: у резервов в БД часто нет incoming_after/reserved_after;
 * одиночный «Резерв по заказу» — те же правила, что у сгруппированных резервов;
 * пачка отгрузки — «в пути» 0, резерв 0.
 */
function enrichHistoryRowSnapshot(item, cur, prevLineBelow, kitProduct = null) {
  const out = {
    inc: cur.inc != null && !Number.isNaN(Number(cur.inc)) ? Number(cur.inc) : cur.inc,
    res: cur.res != null && !Number.isNaN(Number(cur.res)) ? Number(cur.res) : cur.res,
    bal: cur.bal != null && !Number.isNaN(Number(cur.bal)) ? Number(cur.bal) : cur.bal,
  };

  const reserveLikeMs =
    item.kind === 'reserveGroup' || item.kind === 'unreserveGroup'
      ? item.movements
      : item.kind === 'single' &&
          (movementTypeLower(item.m) === 'reserve' || movementTypeLower(item.m) === 'unreserve')
        ? [item.m]
        : null;

  if (reserveLikeMs && reserveLikeMs.length) {
    const head = reserveLikeMs[0];
    const sumQc = sumMovementsQuantityChange(reserveLikeMs);
    const dbInc = movementNum(head, 'incoming_after');
    const dbRes = movementNum(head, 'reserved_after');
    const dbBal = movementNum(head, 'balance_after');

    // Резерв не меняет «в пути» — не показываем ложный +Δ из incoming_after снимка.
    if (prevLineBelow?.inc != null && !Number.isNaN(prevLineBelow.inc)) {
      out.inc = prevLineBelow.inc;
    } else if (dbInc != null) {
      out.inc = dbInc;
    } else if (out.inc == null) {
      out.inc = 0;
    }

    const useKitUnits =
      kitProduct &&
      isKitProduct(kitProduct) &&
      reserveLikeMs.some((m) => {
        const meta = parseMovementMeta(m);
        return meta.kit_component_reserve === true || meta.kit_reserve_scope;
      });

    if (dbRes != null) {
      out.res = dbRes;
    } else if (useKitUnits && prevLineBelow?.res != null) {
      const kitUnits = kitReserveUnitsFromMovements(reserveLikeMs);
      const isUnreserve =
        item.kind === 'unreserveGroup' ||
        (item.kind === 'single' && movementTypeLower(item.m) === 'unreserve');
      out.res = isUnreserve
        ? Math.max(0, prevLineBelow.res - kitUnits)
        : prevLineBelow.res + kitUnits;
    } else if (prevLineBelow?.res != null && Number.isFinite(sumQc)) {
      out.res =
        sumQc > 0
          ? Math.max(0, prevLineBelow.res - sumQc)
          : Math.max(0, prevLineBelow.res + sumQc);
    }

    // Резерв не меняет наличие на складе — в колонке «Наличие» держим снимок как у строки ниже.
    if (prevLineBelow?.bal != null && !Number.isNaN(prevLineBelow.bal)) {
      out.bal = prevLineBelow.bal;
    } else if (dbBal != null) {
      out.bal = dbBal;
    }
    if (out.inc == null || Number.isNaN(Number(out.inc))) out.inc = 0;
    if (out.res == null || Number.isNaN(Number(out.res))) out.res = 0;
    if (out.bal == null || Number.isNaN(Number(out.bal))) out.bal = 0;
    return out;
  }

  if (item.kind === 'outboundGroup') {
    const head = item.movements[0];
    const dbInc = movementNum(head, 'incoming_after');
    const dbRes = movementNum(head, 'reserved_after');
    const dbBal = movementNum(head, 'balance_after');
    if (dbInc != null) out.inc = dbInc;
    if (dbRes != null) out.res = dbRes;
    if (dbBal != null) out.bal = dbBal;
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
      const moveQty = Math.max(0, Number(m.quantity_change) || 0);
      const dbInc = movementNum(m, 'incoming_after');
      const dbRes = movementNum(m, 'reserved_after');
      const dbBal = movementNum(m, 'balance_after');
      if (dbInc != null) out.inc = dbInc;
      else if (prevLineBelow?.inc != null && moveQty > 0) {
        out.inc = Math.max(0, Number(prevLineBelow.inc) - moveQty);
      } else if (out.inc == null || Number.isNaN(Number(out.inc))) out.inc = 0;
      const prevRes =
        prevLineBelow?.res != null && !Number.isNaN(Number(prevLineBelow.res))
          ? Number(prevLineBelow.res)
          : null;
      // При приёмке резерв не снимается — только перенос из «в пути» в наличие (старые снимки могли писать reserved_after=0).
      if (prevRes != null && prevRes > 0) {
        out.res = dbRes != null && dbRes >= prevRes ? dbRes : prevRes;
      } else if (dbRes != null) {
        out.res = dbRes;
      } else if (prevRes != null) {
        out.res = prevRes;
      }
      if (dbBal != null) {
        out.bal = dbBal;
      } else if (prevLineBelow?.bal != null && moveQty > 0) {
        out.bal = Number(prevLineBelow.bal) + moveQty;
      }
    }
    if (t === 'inventory') {
      const dbBal = movementNum(m, 'balance_after');
      if (dbBal != null) out.bal = dbBal;
      // Инвентаризация меняет только наличие — резерв и «в пути» в истории не двигаем.
      if (prevLineBelow?.inc != null && !Number.isNaN(Number(prevLineBelow.inc))) {
        out.inc = Number(prevLineBelow.inc);
      } else {
        const dbInc = movementNum(m, 'incoming_after');
        out.inc = dbInc != null ? dbInc : 0;
      }
      if (prevLineBelow?.res != null && !Number.isNaN(Number(prevLineBelow.res))) {
        out.res = Number(prevLineBelow.res);
      } else {
        const dbRes = movementNum(m, 'reserved_after');
        out.res = dbRes != null ? dbRes : 0;
      }
      return out;
    }
    if (t === 'reserve' || t === 'unreserve') {
      const dbRes = movementNum(m, 'reserved_after');
      if (dbRes != null) out.res = dbRes;
      if (prevLineBelow?.inc != null && !Number.isNaN(prevLineBelow.inc)) {
        out.inc = prevLineBelow.inc;
      }
      if (prevLineBelow?.bal != null && !Number.isNaN(prevLineBelow.bal)) {
        out.bal = prevLineBelow.bal;
      }
    }
  }

  return out;
}

/** Снимки строк истории с enrich; индекс 0 — самая новая строка, prev для строки i = enriched[i+1]. */
function buildHistoryDisplaySnapshots(
  displayRows,
  currentNetReserved = null,
  warehouseFilterId = null,
  kitProduct = null
) {
  if (!Array.isArray(displayRows) || displayRows.length === 0) return [];
  const n = displayRows.length;
  const enriched = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const item = displayRows[i];
    const raw = snapshotAfterDisplayItem(item, warehouseFilterId);
    const prevLineBelow = i + 1 < n ? enriched[i + 1] : null;
    enriched[i] = enrichHistoryRowSnapshot(item, raw, prevLineBelow, kitProduct);
  }
  const net =
    currentNetReserved != null && Number.isFinite(Number(currentNetReserved))
      ? Math.max(0, Math.floor(Number(currentNetReserved)))
      : null;
  // Верхняя строка — актуальный нетто-резерв с API, кроме инвентаризации (она резерв не меняет).
  if (net != null && enriched[0]) {
    const topItem = displayRows[0];
    const topType =
      topItem?.kind === 'single' && topItem.m ? movementTypeLower(topItem.m) : null;
    if (topType !== 'inventory') {
      enriched[0].res = net;
    }
  }

  // Комплект: «Доступно» и снимок наличия/в пути — как в таблице остатков (kit_display), не сырой журнал SKU.
  if (kitProduct && isKitProduct(kitProduct) && warehouseFilterId) {
    const metrics = parseKitDisplayMetrics(kitProduct);
    if (metrics) {
      const kitSkuInc = Math.max(
        0,
        Number(kitProduct.incoming_quantity ?? kitProduct.incomingQuantity) || 0
      );
      const incFromComponents = kitIncomingFromComponentsAmount(metrics, kitProduct);
      const displayInc = kitSkuInc + incFromComponents;
      const whole = Math.max(0, Number(metrics.whole_on_hand) || 0);
      const assemblable = Math.max(0, Number(metrics.assemblable_from_components) || 0);
      const onSkuReserved = Math.max(0, Number(metrics.reserved_on_sku) || 0);
      const displayReserved = Math.max(
        0,
        Number(
          kitProduct.net_reserved_quantity ??
            kitProduct.netReservedQuantity ??
            kitProduct.reserved_quantity ??
            kitProduct.reservedQuantity
        ) || 0
      );
      const wholeAvailCurrent =
        metrics.whole_available != null && !Number.isNaN(Number(metrics.whole_available))
          ? Math.max(0, Number(metrics.whole_available))
          : Math.max(0, whole + kitSkuInc - onSkuReserved);
      const totalAvailCurrent =
        metrics.marketplace_available != null &&
        !Number.isNaN(Number(metrics.marketplace_available))
          ? Math.max(0, Number(metrics.marketplace_available))
          : Math.max(0, whole + kitSkuInc + assemblable - displayReserved);
      for (let i = 0; i < enriched.length; i++) {
        const row = enriched[i];
        if (!row) continue;
        const onSkuRes = Math.max(0, Number(row.res) || 0);
        if (i === 0) {
          row.bal = whole;
          row.inc = displayInc;
          row._kitAvailableWhole = wholeAvailCurrent;
          row._kitAvailableTotal = totalAvailCurrent;
          continue;
        }
        const rowBal =
          row.bal != null && !Number.isNaN(Number(row.bal)) ? Number(row.bal) : whole;
        const rowInc =
          row.inc != null && !Number.isNaN(Number(row.inc)) ? Number(row.inc) : displayInc;
        row._kitAvailableWhole = Math.max(0, rowBal + kitSkuInc - onSkuRes);
        row._kitAvailableTotal = Math.max(
          0,
          rowBal + kitSkuInc + assemblable - displayReserved
        );
      }
    }
  }

  return enriched;
}

/** Синтетическое движение для inferPrevForDelta в сгруппированных строках. */
function movementForDeltaInference(item, column) {
  const reserveLikeMs =
    item.kind === 'reserveGroup' || item.kind === 'unreserveGroup'
      ? item.movements
      : item.kind === 'single' &&
          (movementTypeLower(item.m) === 'reserve' || movementTypeLower(item.m) === 'unreserve')
        ? [item.m]
        : null;
  if (reserveLikeMs && reserveLikeMs.length) {
    if (column === 'res') {
      const sumQc = reserveLikeMs.reduce((s, x) => s + Number(x.quantity_change || 0), 0);
      const t = sumQc > 0 ? 'unreserve' : 'reserve';
      return { ...reserveLikeMs[0], type: t, quantity_change: sumQc };
    }
    return reserveLikeMs[0];
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
  if (meta.receipt_id != null) {
    let op = 'receipts_list';
    if (t === 'customer_return') op = 'return_customer';
    else if (t === 'return_to_supplier') op = 'return_supplier';
    return {
      to: { pathname: '/stock-levels/warehouse', search: `?op=${op}` },
      state: { openReceiptId: meta.receipt_id, openTab: op },
      label: reasonText
    };
  }
  if (t === 'reserve' && meta.orderId != null && String(meta.orderId).trim() !== '') {
    const orderId = String(meta.orderId).trim();
    const pathMp = marketplacePathFromMeta(meta);
    if (!pathMp) return null;
    return { to: `/orders/${pathMp}/${encodeURIComponent(orderId)}`, state: null, label: reasonText };
  }
  if (t === 'writeoff') {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=writeoff' },
      state: { openTab: 'writeoff' },
      label: reasonText
    };
  }
  if (t === 'transfer') {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=transfer' },
      state: { openTab: 'transfer' },
      label: reasonText
    };
  }
  if (t === 'shipment' && meta.orderId != null && String(meta.orderId).trim() !== '') {
    const orderId = String(meta.orderId).trim();
    const pathMp = marketplacePathFromMeta(meta);
    if (!pathMp) return null;
    return { to: `/orders/${pathMp}/${encodeURIComponent(orderId)}`, state: null, label: reasonText };
  }
  return null;
}

const STOCK_WAREHOUSE_LS = 'stockLevelsWarehouseId';

/** ERP-склад с привязками warehouse_mappings (для экспорта остатков на МП). */
function pickPrimaryMarketplaceStockWarehouseId(mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) return '';
  const byWh = new Map();
  for (const m of mappings) {
    const wid = String(m.warehouse_id ?? m.warehouseId ?? '').trim();
    if (!wid) continue;
    const mid = Number(m.id) || 0;
    const prev = byWh.get(wid);
    if (!prev || mid < prev.mid || (mid === prev.mid && Number(wid) < Number(prev.wid))) {
      byWh.set(wid, { wid, mid });
    }
  }
  let best = null;
  for (const v of byWh.values()) {
    if (!best || v.mid < best.mid || (v.mid === best.mid && Number(v.wid) < Number(best.wid))) {
      best = v;
    }
  }
  return best?.wid ?? '';
}

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
  const [isHovered, setIsHovered] = useState(false);
  const [showAbove, setShowAbove] = useState(false);
  const containerRef = useRef(null);

  const hasSuppliers = Array.isArray(details) && details.length > 0;
  const totalStock = hasSuppliers
    ? details.reduce((s, d) => s + (Number(d.stock) || 0), 0)
    : Number(total) || 0;

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

function ManualOnHandCell({ productId, currentOnHand, warehouseId, disabledReason, onSaved }) {
  const [value, setValue] = useState(String(currentOnHand ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setValue(String(currentOnHand ?? 0));
    setError(null);
  }, [productId, currentOnHand, warehouseId]);

  const parsed = Math.max(0, parseInt(String(value).trim(), 10) || 0);
  const unchanged = parsed === (Number(currentOnHand) || 0);

  const handleSave = async () => {
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    if (unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      const delta = parsed - (Number(currentOnHand) || 0);
      await stockMovementsApi.applyChange(productId, {
        delta,
        type: 'manual',
        reason: 'Ручная корректировка в списке остатков',
        meta: { warehouse_id: Number(warehouseId) }
      });
      onSaved?.();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  if (disabledReason) {
    return (
      <span className="stock-manual-onhand-readonly" title={disabledReason}>
        {currentOnHand}
      </span>
    );
  }

  return (
    <div className="stock-manual-onhand-edit" data-no-nav-click>
      <input
        type="number"
        min={0}
        step={1}
        className="stock-manual-onhand-input"
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        disabled={saving}
        title="Новое количество на выбранном складе"
        onClick={(ev) => ev.stopPropagation()}
      />
      <button
        type="button"
        className="stock-manual-onhand-save-btn"
        disabled={saving || unchanged}
        title="Сохранить новое наличие"
        aria-label="Сохранить наличие"
        onClick={(ev) => {
          ev.stopPropagation();
          void handleSave();
        }}
      >
        <svg
          className="stock-manual-onhand-save-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M13.485 3.515a1 1 0 0 1 0 1.414l-7.07 7.071a1 1 0 0 1-1.415 0L2.515 8.515a1 1 0 1 1 1.414-1.414L5.5 8.672l6.364-6.364a1 1 0 0 1 1.414 0z"
          />
        </svg>
      </button>
      {error ? (
        <span className="stock-manual-onhand-error" title={error} aria-label={error}>
          !
        </span>
      ) : null}
    </div>
  );
}

export function WarehouseStocks() {
  const { profile, isProfileAdmin, isAccountAdmin, accountRole, profileId } = useAuth();
  const kitsEnabled = isProfileKitsEnabled(profile);
  const supplierBindingEnabled = isProfileProductSupplierBindingEnabled(profile);
  const { suppliers } = useSuppliers();
  const supplierSyncEnabled = profile?.supplier_sync_enabled !== false;
  const allowManualStockEdit = profile?.allow_manual_warehouse_stock_edit === true;
  const canManageAccountStockReset =
    Boolean(profileId) &&
    (isProfileAdmin ||
      isAccountAdmin ||
      String(accountRole || '').toLowerCase() === 'admin');
  const [stockResetSettingOn, setStockResetSettingOn] = useState(false);

  const loadStockResetSetting = useCallback(async () => {
    if (!canManageAccountStockReset) {
      setStockResetSettingOn(false);
      return;
    }
    if (isStockResetFlagEnabled(profile?.allow_stock_history_reset)) {
      setStockResetSettingOn(true);
      return;
    }
    try {
      const authRes = await authApi.me();
      const authProfile = authRes?.data?.profile;
      if (isStockResetFlagEnabled(authProfile?.allow_stock_history_reset)) {
        setStockResetSettingOn(true);
        return;
      }
    } catch {
      /* fallback profiles/me */
    }
    try {
      const res = await profilesApi.getMe();
      const p = res?.data ?? res;
      setStockResetSettingOn(isStockResetFlagEnabled(p?.allow_stock_history_reset));
    } catch {
      setStockResetSettingOn(false);
    }
  }, [canManageAccountStockReset, profile?.allow_stock_history_reset]);

  useEffect(() => {
    void loadStockResetSetting();
  }, [loadStockResetSetting]);

  const allowStockHistoryReset = canManageAccountStockReset && stockResetSettingOn;
  const {
    products,
    meta,
    loading: productsLoading,
    listRefreshing,
    error: productsError,
    loadProducts
  } = useProducts({ autoLoad: false });
  const { warehouses, loading: warehousesLoading, error: warehousesError } = useWarehouses();
  const [stockWarehouseId, setStockWarehouseId] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(STOCK_WAREHOUSE_LS) || '' : '';
    } catch {
      return '';
    }
  });
  const manualOnHandBlockedReason = useMemo(
    () =>
      manualWarehouseStockEditBlockedReason({
        allowManualStockEdit,
        warehouseId: stockWarehouseId || null,
      }),
    [allowManualStockEdit, stockWarehouseId]
  );
  const { organizations = [] } = useOrganizations();
  const { categories = [] } = useCategories();
  const { brands = [] } = useBrands();
  const [filterOrganizationId, setFilterOrganizationId] = useState(() => {
    try {
      const raw =
        typeof localStorage !== 'undefined' ? localStorage.getItem('erp_selected_organization_id') : null;
      return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
    } catch {
      return '';
    }
  });
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterProductType, setFilterProductType] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterSearchDebounced, setFilterSearchDebounced] = useState('');
  const [filterInStockOnly, setFilterInStockOnly] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(STOCK_IN_STOCK_ONLY_LS) === '1';
    } catch {
      return false;
    }
  });
  const [filterReservedOnly, setFilterReservedOnly] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(STOCK_RESERVED_ONLY_LS) === '1';
    } catch {
      return false;
    }
  });
  const [filterAvailableOnly, setFilterAvailableOnly] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(STOCK_AVAILABLE_ONLY_LS) === '1';
    } catch {
      return false;
    }
  });
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STOCK_LIST_PAGE_SIZE_LS) : null;
      const n = parseInt(raw, 10);
      return STOCK_LIST_PAGE_SIZES.includes(n) ? n : 50;
    } catch {
      return 50;
    }
  });
  const loadListRef = useRef(() => {});
  const listBootstrappedRef = useRef(false);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [historyNetReserved, setHistoryNetReserved] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [reserveModalOpen, setReserveModalOpen] = useState(false);
  /** Товар, для которого открыта модалка резерва (таблица или история). */
  const [reserveModalProduct, setReserveModalProduct] = useState(null);
  const [reserveOrders, setReserveOrders] = useState([]);
  const [reserveFboSupplies, setReserveFboSupplies] = useState([]);
  const [reserveSummary, setReserveSummary] = useState(null);
  const [reserveLoading, setReserveLoading] = useState(false);
  const [reserveError, setReserveError] = useState(null);
  const [reserveUnreserveKey, setReserveUnreserveKey] = useState(null);
  const [reserveBulkReleasing, setReserveBulkReleasing] = useState(false);
  /** Список заказов из сгруппированной строки журнала (без запроса к API). */
  const [reserveListOverride, setReserveListOverride] = useState(null);
  const [supplierBreakdownByProductId, setSupplierBreakdownByProductId] = useState({});
  const [supplierStocksRefreshing, setSupplierStocksRefreshing] = useState(false);
  const [mpStockSyncing, setMpStockSyncing] = useState(false);
  const [mpStockPushBanner, setMpStockPushBanner] = useState(null);
  /** error | confirm | force | working | result — панель на странице (не window.alert) */
  const [mpPushPanel, setMpPushPanel] = useState(null);
  const [mpLinkedWarehouseId, setMpLinkedWarehouseId] = useState('');
  const [stockResetOpen, setStockResetOpen] = useState(false);
  const [stockResetProduct, setStockResetProduct] = useState(null);
  const [stockResetForm, setStockResetForm] = useState({ incoming: 0, onHand: 0, reserved: 0 });
  const [stockResetSaving, setStockResetSaving] = useState(false);
  const [stockResetError, setStockResetError] = useState('');

  useEffect(() => {
    if (historyProduct?.id) void loadStockResetSetting();
  }, [historyProduct?.id, loadStockResetSetting]);

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
    if (s?.openReceiptId != null) {
      const targetOp =
        s?.openTab && WAREHOUSE_VALID_OPS.has(s.openTab) ? s.openTab : 'receipts_list';
      if (sp.get('op') !== targetOp) {
        navigate(`/stock-levels/warehouse?op=${encodeURIComponent(targetOp)}`, {
          replace: true,
          state: s
        });
        return;
      }
    }
    if (s?.openTab && WAREHOUSE_VALID_OPS.has(s.openTab) && sp.get('op') !== s.openTab) {
      navigate(`/stock-levels/warehouse?op=${encodeURIComponent(s.openTab)}`, { replace: true, state: s });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    let cancelled = false;
    warehouseMappingsApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setMpLinkedWarehouseId(pickPrimaryMarketplaceStockWarehouseId(rows));
      })
      .catch(() => {
        if (!cancelled) setMpLinkedWarehouseId('');
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const mpLinkedWarehouse = useMemo(
    () =>
      mpLinkedWarehouseId && Array.isArray(warehouses)
        ? warehouses.find((w) => String(w.id) === String(mpLinkedWarehouseId))
        : null,
    [mpLinkedWarehouseId, warehouses]
  );

  /** По умолчанию таблица — склад с привязками к МП (Электролитный и т.п.). */
  useEffect(() => {
    if (!mpLinkedWarehouseId || stockWarehouseId) return;
    setStockWarehouseId(String(mpLinkedWarehouseId));
    try {
      localStorage.setItem(STOCK_WAREHOUSE_LS, String(mpLinkedWarehouseId));
    } catch {
      /* ignore */
    }
  }, [mpLinkedWarehouseId, stockWarehouseId]);

  const buildListParams = useCallback(
    (extra = {}) => {
      const search = (extra.search !== undefined ? extra.search : filterSearchDebounced).trim();
      const productType = extra.productType !== undefined ? extra.productType : filterProductType;
      const brandId = extra.brandId !== undefined ? extra.brandId : filterBrandId;
      const supplierId = extra.supplierId !== undefined ? extra.supplierId : filterSupplierId;
      const {
        page: _page,
        silent: _silent,
        limit: _limit,
        offset: _offset,
        inStockOnly: inStockFlag,
        reservedOnly: reservedFlag,
        availableOnly: availableFlag,
        ...rest
      } = extra;
      const wantInStock =
        inStockFlag === true || (inStockFlag !== false && filterInStockOnly);
      const wantReserved =
        reservedFlag === true || (reservedFlag !== false && filterReservedOnly);
      const wantAvailable =
        availableFlag === true || (availableFlag !== false && filterAvailableOnly);
      return {
        ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
        ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(supplierBindingEnabled && supplierId ? { supplierId } : {}),
        ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {}),
        ...(productType ? { productType } : {}),
        ...(search ? { search } : {}),
        ...rest,
        ...(wantInStock ? { inStockOnly: true } : {}),
        ...(wantReserved ? { reservedOnly: true } : {}),
        ...(wantAvailable ? { availableOnly: true } : {})
      };
    },
    [
      filterOrganizationId,
      filterCategoryId,
      filterBrandId,
      filterSupplierId,
      stockWarehouseId,
      filterProductType,
      filterSearchDebounced,
      filterInStockOnly,
      filterReservedOnly,
      filterAvailableOnly,
      supplierBindingEnabled,
    ]
  );

  const loadStockList = useCallback(
    (partial = {}) => {
      const page = partial.page !== undefined ? partial.page : currentPage;
      const limitCandidate = partial.limit !== undefined ? Number(partial.limit) : pageSize;
      const limit = STOCK_LIST_PAGE_SIZES.includes(limitCandidate) ? limitCandidate : 50;
      const silent = partial.silent === true;
      const listParams = buildListParams(partial);
      const wantInStock =
        partial.inStockOnly === true ||
        (partial.inStockOnly !== false && filterInStockOnly);
      const wantReserved =
        partial.reservedOnly === true ||
        (partial.reservedOnly !== false && filterReservedOnly);
      const wantAvailable =
        partial.availableOnly === true ||
        (partial.availableOnly !== false && filterAvailableOnly);
      return loadProducts({
        ...listParams,
        ...(wantInStock ? { inStockOnly: true } : {}),
        ...(wantReserved ? { reservedOnly: true } : {}),
        ...(wantAvailable ? { availableOnly: true } : {}),
        page,
        limit,
        offset: Math.max(0, (page - 1) * limit),
        stockList: true,
        silent
      });
    },
    [
      currentPage,
      pageSize,
      buildListParams,
      loadProducts,
      filterInStockOnly,
      filterReservedOnly,
      filterAvailableOnly
    ]
  );

  loadListRef.current = loadStockList;

  const totalProducts = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : products.length;
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalProducts) / Math.max(1, pageSize)));
  const pageOffset = meta?.offset ?? Math.max(0, currentPage - 1) * pageSize;
  const pageFrom = totalProducts > 0 ? pageOffset + 1 : 0;
  const pageTo = totalProducts > 0 ? Math.min(pageOffset + products.length, totalProducts) : 0;

  const goToPage = useCallback(
    (page) => {
      const next = Math.min(Math.max(1, page), totalPages);
      setCurrentPage(next);
      loadListRef.current({ page: next, silent: true });
    },
    [totalPages]
  );

  const handlePageSizeChange = (e) => {
    const next = parseInt(e.target.value, 10);
    if (!STOCK_LIST_PAGE_SIZES.includes(next)) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STOCK_LIST_PAGE_SIZE_LS, String(next));
      }
    } catch {
      /* ignore */
    }
    setPageSize(next);
    setCurrentPage(1);
    loadListRef.current({ page: 1, limit: next, silent: true });
  };

  const applyFilters = () => {
    const search = filterSearch.trim();
    setFilterSearchDebounced(search);
    setCurrentPage(1);
    loadStockList({ search, page: 1, silent: false });
  };

  useEffect(() => {
    const t = setTimeout(() => setFilterSearchDebounced(filterSearch.trim()), 400);
    return () => clearTimeout(t);
  }, [filterSearch]);

  useEffect(() => {
    const isFirstLoad = !listBootstrappedRef.current;
    if (isFirstLoad) {
      listBootstrappedRef.current = true;
    } else {
      setCurrentPage(1);
    }
    loadListRef.current({
      page: 1,
      inStockOnly: filterInStockOnly,
      reservedOnly: filterReservedOnly,
      availableOnly: filterAvailableOnly,
      brandId: filterBrandId || undefined,
      supplierId: supplierBindingEnabled ? filterSupplierId || undefined : undefined,
      silent: !isFirstLoad
    });
  }, [
    filterSearchDebounced,
    filterProductType,
    filterInStockOnly,
    filterReservedOnly,
    filterAvailableOnly,
    filterBrandId,
    filterSupplierId,
    filterCategoryId,
    filterOrganizationId,
    stockWarehouseId,
    supplierBindingEnabled,
  ]);

  useEffect(() => {
    const rows = meta?.supplierBreakdown;
    if (!Array.isArray(rows)) return;
    setSupplierBreakdownByProductId(buildSupplierBreakdownMap(rows));
  }, [meta?.supplierBreakdown]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages, pageSize]);

  /** ID товаров в текущей таблице (уже с учётом фильтров списка). */
  const refreshMpStockPushStatus = useCallback(async () => {
    try {
      const status = await marketplaceStockApi.getSyncStatus();
      if (status?.inProgress) {
        setMpStockPushBanner(
          status.lastStartedAt
            ? `Идёт отправка остатков на МП (с ${new Date(status.lastStartedAt).toLocaleString('ru-RU')})…`
            : 'Идёт отправка остатков на МП…'
        );
        return status;
      }
      if (status?.lastFinishedAt && status?.lastResult) {
        const r = status.lastResult;
        const finishedMs = new Date(status.lastFinishedAt).getTime();
        if (Number.isFinite(finishedMs) && Date.now() - finishedMs < 30 * 60 * 1000) {
          const err = status.lastError ? ` Ошибка: ${status.lastError}` : '';
          setMpStockPushBanner(
            `Последняя отправка на МП: успешно ${r.pushed ?? 0}, пропущено ${r.skipped ?? 0}, ошибок ${r.failed ?? 0}.${err}`
          );
          return status;
        }
      }
      setMpStockPushBanner(null);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    refreshMpStockPushStatus();
    const t = setInterval(refreshMpStockPushStatus, 15000);
    return () => clearInterval(t);
  }, [refreshMpStockPushStatus]);

  useEffect(() => {
    let cancelled = false;
    marketplaceStockApi
      .getSyncStatus()
      .then((st) => {
        if (cancelled) return;
        if (!st?.inProgress) setMpStockSyncing(false);
      })
      .catch(() => {
        if (!cancelled) setMpStockSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tableProductIdsForMpPush = useMemo(() => {
    if (!Array.isArray(products) || products.length === 0) return [];
    const ids = products
      .map((p) => p?.id)
      .filter((id) => id != null && id !== '')
      .map((id) => {
        const n = Number(id);
        return Number.isFinite(n) && n > 0 ? n : String(id).trim();
      })
      .filter((id) => (typeof id === 'number' && id > 0) || (typeof id === 'string' && id.length > 0));
    return [...new Set(ids)];
  }, [products]);

  const mpPushBlockReason = useMemo(() => {
    if (!filterOrganizationId) {
      return 'Выберите организацию в фильтре (не «Все») — остатки уходят в кабинет этой организации.';
    }
    if (!mpLinkedWarehouseId) {
      return 'Нет привязки складов ERP ↔ маркетплейсы. Настройте в разделе «Склады».';
    }
    if (tableProductIdsForMpPush.length === 0) {
      return 'В таблице нет товаров для отправки. Измените фильтры или нажмите «Обновить склад».';
    }
    return null;
  }, [filterOrganizationId, mpLinkedWarehouseId, tableProductIdsForMpPush.length]);

  const buildMpPushFilterHint = useCallback(() => {
    const filterParts = [];
    if (filterCategoryId) {
      const cat = categories.find((c) => String(c.id) === String(filterCategoryId));
      filterParts.push(`категория: ${cat?.name || filterCategoryId}`);
    }
    if (filterProductType) {
      filterParts.push(`тип: ${filterProductType === 'kit' ? 'комплект' : 'товар'}`);
    }
    if (filterSearchDebounced) filterParts.push(`поиск: «${filterSearchDebounced}»`);
    if (filterBrandId) {
      const brand = brands.find((b) => String(b.id) === String(filterBrandId));
      filterParts.push(`бренд: ${brand?.name || filterBrandId}`);
    }
    if (supplierBindingEnabled && filterSupplierId) {
      const sup = (suppliers || []).find((s) => String(s.id) === String(filterSupplierId));
      filterParts.push(`поставщик: ${sup?.name || filterSupplierId}`);
    }
    if (filterInStockOnly) filterParts.push('наличие');
    if (filterReservedOnly) filterParts.push('резерв');
    if (filterAvailableOnly) filterParts.push('доступно');
    return filterParts.length > 0 ? filterParts.join('; ') : '';
  }, [
    filterCategoryId,
    filterProductType,
    filterSearchDebounced,
    filterBrandId,
    filterInStockOnly,
    filterReservedOnly,
    filterAvailableOnly,
    categories,
    brands
  ]);

  const formatMpPushResultDetails = useCallback((data) => {
    const pushed = data?.pushed ?? 0;
    const failed = data?.failed ?? 0;
    const skipped = data?.skipped ?? 0;
    if (data?.skipped && data?.reason === 'skip_marketplace_stock_sync') {
      return 'Отправка отключена в настройках организации или категории товара.';
    }
    const total = data?.productsTotal;
    let details = `Успешно обновлено на МП: ${pushed}\nПропущено: ${skipped}\nОшибок: ${failed}`;
    if (total != null) details += `\nПозиций в отправке: ${total}`;
    if (data?.message) details += `\n\n${data.message}`;
    if (data?.skipReasonsText) details += `\n\nПричины пропуска:\n${data.skipReasonsText}`;
    const failSamples = (data?.results || [])
      .flatMap((row) => row?.results || [])
      .filter((r) => r && r.ok === false && !r.skipped && r.error)
      .slice(0, 5)
      .map((r) => `${r.marketplace}: ${r.error}`);
    if (failSamples.length > 0) {
      details += `\n\nОшибки API:\n${failSamples.join('\n')}`;
      if (failSamples.some((line) => /429|rate limit|too many requests/i.test(line))) {
        details +=
          '\n\nЛимит запросов маркетплейса (429). Подождите 15–30 секунд и отправьте снова — повтор уже выполняется автоматически.';
      }
    }
    else if (pushed === 0 && failed === 0 && skipped === 0 && (data?.noMappings ?? 0) > 0) {
      details +=
        '\n\nНи у одного товара нет сопоставления вашего склада с складами Ozon / WB / Яндекс. Проверьте раздел «Склады».';
    } else if (pushed === 0 && failed === 0 && skipped > 0) {
      details +=
        '\n\nТовары в таблице есть, но отправка не выполнена (нет SKU на МП, API-ключей или сопоставления складов).';
    }
    return details;
  }, []);

  const runMpStockPush = useCallback(
    async (force = false) => {
      setMpStockSyncing(true);
      setMpPushPanel({ type: 'working' });
      try {
        const res = await marketplaceStockApi.syncBulk({
          organizationId: filterOrganizationId,
          productIds: tableProductIdsForMpPush,
          warehouseId: mpLinkedWarehouseId,
          warehouseScoped: true,
          force
        });
        const data = res?.data ?? res;
        if (res?.status === 202) {
          await refreshMpStockPushStatus();
          setMpPushPanel({
            type: 'result',
            title: 'Отправка в фоне',
            details:
              data?.message ||
              `Отправка запущена (~${data?.productsTotal ?? tableProductIdsForMpPush.length} поз.). Статус обновится на странице; до 50 позиций результат показывается сразу.`
          });
          return;
        }
        if (data?.inProgress && data?.started === false) {
          setMpPushPanel({
            type: 'error',
            message: data?.message || 'Отправка уже выполняется. Подождите или запустите повторно.'
          });
          return;
        }
        await refreshMpStockPushStatus();
        setMpPushPanel({
          type: 'result',
          title: 'Отправка завершена',
          details: formatMpPushResultDetails(data)
        });
      } catch (e) {
        setMpPushPanel({
          type: 'error',
          message: e.response?.data?.message || e.message || 'Не удалось отправить остатки'
        });
      } finally {
        setMpStockSyncing(false);
      }
    },
    [
      filterOrganizationId,
      tableProductIdsForMpPush,
      mpLinkedWarehouseId,
      refreshMpStockPushStatus,
      formatMpPushResultDetails
    ]
  );

  const handleMpPushButtonClick = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    try {
      if (mpPushBlockReason) {
        setMpPushPanel({ type: 'error', message: mpPushBlockReason });
        return;
      }
      const whLabel =
        mpLinkedWarehouse?.address || mpLinkedWarehouse?.name || `склад #${mpLinkedWarehouseId}`;
      const orgLabel =
        organizations.find((o) => String(o.id) === String(filterOrganizationId))?.name ||
        filterOrganizationId;
      const filterHint = buildMpPushFilterHint();
      setMpPushPanel({
        type: 'confirm',
        whLabel,
        orgLabel,
        count: tableProductIdsForMpPush.length,
        filterHint
      });
    } catch (err) {
      console.error('[MP Push] handleMpPushButtonClick:', err);
      setMpPushPanel({
        type: 'error',
        message: err?.message || 'Не удалось открыть диалог отправки'
      });
    }
  };

  const handleMpPushConfirm = async () => {
    try {
      const st = await marketplaceStockApi.getSyncStatus();
      if (st?.inProgress) {
        setMpPushPanel({ type: 'force', lastError: st.lastError || null });
        return;
      }
    } catch {
      // статус недоступен — продолжаем
    }
    await runMpStockPush(false);
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
        await loadStockList({ page: currentPage, silent: true });
      }
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось запустить обновление';
      window.alert(`Ошибка: ${msg}`);
    } finally {
      setSupplierStocksRefreshing(false);
    }
  };

  const handleOrganizationFilterChange = (e) => {
    setFilterOrganizationId(e.target.value);
    setCurrentPage(1);
  };

  const handleCategoryFilterChange = (e) => {
    setFilterCategoryId(e.target.value);
    setCurrentPage(1);
  };

  const handleProductTypeFilterChange = (e) => {
    setFilterProductType(e.target.value);
    setCurrentPage(1);
  };

  const handleBrandFilterChange = (e) => {
    setFilterBrandId(e.target.value);
    setCurrentPage(1);
  };

  const handleSupplierFilterChange = (e) => {
    setFilterSupplierId(e.target.value);
    setCurrentPage(1);
  };

  const handleStockToggleFilterChange = (key, lsKey, setter) => (e) => {
    const on = e.target.checked;
    setter(on);
    try {
      if (on) localStorage.setItem(lsKey, '1');
      else localStorage.removeItem(lsKey);
    } catch {
      /* ignore */
    }
    setCurrentPage(1);
    loadStockList({ [key]: on, page: 1, silent: false });
  };

  const handleInStockOnlyChange = handleStockToggleFilterChange(
    'inStockOnly',
    STOCK_IN_STOCK_ONLY_LS,
    setFilterInStockOnly
  );

  const handleReservedOnlyChange = handleStockToggleFilterChange(
    'reservedOnly',
    STOCK_RESERVED_ONLY_LS,
    setFilterReservedOnly
  );

  const handleAvailableOnlyChange = handleStockToggleFilterChange(
    'availableOnly',
    STOCK_AVAILABLE_ONLY_LS,
    setFilterAvailableOnly
  );

  const ownWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId
      ),
    [warehouses]
  );

  /** Сброс устаревшего склада из localStorage (удалённый или склад поставщика). */
  useEffect(() => {
    if (warehousesLoading || !stockWarehouseId) return;
    if (!ownWarehouses.some((w) => String(w.id) === String(stockWarehouseId))) {
      setStockWarehouseId('');
      try {
        localStorage.removeItem(STOCK_WAREHOUSE_LS);
      } catch {
        /* ignore */
      }
    }
  }, [stockWarehouseId, ownWarehouses, warehousesLoading]);

  const handleStockWarehouseChange = (e) => {
    const v = e.target.value;
    setStockWarehouseId(v);
    try {
      if (v) localStorage.setItem(STOCK_WAREHOUSE_LS, v);
      else localStorage.removeItem(STOCK_WAREHOUSE_LS);
    } catch {
      /* ignore */
    }
    setCurrentPage(1);
  };

  /** Подгрузка остатков по складу (инвентаризация); синхронизирует фильтр «Склад» в таблице. */
  const reloadProductsWithWarehouse = useCallback(
    (warehouseId) => {
      const w = warehouseId != null && warehouseId !== '' ? String(warehouseId) : '';
      const current = String(stockWarehouseId || '');
      if (w !== current) {
        setStockWarehouseId(w);
        try {
          if (w) localStorage.setItem(STOCK_WAREHOUSE_LS, w);
          else localStorage.removeItem(STOCK_WAREHOUSE_LS);
        } catch {
          /* ignore */
        }
        setCurrentPage(1);
        return;
      }
      loadStockList({ warehouseId: w || undefined, page: currentPage, silent: true });
    },
    [loadStockList, currentPage, stockWarehouseId]
  );

  useEffect(() => {
    if (!supplierSyncEnabled) {
      setSupplierBreakdownByProductId({});
      return undefined;
    }
    if (activeTab !== 'table' || !products.length) {
      if (!products.length) setSupplierBreakdownByProductId({});
      return undefined;
    }
    if (Array.isArray(meta?.supplierBreakdown)) {
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

    (async () => {
      try {
        const res = await supplierStocksApi.getBreakdown(ids, { mainWarehouseId });
        const rows = res?.data ?? (Array.isArray(res) ? res : []);
        if (cancelled) return;
        setSupplierBreakdownByProductId(buildSupplierBreakdownMap(Array.isArray(rows) ? rows : []));
      } catch {
        if (!cancelled) setSupplierBreakdownByProductId({});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [products, activeTab, stockWarehouseId, meta?.supplierBreakdown, supplierSyncEnabled]);

  useEffect(() => {
    if (!historyProduct) {
      setHistoryList([]);
      setHistoryNetReserved(null);
      setHistoryError(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    stockMovementsApi.getHistory(historyProduct.id, {
      limit: 100,
      warehouseId: stockWarehouseId || undefined
    })
      .then(res => {
        if (cancelled) return;
        const list = res?.data ?? (Array.isArray(res) ? res : []);
        const arr = Array.isArray(list) ? list : [];
        setHistoryList(arr);
        const net =
          res?.netReserved != null
            ? Number(res.netReserved)
            : res?.net_reserved != null
              ? Number(res.net_reserved)
              : null;
        setHistoryNetReserved(Number.isFinite(net) ? net : null);
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryList([]);
          setHistoryNetReserved(null);
          setHistoryError(
            err?.response?.data?.message ||
              (err?.code === 'ECONNABORTED'
                ? 'Превышено время ожидания ответа сервера'
                : err?.message) ||
              'Не удалось загрузить историю'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [historyProduct, currentPage, stockWarehouseId]);

  const displayHistoryRows = useMemo(() => {
    const visible = historyList.filter(
      (m) =>
        !isHiddenStockHistoryMovement(m) &&
        isKitStockHistoryMovement(m, historyProduct)
    );
    return buildHistoryDisplayRows(visible);
  }, [historyList, historyProduct]);

  const historyDisplaySnapshots = useMemo(
    () =>
      buildHistoryDisplaySnapshots(
        displayHistoryRows,
        historyNetReserved,
        stockWarehouseId,
        historyProduct
      ),
    [displayHistoryRows, historyNetReserved, stockWarehouseId, historyProduct]
  );

  const openReserveModalForProduct = useCallback((product, { pinnedList = null } = {}) => {
    if (!product?.id) return;
    setReserveModalProduct(product);
    setReserveListOverride(pinnedList);
    setReserveError(null);
    setReserveModalOpen(true);
  }, []);

  const closeReserveModal = useCallback(() => {
    setReserveModalOpen(false);
    setReserveListOverride(null);
    setReserveModalProduct(null);
    setReserveSummary(null);
    setReserveError(null);
    setReserveUnreserveKey(null);
  }, []);

  const openStockResetModal = useCallback((row) => {
    if (!row?.product?.id) return;
    setStockResetProduct(row.product);
    setStockResetForm({
      incoming: Number(row.incoming) || 0,
      onHand: Number(row.onHand) || 0,
      reserved: Number(row.reserved) || 0,
    });
    setStockResetError('');
    setStockResetOpen(true);
  }, []);

  const openStockResetFromHistory = useCallback(() => {
    if (!historyProduct?.id) return;
    const incoming =
      Number(historyProduct.incoming_quantity ?? historyProduct.incomingQuantity) || 0;
    const onHand = Number(historyProduct.quantity) || 0;
    const reserved =
      historyNetReserved != null
        ? Number(historyNetReserved) || 0
        : Number(
            historyProduct.net_reserved_quantity ??
              historyProduct.reserved_quantity ??
              historyProduct.reservedQuantity
          ) || 0;
    setStockResetProduct(historyProduct);
    setStockResetForm({ incoming, onHand, reserved });
    setStockResetError('');
    setStockResetOpen(true);
  }, [historyProduct, historyNetReserved]);

  const closeStockResetModal = useCallback(() => {
    setStockResetOpen(false);
    setStockResetProduct(null);
    setStockResetError('');
    setStockResetSaving(false);
  }, []);

  const submitStockReset = useCallback(async () => {
    if (!stockResetProduct?.id) return;
    if (!stockWarehouseId) {
      setStockResetError('Выберите склад в фильтре над таблицей');
      return;
    }
    setStockResetSaving(true);
    setStockResetError('');
    try {
      await stockMovementsApi.resetStockHistory(stockResetProduct.id, {
        warehouseId: stockWarehouseId,
        incoming: Math.max(0, Math.floor(Number(stockResetForm.incoming) || 0)),
        onHand: Math.max(0, Math.floor(Number(stockResetForm.onHand) || 0)),
        reserved: Math.max(0, Math.floor(Number(stockResetForm.reserved) || 0)),
      });
      closeStockResetModal();
      loadListRef.current?.({ page: currentPage, silent: true });
      if (historyProduct?.id === stockResetProduct.id) {
        setHistoryLoading(true);
        setHistoryError(null);
        try {
          const res = await stockMovementsApi.getHistory(stockResetProduct.id, {
            limit: 100,
            warehouseId: stockWarehouseId || undefined,
          });
          const list = res?.data ?? (Array.isArray(res) ? res : []);
          setHistoryList(Array.isArray(list) ? list : []);
          const net =
            res?.netReserved != null
              ? Number(res.netReserved)
              : res?.net_reserved != null
                ? Number(res.net_reserved)
                : null;
          setHistoryNetReserved(Number.isFinite(net) ? net : null);
        } catch (err) {
          setHistoryError(
            err?.response?.data?.message || err?.message || 'Не удалось обновить историю'
          );
        } finally {
          setHistoryLoading(false);
        }
      }
    } catch (err) {
      setStockResetError(err?.response?.data?.message || err?.message || 'Ошибка сброса');
    } finally {
      setStockResetSaving(false);
    }
  }, [
    stockResetProduct,
    stockWarehouseId,
    stockResetForm,
    historyProduct?.id,
    currentPage,
    closeStockResetModal,
  ]);

  const stockResetAvailablePreview = useMemo(
    () =>
      stockTableAvailable({
        onHand: Number(stockResetForm.onHand) || 0,
        incoming: Number(stockResetForm.incoming) || 0,
        reserved: Number(stockResetForm.reserved) || 0,
        suppliers: 0,
      }),
    [stockResetForm]
  );

  const reloadReserveOrdersList = useCallback(async () => {
    const pid = reserveModalProduct?.id;
    if (!pid) return [];
    const res = await stockMovementsApi.getReservedOrders(pid, {
      warehouseId: stockWarehouseId || undefined
    });
    const list = res?.data ?? res ?? [];
    const arr = Array.isArray(list) ? list : [];
    const fbo = Array.isArray(res?.fboSupplies) ? res.fboSupplies : [];
    setReserveOrders(arr);
    setReserveFboSupplies(fbo);
    setReserveSummary(res?.summary ?? null);
    return arr;
  }, [reserveModalProduct?.id, stockWarehouseId]);

  useEffect(() => {
    if (!reserveModalOpen || !reserveModalProduct?.id) {
      setReserveOrders([]);
      setReserveFboSupplies([]);
      setReserveSummary(null);
      return;
    }
    if (reserveListOverride != null) {
      setReserveLoading(false);
      return;
    }
    let cancelled = false;
    setReserveLoading(true);
    setReserveError(null);
    stockMovementsApi
      .getReservedOrders(reserveModalProduct.id, {
        warehouseId: stockWarehouseId || undefined
      })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res ?? [];
        setReserveOrders(Array.isArray(list) ? list : []);
        setReserveFboSupplies(Array.isArray(res?.fboSupplies) ? res.fboSupplies : []);
        setReserveSummary(res?.summary ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setReserveOrders([]);
          setReserveFboSupplies([]);
          setReserveSummary(null);
          setReserveError(
            err?.response?.data?.message ||
              (err?.code === 'ECONNABORTED'
                ? 'Превышено время ожидания ответа сервера'
                : err?.message) ||
              'Не удалось загрузить список заказов'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setReserveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reserveModalOpen, reserveListOverride, reserveModalProduct?.id, stockWarehouseId]);

  const handleUnreserveOrderFromStock = useCallback(
    async (orderRow) => {
      if (orderRow?.orderDbId == null) return;
      const key = orderRow.deletedOrderReserve
        ? `deleted-${orderRow.orderDbId}`
        : `${orderRow.marketplace || 'order'}|${orderRow.orderId || orderRow.orderDbId}`;
      setReserveUnreserveKey(key);
      setReserveError(null);
      try {
        const summary = await stockMovementsApi.releaseOrderReserve(
          reserveModalProduct.id,
          orderRow.orderDbId
        );
        if ((Number(summary?.releasedProductLines) || 0) === 0) {
          setReserveError(
            'Не удалось снять резерв: в журнале нет записей для снятия (обновите страницу)'
          );
          return;
        }
        await reloadReserveOrdersList();
        loadListRef.current?.({ page: currentPage, silent: true });
        if (historyProduct?.id === reserveModalProduct?.id) {
          stockMovementsApi
            .getHistory(historyProduct.id, {
              limit: 100,
              warehouseId: stockWarehouseId || undefined
            })
            .then((res) => {
            const list = res?.data ?? res ?? [];
            setHistoryList(Array.isArray(list) ? list : []);
          });
        }
      } catch (e) {
        setReserveError(e?.response?.data?.message || e?.message || 'Не удалось снять резерв');
      } finally {
        setReserveUnreserveKey(null);
      }
    },
    [reloadReserveOrdersList, currentPage, historyProduct?.id, reserveModalProduct?.id, stockWarehouseId]
  );

  const reserveModalTotalQty = useMemo(() => {
    if (reserveListOverride != null) {
      return reserveListOverride.reduce((s, o) => s + (Number(o.reservedQty) || 0), 0);
    }
    return reserveOrders.reduce((s, o) => s + (Number(o.reservedQty) || 0), 0);
  }, [reserveListOverride, reserveOrders]);

  const reserveJournalQty = useMemo(
    () => Math.max(0, Number(reserveSummary?.displayReservedQty) || 0),
    [reserveSummary?.displayReservedQty]
  );
  const reserveOrphanQty = useMemo(
    () => Math.max(0, Number(reserveSummary?.orphanJournalReserve) || 0),
    [reserveSummary?.orphanJournalReserve]
  );

  const handleReleaseOrphanReserveFromStock = useCallback(async () => {
    const pid = reserveModalProduct?.id;
    if (!pid || reserveBulkReleasing) return;
    const qty = reserveOrphanQty > 0 ? reserveOrphanQty : reserveJournalQty;
    if (qty <= 0) return;
    if (
      !window.confirm(
        `Снять лишний резерв в журнале (${qty} шт.)? Заказы и FBO не будут затронуты, если они есть в списке.`
      )
    ) {
      return;
    }
    setReserveBulkReleasing(true);
    setReserveError(null);
    try {
      await stockMovementsApi.releaseOrphanReserve(pid, {
        warehouseId: stockWarehouseId || undefined
      });
      await reloadReserveOrdersList();
      loadListRef.current?.({ page: currentPage, silent: true });
    } catch (e) {
      setReserveError(e?.response?.data?.message || e?.message || 'Не удалось снять резерв');
    } finally {
      setReserveBulkReleasing(false);
    }
  }, [
    reserveModalProduct?.id,
    reserveBulkReleasing,
    reserveOrphanQty,
    reserveJournalQty,
    reloadReserveOrdersList,
    currentPage,
    stockWarehouseId
  ]);

  const handleReleaseAllReservesFromStock = useCallback(async () => {
    const pid = reserveModalProduct?.id;
    if (!pid || reserveBulkReleasing) return;
    const confirmMsg = `Снять резерв по всем ${reserveOrders.length} заказам в списке (всего ${reserveModalTotalQty} шт.)?`;
    if (!window.confirm(confirmMsg)) {
      return;
    }
    setReserveBulkReleasing(true);
    setReserveError(null);
    try {
      await stockMovementsApi.releaseAllReserves(pid, {
        warehouseId: stockWarehouseId || undefined
      });
      await reloadReserveOrdersList();
      loadListRef.current?.({ page: currentPage, silent: true });
    } catch (e) {
      setReserveError(e?.response?.data?.message || e?.message || 'Не удалось снять резерв');
    } finally {
      setReserveBulkReleasing(false);
    }
  }, [
    reserveModalProduct?.id,
    reserveBulkReleasing,
    reserveOrders.length,
    reserveModalTotalQty,
    reloadReserveOrdersList,
    currentPage,
    stockWarehouseId
  ]);

  const selectedWarehouse = stockWarehouseId
    ? ownWarehouses.find((w) => String(w.id) === stockWarehouseId)
    : null;
  const mainWarehouseName = selectedWarehouse
    ? selectedWarehouse.address || selectedWarehouse.name || 'Склад'
    : 'Все склады (сумма)';

  const rows = useMemo(() => {
    const built = buildStockRowsWithKits(products, (product) => {
      const onHand = Number(product.quantity ?? 0) || 0;
      const incoming = Number(product.incoming_quantity ?? product.incomingQuantity ?? 0) || 0;
      const reservedRaw =
        product.net_reserved_quantity ??
        product.netReservedQuantity ??
        product.reserved_quantity ??
        product.reservedQuantity ??
        0;
      const reserved = Math.max(0, Number(reservedRaw) || 0);
      const allDetails = supplierSyncEnabled
        ? supplierBreakdownByProductId[String(product.id)] || []
        : [];
      const supplierDetails = supplierSyncEnabled
        ? enrichSupplierDetailsLabels(allDetails, warehouses, stockWarehouseId || null)
        : [];
      const suppliers = supplierSyncEnabled
        ? supplierDetails.reduce((s, d) => s + (Number(d.stock) || 0), 0)
        : 0;
      const available = stockTableAvailable({ onHand, incoming, reserved, suppliers });
      return { onHand, incoming, reserved, suppliers, supplierDetails, available };
    });
    // Все фильтры (категория, поиск, тип, «только в наличии») — на сервере по всему каталогу, не по строкам страницы.
    return built;
  }, [products, supplierBreakdownByProductId, warehouses, stockWarehouseId, supplierSyncEnabled]);

  const renderStockListPager = (placement) => {
    const idSuffix = placement === 'top' ? 'top' : 'bottom';
    return (
      <div
        className={`stock-levels-list-pager d-flex justify-content-between align-items-center flex-wrap gap-2 ${
          placement === 'top' ? 'stock-levels-list-pager-top' : 'stock-levels-list-pager-bottom'
        }`}
      >
        <div className="d-flex flex-wrap align-items-center gap-3 text-muted small">
          <span>
            {totalProducts > 0 ? (
              <>
                Показано <strong>{pageFrom}</strong>–<strong>{pageTo}</strong> из <strong>{totalProducts}</strong>
              </>
            ) : (
              <>Нет позиций</>
            )}
          </span>
          <span>
            Страница <strong>{currentPage}</strong> из <strong>{totalPages}</strong>
          </span>
          <label
            className="d-inline-flex align-items-center gap-2 mb-0"
            htmlFor={`stock-list-page-size-${idSuffix}`}
          >
            <span>На странице</span>
            <select
              id={`stock-list-page-size-${idSuffix}`}
              className="form-select form-select-sm stock-levels-filter-select"
              style={{ width: 'auto', minWidth: '4.5rem' }}
              value={pageSize}
              onChange={handlePageSizeChange}
              disabled={listRefreshing}
            >
              {STOCK_LIST_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {listRefreshing ? <span className="text-muted">Обновление…</span> : null}
        </div>
        <div className="d-flex gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1 || listRefreshing}
          >
            Назад
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages || listRefreshing}
          >
            Вперёд
          </Button>
        </div>
      </div>
    );
  };

  const showInitialLoader =
    (productsLoading && products.length === 0 && !listRefreshing) || warehousesLoading;
  if (showInitialLoader) {
    return <div className="loading">Загрузка остатков на складе...</div>;
  }
  if (productsError && products.length === 0) {
    return <div className="error">Ошибка загрузки товаров: {productsError}</div>;
  }
  if (warehousesError) {
    return <div className="error">Ошибка загрузки складов: {warehousesError}</div>;
  }

  return (
    <>
      {activeTab === 'table' && (
        <>
          <p className="stock-levels-description">
            Складской учёт: остатки, приёмка, перемещение между складами организации, списание и инвентаризация. Поиск товара — по штрихкоду, артикулу или названию.
          </p>
          {productsError && products.length > 0 ? (
            <div className="error" style={{ marginBottom: 12 }} role="alert">
              Не удалось обновить остатки: {productsError}
            </div>
          ) : null}
          <div className="stock-levels-filters">
            <label className="stock-levels-filter-label">
              <span>Склад:</span>
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
              <span>Бренд:</span>
              <select
                value={filterBrandId}
                onChange={handleBrandFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                {[...brands]
                  .filter((b) => b && b.name)
                  .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </label>
            {supplierBindingEnabled ? (
              <label className="stock-levels-filter-label">
                <span>Поставщик:</span>
                <select
                  value={filterSupplierId}
                  onChange={handleSupplierFilterChange}
                  className="stock-levels-filter-select"
                >
                  <option value="">Все</option>
                  {[...(suppliers || [])]
                    .filter((s) => s && s.name)
                    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
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
              <span>Тип:</span>
              <select
                value={filterProductType}
                onChange={handleProductTypeFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                <option value="product">Товар</option>
                {kitsEnabled ? <option value="kit">Комплект</option> : null}
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
            <div className="stock-levels-filters-toggles">
            <label className="stock-levels-filter-label stock-levels-filter-toggle">
              <span>Наличие:</span>
              <span className="form-check form-switch mb-0 stock-levels-filter-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="stock-filter-in-stock-only"
                  checked={filterInStockOnly}
                  onChange={handleInStockOnlyChange}
                  disabled={listRefreshing}
                  aria-label="Наличие"
                />
              </span>
            </label>
            <label className="stock-levels-filter-label stock-levels-filter-toggle">
              <span>Резерв:</span>
              <span className="form-check form-switch mb-0 stock-levels-filter-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="stock-filter-reserved-only"
                  checked={filterReservedOnly}
                  onChange={handleReservedOnlyChange}
                  disabled={listRefreshing}
                  aria-label="Резерв"
                />
              </span>
            </label>
            <label className="stock-levels-filter-label stock-levels-filter-toggle">
              <span>Доступно:</span>
              <span className="form-check form-switch mb-0 stock-levels-filter-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="stock-filter-available-only"
                  checked={filterAvailableOnly}
                  onChange={handleAvailableOnlyChange}
                  disabled={listRefreshing}
                  aria-label="Доступно"
                />
              </span>
            </label>
            </div>
          </div>
          {renderStockListPager('top')}
          <div
            className={`stock-levels-table-wrapper${listRefreshing ? ' stock-levels-table-wrapper-refreshing' : ''}`}
            style={{ marginTop: '16px', width: '100%' }}
          >
            <table className="stock-levels-table table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Товар</th>
                  <th>В пути</th>
                  <th>Наличие</th>
                  <th>Резерв</th>
                  {supplierSyncEnabled ? <th>Поставщики</th> : null}
                  <th>Доступно</th>
                  {allowStockHistoryReset ? <th style={{ width: 88 }}>Сброс</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.product.sku || row.product.id}
                    className="stock-levels-row-clickable"
                    onClick={onNavigationClick(() => setHistoryProduct(row.product), {
                      ignoreClosest:
                        'input, textarea, select, label, button, .supplier-stock-cell, .stock-levels-reserved-btn, .stock-manual-onhand-edit, .stock-history-reset-btn, [data-no-nav-click]',
                    })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setHistoryProduct(row.product)}
                  >
                    <td className="sku-cell">{row.product.sku || '—'}</td>
                    <td className="name-cell">{row.product.name || 'Без названия'}</td>
                    <td>
                      {row.incomingFromComponents > 0 ? (
                        <span
                          className="stock-main-value"
                          title={`В т.ч. ${row.incomingFromComponents} компл. из ожидания комплектующих на этом складе`}
                        >
                          {row.incoming}
                        </span>
                      ) : (
                        row.incoming
                      )}
                    </td>
                    <td className="main-warehouse-cell" onClick={(e) => e.stopPropagation()}>
                      {allowManualStockEdit ? (
                        <ManualOnHandCell
                          productId={row.product.id}
                          currentOnHand={row.onHand}
                          warehouseId={stockWarehouseId}
                          disabledReason={manualOnHandBlockedReason}
                          onSaved={() => loadListRef.current?.({ page: currentPage, silent: true })}
                        />
                      ) : (
                        <span
                          className="stock-manual-onhand-readonly"
                          title="Включите «Ручное изменение наличия на складе» в настройках аккаунта"
                        >
                          {row.onHand}
                        </span>
                      )}
                    </td>
                    <td className="stock-levels-reserved-cell" onClick={(e) => e.stopPropagation()}>
                      {row.reserved > 0 ? (
                        <button
                          type="button"
                          className="stock-levels-reserved-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            openReserveModalForProduct(row.product);
                          }}
                          title="Заказы с резервом и снятие резерва"
                        >
                          {row.reserved}
                        </button>
                      ) : (
                        row.reserved
                      )}
                    </td>
                    {supplierSyncEnabled ? (
                      <td className="supplier-stock-cell" onClick={(e) => e.stopPropagation()}>
                        {row.suppliersDisplay ? (
                          <span
                            className="stock-main-value"
                            title="Сколько комплектов можно собрать из остатков поставщиков по комплектующим"
                          >
                            {row.suppliersDisplay}
                          </span>
                        ) : (
                          <SupplierStockCell total={row.suppliers} details={row.supplierDetails} />
                        )}
                      </td>
                    ) : null}
                    <td
                      title={
                        isKitProduct(row.product)
                          ? row.availableDisplay
                            ? `Доступно ${row.availableDisplay}: слева — целые комплекты к продаже; в скобках — целые + собираемость из комплектующих (на МП).`
                            : 'Слева — доступно с резервом; в скобках — целые комплекты + собираемость (на маркетплейсы).'
                          : undefined
                      }
                    >
                      {row.availableDisplay ?? row.available}
                    </td>
                    {allowStockHistoryReset ? (
                      <td className="stock-history-reset-cell" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="stock-history-reset-btn"
                          title="Очистить историю и задать текущие остатки"
                          onClick={() => openStockResetModal(row)}
                        >
                          ⟲
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderStockListPager('bottom')}

          <p className="stock-levels-history-hint">
            Нажмите на строку — история остатков; на число в колонке «Резерв» — заказы с резервом и снятие резерва.
            {allowManualStockEdit ? (
              <>
                {' '}
                В колонке «Наличие» задайте количество и нажмите ✓ — нужен выбранный склад в фильтре и включённая настройка в аккаунте.
              </>
            ) : (
              <>
                {' '}
                Ручное изменение «Наличия» отключено — включите в настройках аккаунта.
              </>
            )}
            {allowStockHistoryReset ? (
              <>
                {' '}
                Кнопка «⟲» очищает историю движений по товару и задаёт текущие «В пути», «Наличие» и «Резерв» (нужен выбранный склад).
              </>
            ) : null}
          </p>

          {mpStockPushBanner ? (
            <div className="alert alert-info py-2 mt-3" role="status">
              {mpStockPushBanner}
            </div>
          ) : null}

          {mpPushPanel ? (
            <div className="stock-levels-mp-push-panel" role="dialog" aria-label="Отправка на маркетплейсы">
              <div className="stock-levels-mp-push-panel-header">
                <strong>
                  {mpPushPanel.type === 'confirm'
                    ? 'Отправка на маркетплейсы'
                    : mpPushPanel.type === 'force'
                      ? 'Повторная отправка'
                      : mpPushPanel.type === 'working'
                        ? 'Отправка…'
                        : mpPushPanel.type === 'result'
                          ? mpPushPanel.title || 'Результат'
                          : 'Отправка на маркетплейсы'}
                </strong>
                {mpPushPanel.type !== 'working' ? (
                  <button
                    type="button"
                    className="btn-close"
                    aria-label="Закрыть"
                    onClick={() => setMpPushPanel(null)}
                  />
                ) : null}
              </div>
              {mpPushPanel.type === 'error' ? <p className="mb-0">{mpPushPanel.message}</p> : null}
              {mpPushPanel.type === 'confirm' ? (
                <>
                  <p className="mb-2">
                    Отправить остатки («Доступно») на маркетплейсы со склада «{mpPushPanel.whLabel}»?
                    <br />
                    <span className="text-muted small">
                      Только остаток этого склада ERP (с привязкой к Ozon / WB / Яндекс), не с других складов.
                    </span>
                  </p>
                  <p className="mb-2 text-muted small">
                    Позиций в таблице: <strong>{mpPushPanel.count}</strong> (организация «{mpPushPanel.orgLabel}»).
                    {mpPushPanel.filterHint ? (
                      <>
                        <br />
                        Фильтры: {mpPushPanel.filterHint}.
                      </>
                    ) : null}
                  </p>
                  <p className="mb-0 text-muted small">Позиции без связи с МП или без SKU будут пропущены.</p>
                  <div className="d-flex justify-content-end gap-2 mt-3">
                    <Button variant="secondary" onClick={() => setMpPushPanel(null)}>
                      Отмена
                    </Button>
                    <Button variant="primary" onClick={() => void handleMpPushConfirm()} disabled={mpStockSyncing}>
                      Отправить
                    </Button>
                  </div>
                </>
              ) : null}
              {mpPushPanel.type === 'force' ? (
                <>
                  <p className="mb-0">
                    {mpPushPanel.lastError
                      ? `Предыдущая отправка ещё активна. Ошибка: ${mpPushPanel.lastError}`
                      : 'Отправка остатков на МП уже выполняется.'}
                  </p>
                  <p className="mt-2 mb-0">Запустить повторно? Зависшая задача будет сброшена.</p>
                  <div className="d-flex justify-content-end gap-2 mt-3">
                    <Button variant="secondary" onClick={() => setMpPushPanel(null)}>
                      Отмена
                    </Button>
                    <Button variant="primary" onClick={() => void runMpStockPush(true)} disabled={mpStockSyncing}>
                      Запустить снова
                    </Button>
                  </div>
                </>
              ) : null}
              {mpPushPanel.type === 'working' ? (
                <p className="mb-0">Идёт отправка остатков на маркетплейсы, подождите…</p>
              ) : null}
              {mpPushPanel.type === 'result' ? (
                <>
                  <pre className="mb-0 stock-levels-mp-push-pre">{mpPushPanel.details}</pre>
                  <div className="d-flex justify-content-end mt-3">
                    <Button variant="primary" onClick={() => setMpPushPanel(null)}>
                      OK
                    </Button>
                  </div>
                </>
              ) : null}
              {mpPushPanel.type === 'error' ? (
                <div className="d-flex justify-content-end mt-3">
                  <Button variant="primary" onClick={() => setMpPushPanel(null)}>
                    OK
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="actions" style={{ marginTop: '16px' }}>
            <Button variant="secondary" onClick={applyFilters} disabled={supplierStocksRefreshing || mpStockSyncing}>
              Обновить склад
            </Button>
            {supplierSyncEnabled ? (
              <Button
                variant="primary"
                onClick={handleRefreshWarehouseAndSupplierStocks}
                disabled={supplierStocksRefreshing || mpStockSyncing || productsLoading}
                style={{ marginLeft: 8 }}
              >
                {supplierStocksRefreshing ? 'Обновление поставщиков…' : 'Обновить остатки поставщиков'}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={handleMpPushButtonClick}
              disabled={supplierStocksRefreshing}
              style={{ marginLeft: 8 }}
              title={
                mpLinkedWarehouse
                  ? `Отправить «Доступно» со склада «${mpLinkedWarehouse.address || mpLinkedWarehouseId}» (привязан к МП) на Ozon, WB и Яндекс`
                  : 'Отправить остатки со склада ERP, привязанного к маркетплейсам'
              }
            >
              {mpStockSyncing ? 'Отправка на МП…' : 'Отправить на маркетплейсы'}
            </Button>
          </div>
          {mpPushBlockReason ? (
            <p className="text-warning small mt-2 mb-0" role="status">
              {mpPushBlockReason}
            </p>
          ) : null}
        </>
      )}

      <WarehouseOperations
        products={products}
        mainWarehouseName={mainWarehouseName}
        defaultOrganizationId={filterOrganizationId || ''}
        inventoryWarehouseId={stockWarehouseId || ''}
        reloadProductsWithWarehouse={reloadProductsWithWarehouse}
        onRefresh={() => loadStockList({ page: currentPage, silent: true })}
        loading={productsLoading}
        activeTab={activeTab}
        onTabChange={handleWarehouseTabChange}
        openReceiptId={location.state?.openReceiptId}
        hideTabs
      />

      <Modal
        isOpen={!!historyProduct}
        onClose={() => {
          setHistoryProduct(null);
          closeReserveModal();
        }}
        title={
          historyProduct
            ? `История остатков: ${historyProduct.name || historyProduct.sku || '—'}${
                stockWarehouseId ? ` · ${mainWarehouseName}` : ''
              }`
            : 'История остатков'
        }
        size="large"
      >
        {allowStockHistoryReset && historyProduct ? (
          <div className="stock-history-reset-toolbar">
            <Button
              type="button"
              variant="outline-danger"
              size="small"
              onClick={openStockResetFromHistory}
            >
              Сбросить историю и задать остатки
            </Button>
            {!stockWarehouseId ? (
              <span className="text-muted small">
                Для сброса выберите склад в фильтре над таблицей.
              </span>
            ) : isKitProduct(historyProduct) ? (
              <span className="text-muted small">
                Для комплекта также снимается резерв комплектующих, привязанный к этому SKU.
              </span>
            ) : null}
          </div>
        ) : historyProduct && canManageAccountStockReset && !stockResetSettingOn ? (
          <p className="text-muted small mb-2">
            Сброс истории отключён. Включите «Сброс истории остатков по товару» в{' '}
            <Link to="/settings">настройках аккаунта</Link> (нужны права администратора).
          </p>
        ) : null}
        {historyLoading ? (
          <div className="loading">Загрузка истории…</div>
        ) : historyError ? (
          <p className="text-danger mb-0" role="alert">
            {historyError}
          </p>
        ) : historyList.length === 0 ? (
          <p className="stock-levels-history-empty">Нет записей об изменениях остатков.</p>
        ) : (
          <>
            {stockWarehouseId ? (
              <p className="text-muted small mb-2" role="status">
                {isKitProduct(historyProduct) ? (
                  <>
                    Колонка «В пути» — целые комплекты в ожидании + комплекты, собираемые из ожидания
                    комплектующих. «Доступно» — как в таблице остатков (без двойного учёта).
                  </>
                ) : (
                  <>Колонка «Наличие» — по выбранному складу в фильтре таблицы (не сумма по всем складам).</>
                )}
              </p>
            ) : null}
            {historyNetReserved != null && (
              <p className="stock-levels-history-net-reserved text-muted small" style={{ marginBottom: 8 }}>
                Сейчас в резерве по журналу: <strong>{historyNetReserved}</strong>
                {historyNetReserved !== (Number(historyProduct?.reserved_quantity ?? historyProduct?.reservedQuantity) || 0)
                  ? ' (таблица остатков обновлена)'
                  : ''}
              </p>
            )}
          <div className="stock-levels-history-table-wrap">
            <table className="stock-levels-table table stock-levels-history-table">
              <colgroup>
                <col className="stock-levels-history-col-date" />
                <col className="stock-levels-history-col-reason" />
                <col className="stock-levels-history-col-qty" />
                <col className="stock-levels-history-col-qty" />
                <col className="stock-levels-history-col-qty" />
                <col className="stock-levels-history-col-qty" />
              </colgroup>
              <thead>
                <tr>
                  <th>Дата и время</th>
                  <th>Причина</th>
                  <th>В пути</th>
                  <th className="stock-levels-history-col-onhand">Наличие</th>
                  <th>Резерв</th>
                  <th>Доступно</th>
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
                  const availCell = formatAvailableHistoryCell(cur, prev);

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
                        <td>{renderStockHistoryQtyCell(balCell)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openReserveModalForProduct(historyProduct);
                            }}
                            title="Заказы с резервом этого товара (текущее состояние)"
                          >
                            {renderStockHistoryQtyCell(resCell)}
                          </button>
                        </td>
                        <td>{renderStockHistoryQtyCell(availCell)}</td>
                      </tr>
                    );
                  }

                  if (item.kind === 'reserveGroup' || item.kind === 'unreserveGroup') {
                    const orderIds = item.movements
                      .map((x) => extractOrderIdFromReserveMovement(x))
                      .filter(Boolean);
                    const reasonText =
                      item.kind === 'unreserveGroup'
                        ? `Снятие резерва (${orderIds.length} зак.): ${orderIds.join(', ')}`.slice(
                            0,
                            HISTORY_REASON_MAX_LEN
                          )
                        : truncateReserveReason(orderIds);
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
                        onClick={onNavigationClick(() => {
                          openReserveModalForProduct(historyProduct, { pinnedList: pinned });
                        })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            openReserveModalForProduct(historyProduct, { pinnedList: pinned });
                          }
                        }}
                      >
                        <td>{formatDateTime(createdAt)}</td>
                        <td>{reasonText}</td>
                        <td>{renderStockHistoryQtyCell(incCell)}</td>
                        <td>{renderStockHistoryQtyCell(balCell)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openReserveModalForProduct(historyProduct);
                            }}
                            title="Заказы с резервом этого товара (текущее состояние)"
                          >
                            {renderStockHistoryQtyCell(resCell)}
                          </button>
                        </td>
                        <td>{renderStockHistoryQtyCell(availCell)}</td>
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
                      <td>{renderStockHistoryQtyCell(balCell)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-link p-0 align-baseline text-decoration-none stock-levels-history-reserve-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openReserveModalForProduct(historyProduct);
                            }}
                            title="Заказы с резервом этого товара (текущее состояние)"
                          >
                            {renderStockHistoryQtyCell(resCell)}
                          </button>
                        </td>
                        <td>{renderStockHistoryQtyCell(availCell)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={reserveModalOpen}
        onClose={closeReserveModal}
        title={
          reserveModalProduct
            ? `Резерв: ${reserveModalProduct.name || reserveModalProduct.sku || '—'}`
            : 'Резерв под заказы'
        }
        size="medium"
      >
        {reserveListOverride != null ? (
          reserveListOverride.length === 0 ? (
            <p className="text-muted mb-0">В этой записи журнала не удалось извлечь номера заказов.</p>
          ) : (
            <>
              <p className="text-muted small mb-2">
                Заказы из выбранной записи журнала (снимок на момент операции, не текущее состояние).
              </p>
              <p className="mb-2">
                Всего в записи: <strong>{reserveModalTotalQty}</strong> шт.
              </p>
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
                        closeReserveModal();
                        setHistoryProduct(null);
                      }}
                    >
                      {o.marketplace} · {o.orderId}
                    </Link>
                    <span className="badge bg-secondary rounded-pill">{o.reservedQty} шт.</span>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : reserveLoading ? (
          <div className="loading">Загрузка…</div>
        ) : (
          <>
            {reserveOrders.length === 0 && reserveFboSupplies.length === 0 ? (
              reserveJournalQty > 0 ? (
                <>
                  <p className="text-warning small mb-2" role="status">
                    В журнале по выбранному складу: <strong>{reserveJournalQty}</strong> шт., но
                    заказы и поставки FBO не найдены
                    {reserveOrphanQty > 0 ? ` (лишний резерв: ${reserveOrphanQty} шт.)` : ''}.
                    {reserveSummary?.isKit && Number(reserveSummary?.componentJournalReserve) > 0
                      ? ' Резерв учтён по комплектующим — список заказов должен появиться ниже после обновления.'
                      : ' При открытии модалки лишний резерв снимается автоматически; если цифра не совпадает с колонкой «Резерв», нажмите кнопку ниже.'}
                  </p>
                  {reserveError && (
                    <p className="text-danger small mb-2" role="alert">
                      {reserveError}
                    </p>
                  )}
                  <div className="mb-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={reserveBulkReleasing}
                      onClick={handleReleaseOrphanReserveFromStock}
                    >
                      {reserveBulkReleasing
                        ? 'Снимаем резерв…'
                        : `Снять лишний резерв (${reserveOrphanQty > 0 ? reserveOrphanQty : reserveJournalQty} шт.)`}
                    </Button>
                  </div>
                </>
              ) : reserveSummary?.isKit && Number(reserveSummary?.componentJournalReserve) > 0 ? (
                <p className="text-muted mb-2">
                  Резерв по комплектующим: <strong>{reserveSummary.componentJournalReserve}</strong> шт.
                  в журнале (на SKU комплекта — 0). Откройте комплектующие в таблице остатков, чтобы
                  увидеть заказы с резервом.
                </p>
              ) : (
                <p className="text-muted mb-2">Нет активного резерва по заказам и поставкам FBO.</p>
              )
            ) : null}
            {reserveSummary?.isKit &&
              reserveOrders.length === 0 &&
              Number(reserveSummary.componentJournalReserve) > 0 && (
                <p className="text-muted small mb-2">
                  В журнале комплектующих: <strong>{reserveSummary.componentJournalReserve}</strong> шт.
                  (в колонке «Резерв» для комплекта учитывается только SKU комплекта).
                </p>
              )}
            {reserveFboSupplies.length > 0 ? (
              <>
                <p className="text-muted small mb-2 mt-1">
                  {stockWarehouseId
                    ? `Резерв под поставки FBO на складе «${mainWarehouseName}» (только этот склад):`
                    : 'Резерв под поставки FBO (колонка «Резерв» включает и заказы, и FBO):'}
                </p>
                <ul className="list-group mb-3">
                  {reserveFboSupplies.map((f) => (
                    <li
                      key={`fbo-${f.supplyId}-${f.supplyItemId}`}
                      className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"
                    >
                      {f.supplyId ? (
                        <Link
                          to={`/stock-levels/fbo-supplies/${f.supplyId}`}
                          className="stock-levels-history-link"
                          onClick={closeReserveModal}
                        >
                          {f.label || `FBO поставка №${f.supplyId}`}
                        </Link>
                      ) : (
                        <span>{f.label || 'FBO поставка'}</span>
                      )}
                      <span className="badge bg-secondary rounded-pill">{f.reservedQty} шт.</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {reserveOrphanQty > 0 &&
            (reserveOrders.length > 0 || reserveFboSupplies.length > 0) ? (
              <>
                <p className="text-warning small mb-2" role="status">
                  В журнале по выбранному складу есть лишний резерв:{' '}
                  <strong>{reserveOrphanQty}</strong> шт. сверх заказов и FBO. При открытии модалки
                  он снимается автоматически; если цифра не совпадает с колонкой «Резерв», нажмите
                  кнопку ниже.
                </p>
                <div className="mb-3">
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={reserveBulkReleasing}
                    onClick={handleReleaseOrphanReserveFromStock}
                  >
                    {reserveBulkReleasing
                      ? 'Снимаем резерв…'
                      : `Снять лишний резерв (${reserveOrphanQty} шт.)`}
                  </Button>
                </div>
              </>
            ) : null}
            {reserveOrders.length > 0 ? (
          <>
            <p className="text-muted small mb-2">
              Резерв по заказам маркетплейса: <strong>{reserveModalTotalQty}</strong> шт.,{' '}
              {reserveOrders.length} зак.
            </p>
            {reserveOrders.some((o) => o.staleReserve) && (
              <p className="text-warning small mb-2" role="status">
                Заказы «отгружен» / «отменён» не должны держать резерв — при открытии модалки он
                снимается автоматически. Если строка осталась, нажмите «Снять резерв».
              </p>
            )}
            {reserveError && (
              <p className="text-danger small mb-2" role="alert">
                {reserveError}
              </p>
            )}
            <div className="mb-3">
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={reserveBulkReleasing || Boolean(reserveUnreserveKey)}
                onClick={handleReleaseAllReservesFromStock}
              >
                {reserveBulkReleasing
                  ? 'Снимаем резерв…'
                  : `Снять весь резерв (${reserveModalTotalQty} шт.)`}
              </Button>
            </div>
            <ul className="list-group stock-levels-reserve-orders-list">
              {reserveOrders.map((o) => {
                const rowKey = `${o.orderDbId}-${o.orderId}`;
                const busy = o.deletedOrderReserve
                  ? reserveUnreserveKey === `deleted-${o.orderDbId}`
                  : reserveUnreserveKey === `${o.marketplace}|${o.orderId}`;
                return (
                  <li
                    key={rowKey}
                    className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"
                  >
                    <div className="d-flex flex-column gap-1">
                      {o.deletedOrderReserve ? (
                        <span className="text-warning">Резерв в журнале: {o.orderId}</span>
                      ) : (
                        <Link
                          to={`/orders/${o.marketplace}/${encodeURIComponent(o.orderId)}`}
                          className="stock-levels-history-link"
                          onClick={closeReserveModal}
                        >
                          {o.marketplace} · {o.orderId}
                        </Link>
                      )}
                      {o.status || o.statusLabel ? (
                        <span className={`small ${o.staleReserve ? 'text-warning' : 'text-muted'}`}>
                          {o.statusLabel || getOrderStatusLabel(o.status)}
                          {o.staleReserve ? ' · залипший резерв' : ''}
                        </span>
                      ) : null}
                    </div>
                    <div className="d-flex align-items-center gap-2 flex-shrink-0">
                      <span className="badge bg-secondary rounded-pill">{o.reservedQty} шт.</span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={Boolean(reserveUnreserveKey)}
                        onClick={() => handleUnreserveOrderFromStock(o)}
                      >
                        {busy ? '…' : 'Снять резерв'}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
            ) : null}
          </>
        )}
      </Modal>

      <Modal
        isOpen={stockResetOpen}
        onClose={closeStockResetModal}
        title={
          stockResetProduct
            ? `Сброс истории: ${stockResetProduct.name || stockResetProduct.sku || '—'}`
            : 'Сброс истории остатков'
        }
        size="small"
      >
        <p className="text-muted small">
          Будет удалена <strong>вся</strong> история движений по этому товару. Затем будут установлены указанные
          значения. Операция необратима.
        </p>
        {!stockWarehouseId ? (
          <p className="text-danger small">Выберите склад в фильтре «Склад (остаток)» над таблицей.</p>
        ) : (
          <p className="text-muted small mb-2">
            Склад:{' '}
            <strong>
              {ownWarehouses.find((w) => String(w.id) === String(stockWarehouseId))?.address ||
                ownWarehouses.find((w) => String(w.id) === String(stockWarehouseId))?.name ||
                `#${stockWarehouseId}`}
            </strong>
          </p>
        )}
        <div className="stock-history-reset-form">
          <label className="stock-history-reset-field">
            <span>В пути</span>
            <input
              type="number"
              min={0}
              step={1}
              className="form-control form-control-sm"
              value={stockResetForm.incoming}
              onChange={(e) =>
                setStockResetForm((f) => ({ ...f, incoming: e.target.value }))
              }
            />
          </label>
          <label className="stock-history-reset-field">
            <span>Наличие</span>
            <input
              type="number"
              min={0}
              step={1}
              className="form-control form-control-sm"
              value={stockResetForm.onHand}
              onChange={(e) =>
                setStockResetForm((f) => ({ ...f, onHand: e.target.value }))
              }
            />
          </label>
          <label className="stock-history-reset-field">
            <span>Резерв</span>
            <input
              type="number"
              min={0}
              step={1}
              className="form-control form-control-sm"
              value={stockResetForm.reserved}
              onChange={(e) =>
                setStockResetForm((f) => ({ ...f, reserved: e.target.value }))
              }
            />
          </label>
          <p className="mb-0 mt-2">
            Доступно: <strong>{stockResetAvailablePreview}</strong> шт.
          </p>
        </div>
        {stockResetError ? (
          <p className="text-danger small mt-2 mb-0">{stockResetError}</p>
        ) : null}
        <div className="d-flex gap-2 justify-content-end mt-3">
          <Button type="button" variant="secondary" onClick={closeStockResetModal} disabled={stockResetSaving}>
            Отмена
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void submitStockReset()}
            disabled={stockResetSaving || !stockWarehouseId}
          >
            {stockResetSaving ? 'Сохранение…' : 'Очистить и сохранить'}
          </Button>
        </div>
      </Modal>
    </>
  );
}

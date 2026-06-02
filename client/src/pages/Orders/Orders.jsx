/**
 * Orders Page
 * Страница управления заказами: выбор заказов и отправка на сборку
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOrders } from '../../hooks/useOrders';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useOrganizations } from '../../hooks/useOrganizations';
import { ordersApi } from '../../services/orders.api';
import { productsApi } from '../../services/products.api';
import { purchasesApi } from '../../services/purchases.api';
import { suppliersApi } from '../../services/suppliers.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import { formatProductOptionLabel } from '../../utils/productSearch';
import {
  getOrderStatusLabel,
  isOrderStatusEligibleForProcurement,
} from '../../constants/orderStatuses';
import { OrderDetailContent, OrderSummaryFromList } from './OrderDetail';
import { onNavigationClick } from '../../utils/navigationClick.js';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import {
  normalizeMarketplaceForUI,
  orderGroupKey,
  singleOrderListGroupKey,
  marketplaceOrderIdForApi
} from '../../utils/orderListGroupKey';
import {
  isAssemblyLikeStatus,
  orderStickerCellValue,
  shouldShowOrdersStickerColumn
} from '../../utils/orderStickerDisplay';
import {
  groupReserveCoverageKind,
  reserveBadgeClassName,
  formatOrderReserveBadgeTitle
} from '../../utils/orderReserveBadge.js';
import {
  buildProcurementEditableLines,
  productsMapFromStockList
} from '../../utils/procurementPreview.js';
import './Orders.css';
import './OrderDetail.css';

function buildOrdersSyncDoneMessage(lastStatus, { forceImport = false } = {}) {
  const r = lastStatus?.lastSyncResult;
  if (!r) return 'Синхронизация завершена. Список обновлён.';
  const oz = r.ozon?.success ?? 0;
  const wb = r.wildberries?.success ?? 0;
  const ym = r.yandex?.success ?? 0;
  const ymTail = r.yandex?.reason ? ` (${r.yandex.reason})` : '';
  if (forceImport) {
    return (
      `Импорт завершён: Ozon ${oz}, WB ${wb}, Яндекс ${ym}${ymTail}. ` +
      'Если заказ не виден во «Новых», откройте фильтр «Все» или другой статус.'
    );
  }
  return `Синхронизация завершена: Ozon ${oz}, WB ${wb}, Яндекс ${ym}${ymTail}.`;
}

function orderKey(o) {
  const mp = normalizeMarketplaceForUI(o.marketplace);
  return `${mp}|${o.orderId ?? ''}`;
}

function OrderQuantityWithReserve({
  qty,
  reservedQty,
  needQty,
  coverageKind,
  groupOrders,
  isGroup,
}) {
  const q = Number(qty);
  const displayQty = Number.isFinite(q) && q > 0 ? q : 1;
  const r = Number(reservedQty) || 0;
  const n = Number(needQty) || displayQty;
  if (r <= 0) {
    return <span className="orders-qty-value">{displayQty}</span>;
  }
  return (
    <span className="orders-qty-with-reserve">
      <span className="orders-qty-value">{displayQty}</span>
      <span
        className={reserveBadgeClassName(coverageKind)}
        title={formatOrderReserveBadgeTitle({
          reservedQty: r,
          needQty: n,
          orders: groupOrders,
          isGroup,
          coverageKind,
        })}
      >
        {r}/{n}
      </span>
    </span>
  );
}

/** Сообщение «на сборку», если поставка WB заведена только в ERM без ключа API */
function appendLocalWbOnlyAssemblyHint(msg, shipments) {
  if (!Array.isArray(shipments) || !shipments.some((s) => s.localWbOnly)) return msg;
  return `${msg} Wildberries: без ключа API поставка только в ERM; в личном кабинете WB не создаётся. Добавьте токен WB в «Интеграции» для привязки к МП.`.trim();
}

function appendAssemblyWarnings(msg, warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return msg;
  const parts = warnings
    .map((w) => {
      const mp = w?.marketplace ? String(w.marketplace) : 'mp';
      const m = w?.message ? String(w.message) : '';
      const failed = Array.isArray(w?.failedOrderIds) ? w.failedOrderIds.filter(Boolean).slice(0, 8).join(', ') : '';
      return `${mp}: ${m}${failed ? ` (не удалось: ${failed})` : ''}`.trim();
    })
    .filter(Boolean);
  if (parts.length === 0) return msg;
  return `${msg} Предупреждения МП: ${parts.join('; ')}`.trim();
}

function appendShipmentsPendingHint(msg, result) {
  if (!result?.shipmentsPending) return msg;
  return `${msg} Поставки на маркетплейсах создаются в фоне — обновите список заказов через 1–2 минуты.`.trim();
}

/**
 * Один запрос to-procurement на группу в БД: по сырому order_group_id, даже если UI не склеивает строки
 * (например, ненадёжный WB uid в orderGroupKey возвращает пустую строку).
 */
function procurementStatusUpdateDedupeKey(o) {
  if (!o) return '';
  const rawGid = o.orderGroupId ?? o.order_group_id;
  const gid = rawGid != null ? String(rawGid).trim() : '';
  if (gid !== '') {
    const mp = normalizeMarketplaceForUI(o.marketplace);
    return `procgrp|${mp}|${gid}`;
  }
  return orderKey(o);
}

/**
 * @param {Array<*>} orderPool — полный пул заказов для выбранных позиций (все страницы).
 * @param {Set<string>} selectedKeys
 */
function expandSelectedOrdersForBulkActions(orderPool, selectedKeys) {
  const toSend = [];
  const added = new Set();
  for (const o of orderPool) {
    if (!selectedKeys.has(orderKey(o))) continue;
    const gid = orderGroupKey(o);
    if (gid) {
      for (const g of orderPool) {
        if (orderGroupKey(g) !== gid) continue;
        const k = orderKey(g);
        if (!added.has(k)) {
          added.add(k);
          toSend.push(g);
        }
      }
    } else {
      const k = orderKey(o);
      if (!added.has(k)) {
        added.add(k);
        toSend.push(o);
      }
    }
  }
  return toSend;
}

/** По одному представителю на группу — для return-to-new / to-procurement в нашей БД */
function representativesForGroupScopedApi(toSend) {
  const byGid = new Map();
  const singles = [];
  for (const o of toSend) {
    const gid = orderGroupKey(o);
    if (gid) {
      if (!byGid.has(gid)) byGid.set(gid, o);
    } else {
      singles.push(o);
    }
  }
  return [...byGid.values(), ...singles];
}

/** Артикул для списка: внутренний SKU каталога, иначе offer_id / id на МП */
function orderArticleLabel(o) {
  if (!o) return '—';
  const v =
    o.productSku ??
    o.product_sku ??
    o.offerId ??
    o.offer_id ??
    (o.sku != null && o.sku !== '' ? String(o.sku) : null);
  const s = v != null ? String(v).trim() : '';
  return s !== '' ? s : '—';
}

const ARTICLE_SORT_LOCALE_OPTS = { sensitivity: 'base', numeric: true };

/**
 * Ключ сортировки группы заказов по артикулу: минимальный артикул среди позиций
 * (составной заказ упорядочивается по «раннему» коду в алфавите).
 */
function displayRowPrimaryArticleKey(row) {
  if (!row?.orders?.length) return null;
  const labels = row.orders.map(orderArticleLabel).filter((s) => s && s !== '—');
  if (labels.length === 0) return null;
  return [...labels].sort((a, b) => a.localeCompare(b, 'ru', ARTICLE_SORT_LOCALE_OPTS))[0];
}

function fmtPurchaseDraftLabel(p) {
  const dt =
    p?.created_at != null
      ? new Date(p.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
      : '';
  const sup = p?.supplier_name || 'без поставщика';
  const n = p?.items_count != null ? `${p.items_count} поз.` : '';
  return [dt, sup, n].filter(Boolean).join(' · ');
}

/** Форматирует время появления заказа на маркетплейсе (createdAt) для отображения в списке */
function formatMarketplaceDate(createdAt) {
  if (createdAt == null || createdAt === '') return '—';
  try {
    const d = new Date(createdAt);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '—';
  }
}

/** Отмена на МП + в ERM для этих МП и статусов (до отгрузки) */
function orderCanShowCancel(marketplace, status) {
  const mp = normalizeMarketplaceForUI(marketplace);
  if (!['wildberries', 'ozon', 'yandex', 'manual'].includes(mp)) return false;
  return ['new', 'in_procurement', 'in_assembly', 'assembled', 'wb_assembly'].includes(status);
}

function orderSupportsFbsShipment(marketplace) {
  const mp = normalizeMarketplaceForUI(marketplace);
  return ['wildberries', 'ozon', 'yandex'].includes(mp);
}

function orderCanAddToOpenShipment(first) {
  if (!first || first.status !== 'assembled') return false;
  if (first.localShipmentId || first.localShipmentName) return false;
  return orderSupportsFbsShipment(first.marketplace);
}

function orderRowHasAnyAction(first) {
  if (first.status === 'new') return true;
  if (orderCanShowCancel(first.marketplace, first.status)) return true;
  if (first.status === 'in_procurement') return true;
  if (first.status === 'in_assembly' || first.status === 'assembled') return true;
  if (orderCanAddToOpenShipment(first)) return true;
  if (first.marketplace === 'manual') return true;
  return false;
}

/** Состав строки списка для закупки: `orders: []` не скрывает позицию — берём first */
function ordersArrayForPurchaseRow(row) {
  if (!row) return [];
  if (Array.isArray(row.orders) && row.orders.length > 0) return row.orders;
  if (row.first) return [row.first];
  return [];
}

/** Сколько разных заказов на МП в выборке (по order_group_id / orderUid или по паре мп+order_id). */
function uniqueMarketplaceOrdersFromBulkRows(rows) {
  const keys = new Set();
  for (const r of rows || []) {
    for (const o of ordersArrayForPurchaseRow(r)) {
      const mp = normalizeMarketplaceForUI(o.marketplace);
      const g = orderGroupKey(o);
      if (g) {
        keys.add(`${mp}|g:${g}`);
        continue;
      }
      if (mp === 'yandex') {
        const oid = String(o.orderId ?? '').trim();
        const base = oid.includes(':') ? oid.slice(0, oid.indexOf(':')) : oid;
        keys.add(`${mp}|o:${base}`);
        continue;
      }
      keys.add(`${mp}|o:${String(o.orderId ?? '').trim()}`);
    }
  }
  return keys.size;
}

/** Сумма полей quantity по всем выбранным строкам заказов (физические единицы, а не число строк БД). */
function totalOrderUnitsFromBulkRows(rows) {
  let sum = 0;
  for (const r of rows || []) {
    for (const o of ordersArrayForPurchaseRow(r)) {
      const q = Number(o.quantity);
      sum += Number.isFinite(q) && q > 0 ? q : 1;
    }
  }
  return sum;
}

/** Позиции заказа для строки списка (группа или одна строка) → закупка */
function purchaseLinesFromDisplayRow(row) {
  const orders = ordersArrayForPurchaseRow(row);
  return orders.map((o) => {
    const rawId = o.productId ?? o.product_id;
    const n = rawId != null && rawId !== '' ? Number(rawId) : NaN;
    const q = Number(o.quantity);
    const quantity = Number.isFinite(q) && q > 0 ? q : 1;
    return {
      productId: Number.isInteger(n) && n >= 1 ? n : null,
      quantity,
      name: o.productName || o.product_name || '—',
      article: orderArticleLabel(o),
      sourceOrder: { marketplace: o.marketplace, orderId: String(o.orderId ?? '') },
    };
  });
}

/** Одна строка закупки на артикул / product_id: суммируем количество, склеиваем заказы-источники */
function mergePurchaseLinesByArticle(lines) {
  const map = new Map();
  const soKey = (x) => `${String(x.marketplace || '').toLowerCase()}|${String(x.orderId ?? '')}`;

  for (const l of lines) {
    const pid = l.productId != null ? Number(l.productId) : NaN;
    const hasPid = Number.isInteger(pid) && pid >= 1;
    const art = String(l.article || '').trim().toUpperCase();
    const groupKey = hasPid ? `p:${pid}` : `a:${art || '_'}`;

    const chunk =
      l.sourceOrder && l.sourceOrder.marketplace != null && l.sourceOrder.orderId != null
        ? [
            {
              marketplace: String(l.sourceOrder.marketplace).trim(),
              orderId: String(l.sourceOrder.orderId).trim(),
            },
          ]
        : [];

    let cur = map.get(groupKey);
    if (!cur) {
      cur = {
        productId: hasPid ? pid : l.productId,
        quantity: 0,
        name: l.name,
        article: l.article,
        sourceOrders: [],
        _soKeys: new Set(),
      };
      map.set(groupKey, cur);
    }
    cur.quantity += Number(l.quantity) > 0 ? Number(l.quantity) : 1;
    for (const c of chunk) {
      const k = soKey(c);
      if (!c.marketplace || !c.orderId || k.endsWith('|')) continue;
      if (!cur._soKeys.has(k)) {
        cur._soKeys.add(k);
        cur.sourceOrders.push(c);
      }
    }
  }

  return [...map.values()].map(({ _soKeys, ...rest }) => rest);
}

/** Если в заказе нет product_id, но артикул совпадает с products.sku — подставить id для закупки */
async function resolvePurchaseLinesByCatalogSku(lines) {
  const need = lines.filter((l) => !l.productId && l.article && l.article !== '—');
  if (need.length === 0) return lines;
  try {
    const data = await productsApi.getAll({ cacheBust: true, limit: 500, listView: 'stock' });
    const products = Array.isArray(data) ? data : data?.data ?? data?.products ?? [];
    if (!Array.isArray(products) || products.length === 0) return lines;
    const bySku = new Map();
    for (const p of products) {
      const sku = p?.sku != null ? String(p.sku).trim() : '';
      if (!sku) continue;
      const u = sku.toUpperCase();
      if (!bySku.has(u)) bySku.set(u, Number(p.id));
    }
    return lines.map((l) => {
      if (l.productId) return l;
      const a = String(l.article || '').trim().toUpperCase();
      const id = bySku.get(a);
      return id != null && Number.isInteger(id) && id >= 1 ? { ...l, productId: id } : l;
    });
  } catch {
    return lines;
  }
}

const ORDERS_LIST_PAGE_SIZES = [50, 100, 200];

export function Orders() {
  const navigate = useNavigate();
  const { profile, selectedOrganizationId: contextOrganizationId, setSelectedOrganizationId } = useAuth();
  const allowPrivateOrders = profile?.allow_private_orders === true;
  const { warehouses, loadWarehouses } = useWarehouses();
  const { organizations } = useOrganizations();
  const { orders, meta, loading, error, loadOrders } = useOrders({ autoLoad: false });
  const initialOrdersLoadedRef = useRef(false);
  const assembledCount = useMemo(() => orders.filter(o => o.status === 'assembled').length, [orders]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncKind, setSyncKind] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [syncInfo, setSyncInfo] = useState(null);
  /** Пауза фоновой синхронизации с МП + таймер обновления списка на этой странице */
  const [ordersAutoSyncPaused, setOrdersAutoSyncPaused] = useState(false);
  const [ordersAutoSyncPauseLoaded, setOrdersAutoSyncPauseLoaded] = useState(false);
  const [ordersAutoSyncPauseLoading, setOrdersAutoSyncPauseLoading] = useState(false);
  const [ordersAutoSyncPauseError, setOrdersAutoSyncPauseError] = useState(null);
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('new');
  /** Колонка «Поставка» — только на вкладке «Собран» */
  const showShipmentColumn = statusFilter === 'assembled';
  /** Колонка «Стикер» — на сборке и у собранных (не на «Новый» / «В закупке») */
  const showStickerColumn = shouldShowOrdersStickerColumn(statusFilter);
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  const [statusCounts, setStatusCounts] = useState({ all: 0 });
  /** null — порядок с сервера; asc/desc — по минимальному артикулу в группе */
  const [sortByArticle, setSortByArticle] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('ordersListPageSize') : null;
      const n = parseInt(raw, 10);
      return ORDERS_LIST_PAGE_SIZES.includes(n) ? n : 50;
    } catch {
      return 50;
    }
  });
  const [markShippedLoadingKey, setMarkShippedLoadingKey] = useState(null);

  // Если организация ещё не выбрана — выберем первую доступную,
  // иначе X-Organization-Id не уйдёт и "На сборку" не переведёт заказы на маркетплейсе.
  useEffect(() => {
    if (contextOrganizationId) return;
    const first = (organizations || [])[0];
    if (first?.id != null) {
      setSelectedOrganizationId(String(first.id));
    }
  }, [contextOrganizationId, organizations, setSelectedOrganizationId]);
  const [deleteLoadingKey, setDeleteLoadingKey] = useState(null);
  const [returnToNewLoadingKey, setReturnToNewLoadingKey] = useState(null);
  const [releaseReserveLoadingKey, setReleaseReserveLoadingKey] = useState(null);
  const [cancelOrderLoadingKey, setCancelOrderLoadingKey] = useState(null);
  const [procurementLoadingKey, setProcurementLoadingKey] = useState(null);
  /** Сброс нативного select «Статус в системе» после применения */
  const [bulkErmStatusKey, setBulkErmStatusKey] = useState(0);
  const [bulkLocalErmStatusLoading, setBulkLocalErmStatusLoading] = useState(false);
  const [sendToAssemblyRowKey, setSendToAssemblyRowKey] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  /** Снапшот заказа по `orderKey` — чтобы «В закупку»/сборка/ERM по всем страницам, а не только по текущей. */
  const [selectedOrderByKey, setSelectedOrderByKey] = useState({});
  const [assemblyLoading, setAssemblyLoading] = useState(false);
  const [assemblyMessage, setAssemblyMessage] = useState(null);
  const [addOrderOpen, setAddOrderOpen] = useState(false);
  const [addOrderCustomerName, setAddOrderCustomerName] = useState('');
  const [addOrderCustomerPhone, setAddOrderCustomerPhone] = useState('');
  const [addOrderItems, setAddOrderItems] = useState([
    { productId: '', productLabel: '', searchText: '', quantity: 1, price: '' },
  ]);
  const [addOrderLoading, setAddOrderLoading] = useState(false);
  const [addOrderError, setAddOrderError] = useState(null);
  const [productsList, setProductsList] = useState([]);
  const [detailModalRow, setDetailModalRow] = useState(null);
  const [detailModalData, setDetailModalData] = useState(null);
  const [detailModalLoading, setDetailModalLoading] = useState(false);
  const [detailModalError, setDetailModalError] = useState(null);

  /** Модалка «В закупку»: создать закупку или добавить в черновик */
  const [procurementModalRow, setProcurementModalRow] = useState(null);
  /** Для кнопки панели: исходные строки таблицы (по одной на заказ/группу), чтобы перевести каждую в in_procurement */
  const [procurementModalBulkSourceRows, setProcurementModalBulkSourceRows] = useState(null);
  const [procurementModalLoading, setProcurementModalLoading] = useState(false);
  const [procurementModalErr, setProcurementModalErr] = useState(null);
  const [procurementDraftPurchases, setProcurementDraftPurchases] = useState([]);
  const [procurementSuppliers, setProcurementSuppliers] = useState([]);
  const [procurementChoice, setProcurementChoice] = useState('existing');
  const [procurementExistingId, setProcurementExistingId] = useState('');
  const [procurementSupplierId, setProcurementSupplierId] = useState('');
  const [procurementOrganizationId, setProcurementOrganizationId] = useState('');
  const [procurementWarehouseId, setProcurementWarehouseId] = useState('');
  /** Сортировка таблицы позиций в модалке закупки по количеству */
  const [procurementPreviewQtySort, setProcurementPreviewQtySort] = useState(null);
  /** Редактируемые позиции закупки (кол-во, исключение, подсказка по складу) */
  const [procurementEditableLines, setProcurementEditableLines] = useState([]);
  const [procurementLinesReady, setProcurementLinesReady] = useState(false);

  const procurementWarehouseOptions = useMemo(
    () => (warehouses || []).filter((w) => w?.type === 'warehouse' && !w?.supplier_id),
    [warehouses]
  );

  /** Подставить организацию из глобального переключателя (Auth), если в модалке «Новая закупка» и поле пустое */
  useEffect(() => {
    if (!procurementModalRow || procurementModalLoading) return;
    if (procurementChoice !== 'new') return;
    if (procurementOrganizationId) return;
    const so = contextOrganizationId;
    if (!so) return;
    if (!(organizations || []).some((o) => String(o.id) === String(so))) return;
    setProcurementOrganizationId(String(so));
    (async () => {
      try {
        await loadWarehouses(String(so));
      } catch {
        // ошибка в хуке
      }
    })();
  }, [
    procurementModalRow,
    procurementModalLoading,
    procurementChoice,
    procurementOrganizationId,
    contextOrganizationId,
    organizations,
    loadWarehouses,
  ]);

  /** Если у выбранной организации ровно один подходящий склад — выбрать его */
  useEffect(() => {
    if (!procurementModalRow || procurementModalLoading) return;
    if (procurementChoice !== 'new') return;
    if (procurementWarehouseId) return;
    if (!procurementOrganizationId) return;
    if (procurementWarehouseOptions.length !== 1) return;
    setProcurementWarehouseId(String(procurementWarehouseOptions[0].id));
  }, [
    procurementModalRow,
    procurementModalLoading,
    procurementChoice,
    procurementOrganizationId,
    procurementWarehouseId,
    procurementWarehouseOptions,
  ]);

  const procurementDisplayLines = useMemo(() => {
    const lines = procurementEditableLines.filter((l) => !l.excluded);
    if (procurementPreviewQtySort == null) return lines;
    const dir = procurementPreviewQtySort === 'asc' ? 1 : -1;
    const q = (l) => {
      const n = Number(l.quantity);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return [...lines].sort((a, b) => {
      const d = q(a) - q(b);
      if (d !== 0) return d * dir;
      return String(a.article || '').localeCompare(String(b.article || ''), 'ru', { numeric: true });
    });
  }, [procurementEditableLines, procurementPreviewQtySort]);

  const procurementExcludedOnHandCount = useMemo(
    () => procurementEditableLines.filter((l) => l.excluded && l.stockStatus === 'on_hand').length,
    [procurementEditableLines]
  );

  useEffect(() => {
    setProcurementPreviewQtySort(null);
    setProcurementEditableLines([]);
    setProcurementLinesReady(false);
  }, [procurementModalRow?.key]);

  useEffect(() => {
    if (!procurementModalRow || procurementModalLoading) return undefined;
    let cancelled = false;
    setProcurementLinesReady(false);
    (async () => {
      try {
        const rawLines = purchaseLinesFromDisplayRow(procurementModalRow);
        const resolved = await resolvePurchaseLinesByCatalogSku(rawLines);
        const merged = mergePurchaseLinesByArticle(resolved);
        const sourceOrders =
          procurementModalBulkSourceRows && procurementModalBulkSourceRows.length > 0
            ? procurementModalBulkSourceRows.flatMap((r) => ordersArrayForPurchaseRow(r))
            : ordersArrayForPurchaseRow(procurementModalRow);
        const pids = [
          ...new Set(
            merged.map((l) => Number(l.productId)).filter((id) => Number.isInteger(id) && id >= 1)
          ),
        ];
        let productsById = new Map();
        if (pids.length > 0) {
          const data = await productsApi.getAll({ cacheBust: true, limit: 2000, listView: 'stock' });
          const products = Array.isArray(data) ? data : data?.data ?? data?.products ?? [];
          productsById = productsMapFromStockList(products);
        }
        const editable = buildProcurementEditableLines(merged, sourceOrders, productsById);
        if (!cancelled) {
          setProcurementEditableLines(editable);
          setProcurementLinesReady(true);
        }
      } catch {
        if (!cancelled) {
          setProcurementEditableLines([]);
          setProcurementLinesReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [procurementModalRow, procurementModalBulkSourceRows, procurementModalLoading]);

  const setProcurementLineQuantity = (lineKey, rawQty) => {
    const n = parseInt(rawQty, 10);
    const quantity = Number.isFinite(n) ? Math.max(0, n) : 0;
    setProcurementEditableLines((prev) =>
      prev.map((l) =>
        l.lineKey === lineKey ? { ...l, quantity, excluded: quantity <= 0 ? l.excluded : false } : l
      )
    );
  };

  const removeProcurementLine = (lineKey) => {
    setProcurementEditableLines((prev) =>
      prev.map((l) => (l.lineKey === lineKey ? { ...l, excluded: true, quantity: 0 } : l))
    );
  };

  const restoreProcurementLine = (lineKey) => {
    setProcurementEditableLines((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        const qty = Math.max(0, Number(l.orderNeed) || 0);
        return {
          ...l,
          excluded: false,
          quantity: l.stockStatus === 'on_hand' ? 0 : qty > 0 ? qty : 1,
        };
      })
    );
  };

  useEffect(() => {
    if (!allowPrivateOrders) {
      setMarketplaceFilter((f) => (f === 'manual' ? 'all' : f));
      setAddOrderOpen(false);
    }
  }, [allowPrivateOrders]);

  useEffect(() => {
    if (!addOrderOpen) return;
    productsApi
      .getAll({ limit: 400, listView: 'full' })
      .then((data) => {
        const list = Array.isArray(data) ? data : data?.data ?? data?.products ?? [];
        setProductsList(list.filter((p) => p?.id != null));
      })
      .catch(() => setProductsList([]));
  }, [addOrderOpen]);

  const buildOrdersListParams = useCallback(
    (page = currentPage) => {
      const params = {
        limit: pageSize,
        offset: Math.max(0, page - 1) * pageSize,
      };
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      if (statusFilter !== 'all') params.status = statusFilter;
      const query = String(orderSearchQuery || '').trim();
      if (query) params.search = query;
      return params;
    },
    [currentPage, pageSize, marketplaceFilter, statusFilter, orderSearchQuery]
  );

  const reloadOrders = useCallback(
    async (options = {}) => {
      const page = options.page ?? currentPage;
      const params = {
        ...buildOrdersListParams(page),
        ...(options.params || {}),
      };
      return await loadOrders({
        ...options,
        params,
      });
    },
    [buildOrdersListParams, currentPage, loadOrders]
  );

  useEffect(() => {
    // После первой загрузки не “роняем” страницу в общий loader — обновляем список тихо.
    const silent = initialOrdersLoadedRef.current;
    void reloadOrders({ silent });
    initialOrdersLoadedRef.current = true;
  }, [reloadOrders]);

  const loadStatusCounts = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const params = {};
        if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
        const q = String(orderSearchQuery || '').trim();
        if (q) params.search = q;
        const data = await ordersApi.getStatusCounts(params);
        setStatusCounts(data && typeof data === 'object' ? data : { all: 0 });
      } catch (e) {
        // Не блокируем UI счётчиков на ошибке — просто оставляем прошлые значения.
      }
    },
    [marketplaceFilter, orderSearchQuery]
  );

  useEffect(() => {
    // Обновляем счётчики при смене marketplace и (с debounce) поиска.
    const t = setTimeout(() => {
      void loadStatusCounts({ silent: false });
    }, 250);
    return () => clearTimeout(t);
  }, [marketplaceFilter, orderSearchQuery, loadStatusCounts]);

  useEffect(() => {
    // После любых обновлений списка (смена статуса, действия по заказу, синк) — тихо обновляем счётчики.
    if (!initialOrdersLoadedRef.current) return;
    void loadStatusCounts({ silent: true });
  }, [orders, loadStatusCounts]);

  // Звук "Новый заказ" перенесён в глобальный опрос (Layout) — чтобы работать на любой странице
  // и не срабатывать при открытии страницы «Заказы».

  useEffect(() => {
    setCurrentPage(1);
  }, [marketplaceFilter, statusFilter]);

  useEffect(() => {
    const t = setTimeout(() => {
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [orderSearchQuery]);

  useEffect(() => {
    if (!detailModalRow) {
      setDetailModalData(null);
      setDetailModalError(null);
      return;
    }
    const { first, orders: modalOrders } = detailModalRow;
    const marketplace = first.marketplace;
    const orderId = marketplaceOrderIdForApi(modalOrders ?? [first], marketplace);
    const supportsDetailApi =
      marketplace === 'ozon' ||
      marketplace === 'wildberries' ||
      marketplace === 'wb' ||
      marketplace === 'yandex';
    if (!supportsDetailApi) {
      setDetailModalData(null);
      setDetailModalError(null);
      setDetailModalLoading(false);
      return;
    }
    setDetailModalLoading(true);
    setDetailModalError(null);
    setDetailModalData(null);
    ordersApi.getOrderDetail(marketplace, orderId, { fast: true })
      .then((result) => {
        setDetailModalData(result);
        setDetailModalError(null);
      })
      .catch((e) => {
        setDetailModalError(e.response?.data?.message || e.message || 'Не удалось загрузить детали');
        setDetailModalData(null);
      })
      .finally(() => setDetailModalLoading(false));
  }, [detailModalRow]);

  const syncInFlightRef = useRef(false);

  const runSync = useCallback(
    async (silent = false, opts = {}) => {
      const forceImport = opts.force === true;
      // Тихий опрос при открытии страницы не блокирует ручной «Импорт».
      if (syncInFlightRef.current && !silent && !forceImport) {
        setSyncInfo({ message: 'Синхронизация уже выполняется, подождите…' });
        return;
      }
      if (syncInFlightRef.current && !silent && forceImport) {
        try {
          await ordersApi.resetSyncFbs();
        } catch {
          /* ignore */
        }
      }
      syncInFlightRef.current = true;
      const refreshStatuses = opts.refreshStatuses === true;
      try {
        if (!silent) {
          setSyncLoading(true);
          setSyncKind(forceImport ? 'import' : 'refresh');
          setSyncError(null);
          setSyncInfo(null);
        }
        await ordersApi.syncFbs({
          force: forceImport,
          refreshStatuses
        });
        if (!silent) {
          setSyncInfo({ message: forceImport ? 'Импорт заказов с маркетплейсов…' : 'Синхронизация…' });
        }

        const startedAt = Date.now();
        const MAX_WAIT_MS = 600000;
        let lastStatus = null;
        let sawInProgress = false;
        while (Date.now() - startedAt < MAX_WAIT_MS) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1500));
          // eslint-disable-next-line no-await-in-loop
          lastStatus = await ordersApi.getSyncFbsStatus().catch(() => null);
          if (lastStatus?.inProgress) sawInProgress = true;
          const elapsed = Date.now() - startedAt;
          const elapsedSec = Math.floor(elapsed / 1000);
          if (!silent && lastStatus?.inProgress) {
            setSyncInfo({
              message: forceImport
                ? `Импорт заказов с маркетплейсов… (${elapsedSec} с)`
                : `Синхронизация… (${elapsedSec} с)`
            });
          }
          if (!lastStatus?.inProgress && (sawInProgress || elapsed >= 5000)) break;
          if (elapsed > 120000 && lastStatus?.inProgress && !silent) {
            setSyncInfo({
              message: `Импорт всё ещё идёт на сервере (${elapsedSec} с). Можно обновить список или нажать «Сбросить импорт».`
            });
          }
        }

        const ym = lastStatus?.lastSyncResult?.yandex;
        if (lastStatus?.lastSyncError && !silent) {
          setSyncError(String(lastStatus.lastSyncError));
          setSyncInfo(null);
        } else if (forceImport && ym && Number(ym.success) === 0 && ym.reason && !silent) {
          setSyncError(`Яндекс.Маркет: ${ym.reason}`);
        } else if (lastStatus?.inProgress && !silent) {
          setSyncError(
            'Синхронизация на сервере ещё идёт. Подождите минуту и нажмите «Обновить список» или повторите импорт.'
          );
        } else if (!silent) {
          setSyncInfo({
            message: buildOrdersSyncDoneMessage(lastStatus, { forceImport })
          });
        }

        if (forceImport) setCurrentPage(1);
        const loaded = await reloadOrders({ silent: true, page: forceImport ? 1 : undefined });
        if (forceImport) {
          const r = lastStatus?.lastSyncResult;
          const totalImported =
            (r?.ozon?.success ?? 0) + (r?.wildberries?.success ?? 0) + (r?.yandex?.success ?? 0);
          const listEmpty = Array.isArray(loaded?.data) ? loaded.data.length === 0 : false;
          if (listEmpty && totalImported > 0 && statusFilter !== 'all') {
            // Частый кейс: импорт принёс заказы, но текущий фильтр («Новые») их скрывает.
            setStatusFilter('all');
            await reloadOrders({ silent: true, page: 1 });
            if (!silent) {
              setSyncInfo({
                message:
                  (buildOrdersSyncDoneMessage(lastStatus, { forceImport }) || 'Импорт завершён.') +
                  ' Показан фильтр «Все», т.к. по текущему фильтру список оказался пустым.'
              });
            }
          }
        }
      } catch (e) {
        const status = e.response?.status;
        const data = e.response?.data;
        const msg = data?.message || data?.error || (typeof data?.message === 'string' ? data.message : null) || e.message;
        console.error('Ошибка синхронизации заказов:', e.message, status ? `[${status}]` : '', data || '');
        try {
          await reloadOrders({ silent: true });
        } catch (_) {
          /* ignore */
        }
        if (!silent) {
          if (status === 404) {
            setSyncError('Эндпоинт синхронизации не найден (404). Проверьте, что бэкенд запущен и адрес API указан верно (REACT_APP_API_URL).');
          } else if (status === 429) {
            setSyncError(msg || 'Слишком частые запросы. Подождите перед повторной синхронизацией.');
          } else if (e.code === 'ECONNABORTED' || /timeout/i.test(String(e.message || ''))) {
            setSyncError(
              'Таймаут запроса. Импорт мог запуститься на сервере — подождите 1–2 минуты и обновите список. Проверьте логи pm2 при повторной ошибке.'
            );
          } else if (!e.response) {
            setSyncError(`Нет связи с сервером: ${e.message || 'сетевая ошибка'}. Проверьте, что бэкенд запущен и доступен по адресу ${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}.`);
          } else {
            setSyncError(msg || `Ошибка синхронизации${status ? ` (${status})` : ''}`);
          }
        }
      } finally {
        syncInFlightRef.current = false;
        if (!silent) {
          setSyncLoading(false);
          setSyncKind(null);
        }
      }
    },
    [reloadOrders, statusFilter]
  );

  const handleSync = () => runSync(false, { refreshStatuses: true });
  const handleImportOrders = () => runSync(false, { force: true });

  const handleResetSync = async () => {
    try {
      setSyncLoading(true);
      await ordersApi.resetSyncFbs();
      setSyncInfo({ message: 'Блокировка снята. Можно снова нажать «Импортировать заказы».' });
      setSyncError(null);
    } catch (e) {
      setSyncError(e.response?.data?.message || e.message || 'Не удалось сбросить синхронизацию');
    } finally {
      syncInFlightRef.current = false;
      setSyncLoading(false);
      setSyncKind(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    ordersApi
      .getOrdersFbsSyncPause()
      .then((d) => {
        if (!cancelled) setOrdersAutoSyncPaused(Boolean(d?.paused));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setOrdersAutoSyncPauseLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOrdersAutoSyncPause = async (paused) => {
    setOrdersAutoSyncPauseError(null);
    setOrdersAutoSyncPauseLoading(true);
    try {
      await ordersApi.setOrdersFbsSyncPause(paused);
      setOrdersAutoSyncPaused(paused);
    } catch (e) {
      setOrdersAutoSyncPauseError(e.response?.data?.message || e.message || 'Не удалось переключить автообновление');
    } finally {
      setOrdersAutoSyncPauseLoading(false);
    }
  };

  // Фон на сервере подтягивает заказы (ORDERS_FBS_SYNC_CRON). На клиенте — только обновление списка,
  // без POST /sync-fbs (иначе пул БД забивается параллельно с cron и десятками GET при открытии страницы).
  useEffect(() => {
    if (!ordersAutoSyncPauseLoaded || ordersAutoSyncPaused) return undefined;
    let mounted = true;
    const POLL_MS = 2 * 60 * 1000;

    const t0 = setTimeout(() => {
      if (!mounted) return;
      reloadOrders({ silent: true });
    }, 5000);

    const poll = setInterval(() => {
      if (!mounted) return;
      reloadOrders({ silent: true });
    }, POLL_MS);

    return () => {
      mounted = false;
      clearTimeout(t0);
      clearInterval(poll);
    };
  }, [reloadOrders, runSync, ordersAutoSyncPauseLoaded, ordersAutoSyncPaused]);

  const handleMarkShipped = async (marketplace, orderId, rowKey) => {
    try {
      setMarkShippedLoadingKey(rowKey);
      setRefreshError(null);
      await ordersApi.markShipped(marketplace, orderId);
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка смены статуса на «Отгружен»:', e);
      setRefreshError(e.response?.data?.message || e.message || 'Не удалось изменить статус');
    } finally {
      setMarkShippedLoadingKey(null);
    }
  };

  const handleDeleteOrder = async (marketplace, orderId, rowKey) => {
    if (!window.confirm('Удалить этот заказ? При заказе с несколькими товарами удалится вся группа.')) return;
    try {
      setDeleteLoadingKey(rowKey);
      setRefreshError(null);
      await ordersApi.deleteOrder(marketplace, orderId);
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка удаления заказа:', e);
      setRefreshError(e.response?.data?.message || e.message || 'Не удалось удалить заказ');
    } finally {
      setDeleteLoadingKey(null);
    }
  };

  const handleReturnToNew = async (marketplace, orderId, rowKey) => {
    try {
      setReturnToNewLoadingKey(rowKey);
      setRefreshError(null);
      await ordersApi.returnToNew(marketplace, orderId);
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка возврата в «Новый»:', e);
      setRefreshError(e.response?.data?.message || e.message || 'Не удалось вернуть заказ в статус «Новый»');
    } finally {
      setReturnToNewLoadingKey(null);
    }
  };

  const handleReleaseReserve = async (marketplace, orderId, rowKey) => {
    if (!window.confirm('Снять весь резерв по этому заказу?')) return;
    try {
      setReleaseReserveLoadingKey(rowKey);
      setRefreshError(null);
      await ordersApi.setOrderReserve(marketplace, orderId, { action: 'unreserve' });
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка снятия резерва:', e);
      setRefreshError(e.response?.data?.message || e.message || 'Не удалось снять резерв');
    } finally {
      setReleaseReserveLoadingKey(null);
    }
  };

  const handleCancelOrder = async (marketplace, orderId, rowKey) => {
    if (
      !window.confirm(
        'Отменить заказ? В системе статус станет «Отменён»; для Ozon, Wildberries и Яндекс.Маркета будет отправлен запрос отмены продавца в API маркетплейса (если статус допускает отмену).'
      )
    ) {
      return;
    }
    try {
      setCancelOrderLoadingKey(rowKey);
      setRefreshError(null);
      await ordersApi.cancelOrder(marketplace, orderId);
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка отмены заказа:', e);
      setRefreshError(e.response?.data?.message || e.message || 'Не удалось отменить заказ');
    } finally {
      setCancelOrderLoadingKey(null);
    }
  };

  const openProcurementModal = async (row) => {
    setProcurementModalErr(null);
    setProcurementModalBulkSourceRows(null);
    setProcurementModalRow(row);
    setProcurementExistingId('');
    setProcurementSupplierId('');
    setProcurementOrganizationId('');
    setProcurementWarehouseId('');
    setProcurementModalLoading(true);
    try {
      const [drafts, supRes] = await Promise.all([
        purchasesApi.list({ status: 'open', limit: 50 }),
        suppliersApi.getAll(),
      ]);
      const listDrafts = Array.isArray(drafts) ? drafts : [];
      setProcurementDraftPurchases(listDrafts);
      setProcurementChoice(listDrafts.length > 0 ? 'existing' : 'new');
      const rawSup =
        supRes && supRes.ok && Array.isArray(supRes.data)
          ? supRes.data
          : Array.isArray(supRes)
            ? supRes
            : [];
      setProcurementSuppliers(rawSup);
      if (listDrafts.length > 0) {
        setProcurementExistingId(String(listDrafts[0].id));
      }
    } catch (e) {
      setProcurementChoice('new');
      setProcurementModalErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупки и поставщиков');
    } finally {
      setProcurementModalLoading(false);
    }
  };

  const closeProcurementModal = () => {
    setProcurementModalRow(null);
    setProcurementModalBulkSourceRows(null);
    setProcurementModalErr(null);
    setProcurementPreviewQtySort(null);
    setProcurementEditableLines([]);
    setProcurementLinesReady(false);
    setProcurementOrganizationId('');
    setProcurementWarehouseId('');
  };

  const submitProcurementFromOrder = async () => {
    if (!procurementModalRow) return;
    const activeLines = procurementEditableLines.filter(
      (l) => !l.excluded && l.productId && Number(l.quantity) > 0
    );
    const missingCatalog = procurementEditableLines.filter((l) => !l.excluded && !l.productId);
    if (missingCatalog.length > 0) {
      const names = missingCatalog.map((l) => l.article || l.name || '?').join(', ');
      setProcurementModalErr(
        `Не удалось определить товар в каталоге для: ${names}. Убедитесь, что в карточке товара указан такой же артикул (SKU), либо добавьте сопоставление SKU маркетплейса в каталоге. Обновите список заказов после правок.`
      );
      return;
    }
    const items = activeLines.map((l) => ({
      productId: l.productId,
      quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
      sourceOrders: l.sourceOrders ?? [],
    }));
    if (items.length === 0) {
      setProcurementModalErr(
        procurementExcludedOnHandCount > 0
          ? 'Все позиции уже на складе или сняты с закупки. Добавьте количество хотя бы для одной строки.'
          : 'Нет позиций для закупки'
      );
      return;
    }
    if (procurementChoice === 'existing') {
      const pid = parseInt(procurementExistingId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        setProcurementModalErr('Выберите существующую закупку');
        return;
      }
    } else {
      if (!String(procurementSupplierId || '').trim()) {
        setProcurementModalErr('Выберите поставщика');
        return;
      }
      if (!String(procurementOrganizationId || '').trim()) {
        setProcurementModalErr('Выберите организацию');
        return;
      }
      if (!String(procurementWarehouseId || '').trim()) {
        setProcurementModalErr('Выберите склад назначения');
        return;
      }
    }
    const sourceRows =
      procurementModalBulkSourceRows && procurementModalBulkSourceRows.length > 0
        ? procurementModalBulkSourceRows
        : [procurementModalRow];
    const { first } = procurementModalRow;
    setProcurementModalErr(null);
    setProcurementLoadingKey(procurementModalRow.key);
    setRefreshError(null);
    try {
      const procurementItems = [];
      const seenProcKeys = new Set();
      for (const r of sourceRows) {
        for (const o of ordersArrayForPurchaseRow(r)) {
          const dk = procurementStatusUpdateDedupeKey(o);
          if (seenProcKeys.has(dk)) continue;
          seenProcKeys.add(dk);
          if (!isOrderStatusEligibleForProcurement(o.marketplace, o.status)) continue;
          procurementItems.push({ marketplace: o.marketplace, orderId: o.orderId });
        }
      }
      const note =
        sourceRows.length > 1
          ? `Из заказов (${sourceRows.length}): ${sourceRows.map((r) => r.first.orderId).join(', ')}`
          : `Из заказа ${first.orderId} (${first.marketplace})`;
      const procurePayload = {
        procurementItems,
        items,
        note,
      };
      if (procurementChoice === 'existing') {
        procurePayload.existingPurchaseId = parseInt(procurementExistingId, 10);
      } else {
        procurePayload.supplierId = parseInt(String(procurementSupplierId).trim(), 10);
        procurePayload.organizationId = parseInt(String(procurementOrganizationId).trim(), 10);
        procurePayload.warehouseId = parseInt(String(procurementWarehouseId).trim(), 10);
      }
      await purchasesApi.procureFromOrders(procurePayload);
      closeProcurementModal();
      await reloadOrders({ silent: true });
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const r of sourceRows) {
          for (const o of ordersArrayForPurchaseRow(r)) {
            next.delete(orderKey(o));
          }
        }
        return next;
      });
      setSelectedOrderByKey((prev) => {
        const n = { ...prev };
        for (const r of sourceRows) {
          for (const o of ordersArrayForPurchaseRow(r)) {
            delete n[orderKey(o)];
          }
        }
        return n;
      });
    } catch (e) {
      console.error('Ошибка «В закупку»:', e);
      const msg = getApiErrorMessage(e, 'Не удалось оформить закупку и обновить заказ');
      setProcurementModalErr(msg);
      setRefreshError(msg);
    } finally {
      setProcurementLoadingKey(null);
    }
  };

  const handleSendOneToAssembly = async (row) => {
    const toSend = row.orders || [row.first];
    const items = toSend.map(o => ({ marketplace: o.marketplace, orderId: o.orderId }));
    if (items.length === 0) return;
    if (!contextOrganizationId) {
      setAssemblyMessage('Выберите организацию (вверху/в настройках аккаунта), затем повторите «На сборку».');
      return;
    }
    try {
      setSendToAssemblyRowKey(row.key);
      setAssemblyMessage(null);
      setRefreshError(null);
      const result = await ordersApi.sendToAssembly(items);
      const updated = result?.updated ?? items.length;
      const preserved = result?.statusPreserved ?? 0;
      const allPreserved = preserved >= items.length && updated === 0;
      let msg = allPreserved
        ? `Заказ(ы) добавлены в поставку (${items.length}), статус «Собран» сохранён.`
        : `На сборку отправлено заказов: ${items.length}${result?.updated != null ? ` (обновлено: ${updated})` : ''}.`;
      if (preserved > 0 && !allPreserved) {
        msg += ` Статус «Собран» сохранён у ${preserved} заказ(ов).`;
      }
      if (result?.shipments?.length) {
        msg += ` Поставки: ${result.shipments.map(s => `${s.marketplace}: ${s.shipmentName}`).join('; ')}.`;
      }
      msg = appendAssemblyWarnings(msg, result?.warnings);
      msg = appendShipmentsPendingHint(msg, result);
      setAssemblyMessage(appendLocalWbOnlyAssemblyHint(msg, result?.shipments));
      await reloadOrders({ silent: true });
    } catch (e) {
      setAssemblyMessage(e.response?.data?.message || e.message || 'Ошибка отправки на сборку');
    } finally {
      setSendToAssemblyRowKey(null);
    }
  };

  // Маркетплейсы для фильтра; «Ручной» — только если включены частные заказы в настройках аккаунта
  const allMarketplaces = useMemo(
    () => {
      const base = [
        { name: 'Ozon', code: 'ozon', icon: '🟠', badgeClass: 'ozon', shortLabel: 'OZ' },
        { name: 'Wildberries', code: 'wildberries', icon: '🟣', badgeClass: 'wb', shortLabel: 'WB' },
        { name: 'Яндекс Маркет', code: 'yandex', icon: '🔴', badgeClass: 'ym', shortLabel: 'YM' },
        { name: 'Ручной', code: 'manual', icon: '✏️', badgeClass: 'manual', shortLabel: 'РУЧ' },
      ];
      return allowPrivateOrders ? base : base.filter((mp) => mp.code !== 'manual');
    },
    [allowPrivateOrders]
  );

  const defaultPriceFromProduct = (p) => {
    if (!p || typeof p !== 'object') return '';
    const c = p.cost != null ? Number(p.cost) : NaN;
    if (Number.isFinite(c) && c >= 0) return c;
    const pr = p.price != null ? Number(p.price) : NaN;
    return Number.isFinite(pr) && pr >= 0 ? pr : '';
  };

  const handleAddOrderOpen = () => {
    setAddOrderError(null);
    setAddOrderCustomerName('');
    setAddOrderCustomerPhone('');
    setAddOrderItems([{ productId: '', productLabel: '', searchText: '', quantity: 1, price: '' }]);
    setAddOrderOpen(true);
  };

  const addOrderAddRow = () => {
    setAddOrderItems((prev) => [
      ...prev,
      { productId: '', productLabel: '', searchText: '', quantity: 1, price: '' },
    ]);
  };

  const addOrderRemoveRow = (index) => {
    setAddOrderItems((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const addOrderUpdateRow = (index, field, value) => {
    setAddOrderItems((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  };

  const addOrderSelectProduct = (index, product) => {
    if (!product?.id) return;
    const productId = Number(product.id);
    if (!Number.isFinite(productId) || productId < 1) return;
    setProductsList((prev) => {
      if (prev.some((x) => Number(x.id) === productId)) return prev;
      return [...prev, product];
    });
    setAddOrderItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = {
          ...row,
          productId,
          productLabel: formatProductOptionLabel(product),
          searchText: '',
        };
        const def = defaultPriceFromProduct(product);
        if (def !== '') next.price = def;
        return next;
      })
    );
  };

  const addOrderClearProduct = (index) => {
    setAddOrderItems((prev) =>
      prev.map((row, i) =>
        i === index
          ? { ...row, productId: '', productLabel: '', searchText: '' }
          : row
      )
    );
  };

  const handleAddOrderSubmit = async (e) => {
    e.preventDefault();
    const customerName = String(addOrderCustomerName || '').trim();
    const customerPhone = String(addOrderCustomerPhone || '').trim();
    if (!customerName) {
      setAddOrderError('Укажите ФИО покупателя');
      return;
    }
    if (!customerPhone) {
      setAddOrderError('Укажите телефон покупателя');
      return;
    }
    const items = [];
    for (const row of addOrderItems) {
      if (row.productId === '' || row.productId == null) continue;
      const productId = Number(row.productId);
      if (!Number.isFinite(productId) || productId < 1) continue;
      const quantity = Math.max(1, parseInt(row.quantity, 10) || 1);
      const unitPrice = row.price === '' || row.price == null ? NaN : Number(row.price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        setAddOrderError('Укажите цену за единицу для каждой выбранной позиции (неотрицательное число)');
        return;
      }
      items.push({ productId, quantity, price: unitPrice });
    }
    if (items.length === 0) {
      setAddOrderError('Добавьте хотя бы один товар с количеством и ценой');
      return;
    }
    setAddOrderLoading(true);
    setAddOrderError(null);
    try {
      await ordersApi.createManual({ items, customerName, customerPhone });
      await reloadOrders({ silent: true });
      setAddOrderOpen(false);
    } catch (err) {
      setAddOrderError(err.response?.data?.message || err.message || 'Не удалось добавить заказ');
    } finally {
      setAddOrderLoading(false);
    }
  };
  
  const uniqueStatuses = useMemo(
    () =>
      Array.from(
        new Set([
          'new',
          'in_procurement',
          'in_assembly',
          'assembled',
          'shipped',
          'in_transit',
          'delivered',
          'cancelled',
          ...orders.map((o) => o.status).filter((s) => s && s !== 'processing'),
        ])
      ),
    [orders]
  );

  /** Для WB техстатусы до резолва API — в UI считаем тем же «Новый», что и `new` (без дублей в фильтре). */
  const normalizeWbNewLikeStatus = (status) => {
    const s = String(status ?? '').trim();
    const sNorm = s.toLowerCase();
    if (sNorm === 'wb_status_unknown' || s === '__wb_status_pending__') return 'new';
    return s;
  };

  const statusFilterOptions = useMemo(() => {
    const raw = uniqueStatuses;
    const out = [];
    const seenUi = new Set();
    for (const st of raw) {
      const uiKey = getOrderStatusLabel(st);
      if (seenUi.has(uiKey)) continue;
      seenUi.add(uiKey);
      out.push(st);
    }
    return out;
  }, [uniqueStatuses]);

  const filteredOrders = useMemo(() => orders.filter(o => {
    const orderMarketplace = normalizeMarketplaceForUI(o.marketplace);
    const byMarketplace =
      marketplaceFilter === 'all' || orderMarketplace === marketplaceFilter;
    const q = String(orderSearchQuery || '').trim();
    const orderIdStr = String(o.orderId || '');
    const groupIdStr = String(o.orderGroupId || o.order_group_id || '');
    const bySearch = !q || orderIdStr.includes(q) || groupIdStr.includes(q);
    const mpLower = String(o.marketplace || '').toLowerCase();
    const isWb = mpLower === 'wb' || mpLower === 'wildberries';
    const stNorm = isWb ? normalizeWbNewLikeStatus(o.status) : String(o.status ?? '');
    const byStatus =
      statusFilter === 'all' ||
      stNorm === statusFilter ||
      (statusFilter === 'in_assembly' && o.status === 'wb_assembly') ||
      (!isWb && o.status === statusFilter);
    return byMarketplace && byStatus && bySearch;
  }), [orders, marketplaceFilter, statusFilter, orderSearchQuery]);

  const filteredKeys = useMemo(() => new Set(filteredOrders.map(orderKey)), [filteredOrders]);

  /** Пул заказов для выбранных чекбоксов: сначала свежие объекты с текущей страницы, иначе снапшот с другой страницы. */
  const orderPoolForSelection = useMemo(() => {
    const fromPage = new Map();
    for (const o of filteredOrders) {
      const k = orderKey(o);
      if (selectedKeys.has(k)) fromPage.set(k, o);
    }
    const out = [];
    const seen = new Set();
    for (const k of selectedKeys) {
      const o = fromPage.get(k) ?? selectedOrderByKey[k];
      if (o && !seen.has(k)) {
        seen.add(k);
        out.push(o);
      }
    }
    return out;
  }, [selectedKeys, selectedOrderByKey, filteredOrders]);

  // Подсчёт количества строк (групп заказов) для кнопок фильтра маркетплейсов.
  // Важно: считаем группы по `orderGroupId`, т.к. один заказ может быть из нескольких товаров.
  const countsByMarketplace = useMemo(() => {
    const ordersByStatus = orders.filter((o) => {
      if (statusFilter === 'all') return true;
      const mpLower = String(o.marketplace || '').toLowerCase();
      const isWb = mpLower === 'wb' || mpLower === 'wildberries';
      const stNorm = isWb ? normalizeWbNewLikeStatus(o.status) : String(o.status ?? '');
      return (
        stNorm === statusFilter ||
        (statusFilter === 'in_assembly' && o.status === 'wb_assembly') ||
        (!isWb && o.status === statusFilter)
      );
    });
    const byGroup = new Map(); // gid -> normalizedMarketplace
    for (const o of ordersByStatus) {
      const mp = normalizeMarketplaceForUI(o.marketplace);
      const ogk = orderGroupKey(o);
      const gid = ogk || singleOrderListGroupKey(o);
      if (!byGroup.has(gid)) byGroup.set(gid, mp);
    }
    const out = {};
    for (const mp of byGroup.values()) {
      out[mp] = (out[mp] || 0) + 1;
    }
    return out;
  }, [orders, statusFilter]);

  const mpFilterRowTotal = useMemo(
    () => Object.values(countsByMarketplace).reduce((a, b) => a + (Number(b) || 0), 0),
    [countsByMarketplace]
  );

  const countsByStatus = statusCounts;

  /** Склейка строк списка по group_id; общая логика для текущей страницы и для пула «все выделенные». */
  const buildGroupedDisplayRowsFromOrderList = useCallback((list) => {
    const byGroup = new Map();
    for (const o of list) {
      const ogk = orderGroupKey(o);
      const gid = ogk || singleOrderListGroupKey(o);
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(o);
    }
    return Array.from(byGroup.entries()).map(([gid, groupOrders]) => {
      const first = groupOrders[0];
      const isGroup = groupOrders.length > 1;
      return {
        key: isGroup ? gid : orderKey(first),
        orderGroupId: isGroup ? gid : null,
        orders: groupOrders,
        first,
        isGroup
      };
    });
  }, []);

  // Группируем заказы с одним order_group_id в одну строку (один заказ — несколько товаров).
  // Маркетплейс нормализуем — иначе две строки одного заказа (wb vs wildberries) не слипаются.
  const groupedDisplayRows = useMemo(
    () => buildGroupedDisplayRowsFromOrderList(filteredOrders),
    [buildGroupedDisplayRowsFromOrderList, filteredOrders]
  );

  const applyArticleSortToGroupedRows = useCallback(
    (rows) => {
      if (sortByArticle == null) return rows;
      const dir = sortByArticle === 'asc' ? 1 : -1;
      const tieBreak = (a, b) => {
        const ta = new Date(a.first.createdAt || 0).getTime();
        const tb = new Date(b.first.createdAt || 0).getTime();
        return tb - ta;
      };
      return [...rows].sort((a, b) => {
        const ka = displayRowPrimaryArticleKey(a);
        const kb = displayRowPrimaryArticleKey(b);
        const aMiss = ka == null;
        const bMiss = kb == null;
        if (aMiss && bMiss) return tieBreak(a, b);
        if (aMiss) return 1;
        if (bMiss) return -1;
        const c = ka.localeCompare(kb, 'ru', ARTICLE_SORT_LOCALE_OPTS);
        if (c !== 0) return c * dir;
        return tieBreak(a, b);
      });
    },
    [sortByArticle]
  );

  const sortedGroupedDisplayRows = useMemo(
    () => applyArticleSortToGroupedRows(groupedDisplayRows),
    [groupedDisplayRows, applyArticleSortToGroupedRows]
  );

  /** Те же группы строк, что в таблице, но по всем выбранным заказам (все страницы) — для «В закупку». */
  const groupedSelectedRowsForBulk = useMemo(
    () => applyArticleSortToGroupedRows(buildGroupedDisplayRowsFromOrderList(orderPoolForSelection)),
    [buildGroupedDisplayRowsFromOrderList, orderPoolForSelection, applyArticleSortToGroupedRows]
  );

  const totalOrders = meta?.total ?? orders.length;
  const totalPages = meta?.total != null ? Math.max(1, Math.ceil(meta.total / Math.max(1, pageSize))) : 1;
  const pageOffset = meta?.offset ?? Math.max(0, currentPage - 1) * pageSize;
  const goToPage = (page) => {
    const next = Math.min(Math.max(1, page), totalPages);
    if (next !== currentPage) setCurrentPage(next);
  };

  const handleOrdersPageSizeChange = (e) => {
    const next = parseInt(e.target.value, 10);
    if (!ORDERS_LIST_PAGE_SIZES.includes(next)) return;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ordersListPageSize', String(next));
    } catch {
      /* ignore */
    }
    setPageSize(next);
    setCurrentPage(1);
  };

  const renderOrdersListPager = (placement) => {
    const idSuffix = placement === 'top' ? 'top' : 'bottom';
    return (
      <div
        className={`d-flex justify-content-between align-items-center flex-wrap gap-2 ${
          placement === 'top' ? 'mb-3' : 'mt-3'
        }`}
      >
        <div className="d-flex flex-wrap align-items-center gap-3 text-muted small">
          <span>
            Показано: {sortedGroupedDisplayRows.length} из {totalOrders}
          </span>
          <span>
            Страница <strong>{currentPage}</strong> из <strong>{totalPages}</strong>
          </span>
          <label className="d-inline-flex align-items-center gap-2 mb-0" htmlFor={`orders-list-page-size-${idSuffix}`}>
            <span>На странице</span>
            <select
              id={`orders-list-page-size-${idSuffix}`}
              className="form-select form-select-sm"
              style={{ width: 'auto', minWidth: '4.5rem' }}
              value={pageSize}
              onChange={handleOrdersPageSizeChange}
              disabled={loading}
            >
              {ORDERS_LIST_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="d-flex align-items-center gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
          >
            Назад
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
          >
            Вперёд
          </Button>
        </div>
      </div>
    );
  };

  /** Кнопка «В закупку»: та же модалка, сигнатура как у прочих действий строки */
  const handleSetToProcurement = (marketplace, orderId, rowKey) => {
    const row =
      sortedGroupedDisplayRows.find((r) => r.key === rowKey) ||
      sortedGroupedDisplayRows.find(
        (r) =>
          r.first &&
          r.first.marketplace === marketplace &&
          String(r.first.orderId ?? '') === String(orderId ?? '')
      );
    if (row) void openProcurementModal(row);
  };

  const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every(o => selectedKeys.has(orderKey(o)));
  // Выделение должно сохраняться между страницами, поэтому считаем все выбранные ключи, а не только текущую страницу.
  const selectedCount = selectedKeys.size;

  const toggleSelectGroup = (row) => {
    const keys = row.orders.map(orderKey);
    const allSelected = keys.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
    setSelectedOrderByKey((prev) => {
      const n = { ...prev };
      if (allSelected) {
        keys.forEach((k) => {
          delete n[k];
        });
      } else {
        for (const o of row.orders) {
          n[orderKey(o)] = o;
        }
      }
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        filteredKeys.forEach((k) => next.delete(k));
        return next;
      });
      setSelectedOrderByKey((prev) => {
        const n = { ...prev };
        filteredKeys.forEach((k) => {
          delete n[k];
        });
        return n;
      });
    } else {
      setSelectedKeys((prev) => new Set([...prev, ...filteredKeys]));
      setSelectedOrderByKey((prev) => {
        const n = { ...prev };
        for (const o of filteredOrders) {
          n[orderKey(o)] = o;
        }
        return n;
      });
    }
  };

  const handleSendToAssembly = async () => {
    // При выборе одного заказа из группы (orderGroupId) отправляем на сборку всю группу (все выделенные страницы)
    const toSend = expandSelectedOrdersForBulkActions(orderPoolForSelection, selectedKeys);
    if (toSend.length === 0) return;
    if (!contextOrganizationId) {
      setAssemblyMessage('Выберите организацию (вверху/в настройках аккаунта), затем повторите «На сборку».');
      return;
    }
    setAssemblyLoading(true);
    setAssemblyMessage(null);
    try {
      const result = await ordersApi.sendToAssembly(toSend.map(o => ({ marketplace: o.marketplace, orderId: o.orderId })));
      const updated = result?.updated ?? toSend.length;
      let msg = `На сборку отправлено заказов: ${toSend.length}${result?.updated != null ? ` (обновлено: ${updated})` : ''}.`;
      if (result?.shipments?.length) {
        msg += ` Поставки: ${result.shipments.map(s => `${s.marketplace}: ${s.shipmentName}`).join('; ')}.`;
      }
      msg = appendAssemblyWarnings(msg, result?.warnings);
      msg = appendShipmentsPendingHint(msg, result);
      setAssemblyMessage(appendLocalWbOnlyAssemblyHint(msg, result?.shipments));
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        toSend.forEach((o) => next.delete(orderKey(o)));
        return next;
      });
      setSelectedOrderByKey((prev) => {
        const n = { ...prev };
        toSend.forEach((o) => {
          delete n[orderKey(o)];
        });
        return n;
      });
      await reloadOrders({ silent: true });
    } catch (e) {
      setAssemblyMessage(e.response?.data?.message || e.message || 'Ошибка отправки на сборку');
    } finally {
      setAssemblyLoading(false);
    }
  };

  /** Массовая смена статуса только в нашей БД (ERM), не запросы к маркетплейсам */
  const handleBulkLocalErmStatus = async (targetStatus) => {
    const toSend = expandSelectedOrdersForBulkActions(orderPoolForSelection, selectedKeys);
    if (toSend.length === 0 || !targetStatus) return;
    setBulkLocalErmStatusLoading(true);
    setAssemblyMessage(null);
    setRefreshError(null);
    try {
      if (targetStatus === 'new') {
        const reps = representativesForGroupScopedApi(toSend);
        const items = reps.map((o) => ({ marketplace: o.marketplace, orderId: o.orderId }));
        try {
          const result = await ordersApi.bulkReturnToNew(items);
          const ok = result?.updated ?? items.length;
          const skipped = result?.skipped ?? 0;
          setAssemblyMessage(
            skipped > 0
              ? `В «Новый» переведено: ${ok}. Пропущено: ${skipped}. Резерв дозаполняется в фоне.`
              : `В «Новый» переведено: ${ok}. Резерв дозаполняется в фоне.`
          );
        } catch (e) {
          setAssemblyMessage(e.response?.data?.message || e.message || 'Ошибка возврата в «Новый»');
        }
      } else if (targetStatus === 'in_procurement') {
        const reps = representativesForGroupScopedApi(toSend);
        const items = reps
          .filter((o) => isOrderStatusEligibleForProcurement(o.marketplace, o.status))
          .map((o) => ({ marketplace: o.marketplace, orderId: o.orderId }));
        const skipped = reps.length - items.length;
        try {
          const result = await ordersApi.bulkSetToProcurement(items);
          const ok = result?.updated ?? items.length;
          setAssemblyMessage(
            [
              `В «В закупке» переведено: ${ok}.`,
              skipped ? ` Пропущено (нет права из текущего статуса): ${skipped}.` : '',
            ].join('')
          );
        } catch (e) {
          setAssemblyMessage(
            `Не удалось перевести в «В закупке»: ${e.response?.data?.message || e.message}`
          );
        }
      } else if (targetStatus === 'in_assembly') {
        if (!contextOrganizationId) {
          setAssemblyMessage('Выберите организацию (вверху/в настройках аккаунта), затем повторите перевод «На сборке».');
          return;
        }
        const result = await ordersApi.sendToAssembly(
          toSend.map((o) => ({ marketplace: o.marketplace, orderId: o.orderId }))
        );
        const updated = result?.updated ?? toSend.length;
        let msg = `В системе статус «На сборке» обновлён для строк: ${updated} из ${toSend.length}.`;
        msg = appendAssemblyWarnings(msg, result?.warnings);
        msg = appendShipmentsPendingHint(msg, result);
        setAssemblyMessage(appendLocalWbOnlyAssemblyHint(msg, result?.shipments));
      }
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        toSend.forEach((o) => next.delete(orderKey(o)));
        return next;
      });
      setSelectedOrderByKey((prev) => {
        const n = { ...prev };
        toSend.forEach((o) => {
          delete n[orderKey(o)];
        });
        return n;
      });
      await reloadOrders({ silent: true });
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось изменить статус';
      setAssemblyMessage(msg);
      setRefreshError(msg);
    } finally {
      setBulkLocalErmStatusLoading(false);
      setBulkErmStatusKey((k) => k + 1);
    }
  };

  /** Выбранные целиком строки, готовые к закупке (новый / у WB — pending до резолва статуса). По всем страницам. */
  const bulkProcurementSelectedRows = useMemo(() => {
    return groupedSelectedRowsForBulk.filter((row) => {
      const keys = row.orders.map(orderKey);
      if (!keys.every((k) => selectedKeys.has(k))) return false;
      return row.orders.every((o) => isOrderStatusEligibleForProcurement(o.marketplace, o.status));
    });
  }, [groupedSelectedRowsForBulk, selectedKeys]);

  const openBulkProcurementModal = async () => {
    const rows = bulkProcurementSelectedRows;
    if (rows.length === 0) {
      setAssemblyMessage(
        'Отметьте чекбоксами целые строки заказов, доступных к закупке («Новый», «На сборке» или у WB — пока статус не получен), затем снова нажмите «В закупку».'
      );
      return;
    }
    setProcurementModalErr(null);
    setProcurementModalBulkSourceRows(rows);
    const synthetic = {
      key: '__bulk__',
      orders: rows.flatMap((r) => ordersArrayForPurchaseRow(r)),
      first: rows[0].first,
      isGroup: rows.length > 1 || rows.some((r) => r.isGroup),
    };
    setProcurementModalRow(synthetic);
    setProcurementExistingId('');
    setProcurementSupplierId('');
    setProcurementModalLoading(true);
    try {
      const [drafts, supRes] = await Promise.all([
        purchasesApi.list({ status: 'open', limit: 50 }),
        suppliersApi.getAll(),
      ]);
      const listDrafts = Array.isArray(drafts) ? drafts : [];
      setProcurementDraftPurchases(listDrafts);
      setProcurementChoice(listDrafts.length > 0 ? 'existing' : 'new');
      const rawSup =
        supRes && supRes.ok && Array.isArray(supRes.data)
          ? supRes.data
          : Array.isArray(supRes)
            ? supRes
            : [];
      setProcurementSuppliers(rawSup);
      if (listDrafts.length > 0) {
        setProcurementExistingId(String(listDrafts[0].id));
      }
    } catch (e) {
      setProcurementChoice('new');
      setProcurementModalErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупки и поставщиков');
    } finally {
      setProcurementModalLoading(false);
    }
  };

  const isInitialLoading = loading && orders.length === 0;
  if (isInitialLoading) {
    return <div className="loading">Загрузка заказов...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      {ordersAutoSyncPaused && (
        <div
          role="status"
          style={{
            marginBottom: '14px',
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'var(--warning-bg, #fff8e6)',
            border: '1px solid var(--warning-border, #e6c200)',
            color: 'var(--text, inherit)',
          }}
        >
          <strong>Автообновление заказов с маркетплейсов приостановлено.</strong> Статусы не меняются по расписанию сервера,
          список здесь тоже не опрашивается по таймеру. Кнопки «Обновить статусы» и «Импортировать заказы» ниже — ручная
          синхронизация когда будете готовы.
          <div style={{ marginTop: '10px' }}>
            <Button
              variant="primary"
              size="small"
              onClick={() => handleOrdersAutoSyncPause(false)}
              disabled={ordersAutoSyncPauseLoading}
            >
              {ordersAutoSyncPauseLoading ? '…' : 'Включить автообновление обратно'}
            </Button>
          </div>
        </div>
      )}
      {ordersAutoSyncPauseError && (
        <p className="error" style={{ marginBottom: '12px' }}>
          {ordersAutoSyncPauseError}
        </p>
      )}
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
        <h1 className="title" style={{margin: 0}}>📋 Заказы</h1>
        <div style={{display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}>
          {!ordersAutoSyncPaused ? (
            <Button
              variant="secondary"
              size="small"
              onClick={() => handleOrdersAutoSyncPause(true)}
              disabled={ordersAutoSyncPauseLoading || !ordersAutoSyncPauseLoaded}
              title="Остановить фоновую подгрузку заказов и статусов с Ozon, WB и Яндекс (удобно во время сборки)"
            >
              {ordersAutoSyncPauseLoading ? '…' : '⏸ Пауза автообновления'}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="small"
            onClick={handleSync}
            disabled={syncLoading}
          >
            {syncLoading && syncKind === 'refresh' ? 'Обновление...' : '🔄 Обновить статусы заказов'}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={handleImportOrders}
            disabled={syncLoading}
            title="Загрузка заказов за последние ~45 дней с Ozon, Wildberries и Яндекс.Маркет"
          >
            {syncLoading && syncKind === 'import' ? 'Импорт...' : '📥 Импортировать заказы'}
          </Button>
          {syncLoading && (
            <Button
              variant="outline-secondary"
              size="small"
              onClick={() => void handleResetSync()}
              title="Если импорт завис больше 2–3 минут"
            >
              Сбросить импорт
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            onClick={() => navigate('/assembly')}
            title="Перейти к экрану сборки заказов"
          >
            {assembledCount > 0 ? `📦 Сборка (${assembledCount})` : '📦 Сборка'}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => navigate('/shipments')}
            title="Перейти к поставкам FBS"
          >
            🚚 Поставки FBS
          </Button>
          {selectedCount > 0 && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => void openBulkProcurementModal()}
              disabled={
                bulkProcurementSelectedRows.length === 0 ||
                !!procurementLoadingKey ||
                syncLoading ||
                bulkLocalErmStatusLoading
              }
              title={
                bulkProcurementSelectedRows.length === 0
                  ? 'Отметьте целиком строки заказов в статусе «Новый»'
                  : 'Выберите существующую закупку или создайте новую — позиции попадут туда, заказы перейдут в «В закупке»'
              }
            >
              {procurementLoadingKey === '__bulk__'
                ? '…'
                : `🛒 В закупку (${bulkProcurementSelectedRows.length || 0})`}
            </Button>
          )}
          {selectedCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label htmlFor={`orders-bulk-erm-status-${bulkErmStatusKey}`} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                Статус в системе
              </label>
              <select
                key={bulkErmStatusKey}
                id={`orders-bulk-erm-status-${bulkErmStatusKey}`}
                className="form-control"
                defaultValue=""
                disabled={
                  bulkLocalErmStatusLoading ||
                  assemblyLoading ||
                  !!procurementLoadingKey ||
                  syncLoading
                }
                style={{ minWidth: 220, padding: '6px 10px', fontSize: 13 }}
                title={
                  '«Новый» и «В закупке» — только наша база. «На сборке» — как кнопка «Отправить на сборку» ' +
                  '(для Ozon/WB/Я.Маркет дополнительно создаётся/пополняется поставка на стороне МП).'
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  void handleBulkLocalErmStatus(v);
                }}
              >
                <option value="">— выберите —</option>
                <option value="new">Новый</option>
                <option value="in_procurement">В закупке</option>
                <option value="in_assembly">На сборке</option>
              </select>
            </div>
          )}
          {selectedCount > 0 && (
            <Button
              variant="primary"
              size="small"
              onClick={handleSendToAssembly}
              disabled={assemblyLoading || bulkLocalErmStatusLoading}
            >
              {assemblyLoading ? 'Отправка...' : `➡️ Отправить на сборку (${selectedCount})`}
            </Button>
          )}
          {allowPrivateOrders && (
            <Button variant="secondary" size="small" onClick={handleAddOrderOpen}>
              ✏️ Добавить заказ
            </Button>
          )}
        </div>
      </div>
      <p className="subtitle">Управление заказами с маркетплейсов</p>

      <Modal
        isOpen={addOrderOpen && allowPrivateOrders}
        onClose={() => setAddOrderOpen(false)}
        title="Добавить заказ"
        size="large"
      >
        <form onSubmit={handleAddOrderSubmit} className="orders-add-form">
          {addOrderError && (
            <div className="error" style={{ marginBottom: '12px' }}>{addOrderError}</div>
          )}
          <p className="form-hint" style={{ marginBottom: '12px' }}>
            Укажите покупателя и позиции. Поиск товара — по артикулу, штрихкоду или названию.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px',
              marginBottom: '16px',
            }}
            className="orders-add-customer-grid"
          >
            <div className="form-group">
              <label className="label">ФИО покупателя</label>
              <input
                type="text"
                className="form-control"
                value={addOrderCustomerName}
                onChange={(e) => setAddOrderCustomerName(e.target.value)}
                autoComplete="name"
                placeholder="Иванов Иван Иванович"
              />
            </div>
            <div className="form-group">
              <label className="label">Телефон</label>
              <input
                type="tel"
                className="form-control"
                value={addOrderCustomerPhone}
                onChange={(e) => setAddOrderCustomerPhone(e.target.value)}
                autoComplete="tel"
                placeholder="+7 …"
              />
            </div>
          </div>
          {addOrderItems.map((row, index) => (
            <div key={index} className="orders-add-row" style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', marginBottom: '12px', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 240px', minWidth: 200 }}>
                <label className="label">Товар</label>
                {row.productId ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 6,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{row.productLabel || `Товар #${row.productId}`}</span>
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0"
                      onClick={() => addOrderClearProduct(index)}
                    >
                      Сменить
                    </button>
                  </div>
                ) : (
                  <ProductSearchInput
                    id={`manual-order-product-${index}`}
                    className="form-control"
                    value={row.searchText || ''}
                    onChange={(v) => addOrderUpdateRow(index, 'searchText', v)}
                    onSelect={(p) => addOrderSelectProduct(index, p)}
                    products={productsList}
                    organizationId={contextOrganizationId}
                    placeholder="Артикул, штрихкод или название"
                    disabled={addOrderLoading}
                  />
                )}
              </div>
              <div className="form-group" style={{ width: '88px' }}>
                <label className="label">Кол-во</label>
                <input
                  type="number"
                  min={1}
                  value={row.quantity}
                  onChange={(e) => addOrderUpdateRow(index, 'quantity', e.target.value)}
                  className="form-control"
                />
              </div>
              <div className="form-group" style={{ width: '120px' }}>
                <label className="label">Цена за ед., ₽</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={row.price}
                  onChange={(e) => addOrderUpdateRow(index, 'price', e.target.value)}
                  className="form-control"
                  placeholder="0"
                />
              </div>
              <div className="form-group" style={{ flexShrink: 0 }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() => addOrderRemoveRow(index)}
                  disabled={addOrderItems.length <= 1}
                  title={addOrderItems.length <= 1 ? 'Должна остаться хотя бы одна строка' : 'Удалить строку'}
                >
                  ✕
                </Button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '12px', marginTop: '16px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Button type="button" variant="secondary" size="small" onClick={addOrderAddRow}>
              + Добавить товар
            </Button>
            <div style={{ display: 'flex', gap: '12px' }}>
              <Button type="button" variant="secondary" onClick={() => setAddOrderOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" variant="primary" disabled={addOrderLoading}>
                {addOrderLoading ? 'Добавление...' : 'Добавить заказ'}
              </Button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!procurementModalRow}
        onClose={closeProcurementModal}
        title={
          procurementModalBulkSourceRows && procurementModalBulkSourceRows.length > 0
            ? `Закупка: выбрано строк — ${procurementModalBulkSourceRows.length}`
            : 'Закупка по заказу'
        }
        size="large"
      >
        {procurementModalRow && (
          <div className="orders-procurement-modal">
            {procurementModalErr && (
              <div className="error" style={{ marginBottom: 12 }}>
                {procurementModalErr}
              </div>
            )}
            {procurementModalLoading ? (
              <div className="loading">Загрузка закупок и поставщиков…</div>
            ) : (
              <>
                <p className="muted" style={{ marginBottom: 12 }}>
                  {procurementModalBulkSourceRows && procurementModalBulkSourceRows.length > 0 ? (
                    <>
                      Строк в списке: <strong>{procurementModalBulkSourceRows.length}</strong>
                      {' · '}
                      Уникальных заказов МП:{' '}
                      <strong>{uniqueMarketplaceOrdersFromBulkRows(procurementModalBulkSourceRows)}</strong>
                      {' · '}
                      Товарных позиций (строк заказов в БД):{' '}
                      <strong>
                        {procurementModalBulkSourceRows.reduce(
                          (n, r) => n + ordersArrayForPurchaseRow(r).length,
                          0
                        )}
                      </strong>
                      {' · '}
                      Всего единиц (Σ «кол-во»):{' '}
                      <strong>{totalOrderUnitsFromBulkRows(procurementModalBulkSourceRows)}</strong>
                      {' · '}
                      Уникальных строк закупки (после объединения по артикулу):{' '}
                      <strong>{procurementEditableLines.length}</strong>
                      {procurementExcludedOnHandCount > 0 ? (
                        <>
                          {' '}
                          · на складе (не закупаем): <strong>{procurementExcludedOnHandCount}</strong>
                        </>
                      ) : null}
                      . Совпадение «заказов МП» и «позиций» бывает, если заказ — одна строка в БД с количеством больше 1. После
                      подтверждения строки попадут в закупку; каждая позиция заказа — в статус «В закупке».
                    </>
                  ) : (
                    <>
                      Заказ <strong>{procurementModalRow.first.orderId}</strong>. Позиции попадут в закупку, затем заказ
                      переведётся в статус «В закупке».
                    </>
                  )}
                </p>
                {!procurementLinesReady ? (
                  <p className="muted" style={{ marginBottom: 16 }}>
                    Подготовка списка и проверка остатков на складе…
                  </p>
                ) : (
                  <>
                    {procurementExcludedOnHandCount > 0 ? (
                      <p className="orders-procurement-stock-hint" style={{ marginBottom: 10 }}>
                        Позиции с пометкой «На складе» уже покрыты остатком или резервом со склада — по умолчанию
                        не попадают в закупку. При необходимости верните строку и укажите количество.
                      </p>
                    ) : null}
                    <table className="table orders-procurement-lines-table" style={{ marginBottom: 16, fontSize: 14 }}>
                      <thead>
                        <tr>
                          <th>Товар</th>
                          <th>Артикул</th>
                          <th>Склад</th>
                          <th className="orders-procurement-th-need">По заказу</th>
                          <th
                            className={`orders-th-sortable orders-procurement-th-qty${procurementPreviewQtySort ? ' orders-th-sortable--active' : ''}`}
                          >
                            <button
                              type="button"
                              className="orders-th-sortable-btn"
                              aria-label={
                                procurementPreviewQtySort == null
                                  ? 'Сортировать по количеству к закупке по возрастанию'
                                  : procurementPreviewQtySort === 'asc'
                                    ? 'Сортировать по количеству к закупке по убыванию'
                                    : 'Сбросить сортировку по количеству'
                              }
                              onClick={() =>
                                setProcurementPreviewQtySort((prev) =>
                                  prev == null ? 'asc' : prev === 'asc' ? 'desc' : null
                                )
                              }
                            >
                              К закупке
                              {procurementPreviewQtySort === 'asc' ? ' ↑' : ''}
                              {procurementPreviewQtySort === 'desc' ? ' ↓' : ''}
                            </button>
                          </th>
                          <th className="orders-procurement-th-actions" aria-label="Действия" />
                        </tr>
                      </thead>
                      <tbody>
                        {procurementEditableLines.map((line) => {
                          const dimmed = line.excluded;
                          const rowClass = [
                            dimmed ? 'orders-procurement-line--excluded' : '',
                            line.stockStatus === 'on_hand' && !dimmed ? 'orders-procurement-line--on-hand' : '',
                            line.stockStatus === 'partial' && !dimmed ? 'orders-procurement-line--partial' : '',
                          ]
                            .filter(Boolean)
                            .join(' ');
                          return (
                            <tr key={line.lineKey} className={rowClass || undefined}>
                              <td>{line.name}</td>
                              <td>{line.article}</td>
                              <td className="orders-procurement-stock-cell">
                                {line.stockStatus === 'on_hand' ? (
                                  <span
                                    className="orders-procurement-stock-badge orders-procurement-stock-badge--on-hand"
                                    title={`На складе: ${line.onHand}, по заказу: ${line.orderNeed}`}
                                  >
                                    На складе
                                  </span>
                                ) : line.stockStatus === 'partial' ? (
                                  <span
                                    className="orders-procurement-stock-badge orders-procurement-stock-badge--partial"
                                    title={`На складе ${line.onHand}, покрыто ${line.covered} из ${line.orderNeed}`}
                                  >
                                    Частично
                                  </span>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                              <td className="orders-procurement-need-cell">{line.orderNeed}</td>
                              <td className="orders-procurement-qty-cell">
                                {dimmed ? (
                                  <span className="text-muted">—</span>
                                ) : (
                                  <input
                                    type="number"
                                    className="form-control orders-procurement-qty-input"
                                    min={0}
                                    max={9999}
                                    value={line.quantity}
                                    onChange={(e) => setProcurementLineQuantity(line.lineKey, e.target.value)}
                                    aria-label={`Количество к закупке: ${line.article || line.name}`}
                                  />
                                )}
                              </td>
                              <td className="orders-procurement-actions-cell">
                                {dimmed ? (
                                  <button
                                    type="button"
                                    className="orders-procurement-restore-btn"
                                    onClick={() => restoreProcurementLine(line.lineKey)}
                                  >
                                    Вернуть
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="orders-procurement-remove-btn"
                                    title="Убрать из закупки"
                                    aria-label={`Убрать из закупки: ${line.article || line.name}`}
                                    onClick={() => removeProcurementLine(line.lineKey)}
                                  >
                                    ×
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {procurementDisplayLines.length === 0 && procurementLinesReady ? (
                      <p className="muted" style={{ marginBottom: 12 }}>
                        Нет активных позиций для закупки. Верните строку из списка или измените количество.
                      </p>
                    ) : null}
                  </>
                )}

                {procurementDraftPurchases.length > 0 && (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="procurementChoice"
                          checked={procurementChoice === 'existing'}
                          onChange={() => setProcurementChoice('existing')}
                        />
                        <span>Добавить в существующую закупку</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="procurementChoice"
                          checked={procurementChoice === 'new'}
                          onChange={() => setProcurementChoice('new')}
                        />
                        <span>Новая закупка</span>
                      </label>
                    </div>
                    {procurementChoice === 'existing' && (
                      <select
                        className="form-control"
                        style={{ marginTop: 8, maxWidth: 420 }}
                        value={procurementExistingId}
                        onChange={(e) => setProcurementExistingId(e.target.value)}
                      >
                        {procurementDraftPurchases.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            №{p.id} · {fmtPurchaseDraftLabel(p)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {procurementChoice === 'new' && (
                  <>
                    <p className="muted" style={{ marginBottom: 10, fontSize: 14 }}>
                      Для новой закупки укажите поставщика, организацию (получателя) и склад назначения — так же, как в разделе «Закупки».
                    </p>
                    <div className="form-group" style={{ marginBottom: 12 }}>
                      <label className="label">Поставщик *</label>
                      <select
                        className="form-control"
                        style={{ maxWidth: 420 }}
                        value={procurementSupplierId}
                        onChange={(e) => setProcurementSupplierId(e.target.value)}
                      >
                        <option value="">— Выберите поставщика —</option>
                        {procurementSuppliers.map((s) => (
                          <option key={s.id} value={String(s.id)}>
                            {s.name || `Поставщик №${s.id}`}
                          </option>
                        ))}
                      </select>
                      {procurementSuppliers.length === 0 && (
                        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                          Поставщиков нет. Создайте карточку в разделе «Поставщики».
                        </p>
                      )}
                    </div>
                    <div className="form-group" style={{ marginBottom: 12 }}>
                      <label className="label">Получатель (организация) *</label>
                      <select
                        className="form-control"
                        style={{ maxWidth: 420 }}
                        value={procurementOrganizationId}
                        onChange={async (e) => {
                          const v = e.target.value;
                          setProcurementOrganizationId(v);
                          setProcurementWarehouseId('');
                          try {
                            await loadWarehouses(v);
                          } catch {
                            // ошибка в хуке
                          }
                        }}
                      >
                        <option value="">— Выберите организацию —</option>
                        {(organizations || []).map((o) => (
                          <option key={o.id} value={String(o.id)}>
                            {o.name || `Организация №${o.id}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 16 }}>
                      <label className="label">Склад назначения *</label>
                      <select
                        className="form-control"
                        style={{ maxWidth: 420 }}
                        value={procurementWarehouseId}
                        onChange={(e) => setProcurementWarehouseId(e.target.value)}
                      >
                        <option value="">— Выберите склад —</option>
                        {procurementWarehouseOptions.map((w) => (
                          <option key={w.id} value={String(w.id)}>
                            {w.name || w.address || w.city || `Склад №${w.id}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button variant="primary" onClick={submitProcurementFromOrder} disabled={!!procurementLoadingKey}>
                    {procurementLoadingKey ? '…' : 'Создать / добавить и перевести в закупку'}
                  </Button>
                  <Button variant="secondary" onClick={closeProcurementModal} disabled={!!procurementLoadingKey}>
                    Отмена
                  </Button>
                  <Link to="/stock-levels/purchases" className="order-detail-row-link" style={{ fontSize: 14 }}>
                    Все закупки →
                  </Link>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!detailModalRow}
        onClose={() => setDetailModalRow(null)}
        title={detailModalRow ? `Заказ ${marketplaceOrderIdForApi(detailModalRow.orders ?? [detailModalRow.first], detailModalRow.first.marketplace)} (${allMarketplaces.find(m => m.code === detailModalRow.first.marketplace)?.name ?? detailModalRow.first.marketplace})` : 'Заказ'}
        size="large"
      >
        {detailModalRow && (
          <div className="order-detail-modal-body">
            {detailModalLoading && (
              <div className="loading">Загрузка деталей заказа...</div>
            )}
            {!detailModalLoading && detailModalError && (
              <div className="error" style={{ marginBottom: 16 }}>{detailModalError}</div>
            )}
            {!detailModalLoading &&
              detailModalData &&
              ['ozon', 'wildberries', 'wb', 'yandex'].includes(detailModalData.marketplace) && (
                <OrderDetailContent
                  data={detailModalData}
                  orderId={marketplaceOrderIdForApi(detailModalRow.orders ?? [detailModalRow.first], detailModalRow.first.marketplace)}
                  onReserveChange={(r) => {
                    setDetailModalData((d) => (d ? { ...d, reserve: r } : d));
                    reloadOrders({ silent: true });
                  }}
                />
              )}
            {!detailModalLoading &&
              (!detailModalData ||
                detailModalError ||
                !['ozon', 'wildberries', 'wb', 'yandex'].includes(detailModalRow.first.marketplace)) && (
                <OrderSummaryFromList
                  orders={detailModalRow.orders}
                  marketplace={detailModalRow.first.marketplace}
                  onReserveChange={() => reloadOrders({ silent: true })}
                />
              )}
          </div>
        )}
      </Modal>

      {syncError && (
        <div className="error" style={{marginBottom: '16px'}}>
          {syncError}
        </div>
      )}

      {syncInfo && (
        <div className="info" style={{marginBottom: '16px'}}>
          {syncInfo.rateLimited
            ? `Слишком частые запросы. Подождите ${syncInfo.retryAfterSeconds} секунд.`
            : syncInfo.message || 'Синхронизация завершена. Список обновлён.'}
        </div>
      )}

      {refreshError && (
        <div className="error" style={{marginBottom: '16px'}}>
          {refreshError}
        </div>
      )}

      {assemblyMessage && (
        <div className={assemblyMessage.startsWith('Ошибка') ? 'error' : 'info'} style={{marginBottom: '16px'}}>
          {assemblyMessage}
        </div>
      )}

      <div style={{marginTop: '20px'}}>
        <div className="erp-filter-row erp-filter-row--search" role="group" aria-label="Фильтр по маркетплейсу">
          <button
            type="button"
            className={`erp-filter-btn${marketplaceFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setMarketplaceFilter('all')}
          >
            Все
            <span className="erp-filter-btn__count">{mpFilterRowTotal}</span>
          </button>
          {allMarketplaces.map((mp) => (
            <button
              key={mp.code}
              type="button"
              className={`erp-filter-btn${marketplaceFilter === mp.code ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setMarketplaceFilter(mp.code)}
              title={mp.name}
              aria-label={`${mp.name}, ${countsByMarketplace[mp.code] ?? 0} заказов`}
            >
              {mp.badgeClass && mp.shortLabel ? (
                <span className={`mp-badge ${mp.badgeClass}`}>{mp.shortLabel}</span>
              ) : (
                <span aria-hidden>{mp.icon}</span>
              )}
              <span className="erp-filter-btn__label">{mp.name}</span>
              <span className="erp-filter-btn__count">{countsByMarketplace[mp.code] ?? 0}</span>
            </button>
          ))}

          <div className="erp-filter-search-wrap">
            <input
              type="text"
              value={orderSearchQuery}
              onChange={(e) => setOrderSearchQuery(e.target.value)}
              placeholder="Поиск по номеру заказа..."
              className="form-control"
              style={{ maxWidth: 420, width: '100%' }}
            />
            {orderSearchQuery.trim() && (
              <Button
                variant="secondary"
                size="small"
                onClick={() => setOrderSearchQuery('')}
                title="Очистить поиск"
              >
                ✕
              </Button>
            )}
          </div>
        </div>

        <div className="erp-filter-row" role="group" aria-label="Фильтр по статусу заказа">
          {statusFilterOptions.map((st) => (
            <button
              key={st}
              type="button"
              className={`erp-filter-btn${statusFilter === st ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setStatusFilter(st)}
            >
              <span className="erp-filter-btn__label">{getOrderStatusLabel(st)}</span>
              <span className="erp-filter-btn__count">{countsByStatus[st] ?? 0}</span>
            </button>
          ))}
          <button
            type="button"
            className={`erp-filter-btn${statusFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            <span className="erp-filter-btn__label">Все заказы</span>
            <span className="erp-filter-btn__count">{countsByStatus.all ?? 0}</span>
          </button>
        </div>

        {renderOrdersListPager('top')}

        <div className="orders-list" style={{marginTop: '16px'}}>
        {!loading && sortedGroupedDisplayRows.length === 0 ? (
          <div className="empty-state">
            <p>Заказы не найдены</p>
          </div>
        ) : (
          <>
            <table className="orders-table table">
            <thead>
              <tr>
                <th className="orders-col-checkbox">
                  <label className="orders-checkbox-label">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      title={allFilteredSelected ? 'Снять выделение' : 'Выбрать все'}
                    />
                    <span className="orders-checkbox-caption">Все</span>
                  </label>
                </th>
                <th className="orders-col-num">№</th>
                <th className="orders-col-mp" title="Маркетплейс">
                  МП
                </th>
                <th>ID заказа</th>
                <th>Появился</th>
                <th>Товары</th>
                <th
                  className={`orders-th-sortable${sortByArticle ? ' orders-th-sortable--active' : ''}`}
                >
                  <button
                    type="button"
                    className="orders-th-sortable-btn"
                    aria-label={
                      sortByArticle == null
                        ? 'Включить сортировку по артикулу по возрастанию'
                        : sortByArticle === 'asc'
                          ? 'Сортировка по возрастанию. Переключить на убывание'
                          : 'Сортировка по убыванию. Сбросить сортировку'
                    }
                    onClick={() =>
                      setSortByArticle((prev) => (prev == null ? 'asc' : prev === 'asc' ? 'desc' : null))
                    }
                    title={
                      sortByArticle == null
                        ? 'Нажмите: сортировать А→Я по артикулу'
                        : sortByArticle === 'asc'
                          ? 'Сейчас А→Я. Нажмите — Я→А'
                          : 'Сейчас Я→А. Нажмите — порядок как с сервера'
                    }
                  >
                    Артикул
                    {sortByArticle === 'asc' ? ' ↑' : ''}
                    {sortByArticle === 'desc' ? ' ↓' : ''}
                  </button>
                </th>
                <th>Количество</th>
                <th>Цена</th>
                {showStickerColumn ? <th>Стикер</th> : null}
                {showShipmentColumn ? <th>Поставка</th> : null}
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroupedDisplayRows.map((row, idx) => {
                const { first, orders: groupOrders, isGroup } = row;
                const keys = groupOrders.map(orderKey);
                const checked = keys.every(k => selectedKeys.has(k));
                const orderIdDisplay = !isGroup ? first.orderId : (first.orderGroupId || first.orderId);
                const productsDisplay = isGroup
                  ? groupOrders.map(o => o.productName || o.product_name || '—').join('; ')
                  : (first.productName || first.product_name || '—');
                const articlesDisplay = orderArticleLabel(first);
                const lineQty = (o) => {
                  const n = Number(o?.quantity);
                  return Number.isFinite(n) && n > 0 ? n : 1;
                };
                const mergedGroupLines = (() => {
                  if (!isGroup) return [];
                  const byKey = new Map();
                  for (const o of groupOrders || []) {
                    const name = o?.productName || o?.product_name || '—';
                    const article = orderArticleLabel(o);
                    const pidRaw = o?.productId ?? o?.product_id;
                    const pid = pidRaw != null && pidRaw !== '' ? Number(pidRaw) : NaN;
                    const hasPid = Number.isFinite(pid) && pid > 0;
                    const artNorm = String(article || '').trim().toUpperCase();
                    const nameNorm = String(name || '').trim().toLowerCase();
                    // Для WB одна «корзина» может прийти несколькими строками.
                    // Склеиваем в UI в первую очередь по артикулу (он наиболее стабильный для пользователя),
                    // а productId используем как fallback.
                    const key =
                      artNorm && artNorm !== '—'
                        ? `a:${artNorm}`
                        : hasPid
                          ? `p:${pid}`
                          : `n:${nameNorm || '_'}`;
                    const cur = byKey.get(key);
                    const add = lineQty(o);
                    if (!cur) byKey.set(key, { name, article, quantity: add });
                    else byKey.set(key, { ...cur, quantity: (cur.quantity || 0) + add });
                  }
                  return [...byKey.values()];
                })();
                const sq = Number(first?.quantity);
                const singleQty = Number.isFinite(sq) && sq > 0 ? sq : 1;
                const groupRowTitle = isGroup
                  ? groupOrders
                      .map(
                        (o) =>
                          `${o.productName || o.product_name || '—'} · ${orderArticleLabel(o)} · ${lineQty(o)} шт.`
                      )
                      .join('\n')
                  : undefined;
                const priceDisplay = isGroup ? '—' : first.price;
                // Раньше показывали "✓ Есть на складе" по hasReserve, но это вводило в заблуждение:
                // резерв может быть за счёт incoming (в пути) или быть частичным.
                // Для "Новый" показываем только прогресс резерва X/Y.
                const reservedQty = isGroup
                  ? groupOrders.reduce(
                      (s, o) => s + (Number(o.reservedQty ?? o.reserved_qty) || 0),
                      0
                    )
                  : Number(first.reservedQty ?? first.reserved_qty ?? 0) || 0;
                const lineNeed = (o) =>
                  Math.max(1, Number(o.needQty ?? o.need_qty ?? o.quantity) || 1);
                const needQty = isGroup
                  ? groupOrders.reduce((s, o) => s + lineNeed(o), 0)
                  : lineNeed(first);
                const showReserveCell = reservedQty > 0;
                const reserveCoverageKind = isGroup
                  ? groupReserveCoverageKind(groupOrders)
                  : groupReserveCoverageKind([first]);
                const stickerDisplay = (() => {
                  if (isGroup) {
                    const asmLines = groupOrders.filter((o) => isAssemblyLikeStatus(o.status));
                    if (!asmLines.length) return '—';
                    const mp = normalizeMarketplaceForUI(first.marketplace);
                    if (mp === 'wildberries') {
                      return orderStickerCellValue(first, { groupOrders: asmLines });
                    }
                    const ids = [
                      ...new Set(
                        asmLines
                          .map((o) =>
                            String(o.orderGroupId ?? o.order_group_id ?? o.orderId ?? '').trim()
                          )
                          .filter(Boolean)
                      ),
                    ];
                    return ids.length ? ids.join(', ') : '—';
                  }
                  return orderStickerCellValue(first);
                })();
                return (
                <tr
                  key={row.key + idx}
                  className={`orders-row-clickable ${checked ? 'orders-row-selected' : ''} ${isGroup ? 'orders-row-multi' : ''}`}
                  onClick={onNavigationClick(() => setDetailModalRow(row), {
                    ignoreClosest:
                      'input, textarea, select, label, .orders-col-checkbox, .orders-col-actions, [data-no-nav-click]',
                  })}
                  title={groupRowTitle ?? 'Открыть карточку заказа'}
                >
                  <td className="orders-col-checkbox" onClick={e => e.stopPropagation()}>
                    <label className="orders-checkbox-label">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelectGroup(row)}
                        onClick={e => e.stopPropagation()}
                      />
                    </label>
                  </td>
                  <td className="orders-col-num">{pageOffset + idx + 1}</td>
                  <td className="orders-col-mp">
                    {(() => {
                      const mpNorm = normalizeMarketplaceForUI(first.marketplace);
                      const meta = allMarketplaces.find((m) => m.code === mpNorm);
                      const label = meta?.name ?? String(first.marketplace ?? '—');
                      if (meta?.badgeClass && meta.shortLabel) {
                        return (
                          <span className={`mp-badge ${meta.badgeClass}`} title={label} aria-label={label}>
                            {meta.shortLabel}
                          </span>
                        );
                      }
                      return (
                        <span className="mp-badge mp-unknown" title={label} aria-label={label}>
                          ?
                        </span>
                      );
                    })()}
                  </td>
                  <td>{orderIdDisplay}</td>
                  <td
                    className="orders-col-date"
                    title={first.createdAt ? new Date(first.createdAt).toLocaleString() : ''}
                  >
                    {formatMarketplaceDate(first.createdAt)}
                  </td>
                  <td
                    className="orders-col-products"
                    title={isGroup ? productsDisplay : String(productsDisplay || '')}
                  >
                    {isGroup ? (
                      <div className="orders-stacked-lines">
                        {mergedGroupLines.map((o, i) => (
                          <div key={i} className="orders-stacked-line orders-stacked-line--product">
                            <span className="orders-product-cell-text" title={o.name || '—'}>
                              {o.name || '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="orders-product-cell-text" title={String(productsDisplay || '')}>
                        {productsDisplay}
                      </span>
                    )}
                  </td>
                  <td className="orders-col-article">
                    {isGroup ? (
                      <div className="orders-stacked-lines">
                        {mergedGroupLines.map((o, i) => (
                          <div key={i} className="orders-stacked-line orders-stacked-line--ellipsis" title={o.article}>
                            {o.article}
                          </div>
                        ))}
                      </div>
                    ) : (
                      articlesDisplay
                    )}
                  </td>
                  <td className="orders-col-qty">
                    {isGroup ? (
                      <>
                        <div className="orders-stacked-lines orders-stacked-lines--qty">
                          {mergedGroupLines.map((o, i) => (
                            <div key={i} className="orders-stacked-line">{o.quantity}</div>
                          ))}
                        </div>
                        {showReserveCell ? (
                          <div className="orders-qty-reserve-footer">
                            <span
                              className={reserveBadgeClassName(reserveCoverageKind)}
                              title={formatOrderReserveBadgeTitle({
                                reservedQty,
                                needQty,
                                orders: groupOrders,
                                isGroup,
                                coverageKind: reserveCoverageKind,
                              })}
                            >
                              рез. {reservedQty}/{needQty}
                            </span>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <OrderQuantityWithReserve
                        qty={singleQty}
                        reservedQty={reservedQty}
                        needQty={needQty}
                        coverageKind={reserveCoverageKind}
                        groupOrders={groupOrders}
                        isGroup={isGroup}
                      />
                    )}
                  </td>
                  <td>{priceDisplay}</td>
                  {showStickerColumn ? (
                    <td className="orders-col-sticker" title={stickerDisplay !== '—' ? stickerDisplay : ''}>
                      {stickerDisplay}
                    </td>
                  ) : null}
                  {showShipmentColumn && first.status === 'assembled' ? (
                    <td className="orders-col-shipment" title={first.localShipmentName || ''}>
                      {first.localShipmentName ? (
                        <span>
                          {first.localShipmentClosed ? '✓ ' : ''}
                          {first.localShipmentName}
                        </span>
                      ) : orderSupportsFbsShipment(first.marketplace) ? (
                        <span className="text-muted">—</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  ) : showShipmentColumn ? (
                    <td className="orders-col-shipment">—</td>
                  ) : null}
                  <td className="orders-col-actions" onClick={e => e.stopPropagation()}>
                    <div className="orders-actions">
                      {showReserveCell && reservedQty > 0 && (
                        <Button
                          variant="secondary"
                          size="small"
                          className="orders-action-icon"
                          onClick={() => handleReleaseReserve(first.marketplace, first.orderId, row.key)}
                          disabled={
                            releaseReserveLoadingKey === row.key ||
                            procurementLoadingKey === row.key ||
                            cancelOrderLoadingKey === row.key
                          }
                          title="Снять весь резерв по заказу"
                          aria-label="Снять резерв"
                        >
                          {releaseReserveLoadingKey === row.key ? (
                            <span className="orders-action-icon__busy" aria-hidden>…</span>
                          ) : (
                            <i className="pe-7s-unlock" aria-hidden />
                          )}
                        </Button>
                      )}
                      {groupOrders.some((o) =>
                        isOrderStatusEligibleForProcurement(o.marketplace, o.status)
                      ) && (
                        <Button
                          variant="secondary"
                          size="small"
                          className="orders-action-icon"
                          onClick={() => handleSetToProcurement(first.marketplace, first.orderId, row.key)}
                          disabled={
                            procurementLoadingKey === row.key ||
                            procurementLoadingKey === '__bulk__' ||
                            cancelOrderLoadingKey === row.key
                          }
                          title="Перевести заказ в статус «В закупке»"
                          aria-label="В закупке"
                        >
                          {procurementLoadingKey === row.key ? (
                            <span className="orders-action-icon__busy" aria-hidden>…</span>
                          ) : (
                            <i className="pe-7s-cart" aria-hidden />
                          )}
                        </Button>
                      )}
                      {orderCanShowCancel(first.marketplace, first.status) && (
                        <Button
                          variant="danger"
                          size="small"
                          className="orders-action-icon"
                          onClick={() => handleCancelOrder(first.marketplace, first.orderId, row.key)}
                          disabled={
                            cancelOrderLoadingKey === row.key ||
                            returnToNewLoadingKey === row.key ||
                            procurementLoadingKey === row.key ||
                            sendToAssemblyRowKey === row.key
                          }
                          title="Отменить заказ на маркетплейсе (если доступно по API) и в системе"
                          aria-label="Отменить заказ"
                        >
                          {cancelOrderLoadingKey === row.key ? (
                            <span className="orders-action-icon__busy" aria-hidden>…</span>
                          ) : (
                            <i className="pe-7s-close" aria-hidden />
                          )}
                        </Button>
                      )}
                      {first.status === 'in_procurement' && (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            className="orders-action-icon"
                            onClick={() => handleReturnToNew(first.marketplace, first.orderId, row.key)}
                            disabled={returnToNewLoadingKey === row.key}
                            title="Вернуть заказ в статус «Новый»"
                            aria-label="Вернуть в «Новый»"
                          >
                            {returnToNewLoadingKey === row.key ? (
                              <span className="orders-action-icon__busy" aria-hidden>…</span>
                            ) : (
                              <i className="pe-7s-back" aria-hidden />
                            )}
                          </Button>
                          <Button
                            variant="primary"
                            size="small"
                            className="orders-action-icon"
                            onClick={() => handleSendOneToAssembly(row)}
                            disabled={sendToAssemblyRowKey === row.key}
                            title="Отправить заказ на сборку"
                            aria-label="На сборку"
                          >
                            {sendToAssemblyRowKey === row.key ? (
                              <span className="orders-action-icon__busy" aria-hidden>…</span>
                            ) : (
                              <i className="pe-7s-box2" aria-hidden />
                            )}
                          </Button>
                        </>
                      )}
                      {(first.status === 'in_assembly' || first.status === 'assembled') && (
                        <Button
                          variant="secondary"
                          size="small"
                          className="orders-action-icon"
                          onClick={() => handleReturnToNew(first.marketplace, first.orderId, row.key)}
                          disabled={returnToNewLoadingKey === row.key}
                          title="Вернуть заказ в статус «Новый»"
                          aria-label="Вернуть в новые"
                        >
                          {returnToNewLoadingKey === row.key ? (
                            <span className="orders-action-icon__busy" aria-hidden>…</span>
                          ) : (
                            <i className="pe-7s-back" aria-hidden />
                          )}
                        </Button>
                      )}
                      {orderCanAddToOpenShipment(first) && (
                        <Button
                          variant="primary"
                          size="small"
                          className="orders-action-icon"
                          onClick={() => handleSendOneToAssembly(row)}
                          disabled={sendToAssemblyRowKey === row.key}
                          title="Добавить в открытую поставку FBS (статус «Собран» не меняется)"
                          aria-label="В поставку"
                        >
                          {sendToAssemblyRowKey === row.key ? (
                            <span className="orders-action-icon__busy" aria-hidden>…</span>
                          ) : (
                            <i className="pe-7s-box2" aria-hidden />
                          )}
                        </Button>
                      )}
                      {first.marketplace === 'manual' && (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            className="orders-action-icon"
                            onClick={() => handleMarkShipped(first.marketplace, first.orderId, row.key)}
                            disabled={markShippedLoadingKey === row.key || deleteLoadingKey === row.key || returnToNewLoadingKey === row.key}
                            title={`Поставить статус «${getOrderStatusLabel('shipped')}» (для тестирования)`}
                            aria-label={getOrderStatusLabel('shipped')}
                          >
                            {markShippedLoadingKey === row.key ? (
                              <span className="orders-action-icon__busy" aria-hidden>…</span>
                            ) : (
                              <i className="pe-7s-plane" aria-hidden />
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            className="orders-action-icon"
                            onClick={() => handleDeleteOrder(first.marketplace, first.orderId, row.key)}
                            disabled={markShippedLoadingKey === row.key || deleteLoadingKey === row.key || returnToNewLoadingKey === row.key}
                            title="Удалить заказ"
                            aria-label="Удалить заказ"
                          >
                            {deleteLoadingKey === row.key ? (
                              <span className="orders-action-icon__busy" aria-hidden>…</span>
                            ) : (
                              <i className="pe-7s-trash" aria-hidden />
                            )}
                          </Button>
                        </>
                      )}
                      {!orderRowHasAnyAction(first) && (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
            {renderOrdersListPager('bottom')}
          </>
        )}
        </div>
      </div>
    </div>
  );
}



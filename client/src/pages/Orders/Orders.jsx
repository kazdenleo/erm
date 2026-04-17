/**
 * Orders Page
 * Страница управления заказами: выбор заказов и отправка на сборку
 */

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOrders } from '../../hooks/useOrders';
import { ordersApi } from '../../services/orders.api';
import { productsApi } from '../../services/products.api';
import { purchasesApi } from '../../services/purchases.api';
import { suppliersApi } from '../../services/suppliers.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import {
  orderStatusLabels,
  getOrderStatusLabel,
  isOrderStatusEligibleForProcurement,
} from '../../constants/orderStatuses';
import { OrderDetailContent, OrderSummaryFromList } from './OrderDetail';
import {
  normalizeMarketplaceForUI,
  orderGroupKey,
  singleOrderListGroupKey
} from '../../utils/orderListGroupKey';
import './Orders.css';
import './OrderDetail.css';

function orderKey(o) {
  const mp = normalizeMarketplaceForUI(o.marketplace);
  return `${mp}|${o.orderId ?? ''}`;
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

/** Выделенные заказы с полным разворотом групп (все строки БД), как для «Отправить на сборку» */
function expandSelectedOrdersForBulkActions(filteredOrders, selectedKeys) {
  const toSend = [];
  const added = new Set();
  for (const o of filteredOrders) {
    if (!selectedKeys.has(orderKey(o))) continue;
    const gid = orderGroupKey(o);
    if (gid) {
      for (const g of filteredOrders) {
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

function orderRowHasAnyAction(first) {
  if (first.status === 'new') return true;
  if (orderCanShowCancel(first.marketplace, first.status)) return true;
  if (first.status === 'in_procurement') return true;
  if (first.status === 'in_assembly' || first.status === 'assembled') return true;
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
    const data = await productsApi.getAll({ cacheBust: true });
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

export function Orders() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const allowPrivateOrders = profile?.allow_private_orders === true;
  const { orders, meta, loading, error, loadOrders } = useOrders({ autoLoad: false });
  const ORDERS_PAGE_SIZE = 50;
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
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  /** null — порядок с сервера; asc/desc — по минимальному артикулу в группе */
  const [sortByArticle, setSortByArticle] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [markShippedLoadingKey, setMarkShippedLoadingKey] = useState(null);
  const [deleteLoadingKey, setDeleteLoadingKey] = useState(null);
  const [returnToNewLoadingKey, setReturnToNewLoadingKey] = useState(null);
  const [cancelOrderLoadingKey, setCancelOrderLoadingKey] = useState(null);
  const [procurementLoadingKey, setProcurementLoadingKey] = useState(null);
  /** Сброс нативного select «Статус в системе» после применения */
  const [bulkErmStatusKey, setBulkErmStatusKey] = useState(0);
  const [bulkLocalErmStatusLoading, setBulkLocalErmStatusLoading] = useState(false);
  const [sendToAssemblyRowKey, setSendToAssemblyRowKey] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [assemblyLoading, setAssemblyLoading] = useState(false);
  const [assemblyMessage, setAssemblyMessage] = useState(null);
  const [addOrderOpen, setAddOrderOpen] = useState(false);
  const [addOrderCustomerName, setAddOrderCustomerName] = useState('');
  const [addOrderCustomerPhone, setAddOrderCustomerPhone] = useState('');
  const [addOrderItems, setAddOrderItems] = useState([{ productId: '', quantity: 1, price: '' }]);
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
  /** Сортировка таблицы позиций в модалке закупки по количеству */
  const [procurementPreviewQtySort, setProcurementPreviewQtySort] = useState(null);

  const procurementMergedPreviewLines = useMemo(() => {
    if (!procurementModalRow) return [];
    const lines = mergePurchaseLinesByArticle(purchaseLinesFromDisplayRow(procurementModalRow));
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
  }, [procurementModalRow, procurementPreviewQtySort]);

  useEffect(() => {
    setProcurementPreviewQtySort(null);
  }, [procurementModalRow?.key]);

  useEffect(() => {
    if (!allowPrivateOrders) {
      setMarketplaceFilter((f) => (f === 'manual' ? 'all' : f));
      setAddOrderOpen(false);
    }
  }, [allowPrivateOrders]);

  useEffect(() => {
    if (addOrderOpen && productsList.length === 0) {
      productsApi.getAll().then((data) => {
        const list = Array.isArray(data) ? data : data?.data ?? data?.products ?? [];
        setProductsList(list);
      }).catch(() => setProductsList([]));
    }
  }, [addOrderOpen, productsList.length]);

  const buildOrdersListParams = useCallback((page = currentPage) => {
    const params = {
      limit: ORDERS_PAGE_SIZE,
      offset: Math.max(0, page - 1) * ORDERS_PAGE_SIZE,
    };
    if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
    if (statusFilter !== 'all') params.status = statusFilter;
    const query = String(orderSearchQuery || '').trim();
    if (query) params.search = query;
    return params;
  }, [currentPage, marketplaceFilter, statusFilter, orderSearchQuery]);

  const reloadOrders = useCallback(async (options = {}) => {
    const page = options.page ?? currentPage;
    const params = {
      ...buildOrdersListParams(page),
      ...(options.params || {}),
    };
    return await loadOrders({
      ...options,
      params,
    });
  }, [buildOrdersListParams, currentPage, loadOrders]);

  useEffect(() => {
    reloadOrders();
  }, [reloadOrders]);

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
    const { first, orders: groupOrders } = detailModalRow;
    const marketplace = first.marketplace;
    const orderId = first.orderId;
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
    ordersApi.getOrderDetail(marketplace, orderId)
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

  const runSync = useCallback(
    async (silent = false, opts = {}) => {
      const forceImport = opts.force === true;
      try {
        if (!silent) {
          setSyncLoading(true);
          setSyncKind(forceImport ? 'import' : 'refresh');
          setSyncError(null);
          setSyncInfo(null);
        }
        const result = await ordersApi.syncFbs({ force: forceImport });
        if (!silent) setSyncInfo(result);
        await reloadOrders({ silent: true });
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
          } else if (!e.response) {
            setSyncError(`Нет связи с сервером: ${e.message || 'сетевая ошибка'}. Проверьте, что бэкенд запущен и доступен по адресу ${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}.`);
          } else {
            setSyncError(msg || `Ошибка синхронизации${status ? ` (${status})` : ''}`);
          }
        }
      } finally {
        if (!silent) {
          setSyncLoading(false);
          setSyncKind(null);
        }
      }
    },
    [reloadOrders]
  );

  const handleSync = () => runSync(false, { force: false });
  const handleImportOrders = () => runSync(false, { force: true });

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

  // Фон на сервере подтягивает заказы в БД (ORDERS_FBS_SYNC_CRON). На клиенте: через 2 с — тихий sync;
  // далее каждые 2 мин GET /orders. Пока включена пауза — таймеры не ставим (статусы не «прыгают» во время сборки).
  useEffect(() => {
    if (!ordersAutoSyncPauseLoaded || ordersAutoSyncPaused) return undefined;
    let mounted = true;
    const POLL_MS = 2 * 60 * 1000;

    const t0 = setTimeout(() => {
      if (!mounted) return;
      runSync(true, { force: false });
    }, 2000);

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
    setProcurementModalLoading(true);
    try {
      const [drafts, supRes] = await Promise.all([
        purchasesApi.list({ limit: 100 }),
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
  };

  const submitProcurementFromOrder = async () => {
    if (!procurementModalRow) return;
    let lines = purchaseLinesFromDisplayRow(procurementModalRow);
    lines = await resolvePurchaseLinesByCatalogSku(lines);
    const missingCatalog = lines.filter((l) => !l.productId);
    if (missingCatalog.length > 0) {
      const names = missingCatalog.map((l) => l.article || l.name || '?').join(', ');
      setProcurementModalErr(
        `Не удалось определить товар в каталоге для: ${names}. Убедитесь, что в карточке товара указан такой же артикул (SKU), либо добавьте сопоставление SKU маркетплейса в каталоге. Обновите список заказов после правок.`
      );
      return;
    }
    const merged = mergePurchaseLinesByArticle(lines);
    const items = merged.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      sourceOrders: l.sourceOrders ?? [],
    }));
    if (items.length === 0) {
      setProcurementModalErr('Нет позиций для закупки');
      return;
    }
    if (procurementChoice === 'existing') {
      const pid = parseInt(procurementExistingId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        setProcurementModalErr('Выберите существующую закупку');
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
      if (procurementChoice === 'existing') {
        const pid = parseInt(procurementExistingId, 10);
        await purchasesApi.appendDraftItems(pid, { items });
      } else {
        const sidRaw = procurementSupplierId === '' ? null : parseInt(procurementSupplierId, 10);
        const supplierId = sidRaw != null && !Number.isNaN(sidRaw) && sidRaw > 0 ? sidRaw : null;
        const note =
          sourceRows.length > 1
            ? `Из заказов (${sourceRows.length}): ${sourceRows.map((r) => r.first.orderId).join(', ')}`
            : `Из заказа ${first.orderId} (${first.marketplace})`;
        await purchasesApi.create({
          supplierId,
          items,
          note,
        });
      }
      const seenProcKeys = new Set();
      for (const r of sourceRows) {
        for (const o of ordersArrayForPurchaseRow(r)) {
          const dk = procurementStatusUpdateDedupeKey(o);
          if (seenProcKeys.has(dk)) continue;
          seenProcKeys.add(dk);
          if (!isOrderStatusEligibleForProcurement(o.marketplace, o.status)) continue;
          await ordersApi.setToProcurement(o.marketplace, o.orderId);
        }
      }
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const r of sourceRows) {
          for (const o of ordersArrayForPurchaseRow(r)) {
            next.delete(orderKey(o));
          }
        }
        return next;
      });
      closeProcurementModal();
      await reloadOrders({ silent: true });
    } catch (e) {
      console.error('Ошибка «В закупку»:', e);
      const msg = e.response?.data?.message || e.message || 'Не удалось оформить закупку и обновить заказ';
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
    try {
      setSendToAssemblyRowKey(row.key);
      setAssemblyMessage(null);
      setRefreshError(null);
      const result = await ordersApi.sendToAssembly(items);
      const updated = result?.updated ?? items.length;
      let msg = `На сборку отправлено заказов: ${items.length}${result?.updated != null ? ` (обновлено: ${updated})` : ''}.`;
      if (result?.shipments?.length) {
        msg += ` Поставки: ${result.shipments.map(s => `${s.marketplace}: ${s.shipmentName}`).join('; ')}.`;
      }
      setAssemblyMessage(msg);
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
    setAddOrderItems([{ productId: '', quantity: 1, price: '' }]);
    setAddOrderOpen(true);
  };

  const addOrderAddRow = () => {
    setAddOrderItems((prev) => [...prev, { productId: '', quantity: 1, price: '' }]);
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

  const addOrderProductChange = (index, rawProductId) => {
    const productId = rawProductId === '' || rawProductId == null ? '' : Number(rawProductId);
    setAddOrderItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, productId: productId === '' ? '' : productId };
        if (productId !== '' && Number.isFinite(productId)) {
          const p = productsList.find((x) => Number(x.id) === Number(productId));
          if (p) {
            const def = defaultPriceFromProduct(p);
            if (def !== '') next.price = def;
          }
        }
        return next;
      })
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
  
  const uniqueStatuses = Array.from(
    new Set([
      'new',
      'in_procurement',
      'in_assembly',
      'assembled',
      'in_transit',
      'shipped',
      'delivered',
      'cancelled',
      ...orders.map(o => o.status).filter(s => s && s !== 'processing')
    ])
  );

  const filteredOrders = useMemo(() => orders.filter(o => {
    const orderMarketplace = normalizeMarketplaceForUI(o.marketplace);
    const byMarketplace =
      marketplaceFilter === 'all' || orderMarketplace === marketplaceFilter;
    const q = String(orderSearchQuery || '').trim();
    const orderIdStr = String(o.orderId || '');
    const groupIdStr = String(o.orderGroupId || o.order_group_id || '');
    const bySearch = !q || orderIdStr.includes(q) || groupIdStr.includes(q);
    const byStatus = statusFilter === 'all' || o.status === statusFilter;
    return byMarketplace && byStatus && bySearch;
  }), [orders, marketplaceFilter, statusFilter, orderSearchQuery]);

  // Подсчёт количества строк (групп заказов) для кнопок фильтра маркетплейсов.
  // Важно: считаем группы по `orderGroupId`, т.к. один заказ может быть из нескольких товаров.
  const countsByMarketplace = useMemo(() => {
    const ordersByStatus = orders.filter(o => statusFilter === 'all' || o.status === statusFilter);
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

  // Группы по статусу для кнопок статусов — с учётом выбранного маркетплейса (без фильтра по статусу).
  const countsByStatus = useMemo(() => {
    const base = orders.filter((o) => {
      const mp = normalizeMarketplaceForUI(o.marketplace);
      return marketplaceFilter === 'all' || mp === marketplaceFilter;
    });
    const groupToStatus = new Map();
    for (const o of base) {
      const ogk = orderGroupKey(o);
      const gid = ogk || singleOrderListGroupKey(o);
      const st = o.status || 'unknown';
      if (!groupToStatus.has(gid)) groupToStatus.set(gid, st);
    }
    const out = { all: groupToStatus.size };
    for (const st of groupToStatus.values()) {
      out[st] = (out[st] || 0) + 1;
    }
    return out;
  }, [orders, marketplaceFilter]);

  // Группируем заказы с одним order_group_id в одну строку (один заказ — несколько товаров).
  // Маркетплейс нормализуем — иначе две строки одного заказа (wb vs wildberries) не слипаются.
  const groupedDisplayRows = useMemo(() => {
    const byGroup = new Map();
    for (const o of filteredOrders) {
      const mp = normalizeMarketplaceForUI(o.marketplace);
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
  }, [filteredOrders]);

  const sortedGroupedDisplayRows = useMemo(() => {
    if (sortByArticle == null) return groupedDisplayRows;
    const dir = sortByArticle === 'asc' ? 1 : -1;
    const tieBreak = (a, b) => {
      const ta = new Date(a.first.createdAt || 0).getTime();
      const tb = new Date(b.first.createdAt || 0).getTime();
      return tb - ta;
    };
    return [...groupedDisplayRows].sort((a, b) => {
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
  }, [groupedDisplayRows, sortByArticle]);

  const totalOrders = meta?.total ?? orders.length;
  const totalPages = meta?.total != null ? Math.max(1, Math.ceil(meta.total / ORDERS_PAGE_SIZE)) : 1;
  const pageOffset = (meta?.offset ?? Math.max(0, currentPage - 1) * ORDERS_PAGE_SIZE);
  const goToPage = (page) => {
    const next = Math.min(Math.max(1, page), totalPages);
    if (next !== currentPage) setCurrentPage(next);
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

  const filteredKeys = useMemo(() => new Set(filteredOrders.map(orderKey)), [filteredOrders]);
  const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every(o => selectedKeys.has(orderKey(o)));
  const selectedCount = filteredOrders.filter(o => selectedKeys.has(orderKey(o))).length;

  const toggleSelect = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectGroup = (row) => {
    const keys = row.orders.map(orderKey);
    const allSelected = keys.every(k => selectedKeys.has(k));
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allSelected) keys.forEach(k => next.delete(k));
      else keys.forEach(k => next.add(k));
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        filteredKeys.forEach(k => next.delete(k));
        return next;
      });
    } else {
      setSelectedKeys(prev => new Set([...prev, ...filteredKeys]));
    }
  };

  const handleSendToAssembly = async () => {
    // При выборе одного заказа из группы (orderGroupId) отправляем на сборку всю группу
    const toSend = [];
    const added = new Set();
    for (const o of filteredOrders) {
      if (!selectedKeys.has(orderKey(o))) continue;
      const rowGid = orderGroupKey(o);
      if (rowGid) {
        filteredOrders
          .filter((x) => orderGroupKey(x) === rowGid)
          .forEach((g) => {
          const k = orderKey(g);
          if (!added.has(k)) {
            added.add(k);
            toSend.push(g);
          }
        });
      } else {
        const k = orderKey(o);
        if (!added.has(k)) {
          added.add(k);
          toSend.push(o);
        }
      }
    }
    if (toSend.length === 0) return;
    setAssemblyLoading(true);
    setAssemblyMessage(null);
    try {
      const result = await ordersApi.sendToAssembly(toSend.map(o => ({ marketplace: o.marketplace, orderId: o.orderId })));
      const updated = result?.updated ?? toSend.length;
      let msg = `На сборку отправлено заказов: ${toSend.length}${result?.updated != null ? ` (обновлено: ${updated})` : ''}.`;
      if (result?.shipments?.length) {
        msg += ` Поставки: ${result.shipments.map(s => `${s.marketplace}: ${s.shipmentName}`).join('; ')}.`;
      }
      setAssemblyMessage(msg);
      setSelectedKeys(prev => {
        const next = new Set(prev);
        toSend.forEach(o => next.delete(orderKey(o)));
        return next;
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
    const toSend = expandSelectedOrdersForBulkActions(filteredOrders, selectedKeys);
    if (toSend.length === 0 || !targetStatus) return;
    setBulkLocalErmStatusLoading(true);
    setAssemblyMessage(null);
    setRefreshError(null);
    try {
      if (targetStatus === 'new') {
        const reps = representativesForGroupScopedApi(toSend);
        let ok = 0;
        const errors = [];
        for (const o of reps) {
          try {
            await ordersApi.returnToNew(o.marketplace, o.orderId);
            ok += 1;
          } catch (e) {
            errors.push(`${o.orderId}: ${e.response?.data?.message || e.message}`);
          }
        }
        setAssemblyMessage(
          errors.length
            ? `В «Новый» переведено заказов (групп): ${ok}. Ошибки: ${errors.slice(0, 8).join('; ')}`
            : `В «Новый» переведено заказов (групп): ${ok}.`
        );
      } else if (targetStatus === 'in_procurement') {
        const reps = representativesForGroupScopedApi(toSend);
        let ok = 0;
        let skipped = 0;
        const errors = [];
        for (const o of reps) {
          if (!isOrderStatusEligibleForProcurement(o.marketplace, o.status)) {
            skipped += 1;
            continue;
          }
          try {
            await ordersApi.setToProcurement(o.marketplace, o.orderId);
            ok += 1;
          } catch (e) {
            errors.push(`${o.orderId}: ${e.response?.data?.message || e.message}`);
          }
        }
        setAssemblyMessage(
          [
            `В «В закупке» переведено: ${ok}.`,
            skipped ? ` Пропущено (нет права из текущего статуса): ${skipped}.` : '',
            errors.length ? ` Ошибки: ${errors.slice(0, 8).join('; ')}` : '',
          ].join('')
        );
      } else if (targetStatus === 'in_assembly') {
        const result = await ordersApi.sendToAssembly(
          toSend.map((o) => ({ marketplace: o.marketplace, orderId: o.orderId }))
        );
        const updated = result?.updated ?? toSend.length;
        let msg = `В системе статус «На сборке» обновлён для строк: ${updated} из ${toSend.length}.`;
        if (result?.warnings?.length) {
          msg += ` Предупреждения по поставкам МП: ${result.warnings.length}.`;
        }
        setAssemblyMessage(msg);
      }
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        toSend.forEach((o) => next.delete(orderKey(o)));
        return next;
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

  /** Выбранные целиком строки, готовые к закупке (новый / у WB — pending до резолва статуса). */
  const bulkProcurementSelectedRows = useMemo(() => {
    return sortedGroupedDisplayRows.filter((row) => {
      const keys = row.orders.map(orderKey);
      if (!keys.every((k) => selectedKeys.has(k))) return false;
      return row.orders.every((o) => isOrderStatusEligibleForProcurement(o.marketplace, o.status));
    });
  }, [sortedGroupedDisplayRows, selectedKeys]);

  const openBulkProcurementModal = async () => {
    const rows = bulkProcurementSelectedRows;
    if (rows.length === 0) {
      setAssemblyMessage(
        'Отметьте чекбоксами целые строки заказов, доступных к закупке (статус «Новый» или у WB — пока статус не получен), затем снова нажмите «В закупку».'
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
        purchasesApi.list({ limit: 100 }),
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

  if (loading) {
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
            title="Полная загрузка заказов с Ozon, Wildberries и Яндекс.Маркет (обходит ограничение «не чаще раза в минуту»)"
          >
            {syncLoading && syncKind === 'import' ? 'Импорт...' : '📥 Импортировать заказы'}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => navigate('/assembly')}
            title="Перейти к экрану сборки заказов"
          >
            {assembledCount > 0 ? `📦 Сборка (${assembledCount})` : '📦 Сборка'}
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
            Укажите покупателя и позиции: для каждой — товар, количество и цену за единицу.
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
              <div className="form-group" style={{ flex: '1 1 180px' }}>
                <label className="label">Товар</label>
                <select
                  value={row.productId === '' ? '' : row.productId}
                  onChange={(e) => addOrderProductChange(index, e.target.value)}
                  className="form-control"
                >
                  <option value="">— Выберите товар —</option>
                  {productsList
                    .filter((p) => {
                      const n = Number(p.id);
                      return !Number.isNaN(n) && n >= 1;
                    })
                    .map((p) => (
                      <option key={p.id} value={Number(p.id)}>
                        {p.name || p.sku || `ID ${p.id}`}
                      </option>
                    ))}
                </select>
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
                      <strong>
                        {
                          mergePurchaseLinesByArticle(purchaseLinesFromDisplayRow(procurementModalRow))
                            .length
                        }
                      </strong>
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
                <table className="table" style={{ marginBottom: 16, fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th>Товар</th>
                      <th>Артикул</th>
                      <th
                        className={`orders-th-sortable${procurementPreviewQtySort ? ' orders-th-sortable--active' : ''}`}
                      >
                        <button
                          type="button"
                          className="orders-th-sortable-btn"
                          aria-label={
                            procurementPreviewQtySort == null
                              ? 'Сортировать по количеству по возрастанию'
                              : procurementPreviewQtySort === 'asc'
                                ? 'Сортировать по количеству по убыванию'
                                : 'Сбросить сортировку по количеству'
                          }
                          onClick={() =>
                            setProcurementPreviewQtySort((prev) =>
                              prev == null ? 'asc' : prev === 'asc' ? 'desc' : null
                            )
                          }
                          title={
                            procurementPreviewQtySort == null
                              ? 'Нажмите: сортировать по количеству ↑'
                              : procurementPreviewQtySort === 'asc'
                                ? 'Сейчас ↑. Нажмите — ↓'
                                : 'Сейчас ↓. Нажмите — без сортировки'
                          }
                        >
                          Кол-во
                          {procurementPreviewQtySort === 'asc' ? ' ↑' : ''}
                          {procurementPreviewQtySort === 'desc' ? ' ↓' : ''}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {procurementMergedPreviewLines.map((line, i) => (
                      <tr key={`${line.article}-${line.productId ?? 'x'}-${i}`}>
                        <td>{line.name}</td>
                        <td>{line.article}</td>
                        <td>{line.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

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
                  <div className="form-group" style={{ marginBottom: 16 }}>
                    <label className="label">Поставщик</label>
                    <select
                      className="form-control"
                      style={{ maxWidth: 420 }}
                      value={procurementSupplierId}
                      onChange={(e) => setProcurementSupplierId(e.target.value)}
                    >
                      <option value="">— Не выбран —</option>
                      {procurementSuppliers.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.name || `Поставщик №${s.id}`}
                        </option>
                      ))}
                    </select>
                  </div>
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
        title={detailModalRow ? `Заказ ${detailModalRow.first.orderId} (${allMarketplaces.find(m => m.code === detailModalRow.first.marketplace)?.name ?? detailModalRow.first.marketplace})` : 'Заказ'}
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
                <OrderDetailContent data={detailModalData} />
              )}
            {!detailModalLoading &&
              (!detailModalData ||
                detailModalError ||
                !['ozon', 'wildberries', 'wb', 'yandex'].includes(detailModalRow.first.marketplace)) && (
                <OrderSummaryFromList orders={detailModalRow.orders} marketplace={detailModalRow.first.marketplace} />
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
            : 'Синхронизация завершена.'}
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
          {uniqueStatuses.map((st) => (
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

        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <span className="text-muted small">
            Показано: {sortedGroupedDisplayRows.length} из {totalOrders}
          </span>
          {totalPages > 1 ? (
            <div className="d-flex align-items-center gap-2">
              <Button
                variant="secondary"
                size="small"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading}
              >
                Назад
              </Button>
              <span className="text-muted small">
                Страница {currentPage} из {totalPages}
              </span>
              <Button
                variant="secondary"
                size="small"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages || loading}
              >
                Вперёд
              </Button>
            </div>
          ) : null}
        </div>

        <div className="orders-list" style={{marginTop: '16px'}}>
        {!loading && sortedGroupedDisplayRows.length === 0 ? (
          <div className="empty-state">
            <p>Заказы не найдены</p>
          </div>
        ) : (
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
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroupedDisplayRows.map((row, idx) => {
                const { first, orders: groupOrders, isGroup } = row;
                const keys = groupOrders.map(orderKey);
                const checked = keys.every(k => selectedKeys.has(k));
                const mpRow = normalizeMarketplaceForUI(first.marketplace);
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
                const reservedQty = Number(first.reservedQty ?? first.reserved_qty ?? 0) || 0;
                const needQty = Number(first.quantity) || 1;
                const reserveProgressBadge = (first.status === 'in_procurement' || first.status === 'new') && reservedQty > 0;
                const groupStatusLabelsMixed =
                  isGroup &&
                  groupOrders &&
                  new Set(groupOrders.map((o) => String(o.status ?? ''))).size > 1;
                return (
                <tr
                  key={row.key + idx}
                  className={`orders-row-clickable ${checked ? 'orders-row-selected' : ''} ${isGroup ? 'orders-row-multi' : ''}`}
                  onClick={() => setDetailModalRow(row)}
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
                      <div className="orders-stacked-lines orders-stacked-lines--qty">
                        {mergedGroupLines.map((o, i) => (
                          <div key={i} className="orders-stacked-line">{o.quantity}</div>
                        ))}
                      </div>
                    ) : (
                      singleQty
                    )}
                  </td>
                  <td>{priceDisplay}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {groupStatusLabelsMixed ? (
                        <div className="orders-stacked-lines">
                          {groupOrders.map((o) => (
                            <div key={orderKey(o)} className="orders-stacked-line">
                              {getOrderStatusLabel(o.status)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span>{getOrderStatusLabel(first.status)}</span>
                      )}
                      {reserveProgressBadge && (
                        <span
                          className="badge"
                          style={{
                            border: '1px solid rgba(0,0,0,0.12)',
                            background: 'rgba(0,0,0,0.04)',
                            color: 'var(--text)',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                          title={`Резерв под заказ: ${reservedQty} из ${needQty}`}
                        >
                          Резерв: {reservedQty}/{needQty}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="orders-col-actions" onClick={e => e.stopPropagation()}>
                    <div className="orders-actions">
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
                      {first.marketplace === 'manual' && (
                        <>
                          <Button
                            variant="secondary"
                            size="small"
                            className="orders-action-icon"
                            onClick={() => handleMarkShipped(first.marketplace, first.orderId, row.key)}
                            disabled={markShippedLoadingKey === row.key || deleteLoadingKey === row.key || returnToNewLoadingKey === row.key}
                            title="Поставить статус «Отгружен» (для тестирования)"
                            aria-label="Отгружен"
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
        )}
        </div>
      </div>
    </div>
  );
}



/**
 * Assembly Page
 * Интерфейс сборки заказов: сканирование штрихкода → поиск заказа → дособор → печать стикера.
 * Сверху блок ввода штрихкода; при сканировании ищется первый заказ на сборке с этим товаром.
 */

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useProductCardModal } from '../../context/ProductCardModalContext.jsx';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { OrderLabelIcon } from '../../components/common/OrderLabelIcon/OrderLabelIcon';
import { ordersApi, assemblyApi } from '../../services/orders.api';
import api from '../../services/api';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { clearScanField } from '../../utils/scanInput';
import { FastScanInput } from '../../components/common/FastScanInput/FastScanInput';
import { getStoredLabelSize } from '../Settings/Labels';
import { isAssemblyLikeStatus, orderStickerCellValue } from '../../utils/orderStickerDisplay';
import { getAssemblyOrderCompositionLines } from '../../utils/assemblyOrderComposition';
import {
  orderGroupKey,
  singleOrderListGroupKey,
  marketplaceOrderIdForApi,
} from '../../utils/orderListGroupKey';
import { OrderStickerDisplay } from '../../components/orders/OrderStickerDisplay';
import {
  assemblyLineScanKey,
  scannedQtyForAssemblyLine,
  applyAssemblyBarcodeScan,
  isAssemblyCompositionComplete,
  shouldPreferCurrentAssemblyOrder,
} from '../../utils/assemblyKitScan.js';
import './Assembly.css';

function resolveApiBaseUrl() {
  const env = process.env.REACT_APP_API_URL;
  // На HTTPS-странице браузер блокирует любые запросы к http:// (Mixed Content).
  // Поэтому при HTTPS всегда используем относительный '/api' (тот же origin).
  try {
    if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
      if (env && /^http:\/\//i.test(String(env))) return '/api';
    }
  } catch {
    // ignore
  }
  return env || '/api';
}

const API_BASE = resolveApiBaseUrl();
/** По умолчанию пробуем локальный Print Helper — без настройки сервера достаточно запустить exe */
const PRINT_HELPER_URL_DEFAULT = process.env.REACT_APP_PRINT_HELPER_URL || 'http://127.0.0.1:9100';
/** Ozon create/get этикетки на сервере может занимать 30+ с — обрыв раньше даёт «не напечаталось». */
const PRINT_HELPER_FETCH_MS = 90000;
/** Опрос кэша этикетки на сервере (fallback, если mark-collected не успел скачать). */
const LABEL_STATUS_POLL_MS = 45000;
const LABEL_STATUS_POLL_INTERVAL_MS = 400;

const marketplaceLabels = [
  { code: 'ozon', name: 'Ozon', icon: '🟠' },
  { code: 'wildberries', name: 'Wildberries', icon: '🟣' },
  { code: 'yandex', name: 'Яндекс.Маркет', icon: '🔴' }
];

/**
 * Страница /orders/.../label/print сама вызывает печать после загрузки.
 * window.open после async (скан → markCollected → печать) часто блокируется; iframe — нет.
 */
function openLabelPrintFallbackPage(url) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.title = 'Печать этикетки';
  iframe.style.cssText =
    'position:fixed;width:0;height:0;border:0;left:0;top:0;clip:rect(0,0,0,0);visibility:hidden';
  iframe.src = url;
  const remove = () => {
    try {
      iframe.remove();
    } catch {
      /* ignore */
    }
  };
  setTimeout(remove, 180000);
  document.body.appendChild(iframe);
}

function normMarketplace(o) {
  const m = (o?.marketplace || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m;
}

const ARTICLE_SORT_LOCALE_OPTS = { sensitivity: 'base', numeric: true };

/** Артикул для сортировки списка сборки (SKU каталога → offerId МП). */
function assemblyOrderArticleKey(o) {
  if (!o) return '';
  const v =
    o.productSku ??
    o.product_sku ??
    o.offerId ??
    o.offer_id ??
    o.marketplaceSku ??
    o.marketplace_sku ??
    '';
  return String(v).trim();
}

/** Ручные заказы — без этикетки МП; остальные маркетплейсы требуют стикер до завершения сборки. */
function orderRequiresMarketplaceLabel(order) {
  const mp = normMarketplace(order);
  return mp === 'ozon' || mp === 'wildberries' || mp === 'yandex';
}

function labelNotReadyAssemblyMessage(marketplace) {
  const mp = normMarketplace({ marketplace });
  if (mp === 'ozon') {
    return (
      'Этикетка Ozon ещё не загружена. Подождите 1–2 минуты после «На сборку» или проверьте заказ в ЛК Ozon ' +
      '(для продаж юрлицам сначала заполните данные отправления — без них стикер не выдаётся).'
    );
  }
  if (mp === 'wildberries') {
    return (
      'Стикер WB ещё не загружен. Подождите или проверьте, что заказ переведён в сборку в кабинете Wildberries.'
    );
  }
  if (mp === 'yandex') {
    return 'Этикетка Яндекс.Маркета ещё не загружена. Подождите или проверьте статус заказа в кабинете.';
  }
  return 'Этикетка заказа ещё не загружена на сервер. Подождите и повторите.';
}

/**
 * Один заказ на сборке для группы МП (несколько строк в БД с разным orderId).
 * Ключ сессии должен быть стабильным — иначе при скане второй позиции приходит другая строка,
 * меняется orderId, фронт сбрасывает счётчики «осталось отсканировать».
 */
function AssemblyCompositionCell({ rows }) {
  const lines = getAssemblyOrderCompositionLines(rows);
  if (!lines.length) return '—';
  const title = lines.join('\n');
  return (
    <div className="assembly-composition-lines" title={title}>
      {lines.map((line, i) => (
        <div key={`${line}-${i}`} className="assembly-composition-line">
          {line}
        </div>
      ))}
    </div>
  );
}

function assemblyOrderSessionKey(order) {
  if (!order) return '';
  const mp = normMarketplace(order);
  const ogk = orderGroupKey(order);
  if (ogk) return `${mp}|g:${ogk}`;
  return singleOrderListGroupKey(order);
}

function groupAssemblyRowsBySessionKey(rows) {
  const keyOrder = [];
  const byKey = new Map();
  for (const o of rows || []) {
    const k = assemblyOrderSessionKey(o);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      keyOrder.push(k);
    }
    byKey.get(k).push(o);
  }
  return keyOrder.map((k) => {
    const groupRows = byKey.get(k);
    return { key: k, rows: groupRows, primary: groupRows[0] };
  });
}

/** Строка состава: «offerId/строка заказа, название - Nшт»; внутренний productId не показываем */
function formatAssemblyCompositionLine(item) {
  const externalId = String(item.offerId ?? item.orderLineId ?? '').trim();
  const name = item.productName || item.product_name || '—';
  const q = item.quantity ?? 1;
  if (externalId) {
    return `${externalId}, ${name} - ${q}шт`;
  }
  return `${name} - ${q}шт`;
}

function assemblyLineProductId(item) {
  const raw = item?.productId ?? item?.product_id;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Части строки состава: название можно сделать ссылкой на карточку товара в ERP */
function assemblyCompositionParts(item, quantityOverride) {
  const externalId = String(item.offerId ?? item.orderLineId ?? '').trim();
  const name = item.productName || item.product_name || '—';
  const q = quantityOverride ?? item.quantity ?? 1;
  const productId = assemblyLineProductId(item);
  return {
    externalId,
    name,
    q,
    productId,
    fallbackText: formatAssemblyCompositionLine({ ...item, quantity: q })
  };
}

export function Assembly() {
  const { openProductCardFromClick } = useProductCardModal();
  const [assemblyOrders, setAssemblyOrders] = useState([]);
  const [collectedOrders, setCollectedOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [sortField, setSortField] = useState('name'); // 'name' | 'article'
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [currentOrderData, setCurrentOrderData] = useState(null); // { order, product, orderItems }
  const [currentOrderKey, setCurrentOrderKey] = useState(''); // marketplace|orderId или marketplace|g:groupId
  // Счётчики сканов по строкам состава (assemblyLineScanKey) или по productId, если состав пуст
  const [scannedQuantities, setScannedQuantities] = useState(() => ({}));
  const [returnToNewLoadingKey, setReturnToNewLoadingKey] = useState('');
  const [finishScanSubmitting, setFinishScanSubmitting] = useState(false);
  /** URL локального Print Helper для тихой печати (с сервера или из env) — один билд для всех ПК */
  const [printHelperUrl, setPrintHelperUrl] = useState(PRINT_HELPER_URL_DEFAULT);
  const [labelPrintError, setLabelPrintError] = useState(null);
  /** orderId -> true, если файл этикетки уже загружен на сервер (можно показывать иконку печати) */
  const [labelReadyByOrderId, setLabelReadyByOrderId] = useState(() => ({}));
  const [ordersAutoSyncPaused, setOrdersAutoSyncPaused] = useState(false);
  const barcodeInputRef = useRef(null);
  const doSearchRef = useRef(async () => {});
  const orderKeyRef = useRef('');
  const currentOrderDataRef = useRef(null);
  const scannedQuantitiesRef = useRef({});
  const markedCollectedKeyRef = useRef('');
  const autoFinishKeyRef = useRef('');
  /** Пока идёт markCollected + печать — игнорируем сканы (иначе сканер шлёт второй ввод и открывается чужой заказ с тем же товаром → вторая этикетка). */
  const printingFlowRef = useRef(false);
  const scanLoadingRef = useRef(false);
  orderKeyRef.current = currentOrderKey;
  currentOrderDataRef.current = currentOrderData;
  scannedQuantitiesRef.current = scannedQuantities;
  scanLoadingRef.current = scanLoading;

  const loadOrders = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const [assemblyResponse, collectedResponse] = await Promise.all([
        ordersApi.getAll({ status: 'in_assembly', limit: 500, skipAutoReserve: '1' }),
        ordersApi.getAll({ status: 'assembled', limit: 200, skipAutoReserve: '1' }),
      ]);
      const assemblyList = Array.isArray(assemblyResponse?.data) ? assemblyResponse.data : [];
      const collectedList = Array.isArray(collectedResponse?.data) ? collectedResponse.data : [];
      setAssemblyOrders(assemblyList);
      setCollectedOrders(collectedList);
      // Инициализируем иконки печати сразу из backend-поля hasLabel.
      const initialReady = {};
      for (const o of [...assemblyList, ...collectedList]) {
        const oid = o?.orderId ?? o?.order_id;
        if (oid == null || String(oid).trim() === '') continue;
        if (o?.hasLabel === true || o?.has_label === true) initialReady[String(oid)] = true;
      }
      if (Object.keys(initialReady).length > 0) {
        setLabelReadyByOrderId((prev) => ({ ...(prev || {}), ...initialReady }));
      }
    } catch (err) {
      console.error('Error loading assembly orders:', err);
      setError(err.message || 'Ошибка загрузки заказов');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!scanLoading && barcodeInputRef.current) {
      barcodeInputRef.current.focus();
    }
  }, [scanLoading, currentOrderData]);

  /** Через 3 с без действий пользователя — снова фокус в поле штрихкода (удобно для сканера). */
  useEffect(() => {
    const IDLE_MS = 3000;
    let timerId = null;

    const scheduleIdleFocus = () => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        if (printingFlowRef.current || scanLoadingRef.current) return;
        const el = barcodeInputRef.current;
        if (el && !el.disabled) el.focus();
      }, IDLE_MS);
    };

    const onActivity = () => scheduleIdleFocus();
    const opts = { capture: true, passive: true };

    scheduleIdleFocus();

    window.addEventListener('mousedown', onActivity, opts);
    window.addEventListener('keydown', onActivity, opts);
    window.addEventListener('touchstart', onActivity, opts);

    return () => {
      if (timerId) clearTimeout(timerId);
      window.removeEventListener('mousedown', onActivity, opts);
      window.removeEventListener('keydown', onActivity, opts);
      window.removeEventListener('touchstart', onActivity, opts);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    ordersApi
      .getOrdersFbsSyncPause()
      .then((d) => {
        if (!cancelled) setOrdersAutoSyncPaused(Boolean(d?.paused));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Конфиг с сервера может переопределить URL помощника (если сервер вернул пусто — оставляем дефолт 127.0.0.1:9100)
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE.replace(/\/$/, '')}/config`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled || !body?.ok) return;
        const url = (body.data?.printHelperUrl ?? '').trim();
        setPrintHelperUrl(url || PRINT_HELPER_URL_DEFAULT);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Как только заказ открыт на сборке — прогреваем этикетку в фоне (к завершению скана файл уже в кэше).
  useEffect(() => {
    const orderId = currentOrderData?.order?.orderId;
    if (!orderId) return;
    const id = String(orderId);
    api.get(`/orders/${encodeURIComponent(orderId)}/label/status`, { timeout: 45000 }).catch(() => {});
    api
      .get(`/orders/${encodeURIComponent(orderId)}/label`, {
        responseType: 'blob',
        timeout: PRINT_HELPER_FETCH_MS,
      })
      .then(() => {
        setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [id]: true }));
      })
      .catch(() => {});
  }, [currentOrderData?.order?.orderId]);

  // Фоновая проверка: показываем иконку печати только если файл этикетки уже кэширован на сервере.
  useEffect(() => {
    const ids = new Set();
    for (const o of assemblyOrders || []) {
      const oid = o?.orderId ?? o?.order_id;
      if (oid != null && String(oid).trim() !== '') ids.add(String(oid));
    }
    for (const o of collectedOrders || []) {
      const oid = o?.orderId ?? o?.order_id;
      if (oid != null && String(oid).trim() !== '') ids.add(String(oid));
    }
    const cur = currentOrderData?.order?.orderId;
    if (cur != null && String(cur).trim() !== '') ids.add(String(cur));

    const toFetch = [];
    for (const id of ids) {
      if (labelReadyByOrderId?.[id] === true) continue;
      toFetch.push(id);
    }
    if (toFetch.length === 0) return;

    let cancelled = false;
    const ac = new AbortController();

    // Ограничим количество параллельных запросов, чтобы не ловить 429 на WB.
    const limit = 12;
    const runChunk = async (id) => {
      try {
        const r = await api.get(`/orders/${encodeURIComponent(id)}/label/status`, {
          timeout: 15000,
          signal: ac.signal,
        });
        const exists = r?.data?.data?.exists === true || r?.data?.exists === true;
        if (!exists) return;
        if (cancelled) return;
        setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [id]: true }));
      } catch {
        // ignore
      }
    };

    const run = async () => {
      for (let i = 0; i < toFetch.length; i += limit) {
        const chunk = toFetch.slice(i, i + limit);
        await Promise.all(chunk.map((id) => runChunk(id)));
        if (cancelled) return;
      }
    };

    run();

    return () => {
      cancelled = true;
      try { ac.abort(); } catch { /* ignore */ }
    };
  }, [assemblyOrders, collectedOrders, currentOrderData?.order?.orderId, labelReadyByOrderId]);

  const waitLabelCachedOnServer = useCallback(async (orderId, { maxMs = LABEL_STATUS_POLL_MS } = {}) => {
    const path = `/orders/${encodeURIComponent(orderId)}/label/status`;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        const r = await api.get(path, { timeout: 5000 });
        if (r?.data?.data?.exists === true || r?.data?.exists === true) return true;
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, LABEL_STATUS_POLL_INTERVAL_MS));
    }
    return false;
  }, []);

  /**
   * Та же логика, что после «заказ собран»: Print Helper (тихая печать) или страница /label/print с window.print().
   * Раньше иконка вела на /label (только файл в вкладке — без диалога печати).
   */
  const requestLabelPrint = useCallback(async (orderId, { labelAlreadyCached = false, skipBrowserWarm = false } = {}) => {
    const id = orderId != null ? String(orderId) : '';
    if (!id) return;
    // Печать через фронтовую страницу: она умеет скачивать этикетку с Authorization: Bearer из localStorage.
    const labelPrintPageUrl = `/print/label/${encodeURIComponent(id)}`;
    const labelFileUrl = `${API_BASE}/orders/${encodeURIComponent(id)}/label`;
    const labelFilePath = `/orders/${encodeURIComponent(id)}/label`;

    // Если печатаем через страницу /label/print (без локального helper),
    // лучше открыть вкладку синхронно по клику — иначе браузер может заблокировать window.print().
    let printWindow = null;

    // Print Helper (127.0.0.1) должен получить абсолютный URL до этикетки на сервере.
    const labelFileUrlAbs = (() => {
      try {
        return new URL(labelFileUrl, window.location.origin).toString();
      } catch {
        return labelFileUrl;
      }
    })();

    // В HTTP-контексте браузер запрещает запросы к loopback (127.0.0.1) из-за Private Network Access.
    // Тогда не пытаемся дергать Print Helper — используем страницу /label/print.
    const canUseLocalHelper = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
    const base = canUseLocalHelper ? (printHelperUrl || '').trim().replace(/\/$/, '') : '';
    const willUseHelper = Boolean(base);
    if (!willUseHelper) {
      try {
        printWindow = window.open('about:blank', '_blank', 'noopener,noreferrer');
      } catch {
        printWindow = null;
      }
    }

    // Print Helper сам качает PDF с сервера — в браузер blob не тянем (skipBrowserWarm / labelAlreadyCached).
    const canSkipBrowserWarm = labelAlreadyCached || (skipBrowserWarm && willUseHelper);
    if (!canSkipBrowserWarm) {
      try {
        let status = 0;
        let msg = '';
        await waitLabelCachedOnServer(id);
        const warmAc = new AbortController();
        const warmT = setTimeout(() => warmAc.abort(), PRINT_HELPER_FETCH_MS);
        try {
          try {
            await api.get(labelFilePath, {
              responseType: 'blob',
              timeout: PRINT_HELPER_FETCH_MS,
              headers: { Accept: '*/*' },
              signal: warmAc.signal
            });
            status = 200;
          } catch (e) {
            status = e?.response?.status || 0;
            const data = e?.response?.data;
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
              try {
                const text = await data.text();
                try {
                  const j = text ? JSON.parse(text) : null;
                  msg = j?.message || j?.error || '';
                } catch {
                  msg = text || '';
                }
                msg = String(msg || '').trim();
              } catch {
                msg = '';
              }
            }
            if (!msg) msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || '';
          }

          if (status !== 200) {
            const base =
              status === 409
                ? 'Этикетка ещё не готова или недоступна для этого заказа.'
                : status === 429
                  ? 'Слишком много запросов к этикеткам/синхронизации. Подождите и повторите.'
                  : status === 404
                    ? 'Этикетка для заказа не найдена.'
                    : status
                      ? `Не удалось получить этикетку (HTTP ${status}).`
                      : 'Не удалось получить этикетку (сеть/таймаут).';
            const detail = msg ? ` ${String(msg).trim()}` : '';
            setLabelPrintError(`${base}${detail}`);
            setTimeout(() => setLabelPrintError(null), 12000);
            try {
              if (printWindow && !printWindow.closed) printWindow.close();
            } catch {
              /* ignore */
            }
            return;
          }
        } finally {
          clearTimeout(warmT);
        }
      } catch {
        setLabelPrintError(
          'Таймаут/сбой сети при загрузке этикетки. Подождите и попробуйте ещё раз.'
        );
        setTimeout(() => setLabelPrintError(null), 12000);
        try {
          if (printWindow && !printWindow.closed) printWindow.close();
        } catch {
          /* ignore */
        }
        return;
      }
    }

    if (!willUseHelper) {
      // Если вкладка открылась — навигируем её на страницу печати.
      // Иначе используем скрытый iframe fallback.
      try {
        if (printWindow && !printWindow.closed) {
          printWindow.location.href = labelPrintPageUrl;
          return;
        }
      } catch {
        /* ignore */
      }
      openLabelPrintFallbackPage(labelPrintPageUrl);
      return;
    }

    if (skipBrowserWarm && willUseHelper && !labelAlreadyCached) {
      const ready = await waitLabelCachedOnServer(id);
      if (!ready) {
        setLabelPrintError(
          'Этикетка ещё формируется на маркетплейсе. Повторите печать через несколько секунд.'
        );
        setTimeout(() => setLabelPrintError(null), 12000);
        return;
      }
      setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [id]: true }));
    }

    setLabelPrintError(null);
    const labelSize = getStoredLabelSize();
    const helperUrl = `${base}/print?orderId=${encodeURIComponent(id)}&labelUrl=${encodeURIComponent(labelFileUrlAbs)}&labelSize=${encodeURIComponent(labelSize)}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), PRINT_HELPER_FETCH_MS);
    try {
      const r = await fetch(helperUrl, { method: 'GET', mode: 'cors', signal: ac.signal });
      if (r.ok) return;
      const body = await r.json().catch(() => ({}));
      const msg = body?.message || 'Принтер не ответил';
      if (r.status === 502 && (String(msg).includes('Этикетка') || String(msg).includes('загружена'))) {
        setLabelPrintError('Этикетка для заказа не загружена. Запущена печать со страницы этикетки.');
        setTimeout(() => setLabelPrintError(null), 8000);
      }
      throw new Error(msg);
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      if (aborted) {
        setLabelPrintError(
          'Таймаут печати: этикетка с маркетплейса долго формируется. Запущена печать со страницы этикетки.'
        );
        setTimeout(() => setLabelPrintError(null), 10000);
      }
      openLabelPrintFallbackPage(labelPrintPageUrl);
    } finally {
      clearTimeout(t);
    }
  }, [printHelperUrl, waitLabelCachedOnServer]);

  /** Отметка «Собран» + печать этикетки (общая для скана и таблицы). */
  const runMarkCollectedFlow = useCallback(
    async (marketplace, orderId, stickerRaw = null, { afterSuccess, order: orderHint = null } = {}) => {
      const trimmed = stickerRaw != null ? String(stickerRaw).trim() : '';
      const oid = orderId != null ? String(orderId) : '';
      const orderForLabel =
        orderHint ||
        assemblyOrders.find((o) => String(o.orderId ?? o.order_id) === oid) ||
        collectedOrders.find((o) => String(o.orderId ?? o.order_id) === oid) ||
        currentOrderData?.order;
      printingFlowRef.current = true;
      try {
        if (orderForLabel && orderRequiresMarketplaceLabel(orderForLabel)) {
          let ready = labelReadyByOrderId?.[oid] === true;
          if (!ready) {
            ready = await waitLabelCachedOnServer(oid, { maxMs: 90000 });
            if (ready) {
              setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [oid]: true }));
            }
          }
          if (!ready) {
            setLabelPrintError(labelNotReadyAssemblyMessage(orderForLabel.marketplace));
            setTimeout(() => setLabelPrintError(null), 15000);
            return false;
          }
        }
        const collected = await assemblyApi.markCollected(marketplace, orderId, trimmed || null);
        afterSuccess?.(trimmed || null);
        void loadOrders({ silent: true });
        const labelCached =
          labelReadyByOrderId?.[oid] === true || collected?.labelReady === true;
        if (collected?.labelReady === true) {
          setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [oid]: true }));
        }
        void requestLabelPrint(orderId, {
          labelAlreadyCached: labelCached,
          skipBrowserWarm: true
        }).finally(() => {
          setTimeout(() => {
            printingFlowRef.current = false;
            setTimeout(() => barcodeInputRef.current?.focus(), 50);
          }, 300);
        });
        return true;
      } catch (err) {
        printingFlowRef.current = false;
        const msg =
          err?.response?.data?.message ||
          err?.message ||
          'Не удалось отметить заказ собранным — печать не запускалась.';
        setLabelPrintError(msg);
        setTimeout(() => setLabelPrintError(null), 12000);
        return false;
      }
    },
    [loadOrders, requestLabelPrint, labelReadyByOrderId, waitLabelCachedOnServer, assemblyOrders, collectedOrders, currentOrderData?.order]
  );

  useEffect(() => {
    setFinishScanSubmitting(false);
  }, [currentOrderKey]);

  /** Смена фильтра МП сбрасывает текущую сессию скана, если заказ не подходит. */
  useEffect(() => {
    if (!currentOrderData?.order) return;
    if (marketplaceFilter === 'all') return;
    if (normMarketplace(currentOrderData.order) === marketplaceFilter) return;
    setCurrentOrderData(null);
    setCurrentOrderKey('');
    setScannedQuantities({});
    markedCollectedKeyRef.current = '';
    autoFinishKeyRef.current = '';
    setScanError('Фильтр маркетплейса изменён — текущая сборка сброшена');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем на смену фильтра и ключа заказа
  }, [marketplaceFilter, currentOrderKey]);

  const doSearch = async (barcode) => {
    const trimmed = (barcode || '').trim();
    if (trimmed.length < 2) return;
    if (printingFlowRef.current) return;
    setScanError(null);
    setScanLoading(true);
    try {
      const cur = currentOrderDataRef.current;
      const qty = scannedQuantitiesRef.current || {};
      const curItems = cur?.orderItems || [];
      const preferIncomplete =
        !!cur?.order?.orderId &&
        ((curItems.length > 0 && !isAssemblyCompositionComplete(curItems, qty)) ||
          (curItems.length === 0 &&
            String(cur.order?.status ?? '').toLowerCase() !== 'assembled'));

      const data = await assemblyApi.findOrderByBarcode(trimmed, {
        marketplace: marketplaceFilter,
        ...(preferIncomplete
          ? {
              preferOrderId: String(cur.order.orderId),
              preferMarketplace: normMarketplace(cur.order) || undefined
            }
          : {})
      });
      if (data?.order && data?.product) {
        if (
          marketplaceFilter !== 'all' &&
          normMarketplace(data.order) !== marketplaceFilter
        ) {
          clearScanField(barcodeInputRef.current);
          setScanError(
            'Заказ относится к другому маркетплейсу. Сбросьте фильтр или выберите нужный МП.'
          );
          playEventSound(SOUND_EVENTS.scan_error);
          return;
        }
        playEventSound(SOUND_EVENTS.scan_ok);
        let order = data.order;
        let orderItems = data.orderItems || [];
        const apiKey = assemblyOrderSessionKey(order);
        const prevKey = orderKeyRef.current;

        // Страховка: API мог вернуть другой заказ с тем же SKU — не бросаем незавершённый текущий.
        // Если штрихкод ещё нужен на текущем — остаёмся. Если текущий незакрыт, а SKU к нему
        // не относится — тоже не переключаемся (иначе общие комплектующие «прыгают» между заказами).
        if (prevKey && apiKey !== prevKey && cur?.order && preferIncomplete) {
          const stillNeeded = shouldPreferCurrentAssemblyOrder(data.product, curItems, qty);
          const currentOpen =
            curItems.length > 0 && !isAssemblyCompositionComplete(curItems, qty);
          if (stillNeeded || currentOpen) {
            order = cur.order;
            orderItems = curItems;
            if (!stillNeeded && currentOpen) {
              clearScanField(barcodeInputRef.current);
              setScanError(
                'Этот штрихкод не нужен в текущем заказе. Дособерите текущий или сбросьте сессию.'
              );
              playEventSound(SOUND_EVENTS.scan_error);
              return;
            }
          }
        }

        const newKey = assemblyOrderSessionKey(order);
        if (newKey !== prevKey) {
          markedCollectedKeyRef.current = '';
        }
        const isSameOrder = newKey === prevKey;
        setCurrentOrderData({ order, product: data.product, orderItems });
        setCurrentOrderKey(newKey);
        setScannedQuantities((prev) => {
          const base = isSameOrder ? prev : {};
          return applyAssemblyBarcodeScan(base, data.product, orderItems);
        });
        clearScanField(barcodeInputRef.current);
      } else {
        clearScanField(barcodeInputRef.current);
        setScanError('Заказ с таким штрихкодом не найден на сборке');
        playEventSound(SOUND_EVENTS.scan_error);
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Ошибка поиска заказа';
      setScanError(msg);
      clearScanField(barcodeInputRef.current);
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setScanLoading(false);
    }
  };

  doSearchRef.current = doSearch;

  const handleAssemblyScan = useCallback((code) => {
    doSearchRef.current(code);
  }, []);

  // Позиции, по которым ещё не добрано: нужное количество минус отсканировано
  const remainingItems = useMemo(() => {
    if (!currentOrderData?.orderItems?.length) return [];
    const items = currentOrderData.orderItems;
    const result = [];
    items.forEach((item, idx) => {
      const need = item.quantity ?? 1;
      const scanned = scannedQtyForAssemblyLine(item, idx, scannedQuantities, items);
      const remaining = Math.max(0, need - scanned);
      if (remaining > 0) {
        result.push({ ...item, need, scanned, remaining });
      }
    });
    return result;
  }, [currentOrderData, scannedQuantities]);

  /** Все позиции состава с полями для отображения */
  const compositionLines = useMemo(() => {
    if (!currentOrderData?.orderItems?.length) return [];
    const items = currentOrderData.orderItems;
    return items.map((item, idx) => {
      const need = item.quantity ?? 1;
      const scanned = scannedQtyForAssemblyLine(item, idx, scannedQuantities, items);
      const remaining = Math.max(0, need - scanned);
      const parts = assemblyCompositionParts({ ...item, quantity: need }, need);
      return {
        key: assemblyLineScanKey(item, idx, items),
        ...parts,
        remaining,
        scanned
      };
    });
  }, [currentOrderData, scannedQuantities]);

  const isKitAssembly = useMemo(() => {
    const items = currentOrderData?.orderItems || [];
    if (items.length > 1) return true;
    if (items.some((i) => i.isKitComponent || i.isSubKitWhole || i.kitProductId || i.subKitProductId))
      return true;
    const needTotal = items.reduce((s, i) => s + (i.quantity ?? 1), 0);
    if (items.length === 1 && needTotal > 1) return true;
    const lineIds = items
      .map((i) => (i.orderLineId != null ? String(i.orderLineId).trim() : ''))
      .filter(Boolean);
    return lineIds.length > 1 && new Set(lineIds).size < lineIds.length;
  }, [currentOrderData]);

  const implicitSingleLineDone = useMemo(() => {
    if (isKitAssembly) return false;
    if (!currentOrderData?.order?.orderId || (currentOrderData.orderItems?.length ?? 0) > 0) return false;
    const need = currentOrderData.order.quantity ?? 1;
    const pid = Number(currentOrderData.product?.id);
    const pk = Number.isNaN(pid) ? currentOrderData.product?.id : pid;
    const scanned = scannedQuantities[pk] ?? 0;
    return scanned >= need;
  }, [currentOrderData, scannedQuantities, isKitAssembly]);

  const isOrderFullyCollected =
    !!currentOrderData?.order &&
    !!currentOrderKey &&
    ((currentOrderData.orderItems?.length ?? 0) > 0
      ? remainingItems.length === 0
      : implicitSingleLineDone);

  const showScanStickerFinish =
    isOrderFullyCollected &&
    String(currentOrderData?.order?.status ?? '').toLowerCase() !== 'assembled';

  const currentOrderLabelReady =
    !currentOrderData?.order ||
    !orderRequiresMarketplaceLabel(currentOrderData.order) ||
    labelReadyByOrderId?.[String(currentOrderData.order.orderId)] === true;

  const waitingForOrderLabel =
    showScanStickerFinish &&
    currentOrderData?.order &&
    orderRequiresMarketplaceLabel(currentOrderData.order) &&
    !currentOrderLabelReady;

  // Пока ждём этикетку — опрашиваем статус чаще, чем фоновый список.
  useEffect(() => {
    if (!waitingForOrderLabel || !currentOrderData?.order?.orderId) return undefined;
    const oid = String(currentOrderData.order.orderId);
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.get(`/orders/${encodeURIComponent(oid)}/label/status`, { timeout: 20000 });
        const exists = r?.data?.data?.exists === true || r?.data?.exists === true;
        if (exists && !cancelled) {
          setLabelReadyByOrderId((prev) => ({ ...(prev || {}), [oid]: true }));
        }
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [waitingForOrderLabel, currentOrderData?.order?.orderId]);

  // Автозавершение скан-сборки: все позиции отсканированы и этикетка на сервере → печать.
  useEffect(() => {
    if (!showScanStickerFinish || !currentOrderLabelReady) return;
    if (!currentOrderData?.order || !currentOrderKey) return;
    if (finishScanSubmitting || printingFlowRef.current) return;
    if (markedCollectedKeyRef.current === currentOrderKey) return;
    if (autoFinishKeyRef.current === currentOrderKey) return;
    autoFinishKeyRef.current = currentOrderKey;
    setTimeout(() => {
      // best effort: если пользователь успел сменить заказ — не запускаем
      if (autoFinishKeyRef.current !== currentOrderKey) return;
      void handleFinishScanAssembly();
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- намеренно не добавляем handleFinishScanAssembly (не stable)
  }, [showScanStickerFinish, currentOrderLabelReady, currentOrderKey, currentOrderData?.order, finishScanSubmitting]);

  const handleFinishScanAssembly = async () => {
    if (!currentOrderData?.order || !currentOrderKey || finishScanSubmitting) return;
    if (
      marketplaceFilter !== 'all' &&
      normMarketplace(currentOrderData.order) !== marketplaceFilter
    ) {
      setScanError(
        'Заказ относится к другому маркетплейсу. Сбросьте фильтр или выберите нужный МП.'
      );
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    const { marketplace, orderId } = currentOrderData.order;
    setFinishScanSubmitting(true);
    try {
      await runMarkCollectedFlow(marketplace, orderId, currentOrderData?.order?.assemblyStickerNumber ?? null, {
        afterSuccess: () => {
          markedCollectedKeyRef.current = currentOrderKey;
          setCurrentOrderData((prev) =>
            prev
              ? {
                  ...prev,
                  order: {
                    ...prev.order,
                    status: 'assembled',
                  }
                }
              : null
          );
        }
      });
    } finally {
      setFinishScanSubmitting(false);
    }
  };

  const handleClearCurrentOrder = () => {
    printingFlowRef.current = false;
    setCurrentOrderData(null);
    setCurrentOrderKey('');
    setScannedQuantities({});
    markedCollectedKeyRef.current = '';
    autoFinishKeyRef.current = '';
    setScanError(null);
    clearScanField(barcodeInputRef.current);
    if (barcodeInputRef.current) barcodeInputRef.current.focus();
  };

  const handleReturnToNew = async (marketplace, orderId, orderGroupId) => {
    const key = assemblyOrderSessionKey({ marketplace, orderId, orderGroupId });
    try {
      setReturnToNewLoadingKey(key);
      await ordersApi.returnToNew(marketplace, orderId);
      await loadOrders({ silent: true });
      if (currentOrderKey === key) handleClearCurrentOrder();
    } catch (e) {
      console.error('Ошибка возврата в «Новый»:', e);
    } finally {
      setReturnToNewLoadingKey('');
    }
  };

  const handleManualAssembleFromTable = (o) => {
    const rowKey = assemblyOrderSessionKey(o);
    const marketplace = o.marketplace;
    const orderId = String(o.orderId ?? o.order_id ?? '').trim();
    if (!marketplace || !orderId) return;
    if (printingFlowRef.current) return;
    if (marketplaceFilter !== 'all' && normMarketplace(o) !== marketplaceFilter) {
      setLabelPrintError(
        'Сейчас выбран фильтр другого маркетплейса — этот заказ собрать нельзя.'
      );
      setTimeout(() => setLabelPrintError(null), 8000);
      return;
    }
    if (orderRequiresMarketplaceLabel(o) && labelReadyByOrderId?.[orderId] !== true) {
      setLabelPrintError(labelNotReadyAssemblyMessage(o.marketplace));
      setTimeout(() => setLabelPrintError(null), 12000);
      return;
    }
    void runMarkCollectedFlow(marketplace, orderId, o.assemblyStickerNumber ?? o.assembly_sticker_number ?? null, {
      order: o,
      afterSuccess: () => {
        if (currentOrderKey === rowKey) handleClearCurrentOrder();
      },
    });
  };

  const assembledOrders = useMemo(() => {
    return assemblyOrders;
  }, [assemblyOrders]);

  /** Недавно собранные (ещё можно повторно напечатать стикер) — сверху свежие по времени сборки */
  const collectedOrdersSorted = useMemo(() => {
    const list = collectedOrders;
    const byAssembledThenName = (a, b) => {
      const ta = a.assembledAt ? new Date(a.assembledAt).getTime() : 0;
      const tb = b.assembledAt ? new Date(b.assembledAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      const na = (a.productName || a.product_name || a.orderId || '').toLowerCase();
      const nb = (b.productName || b.product_name || b.orderId || '').toLowerCase();
      return na.localeCompare(nb);
    };
    return [...list].sort(byAssembledThenName);
  }, [collectedOrders]);

  const mpDisplay = (code) => marketplaceLabels.find((m) => m.code === normMarketplace({ marketplace: code })) || null;

  const filtered = useMemo(() => {
    let list = assembledOrders;
    if (marketplaceFilter !== 'all') {
      list = list.filter(o => normMarketplace(o) === marketplaceFilter);
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const byName = (a, b) => {
      const na = (a.productName || a.product_name || a.orderId || '').toLowerCase();
      const nb = (b.productName || b.product_name || b.orderId || '').toLowerCase();
      return na.localeCompare(nb, 'ru') * dir;
    };
    const byArticle = (a, b) => {
      const ka = assemblyOrderArticleKey(a);
      const kb = assemblyOrderArticleKey(b);
      if (!ka && !kb) return byName(a, b);
      if (!ka) return 1;
      if (!kb) return -1;
      const cmp = ka.localeCompare(kb, 'ru', ARTICLE_SORT_LOCALE_OPTS);
      return cmp !== 0 ? cmp * dir : byName(a, b);
    };
    return [...list].sort(sortField === 'article' ? byArticle : byName);
  }, [assembledOrders, marketplaceFilter, sortField, sortDir]);

  /** Одна строка таблицы = один заказ (группа по session key); комплектующие в ячейках */
  const assemblyTableGroups = useMemo(
    () => groupAssemblyRowsBySessionKey(filtered),
    [filtered]
  );

  const collectedFiltered = useMemo(() => {
    let list = collectedOrdersSorted;
    if (marketplaceFilter !== 'all') {
      list = list.filter(o => normMarketplace(o) === marketplaceFilter);
    }
    return list;
  }, [collectedOrdersSorted, marketplaceFilter]);

  const collectedTableGroups = useMemo(
    () => groupAssemblyRowsBySessionKey(collectedFiltered),
    [collectedFiltered]
  );

  if (loading) {
    return (
      <div className="card assembly-page">
        <div className="loading">Загрузка заказов...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card assembly-page">
        <div className="error">Ошибка: {error}</div>
      </div>
    );
  }

  const curAssemblyMp = currentOrderData ? mpDisplay(currentOrderData.order.marketplace) : null;

  return (
    <div className="card assembly-page">
      {ordersAutoSyncPaused && (
        <p
          className="assembly-sync-paused-banner"
          style={{
            margin: '0 0 14px',
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'var(--warning-bg, #fff8e6)',
            border: '1px solid var(--warning-border, #e6c200)',
          }}
        >
          Автообновление заказов с маркетплейсов на паузе — статусы не меняются по расписанию. Включить снова:{' '}
          <Link to="/orders">страница «Заказы»</Link>.
        </p>
      )}
      <h1 className="title">🔧 Сборка заказов</h1>
      <p className="subtitle">
        Заказы, отправленные на сборку ({assemblyTableGroups.length}). У каждого заказа в таблице — кнопка «Собрать»
        без сканера: статус «Собран» и печать этикетки. При активном фильтре маркетплейса сканер собирает только
        заказы этого МП; без фильтра — любой. После последнего штрихкода этикетка печатается автоматически;
        кнопка «Завершить сборку» — запасной вариант.
      </p>

      <div className="assembly-scan-block">
        <div className="assembly-scan-form">
          <label htmlFor="assembly-barcode" className="assembly-scan-label">
            Штрихкод товара
          </label>
          <FastScanInput
            id="assembly-barcode"
            inputRef={barcodeInputRef}
            className="assembly-scan-input"
            placeholder="Отсканируйте или введите штрихкод — поиск автоматически"
            onScan={handleAssemblyScan}
            debounceMs={400}
            enableGlobalCapture
            disabled={scanLoading}
          />
        </div>
        {scanError && <p className="assembly-scan-error">{scanError}</p>}
        {labelPrintError && <p className="assembly-scan-error assembly-label-error">{labelPrintError}</p>}

        {currentOrderData && (
          <div className="assembly-current-order">
            <h3 className="assembly-current-title">
              {curAssemblyMp ? `${curAssemblyMp.icon} ` : ''}
              Заказ {currentOrderData.order.orderId}
              {curAssemblyMp
                ? ` · ${curAssemblyMp.name}`
                : ` · ${currentOrderData.order.marketplace}`}
            </h3>
            {isAssemblyLikeStatus(currentOrderData.order.status) ? (
              <p className="assembly-current-sticker text-muted small mb-2">
                {normMarketplace(currentOrderData.order.marketplace) === 'wildberries'
                  ? 'Стикер'
                  : 'Номер заказа'}
                :{' '}
                <OrderStickerDisplay order={currentOrderData.order} />
              </p>
            ) : null}
            <div className="assembly-composition">
              <span className="assembly-composition-label">Состав заказа:</span>
              <ul className="assembly-composition-list">
                {compositionLines.map((line, idx) => (
                  <li key={`${line.key}-${idx}`}>
                    {line.productId ? (
                      <>
                        {line.externalId ? `${line.externalId}, ` : ''}
                        <button
                          type="button"
                          onClick={(e) => openProductCardFromClick(line.productId, e)}
                          className="assembly-product-link"
                          title="Открыть карточку товара"
                          style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                        >
                          {line.name}
                        </button>
                        {` - ${line.q}шт`}
                      </>
                    ) : (
                      line.fallbackText
                    )}
                    {line.remaining > 0 && (
                      <span className="assembly-composition-progress">
                        {' '}
                        (осталось отсканировать: {line.remaining})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            {remainingItems.length > 0 && (
              <p className="assembly-remaining-hint">Отсканируйте следующий товар по штрихкоду.</p>
            )}
            {showScanStickerFinish && (
              <div className="assembly-sticker-finish">
                <p className="assembly-ready-text">
                  {waitingForOrderLabel
                    ? 'Все позиции отсканированы. Загружаем этикетку с маркетплейса — сборка начнётся автоматически, как только стикер будет готов.'
                    : finishScanSubmitting
                      ? 'Все позиции отсканированы. Отмечаем собранным и отправляем этикетку на печать…'
                      : 'Все позиции отсканированы. Этикетка отправляется в печать автоматически…'}
                </p>
                {waitingForOrderLabel && currentOrderData?.order && (
                  <p className="assembly-label-wait-hint" style={{ marginTop: 8, fontSize: '0.92rem', opacity: 0.9 }}>
                    {labelNotReadyAssemblyMessage(currentOrderData.order.marketplace)}
                  </p>
                )}
                <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button
                    variant="primary"
                    onClick={() => void handleFinishScanAssembly()}
                    disabled={finishScanSubmitting || waitingForOrderLabel}
                    title={waitingForOrderLabel ? 'Дождитесь загрузки этикетки' : undefined}
                  >
                    {finishScanSubmitting ? '…' : waitingForOrderLabel ? 'Ожидание этикетки…' : 'Завершить сборку и напечатать'}
                  </Button>
                  {labelReadyByOrderId?.[String(currentOrderData.order.orderId)] === true && (
                    <button
                      type="button"
                      className="assembly-label-link assembly-label-link-inline"
                      title="Только печать этикетки (без смены статуса)"
                      aria-label="Печать этикетки заказа"
                      disabled={finishScanSubmitting}
                      onClick={() => requestLabelPrint(currentOrderData.order.orderId)}
                    >
                      <OrderLabelIcon size={20} />
                    </button>
                  )}
                </div>
              </div>
            )}
            {String(currentOrderData?.order?.status ?? '').toLowerCase() === 'assembled' && (
              <div className="assembly-ready">
                <p className="assembly-ready-text">
                  Заказ собран
                  {orderStickerCellValue(currentOrderData.order) !== '—' ? (
                    <>
                      .{' '}
                      {normMarketplace(currentOrderData.order.marketplace) === 'wildberries'
                        ? 'Стикер'
                        : 'Заказ'}
                      : <OrderStickerDisplay order={currentOrderData.order} />
                    </>
                  ) : null}
                  {' '}
                  {labelReadyByOrderId?.[String(currentOrderData.order.orderId)] === true && (
                    <button
                      type="button"
                      className="assembly-label-link assembly-label-link-inline"
                      title="Печать этикетки"
                      aria-label="Печать этикетки заказа"
                      onClick={() => requestLabelPrint(currentOrderData.order.orderId)}
                    >
                      <OrderLabelIcon size={20} />
                    </button>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="assembly-toolbar">
        <div className="assembly-filters">
          <span className="assembly-filter-label">Маркетплейс:</span>
          <Button
            variant={marketplaceFilter === 'all' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setMarketplaceFilter('all')}
          >
            Все
          </Button>
          {marketplaceLabels.map(mp => (
            <Button
              key={mp.code}
              variant={marketplaceFilter === mp.code ? 'primary' : 'secondary'}
              size="small"
              onClick={() => setMarketplaceFilter(mp.code)}
            >
              {mp.icon} {mp.name}
            </Button>
          ))}
        </div>
        <div className="assembly-sort">
          <span className="assembly-filter-label">Сортировка:</span>
          <Button
            variant={sortField === 'name' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => {
              if (sortField === 'name') {
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
              } else {
                setSortField('name');
                setSortDir('asc');
              }
            }}
          >
            По имени {sortField === 'name' ? (sortDir === 'asc' ? 'А→Я' : 'Я→А') : ''}
          </Button>
          <Button
            variant={sortField === 'article' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => {
              if (sortField === 'article') {
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
              } else {
                setSortField('article');
                setSortDir('asc');
              }
            }}
          >
            По артикулу {sortField === 'article' ? (sortDir === 'asc' ? 'А→Я' : 'Я→А') : ''}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="assembly-empty">
          <p>
            {assembledOrders.length === 0
              ? 'Нет заказов на сборке. Отправьте заказы на сборку со страницы «Заказы».'
              : 'Нет заказов по выбранному фильтру.'}
          </p>
        </div>
      ) : (
        <div className="assembly-table-wrap">
          <table className="assembly-table table">
            <thead>
              <tr>
                <th>Маркетплейс</th>
                <th>ID заказа</th>
                <th>Товар</th>
                <th>Кол-во</th>
                <th>Состав</th>
                <th>Стикер</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {assemblyTableGroups.map(({ key: groupKey, rows, primary }) => {
                const rowKey = groupKey;
                const isReturnLoading = returnToNewLoadingKey === rowKey;
                const mp = primary.marketplace;
                const apiOrderId = marketplaceOrderIdForApi(rows, mp);
                const qtyCell =
                  rows.length === 1
                    ? primary.quantity ?? '—'
                    : rows.map((r) => r.quantity ?? 1).join(' + ');
                return (
                  <tr key={groupKey}>
                    <td>{mp}</td>
                    <td>
                      <Link
                        to={`/orders/${encodeURIComponent(mp)}/${encodeURIComponent(apiOrderId || primary.orderId)}`}
                        className="assembly-order-link"
                      >
                        {apiOrderId || primary.orderId}
                      </Link>
                    </td>
                    <td>
                      <div className="assembly-table-lines">
                        {rows.map((o, i) => {
                          const erpPid = assemblyLineProductId(o);
                          const name = o.productName || o.product_name || '—';
                          const q = o.quantity ?? 1;
                          return (
                            <div key={`${String(o.orderId)}-${i}`} className="assembly-table-line">
                              {erpPid ? (
                                <button
                                  type="button"
                                  onClick={(e) => openProductCardFromClick(erpPid, e)}
                                  className="assembly-product-link"
                                  title="Открыть карточку товара"
                                  style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                                >
                                  {name}
                                </button>
                              ) : (
                                name
                              )}
                              <span className="assembly-table-line-qty">{` — ${q} шт`}</span>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td>{qtyCell}</td>
                    <td className="assembly-col-composition">
                      <AssemblyCompositionCell rows={rows} />
                    </td>
                    <td className="assembly-col-sticker">
                      <OrderStickerDisplay order={primary} groupOrders={rows} />
                    </td>
                    <td>
                      <div className="assembly-row-actions">
                        {labelReadyByOrderId?.[String(primary.orderId)] === true && (
                          <button
                            type="button"
                            className="assembly-label-link"
                            title={
                              isAssemblyLikeStatus(primary.status) && primary.status !== 'assembled'
                                ? 'Напечатать этикетку и отметить собранным'
                                : 'Печать стикера'
                            }
                            aria-label={
                              isAssemblyLikeStatus(primary.status) && primary.status !== 'assembled'
                                ? 'Напечатать этикетку и отметить заказ собранным'
                                : 'Печать этикетки заказа'
                            }
                            onClick={() =>
                              isAssemblyLikeStatus(primary.status) && primary.status !== 'assembled'
                                ? handleManualAssembleFromTable(primary)
                                : requestLabelPrint(primary.orderId)
                            }
                          >
                            <OrderLabelIcon size={20} />
                          </button>
                        )}
                        <Button
                          variant="primary"
                          size="small"
                          onClick={() => handleManualAssembleFromTable(primary)}
                          disabled={
                            isReturnLoading ||
                            finishScanSubmitting ||
                            (orderRequiresMarketplaceLabel(primary) &&
                              labelReadyByOrderId?.[String(primary.orderId)] !== true)
                          }
                          title={
                            orderRequiresMarketplaceLabel(primary) &&
                            labelReadyByOrderId?.[String(primary.orderId)] !== true
                              ? labelNotReadyAssemblyMessage(primary.marketplace)
                              : 'Отметить заказ собранным без сканирования и напечатать этикетку'
                          }
                        >
                          {orderRequiresMarketplaceLabel(primary) &&
                          labelReadyByOrderId?.[String(primary.orderId)] !== true
                            ? '⏳ Этикетка…'
                            : '✓ Собрать'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() =>
                            handleReturnToNew(
                              primary.marketplace,
                              primary.orderId,
                              primary.orderGroupId ?? primary.order_group_id
                            )
                          }
                          disabled={isReturnLoading || finishScanSubmitting}
                          title="Вернуть заказ в статус «Новый»"
                        >
                          {isReturnLoading ? '...' : '↩️ Вернуть в новые'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="assembly-section-title">
        {`Собранные заказы (${collectedTableGroups.length}${marketplaceFilter !== 'all' ? ', выбран маркетплейс' : ''})`}
      </h2>
      <p className="assembly-section-hint">
        Статус «Собран» — повторная печать стикера и просмотр этикетки.
      </p>
      {collectedTableGroups.length === 0 ? (
        <div className="assembly-empty assembly-empty-muted">
          <p>
            {collectedOrdersSorted.length === 0
              ? 'Пока нет заказов в статусе «Собран».'
              : 'Нет собранных заказов по выбранному маркетплейсу.'}
          </p>
        </div>
      ) : (
        <div className="assembly-table-wrap">
          <table className="assembly-table table">
            <thead>
              <tr>
                <th>Маркетплейс</th>
                <th>ID заказа</th>
                <th>Товар</th>
                <th>Кол-во</th>
                <th>Состав</th>
                <th>Собран</th>
                <th>Собрал</th>
                <th>Стикер</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {collectedTableGroups.map(({ key: groupKey, rows, primary }) => {
                const mp = primary.marketplace;
                const mpRow = mpDisplay(mp);
                const apiOrderId = marketplaceOrderIdForApi(rows, mp);
                const qtyCell =
                  rows.length === 1
                    ? primary.quantity ?? '—'
                    : rows.map((r) => r.quantity ?? 1).join(' + ');
                const assembledLabel = primary.assembledAt
                  ? new Date(primary.assembledAt).toLocaleString('ru-RU')
                  : '—';
                const who =
                  [primary.assembledByFullName, primary.assembledByEmail].filter(Boolean).join(' · ') || '—';
                const stickerOrderId = apiOrderId || String(primary.orderId ?? '');
                const labelReady =
                  labelReadyByOrderId?.[stickerOrderId] === true ||
                  rows.some((r) => labelReadyByOrderId?.[String(r.orderId ?? '')] === true);
                return (
                  <tr key={groupKey}>
                    <td>{mpRow ? `${mpRow.icon} ${mpRow.name}` : mp}</td>
                    <td>
                      <Link
                        to={`/orders/${encodeURIComponent(mp)}/${encodeURIComponent(stickerOrderId)}`}
                        className="assembly-order-link"
                      >
                        {stickerOrderId}
                      </Link>
                    </td>
                    <td>
                      <div className="assembly-table-lines">
                        {rows.map((o, i) => {
                          const erpPid = assemblyLineProductId(o);
                          const name = o.productName || o.product_name || '—';
                          return (
                            <div key={`${String(o.orderId)}-${i}`} className="assembly-table-line">
                              {erpPid ? (
                                <button
                                  type="button"
                                  onClick={(e) => openProductCardFromClick(erpPid, e)}
                                  className="assembly-product-link"
                                  title="Открыть карточку товара"
                                  style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                                >
                                  {name}
                                </button>
                              ) : (
                                name
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td>{qtyCell}</td>
                    <td className="assembly-col-composition">
                      <AssemblyCompositionCell rows={rows} />
                    </td>
                    <td>{assembledLabel}</td>
                    <td>{who}</td>
                    <td className="assembly-col-sticker">
                      <OrderStickerDisplay order={primary} groupOrders={rows} />
                    </td>
                    <td>
                      <div className="assembly-row-actions">
                        {labelReady && (
                          <button
                            type="button"
                            className="assembly-label-link"
                            title="Печать стикера"
                            aria-label="Печать этикетки заказа"
                            onClick={() => requestLabelPrint(stickerOrderId)}
                          >
                            <OrderLabelIcon size={20} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}

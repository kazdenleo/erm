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
import { OrderStickerDisplay } from '../../components/orders/OrderStickerDisplay';
import {
  isKitSkuScanForOrder,
  assemblyLinesToCompleteOnKitScan,
  orderItemMatchesScannedProduct,
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
  const m = (o.marketplace || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m;
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
  const gid = order.orderGroupId ?? order.order_group_id;
  if (gid != null && String(gid).trim() !== '') {
    return `${mp}|g:${String(gid)}`;
  }
  const oid = order.orderId ?? order.order_id;
  return `${mp}|${oid ?? ''}`;
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

/** Уникальный ключ строки состава (всегда с idx — защита от дублей productId / orderLineId). */
function assemblyLineScanKey(item, idx) {
  const orderLineId = item.orderLineId != null ? String(item.orderLineId).trim() : '';
  const pid = item.productId ?? item.product_id ?? '';
  return `asm:${idx}:${orderLineId}:${pid}`;
}

function scannedQtyForAssemblyLine(item, idx, scannedQuantities, itemsLength = 1) {
  const key = assemblyLineScanKey(item, idx);
  const fromKey = scannedQuantities[key];
  if (fromKey != null) return fromKey;
  if (itemsLength === 1) {
    const pid = item.productId ?? item.product_id;
    if (pid != null && pid !== '') {
      return scannedQuantities[pid] ?? scannedQuantities[Number(pid)] ?? 0;
    }
  }
  return 0;
}

export function Assembly() {
  const { openProductCardFromClick } = useProductCardModal();
  const [assemblyOrders, setAssemblyOrders] = useState([]);
  const [collectedOrders, setCollectedOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [sortByName, setSortByName] = useState('asc'); // 'asc' | 'desc'
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
  const markedCollectedKeyRef = useRef('');
  const autoFinishKeyRef = useRef('');
  /** Пока идёт markCollected + печать — игнорируем сканы (иначе сканер шлёт второй ввод и открывается чужой заказ с тем же товаром → вторая этикетка). */
  const printingFlowRef = useRef(false);
  const scanLoadingRef = useRef(false);
  orderKeyRef.current = currentOrderKey;
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

  const doSearch = async (barcode) => {
    const trimmed = (barcode || '').trim();
    if (trimmed.length < 2) return;
    if (printingFlowRef.current) return;
    setScanError(null);
    setScanLoading(true);
    try {
      const data = await assemblyApi.findOrderByBarcode(trimmed);
      if (data?.order && data?.product) {
        playEventSound(SOUND_EVENTS.scan_ok);
        const newKey = assemblyOrderSessionKey(data.order);
        const prevKey = orderKeyRef.current;
        if (newKey !== prevKey) {
          markedCollectedKeyRef.current = '';
        }
        const isSameOrder = newKey === prevKey;
        setCurrentOrderData({ order: data.order, product: data.product, orderItems: data.orderItems || [] });
        setCurrentOrderKey(newKey);
        setScannedQuantities((prev) => {
          const next = isSameOrder ? { ...prev } : {};
          const items = data.orderItems || [];
          const product = data.product;

          if (items.length === 0) {
            return next;
          }

          if (isKitSkuScanForOrder(product, items)) {
            const lineIdxs = assemblyLinesToCompleteOnKitScan(product, items);
            for (const idx of lineIdxs) {
              const item = items[idx];
              const need = item.quantity ?? 1;
              next[assemblyLineScanKey(item, idx)] = need;
            }
            return next;
          }

          const candidates = items
            .map((item, idx) => ({ item, idx }))
            .filter(({ item }) => orderItemMatchesScannedProduct(item, product));

          const bumpLine = (item, idx) => {
            const key = assemblyLineScanKey(item, idx);
            next[key] = (next[key] || 0) + 1;
          };

          if (candidates.length === 0) {
            // Без совпадения product_id не засчитываем скан (важно для комплектов:
            // строка «целый комплект» vs штрихкод комплектующей).
            const legacySingleLine =
              items.length === 1 && assemblyLineProductId(items[0]) == null;
            if (legacySingleLine) {
              bumpLine(items[0], 0);
            }
            return next;
          }

          for (const { item, idx } of candidates) {
            const need = item.quantity ?? 1;
            const key = assemblyLineScanKey(item, idx);
            const got = next[key] ?? 0;
            if (got < need) {
              bumpLine(item, idx);
              return next;
            }
          }
          const { item, idx } = candidates[candidates.length - 1];
          bumpLine(item, idx);
          return next;
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
    const result = [];
    currentOrderData.orderItems.forEach((item, idx) => {
      const need = item.quantity ?? 1;
      const itemsLen = currentOrderData.orderItems.length;
      const scanned = scannedQtyForAssemblyLine(item, idx, scannedQuantities, itemsLen);
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
    const itemsLen = currentOrderData.orderItems.length;
    return currentOrderData.orderItems.map((item, idx) => {
      const need = item.quantity ?? 1;
      const scanned = scannedQtyForAssemblyLine(item, idx, scannedQuantities, itemsLen);
      const remaining = Math.max(0, need - scanned);
      const parts = assemblyCompositionParts({ ...item, quantity: need }, need);
      return {
        key: `${item.orderLineId ?? item.offerId ?? item.productId ?? idx}`,
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
    const byName = (a, b) => {
      const na = (a.productName || a.product_name || a.orderId || '').toLowerCase();
      const nb = (b.productName || b.product_name || b.orderId || '').toLowerCase();
      if (sortByName === 'asc') return na.localeCompare(nb);
      return nb.localeCompare(na);
    };
    return [...list].sort(byName);
  }, [assembledOrders, marketplaceFilter, sortByName]);

  /** Одна строка таблицы = один заказ (группа по session key); комплектующие в ячейках */
  const assemblyTableGroups = useMemo(() => {
    const keyOrder = [];
    const byKey = new Map();
    for (const o of filtered) {
      const k = assemblyOrderSessionKey(o);
      if (!byKey.has(k)) {
        byKey.set(k, []);
        keyOrder.push(k);
      }
      byKey.get(k).push(o);
    }
    return keyOrder.map((k) => {
      const rows = byKey.get(k);
      return { key: k, rows, primary: rows[0] };
    });
  }, [filtered]);

  const collectedFiltered = useMemo(() => {
    let list = collectedOrdersSorted;
    if (marketplaceFilter !== 'all') {
      list = list.filter(o => normMarketplace(o) === marketplaceFilter);
    }
    return list;
  }, [collectedOrdersSorted, marketplaceFilter]);

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
        без сканера: статус «Собран» и печать этикетки. При скан‑сборке (включая комплекты по комплектующим)
        после последнего штрихкода этикетка печатается автоматически; кнопка «Завершить сборку» — запасной вариант.
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
            variant="secondary"
            size="small"
            onClick={() => setSortByName(sortByName === 'asc' ? 'desc' : 'asc')}
          >
            По имени {sortByName === 'asc' ? 'А→Я' : 'Я→А'}
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
                const orderIds = [...new Set(rows.map((r) => String(r.orderId ?? r.order_id ?? '').trim()).filter(Boolean))];
                const mp = primary.marketplace;
                const qtyCell =
                  rows.length === 1
                    ? primary.quantity ?? '—'
                    : rows.map((r) => r.quantity ?? 1).join(' + ');
                return (
                  <tr key={groupKey}>
                    <td>{mp}</td>
                    <td>
                      {orderIds.length <= 1 ? (
                        <Link
                          to={`/orders/${encodeURIComponent(mp)}/${encodeURIComponent(primary.orderId)}`}
                          className="assembly-order-link"
                        >
                          {orderIds[0] ?? primary.orderId}
                        </Link>
                      ) : (
                        <div className="assembly-table-order-ids">
                          {orderIds.map((oid) => (
                            <div key={oid}>
                              <Link
                                to={`/orders/${encodeURIComponent(mp)}/${encodeURIComponent(oid)}`}
                                className="assembly-order-link"
                              >
                                {oid}
                              </Link>
                            </div>
                          ))}
                        </div>
                      )}
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
        {`Собранные заказы (${collectedFiltered.length}${marketplaceFilter !== 'all' ? ', выбран маркетплейс' : ''})`}
      </h2>
      <p className="assembly-section-hint">
        Статус «Собран» — повторная печать стикера и просмотр этикетки.
      </p>
      {collectedFiltered.length === 0 ? (
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
              {collectedFiltered.map((o, idx) => {
                const rowKey = `collected-${o.marketplace}|${o.orderId}|${idx}`;
                const mpRow = mpDisplay(o.marketplace);
                const assembledLabel = o.assembledAt
                  ? new Date(o.assembledAt).toLocaleString('ru-RU')
                  : '—';
                const who =
                  [o.assembledByFullName, o.assembledByEmail].filter(Boolean).join(' · ') || '—';
                const erpPidCol = assemblyLineProductId(o);
                return (
                  <tr key={rowKey}>
                    <td>{mpRow ? `${mpRow.icon} ${mpRow.name}` : o.marketplace}</td>
                    <td>
                      <Link
                        to={`/orders/${encodeURIComponent(o.marketplace)}/${encodeURIComponent(o.orderId)}`}
                        className="assembly-order-link"
                      >
                        {o.orderId}
                      </Link>
                    </td>
                    <td>
                      {erpPidCol ? (
                        <button
                          type="button"
                          onClick={(e) => openProductCardFromClick(erpPidCol, e)}
                          className="assembly-product-link"
                          title="Открыть карточку товара"
                          style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
                        >
                          {o.productName || o.product_name || '—'}
                        </button>
                      ) : (
                        o.productName || o.product_name || '—'
                      )}
                    </td>
                    <td>{o.quantity ?? '—'}</td>
                    <td className="assembly-col-composition">
                      <AssemblyCompositionCell rows={[o]} />
                    </td>
                    <td>{assembledLabel}</td>
                    <td>{who}</td>
                    <td className="assembly-col-sticker">
                      <OrderStickerDisplay order={o} />
                    </td>
                    <td>
                      <div className="assembly-row-actions">
                        {labelReadyByOrderId?.[String(o.orderId)] === true && (
                          <button
                            type="button"
                            className="assembly-label-link"
                            title="Печать стикера"
                            aria-label="Печать этикетки заказа"
                            onClick={() => requestLabelPrint(o.orderId)}
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

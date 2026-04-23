/**
 * Assembly Page
 * Интерфейс сборки заказов: сканирование штрихкода → поиск заказа → дособор → печать стикера.
 * Сверху блок ввода штрихкода; при сканировании ищется первый заказ на сборке с этим товаром.
 */

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { OrderLabelIcon } from '../../components/common/OrderLabelIcon/OrderLabelIcon';
import { ordersApi, assemblyApi } from '../../services/orders.api';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { getStoredLabelSize } from '../Settings/Labels';
import './Assembly.css';

const API_BASE = process.env.REACT_APP_API_URL || '/api';
/** По умолчанию пробуем локальный Print Helper — без настройки сервера достаточно запустить exe */
const PRINT_HELPER_URL_DEFAULT = process.env.REACT_APP_PRINT_HELPER_URL || 'http://127.0.0.1:9100';
/** Ожидание печати после сборки; иначе зависший fetch к Print Helper блокирует сканер (printingFlowRef). */
const ASSEMBLY_PRINT_WAIT_MS = 15000;
/** Ozon create/get этикетки на сервере может занимать 30+ с — обрыв раньше даёт «не напечаталось». */
const PRINT_HELPER_FETCH_MS = 90000;

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

/**
 * Один заказ на сборке для группы МП (несколько строк в БД с разным orderId).
 * Ключ сессии должен быть стабильным — иначе при скане второй позиции приходит другая строка,
 * меняется orderId, фронт сбрасывает счётчики «осталось отсканировать».
 */
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

/** Ключ строки состава для счётчика сканов (нельзя только productId — в БД он может не совпадать с id товара по штрихкоду). */
function assemblyLineScanKey(item, idx) {
  if (item.orderLineId != null && String(item.orderLineId).trim() !== '') {
    return `line:${String(item.orderLineId)}`;
  }
  const pid = item.productId ?? item.product_id ?? 'x';
  return `row:${idx}:p:${pid}`;
}

function orderItemMatchesScannedProduct(item, product, itemsLength = 1) {
  if (!product?.id) return false;
  const raw = item.productId ?? item.product_id;
  if (raw == null || raw === '') return itemsLength <= 1;
  const target = Number(product.id);
  const linePid = Number(raw);
  if (!Number.isNaN(target) && !Number.isNaN(linePid)) return linePid === target;
  return String(raw) === String(product.id);
}

export function Assembly() {
  const [assemblyOrders, setAssemblyOrders] = useState([]);
  const [collectedOrders, setCollectedOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [sortByName, setSortByName] = useState('asc'); // 'asc' | 'desc'
  const [barcodeInput, setBarcodeInput] = useState('');
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
  const [ordersAutoSyncPaused, setOrdersAutoSyncPaused] = useState(false);
  const barcodeInputRef = useRef(null);
  /** Актуальная строка штрихкода для глобального перехвата скана (фокус не в поле). */
  const barcodeValueRef = useRef('');
  const debounceRef = useRef(null);
  const doSearchRef = useRef(async () => {});
  const orderKeyRef = useRef('');
  const markedCollectedKeyRef = useRef('');
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
        ordersApi.getAll({ status: 'in_assembly', limit: 500 }),
        ordersApi.getAll({ status: 'assembled', limit: 200 }),
      ]);
      setAssemblyOrders(Array.isArray(assemblyResponse?.data) ? assemblyResponse.data : []);
      setCollectedOrders(Array.isArray(collectedResponse?.data) ? collectedResponse.data : []);
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
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
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

  // Как только заказ открыт на сборке — запускаем подгрузку этикетки, чтобы к моменту печати она была готова
  useEffect(() => {
    const orderId = currentOrderData?.order?.orderId;
    if (!orderId) return;
    fetch(`${API_BASE.replace(/\/$/, '')}/orders/${encodeURIComponent(orderId)}/label/status`)
      .catch(() => {});
  }, [currentOrderData?.order?.orderId]);

  /**
   * Та же логика, что после «заказ собран»: Print Helper (тихая печать) или страница /label/print с window.print().
   * Раньше иконка вела на /label (только файл в вкладке — без диалога печати).
   */
  const requestLabelPrint = useCallback(async (orderId) => {
    const id = orderId != null ? String(orderId) : '';
    if (!id) return;
    // Печать через фронтовую страницу: она умеет скачивать этикетку с Authorization: Bearer из localStorage.
    const labelPrintPageUrl = `/print/label/${encodeURIComponent(id)}`;
    const labelFileUrl = `${API_BASE}/orders/${encodeURIComponent(id)}/label`;

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

    // Дождаться файла на сервере (ensureLabelFile), иначе Print Helper сразу после сборки часто ловит 502.
    // Если этикетка недоступна (409/429/5xx) — покажем понятную ошибку и не будем дергать Print Helper.
    try {
      const warmAc = new AbortController();
      const warmT = setTimeout(() => warmAc.abort(), PRINT_HELPER_FETCH_MS);
      try {
        const warmR = await fetch(labelFileUrl, { method: 'GET', cache: 'no-store', signal: warmAc.signal });
        if (!warmR.ok) {
          const status = warmR.status;
          let msg = '';
          try {
            const j = await warmR.json();
            msg = j?.message || j?.error || '';
          } catch {
            try {
              msg = (await warmR.text()) || '';
            } catch {
              /* ignore */
            }
          }
          const base =
            status === 409
              ? 'Этикетка ещё не готова или недоступна в Wildberries для этого заказа.'
              : status === 429
                ? 'Слишком много запросов к этикеткам/синхронизации. Подождите и повторите.'
                : status === 404
                  ? 'Этикетка для заказа не найдена.'
                  : `Не удалось получить этикетку (HTTP ${status}).`;
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
        await warmR.blob();
      } finally {
        clearTimeout(warmT);
      }
    } catch {
      // При сетевом сбое/таймауте не запускаем Print Helper, иначе он покажет 502.
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
  }, [printHelperUrl]);

  const withPrintWait = useCallback(
    (orderId) =>
      Promise.race([
        requestLabelPrint(orderId),
        new Promise((resolve) => {
          setTimeout(resolve, ASSEMBLY_PRINT_WAIT_MS);
        })
      ]),
    [requestLabelPrint]
  );

  /** Отметка «Собран» + фоновая печать этикетки (общая для скана и таблицы). */
  const runMarkCollectedFlow = useCallback(
    async (marketplace, orderId, stickerRaw = null, { afterSuccess } = {}) => {
      const trimmed = stickerRaw != null ? String(stickerRaw).trim() : '';
      printingFlowRef.current = true;
      const afterPrintDelayMs = 400;
      try {
        await assemblyApi.markCollected(marketplace, orderId, trimmed || null);
        await loadOrders({ silent: true });
        afterSuccess?.(trimmed || null);
        try {
          await withPrintWait(orderId);
        } finally {
          setTimeout(() => {
            printingFlowRef.current = false;
            setTimeout(() => barcodeInputRef.current?.focus(), 50);
          }, afterPrintDelayMs);
        }
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
    [loadOrders, withPrintWait]
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
            const pid = Number(product.id);
            const pidKey = Number.isNaN(pid) ? product.id : pid;
            next[pidKey] = (next[pidKey] || 0) + 1;
            return next;
          }

          const candidates = items
            .map((item, idx) => ({ item, idx }))
            .filter(({ item }) => orderItemMatchesScannedProduct(item, product, items.length));

          const bumpLine = (item, idx) => {
            const key = assemblyLineScanKey(item, idx);
            next[key] = (next[key] || 0) + 1;
          };

          if (candidates.length === 0) {
            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx];
              const need = item.quantity ?? 1;
              const key = assemblyLineScanKey(item, idx);
              const got = next[key] ?? 0;
              if (got < need) {
                bumpLine(item, idx);
                return next;
              }
            }
            const last = items.length - 1;
            bumpLine(items[last], last);
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
        setBarcodeInput('');
      } else {
        setBarcodeInput('');
        setScanError('Заказ с таким штрихкодом не найден на сборке');
        playEventSound(SOUND_EVENTS.scan_error);
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Ошибка поиска заказа';
      setScanError(msg);
      setBarcodeInput('');
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setScanLoading(false);
    }
  };

  doSearchRef.current = doSearch;

  useEffect(() => {
    barcodeValueRef.current = barcodeInput;
  }, [barcodeInput]);

  /**
   * Сканер (HID-клавиатура) часто посылает символы, пока фокус на body/ссылке, а не в input.
   * Перехватываем печатные клавиши и Enter в capture — переносим в поле штрихкода.
   */
  useEffect(() => {
    const BARCODE_INPUT_ID = 'assembly-barcode';

    const isOtherTextField = (target) => {
      if (!target || typeof target !== 'object') return false;
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (tag === 'INPUT') {
        const type = String(target.type || '').toLowerCase();
        if (target.id === BARCODE_INPUT_ID) return false;
        if (type === 'button' || type === 'submit' || type === 'checkbox' || type === 'radio') return false;
        return true;
      }
      if (target.isContentEditable) return true;
      return false;
    };

    const scheduleSearch = (rawValue) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const trimmed = String(rawValue || '').trim();
        if (trimmed.length >= 2) doSearchRef.current(trimmed);
      }, 400);
    };

    const onKeyDownCapture = (e) => {
      if (printingFlowRef.current || scanLoadingRef.current) return;
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const input = barcodeInputRef.current;
      if (!input || input.disabled) return;
      if (e.target?.id === BARCODE_INPUT_ID) return;
      if (isOtherTextField(e.target)) return;

      const key = e.key;

      if (key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        input.focus();
        const trimmed = String(barcodeValueRef.current || '').trim();
        if (trimmed.length >= 2) doSearchRef.current(trimmed);
        return;
      }

      if (key.length !== 1) return;
      const c = key.charCodeAt(0);
      if (c < 32 || c === 127) return;

      e.preventDefault();
      e.stopPropagation();
      input.focus();
      setBarcodeInput((prev) => {
        const next = prev + key;
        barcodeValueRef.current = next;
        scheduleSearch(next);
        return next;
      });
    };

    document.addEventListener('keydown', onKeyDownCapture, true);
    return () => document.removeEventListener('keydown', onKeyDownCapture, true);
  }, []);

  const handleBarcodeChange = (e) => {
    const value = e.target.value;
    barcodeValueRef.current = value;
    setBarcodeInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed.length >= 2) doSearchRef.current(trimmed);
    }, 400);
  };

  /** Enter в конце скана приходит до commit state — берём значение из input, не из barcodeInput. */
  const handleBarcodeKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const trimmed = String(e.currentTarget.value || '').trim();
    barcodeValueRef.current = trimmed;
    if (trimmed.length >= 2) doSearchRef.current(trimmed);
  };

  const handleBarcodeSubmit = (e) => {
    e.preventDefault();
    const fromInput = String(barcodeInputRef.current?.value ?? '').trim();
    const trimmed = fromInput.length >= 2 ? fromInput : String(barcodeInput || '').trim();
    barcodeValueRef.current = trimmed;
    if (trimmed.length >= 2) doSearchRef.current(trimmed);
  };

  // Позиции, по которым ещё не добрано: нужное количество минус отсканировано
  const remainingItems = useMemo(() => {
    if (!currentOrderData?.orderItems?.length) return [];
    const result = [];
    currentOrderData.orderItems.forEach((item, idx) => {
      const need = item.quantity ?? 1;
      const key = assemblyLineScanKey(item, idx);
      const linePid = Number(item.productId);
      const pidFallback = Number.isNaN(linePid) ? item.productId : linePid;
      const scanned =
        scannedQuantities[key] ??
        scannedQuantities[pidFallback] ??
        scannedQuantities[item.productId] ??
        0;
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
    return currentOrderData.orderItems.map((item, idx) => {
      const need = item.quantity ?? 1;
      const key = assemblyLineScanKey(item, idx);
      const linePid = Number(item.productId);
      const pidFallback = Number.isNaN(linePid) ? item.productId : linePid;
      const scanned =
        scannedQuantities[key] ??
        scannedQuantities[pidFallback] ??
        scannedQuantities[item.productId] ??
        0;
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

  const implicitSingleLineDone = useMemo(() => {
    if (!currentOrderData?.order?.orderId || (currentOrderData.orderItems?.length ?? 0) > 0) return false;
    const need = currentOrderData.order.quantity ?? 1;
    const pid = Number(currentOrderData.product?.id);
    const pk = Number.isNaN(pid) ? currentOrderData.product?.id : pid;
    const scanned = scannedQuantities[pk] ?? 0;
    return scanned >= need;
  }, [currentOrderData, scannedQuantities]);

  const isOrderFullyCollected =
    !!currentOrderData?.order &&
    !!currentOrderKey &&
    ((currentOrderData.orderItems?.length ?? 0) > 0
      ? remainingItems.length === 0
      : implicitSingleLineDone);

  const showScanStickerFinish =
    isOrderFullyCollected &&
    String(currentOrderData?.order?.status ?? '').toLowerCase() !== 'assembled';

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
    setScanError(null);
    setBarcodeInput('');
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
    void runMarkCollectedFlow(marketplace, orderId, o.assemblyStickerNumber ?? o.assembly_sticker_number ?? null, {
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
        без сканера: статус «Собран» и печать этикетки. При скан‑сборке после того, как все позиции отсканированы,
        нажмите «Завершить сборку и напечатать».
      </p>

      <div className="assembly-scan-block">
        <form onSubmit={handleBarcodeSubmit} className="assembly-scan-form">
          <label htmlFor="assembly-barcode" className="assembly-scan-label">
            Штрихкод товара
          </label>
          <input
            id="assembly-barcode"
            ref={barcodeInputRef}
            type="text"
            className="assembly-scan-input"
            placeholder="Отсканируйте или введите штрихкод — поиск автоматически"
            value={barcodeInput}
            onChange={handleBarcodeChange}
            onKeyDown={handleBarcodeKeyDown}
            disabled={scanLoading}
            autoComplete="off"
          />
        </form>
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
            <div className="assembly-composition">
              <span className="assembly-composition-label">Состав заказа:</span>
              <ul className="assembly-composition-list">
                {compositionLines.map((line, idx) => (
                  <li key={`${line.key}-${idx}`}>
                    {line.productId ? (
                      <>
                        {line.externalId ? `${line.externalId}, ` : ''}
                        <Link
                          to={`/products?open=${line.productId}`}
                          className="assembly-product-link"
                          title="Открыть товар в каталоге"
                        >
                          {line.name}
                        </Link>
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
                  Все позиции отсканированы. Завершите сборку — этикетка уйдёт в печать автоматически.
                </p>
                <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button
                    variant="primary"
                    onClick={() => void handleFinishScanAssembly()}
                    disabled={finishScanSubmitting}
                  >
                    {finishScanSubmitting ? '…' : 'Завершить сборку и напечатать'}
                  </Button>
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
                </div>
              </div>
            )}
            {String(currentOrderData?.order?.status ?? '').toLowerCase() === 'assembled' && (
              <div className="assembly-ready">
                <p className="assembly-ready-text">
                  Заказ собран
                  {currentOrderData.order.assemblyStickerNumber ? (
                    <>
                      . Стикер: <strong>{currentOrderData.order.assemblyStickerNumber}</strong>
                    </>
                  ) : null}
                  {' '}
                  <button
                    type="button"
                    className="assembly-label-link assembly-label-link-inline"
                    title="Печать этикетки"
                    aria-label="Печать этикетки заказа"
                    onClick={() => requestLabelPrint(currentOrderData.order.orderId)}
                  >
                    <OrderLabelIcon size={20} />
                  </button>
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
                const sticker =
                  primary.assemblyStickerNumber ?? primary.assembly_sticker_number ?? '—';
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
                                <Link
                                  to={`/products?open=${erpPid}`}
                                  className="assembly-product-link"
                                  title="Открыть товар в каталоге"
                                >
                                  {name}
                                </Link>
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
                    <td>{sticker}</td>
                    <td>
                      <div className="assembly-row-actions">
                        <button
                          type="button"
                          className="assembly-label-link"
                          title="Печать стикера"
                          aria-label="Печать этикетки заказа"
                          onClick={() => requestLabelPrint(primary.orderId)}
                        >
                          <OrderLabelIcon size={20} />
                        </button>
                        <Button
                          variant="primary"
                          size="small"
                          onClick={() => handleManualAssembleFromTable(primary)}
                          disabled={isReturnLoading || finishScanSubmitting}
                          title="Отметить заказ собранным без сканирования и напечатать этикетку"
                        >
                          ✓ Собрать
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
                const sticker =
                  o.assemblyStickerNumber ?? o.assembly_sticker_number ?? '—';
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
                        <Link
                          to={`/products?open=${erpPidCol}`}
                          className="assembly-product-link"
                          title="Открыть товар в каталоге"
                        >
                          {o.productName || o.product_name || '—'}
                        </Link>
                      ) : (
                        o.productName || o.product_name || '—'
                      )}
                    </td>
                    <td>{o.quantity ?? '—'}</td>
                    <td>{assembledLabel}</td>
                    <td>{who}</td>
                    <td>{sticker}</td>
                    <td>
                      <div className="assembly-row-actions">
                        <button
                          type="button"
                          className="assembly-label-link"
                          title="Печать стикера"
                          aria-label="Печать этикетки заказа"
                          onClick={() => requestLabelPrint(o.orderId)}
                        >
                          <OrderLabelIcon size={20} />
                        </button>
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

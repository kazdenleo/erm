import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { assemblyApi, ordersApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { scanError, scanOk } from '../../lib/feedback';
import { printOrderLabel } from '../../lib/labels';
import { readItem } from '../../lib/storage';
import {
  applyAssemblyBarcodeScan,
  applyAssemblyPickScan,
  assemblyLineScanKey,
  assemblyPickedItemsList,
  isAssemblyCompositionComplete,
  isKitSkuScanForOrder,
  isRootKitSkuScanForOrder,
  normalizeMarketplaceForUI,
  orderGroupKey,
  orderItemMatchesScannedProduct,
  scannedProductStillNeededOnOrder,
  scannedQtyForAssemblyLine,
  singleOrderListGroupKey,
} from '../../shared/erpUtils';

const ORDERS_REFRESH_MS = 60000;

/** Ключ сессии скана — как на веб-странице сборки (группа МП или одиночный заказ). */
export function assemblySessionKey(order) {
  if (!order) return '';
  const mp = normalizeMarketplaceForUI(order.marketplace);
  const ogk = orderGroupKey(order);
  return ogk ? `${mp}|g:${ogk}` : singleOrderListGroupKey(order);
}

function productNameOf(o) {
  return String(o?.productName || o?.product_name || o?.orderId || '').toLowerCase();
}

function groupBySessionKey(rows) {
  const order = [];
  const byKey = new Map();
  for (const o of rows) {
    const k = assemblySessionKey(o);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      order.push(k);
    }
    byKey.get(k).push(o);
  }
  return order.map((k) => ({ key: k, rows: byKey.get(k), primary: byKey.get(k)[0] }));
}

function isCurrentComplete(cur, scanned) {
  if (!cur?.order) return false;
  const items = cur.orderItems || [];
  if (items.length) return isAssemblyCompositionComplete(items, scanned);
  const pid = Number(cur.product?.id);
  return (scanned[pid] ?? 0) >= (Number(cur.order.quantity) || 1);
}

export function useAssemblySession() {
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [marketplace, setMarketplace] = useState('all');
  const [current, setCurrent] = useState(null);
  const [scanned, setScanned] = useState({});
  const [picked, setPicked] = useState({});
  /** idle | collecting | finishing | collected | finishFailed */
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);

  const busyRef = useRef(false);
  const stateRef = useRef({});

  const loadOrders = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setOrdersLoading(true);
    try {
      const list = await ordersApi.listInAssembly();
      setOrders(list);
      setOrdersError(null);
    } catch (e) {
      setOrdersError(errorMessage(e, 'Не удалось загрузить заказы'));
    } finally {
      if (!silent) setOrdersLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadOrders({ silent: true }).finally(() => setOrdersLoading(false));
      const t = setInterval(() => loadOrders({ silent: true }), ORDERS_REFRESH_MS);
      return () => clearInterval(t);
    }, [loadOrders])
  );

  const groups = useMemo(() => {
    const list =
      marketplace === 'all'
        ? orders
        : orders.filter((o) => normalizeMarketplaceForUI(o.marketplace) === marketplace);
    const sorted = [...list].sort((a, b) => productNameOf(a).localeCompare(productNameOf(b), 'ru'));
    return groupBySessionKey(sorted);
  }, [orders, marketplace]);

  const listOrder = useMemo(
    () =>
      groups.flatMap(({ rows }) =>
        rows.map((o) => ({ marketplace: o.marketplace, orderId: String(o.orderId ?? o.order_id ?? '') }))
      ),
    [groups]
  );

  // Сканы приходят из событий (сканер, камера) — читаем актуальное состояние через ref.
  useEffect(() => {
    stateRef.current = { current, scanned, picked, phase, marketplace, listOrder };
  }, [current, scanned, picked, phase, marketplace, listOrder]);

  const countsByMarketplace = useMemo(() => {
    const counts = { all: 0 };
    for (const g of groupBySessionKey(orders)) {
      const mp = normalizeMarketplaceForUI(g.primary.marketplace);
      counts[mp] = (counts[mp] || 0) + 1;
      counts.all += 1;
    }
    return counts;
  }, [orders]);

  const printLabel = useCallback(async (orderId) => {
    setPrinting(true);
    try {
      await printOrderLabel(orderId);
    } catch (e) {
      setMessage({ kind: 'error', text: `Печать: ${errorMessage(e)}` });
    } finally {
      setPrinting(false);
    }
  }, []);

  const finish = useCallback(
    async (cur, pickedSnapshot) => {
      setPhase('finishing');
      try {
        const res = await assemblyApi.markCollected(cur.order.marketplace, cur.order.orderId, {
          stickerNumber: cur.order.assemblyStickerNumber ?? cur.order.assembly_sticker_number ?? null,
          pickedItems: assemblyPickedItemsList(pickedSnapshot),
        });
        setPhase('collected');
        setCurrent((prev) =>
          prev && prev.key === cur.key ? { ...prev, order: { ...prev.order, status: 'assembled' } } : prev
        );
        setMessage({ kind: 'success', text: 'Заказ собран' });
        loadOrders({ silent: true });
        if ((await readItem('autoPrintLabel')) === '1' && res?.labelReady !== false) {
          printLabel(cur.order.orderId);
        }
      } catch (e) {
        setPhase('finishFailed');
        scanError();
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось отметить заказ собранным') });
      }
    },
    [loadOrders, printLabel]
  );

  const handleScan = useCallback(
    async (code) => {
      if (busyRef.current) return;
      const st = stateRef.current;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const cur = st.current;
        const qty = st.scanned;
        const curItems = cur?.orderItems || [];
        const curOpen =
          !!cur?.order?.orderId && st.phase !== 'collected' && !isCurrentComplete(cur, qty);

        const data = await assemblyApi.findByBarcode(code, {
          marketplace: st.marketplace,
          listOrder: st.listOrder,
          ...(curOpen
            ? {
                preferOrderId: cur.order.orderId,
                preferMarketplace: normalizeMarketplaceForUI(cur.order.marketplace),
              }
            : {}),
        });
        if (!data?.order || !data?.product) {
          setMessage({ kind: 'error', text: 'Заказ с таким штрихкодом не найден на сборке' });
          scanError();
          return;
        }
        if (st.marketplace !== 'all' && normalizeMarketplaceForUI(data.order.marketplace) !== st.marketplace) {
          setMessage({ kind: 'error', text: 'Заказ относится к другому маркетплейсу. Сбросьте фильтр.' });
          scanError();
          return;
        }

        let order = data.order;
        let orderItems = data.orderItems || [];
        // Пока текущий состав не закрыт — принимаем только ещё нужные штрихкоды этого заказа.
        if (curOpen && curItems.length > 0) {
          if (!scannedProductStillNeededOnOrder(data.product, curItems, qty)) {
            const onCurrent =
              isKitSkuScanForOrder(data.product, curItems) ||
              isRootKitSkuScanForOrder(data.product, curItems) ||
              curItems.some((item) => orderItemMatchesScannedProduct(item, data.product));
            setMessage({
              kind: 'error',
              text: onCurrent
                ? 'Этот товар уже отсканирован в текущем заказе. Отсканируйте оставшиеся позиции.'
                : 'Этот товар не нужен в текущем заказе. Дособерите его или сбросьте сессию.',
            });
            scanError();
            return;
          }
          order = cur.order;
          orderItems = curItems;
        }

        const key = assemblySessionKey(order);
        const sameOrder = !!cur && key === cur.key && st.phase !== 'collected';
        const scannedBefore = sameOrder ? qty : {};
        const kitUnits =
          Number(order.productId ?? order.product_id) === Number(data.product.id) ? Number(order.quantity) || 1 : 1;
        let nextScanned = applyAssemblyBarcodeScan(scannedBefore, data.product, orderItems);
        if (!orderItems.length) {
          const pid = Number(data.product.id);
          nextScanned = { ...nextScanned, [pid]: (nextScanned[pid] || 0) + 1 };
        }
        const nextPicked = applyAssemblyPickScan(sameOrder ? st.picked : {}, data.product, orderItems, scannedBefore, {
          kitUnits,
        });
        const nextCurrent = { key, order, product: data.product, orderItems };
        setCurrent(nextCurrent);
        setScanned(nextScanned);
        setPicked(nextPicked);
        scanOk();

        if (isCurrentComplete(nextCurrent, nextScanned)) {
          await finish(nextCurrent, nextPicked);
        } else {
          setPhase('collecting');
        }
      } catch (e) {
        setMessage({ kind: 'error', text: errorMessage(e, 'Ошибка поиска заказа') });
        scanError();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [finish]
  );

  const retryFinish = useCallback(async () => {
    const st = stateRef.current;
    if (!st.current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await finish(st.current, st.picked);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [finish]);

  const reset = useCallback(() => {
    setCurrent(null);
    setScanned({});
    setPicked({});
    setPhase('idle');
    setMessage(null);
  }, []);

  /** Смена фильтра МП сбрасывает текущий заказ, если он с другого маркетплейса. */
  const changeMarketplace = useCallback(
    (mp) => {
      setMarketplace(mp);
      const cur = stateRef.current.current;
      if (cur?.order && mp !== 'all' && normalizeMarketplaceForUI(cur.order.marketplace) !== mp) reset();
    },
    [reset]
  );

  const lines = useMemo(() => {
    const items = current?.orderItems || [];
    return items.map((item, idx) => {
      const need = Number(item.quantity ?? 1);
      const got = Math.min(need, scannedQtyForAssemblyLine(item, idx, scanned, items));
      return {
        key: assemblyLineScanKey(item, idx, items),
        name: item.productName || item.product_name || '—',
        attribute: String(item.displayAttributeValue ?? item.display_attribute_value ?? '').trim(),
        article: String(item.offerId ?? item.orderLineId ?? '').trim(),
        need,
        scanned: got,
      };
    });
  }, [current, scanned]);

  return {
    orders,
    groups,
    countsByMarketplace,
    ordersLoading,
    ordersError,
    reloadOrders: loadOrders,
    marketplace,
    setMarketplace: changeMarketplace,
    current,
    lines,
    phase,
    message,
    clearMessage: () => setMessage(null),
    busy,
    printing,
    handleScan,
    retryFinish,
    reset,
    printLabel,
  };
}

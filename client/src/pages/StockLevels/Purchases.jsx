/**
 * Purchases (Stock incoming)
 * Минимальный UI: список закупок → детали → создать приёмку → сканирование.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LinkBarcodeToProductModal } from '../../components/common/LinkBarcodeToProductModal/LinkBarcodeToProductModal';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import {
  matchProductsLocal,
  mergeProductLists,
  normalizeProductSearchQuery,
  searchProductsRemote,
} from '../../utils/productSearch';
import { useNavigate } from 'react-router-dom';
import { purchasesApi } from '../../services/purchases.api';
import { productsApi } from '../../services/products.api';
import { useProducts } from '../../hooks/useProducts';
import './WarehouseOperations.css';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { onNavigationClick } from '../../utils/navigationClick.js';
import { supplierPrefixesFromApiConfig } from '../../utils/supplierArticlePrefixes';

const RECEIPT_SCANNER_ID_LS = 'erm:purchase-receipt-scanner-id';

function getOrCreateScannerId() {
  try {
    const existing = typeof localStorage !== 'undefined' ? localStorage.getItem(RECEIPT_SCANNER_ID_LS) : null;
    if (existing && String(existing).trim()) return String(existing).trim();
  } catch {
    /* ignore */
  }
  const next = `scn-${Math.random().toString(16).slice(2, 8)}`;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(RECEIPT_SCANNER_ID_LS, next);
  } catch {
    /* ignore */
  }
  return next;
}

function normalizeScanInput(raw) {
  return String(raw || '').replace(/[\r\n]+/g, '').trim();
}

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function qtyCell(raw) {
  if (raw == null || raw === '') return '—';
  const n = Number(raw);
  return Number.isFinite(n) ? n : '—';
}

function formatPurchaseApiError(e, fallback) {
  return getApiErrorMessage(e, fallback);
}

/** Частичное или полное уменьшение «ожидалось» по строке закупки (поле «На … шт.» + «Уменьшить»). */
function PurchaseLineReduceControls({
  purchaseId,
  itemId,
  expected,
  received,
  unreceived,
  onDone,
  setErr,
  busy,
  setBusy,
}) {
  const [qtyStr, setQtyStr] = useState(String(unreceived));

  useEffect(() => {
    setQtyStr(String(unreceived));
  }, [itemId, unreceived]);

  const parsed = parseInt(String(qtyStr).trim(), 10);
  const rbCap = Math.min(Math.max(1, Number.isFinite(parsed) ? parsed : 0), unreceived);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= unreceived;
  const newExpected = expected - rbCap;
  const newUnreceived = newExpected - received;

  return (
    <div
      className="purchase-line-reduce-controls"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: 320 }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="muted" style={{ fontSize: 12 }}>
        На
      </span>
      <input
        type="number"
        className="warehouse-ops-qty-input"
        style={{ width: 72 }}
        min={1}
        max={unreceived}
        value={qtyStr}
        onChange={(e) => setQtyStr(e.target.value)}
      />
      <span className="muted" style={{ fontSize: 12 }}>
        шт.
      </span>
      <Button
        variant="secondary"
        size="small"
        disabled={!valid || busy}
        title={
          valid
            ? `После: ожидалось ${newExpected}, непринято ${newUnreceived}`
            : `Укажите от 1 до ${unreceived}`
        }
        onClick={async () => {
          if (busy) return;
          const rb = Math.min(
            Math.max(1, parseInt(String(qtyStr).trim(), 10) || 0),
            unreceived
          );
          const ne = expected - rb;
          const nu = ne - received;
          let msg;
          if (received > 0) {
            msg = `Уменьшить ожидание на ${rb} шт.? Станет «ожидалось» ${ne} (принято ${received}), непринято ${nu}. Часть заказов в привязке сверх ${ne} вернётся в «Новый», если нет другой закупки. Дальше можно снова оформить приёмку на остаток.`;
          } else if (rb >= unreceived) {
            msg = `Снять всё непринятое (${unreceived} шт.) и удалить строку из закупки?`;
          } else {
            msg = `Уменьшить ожидание на ${rb} шт.? Останется ждать ${ne} шт. по этой строке — позже можно принять их этой же закупкой.`;
          }
          if (!window.confirm(msg)) return;
          try {
            setBusy(itemId);
            setErr(null);
            await purchasesApi.removeDraftLineItem(purchaseId, itemId, { reduceBy: rb });
            await onDone();
          } catch (e) {
            setErr(formatPurchaseApiError(e, 'Не удалось изменить строку'));
          } finally {
            setBusy(null);
          }
        }}
      >
        {busy ? '…' : 'Уменьшить'}
      </Button>
    </div>
  );
}

function formatSourceOrders(raw) {
  if (!raw) return '—';
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return '—';
    }
  }
  if (!Array.isArray(list) || list.length === 0) return '—';
  const parts = [];
  for (const o of list) {
    if (!o) continue;
    const mp = String(o.marketplace || '').trim();
    const id = String(o.orderId ?? '').trim();
    if (!id) continue;
    parts.push(mp ? `${mp}:${id}` : id);
  }
  if (parts.length === 0) return '—';
  const shown = parts.slice(0, 4);
  const tail = parts.length > shown.length ? ` +${parts.length - shown.length}` : '';
  return shown.join(', ') + tail;
}

export function Purchases() {
  const navigate = useNavigate();
  const { products } = useProducts({ autoLoad: false });
  const { warehouses } = useWarehouses();
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const [showArchived, setShowArchived] = useState(false);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [importOk, setImportOk] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createSupplierId, setCreateSupplierId] = useState('');
  const [createOrganizationId, setCreateOrganizationId] = useState('');
  const [createWarehouseId, setCreateWarehouseId] = useState('');
  const [createItems, setCreateItems] = useState([{ productId: '', quantity: 1 }]);
  const [createProductSearch, setCreateProductSearch] = useState('');
  const [createSearchResults, setCreateSearchResults] = useState([]);
  const [createSearchLoading, setCreateSearchLoading] = useState(false);
  const [excelImportLoading, setExcelImportLoading] = useState(false);
  const excelInputRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [receipt, setReceipt] = useState(null);
  const [scanValue, setScanValue] = useState('');
  const scanRef = useRef(null);
  const scanDebounceRef = useRef(null);
  const [scannerId, setScannerId] = useState(() => getOrCreateScannerId());
  const scanInFlightRef = useRef(false);
  const lastScanRef = useRef({ value: '', at: 0 });
  const receiptRefreshTimerRef = useRef(null);
  const receiptRefreshInFlightRef = useRef(false);
  const [pendingScans, setPendingScans] = useState(0);
  const pendingScansRef = useRef(0);
  const [scanMsg, setScanMsg] = useState(null);
  const [lastScanLine, setLastScanLine] = useState(null);
  const [boxAddCode, setBoxAddCode] = useState('');
  const [boxAddQty, setBoxAddQty] = useState('');
  const [boxAddBusy, setBoxAddBusy] = useState(false);
  const [createReceiptBusy, setCreateReceiptBusy] = useState(false);
  const [extrasToResolve, setExtrasToResolve] = useState(null);
  const [receiptWarehouseId, setReceiptWarehouseId] = useState('');
  const [receiptSupplierId, setReceiptSupplierId] = useState('');
  const [receiptOrganizationId, setReceiptOrganizationId] = useState('');
  /** null | 'asc' | 'desc' — сортировка позиций закупки по «Ожидалось» */
  const [detailExpectedQtySort, setDetailExpectedQtySort] = useState(null);
  const [lineActionBusy, setLineActionBusy] = useState(null);
  const [deletePurchaseBusy, setDeletePurchaseBusy] = useState(false);
  const detailErrRef = useRef(null);
  /** null | 'asc' | 'desc' — сортировка строк приёмки по отсканированному количеству */
  const [receiptScannedQtySort, setReceiptScannedQtySort] = useState(null);
  const [linkBarcodeOpen, setLinkBarcodeOpen] = useState(false);
  const [linkBarcodeValue, setLinkBarcodeValue] = useState('');
  const purchaseLinkRetryRef = useRef(null);

  const sortedDetailItems = useMemo(() => {
    const items = detail?.items;
    if (!Array.isArray(items) || items.length === 0) return [];
    if (detailExpectedQtySort == null) return items;
    const dir = detailExpectedQtySort === 'asc' ? 1 : -1;
    const qty = (it) => {
      const n = Number(it.expected_quantity);
      return Number.isFinite(n) ? n : 0;
    };
    return [...items].sort((a, b) => {
      const d = qty(a) - qty(b);
      if (d !== 0) return d * dir;
      const sa = String(a.product_sku || a.id || '');
      const sb = String(b.product_sku || b.id || '');
      return sa.localeCompare(sb, 'ru', { numeric: true });
    });
  }, [detail?.items, detailExpectedQtySort]);

  const sortedReceiptItems = useMemo(() => {
    const items = receipt?.items;
    if (!Array.isArray(items) || items.length === 0) return [];
    if (receiptScannedQtySort == null) return items;
    const dir = receiptScannedQtySort === 'asc' ? 1 : -1;
    const qty = (it) => {
      const n = Number(it.scanned_quantity);
      return Number.isFinite(n) ? n : 0;
    };
    return [...items].sort((a, b) => {
      const d = qty(a) - qty(b);
      if (d !== 0) return d * dir;
      const sa = String(a.product_sku || a.id || '');
      const sb = String(b.product_sku || b.id || '');
      return sa.localeCompare(sb, 'ru', { numeric: true });
    });
  }, [receipt?.items, receiptScannedQtySort]);

  useEffect(() => {
    setDetailExpectedQtySort(null);
  }, [detail?.purchase?.id]);

  useEffect(() => {
    setReceiptScannedQtySort(null);
  }, [receipt?.receipt?.id]);

  const reload = async (opts = {}) => {
    const includeArchived = opts.includeArchived ?? showArchived;
    setLoading(true);
    setErr(null);
    try {
      const data = await purchasesApi.list({
        limit: 200,
        ...(includeArchived ? { includeArchived: true } : {}),
      });
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload({ includeArchived: showArchived });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  const productOptions = useMemo(() => {
    return (products || []).map((p) => ({
      id: p.id,
      label: `${p.sku || p.id} — ${p.name || 'Без названия'}`,
    }));
  }, [products]);

  const createFilteredProductOptions = useMemo(() => {
    const q = normalizeProductSearchQuery(createProductSearch);
    if (!q) return productOptions;
    const ids = new Set(
      (createSearchResults.length ? createSearchResults : matchProductsLocal(products, q)).map((p) =>
        String(p.id)
      )
    );
    if (ids.size === 0) return productOptions;
    return productOptions.filter((o) => ids.has(String(o.id)));
  }, [productOptions, createProductSearch, createSearchResults, products]);

  const closeCreateModal = useCallback(() => {
    setCreateOpen(false);
    setCreateProductSearch('');
    setCreateSearchResults([]);
    setCreateSearchLoading(false);
    setExcelImportLoading(false);
  }, []);

  const createSupplierPrefixes = useMemo(() => {
    if (!createSupplierId) return [];
    const s = (suppliers || []).find((x) => String(x.id) === String(createSupplierId));
    return supplierPrefixesFromApiConfig(s?.apiConfig || s?.api_config || {});
  }, [suppliers, createSupplierId]);

  const createProductLabelById = useMemo(() => {
    const m = new Map();
    for (const p of createSearchResults) {
      if (p?.id != null) m.set(String(p.id), `${p.sku || '—'} — ${p.name || 'Без названия'}`);
    }
    return m;
  }, [createSearchResults]);

  const addProductToCreateItems = useCallback((product, addQty = 1) => {
    const id = product?.id;
    if (id == null || id === '') return;
    setCreateSearchResults((prev) => mergeProductLists(prev, [product]));
    const add = Math.max(1, parseInt(addQty, 10) || 1);
    const idStr = String(id);
    setCreateItems((prev) => {
      const idx = prev.findIndex((x) => String(x.productId) === idStr);
      if (idx >= 0) {
        const cur = Number(prev[idx].quantity) || 0;
        return prev.map((x, i) => (i === idx ? { ...x, productId: idStr, quantity: cur + add } : x));
      }
      const emptyIdx = prev.findIndex((x) => !x.productId);
      if (emptyIdx >= 0) {
        return prev.map((x, i) => (i === emptyIdx ? { ...x, productId: idStr, quantity: add } : x));
      }
      return [...prev, { productId: idStr, quantity: add }];
    });
  }, []);

  useEffect(() => {
    if (!createOpen) return undefined;
    const q = normalizeProductSearchQuery(createProductSearch);
    if (!q) {
      setCreateSearchResults([]);
      setCreateSearchLoading(false);
      return undefined;
    }
    const local = matchProductsLocal(products, q);
    if (local.length) setCreateSearchResults(local);
    let cancelled = false;
    const timer = setTimeout(async () => {
      setCreateSearchLoading(true);
      try {
        const res = await productsApi.getAll({ search: q, limit: 40 });
        const remote = Array.isArray(res?.data) ? res.data : [];
        if (!cancelled) setCreateSearchResults(mergeProductLists(local, remote));
      } catch {
        if (!cancelled) setCreateSearchResults(local);
      } finally {
        if (!cancelled) setCreateSearchLoading(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [createOpen, createProductSearch, products]);

  const resolveProductForCreate = useCallback(
    async (raw) => {
      const v = normalizeProductSearchQuery(raw);
      if (!v) return null;
      try {
        const res = await productsApi.getByBarcode(v);
        const byBarcode = res?.data ?? res;
        if (byBarcode?.id) return byBarcode;
      } catch {
        /* fallback */
      }
      const local = matchProductsLocal(products, v);
      if (local.length === 1) return local[0];
      const fromResults = createSearchResults.length ? createSearchResults : local;
      if (fromResults.length === 1) return fromResults[0];
      try {
        const res = await productsApi.getAll({ search: v, limit: 5 });
        const list = Array.isArray(res?.data) ? res.data : [];
        if (list.length === 1) return list[0];
      } catch {
        /* ignore */
      }
      return null;
    },
    [products, createSearchResults]
  );

  const handleCreateSearchSubmit = useCallback(
    async (e) => {
      e?.preventDefault?.();
      const q = normalizeProductSearchQuery(createProductSearch);
      if (!q) return;
      setErr(null);
      const matches =
        createSearchResults.length > 0 ? createSearchResults : matchProductsLocal(products, q);
      if (matches.length > 1) return;
      const product = matches.length === 1 ? matches[0] : await resolveProductForCreate(q);
      if (!product?.id) {
        setErr('Товар не найден. Уточните артикул, название или штрихкод.');
        return;
      }
      addProductToCreateItems(product, 1);
      setCreateProductSearch('');
      setCreateSearchResults([]);
    },
    [
      createProductSearch,
      createSearchResults,
      products,
      resolveProductForCreate,
      addProductToCreateItems
    ]
  );

  useEffect(() => {
    if (err && detail && detailErrRef.current) {
      detailErrRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [err, detail]);

  const openDetail = async (id) => {
    setErr(null);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await purchasesApi.getById(id);
      setDetail(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупку');
    } finally {
      setDetailLoading(false);
    }
  };

  const openReceipt = async (receiptId) => {
    try {
      const data = await purchasesApi.getReceipt(receiptId);
      setReceipt(data);
      setScanMsg(null);
      setLastScanLine(null);
      const p = data?.purchase || {};
      const dp = detail?.purchase;
      setReceiptWarehouseId(
        p.warehouseId != null
          ? String(p.warehouseId)
          : dp?.warehouse_id != null
            ? String(dp.warehouse_id)
            : ''
      );
      setReceiptSupplierId(
        p.supplierId != null
          ? String(p.supplierId)
          : dp?.supplier_id != null
            ? String(dp.supplier_id)
            : ''
      );
      setReceiptOrganizationId(
        p.organizationId != null
          ? String(p.organizationId)
          : dp?.organization_id != null
            ? String(dp.organization_id)
            : ''
      );
      setTimeout(() => scanRef.current?.focus(), 80);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось открыть приёмку');
    }
  };

  const createPurchase = async () => {
    const items = createItems
      .map((it) => ({
        productId: it.productId ? Number(it.productId) : null,
        quantity: Number(it.quantity) || 1,
      }))
      .filter((it) => it.productId && it.quantity > 0);
    if (items.length === 0) {
      setErr('Добавьте хотя бы одну позицию');
      return;
    }
    if (!String(createSupplierId || '').trim()) {
      setErr('Выберите поставщика');
      return;
    }
    if (!String(createOrganizationId || '').trim()) {
      setErr('Выберите организацию');
      return;
    }
    if (!String(createWarehouseId || '').trim()) {
      setErr('Выберите склад назначения');
      return;
    }
    try {
      const res = await purchasesApi.create({
        supplierId: Number(createSupplierId),
        organizationId: Number(createOrganizationId),
        warehouseId: Number(createWarehouseId),
        items,
      });
      closeCreateModal();
      setCreateSupplierId('');
      setCreateOrganizationId('');
      setCreateWarehouseId('');
      setCreateItems([{ productId: '', quantity: 1 }]);
      await reload();
      if (res?.id) openDetail(res.id);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось создать закупку');
    }
  };

  const importPurchaseFromExcel = async (file) => {
    if (!file) return;
    if (!String(createSupplierId || '').trim()) {
      setErr('Выберите поставщика');
      return;
    }
    if (!String(createOrganizationId || '').trim()) {
      setErr('Выберите организацию');
      return;
    }
    if (!String(createWarehouseId || '').trim()) {
      setErr('Выберите склад назначения');
      return;
    }
    setExcelImportLoading(true);
    setErr(null);
    setImportOk(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('supplierId', String(createSupplierId));
      formData.append('organizationId', String(createOrganizationId));
      formData.append('warehouseId', String(createWarehouseId));
      const res = await purchasesApi.importFromExcel(formData);
      const summary = res?.importSummary;
      if (summary?.parserVersion && summary.parserVersion !== 'v4-article-qty-cost') {
        setErr(
          `На сервере старая версия импорта (${summary.parserVersion}). Нужны git pull и pm2 restart erm-api.`
        );
        return;
      }
      if (summary) {
        const lines = (summary.preview || [])
          .filter((p) => (p.excelLines?.length || 0) > 1)
          .map((p) => `${p.cleanSku}: ${p.quantity} шт. (${(p.excelLines || []).map((l) => l.qty).join('+')})`)
          .slice(0, 5);
        const dupNote = lines.length ? ` Суммы дублей: ${lines.join('; ')}.` : '';
        setImportOk(
          `Импорт ${summary.parserVersion || ''}: ${summary.excelDataRows ?? '—'} строк Excel → ${summary.totalQuantity ?? '—'} шт.${dupNote}`
        );
      }
      closeCreateModal();
      setCreateSupplierId('');
      setCreateOrganizationId('');
      setCreateWarehouseId('');
      setCreateItems([{ productId: '', quantity: 1 }]);
      await reload();
      if (res?.id) openDetail(res.id);
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось импортировать Excel';
      const unresolved = e.response?.data?.details?.unresolved;
      if (Array.isArray(unresolved) && unresolved.length > 0) {
        const extra = unresolved
          .slice(0, 15)
          .map((u) => `${u.cleanSku} (${u.quantity} шт.)`)
          .join(', ');
        const tail = unresolved.length > 15 ? ` … +${unresolved.length - 15}` : '';
        setErr(`${msg}${extra ? `\n${extra}${tail}` : ''}`);
      } else {
        setErr(msg);
      }
    } finally {
      setExcelImportLoading(false);
      if (excelInputRef.current) excelInputRef.current.value = '';
    }
  };

  const scheduleReceiptRefresh = useCallback(
    (rid) => {
      const id = rid != null ? Number(rid) : null;
      if (!id || Number.isNaN(id)) return;
      if (receiptRefreshTimerRef.current) {
        clearTimeout(receiptRefreshTimerRef.current);
        receiptRefreshTimerRef.current = null;
      }
      // При активном сканировании не дёргаем getReceipt после каждого скана:
      // один запрос раз в ~1.5с хорошо балансирует актуальность и нагрузку при нескольких сканерах.
      receiptRefreshTimerRef.current = setTimeout(async () => {
        if (receiptRefreshInFlightRef.current) return;
        receiptRefreshInFlightRef.current = true;
        try {
          const data = await purchasesApi.getReceipt(id);
          setReceipt(data);
        } catch {
          /* ignore */
        } finally {
          receiptRefreshInFlightRef.current = false;
        }
      }, 1500);
    },
    [setReceipt]
  );

  // Пока приёмка открыта и идёт поток сканов — периодически подтягиваем состояние (на случай пропущенных строк/излишков).
  useEffect(() => {
    const rid = receipt?.receipt?.id;
    if (!rid) return undefined;
    if (pendingScansRef.current <= 0) return undefined;
    let mounted = true;
    const t = setInterval(() => {
      if (!mounted) return;
      if (pendingScansRef.current <= 0) return;
      scheduleReceiptRefresh(rid);
    }, 2000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [receipt?.receipt?.id, scheduleReceiptRefresh, pendingScans]);

  const scan = async (valueOverride) => {
    const rid = receipt?.receipt?.id;
    const v = normalizeScanInput(valueOverride ?? scanValue ?? '');
    if (!rid || !v) return;
    const effectiveScannerId = scannerId || null;
    if (!v) return;
    // Защита от двойного скана: некоторые сканеры шлют и \n, и Enter,
    // из-за чего scan() вызывается два раза почти одновременно.
    const now = Date.now();
    if (scanInFlightRef.current) return;
    const lastKey = `${effectiveScannerId || 'no-scanner'}|${v}`;
    if (lastScanRef.current.value === lastKey && now - (lastScanRef.current.at || 0) < 500) return;
    scanInFlightRef.current = true;
    lastScanRef.current = { value: lastKey, at: now };
    try {
      setScanMsg('Сканирую…');
      setLastScanLine(null);
      const before = new Map();
      for (const it of (receipt?.items || [])) {
        if (!it || it.id == null) continue;
        before.set(String(it.id), Number(it.scanned_quantity) || 0);
      }
      pendingScansRef.current += 1;
      setPendingScans(pendingScansRef.current);
      const scanRes = await purchasesApi.scanReceipt(rid, { barcode: v, scannerId: effectiveScannerId });
      // Оптимистично обновим строку по ответу сервера (productId + scannedQuantity),
      // а полный receipt подтянем с debounce — чтобы несколько сканеров не "забивали" API.
      const updatedProductId = Number(scanRes?.productId);
      const updatedScannedQty = Number(scanRes?.scannedQuantity);
      if (Number.isFinite(updatedProductId) && Number.isFinite(updatedScannedQty) && updatedScannedQty >= 0) {
        setReceipt((prev) => {
          if (!prev?.receipt) return prev;
          const items = Array.isArray(prev.items) ? prev.items : [];
          let hit = false;
          const nextItems = items.map((it) => {
            if (Number(it?.product_id) !== updatedProductId) return it;
            hit = true;
            return { ...it, scanned_quantity: updatedScannedQty };
          });
          // Если товара ещё нет в списке строк (редкий кейс: скан вне позиций закупки) — просто дождёмся refresh.
          return hit ? { ...prev, items: nextItems } : prev;
        });
      }
      scheduleReceiptRefresh(rid);
      // UI списка закупок обновится при следующем reload; не дёргаем его на каждый скан.
      setScanValue('');
      setScanMsg(null);
      playEventSound(SOUND_EVENTS.scan_ok);

      // Быстрый статус по последнему скану (без ожидания getReceipt)
      if (Number.isFinite(updatedProductId) && Number.isFinite(updatedScannedQty)) {
        const curItems = Array.isArray(receipt?.items) ? receipt.items : [];
        const hit = curItems.find((it) => Number(it?.product_id) === updatedProductId) || null;
        if (hit) {
          const exp = Number(hit.expected_quantity);
          const expected = Number.isFinite(exp) ? exp : null;
          const rec = Number(hit.received_quantity);
          const received = Number.isFinite(rec) ? rec : null;
          const over = expected != null && updatedScannedQty > expected;
          setLastScanLine({
            sku: hit.product_sku || '—',
            name: hit.product_name || '—',
            expected,
            received,
            scanned: updatedScannedQty,
            over,
          });
        }
      }
      scanRef.current?.focus();
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Ошибка сканирования';
      const st = e.response?.status;
      if (st === 404 && /не найден/i.test(String(msg))) {
        purchaseLinkRetryRef.current = { rid, barcode: v };
        setLinkBarcodeValue(v);
        setLinkBarcodeOpen(true);
        setScanMsg(null);
      } else {
        setScanMsg(msg);
      }
      playEventSound(SOUND_EVENTS.scan_error);
      setScanValue('');
      scanRef.current?.focus();
    } finally {
      pendingScansRef.current = Math.max(0, pendingScansRef.current - 1);
      setPendingScans(pendingScansRef.current);
      scanInFlightRef.current = false;
    }
  };

  const handlePurchaseBarcodeLinked = useCallback(
    async () => {
      setLinkBarcodeOpen(false);
      setLinkBarcodeValue('');
      const pending = purchaseLinkRetryRef.current;
      purchaseLinkRetryRef.current = null;
      if (pending?.rid && pending?.barcode) {
        try {
          setScanMsg('Сканирую…');
          await purchasesApi.scanReceipt(pending.rid, {
            barcode: normalizeScanInput(pending.barcode),
            scannerId: scannerId || null
          });
          scheduleReceiptRefresh(pending.rid);
          setScanMsg('Ок');
          playEventSound(SOUND_EVENTS.scan_ok);
        } catch (e2) {
          setScanMsg(e2.response?.data?.message || e2.message || 'Ошибка сканирования');
          playEventSound(SOUND_EVENTS.scan_error);
        }
      }
      setTimeout(() => scanRef.current?.focus(), 50);
    },
    [scannerId, scheduleReceiptRefresh]
  );

  return (
    <div className="card">
      <h2 className="title">🧾 Закупка</h2>
      <p className="subtitle">Ожидание поставки (incoming) и приёмки по закупкам</p>

      {err && <p className="error">{err}</p>}
      {importOk && (
        <p className="muted" style={{ color: 'var(--success, #198754)', marginBottom: 12 }}>
          {importOk}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Button onClick={() => setCreateOpen(true)}>Новая закупка</Button>
        <Button variant="secondary" onClick={() => reload()} disabled={loading}>
          {loading ? '...' : 'Обновить'}
        </Button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', margin: 0 }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Показать архив
        </label>
      </div>

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : list.length === 0 ? (
        <p className="muted">Закупок пока нет.</p>
      ) : (
        <div className="warehouse-ops-receipts-list-wrap">
          <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>№</th>
                <th>Поставщик</th>
                <th>Получатель</th>
                <th>Склад</th>
                <th>Заказано, шт.</th>
                <th>Принято, шт.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr
                  key={p.id}
                  className="stock-levels-row-clickable"
                  onClick={onNavigationClick(() => openDetail(p.id))}
                >
                  <td>{fmtDt(p.created_at)}</td>
                  <td>№{p.id}</td>
                  <td>{p.supplier_name || '—'}</td>
                  <td>{p.organization_name || '—'}</td>
                  <td>{p.warehouse_name || '—'}</td>
                  <td>{qtyCell(p.expected_total ?? p.expectedTotal)}</td>
                  <td>{qtyCell(p.received_total ?? p.receivedTotal)}</td>
                  <td>
                    {String(p.status || '') === 'archived' ? (
                      <span className="muted" style={{ fontSize: 12 }}>Архив</span>
                    ) : (
                      <span className="muted">Подробнее →</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={createOpen} onClose={closeCreateModal} title="Новая закупка" size="xl">
        <p className="muted">Выберите поставщика, организацию и склад назначения, затем добавьте позиции вручную или импортируйте из Excel.</p>
        <input
          ref={excelInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importPurchaseFromExcel(f);
          }}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
          <select className="warehouse-ops-select" value={createSupplierId} onChange={(e) => setCreateSupplierId(e.target.value)}>
            <option value="">— Выберите поставщика —</option>
            {(suppliers || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || `Поставщик #${s.id}`}
              </option>
            ))}
          </select>

          <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
          <select
            className="warehouse-ops-select"
            value={createOrganizationId}
            onChange={(e) => setCreateOrganizationId(e.target.value)}
          >
            <option value="">— Выберите организацию —</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name || `Организация #${o.id}`}
              </option>
            ))}
          </select>

          <span className="muted" style={{ fontSize: 13 }}>Склад</span>
          <select className="warehouse-ops-select" value={createWarehouseId} onChange={(e) => setCreateWarehouseId(e.target.value)}>
            <option value="">— Выберите склад —</option>
            {(warehouses || [])
              .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name || w.address || w.city || `Склад #${w.id}`}
                </option>
              ))}
          </select>
        </div>
        {createSupplierPrefixes.length > 0 ? (
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Префиксы поставщика для Excel:{' '}
            <strong>{createSupplierPrefixes.map((p) => `"${p}"`).join(', ')}</strong> — будут сняты с начала артикула в файле.
          </p>
        ) : null}
        <div
          className="warehouse-ops-list-form"
          style={{ marginBottom: 14, borderTop: '1px solid var(--border, #e8e8e8)', paddingTop: 12 }}
        >
          <p className="warehouse-ops-hint" style={{ marginBottom: 8 }}>
            Импорт из Excel: A — артикул, B — количество, C — себестоимость (заголовок не обязателен), либо колонки «артикул», «количество», «себестоимость». Одинаковые артикулы суммируются. Себестоимость из файла попадёт в закупку и обновит cost товара при приёмке на склад. Если хотя бы один артикул не найден в каталоге, закупка не создаётся.
          </p>
          <div style={{ marginBottom: 12 }}>
            <Button
              type="button"
              variant="secondary"
              disabled={excelImportLoading}
              onClick={() => excelInputRef.current?.click()}
            >
              {excelImportLoading ? 'Импорт…' : 'Импорт из Excel'}
            </Button>
          </div>
          <p className="warehouse-ops-hint" style={{ marginBottom: 8 }}>
            Поиск товара по артикулу, названию или штрихкоду
          </p>
          <div style={{ marginBottom: 8 }}>
            <label htmlFor="purchase-create-product-search">Поиск (сканер или ввод)</label>
            <ProductSearchInput
              id="purchase-create-product-search"
              value={createProductSearch}
              onChange={setCreateProductSearch}
              products={products}
              organizationId={createOrganizationId}
              placeholder="Штрихкод, артикул, название"
              onSelect={(p) => {
                addProductToCreateItems(p, 1);
                setCreateProductSearch('');
                setCreateSearchResults([]);
                setErr(null);
              }}
            />
          </div>
          {createSearchLoading && (
            <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
              Поиск…
            </p>
          )}
          {!createSearchLoading &&
            normalizeProductSearchQuery(createProductSearch) &&
            createSearchResults.length > 1 && (
              <div style={{ marginBottom: 8, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border, #e8e8e8)', borderRadius: 6 }}>
                <div className="muted" style={{ fontSize: 12, padding: '6px 10px', borderBottom: '1px solid var(--border, #eee)' }}>
                  Выберите товар
                </div>
                {createSearchResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      border: 'none',
                      borderBottom: '1px solid var(--border, #f0f0f0)',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      addProductToCreateItems(p, 1);
                      setCreateProductSearch('');
                      setCreateSearchResults([]);
                      setErr(null);
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.sku || '—'}</div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>{p.name || 'Без названия'}</div>
                  </button>
                ))}
              </div>
            )}
        </div>
        {createItems.map((it, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="muted" style={{ minWidth: 200, fontSize: 13 }}>
              {it.productId
                ? createProductLabelById.get(String(it.productId)) || `Товар #${it.productId}`
                : '— добавьте через поиск выше —'}
            </span>
            <input
              className="warehouse-ops-qty-input"
              type="number"
              min={1}
              value={it.quantity}
              onChange={(e) => {
                const v = e.target.value;
                setCreateItems((prev) => prev.map((x, i) => (i === idx ? { ...x, quantity: v } : x)));
              }}
            />
            <Button
              variant="secondary"
              onClick={() => setCreateItems((prev) => prev.filter((_, i) => i !== idx))}
              disabled={createItems.length === 1}
            >
              Удалить
            </Button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => setCreateItems((prev) => [...prev, { productId: '', quantity: 1 }])}>
            + Позиция
          </Button>
          <Button onClick={createPurchase}>Сохранить</Button>
        </div>
      </Modal>

      <Modal
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.purchase?.id ? `Закупка №${detail.purchase.id}` : 'Закупка'}
        size="xl"
      >
        {detailLoading ? (
          <div className="loading">Загрузка…</div>
        ) : detail?.purchase ? (
          <>
            {err && (
              <p
                ref={detailErrRef}
                className="error"
                role="alert"
                style={{ marginBottom: 12 }}
              >
                {err}
              </p>
            )}
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              Создана: {fmtDt(detail.purchase.created_at)}. Ожидание (incoming) и резервы по заказам формируются при добавлении
              позиций; при приёмке товар уходит из ожидания на склад.
              {String(detail.purchase.status || '') === 'archived' && (
                <>
                  {' '}
                  <strong>В архиве</strong> (всё принято
                  {detail.purchase.completed_at ? ` · ${fmtDt(detail.purchase.completed_at)}` : ''}).
                </>
              )}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.supplier_id != null ? String(detail.purchase.supplier_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      supplierId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить поставщика');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.organization_id != null ? String(detail.purchase.organization_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      organizationId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить получателя');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(organizations || []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || `Организация #${o.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Склад (назначение)</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.warehouse_id != null ? String(detail.purchase.warehouse_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      warehouseId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить склад');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(warehouses || [])
                  .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.address || w.city || `Склад #${w.id}`}
                    </option>
                  ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <Button
                onClick={async () => {
                  if (createReceiptBusy) return;
                  if (String(detail?.purchase?.status || '') === 'archived') {
                    setErr('Закупка в архиве — всё принято. Создайте новую закупку для следующей поставки.');
                    return;
                  }
                  setCreateReceiptBusy(true);
                  try {
                    setErr(null);
                    const existingScanning = Array.isArray(detail?.receipts)
                      ? detail.receipts.find((x) => String(x?.status) === 'scanning')
                      : null;
                    if (existingScanning?.id) {
                      setErr(`У этой закупки уже есть незавершённая приёмка №${existingScanning.id}. Открываю её.`);
                      await openReceipt(existingScanning.id);
                      return;
                    }
                    const r = await purchasesApi.createReceipt(detail.purchase.id);
                    await openDetail(detail.purchase.id);
                    await openReceipt(r.id);
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось создать приёмку');
                  } finally {
                    setCreateReceiptBusy(false);
                  }
                }}
                disabled={createReceiptBusy}
              >
                {createReceiptBusy ? 'Создаю приёмку…' : 'Создать приёмку (сканирование)'}
              </Button>
              <Button
                variant="secondary"
                disabled={deletePurchaseBusy}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (deletePurchaseBusy) return;
                  if (
                    !window.confirm(
                      `Удалить закупку №${detail.purchase.id} со всеми приёмками? Будет выполнен откат (сторно): в журнал движений добавятся обратные проводки, старые записи не удаляются. Остатки и incoming будут скорректированы; заказы из «В закупке» вернутся в «Новые», резерв снимется.`
                    )
                  ) {
                    return;
                  }
                  try {
                    setDeletePurchaseBusy(true);
                    setErr(null);
                    await purchasesApi.deletePurchase(detail.purchase.id);
                    setDetail(null);
                    await reload();
                  } catch (ex) {
                    setErr(formatPurchaseApiError(ex, 'Не удалось удалить закупку'));
                  } finally {
                    setDeletePurchaseBusy(false);
                  }
                }}
              >
                {deletePurchaseBusy ? 'Удаляю…' : 'Удалить закупку'}
              </Button>
            </div>
            <h4>Позиции</h4>
            <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
              Если «ожидалось» больше «принято», укажите в штуках, на сколько уменьшить ожидание (не обязательно на всё непринятое):
              остаток по строке можно принять позже той же закупкой. Incoming уменьшится на выбранное число; уже принятое на склад не
              затрагивается. Заказы в привязке сверх нового «ожидалось» вернутся в «Новый», если нет другой закупки.
            </p>
            {Array.isArray(detail.items) && detail.items.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Под заказы</th>
                      <th>Закуп. цена</th>
                      <th>
                        <button
                          type="button"
                          onClick={() =>
                            setDetailExpectedQtySort((prev) =>
                              prev == null ? 'asc' : prev === 'asc' ? 'desc' : null
                            )
                          }
                          title={
                            detailExpectedQtySort == null
                              ? 'Сортировать по ожидаемому количеству'
                              : detailExpectedQtySort === 'asc'
                                ? 'Сейчас по возрастанию — по убыванию'
                                : 'Сбросить сортировку'
                          }
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            font: 'inherit',
                            padding: 0,
                            textAlign: 'left',
                            textDecoration: detailExpectedQtySort ? 'underline' : 'underline dotted',
                            fontWeight: detailExpectedQtySort ? 600 : 400,
                            color: 'inherit',
                          }}
                        >
                          Ожидалось
                          {detailExpectedQtySort === 'asc' ? ' ↑' : ''}
                          {detailExpectedQtySort === 'desc' ? ' ↓' : ''}
                        </button>
                      </th>
                      <th>Принято</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDetailItems.map((it) => (
                      <tr key={it.id}>
                        <td className="sku-cell">{it.product_sku || '—'}</td>
                        <td className="name-cell">{it.product_name || '—'}</td>
                        <td className="muted" title={formatSourceOrders(it.source_orders)} style={{ maxWidth: 260 }}>
                          {formatSourceOrders(it.source_orders)}
                        </td>
                        <td style={{ width: 140 }} onClick={(e) => e.stopPropagation()}>
                          <input
                            className="warehouse-ops-qty-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={it.purchase_price ?? it.product_cost ?? ''}
                            onChange={async (e) => {
                              const v = e.target.value;
                              try {
                                setErr(null);
                                await purchasesApi.updatePurchaseItem(detail.purchase.id, it.id, {
                                  purchasePrice: v === '' ? null : Number(v),
                                });
                                await openDetail(detail.purchase.id);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить цену');
                              }
                            }}
                          />
                        </td>
                        <td>{it.expected_quantity}</td>
                        <td>{it.received_quantity}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const exp = Number(it.expected_quantity);
                            const rec = Number(it.received_quantity);
                            const expected = Math.max(
                              0,
                              Math.floor(Number.isFinite(exp) ? exp : 0)
                            );
                            const received = Math.max(
                              0,
                              Math.floor(Number.isFinite(rec) ? rec : 0)
                            );
                            const unreceived = Math.max(0, expected - received);
                            if (unreceived <= 0) {
                              return <span className="muted">—</span>;
                            }
                            return (
                              <PurchaseLineReduceControls
                                purchaseId={detail.purchase.id}
                                itemId={it.id}
                                expected={expected}
                                received={received}
                                unreceived={unreceived}
                                setErr={setErr}
                                busy={lineActionBusy === it.id}
                                setBusy={setLineActionBusy}
                                onDone={async () => {
                                  await openDetail(detail.purchase.id);
                                  await reload();
                                }}
                              />
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Нет строк.</p>
            )}

            <h4 style={{ marginTop: 14 }}>Приёмки</h4>
            {Array.isArray(detail.receipts) && detail.receipts.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>№</th>
                      <th>Статус</th>
                      <th>Позиций</th>
                      <th />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.receipts.map((r) => (
                      <tr
                        key={r.id}
                        className="stock-levels-row-clickable"
                        onClick={onNavigationClick(() => openReceipt(r.id))}
                      >
                        <td>{fmtDt(r.created_at)}</td>
                        <td>№{r.id}</td>
                        <td>{r.status}</td>
                        <td>{r.items_count ?? '—'}</td>
                        <td>
                          <span className="muted">Открыть →</span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={async () => {
                              const completed = String(r.status) === 'completed';
                              const msg = completed
                                ? `Удалить приёмку №${r.id}? Сторно: остатки и incoming будут откатаны новыми проводками в журнале; исходные записи приёмки останутся в истории.`
                                : `Удалить приёмку №${r.id} (сканирование)? Черновик и строки складской приёмки будут сняты (в журнал движений это не пишется, т.к. приёмка не была завершена).`;
                              if (!window.confirm(msg)) return;
                              try {
                                setErr(null);
                                await purchasesApi.deleteReceipt(r.id);
                                await openDetail(detail.purchase.id);
                                await reload();
                                if (receipt?.receipt?.id === r.id) setReceipt(null);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить приёмку');
                              }
                            }}
                          >
                            Удалить
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Пока нет приёмок.</p>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={!!receipt?.receipt?.id}
        onClose={() => setReceipt(null)}
        title={receipt?.receipt?.id ? `Приёмка №${receipt.receipt.id}` : 'Приёмка'}
        size="xl"
      >
        {receipt?.receipt ? (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              статус: {receipt.receipt.status} · закупка №{receipt.receipt.purchase_id}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={receiptSupplierId}
                onChange={async (e) => {
                  const v = e.target.value;
                  setReceiptSupplierId(v);
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(receipt.receipt.purchase_id, {
                      supplierId: v === '' ? null : Number(v),
                    });
                    if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                    await openReceipt(receipt.receipt.id);
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить поставщика');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
              <select
                className="warehouse-ops-select"
                value={receiptOrganizationId}
                onChange={async (e) => {
                  const v = e.target.value;
                  setReceiptOrganizationId(v);
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(receipt.receipt.purchase_id, {
                      organizationId: v === '' ? null : Number(v),
                    });
                    if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                    await openReceipt(receipt.receipt.id);
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить организацию');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(organizations || []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || `Организация #${o.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Склад приёмки</span>
              <select
                className="warehouse-ops-select"
                value={receiptWarehouseId}
                onChange={(e) => setReceiptWarehouseId(e.target.value)}
              >
                <option value="">— По умолчанию —</option>
                {(warehouses || [])
                  .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.address || w.city || `Склад #${w.id}`}
                    </option>
                  ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Сканер</span>
              <input
                className="warehouse-ops-input"
                style={{ maxWidth: 220 }}
                value={scannerId}
                onChange={(e) => {
                  const v = String(e.target.value || '').trim();
                  setScannerId(v);
                  try {
                    if (typeof localStorage !== 'undefined') localStorage.setItem(RECEIPT_SCANNER_ID_LS, v);
                  } catch {
                    /* ignore */
                  }
                }}
                placeholder="scn-..."
                autoComplete="off"
                spellCheck={false}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                На каждом устройстве свой ID (сохраняется в браузере). Нужен, если два сканера на одном ПК ведут одну приёмку.
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
                scan();
              }}
              className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
            >
              <input
                ref={scanRef}
                className="warehouse-ops-scan-input"
                value={scanValue}
                onChange={(e) => {
                  const v = e.target.value;
                  setScanValue(v);
                  if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);

                  // 1) Некоторые сканеры вставляют \r/\n вместо Enter
                  if (/[\r\n]/.test(v)) {
                    // Важно: некоторые сканеры ещё и шлют Enter → не допускаем двойной отправки
                    scanDebounceRef.current = setTimeout(() => scan(v), 0);
                    return;
                  }

                  // 2) Многие сканеры не отправляют Enter вообще — просто быстро "набирают" символы
                  // Если ввод не менялся ~120мс, считаем что скан завершён и отправляем.
                  if (String(v).trim().length >= 4) {
                    scanDebounceRef.current = setTimeout(() => scan(v), 120);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
                    // Если сканер "вставил" перенос строки в значение, onChange уже отправит scan()
                    if (/[\r\n]/.test(e.currentTarget.value)) return;
                    scan(e.currentTarget.value);
                  }
                }}
                placeholder="Сканируйте штрихкод (1 скан = +1)"
                autoComplete="off"
              />
            </form>
            {pendingScans > 0 ? (
              <p className="muted" style={{ marginTop: 8 }} role="status">
                В очереди сканов: <strong>{pendingScans}</strong> · список обновляется автоматически
              </p>
            ) : scanMsg ? (
              <p className="muted" style={{ marginTop: 8 }}>{scanMsg}</p>
            ) : null}
            {lastScanLine && (
              <div
                role="status"
                style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${lastScanLine.over ? '#d33' : 'rgba(0,0,0,0.12)'}`,
                  background: lastScanLine.over ? 'rgba(211,51,51,0.08)' : 'rgba(0,0,0,0.03)',
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {lastScanLine.sku} — {lastScanLine.name}
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  Ожидалось: {lastScanLine.expected ?? '—'} · Принято: {lastScanLine.scanned}
                  {lastScanLine.received != null ? `/${lastScanLine.received}` : ''}
                  {lastScanLine.over ? ' · Перескан!' : ''}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <Button
                onClick={async () => {
                  const res = await purchasesApi.completeReceipt(receipt.receipt.id, {
                    warehouseId: receiptWarehouseId || null,
                  });
                  setReceipt(null);
                  setScanMsg(null);
                  await reload();
                  if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                  if (Array.isArray(res?.extras) && res.extras.length > 0) {
                    setExtrasToResolve({
                      receiptId: receipt.receipt.id,
                      purchaseId: res.purchaseId,
                      extras: res.extras,
                      warehouseId: res.warehouseId ?? (receiptWarehouseId || null),
                    });
                  }
                  if (res?.stockProblems?.length) {
                    setErr(`Проблемы с покрытием резерва: ${res.stockProblems.length} SKU`);
                  }
                  if (res?.warehouseReceiptId) {
                    navigate('/stock-levels/warehouse?op=receipts_list', {
                      state: { openReceiptId: res.warehouseReceiptId }
                    });
                  }
                }}
              >
                Завершить приёмку
              </Button>
              <Button variant="secondary" onClick={() => openReceipt(receipt.receipt.id)}>
                Обновить
              </Button>
            </div>

            <h4 style={{ marginTop: 14 }}>Коробкой (ручной ввод)</h4>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const rid = receipt?.receipt?.id;
                const raw = String(boxAddCode || '').trim();
                const qty = Math.floor(Number(boxAddQty) || 0);
                if (!rid || !raw || qty <= 0 || boxAddBusy) return;

                try {
                  setBoxAddBusy(true);
                  setErr(null);
                  pendingScansRef.current += 1;
                  setPendingScans(pendingScansRef.current);

                  const code = normalizeScanInput(raw);

                  await purchasesApi.addReceiptQuantity(rid, {
                    quantity: qty,
                    barcode: code,
                    sku: code,
                    scannerId: scannerId || null,
                  });

                  setBoxAddCode('');
                  setBoxAddQty('');
                  scheduleReceiptRefresh(rid);
                } catch (ex) {
                  setErr(ex.response?.data?.message || ex.message || 'Не удалось добавить количество');
                } finally {
                  setBoxAddBusy(false);
                  pendingScansRef.current = Math.max(0, pendingScansRef.current - 1);
                  setPendingScans(pendingScansRef.current);
                }
              }}
              className="warehouse-ops-scan-form"
              style={{ marginTop: 8 }}
            >
              <input
                className="warehouse-ops-scan-input"
                value={boxAddCode}
                onChange={(e) => setBoxAddCode(e.target.value)}
                placeholder="ШК или артикул (можно с префиксом A:/B- для авто-ID сканера)"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                className="warehouse-ops-qty-input"
                type="number"
                min={1}
                step={1}
                value={boxAddQty}
                onChange={(e) => setBoxAddQty(e.target.value)}
                placeholder="Кол-во"
                style={{ width: 120 }}
              />
              <Button type="submit" variant="secondary" disabled={boxAddBusy}>
                Добавить
              </Button>
            </form>

            <h4 style={{ marginTop: 14 }}>Отсканировано</h4>
            {Array.isArray(receipt.items) && receipt.items.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Закуп. цена</th>
                      <th>Заказано</th>
                      <th>Принято</th>
                      <th style={{ width: 190 }}>Коробкой</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReceiptItems.map((it) => (
                      <tr key={it.id}>
                        <td className="sku-cell">{it.product_sku || '—'}</td>
                        <td className="name-cell">{it.product_name || '—'}</td>
                        <td style={{ width: 140 }}>
                          <input
                            className="warehouse-ops-qty-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={it.purchase_price ?? it.product_cost ?? ''}
                            onChange={async (e) => {
                              const v = e.target.value;
                              const purchaseItemId = it.purchase_item_id;
                              if (!purchaseItemId) return;
                              try {
                                setErr(null);
                                await purchasesApi.updatePurchaseItem(receipt.receipt.purchase_id, purchaseItemId, {
                                  purchasePrice: v === '' ? null : Number(v),
                                });
                                await openReceipt(receipt.receipt.id);
                                if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить цену');
                              }
                            }}
                          />
                        </td>
                        {(() => {
                          const exp = Number(it.expected_quantity);
                          const expected = Number.isFinite(exp) ? exp : null;
                          const scanned = Number(it.scanned_quantity) || 0;
                          const rec = Number(it.received_quantity);
                          const received = Number.isFinite(rec) ? rec : null;
                          const diff = expected != null ? scanned - expected : null;
                          const remain = expected != null ? Math.max(0, expected - scanned) : null;
                          const isOver = diff != null && diff > 0;
                          const isExact = diff != null && diff === 0 && expected !== 0;
                          const isUnder = diff != null && diff < 0;
                          const cellStyle = isOver
                            ? { color: '#b00020', fontWeight: 700 }
                            : isExact
                              ? { color: '#1b5e20', fontWeight: 700 }
                              : isUnder
                                ? { color: '#8a6d00', fontWeight: 700 }
                                : {};
                          return (
                            <>
                              <td>{it.expected_quantity ?? '—'}</td>
                              <td style={cellStyle}>
                                {scanned}
                                {received != null ? `/${received}` : ''}
                                {diff != null && diff !== 0 && (
                                  <span className="muted" style={{ marginLeft: 6, fontWeight: 600 }}>
                                    ({diff > 0 ? `+${diff}` : diff})
                                  </span>
                                )}
                                {remain != null && remain > 0 && (
                                  <span className="muted" style={{ marginLeft: 8, fontWeight: 500 }}>
                                    ещё {remain}
                                  </span>
                                )}
                                {expected != null && expected === 0 && scanned > 0 && (
                                  <span className="muted" style={{ marginLeft: 8, fontWeight: 500 }}>
                                    (не ожидалось)
                                  </span>
                                )}
                                {received != null && expected != null && received >= expected && scanned > expected && (
                                  <span className="muted" style={{ marginLeft: 8, fontWeight: 600 }}>
                                    перескан
                                  </span>
                                )}
                              </td>
                            </>
                          );
                        })()}
                        <td>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              className="warehouse-ops-qty-input"
                              style={{ width: 90 }}
                              placeholder="+N"
                              value={it._boxQtyInput ?? ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setReceipt((prev) => {
                                  if (!prev?.items) return prev;
                                  const nextItems = (prev.items || []).map((x) =>
                                    x?.id === it.id ? { ...x, _boxQtyInput: v } : x
                                  );
                                  return { ...prev, items: nextItems };
                                });
                              }}
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              size="small"
                              onClick={async () => {
                                const rid = receipt?.receipt?.id;
                                const qty = Math.floor(Number(it._boxQtyInput) || 0);
                                if (!rid || qty <= 0) return;
                                try {
                                  pendingScansRef.current += 1;
                                  setPendingScans(pendingScansRef.current);
                                  const effectiveScannerId = scannerId || null;
                                  const res = await purchasesApi.addReceiptQuantity(rid, {
                                    productId: it.product_id,
                                    quantity: qty,
                                    scannerId: effectiveScannerId,
                                  });
                                  const updatedProductId = Number(res?.productId);
                                  const updatedScannedQty = Number(res?.scannedQuantity);
                                  if (Number.isFinite(updatedProductId) && Number.isFinite(updatedScannedQty)) {
                                    setReceipt((prev) => {
                                      if (!prev?.items) return prev;
                                      const nextItems = (prev.items || []).map((x) => {
                                        if (Number(x?.product_id) !== updatedProductId) return x;
                                        return { ...x, scanned_quantity: updatedScannedQty, _boxQtyInput: '' };
                                      });
                                      return { ...prev, items: nextItems };
                                    });
                                  }
                                  scheduleReceiptRefresh(rid);
                                } catch (ex) {
                                  setErr(ex.response?.data?.message || ex.message || 'Не удалось добавить количество');
                                } finally {
                                  pendingScansRef.current = Math.max(0, pendingScansRef.current - 1);
                                  setPendingScans(pendingScansRef.current);
                                }
                              }}
                            >
                              Добавить
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Пока ничего не отсканировано.</p>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={!!extrasToResolve}
        onClose={() => setExtrasToResolve(null)}
        title="Излишки по приёмке"
        size="xl"
      >
        {extrasToResolve ? (
          <>
            <p className="warehouse-ops-hint">
              Найдены излишки по закупке №{extrasToResolve.purchaseId}. Выберите действие: допринять на склад или оформить возврат поставщику.
            </p>
            <div className="warehouse-ops-receipt-list-wrap" style={{ marginTop: 10 }}>
              <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th>Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {extrasToResolve.extras.map((x) => (
                    <tr key={x.productId}>
                      <td className="sku-cell">{x.sku || '—'}</td>
                      <td className="name-cell">{x.name || '—'}</td>
                      <td>{x.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <Button
                onClick={async () => {
                  await purchasesApi.resolveExtras(extrasToResolve.receiptId, {
                    action: 'accept',
                    warehouseId: extrasToResolve.warehouseId ?? null,
                  });
                  setExtrasToResolve(null);
                  await reload();
                }}
              >
                Допринять на склад
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await purchasesApi.resolveExtras(extrasToResolve.receiptId, {
                    action: 'return',
                    warehouseId: extrasToResolve.warehouseId ?? null,
                  });
                  setExtrasToResolve(null);
                  await reload();
                  setErr('Создан возврат поставщику (черновик).');
                }}
              >
                Создать возврат поставщику
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      <LinkBarcodeToProductModal
        isOpen={linkBarcodeOpen}
        onClose={() => {
          setLinkBarcodeOpen(false);
          setLinkBarcodeValue('');
          purchaseLinkRetryRef.current = null;
        }}
        barcode={linkBarcodeValue}
        products={products}
        onLinked={handlePurchaseBarcodeLinked}
      />
    </div>
  );
}


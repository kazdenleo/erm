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
import { clearScanField, readScanFieldValue } from '../../utils/scanInput';
import { useLocation, useNavigate } from 'react-router-dom';
import { purchasesApi } from '../../services/purchases.api';
import { productsApi } from '../../services/products.api';
import { usersApi } from '../../services/users.api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useProducts } from '../../hooks/useProducts';
import './WarehouseOperations.css';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { Button } from '../../components/common/Button/Button';
import { InviteUserButton } from '../../components/common/InviteUserButton/InviteUserButton';
import { FastScanInput } from '../../components/common/FastScanInput/FastScanInput';
import { Modal } from '../../components/common/Modal/Modal';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import {
  applySingleOrgWarehouseDefaults,
  stockDestinationWarehouses,
  useStockDestinationDefaults,
  warehouseDisplayLabel,
} from '../../utils/stockDestinationDefaults.js';
import { onNavigationClick } from '../../utils/navigationClick.js';
import { PurchaseExpectedDraftModal } from './PurchaseExpectedDraftModal.jsx';
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

function syncPurchaseReceiptInUrl(receiptId) {
  const rid = String(receiptId || '').trim();
  try {
    const url = new URL(window.location.href);
    if (rid) url.searchParams.set('purchase_receipt', rid);
    else url.searchParams.delete('purchase_receipt');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
}

function receiptItemRowKey(it) {
  const pid = Number(it?.product_id);
  if (Number.isFinite(pid) && pid > 0) return `p-${pid}`;
  const id = Number(it?.id);
  if (Number.isFinite(id) && id > 0) return `i-${id}`;
  return String(it?.product_sku || 'row');
}

function parseReceiptScanMeta(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Сначала недавно отсканированные текущим пользователем/устройством, затем по количеству. */
function sortReceiptItemsByParticipant(items, { userId = null, scannerId = null } = {}) {
  const uid =
    userId != null && userId !== '' && Number.isFinite(Number(userId)) ? String(Number(userId)) : null;
  const sc =
    scannerId != null && String(scannerId).trim() !== '' ? String(scannerId).trim() : '_default';
  return [...(items || [])].sort((a, b) => {
    if (uid) {
      const byUserA = parseReceiptScanMeta(a?.scan_meta).byUser || {};
      const byUserB = parseReceiptScanMeta(b?.scan_meta).byUser || {};
      const ta = Number(byUserA[uid]) || 0;
      const tb = Number(byUserB[uid]) || 0;
      if (tb !== ta) return tb - ta;
    }
    const metaA = parseReceiptScanMeta(a?.scan_meta).byScanner || {};
    const metaB = parseReceiptScanMeta(b?.scan_meta).byScanner || {};
    const taSc = Number(metaA[sc]) || 0;
    const tbSc = Number(metaB[sc]) || 0;
    if (tbSc !== taSc) return tbSc - taSc;
    const scannedA = Number(a?.scanned_quantity) || 0;
    const scannedB = Number(b?.scanned_quantity) || 0;
    if (scannedB !== scannedA) return scannedB - scannedA;
    return String(a?.product_sku || a?.id || '').localeCompare(String(b?.product_sku || b?.id || ''), 'ru', {
      numeric: true,
    });
  });
}

function receiptStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'expected') return 'Ожидается';
  if (s === 'scanning') return 'сканирование';
  if (s === 'completed') return 'завершена';
  if (s === 'cancelled') return 'отменена';
  return status || '—';
}

function findExpectedReceipt(receipts) {
  return (Array.isArray(receipts) ? receipts : []).find((x) => String(x?.status) === 'expected') || null;
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

const RECEIPT_CALENDAR_TZ = 'Europe/Moscow';

function receiptCalendarDayKey(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: RECEIPT_CALENDAR_TZ });
  } catch {
    return '';
  }
}

function isReceiptSameCalendarDay(receiptRow) {
  if (!receiptRow) return false;
  const raw =
    receiptRow.started_at || receiptRow.startedAt || receiptRow.created_at || receiptRow.createdAt;
  return receiptCalendarDayKey(raw) === receiptCalendarDayKey(new Date().toISOString());
}

function findScanningDraftReceipt(receipts) {
  return (Array.isArray(receipts) ? receipts : []).find((x) => String(x?.status) === 'scanning') || null;
}

function qtyCell(raw) {
  if (raw == null || raw === '') return '—';
  const n = Number(raw);
  return Number.isFinite(n) ? n : '—';
}

function normalizePurchasePrice(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function purchaseHeaderId(purchase, snakeKey, camelKey) {
  const raw = purchase?.[snakeKey] ?? purchase?.[camelKey];
  if (raw == null || String(raw).trim() === '') return '';
  return String(raw);
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
  const location = useLocation();
  const { user } = useAuth();
  const { products } = useProducts({ autoLoad: false });
  const { warehouses } = useWarehouses();
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const { destWarehouses, singleOrganizationId, singleWarehouseId } = useStockDestinationDefaults(
    organizations,
    warehouses
  );
  const [showArchived, setShowArchived] = useState(false);
  const [filterSupplierId, setFilterSupplierId] = useState('');
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
  const [createSelectedProducts, setCreateSelectedProducts] = useState([]);
  const [createSearchLoading, setCreateSearchLoading] = useState(false);
  const [editSupplierId, setEditSupplierId] = useState('');
  const [editOrganizationId, setEditOrganizationId] = useState('');
  const [editWarehouseId, setEditWarehouseId] = useState('');
  const [editItems, setEditItems] = useState([]);
  const [editOriginal, setEditOriginal] = useState(null);
  const [editProductSearch, setEditProductSearch] = useState('');
  const [editSearchResults, setEditSearchResults] = useState([]);
  const [editSelectedProducts, setEditSelectedProducts] = useState([]);
  const [editSearchLoading, setEditSearchLoading] = useState(false);
  const [editSaveBusy, setEditSaveBusy] = useState(false);
  const [excelImportLoading, setExcelImportLoading] = useState(false);
  const excelInputRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const scanRef = useRef(null);
  const scanDebounceRef = useRef(null);
  const [scannerId] = useState(() => getOrCreateScannerId());
  const [inviteUsers, setInviteUsers] = useState([]);
  const [inviteBusy, setInviteBusy] = useState(false);
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
  const lastScannedProductRef = useRef(null);
  const boxQtyDebounceRef = useRef(null);
  const rowBoxQtyDebounceRef = useRef({});
  const BOX_QTY_APPLY_MS = 2000;
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
  const [receiptDraftChoice, setReceiptDraftChoice] = useState(null);
  const [receiptCloseConfirm, setReceiptCloseConfirm] = useState(false);
  const [manualQtyBusy, setManualQtyBusy] = useState(null);
  const [excelPreviewInfo, setExcelPreviewInfo] = useState(null);
  const [receiptCompleteInfo, setReceiptCompleteInfo] = useState(null);
  const [deleteReceiptDraftBusy, setDeleteReceiptDraftBusy] = useState(false);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [deleteReceiptBusy, setDeleteReceiptBusy] = useState(null);
  const [linkBarcodeOpen, setLinkBarcodeOpen] = useState(false);
  const [linkBarcodeValue, setLinkBarcodeValue] = useState('');
  const purchaseLinkRetryRef = useRef(null);
  const [expectedDraftOpen, setExpectedDraftOpen] = useState(false);

  const currentUserId = useMemo(() => {
    const raw = user?.id ?? user?.userId ?? null;
    return raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  }, [user?.id, user?.userId]);

  const receiptOwnerUserId = useMemo(() => {
    const raw =
      receipt?.receipt?.created_by_user_id ??
      receipt?.receipt?.createdByUserId ??
      null;
    return raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  }, [receipt?.receipt?.created_by_user_id, receipt?.receipt?.createdByUserId]);

  const isReceiptGuest = useMemo(() => {
    if (receiptOwnerUserId == null || currentUserId == null) return false;
    return Number(receiptOwnerUserId) !== Number(currentUserId);
  }, [receiptOwnerUserId, currentUserId]);

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
    if (receiptScannedQtySort != null) {
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
    }
    return sortReceiptItemsByParticipant(items, { userId: currentUserId, scannerId });
  }, [receipt?.items, receiptScannedQtySort, scannerId, currentUserId]);

  useEffect(() => {
    setDetailExpectedQtySort(null);
  }, [detail?.purchase?.id]);

  useEffect(() => {
    setReceiptScannedQtySort(null);
  }, [receipt?.receipt?.id]);

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const purchaseRaw = String(sp.get('purchase') || '').trim();
    if (purchaseRaw && /^\d+$/.test(purchaseRaw)) {
      const pid = Number(purchaseRaw);
      if (Number.isFinite(pid) && pid > 0 && Number(detail?.purchase?.id) !== pid) {
        openDetail(pid);
      }
    }
    const ridRaw = String(sp.get('purchase_receipt') || '').trim();
    if (!ridRaw || !/^\d+$/.test(ridRaw)) return;
    const rid = Number(ridRaw);
    if (!Number.isFinite(rid) || rid < 1) return;
    if (Number(receipt?.receipt?.id) === rid) return;
    openReceipt(rid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    const rid = receipt?.receipt?.id;
    if (!rid || String(receipt?.receipt?.status) !== 'scanning') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await usersApi.getInviteCandidates();
        const rows = res?.data ?? [];
        if (cancelled) return;
        const meEmail = user?.email ? String(user.email).trim().toLowerCase() : null;
        setInviteUsers(
          (Array.isArray(rows) ? rows : []).filter((u) => {
            if (!u) return false;
            const uidRaw = u.id ?? u.user_id ?? u.userId ?? null;
            const uid =
              uidRaw != null && uidRaw !== '' && Number.isFinite(Number(uidRaw)) ? Number(uidRaw) : null;
            if (currentUserId != null && uid != null && uid === currentUserId) return false;
            const em = u.email ? String(u.email).trim().toLowerCase() : null;
            if (meEmail && em && em === meEmail) return false;
            return true;
          })
        );
      } catch {
        if (!cancelled) setInviteUsers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt?.receipt?.id, receipt?.receipt?.status, currentUserId, user?.email]);

  useEffect(() => {
    const rid = receipt?.receipt?.id;
    if (!rid || String(receipt?.receipt?.status) !== 'scanning') return undefined;
    const t = setInterval(() => {
      purchasesApi.getReceipt(rid).then((data) => setReceipt(data)).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [receipt?.receipt?.id, receipt?.receipt?.status]);

  const reload = async (opts = {}) => {
    const includeArchived = opts.includeArchived ?? showArchived;
    const supplierId = opts.supplierId ?? filterSupplierId;
    setLoading(true);
    setErr(null);
    try {
      const data = await purchasesApi.list({
        limit: 200,
        ...(includeArchived ? { includeArchived: true } : {}),
        ...(supplierId ? { supplierId } : {}),
      });
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload({ includeArchived: showArchived, supplierId: filterSupplierId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived, filterSupplierId]);

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
    setCreateSelectedProducts([]);
    setCreateSearchLoading(false);
    setExcelImportLoading(false);
    setExcelPreviewInfo(null);
  }, []);

  const openCreatePurchase = useCallback(() => {
    applySingleOrgWarehouseDefaults({
      singleOrganizationId,
      singleWarehouseId,
      organizationId: createOrganizationId,
      warehouseId: createWarehouseId,
      setOrganizationId: setCreateOrganizationId,
      setWarehouseId: setCreateWarehouseId,
    });
    setCreateOpen(true);
  }, [
    singleOrganizationId,
    singleWarehouseId,
    createOrganizationId,
    createWarehouseId,
  ]);

  useEffect(() => {
    if (!createOpen) return;
    applySingleOrgWarehouseDefaults({
      singleOrganizationId,
      singleWarehouseId,
      organizationId: createOrganizationId,
      warehouseId: createWarehouseId,
      setOrganizationId: setCreateOrganizationId,
      setWarehouseId: setCreateWarehouseId,
    });
  }, [createOpen, singleOrganizationId, singleWarehouseId, createOrganizationId, createWarehouseId]);

  const closeEditModal = useCallback(() => {
    setEditProductSearch('');
    setEditSearchResults([]);
    setEditSearchLoading(false);
    setEditSaveBusy(false);
  }, []);

  const syncPurchaseDraftFromDetail = useCallback((data) => {
    if (!data?.purchase || String(data.purchase.status || '') === 'archived') {
      setEditOriginal(null);
      setEditItems([]);
      return;
    }
    const p = data.purchase;
    const items = (data.items || []).map((it) => ({
      itemId: it.id,
      productId: String(it.product_id),
      quantity: Math.max(0, Math.floor(Number(it.expected_quantity) || 0)),
      purchasePrice: it.purchase_price ?? it.product_cost ?? '',
      receivedQuantity: Math.max(0, Math.floor(Number(it.received_quantity) || 0)),
      productSku: it.product_sku || '',
      productName: it.product_name || '',
      sourceOrders: it.source_orders,
    }));
    setEditSupplierId(purchaseHeaderId(p, 'supplier_id', 'supplierId'));
    setEditOrganizationId(purchaseHeaderId(p, 'organization_id', 'organizationId'));
    setEditWarehouseId(purchaseHeaderId(p, 'warehouse_id', 'warehouseId'));
    setEditItems(
      items.length
        ? items
        : [{ itemId: null, productId: '', quantity: 1, purchasePrice: '', receivedQuantity: 0 }]
    );
    setEditOriginal({
      supplierId: purchaseHeaderId(p, 'supplier_id', 'supplierId'),
      organizationId: purchaseHeaderId(p, 'organization_id', 'organizationId'),
      warehouseId: purchaseHeaderId(p, 'warehouse_id', 'warehouseId'),
      items: items.map((it) => ({ ...it })),
    });
    setEditSelectedProducts(
      (data.items || []).map((it) => ({
        id: it.product_id,
        sku: it.product_sku,
        name: it.product_name,
      }))
    );
    setEditProductSearch('');
    setEditSearchResults([]);
  }, []);

  const normalizeDraftItems = useCallback((items) => {
    return (items || [])
      .map((it) => ({
        itemId: it.itemId ?? null,
        productId: it.productId ? String(it.productId) : '',
        quantity: Math.max(0, Math.floor(Number(it.quantity) || 0)),
        purchasePrice: normalizePurchasePrice(it.purchasePrice),
        receivedQuantity: Math.max(0, Math.floor(Number(it.receivedQuantity) || 0)),
      }))
      .filter((it) => it.productId && it.quantity > 0);
  }, []);

  const purchaseDraftDirty = useMemo(() => {
    if (!editOriginal || !detail?.purchase) return false;
    if (editSupplierId !== editOriginal.supplierId) return true;
    if (editOrganizationId !== editOriginal.organizationId) return true;
    if (editWarehouseId !== editOriginal.warehouseId) return true;
    const cur = JSON.stringify(normalizeDraftItems(editItems));
    const orig = JSON.stringify(normalizeDraftItems(editOriginal.items));
    return cur !== orig;
  }, [
    editOriginal,
    detail?.purchase,
    editSupplierId,
    editOrganizationId,
    editWarehouseId,
    editItems,
    normalizeDraftItems,
  ]);

  const isDetailEditable = useMemo(
    () => Boolean(detail?.purchase) && String(detail.purchase.status || '') !== 'archived',
    [detail?.purchase]
  );

  const requestCloseReceipt = useCallback(() => {
    if (String(receipt?.receipt?.status) === 'scanning') {
      setReceiptCloseConfirm(true);
      return;
    }
    syncPurchaseReceiptInUrl('');
    setReceipt(null);
  }, [receipt?.receipt?.status]);

  const createSupplierPrefixes = useMemo(() => {
    if (!createSupplierId) return [];
    const s = (suppliers || []).find((x) => String(x.id) === String(createSupplierId));
    return supplierPrefixesFromApiConfig(s?.apiConfig || s?.api_config || {});
  }, [suppliers, createSupplierId]);

  const createProductLabelById = useMemo(() => {
    const m = new Map();
    for (const p of mergeProductLists(products, createSelectedProducts, createSearchResults)) {
      if (p?.id != null) m.set(String(p.id), `${p.sku || '—'} — ${p.name || 'Без названия'}`);
    }
    return m;
  }, [products, createSelectedProducts, createSearchResults]);

  const editProductLabelById = useMemo(() => {
    const m = new Map();
    for (const p of mergeProductLists(products, editSelectedProducts, editSearchResults)) {
      if (p?.id != null) m.set(String(p.id), `${p.sku || '—'} — ${p.name || 'Без названия'}`);
    }
    return m;
  }, [products, editSelectedProducts, editSearchResults]);

  const addProductToCreateItems = useCallback((product, addQty = 1) => {
    const id = product?.id;
    if (id == null || id === '') return;
    setCreateSearchResults((prev) => mergeProductLists(prev, [product]));
    setCreateSelectedProducts((prev) => mergeProductLists(prev, [product]));
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

  const addProductToEditItems = useCallback((product, addQty = 1) => {
    const id = product?.id;
    if (id == null || id === '') return;
    setEditSearchResults((prev) => mergeProductLists(prev, [product]));
    setEditSelectedProducts((prev) => mergeProductLists(prev, [product]));
    const add = Math.max(1, parseInt(addQty, 10) || 1);
    const idStr = String(id);
    const productSku = product?.sku || '';
    const productName = product?.name || '';
    setEditItems((prev) => {
      const idx = prev.findIndex((x) => String(x.productId) === idStr);
      if (idx >= 0) {
        const cur = Number(prev[idx].quantity) || 0;
        return prev.map((x, i) =>
          i === idx
            ? {
                ...x,
                productId: idStr,
                quantity: cur + add,
                productSku: x.productSku || productSku,
                productName: x.productName || productName,
              }
            : x
        );
      }
      const emptyIdx = prev.findIndex((x) => !x.productId);
      const newRow = {
        itemId: null,
        productId: idStr,
        quantity: add,
        purchasePrice: '',
        receivedQuantity: 0,
        productSku,
        productName,
      };
      if (emptyIdx >= 0) {
        return prev.map((x, i) => (i === emptyIdx ? { ...x, ...newRow } : x));
      }
      return [...prev, newRow];
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
    if (!isDetailEditable) return undefined;
    const q = normalizeProductSearchQuery(editProductSearch);
    if (!q) {
      setEditSearchResults([]);
      setEditSearchLoading(false);
      return undefined;
    }
    const local = matchProductsLocal(products, q);
    if (local.length) setEditSearchResults(local);
    let cancelled = false;
    const timer = setTimeout(async () => {
      setEditSearchLoading(true);
      try {
        const res = await productsApi.getAll({ search: q, limit: 40 });
        const remote = Array.isArray(res?.data) ? res.data : [];
        if (!cancelled) setEditSearchResults(mergeProductLists(local, remote));
      } catch {
        if (!cancelled) setEditSearchResults(local);
      } finally {
        if (!cancelled) setEditSearchLoading(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isDetailEditable, editProductSearch, products]);

  const saveEditPurchase = async () => {
    const purchaseId = detail?.purchase?.id;
    const orig = editOriginal;
    if (!purchaseId || !orig) return;

    const normalizedItems = normalizeDraftItems(editItems);

    if (normalizedItems.length === 0) {
      setErr('Добавьте хотя бы одну позицию');
      return;
    }
    if (!String(editSupplierId || orig?.supplierId || '').trim()) {
      setErr('Выберите поставщика');
      return;
    }
    if (!String(editOrganizationId || orig?.organizationId || '').trim()) {
      setErr('Выберите организацию');
      return;
    }
    if (!String(editWarehouseId || orig?.warehouseId || '').trim()) {
      setErr('Выберите склад назначения');
      return;
    }
    for (const it of normalizedItems) {
      if (it.quantity < it.receivedQuantity) {
        setErr(
          `По товару #${it.productId} нельзя указать «ожидалось» меньше принятого (${it.receivedQuantity} шт.)`
        );
        return;
      }
    }

    setEditSaveBusy(true);
    setErr(null);
    try {
      const serverDetail = await purchasesApi.getById(purchaseId);
      const serverItemsById = new Map(
        (serverDetail?.items || [])
          .filter((it) => it.id != null)
          .map((it) => [Number(it.id), it])
      );

      const headerPayload = {};
      const supplierToSave = String(editSupplierId || orig.supplierId || '').trim();
      const organizationToSave = String(editOrganizationId || orig.organizationId || '').trim();
      const warehouseToSave = String(editWarehouseId || orig.warehouseId || '').trim();
      if (supplierToSave && supplierToSave !== orig.supplierId) {
        headerPayload.supplierId = Number(supplierToSave);
      }
      if (organizationToSave && organizationToSave !== orig.organizationId) {
        headerPayload.organizationId = Number(organizationToSave);
      }
      if (warehouseToSave && warehouseToSave !== orig.warehouseId) {
        headerPayload.warehouseId = Number(warehouseToSave);
      }

      const origByItemId = new Map(
        orig.items.filter((i) => i.itemId != null).map((i) => [Number(i.itemId), i])
      );
      const editByItemId = new Map(
        normalizedItems.filter((i) => i.itemId != null).map((i) => [Number(i.itemId), i])
      );

      for (const origItem of orig.items) {
        if (origItem.itemId == null) continue;
        if (editByItemId.has(Number(origItem.itemId))) continue;
        if (origItem.receivedQuantity > 0) {
          const err = new Error('Нельзя удалить строку с уже принятым товаром');
          err.response = { data: { message: err.message } };
          throw err;
        }
        await purchasesApi.removeDraftLineItem(purchaseId, origItem.itemId);
      }

      for (const editItem of normalizedItems) {
        if (editItem.itemId == null) continue;
        const origItem = origByItemId.get(Number(editItem.itemId));
        if (!origItem) continue;

        const origPrice = normalizePurchasePrice(origItem.purchasePrice);
        const newPrice = normalizePurchasePrice(editItem.purchasePrice);
        if (origPrice !== newPrice) {
          await purchasesApi.updatePurchaseItem(purchaseId, editItem.itemId, {
            purchasePrice: newPrice,
          });
        }

        const serverItem = serverItemsById.get(Number(editItem.itemId));
        const serverExpected = Math.max(
          0,
          Math.floor(Number(serverItem?.expected_quantity) || 0)
        );
        const origQty = serverExpected > 0 ? serverExpected : Math.max(0, Math.floor(Number(origItem.quantity) || 0));
        const newQty = editItem.quantity;
        if (newQty > origQty) {
          const payload = {
            productId: Number(editItem.productId),
            quantity: newQty - origQty,
          };
          if (newPrice != null) payload.purchasePrice = newPrice;
          await purchasesApi.appendDraftItems(purchaseId, { items: [payload] });
        } else if (newQty < origQty) {
          await purchasesApi.removeDraftLineItem(purchaseId, editItem.itemId, {
            reduceBy: origQty - newQty,
          });
        }
      }

      const newLines = normalizedItems.filter((i) => i.itemId == null);
      if (newLines.length > 0) {
        await purchasesApi.appendDraftItems(purchaseId, {
          items: newLines.map((it) => {
            const row = {
              productId: Number(it.productId),
              quantity: it.quantity,
            };
            const pp = normalizePurchasePrice(it.purchasePrice);
            if (pp != null) row.purchasePrice = pp;
            return row;
          }),
        });
      }

      if (Object.keys(headerPayload).length > 0) {
        await purchasesApi.updatePurchase(purchaseId, headerPayload);
      }

      closeEditModal();
      await reload();
      const data = await purchasesApi.getById(purchaseId);
      setDetail(data);
      syncPurchaseDraftFromDetail(data);
    } catch (e) {
      setErr(formatPurchaseApiError(e, 'Не удалось сохранить изменения закупки'));
    } finally {
      setEditSaveBusy(false);
    }
  };

  useEffect(() => {
    if (err && detail && detailErrRef.current) {
      detailErrRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [err, detail]);

  const openDetail = async (id) => {
    setErr(null);
    setDetailLoading(true);
    setDetail(null);
    setEditOriginal(null);
    try {
      const data = await purchasesApi.getById(id);
      setDetail(data);
      syncPurchaseDraftFromDetail(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупку');
    } finally {
      setDetailLoading(false);
    }
  };

  const requestCloseDetail = useCallback(() => {
    if (
      purchaseDraftDirty &&
      !window.confirm('Есть несохранённые изменения. Закрыть карточку без сохранения?')
    ) {
      return;
    }
    setDetail(null);
    setEditOriginal(null);
    setEditItems([]);
    closeEditModal();
  }, [purchaseDraftDirty, closeEditModal]);

  const startPurchaseReceipt = useCallback(
    async ({ forceNew = false } = {}) => {
      const purchaseId = detail?.purchase?.id;
      if (!purchaseId) return null;
      setCreateReceiptBusy(true);
      try {
        setErr(null);
        const r = await purchasesApi.createReceipt(purchaseId, forceNew ? { forceNew: true } : {});
        await openDetail(purchaseId);
        await openReceipt(r.id);
        return r;
      } catch (ex) {
        setErr(ex.response?.data?.message || ex.message || 'Не удалось создать приёмку');
        return null;
      } finally {
        setCreateReceiptBusy(false);
      }
    },
    // openDetail/openReceipt ниже по файлу — стабильные колбэки не требуются
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail?.purchase?.id]
  );

  const handleDeletePurchaseReceipt = useCallback(
    async (receiptRow, { closeModal = false } = {}) => {
      const rid = receiptRow?.id;
      if (!rid) return;
      const completed = String(receiptRow.status) === 'completed';
      const msg = completed
        ? `Отменить приёмку №${rid}? Остатки и «в пути» будут откачены; приёмка останется в списке со статусом «отменена».`
        : `Удалить приёмку №${rid} (сканирование)? Черновик и строки складской приёмки будут сняты.`;
      if (!window.confirm(msg)) return;
      try {
        setDeleteReceiptBusy(rid);
        setErr(null);
        await purchasesApi.deleteReceipt(rid);
        if (closeModal || Number(receipt?.receipt?.id) === Number(rid)) {
          syncPurchaseReceiptInUrl('');
          setReceipt(null);
          setScanMsg(null);
          setReceiptCloseConfirm(false);
        }
        if (detail?.purchase?.id) await openDetail(detail.purchase.id);
        await reload();
      } catch (ex) {
        setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить приёмку');
      } finally {
        setDeleteReceiptBusy(null);
      }
    },
    [detail?.purchase?.id, receipt?.receipt?.id, reload]
  );

  const openReceipt = async (receiptId) => {
    const rid = Number(receiptId);
    if (!Number.isFinite(rid) || rid < 1) return;
    setReceiptLoading(true);
    setErr(null);
    try {
      const data = await purchasesApi.getReceipt(rid);
      if (!data?.receipt?.id) {
        setErr('Приёмка не найдена или недоступна');
        return;
      }
      setReceipt(data);
      syncPurchaseReceiptInUrl(data.receipt.id);
      setScanMsg(null);
      setLastScanLine(null);
      const p = data?.purchase || {};
      const dp = detail?.purchase;
      if (p.id != null && Number(dp?.id) !== Number(p.id)) {
        await openDetail(p.id);
      }
      setReceiptWarehouseId(
        p.warehouseId != null
          ? String(p.warehouseId)
          : dp?.warehouse_id != null
            ? String(dp.warehouse_id)
            : singleWarehouseId || ''
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
      if (String(data.receipt.status) === 'scanning') {
        setTimeout(() => scanRef.current?.focus(), 80);
      }
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось открыть приёмку');
    } finally {
      setReceiptLoading(false);
    }
  };

  const createPurchase = async () => {
    const items = createItems
      .map((it) => {
        const row = {
          productId: it.productId ? Number(it.productId) : null,
          quantity: Number(it.quantity) || 1,
        };
        if (
          it.purchasePrice != null &&
          it.purchasePrice !== '' &&
          Number.isFinite(Number(it.purchasePrice))
        ) {
          row.purchasePrice = Number(it.purchasePrice);
        }
        return row;
      })
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
      setCreateSelectedProducts([]);
      await reload();
      if (res?.id) openDetail(res.id);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось создать закупку');
    }
  };

  const loadExcelIntoCreateTable = async (file) => {
    if (!file) return;
    if (!String(createSupplierId || '').trim()) {
      setErr('Выберите поставщика');
      return;
    }
    setExcelImportLoading(true);
    setErr(null);
    setExcelPreviewInfo(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('supplierId', String(createSupplierId));
      const res = await purchasesApi.previewExcelImport(formData);
      if (res?.parserVersion && res.parserVersion !== 'v4-article-qty-cost') {
        setErr(
          `На сервере старая версия импорта (${res.parserVersion}). Нужны git pull и pm2 restart erm-api.`
        );
        return;
      }
      const tableItems = Array.isArray(res?.tableItems) ? res.tableItems : [];
      const unresolved = Array.isArray(res?.unresolved) ? res.unresolved : [];
      if (tableItems.length === 0 && unresolved.length === 0) {
        setErr('В файле нет распознанных строк с артикулом и количеством.');
        return;
      }
      const productsFromExcel = tableItems
        .filter((it) => it?.productId != null)
        .map((it) => ({
          id: it.productId,
          sku: it.sku || null,
          name: it.name || null,
        }));
      if (productsFromExcel.length > 0) {
        setCreateSearchResults((prev) => mergeProductLists(prev, productsFromExcel));
        setCreateSelectedProducts((prev) => mergeProductLists(prev, productsFromExcel));
      }
      setCreateItems(
        tableItems.length > 0
          ? tableItems.map((it) => ({
              productId: String(it.productId),
              quantity: it.quantity,
              purchasePrice: it.purchasePrice ?? null,
            }))
          : [{ productId: '', quantity: 1 }]
      );
      const loadedQty = tableItems.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
      let info = `Загружено из Excel: ${res.excelDataRows ?? '—'} строк → ${tableItems.length} поз., ${loadedQty} шт.`;
      if (res.hasImportPrices) info += ' Цены из файла попадут в закупку при сохранении.';
      if (unresolved.length > 0) {
        const extra = unresolved
          .slice(0, 10)
          .map((u) => `${u.cleanSku} (${u.quantity} шт.)`)
          .join(', ');
        const tail = unresolved.length > 10 ? ` … +${unresolved.length - 10}` : '';
        info += ` Не найдены в каталоге (${unresolved.length}): ${extra}${tail}.`;
      }
      setExcelPreviewInfo(info);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось разобрать Excel');
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

  const handleManualReceiptQty = useCallback(
    async (it, rawQty) => {
      const rid = receipt?.receipt?.id;
      if (!rid || String(receipt?.receipt?.status) !== 'scanning') return;
      const qty = Math.max(0, Math.floor(Number(rawQty) || 0));
      const prev = Number(it.scanned_quantity) || 0;
      if (qty === prev) return;
      try {
        setManualQtyBusy(it.product_id);
        setErr(null);
        const res = await purchasesApi.setReceiptItemQuantity(rid, {
          productId: it.product_id,
          quantity: qty,
          scannerId: scannerId || null,
        });
        const savedQty = res?.scannedQuantity ?? qty;
        setReceipt((prev) => {
          if (!prev?.items) return prev;
          const pid = Number(it.product_id);
          return {
            ...prev,
            items: prev.items.map((row) =>
              Number(row.product_id) === pid ? { ...row, scanned_quantity: savedQty } : row
            ),
          };
        });
        scheduleReceiptRefresh(rid);
      } catch (ex) {
        setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить количество');
      } finally {
        setManualQtyBusy(null);
      }
    },
    [receipt?.receipt?.id, receipt?.receipt?.status, scannerId, scheduleReceiptRefresh]
  );

  const applyPurchaseReceiptBoxQty = useCallback(
    async ({ productId = null, barcode = null, sku = null, qty, clearRowProductId = null } = {}) => {
      const rid = receipt?.receipt?.id;
      if (!rid || String(receipt?.receipt?.status) !== 'scanning') return;
      const n = Math.floor(Number(qty) || 0);
      if (n <= 0 || boxAddBusy) return;

      const payload = { quantity: n, scannerId: scannerId || null };
      const pidNum = productId != null ? Number(productId) : null;
      if (Number.isFinite(pidNum) && pidNum > 0) {
        payload.productId = pidNum;
      } else {
        const code = normalizeScanInput(String(barcode || sku || '').trim());
        if (!code) return;
        payload.barcode = code;
        payload.sku = code;
      }

      try {
        setBoxAddBusy(true);
        setErr(null);
        pendingScansRef.current += 1;
        setPendingScans(pendingScansRef.current);

        const res = await purchasesApi.addReceiptQuantity(rid, payload);
        const updatedProductId = Number(res?.productId);
        const updatedScannedQty = Number(res?.scannedQuantity);
        if (Number.isFinite(updatedProductId) && Number.isFinite(updatedScannedQty)) {
          setReceipt((prev) => {
            if (!prev?.items) return prev;
            const nextItems = (prev.items || []).map((x) => {
              if (Number(x?.product_id) !== updatedProductId) return x;
              const next = { ...x, scanned_quantity: updatedScannedQty };
              if (clearRowProductId != null && Number(clearRowProductId) === updatedProductId) {
                next._boxQtyInput = '';
              }
              return next;
            });
            return { ...prev, items: nextItems };
          });
          lastScannedProductRef.current = updatedProductId;
        }
        if (clearRowProductId == null) {
          setBoxAddCode('');
          setBoxAddQty('');
        }
        scheduleReceiptRefresh(rid);
        playEventSound(SOUND_EVENTS.scan_ok);
      } catch (ex) {
        setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить количество');
        playEventSound(SOUND_EVENTS.scan_error);
      } finally {
        setBoxAddBusy(false);
        pendingScansRef.current = Math.max(0, pendingScansRef.current - 1);
        setPendingScans(pendingScansRef.current);
        scanRef.current?.focus();
      }
    },
    [boxAddBusy, receipt?.receipt?.id, receipt?.receipt?.status, scannerId, scheduleReceiptRefresh]
  );

  const scheduleTopBoxQtyApply = useCallback(
    (qtyStr, codeStr) => {
      if (boxQtyDebounceRef.current) clearTimeout(boxQtyDebounceRef.current);
      boxQtyDebounceRef.current = setTimeout(() => {
        boxQtyDebounceRef.current = null;
        const qty = Math.floor(Number(qtyStr) || 0);
        if (qty <= 0) return;
        const code = normalizeScanInput(String(codeStr || '').trim());
        if (code) {
          void applyPurchaseReceiptBoxQty({ barcode: code, sku: code, qty });
          return;
        }
        const lastPid = lastScannedProductRef.current;
        if (lastPid != null && Number.isFinite(Number(lastPid)) && Number(lastPid) > 0) {
          void applyPurchaseReceiptBoxQty({ productId: lastPid, qty });
        }
      }, BOX_QTY_APPLY_MS);
    },
    [applyPurchaseReceiptBoxQty]
  );

  const scheduleRowBoxQtyApply = useCallback(
    (productId, qtyStr) => {
      const key = String(productId);
      if (rowBoxQtyDebounceRef.current[key]) {
        clearTimeout(rowBoxQtyDebounceRef.current[key]);
      }
      rowBoxQtyDebounceRef.current[key] = setTimeout(() => {
        delete rowBoxQtyDebounceRef.current[key];
        const qty = Math.floor(Number(qtyStr) || 0);
        if (qty <= 0) return;
        void applyPurchaseReceiptBoxQty({
          productId,
          qty,
          clearRowProductId: productId,
        });
      }, BOX_QTY_APPLY_MS);
    },
    [applyPurchaseReceiptBoxQty]
  );

  useEffect(() => {
    return () => {
      if (boxQtyDebounceRef.current) clearTimeout(boxQtyDebounceRef.current);
      Object.values(rowBoxQtyDebounceRef.current).forEach((t) => clearTimeout(t));
      rowBoxQtyDebounceRef.current = {};
    };
  }, [receipt?.receipt?.id]);

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
    const v = normalizeScanInput(valueOverride ?? readScanFieldValue(scanRef.current) ?? '');
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
      for (const it of receipt?.items || []) {
        const pid = Number(it?.product_id);
        if (!Number.isFinite(pid) || pid < 1) continue;
        before.set(String(pid), Number(it.scanned_quantity) || 0);
      }
      pendingScansRef.current += 1;
      setPendingScans(pendingScansRef.current);
      const scanRes = await purchasesApi.scanReceipt(rid, { barcode: v, scannerId: effectiveScannerId });
      if (scanRes?.ignoredDuplicate) {
        clearScanField(scanRef.current);
        setScanMsg(null);
        scanRef.current?.focus();
        return;
      }
      // Оптимистично обновим строку по ответу сервера (productId + scannedQuantity),
      // а полный receipt подтянем с debounce — чтобы несколько сканеров не "забивали" API.
      const updatedProductId = Number(scanRes?.productId);
      const updatedScannedQty = Number(scanRes?.scannedQuantity);
      if (Number.isFinite(updatedProductId) && Number.isFinite(updatedScannedQty) && updatedScannedQty >= 0) {
        lastScannedProductRef.current = updatedProductId;
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
      clearScanField(scanRef.current);
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
      clearScanField(scanRef.current);
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
    <>
      {err && <p className="error">{err}</p>}
      {importOk && (
        <p className="muted" style={{ color: 'var(--success, #198754)', marginBottom: 12 }}>
          {importOk}
        </p>
      )}
      {receiptCompleteInfo && (
        <p className="muted" style={{ color: 'var(--success, #198754)', marginBottom: 12 }}>
          {receiptCompleteInfo}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Button onClick={openCreatePurchase}>Новая закупка</Button>
        <Button variant="secondary" onClick={() => navigate('/stock-levels/purchases/forecast')}>
          Прогноз закупки
        </Button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span className="muted">Поставщик</span>
          <select
            className="warehouse-ops-select"
            value={filterSupplierId}
            onChange={(e) => setFilterSupplierId(e.target.value)}
          >
            <option value="">Все</option>
            {(suppliers || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || `Поставщик #${s.id}`}
              </option>
            ))}
          </select>
        </label>
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
                  <td>{p.warehouse_name || warehouseDisplayLabel(null, p.warehouse_id) || '—'}</td>
                  <td>{qtyCell(p.expected_total ?? p.expectedTotal)}</td>
                  <td>{qtyCell(p.received_total ?? p.receivedTotal)}</td>
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
            if (f) loadExcelIntoCreateTable(f);
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
            {(destWarehouses || [])
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseDisplayLabel(w)}
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
            Excel: столбцы <strong>Артикул</strong>, <strong>Количество</strong> (обязательно), <strong>Цена / себестоимость</strong> — по желанию.
            Кнопка ниже загружает файл в таблицу позиций; закупка создаётся отдельно кнопкой «Сохранить». Нераспознанные артикулы показываются предупреждением, найденные строки всё равно попадут в таблицу.
          </p>
          <div style={{ marginBottom: 12 }}>
            <Button
              type="button"
              variant="secondary"
              disabled={excelImportLoading}
              onClick={() => excelInputRef.current?.click()}
            >
              {excelImportLoading ? 'Загрузка…' : 'Загрузить из Excel в таблицу'}
            </Button>
          </div>
          {excelPreviewInfo ? (
            <p className="muted" style={{ fontSize: 13, marginBottom: 12, color: 'var(--success, #198754)' }}>
              {excelPreviewInfo}
            </p>
          ) : null}
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
        isOpen={!!detail && !receipt?.receipt?.id}
        onClose={requestCloseDetail}
        title={
          detail?.purchase?.id ? (
            <div className="purchase-detail-modal-title">
              <span className="purchase-detail-modal-title__heading">
                Закупка №{detail.purchase.id}
              </span>
              <div className="purchase-detail-modal-title__actions">
                <Button
                  variant="secondary"
                  disabled={deletePurchaseBusy}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (deletePurchaseBusy) return;
                    if (
                      !window.confirm(
                        `Удалить закупку №${detail.purchase.id} со всеми приёмками? Будет выполнена отмена: в журнал добавятся обратные проводки, приёмки останутся в истории. Остатки и «в пути» будут скорректированы; заказы из «В закупке» вернутся в «Новые», резерв снимется.`
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
                <Button
                  onClick={async () => {
                    if (createReceiptBusy) return;
                    if (String(detail?.purchase?.status || '') === 'archived') {
                      setErr('Закупка в архиве — всё принято. Создайте новую закупку для следующей поставки.');
                      return;
                    }
                    const scanningDraft = findScanningDraftReceipt(detail?.receipts);
                    if (scanningDraft?.id && isReceiptSameCalendarDay(scanningDraft)) {
                      setReceiptDraftChoice({
                        purchaseId: detail.purchase.id,
                        existingReceiptId: scanningDraft.id,
                        draftDate: scanningDraft.started_at || scanningDraft.created_at,
                      });
                      return;
                    }
                    await startPurchaseReceipt({ forceNew: false });
                  }}
                  disabled={createReceiptBusy}
                >
                  {createReceiptBusy ? 'Создаю приёмку…' : 'Создать приёмку (сканирование)'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setExpectedDraftOpen(true)}
                  disabled={!isDetailEditable}
                >
                  {findExpectedReceipt(detail?.receipts) ? 'Черновик «Ожидается»' : 'Создать «Ожидается»'}
                </Button>
                <Button
                  className={`purchase-detail-modal-title__save${purchaseDraftDirty ? '' : ' purchase-detail-modal-title__save--hidden'}`}
                  disabled={!purchaseDraftDirty || editSaveBusy}
                  onClick={saveEditPurchase}
                  aria-hidden={!purchaseDraftDirty}
                  tabIndex={purchaseDraftDirty ? 0 : -1}
                >
                  {editSaveBusy ? 'Сохраняю…' : 'Сохранить изменения'}
                </Button>
              </div>
            </div>
          ) : (
            'Закупка'
          )
        }
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
              {detail.purchase.supplier_submitted_at ? (
                <>
                  {' '}
                  <strong>Отправлено поставщику</strong>
                  {detail.purchase.supplier_order_ref
                    ? ` (№${detail.purchase.supplier_order_ref})`
                    : ''}{' '}
                  · {fmtDt(detail.purchase.supplier_submitted_at)}.
                </>
              ) : null}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={isDetailEditable ? editSupplierId : purchaseHeaderId(detail.purchase, 'supplier_id', 'supplierId')}
                disabled={!isDetailEditable || editSaveBusy}
                onChange={(e) => setEditSupplierId(e.target.value)}
              >
                <option value="">— Выберите поставщика —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
              <select
                className="warehouse-ops-select"
                value={
                  isDetailEditable
                    ? editOrganizationId
                    : purchaseHeaderId(detail.purchase, 'organization_id', 'organizationId')
                }
                disabled={!isDetailEditable || editSaveBusy}
                onChange={(e) => setEditOrganizationId(e.target.value)}
              >
                <option value="">— Выберите организацию —</option>
                {(organizations || []).map((o) => (
                  <option key={o.id} value={String(o.id)}>
                    {o.name || `Организация #${o.id}`}
                  </option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: 13 }}>Склад (назначение)</span>
              <select
                className="warehouse-ops-select"
                value={
                  isDetailEditable
                    ? editWarehouseId
                    : purchaseHeaderId(detail.purchase, 'warehouse_id', 'warehouseId')
                }
                disabled={!isDetailEditable || editSaveBusy}
                onChange={(e) => setEditWarehouseId(e.target.value)}
              >
                <option value="">— Выберите склад —</option>
                {(destWarehouses || []).map((w) => (
                  <option key={w.id} value={String(w.id)}>
                    {warehouseDisplayLabel(w)}
                  </option>
                ))}
              </select>
            </div>
            <h4>Позиции</h4>
            {isDetailEditable ? (
              <>
                <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
                  Измените количество и цену в таблице или добавьте товары через поиск. «Принято» только для
                  справки — «ожидалось» не может быть меньше принятого.
                </p>
                <div className="warehouse-ops-list-form" style={{ marginBottom: 12 }}>
                  <label htmlFor="purchase-detail-product-search">Поиск товара (сканер или ввод)</label>
                  <ProductSearchInput
                    id="purchase-detail-product-search"
                    value={editProductSearch}
                    onChange={setEditProductSearch}
                    products={products}
                    organizationId={editOrganizationId}
                    placeholder="Штрихкод, артикул, название"
                    disabled={editSaveBusy}
                    onSelect={(p) => {
                      addProductToEditItems(p, 1);
                      setEditProductSearch('');
                      setEditSearchResults([]);
                      setErr(null);
                    }}
                  />
                  {editSearchLoading && (
                    <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                      Поиск…
                    </p>
                  )}
                </div>
                {editItems.length > 0 ? (
                  <div className="warehouse-ops-receipt-list-wrap">
                    <table className="warehouse-ops-receipt-list-table table">
                      <thead>
                        <tr>
                          <th>Артикул</th>
                          <th>Товар</th>
                          <th>Под заказы</th>
                          <th>Закуп. цена</th>
                          <th>Ожидалось</th>
                          <th>Принято</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {editItems.map((it, idx) => {
                          const received = Math.max(0, Math.floor(Number(it.receivedQuantity) || 0));
                          const minQty = received > 0 ? received : 1;
                          const canRemove = received <= 0;
                          const label =
                            it.productId &&
                            (editProductLabelById.get(String(it.productId)) ||
                              `${it.productSku || '—'} — ${it.productName || 'Без названия'}`);
                          return (
                            <tr key={it.itemId != null ? `line-${it.itemId}` : `new-${idx}-${it.productId || 'empty'}`}>
                              <td className="sku-cell">
                                {it.productSku || (it.productId ? '—' : '—')}
                              </td>
                              <td className="name-cell">
                                {label || '— добавьте через поиск —'}
                              </td>
                              <td className="muted" style={{ maxWidth: 260 }}>
                                {formatSourceOrders(it.sourceOrders)}
                              </td>
                              <td style={{ width: 120 }}>
                                <input
                                  className="warehouse-ops-qty-input"
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={it.purchasePrice ?? ''}
                                  disabled={editSaveBusy || !it.productId}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setEditItems((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, purchasePrice: v } : x))
                                    );
                                  }}
                                />
                              </td>
                              <td style={{ width: 100 }}>
                                <input
                                  className="warehouse-ops-qty-input"
                                  type="number"
                                  min={minQty}
                                  value={it.quantity}
                                  disabled={editSaveBusy || !it.productId}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setEditItems((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, quantity: v } : x))
                                    );
                                  }}
                                />
                              </td>
                              <td>{received}</td>
                              <td>
                                <Button
                                  variant="secondary"
                                  size="small"
                                  disabled={editSaveBusy || !canRemove || !it.productId}
                                  title={
                                    canRemove
                                      ? 'Удалить строку'
                                      : 'Нельзя удалить — уже есть принятое количество'
                                  }
                                  onClick={() => setEditItems((prev) => prev.filter((_, i) => i !== idx))}
                                >
                                  Удалить
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">Нет строк — добавьте товар через поиск.</p>
                )}
              </>
            ) : (
              <>
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
                        <td style={{ width: 140 }}>
                          {it.purchase_price ?? it.product_cost ?? '—'}
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
              </>
            )}

            <h4 style={{ marginTop: 14 }}>Приёмки</h4>
            {Array.isArray(detail.receipts) && detail.receipts.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>№</th>
                      <th>Склад</th>
                      <th>Статус</th>
                      <th>Позиций</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.receipts.map((r) => {
                      const isScanning = String(r.status) === 'scanning';
                      const isExpected = String(r.status) === 'expected';
                      const isCancelled = String(r.status) === 'cancelled';
                      return (
                        <tr key={r.id}>
                          <td>{fmtDt(r.cancelled_at || r.started_at || r.created_at)}</td>
                          <td>№{r.id}</td>
                          <td>{r.warehouse_name || warehouseDisplayLabel(null, r.warehouse_id) || '—'}</td>
                          <td>{receiptStatusLabel(r.status)}</td>
                          <td>{r.items_count ?? '—'}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <Button
                                variant="secondary"
                                size="small"
                                disabled={receiptLoading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isExpected) setExpectedDraftOpen(true);
                                  else openReceipt(r.id);
                                }}
                              >
                                {receiptLoading
                                  ? 'Открываю…'
                                  : isExpected
                                    ? 'Редактировать'
                                    : isScanning
                                      ? 'Редактировать'
                                      : 'Открыть'}
                              </Button>
                              {!isCancelled ? (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  disabled={deleteReceiptBusy === r.id}
                                  onClick={() => handleDeletePurchaseReceipt(r)}
                                >
                                  {deleteReceiptBusy === r.id
                                    ? '…'
                                    : String(r.status) === 'completed'
                                      ? 'Отменить'
                                      : 'Удалить'}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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
        isOpen={!!receipt?.receipt?.id || receiptLoading}
        onClose={requestCloseReceipt}
        title={
          receiptLoading
            ? 'Загрузка приёмки…'
            : receipt?.receipt?.id
              ? `Приёмка №${receipt.receipt.id}`
              : 'Приёмка'
        }
        size="xl"
      >
        {receiptLoading && !receipt?.receipt?.id ? (
          <div className="loading">Загрузка приёмки…</div>
        ) : null}
        {receipt?.receipt ? (
          <>
            {err ? (
              <p className="error" role="alert" style={{ marginBottom: 12 }}>
                {err}
              </p>
            ) : null}
            {(() => {
              const isReceiptScanning = String(receipt.receipt.status) === 'scanning';
              const isReceiptCancelled = String(receipt.receipt.status) === 'cancelled';
              return (
                <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              статус: {receiptStatusLabel(receipt.receipt.status)} · закупка №{receipt.receipt.purchase_id}
              {receipt.receipt.completed_at ? ` · завершена ${fmtDt(receipt.receipt.completed_at)}` : ''}
              {receipt.receipt.cancelled_at ? ` · отменена ${fmtDt(receipt.receipt.cancelled_at)}` : ''}
              {receipt.hasExpectedDraft ? (
                <>
                  {' '}
                  · сравнение с черновиком <strong>«Ожидается»</strong>
                </>
              ) : null}
            </p>
            {!isReceiptScanning ? (
              <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
                {isReceiptCancelled
                  ? 'Приёмка отменена: остатки откачены. Просмотр только для истории.'
                  : 'Завершённую приёмку можно просмотреть или отменить (с откатом остатков). Редактирование количеств недоступно.'}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={receiptSupplierId}
                disabled={!isReceiptScanning}
                onChange={async (e) => {
                  const v = e.target.value;
                  setReceiptSupplierId(v);
                  if (!v) {
                    setErr('Выберите поставщика');
                    return;
                  }
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(receipt.receipt.purchase_id, {
                      supplierId: Number(v),
                    });
                    if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                    await openReceipt(receipt.receipt.id);
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить поставщика');
                  }
                }}
              >
                <option value="">— Выберите поставщика —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={String(s.id)}>
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
                disabled={!isReceiptScanning}
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
                {(destWarehouses || []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {warehouseDisplayLabel(w)}
                    </option>
                  ))}
              </select>
            </div>
            {isReceiptGuest ? (
              <p className="warehouse-ops-hint" style={{ marginBottom: 10 }}>
                Вы приглашены в совместную приёмку: сканируйте товары — они попадут в общий список. Завершить приёмку может только создатель.
              </p>
            ) : null}
            {isReceiptScanning && !isReceiptGuest ? (
              <div style={{ marginBottom: 12 }}>
                <InviteUserButton
                  users={inviteUsers}
                  busy={inviteBusy}
                  excludeUserId={currentUserId}
                  onInvite={async (uid) => {
                    const rid = receipt?.receipt?.id;
                    if (!rid || inviteBusy) return;
                    try {
                      setInviteBusy(true);
                      setErr(null);
                      await purchasesApi.inviteToReceipt(rid, { userId: uid });
                      setReceiptCompleteInfo('Приглашение отправлено в уведомления.');
                    } catch (ex) {
                      setErr(ex.response?.data?.message || ex.message || 'Не удалось отправить приглашение');
                    } finally {
                      setInviteBusy(false);
                    }
                  }}
                />
              </div>
            ) : null}
            {isReceiptScanning ? (
            <form
              onSubmit={(e) => e.preventDefault()}
              className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
            >
              <FastScanInput
                inputRef={scanRef}
                onScan={scan}
                debounceMs={120}
                minLength={4}
                placeholder="Сканируйте штрихкод (1 скан = +1)"
              />
            </form>
            ) : null}
            {isReceiptScanning && pendingScans > 0 ? (
              <p className="muted" style={{ marginTop: 8 }} role="status">
                В очереди сканов: <strong>{pendingScans}</strong> · список обновляется автоматически
              </p>
            ) : isReceiptScanning && scanMsg ? (
              <p className="muted" style={{ marginTop: 8 }}>{scanMsg}</p>
            ) : null}
            {isReceiptScanning && lastScanLine && (
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
              {isReceiptScanning ? (
              <Button
                disabled={isReceiptGuest}
                title={isReceiptGuest ? 'Завершить может только создатель приёмки' : undefined}
                onClick={async () => {
                  const completedReceiptId = receipt.receipt.id;
                  const res = await purchasesApi.completeReceipt(completedReceiptId, {
                    warehouseId: receiptWarehouseId || null,
                  });
                  syncPurchaseReceiptInUrl('');
                  setReceipt(null);
                  setScanMsg(null);
                  setReceiptCloseConfirm(false);
                  await reload();
                  if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                  if (Array.isArray(res?.extras) && res.extras.length > 0) {
                    const totalExtra = res.extras.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
                    setReceiptCompleteInfo(
                      `Приёмка завершена. Излишек: ${res.extras.length} поз., ${totalExtra} шт. — товар уже принят на склад.`
                    );
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
              ) : null}
              <Button variant="secondary" onClick={() => openReceipt(receipt.receipt.id)}>
                Обновить
              </Button>
              {isReceiptScanning ? (
                <Button variant="secondary" onClick={requestCloseReceipt}>
                  Закрыть (сохранить черновик)
                </Button>
              ) : null}
              {!isReceiptGuest ? (
                <Button
                  variant="secondary"
                  disabled={deleteReceiptBusy === receipt.receipt.id}
                  onClick={() => handleDeletePurchaseReceipt(receipt.receipt, { closeModal: true })}
                >
                  {deleteReceiptBusy === receipt.receipt.id ? 'Удаляю…' : 'Удалить приёмку'}
                </Button>
              ) : null}
            </div>

            {isReceiptScanning ? (
            <>
            <h4 style={{ marginTop: 14 }}>Коробкой</h4>
            <p className="warehouse-ops-hint" style={{ marginTop: 0 }}>
              Отсканируйте товар выше (идентификация), затем укажите количество в коробке — через 2 с прибавим его к уже принятому и вернём фокус в поле скана.
              Либо введите ШК/артикул и количество в поля ниже.
            </p>
            <form
              onSubmit={(e) => e.preventDefault()}
              className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
              style={{ marginTop: 8 }}
            >
              <input
                className="warehouse-ops-scan-input"
                value={boxAddCode}
                onChange={(e) => {
                  const code = e.target.value;
                  setBoxAddCode(code);
                  scheduleTopBoxQtyApply(boxAddQty, code);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                placeholder="ШК или артикул (необязательно после скана)"
                autoComplete="off"
                spellCheck={false}
                disabled={boxAddBusy}
              />
              <input
                className="warehouse-ops-qty-input"
                type="number"
                min={1}
                step={1}
                value={boxAddQty}
                onChange={(e) => {
                  const qty = e.target.value;
                  setBoxAddQty(qty);
                  scheduleTopBoxQtyApply(qty, boxAddCode);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                placeholder="Кол-во"
                style={{ width: 120 }}
                disabled={boxAddBusy}
              />
            </form>
            </>
            ) : null}

            <h4 style={{ marginTop: 14 }}>{isReceiptScanning ? 'Отсканировано' : 'Принято по приёмке'}</h4>
            {Array.isArray(receipt.items) && receipt.items.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Закуп. цена</th>
                      <th>{receipt.hasExpectedDraft ? 'Ожидалось (черновик)' : 'Заказано'}</th>
                      <th>Принято</th>
                      {isReceiptScanning ? <th style={{ width: 190 }}>Коробкой</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReceiptItems.map((it) => (
                      <tr key={receiptItemRowKey(it)}>
                        <td className="sku-cell">{it.product_sku || '—'}</td>
                        <td className="name-cell">{it.product_name || '—'}</td>
                        <td style={{ width: 140 }}>
                          {isReceiptScanning ? (
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
                          ) : (
                            it.purchase_price ?? it.product_cost ?? '—'
                          )}
                        </td>
                        {(() => {
                          const draftExpRaw = it.draft_expected_quantity;
                          const draftExp =
                            draftExpRaw != null && draftExpRaw !== '' ? Number(draftExpRaw) : null;
                          const expPurchase = Number(it.expected_quantity);
                          const expected =
                            draftExp != null && Number.isFinite(draftExp)
                              ? draftExp
                              : Number.isFinite(expPurchase)
                                ? expPurchase
                                : null;
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
                          const isScanning = String(receipt?.receipt?.status) === 'scanning';
                          return (
                            <>
                              <td>{expected ?? '—'}</td>
                              <td style={cellStyle}>
                                {isScanning ? (
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <input
                                      key={`${it.product_id}-${scanned}`}
                                      type="number"
                                      min={0}
                                      step={1}
                                      className="warehouse-ops-qty-input"
                                      style={{ width: 80 }}
                                      defaultValue={scanned}
                                      disabled={manualQtyBusy === it.product_id}
                                      onBlur={(e) => handleManualReceiptQty(it, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') e.preventDefault();
                                      }}
                                    />
                                    {received != null ? (
                                      <span className="muted" style={{ fontSize: 12 }}>
                                        было {received}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : (
                                  <>
                                    {scanned}
                                    {received != null ? `/${received}` : ''}
                                  </>
                                )}
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
                                {isOver && (
                                  <span className="muted" style={{ marginLeft: 8, fontWeight: 600 }}>
                                    больше заказанного
                                  </span>
                                )}
                              </td>
                            </>
                          );
                        })()}
                        {isReceiptScanning ? (
                          <td>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              className="warehouse-ops-qty-input"
                              style={{ width: 90 }}
                              placeholder="+N"
                              value={it._boxQtyInput ?? ''}
                              disabled={boxAddBusy}
                              onChange={(e) => {
                                const v = e.target.value;
                                setReceipt((prev) => {
                                  if (!prev?.items) return prev;
                                  const nextItems = (prev.items || []).map((x) =>
                                    Number(x?.product_id) === Number(it.product_id)
                                      ? { ...x, _boxQtyInput: v }
                                      : x
                                  );
                                  return { ...prev, items: nextItems };
                                });
                                scheduleRowBoxQtyApply(it.product_id, v);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.preventDefault();
                              }}
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Пока ничего не отсканировано.</p>
            )}
                </>
              );
            })()}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={!!receiptDraftChoice}
        onClose={() => setReceiptDraftChoice(null)}
        title="Приёмка за сегодня"
        size="md"
      >
        {receiptDraftChoice ? (
          <>
            <p className="warehouse-ops-hint">
              У закупки №{receiptDraftChoice.purchaseId} сегодня уже есть незавершённая приёмка №
              {receiptDraftChoice.existingReceiptId}
              {receiptDraftChoice.draftDate ? ` (от ${fmtDt(receiptDraftChoice.draftDate)})` : ''}. Продолжить её или
              начать новую?
            </p>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              Черновик с другого дня не предлагается — для новой даты создаётся отдельная приёмка.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <Button
                onClick={async () => {
                  const rid = receiptDraftChoice.existingReceiptId;
                  setReceiptDraftChoice(null);
                  await openReceipt(rid);
                }}
              >
                Продолжить приёмку
              </Button>
              <Button
                variant="secondary"
                disabled={createReceiptBusy}
                onClick={async () => {
                  setReceiptDraftChoice(null);
                  await startPurchaseReceipt({ forceNew: true });
                }}
              >
                {createReceiptBusy ? 'Создаю…' : 'Начать новую'}
              </Button>
              <Button variant="secondary" onClick={() => setReceiptDraftChoice(null)}>
                Отмена
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={receiptCloseConfirm}
        onClose={() => setReceiptCloseConfirm(false)}
        title="Закрыть приёмку"
        size="md"
      >
        <p className="warehouse-ops-hint">
          Черновик приёмки №{receipt?.receipt?.id} можно сохранить и продолжить позже, или удалить без завершения.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <Button
            onClick={() => {
              setReceiptCloseConfirm(false);
              syncPurchaseReceiptInUrl('');
              setReceipt(null);
              setScanMsg(null);
            }}
          >
            Сохранить черновик и закрыть
          </Button>
          <Button
            variant="secondary"
            disabled={deleteReceiptDraftBusy}
            onClick={async () => {
              const rid = receipt?.receipt?.id;
              if (!rid) return;
              try {
                setDeleteReceiptDraftBusy(true);
                setErr(null);
                await purchasesApi.deleteReceipt(rid);
                setReceiptCloseConfirm(false);
                syncPurchaseReceiptInUrl('');
                setReceipt(null);
                setScanMsg(null);
                if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                await reload();
              } catch (ex) {
                setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить черновик');
              } finally {
                setDeleteReceiptDraftBusy(false);
              }
            }}
          >
            {deleteReceiptDraftBusy ? 'Удаляю…' : 'Удалить черновик'}
          </Button>
          <Button variant="secondary" onClick={() => setReceiptCloseConfirm(false)}>
            Отмена
          </Button>
        </div>
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

      <PurchaseExpectedDraftModal
        isOpen={expectedDraftOpen && Boolean(detail?.purchase?.id)}
        onClose={() => setExpectedDraftOpen(false)}
        purchaseId={detail?.purchase?.id}
        supplierId={detail?.purchase?.supplier_id}
        organizationId={detail?.purchase?.organization_id}
        suppliers={suppliers}
        products={products}
        setErr={setErr}
        onSaved={async () => {
          if (detail?.purchase?.id) await openDetail(detail.purchase.id);
        }}
        onApplied={async () => {
          if (detail?.purchase?.id) {
            await openDetail(detail.purchase.id);
            await reload();
          }
        }}
      />

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
    </>
  );
}


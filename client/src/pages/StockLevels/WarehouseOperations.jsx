/**
 * Операции склада: поступление (по скану), списание, инвентаризация
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LinkBarcodeToProductModal } from '../../components/common/LinkBarcodeToProductModal/LinkBarcodeToProductModal';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import { productsApi } from '../../services/products.api';
import { stockMovementsApi } from '../../services/stockMovements.api';
import { receiptsApi } from '../../services/receipts.api';
import { inventorySessionsApi } from '../../services/inventorySessions.api';
import { fetchProductByScanCode } from '../../utils/productSearch.js';
import { clearScanField, readScanFieldValue } from '../../utils/scanInput.js';
import { shouldUseBarcodeDigitFallback } from '../../utils/productBarcodes.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Button } from '../../components/common/Button/Button';
import { InviteUserButton } from '../../components/common/InviteUserButton/InviteUserButton';
import { FastScanInput } from '../../components/common/FastScanInput/FastScanInput';
import { Modal } from '../../components/common/Modal/Modal';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { onNavigationClick } from '../../utils/navigationClick.js';
import {
  applySingleOrgWarehouseDefaults,
  useStockDestinationDefaults,
  warehouseDisplayLabel,
} from '../../utils/stockDestinationDefaults.js';
import { usersApi } from '../../services/users.api.js';
import {
  isLikelyBarcodeScan,
  matchProductsLocal,
  mergeProductLists,
  normalizeProductSearchQuery,
  searchProductsRemote,
  formatProductOptionLabel,
  searchProductsCombined,
} from '../../utils/productSearch';
import { MarketplaceReturnsPanel } from '../../components/returns/MarketplaceReturnsPanel';
import { orderRowCatalogSku } from '../../utils/orderActions.js';
import './WarehouseOperations.css';

const MODE_TABLE = 'table';
const MODE_RECEIPT = 'receipt';
const MODE_WRITEOFF = 'writeoff';
const MODE_INVENTORY = 'inventory';
const MODE_RECEIPTS_LIST = 'receipts_list';
const MODE_RETURN_SUPPLIER = 'return_supplier';

function formatWarehouseReceiptNumber(r) {
  const prId = r?.purchase_receipt_id ?? r?.purchaseReceiptId;
  const docNo = r?.receipt_number || (r?.id != null ? `#${r.id}` : '—');
  if (prId != null && String(prId).trim() !== '') {
    return `закуп. приёмка №${prId} · ${docNo}`;
  }
  return docNo;
}

/** @deprecated используйте formatWarehouseReceiptNumber */
const formatPurchaseReceiptNumber = formatWarehouseReceiptNumber;
const MODE_RETURN_CUSTOMER = 'return_customer';
const MODE_TRANSFER = 'transfer';

const INVENTORY_LIVE_DRAFT_LS = 'warehouse_ops_inventory_live_draft';
const WAREHOUSE_SCAN_DEDUP_MS = 500;

function resolveCustomerReturnLineSku(line, fromCatalog) {
  const fromLine = orderRowCatalogSku(line);
  if (fromLine) return fromLine;
  const raw = String(line?.sku ?? '').trim();
  if (raw && raw !== '—') return raw;
  const fromProduct = String(fromCatalog?.sku ?? '').trim();
  return fromProduct || '—';
}

function clearWarehouseScanDebounce(debounceRef) {
  if (debounceRef?.current) {
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }
}

/** Один физический скан не должен обрабатываться дважды (debounce + Enter). */
function shouldIgnoreDuplicateWarehouseScan(dedupRef, value) {
  const k = String(value || '').trim().toLowerCase();
  if (!k) return true;
  const now = Date.now();
  if (dedupRef.current.key === k && now - dedupRef.current.at < WAREHOUSE_SCAN_DEDUP_MS) {
    return true;
  }
  dedupRef.current = { key: k, at: now };
  return false;
}

function normalizeScanInput(raw) {
  return String(raw || '')
    .replace(/[\r\n]+/g, '')
    .trim();
}

/** Сначала недавно отсканированные текущим пользователем, затем по артикулу. */
function sortInventoryNewRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ta = Number(a?.scannedAt) || 0;
    const tb = Number(b?.scannedAt) || 0;
    if (tb !== ta) return tb - ta;
    return String(a?.product?.sku || '').localeCompare(String(b?.product?.sku || ''), 'ru', {
      numeric: true,
    });
  });
}

function warehouseScanErrorMessage(e, fallback = 'Товар не найден') {
  const m = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message;
  const s = String(m || fallback).trim();
  return s || fallback;
}

function readInventoryLiveDraft() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(INVENTORY_LIVE_DRAFT_LS) : null;
    if (!raw) return null;
    const d = JSON.parse(raw);
    const sid = String(d?.liveSessionId || '').trim();
    if (!sid) return null;
    if (d?.savedAt && Date.now() - Number(d.savedAt) > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(INVENTORY_LIVE_DRAFT_LS);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

function writeInventoryLiveDraft(draft) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!draft?.liveSessionId) {
      localStorage.removeItem(INVENTORY_LIVE_DRAFT_LS);
      return;
    }
    localStorage.setItem(INVENTORY_LIVE_DRAFT_LS, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}

function clearInventoryLiveDraft() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(INVENTORY_LIVE_DRAFT_LS);
  } catch {
    /* ignore */
  }
}

function syncInventoryLiveSessionInUrl(sessionId) {
  try {
    const url = new URL(window.location.href);
    const sid = String(sessionId || '').trim();
    if (sid) {
      url.searchParams.set('op', 'inventory');
      url.searchParams.set('inv_session', sid);
    } else {
      url.searchParams.delete('inv_session');
    }
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
}

const KNOWN_MODES = new Set([
  MODE_TABLE,
  MODE_RECEIPTS_LIST,
  MODE_TRANSFER,
  MODE_WRITEOFF,
  MODE_RETURN_SUPPLIER,
  MODE_RETURN_CUSTOMER,
  MODE_INVENTORY,
  MODE_RECEIPT
]);

/** Тип документа warehouse_receipts для каждого раздела склада. */
const RECEIPT_DOCUMENT_TYPE_BY_MODE = {
  [MODE_RECEIPTS_LIST]: 'receipt',
  [MODE_RETURN_SUPPLIER]: 'return',
  [MODE_RETURN_CUSTOMER]: 'customer_return',
  [MODE_WRITEOFF]: 'writeoff',
};

function receiptDocumentTypeLabel(documentType) {
  if (documentType === 'return') return 'Возврат поставщику';
  if (documentType === 'customer_return') return 'Возврат от клиента';
  if (documentType === 'writeoff') return 'Списание';
  return 'Приёмка';
}

function warehousesForOrganization(ownWarehouses, organizationId) {
  const orgId = String(organizationId || '').trim();
  if (!orgId) return [];
  return (ownWarehouses || []).filter((w) => {
    const wOrg = w.organizationId ?? w.organization_id;
    return wOrg != null && String(wOrg) === orgId;
  });
}

export function WarehouseOperations({
  products,
  mainWarehouseName,
  /** Организация с вкладки «Остатки» — подставляется в перемещение */
  defaultOrganizationId = '',
  /** Выбранный склад на вкладке «Остатки» (подсказка для полей склада) */
  inventoryWarehouseId,
  /** Перезагрузить товары с фильтром по складу (для пересчёта «в системе» при инвентаризации) */
  reloadProductsWithWarehouse,
  onRefresh,
  loading,
  activeTab,
  onTabChange,
  openReceiptId,
  /** Предзаполнение приёмки возврата из списка МП: { scanCode, marketplace, orderId } */
  prefillCustomerReturn = null,
  /** Спрятать внутреннюю полосу вкладок (вкладки вынесены в StockLevelsLayout) */
  hideTabs = false
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
  const { singleOrganizationId, singleWarehouseId } = useStockDestinationDefaults(
    organizations,
    warehouses,
    { ownOnly: true }
  );
  const ownWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId
      ),
    [warehouses]
  );
  const [internalMode, setInternalMode] = useState(MODE_TABLE);
  const mode =
    typeof activeTab === 'string' && KNOWN_MODES.has(activeTab) ? activeTab : internalMode;
  const setMode = onTabChange || setInternalMode;
  const [foundProduct, setFoundProduct] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [qtyInput, setQtyInput] = useState(1);
  const [opLoading, setOpLoading] = useState(false);
  const [opMessage, setOpMessage] = useState(null);
  // Перемещение между складами: список строк { productId, sku, name, quantity }
  const [transferOrganizationId, setTransferOrganizationId] = useState('');
  const [transferFromWarehouseId, setTransferFromWarehouseId] = useState('');
  const [transferToWarehouseId, setTransferToWarehouseId] = useState('');
  const [transferManualSearch, setTransferManualSearch] = useState('');
  const transferScanInputRef = useRef(null);
  const transferScanDebounceRef = useRef(null);
  const [transferSelectedProductId, setTransferSelectedProductId] = useState('');
  const [transferQty, setTransferQty] = useState(1);
  const [transferQuickMode, setTransferQuickMode] = useState(true);
  const [transferList, setTransferList] = useState([]);
  const transferWarehouses = useMemo(() => {
    const orgId = String(transferOrganizationId || '').trim();
    if (!orgId) return [];
    return ownWarehouses.filter((w) => {
      const wOrg = w.organizationId ?? w.organization_id;
      return wOrg != null && String(wOrg) === orgId;
    });
  }, [ownWarehouses, transferOrganizationId]);
  const transferWarehouseLabel = (w) => {
    if (!w) return '';
    return w.address || w.name || `Склад #${w.id}`;
  };
  const transferFromWarehouse = useMemo(
    () => transferWarehouses.find((w) => String(w.id) === String(transferFromWarehouseId)),
    [transferWarehouses, transferFromWarehouseId]
  );
  const transferToWarehouse = useMemo(
    () => transferWarehouses.find((w) => String(w.id) === String(transferToWarehouseId)),
    [transferWarehouses, transferToWarehouseId]
  );
  const [inventorySessionsList, setInventorySessionsList] = useState([]);
  const [inventorySessionsLoading, setInventorySessionsLoading] = useState(false);
  const [inventoryDetailView, setInventoryDetailView] = useState(null);
  const scanInputRef = useRef(null);
  const [receiptMode, setReceiptMode] = useState('scan');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [receiptListSearch, setReceiptListSearch] = useState('');
  const [receiptPickedProduct, setReceiptPickedProduct] = useState(null);
  const [listQty, setListQty] = useState(1);
  const [receiptSupplierId, setReceiptSupplierId] = useState('');
  const [receiptOrganizationId, setReceiptOrganizationId] = useState('');
  /** Обязательный склад приёмки (поступление / возвраты) */
  const [receiptWarehouseId, setReceiptWarehouseId] = useState('');
  const [returnWarehouseId, setReturnWarehouseId] = useState('');
  const [writeoffOrganizationId, setWriteoffOrganizationId] = useState('');
  const [writeoffWarehouseId, setWriteoffWarehouseId] = useState('');
  const [writeoffReason, setWriteoffReason] = useState('Брак');
  const [writeoffFilterOrgId, setWriteoffFilterOrgId] = useState('');
  const [writeoffFilterWhId, setWriteoffFilterWhId] = useState('');
  const [writeoffList, setWriteoffList] = useState([]);
  const writeoffScanDebounceRef = useRef(null);
  const writeoffScanInputRef = useRef(null);
  const writeoffScanDedupRef = useRef({ key: '', at: 0 });
  const writeoffSuppressScanRef = useRef(false);
  const [customerReturnWarehouseId, setCustomerReturnWarehouseId] = useState('');
  // Список для поступления: { productId, sku, name, quantity, cost }
  const [receiptList, setReceiptList] = useState([]);
  const scanDebounceRef = useRef(null);
  const manualSearchDebounceRef = useRef(null);
  const [receiptsList, setReceiptsList] = useState([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState(null);
  const [receiptEditOpen, setReceiptEditOpen] = useState(false);
  const [receiptEditSaving, setReceiptEditSaving] = useState(false);
  const [receiptEditForm, setReceiptEditForm] = useState(null);
  const [addReceiptModalOpen, setAddReceiptModalOpen] = useState(false);
  const [receiptSessionEnabled, setReceiptSessionEnabled] = useState(false);
  const [receiptSessionId, setReceiptSessionId] = useState('');
  const [receiptSessionOwnerUserId, setReceiptSessionOwnerUserId] = useState(null);
  const [boxAddCode, setBoxAddCode] = useState('');
  const [boxAddQty, setBoxAddQty] = useState('');
  const [boxAddBusy, setBoxAddBusy] = useState(false);
  const lastReceiptScannedProductRef = useRef(null);
  const boxQtyDebounceRef = useRef(null);
  const BOX_QTY_APPLY_MS = 2000;
  const [inviteUsers, setInviteUsers] = useState([]);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inventoryLiveDraft, setInventoryLiveDraft] = useState(null);
  const [receiptDeleteLoading, setReceiptDeleteLoading] = useState(false);
  const [inventoryDeleteLoading, setInventoryDeleteLoading] = useState(false);

  const leaveReceiptSession = useCallback(() => {
    setReceiptSessionEnabled(false);
    setReceiptSessionId('');
    setReceiptSessionOwnerUserId(null);
    setLookupError(null);
    setOpMessage(null);
    setReceiptList([]);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('session');
      window.history.replaceState({}, '', url.toString());
    } catch {
      /* ignore */
    }
  }, []);
  // Возврат поставщику: организация, поставщик и список { productId, sku, name, quantity }
  const [returnOrganizationId, setReturnOrganizationId] = useState('');
  const [returnSupplierId, setReturnSupplierId] = useState('');
  const [returnList, setReturnList] = useState([]);
  const [returnMode, setReturnMode] = useState('scan');
  const [returnSelectedProductId, setReturnSelectedProductId] = useState('');
  const [returnListSearch, setReturnListSearch] = useState('');
  const [returnPickedProduct, setReturnPickedProduct] = useState(null);
  const [returnListQty, setReturnListQty] = useState(1);
  const returnScanDebounceRef = useRef(null);
  const returnScanInputRef = useRef(null);
  const returnScanDedupRef = useRef({ key: '', at: 0 });
  const [customerReturnOrganizationId, setCustomerReturnOrganizationId] = useState('');
  const returnWarehouses = useMemo(
    () => warehousesForOrganization(ownWarehouses, returnOrganizationId),
    [ownWarehouses, returnOrganizationId]
  );
  const customerReturnWarehouses = useMemo(
    () => warehousesForOrganization(ownWarehouses, customerReturnOrganizationId),
    [ownWarehouses, customerReturnOrganizationId]
  );
  const writeoffWarehouses = useMemo(
    () => warehousesForOrganization(ownWarehouses, writeoffOrganizationId),
    [ownWarehouses, writeoffOrganizationId]
  );
  const writeoffFilterWarehouses = useMemo(
    () =>
      writeoffFilterOrgId
        ? warehousesForOrganization(ownWarehouses, writeoffFilterOrgId)
        : ownWarehouses,
    [ownWarehouses, writeoffFilterOrgId]
  );
  const [customerReturnList, setCustomerReturnList] = useState([]);
  const [customerReturnMode, setCustomerReturnMode] = useState('scan');
  const [customerReturnSelectedProductId, setCustomerReturnSelectedProductId] = useState('');
  const [customerReturnListSearch, setCustomerReturnListSearch] = useState('');
  const [customerReturnPickedProduct, setCustomerReturnPickedProduct] = useState(null);
  const [customerReturnListQty, setCustomerReturnListQty] = useState(1);
  const customerReturnScanDebounceRef = useRef(null);
  const customerReturnScanInputRef = useRef(null);
  const customerReturnScanDedupRef = useRef({ key: '', at: 0 });
  const customerReturnAcceptRef = useRef(null);
  /** Пересчёт выборочно: скан / поиск + только отмеченные позиции */
  const [inventoryNewSession, setInventoryNewSession] = useState(false);
  const [inventoryNewRows, setInventoryNewRows] = useState([]);
  const [inventoryNewPickedProduct, setInventoryNewPickedProduct] = useState(null);
  const [inventoryNewSearch, setInventoryNewSearch] = useState('');
  const [linkBarcodeModalOpen, setLinkBarcodeModalOpen] = useState(false);
  const [linkBarcodeScanned, setLinkBarcodeScanned] = useState('');
  const linkBarcodeContinueRef = useRef(null);
  const [productPickOpen, setProductPickOpen] = useState(false);
  const [productPickTitle, setProductPickTitle] = useState('');
  const [productPickList, setProductPickList] = useState([]);
  const productPickOnPickRef = useRef(null);
  // Dropdown suggestions (по буквам) — для полей ввода/поиска
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestTitle, setSuggestTitle] = useState('');
  const [suggestList, setSuggestList] = useState([]);
  const [suggestContext, setSuggestContext] = useState('');
  const suggestOnPickRef = useRef(null);

  const closeLinkBarcodeModal = useCallback(() => {
    setLinkBarcodeModalOpen(false);
    setLinkBarcodeScanned('');
    linkBarcodeContinueRef.current = null;
  }, []);

  const closeProductPick = useCallback(() => {
    setProductPickOpen(false);
    setProductPickTitle('');
    setProductPickList([]);
    productPickOnPickRef.current = null;
  }, []);

  const openProductPick = useCallback((title, list, onPick) => {
    setProductPickTitle(String(title || 'Выберите товар'));
    setProductPickList(Array.isArray(list) ? list : []);
    productPickOnPickRef.current = typeof onPick === 'function' ? onPick : null;
    setProductPickOpen(true);
  }, []);

  const openLinkBarcode = useCallback((code, continueFn) => {
    setLinkBarcodeScanned(String(code || '').trim());
    linkBarcodeContinueRef.current = typeof continueFn === 'function' ? continueFn : null;
    setLinkBarcodeModalOpen(true);
  }, []);

  const normalizeQuery = normalizeProductSearchQuery;
  const closeSuggest = useCallback(() => {
    setSuggestOpen(false);
    setSuggestTitle('');
    setSuggestList([]);
    setSuggestContext('');
    suggestOnPickRef.current = null;
  }, []);
  const openSuggest = useCallback((context, title, list, onPick) => {
    setSuggestContext(String(context || ''));
    setSuggestTitle(String(title || 'Выберите товар'));
    setSuggestList(Array.isArray(list) ? list : []);
    suggestOnPickRef.current = typeof onPick === 'function' ? onPick : null;
    setSuggestOpen(true);
  }, []);
  const findLocalMatches = useCallback(
    (query) => matchProductsLocal(products, query, { limit: 30 }),
    [products]
  );

  const lookupProductByAny = useCallback(
    async (
      value,
      { title = 'Выберите товар', allowLinkBarcode = false, organizationId = null, useServerSearch = false } = {}
    ) => {
      const v = normalizeQuery(value);
      if (!v) {
        throw new Error('Введите штрихкод / артикул / название');
      }
      let barcodeProduct = null;
      if (isLikelyBarcodeScan(v)) {
        try {
          barcodeProduct = await fetchProductByScanCode(v);
        } catch (scanErr) {
          if (!shouldUseBarcodeDigitFallback(v)) throw scanErr;
        }
      }

      // 2) Поиск по штрихкоду / артикулу / названию (локально + сервер)
      let matches = findLocalMatches(v);
      const remote = await searchProductsRemote(v, { organizationId, limit: 40 });
      matches = mergeProductLists(barcodeProduct ? [barcodeProduct] : [], matches, remote);
      if (matches.length === 0 && useServerSearch === false) {
        matches = remote;
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        return await new Promise((resolve, reject) => {
          openProductPick(title, matches, (p) => {
            closeProductPick();
            if (!p) reject(new Error('Товар не выбран'));
            else resolve(p);
          });
        });
      }

      // 3) Если ввели штрихкод вручную и товара нет — предложим привязать штрихкод к товару (только там, где это уместно).
      if (allowLinkBarcode) {
        return await new Promise((resolve, reject) => {
          openLinkBarcode(v, (p) => {
            if (!p) reject(new Error('Товар не выбран'));
            else resolve(p);
          });
        });
      }

      throw new Error('Товар не найден');
    },
    [findLocalMatches, searchProductsRemote, openProductPick, closeProductPick, openLinkBarcode]
  );

  const handleLinkBarcodeLinked = useCallback(
    async (product) => {
      const fn = linkBarcodeContinueRef.current;
      linkBarcodeContinueRef.current = null;
      setLinkBarcodeModalOpen(false);
      setLinkBarcodeScanned('');
      try {
        if (typeof onRefresh === 'function') await Promise.resolve(onRefresh());
      } catch (_) {
        /* ignore */
      }
      if (fn && product) {
        window.setTimeout(() => fn(product), 0);
      }
    },
    [onRefresh]
  );
  const inventoryNewScanDebounceRef = useRef(null);
  const inventoryNewScanInputRef = useRef(null);
  const inventoryScanBusyRef = useRef(false);
  /** Склад, по которому ведётся новая инвентаризация (обязателен до сохранения) */
  const [inventorySessionWarehouseId, setInventorySessionWarehouseId] = useState('');
  /** Обнулить остаток по позициям на складе, не попавшим в список пересчёта */
  const [inventoryZeroUnlisted, setInventoryZeroUnlisted] = useState(true);
  /** Редактирование существующего документа (id) */
  const [inventoryEditingSessionId, setInventoryEditingSessionId] = useState(null);
  const [inventoryLiveEnabled, setInventoryLiveEnabled] = useState(false);
  const [inventoryLiveSessionId, setInventoryLiveSessionId] = useState('');
  const [inventoryLiveOwnerUserId, setInventoryLiveOwnerUserId] = useState(null);
  const inventorySetFactDebounceRef = useRef({});

  const loadReceiptsList = useCallback(
    (forMode = mode) => {
      const documentType = RECEIPT_DOCUMENT_TYPE_BY_MODE[forMode];
      if (!documentType) return;
      setReceiptsLoading(true);
      const params = { limit: 200, documentType };
      if (forMode === MODE_WRITEOFF) {
        if (writeoffFilterOrgId) params.organizationId = writeoffFilterOrgId;
        if (writeoffFilterWhId) params.warehouseId = writeoffFilterWhId;
      }
      receiptsApi
        .getList(params)
        .then(({ list }) => {
          setReceiptsList(Array.isArray(list) ? list : []);
        })
        .catch((err) => {
          console.warn('[WarehouseOperations] loadReceiptsList failed:', err?.message || err);
          setReceiptsList([]);
        })
        .finally(() => setReceiptsLoading(false));
    },
    [mode, writeoffFilterOrgId, writeoffFilterWhId]
  );

  const receiptRowTotalUnits = (r) => {
    const q = r?.total_quantity ?? r?.totalQuantity;
    if (q == null || q === '') return '—';
    const n = Number(q);
    return Number.isFinite(n) ? n : '—';
  };

  useEffect(() => {
    if (mode === MODE_RECEIPT && setMode) {
      setMode(MODE_RECEIPTS_LIST);
    }
  }, [mode, setMode]);

  useEffect(() => {
    if (mode === MODE_WRITEOFF) writeoffScanInputRef.current?.focus();
    if (mode === MODE_RETURN_SUPPLIER) returnScanInputRef.current?.focus();
    if (mode === MODE_RETURN_CUSTOMER) customerReturnScanInputRef.current?.focus();
    if (mode === MODE_TRANSFER) transferScanInputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== MODE_TRANSFER) return;
    if (!transferOrganizationId && defaultOrganizationId) {
      setTransferOrganizationId(String(defaultOrganizationId));
    } else if (!transferOrganizationId && singleOrganizationId) {
      setTransferOrganizationId(singleOrganizationId);
    }
  }, [mode, transferOrganizationId, defaultOrganizationId, singleOrganizationId]);

  useEffect(() => {
    const allowed = new Set(returnWarehouses.map((w) => String(w.id)));
    if (returnWarehouseId && !allowed.has(String(returnWarehouseId))) {
      setReturnWarehouseId('');
    }
  }, [returnWarehouses, returnWarehouseId]);

  useEffect(() => {
    const allowed = new Set(customerReturnWarehouses.map((w) => String(w.id)));
    if (customerReturnWarehouseId && !allowed.has(String(customerReturnWarehouseId))) {
      setCustomerReturnWarehouseId('');
    }
  }, [customerReturnWarehouses, customerReturnWarehouseId]);

  useEffect(() => {
    if (mode !== MODE_TRANSFER) return;
    // Подсказка: если пользователь пришёл из таблицы остатков с выбранным складом — используем как склад-источник.
    if (!transferFromWarehouseId && inventoryWarehouseId) {
      const wh = ownWarehouses.find((w) => String(w.id) === String(inventoryWarehouseId));
      const whOrg = wh?.organizationId ?? wh?.organization_id;
      if (whOrg != null && String(whOrg) === String(transferOrganizationId || defaultOrganizationId)) {
        setTransferFromWarehouseId(String(inventoryWarehouseId));
      }
    }
  }, [
    mode,
    transferFromWarehouseId,
    inventoryWarehouseId,
    transferOrganizationId,
    defaultOrganizationId,
    ownWarehouses
  ]);

  useEffect(() => {
    if (mode !== MODE_WRITEOFF) return;
    if (!writeoffOrganizationId) {
      if (defaultOrganizationId) setWriteoffOrganizationId(String(defaultOrganizationId));
      else if (singleOrganizationId) setWriteoffOrganizationId(singleOrganizationId);
    }
  }, [mode, writeoffOrganizationId, defaultOrganizationId, singleOrganizationId]);

  useEffect(() => {
    if (mode !== MODE_WRITEOFF) return;
    if (!writeoffWarehouseId) {
      if (inventoryWarehouseId) setWriteoffWarehouseId(String(inventoryWarehouseId));
      else if (singleWarehouseId) setWriteoffWarehouseId(singleWarehouseId);
    }
  }, [mode, writeoffWarehouseId, inventoryWarehouseId, singleWarehouseId]);

  useEffect(() => {
    const allowed = new Set(writeoffWarehouses.map((w) => String(w.id)));
    if (writeoffWarehouseId && !allowed.has(String(writeoffWarehouseId))) {
      setWriteoffWarehouseId('');
    }
  }, [writeoffWarehouses, writeoffWarehouseId]);

  useEffect(() => {
    const allowed = new Set(writeoffFilterWarehouses.map((w) => String(w.id)));
    if (writeoffFilterWhId && !allowed.has(String(writeoffFilterWhId))) {
      setWriteoffFilterWhId('');
    }
  }, [writeoffFilterWarehouses, writeoffFilterWhId]);

  useEffect(() => {
    if (mode !== MODE_TRANSFER) return;
    const allowed = new Set(transferWarehouses.map((w) => String(w.id)));
    if (transferFromWarehouseId && !allowed.has(String(transferFromWarehouseId))) {
      setTransferFromWarehouseId('');
    }
    if (transferToWarehouseId && !allowed.has(String(transferToWarehouseId))) {
      setTransferToWarehouseId('');
    }
  }, [mode, transferWarehouses, transferFromWarehouseId, transferToWarehouseId]);

  const resolveTransferMatches = useCallback(
    async (qq) => {
      const local = findLocalMatches(qq);
      if (local.length > 0) return local;
      if (!transferOrganizationId) return [];
      return searchProductsRemote(qq, transferOrganizationId);
    },
    [findLocalMatches, searchProductsRemote, transferOrganizationId]
  );

  const transferCandidates = useMemo(() => {
    const orgId = String(transferOrganizationId || '').trim();
    const list = (Array.isArray(products) ? products : []).filter((p) => {
      if (!p?.id) return false;
      if (!orgId) return false;
      const pOrg = p.organizationId ?? p.organization_id;
      return pOrg == null || String(pOrg) === orgId;
    });
    return list.map((p) => ({
      id: String(p.id),
      sku: (p.sku || p.article || p.vendorCode || '').toString(),
      name: (p.name || p.title || '—').toString()
    }));
  }, [products, transferOrganizationId]);

  const addTransferItem = () => {
    const pid = String(transferSelectedProductId || '').trim();
    const qty = Number(transferQty);
    if (!pid) return;
    if (!Number.isFinite(qty) || qty <= 0) return;
    const p = transferCandidates.find((x) => x.id === pid);
    const sku = p?.sku || '';
    const name = p?.name || '—';
    setTransferList((prev) => {
      const out = Array.isArray(prev) ? [...prev] : [];
      const idx = out.findIndex((x) => String(x.productId) === pid);
      if (idx >= 0) out[idx] = { ...out[idx], quantity: Number(out[idx].quantity || 0) + qty };
      else out.push({ productId: pid, sku, name, quantity: qty });
      return out;
    });
    setTransferSelectedProductId('');
    setTransferQty(1);
  };

  const addTransferItemFromProduct = useCallback((product, qtyRaw) => {
    if (!product?.id) return;
    const pid = String(product.id);
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const sku = String(product.sku || product.article || product.vendorCode || '').trim();
    const name = String(product.name || product.title || '—').trim();
    setTransferList((prev) => {
      const out = Array.isArray(prev) ? [...prev] : [];
      const idx = out.findIndex((x) => String(x.productId) === pid);
      if (idx >= 0) out[idx] = { ...out[idx], quantity: Number(out[idx].quantity || 0) + qty };
      else out.push({ productId: pid, sku, name, quantity: qty });
      return out;
    });
    if (transferQuickMode) {
      setTransferQty(1);
    }
  }, [transferQuickMode]);

  const removeTransferItem = (pid) => {
    const id = String(pid);
    setTransferList((prev) => (Array.isArray(prev) ? prev.filter((x) => String(x.productId) !== id) : []));
  };

  const submitTransfer = async () => {
    if (opLoading) return;
    if (!transferOrganizationId) {
      setOpMessage('Выберите организацию');
      return;
    }
    const fromId = String(transferFromWarehouseId || '').trim();
    const toId = String(transferToWarehouseId || '').trim();
    if (!fromId || !toId) {
      setOpMessage('Выберите склад-источник и склад-получатель');
      return;
    }
    if (fromId === toId) {
      setOpMessage('Склады должны отличаться');
      return;
    }
    const items = Array.isArray(transferList)
      ? transferList.filter((x) => x && x.productId && Number(x.quantity) > 0)
      : [];
    if (items.length === 0) {
      setOpMessage('Добавьте хотя бы один товар');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      for (const it of items) {
        // eslint-disable-next-line no-await-in-loop
        await stockMovementsApi.transfer(it.productId, {
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          quantity: Number(it.quantity),
          reason: 'Перемещение между складами',
          meta: { ui: 'warehouse_transfer' }
        });
      }
      setTransferList([]);
      const fromLbl = transferWarehouseLabel(transferFromWarehouse);
      const toLbl = transferWarehouseLabel(transferToWarehouse);
      const route =
        fromLbl && toLbl ? `${fromLbl} → ${toLbl}` : '';
      setOpMessage(
        route
          ? `Перемещение выполнено (${items.length} поз.): ${route}`
          : `Перемещение выполнено (${items.length} поз.)`
      );
      onRefresh?.();
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || 'Не удалось выполнить перемещение';
      setOpMessage('Ошибка: ' + String(msg));
    } finally {
      setOpLoading(false);
    }
  };

  const submitTransferScan = useCallback(
    async (e, codeOverride = null) => {
      e?.preventDefault?.();
      if (opLoading) return;
      const raw = String(codeOverride ?? readScanFieldValue(transferScanInputRef.current)).trim();
      if (!raw) return;
      try {
        if (!transferOrganizationId) {
          setOpMessage('Сначала выберите организацию');
          return;
        }
        const p = await lookupProductByAny(raw, {
          title: 'Выберите товар для перемещения',
          allowLinkBarcode: true,
          organizationId: transferOrganizationId,
          useServerSearch: true
        });
        addTransferItemFromProduct(p, transferQuickMode ? 1 : transferQty);
        clearScanField(transferScanInputRef.current);
        setOpMessage(null);
        if (transferQuickMode) setTransferQty(1);
        window.setTimeout(() => transferScanInputRef.current?.focus(), 0);
      } catch (err) {
        const msg = err?.message || 'Товар не найден';
        setOpMessage(String(msg));
        window.setTimeout(() => transferScanInputRef.current?.focus(), 0);
      }
    },
    [
      opLoading,
      transferOrganizationId,
      lookupProductByAny,
      addTransferItemFromProduct,
      transferQty,
      transferQuickMode
    ]
  );

  useEffect(() => {
    return () => {
      if (returnScanDebounceRef.current) clearTimeout(returnScanDebounceRef.current);
      if (customerReturnScanDebounceRef.current) clearTimeout(customerReturnScanDebounceRef.current);
      if (inventoryNewScanDebounceRef.current) clearTimeout(inventoryNewScanDebounceRef.current);
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
      if (manualSearchDebounceRef.current) clearTimeout(manualSearchDebounceRef.current);
      if (transferScanDebounceRef.current) clearTimeout(transferScanDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (addReceiptModalOpen && receiptMode === 'scan' && receiptWarehouseId) {
      const t = setTimeout(() => scanInputRef.current?.focus(), 150);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [addReceiptModalOpen, receiptMode, receiptWarehouseId]);

  useEffect(() => {
    return () => {
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
    };
  }, []);

  const loadInventorySessions = useCallback(() => {
    setInventorySessionsLoading(true);
    inventorySessionsApi
      .list({ limit: 200 })
      .then((data) => setInventorySessionsList(Array.isArray(data) ? data : []))
      .catch(() => setInventorySessionsList([]))
      .finally(() => setInventorySessionsLoading(false));
  }, []);

  useEffect(() => {
    if (mode === MODE_INVENTORY && !inventoryNewSession) {
      loadInventorySessions();
    }
  }, [mode, inventoryNewSession, loadInventorySessions]);

  useEffect(() => {
    if (mode !== MODE_INVENTORY) {
      setInventoryNewSession(false);
      setInventoryNewRows([]);
      clearScanField(inventoryNewScanInputRef.current);
      setInventoryNewSearch('');
      setInventoryNewPickedProduct(null);
      setInventoryDetailView(null);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== MODE_INVENTORY || !inventoryNewSession) return;
    const t = setTimeout(() => inventoryNewScanInputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [mode, inventoryNewSession]);

  const returnSupplierProducts = useMemo(() => products || [], [products]);

  const pickListProduct = useCallback((product, { setProduct, setSearch, setId }) => {
    if (!product?.id) return;
    setProduct(product);
    setId(String(product.id));
    setSearch(formatProductOptionLabel(product));
  }, []);

  useEffect(() => {
    if (!addReceiptModalOpen) {
      setReceiptListSearch('');
      setReceiptPickedProduct(null);
      setSelectedProductId('');
    }
  }, [addReceiptModalOpen]);

  const applySessionStateToList = useCallback((sessionData) => {
    const d = sessionData?.data ?? sessionData;
    const items = Array.isArray(d?.items) ? d.items : [];
    const ownerIdRaw = d?.ownerUserId ?? d?.owner_user_id ?? null;
    const ownerId =
      ownerIdRaw != null && ownerIdRaw !== '' && Number.isFinite(Number(ownerIdRaw)) ? Number(ownerIdRaw) : null;
    const widRaw = d?.warehouseId ?? d?.warehouse_id ?? null;
    if (widRaw != null && widRaw !== '') {
      setReceiptWarehouseId(String(widRaw));
    }
    setReceiptSessionOwnerUserId(ownerId);
    setReceiptList(
      items.map((it) => ({
        productId: it.productId,
        sku: it.sku || '—',
        name: it.name || 'Без названия',
        quantity: Number(it.quantity) || 0,
        cost: it.cost ?? ''
      }))
    );
  }, []);

  const currentUserId = useMemo(() => {
    const raw = user?.id ?? user?.userId ?? null;
    if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return null;
    return Number(raw);
  }, [user?.id, user?.userId]);

  const isReceiptSessionGuest = useMemo(() => {
    if (!receiptSessionEnabled || !String(receiptSessionId || '').trim()) return false;
    if (receiptSessionOwnerUserId == null || currentUserId == null) return false;
    return Number(receiptSessionOwnerUserId) !== Number(currentUserId);
  }, [receiptSessionEnabled, receiptSessionId, receiptSessionOwnerUserId, currentUserId]);

  const isInventoryLiveGuest = useMemo(() => {
    if (!inventoryLiveEnabled || !String(inventoryLiveSessionId || '').trim()) return false;
    if (inventoryLiveOwnerUserId == null || currentUserId == null) return false;
    return Number(inventoryLiveOwnerUserId) !== Number(currentUserId);
  }, [inventoryLiveEnabled, inventoryLiveSessionId, inventoryLiveOwnerUserId, currentUserId]);

  const applyInventoryLiveStateToRows = useCallback((sessionData) => {
    const d = sessionData?.data ?? sessionData;
    const items = Array.isArray(d?.items) ? d.items : [];
    const ownerIdRaw = d?.ownerUserId ?? d?.owner_user_id ?? null;
    const ownerId =
      ownerIdRaw != null && ownerIdRaw !== '' && Number.isFinite(Number(ownerIdRaw)) ? Number(ownerIdRaw) : null;
    const widRaw = d?.warehouseId ?? d?.warehouse_id ?? null;
    if (widRaw != null && widRaw !== '') {
      setInventorySessionWarehouseId(String(widRaw));
    }
    if (d?.zeroUnlisted === false) {
      setInventoryZeroUnlisted(false);
    } else if (d?.zeroUnlisted === true) {
      setInventoryZeroUnlisted(true);
    }
    setInventoryLiveOwnerUserId(ownerId);
    const editSidRaw = d?.editingSessionId ?? d?.editing_session_id ?? null;
    const meRaw = user?.id ?? user?.userId ?? null;
    const me =
      meRaw != null && meRaw !== '' && Number.isFinite(Number(meRaw)) ? Number(meRaw) : null;
    const isGuest =
      ownerId != null && me != null && Number(ownerId) !== Number(me);
    if (
      !isGuest &&
      editSidRaw != null &&
      editSidRaw !== '' &&
      Number.isFinite(Number(editSidRaw))
    ) {
      setInventoryEditingSessionId(Number(editSidRaw));
    }
    setInventoryNewRows(
      sortInventoryNewRows(
        items.map((it) => {
          const scanAt =
            me != null && it.scanAtByUser && it.scanAtByUser[String(me)] != null
              ? Number(it.scanAtByUser[String(me)])
              : null;
          return {
            product: {
              id: it.productId,
              sku: it.sku || '—',
              name: it.name || 'Без названия',
              cost: it.cost,
            },
            current: Math.max(0, Number(it.current) || 0),
            fact: Math.max(0, Number(it.fact) || 0),
            scannedAt: Number.isFinite(scanAt) && scanAt > 0 ? scanAt : null,
          };
        })
      )
    );
  }, [user?.id, user?.userId]);

  const leaveInventoryLiveSession = useCallback((clearDraft = true) => {
    setInventoryLiveEnabled(false);
    setInventoryLiveSessionId('');
    setInventoryLiveOwnerUserId(null);
    syncInventoryLiveSessionInUrl('');
    if (clearDraft) {
      clearInventoryLiveDraft();
      setInventoryLiveDraft(null);
    }
  }, []);

  const startInventoryLiveSession = useCallback(async () => {
    if (!inventorySessionWarehouseId) {
      setLookupError('Сначала выберите склад инвентаризации');
      return false;
    }
    setLookupError(null);
    setOpMessage(null);
    try {
      const items = inventoryNewRows.map((r) => ({
        productId: r.product?.id,
        sku: r.product?.sku,
        name: r.product?.name,
        fact: r.fact,
        current: r.current,
        cost: r.product?.cost,
      }));
      const created = await inventorySessionsApi.createSession({
        warehouseId: Number(inventorySessionWarehouseId),
        zeroUnlisted: inventoryZeroUnlisted,
        items,
        editingSessionId: inventoryEditingSessionId || undefined,
      });
      const d = created?.data ?? created;
      const sid = String(d?.sessionId || '').trim();
      if (!sid) {
        setLookupError('Сервер не вернул код сессии');
        return false;
      }
      setInventoryLiveEnabled(true);
      setInventoryLiveSessionId(sid);
      applyInventoryLiveStateToRows(created);
      syncInventoryLiveSessionInUrl(sid);
      const draft = {
        liveSessionId: sid,
        editingSessionId: inventoryEditingSessionId || d?.editingSessionId || null,
        warehouseId: inventorySessionWarehouseId,
      };
      writeInventoryLiveDraft(draft);
      setInventoryLiveDraft(draft);
      return true;
    } catch (ex) {
      setLookupError(
        ex.response?.data?.message || ex.message || 'Не удалось создать общую инвентаризацию'
      );
      return false;
    }
  }, [
    inventorySessionWarehouseId,
    inventoryZeroUnlisted,
    inventoryNewRows,
    inventoryEditingSessionId,
    applyInventoryLiveStateToRows,
  ]);

  const joinInventoryLiveSessionFromUrl = useCallback(
    async (sid) => {
      const sessionId = String(sid || '').trim();
      if (!sessionId) return;
      setInventoryNewSession(true);
      setInventoryLiveEnabled(true);
      setInventoryLiveSessionId(sessionId);
      setLookupError(null);
      setMode(MODE_INVENTORY);
      try {
        const res = await inventorySessionsApi.getSession(sessionId);
        applyInventoryLiveStateToRows(res);
      } catch (ex) {
        setLookupError(
          ex?.response?.data?.message || ex?.message || 'Сессия инвентаризации не найдена или истекла'
        );
        leaveInventoryLiveSession();
      }
    },
    [applyInventoryLiveStateToRows, leaveInventoryLiveSession]
  );

  const receiptWarehouseLabel = useMemo(() => {
    if (!receiptWarehouseId) return '';
    const w = ownWarehouses.find((x) => String(x.id) === String(receiptWarehouseId));
    return warehouseDisplayLabel(w, receiptWarehouseId);
  }, [receiptWarehouseId, ownWarehouses]);

  const openAddReceiptModal = useCallback(() => {
    setReceiptList([]);
    setOpMessage(null);
    setLookupError(null);
    if (!receiptWarehouseId) {
      const preferred = inventoryWarehouseId ? String(inventoryWarehouseId) : singleWarehouseId;
      if (preferred) setReceiptWarehouseId(preferred);
    }
    applySingleOrgWarehouseDefaults({
      singleOrganizationId,
      organizationId: receiptOrganizationId,
      setOrganizationId: setReceiptOrganizationId,
    });
    setAddReceiptModalOpen(true);
  }, [
    receiptWarehouseId,
    inventoryWarehouseId,
    singleWarehouseId,
    singleOrganizationId,
    receiptOrganizationId,
  ]);

  const joinReceiptSessionFromUrl = useCallback(
    async (sid) => {
      const sessionId = String(sid || '').trim();
      if (!sessionId) return;
      setAddReceiptModalOpen(true);
      setReceiptSessionEnabled(true);
      setReceiptSessionId(sessionId);
      setReceiptMode('scan');
      setLookupError(null);
      try {
        const res = await receiptsApi.getSession(sessionId);
        applySessionStateToList(res);
      } catch (ex) {
        setLookupError(
          ex?.response?.data?.message || ex?.message || 'Сессия приёмки не найдена или истекла'
        );
        setReceiptSessionEnabled(false);
        setReceiptSessionId('');
      }
    },
    [applySessionStateToList]
  );

  // Если пришли по ссылке сессии (?session=) — подхватываем при каждом изменении URL (в т.ч. из уведомления).
  useEffect(() => {
    const sp = new URLSearchParams(location.search || '');
    const sid = String(sp.get('session') || '').trim();
    if (!sid) return;
    joinReceiptSessionFromUrl(sid);
  }, [location.search, joinReceiptSessionFromUrl]);

  useEffect(() => {
    const sp = new URLSearchParams(location.search || '');
    const invSid = String(sp.get('inv_session') || '').trim();
    if (!invSid) return;
    joinInventoryLiveSessionFromUrl(invSid);
  }, [location.search, joinInventoryLiveSessionFromUrl]);

  useEffect(() => {
    if (!inventoryNewSession || !inventoryLiveEnabled) return undefined;
    const sid = String(inventoryLiveSessionId || '').trim();
    if (!sid) return undefined;
    let mounted = true;
    const t = setInterval(() => {
      if (!mounted || inventoryScanBusyRef.current) return;
      inventorySessionsApi.getSession(sid).then(applyInventoryLiveStateToRows).catch(() => {});
    }, 1200);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [inventoryNewSession, inventoryLiveEnabled, inventoryLiveSessionId, applyInventoryLiveStateToRows]);

  useEffect(() => {
    if (mode !== MODE_INVENTORY || inventoryNewSession) return;
    setInventoryLiveDraft(readInventoryLiveDraft());
  }, [mode, inventoryNewSession]);

  useEffect(() => {
    if (!inventoryNewSession || isInventoryLiveGuest) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await usersApi.getInviteCandidates();
        const rows = res?.data ?? [];
        const meIdRaw = user?.id ?? user?.userId ?? null;
        const meId =
          meIdRaw != null && meIdRaw !== '' && Number.isFinite(Number(meIdRaw)) ? Number(meIdRaw) : null;
        const meEmail = user?.email ? String(user.email).trim().toLowerCase() : null;
        if (cancelled) return;
        const filtered = (Array.isArray(rows) ? rows : []).filter((u) => {
          if (!u) return false;
          const uidRaw = u.id ?? u.user_id ?? u.userId ?? null;
          const uid = uidRaw != null && uidRaw !== '' && Number.isFinite(Number(uidRaw)) ? Number(uidRaw) : null;
          if (meId != null && uid != null && uid === meId) return false;
          const em = u.email ? String(u.email).trim().toLowerCase() : null;
          if (meEmail && em && em === meEmail) return false;
          return true;
        });
        setInviteUsers(filtered);
      } catch {
        if (!cancelled) setInviteUsers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inventoryNewSession, isInventoryLiveGuest, user?.id, user?.userId, user?.email]);

  // Подтягиваем состояние сессии периодически (чтобы видеть сканы с других устройств).
  useEffect(() => {
    if (!addReceiptModalOpen) return undefined;
    if (!receiptSessionEnabled) return undefined;
    const sid = String(receiptSessionId || '').trim();
    if (!sid) return undefined;
    let mounted = true;
    const t = setInterval(() => {
      if (!mounted) return;
      receiptsApi.getSession(sid).then(applySessionStateToList).catch(() => {});
    }, 1200);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [addReceiptModalOpen, receiptSessionEnabled, receiptSessionId, applySessionStateToList]);

  // Пользователи для приглашения (в рамках профиля): загружаем, когда открыта модалка и включена общая приёмка.
  useEffect(() => {
    if (!addReceiptModalOpen) return;
    if (!receiptSessionEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await usersApi.getInviteCandidates();
        const rows = res?.data ?? [];
        const meIdRaw = user?.id ?? user?.userId ?? null;
        const meId =
          meIdRaw != null && meIdRaw !== '' && Number.isFinite(Number(meIdRaw)) ? Number(meIdRaw) : null;
        const meEmail = user?.email ? String(user.email).trim().toLowerCase() : null;
        if (cancelled) return;
        const filtered = (Array.isArray(rows) ? rows : []).filter((u) => {
          if (!u) return false;
          const uidRaw = u.id ?? u.user_id ?? u.userId ?? null;
          const uid = uidRaw != null && uidRaw !== '' && Number.isFinite(Number(uidRaw)) ? Number(uidRaw) : null;
          if (meId != null && uid != null && uid === meId) return false;
          const em = u.email ? String(u.email).trim().toLowerCase() : null;
          if (meEmail && em && em === meEmail) return false;
          return true;
        });
        setInviteUsers(filtered);
      } catch {
        if (!cancelled) setInviteUsers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addReceiptModalOpen, receiptSessionEnabled, user?.id, user?.userId, user?.email]);

  useEffect(() => {
    if (!RECEIPT_DOCUMENT_TYPE_BY_MODE[mode]) return;
    loadReceiptsList(mode);
  }, [mode, loadReceiptsList]);

  useEffect(() => {
    if (openReceiptId == null || !openReceiptId) return;
    receiptsApi.getById(openReceiptId)
      .then(res => {
        const data = res?.data ?? res;
        if (data) setReceiptDetail(data);
      })
      .catch(() => {});
  }, [openReceiptId]);

  const lookupByBarcodeOrSku = async (value) => {
    setLookupError(null);
    setFoundProduct(null);
    try {
      const product = await lookupProductByAny(value, { title: 'Выберите товар для операции' });
      if (product && (product.id || product.sku)) {
        setFoundProduct(product);
        setQtyInput(1);
      } else {
        setLookupError('Товар не найден');
      }
    } catch (e) {
      setLookupError(e?.message || 'Ошибка поиска');
    }
  };

  const handleScanSubmit = (e) => {
    e.preventDefault();
    if (mode === MODE_RECEIPT && receiptMode === 'scan') {
      return;
    }
    if (mode === MODE_WRITEOFF) {
      if (writeoffSuppressScanRef.current) return;
      lookupByBarcodeOrSkuThenWriteoffOne(readScanFieldValue(writeoffScanInputRef.current));
      return;
    }
    lookupByBarcodeOrSku(readScanFieldValue(scanInputRef.current));
  };

  /** Добавить товар в список для поступления (объединяем по productId) */
  const addToReceiptList = (product, qty) => {
    const add = Math.max(1, parseInt(qty, 10) || 1);
    const id = product.id;
    setReceiptList(prev => {
      const existing = prev.find(item => String(item.productId) === String(id));
      if (existing) {
        return prev.map(item =>
          String(item.productId) === String(id)
            ? { ...item, quantity: item.quantity + add }
            : item
        );
      }
      const pc = product?.cost;
      const defaultCost =
        pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : '';
      return [...prev, {
        productId: id,
        sku: product.sku || '—',
        name: product.name || 'Без названия',
        quantity: add,
        cost: defaultCost
      }];
    });
  };

  /** Установить количество в списке поступления (режим «коробкой»). */
  const setReceiptListProductQty = (product, qty) => {
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const id = product.id;
    setReceiptList((prev) => {
      const existing = prev.find((item) => String(item.productId) === String(id));
      if (existing) {
        return prev.map((item) =>
          String(item.productId) === String(id) ? { ...item, quantity: n } : item
        );
      }
      const pc = product?.cost;
      const defaultCost =
        pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : '';
      return [
        ...prev,
        {
          productId: id,
          sku: product.sku || '—',
          name: product.name || 'Без названия',
          quantity: n,
          cost: defaultCost,
        },
      ];
    });
  };

  const setReceiptSessionProductQty = async (product, qty) => {
    const sid = String(receiptSessionId || '').trim();
    if (!sid) return;
    const n = Math.max(1, parseInt(qty, 10) || 1);
    const pid = Number(product?.id);
    const existing = receiptList.find((item) => String(item.productId) === String(pid));
    const current = existing ? Math.max(0, parseInt(existing.quantity, 10) || 0) : 0;
    const delta = n - current;
    if (delta === 0) return;
    const pc = product?.cost;
    const defaultCost =
      pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : null;
    const res = await receiptsApi.addSessionQuantity(sid, {
      code: String(product?.id || ''),
      quantity: delta,
      cost: defaultCost,
    });
    applySessionStateToList(res);
  };

  const addToReceiptSession = async (product, qty) => {
    const sid = String(receiptSessionId || '').trim();
    if (!sid) return;
    const add = Math.max(1, parseInt(qty, 10) || 1);
    const pc = product?.cost;
    const defaultCost =
      pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : null;
    const res = await receiptsApi.addSessionQuantity(sid, {
      code: String(product?.id || ''),
      quantity: add,
      cost: defaultCost
    });
    applySessionStateToList(res);
  };

  /** Поступление по скану: 1 скан = +1 шт в список (без сохранения в БД) */
  const lookupByBarcodeOrSkuThenReceiptOne = async (value) => {
    const v = normalizeScanInput(value);
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    if (!receiptWarehouseId) {
      setLookupError('Сначала выберите склад приёмки');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для поступления', allowLinkBarcode: true });
      lastReceiptScannedProductRef.current = product?.id ?? null;
      if (receiptSessionEnabled && String(receiptSessionId || '').trim()) {
        await addToReceiptSession(product, 1);
      } else {
      addToReceiptList(product, 1);
      }
      setOpMessage(`В список: +1 шт — ${product.name || product.sku}`);
      playEventSound(SOUND_EVENTS.scan_ok);
      clearScanField(scanInputRef.current);
      scanInputRef.current?.focus();
    } catch (e) {
      const msg = e?.message || 'поиск не удался';
      setLookupError(msg);
      setOpMessage('Ошибка: ' + msg);
      playEventSound(SOUND_EVENTS.scan_error);
    }
  };

  /** Добавить выбранный товар в список поступления (из списка) */
  const handleReceiptFromList = () => {
    if (!receiptWarehouseId) {
      setOpMessage('Выберите склад приёмки');
      return;
    }
    const product =
      receiptPickedProduct ||
      products.find((p) => String(p.id) === String(selectedProductId || '').trim());
    if (!product?.id) {
      setOpMessage('Выберите товар из подсказок поиска');
      return;
    }
    const add = Math.max(1, parseInt(listQty, 10) || 1);
    if (receiptSessionEnabled && String(receiptSessionId || '').trim()) {
      addToReceiptSession(product, add)
        .then(() => setOpMessage(`В список: ${product.name} — ${add} шт`))
        .catch((ex) => setOpMessage('Ошибка: ' + (ex?.message || 'не удалось добавить')));
    } else {
    addToReceiptList(product, add);
    setOpMessage(`В список: ${product.name} — ${add} шт`);
    }
    setReceiptPickedProduct(null);
    setSelectedProductId('');
    setReceiptListSearch('');
  };

  /** Удалить позицию из списка поступления */
  const removeFromReceiptList = (index) => {
    setReceiptList(prev => prev.filter((_, i) => i !== index));
  };

  const updateReceiptQuantity = (index, value) => {
    const num = parseInt(value, 10);
    const qty = isNaN(num) || num < 1 ? 1 : num;
    setReceiptList(prev =>
      prev.map((item, i) => (i === index ? { ...item, quantity: qty } : item))
    );
  };

  const updateReceiptCost = (index, value) => {
    setReceiptList(prev =>
      prev.map((item, i) => (i === index ? { ...item, cost: value } : item))
    );
  };

  /** Оформить поступление: создать приёмку (организация, поставщик, строки), движения остатков, обновить себестоимость товаров */
  const applyReceiptList = async () => {
    if (receiptList.length === 0) {
      setOpMessage('Список пуст');
      return;
    }
    if (!receiptWarehouseId) {
      setOpMessage('Выберите склад приёмки');
      return;
    }
    if (!String(receiptOrganizationId || '').trim()) {
      setOpMessage('Выберите организацию');
      return;
    }
    if (!String(receiptSupplierId || '').trim()) {
      setOpMessage('Выберите поставщика');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      const organizationId = receiptOrganizationId ? Number(receiptOrganizationId) : null;
      const supplierId = receiptSupplierId ? Number(receiptSupplierId) : null;
      if (receiptSessionEnabled && String(receiptSessionId || '').trim()) {
        const meIdRaw = user?.id ?? user?.userId ?? null;
        const meId =
          meIdRaw != null && meIdRaw !== '' && Number.isFinite(Number(meIdRaw)) ? Number(meIdRaw) : null;
        if (receiptSessionOwnerUserId != null && meId != null && Number(receiptSessionOwnerUserId) !== Number(meId)) {
          setOpLoading(false);
          setLookupError('Оформить общую приёмку может только пользователь, который её создал.');
          return;
        }
        const r = await receiptsApi.completeSession(String(receiptSessionId || '').trim(), {
          organizationId,
          supplierId
        });
        const receiptNumber = r?.data?.receipt?.receipt_number || '';
        setOpMessage(receiptNumber ? `Приёмка ${receiptNumber} оформлена` : 'Поступление оформлено');
        setReceiptList([]);
        setReceiptSessionEnabled(false);
        setReceiptSessionId('');
        setReceiptSessionOwnerUserId(null);
        onRefresh?.();
        if (addReceiptModalOpen) {
          setAddReceiptModalOpen(false);
          setOpMessage(null);
          loadReceiptsList();
        } else {
          setMode(MODE_RECEIPTS_LIST);
        }
        return;
      }
      const lines = receiptList.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        cost: item.cost !== '' && item.cost != null ? parseFloat(String(item.cost).replace(',', '.')) : null
      }));
      const res = await receiptsApi.create({
        organizationId,
        supplierId,
        warehouseId: Number(receiptWarehouseId),
        lines
      });
      const receiptNumber = res?.data?.receipt?.receipt_number || '';
      setOpMessage(receiptNumber ? `Приёмка ${receiptNumber} оформлена` : 'Поступление оформлено');
      setReceiptList([]);
      onRefresh?.();
      if (addReceiptModalOpen) {
        setAddReceiptModalOpen(false);
        setOpMessage(null);
        loadReceiptsList();
      } else {
        setMode(MODE_RECEIPTS_LIST);
      }
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось оформить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearReceiptList = () => {
    setReceiptList([]);
    setOpMessage('Список очищен');
  };

  const openReceiptEdit = () => {
    if (!receiptDetail?.id) return;
    if (
      receiptDetail.purchase_receipt_id &&
      String(receiptDetail.purchase_receipt_status) === 'scanning'
    ) {
      setOpMessage('Приёмка в процессе сканирования — редактируйте в разделе «Закупки»');
      return;
    }
    setReceiptEditForm({
      id: receiptDetail.id,
      documentType: receiptDetail.document_type || 'receipt',
      organizationId: receiptDetail.organization_id != null ? String(receiptDetail.organization_id) : '',
      supplierId: receiptDetail.supplier_id != null ? String(receiptDetail.supplier_id) : '',
      warehouseId:
        receiptDetail.warehouse_id != null
          ? String(receiptDetail.warehouse_id)
          : String(receiptWarehouseId || singleWarehouseId || ''),
      lines: (receiptDetail.lines || []).map((line) => ({
        lineId: line.id,
        productId: line.product_id,
        sku: line.product_sku,
        name: line.product_name,
        quantity: Math.max(1, parseInt(line.quantity, 10) || 1),
        cost: line.cost != null ? String(line.cost) : '',
      })),
    });
    setReceiptEditOpen(true);
  };

  const updateReceiptEditLine = (index, field, value) => {
    setReceiptEditForm((prev) => {
      if (!prev?.lines) return prev;
      const lines = prev.lines.map((line, i) => {
        if (i !== index) return line;
        if (field === 'quantity') {
          const n = parseInt(value, 10);
          return { ...line, quantity: Number.isNaN(n) || n < 1 ? 1 : n };
        }
        return { ...line, [field]: value };
      });
      return { ...prev, lines };
    });
  };

  const removeReceiptEditLine = (index) => {
    setReceiptEditForm((prev) => {
      if (!prev?.lines) return prev;
      return { ...prev, lines: prev.lines.filter((_, i) => i !== index) };
    });
  };

  const saveReceiptEdit = async () => {
    const form = receiptEditForm;
    if (!form?.id) return;
    if (!String(form.warehouseId || '').trim()) {
      setOpMessage('Выберите склад');
      return;
    }
    if (!String(form.organizationId || '').trim()) {
      setOpMessage('Выберите организацию');
      return;
    }
    if (form.documentType !== 'customer_return' && !String(form.supplierId || '').trim()) {
      setOpMessage('Выберите поставщика');
      return;
    }
    if (!form.lines?.length) {
      setOpMessage('Добавьте хотя бы одну позицию');
      return;
    }
    setReceiptEditSaving(true);
    setOpMessage(null);
    try {
      const payload = {
        organizationId: Number(form.organizationId),
        warehouseId: Number(form.warehouseId),
        lines: form.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          ...(form.documentType !== 'return' && line.cost !== ''
            ? { cost: parseFloat(String(line.cost).replace(',', '.')) }
            : {}),
        })),
      };
      if (form.documentType !== 'customer_return') {
        payload.supplierId = Number(form.supplierId);
      }
      const res = await receiptsApi.update(form.id, payload);
      const updated = res?.data ?? res;
      setReceiptEditOpen(false);
      setReceiptEditForm(null);
      setReceiptDetail(updated);
      setOpMessage('Документ сохранён');
      loadReceiptsList();
      onRefresh?.();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось сохранить'));
    } finally {
      setReceiptEditSaving(false);
    }
  };

  const handleInventorySessionWarehouseChange = (e) => {
    const v = e.target.value;
    if (inventoryNewRows.length > 0 && v !== inventorySessionWarehouseId) {
      setInventoryNewRows([]);
      setOpMessage('Список пересчёта очищен: изменён склад.');
    }
    setInventorySessionWarehouseId(v);
    if (v && typeof reloadProductsWithWarehouse === 'function') {
      reloadProductsWithWarehouse(v);
    }
  };

  /** Скан поступления: только по завершённому вводу, без re-render на каждый символ */
  const handleReceiptScan = useCallback(
    (code) => {
      setLookupError(null);
      setOpMessage('Поиск товара…');
      lookupByBarcodeOrSkuThenReceiptOne(code);
      scanInputRef.current?.focus();
    },
    [lookupByBarcodeOrSkuThenReceiptOne]
  );

  const handleWriteoffManualQuery = useCallback(
    async (qq) => {
      if (qq.length < 2) {
        if (suggestContext === 'writeoff_scan') closeSuggest();
        return;
      }
      let matches = findLocalMatches(qq);
      const remote = await searchProductsRemote(qq, { limit: 40 });
      matches = mergeProductLists(matches, remote);
      if (matches.length === 0) {
        if (suggestContext === 'writeoff_scan') closeSuggest();
        return;
      }
      openSuggest('writeoff_scan', 'Выберите товар', matches, async (p) => {
        if (!p) return;
        writeoffSuppressScanRef.current = true;
        clearScanField(writeoffScanInputRef.current);
        const added = await addToWriteoffList(p, 1);
        if (added > 0) {
          setLookupError(null);
          setOpMessage(`В список списания: ${p.name || p.sku} — 1 шт`);
          playEventSound(SOUND_EVENTS.scan_ok);
        } else {
          setOpMessage(null);
          setLookupError('Нет остатка на выбранном складе');
        }
        window.setTimeout(() => {
          writeoffSuppressScanRef.current = false;
          writeoffScanInputRef.current?.focus();
        }, 500);
      });
    },
    [findLocalMatches, suggestContext, closeSuggest, openSuggest]
  );

  const lookupByBarcodeOrSkuThenWriteoffOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    if (shouldIgnoreDuplicateWarehouseScan(writeoffScanDedupRef, v)) return;
    if (!writeoffWarehouseId) {
      setLookupError('Сначала выберите склад списания');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для списания' });
      const added = await addToWriteoffList(product, 1);
      if (added < 1) {
        setOpMessage(null);
        setLookupError('Нет остатка на выбранном складе');
        playEventSound(SOUND_EVENTS.scan_error);
        return;
      }
      setLookupError(null);
      setOpMessage(`В список списания: +1 шт — ${product.name || product.sku}`);
      playEventSound(SOUND_EVENTS.scan_ok);
      clearScanField(writeoffScanInputRef.current);
      writeoffScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage(null);
      setLookupError(e.message || 'поиск не удался');
      playEventSound(SOUND_EVENTS.scan_error);
    }
  };

  const handleWriteoffScan = useCallback(
    (code) => {
      if (writeoffSuppressScanRef.current) return;
      setLookupError(null);
      lookupByBarcodeOrSkuThenWriteoffOne(code);
      writeoffScanInputRef.current?.focus();
    },
    [lookupByBarcodeOrSkuThenWriteoffOne]
  );

  const applyWarehouseReceiptBoxQty = useCallback(
    async ({ product = null, code = null, qty } = {}) => {
      if (!receiptWarehouseId) {
        setLookupError('Сначала выберите склад приёмки');
        playEventSound(SOUND_EVENTS.scan_error);
        return;
      }
      const n = Math.floor(Number(qty) || 0);
      if (n <= 0 || boxAddBusy) return;

      try {
        setBoxAddBusy(true);
        setLookupError(null);
        let resolved = product;
        if (!resolved?.id && code) {
          const normalized = normalizeScanInput(String(code).trim());
          if (!normalized) return;
          resolved = await lookupProductByAny(normalized, {
            title: 'Выберите товар для поступления',
            allowLinkBarcode: true,
          });
        }
        if (!resolved?.id) return;

        if (receiptSessionEnabled && String(receiptSessionId || '').trim()) {
          await setReceiptSessionProductQty(resolved, n);
        } else {
          setReceiptListProductQty(resolved, n);
        }
        lastReceiptScannedProductRef.current = resolved.id;
        setOpMessage(`В список: ${n} шт — ${resolved.name || resolved.sku}`);
        playEventSound(SOUND_EVENTS.scan_ok);
        setBoxAddCode('');
        setBoxAddQty('');
      } catch (ex) {
        const msg = ex?.message || 'поиск не удался';
        setLookupError(msg);
        setOpMessage('Ошибка: ' + msg);
        playEventSound(SOUND_EVENTS.scan_error);
      } finally {
        setBoxAddBusy(false);
        scanInputRef.current?.focus();
      }
    },
    [
      addToReceiptList,
      boxAddBusy,
      products,
      receiptList,
      receiptSessionEnabled,
      receiptSessionId,
      receiptWarehouseId,
      setReceiptListProductQty,
      setReceiptSessionProductQty,
    ]
  );

  const scheduleWarehouseBoxQtyApply = useCallback(
    (qtyStr, codeStr) => {
      if (boxQtyDebounceRef.current) clearTimeout(boxQtyDebounceRef.current);
      boxQtyDebounceRef.current = setTimeout(() => {
        boxQtyDebounceRef.current = null;
        const qty = Math.floor(Number(qtyStr) || 0);
        if (qty <= 0) return;
        const code = normalizeScanInput(String(codeStr || '').trim());
        if (code) {
          void applyWarehouseReceiptBoxQty({ code, qty });
          return;
        }
        const lastPid = lastReceiptScannedProductRef.current;
        if (lastPid != null) {
          const fromList = (products || []).find((p) => String(p.id) === String(lastPid));
          if (fromList) {
            void applyWarehouseReceiptBoxQty({ product: fromList, qty });
          }
        }
      }, BOX_QTY_APPLY_MS);
    },
    [applyWarehouseReceiptBoxQty]
  );

  const warehouseQtyForProduct = async (product, warehouseId) => {
    if (!product?.id) return 0;
    const wid = warehouseId != null && String(warehouseId).trim() !== '' ? String(warehouseId) : '';
    if (!wid) return 0;
    const fromList =
      product?.quantity != null &&
      String(product.quantity_warehouse_id ?? product.quantityWarehouseId ?? '') === wid
        ? Math.max(0, Number(product.quantity) || 0)
        : 0;
    try {
      const data = await stockMovementsApi.getWarehouseStock(product.id, wid);
      const apiQty = Math.max(0, Number(data?.quantity) || 0);
      return Math.max(apiQty, fromList);
    } catch {
      return fromList;
    }
  };

  /** Добавить товар в список списания (qty ограничено остатком на выбранном складе). Возвращает добавленное кол-во или 0. */
  const addToWriteoffList = async (product, add) => {
    if (!writeoffWarehouseId) return 0;
    const maxQty = await warehouseQtyForProduct(product, writeoffWarehouseId);
    if (maxQty < 1) return 0;
    const qty = Math.min(Math.max(1, parseInt(add, 10) || 1), maxQty);
    if (qty < 1) return 0;
    const id = product.id;
    const pc = product?.cost;
    const defaultCost =
      pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : null;
    setWriteoffList((prev) => {
      const existing = prev.find((item) => String(item.productId) === String(id));
      if (existing) {
        const newQty = Math.min(existing.quantity + qty, maxQty);
        if (newQty <= 0) return prev;
        return prev.map((item) =>
          String(item.productId) === String(id)
            ? { ...item, quantity: newQty, warehouseMaxQty: maxQty }
            : item
        );
      }
      return [
        ...prev,
        {
          productId: id,
          sku: product.sku || '—',
          name: product.name || 'Без названия',
          quantity: qty,
          warehouseMaxQty: maxQty,
          cost: defaultCost,
        },
      ];
    });
    return qty;
  };

  const removeFromWriteoffList = (index) => {
    setWriteoffList((prev) => prev.filter((_, i) => i !== index));
  };

  const updateWriteoffQuantity = (index, value) => {
    const num = parseInt(value, 10);
    const item = writeoffList[index];
    if (!item) return;
    const maxQty = Math.max(0, Number(item.warehouseMaxQty) || 0);
    const qty = Math.min(isNaN(num) || num < 1 ? 1 : num, maxQty || 1);
    setWriteoffList((prev) =>
      prev.map((it, i) => (i === index ? { ...it, quantity: qty } : it))
    );
  };

  const writeoffListTotals = useMemo(() => {
    let units = 0;
    let sumRub = 0;
    for (const item of writeoffList) {
      const q = Math.max(0, Number(item.quantity) || 0);
      units += q;
      const cost = item.cost != null && item.cost !== '' ? Number(item.cost) : null;
      if (cost != null && Number.isFinite(cost)) sumRub += q * cost;
    }
    return { units, sumRub };
  }, [writeoffList]);

  const applyWriteoffDocument = async () => {
    if (writeoffList.length === 0) {
      setOpMessage('Список пуст');
      return;
    }
    if (!writeoffOrganizationId) {
      setOpMessage('Выберите организацию');
      return;
    }
    if (!writeoffWarehouseId) {
      setOpMessage('Выберите склад списания');
      return;
    }
    if (!writeoffReason) {
      setOpMessage('Выберите причину списания');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      const lines = [];
      for (const l of writeoffList) {
        const pid = Number(l.productId);
        if (!Number.isFinite(pid) || pid < 1) continue;
        const product =
          products.find((p) => Number(p.id) === pid) || {
            id: pid,
            sku: l.sku,
            name: l.name,
          };
        const maxQty = await warehouseQtyForProduct(product, writeoffWarehouseId);
        if (maxQty < 1) continue;
        const qty = Math.min(Math.max(1, parseInt(l.quantity, 10) || 1), maxQty);
        lines.push({ productId: pid, quantity: qty });
      }
      if (lines.length === 0) {
        setOpMessage(
          'Нет позиций с остатком на выбранном складе — добавьте товары по скану или из списка'
        );
        setOpLoading(false);
        return;
      }
      const res = await receiptsApi.create({
        documentType: 'writeoff',
        organizationId: Number(writeoffOrganizationId),
        warehouseId: Number(writeoffWarehouseId),
        writeoffReason,
        lines,
      });
      const receiptNumber = res?.data?.receipt?.receipt_number || '';
      setOpMessage(receiptNumber ? `Документ списания ${receiptNumber} оформлен` : 'Списание оформлено');
      playEventSound(SOUND_EVENTS.success);
      setWriteoffList([]);
      onRefresh?.();
      loadReceiptsList(MODE_WRITEOFF);
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось оформить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearWriteoffList = () => {
    setWriteoffList([]);
    setOpMessage('Список очищен');
  };

  /** Добавить товар в список возврата поставщику (qty ограничено остатком на выбранном складе) */
  const addToReturnList = async (product, add) => {
    if (!returnWarehouseId) {
      setOpMessage('Выберите склад списания');
      return;
    }
    const maxQty = await warehouseQtyForProduct(product, returnWarehouseId);
    if (maxQty < 1) {
      setOpMessage('Нет остатка на выбранном складе');
      return;
    }
    const qty = Math.min(Math.max(1, parseInt(add, 10) || 1), maxQty);
    if (qty < 1) return;
    const id = product.id;
    setReturnList((prev) => {
      const existing = prev.find((item) => String(item.productId) === String(id));
      if (existing) {
        const newQty = Math.min(existing.quantity + qty, maxQty);
        if (newQty <= 0) return prev;
        return prev.map((item) =>
          String(item.productId) === String(id)
            ? { ...item, quantity: newQty, warehouseMaxQty: maxQty }
            : item
        );
      }
      return [
        ...prev,
        {
          productId: id,
          sku: product.sku || '—',
          name: product.name || 'Без названия',
          quantity: qty,
          warehouseMaxQty: maxQty,
        },
      ];
    });
  };

  /** По скану: 1 скан = +1 в список возврата */
  const lookupByBarcodeOrSkuThenReturnOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    if (shouldIgnoreDuplicateWarehouseScan(returnScanDedupRef, v)) return;
    if (!returnWarehouseId) {
      setLookupError('Сначала выберите склад списания');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для возврата поставщику' });
      const available = await warehouseQtyForProduct(product, returnWarehouseId);
      if (available < 1) {
        setLookupError('Нет остатка на выбранном складе');
        playEventSound(SOUND_EVENTS.scan_error);
        return;
      }
      await addToReturnList(product, 1);
      setOpMessage(`В список возврата: +1 шт — ${product.name || product.sku}`);
      playEventSound(SOUND_EVENTS.scan_ok);
      clearScanField(returnScanInputRef.current);
      returnScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
      playEventSound(SOUND_EVENTS.scan_error);
    }
  };

  const handleReturnScan = useCallback(
    (code) => {
      setLookupError(null);
      lookupByBarcodeOrSkuThenReturnOne(code);
      returnScanInputRef.current?.focus();
    },
    [lookupByBarcodeOrSkuThenReturnOne]
  );

  const handleTransferScan = useCallback(
    (code) => {
      submitTransferScan({ preventDefault: () => {} }, code);
    },
    [submitTransferScan]
  );

  const handleTransferManualQuery = useCallback(
    async (qq) => {
      if (qq.length < 2) return;
      const matches = await resolveTransferMatches(qq);
      if (matches.length === 0) {
        if (suggestContext === 'transfer_scan') closeSuggest();
        return;
      }
      openSuggest('transfer_scan', 'Выберите товар', matches, (p) => {
        if (!p) return;
        addTransferItemFromProduct(p, transferQuickMode ? 1 : transferQty);
        clearScanField(transferScanInputRef.current);
        window.setTimeout(() => transferScanInputRef.current?.focus(), 0);
      });
    },
    [
      resolveTransferMatches,
      suggestContext,
      closeSuggest,
      openSuggest,
      addTransferItemFromProduct,
      transferQuickMode,
      transferQty,
    ]
  );

  const handleReturnFromList = async () => {
    if (!returnWarehouseId) {
      setOpMessage('Выберите склад списания');
      return;
    }
    const picked =
      returnPickedProduct ||
      products.find((p) => String(p.id) === String(returnSelectedProductId || '').trim());
    if (!picked?.id) {
      setOpMessage('Выберите товар из подсказок поиска');
      return;
    }
    const product = products.find((p) => String(p.id) === String(picked.id)) || picked;
    const add = Math.max(1, parseInt(returnListQty, 10) || 1);
    await addToReturnList(product, add);
    setOpMessage(`В список возврата: ${product.name} — до ${add} шт`);
    setReturnPickedProduct(null);
    setReturnSelectedProductId('');
    setReturnListSearch('');
  };

  const removeFromReturnList = (index) => {
    setReturnList(prev => prev.filter((_, i) => i !== index));
  };

  const updateReturnQuantity = (index, value) => {
    const num = parseInt(value, 10);
    const item = returnList[index];
    if (!item) return;
    const maxQty = Math.max(0, Number(item.warehouseMaxQty) || 0);
    const qty = Math.min(isNaN(num) || num < 1 ? 1 : num, maxQty || 1);
    setReturnList((prev) =>
      prev.map((it, i) => (i === index ? { ...it, quantity: qty } : it))
    );
  };

  const applyReturnToSupplier = async () => {
    if (returnList.length === 0) {
      setOpMessage('Список пуст');
      return;
    }
    if (!returnSupplierId) {
      setOpMessage('Выберите поставщика');
      return;
    }
    if (!returnOrganizationId) {
      setOpMessage('Выберите организацию');
      return;
    }
    if (!returnWarehouseId) {
      setOpMessage('Выберите склад списания');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      const lines = [];
      for (const l of returnList) {
        const pid = Number(l.productId);
        if (!Number.isFinite(pid) || pid < 1) continue;
        const product =
          products.find((p) => Number(p.id) === pid) || {
            id: pid,
            sku: l.sku,
            name: l.name,
          };
        const maxQty = await warehouseQtyForProduct(product, returnWarehouseId);
        if (maxQty < 1) continue;
        const qty = Math.min(Math.max(1, parseInt(l.quantity, 10) || 1), maxQty);
        lines.push({ productId: pid, quantity: qty });
      }
      if (lines.length === 0) {
        setOpMessage(
          'Нет позиций с остатком на выбранном складе — добавьте товары по скану или из списка'
        );
        setOpLoading(false);
        return;
      }
      const res = await receiptsApi.create({
        documentType: 'return',
        organizationId: Number(returnOrganizationId),
        supplierId: Number(returnSupplierId),
        warehouseId: Number(returnWarehouseId),
        lines
      });
      const receiptNumber = res?.data?.receipt?.receipt_number || '';
      setOpMessage(receiptNumber ? `Возвратная накладная ${receiptNumber} оформлена` : 'Возврат оформлен');
      playEventSound(SOUND_EVENTS.success);
      setReturnList([]);
      onRefresh?.();
      loadReceiptsList(MODE_RETURN_SUPPLIER);
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось оформить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearReturnList = () => {
    setReturnList([]);
    setOpMessage('Список очищен');
  };

  const addToCustomerReturnList = (product, add) => {
    const qty = Math.max(1, parseInt(add, 10) || 1);
    const id = product.id;
    const pc = product?.cost;
    const defaultCost =
      pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : '';
    setCustomerReturnList(prev => {
      const existing = prev.find(item => String(item.productId) === String(id));
      if (existing) {
        return prev.map(item =>
          String(item.productId) === String(id) ? { ...item, quantity: existing.quantity + qty } : item
        );
      }
      return [...prev, {
        productId: id,
        sku: product.sku || '—',
        name: product.name || 'Без названия',
        quantity: qty,
        cost: defaultCost
      }];
    });
  };

  const lookupByBarcodeOrSkuThenCustomerReturnOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    if (shouldIgnoreDuplicateWarehouseScan(customerReturnScanDedupRef, v)) return;
    if (!customerReturnWarehouseId) {
      setLookupError('Сначала выберите склад приёмки возврата');
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для возврата от клиента' });
      addToCustomerReturnList(product, 1);
      setOpMessage(`В список возврата от клиента: +1 шт — ${product.name || product.sku}`);
      playEventSound(SOUND_EVENTS.scan_ok);
      clearScanField(customerReturnScanInputRef.current);
      customerReturnScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
      playEventSound(SOUND_EVENTS.scan_error);
    }
  };

  const handleCustomerReturnScan = useCallback(
    (code) => {
      setLookupError(null);
      lookupByBarcodeOrSkuThenCustomerReturnOne(code);
      customerReturnScanInputRef.current?.focus();
    },
    [lookupByBarcodeOrSkuThenCustomerReturnOne]
  );

  const scrollToCustomerReturnAccept = useCallback(() => {
    customerReturnAcceptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleAcceptMarketplaceReturn = useCallback(
    (row) => {
      scrollToCustomerReturnAccept();
      const scanCode = String(row?.barcode || row?.sku || '').trim();
      if (!scanCode) {
        setOpMessage('У возврата нет штрихкода или SKU для поиска товара');
        return;
      }
      if (!customerReturnWarehouseId) {
        setOpMessage('Сначала выберите склад приёмки возврата');
        return;
      }
      lookupByBarcodeOrSkuThenCustomerReturnOne(scanCode);
    },
    [scrollToCustomerReturnAccept, customerReturnWarehouseId, lookupByBarcodeOrSkuThenCustomerReturnOne]
  );

  const customerReturnPrefillRef = useRef('');

  useEffect(() => {
    if (mode !== MODE_RETURN_CUSTOMER) return undefined;
    const prefill = prefillCustomerReturn;
    if (!prefill || typeof prefill !== 'object') return undefined;

    const linesKey = Array.isArray(prefill.lines)
      ? prefill.lines.map((l) => `${l.productId}:${l.quantity}`).join('|')
      : '';
    const key = `${prefill.source || ''}|${prefill.orderId || ''}|${prefill.marketplace || ''}|${linesKey}|${prefill.scanCode || ''}`;
    if (customerReturnPrefillRef.current === key) return undefined;
    customerReturnPrefillRef.current = key;

    if (prefill.organizationId != null && String(prefill.organizationId).trim() !== '') {
      setCustomerReturnOrganizationId(String(prefill.organizationId));
    }
    if (prefill.warehouseId != null && String(prefill.warehouseId).trim() !== '') {
      setCustomerReturnWarehouseId(String(prefill.warehouseId));
    }

    if (Array.isArray(prefill.lines) && prefill.lines.length > 0) {
      const enriched = prefill.lines.map((line) => {
        const productId = line.productId;
        const fromCatalog = (products || []).find((p) => String(p.id) === String(productId));
        const costRaw = line.cost ?? fromCatalog?.cost;
        const cost =
          costRaw != null && costRaw !== '' && Number.isFinite(Number(costRaw)) ? Number(costRaw) : '';
        return {
          productId,
          sku: resolveCustomerReturnLineSku(line, fromCatalog),
          name: line.name || fromCatalog?.name || `Товар #${productId}`,
          quantity: Math.max(1, Number(line.quantity) || 1),
          cost,
        };
      });
      setCustomerReturnList(enriched);
      const orderLabel = prefill.orderId ? `ручному заказу ${prefill.orderId}` : 'заказу';
      setOpMessage(`Список заполнен по ${orderLabel}. Проверьте количество и оформите возврат.`);
      scrollToCustomerReturnAccept();
      return undefined;
    }

    const scanCode = String(prefill.scanCode || '').trim();
    if (!scanCode) return undefined;
    scrollToCustomerReturnAccept();
    const timer = setTimeout(() => {
      lookupByBarcodeOrSkuThenCustomerReturnOne(scanCode);
    }, 200);
    return () => clearTimeout(timer);
  }, [
    mode,
    prefillCustomerReturn,
    products,
    scrollToCustomerReturnAccept,
    lookupByBarcodeOrSkuThenCustomerReturnOne,
  ]);

  // Если список заполнили до загрузки products — дотянуть артикулы из каталога.
  useEffect(() => {
    if (mode !== MODE_RETURN_CUSTOMER || !Array.isArray(products) || products.length === 0) return undefined;
    setCustomerReturnList((prev) => {
      if (!prev.length) return prev;
      let changed = false;
      const next = prev.map((item) => {
        const sku = String(item.sku ?? '').trim();
        if (sku && sku !== '—') return item;
        const fromCatalog = products.find((p) => String(p.id) === String(item.productId));
        const resolved = resolveCustomerReturnLineSku(item, fromCatalog);
        if (resolved === item.sku) return item;
        changed = true;
        return { ...item, sku: resolved };
      });
      return changed ? next : prev;
    });
    return undefined;
  }, [mode, products]);

  const handleCustomerReturnFromList = () => {
    if (!customerReturnWarehouseId) {
      setOpMessage('Выберите склад приёмки возврата');
      return;
    }
    const product =
      customerReturnPickedProduct ||
      products.find((p) => String(p.id) === String(customerReturnSelectedProductId || '').trim());
    if (!product?.id) {
      setOpMessage('Выберите товар из подсказок поиска');
      return;
    }
    const add = Math.max(1, parseInt(customerReturnListQty, 10) || 1);
    addToCustomerReturnList(product, add);
    setOpMessage(`В список возврата от клиента: ${product.name} — ${add} шт`);
    setCustomerReturnPickedProduct(null);
    setCustomerReturnSelectedProductId('');
    setCustomerReturnListSearch('');
  };

  const removeFromCustomerReturnList = (index) => {
    setCustomerReturnList(prev => prev.filter((_, i) => i !== index));
  };

  const updateCustomerReturnQuantity = (index, value) => {
    const num = parseInt(value, 10);
    const item = customerReturnList[index];
    if (!item) return;
    const qty = isNaN(num) || num < 1 ? 1 : num;
    setCustomerReturnList(prev =>
      prev.map((it, i) => (i === index ? { ...it, quantity: qty } : it))
    );
  };

  const applyCustomerReturnToWarehouse = async () => {
    if (customerReturnList.length === 0) {
      setOpMessage('Список пуст');
      return;
    }
    if (!customerReturnWarehouseId) {
      setOpMessage('Выберите склад приёмки возврата');
      return;
    }
    if (!String(customerReturnOrganizationId || '').trim()) {
      setOpMessage('Выберите организацию');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      const lines = customerReturnList.map((l) => ({
        productId: l.productId,
        quantity: Math.max(1, l.quantity),
        cost:
          l.cost !== '' && l.cost != null
            ? parseFloat(String(l.cost).replace(',', '.'))
            : null
      }));
      const res = await receiptsApi.create({
        documentType: 'customer_return',
        organizationId: customerReturnOrganizationId ? Number(customerReturnOrganizationId) : null,
        warehouseId: Number(customerReturnWarehouseId),
        lines
      });
      const receiptNumber = res?.data?.receipt?.receipt_number || '';
      setOpMessage(receiptNumber ? `Возврат от клиента ${receiptNumber} оформлен` : 'Возврат на склад оформлен');
      playEventSound(SOUND_EVENTS.success);
      setCustomerReturnList([]);
      onRefresh?.();
      loadReceiptsList(MODE_RETURN_CUSTOMER);
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось оформить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearCustomerReturnList = () => {
    setCustomerReturnList([]);
    setOpMessage('Список очищен');
  };

  /** Остаток «в системе» для строки пересчёта: как в таблице склада (выбранный склад), не raw products.quantity из GET по штрихкоду. */
  const resolveProductForInventory = (product) => {
    if (!product?.id) return product;
    const fromList = products.find((p) => String(p.id) === String(product.id));
    if (!fromList) return product;
    return {
      ...product,
      quantity: fromList.quantity != null ? fromList.quantity : product.quantity ?? 0,
      cost: fromList.cost != null ? fromList.cost : product.cost
    };
  };

  const appendInventoryRowDelta = async (product, factDelta = 1) => {
    if (!product?.id) {
      throw new Error('Товар не найден в каталоге (нет ID)');
    }
    const resolved = resolveProductForInventory(product);
    const current = await warehouseQtyForProduct(resolved, inventorySessionWarehouseId);
    const now = Date.now();
    const delta = Math.max(1, Number(factDelta) || 1);
    setInventoryNewRows((prev) => {
      const idx = prev.findIndex((r) => r.product.id === resolved.id);
      if (idx === -1) {
        return sortInventoryNewRows([{ product: resolved, current, fact: delta, scannedAt: now }, ...prev]);
      }
      const row = { ...prev[idx], fact: prev[idx].fact + delta, current, scannedAt: now };
      return sortInventoryNewRows([row, ...prev.filter((_, i) => i !== idx)]);
    });
  };

  const getInventoryUnitCostRub = (product) => {
    const c = product?.cost;
    if (c === null || c === undefined || c === '') return null;
    const n = Number(c);
    return Number.isFinite(n) ? n : null;
  };

  const formatRub = (amount) => {
    if (amount == null || Number.isNaN(amount)) return '—';
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      maximumFractionDigits: 0
    }).format(amount);
  };

  /** Итог в списке инвентаризаций: чистая Σ(Δкол-во × себестоимость), строки без cost не входят; NULL → «—». */
  const formatInventorySessionNetRubList = (raw) => {
    if (raw == null || raw === '') return '—';
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 0
      }).format(0);
    }
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      maximumFractionDigits: 0,
      signDisplay: 'always'
    }).format(n);
  };

  /** Сумма в списке приёмок: Σ(кол-во × цена в строке); строки без себестоимости не входят в сумму. */
  const formatReceiptListAmountRub = (raw) => {
    if (raw == null || raw === '') return '—';
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return '—';
    return formatRub(n);
  };

  const openReceiptDocument = (id) => {
    receiptsApi
      .getById(id)
      .then((res) => {
        const data = res?.data ?? res;
        if (data) setReceiptDetail(data);
      })
      .catch(() => {});
  };

  const renderWarehouseDocumentsList = ({
    title,
    emptyText,
    showSupplier = true,
    showTypeColumn = false,
    showReasonColumn = false,
    filterControls = null,
  }) => (
    <div className="warehouse-ops-documents-section">
      {title ? <h4 className="warehouse-ops-receipt-list-title">{title}</h4> : null}
      {filterControls}
      {receiptsLoading ? (
        <div className="loading">Загрузка документов…</div>
      ) : receiptsList.length === 0 ? (
        <p className="warehouse-ops-receipt-list-empty">{emptyText}</p>
      ) : (
        <div className="warehouse-ops-receipts-list-wrap">
          <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Номер</th>
                {showTypeColumn ? <th>Тип</th> : null}
                {showReasonColumn ? <th>Причина</th> : null}
                <th>Организация</th>
                {showSupplier ? <th>Поставщик</th> : null}
                <th>Склад</th>
                <th>Кол-во, шт</th>
                <th>Сумма, ₽</th>
              </tr>
            </thead>
            <tbody>
              {receiptsList.map((r) => (
                <tr
                  key={r.id}
                  className="stock-levels-row-clickable"
                  onClick={onNavigationClick(() => openReceiptDocument(r.id))}
                >
                  <td>
                    {r.created_at
                      ? new Date(r.created_at).toLocaleString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })
                      : '—'}
                  </td>
                  <td>{formatWarehouseReceiptNumber(r)}</td>
                  {showTypeColumn ? (
                    <td>{receiptDocumentTypeLabel(r.document_type)}</td>
                  ) : null}
                  {showReasonColumn ? <td>{r.writeoff_reason || '—'}</td> : null}
                  <td>{r.organization_name || '—'}</td>
                  {showSupplier ? <td>{r.supplier_name || r.supplier_code || '—'}</td> : null}
                  <td>{r.warehouse_name || '—'}</td>
                  <td>{receiptRowTotalUnits(r)}</td>
                  <td>{formatReceiptListAmountRub(r.total_amount_rub ?? r.totalAmountRub)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const inventoryNewRowsSorted = useMemo(
    () => sortInventoryNewRows(inventoryNewRows),
    [inventoryNewRows]
  );

  const inventoryNewMoneyTotals = useMemo(() => {
    let plus = 0;
    let minus = 0;
    for (const row of inventoryNewRows) {
      const unit = getInventoryUnitCostRub(row.product);
      if (unit == null) continue;
      const d = (row.fact ?? 0) - (row.current ?? 0);
      if (d > 0) plus += d * unit;
      else if (d < 0) minus += -d * unit;
    }
    return { plus, minus, net: plus - minus };
  }, [inventoryNewRows]);

  const inventorySavedMoneyTotals = useMemo(() => {
    const lines = inventoryDetailView?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return { plus: 0, minus: 0, net: 0 };
    let plus = 0;
    let minus = 0;
    for (const line of lines) {
      const unit = getInventoryUnitCostRub({ cost: line.product_cost ?? line.productCost });
      if (unit == null) continue;
      const before = Number(line.quantity_before ?? 0);
      const after = Number(line.quantity_after ?? 0);
      const d = after - before;
      if (d > 0) plus += d * unit;
      else if (d < 0) minus += -d * unit;
    }
    return { plus, minus, net: plus - minus };
  }, [inventoryDetailView]);

  const addOneToInventoryNewRow = async (product) => {
    if (!product?.id) {
      throw new Error('Товар не найден в каталоге (нет ID)');
    }
    await appendInventoryRowDelta(resolveProductForInventory(product), 1);
  };

  const scanInventoryLive = async (code) => {
    const sid = String(inventoryLiveSessionId || '').trim();
    if (!sid) return null;
    const res = await inventorySessionsApi.scanSession(sid, { code: String(code || '').trim() });
    applyInventoryLiveStateToRows(res);
    return res?.data ?? res;
  };

  const lookupByBarcodeOrSkuThenInventoryNewOne = async (value) => {
    if (inventoryScanBusyRef.current) return;
    const v = normalizeScanInput(value);
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      setOpMessage(null);
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    if (!inventorySessionWarehouseId) {
      setLookupError('Сначала выберите склад инвентаризации');
      setOpMessage(null);
      playEventSound(SOUND_EVENTS.scan_error);
      return;
    }
    inventoryScanBusyRef.current = true;
    setLookupError(null);
    setOpMessage('Поиск товара…');
    try {
      if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
        await scanInventoryLive(v);
        setLookupError(null);
        setOpMessage('Пересчёт: +1 шт');
        playEventSound(SOUND_EVENTS.scan_ok);
        return;
      }
      const product = await fetchProductByScanCode(v);
      await addOneToInventoryNewRow(product);
      setLookupError(null);
      setOpMessage(`Пересчёт: +1 шт — ${product.name || product.sku}`);
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      const msg = warehouseScanErrorMessage(
        e,
        'Штрихкод не найден. Проверьте штрихкод в карточке товара или привяжите его к товару.'
      );
      setLookupError(msg);
      setOpMessage(null);
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      inventoryScanBusyRef.current = false;
      clearScanField(inventoryNewScanInputRef.current);
      inventoryNewScanInputRef.current?.focus();
    }
  };

  const handleInventoryScan = useCallback(
    (code) => {
      if (!inventorySessionWarehouseId) {
        setLookupError('Сначала выберите склад инвентаризации');
        setOpMessage(null);
        playEventSound(SOUND_EVENTS.scan_error);
        return;
      }
      setLookupError(null);
      lookupByBarcodeOrSkuThenInventoryNewOne(code);
    },
    [inventorySessionWarehouseId, lookupByBarcodeOrSkuThenInventoryNewOne]
  );

  const addInventoryProductFromPick = async (product) => {
    if (!inventorySessionWarehouseId) {
      setOpMessage('Выберите склад инвентаризации');
      return false;
    }
    if (!product?.id) {
      setOpMessage('Выберите товар из списка или введите точный артикул / штрихкод');
      return false;
    }
    try {
      if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
        await scanInventoryLive(String(product.id));
        setOpMessage(`Пересчёт: +1 шт — ${product.name || product.sku}`);
      } else {
        await addOneToInventoryNewRow(product);
        setOpMessage(`Пересчёт: +1 шт — ${product.name || product.sku}`);
      }
      setInventoryNewPickedProduct(null);
      setInventoryNewSearch('');
      setLookupError(null);
    inventoryNewScanInputRef.current?.focus();
      return true;
    } catch (e) {
      const msg = warehouseScanErrorMessage(e, 'Не удалось добавить');
      setLookupError(msg);
      setOpMessage(null);
      playEventSound(SOUND_EVENTS.scan_error);
      return false;
    }
  };

  const resolveInventoryPickedProduct = async () => {
    if (inventoryNewPickedProduct?.id) return inventoryNewPickedProduct;
    const q = normalizeProductSearchQuery(inventoryNewSearch);
    if (!q) return null;
    const matches = await searchProductsCombined(q, { products, limit: 40 });
    if (matches.length === 1) return matches[0];
    const ql = q.toLowerCase();
    return (
      matches.find((p) => {
        const sku = String(p?.sku || '').trim().toLowerCase();
        if (sku === ql) return true;
        return false;
      }) || null
    );
  };

  const handleInventoryNewAddFromSelect = async () => {
    let product = inventoryNewPickedProduct;
    if (!product?.id) {
      try {
        product = await resolveInventoryPickedProduct();
      } catch {
        product = null;
      }
    }
    if (!product?.id) {
      setOpMessage('Выберите товар из списка или введите точный артикул / штрихкод');
      return;
    }
    await addInventoryProductFromPick(product);
  };

  const setInventoryNewFact = (productId, value) => {
    const num = parseInt(value, 10);
    const fact = isNaN(num) || num < 0 ? 0 : num;
    setInventoryNewRows((prev) =>
      prev.map((r) => (r.product.id === productId ? { ...r, fact } : r))
    );
    if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
      const sid = String(inventoryLiveSessionId || '').trim();
      const pid = Number(productId);
      if (inventorySetFactDebounceRef.current[pid]) {
        clearTimeout(inventorySetFactDebounceRef.current[pid]);
      }
      inventorySetFactDebounceRef.current[pid] = setTimeout(() => {
        delete inventorySetFactDebounceRef.current[pid];
        inventorySessionsApi
          .setSessionFact(sid, { productId: pid, fact })
          .then(applyInventoryLiveStateToRows)
          .catch(() => {});
      }, 400);
    }
  };

  const removeInventoryNewRow = (productId) => {
    if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
      const sid = String(inventoryLiveSessionId || '').trim();
      inventorySessionsApi
        .removeSessionItem(sid, { productId: Number(productId) })
        .then(applyInventoryLiveStateToRows)
        .catch(() => {});
      return;
    }
    setInventoryNewRows((prev) => prev.filter((r) => r.product.id !== productId));
  };

  const resetInventoryNewForm = () => {
    leaveInventoryLiveSession();
    setInventoryNewSession(false);
    setInventoryNewRows([]);
    setInventorySessionWarehouseId('');
    setInventoryEditingSessionId(null);
    setInventoryZeroUnlisted(true);
    setLookupError(null);
    setInventoryLiveDraft(readInventoryLiveDraft());
  };

  const enableInventoryLiveSession = useCallback(async () => {
    if (!inventorySessionWarehouseId) {
      setLookupError('Сначала выберите склад инвентаризации');
      return false;
    }
    setLookupError(null);
    setOpMessage(null);
    setInventoryLiveEnabled(true);
    const ok = await startInventoryLiveSession();
    if (!ok) {
      setInventoryLiveEnabled(false);
      setInventoryLiveSessionId('');
    }
    return ok;
  }, [inventorySessionWarehouseId, startInventoryLiveSession]);

  const handleCloseInventoryWorkspace = useCallback(() => {
    if (inventoryNewRows.length > 0) {
      const ok = window.confirm(
        'Закрыть пересчёт? Несохранённые изменения в списке будут потеряны (кроме общей сессии, если она включена).'
      );
      if (!ok) return;
    }
    resetInventoryNewForm();
  }, [inventoryNewRows.length]);

  const beginInventoryEditFromData = useCallback(
    async (detail) => {
      const session = detail?.session ?? detail;
      const lines = detail?.lines ?? [];
    if (!session?.id || !session?.warehouse_id) {
      setOpMessage('Не удалось открыть редактирование: у документа не указан склад');
        return false;
    }
    const whId = String(session.warehouse_id);
      leaveInventoryLiveSession();
      const rowTasks = (lines || []).map(async (line) => {
        const product = {
          id: line.product_id,
          sku: line.product_sku,
          name: line.product_name,
          cost: line.product_cost ?? line.productCost,
        };
        if (!product.id) return null;
        let current = await warehouseQtyForProduct(product, whId);
        if (!current && line.quantity_before != null) {
          current = Math.max(0, Number(line.quantity_before) || 0);
        }
        return {
          product,
          current,
          fact: Math.max(0, Number(line.quantity_after ?? 0)),
        };
        });
      const rows = (await Promise.all(rowTasks)).filter(Boolean);
      setInventoryEditingSessionId(session.id);
      setInventorySessionWarehouseId(whId);
      setInventoryZeroUnlisted(true);
      setInventoryNewRows(rows);
      setInventoryNewSession(true);
      setInventoryDetailView(null);
      setLookupError(null);
      setOpMessage(
        `Редактирование инвентаризации №${session.id}. Можно включить общую сессию и пригласить участников.`
      );
      if (typeof reloadProductsWithWarehouse === 'function') {
        await reloadProductsWithWarehouse(whId);
      }
      return true;
    },
    [leaveInventoryLiveSession, warehouseQtyForProduct, reloadProductsWithWarehouse]
  );

  const openInventoryEditFromSession = async (sessionId) => {
    const sid = sessionId != null ? Number(sessionId) : null;
    if (!sid || Number.isNaN(sid)) return;
    setOpLoading(true);
    try {
      const data = await inventorySessionsApi.getById(sid);
      await beginInventoryEditFromData(data);
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось открыть'));
    } finally {
      setOpLoading(false);
    }
  };

  const resumeInventoryLiveDraft = async () => {
    const draft = inventoryLiveDraft || readInventoryLiveDraft();
    const sid = String(draft?.liveSessionId || '').trim();
    if (!sid) return;
    setOpLoading(true);
    try {
      if (draft?.editingSessionId != null && Number.isFinite(Number(draft.editingSessionId))) {
        setInventoryEditingSessionId(Number(draft.editingSessionId));
      }
      await joinInventoryLiveSessionFromUrl(sid);
    } catch (e) {
      setLookupError(e?.response?.data?.message || e?.message || 'Сессия не найдена');
      clearInventoryLiveDraft();
      setInventoryLiveDraft(null);
    } finally {
      setOpLoading(false);
    }
  };

  const startInventoryEdit = async () => {
    setOpLoading(true);
    try {
      await beginInventoryEditFromData(inventoryDetailView);
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось открыть'));
    } finally {
      setOpLoading(false);
    }
  };

  const applyInventoryNew = async () => {
    if (!inventorySessionWarehouseId) {
      setOpMessage('Выберите склад инвентаризации');
      return;
    }
    if (inventoryNewRows.length === 0) {
      setOpMessage('Список пересчёта пуст');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    const lines = [];
    for (const row of inventoryNewRows) {
      const productId = Number(row?.product?.id ?? row?.product?.productId);
      if (!productId || Number.isNaN(productId)) {
        setOpMessage('Ошибка: в списке есть строка без ID товара — удалите её и добавьте заново');
        setOpLoading(false);
        return;
      }
      lines.push({
        productId,
        quantityAfter: Math.max(0, Number(row.fact) || 0),
      });
    }
    const payload = {
      lines,
      zeroUnlisted: inventoryZeroUnlisted,
    };
    try {
      if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
        if (isInventoryLiveGuest) {
          setOpMessage('Применить инвентаризацию может только создатель общей сессии');
          setOpLoading(false);
          return;
        }
        const r = await inventorySessionsApi.completeSession(String(inventoryLiveSessionId || '').trim(), {
          zeroUnlisted: inventoryZeroUnlisted,
          updateSessionId: inventoryEditingSessionId || undefined,
        });
        const res = r?.data ?? r;
        const sid = res?.sessionId ?? inventoryEditingSessionId;
        setOpMessage(
          sid
            ? inventoryEditingSessionId
              ? `Инвентаризация №${sid} обновлена. Позиций: ${res.linesApplied ?? 0}`
              : `Инвентаризация №${sid} сохранена. Обновлено позиций: ${res.linesApplied ?? 0}`
            : res?.message || 'Изменений не зафиксировано'
        );
        clearInventoryLiveDraft();
        onRefresh?.();
        loadInventorySessions();
        resetInventoryNewForm();
        setOpLoading(false);
        return;
      }
      const res = inventoryEditingSessionId
        ? await inventorySessionsApi.update(inventoryEditingSessionId, payload)
        : await inventorySessionsApi.apply({
            ...payload,
            warehouseId: Number(inventorySessionWarehouseId),
          });
      if (!inventoryEditingSessionId && res?.sessionId == null) {
        setOpMessage(res?.message || 'Изменений не зафиксировано');
      } else if (res?.linesApplied === 0 && res?.message) {
        setOpMessage(res.message);
        onRefresh?.();
        loadInventorySessions();
        resetInventoryNewForm();
      } else {
        const sid = res?.sessionId ?? inventoryEditingSessionId;
        setOpMessage(
          inventoryEditingSessionId
            ? `Инвентаризация №${sid} обновлена. Позиций в документе: ${res.linesApplied ?? 0}`
            : `Инвентаризация №${sid} сохранена. Обновлено позиций: ${res.linesApplied ?? 0}`
        );
        onRefresh?.();
        loadInventorySessions();
        resetInventoryNewForm();
      }
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось сохранить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearInventoryNewRows = () => {
    if (inventoryLiveEnabled && String(inventoryLiveSessionId || '').trim()) {
      setOpMessage('В общей инвентаризации удаляйте строки по одной — общий список на сервере.');
      return;
    }
    setInventoryNewRows([]);
    setOpMessage('Список пересчёта очищен');
  };

  return (
    <div className={`warehouse-operations${hideTabs ? ' warehouse-operations--embedded' : ''}`}>
      {!hideTabs ? (
        <div className="warehouse-ops-tabs">
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_TABLE ? 'active' : ''}`}
            onClick={() => setMode(MODE_TABLE)}
          >
            Таблица остатков
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_RECEIPTS_LIST ? 'active' : ''}`}
            onClick={() => setMode(MODE_RECEIPTS_LIST)}
          >
            📑 Приёмки
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_TRANSFER ? 'active' : ''}`}
            onClick={() => setMode(MODE_TRANSFER)}
          >
            ↔️ Перемещение
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_WRITEOFF ? 'active' : ''}`}
            onClick={() => setMode(MODE_WRITEOFF)}
          >
            📤 Списание
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_RETURN_SUPPLIER ? 'active' : ''}`}
            onClick={() => setMode(MODE_RETURN_SUPPLIER)}
          >
            ↩️ Возврат поставщику
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_RETURN_CUSTOMER ? 'active' : ''}`}
            onClick={() => setMode(MODE_RETURN_CUSTOMER)}
          >
            📥 Возвраты от клиентов
          </button>
          <button
            type="button"
            className={`warehouse-ops-tab ${mode === MODE_INVENTORY ? 'active' : ''}`}
            onClick={() => setMode(MODE_INVENTORY)}
          >
            📋 Инвентаризация
          </button>
        </div>
      ) : null}

      {mode === MODE_WRITEOFF && (
        <div className="warehouse-ops-panel writeoff-panel">
          <p className="warehouse-ops-hint">
            Укажите организацию, склад и причину списания; добавьте товары сканером или поиском в одной строке.
            Остаток проверяется по выбранному складу. Документ оформляется одной операцией по всем позициям.
          </p>
          <div className="warehouse-ops-return-org-supplier">
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Организация <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={writeoffOrganizationId}
                onChange={(e) => {
                  setWriteoffOrganizationId(e.target.value);
                  setWriteoffWarehouseId('');
                  setWriteoffList([]);
                  setOpMessage(null);
                }}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите организацию —</option>
                {(organizations || []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад списания <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                className="warehouse-ops-select"
                value={writeoffWarehouseId}
                onChange={(e) => {
                  setWriteoffWarehouseId(e.target.value);
                  setWriteoffList([]);
                  setOpMessage(null);
                }}
                disabled={!writeoffOrganizationId}
              >
                <option value="">
                  {writeoffOrganizationId ? '— Выберите склад —' : '— Сначала выберите организацию —'}
                </option>
                {writeoffWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Причина списания <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                className="warehouse-ops-select"
                value={writeoffReason}
                onChange={(e) => setWriteoffReason(e.target.value)}
              >
                <option value="Брак">Брак</option>
                <option value="Утеря">Утеря</option>
              </select>
            </div>
          </div>

          <p className="warehouse-ops-hint">
            Сканируйте штрихкод (1 скан = 1 шт) или введите артикул / название для выбора из списка. Количество укажите в таблице ниже.
          </p>
          <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
            <div className="warehouse-ops-scan-form-input-wrap">
              <FastScanInput
                inputRef={writeoffScanInputRef}
                onScan={handleWriteoffScan}
                onManualQuery={handleWriteoffManualQuery}
                debounceMs={200}
                manualDebounceMs={400}
                placeholder="Штрихкод, артикул или название"
                disabled={!writeoffWarehouseId}
                onBlur={() => {
                  setTimeout(() => {
                    if (suggestContext === 'writeoff_scan') closeSuggest();
                  }, 150);
                }}
              />
              {suggestOpen && suggestContext === 'writeoff_scan' && (
                <div className="warehouse-ops-suggest warehouse-ops-suggest--anchored">
                  <div className="warehouse-ops-suggest-title">{suggestTitle || 'Выберите товар'}</div>
                  <div className="warehouse-ops-suggest-list">
                    {(suggestList || []).map((p) => (
                      <button
                        key={p.id ?? `${p.sku || ''}-${p.name || ''}`}
                        type="button"
                        className="warehouse-ops-suggest-item"
                        onMouseDown={(ev) => {
                          ev.preventDefault();
                          writeoffSuppressScanRef.current = true;
                          clearScanField(writeoffScanInputRef.current);
                          window.setTimeout(() => {
                            writeoffSuppressScanRef.current = false;
                          }, 500);
                          const fn = suggestOnPickRef.current;
                          closeSuggest();
                          if (typeof fn === 'function') fn(p);
                        }}
                      >
                        <div className="warehouse-ops-suggest-sku">{p.sku || '—'}</div>
                        <div className="warehouse-ops-suggest-name">{p.name || '—'}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="warehouse-ops-scan-form-notice" aria-live="polite">
              {lookupError ? (
                <div className="warehouse-ops-scan-form-notice-text warehouse-ops-scan-form-notice-text--error">
                  {lookupError}
                </div>
              ) : opMessage ? (
                <div className="warehouse-ops-scan-form-notice-text warehouse-ops-scan-form-notice-text--success">
                  {opMessage}
                </div>
              ) : null}
            </div>
          </form>

          <div className="warehouse-ops-receipt-list-section">
            <h4 className="warehouse-ops-receipt-list-title">Список товаров для списания</h4>
            {writeoffList.length === 0 ? (
              <p className="warehouse-ops-receipt-list-empty">Список пуст. Сканируйте товары или найдите по артикулу / названию.</p>
            ) : (
              <>
                <div className="warehouse-ops-receipt-list-wrap">
                  <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Товар</th>
                        <th>Кол-во</th>
                        <th>Сумма, ₽</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {writeoffList.map((item, index) => {
                        const maxQty = Math.max(1, Number(item.warehouseMaxQty) || 1);
                        const unitCost =
                          item.cost != null && item.cost !== '' ? Number(item.cost) : null;
                        const lineSum =
                          unitCost != null && Number.isFinite(unitCost)
                            ? unitCost * (Number(item.quantity) || 0)
                            : null;
                        return (
                          <tr key={`${item.productId}-${index}`}>
                            <td className="sku-cell">{item.sku}</td>
                            <td className="name-cell">{item.name}</td>
                            <td>
                              <input
                                type="number"
                                min={1}
                                max={maxQty}
                                value={item.quantity}
                                onChange={(e) => updateWriteoffQuantity(index, e.target.value)}
                                className="warehouse-ops-qty-input small"
                              />
                            </td>
                            <td className="num-cell">
                              {lineSum != null ? formatRub(lineSum) : '—'}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="warehouse-ops-remove-btn"
                                onClick={() => removeFromWriteoffList(index)}
                                title="Удалить из списка"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
                  Итого: {writeoffListTotals.units} шт
                  {writeoffListTotals.sumRub > 0 ? ` · ${formatRub(writeoffListTotals.sumRub)}` : ''}
                </p>
                <div className="warehouse-ops-receipt-list-actions">
                  <Button
                    onClick={applyWriteoffDocument}
                    disabled={
                      opLoading ||
                      !writeoffOrganizationId ||
                      !writeoffWarehouseId ||
                      !writeoffReason
                    }
                  >
                    {opLoading ? 'Оформление…' : 'Оформить списание'}
                  </Button>
                  <Button variant="secondary" onClick={clearWriteoffList} disabled={opLoading}>
                    Очистить список
                  </Button>
                </div>
              </>
            )}
          </div>

          {renderWarehouseDocumentsList({
            title: 'Оформленные списания',
            emptyText: 'Списаний пока нет',
            showSupplier: false,
            showReasonColumn: true,
            filterControls: (
              <div className="warehouse-ops-return-org-supplier" style={{ marginBottom: 12 }}>
                <div className="warehouse-ops-receipt-supplier-row">
                  <label>Фильтр: организация</label>
                  <select
                    value={writeoffFilterOrgId}
                    onChange={(e) => {
                      setWriteoffFilterOrgId(e.target.value);
                      setWriteoffFilterWhId('');
                    }}
                    className="warehouse-ops-select"
                  >
                    <option value="">— Все организации —</option>
                    {(organizations || []).map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="warehouse-ops-receipt-supplier-row">
                  <label>Фильтр: склад</label>
                  <select
                    value={writeoffFilterWhId}
                    onChange={(e) => setWriteoffFilterWhId(e.target.value)}
                    className="warehouse-ops-select"
                  >
                    <option value="">— Все склады —</option>
                    {writeoffFilterWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.address || w.name || `Склад #${w.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ),
          })}
        </div>
      )}

      {mode === MODE_RETURN_SUPPLIER && (
        <div className="warehouse-ops-panel return-supplier-panel">
          <p className="warehouse-ops-hint">Укажите организацию (от имени которой возврат), поставщика и склад списания; добавьте товары по скану или из списка. Остаток проверяется по выбранному складу, а не по общему количеству в каталоге. Документы сохраняются в списке ниже.</p>
          <div className="warehouse-ops-return-org-supplier">
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Организация (от имени которой возврат) <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={returnOrganizationId}
                onChange={e => setReturnOrganizationId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите организацию —</option>
                {(organizations || []).map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад списания <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={returnWarehouseId}
                onChange={(e) => setReturnWarehouseId(e.target.value)}
                className="warehouse-ops-select"
                disabled={!returnOrganizationId}
              >
                <option value="">
                  {returnOrganizationId ? '— Выберите склад —' : '— Сначала выберите организацию —'}
                </option>
                {returnWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Поставщик <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={returnSupplierId}
                onChange={e => setReturnSupplierId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите поставщика —</option>
                {(suppliers || []).map(s => (
                  <option key={s.id} value={s.id}>{s.name || s.code || s.id}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="warehouse-ops-receipt-modes">
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="returnMode"
                checked={returnMode === 'scan'}
                onChange={() => setReturnMode('scan')}
              />
              <span>По скану — 1 скан = 1 шт</span>
            </label>
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="returnMode"
                checked={returnMode === 'list'}
                onChange={() => setReturnMode('list')}
              />
              <span>Из списка — выбор товара и количество</span>
            </label>
          </div>

          {returnMode === 'scan' && (
            <>
              <p className="warehouse-ops-hint">Отсканируйте штрихкод — товар добавится в список возврата (1 скан = 1 шт).</p>
              <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <FastScanInput
                  inputRef={returnScanInputRef}
                  onScan={handleReturnScan}
                  debounceMs={200}
                  placeholder="Наведите сканер сюда"
                  disabled={!returnWarehouseId}
                />
              </form>
            </>
          )}

          {returnMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row warehouse-ops-list-row--search">
                <label htmlFor="return-supplier-product-search">Товар:</label>
                <ProductSearchInput
                  id="return-supplier-product-search"
                  value={returnListSearch}
                  onChange={(v) => {
                    setReturnListSearch(v);
                    setReturnPickedProduct(null);
                    setReturnSelectedProductId('');
                  }}
                  products={returnSupplierProducts}
                  placeholder="Штрихкод, артикул или название"
                  disabled={!returnWarehouseId}
                  onSelect={(p) =>
                    pickListProduct(p, {
                      setProduct: setReturnPickedProduct,
                      setSearch: setReturnListSearch,
                      setId: setReturnSelectedProductId,
                    })
                  }
                />
              </div>
              <div className="warehouse-ops-list-row">
                <label>Количество:</label>
                <input
                  type="number"
                  min={1}
                  value={returnListQty}
                  onChange={e => setReturnListQty(e.target.value)}
                  className="warehouse-ops-qty-input"
                />
                <Button
                  onClick={handleReturnFromList}
                  disabled={(!returnPickedProduct && !returnSelectedProductId) || !returnWarehouseId}
                >
                  В список
                </Button>
              </div>
            </div>
          )}

          {lookupError && <div className="warehouse-ops-error">{lookupError}</div>}
          {opMessage && <div className="warehouse-ops-msg success">{opMessage}</div>}

          <div className="warehouse-ops-receipt-list-section">
            <h4 className="warehouse-ops-receipt-list-title">Список товаров для возврата</h4>
            {returnList.length === 0 ? (
              <p className="warehouse-ops-receipt-list-empty">Список пуст. Сканируйте товары или добавляйте из списка.</p>
            ) : (
              <>
                <div className="warehouse-ops-receipt-list-wrap">
                  <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Товар</th>
                        <th>Кол-во</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnList.map((item, index) => {
                        const maxQty = Math.max(1, Number(item.warehouseMaxQty) || 1);
                        return (
                          <tr key={`${item.productId}-${index}`}>
                            <td className="sku-cell">{item.sku}</td>
                            <td className="name-cell">{item.name}</td>
                            <td>
                              <input
                                type="number"
                                min={1}
                                max={maxQty}
                                value={item.quantity}
                                onChange={e => updateReturnQuantity(index, e.target.value)}
                                className="warehouse-ops-qty-input small"
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="warehouse-ops-remove-btn"
                                onClick={() => removeFromReturnList(index)}
                                title="Удалить из списка"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="warehouse-ops-receipt-list-actions">
                  <Button
                    onClick={applyReturnToSupplier}
                    disabled={
                      opLoading ||
                      !returnSupplierId ||
                      !returnOrganizationId ||
                      !returnWarehouseId
                    }
                  >
                    {opLoading ? 'Оформление…' : 'Оформить возврат'}
                  </Button>
                  <Button variant="secondary" onClick={clearReturnList} disabled={opLoading}>
                    Очистить список
                  </Button>
                </div>
              </>
            )}
          </div>

          {renderWarehouseDocumentsList({
            title: 'Оформленные возвраты поставщику',
            emptyText: 'Нет возвратных накладных.',
            showSupplier: true
          })}
        </div>
      )}

      {mode === MODE_RETURN_CUSTOMER && (
        <>
          <MarketplaceReturnsPanel embedded onAcceptReturn={handleAcceptMarketplaceReturn} />
          <div
            ref={customerReturnAcceptRef}
            id="warehouse-customer-return-accept"
            className="warehouse-ops-panel return-customer-panel"
          >
          <h4 className="warehouse-ops-subsection-title">Принять возврат на склад</h4>
          <p className="warehouse-ops-hint">
            Сначала выберите организацию и склад приёмки, затем добавьте товары по скану или из списка. Документы сохраняются в списке ниже.
          </p>
          <div className="warehouse-ops-return-org-supplier">
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Организация (принимающая возврат) <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={customerReturnOrganizationId}
                onChange={e => setCustomerReturnOrganizationId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите организацию —</option>
                {(organizations || []).map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад приёмки <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={customerReturnWarehouseId}
                onChange={(e) => setCustomerReturnWarehouseId(e.target.value)}
                className="warehouse-ops-select"
                disabled={!customerReturnOrganizationId}
              >
                <option value="">
                  {customerReturnOrganizationId ? '— Выберите склад —' : '— Сначала выберите организацию —'}
                </option>
                {customerReturnWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="warehouse-ops-receipt-modes">
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="customerReturnMode"
                checked={customerReturnMode === 'scan'}
                onChange={() => setCustomerReturnMode('scan')}
              />
              <span>По скану — 1 скан = 1 шт</span>
            </label>
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="customerReturnMode"
                checked={customerReturnMode === 'list'}
                onChange={() => setCustomerReturnMode('list')}
              />
              <span>Из списка — выбор товара и количество</span>
            </label>
          </div>

          {customerReturnMode === 'scan' && (
            <>
              <p className="warehouse-ops-hint">Отсканируйте штрихкод — товар добавится в список (1 скан = 1 шт).</p>
              <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <FastScanInput
                  inputRef={customerReturnScanInputRef}
                  onScan={handleCustomerReturnScan}
                  debounceMs={200}
                  placeholder="Наведите сканер сюда"
                  disabled={!customerReturnWarehouseId}
                />
              </form>
            </>
          )}

          {customerReturnMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row warehouse-ops-list-row--search">
                <label htmlFor="customer-return-product-search">Товар:</label>
                <ProductSearchInput
                  id="customer-return-product-search"
                  value={customerReturnListSearch}
                  onChange={(v) => {
                    setCustomerReturnListSearch(v);
                    setCustomerReturnPickedProduct(null);
                    setCustomerReturnSelectedProductId('');
                  }}
                  products={products}
                  placeholder="Штрихкод, артикул или название"
                  disabled={!customerReturnWarehouseId}
                  onSelect={(p) =>
                    pickListProduct(p, {
                      setProduct: setCustomerReturnPickedProduct,
                      setSearch: setCustomerReturnListSearch,
                      setId: setCustomerReturnSelectedProductId,
                    })
                  }
                />
              </div>
              <div className="warehouse-ops-list-row">
                <label>Количество:</label>
                <input
                  type="number"
                  min={1}
                  value={customerReturnListQty}
                  onChange={e => setCustomerReturnListQty(e.target.value)}
                  className="warehouse-ops-qty-input"
                />
                <Button
                  onClick={handleCustomerReturnFromList}
                  disabled={
                    (!customerReturnPickedProduct && !customerReturnSelectedProductId) ||
                    !customerReturnWarehouseId
                  }
                >
                  В список
                </Button>
              </div>
            </div>
          )}

          {lookupError && <div className="warehouse-ops-error">{lookupError}</div>}
          {opMessage && <div className="warehouse-ops-msg success">{opMessage}</div>}

          <div className="warehouse-ops-receipt-list-section">
            <h4 className="warehouse-ops-receipt-list-title">Список товаров для приёмки на склад</h4>
            {customerReturnList.length === 0 ? (
              <p className="warehouse-ops-receipt-list-empty">Список пуст. Сканируйте товары или добавляйте из списка.</p>
            ) : (
              <>
                <div className="warehouse-ops-receipt-list-wrap">
                  <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Товар</th>
                        <th>Кол-во</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerReturnList.map((item, index) => (
                        <tr key={`${item.productId}-${index}`}>
                          <td className="sku-cell">{item.sku}</td>
                          <td className="name-cell">{item.name}</td>
                          <td>
                            <input
                              type="number"
                              min={1}
                              value={item.quantity}
                              onChange={e => updateCustomerReturnQuantity(index, e.target.value)}
                              className="warehouse-ops-qty-input small"
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="warehouse-ops-remove-btn"
                              onClick={() => removeFromCustomerReturnList(index)}
                              title="Удалить из списка"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="warehouse-ops-receipt-list-actions">
                  <Button
                    onClick={applyCustomerReturnToWarehouse}
                    disabled={opLoading || !customerReturnWarehouseId}
                  >
                    {opLoading ? 'Оформление…' : 'Оформить возврат на склад'}
                  </Button>
                  <Button variant="secondary" onClick={clearCustomerReturnList} disabled={opLoading}>
                    Очистить список
                  </Button>
                </div>
              </>
            )}
          </div>

          {renderWarehouseDocumentsList({
            title: 'Оформленные возвраты от клиентов',
            emptyText: 'Нет документов возврата от клиентов.',
            showSupplier: false
          })}
          </div>
        </>
      )}

      {mode === MODE_INVENTORY && (
        <div className="warehouse-ops-panel inventory-panel">
          {!inventoryNewSession && (
            <>
              <div className="warehouse-ops-inventory-header-row">
                <div>
                  <p className="warehouse-ops-hint">
                    Список завершённых пересчётов. Чтобы заново пересчитать остатки — нажмите «Новая инвентаризация»,
                    отсканируйте товары и сохраните документ.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    setInventoryNewSession(true);
                    setInventoryNewRows([]);
                    setOpMessage(null);
                    setLookupError(null);
                    clearScanField(inventoryNewScanInputRef.current);
                    setInventoryNewSearch('');
                    setInventoryNewPickedProduct(null);
                    const initWh = inventoryWarehouseId || '';
                    setInventorySessionWarehouseId(initWh);
                    if (initWh && typeof reloadProductsWithWarehouse === 'function') {
                      reloadProductsWithWarehouse(initWh);
                    }
                  }}
                  disabled={opLoading}
                >
                  Новая инвентаризация
                </Button>
              </div>
              {inventoryLiveDraft?.liveSessionId && (
                <div className="warehouse-ops-msg" style={{ marginBottom: 12 }}>
                  <strong>Незавершённая общая инвентаризация</strong>
                  {inventoryLiveDraft.editingSessionId
                    ? ` (редактирование документа №${inventoryLiveDraft.editingSessionId})`
                    : ''}
                  {' — '}
                  код <code>{inventoryLiveDraft.liveSessionId}</code>
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button type="button" onClick={resumeInventoryLiveDraft} disabled={opLoading}>
                      Продолжить пересчёт
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        clearInventoryLiveDraft();
                        setInventoryLiveDraft(null);
                      }}
                    >
                      Забыть черновик
                    </Button>
                  </div>
                </div>
              )}
              {inventorySessionsLoading ? (
                <div className="loading">Загрузка списка…</div>
              ) : inventorySessionsList.length === 0 ? (
                <p className="warehouse-ops-receipt-list-empty">Пока нет сохранённых инвентаризаций.</p>
              ) : (
                <div className="warehouse-ops-receipts-list-wrap">
                  <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
                    <thead>
                      <tr>
                        <th>Дата</th>
                        <th>Номер</th>
                        <th>Склад</th>
                        <th>Позиций</th>
                        <th>Итог, ₽</th>
                        <th>Кем создано</th>
                        <th style={{ width: 120 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {inventorySessionsList.map((s) => {
                        const who =
                          [s.created_by_full_name, s.created_by_email].filter(Boolean).join(' · ') || '—';
                        const wh =
                          s.warehouse_label ||
                          (s.warehouse_id != null ? `Склад №${s.warehouse_id}` : '—');
                        return (
                          <tr
                            key={s.id}
                            className="stock-levels-row-clickable"
                            onClick={onNavigationClick(() => {
                              inventorySessionsApi
                                .getById(s.id)
                                .then((data) => setInventoryDetailView(data))
                                .catch(() => setOpMessage('Не удалось загрузить документ'));
                            })}
                          >
                            <td>
                              {s.created_at
                                ? new Date(s.created_at).toLocaleString('ru-RU', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : '—'}
                            </td>
                            <td>№{s.id}</td>
                            <td className="name-cell">{wh}</td>
                            <td>{s.lines_count ?? '—'}</td>
                            <td>{formatInventorySessionNetRubList(s.net_amount_rub)}</td>
                            <td>{who}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={opLoading}
                                onClick={() => openInventoryEditFromSession(s.id)}
                              >
                                Редактировать
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {opMessage && mode === MODE_INVENTORY && !inventoryNewSession && (
                <div className="warehouse-ops-msg success" style={{ marginTop: 12 }}>
                  {opMessage}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Modal
        isOpen={mode === MODE_INVENTORY && inventoryNewSession}
        onClose={handleCloseInventoryWorkspace}
        title={
          inventoryEditingSessionId
                      ? `Редактирование инвентаризации №${inventoryEditingSessionId}`
            : 'Новая инвентаризация'
        }
        size="full"
        closeOnEscape={false}
        closeOnBackdropClick={false}
      >
        <div className="warehouse-ops-inventory-workspace">
                  <p className="warehouse-ops-hint">
            Каждое сканирование штрихкода — плюс 1 шт к фактическому количеству. Чтобы пригласить коллег с других
            устройств — включите «Совместный пересчёт» ниже.
                  </p>

              <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 12 }}>
                <label>
                  Склад инвентаризации <span className="warehouse-ops-required-star">*</span>
                </label>
                {inventoryLiveEnabled && inventoryLiveSessionId ? (
                  <div className="warehouse-ops-select" style={{ padding: '8px 0', fontSize: 14 }}>
                    {ownWarehouses.find((w) => String(w.id) === String(inventorySessionWarehouseId))?.address ||
                      ownWarehouses.find((w) => String(w.id) === String(inventorySessionWarehouseId))?.name ||
                      (inventorySessionWarehouseId ? `Склад #${inventorySessionWarehouseId}` : 'Загрузка…')}
                    {isInventoryLiveGuest ? (
                      <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                        Склад задан создателем общей инвентаризации
                      </span>
                    ) : null}
                  </div>
                ) : (
                <select
                  value={inventorySessionWarehouseId}
                  onChange={handleInventorySessionWarehouseChange}
                  className="warehouse-ops-select"
                  disabled={!!inventoryEditingSessionId}
                >
                  <option value="">— Выберите склад —</option>
                  {ownWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.address || w.name || `Склад #${w.id}`}
                    </option>
                  ))}
                </select>
                )}
              </div>

              {isInventoryLiveGuest && (
                <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
                  Вы приглашены в общую инвентаризацию: сканируйте товары — они попадут в общий список пересчёта.
                  Применить документ может только создатель.
                </p>
              )}

              {!isInventoryLiveGuest && (
                <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {!inventorySessionWarehouseId ? (
                    <span className="muted" style={{ fontSize: 13 }}>
                      Выберите склад для совместного пересчёта.
                    </span>
                  ) : !inventoryLiveEnabled || !inventoryLiveSessionId ? (
                    <Button
                      type="button"
                      onClick={enableInventoryLiveSession}
                      disabled={!inventorySessionWarehouseId || opLoading}
                    >
                      Включить совместный пересчёт
                    </Button>
                  ) : (
                    <>
                      <InviteUserButton
                        users={inviteUsers}
                        busy={inviteBusy}
                        excludeUserId={user?.id ?? user?.userId}
                        onInvite={async (uid) => {
                          const sid = String(inventoryLiveSessionId || '').trim();
                          if (!sid || inviteBusy) return;
                          try {
                            setInviteBusy(true);
                            await inventorySessionsApi.inviteToSession(sid, { userId: uid });
                            setOpMessage('Приглашение отправлено в уведомления.');
                          } catch (ex) {
                            setLookupError(
                              ex.response?.data?.message || ex.message || 'Не удалось отправить приглашение'
                            );
                          } finally {
                            setInviteBusy(false);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          leaveInventoryLiveSession(true);
                          if (!inventoryEditingSessionId) {
                            setInventoryNewRows([]);
                          }
                        }}
                      >
                        Выйти из совместного пересчёта
                      </Button>
                    </>
                  )}
                </div>
              )}

              <label className="warehouse-ops-checkbox-row" style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={inventoryZeroUnlisted}
                  onChange={(e) => setInventoryZeroUnlisted(e.target.checked)}
                />
                <span>
                  Обнулить остаток по товарам на складе, не попавшим в список пересчёта (списание непересчитанных)
                </span>
              </label>
              <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
                «В системе» и суммы пересчёта считаются по выбранному складу
                {inventoryEditingSessionId ? '' : '; при смене склада список строк очищается'}.
              </p>

              <p className="warehouse-ops-hint">Скан:</p>
              <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <FastScanInput
                  inputRef={inventoryNewScanInputRef}
                  onScan={handleInventoryScan}
                  debounceMs={160}
                  placeholder="Наведите сканер или введите штрихкод / артикул"
                  disabled={!inventorySessionWarehouseId}
                />
              </form>
              {!inventorySessionWarehouseId ? (
                <p className="warehouse-ops-hint" style={{ color: 'var(--danger, #ef4444)', marginTop: 8 }}>
                  Выберите склад выше — без склада сканирование недоступно.
                </p>
              ) : null}
              {lookupError ? (
                <div className="warehouse-ops-error" role="alert" style={{ marginTop: 10 }}>
                  {lookupError}
                </div>
              ) : null}
              {opMessage ? <div className="warehouse-ops-msg success" style={{ marginTop: 8 }}>{opMessage}</div> : null}

              <div className="warehouse-ops-list-form" style={{ marginTop: 16 }}>
                <form
                  className="warehouse-ops-list-row warehouse-ops-list-row--search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleInventoryNewAddFromSelect();
                  }}
                >
                  <label htmlFor="inventory-new-product-search">Товар:</label>
                  <ProductSearchInput
                    id="inventory-new-product-search"
                    value={inventoryNewSearch}
                    onChange={(v) => {
                      setInventoryNewSearch(v);
                      setInventoryNewPickedProduct(null);
                    }}
                    products={products}
                    placeholder="Штрихкод, артикул или название"
                    disabled={!inventorySessionWarehouseId}
                    onSelect={(p) => {
                      if (!p?.id) return;
                      setInventoryNewPickedProduct(p);
                      setInventoryNewSearch(formatProductOptionLabel(p));
                      addInventoryProductFromPick(p);
                    }}
                  />
                  <Button
                    type="button"
                    onClick={handleInventoryNewAddFromSelect}
                    disabled={
                      (!inventoryNewPickedProduct?.id &&
                        !normalizeProductSearchQuery(inventoryNewSearch)) ||
                      !inventorySessionWarehouseId
                    }
                  >
                    Добавить 1 шт
                  </Button>
                </form>
              </div>

              <h4 className="warehouse-ops-receipt-list-title" style={{ marginTop: 20 }}>
                Список пересчёта
              </h4>
              {inventoryNewRows.length === 0 ? (
                <p className="warehouse-ops-receipt-list-empty">Пока нет позиций. Сканируйте или добавьте из списка.</p>
              ) : (
                <>
                  <div className="warehouse-ops-receipt-list-wrap">
                    <table className="warehouse-ops-receipt-list-table table warehouse-ops-inventory-table">
                      <thead>
                        <tr>
                          <th>Артикул</th>
                          <th>Товар</th>
                          <th>В системе</th>
                          <th>Факт (пересчёт)</th>
                          <th className="num-cell">Себестоимость<br /><span className="warehouse-ops-th-sub">₽/шт</span></th>
                          <th className="num-cell">Излишек</th>
                          <th className="num-cell">Недостача</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {inventoryNewRowsSorted.map((row) => {
                          const unit = getInventoryUnitCostRub(row.product);
                          const delta = (row.fact ?? 0) - (row.current ?? 0);
                          let plusRub = null;
                          let minusRub = null;
                          if (unit != null) {
                            if (delta > 0) plusRub = delta * unit;
                            if (delta < 0) minusRub = -delta * unit;
                          }
                          return (
                            <tr key={row.product.id}>
                              <td className="sku-cell">{row.product.sku || '—'}</td>
                              <td className="name-cell">{row.product.name || '—'}</td>
                              <td>{row.current}</td>
                              <td>
                                <input
                                  type="number"
                                  min={0}
                                  value={row.fact}
                                  onChange={(e) => setInventoryNewFact(row.product.id, e.target.value)}
                                  className="warehouse-ops-qty-input small"
                                />
                              </td>
                              <td className="num-cell">{unit != null ? formatRub(unit) : '—'}</td>
                              <td className="num-cell warehouse-ops-inventory-plus">
                                {plusRub != null ? formatRub(plusRub) : '—'}
                              </td>
                              <td className="num-cell warehouse-ops-inventory-minus">
                                {minusRub != null ? formatRub(minusRub) : '—'}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="warehouse-ops-remove-btn"
                                  onClick={() => removeInventoryNewRow(row.product.id)}
                                  title="Убрать из пересчёта"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="warehouse-ops-inventory-totals">
                          <td colSpan={5} className="warehouse-ops-inventory-totals-label">
                            Итого по пересчёту (только позиции с указанной себестоимостью):
                          </td>
                          <td className="num-cell warehouse-ops-inventory-plus">
                            {formatRub(inventoryNewMoneyTotals.plus)}
                          </td>
                          <td className="num-cell warehouse-ops-inventory-minus">
                            {formatRub(inventoryNewMoneyTotals.minus)}
                          </td>
                          <td />
                        </tr>
                        <tr className="warehouse-ops-inventory-totals warehouse-ops-inventory-totals-net">
                          <td colSpan={5} className="warehouse-ops-inventory-totals-label">
                            Чистая разница (излишек − недостача):
                          </td>
                          <td colSpan={2} className="num-cell warehouse-ops-inventory-net">
                            {formatRub(inventoryNewMoneyTotals.net)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="warehouse-ops-receipt-list-actions">
                    <Button
                      onClick={applyInventoryNew}
                      disabled={opLoading || isInventoryLiveGuest}
                      title={isInventoryLiveGuest ? 'Применить может только создатель общей инвентаризации' : undefined}
                    >
                      {opLoading
                        ? 'Сохранение…'
                        : inventoryEditingSessionId
                          ? 'Сохранить изменения'
                          : 'Применить инвентаризацию'}
                    </Button>
                    <Button type="button" variant="secondary" onClick={clearInventoryNewRows} disabled={opLoading}>
                      Очистить список
                    </Button>
                  </div>
            </>
          )}
        </div>
      </Modal>

      {mode === MODE_TRANSFER && (
        <div className="warehouse-ops-panel transfer-panel">
          <p className="warehouse-ops-hint">
            Перенос свободного остатка между складами одной организации. Поиск товара: штрихкод, артикул или название.
            В журнале движений — две записи (списание со склада-источника и поступление на склад-получатель).
          </p>

          <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 12 }}>
            <div className="warehouse-ops-receipt-supplier-col">
              <label>
                Организация <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                className="form-select"
                value={transferOrganizationId}
                onChange={(e) => {
                  setTransferOrganizationId(e.target.value);
                  setTransferFromWarehouseId('');
                  setTransferToWarehouseId('');
                }}
              >
                <option value="">— выберите организацию —</option>
                {(organizations || []).map((org) => (
                  <option key={org.id} value={String(org.id)}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {transferOrganizationId && transferWarehouses.length < 2 && (
            <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
              Для перемещения нужны минимум два склада, привязанные к выбранной организации. Добавьте склад в настройках.
            </p>
          )}

          <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 12 }}>
            <div className="warehouse-ops-receipt-supplier-col">
              <label>
                Со склада <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                className="form-select"
                value={transferFromWarehouseId}
                onChange={(e) => setTransferFromWarehouseId(e.target.value)}
                disabled={!transferOrganizationId}
              >
                <option value="">— выберите —</option>
                {transferWarehouses.map((w) => (
                  <option key={w.id} value={String(w.id)}>
                    {transferWarehouseLabel(w)}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-col">
              <label>
                На склад <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                className="form-select"
                value={transferToWarehouseId}
                onChange={(e) => setTransferToWarehouseId(e.target.value)}
                disabled={!transferOrganizationId}
              >
                <option value="">— выберите —</option>
                {transferWarehouses.map((w) => (
                  <option key={w.id} value={String(w.id)}>
                    {transferWarehouseLabel(w)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {transferOrganizationId && (
            <div
              className={`warehouse-ops-transfer-route${
                transferFromWarehouseId && transferToWarehouseId ? '' : ' warehouse-ops-transfer-route--pending'
              }`}
            >
              {transferFromWarehouseId && transferToWarehouseId ? (
                <>
                  <span className="warehouse-ops-transfer-route-label">Маршрут:</span>
                  <strong>{transferWarehouseLabel(transferFromWarehouse)}</strong>
                  <span className="warehouse-ops-transfer-route-arrow">→</span>
                  <strong>{transferWarehouseLabel(transferToWarehouse)}</strong>
                </>
              ) : (
                <span className="warehouse-ops-transfer-route-hint">
                  Укажите склад-источник и склад-получатель перед добавлением товаров
                </span>
              )}
            </div>
          )}

          <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn" style={{ marginTop: 10 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <FastScanInput
                inputRef={transferScanInputRef}
                onScan={handleTransferScan}
                onManualQuery={handleTransferManualQuery}
                debounceMs={120}
                manualDebounceMs={250}
                placeholder="Скан: штрихкод / артикул / название"
                disabled={!transferOrganizationId}
                onBlur={() => {
                  setTimeout(() => {
                    if (suggestContext === 'transfer_scan') closeSuggest();
                  }, 120);
                }}
              />
              {suggestOpen && suggestContext === 'transfer_scan' && (
                <div className="warehouse-ops-suggest">
                  <div className="warehouse-ops-suggest-title">{suggestTitle || 'Выберите товар'}</div>
                  <div className="warehouse-ops-suggest-list">
                    {suggestList.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="warehouse-ops-suggest-item"
                        onMouseDown={(ev) => {
                          // onMouseDown чтобы input не потерял фокус до выбора
                          ev.preventDefault();
                          const fn = suggestOnPickRef.current;
                          if (fn) fn(p);
                          closeSuggest();
                        }}
                      >
                        <div className="warehouse-ops-suggest-sku">{p.sku || '—'}</div>
                        <div className="warehouse-ops-suggest-name">{p.name || '—'}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ width: 140 }}>
              <label>Кол-во:</label>
              <input
                type="number"
                className="form-control"
                min={1}
                value={transferQty}
                onChange={(e) => setTransferQty(e.target.value)}
              />
              <label style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#667085' }}>
                <input
                  type="checkbox"
                  checked={transferQuickMode}
                  onChange={(e) => setTransferQuickMode(Boolean(e.target.checked))}
                />
                Быстрый режим (по скану всегда 1 шт)
              </label>
            </div>
          </form>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14, alignItems: 'flex-end' }}>
            <div style={{ minWidth: 280, flex: 1 }}>
              <label>Товар (поиск):</label>
              <ProductSearchInput
                value={transferManualSearch}
                onChange={setTransferManualSearch}
                products={products}
                organizationId={transferOrganizationId}
                placeholder="Штрихкод, артикул, название"
                onSelect={(p) => {
                  if (!p) return;
                  addTransferItemFromProduct(p, transferQuickMode ? 1 : transferQty);
                  setTransferManualSearch('');
                }}
              />
            </div>
            <div style={{ width: 140 }}>
              <label>Кол-во (ручной выбор):</label>
              <input
                type="number"
                className="form-control"
                min={1}
                value={transferQty}
                onChange={(e) => setTransferQty(e.target.value)}
              />
            </div>
          </div>

          {transferList.length > 0 ? (
            <div className="warehouse-ops-receipts-list-wrap" style={{ marginTop: 12 }}>
              {transferFromWarehouseId && transferToWarehouseId && (
                <p className="warehouse-ops-transfer-list-route">
                  Перемещение:{' '}
                  <strong>{transferWarehouseLabel(transferFromWarehouse)}</strong>
                  {' → '}
                  <strong>{transferWarehouseLabel(transferToWarehouse)}</strong>
                </p>
              )}
              <table className="warehouse-ops-receipt-list-table table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Название</th>
                    <th className="text-end">Кол-во</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {transferList.map((row) => (
                    <tr key={row.productId}>
                      <td>{row.sku || '—'}</td>
                      <td>{row.name || '—'}</td>
                      <td className="text-end">{row.quantity}</td>
                      <td className="text-end">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => removeTransferItem(row.productId)}
                          disabled={opLoading}
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
            <p className="warehouse-ops-receipt-list-empty" style={{ marginTop: 12 }}>
              Добавьте товары в список перемещения.
            </p>
          )}

          {opMessage && mode === MODE_TRANSFER && (
            <div
              className={`warehouse-ops-msg ${
                String(opMessage).startsWith('Ошибка') ? 'error' : 'success'
              }`}
              style={{ marginTop: 12 }}
            >
              {opMessage}
            </div>
          )}

          <div className="warehouse-ops-receipt-list-actions" style={{ marginTop: 12 }}>
            <Button
              onClick={submitTransfer}
              disabled={
                opLoading ||
                !transferOrganizationId ||
                !transferFromWarehouseId ||
                !transferToWarehouseId ||
                transferFromWarehouseId === transferToWarehouseId
              }
            >
              {opLoading ? 'Перемещение…' : 'Выполнить перемещение'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setTransferList([])}
              disabled={opLoading}
            >
              Очистить список
            </Button>
          </div>
        </div>
      )}

      {mode === MODE_RECEIPTS_LIST && (
        <div className="warehouse-ops-panel receipts-list-panel">
          <div className="warehouse-ops-receipts-list-header">
            <div>
              <p className="warehouse-ops-hint">
                Поступления на склад (ПТ). Возвраты — в разделе «Возвраты».
                «Кол-во, шт» — сумма единиц по строкам; «Сумма, ₽» — по строкам с указанной себестоимостью.
              </p>
            </div>
            <Button onClick={openAddReceiptModal}>Добавить поступление</Button>
          </div>
          {renderWarehouseDocumentsList({
            title: '',
            emptyText: 'Нет приёмок.',
            showSupplier: true
          })}
        </div>
      )}

      <Modal
        isOpen={!!receiptDetail}
        onClose={() => setReceiptDetail(null)}
        title={receiptDetail
          ? (receiptDetail.document_type === 'return' ? 'Возврат ' : (receiptDetail.document_type === 'customer_return' ? 'Возврат от клиента ' : 'Приёмка ')) + (receiptDetail.receipt_number || receiptDetail.id)
          : 'Документ'}
        size="xl"
      >
        {receiptDetail && (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              {receiptDetail.created_at ? new Date(receiptDetail.created_at).toLocaleString('ru-RU') : ''}
              {receiptDetail.organization_name ? ` · Организация: ${receiptDetail.organization_name}` : ''}
              {receiptDetail.supplier_name ? ` · Поставщик: ${receiptDetail.supplier_name}` : ''}
            </p>
            {receiptDetail.lines && receiptDetail.lines.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Кол-во</th>
                      {receiptDetail.document_type !== 'return' && <th>Себестоимость, ₽</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {receiptDetail.lines.map(line => (
                      <tr key={line.id}>
                        <td className="sku-cell">{line.product_sku || '—'}</td>
                        <td className="name-cell">{line.product_name || '—'}</td>
                        <td>{line.quantity}</td>
                        {receiptDetail.document_type !== 'return' && (
                          <td>{line.cost != null ? Number(line.cost) : '—'}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="warehouse-ops-receipt-list-empty">Нет строк.</p>
            )}
            <div className="warehouse-ops-receipt-detail-actions" style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {receiptDetail.purchase_receipt_id &&
              String(receiptDetail.purchase_receipt_status) === 'scanning' &&
              receiptDetail.document_type !== 'return' &&
              receiptDetail.document_type !== 'customer_return' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const prId = receiptDetail.purchase_receipt_id;
                    const purchaseId = receiptDetail.purchase_id;
                    const params = new URLSearchParams();
                    params.set('purchase_receipt', String(prId));
                    if (purchaseId != null) params.set('purchase', String(purchaseId));
                    setReceiptDetail(null);
                    navigate(`/stock-levels/purchases?${params.toString()}`);
                  }}
                >
                  Редактировать приёмку
                </Button>
              ) : receiptDetail.purchase_receipt_id ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const prId = receiptDetail.purchase_receipt_id;
                    const purchaseId = receiptDetail.purchase_id;
                    const params = new URLSearchParams();
                    params.set('purchase_receipt', String(prId));
                    if (purchaseId != null) params.set('purchase', String(purchaseId));
                    setReceiptDetail(null);
                    navigate(`/stock-levels/purchases?${params.toString()}`);
                  }}
                >
                  Открыть в закупке
                </Button>
              ) : null}
              {!(
                receiptDetail.purchase_receipt_id &&
                String(receiptDetail.purchase_receipt_status) === 'scanning'
              ) ? (
                <Button variant="secondary" onClick={openReceiptEdit}>
                  Редактировать
                </Button>
              ) : null}
              <Button
                variant="danger"
                onClick={async () => {
                  if (!receiptDetail?.id) return;
                  const docLabel = receiptDetail.document_type === 'return' ? 'возврат' : (receiptDetail.document_type === 'customer_return' ? 'возврат от клиента' : 'приёмку');
                  if (!window.confirm(`Удалить ${docLabel} ${receiptDetail.receipt_number || receiptDetail.id}? Остатки будут пересчитаны.`)) return;
                  setReceiptDeleteLoading(true);
                  try {
                    await receiptsApi.delete(receiptDetail.id);
                    setReceiptDetail(null);
                    setLookupError(null);
                    loadReceiptsList();
                    onRefresh?.();
                  } catch (e) {
                    const msg = e.response?.data?.message || e.message || 'не удалось удалить';
                    setOpMessage('Ошибка: ' + msg);
                    setLookupError(msg);
                  } finally {
                    setReceiptDeleteLoading(false);
                  }
                }}
                disabled={receiptDeleteLoading}
              >
                {receiptDeleteLoading ? 'Удаление…' : 'Удалить'}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={receiptEditOpen}
        onClose={() => {
          if (receiptEditSaving) return;
          setReceiptEditOpen(false);
          setReceiptEditForm(null);
        }}
        title={
          receiptEditForm
            ? `Редактирование ${receiptEditForm.documentType === 'return' ? 'возврата' : receiptEditForm.documentType === 'customer_return' ? 'возврата от клиента' : 'приёмки'}`
            : 'Редактирование'
        }
        size="xl"
        closeOnBackdropClick={!receiptEditSaving}
        closeOnEscape={!receiptEditSaving}
      >
        {receiptEditForm && (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              Изменения пересчитают остатки на складе: старые движения отменяются, затем проводятся новые.
            </p>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={receiptEditForm.warehouseId}
                onChange={(e) => setReceiptEditForm((f) => ({ ...f, warehouseId: e.target.value }))}
                className="warehouse-ops-select"
                disabled={receiptEditSaving}
              >
                <option value="">— Выберите склад —</option>
                {ownWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
              <label>
                Организация <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={receiptEditForm.organizationId}
                onChange={(e) => setReceiptEditForm((f) => ({ ...f, organizationId: e.target.value }))}
                className="warehouse-ops-select"
                disabled={receiptEditSaving}
              >
                <option value="">— Выберите организацию —</option>
                {(organizations || []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || o.id}
                  </option>
                ))}
              </select>
            </div>
            {receiptEditForm.documentType !== 'customer_return' ? (
              <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
                <label>
                  Поставщик <span className="warehouse-ops-required-star">*</span>
                </label>
                <select
                  value={receiptEditForm.supplierId}
                  onChange={(e) => setReceiptEditForm((f) => ({ ...f, supplierId: e.target.value }))}
                  className="warehouse-ops-select"
                  disabled={receiptEditSaving}
                >
                  <option value="">— Выберите поставщика —</option>
                  {(suppliers || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.code || s.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="warehouse-ops-receipt-list-wrap" style={{ marginTop: 12 }}>
              <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th>Кол-во</th>
                    {receiptEditForm.documentType !== 'return' ? <th>Себестоимость, ₽</th> : null}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(receiptEditForm.lines || []).map((line, index) => (
                    <tr key={`${line.productId}-${index}`}>
                      <td className="sku-cell">{line.sku || '—'}</td>
                      <td className="name-cell">{line.name || '—'}</td>
                      <td>
                        <input
                          type="number"
                          min={1}
                          value={line.quantity}
                          onChange={(e) => updateReceiptEditLine(index, 'quantity', e.target.value)}
                          className="warehouse-ops-qty-input small"
                          disabled={receiptEditSaving}
                        />
                      </td>
                      {receiptEditForm.documentType !== 'return' ? (
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.cost}
                            onChange={(e) => updateReceiptEditLine(index, 'cost', e.target.value)}
                            className="warehouse-ops-qty-input small"
                            disabled={receiptEditSaving}
                          />
                        </td>
                      ) : null}
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={() => removeReceiptEditLine(index)}
                          disabled={receiptEditSaving || (receiptEditForm.lines || []).length <= 1}
                        >
                          Удалить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={saveReceiptEdit} disabled={receiptEditSaving}>
                {receiptEditSaving ? 'Сохранение…' : 'Сохранить'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setReceiptEditOpen(false);
                  setReceiptEditForm(null);
                }}
                disabled={receiptEditSaving}
              >
                Отмена
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={!!inventoryDetailView?.session}
        onClose={() => setInventoryDetailView(null)}
        title={
          inventoryDetailView?.session?.id
            ? `Инвентаризация №${inventoryDetailView.session.id}${
                inventoryDetailView.session.warehouse_label ||
                inventoryDetailView.session.warehouseLabel
                  ? ` · ${
                      inventoryDetailView.session.warehouse_label ||
                      inventoryDetailView.session.warehouseLabel
                    }`
                  : ''
              }`
            : 'Инвентаризация'
        }
        size="xl"
      >
        {inventoryDetailView?.session && (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              {inventoryDetailView.session.created_at
                ? new Date(inventoryDetailView.session.created_at).toLocaleString('ru-RU')
                : ''}
              {inventoryDetailView.session.lines_count != null
                ? ` · Позиций: ${inventoryDetailView.session.lines_count}`
                : ''}
              {inventoryDetailView.session.warehouse_label ||
              inventoryDetailView.session.warehouseLabel
                ? ` · Склад: ${
                    inventoryDetailView.session.warehouse_label ||
                    inventoryDetailView.session.warehouseLabel
                  }`
                : inventoryDetailView.session.warehouse_id != null
                  ? ` · Склад №${inventoryDetailView.session.warehouse_id}`
                  : ''}
            </p>
            {Array.isArray(inventoryDetailView.lines) && inventoryDetailView.lines.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table warehouse-ops-inventory-table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Было</th>
                      <th>Стало</th>
                      <th className="num-cell">
                        Себестоимость
                        <br />
                        <span className="warehouse-ops-th-sub">₽/шт</span>
                      </th>
                      <th className="num-cell">Излишек</th>
                      <th className="num-cell">Недостача</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryDetailView.lines.map((line) => {
                      const unit = getInventoryUnitCostRub({
                        cost: line.product_cost ?? line.productCost
                      });
                      const before = Number(line.quantity_before ?? 0);
                      const after = Number(line.quantity_after ?? 0);
                      const delta = after - before;
                      let plusRub = null;
                      let minusRub = null;
                      if (unit != null) {
                        if (delta > 0) plusRub = delta * unit;
                        if (delta < 0) minusRub = -delta * unit;
                      }
                      return (
                        <tr key={line.id}>
                          <td className="sku-cell">{line.product_sku || '—'}</td>
                          <td className="name-cell">{line.product_name || '—'}</td>
                          <td>{line.quantity_before}</td>
                          <td>{line.quantity_after}</td>
                          <td className="num-cell">{unit != null ? formatRub(unit) : '—'}</td>
                          <td className="num-cell warehouse-ops-inventory-plus">
                            {plusRub != null ? formatRub(plusRub) : '—'}
                          </td>
                          <td className="num-cell warehouse-ops-inventory-minus">
                            {minusRub != null ? formatRub(minusRub) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="warehouse-ops-inventory-totals">
                      <td colSpan={5} className="warehouse-ops-inventory-totals-label">
                        Итого (по строкам с себестоимостью в карточке на момент просмотра):
                      </td>
                      <td className="num-cell warehouse-ops-inventory-plus">
                        {formatRub(inventorySavedMoneyTotals.plus)}
                      </td>
                      <td className="num-cell warehouse-ops-inventory-minus">
                        {formatRub(inventorySavedMoneyTotals.minus)}
                      </td>
                    </tr>
                    <tr className="warehouse-ops-inventory-totals warehouse-ops-inventory-totals-net">
                      <td colSpan={5} className="warehouse-ops-inventory-totals-label">
                        Чистая разница (излишек − недостача):
                      </td>
                      <td colSpan={2} className="num-cell warehouse-ops-inventory-net">
                        {formatRub(inventorySavedMoneyTotals.net)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="warehouse-ops-receipt-list-empty">Нет строк.</p>
            )}
            <p className="warehouse-ops-hint" style={{ marginTop: 16 }}>
              Удаление отменяет эффект документа: к текущим остаткам добавляется обратная поправка (было
              минус стало по каждой строке), в журнал пишется запись, затем документ удаляется.
            </p>
            <div className="warehouse-ops-receipt-detail-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={startInventoryEdit} disabled={opLoading || inventoryDeleteLoading}>
                Редактировать
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (!inventoryDetailView?.session?.id) return;
                  if (
                    !window.confirm(
                      `Удалить инвентаризацию №${inventoryDetailView.session.id} и откатить остатки по её строкам?`
                    )
                  ) {
                    return;
                  }
                  setInventoryDeleteLoading(true);
                  try {
                    await inventorySessionsApi.delete(inventoryDetailView.session.id);
                    setInventoryDetailView(null);
                    loadInventorySessions();
                    onRefresh?.();
                    setOpMessage('Инвентаризация удалена, остатки пересчитаны.');
                  } catch (e) {
                    setOpMessage(
                      'Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось удалить')
                    );
                  } finally {
                    setInventoryDeleteLoading(false);
                  }
                }}
                disabled={inventoryDeleteLoading}
              >
                {inventoryDeleteLoading ? 'Удаление…' : 'Удалить инвентаризацию'}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        isOpen={productPickOpen}
        onClose={closeProductPick}
        title={productPickTitle || 'Выберите товар'}
        size="xl"
      >
        <div className="warehouse-ops-product-pick">
          {Array.isArray(productPickList) && productPickList.length > 0 ? (
            <div className="warehouse-ops-receipt-list-wrap">
              <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th>Наличие</th>
                    <th>Ожидается</th>
                    <th>Резерв</th>
                  </tr>
                </thead>
                <tbody>
                  {productPickList.map((p) => (
                    <tr
                      key={p.id ?? `${p.sku || ''}-${p.name || ''}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        try {
                          const fn = productPickOnPickRef.current;
                          if (typeof fn === 'function') fn(p);
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      <td className="sku-cell">{p.sku || '—'}</td>
                      <td className="name-cell">{p.name || '—'}</td>
                      <td>{p.quantity ?? 0}</td>
                      <td>{p.incoming_quantity ?? p.incomingQuantity ?? 0}</td>
                      <td>{p.reserved_quantity ?? p.reservedQuantity ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="warehouse-ops-receipt-list-empty">Нет подходящих товаров.</p>
          )}
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={closeProductPick}>Закрыть</Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={addReceiptModalOpen}
        onClose={() => setAddReceiptModalOpen(false)}
        title="Добавить поступление"
        size="xl"
        closeOnBackdropClick={false}
        closeOnEscape={false}
      >
        <div className="warehouse-ops-panel receipt-panel" style={{ marginBottom: 0 }}>
          <div className="warehouse-ops-receipt-supplier-row">
            <label>
              Склад приёмки <span className="warehouse-ops-required-star">*</span>
            </label>
            {receiptSessionEnabled && receiptSessionId ? (
              <div className="warehouse-ops-select" style={{ padding: '8px 0', fontSize: 14 }}>
                {receiptWarehouseLabel || (receiptWarehouseId ? `Склад #${receiptWarehouseId}` : 'Загрузка…')}
                {isReceiptSessionGuest ? (
                  <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    Склад задан создателем общей приёмки
                  </span>
                ) : null}
              </div>
            ) : (
            <select
              value={receiptWarehouseId}
              onChange={(e) => setReceiptWarehouseId(e.target.value)}
              className="warehouse-ops-select"
            >
              <option value="">— Выберите склад —</option>
              {ownWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.address || w.name || `Склад #${w.id}`}
                </option>
              ))}
            </select>
            )}
          </div>
          <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
            <label>
              Организация <span className="warehouse-ops-required-star">*</span>
            </label>
            <select
              value={receiptOrganizationId}
              onChange={(e) => setReceiptOrganizationId(e.target.value)}
              className="warehouse-ops-select"
            >
              <option value="">— Выберите организацию —</option>
              {(organizations || []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || o.id}
                </option>
              ))}
            </select>
          </div>
          <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
            <label>
              Поставщик <span className="warehouse-ops-required-star">*</span>
            </label>
            <select
              value={receiptSupplierId}
              onChange={(e) => setReceiptSupplierId(e.target.value)}
              className="warehouse-ops-select"
            >
              <option value="">— Выберите поставщика —</option>
              {(suppliers || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.code || s.id}
                </option>
              ))}
            </select>
          </div>
          {isReceiptSessionGuest && (
            <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
              Вы приглашены в общую приёмку: сканируйте товары — они попадут в общий список. Оформить документ может только создатель.
            </p>
          )}
          {!isReceiptSessionGuest && (
          <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
            <label className="warehouse-ops-radio" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={receiptSessionEnabled}
                onChange={async (e) => {
                  const on = !!e.target.checked;
                  setLookupError(null);
                  setOpMessage(null);
                  setReceiptSessionEnabled(on);
                  if (!on) {
                    leaveReceiptSession();
                    return;
                  }
                  if (!receiptWarehouseId) {
                    setLookupError('Сначала выберите склад приёмки');
                    setReceiptSessionEnabled(false);
                    return;
                  }
                  try {
                    const created = await receiptsApi.createSession({ warehouseId: Number(receiptWarehouseId) });
                    const d = created?.data ?? created;
                    const sid = String(d?.sessionId || '').trim();
                    if (sid) {
                      setReceiptSessionId(sid);
                      applySessionStateToList(created);
                    }
                  } catch (ex) {
                    setLookupError(ex.response?.data?.message || ex.message || 'Не удалось создать общую приёмку');
                    setReceiptSessionEnabled(false);
                    setReceiptSessionId('');
                  }
                }}
              />
              <span>Общая приёмка (несколько устройств)</span>
            </label>
          </div>
          )}
          {receiptSessionEnabled && receiptSessionId && (
            <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 6 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  leaveReceiptSession();
                  setAddReceiptModalOpen(false);
                }}
              >
                Выйти из общей приёмки
              </Button>
              <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                Приглашённые пользователи могут только выйти; оформить поступление может только создатель.
              </span>
            </div>
          )}
          {receiptSessionEnabled && receiptSessionId && !isReceiptSessionGuest && (
            <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 8 }}>
              <InviteUserButton
                users={inviteUsers}
                busy={inviteBusy}
                excludeUserId={user?.id ?? user?.userId}
                onInvite={async (uid) => {
                  const sid = String(receiptSessionId || '').trim();
                  if (!sid || inviteBusy) return;
                  try {
                    setInviteBusy(true);
                    setLookupError(null);
                    await receiptsApi.inviteToSession(sid, { userId: uid });
                    setOpMessage('Приглашение отправлено в уведомления.');
                  } catch (ex) {
                    setLookupError(ex.response?.data?.message || ex.message || 'Не удалось отправить приглашение');
                  } finally {
                    setInviteBusy(false);
                  }
                }}
              />
            </div>
          )}
          <div className="warehouse-ops-receipt-modes">
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="receiptModeModal"
                checked={receiptMode === 'scan'}
                onChange={() => setReceiptMode('scan')}
              />
              <span>По скану — 1 скан = 1 шт</span>
            </label>
            <label className="warehouse-ops-radio">
              <input
                type="radio"
                name="receiptModeModal"
                checked={receiptMode === 'list'}
                onChange={() => setReceiptMode('list')}
              />
              <span>Из списка — выбор товара и количество</span>
            </label>
          </div>

          {receiptMode === 'scan' && (
            <>
              <p className="warehouse-ops-hint">Отсканируйте штрихкод — товар добавится в список (1 скан = 1 шт).</p>
              <form onSubmit={(e) => e.preventDefault()} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <FastScanInput
                  inputRef={scanInputRef}
                  onScan={handleReceiptScan}
                  debounceMs={160}
                  placeholder="Наведите сканер сюда"
                  disabled={!receiptWarehouseId}
                />
              </form>
            </>
          )}

          <div style={{ marginTop: 10 }}>
            <p className="warehouse-ops-hint" style={{ marginBottom: 6 }}>
              Коробкой: отсканируйте товар выше (идентификация), укажите количество в коробке — через 2 с установим это количество в списке и вернём фокус в поле скана.
            </p>
            <form
              onSubmit={(e) => e.preventDefault()}
              className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
            >
              <input
                type="text"
                className="warehouse-ops-scan-input"
                placeholder="ШК или артикул (необязательно после скана)"
                value={boxAddCode}
                onChange={(e) => {
                  const code = e.target.value;
                  setBoxAddCode(code);
                  scheduleWarehouseBoxQtyApply(boxAddQty, code);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                disabled={!receiptWarehouseId || boxAddBusy}
                autoComplete="off"
                spellCheck={false}
              />
              <input
                type="number"
                min={1}
                step={1}
                className="warehouse-ops-qty-input"
                style={{ width: 120 }}
                placeholder="Кол-во"
                value={boxAddQty}
                onChange={(e) => {
                  const qty = e.target.value;
                  setBoxAddQty(qty);
                  scheduleWarehouseBoxQtyApply(qty, boxAddCode);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                disabled={!receiptWarehouseId || boxAddBusy}
              />
            </form>
          </div>

          {receiptMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row warehouse-ops-list-row--search">
                <label htmlFor="receipt-modal-product-search">Товар:</label>
                <ProductSearchInput
                  id="receipt-modal-product-search"
                  value={receiptListSearch}
                  onChange={(v) => {
                    setReceiptListSearch(v);
                    setReceiptPickedProduct(null);
                    setSelectedProductId('');
                  }}
                  products={products}
                  placeholder="Штрихкод, артикул или название"
                  disabled={!receiptWarehouseId}
                  onSelect={(p) =>
                    pickListProduct(p, {
                      setProduct: setReceiptPickedProduct,
                      setSearch: setReceiptListSearch,
                      setId: setSelectedProductId,
                    })
                  }
                />
              </div>
              <div className="warehouse-ops-list-row">
                <label>Количество:</label>
                <input
                  type="number"
                  min={1}
                  value={listQty}
                  onChange={e => setListQty(e.target.value)}
                  className="warehouse-ops-qty-input"
                />
                <Button
                  onClick={handleReceiptFromList}
                  disabled={(!receiptPickedProduct && !selectedProductId) || !receiptWarehouseId}
                >
                  В список
                </Button>
              </div>
            </div>
          )}

          {lookupError && <div className="warehouse-ops-error">{lookupError}</div>}
          {opMessage && <div className="warehouse-ops-msg success">{opMessage}</div>}

          <div className="warehouse-ops-receipt-list-section">
            <h4 className="warehouse-ops-receipt-list-title">Список товаров для поступления</h4>
            {receiptList.length === 0 ? (
              <p className="warehouse-ops-receipt-list-empty">Список пуст. Сканируйте товары или добавляйте из списка выше.</p>
            ) : (
              <>
                <div className="warehouse-ops-receipt-list-wrap">
                  <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Товар</th>
                        <th>Кол-во</th>
                        <th>Себестоимость, ₽</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptList.map((item, index) => (
                        <tr key={`${item.productId}-${index}`}>
                          <td className="sku-cell">{item.sku}</td>
                          <td className="name-cell">{item.name}</td>
                          <td>
                            <input
                              type="number"
                              min={1}
                              value={item.quantity}
                              onChange={e => updateReceiptQuantity(index, e.target.value)}
                              className="warehouse-ops-qty-input small"
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              placeholder="—"
                              value={item.cost ?? ''}
                              onChange={e => updateReceiptCost(index, e.target.value)}
                              className="warehouse-ops-cost-input"
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="warehouse-ops-remove-btn"
                              onClick={() => removeFromReceiptList(index)}
                              title="Удалить из списка"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="warehouse-ops-receipt-cost-hint">Если указана себестоимость, она будет сохранена в карточке товара.</p>
                <div className="warehouse-ops-receipt-list-actions">
                  <Button
                    onClick={applyReceiptList}
                    disabled={opLoading || isReceiptSessionGuest}
                    title={
                      isReceiptSessionGuest
                        ? 'Оформить может только создатель общей приёмки'
                        : undefined
                    }
                  >
                    {opLoading ? 'Оформление…' : 'Оформить поступление'}
                  </Button>
                  <Button variant="secondary" onClick={clearReceiptList} disabled={opLoading}>
                    Очистить список
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>

      {mode === MODE_TABLE && null}

      <LinkBarcodeToProductModal
        isOpen={linkBarcodeModalOpen}
        onClose={closeLinkBarcodeModal}
        barcode={linkBarcodeScanned}
        products={products}
        onLinked={handleLinkBarcodeLinked}
      />
    </div>
  );
}

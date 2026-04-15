/**
 * Операции склада: поступление (по скану), списание, инвентаризация
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { LinkBarcodeToProductModal } from '../../components/common/LinkBarcodeToProductModal/LinkBarcodeToProductModal';
import { productsApi } from '../../services/products.api';
import { stockMovementsApi } from '../../services/stockMovements.api';
import { receiptsApi } from '../../services/receipts.api';
import { inventorySessionsApi } from '../../services/inventorySessions.api';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import './WarehouseOperations.css';

const MODE_TABLE = 'table';
const MODE_RECEIPT = 'receipt';
const MODE_WRITEOFF = 'writeoff';
const MODE_INVENTORY = 'inventory';
const MODE_RECEIPTS_LIST = 'receipts_list';
const MODE_RETURN_SUPPLIER = 'return_supplier';
const MODE_RETURN_CUSTOMER = 'return_customer';

const KNOWN_MODES = new Set([
  MODE_TABLE,
  MODE_RECEIPTS_LIST,
  MODE_WRITEOFF,
  MODE_RETURN_SUPPLIER,
  MODE_RETURN_CUSTOMER,
  MODE_INVENTORY,
  MODE_RECEIPT
]);

export function WarehouseOperations({
  products,
  mainWarehouseName,
  /** Выбранный склад на вкладке «Остатки» (подсказка для полей склада) */
  inventoryWarehouseId,
  /** Перезагрузить товары с фильтром по складу (для пересчёта «в системе» при инвентаризации) */
  reloadProductsWithWarehouse,
  onRefresh,
  loading,
  activeTab,
  onTabChange,
  openReceiptId,
  /** Спрятать внутреннюю полосу вкладок (вкладки вынесены в StockLevelsLayout) */
  hideTabs = false
}) {
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
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
  const [scanValue, setScanValue] = useState('');
  const [foundProduct, setFoundProduct] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [qtyInput, setQtyInput] = useState(1);
  const [opLoading, setOpLoading] = useState(false);
  const [opMessage, setOpMessage] = useState(null);
  const [inventorySessionsList, setInventorySessionsList] = useState([]);
  const [inventorySessionsLoading, setInventorySessionsLoading] = useState(false);
  const [inventoryDetailView, setInventoryDetailView] = useState(null);
  const scanInputRef = useRef(null);
  const [receiptMode, setReceiptMode] = useState('scan');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [listQty, setListQty] = useState(1);
  const [receiptSupplierId, setReceiptSupplierId] = useState('');
  const [receiptOrganizationId, setReceiptOrganizationId] = useState('');
  /** Обязательный склад приёмки (поступление / возвраты) */
  const [receiptWarehouseId, setReceiptWarehouseId] = useState('');
  const [returnWarehouseId, setReturnWarehouseId] = useState('');
  const [customerReturnWarehouseId, setCustomerReturnWarehouseId] = useState('');
  // Список для поступления: { productId, sku, name, quantity, cost }
  const [receiptList, setReceiptList] = useState([]);
  const scanDebounceRef = useRef(null);
  const scanValueRef = useRef('');
  const manualSearchDebounceRef = useRef(null);
  const [receiptsList, setReceiptsList] = useState([]);
  const [receiptsTotal, setReceiptsTotal] = useState(0);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState(null);
  const [addReceiptModalOpen, setAddReceiptModalOpen] = useState(false);
  const [receiptDeleteLoading, setReceiptDeleteLoading] = useState(false);
  const [inventoryDeleteLoading, setInventoryDeleteLoading] = useState(false);
  // Возврат поставщику: организация, поставщик и список { productId, sku, name, quantity }
  const [returnOrganizationId, setReturnOrganizationId] = useState('');
  const [returnSupplierId, setReturnSupplierId] = useState('');
  const [returnList, setReturnList] = useState([]);
  const [returnMode, setReturnMode] = useState('scan');
  const [returnScanValue, setReturnScanValue] = useState('');
  const [returnSelectedProductId, setReturnSelectedProductId] = useState('');
  const [returnListQty, setReturnListQty] = useState(1);
  const returnScanDebounceRef = useRef(null);
  const returnScanValueRef = useRef('');
  const returnScanInputRef = useRef(null);
  // Возврат от клиентов на склад
  const [customerReturnOrganizationId, setCustomerReturnOrganizationId] = useState('');
  const [customerReturnList, setCustomerReturnList] = useState([]);
  const [customerReturnMode, setCustomerReturnMode] = useState('scan');
  const [customerReturnScanValue, setCustomerReturnScanValue] = useState('');
  const [customerReturnSelectedProductId, setCustomerReturnSelectedProductId] = useState('');
  const [customerReturnListQty, setCustomerReturnListQty] = useState(1);
  const customerReturnScanDebounceRef = useRef(null);
  const customerReturnScanValueRef = useRef('');
  const customerReturnScanInputRef = useRef(null);
  /** Пересчёт выборочно: скан / поиск + только отмеченные позиции */
  const [inventoryNewSession, setInventoryNewSession] = useState(false);
  const [inventoryNewRows, setInventoryNewRows] = useState([]);
  const [inventoryNewScanValue, setInventoryNewScanValue] = useState('');
  const [inventoryNewSelectedProductId, setInventoryNewSelectedProductId] = useState('');
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

  const normalizeQuery = (value) => String(value || '').trim();
  const isLikelyBarcodeScan = (raw) => {
    const v = String(raw || '').trim();
    if (!v) return false;
    if (/[a-zа-я]/i.test(v)) return false;
    return /^\d{6,}$/.test(v);
  };
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
  const findLocalMatches = useCallback((query) => {
    const q = normalizeQuery(query).toLowerCase();
    if (!q) return [];
    // Точное совпадение SKU — приоритетнее (часто сканер/ручной ввод артикула).
    const exactSku = (products || []).filter((p) => String(p?.sku || '').trim().toLowerCase() === q);
    if (exactSku.length) return exactSku;
    // Иначе — частичное по SKU/названию.
    const scored = (products || [])
      .map((p) => {
        const sku = String(p?.sku || '').toLowerCase();
        const name = String(p?.name || '').toLowerCase();
        const hitSku = sku.includes(q);
        const hitName = name.includes(q);
        if (!hitSku && !hitName) return null;
        const score = (hitSku ? 2 : 0) + (hitName ? 1 : 0) + (sku.startsWith(q) ? 1 : 0);
        return { p, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.p).slice(0, 30);
  }, [products]);

  const lookupProductByAny = useCallback(async (value, { title = 'Выберите товар', allowLinkBarcode = false } = {}) => {
    const v = normalizeQuery(value);
    if (!v) {
      throw new Error('Введите штрихкод / артикул / название');
    }
    // 1) Штрихкод — самый точный (быстро и однозначно).
    try {
      const res = await productsApi.getByBarcode(v);
      const product = res?.data ?? res;
      if (product && (product.id || product.sku)) return product;
    } catch (_) {
      // ignore → fallback
    }

    // 2) Локальный поиск по SKU/названию (по уже загруженному списку).
    const matches = findLocalMatches(v);
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
  }, [findLocalMatches, openProductPick, closeProductPick, openLinkBarcode]);

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
  const inventoryNewScanValueRef = useRef('');
  const inventoryNewScanInputRef = useRef(null);
  /** Склад, по которому ведётся новая инвентаризация (обязателен до сохранения) */
  const [inventorySessionWarehouseId, setInventorySessionWarehouseId] = useState('');

  const loadReceiptsList = useCallback(() => {
    setReceiptsLoading(true);
    receiptsApi.getList({ limit: 200 })
      .then(({ list, total }) => {
        setReceiptsList(Array.isArray(list) ? list : []);
        setReceiptsTotal(typeof total === 'number' ? total : (Array.isArray(list) ? list.length : 0));
      })
      .catch(err => {
        console.warn('[WarehouseOperations] loadReceiptsList failed:', err?.message || err);
        setReceiptsList([]);
      })
      .finally(() => setReceiptsLoading(false));
  }, []);

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
    if (mode === MODE_WRITEOFF) scanInputRef.current?.focus();
    if (mode === MODE_RETURN_SUPPLIER) returnScanInputRef.current?.focus();
    if (mode === MODE_RETURN_CUSTOMER) customerReturnScanInputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    return () => {
      if (returnScanDebounceRef.current) clearTimeout(returnScanDebounceRef.current);
      if (customerReturnScanDebounceRef.current) clearTimeout(customerReturnScanDebounceRef.current);
      if (inventoryNewScanDebounceRef.current) clearTimeout(inventoryNewScanDebounceRef.current);
      if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
      if (manualSearchDebounceRef.current) clearTimeout(manualSearchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (addReceiptModalOpen && receiptMode === 'scan') {
      const t = setTimeout(() => scanInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [addReceiptModalOpen, receiptMode]);

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
      setInventoryNewScanValue('');
      setInventoryNewSearch('');
      setInventoryNewSelectedProductId('');
      setInventoryDetailView(null);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== MODE_INVENTORY || !inventoryNewSession) return;
    const t = setTimeout(() => inventoryNewScanInputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [mode, inventoryNewSession]);

  const inventoryNewFilteredProducts = useMemo(() => {
    const q = (inventoryNewSearch || '').trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => {
      const sku = (p.sku || '').toString().toLowerCase();
      const name = (p.name || '').toString().toLowerCase();
      return sku.includes(q) || name.includes(q);
    });
  }, [products, inventoryNewSearch]);

  useEffect(() => {
    if (mode !== MODE_RECEIPTS_LIST) return;
    loadReceiptsList();
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
      // Поступление по скану: 1 скан = 1 шт — сразу ищем и добавляем 1
      lookupByBarcodeOrSkuThenReceiptOne(scanValue);
    } else {
      lookupByBarcodeOrSku(scanValue);
    }
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

  /** Поступление по скану: 1 скан = +1 шт в список (без сохранения в БД) */
  const lookupByBarcodeOrSkuThenReceiptOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      return;
    }
    if (!receiptWarehouseId) {
      setLookupError('Сначала выберите склад приёмки');
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для поступления', allowLinkBarcode: true });
      addToReceiptList(product, 1);
      setOpMessage(`В список: +1 шт — ${product.name || product.sku}`);
      setScanValue('');
      scanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
    }
  };

  /** Добавить выбранный товар в список поступления (из списка) */
  const handleReceiptFromList = () => {
    if (!receiptWarehouseId) {
      setOpMessage('Выберите склад приёмки');
      return;
    }
    const id = String(selectedProductId || '').trim();
    if (!id) {
      setOpMessage('Выберите товар');
      return;
    }
    const product = products.find(p => String(p.id) === id);
    if (!product) {
      setOpMessage('Товар не найден');
      return;
    }
    const add = Math.max(1, parseInt(listQty, 10) || 1);
    addToReceiptList(product, add);
    setOpMessage(`В список: ${product.name} — ${add} шт`);
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
    setOpLoading(true);
    setOpMessage(null);
    try {
      const organizationId = receiptOrganizationId ? Number(receiptOrganizationId) : null;
      const supplierId = receiptSupplierId ? Number(receiptSupplierId) : null;
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

  /** Обработка ввода в поле скана: авто-добавление через короткую паузу (сканер вводит быстро, без Enter) */
  const handleReceiptScanChange = (e) => {
    const value = e.target.value;
    scanValueRef.current = value;
    setScanValue(value);
    setLookupError(null);

    if (scanDebounceRef.current) {
      clearTimeout(scanDebounceRef.current);
      scanDebounceRef.current = null;
    }
    if (!value.trim()) return;

    const SCAN_DELAY_MS = 200;
    scanDebounceRef.current = setTimeout(() => {
      scanDebounceRef.current = null;
      const toProcess = scanValueRef.current.trim();
      if (!toProcess) return;
      lookupByBarcodeOrSkuThenReceiptOne(toProcess);
      setScanValue('');
      scanValueRef.current = '';
      scanInputRef.current?.focus();
    }, SCAN_DELAY_MS);
  };

  const handleWriteOff = async () => {
    if (!foundProduct) return;
    const sub = Math.max(1, parseInt(qtyInput, 10) || 1);
    const current = foundProduct.quantity ?? 0;
    setOpLoading(true);
    setOpMessage(null);
    try {
      await stockMovementsApi.applyChange(foundProduct.id, {
        delta: -sub,
        type: 'writeoff',
        reason: 'Списание со склада'
      });
      setOpMessage(`Списано ${sub} шт.`);
      onRefresh?.();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'не удалось обновить'));
    } finally {
      setOpLoading(false);
    }
  };

  /** Добавить товар в список возврата поставщику (qty ограничено остатком на складе) */
  const addToReturnList = (product, add) => {
    const maxQty = Math.max(0, product.quantity ?? 0);
    const qty = Math.min(Math.max(1, parseInt(add, 10) || 1), maxQty);
    if (qty < 1) return;
    const id = product.id;
    setReturnList(prev => {
      const existing = prev.find(item => String(item.productId) === String(id));
      if (existing) {
        const newQty = Math.min(existing.quantity + qty, maxQty);
        if (newQty <= 0) return prev;
        return prev.map(item =>
          String(item.productId) === String(id) ? { ...item, quantity: newQty } : item
        );
      }
      return [...prev, { productId: id, sku: product.sku || '—', name: product.name || 'Без названия', quantity: qty }];
    });
  };

  /** По скану: 1 скан = +1 в список возврата */
  const lookupByBarcodeOrSkuThenReturnOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      return;
    }
    if (!returnWarehouseId) {
      setLookupError('Сначала выберите склад списания');
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для возврата поставщику' });
      const available = product.quantity ?? 0;
      if (available < 1) {
        setLookupError('Нет остатка на складе');
        return;
      }
      addToReturnList(product, 1);
      setOpMessage(`В список возврата: +1 шт — ${product.name || product.sku}`);
      setReturnScanValue('');
      returnScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
    }
  };

  const handleReturnScanChange = (e) => {
    const value = e.target.value;
    returnScanValueRef.current = value;
    setReturnScanValue(value);
    setLookupError(null);
    if (returnScanDebounceRef.current) {
      clearTimeout(returnScanDebounceRef.current);
      returnScanDebounceRef.current = null;
    }
    if (!value.trim()) return;
    const SCAN_DELAY_MS = 200;
    returnScanDebounceRef.current = setTimeout(() => {
      returnScanDebounceRef.current = null;
      const toProcess = returnScanValueRef.current.trim();
      if (!toProcess) return;
      lookupByBarcodeOrSkuThenReturnOne(toProcess);
      setReturnScanValue('');
      returnScanValueRef.current = '';
      returnScanInputRef.current?.focus();
    }, SCAN_DELAY_MS);
  };

  const handleReturnFromList = () => {
    if (!returnWarehouseId) {
      setOpMessage('Выберите склад списания');
      return;
    }
    const id = String(returnSelectedProductId || '').trim();
    if (!id) {
      setOpMessage('Выберите товар');
      return;
    }
    const product = products.find(p => String(p.id) === id);
    if (!product) {
      setOpMessage('Товар не найден');
      return;
    }
    const add = Math.max(1, parseInt(returnListQty, 10) || 1);
    addToReturnList(product, add);
    setOpMessage(`В список возврата: ${product.name} — ${add} шт`);
  };

  const removeFromReturnList = (index) => {
    setReturnList(prev => prev.filter((_, i) => i !== index));
  };

  const updateReturnQuantity = (index, value) => {
    const num = parseInt(value, 10);
    const item = returnList[index];
    if (!item) return;
    const product = products.find(p => String(p.id) === String(item.productId));
    const maxQty = Math.max(0, product?.quantity ?? 0);
    const qty = Math.min(isNaN(num) || num < 1 ? 1 : num, maxQty);
    setReturnList(prev =>
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
      const lines = returnList.map(l => ({
        productId: l.productId,
        quantity: Math.min(l.quantity, products.find(p => String(p.id) === String(l.productId))?.quantity ?? 0)
      })).filter(l => l.quantity > 0);
      if (lines.length === 0) {
        setOpMessage('Нет позиций для возврата (проверьте остатки)');
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
      setReturnList([]);
      onRefresh?.();
      loadReceiptsList();
      setMode(MODE_RECEIPTS_LIST);
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
    setCustomerReturnList(prev => {
      const existing = prev.find(item => String(item.productId) === String(id));
      if (existing) {
        return prev.map(item =>
          String(item.productId) === String(id) ? { ...item, quantity: existing.quantity + qty } : item
        );
      }
      return [...prev, { productId: id, sku: product.sku || '—', name: product.name || 'Без названия', quantity: qty }];
    });
  };

  const lookupByBarcodeOrSkuThenCustomerReturnOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      return;
    }
    if (!customerReturnWarehouseId) {
      setLookupError('Сначала выберите склад приёмки возврата');
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для возврата от клиента' });
      addToCustomerReturnList(product, 1);
      setOpMessage(`В список возврата от клиента: +1 шт — ${product.name || product.sku}`);
      setCustomerReturnScanValue('');
      customerReturnScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
    }
  };

  const handleCustomerReturnScanChange = (e) => {
    const value = e.target.value;
    customerReturnScanValueRef.current = value;
    setCustomerReturnScanValue(value);
    setLookupError(null);
    if (customerReturnScanDebounceRef.current) {
      clearTimeout(customerReturnScanDebounceRef.current);
      customerReturnScanDebounceRef.current = null;
    }
    if (!value.trim()) return;
    const SCAN_DELAY_MS = 200;
    customerReturnScanDebounceRef.current = setTimeout(() => {
      customerReturnScanDebounceRef.current = null;
      const toProcess = customerReturnScanValueRef.current.trim();
      if (!toProcess) return;
      lookupByBarcodeOrSkuThenCustomerReturnOne(toProcess);
      setCustomerReturnScanValue('');
      customerReturnScanValueRef.current = '';
      customerReturnScanInputRef.current?.focus();
    }, SCAN_DELAY_MS);
  };

  const handleCustomerReturnFromList = () => {
    if (!customerReturnWarehouseId) {
      setOpMessage('Выберите склад приёмки возврата');
      return;
    }
    const id = String(customerReturnSelectedProductId || '').trim();
    if (!id) {
      setOpMessage('Выберите товар');
      return;
    }
    const product = products.find(p => String(p.id) === id);
    if (!product) {
      setOpMessage('Товар не найден');
      return;
    }
    const add = Math.max(1, parseInt(customerReturnListQty, 10) || 1);
    addToCustomerReturnList(product, add);
    setOpMessage(`В список возврата от клиента: ${product.name} — ${add} шт`);
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
    setOpLoading(true);
    setOpMessage(null);
    try {
      const lines = customerReturnList.map(l => ({
        productId: l.productId,
        quantity: Math.max(1, l.quantity)
      }));
      const res = await receiptsApi.create({
        documentType: 'customer_return',
        organizationId: customerReturnOrganizationId ? Number(customerReturnOrganizationId) : null,
        warehouseId: Number(customerReturnWarehouseId),
        lines
      });
      const receiptNumber = res?.data?.receipt?.receipt_number || '';
      setOpMessage(receiptNumber ? `Возврат от клиента ${receiptNumber} оформлен` : 'Возврат на склад оформлен');
      setCustomerReturnList([]);
      onRefresh?.();
      loadReceiptsList();
      setMode(MODE_RECEIPTS_LIST);
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

  const addOneToInventoryNewRow = (product) => {
    if (!product?.id) return;
    product = resolveProductForInventory(product);
    const current = product.quantity ?? 0;
    setInventoryNewRows((prev) => {
      const idx = prev.findIndex((r) => r.product.id === product.id);
      if (idx === -1) {
        return [...prev, { product, current, fact: 1 }];
      }
      return prev.map((r, i) => (i === idx ? { ...r, fact: r.fact + 1, current } : r));
    });
  };

  const lookupByBarcodeOrSkuThenInventoryNewOne = async (value) => {
    const v = String(value || '').trim();
    if (!v) {
      setLookupError('Введите штрихкод / артикул / название');
      return;
    }
    if (!inventorySessionWarehouseId) {
      setLookupError('Сначала выберите склад инвентаризации');
      return;
    }
    setLookupError(null);
    try {
      const product = await lookupProductByAny(v, { title: 'Выберите товар для инвентаризации' });
      addOneToInventoryNewRow(product);
      setOpMessage(`Пересчёт: +1 шт — ${product.name || product.sku}`);
      setInventoryNewScanValue('');
      inventoryNewScanValueRef.current = '';
      inventoryNewScanInputRef.current?.focus();
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.message || 'поиск не удался'));
    }
  };

  const handleInventoryNewScanChange = (e) => {
    const value = e.target.value;
    inventoryNewScanValueRef.current = value;
    setInventoryNewScanValue(value);
    setLookupError(null);
    if (inventoryNewScanDebounceRef.current) {
      clearTimeout(inventoryNewScanDebounceRef.current);
      inventoryNewScanDebounceRef.current = null;
    }
    if (!value.trim()) return;
    const SCAN_DELAY_MS = 200;
    inventoryNewScanDebounceRef.current = setTimeout(() => {
      inventoryNewScanDebounceRef.current = null;
      const toProcess = inventoryNewScanValueRef.current.trim();
      if (!toProcess) return;
      lookupByBarcodeOrSkuThenInventoryNewOne(toProcess);
      setInventoryNewScanValue('');
      inventoryNewScanValueRef.current = '';
      inventoryNewScanInputRef.current?.focus();
    }, SCAN_DELAY_MS);
  };

  /** Сканеры часто шлют Enter в конце: и debounce, и submit формы давали двойной +1. Enter обрабатываем один раз и сбрасываем таймер. */
  const handleInventoryNewScanKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (inventoryNewScanDebounceRef.current) {
      clearTimeout(inventoryNewScanDebounceRef.current);
      inventoryNewScanDebounceRef.current = null;
    }
    const v = String(inventoryNewScanValueRef.current || '').trim();
    if (!v) return;
    lookupByBarcodeOrSkuThenInventoryNewOne(v);
  };

  const handleInventoryNewAddFromSelect = () => {
    if (!inventorySessionWarehouseId) {
      setOpMessage('Выберите склад инвентаризации');
      return;
    }
    const id = String(inventoryNewSelectedProductId || '').trim();
    if (!id) {
      setOpMessage('Выберите товар');
      return;
    }
    const product = products.find((p) => String(p.id) === id);
    if (!product) {
      setOpMessage('Товар не найден');
      return;
    }
    addOneToInventoryNewRow(product);
    setOpMessage(`Пересчёт: +1 шт — ${product.name || product.sku}`);
    inventoryNewScanInputRef.current?.focus();
  };

  const setInventoryNewFact = (productId, value) => {
    const num = parseInt(value, 10);
    const fact = isNaN(num) || num < 0 ? 0 : num;
    setInventoryNewRows((prev) =>
      prev.map((r) => (r.product.id === productId ? { ...r, fact } : r))
    );
  };

  const removeInventoryNewRow = (productId) => {
    setInventoryNewRows((prev) => prev.filter((r) => r.product.id !== productId));
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
    const toUpdate = inventoryNewRows.filter((row) => row.fact !== row.current);
    if (toUpdate.length === 0) {
      setOpMessage('Факт совпадает с количеством в системе по всем строкам — сохранять нечего');
      return;
    }
    setOpLoading(true);
    setOpMessage(null);
    try {
      const res = await inventorySessionsApi.apply({
        warehouseId: Number(inventorySessionWarehouseId),
        lines: toUpdate.map((row) => ({
          productId: row.product.id,
          quantityAfter: row.fact,
        })),
      });
      if (res?.sessionId == null) {
        setOpMessage(res?.message || 'Изменений не зафиксировано');
      } else {
        setOpMessage(
          `Инвентаризация №${res.sessionId} сохранена. Обновлено позиций: ${res.linesApplied ?? 0}`
        );
        onRefresh?.();
        loadInventorySessions();
        setInventoryNewSession(false);
        setInventoryNewRows([]);
        setInventorySessionWarehouseId('');
      }
    } catch (e) {
      setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось сохранить'));
    } finally {
      setOpLoading(false);
    }
  };

  const clearInventoryNewRows = () => {
    setInventoryNewRows([]);
    setOpMessage('Список пересчёта очищен');
  };

  return (
    <div className="warehouse-operations">
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
            📥 Возврат от клиентов
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
          <h3 className="warehouse-ops-panel-title">Списание товара</h3>
          <p className="warehouse-ops-hint">Отсканируйте штрихкод или введите артикул, затем укажите количество к списанию.</p>
          <form onSubmit={handleScanSubmit} className="warehouse-ops-scan-form">
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                ref={scanInputRef}
                type="text"
                className="warehouse-ops-scan-input"
                placeholder="Штрихкод / артикул / название"
                value={scanValue}
                onChange={(e) => {
                  const v = e.target.value;
                  setScanValue(v);
                  setLookupError(null);
                  if (manualSearchDebounceRef.current) clearTimeout(manualSearchDebounceRef.current);
                  if (!v.trim() || isLikelyBarcodeScan(v)) {
                    if (suggestContext === 'writeoff_scan') closeSuggest();
                    return;
                  }
                  manualSearchDebounceRef.current = setTimeout(() => {
                    manualSearchDebounceRef.current = null;
                    const qq = String(v || '').trim();
                    if (qq.length < 2) return;
                    const matches = findLocalMatches(qq);
                    if (matches.length === 0) {
                      if (suggestContext === 'writeoff_scan') closeSuggest();
                      return;
                    }
                    openSuggest('writeoff_scan', 'Выберите товар', matches, (p) => {
                      if (!p) return;
                      setFoundProduct(p);
                      setQtyInput(1);
                      setScanValue('');
                      scanInputRef.current?.focus();
                    });
                  }, 250);
                }}
                onBlur={() => {
                  setTimeout(() => {
                    if (suggestContext === 'writeoff_scan') closeSuggest();
                  }, 150);
                }}
                autoComplete="off"
              />
              {suggestOpen && suggestContext === 'writeoff_scan' && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    left: 0,
                    right: 0,
                    background: '#fff',
                    border: '1px solid rgba(0,0,0,0.15)',
                    borderRadius: 8,
                    boxShadow: '0 10px 24px rgba(0,0,0,0.14)',
                    maxHeight: 320,
                    overflow: 'auto',
                    zIndex: 10
                  }}
                >
                  <div style={{ padding: '8px 10px', fontSize: 12, opacity: 0.75 }}>
                    {suggestTitle || 'Выберите товар'}
                  </div>
                  {(suggestList || []).map((p) => (
                    <button
                      key={p.id ?? `${p.sku || ''}-${p.name || ''}`}
                      type="button"
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => {
                        const fn = suggestOnPickRef.current;
                        closeSuggest();
                        if (typeof fn === 'function') fn(p);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 10px',
                        border: 0,
                        background: 'transparent',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
                        <div style={{ fontWeight: 600 }}>{p.sku || '—'}</div>
                        <div style={{ opacity: 0.7, fontSize: 12 }}>
                          Нал: {p.quantity ?? 0} · Ожид: {p.incoming_quantity ?? p.incomingQuantity ?? 0} · Рез: {p.reserved_quantity ?? p.reservedQuantity ?? 0}
                        </div>
                      </div>
                      <div style={{ opacity: 0.85 }}>{p.name || '—'}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button type="submit" variant="secondary">Найти</Button>
          </form>
          {lookupError && <div className="warehouse-ops-error">{lookupError}</div>}
          {foundProduct && (
            <div className="warehouse-ops-product-card">
              <div className="warehouse-ops-product-info">
                <strong>{foundProduct.name}</strong>
                <span className="muted">Артикул: {foundProduct.sku || '—'}</span>
                <span>Текущий остаток: <strong>{foundProduct.quantity ?? 0}</strong></span>
              </div>
              <div className="warehouse-ops-qty-row">
                <label>Количество к списанию:</label>
                <input
                  type="number"
                  min={1}
                  max={foundProduct.quantity ?? 0}
                  value={qtyInput}
                  onChange={e => setQtyInput(e.target.value)}
                  className="warehouse-ops-qty-input"
                />
                <Button onClick={handleWriteOff} disabled={opLoading || (foundProduct.quantity ?? 0) < 1}>
                  {opLoading ? 'Сохранение…' : 'Списать'}
                </Button>
              </div>
            </div>
          )}
          {opMessage && <div className="warehouse-ops-msg success">{opMessage}</div>}
        </div>
      )}

      {mode === MODE_RETURN_SUPPLIER && (
        <div className="warehouse-ops-panel return-supplier-panel">
          <h3 className="warehouse-ops-panel-title">Возврат товара поставщику</h3>
          <p className="warehouse-ops-hint">Укажите организацию (от имени которой возврат), поставщика и склад списания; добавьте товары по скану или из списка. Возвратная накладная сохранится в общем списке приёмок.</p>
          <div className="warehouse-ops-return-org-supplier">
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад списания <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={returnWarehouseId}
                onChange={(e) => setReturnWarehouseId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите склад —</option>
                {ownWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>Организация (от имени которой возврат):</label>
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
              <label>Поставщик:</label>
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
              <form onSubmit={e => { e.preventDefault(); lookupByBarcodeOrSkuThenReturnOne(returnScanValue); }} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <input
                  ref={returnScanInputRef}
                  type="text"
                  className="warehouse-ops-scan-input"
                  placeholder="Наведите сканер сюда"
                  value={returnScanValue}
                  onChange={handleReturnScanChange}
                  autoComplete="off"
                  disabled={!returnWarehouseId}
                />
              </form>
            </>
          )}

          {returnMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row">
                <label>Товар:</label>
                <select
                  value={returnSelectedProductId}
                  onChange={e => setReturnSelectedProductId(e.target.value)}
                  className="warehouse-ops-select"
                >
                  <option value="">— Выберите товар —</option>
                  {products.filter(p => (p.quantity ?? 0) > 0).map(p => (
                    <option key={p.id} value={p.id}>
                      {p.sku || p.id} — {p.name || 'Без названия'} (остаток: {p.quantity})
                    </option>
                  ))}
                </select>
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
                  disabled={!returnSelectedProductId || !returnWarehouseId}
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
                        const product = products.find(p => String(p.id) === String(item.productId));
                        const maxQty = product?.quantity ?? 0;
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
        </div>
      )}

      {mode === MODE_RETURN_CUSTOMER && (
        <div className="warehouse-ops-panel return-customer-panel">
          <h3 className="warehouse-ops-panel-title">Возврат товара от клиентов на склад</h3>
          <p className="warehouse-ops-hint">
            Принимайте возвращённый клиентом товар: укажите склад приёмки и организацию (при необходимости), добавьте товары по скану или из списка. Документ сохранится в общем списке приёмок.
          </p>
          <div className="warehouse-ops-return-org-supplier">
            <div className="warehouse-ops-receipt-supplier-row">
              <label>
                Склад приёмки <span className="warehouse-ops-required-star">*</span>
              </label>
              <select
                value={customerReturnWarehouseId}
                onChange={(e) => setCustomerReturnWarehouseId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Выберите склад —</option>
                {ownWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="warehouse-ops-receipt-supplier-row">
              <label>Организация (принимающая возврат):</label>
              <select
                value={customerReturnOrganizationId}
                onChange={e => setCustomerReturnOrganizationId(e.target.value)}
                className="warehouse-ops-select"
              >
                <option value="">— Не указана —</option>
                {(organizations || []).map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
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
              <form onSubmit={e => { e.preventDefault(); lookupByBarcodeOrSkuThenCustomerReturnOne(customerReturnScanValue); }} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <input
                  ref={customerReturnScanInputRef}
                  type="text"
                  className="warehouse-ops-scan-input"
                  placeholder="Наведите сканер сюда"
                  value={customerReturnScanValue}
                  onChange={handleCustomerReturnScanChange}
                  autoComplete="off"
                  disabled={!customerReturnWarehouseId}
                />
              </form>
            </>
          )}

          {customerReturnMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row">
                <label>Товар:</label>
                <select
                  value={customerReturnSelectedProductId}
                  onChange={e => setCustomerReturnSelectedProductId(e.target.value)}
                  className="warehouse-ops-select"
                >
                  <option value="">— Выберите товар —</option>
                  {(products || []).map(p => (
                    <option key={p.id} value={p.id}>
                      {p.sku || p.id} — {p.name || 'Без названия'}
                    </option>
                  ))}
                </select>
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
                  disabled={!customerReturnSelectedProductId || !customerReturnWarehouseId}
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
        </div>
      )}

      {mode === MODE_INVENTORY && (
        <div className="warehouse-ops-panel inventory-panel">
          {!inventoryNewSession ? (
            <>
              <div className="warehouse-ops-inventory-header-row">
                <div>
                  <h3 className="warehouse-ops-panel-title">Инвентаризация</h3>
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
                    setInventoryNewScanValue('');
                    setInventoryNewSearch('');
                    setInventoryNewSelectedProductId('');
                    const initWh = inventoryWarehouseId || '';
                    setInventorySessionWarehouseId(initWh);
                    if (initWh && typeof reloadProductsWithWarehouse === 'function') {
                      reloadProductsWithWarehouse(initWh);
                    }
                  }}
                  disabled={loading}
                >
                  Новая инвентаризация
                </Button>
              </div>
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
                            onClick={() => {
                              inventorySessionsApi
                                .getById(s.id)
                                .then((data) => setInventoryDetailView(data))
                                .catch(() => setOpMessage('Не удалось загрузить документ'));
                            }}
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
          ) : (
            <>
              <div className="warehouse-ops-inventory-header-row">
                <div>
                  <h3 className="warehouse-ops-panel-title">Новая инвентаризация</h3>
                  <p className="warehouse-ops-hint">
                    Каждое сканирование штрихкода — плюс 1 шт к фактическому количеству по этой позиции. Либо найдите товар по артикулу/названию и нажмите «Добавить 1 шт».
                    Сохраняются только строки из списка, где факт отличается от количества в системе.
                    Колонки «Излишек» и «Недостача» в ₽ считаются по себестоимости из карточки товара (остаток на складе берётся как в таблице выше); без себестоимости суммы не показываются.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setInventoryNewSession(false);
                    setInventoryNewRows([]);
                    setInventorySessionWarehouseId('');
                    setLookupError(null);
                  }}
                >
                  К списку инвентаризаций
                </Button>
              </div>

              <div className="warehouse-ops-receipt-supplier-row" style={{ marginTop: 12 }}>
                <label>
                  Склад инвентаризации <span className="warehouse-ops-required-star">*</span>
                </label>
                <select
                  value={inventorySessionWarehouseId}
                  onChange={handleInventorySessionWarehouseChange}
                  className="warehouse-ops-select"
                >
                  <option value="">— Выберите склад —</option>
                  {ownWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.address || w.name || `Склад #${w.id}`}
                    </option>
                  ))}
                </select>
              </div>
              <p className="warehouse-ops-hint" style={{ marginTop: 8 }}>
                «В системе» и суммы пересчёта считаются по выбранному складу; при смене склада список строк очищается.
              </p>

              <p className="warehouse-ops-hint">Скан:</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                }}
                className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
              >
                <input
                  ref={inventoryNewScanInputRef}
                  type="text"
                  className="warehouse-ops-scan-input"
                  placeholder="Наведите сканер или введите штрихкод / артикул"
                  value={inventoryNewScanValue}
                  onChange={handleInventoryNewScanChange}
                  onKeyDown={handleInventoryNewScanKeyDown}
                  autoComplete="off"
                  disabled={!inventorySessionWarehouseId}
                />
              </form>

              <div className="warehouse-ops-list-form" style={{ marginTop: 16 }}>
                <div className="warehouse-ops-list-row warehouse-ops-inventory-search-row">
                  <label htmlFor="inventory-new-search">Поиск товара:</label>
                  <input
                    id="inventory-new-search"
                    type="text"
                    className="warehouse-ops-scan-input"
                    placeholder="Артикул или фрагмент названия"
                    value={inventoryNewSearch}
                    onChange={(e) => setInventoryNewSearch(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="warehouse-ops-list-row">
                  <label>Выбор товара:</label>
                  <select
                    value={inventoryNewSelectedProductId}
                    onChange={(e) => setInventoryNewSelectedProductId(e.target.value)}
                    className="warehouse-ops-select"
                  >
                    <option value="">— Выберите товар —</option>
                    {inventoryNewFilteredProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku || p.id} — {p.name || 'Без названия'}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    onClick={handleInventoryNewAddFromSelect}
                    disabled={!inventoryNewSelectedProductId || !inventorySessionWarehouseId}
                  >
                    Добавить 1 шт
                  </Button>
                </div>
              </div>

              {lookupError && <div className="warehouse-ops-error">{lookupError}</div>}
              {opMessage && <div className="warehouse-ops-msg success">{opMessage}</div>}

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
                        {inventoryNewRows.map((row) => {
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
                    <Button onClick={applyInventoryNew} disabled={opLoading}>
                      {opLoading ? 'Сохранение…' : 'Применить инвентаризацию'}
                    </Button>
                    <Button type="button" variant="secondary" onClick={clearInventoryNewRows} disabled={opLoading}>
                      Очистить список
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {mode === MODE_RECEIPTS_LIST && (
        <div className="warehouse-ops-panel receipts-list-panel">
          <div className="warehouse-ops-receipts-list-header">
            <div>
              <h3 className="warehouse-ops-panel-title">Список приёмок и возвратов</h3>
              <p className="warehouse-ops-hint">
                Поступления на склад (ПТ) и возвратные накладные поставщикам (ВН). «Кол-во, шт» — сумма единиц по
                строкам; «Сумма, ₽» — по строкам с указанной себестоимостью (кол-во × цена в строке), иначе «—».
              </p>
            </div>
            <Button
              onClick={() => {
                setReceiptList([]);
                setOpMessage(null);
                setLookupError(null);
                setReceiptWarehouseId(inventoryWarehouseId || '');
                setAddReceiptModalOpen(true);
              }}
            >
              Добавить поступление
            </Button>
          </div>
          {receiptsLoading ? (
            <div className="loading">Загрузка приёмок…</div>
          ) : receiptsList.length === 0 ? (
            <p className="warehouse-ops-receipt-list-empty">Нет приёмок.</p>
          ) : (
            <div className="warehouse-ops-receipts-list-wrap">
              <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Номер</th>
                    <th>Тип</th>
                    <th>Организация</th>
                    <th>Поставщик</th>
                    <th>Кол-во, шт</th>
                    <th>Сумма, ₽</th>
                  </tr>
                </thead>
                <tbody>
                  {receiptsList.map(r => (
                    <tr
                      key={r.id}
                      className="stock-levels-row-clickable"
                      onClick={() => {
                        receiptsApi.getById(r.id).then(res => {
                          const data = res?.data ?? res;
                          if (data) setReceiptDetail(data);
                        });
                      }}
                    >
                      <td>{r.created_at ? new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td>{r.receipt_number || `#${r.id}`}</td>
                      <td>{r.document_type === 'return' ? 'Возврат' : (r.document_type === 'customer_return' ? 'Возврат от клиента' : 'Приёмка')}</td>
                      <td>{r.organization_name || '—'}</td>
                      <td>{r.supplier_name || r.supplier_code || '—'}</td>
                      <td>{receiptRowTotalUnits(r)}</td>
                      <td>{formatReceiptListAmountRub(r.total_amount_rub ?? r.totalAmountRub)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={!!receiptDetail}
        onClose={() => setReceiptDetail(null)}
        title={receiptDetail
          ? (receiptDetail.document_type === 'return' ? 'Возврат ' : (receiptDetail.document_type === 'customer_return' ? 'Возврат от клиента ' : 'Приёмка ')) + (receiptDetail.receipt_number || receiptDetail.id)
          : 'Документ'}
        size="large"
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
            <div className="warehouse-ops-receipt-detail-actions" style={{ marginTop: 16 }}>
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
                    loadReceiptsList();
                    onRefresh?.();
                  } catch (e) {
                    setOpMessage('Ошибка: ' + (e.response?.data?.message || e.message || 'не удалось удалить'));
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
        size="large"
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
            <div className="warehouse-ops-receipt-detail-actions" style={{ marginTop: 12 }}>
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
        size="large"
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
        size="large"
        closeOnBackdropClick={false}
        closeOnEscape={false}
      >
        <div className="warehouse-ops-panel receipt-panel" style={{ marginBottom: 0 }}>
          <div className="warehouse-ops-receipt-supplier-row">
            <label>
              Склад приёмки <span className="warehouse-ops-required-star">*</span>
            </label>
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
          </div>
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
              <form onSubmit={handleScanSubmit} className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn">
                <input
                  ref={scanInputRef}
                  type="text"
                  className="warehouse-ops-scan-input"
                  placeholder="Наведите сканер сюда"
                  value={scanValue}
                  onChange={handleReceiptScanChange}
                  autoComplete="off"
                  disabled={!receiptWarehouseId}
                />
              </form>
            </>
          )}

          {receiptMode === 'list' && (
            <div className="warehouse-ops-list-form">
              <div className="warehouse-ops-list-row">
                <label>Товар:</label>
                <select
                  value={selectedProductId}
                  onChange={e => setSelectedProductId(e.target.value)}
                  className="warehouse-ops-select"
                >
                  <option value="">— Выберите товар —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.sku || p.id} — {p.name || 'Без названия'}
                    </option>
                  ))}
                </select>
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
                  disabled={!selectedProductId || !receiptWarehouseId}
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
                <div className="warehouse-ops-receipt-supplier-row">
                  <label>Поставщик:</label>
                  <select
                    value={receiptSupplierId}
                    onChange={e => setReceiptSupplierId(e.target.value)}
                    className="warehouse-ops-select"
                  >
                    <option value="">— Не указан —</option>
                    {(suppliers || []).map(s => (
                      <option key={s.id} value={s.id}>{s.name || s.code || s.id}</option>
                    ))}
                  </select>
                </div>
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
                  <Button onClick={applyReceiptList} disabled={opLoading}>
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

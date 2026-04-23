/**
 * Остатки на складе — складской учёт, поступление, списание, инвентаризация
 */

import React, { useState, useEffect, useMemo, useLayoutEffect, useCallback } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useCategories } from '../../hooks/useCategories';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { stockMovementsApi } from '../../services/stockMovements.api';
import { WarehouseOperations } from './WarehouseOperations';
import { warehouseOpFromSearch, WAREHOUSE_VALID_OPS } from './warehouseTabs';
import './StockLevels.css';

const MOVEMENT_TYPE_LABELS = {
  receipt: 'Поступление',
  incoming: 'Ожидается (incoming)',
  writeoff: 'Списание',
  shipment: 'Отгрузка',
  reserve: 'Резерв',
  unreserve: 'Снятие резерва',
  inventory: 'Инвентаризация',
  manual: 'Ручное изменение',
  return_to_supplier: 'Возврат поставщику',
  customer_return: 'Возврат от клиента'
};

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Текст причины в истории: если есть reason — только он, иначе тип операции. Сторно помечается в meta.storno. */
function formatMovementReason(m) {
  const meta = m.meta || {};
  const isStorno = meta.storno === true || meta.storno === 'true';
  const reason = (m.reason && m.reason.trim()) ? m.reason.trim() : '';
  if (reason) {
    if (isStorno && !/^сторно/i.test(reason)) return `Сторно: ${reason}`;
    return reason;
  }
  const typeLabel = (MOVEMENT_TYPE_LABELS[m.type] || m.type) || '—';
  if (isStorno) return `Сторно (${typeLabel})`;
  return typeLabel;
}

/** Ссылка для перехода из истории остатков: поступление → приёмка, резерв → заказ, списание → вкладка списания */
function getMovementLink(m) {
  const meta = m.meta || {};
  const reasonText = formatMovementReason(m);
  if ((m.type === 'receipt' || m.type === 'customer_return') && meta.receipt_id != null) {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=receipts_list' },
      state: { openReceiptId: meta.receipt_id },
      label: reasonText
    };
  }
  if (m.type === 'reserve' && (meta.orderId != null || meta.order_id != null)) {
    const orderId = meta.orderId ?? meta.order_id;
    const marketplace = meta.marketplace || 'manual';
    return { to: `/orders/${marketplace}/${orderId}`, state: null, label: reasonText };
  }
  if (m.type === 'writeoff') {
    return {
      to: { pathname: '/stock-levels/warehouse', search: '?op=writeoff' },
      state: { openTab: 'writeoff' },
      label: reasonText
    };
  }
  if (m.type === 'shipment' && (meta.orderId != null || meta.order_id != null)) {
    const orderId = meta.orderId ?? meta.order_id;
    const marketplace = meta.marketplace || 'manual';
    return { to: `/orders/${marketplace}/${orderId}`, state: null, label: reasonText };
  }
  return null;
}

const STOCK_WAREHOUSE_LS = 'stockLevelsWarehouseId';

export function WarehouseStocks() {
  const { products, loading: productsLoading, error: productsError, loadProducts } = useProducts();
  const { warehouses, loading: warehousesLoading, error: warehousesError } = useWarehouses();
  const [stockWarehouseId, setStockWarehouseId] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(STOCK_WAREHOUSE_LS) || '' : '';
    } catch {
      return '';
    }
  });
  const { organizations = [] } = useOrganizations();
  const { categories = [] } = useCategories();
  const [filterOrganizationId, setFilterOrganizationId] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [historyProduct, setHistoryProduct] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = useMemo(
    () => warehouseOpFromSearch(new URLSearchParams(location.search || '')),
    [location.search]
  );

  const handleWarehouseTabChange = useCallback(
    (tab) => {
      if (tab === 'table') {
        navigate('/stock-levels/warehouse', { replace: true });
      } else {
        navigate(`/stock-levels/warehouse?op=${encodeURIComponent(tab)}`, { replace: true });
      }
    },
    [navigate]
  );

  useLayoutEffect(() => {
    if (location.pathname !== '/stock-levels/warehouse') return;
    const s = location.state;
    const sp = new URLSearchParams(location.search || '');
    if (s?.openReceiptId != null && sp.get('op') !== 'receipts_list') {
      navigate('/stock-levels/warehouse?op=receipts_list', { replace: true, state: s });
      return;
    }
    if (s?.openTab && WAREHOUSE_VALID_OPS.has(s.openTab) && sp.get('op') !== s.openTab) {
      navigate(`/stock-levels/warehouse?op=${encodeURIComponent(s.openTab)}`, { replace: true, state: s });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  const applyFilters = () => {
    loadProducts({
      ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
      ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
      ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {})
    });
  };

  const handleOrganizationFilterChange = (e) => {
    const v = e.target.value;
    setFilterOrganizationId(v);
    loadProducts({
      ...(v ? { organizationId: v } : {}),
      ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
      ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {})
    });
  };

  const handleCategoryFilterChange = (e) => {
    const v = e.target.value;
    setFilterCategoryId(v);
    loadProducts({
      ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
      ...(v ? { categoryId: v } : {}),
      ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {})
    });
  };

  const ownWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId
      ),
    [warehouses]
  );

  const handleStockWarehouseChange = (e) => {
    const v = e.target.value;
    setStockWarehouseId(v);
    try {
      if (v) localStorage.setItem(STOCK_WAREHOUSE_LS, v);
      else localStorage.removeItem(STOCK_WAREHOUSE_LS);
    } catch {
      /* ignore */
    }
    loadProducts({
      ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
      ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
      ...(v ? { warehouseId: v } : {}),
      silent: true
    });
  };

  /** Подгрузка остатков по конкретному складу (инвентаризация без подстановки «первого склада» при «Все склады»). */
  const reloadProductsWithWarehouse = useCallback(
    (warehouseId) => {
      const w = warehouseId != null && warehouseId !== '' ? String(warehouseId) : '';
      loadProducts({
        ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
        ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
        ...(w ? { warehouseId: w } : {}),
        silent: true
      });
    },
    [loadProducts, filterOrganizationId, filterCategoryId]
  );

  useEffect(() => {
    loadProducts({
      ...(filterOrganizationId ? { organizationId: filterOrganizationId } : {}),
      ...(filterCategoryId ? { categoryId: filterCategoryId } : {}),
      ...(stockWarehouseId ? { warehouseId: stockWarehouseId } : {}),
      silent: true
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- начальная подгрузка; смена фильтров вызывает loadProducts из обработчиков
  }, []);

  useEffect(() => {
    if (!historyProduct) {
      setHistoryList([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    stockMovementsApi.getHistory(historyProduct.id, { limit: 100 })
      .then(res => {
        if (cancelled) return;
        const list = res?.data ?? res ?? [];
        setHistoryList(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setHistoryList([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [historyProduct]);

  if (productsLoading || warehousesLoading) {
    return <div className="loading">Загрузка остатков на складе...</div>;
  }
  if (productsError) {
    return <div className="error">Ошибка загрузки товаров: {productsError}</div>;
  }
  if (warehousesError) {
    return <div className="error">Ошибка загрузки складов: {warehousesError}</div>;
  }

  const selectedWarehouse = stockWarehouseId
    ? ownWarehouses.find((w) => String(w.id) === stockWarehouseId)
    : null;
  const mainWarehouseName = selectedWarehouse
    ? selectedWarehouse.address || selectedWarehouse.name || 'Склад'
    : 'Все склады (сумма)';

  const rows = products.map(product => ({
    product,
    mainWarehouseStock: product.quantity ?? 0,
    incoming: product.incoming_quantity ?? product.incomingQuantity ?? 0,
    reserved: product.reserved_quantity ?? product.reservedQuantity ?? 0
  }));

  return (
    <>
      <p className="stock-levels-description">
        Складской учёт: реальные остатки на вашем складе. Поступление и списание — по скану штрихкода или артикулу; инвентаризация — ввод фактических остатков.
      </p>

      <WarehouseOperations
        products={products}
        mainWarehouseName={mainWarehouseName}
        inventoryWarehouseId={stockWarehouseId || ''}
        reloadProductsWithWarehouse={reloadProductsWithWarehouse}
        onRefresh={loadProducts}
        loading={productsLoading}
        activeTab={activeTab}
        onTabChange={handleWarehouseTabChange}
        openReceiptId={location.state?.openReceiptId}
        hideTabs
      />

      {activeTab === 'table' && (
        <>
          <div className="stock-levels-filters">
            <label className="stock-levels-filter-label">
              <span>Склад (остаток):</span>
              <select
                value={stockWarehouseId}
                onChange={handleStockWarehouseChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все склады (сумма)</option>
                {ownWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address || w.name || `Склад #${w.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Организация:</span>
              <select
                value={filterOrganizationId}
                onChange={handleOrganizationFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>{org.name || org.id}</option>
                ))}
              </select>
            </label>
            <label className="stock-levels-filter-label">
              <span>Категория:</span>
              <select
                value={filterCategoryId}
                onChange={handleCategoryFilterChange}
                className="stock-levels-filter-select"
              >
                <option value="">Все</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name || cat.id}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="stock-levels-table-wrapper" style={{ marginTop: '16px', width: '100%' }}>
            <table className="stock-levels-table table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Товар</th>
                  <th>{mainWarehouseName}</th>
                  <th>Наличие</th>
                  <th>Ожидается</th>
                  <th>Резерв</th>
                  <th>Доступно</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  (() => {
                    const actual = row.mainWarehouseStock;
                    // reserved_quantity — логический резерв и не уменьшает quantity на складе,
                    // поэтому «Доступно» считаем как supply = actual + incoming - reserved.
                    const available = (row.mainWarehouseStock + row.incoming - row.reserved);
                    const availableSafe = Number.isFinite(available) ? available : 0;
                    return (
                  <tr
                    key={row.product.sku || row.product.id}
                    className="stock-levels-row-clickable"
                    onClick={() => setHistoryProduct(row.product)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && setHistoryProduct(row.product)}
                  >
                    <td className="sku-cell">{row.product.sku || '—'}</td>
                    <td className="name-cell">{row.product.name || 'Без названия'}</td>
                    <td className="main-warehouse-cell">{row.mainWarehouseStock}</td>
                    <td>{actual}</td>
                    <td>{row.incoming}</td>
                    <td className="stock-levels-reserved-cell">{row.reserved}</td>
                    <td className={availableSafe < 0 ? 'stock-change-minus' : ''}>{availableSafe}</td>
                  </tr>
                    );
                  })()
                ))}
              </tbody>
            </table>
          </div>

          <p className="stock-levels-history-hint">Нажмите на строку товара, чтобы открыть историю изменений остатков.</p>

          <div className="actions" style={{ marginTop: '16px' }}>
            <Button variant="secondary" onClick={applyFilters}>📦 Обновить остатки на складе</Button>
          </div>
        </>
      )}

      <Modal
        isOpen={!!historyProduct}
        onClose={() => setHistoryProduct(null)}
        title={historyProduct ? `История остатков: ${historyProduct.name || historyProduct.sku || '—'}` : 'История остатков'}
        size="large"
      >
        {historyLoading ? (
          <div className="loading">Загрузка истории…</div>
        ) : historyList.length === 0 ? (
          <p className="stock-levels-history-empty">Нет записей об изменениях остатков.</p>
        ) : (
          <div className="stock-levels-history-table-wrap">
            <table className="stock-levels-table table stock-levels-history-table">
              <thead>
                <tr>
                  <th>Дата и время</th>
                  <th>Причина</th>
                  <th>Изменение</th>
                  <th>Остаток после</th>
                </tr>
              </thead>
              <tbody>
                {historyList.map(m => {
                  const link = getMovementLink(m);
                  const reasonText = link ? link.label : formatMovementReason(m);
                  const balanceKind =
                    m.type === 'incoming'
                      ? 'в пути (incoming)'
                      : 'в наличии';
                  return (
                    <tr key={m.id}>
                      <td>{formatDateTime(m.created_at)}</td>
                      <td>
                        {link ? (
                          <Link
                            to={link.to}
                            state={link.state}
                            className="stock-levels-history-link"
                            onClick={() => setHistoryProduct(null)}
                          >
                            {reasonText}
                          </Link>
                        ) : (
                          reasonText
                        )}
                      </td>
                      <td className={m.quantity_change > 0 ? 'stock-change-plus' : 'stock-change-minus'}>
                        {m.quantity_change > 0 ? '+' : ''}{m.quantity_change}
                      </td>
                      <td>
                        {m.balance_after != null ? m.balance_after : '—'}
                        <div className="text-muted small">{balanceKind}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  );
}

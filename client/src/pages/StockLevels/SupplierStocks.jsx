/**
 * Остатки поставщиков — таблица остатков у интегрированных поставщиков
 */

import React, { useEffect, useState, useRef } from 'react';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { supplierStocksApi } from '../../services/supplierStocks.api';
import { Button } from '../../components/common/Button/Button';
import './StockLevels.css';

export function SupplierStocks() {
  const { products, loading: productsLoading, error: productsError } = useProducts();
  const { warehouses, loading: warehousesLoading, error: warehousesError } = useWarehouses();
  const { suppliers } = useSuppliers();

  const [supplierStocks, setSupplierStocks] = useState({});
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [supplierError, setSupplierError] = useState(null);

  useEffect(() => {
    const loadSupplierStocks = async () => {
      if (!products.length || !warehouses.length || !suppliers.length) {
        setSupplierLoading(false);
        return;
      }

      setSupplierLoading(true);
      setSupplierError(null);

      try {
        const mainWarehouse = warehouses.find(
          w => !w.supplierId && w.type !== 'supplier'
        );
        if (!mainWarehouse) {
          setSupplierLoading(false);
          return;
        }

        const activeSuppliers = suppliers.filter(s => s.isActive !== false);
        const cache = {};
        const mainWarehouseIdStr = String(mainWarehouse.id);
        const attachedSupplierWarehouses = warehouses.filter(
          w => w.supplierId && w.type === 'supplier' && String(w.mainWarehouseId) === mainWarehouseIdStr
        );
        const warehousesBySupplier = {};
        attachedSupplierWarehouses.forEach(warehouse => {
          const supplierId = String(warehouse.supplierId);
          if (!warehousesBySupplier[supplierId]) warehousesBySupplier[supplierId] = [];
          warehousesBySupplier[supplierId].push(warehouse);
        });

        for (const product of products) {
          if (!product.sku) continue;
          for (const supplier of activeSuppliers) {
            if (!supplier.code) continue;
            const key = `${supplier.id}:${product.sku}`;
            if (cache[key]) continue;
            try {
              const resp = await supplierStocksApi.getStock({
                supplier: supplier.code,
                sku: product.sku,
                brand: product.brand
              });
              if (resp && resp.hasOwnProperty('data')) {
                cache[key] = resp.data !== null && resp.data !== undefined ? resp.data : null;
              } else {
                cache[key] = null;
              }
            } catch (e) {
              if (e.response && e.response.status === 404) {
                cache[key] = null;
              } else {
                cache[key] = null;
              }
            }
          }
        }

        setSupplierStocks(cache);
      } catch (e) {
        console.error('Ошибка загрузки остатков поставщиков:', e);
        setSupplierError(e.message || 'Ошибка загрузки остатков поставщиков');
      } finally {
        setSupplierLoading(false);
      }
    };

    if (!productsLoading && !warehousesLoading && suppliers.length > 0 && products.length > 0 && warehouses.length > 0) {
      loadSupplierStocks();
    } else if (!productsLoading && !warehousesLoading) {
      setSupplierLoading(false);
    }
  }, [products, warehouses, suppliers, productsLoading, warehousesLoading]);

  if (productsLoading || warehousesLoading) {
    return <div className="loading">Загрузка остатков поставщиков...</div>;
  }
  if (productsError) {
    return <div className="error">Ошибка загрузки товаров: {productsError}</div>;
  }
  if (warehousesError) {
    return <div className="error">Ошибка загрузки складов: {warehousesError}</div>;
  }

  const mainWarehouse = warehouses.find(w => !w.supplierId && w.type !== 'supplier');
  const mainWarehouseIdStr = mainWarehouse ? String(mainWarehouse.id) : null;
  const attachedSupplierWarehouses = mainWarehouse
    ? warehouses.filter(
        w => w.supplierId && w.type === 'supplier' && String(w.mainWarehouseId) === mainWarehouseIdStr
      )
    : [];
  const getSupplierNameById = supplierId =>
    suppliers.find(s => s.id === supplierId)?.name || supplierId || 'Поставщик';

  const rows = products.map(product => {
    const warehousesBySupplier = {};
    attachedSupplierWarehouses.forEach(warehouse => {
      const supplierId = String(warehouse.supplierId);
      if (!warehousesBySupplier[supplierId]) warehousesBySupplier[supplierId] = [];
      warehousesBySupplier[supplierId].push(warehouse);
    });

    const supplierDetails = [];
    let totalSupplierStock = 0;
    const activeSuppliers = suppliers.filter(s => s.isActive !== false);

    if (product.sku && mainWarehouse) {
      for (const supplier of activeSuppliers) {
        const supplierId = String(supplier.id);
        const key = `${supplierId}:${product.sku}`;
        const stockData = supplierStocks[key];
        if (
          stockData &&
          !stockData.excluded &&
          stockData.stock != null &&
          stockData.stock > 0
        ) {
          const supplierName = supplier.name || getSupplierNameById(supplierId);
          const firstWarehouse = warehousesBySupplier[supplierId]?.[0];
          const warehouseName = firstWarehouse?.address || `Склад ${supplierName}`;
          supplierDetails.push({
            name: warehouseName,
            supplier: supplierName,
            stock: stockData.stock || 0,
            price: stockData.price || null,
            deliveryDays: stockData.deliveryDays || stockData.delivery_days || 0
          });
          totalSupplierStock += stockData.stock || 0;
        }
      }
    }

    return { product, totalSupplierStock, supplierDetails };
  });

  return (
    <>
      <p className="stock-levels-description">
        Остатки товаров у поставщиков, интегрированных в систему. Данные обновляются по API поставщиков.
      </p>

      {supplierLoading && (
        <div className="info" style={{ marginBottom: '20px' }}>Загрузка остатков поставщиков...</div>
      )}
      {supplierError && (
        <div className="error" style={{ marginBottom: '16px' }}>{supplierError}</div>
      )}

      <div className="stock-levels-table-wrapper" style={{ marginTop: '16px', width: '100%' }}>
        <table className="stock-levels-table table">
          <thead>
            <tr>
              <th>Артикул</th>
              <th>Товар</th>
              <th>Итого у поставщиков</th>
              <th>Детали по поставщикам</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <SupplierStockRow key={row.product.sku || row.product.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="actions" style={{ marginTop: '16px' }}>
        <Button variant="secondary">📦 Обновить остатки поставщиков</Button>
      </div>
    </>
  );
}

function SupplierStockRow({ row }) {
  const { product, totalSupplierStock, supplierDetails } = row;
  const hasSuppliers = supplierDetails.length > 0;
  const [isHovered, setIsHovered] = useState(false);
  const [showAbove, setShowAbove] = useState(false);
  const containerRef = useRef(null);

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setShowAbove(spaceBelow < 300);
    }
  };

  return (
    <tr>
      <td className="sku-cell">{product.sku || '—'}</td>
      <td className="name-cell">{product.name || 'Без названия'}</td>
      <td className="total-stock-cell">{totalSupplierStock}</td>
      <td className="supplier-stock-cell">
        {hasSuppliers ? (
          <div
            ref={containerRef}
            className="stock-cell-container"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={() => setIsHovered(false)}
          >
            <span className="stock-main-value">
              {totalSupplierStock} <span className="stock-main-caret">{showAbove ? '▲' : '▼'}</span>
            </span>
            {isHovered && (
              <div
                className={`stock-details-dropdown ${showAbove ? 'dropdown-above' : ''}`}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
              >
                <div className="dropdown-header">Остатки по поставщикам</div>
                {supplierDetails.map((detail, idx) => (
                  <div key={idx} className="dropdown-item">
                    <div className="dropdown-item-main">
                      <div className="dropdown-item-title" title={detail.name}>{detail.name}</div>
                      <div className="dropdown-item-sub">
                        {detail.supplier}
                        {detail.deliveryDays ? ` • ${detail.deliveryDays}д` : ''}
                      </div>
                    </div>
                    <div className="dropdown-item-meta">
                      <span className="dropdown-item-stock">{detail.stock}</span>
                      <span className="dropdown-item-price">{detail.price}₽</span>
                    </div>
                  </div>
                ))}
                <div className="dropdown-footer">
                  <span>Итого:</span>
                  <span>{totalSupplierStock}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

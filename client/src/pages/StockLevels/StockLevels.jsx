/**
 * StockLevels Page
 * Раздел "Остатки": общий остаток, остаток поставщики, основной склад
 */

import React, { useEffect, useState, useRef } from 'react';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { supplierStocksApi } from '../../services/supplierStocks.api';
import { Button } from '../../components/common/Button/Button';
import './StockLevels.css';

export function StockLevels() {
  const { products, loading: productsLoading, error: productsError } = useProducts();
  const {
    warehouses,
    loading: warehousesLoading,
    error: warehousesError
  } = useWarehouses();
  const { suppliers } = useSuppliers();

  const [supplierStocks, setSupplierStocks] = useState({}); // key: `${supplier}:${sku}` -> data
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [supplierError, setSupplierError] = useState(null);

  // Предзагрузка остатков поставщиков по аналогии с renderStockLevels
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

        // Получаем всех активных поставщиков, а не только тех, у кого есть привязанные склады
        const activeSuppliers = suppliers.filter(s => s.isActive !== false);
        console.log(`[StockLevels] Found ${activeSuppliers.length} active suppliers:`, 
          activeSuppliers.map(s => ({ id: s.id, code: s.code, name: s.name })));

        const cache = {};
        
        // Группируем склады по поставщику для отображения
        const warehousesBySupplier = {};
        // Используем строковое сравнение для надежности
        const mainWarehouseIdStr = String(mainWarehouse.id);
        const attachedSupplierWarehouses = warehouses.filter(
          w => w.supplierId && w.type === 'supplier' && String(w.mainWarehouseId) === mainWarehouseIdStr
        );
        console.log(`[StockLevels] Found ${attachedSupplierWarehouses.length} attached supplier warehouses:`, 
          attachedSupplierWarehouses.map(w => ({ id: w.id, supplierId: w.supplierId, mainWarehouseId: w.mainWarehouseId, address: w.address })));
        attachedSupplierWarehouses.forEach(warehouse => {
          const supplierId = String(warehouse.supplierId);
          if (!warehousesBySupplier[supplierId]) {
            warehousesBySupplier[supplierId] = [];
          }
          warehousesBySupplier[supplierId].push(warehouse);
        });

        for (const product of products) {
          if (!product.sku) continue;
          
          // Обрабатываем каждого активного поставщика
          for (const supplier of activeSuppliers) {
            if (!supplier.code) {
              console.warn(`[StockLevels] Supplier ${supplier.name} has no code`);
              continue;
            }
            
            const key = `${supplier.id}:${product.sku}`;
            if (cache[key]) continue;
            
            try {
              const resp = await supplierStocksApi.getStock({
                supplier: supplier.code,
                sku: product.sku,
                brand: product.brand
              });
              // Проверяем, что ответ успешный и содержит data (может быть null)
              if (resp && resp.hasOwnProperty('data')) {
                if (resp.data !== null && resp.data !== undefined) {
                  cache[key] = resp.data;
                  console.log(`[StockLevels] ✓ Loaded stock for ${supplier.code}:${product.sku}:`, resp.data);
                } else {
                  // data: null - товара нет на складе, это нормально
                  cache[key] = null;
                }
              } else {
                cache[key] = null;
              }
            } catch (e) {
              // Обрабатываем ошибки сети или сервера
              if (e.response) {
                // Сервер вернул ошибку
                if (e.response.status === 404) {
                  // 404 - товара нет, это нормально
                  cache[key] = null;
                } else {
                  console.error(`[StockLevels] ✗ Server error for ${supplier.code}:${product.sku}:`, e.response.status, e.response.statusText);
                  cache[key] = null;
                }
              } else {
                // Ошибка сети или другая ошибка
                console.error(`[StockLevels] ✗ Network error for ${supplier.code}:${product.sku}:`, e.message || e);
                cache[key] = null;
              }
            }
          }
        }

        console.log(`[StockLevels] Loaded stock cache:`, Object.keys(cache).map(key => {
          const [supplierId, sku] = key.split(':');
          const supplier = suppliers.find(s => String(s.id) === supplierId);
          return { key, supplier: supplier?.code || supplierId, sku, data: cache[key] };
        }));
        
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
      // Если данные загружены, но нет товаров/складов/поставщиков, скрываем индикатор загрузки
      setSupplierLoading(false);
    }
  }, [products, warehouses, suppliers, productsLoading, warehousesLoading]);

  if (productsLoading || warehousesLoading) {
    return <div className="loading">Загрузка остатков...</div>;
  }

  if (productsError) {
    return <div className="error">Ошибка загрузки товаров: {productsError}</div>;
  }

  if (warehousesError) {
    return <div className="error">Ошибка загрузки складов: {warehousesError}</div>;
  }

  const mainWarehouse = warehouses.find(
    w => !w.supplierId && w.type !== 'supplier'
  );
  const mainWarehouseName = mainWarehouse
    ? mainWarehouse.address || 'Основной склад'
    : 'Основной склад';

  const getSupplierNameById = supplierId => {
    return (
      suppliers.find(s => s.id === supplierId)?.name ||
      supplierId ||
      'Поставщик'
    );
  };

  const rows = products.map(product => {
    // Используем строковое сравнение для надежности
    const mainWarehouseIdStr = mainWarehouse ? String(mainWarehouse.id) : null;
    const attachedSupplierWarehouses = mainWarehouse
      ? warehouses.filter(
          w =>
            w.supplierId &&
            w.type === 'supplier' &&
            String(w.mainWarehouseId) === mainWarehouseIdStr
        )
      : [];

    const supplierDetails = [];
    let totalSupplierStock = 0;

    // Сначала вычисляем остатки поставщиков для этого товара
    if (product.sku && mainWarehouse) {
      // Группируем склады по поставщику для отображения названий складов
      const warehousesBySupplier = {};
      attachedSupplierWarehouses.forEach(warehouse => {
        const supplierId = String(warehouse.supplierId);
        if (!warehousesBySupplier[supplierId]) {
          warehousesBySupplier[supplierId] = [];
        }
        warehousesBySupplier[supplierId].push(warehouse);
      });
      
      // Обрабатываем всех активных поставщиков, а не только тех, у кого есть склады
      const suppliersMap = new Map();
      const activeSuppliers = suppliers.filter(s => s.isActive !== false);
      
      for (const supplier of activeSuppliers) {
        const supplierId = String(supplier.id);
        const key = `${supplierId}:${product.sku}`;
        const stockData = supplierStocks[key];
        
        if (
          stockData &&
          !stockData.excluded &&
          stockData.stock !== undefined &&
          stockData.stock !== null &&
          stockData.stock > 0
        ) {
          const supplierName = supplier.name || getSupplierNameById(supplierId);
          // Используем первый склад поставщика для отображения, если есть
          const firstWarehouse = warehousesBySupplier[supplierId]?.[0];
          const warehouseName = firstWarehouse?.address || `Склад ${supplierName}`;
          
          suppliersMap.set(supplierId, {
            name: warehouseName,
            supplier: supplierName,
            stock: stockData.stock || 0,
            price: stockData.price || null,
            deliveryDays: stockData.deliveryDays || stockData.delivery_days || 0
          });
          
          totalSupplierStock += (stockData.stock || 0);
        }
      }
      
      // Преобразуем Map в массив
      suppliersMap.forEach(detail => {
        supplierDetails.push(detail);
      });
    }

    // product.quantity должен хранить только остаток основного склада
    // Но если в базе есть старые данные, где quantity включает остатки поставщиков,
    // проверяем: если quantity равен сумме остатков поставщиков, то это остатки поставщиков, а не основного склада
    let mainWarehouseStock = product.quantity || 0;
    
    // Если quantity равен сумме остатков поставщиков (с небольшой погрешностью),
    // это означает, что quantity был обновлен остатками поставщиков ранее
    // В этом случае считаем, что остаток основного склада = 0
    if (totalSupplierStock > 0 && Math.abs(mainWarehouseStock - totalSupplierStock) < 0.01) {
      console.log(`[StockLevels] Product ${product.sku}: quantity (${mainWarehouseStock}) equals supplier stock (${totalSupplierStock}), setting main warehouse stock to 0`);
      mainWarehouseStock = 0;
    }

    const totalStock = mainWarehouseStock + totalSupplierStock;

    return {
      product,
      mainWarehouseStock,
      totalSupplierStock,
      totalStock,
      supplierDetails
    };
  });

  return (
    <div className="card">
      <h1 className="title">📊 Остатки</h1>
      <p className="subtitle">Просмотр остатков товаров на основном складе и у поставщиков</p>
      
      <p style={{fontSize: '14px', color: 'var(--muted)', marginBottom: '16px'}}>Управление остатками товаров на складах и маркетплейсах.</p>
      
      {supplierLoading && (
        <div className="info" style={{marginBottom: '20px'}}>Загрузка остатков поставщиков...</div>
      )}

      {supplierError && (
        <div className="error" style={{marginBottom: '16px'}}>
          {supplierError}
        </div>
      )}

      <div className="stock-levels-table-wrapper" style={{marginTop: '16px', width: '100%'}}>
        <table className="stock-levels-table table">
          <thead>
            <tr>
              <th>Артикул</th>
              <th>Товар</th>
              <th>Общий остаток</th>
              <th>Остаток поставщики</th>
              <th>{mainWarehouseName}</th>
              <th>Ozon</th>
              <th>WB</th>
              <th>YM</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <StockRow
                key={row.product.sku || row.product.id}
                row={row}
              />
            ))}
          </tbody>
        </table>
      </div>
      
      <div className="actions" style={{marginTop: '16px'}}>
        <Button variant="secondary">📦 Обновить все остатки</Button>
      </div>
    </div>
  );
}

function StockRow({ row }) {
  const { product, mainWarehouseStock, totalSupplierStock, totalStock, supplierDetails } =
    row;

  const hasSuppliers = supplierDetails.length > 0;
  const [isHovered, setIsHovered] = useState(false);
  const [showAbove, setShowAbove] = useState(false);
  const containerRef = useRef(null);

  const handleMouseEnter = () => {
    setIsHovered(true);
    // Проверяем, достаточно ли места снизу
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const dropdownHeight = 300; // Примерная высота dropdown
      const spaceBelow = window.innerHeight - rect.bottom;
      setShowAbove(spaceBelow < dropdownHeight);
    }
  };

  return (
    <tr>
      <td className="sku-cell">{product.sku || '—'}</td>
      <td className="name-cell">{product.name || 'Без названия'}</td>
      <td className="total-stock-cell">{totalStock}</td>
      <td className="supplier-stock-cell">
        {hasSuppliers ? (
          <div 
            ref={containerRef}
            className="stock-cell-container"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={() => setIsHovered(false)}
          >
            <span className="stock-main-value">
              {totalSupplierStock}{' '}
              <span className="stock-main-caret">{showAbove ? '▲' : '▼'}</span>
            </span>
            {isHovered && (
              <div 
                className={`stock-details-dropdown ${showAbove ? 'dropdown-above' : ''}`}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
              >
                <div className="dropdown-header">
                  📊 Остатки поставщиков
                </div>
                {supplierDetails.map((detail, idx) => {
                  const deliveryInfo = detail.deliveryDays
                    ? ` ${detail.deliveryDays}д`
                    : '';
                  return (
                    <div
                      key={idx}
                      className="dropdown-item"
                    >
                      <div className="dropdown-item-main">
                        <div className="dropdown-item-title" title={detail.name}>
                          {detail.name}
                        </div>
                        <div className="dropdown-item-sub">
                          {detail.supplier}
                          {deliveryInfo ? ` • ${deliveryInfo}` : ''}
                        </div>
                      </div>
                      <div className="dropdown-item-meta">
                        <span className="dropdown-item-stock">
                          {detail.stock}
                        </span>
                        <span className="dropdown-item-price">
                          {detail.price}₽
                        </span>
                      </div>
                    </div>
                  );
                })}
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
      <td className="main-warehouse-cell">{mainWarehouseStock}</td>
      <td className="mp-stock-cell muted">—</td>
      <td className="mp-stock-cell muted">—</td>
      <td className="mp-stock-cell muted">—</td>
    </tr>
  );
}



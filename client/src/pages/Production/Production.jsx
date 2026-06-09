/**
 * Производство — сборка комплектов из комплектующих на складе.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useAuth } from '../../context/AuthContext.jsx';
import { productionApi } from '../../services/production.api';
import { productsApi } from '../../services/products.api';
import { isKitProduct } from '../../utils/kitStockMetrics';
import { openProductLabelPrintTab } from '../../hooks/useProductLabelPrint';
import './Production.css';

export function Production() {
  const { selectedOrganizationId: organizationId } = useAuth();
  const { warehouses, loading: warehousesLoading } = useWarehouses();

  const ownWarehouses = useMemo(() => {
    const orgId = organizationId != null && String(organizationId).trim() !== ''
      ? String(organizationId).trim()
      : '';
    return (warehouses || []).filter((w) => {
      if (!w || String(w.type || '').toLowerCase() === 'supplier' || w.supplierId || w.supplier_id) {
        return false;
      }
      if (!orgId) return true;
      const wOrg = w.organizationId ?? w.organization_id;
      return wOrg != null && String(wOrg) === orgId;
    });
  }, [warehouses, organizationId]);

  const warehouseLabel = (w) => {
    if (!w) return '';
    return w.address || w.name || w.wbWarehouseName || `Склад #${w.id}`;
  };

  const [warehouseId, setWarehouseId] = useState('');
  const [kitProducts, setKitProducts] = useState([]);
  const [selectedKit, setSelectedKit] = useState(null);
  const [searchValue, setSearchValue] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [printLabels, setPrintLabels] = useState(true);
  const [assembling, setAssembling] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    if (warehouseId || ownWarehouses.length === 0) return;
    setWarehouseId(String(ownWarehouses[0].id));
  }, [ownWarehouses, warehouseId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await productsApi.getAll({
          productType: 'kit',
          organizationId: organizationId || undefined,
          limit: 500,
        });
        const list = res?.data?.products ?? res?.products ?? res?.data ?? [];
        if (!cancelled) setKitProducts(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setKitProducts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const loadPreview = useCallback(async (kit, wid) => {
    if (!kit?.id || !wid) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      const data = await productionApi.getKitPreview(kit.id, wid);
      setPreview(data);
      const max = Math.max(0, Number(data?.assemblable) || 0);
      setQuantity((q) => Math.min(Math.max(1, q), max > 0 ? max : 1));
    } catch (e) {
      setPreview(null);
      setError(e.response?.data?.message || e.message || 'Не удалось загрузить состав комплекта');
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedKit?.id || !warehouseId) {
      setPreview(null);
      return;
    }
    loadPreview(selectedKit, warehouseId);
  }, [selectedKit, warehouseId, loadPreview]);

  const handleSelectKit = (product) => {
    if (!product) {
      setSelectedKit(null);
      setSearchValue('');
      return;
    }
    if (!isKitProduct(product)) {
      setError('Выберите товар с типом «Комплект» и заданным составом');
      return;
    }
    setError(null);
    setSuccess(null);
    setSelectedKit(product);
    setSearchValue(product.sku || product.name || '');
  };

  const maxAssemblable = Math.max(0, Number(preview?.assemblable) || 0);
  const qtyNum = Math.max(1, parseInt(quantity, 10) || 1);
  const canAssemble = !!selectedKit && !!warehouseId && maxAssemblable > 0 && qtyNum <= maxAssemblable;

  const handleAssemble = async () => {
    if (!canAssemble || !selectedKit) return;
    setAssembling(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await productionApi.assembleKit({
        kitProductId: selectedKit.id,
        warehouseId,
        quantity: qtyNum,
      });
      const kitName = result?.kit?.name || selectedKit.name || selectedKit.sku || 'комплект';
      setSuccess(`Собрано ${qtyNum} шт. «${kitName}». На складе комплектов: ${result?.kitsOnHand ?? '—'}`);
      await loadPreview(selectedKit, warehouseId);
      if (printLabels) {
        openProductLabelPrintTab(selectedKit.id, qtyNum);
      }
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Ошибка сборки');
    } finally {
      setAssembling(false);
    }
  };

  const handlePrintLabels = () => {
    if (!selectedKit?.id) return;
    openProductLabelPrintTab(selectedKit.id, qtyNum);
  };

  return (
    <div className="production-page">
      <h1>Производство</h1>
      <p className="production-intro">
        Сборка комплектов из комплектующих: комплектующие списываются со склада, готовые комплекты оприходуются.
        После сборки можно распечатать этикетки на собранное количество.
      </p>

      <div className="production-panel">
        <div className="production-field">
          <label htmlFor="production-warehouse">Склад</label>
          <select
            id="production-warehouse"
            value={warehouseId}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setSuccess(null);
            }}
            disabled={warehousesLoading || assembling}
          >
            {warehousesLoading ? (
              <option value="">Загрузка…</option>
            ) : ownWarehouses.length === 0 ? (
              <option value="">Нет складов</option>
            ) : (
              ownWarehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {warehouseLabel(w)}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="production-field">
          <label>Комплект</label>
          <ProductSearchInput
            value={searchValue}
            onChange={setSearchValue}
            onSelect={handleSelectKit}
            products={kitProducts}
            organizationId={organizationId}
            placeholder="Штрихкод, артикул или название комплекта"
            disabled={assembling}
            autoFocus
          />
        </div>

        {previewLoading && <p className="production-loading">Загрузка состава…</p>}

        {preview && selectedKit && !previewLoading && (
          <>
            <h2 className="production-kit-title">
              {preview.kit?.sku ? `${preview.kit.sku} — ` : ''}
              {preview.kit?.name || selectedKit.name}
            </h2>
            <div className="production-metrics">
              <span>
                Можно собрать: <strong>{maxAssemblable}</strong> шт.
              </span>
              <span>
                Комплектов на складе: <strong>{preview.kitsOnHand ?? 0}</strong> шт.
              </span>
            </div>

            <table className="production-components">
              <thead>
                <tr>
                  <th>Комплектующее</th>
                  <th className="num">На 1 комплект</th>
                  <th className="num">На складе</th>
                  <th className="num">Нужно ({qtyNum} шт.)</th>
                </tr>
              </thead>
              <tbody>
                {(preview.components || []).map((c) => {
                  const need = (c.perKit || 1) * qtyNum;
                  const insufficient = (c.onHand || 0) < need;
                  return (
                    <tr key={c.productId} className={insufficient ? 'insufficient' : ''}>
                      <td>
                        {c.sku ? <strong>{c.sku}</strong> : null}
                        {c.sku && c.name ? ' — ' : null}
                        {c.name || `ID ${c.productId}`}
                      </td>
                      <td className="num">{c.perKit}</td>
                      <td className="num">{c.onHand}</td>
                      <td className="num">{need}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="production-qty-row">
              <div className="production-field" style={{ marginBottom: 0 }}>
                <label htmlFor="production-qty">Количество комплектов</label>
                <input
                  id="production-qty"
                  type="number"
                  min={1}
                  max={maxAssemblable || 1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  disabled={assembling || maxAssemblable < 1}
                />
              </div>
              <div className="production-checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={printLabels}
                    onChange={(e) => setPrintLabels(e.target.checked)}
                    disabled={assembling}
                  />
                  Печатать этикетки после сборки
                </label>
              </div>
            </div>

            <div className="production-actions">
              <Button
                variant="primary"
                onClick={handleAssemble}
                disabled={!canAssemble || assembling}
              >
                {assembling ? 'Сборка…' : 'Собрать комплект'}
              </Button>
              <Button variant="secondary" onClick={handlePrintLabels} disabled={!selectedKit?.id}>
                Печать этикеток
              </Button>
            </div>
          </>
        )}
      </div>

      {error && <div className="production-error">{error}</div>}
      {success && <div className="production-success">{success}</div>}
    </div>
  );
}

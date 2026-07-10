/**
 * Прогноз закупки по продажам FBS
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { useOrganizations } from '../../../hooks/useOrganizations';
import { useWarehouses } from '../../../hooks/useWarehouses';
import { useSuppliers } from '../../../hooks/useSuppliers';
import {
  applySingleOrgWarehouseDefaults,
  useStockDestinationDefaults,
  warehouseDisplayLabel,
} from '../../../utils/stockDestinationDefaults';
import { procurementForecastApi } from '../../../services/procurementForecast.api';
import { purchasesApi } from '../../../services/purchases.api';
import './ProcurementForecast.css';

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultSalesRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: formatYmd(from), to: formatYmd(to) };
}

function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

export function ProcurementForecast() {
  const initialRange = useMemo(() => defaultSalesRange(), []);
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
  const { suppliers } = useSuppliers();
  const { destWarehouses, singleOrganizationId, singleWarehouseId } = useStockDestinationDefaults(
    organizations,
    warehouses
  );

  const [organizationId, setOrganizationId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [salesDateFrom, setSalesDateFrom] = useState(initialRange.from);
  const [salesDateTo, setSalesDateTo] = useState(initialRange.to);
  const [procurementDays, setProcurementDays] = useState(30);
  const [tableSupplierId, setTableSupplierId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [createSupplierId, setCreateSupplierId] = useState('');
  const [createOrganizationId, setCreateOrganizationId] = useState('');
  const [createWarehouseId, setCreateWarehouseId] = useState('');
  const [purchaseSaving, setPurchaseSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState(null);

  useEffect(() => {
    applySingleOrgWarehouseDefaults({
      singleOrganizationId,
      singleWarehouseId,
      organizationId,
      warehouseId,
      setOrganizationId,
      setWarehouseId,
    });
  }, [singleOrganizationId, singleWarehouseId, organizationId, warehouseId]);

  useEffect(() => {
    if (!purchaseOpen) return;
    const nextOrg = createOrganizationId || organizationId;
    const nextWh = createWarehouseId || warehouseId;
    applySingleOrgWarehouseDefaults({
      singleOrganizationId,
      singleWarehouseId,
      organizationId: nextOrg,
      warehouseId: nextWh,
      setOrganizationId: setCreateOrganizationId,
      setWarehouseId: setCreateWarehouseId,
    });
  }, [
    purchaseOpen,
    singleOrganizationId,
    singleWarehouseId,
    organizationId,
    warehouseId,
    createOrganizationId,
    createWarehouseId,
  ]);

  const canLoad =
    String(organizationId || '').trim() !== '' && String(warehouseId || '').trim() !== '';

  const load = useCallback(async () => {
    if (!canLoad) {
      setError('Выберите организацию и склад');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    setSelectedIds(new Set());
    setTableSupplierId('');
    try {
      const res = await procurementForecastApi.getFbsForecast({
        organizationId,
        warehouseId,
        salesDateFrom,
        salesDateTo,
        procurementDays,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось построить прогноз');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [
    canLoad,
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
  ]);

  const allItems = Array.isArray(data?.items) ? data.items : [];

  const tableSuppliers = useMemo(() => {
    const map = new Map();
    for (const row of allItems) {
      if (row.supplierId != null) {
        map.set(row.supplierId, row.supplierName || `#${row.supplierId}`);
      }
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  }, [allItems]);

  const items = useMemo(() => {
    if (!tableSupplierId) return allItems;
    const sid = parseInt(tableSupplierId, 10);
    return allItems.filter((row) => row.supplierId === sid);
  }, [allItems, tableSupplierId]);

  const selectableItems = useMemo(
    () => items.filter((row) => (Number(row.toPurchase) || 0) > 0),
    [items]
  );

  const toggleRow = (productId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size >= selectableItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableItems.map((r) => r.productId)));
    }
  };

  const openPurchase = () => {
    if (!selectedIds.size) return;
    setCreateSupplierId('');
    setCreateOrganizationId(organizationId || '');
    setCreateWarehouseId(warehouseId || '');
    setPurchaseOpen(true);
  };

  const createPurchase = async () => {
    const sid = parseInt(createSupplierId, 10);
    const orgId = parseInt(createOrganizationId, 10);
    const whId = parseInt(createWarehouseId, 10);
    if (!Number.isFinite(sid) || sid < 1) {
      setError('Выберите поставщика для закупки');
      return;
    }
    if (!Number.isFinite(orgId) || orgId < 1) {
      setError('Выберите организацию для закупки');
      return;
    }
    if (!Number.isFinite(whId) || whId < 1) {
      setError('Выберите склад для закупки');
      return;
    }
    const selectedRows = allItems.filter(
      (r) =>
        selectedIds.has(r.productId) &&
        (Number(r.toPurchase) || 0) > 0 &&
        r.supplierId === sid
    );
    if (!selectedRows.length) {
      setError('Среди выбранных позиций нет товаров выбранного поставщика');
      return;
    }

    setPurchaseSaving(true);
    setError(null);
    try {
      const result = await purchasesApi.create({
        supplierId: sid,
        organizationId: orgId,
        warehouseId: whId,
        items: selectedRows.map((r) => ({
          productId: r.productId,
          quantity: r.toPurchase,
        })),
        note: `Прогноз закупки · продажи ${salesDateFrom}–${salesDateTo} · на ${procurementDays} дн.`,
      });
      const purchaseId = result?.id ?? result?.purchaseId;
      setSuccessMsg(purchaseId ? `Создана закупка №${purchaseId}` : 'Закупка создана');
      setPurchaseOpen(false);
      setSelectedIds(new Set());
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось создать закупку');
    } finally {
      setPurchaseSaving(false);
    }
  };

  return (
    <div className="procurement-forecast">
      <PageTitle
        iconClass="pe-7s-calculator"
        iconBgClass="bg-mean-fruit"
        title="Прогноз закупки"
        subtitle="Продажи FBS за период → потребность на период закупки"
        actions={
          <Link to="/stock-levels/purchases" className="procurement-forecast__back-link">
            ← К закупкам
          </Link>
        }
      />

      <div className="procurement-forecast__setup">
        <h3 className="procurement-forecast__setup-title">Параметры</h3>
        <div className="procurement-forecast__filters erp-filter-bar">
          <label className="procurement-forecast__field">
            <span>Организация</span>
            <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              <option value="">— выберите —</option>
              {(organizations || []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || o.legalName || `#${o.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="procurement-forecast__field">
            <span>Склад</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">— выберите —</option>
              {destWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseDisplayLabel(w, w.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="procurement-forecast__field">
            <span>Продажи с</span>
            <input
              type="date"
              value={salesDateFrom}
              onChange={(e) => setSalesDateFrom(e.target.value)}
            />
          </label>
          <label className="procurement-forecast__field">
            <span>Продажи по</span>
            <input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} />
          </label>
          <label className="procurement-forecast__field">
            <span>Закупка на, дней</span>
            <input
              type="number"
              min={1}
              max={365}
              value={procurementDays}
              onChange={(e) => setProcurementDays(Math.max(1, parseInt(e.target.value, 10) || 30))}
            />
          </label>
          <Button variant="primary" onClick={load} disabled={loading || !canLoad}>
            {loading ? 'Расчёт…' : 'Сформировать таблицу'}
          </Button>
        </div>
      </div>

      {error && <div className="procurement-forecast__error">{error}</div>}
      {successMsg && <div className="procurement-forecast__success">{successMsg}</div>}

      {data && (
        <>
          <div className="procurement-forecast__summary">
            <span>
              Продано за период: <strong>{formatQty(data.summary?.soldQty)}</strong> шт.
            </span>
            <span>
              К закупке: <strong>{formatQty(data.summary?.toPurchase)}</strong> шт. (
              {data.summary?.linesToPurchase || 0} поз.)
            </span>
            <span className="muted">
              Формула: (продажи / {data.salesPeriod?.days} дн.) × {data.procurementDays} дн. − наличие −
              в пути
            </span>
          </div>

          <div className="procurement-forecast__toolbar">
            <label className="procurement-forecast__field">
              <span>Поставщик</span>
              <select value={tableSupplierId} onChange={(e) => setTableSupplierId(e.target.value)}>
                <option value="">Все</option>
                {tableSuppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              size="small"
              onClick={openPurchase}
              disabled={!selectedIds.size}
            >
              Создать закупку ({selectedIds.size})
            </Button>
          </div>

          <div className="procurement-forecast__table-wrap">
            <table className="procurement-forecast__table table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={
                        selectableItems.length > 0 && selectedIds.size === selectableItems.length
                      }
                      onChange={toggleAll}
                      aria-label="Выбрать все"
                    />
                  </th>
                  <th>Товар</th>
                  <th>Артикул</th>
                  <th>Поставщик</th>
                  <th className="procurement-forecast__num">Продано</th>
                  <th className="procurement-forecast__num">Наличие</th>
                  <th className="procurement-forecast__num">В пути</th>
                  <th className="procurement-forecast__num">Потребность</th>
                  <th className="procurement-forecast__num">Закупить</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={9} className="procurement-forecast__empty">
                      Нет товаров с продажами или остатками за выбранные условия
                    </td>
                  </tr>
                )}
                {items.map((row) => {
                  const canSelect = (Number(row.toPurchase) || 0) > 0;
                  return (
                    <tr key={row.productId} className={row.isComponent ? 'procurement-forecast__row--component' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.productId)}
                          disabled={!canSelect}
                          onChange={() => toggleRow(row.productId)}
                        />
                      </td>
                      <td>
                        {row.productName || '—'}
                        {row.isComponent ? (
                          <span className="procurement-forecast__badge">комплектующая</span>
                        ) : null}
                      </td>
                      <td>{row.productSku || '—'}</td>
                      <td>{row.supplierName || '—'}</td>
                      <td className="procurement-forecast__num">{formatQty(row.soldQty)}</td>
                      <td className="procurement-forecast__num">{formatQty(row.onHand)}</td>
                      <td className="procurement-forecast__num">{formatQty(row.incoming)}</td>
                      <td className="procurement-forecast__num">{formatQty(row.projectedNeed)}</td>
                      <td className="procurement-forecast__num procurement-forecast__num--buy">
                        {formatQty(row.toPurchase)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        isOpen={purchaseOpen}
        onClose={() => !purchaseSaving && setPurchaseOpen(false)}
        title="Создать закупку из прогноза"
        size="md"
      >
        <p className="muted" style={{ marginBottom: 12 }}>
          Будет создана закупка на {selectedIds.size} поз. с количеством «Закупить».
        </p>
        <div className="procurement-forecast__modal-fields">
          <label className="procurement-forecast__field procurement-forecast__field--block">
            <span>Поставщик</span>
            <select value={createSupplierId} onChange={(e) => setCreateSupplierId(e.target.value)}>
              <option value="">— выберите —</option>
              {(suppliers || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `#${s.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="procurement-forecast__field procurement-forecast__field--block">
            <span>Организация</span>
            <select
              value={createOrganizationId}
              onChange={(e) => setCreateOrganizationId(e.target.value)}
            >
              <option value="">— выберите —</option>
              {(organizations || []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || o.legalName || `#${o.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="procurement-forecast__field procurement-forecast__field--block">
            <span>Склад</span>
            <select value={createWarehouseId} onChange={(e) => setCreateWarehouseId(e.target.value)}>
              <option value="">— выберите —</option>
              {destWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseDisplayLabel(w, w.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setPurchaseOpen(false)} disabled={purchaseSaving}>
            Отмена
          </Button>
          <Button variant="primary" onClick={createPurchase} disabled={purchaseSaving}>
            {purchaseSaving ? 'Создание…' : 'Создать закупку'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

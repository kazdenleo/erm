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

function defaultSalesRange(days = 7) {
  const n = Math.max(1, Math.floor(Number(days) || 7));
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (n - 1));
  return { from: formatYmd(from), to: formatYmd(to) };
}

const SALES_PERIOD_PRESETS = [7, 14, 28];

function daysInclusiveYmd(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const [y1, m1, d1] = fromYmd.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = toYmd.split('-').map((x) => parseInt(x, 10));
  if (![y1, m1, d1, y2, m2, d2].every((n) => Number.isFinite(n))) return null;
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

export function ProcurementForecast() {
  const initialRange = useMemo(() => defaultSalesRange(7), []);
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
  const [procurementDays, setProcurementDays] = useState(7);
  const [bufferPercent, setBufferPercent] = useState('');
  const [tableSupplierId, setTableSupplierId] = useState('');
  const [showZeroToPurchase, setShowZeroToPurchase] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [createSupplierId, setCreateSupplierId] = useState('');
  const [createOrganizationId, setCreateOrganizationId] = useState('');
  const [createWarehouseId, setCreateWarehouseId] = useState('');
  /** Позиции в окне создания: { productId, productName, productSku, quantity } */
  const [purchaseDraftItems, setPurchaseDraftItems] = useState([]);
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

  const fetchForecast = useCallback(async () => {
    const bufRaw = String(bufferPercent || '').trim();
    const bufNum = bufRaw === '' ? 0 : Number(bufRaw);
    const res = await procurementForecastApi.getFbsForecast({
      organizationId,
      warehouseId,
      salesDateFrom,
      salesDateTo,
      procurementDays,
      bufferPercent: Number.isFinite(bufNum) ? bufNum : 0,
    });
    return res?.data ?? null;
  }, [
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
    bufferPercent,
  ]);

  const applySalesPeriodPreset = (days) => {
    const range = defaultSalesRange(days);
    setSalesDateFrom(range.from);
    setSalesDateTo(range.to);
    setProcurementDays(days);
  };

  const activeSalesPreset = useMemo(() => {
    const n = daysInclusiveYmd(salesDateFrom, salesDateTo);
    if (n == null) return null;
    const today = formatYmd(new Date());
    if (salesDateTo !== today) return null;
    return SALES_PERIOD_PRESETS.includes(n) ? n : null;
  }, [salesDateFrom, salesDateTo]);

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
      const next = await fetchForecast();
      setData(next);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось построить прогноз');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [canLoad, fetchForecast]);

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
    let list = allItems;
    if (tableSupplierId) {
      const sid = parseInt(tableSupplierId, 10);
      list = list.filter((row) => row.supplierId === sid);
    }
    list = [...list].sort((a, b) => {
      const ta = Number(a.toPurchase) || 0;
      const tb = Number(b.toPurchase) || 0;
      const aNeed = ta > 0 ? 1 : 0;
      const bNeed = tb > 0 ? 1 : 0;
      if (aNeed !== bNeed) return bNeed - aNeed;
      if (tb !== ta) return tb - ta;
      return (Number(b.soldQty) || 0) - (Number(a.soldQty) || 0);
    });
    if (!showZeroToPurchase) {
      list = list.filter((row) => (Number(row.toPurchase) || 0) > 0);
    }
    return list;
  }, [allItems, tableSupplierId, showZeroToPurchase]);

  const selectableItems = useMemo(
    () => items.filter((row) => (Number(row.toPurchase) || 0) > 0),
    [items]
  );

  const hiddenZeroCount = useMemo(() => {
    let list = allItems;
    if (tableSupplierId) {
      const sid = parseInt(tableSupplierId, 10);
      list = list.filter((row) => row.supplierId === sid);
    }
    return list.filter((row) => (Number(row.toPurchase) || 0) <= 0).length;
  }, [allItems, tableSupplierId]);

  const toggleRow = (productId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size >= selectableItems.length && selectableItems.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableItems.map((r) => r.productId)));
    }
  };

  const openPurchase = () => {
    if (!selectedIds.size) return;
    const selectedRows = allItems.filter(
      (r) => selectedIds.has(r.productId) && (Number(r.toPurchase) || 0) > 0
    );
    if (!selectedRows.length) return;

    const draft = selectedRows.map((r) => ({
      productId: r.productId,
      productName: r.productName || '',
      productSku: r.productSku || '',
      quantity: Math.max(1, Math.round(Number(r.toPurchase) || 0)),
    }));

    setPurchaseDraftItems(draft);
    // Поставщика не подставляем: в одной закупке могут быть товары разных поставщиков.
    setCreateSupplierId('');
    setCreateOrganizationId(organizationId || '');
    setCreateWarehouseId(warehouseId || '');
    setError(null);
    setPurchaseOpen(true);
  };

  const updateDraftQty = (productId, raw) => {
    setPurchaseDraftItems((prev) =>
      prev.map((it) =>
        it.productId === productId ? { ...it, quantity: raw } : it
      )
    );
  };

  const removeDraftItem = (productId) => {
    setPurchaseDraftItems((prev) => prev.filter((it) => it.productId !== productId));
  };

  const closePurchaseModal = () => {
    if (purchaseSaving) return;
    setPurchaseOpen(false);
    setPurchaseDraftItems([]);
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

    const itemsPayload = [];
    for (const it of purchaseDraftItems) {
      const qty = Math.floor(Number(it.quantity));
      if (!Number.isFinite(qty) || qty < 1) continue;
      itemsPayload.push({ productId: it.productId, quantity: qty });
    }
    if (!itemsPayload.length) {
      setError('Укажите количество хотя бы по одной позиции (или удалите ненужные)');
      return;
    }

    setPurchaseSaving(true);
    setError(null);
    try {
      const result = await purchasesApi.create({
        supplierId: sid,
        organizationId: orgId,
        warehouseId: whId,
        items: itemsPayload,
        note: `Прогноз закупки · продажи ${salesDateFrom}–${salesDateTo} · на ${procurementDays} дн.`,
      });
      const purchaseId = result?.id ?? result?.purchaseId;
      const purchasedIds = new Set(itemsPayload.map((x) => x.productId));

      setPurchaseOpen(false);
      setPurchaseDraftItems([]);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of purchasedIds) next.delete(id);
        return next;
      });

      // Остаёмся на прогнозе и обновляем «В пути» / «Закупить»
      setLoading(true);
      try {
        const next = await fetchForecast();
        setData(next);
        setSuccessMsg(
          purchaseId
            ? `Создана закупка №${purchaseId}. Таблица обновлена — можно выбрать следующие позиции.`
            : 'Закупка создана. Таблица обновлена — можно выбрать следующие позиции.'
        );
      } catch (reloadErr) {
        setSuccessMsg(
          purchaseId
            ? `Создана закупка №${purchaseId}. Не удалось обновить таблицу — нажмите «Сформировать таблицу».`
            : 'Закупка создана. Обновите таблицу вручную.'
        );
        setError(
          reloadErr?.response?.data?.message ||
            reloadErr?.message ||
            'Закупка создана, но прогноз не обновился'
        );
      } finally {
        setLoading(false);
      }
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось создать закупку');
    } finally {
      setPurchaseSaving(false);
    }
  };

  const draftQtyTotal = useMemo(
    () =>
      purchaseDraftItems.reduce((sum, it) => {
        const q = Math.floor(Number(it.quantity));
        return sum + (Number.isFinite(q) && q > 0 ? q : 0);
      }, 0),
    [purchaseDraftItems]
  );

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
            <span>Период продаж</span>
            <div className="procurement-forecast__presets">
              {SALES_PERIOD_PRESETS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`procurement-forecast__preset-btn${
                    activeSalesPreset === d ? ' is-active' : ''
                  }`}
                  onClick={() => applySalesPeriodPreset(d)}
                >
                  {d} дн.
                </button>
              ))}
            </div>
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
              onChange={(e) => setProcurementDays(Math.max(1, parseInt(e.target.value, 10) || 7))}
            />
          </label>
          <label className="procurement-forecast__field" title="Необязательно: запас сверх темпа продаж">
            <span>Запас, %</span>
            <input
              type="number"
              min={0}
              max={500}
              step={1}
              placeholder="0"
              value={bufferPercent}
              onChange={(e) => setBufferPercent(e.target.value)}
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
              Формула: (продажи / {data.salesPeriod?.days} дн.) × {data.procurementDays} дн.
              {Number(data.bufferPercent) > 0
                ? ` × (1 + ${Number(data.bufferPercent)}%)`
                : ''}{' '}
              − наличие − в пути − в комплектах
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
            <label className="procurement-forecast__toggle">
              <input
                type="checkbox"
                checked={showZeroToPurchase}
                onChange={(e) => setShowZeroToPurchase(e.target.checked)}
              />
              <span>
                Показать с «Закупить» = 0
                {hiddenZeroCount > 0 && !showZeroToPurchase
                  ? ` (скрыто ${hiddenZeroCount})`
                  : ''}
              </span>
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
                        selectableItems.length > 0 &&
                        selectableItems.every((r) => selectedIds.has(r.productId))
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
                  <th
                    className="procurement-forecast__num"
                    title="Штуки комплектующей внутри собранных комплектов на этом складе"
                  >
                    В комплектах
                  </th>
                  <th className="procurement-forecast__num">Закупить</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={9} className="procurement-forecast__empty">
                      {allItems.length === 0
                        ? 'Нет товаров с продажами или остатками за выбранные условия'
                        : showZeroToPurchase
                          ? 'Нет строк по выбранному фильтру поставщика'
                          : 'Нет позиций к закупке. Включите «Показать с Закупить = 0», чтобы увидеть закрытые строки.'}
                    </td>
                  </tr>
                )}
                {items.map((row) => {
                  const canSelect = (Number(row.toPurchase) || 0) > 0;
                  return (
                    <tr
                      key={row.productId}
                      className={row.isComponent ? 'procurement-forecast__row--component' : ''}
                    >
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
                      <td
                        className="procurement-forecast__num"
                        title={
                          Number(row.onHandInKits) > 0
                            ? 'Уже есть в собранных комплектах на складе'
                            : undefined
                        }
                      >
                        {formatQty(row.onHandInKits)}
                      </td>
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
        onClose={closePurchaseModal}
        title="Создать закупку из прогноза"
        size="xl"
      >
        <p className="muted procurement-forecast__modal-hint">
          Проверьте позиции и количество. Лишние строки удалите. Поставщика укажите вручную
          (обязательно). Организация и склад — из параметров прогноза. После создания останетесь на
          этой странице — таблица обновится (в т.ч. «В пути»).
        </p>
        <div className="procurement-forecast__modal-fields procurement-forecast__modal-fields--row">
          <label className="procurement-forecast__field procurement-forecast__field--grow">
            <span>
              Поставщик <span className="procurement-forecast__required">*</span>
            </span>
            <select
              value={createSupplierId}
              onChange={(e) => setCreateSupplierId(e.target.value)}
              required
              aria-required="true"
            >
              <option value="">— выберите поставщика —</option>
              {(suppliers || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `#${s.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="procurement-forecast__field procurement-forecast__field--grow">
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
          <label className="procurement-forecast__field procurement-forecast__field--grow">
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

        <div className="procurement-forecast__draft-list">
          <div className="procurement-forecast__draft-head">
            <span>Артикул</span>
            <span>Товар</span>
            <span className="procurement-forecast__draft-qty-label">Кол-во</span>
            <span />
          </div>
          {purchaseDraftItems.length === 0 ? (
            <p className="procurement-forecast__draft-empty">
              Список пуст — вернитесь к таблице и выберите позиции.
            </p>
          ) : (
            purchaseDraftItems.map((it) => (
              <div key={it.productId} className="procurement-forecast__draft-row">
                <div
                  className="procurement-forecast__draft-sku"
                  title="Артикул — удобно выделить и скопировать"
                >
                  {it.productSku || '—'}
                </div>
                <div className="procurement-forecast__draft-product">
                  <div className="procurement-forecast__draft-name">{it.productName || '—'}</div>
                </div>
                <input
                  className="procurement-forecast__draft-qty"
                  type="number"
                  min={1}
                  step={1}
                  value={it.quantity}
                  onChange={(e) => updateDraftQty(it.productId, e.target.value)}
                  aria-label={`Количество ${it.productSku || it.productId}`}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() => removeDraftItem(it.productId)}
                  disabled={purchaseSaving}
                >
                  Удалить
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="procurement-forecast__modal-footer">
          <span className="muted">
            Позиций: {purchaseDraftItems.length}, шт.: {formatQty(draftQtyTotal)}
          </span>
          <div className="procurement-forecast__modal-actions">
            <Button variant="secondary" onClick={closePurchaseModal} disabled={purchaseSaving}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={createPurchase}
              disabled={
                purchaseSaving ||
                purchaseDraftItems.length === 0 ||
                !String(createSupplierId || '').trim()
              }
            >
              {purchaseSaving ? 'Создание…' : 'Создать закупку'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Расчёт закупки по выбранным поставкам FBO
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import {
  calcPurchaseTotals,
  componentQtyToKitUnits,
  getPurchaseRowDisplayName,
  isPurchasablePurchaseRow,
  kitUnitsToComponentQty,
  mergePurchasedProgress,
  recalcPurchaseRow,
  recalcPurchaseRows,
  sortPurchaseRowsWithProgress,
} from './fboPurchaseCalcUtils';
import { FboPurchaseReplaceModal } from './FboPurchaseReplaceModal';
import { FboOpenCalcSessionsBanner } from './FboOpenCalcSessionsBanner.jsx';
import './FboSupplies.css';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function applyCalcRows(data, { withProgress = false, prevRows = [] } = {}) {
  let rows = recalcPurchaseRows(data?.rows || []);
  if (withProgress) {
    rows = mergePurchasedProgress(rows, prevRows.length ? prevRows : data?.rows || []);
  }
  rows = sortPurchaseRowsWithProgress(rows);
  const totals = calcPurchaseTotals(rows);
  return { ...data, rows, totals };
}

function isRowSelectable(row) {
  return isPurchasablePurchaseRow(row) && Boolean(row?.productId) && (Number(row.remainingToPurchase) || 0) > 0;
}

export function FboPurchaseCalculation() {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionIdFromUrl = useMemo(() => {
    const q = new URLSearchParams(location.search).get('session');
    const n = q != null ? parseInt(q, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [location.search]);

  const supplyIds = useMemo(() => {
    const fromState = location.state?.supplyIds;
    if (Array.isArray(fromState) && fromState.length) {
      return fromState.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    }
    const q = new URLSearchParams(location.search).get('ids');
    if (!q) return [];
    return q
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }, [location.state, location.search]);

  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();

  const [calc, setCalc] = useState(null);
  const [session, setSession] = useState(null);
  const [purchaseLinks, setPurchaseLinks] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState(() => new Set());
  const [successMsg, setSuccessMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [savingCell, setSavingCell] = useState(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseSaving, setPurchaseSaving] = useState(false);
  const [createSupplierId, setCreateSupplierId] = useState('');
  const [createOrganizationId, setCreateOrganizationId] = useState('');
  const [createWarehouseId, setCreateWarehouseId] = useState('');
  const [replaceCtx, setReplaceCtx] = useState(null);
  const [replaceSaving, setReplaceSaving] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const load = useCallback(async () => {
    if (!sessionIdFromUrl && !supplyIds.length) {
      setErr('Не выбраны поставки');
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    setSuccessMsg(null);
    try {
      let payload;
      if (sessionIdFromUrl) {
        payload = await fboSuppliesApi.getPurchaseCalcSession(sessionIdFromUrl);
      } else {
        payload = await fboSuppliesApi.openPurchaseCalcSession(supplyIds);
        if (payload?.session?.id || payload?.id) {
          const sid = payload.session?.id ?? payload.id;
          navigate(`/stock-levels/fbo-supplies/purchase-calc?session=${sid}`, {
            replace: true,
            state: { supplyIds },
          });
        }
      }
      setSession(payload.session ?? { id: payload.id, supplyIds: payload.supplyIds });
      setPurchaseLinks(payload.purchaseLinks || []);
      setCalc(applyCalcRows(payload.calc, { withProgress: true }));
      setCreateOrganizationId(
        payload.calc?.defaultOrganizationId != null
          ? String(payload.calc.defaultOrganizationId)
          : ''
      );
      setCreateWarehouseId(
        payload.calc?.defaultWarehouseId != null ? String(payload.calc.defaultWarehouseId) : ''
      );
      setSelectedRowKeys(new Set());
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить расчёт закупки');
    } finally {
      setLoading(false);
    }
  }, [sessionIdFromUrl, supplyIds, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const updateRows = useCallback((updater) => {
    setCalc((prev) => {
      if (!prev) return prev;
      const nextRows = typeof updater === 'function' ? updater(prev.rows) : updater;
      const rows = sortPurchaseRowsWithProgress(
        mergePurchasedProgress(recalcPurchaseRows(nextRows), prev.rows)
      );
      return { ...prev, rows, totals: calcPurchaseTotals(rows) };
    });
  }, []);

  const supplyIdsForExport = useMemo(
    () => session?.supplyIds || supplyIds,
    [session?.supplyIds, supplyIds]
  );

  const selectableRows = useMemo(
    () => (calc?.rows || []).filter(isRowSelectable),
    [calc?.rows]
  );

  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((r) => selectedRowKeys.has(r.key));

  const toggleRowSelected = (rowKey) => {
    setSelectedRowKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setSelectedRowKeys(new Set());
      return;
    }
    setSelectedRowKeys(new Set(selectableRows.map((r) => r.key)));
  };

  const handleSupplyQtyChange = (rowKey, supplyId, raw) => {
    const parsed = raw === '' ? '' : Math.max(0, parseInt(raw, 10) || 0);
    updateRows((rows) =>
      rows.map((r) => {
        if (r.key !== rowKey) return r;
        const supplyQty = { ...r.supplyQty, [supplyId]: parsed };
        return recalcPurchaseRow({ ...r, supplyQty });
      })
    );
  };

  const handleSupplyQtyBlur = useCallback(
    async (rowKey, supplyId) => {
    const row = calc?.rows?.find((r) => r.key === rowKey);
    if (!row) return;

    const cell = row.supplyCells?.[supplyId];
    if (!cell?.supplyItemId) return;

    const raw = row.supplyQty[supplyId];
    const isKitHeader = row.rowType === 'kit' || row.isKitHeader;

    if (isKitHeader) {
      const kitQty = raw === '' || raw == null ? 0 : Math.max(0, parseInt(raw, 10) || 0);
      const savedKitQty = Number(cell.quantity) || 0;

      if (cell.multiSource || cell.parts?.length > 1) {
        setErr('Несколько строк комплекта в этой поставке — измените количество в карточке поставки');
        return;
      }

      if (kitQty === savedKitQty) {
        if (raw === '') {
          updateRows((rows) =>
            rows.map((r) =>
              r.key === row.key
                ? { ...r, supplyQty: { ...r.supplyQty, [supplyId]: savedKitQty } }
                : r
            )
          );
        }
        return;
      }

      const cellKey = `${supplyId}:${cell.supplyItemId}`;
      setSavingCell(cellKey);
      setErr(null);
      try {
        const result = await fboSuppliesApi.updateSupplyItem(
          supplyId,
          cell.supplyItemId,
          kitQty
        );
        if (result.deleted) {
          await load();
        } else {
          await load();
        }
      } catch (e) {
        setErr(e.response?.data?.message || e.message || 'Не удалось сохранить количество');
        updateRows((rows) =>
          rows.map((r) =>
            r.key === row.key
              ? { ...r, supplyQty: { ...r.supplyQty, [supplyId]: savedKitQty } }
              : r
          )
        );
      } finally {
        setSavingCell(null);
      }
      return;
    }

    const componentQty = raw === '' || raw == null ? 0 : Math.max(0, parseInt(raw, 10) || 0);

    if (cell.multiSource || cell.parts?.length > 1) {
      setErr('Несколько комплектов дают эту позицию — измените количество в карточке поставки');
      return;
    }

    const isKitCell = cell.isKitComponent && cell.kitProductId;
    const perKit = Math.max(1, Number(cell.perKit) || 1);
    const savedComponentQty = isKitCell
      ? kitUnitsToComponentQty(cell.quantity, perKit)
      : Number(cell.quantity) || 0;

    if (componentQty === savedComponentQty) {
      if (raw === '') {
        updateRows((rows) =>
          rows.map((r) =>
            r.key === row.key
              ? recalcPurchaseRow({
                  ...r,
                  supplyQty: { ...r.supplyQty, [supplyId]: savedComponentQty },
                })
              : r
          )
        );
      }
      return;
    }

    const kitQtyToSave = isKitCell
      ? componentQtyToKitUnits(componentQty, perKit)
      : componentQty;

    const cellKey = `${supplyId}:${cell.supplyItemId}`;
    setSavingCell(cellKey);
    setErr(null);
    try {
      const result = await fboSuppliesApi.updateSupplyItem(
        supplyId,
        cell.supplyItemId,
        kitQtyToSave
      );
      const savedKitQty = result.deleted ? 0 : result.quantity;
      updateRows((rows) =>
        recalcPurchaseRows(
          rows.map((r) => {
            const c = r.supplyCells?.[supplyId];
            if (!c || c.supplyItemId !== cell.supplyItemId) return r;
            if (result.deleted) {
              const supplyQty = { ...r.supplyQty };
              const supplyCells = { ...r.supplyCells };
              delete supplyQty[supplyId];
              delete supplyCells[supplyId];
              return { ...r, supplyQty, supplyCells };
            }
            if (c.isKitComponent) {
              const pk = Math.max(1, Number(c.perKit) || 1);
              return {
                ...r,
                supplyQty: {
                  ...r.supplyQty,
                  [supplyId]: kitUnitsToComponentQty(savedKitQty, pk),
                },
                supplyCells: {
                  ...r.supplyCells,
                  [supplyId]: { ...c, quantity: savedKitQty },
                },
              };
            }
            return {
              ...r,
              supplyQty: { ...r.supplyQty, [supplyId]: savedKitQty },
              supplyCells: { ...r.supplyCells, [supplyId]: { ...c, quantity: savedKitQty } },
            };
          })
        )
      );
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить количество');
      updateRows((rows) =>
        rows.map((r) =>
          r.key === row.key
            ? recalcPurchaseRow({
                ...r,
                supplyQty: { ...r.supplyQty, [supplyId]: savedComponentQty },
              })
            : r
        )
      );
    } finally {
      setSavingCell(null);
    }
    },
    [calc?.rows, updateRows, load]
  );

  const openReplace = (row, supply, cell) => {
    const isKitComponent = cell.isKitComponent && cell.kitProductId;
    const inSupply = Number(row.supplyQty[supply.id]) || 0;
    const defaultQty = inSupply > 0 ? inSupply : Math.max(1, row.toPurchase || 1);
    setReplaceCtx({
      supplyId: supply.id,
      supplyLabel: supply.label,
      mode: isKitComponent ? 'add' : 'replace',
      supplyItemId: cell.supplyItemId,
      currentProductName: row.productName,
      currentSku: row.sku,
      defaultQty: isKitComponent && row.toPurchase > 0 ? row.toPurchase : defaultQty,
    });
    setErr(null);
  };

  const handleReplaceConfirm = async ({ productId, quantity }) => {
    if (!replaceCtx) return;
    setReplaceSaving(true);
    setErr(null);
    try {
      if (replaceCtx.mode === 'add') {
        await fboSuppliesApi.addSupplyItem(replaceCtx.supplyId, { productId, quantity });
      } else {
        await fboSuppliesApi.replaceSupplyItem(replaceCtx.supplyId, replaceCtx.supplyItemId, {
          productId,
          quantity,
        });
      }
      setReplaceCtx(null);
      await load();
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить замену');
    } finally {
      setReplaceSaving(false);
    }
  };

  const selectedPurchaseItems = useMemo(
    () =>
      (calc?.rows || [])
        .filter((r) => selectedRowKeys.has(r.key) && isRowSelectable(r))
        .map((r) => ({
          rowKey: r.key,
          productId: r.productId,
          quantity: r.remainingToPurchase,
        })),
    [calc?.rows, selectedRowKeys]
  );

  const handleExportExcel = async () => {
    if (!calc?.rows?.length || !supplyIdsForExport.length) return;
    setExportLoading(true);
    setErr(null);
    try {
      const { buffer, filename } = await fboSuppliesApi.downloadPurchaseCalcExcel({
        supplyIds: supplyIdsForExport,
        calc,
      });
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      let msg = e.response?.data?.message || e.message || 'Не удалось выгрузить Excel';
      if (e.response?.data instanceof ArrayBuffer) {
        try {
          const txt = new TextDecoder().decode(e.response.data);
          const j = JSON.parse(txt);
          msg = j.message || j.error || msg;
        } catch {
          /* ignore */
        }
      }
      setErr(msg);
    } finally {
      setExportLoading(false);
    }
  };

  const handleCreatePurchase = async () => {
    const sid = session?.id ?? sessionIdFromUrl;
    if (!sid) {
      setErr('Сессия расчёта не найдена');
      return;
    }
    if (!selectedPurchaseItems.length) {
      setErr('Отметьте галочками позиции для закупки');
      return;
    }
    if (!createSupplierId) {
      setErr('Выберите поставщика');
      return;
    }
    setPurchaseSaving(true);
    setErr(null);
    setSuccessMsg(null);
    try {
      const res = await fboSuppliesApi.createPurchaseFromCalcSession(sid, {
        supplierId: Number(createSupplierId),
        organizationId: Number(createOrganizationId),
        warehouseId: Number(createWarehouseId),
        items: selectedPurchaseItems,
      });
      setSession(res.session);
      setPurchaseLinks(res.purchaseLinks || []);
      setCalc(applyCalcRows(res.calc, { withProgress: true }));
      setSelectedRowKeys(new Set());
      setPurchaseOpen(false);
      const pid = res.purchaseId ?? res.purchase?.id;
      const pending = (res.calc?.rows || []).filter(isRowSelectable).length;
      if (res.session?.status === 'completed') {
        setSuccessMsg(
          pid
            ? `Закупка №${pid} создана. Все позиции расчёта оформлены — сессия завершена.`
            : 'Все позиции расчёта оформлены — сессия завершена.'
        );
      } else {
        setSuccessMsg(
          pid
            ? `Закупка №${pid} создана. Осталось оформить: ${pending} поз.`
            : `Закупка создана. Осталось оформить: ${pending} поз.`
        );
      }
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось создать закупку');
    } finally {
      setPurchaseSaving(false);
    }
  };

  if (loading) return <div className="fbo-supplies-page">Расчёт закупки…</div>;

  return (
    <div className="fbo-supplies-page">
      <FboOpenCalcSessionsBanner excludeSessionId={session?.id ?? sessionIdFromUrl} compact />

      <div className="fbo-supplies-toolbar">
        <Button variant="secondary" size="small" onClick={() => navigate('/stock-levels/fbo-supplies')}>
          ← К поставкам
        </Button>
        <h2 style={{ margin: 0, flex: 1 }}>Расчёт закупки FBO</h2>
        <Button
          variant="secondary"
          size="small"
          disabled={!calc?.rows?.length || exportLoading}
          onClick={handleExportExcel}
        >
          {exportLoading ? 'Выгрузка…' : 'Excel'}
        </Button>
        <Button
          variant="primary"
          size="small"
          disabled={!selectedPurchaseItems.length || session?.status === 'completed'}
          onClick={() => setPurchaseOpen(true)}
        >
          Закупить выбранное ({selectedPurchaseItems.length})
        </Button>
      </div>

      {session?.id && session.status !== 'completed' ? (
        <div className="fbo-open-calc-sessions-banner fbo-open-calc-sessions-banner--current" role="status">
          <div className="fbo-open-calc-sessions-banner__title">
            Текущий расчёт закупки №{session.id} · в работе
          </div>
          <p className="fbo-open-calc-sessions-banner__hint">
            {selectableRows.length > 0
              ? `Осталось оформить: ${selectableRows.length} поз. Прогресс сохраняется — можно вернуться позже через «Поставки FBO».`
              : 'Все позиции закуплены или покрыты остатком.'}
          </p>
        </div>
      ) : null}

      {session?.id && session.status === 'completed' ? (
        <p className="fbo-packing-hint" style={{ marginBottom: 8 }}>
          Сессия расчёта №{session.id} · завершена. Все позиции оформлены.
        </p>
      ) : null}

      {successMsg ? (
        <div className="alert alert-success" style={{ marginBottom: 12 }}>
          {successMsg}
        </div>
      ) : null}

      {err && <div className="alert alert-danger">{err}</div>}

      {calc?.fboWarehouse ? (
        <p className="fbo-packing-hint">
          Склад FBO: <strong>{calc.fboWarehouse.label}</strong>. К закупке = потребность − наличие − в пути −
          уже оформлено. Отметьте галочками позиции и создайте закупку у нужного поставщика; можно
          несколько закупок на одну сессию. Комплекты показаны отдельной строкой; ниже — комплектующие к закупке.
        </p>
      ) : null}

      {purchaseLinks.length > 0 ? (
        <div className="fbo-packing-hint" style={{ marginBottom: 12 }}>
          <strong>Закупки по этому расчёту:</strong>{' '}
          {purchaseLinks.map((l) => (
            <button
              key={l.id}
              type="button"
              className="btn btn-link btn-sm p-0 me-2"
              onClick={() =>
                navigate('/stock-levels/purchases', { state: { openPurchaseId: l.purchaseId } })
              }
            >
              №{l.purchaseId}
              {l.supplierName ? ` (${l.supplierName})` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {calc ? (
        <div className="fbo-purchase-calc-wrap table-responsive">
          <table className="table table-sm table-bordered fbo-purchase-calc-table">
            <thead>
              <tr>
                <th className="fbo-pc-check-col">
                  <input
                    type="checkbox"
                    checked={allSelectableSelected}
                    disabled={!selectableRows.length}
                    onChange={toggleSelectAll}
                    title="Выбрать все к закупке"
                  />
                </th>
                <th className="fbo-pc-sticky-col">Товар</th>
                <th>Артикул</th>
                <th>К закупке</th>
                <th>Закуплено</th>
                <th>Наличие</th>
                <th>В пути</th>
                {calc.supplies.map((s) => (
                  <th key={s.id} className="fbo-pc-supply-col" title={s.columnTitle || s.label}>
                    {s.label}
                  </th>
                ))}
                <th>Себест.</th>
                <th>Итого себест.</th>
              </tr>
            </thead>
            <tbody>
              {calc.rows.map((row) => {
                const isKitHeader = row.rowType === 'kit' || row.isKitHeader;
                const isComponent = row.rowType === 'component';
                const selectable = isRowSelectable(row);
                const checked = selectedRowKeys.has(row.key);
                return (
                <tr
                  key={row.key}
                  className={[
                    row.purchaseComplete && !isKitHeader ? 'fbo-item-row--complete' : '',
                    checked ? 'fbo-pc-row-selected' : '',
                    isKitHeader ? 'fbo-pc-kit-header-row' : '',
                    isComponent ? 'fbo-pc-kit-component-row' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <td className="fbo-pc-check-col">
                    {selectable ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRowSelected(row.key)}
                        aria-label={`Выбрать ${row.sku || row.productName || 'позицию'}`}
                      />
                    ) : null}
                  </td>
                  <td className="fbo-pc-sticky-col">
                    {isKitHeader ? (
                      <div className="fbo-pc-kit-header-name">
                        <span className="badge bg-secondary me-1">комплект</span>
                        {getPurchaseRowDisplayName(row)}
                      </div>
                    ) : (
                      <div className={isComponent ? 'fbo-pc-kit-component-name' : undefined}>
                        {isComponent ? <span className="fbo-pc-kit-component-marker" aria-hidden>↳</span> : null}
                        {getPurchaseRowDisplayName(row)}
                      </div>
                    )}
                  </td>
                  <td>{row.sku || '—'}</td>
                  <td>
                    {isKitHeader ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <>
                        <strong>{row.remainingToPurchase ?? row.toPurchase}</strong>
                        {row.isKitComponentRow && row.perKit > 1 ? (
                          <div className="text-muted small">{row.perKit} шт./компл.</div>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td>{isKitHeader ? '—' : row.purchasedQty > 0 ? row.purchasedQty : '—'}</td>
                  <td>{isKitHeader ? '—' : row.onHand}</td>
                  <td>{isKitHeader ? '—' : row.incoming}</td>
                  {calc.supplies.map((s) => {
                    const cell = row.supplyCells?.[s.id];
                    const cellKey = cell?.supplyItemId
                      ? `${s.id}:${cell.supplyItemId}`
                      : null;
                    const isSaving = savingCell === cellKey;
                    const val = row.supplyQty[s.id];
                    const readOnlyCell =
                      !cell?.supplyItemId ||
                      cell.multiSource ||
                      (cell.parts?.length ?? 0) > 1;
                    const canReplace =
                      !isKitHeader &&
                      cell?.supplyItemId &&
                      !cell.multiSource &&
                      !(cell.parts?.length > 1);
                    const replaceTitle = cell?.isKitComponent
                      ? 'Добавить аналог в поставку'
                      : 'Заменить товар в поставке';

                    if (readOnlyCell) {
                      return (
                        <td key={s.id} className="text-center">
                          {val != null ? val : '—'}
                        </td>
                      );
                    }
                    return (
                      <td key={s.id} className="text-center">
                        <div className="fbo-pc-supply-cell">
                          <input
                            type="number"
                            min={0}
                            max={99999}
                            className={`form-control form-control-sm fbo-pc-qty-input${
                              isSaving ? ' fbo-pc-qty-saving' : ''
                            }`}
                            value={val ?? 0}
                            disabled={isSaving}
                            title={
                              isKitHeader
                                ? 'Количество комплектов в поставке'
                                : cell.isKitComponent
                                  ? `${cell.quantity ?? 0} компл. × ${cell.perKit ?? 1} шт. В поставке сохраняется число комплектов.`
                                  : undefined
                            }
                            onChange={(e) =>
                              handleSupplyQtyChange(row.key, s.id, e.target.value)
                            }
                            onBlur={() => handleSupplyQtyBlur(row.key, s.id)}
                          />
                          {canReplace ? (
                            <Button
                              variant="secondary"
                              size="small"
                              className="btn-icon btn-icon-only"
                              disabled={isSaving || replaceSaving}
                              title={replaceTitle}
                              aria-label={replaceTitle}
                              onClick={() => openReplace(row, s, cell)}
                            >
                              ⇄
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                  <td>{isKitHeader ? '—' : fmtMoney(row.cost)}</td>
                  <td>{isKitHeader ? '—' : fmtMoney(row.lineCostTotal)}</td>
                </tr>
              );
              })}
            </tbody>
            <tfoot>
              <tr className="fbo-purchase-calc-tfoot">
                <th colSpan={3} className="text-end">
                  Итого к закупке
                </th>
                <th>
                  <strong>{calc.totals.toPurchaseQty}</strong>
                </th>
                <th>{calc.totals.purchasedQty > 0 ? calc.totals.purchasedQty : '—'}</th>
                <th colSpan={2 + calc.supplies.length} />
                <th />
                <th>
                  <strong>{fmtMoney(calc.totals.costSum)}</strong>
                </th>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      <FboPurchaseReplaceModal
        context={replaceCtx}
        saving={replaceSaving}
        onClose={() => !replaceSaving && setReplaceCtx(null)}
        onConfirm={handleReplaceConfirm}
      />

      <Modal
        isOpen={purchaseOpen}
        onClose={() => !purchaseSaving && setPurchaseOpen(false)}
        title="Создать закупку"
        size="medium"
      >
        <p className="text-muted small">
          Выбрано позиций: <strong>{selectedPurchaseItems.length}</strong>, шт.:{' '}
          <strong>
            {selectedPurchaseItems.reduce((s, it) => s + (Number(it.quantity) || 0), 0)}
          </strong>
          , сумма себестоимости по выбранному:{' '}
          <strong>
            {fmtMoney(
              (calc?.rows || [])
                .filter((r) => selectedRowKeys.has(r.key))
                .reduce((s, r) => s + (Number(r.lineCostTotal) || 0), 0)
            )}
          </strong>
        </p>
        <div className="mb-3">
          <label className="form-label">Поставщик</label>
          <select
            className="form-select form-select-sm"
            value={createSupplierId}
            onChange={(e) => setCreateSupplierId(e.target.value)}
          >
            <option value="">— выберите —</option>
            {(suppliers || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.code || `#${s.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Организация</label>
          <select
            className="form-select form-select-sm"
            value={createOrganizationId}
            onChange={(e) => setCreateOrganizationId(e.target.value)}
          >
            <option value="">—</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Склад назначения</label>
          <select
            className="form-select form-select-sm"
            value={createWarehouseId}
            onChange={(e) => setCreateWarehouseId(e.target.value)}
          >
            <option value="">—</option>
            {(warehouses || [])
              .filter((w) => w.type === 'warehouse' && !w.supplierId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.address || w.name || `#${w.id}`}
                  {w.isFboStock ? ' (FBO)' : ''}
                </option>
              ))}
          </select>
        </div>
        <div className="d-flex justify-content-end gap-2">
          <Button variant="secondary" onClick={() => setPurchaseOpen(false)} disabled={purchaseSaving}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleCreatePurchase} disabled={purchaseSaving}>
            {purchaseSaving ? 'Создание…' : 'Создать закупку'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

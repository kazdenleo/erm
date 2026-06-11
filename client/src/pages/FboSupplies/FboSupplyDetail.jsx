/**
 * Карточка поставки FBO
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { useOrganizations } from '../../hooks/useOrganizations';
import {
  filterDeductionWarehouses,
  warehouseSelectLabel,
} from '../../utils/deductionWarehouses.js';
import { Button } from '../../components/common/Button/Button';
import { ProductLabelPrintModal } from '../../components/products/ProductLabelPrintModal.jsx';
import {
  canUsePrintHelper,
  openProductLabelPrintTab,
  openProductLabelsBatchPrintTab,
  useProductLabelPrint,
} from '../../hooks/useProductLabelPrint.js';
import { resolveApiBaseUrl } from '../../services/api';
import {
  FBO_SUPPLY_STATUS_ORDER,
  FBO_SUPPLY_STATUS_OPTIONS,
  canSelectFboSupplyStatus,
  getFboSupplyStatusLabel,
  getMarketplaceLabel,
  hasPackingDiscrepancy,
} from '../../constants/fboSupplyStatuses';
import { FboSupplyPacking } from './FboSupplyPacking.jsx';
import { FboSupplyPackedBreakdownModal } from './FboSupplyPackedBreakdownModal.jsx';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';
import { ozonPlacementZoneLabel } from '../../constants/ozonPlacementZones';
import './FboSupplies.css';

function packedCellClass(packed, planned) {
  if (packed === planned) return 'ok';
  if (packed > planned) return 'over';
  if (packed > 0) return 'short';
  return 'none';
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
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

function itemToPrintProduct(it) {
  const catId = it.productCategoryId;
  return {
    id: it.productId,
    name: it.productName || it.name,
    sku: it.sku,
    user_category_id: catId,
    userCategoryId: catId,
    categoryId: catId,
  };
}

export function FboSupplyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organizations } = useOrganizations();
  const [allWarehouses, setAllWarehouses] = useState([]);
  const [warehousesLoading, setWarehousesLoading] = useState(false);
  const [warehousesError, setWarehousesError] = useState(null);
  const [supply, setSupply] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [stockMsg, setStockMsg] = useState(null);
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  const [printHelperUrl, setPrintHelperUrl] = useState('');
  const [labelPrintItem, setLabelPrintItem] = useState(null);
  const [printMsg, setPrintMsg] = useState(null);
  const [activeTab, setActiveTab] = useState('info');
  const [packing, setPacking] = useState(null);
  const [breakdownItem, setBreakdownItem] = useState(null);
  const [packingExporting, setPackingExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncingPlacementZones, setSyncingPlacementZones] = useState(false);
  const [placementZonesMsg, setPlacementZonesMsg] = useState(null);
  const [submittingPacking, setSubmittingPacking] = useState(false);
  const [submitPackingMsg, setSubmitPackingMsg] = useState(null);
  const [itemSearchQuery, setItemSearchQuery] = useState('');
  const selectAllItemsRef = useRef(null);
  const autoPlacementSyncAttemptedRef = useRef(null);

  const deductionWarehouses = useMemo(
    () => filterDeductionWarehouses(allWarehouses, supply?.deductionWarehouseId),
    [allWarehouses, supply?.deductionWarehouseId]
  );

  const {
    printProductLabel,
    printing: labelPrinting,
    error: labelPrintError,
    setError: setLabelPrintError,
  } = useProductLabelPrint(printHelperUrl);

  const loadDeductionWarehouses = useCallback(async (organizationId) => {
    setWarehousesLoading(true);
    setWarehousesError(null);
    try {
      const params =
        organizationId != null && organizationId !== ''
          ? { organizationId: String(organizationId) }
          : {};
      const whList = await fboSuppliesApi.getDeductionWarehouses(params);
      setAllWarehouses(Array.isArray(whList) ? whList : []);
      setWarehousesError(null);
    } catch (whErr) {
      console.error('Error loading FBO deduction warehouses:', whErr);
      setAllWarehouses([]);
      setWarehousesError(
        whErr.response?.data?.message || whErr.message || 'Ошибка загрузки складов'
      );
    } finally {
      setWarehousesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setWarehousesLoading(true);
    setWarehousesError(null);
    setErr(null);
    try {
      const data = await fboSuppliesApi.getById(id);
      setSupply(data);
      setSelectedItemIds(new Set());
      await loadDeductionWarehouses(data?.organizationId);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить поставку');
      setAllWarehouses([]);
      setWarehousesLoading(false);
    } finally {
      setLoading(false);
    }
  }, [id, loadDeductionWarehouses]);

  const loadPacking = useCallback(async () => {
    try {
      const data = await fboSuppliesApi.getPacking(id);
      setPacking(data);
    } catch {
      setPacking({ cargoUnits: [], itemStats: [] });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (supply?.id) loadPacking();
  }, [supply?.id, loadPacking]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}/config`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setPrintHelperUrl((body?.data?.printHelperUrl ?? '').trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const printableItems = useMemo(
    () => (supply?.items || []).filter((it) => it.productId),
    [supply?.items]
  );

  const allPrintableSelected =
    printableItems.length > 0 && printableItems.every((it) => selectedItemIds.has(String(it.id)));
  const somePrintableSelected = printableItems.some((it) => selectedItemIds.has(String(it.id)));

  useEffect(() => {
    const el = selectAllItemsRef.current;
    if (el) el.indeterminate = somePrintableSelected && !allPrintableSelected;
  }, [somePrintableSelected, allPrintableSelected]);

  const selectedPrintableItems = useMemo(
    () => printableItems.filter((it) => selectedItemIds.has(String(it.id))),
    [printableItems, selectedItemIds]
  );

  const statsByItemId = useMemo(
    () => buildStatsMap(packing?.itemStats),
    [packing?.itemStats]
  );

  const sortedSupplyItems = useMemo(
    () => sortSupplyItemsForPacking(supply?.items || [], statsByItemId),
    [supply?.items, statsByItemId]
  );

  const filteredSupplyItems = useMemo(
    () => filterSupplyItemsByQuery(sortedSupplyItems, itemSearchQuery),
    [sortedSupplyItems, itemSearchQuery]
  );

  const itemSearchActive = Boolean(normalizeProductSearchQuery(itemSearchQuery));

  const packingHasDiscrepancy = hasPackingDiscrepancy(supply, packing);

  const handlePackingChange = useCallback((newPacking, meta) => {
    setPacking(newPacking);
    if (meta && Object.prototype.hasOwnProperty.call(meta, 'packingAllMatch')) {
      setSupply((s) =>
        s
          ? {
              ...s,
              packingAllMatch: meta.packingAllMatch,
              hasPackingDiscrepancy: meta.packingAllMatch === false,
            }
          : s
      );
    }
  }, []);

  const saveField = async (patch) => {
    setSaving(true);
    try {
      const data = await fboSuppliesApi.update(id, patch);
      setSupply((prev) => {
        if (!prev) return data;
        if (Object.prototype.hasOwnProperty.call(patch, 'deductionWarehouseId')) {
          return { ...prev, ...data };
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'deductStock')) {
          return { ...prev, deductStock: data.deductStock };
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
          return { ...prev, ...data };
        }
        return { ...prev, ...data };
      });
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleExportPackingExcel = async () => {
    setPackingExporting(true);
    setErr(null);
    try {
      const { buffer, filename } = await fboSuppliesApi.downloadPackingExcel(id);
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
      setErr(e.response?.data?.message || e.message || 'Не удалось выгрузить Excel');
    } finally {
      setPackingExporting(false);
    }
  };

  const handleSyncOzonPlacementZones = useCallback(async () => {
    setSyncingPlacementZones(true);
    setErr(null);
    setPlacementZonesMsg(null);
    try {
      const data = await fboSuppliesApi.syncOzonPlacementZones(id);
      if (data?.supply) setSupply(data.supply);
      const parts = [];
      if (data?.updated > 0) parts.push(`обновлено ${data.updated}`);
      if (data?.unchanged > 0) parts.push(`без изменений ${data.unchanged}`);
      if (data?.missing > 0) parts.push(`не сопоставлено ${data.missing}`);
      setPlacementZonesMsg(
        parts.length
          ? `Зоны размещения с Ozon: ${parts.join(', ')}.`
          : 'Зоны размещения обновлены.'
      );
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось обновить зоны размещения');
    } finally {
      setSyncingPlacementZones(false);
    }
  }, [id]);

  const handleSubmitPackingToMarketplace = async () => {
    if (!supply) return;
    const mp = supply.marketplace;
    const isOzon =
      mp !== 'wb' && mp !== 'ym' && mp !== 'yandex';
    const mpLabel = isOzon ? 'Ozon' : mp === 'wb' ? 'Wildberries' : 'маркетплейс';
    if (
      !window.confirm(
        `Отправить состав грузомест в ${mpLabel}? Убедитесь, что сборка совпадает с планом.`
      )
    ) {
      return;
    }
    setSubmittingPacking(true);
    setErr(null);
    setSubmitPackingMsg(null);
    try {
      const data = await fboSuppliesApi.submitPackingToMarketplace(id);
      setSubmitPackingMsg(data?.message || 'Состав отправлен на маркетплейс');
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось отправить состав');
    } finally {
      setSubmittingPacking(false);
    }
  };

  useEffect(() => {
    if (!supply?.id || loading || syncingPlacementZones) return;
    if (autoPlacementSyncAttemptedRef.current === String(supply.id)) return;
    const isOzon =
      supply.marketplace !== 'wb' && supply.marketplace !== 'ym' && supply.marketplace !== 'yandex';
    const canSync = isOzon && Boolean(supply.externalShipmentNumber || supply.externalSupplyId);
    const needsZones = (supply.items || []).some((it) => !it.placementZone);
    if (!canSync || !needsZones) return;
    autoPlacementSyncAttemptedRef.current = String(supply.id);
    handleSyncOzonPlacementZones();
  }, [
    supply?.id,
    supply?.items,
    supply?.marketplace,
    supply?.externalShipmentNumber,
    supply?.externalSupplyId,
    loading,
    syncingPlacementZones,
    handleSyncOzonPlacementZones,
  ]);

  const applyStatusChangeResult = (data) => {
    setSupply(data);
    const sd = data?.stockDeduction;
    if (sd?.applied) {
      setStockMsg(`Списано остатков по ${sd.deductedLines} строкам.`);
    } else if (data.status === 'shipped' && data.deductStock && sd?.error) {
      setStockMsg(sd.error);
    } else if (data.status === 'shipped' && data.deductStock && sd?.reason === 'already_deducted') {
      setStockMsg('Остатки уже были списаны ранее.');
    } else {
      setStockMsg(null);
    }
  };

  const handleStatusChange = async (newStatus) => {
    if (!supply || newStatus === supply.status) return;
    if (!canSelectFboSupplyStatus(newStatus, packingHasDiscrepancy)) {
      setErr(
        'Нельзя перевести в «Готов к поставке»: есть расхождения между планом и сборкой. Упакуйте ровно запланированное количество.'
      );
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.update(id, { status: newStatus });
      applyStatusChangeResult(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сменить статус');
    } finally {
      setSaving(false);
    }
  };

  const toggleItemSelected = (itemId, e) => {
    e?.stopPropagation?.();
    const sid = String(itemId);
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const toggleSelectAllPrintable = () => {
    if (allPrintableSelected) {
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set(printableItems.map((it) => String(it.id))));
    }
  };

  const printOneItem = async (it, copiesOverride) => {
    const copies = Math.min(99, Math.max(1, parseInt(copiesOverride ?? it.quantity, 10) || 1));
    const marketplace = supply?.marketplace || undefined;
    if (!canUsePrintHelper(printHelperUrl)) {
      return openProductLabelPrintTab(it.productId, copies, marketplace);
    }
    return printProductLabel(it.productId, { copies, marketplace });
  };

  const buildBatchPrintItems = (items) =>
    items.map((it) => {
      const name = it.productName || it.name || '';
      const sku = it.sku ? String(it.sku) : '';
      const title = [name, sku].filter(Boolean).join(' — ') || `Товар #${it.productId}`;
      return {
        productId: it.productId,
        copies: Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
        title,
        marketplace: supply?.marketplace || undefined,
      };
    });

  const totalLabelsToPrint = useMemo(
    () =>
      selectedPrintableItems.reduce(
        (sum, it) => sum + Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
        0
      ),
    [selectedPrintableItems]
  );

  const handleBulkPrintLabels = () => {
    if (!selectedPrintableItems.length) {
      setPrintMsg('Отметьте одну или несколько строк в таблице (или «Выбрать все»).');
      return;
    }
    setPrintMsg(null);
    setLabelPrintError(null);
    const batchItems = buildBatchPrintItems(selectedPrintableItems);
    if (!openProductLabelsBatchPrintTab(batchItems)) {
      setPrintMsg(
        'Не удалось открыть вкладку печати. Разрешите всплывающие окна для этого сайта и повторите.'
      );
      return;
    }
    setPrintMsg(
      `Открыта печать: ${selectedPrintableItems.length} поз., всего ${totalLabelsToPrint} этикет. (по колонке «Кол-во»)`
    );
  };

  const handleSelectAllForPrint = () => {
    setSelectedItemIds(new Set(printableItems.map((it) => String(it.id))));
    setPrintMsg(null);
  };

  const handleClearSelection = () => {
    setSelectedItemIds(new Set());
    setPrintMsg(null);
  };

  const openSingleLabelModal = (it) => {
    setLabelPrintError(null);
    setLabelPrintItem(it);
  };

  const closeLabelModal = () => {
    if (labelPrinting) return;
    setLabelPrintItem(null);
    setLabelPrintError(null);
  };

  const handleSingleLabelConfirm = async (copies) => {
    const it = labelPrintItem;
    if (!it?.productId) return;
    setLabelPrintItem(null);
    const ok = await printOneItem(it, copies);
    if (!ok) {
      setLabelPrintItem(it);
      if (!labelPrintError) {
        setLabelPrintError('Не удалось напечатать. Разрешите всплывающие окна или настройте Print Helper.');
      }
    }
  };

  if (loading) return <div className="fbo-supplies-page">Загрузка…</div>;
  if (!supply) {
    return (
      <div className="fbo-supplies-page">
        <p>{err || 'Поставка не найдена'}</p>
        <Button variant="secondary" onClick={() => navigate('/fbo-supplies')}>
          К списку
        </Button>
      </div>
    );
  }

  const statusIdx = FBO_SUPPLY_STATUS_ORDER.indexOf(supply.status);
  const isOzonSupply =
    supply.marketplace !== 'wb' && supply.marketplace !== 'ym' && supply.marketplace !== 'yandex';
  const canSyncOzonPlacementZones =
    isOzonSupply && Boolean(supply.externalShipmentNumber || supply.externalSupplyId);

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <Button variant="secondary" size="small" onClick={() => navigate('/fbo-supplies')}>
          ← К списку
        </Button>
        <h2 style={{ margin: 0, flex: 1 }}>
          Поставка FBO № {supply.id}
          {supply.externalShipmentNumber ? ` · ${supply.externalShipmentNumber}` : ''}
        </h2>
        <Button
          variant="secondary"
          size="small"
          disabled={packingExporting || !(packing?.cargoUnits?.length > 0)}
          onClick={handleExportPackingExcel}
          title="Состав по грузоместам для Ozon / WB"
        >
          {packingExporting ? 'Excel…' : 'Excel грузоместа'}
        </Button>
        {canSyncOzonPlacementZones ? (
          <Button
            variant="secondary"
            size="small"
            disabled={syncingPlacementZones || saving}
            onClick={handleSyncOzonPlacementZones}
            title="Подтянуть сортируемый / несортируемый с Ozon для строк поставки"
          >
            {syncingPlacementZones ? 'Зоны…' : 'Зоны с Ozon'}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="small"
          disabled={submittingPacking || saving || !(packing?.cargoUnits?.length > 0)}
          onClick={handleSubmitPackingToMarketplace}
          title="Отправить упакованный состав грузомест на маркетплейс"
        >
          {submittingPacking ? 'Отправка…' : 'На маркетплейс'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={deleting || saving}
          onClick={async () => {
            if (!window.confirm('Удалить поставку? Связанные строки и грузоместа будут удалены.')) return;
            setDeleting(true);
            setErr(null);
            try {
              await fboSuppliesApi.delete(id);
              navigate('/fbo-supplies');
            } catch (e) {
              setErr(e.response?.data?.message || e.message || 'Не удалось удалить поставку');
            } finally {
              setDeleting(false);
            }
          }}
        >
          {deleting ? 'Удаление…' : 'Удалить поставку'}
        </Button>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}
      {placementZonesMsg ? (
        <div className="alert alert-success">{placementZonesMsg}</div>
      ) : null}
      {submitPackingMsg ? (
        <div className="alert alert-success">{submitPackingMsg}</div>
      ) : null}
      {stockMsg && (
        <div className={`alert ${stockMsg.includes('Списано') ? 'alert-success' : 'alert-warning'}`}>
          {stockMsg}
        </div>
      )}
      {printMsg && <div className="alert alert-info">{printMsg}</div>}
      {labelPrintError && !labelPrintItem && (
        <div className="alert alert-danger">{labelPrintError}</div>
      )}
      {supply.status === 'shipped' && supply.deductStock && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
          {supply.stockDeductedAt
            ? `Остатки списаны: ${fmtDt(supply.stockDeductedAt)}`
            : 'Включено списание остатков — укажите склад списания и привязанные товары, затем переведите в «Отгружен».'}
        </p>
      )}

      <div className="fbo-status-stepper">
        {FBO_SUPPLY_STATUS_OPTIONS.map((s, i) => {
          const done = i < statusIdx;
          const active = s === supply.status;
          const blocked = s === 'ready_for_supply' && packingHasDiscrepancy;
          return (
            <button
              key={s}
              type="button"
              className={`fbo-status-step${active ? ' active' : ''}${done ? ' done' : ''}${blocked ? ' blocked' : ''}`}
              disabled={saving || blocked}
              title={
                blocked
                  ? 'Устраните расхождения в сборке, чтобы выбрать этот статус'
                  : `Установить: ${getFboSupplyStatusLabel(s)}`
              }
              onClick={() => handleStatusChange(s)}
            >
              {getFboSupplyStatusLabel(s)}
            </button>
          );
        })}
      </div>

      <div className="fbo-detail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`fbo-detail-tab${activeTab === 'info' ? ' active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Общее
        </button>
        <button
          type="button"
          role="tab"
          className={`fbo-detail-tab${activeTab === 'packing' ? ' active' : ''}`}
          onClick={() => setActiveTab('packing')}
        >
          Сборка
          {packing?.cargoUnits?.length ? ` (${packing.cargoUnits.length})` : ''}
        </button>
      </div>

      <div className="fbo-supply-item-search">
        <input
          type="search"
          className="form-control form-control-sm fbo-supply-item-search__input"
          value={itemSearchQuery}
          onChange={(e) => setItemSearchQuery(e.target.value)}
          placeholder="Поиск товаров: название, артикул или штрихкод"
          autoComplete="off"
          spellCheck={false}
          aria-label="Поиск товаров в поставке"
        />
        {itemSearchActive ? (
          <span className="fbo-supply-item-search__hint muted-hint" aria-live="polite">
            Найдено: <strong>{filteredSupplyItems.length}</strong> из{' '}
            <strong>{sortedSupplyItems.length}</strong>
          </span>
        ) : null}
      </div>

      {activeTab === 'packing' ? (
        <FboSupplyPacking
          supplyId={id}
          marketplace={supply.marketplace}
          supplyItems={supply.items || []}
          packing={packing}
          onPackingChange={handlePackingChange}
          onBreakdownClick={setBreakdownItem}
          itemSearchQuery={itemSearchQuery}
        />
      ) : null}

      {activeTab === 'info' ? (
      <>
      <div className="fbo-supply-meta">
        <div>
          <label>Маркетплейс</label>
          <select
            className="form-select form-select-sm"
            value={supply.marketplace || 'ozon'}
            onChange={(e) => {
              const v = e.target.value;
              setSupply((s) => ({ ...s, marketplace: v }));
              saveField({ marketplace: v });
            }}
            disabled={saving}
          >
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="ym">Яндекс Маркет</option>
          </select>
        </div>
        <div>
          <label>Дата готовности</label>
          <input
            type="date"
            className="form-control form-control-sm"
            value={fmtDate(supply.readyAt)}
            onChange={(e) => {
              const v = e.target.value || null;
              setSupply((s) => ({ ...s, readyAt: v }));
              saveField({ readyAt: v });
            }}
            disabled={saving}
          />
        </div>
        <div>
          <label>Склад маркетплейса</label>
          <input
            className="form-control form-control-sm"
            value={supply.marketplaceWarehouseName || ''}
            onChange={(e) => setSupply((s) => ({ ...s, marketplaceWarehouseName: e.target.value }))}
            onBlur={() => saveField({ marketplaceWarehouseName: supply.marketplaceWarehouseName })}
            disabled={saving}
          />
        </div>
        <div>
          <label>Кластер размещения</label>
          <input
            className="form-control form-control-sm"
            value={supply.placementCluster || ''}
            onChange={(e) => setSupply((s) => ({ ...s, placementCluster: e.target.value }))}
            onBlur={() => saveField({ placementCluster: supply.placementCluster })}
            disabled={saving}
            placeholder="Кластер со склада МП"
          />
        </div>
        <div>
          <label>Номер отгрузки</label>
          <input
            className="form-control form-control-sm"
            value={supply.externalShipmentNumber || ''}
            onChange={(e) => setSupply((s) => ({ ...s, externalShipmentNumber: e.target.value }))}
            onBlur={() => saveField({ externalShipmentNumber: supply.externalShipmentNumber })}
            disabled={saving}
            placeholder="Номер с маркетплейса"
          />
        </div>
        {isOzonSupply ? (
          <div>
            <label>ID поставки Ozon</label>
            <input
              className="form-control form-control-sm"
              value={supply.externalSupplyId || ''}
              onChange={(e) => setSupply((s) => ({ ...s, externalSupplyId: e.target.value }))}
              onBlur={() => saveField({ externalSupplyId: supply.externalSupplyId || null })}
              disabled={saving}
              placeholder="supply_id для API Ozon"
              title="Нужен для отправки грузомест в Ozon"
            />
          </div>
        ) : null}
        <div>
          <label>Организация</label>
          <select
            className="form-select form-select-sm"
            value={
              supply.organizationId != null && supply.organizationId !== ''
                ? String(supply.organizationId)
                : ''
            }
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setSupply((s) => ({ ...s, organizationId: v }));
            }}
            onBlur={async (e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              await saveField({ organizationId: v });
              await loadDeductionWarehouses(v);
            }}
            disabled={saving}
          >
            <option value="">—</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Склад списания остатков</label>
          <select
            className="form-select form-select-sm"
            value={
              supply.deductionWarehouseId != null && supply.deductionWarehouseId !== ''
                ? String(supply.deductionWarehouseId)
                : ''
            }
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw) {
                setSupply((s) => ({
                  ...s,
                  deductionWarehouseId: null,
                  deductionWarehouseName: null,
                }));
                saveField({ deductionWarehouseId: null });
                return;
              }
              const v = Number(raw);
              const picked = deductionWarehouses.find((w) => String(w.id) === raw);
              setSupply((s) => ({
                ...s,
                deductionWarehouseId: v,
                deductionWarehouseName: picked ? warehouseSelectLabel(picked) : s.deductionWarehouseName,
              }));
              saveField({ deductionWarehouseId: v });
            }}
            disabled={warehousesLoading && deductionWarehouses.length === 0}
          >
            <option value="">
              {warehousesLoading && deductionWarehouses.length === 0
                ? 'Загрузка складов…'
                : '— выберите склад —'}
            </option>
            {!warehousesLoading &&
            supply.deductionWarehouseId &&
            !deductionWarehouses.some((w) => String(w.id) === String(supply.deductionWarehouseId)) &&
            supply.deductionWarehouseName ? (
              <option value={String(supply.deductionWarehouseId)}>
                {supply.deductionWarehouseName}
              </option>
            ) : null}
            {deductionWarehouses.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {warehouseSelectLabel(w)}
                {(w.isFboStock || w.is_fbo_stock) ? ' (FBO)' : ''}
              </option>
            ))}
          </select>
          {warehousesError ? (
            <p className="text-danger small mb-0 mt-1">{warehousesError}</p>
          ) : null}
        </div>
        <div>
          <label>Списать остатки при отгрузке</label>
          <div className="form-check form-switch mt-1">
            <input
              className="form-check-input"
              type="checkbox"
              checked={!!supply.deductStock}
              onChange={(e) => {
                const v = e.target.checked;
                setSupply((s) => ({ ...s, deductStock: v }));
                saveField({ deductStock: v });
              }}
              disabled={saving}
            />
          </div>
        </div>
        <div>
          <label>Создана</label>
          <div>{fmtDt(supply.createdAt)}</div>
        </div>
        <div className="fbo-supply-meta-full">
          <label>Комментарий</label>
          <textarea
            className="form-control form-control-sm"
            value={supply.note || ''}
            onChange={(e) => setSupply((s) => ({ ...s, note: e.target.value }))}
            onBlur={() => saveField({ note: supply.note || null })}
            disabled={saving}
            placeholder="Произвольный комментарий к поставке"
            rows={3}
          />
        </div>
      </div>

      <h3 style={{ fontSize: 16, marginBottom: 8 }}>Товары поставки</h3>
      <div className="fbo-items-toolbar">
        <Button
          variant="primary"
          size="small"
          disabled={!selectedPrintableItems.length || labelPrinting}
          onClick={handleBulkPrintLabels}
          title={
            selectedPrintableItems.length
              ? `Печать ${totalLabelsToPrint} этикеток в одной вкладке`
              : 'Сначала выберите строки в таблице'
          }
        >
          Печать стикеров
          {selectedPrintableItems.length
            ? ` (${selectedPrintableItems.length} поз., ${totalLabelsToPrint} шт.)`
            : ''}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!printableItems.length}
          onClick={handleSelectAllForPrint}
        >
          Выбрать все
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!selectedItemIds.size}
          onClick={handleClearSelection}
        >
          Снять выделение
        </Button>
        <span className="muted-hint" aria-live="polite">
          {itemSearchActive ? (
            <>
              Найдено: <strong>{filteredSupplyItems.length}</strong> из{' '}
              <strong>{sortedSupplyItems.length}</strong>
              {' · '}
            </>
          ) : null}
          {printableItems.length ? (
            <>
              Выбрано: <strong>{selectedPrintableItems.length}</strong> из{' '}
              <strong>{printableItems.length}</strong> привязанных
              {selectedPrintableItems.length > 0 ? (
                <>
                  {' '}
                  · этикеток: <strong>{totalLabelsToPrint}</strong>
                </>
              ) : null}
              . Чекбокс в шапке — тоже «выбрать все».
            </>
          ) : (
            'Нет привязанных к ERM товаров — печать недоступна.'
          )}
        </span>
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-hover">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  ref={selectAllItemsRef}
                  type="checkbox"
                  checked={allPrintableSelected}
                  disabled={!printableItems.length}
                  onChange={toggleSelectAllPrintable}
                  title="Выбрать все привязанные товары"
                />
              </th>
              <th>Фото</th>
              <th>Название</th>
              <th>Артикул</th>
              <th>Штрихкод</th>
              <th title="Зарезервировано под поставку со склада списания">Кол-во</th>
              {isOzonSupply ? <th>Размещение</th> : null}
              <th>Расхождения</th>
              <th style={{ width: 48 }} />
            </tr>
          </thead>
          <tbody>
            {filteredSupplyItems.length === 0 ? (
              <tr>
                <td colSpan={isOzonSupply ? 9 : 8} className="text-muted text-center py-3">
                  {itemSearchActive ? 'Ничего не найдено' : 'Нет строк'}
                </td>
              </tr>
            ) : null}
            {filteredSupplyItems.map((it) => {
              const canPrint = Boolean(it.productId);
              const rowSelected = selectedItemIds.has(String(it.id));
              const stat = statsByItemId.get(String(it.id));
              const planned = stat?.planned ?? it.quantity ?? 0;
              const packed = stat?.packed ?? 0;
              const packedCls = packedCellClass(packed, planned);
              const packingComplete = isSupplyItemPackingComplete(stat, it);
              return (
                <tr
                  key={it.id}
                  className={[
                    !canPrint ? 'fbo-import-row-disabled' : '',
                    packingComplete ? 'fbo-item-row--complete' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      disabled={!canPrint}
                      checked={rowSelected}
                      onChange={(e) => toggleItemSelected(it.id, e)}
                      title={canPrint ? 'Выбрать для печати' : 'Товар не привязан к ERM'}
                    />
                  </td>
                  <td>
                    {it.productImage ? (
                      <img src={it.productImage} alt="" style={{ width: 40, height: 40, objectFit: 'cover' }} />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {it.productName || it.name || '—'}
                    {!it.productId && <span className="fbo-import-warn"> (не привязан)</span>}
                  </td>
                  <td>{it.sku || '—'}</td>
                  <td>{it.barcode || '—'}</td>
                  <td
                    title={
                      it.productId
                        ? `Зарезервировано: ${it.reservedQuantity ?? 0}, план: ${it.quantity ?? 0}`
                        : undefined
                    }
                  >
                    {it.productId ? (it.reservedQuantity ?? 0) : '—'}
                  </td>
                  {isOzonSupply ? (
                    <td>
                      <span
                        className={`badge ${
                          ozonPlacementZoneLabel(it.placementZone, it.ozonTags) === 'Сортируемый'
                            ? 'bg-info text-dark'
                            : ozonPlacementZoneLabel(it.placementZone, it.ozonTags) === 'Несортируемый'
                              ? 'bg-secondary'
                              : 'bg-light text-dark border'
                        }`}
                      >
                        {ozonPlacementZoneLabel(it.placementZone, it.ozonTags)}
                      </span>
                    </td>
                  ) : null}
                  <td>
                    <button
                      type="button"
                      className={`fbo-packed-cell fbo-packed-${packedCls}`}
                      onClick={() =>
                        setBreakdownItem({
                          ...it,
                          packed,
                          planned,
                          stat,
                          byCargo: stat?.byCargo || [],
                        })
                      }
                      title="Упаковано по грузоместам"
                    >
                      {packed} / {planned}
                    </button>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="secondary"
                      size="small"
                      className="btn-icon btn-icon-only"
                      disabled={!canPrint}
                      title={canPrint ? 'Печать стикера' : 'Сначала привяжите товар'}
                      aria-label="Печать стикера"
                      onClick={() => openSingleLabelModal(it)}
                    >
                      🏷️
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      ) : null}

      <ProductLabelPrintModal
        isOpen={Boolean(labelPrintItem)}
        product={labelPrintItem ? itemToPrintProduct(labelPrintItem) : null}
        defaultCopies={
          labelPrintItem
            ? Math.max(
                1,
                parseInt(
                  statsByItemId.get(String(labelPrintItem.id))?.planned ??
                    labelPrintItem.quantity,
                  10
                ) || 1
              )
            : 1
        }
        onClose={closeLabelModal}
        onPrint={handleSingleLabelConfirm}
        printing={labelPrinting}
        error={labelPrintError}
      />

      <FboSupplyPackedBreakdownModal
        isOpen={Boolean(breakdownItem)}
        item={breakdownItem}
        onClose={() => setBreakdownItem(null)}
      />
    </div>
  );
}

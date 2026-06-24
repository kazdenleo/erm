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
  fboSupplyStatusBlockedTitle,
  getFboSupplyStatusLabel,
  getFboSupplyStatusClass,
  getMarketplaceLabel,
  hasPackingDiscrepancy,
} from '../../constants/fboSupplyStatuses';
import { FboSupplyPacking } from './FboSupplyPacking.jsx';
import { FboSupplyStatusBadge } from '../../components/fbo/FboSupplyStatusBadge.jsx';
import { FboSupplyPackedBreakdownModal } from './FboSupplyPackedBreakdownModal.jsx';
import { FboSupplyItemGeneralQty } from './FboSupplyItemGeneralQty.jsx';
import { getFboItemReserveParts } from './fboSupplyItemReserve.js';
import { FboPurchaseReplaceModal } from './FboPurchaseReplaceModal.jsx';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForGeneral,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';
import { ozonPlacementZoneLabel } from '../../constants/ozonPlacementZones';
import './FboSupplies.css';

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

function supplyExternalShipmentNumber(supply) {
  return String(
    supply?.externalShipmentNumber ?? supply?.external_shipment_number ?? ''
  ).trim();
}

function supplyExternalSupplyId(supply) {
  return String(supply?.externalSupplyId ?? supply?.external_supply_id ?? '').trim();
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
  const [syncingMpContent, setSyncingMpContent] = useState(false);
  const [syncMpContentMsg, setSyncMpContentMsg] = useState(null);
  const [pullingMpContent, setPullingMpContent] = useState(false);
  const [pullMpContentMsg, setPullMpContentMsg] = useState(null);
  const [statusSyncing, setStatusSyncing] = useState(false);
  const [statusSyncMsg, setStatusSyncMsg] = useState(null);
  const [itemSearchQuery, setItemSearchQuery] = useState('');
  const [replaceCtx, setReplaceCtx] = useState(null);
  const [replaceSaving, setReplaceSaving] = useState(false);
  const selectAllItemsRef = useRef(null);
  const autoPlacementSyncAttemptedRef = useRef(null);
  const statusSyncInFlightRef = useRef(false);

  const STATUS_SYNC_POLL_MS = 90000;

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

  const generalSupplyItems = useMemo(
    () => sortSupplyItemsForGeneral(supply?.items || []),
    [supply?.items]
  );

  const filteredGeneralItems = useMemo(
    () => filterSupplyItemsByQuery(generalSupplyItems, itemSearchQuery),
    [generalSupplyItems, itemSearchQuery]
  );

  const filteredSupplyItems = useMemo(
    () => filterSupplyItemsByQuery(sortedSupplyItems, itemSearchQuery),
    [sortedSupplyItems, itemSearchQuery]
  );

  const itemSearchActive = Boolean(normalizeProductSearchQuery(itemSearchQuery));

  const supplyReserveTotals = useMemo(() => {
    const items = supply?.items || [];
    return items.reduce(
      (acc, it) => {
        const { stock, incoming, total } = getFboItemReserveParts(it);
        acc.stock += stock;
        acc.incoming += incoming;
        acc.reserved += total;
        acc.qty += Number(it.quantity) || 0;
        return acc;
      },
      { stock: 0, incoming: 0, reserved: 0, qty: 0 }
    );
  }, [supply?.items]);

  const packingHasDiscrepancy = hasPackingDiscrepancy(supply, packing);

  const handleItemQuantitySaved = useCallback(
    async (data) => {
      if (data?.deleted) {
        setSupply((s) =>
          s ? { ...s, items: (s.items || []).filter((it) => String(it.id) !== String(data.id)) } : s
        );
        setSelectedItemIds((prev) => {
          const next = new Set(prev);
          next.delete(String(data.id));
          return next;
        });
      } else if (data?.id != null) {
        setSupply((s) =>
          s
            ? {
                ...s,
                items: (s.items || []).map((it) =>
                  String(it.id) === String(data.id) ? { ...it, quantity: data.quantity } : it
                ),
              }
            : s
        );
      }
      if (
        data?.supplyStatus != null ||
        data?.packingAllMatch != null ||
        data?.pendingMpContentUpdate != null
      ) {
        setSupply((s) =>
          s
            ? {
                ...s,
                ...(data.supplyStatus != null ? { status: data.supplyStatus } : {}),
                ...(data.packingAllMatch != null
                  ? {
                      packingAllMatch: data.packingAllMatch,
                      hasPackingDiscrepancy: data.packingAllMatch === false,
                    }
                  : {}),
                ...(data.statusReverted ? { statusRevertedByPacking: true } : {}),
                ...(data.pendingMpContentUpdate != null
                  ? { pendingMpContentUpdate: data.pendingMpContentUpdate === true }
                  : {}),
              }
            : s
        );
      }
      await loadPacking();
      try {
        const fresh = await fboSuppliesApi.getById(id);
        setSupply(fresh);
      } catch {
        /* keep optimistic state */
      }
    },
    [id, loadPacking]
  );

  const canEditSupplyComposition =
    supply &&
    !['shipped', 'closed', 'return'].includes(String(supply.status || '').toLowerCase());

  const handleOpenAddSupplyItem = () => {
    if (!canEditSupplyComposition) return;
    setReplaceCtx({
      supplyId: id,
      supplyLabel: supply?.externalShipmentNumber
        ? `№ ${supply.id} · ${supply.externalShipmentNumber}`
        : `№ ${supply.id}`,
      mode: 'add',
      defaultQty: 1,
    });
  };

  const handleOpenReplaceSupplyItem = (item) => {
    if (!canEditSupplyComposition || !item?.productId) return;
    setReplaceCtx({
      supplyId: id,
      supplyLabel: supply?.externalShipmentNumber
        ? `№ ${supply.id} · ${supply.externalShipmentNumber}`
        : `№ ${supply.id}`,
      mode: 'replace',
      supplyItemId: item.id,
      currentProductName: item.productName || item.name,
      currentSku: item.sku,
      defaultQty: Math.max(1, Number(item.quantity) || 1),
    });
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
      const fresh = await fboSuppliesApi.getById(id);
      setSupply(fresh);
      await loadPacking();
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить состав');
    } finally {
      setReplaceSaving(false);
    }
  };

  const handlePackingChange = useCallback((newPacking, meta) => {
    setPacking(newPacking);
    if (!meta) return;
    setSupply((s) => {
      if (!s) return s;
      const next = { ...s };
      if (Object.prototype.hasOwnProperty.call(meta, 'packingAllMatch')) {
        next.packingAllMatch = meta.packingAllMatch;
        next.hasPackingDiscrepancy = meta.packingAllMatch === false;
      }
      if (meta.supplyStatus != null) {
        next.status = meta.supplyStatus;
      }
      if (meta.statusReverted) {
        next.statusRevertedByPacking = true;
      }
      return next;
    });
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

  const handlePullMarketplaceContent = useCallback(async () => {
    const mpLabel = getMarketplaceLabel(supply?.marketplace);
    if (
      !window.confirm(
        `Обновить состав поставки с ${mpLabel}? План и новые позиции подтянутся с маркетплейса. Упаковка в грузоместах сохранится.`
      )
    ) {
      return;
    }
    setPullingMpContent(true);
    setErr(null);
    setPullMpContentMsg(null);
    try {
      const data = await fboSuppliesApi.pullMarketplaceContent(id);
      if (data?.supply) setSupply(data.supply);
      else {
        const fresh = await fboSuppliesApi.getById(id);
        setSupply(fresh);
      }
      await loadPacking();
      const parts = [];
      if (data?.updated > 0) parts.push(`обновлено ${data.updated}`);
      if (data?.added > 0) parts.push(`добавлено ${data.added}`);
      if (data?.removed > 0) parts.push(`удалено ${data.removed}`);
      if (data?.shrinkPacked > 0) parts.push(`сужено до упакованного ${data.shrinkPacked}`);
      if (data?.unchanged > 0) parts.push(`без изменений ${data.unchanged}`);
      setPullMpContentMsg(
        parts.length
          ? `Состав обновлён с ${mpLabel}: ${parts.join(', ')}. Упаковка сохранена.`
          : `Состав поставки обновлён с ${mpLabel}. Упаковка сохранена.`
      );
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить состав с маркетплейса');
    } finally {
      setPullingMpContent(false);
    }
  }, [id, loadPacking, supply?.marketplace]);

  const handleSyncMarketplaceContent = async () => {
    if (!supply) return;
    const mpLabel = getMarketplaceLabel(supply.marketplace);
    if (
      !window.confirm(
        `Отправить изменённый состав поставки в ${mpLabel}? Количества на маркетплейсе будут приведены к значениям в ERM.`
      )
    ) {
      return;
    }
    setSyncingMpContent(true);
    setErr(null);
    setSyncMpContentMsg(null);
    try {
      const data = await fboSuppliesApi.syncMarketplaceContent(id);
      if (data?.supply) setSupply(data.supply);
      else {
        const fresh = await fboSuppliesApi.getById(id);
        setSupply(fresh);
      }
      setSyncMpContentMsg(data?.message || 'Состав обновлён на маркетплейсе');
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось обновить состав на маркетплейсе');
    } finally {
      setSyncingMpContent(false);
    }
  };

  const handleSubmitPackingToMarketplace = async () => {
    if (!supply) return;
    const mpLabel = getMarketplaceLabel(supply.marketplace);
    const ozonMeta = packing?.ozonMeta;
    if (
      isOzonSupply &&
      ozonMeta &&
      ozonMeta.canSubmitCompositionViaApi === false
    ) {
      setErr(
        ozonMeta.filledCargoWarning ||
          'Состав грузомест уже заполнен в Ozon. Выгрузите Excel и загрузите его в личном кабинете Ozon.'
      );
      return;
    }
    if (
      !window.confirm(
        mpKey === 'ozon'
          ? `Отправить упаковку по грузоместам в ${mpLabel}? Сборка должна совпадать с планом. Грузоместа в Ozon должны быть пустыми (без состава).`
          : `Отправить упаковку по грузоместам в ${mpLabel}? Сборка должна совпадать с планом.`
      )
    ) {
      return;
    }
    setSubmittingPacking(true);
    setErr(null);
    setSubmitPackingMsg(null);
    try {
      const data = await fboSuppliesApi.submitPackingToMarketplace(id);
      if (data?.supply) {
        setSupply(data.supply);
      } else if (data?.supplyStatus) {
        setSupply((s) => (s ? { ...s, status: data.supplyStatus } : s));
      } else {
        const fresh = await fboSuppliesApi.getById(id);
        setSupply(fresh);
      }
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

  const runMarketplaceStatusSync = useCallback(
    async (silent = false) => {
      if (!id || statusSyncInFlightRef.current) return null;
      statusSyncInFlightRef.current = true;
      if (!silent) setStatusSyncing(true);
      try {
        const data = await fboSuppliesApi.syncMarketplaceStatus(id);
        if (data?.updated && data.supply) {
          applyStatusChangeResult(data.supply);
          setStatusSyncMsg(data.message || 'Статус обновлён с маркетплейса');
        } else if (!silent) {
          setStatusSyncMsg(data?.message || null);
        }
        return data;
      } catch (e) {
        if (!silent) {
          setStatusSyncMsg(
            e.response?.data?.message || e.message || 'Не удалось обновить статус с маркетплейса'
          );
        }
        return null;
      } finally {
        statusSyncInFlightRef.current = false;
        if (!silent) setStatusSyncing(false);
      }
    },
    [id]
  );

  const handleStatusChange = async (newStatus) => {
    if (!supply || newStatus === supply.status) return;
    if (!canSelectFboSupplyStatus(newStatus, packingHasDiscrepancy)) {
      setErr(
        newStatus === 'packed'
          ? 'Нельзя перевести в «Упакован»: есть расхождения между планом и сборкой. Упакуйте по каждой позиции ровно запланированное количество.'
          : 'Нельзя перевести в «Готов к отгрузке»: есть расхождения между планом и сборкой. Упакуйте по каждой позиции ровно запланированное количество.'
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

  useEffect(() => {
    if (!id || !supply?.status) return undefined;
    const st = String(supply.status).toLowerCase();
    if (!['ready_for_supply', 'shipped'].includes(st)) return undefined;
    const timer = setInterval(() => {
      runMarketplaceStatusSync(true);
    }, STATUS_SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [id, supply?.status, runMarketplaceStatusSync]);

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
        <Button variant="secondary" onClick={() => navigate('/stock-levels/fbo-supplies')}>
          К списку
        </Button>
      </div>
    );
  }

  const statusIdx = FBO_SUPPLY_STATUS_ORDER.indexOf(supply.status);
  const isOzonSupply =
    supply.marketplace !== 'wb' && supply.marketplace !== 'ym' && supply.marketplace !== 'yandex';
  const mpLabel = getMarketplaceLabel(supply.marketplace);
  const mpKey = String(supply.marketplace || 'ozon').toLowerCase();
  const isFboMarketplaceSupply =
    mpKey === 'ozon' || mpKey === 'wb' || mpKey === 'ym' || mpKey === 'yandex';
  const hasMarketplaceExternalRef =
    Boolean(supplyExternalShipmentNumber(supply)) || Boolean(supplyExternalSupplyId(supply));
  const marketplaceRefBlockedTitle = hasMarketplaceExternalRef
    ? null
    : 'Укажите номер отгрузки или ID поставки в карточке';
  const ozonMeta = packing?.ozonMeta;
  const ozonSubmitBlocked =
    isOzonSupply && ozonMeta && ozonMeta.canSubmitCompositionViaApi === false;
  const canSubmitPackingToMarketplace =
    (supply.status === 'packed' || (mpKey === 'ozon' && supply.status === 'ready_for_supply')) &&
    !packingHasDiscrepancy &&
    (packing?.cargoUnits?.length ?? 0) > 0 &&
    !ozonSubmitBlocked;
  const canSyncMarketplaceStatus =
    isFboMarketplaceSupply &&
    hasMarketplaceExternalRef &&
    ['ready_for_supply', 'shipped', 'closed'].includes(String(supply.status || '').toLowerCase());

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <Button variant="secondary" size="small" onClick={() => navigate('/stock-levels/fbo-supplies')}>
          ← К списку
        </Button>
        <h2 style={{ margin: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            Поставка FBO № {supply.id}
            {supply.externalShipmentNumber ? ` · ${supply.externalShipmentNumber}` : ''}
          </span>
          <FboSupplyStatusBadge status={supply.status} />
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
        {isFboMarketplaceSupply ? (
          <Button
            variant="secondary"
            size="small"
            disabled={pullingMpContent || saving || !hasMarketplaceExternalRef}
            onClick={handlePullMarketplaceContent}
            title={
              marketplaceRefBlockedTitle ||
              `Подтянуть состав поставки с ${mpLabel} (грузоместа и упаковка не сбрасываются)`
            }
          >
            {pullingMpContent ? 'Обновление…' : 'Обновить'}
          </Button>
        ) : null}
        {supply.pendingMpContentUpdate && isFboMarketplaceSupply ? (
          <Button
            variant="warning"
            size="small"
            disabled={syncingMpContent || saving || !hasMarketplaceExternalRef}
            onClick={handleSyncMarketplaceContent}
            title={
              marketplaceRefBlockedTitle ||
              `Отправить изменённый состав поставки (план) в ${mpLabel}`
            }
          >
            {syncingMpContent ? 'Обновление…' : 'Обновить на маркетплейсе'}
          </Button>
        ) : null}
        {isFboMarketplaceSupply ? (
          <Button
            variant="primary"
            size="small"
            disabled={
              submittingPacking ||
              saving ||
              !hasMarketplaceExternalRef ||
              !canSubmitPackingToMarketplace
            }
            onClick={handleSubmitPackingToMarketplace}
            title={
              marketplaceRefBlockedTitle ||
              (!canSubmitPackingToMarketplace &&
              supply.status !== 'packed' &&
              !(mpKey === 'ozon' && supply.status === 'ready_for_supply')
                ? 'Доступно в статусе «Упакован» после полной сборки по плану'
                : packingHasDiscrepancy
                  ? 'Сначала устраните расхождения между планом и сборкой'
                  : !(packing?.cargoUnits?.length > 0)
                    ? 'Сначала создайте грузоместа на вкладке «Сборка»'
                    : ozonSubmitBlocked
                  ? 'Состав уже заполнен в Ozon — используйте Excel, а не отправку из ERM'
                  : mpKey === 'ozon' && supply.status === 'ready_for_supply'
                      ? `Обновить состав грузомест в ${mpLabel} (номера сохраняются)`
                      : `Отправить упакованный состав грузомест в ${mpLabel}`)
            }
          >
            {submittingPacking ? 'Отправка…' : 'Отправить состав на маркетплейс'}
          </Button>
        ) : null}
        {canSyncMarketplaceStatus ? (
          <Button
            variant="secondary"
            size="small"
            disabled={statusSyncing || saving}
            onClick={() => runMarketplaceStatusSync(false)}
            title={`Обновить статус поставки с ${mpLabel}`}
          >
            {statusSyncing ? 'Статус…' : 'Статус с МП'}
          </Button>
        ) : null}
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
              navigate('/stock-levels/fbo-supplies');
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

      {supply?.statusRevertedByPacking ? (
        <div className="alert alert-warning">
          Статус сброшен в «Новая»: сборка не совпадает с планом поставки.
        </div>
      ) : null}
      {ozonMeta?.filledCargoWarning && activeTab !== 'packing' ? (
        <div className="alert alert-warning">
          {ozonMeta.filledCargoWarning}{' '}
          <button
            type="button"
            className="btn btn-link btn-sm p-0 align-baseline"
            disabled={packingExporting || !(packing?.cargoUnits?.length > 0)}
            onClick={handleExportPackingExcel}
          >
            Выгрузить Excel
          </button>
        </div>
      ) : null}
      {packingHasDiscrepancy ? (
        <div className="alert alert-warning">
          Есть расхождения между планом и сборкой — завершите упаковку всех позиций, чтобы перейти в
          «Упакован» / «Готов к отгрузке» или отправить состав на маркетплейс.
        </div>
      ) : null}
      {err && <div className="alert alert-danger">{err}</div>}
      {placementZonesMsg ? (
        <div className="alert alert-success">{placementZonesMsg}</div>
      ) : null}
      {submitPackingMsg ? (
        <div className="alert alert-success">{submitPackingMsg}</div>
      ) : null}
      {syncMpContentMsg ? (
        <div className="alert alert-success">{syncMpContentMsg}</div>
      ) : null}
      {supply.pendingMpContentUpdate && isFboMarketplaceSupply ? (
        <div className="alert alert-warning">
          Состав поставки изменён в ERM и ещё не отправлен на {mpLabel}. Нажмите «Обновить на маркетплейсе».
        </div>
      ) : null}
      {pullMpContentMsg ? (
        <div className="alert alert-success">{pullMpContentMsg}</div>
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

      {statusSyncMsg ? (
        <div className="alert alert-info">{statusSyncMsg}</div>
      ) : null}

      <div className="fbo-status-stepper">
        {FBO_SUPPLY_STATUS_OPTIONS.map((s, i) => {
          const done = i < statusIdx;
          const active = s === supply.status;
          const blocked = !canSelectFboSupplyStatus(s, packingHasDiscrepancy);
          const blockedTitle = fboSupplyStatusBlockedTitle(s, packingHasDiscrepancy);
          const statusClass = getFboSupplyStatusClass(s);
          return (
            <button
              key={s}
              type="button"
              className={`fbo-status-step fbo-status-step--${statusClass}${active ? ' active' : ''}${done ? ' done' : ''}${blocked ? ' blocked' : ''}`}
              disabled={saving || blocked}
              title={blockedTitle || `Установить: ${getFboSupplyStatusLabel(s)}`}
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
            Найдено:{' '}
            <strong>
              {activeTab === 'packing' ? filteredSupplyItems.length : filteredGeneralItems.length}
            </strong>{' '}
            из{' '}
            <strong>
              {activeTab === 'packing' ? sortedSupplyItems.length : generalSupplyItems.length}
            </strong>
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
          onItemQuantitySaved={handleItemQuantitySaved}
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
        <div>
            <label>
              {isOzonSupply
                ? 'ID поставки Ozon'
                : supply.marketplace === 'wb'
                  ? 'ID поставки WB'
                  : supply.marketplace === 'ym' || supply.marketplace === 'yandex'
                    ? 'ID заявки Яндекс Маркет'
                    : 'ID поставки на маркетплейсе'}
            </label>
            <input
              className="form-control form-control-sm"
              value={supply.externalSupplyId || ''}
              onChange={(e) => setSupply((s) => ({ ...s, externalSupplyId: e.target.value }))}
              onBlur={() => saveField({ externalSupplyId: supply.externalSupplyId || null })}
              disabled={saving}
              placeholder={
                isOzonSupply
                  ? 'supply_id для API Ozon'
                  : supply.marketplace === 'wb'
                    ? 'supplyID или preorderID'
                    : 'requestId Яндекс Маркета'
              }
              title={`Нужен для обмена данными с ${mpLabel}`}
            />
        </div>
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
          {!supply.deductStock ? (
            <p className="text-muted small mb-0 mt-1">
              Остатки не резервируются. Включите, чтобы зарезервировать товар под эту поставку.
            </p>
          ) : null}
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
      {!canEditSupplyComposition ? (
        <p className="text-muted small mb-2">
          Состав нельзя менять в статусе «{getFboSupplyStatusLabel(supply.status)}».
        </p>
      ) : (
        <p className="text-muted small mb-2">
          Нажмите на количество, чтобы изменить или удалить строку (0). Добавление и замена — кнопками ниже.
        </p>
      )}
      <div className="fbo-items-toolbar">
        {canEditSupplyComposition ? (
          <Button variant="secondary" size="small" onClick={handleOpenAddSupplyItem}>
            Добавить товар
          </Button>
        ) : null}
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
              Найдено: <strong>{filteredGeneralItems.length}</strong> из{' '}
              <strong>{generalSupplyItems.length}</strong>
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
          {supply?.items?.length ? (
            supply.deductStock ? (
              <>
                {' '}
                · покрытие:{' '}
                <strong>{supplyReserveTotals.stock}</strong> с наличия,{' '}
                <strong>{supplyReserveTotals.incoming}</strong> с пути (из {supplyReserveTotals.qty} шт.)
              </>
            ) : (
              <>
                {' '}
                · <span title="Включите «Списать остатки при отгрузке» для резерва остатков">резерв отключён</span>
              </>
            )
          ) : null}
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
              {isOzonSupply ? <th>Размещение</th> : null}
              <th title="План / зарезервировано. Ниже — с наличия и с пути">
                Количество
              </th>
              <th style={{ width: 88 }}>Действия</th>
              <th style={{ width: 48 }} />
            </tr>
          </thead>
          <tbody>
            {filteredGeneralItems.length === 0 ? (
              <tr>
                <td colSpan={isOzonSupply ? 9 : 8} className="text-muted text-center py-3">
                  {itemSearchActive ? 'Ничего не найдено' : 'Нет строк'}
                </td>
              </tr>
            ) : null}
            {filteredGeneralItems.map((it) => {
              const canPrint = Boolean(it.productId);
              const rowSelected = selectedItemIds.has(String(it.id));
              const stat = statsByItemId.get(String(it.id));
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
                    <FboSupplyItemGeneralQty
                      item={it}
                      supplyId={id}
                      disabled={!canEditSupplyComposition}
                      reserveDisabled={!supply.deductStock}
                      onSaved={handleItemQuantitySaved}
                    />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {canEditSupplyComposition && it.productId ? (
                      <Button
                        variant="secondary"
                        size="small"
                        className="btn-icon btn-icon-only"
                        title="Заменить товар в строке"
                        aria-label="Заменить товар"
                        onClick={() => handleOpenReplaceSupplyItem(it)}
                      >
                        ⇄
                      </Button>
                    ) : (
                      '—'
                    )}
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

      <FboPurchaseReplaceModal
        context={replaceCtx}
        saving={replaceSaving}
        onClose={() => !replaceSaving && setReplaceCtx(null)}
        onConfirm={handleReplaceConfirm}
      />

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

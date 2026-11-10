/**
 * Вкладка «Упаковка» поставки FBO: грузоместа и сканирование.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { useChestnyZnakEnabled } from '../../hooks/useChestnyZnakEnabled.js';
import { FboSupplyPackingRemoveModal } from './FboSupplyPackingRemoveModal.jsx';
import { FboCargoContentMeta } from './FboCargoContentMeta.jsx';
import { FboCargoUnitKind } from './FboCargoUnitKind.jsx';
import { FboCargoBarcodeEdit } from './FboCargoBarcodeEdit.jsx';
import { FboTransportCargoes } from './FboTransportCargoes.jsx';
import {
  cargoWeightExceededMessage,
  cargoWeightSummary,
  fmtVolumeL,
  fmtWeightG,
} from './fboPackingFormat.js';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';
import { ozonPlacementZoneLabel } from '../../constants/ozonPlacementZones';
import { FboSupplyItemPackingCell } from './FboSupplyItemPackingCell.jsx';
import { fboBoxPrintKind } from '../../utils/labelPrinterSettings.js';
import {
  useProductLabelPrint,
  canUsePrintHelper,
  resolvePrintHelperUrl,
} from '../../hooks/useProductLabelPrint.js';

/** Лимит сервера на одно создание грузомест в Ozon. */
const OZON_CARGO_CREATE_MAX = 30;
const NO_CATEGORY_VALUE = '__none__';

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function placementKindLabel(lineOrItem) {
  if (!lineOrItem) return '—';
  return (
    lineOrItem.placementKindLabel ||
    ozonPlacementZoneLabel(lineOrItem.placementZone ?? lineOrItem.supplyPlacementZone, lineOrItem.ozonTags ?? lineOrItem.supplyOzonTags)
  );
}

function cargoPlacementSummary(contents) {
  const labels = new Set();
  for (const line of contents || []) {
    const label = placementKindLabel(line);
    if (label && label !== '—') labels.add(label);
  }
  return labels.size ? [...labels].join(', ') : null;
}

function downloadExcelBuffer(buffer, filename) {
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
}

function resolveCargoPrintKind(cargoUnits, cargoIds, marketplace = 'ozon') {
  const idSet = new Set((cargoIds || []).map(String));
  const matched = (cargoUnits || []).filter(
    (c) => idSet.has(String(c.id)) || idSet.has(String(c.barcode)) || idSet.has(String(c.cargoUnitId))
  );
  const boxKind = fboBoxPrintKind(marketplace);
  if (!matched.length) return boxKind;
  const kinds = new Set(matched.map((c) => (c.cargoKind === 'pallet' ? 'pallet' : 'box')));
  if (kinds.size === 1 && kinds.has('pallet')) return 'pallet';
  if (kinds.size === 1) return boxKind;
  // Смешанная печать — печатаем пачками по типу ниже; здесь fallback.
  return boxKind;
}

export function FboSupplyPacking({
  supplyId,
  marketplace = 'ozon',
  supplyItems = [],
  packing,
  onPackingChange,
  onBreakdownClick,
  onItemQuantitySaved,
  itemSearchQuery = '',
  printHelperUrl = '',
  /** packing — обычная упаковка; express — приёмка+сборка+упаковка+этикетка за один скан */
  mode = 'packing',
  onSupplyStatusChange,
}) {
  const isExpress = mode === 'express';
  const [scanLoading, setScanLoading] = useState(false);
  const { enabled: chestnyZnakEnabled } = useChestnyZnakEnabled();
  const [scanError, setScanError] = useState(null);
  const [scanMsg, setScanMsg] = useState(null);
  const [activeCargoUnitId, setActiveCargoUnitId] = useState(null);
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [creatingOnOzon, setCreatingOnOzon] = useState(null);
  const [ozonCreateCount, setOzonCreateCount] = useState('1');
  const [ozonCreatePrint, setOzonCreatePrint] = useState(true);
  const [syncingFromOzon, setSyncingFromOzon] = useState(false);
  const [printingLabels, setPrintingLabels] = useState(false);
  const [newCargoMode, setNewCargoMode] = useState(false);
  const [weightWarning, setWeightWarning] = useState(null);
  const [placementWarning, setPlacementWarning] = useState(null);
  const [overageConfirm, setOverageConfirm] = useState(null);
  const [overageConfirmBusy, setOverageConfirmBusy] = useState(false);
  /** Экспресс: список номеров ГМ скрыт по умолчанию. */
  const [expressCargoListOpen, setExpressCargoListOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const scanLoadingRef = useRef(false);
  const { printProductLabel, printing: labelPrinting, setError: setPrintHookError } =
    useProductLabelPrint(printHelperUrl);

  scanLoadingRef.current = scanLoading;

  const statsByItemId = useMemo(
    () => buildStatsMap(packing?.itemStats),
    [packing?.itemStats]
  );

  const sortedSupplyItems = useMemo(
    () => sortSupplyItemsForPacking(supplyItems, statsByItemId),
    [supplyItems, statsByItemId]
  );

  const categoryOptions = useMemo(() => {
    if (!isExpress) return [];
    const map = new Map();
    let hasNone = false;
    for (const it of sortedSupplyItems) {
      const id = it.productCategoryId;
      if (id == null) {
        hasNone = true;
        continue;
      }
      if (!map.has(id)) {
        map.set(id, it.productCategoryName || `Категория #${id}`);
      }
    }
    const opts = [...map.entries()]
      .map(([id, name]) => ({ value: String(id), label: name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    if (hasNone) {
      opts.push({ value: NO_CATEGORY_VALUE, label: 'Без категории' });
    }
    return opts;
  }, [isExpress, sortedSupplyItems]);

  const filteredSupplyItems = useMemo(() => {
    let list = sortedSupplyItems;
    if (isExpress && categoryFilter) {
      list = list.filter((it) => {
        if (categoryFilter === NO_CATEGORY_VALUE) return it.productCategoryId == null;
        return String(it.productCategoryId) === categoryFilter;
      });
    }
    return filterSupplyItemsByQuery(list, itemSearchQuery);
  }, [sortedSupplyItems, itemSearchQuery, isExpress, categoryFilter]);

  /** Экспресс: только то, что ещё нужно отсканировать (план ≠ упаковано). */
  const expressPendingItems = useMemo(
    () =>
      filteredSupplyItems.filter(
        (it) => !isSupplyItemPackingComplete(statsByItemId.get(String(it.id)), it)
      ),
    [filteredSupplyItems, statsByItemId]
  );

  const itemSearchActive = Boolean(normalizeProductSearchQuery(itemSearchQuery));
  const expressFilterActive = Boolean(categoryFilter) || itemSearchActive;

  const cargoUnits = packing?.cargoUnits || [];
  const ozonMeta = packing?.ozonMeta;

  const sortedCargoUnits = useMemo(() => {
    if (!activeCargoUnitId) return cargoUnits;
    return [...cargoUnits].sort((a, b) => {
      const aActive = String(a.id) === String(activeCargoUnitId);
      const bActive = String(b.id) === String(activeCargoUnitId);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return Number(a.id) - Number(b.id);
    });
  }, [cargoUnits, activeCargoUnitId]);

  useEffect(() => {
    if (!cargoUnits.length) {
      setActiveCargoUnitId(null);
      return;
    }
    const stillValid =
      activeCargoUnitId != null &&
      cargoUnits.some((c) => String(c.id) === String(activeCargoUnitId));
    if (!stillValid) {
      setActiveCargoUnitId(cargoUnits[cargoUnits.length - 1]?.id ?? null);
    }
  }, [cargoUnits, activeCargoUnitId]);

  const sendExpressPrint = useCallback(
    async (printInfo) => {
      if (!printInfo?.productId) return;
      const copies = Math.max(1, Math.min(99, Number(printInfo.copies) || 1));
      const helperUrl = resolvePrintHelperUrl(printHelperUrl);
      if (canUsePrintHelper(helperUrl) && copies === 1) {
        const ok = await printProductLabel(printInfo.productId, {
          copies,
          marketplace: printInfo.marketplace || marketplace || undefined,
          allowBrowserFallback: false,
        });
        if (!ok) {
          setScanError(
            'Print Helper не ответил. Проверьте помощник печати или напечатайте этикетку на вкладке «Сборка».'
          );
        }
        return;
      }
      await printProductLabel(printInfo.productId, {
        copies,
        marketplace: printInfo.marketplace || marketplace || undefined,
      });
    },
    [marketplace, printHelperUrl, printProductLabel]
  );

  const applyScanResult = useCallback(
    async (data, { scannedAsNewCargo = false } = {}) => {
      if (data?.action === 'ignored_duplicate') {
        setScanMsg(data.message || 'Этот КИ уже в поставке');
        playEventSound(SOUND_EVENTS.scan_error);
        if (data?.packing) {
          onPackingChange(data.packing, {
            supplyStatus: data.supplyStatus,
            packingAllMatch: data.packingAllMatch,
            statusReverted: data.statusReverted,
            lastPackAt: data.lastPackAt ?? null,
          });
        }
        return;
      }
      if (data?.activeCargoUnitId != null) {
        setActiveCargoUnitId(data.activeCargoUnitId);
      }
      if (scannedAsNewCargo && (data?.action === 'cargo_created' || data?.action === 'cargo_selected')) {
        setNewCargoMode(false);
      }
      if (data?.packing) {
        onPackingChange(data.packing, {
          supplyStatus: data.supplyStatus,
          packingAllMatch: data.packingAllMatch,
          statusReverted: data.statusReverted,
          lastPackAt: data.lastPackAt ?? null,
        });
        if (data.statusReverted) {
          setScanMsg('Статус сброшен в «Новая»: сборка не совпадает с планом');
        }
        const nextActiveId = data.activeCargoUnitId ?? activeCargoUnitId;
        const nextActive = (data.packing.cargoUnits || []).find(
          (c) => String(c.id) === String(nextActiveId)
        );
        setWeightWarning(data?.weightWarning || cargoWeightExceededMessage(nextActive) || null);
      } else {
        setWeightWarning(data?.weightWarning || null);
      }
      if (data?.supplyStatus != null || data?.lastCollectAt != null) {
        onSupplyStatusChange?.(data.supplyStatus, {
          lastCollectAt: data.lastCollectAt ?? null,
        });
      }
      if (!data?.statusReverted) {
        setScanMsg(data?.message || 'Готово');
      }
      playEventSound(SOUND_EVENTS.scan_ok);
      if (isExpress && data?.action === 'kit_progress') {
        // Комплектующая принята — этикетка и упаковка после полного набора комплекта.
        return;
      }
      if (isExpress && data?.action === 'express_packed' && data?.print?.productId) {
        await sendExpressPrint(data.print);
      }
    },
    [activeCargoUnitId, onPackingChange, onSupplyStatusChange, isExpress, sendExpressPrint]
  );

  const handleScan = useCallback(
    async (raw, { allowOverage = false } = {}) => {
      const trimmed = (raw || '').trim();
      if (trimmed.length < 2 || scanLoadingRef.current) return;
      setScanError(null);
      setScanMsg(null);
      setWeightWarning(null);
      setPlacementWarning(null);
      setPrintHookError?.(null);
      setScanLoading(true);
      try {
        const scanPayload = {
          barcode: trimmed,
          activeCargoUnitId,
          scanMode: newCargoMode ? 'cargo' : 'product',
          ...(allowOverage ? { allowOverage: true } : {}),
        };
        const data = isExpress
          ? await fboSuppliesApi.expressScan(supplyId, scanPayload)
          : await fboSuppliesApi.packingScan(supplyId, scanPayload);
        await applyScanResult(data, { scannedAsNewCargo: newCargoMode });
      } catch (e) {
        playEventSound(SOUND_EVENTS.scan_error);
        const payload = e.response?.data || {};
        const msg = payload.message || e.message || 'Ошибка сканирования';
        if (payload.code === 'CARGO_BARCODE_IS_PRODUCT' && newCargoMode) {
          setNewCargoMode(false);
        }
        if (
          e.response?.status === 409 &&
          (payload.code === 'PACKING_OVERAGE' || payload.code === 'COLLECT_OVERAGE')
        ) {
          setOverageConfirm({
            barcode: trimmed,
            message: msg,
            productName: payload.productName || payload.name || null,
            planned: payload.planned,
            packed: payload.packed ?? payload.collected,
            sku: payload.sku || null,
          });
          setScanError(null);
          setPlacementWarning(null);
        } else if (e.response?.status === 409 && payload.code === 'PLACEMENT_ZONE_CONFLICT') {
          setPlacementWarning(msg);
          setScanError(null);
        } else {
          setScanError(msg);
          setPlacementWarning(null);
        }
      } finally {
        setScanLoading(false);
      }
    },
    [supplyId, activeCargoUnitId, newCargoMode, applyScanResult, isExpress, setPrintHookError]
  );

  const handleConfirmOverage = async () => {
    if (!overageConfirm?.barcode || overageConfirmBusy) return;
    setOverageConfirmBusy(true);
    setScanError(null);
    try {
      const scanPayload = {
        barcode: overageConfirm.barcode,
        activeCargoUnitId,
        scanMode: 'product',
        allowOverage: true,
      };
      const data = isExpress
        ? await fboSuppliesApi.expressScan(supplyId, scanPayload)
        : await fboSuppliesApi.packingScan(supplyId, scanPayload);
      setOverageConfirm(null);
      await applyScanResult(data);
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setScanError(e.response?.data?.message || e.message || 'Не удалось добавить товар');
      setOverageConfirm(null);
    } finally {
      setOverageConfirmBusy(false);
    }
  };

  const handleCancelOverage = () => {
    if (overageConfirmBusy) return;
    setOverageConfirm(null);
    setScanMsg('Лишний товар не добавлен');
  };

  const handleNewCargoMode = () => {
    setScanError(null);
    if (newCargoMode) {
      setNewCargoMode(false);
      setScanMsg(null);
      return;
    }
    setNewCargoMode(true);
    setScanMsg('Отсканируйте штрихкод коробки или паллеты');
  };

  const handleSelectCargo = (cargoId) => {
    setNewCargoMode(false);
    setActiveCargoUnitId(cargoId);
  };

  const handleExportExcel = async () => {
    setExporting(true);
    setScanError(null);
    try {
      const { buffer, filename } = await fboSuppliesApi.downloadPackingExcel(supplyId);
      downloadExcelBuffer(buffer, filename);
      setScanMsg('Файл Excel сформирован');
    } catch (e) {
      setScanError(e.response?.data?.message || e.message || 'Не удалось выгрузить Excel');
    } finally {
      setExporting(false);
    }
  };

  const handleCreateOnOzon = async (cargoKind = 'box') => {
    const count = Math.min(OZON_CARGO_CREATE_MAX, Math.max(1, parseInt(ozonCreateCount, 10) || 1));
    setOzonCreateCount(String(count));
    setCreatingOnOzon(cargoKind);
    setScanError(null);
    setScanMsg(null);
    try {
      const data = await fboSuppliesApi.createOzonCargoUnits(supplyId, { count, cargoKind });
      if (data?.packing) {
        onPackingChange(
          { ...data.packing, ozonMeta: data.ozonMeta ?? data.packing.ozonMeta },
          {
            ozonMeta: data.ozonMeta,
          }
        );
        if (data.created?.length) {
          const last = data.created[data.created.length - 1];
          if (last?.cargoUnitId) setActiveCargoUnitId(last.cargoUnitId);
        }
      }
      const createdMsg = data?.message || 'Грузоместо создано на Ozon';
      setScanMsg(createdMsg);
      playEventSound(SOUND_EVENTS.scan_ok);
      const createdIds = (data?.createdCargoIds || []).map(String).filter(Boolean);
      if (ozonCreatePrint && createdIds.length) {
        setPrintingLabels(true);
        setScanMsg(`${createdMsg} Получаем этикетки у Ozon…`);
        try {
          const res = await fboSuppliesApi.printCargoLabels(supplyId, createdIds, {
            kind: cargoKind === 'pallet' ? 'pallet' : fboBoxPrintKind(marketplace),
            marketplace,
            printHelperUrl,
          });
          setScanMsg(
            `${createdMsg} ${
              res?.via === 'helper'
                ? 'Этикетки отправлены на принтер.'
                : res?.opened === false
                  ? 'Этикетки скачаны файлом PDF.'
                  : 'Этикетки отправлены на печать.'
            }`
          );
        } catch (pe) {
          setScanError(
            `Грузоместа созданы, но этикетки не получены: ${
              pe.message || 'ошибка'
            }. Нажмите «Печать этикеток».`
          );
        } finally {
          setPrintingLabels(false);
        }
      }
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setScanError(e.response?.data?.message || e.message || 'Не удалось создать грузоместо на Ozon');
    } finally {
      setCreatingOnOzon(null);
    }
  };

  const handleSyncFromOzon = async () => {
    setSyncingFromOzon(true);
    setScanError(null);
    setScanMsg(null);
    try {
      const data = await fboSuppliesApi.syncOzonCargoUnits(supplyId);
      if (data?.packing) {
        onPackingChange(
          { ...data.packing, ozonMeta: data.ozonMeta ?? data.packing.ozonMeta },
          { ozonMeta: data.ozonMeta }
        );
        const lastNew = (data.created || []).filter((c) => !c.existed).pop();
        if (lastNew?.cargoUnitId) setActiveCargoUnitId(lastNew.cargoUnitId);
      }
      setScanMsg(data?.message || 'Грузоместа синхронизированы из Ozon');
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setScanError(e.response?.data?.message || e.message || 'Не удалось подтянуть грузоместа из Ozon');
    } finally {
      setSyncingFromOzon(false);
    }
  };

  const handlePrintCargoLabels = async (cargoIds, e) => {
    e?.stopPropagation?.();
    const ids = (cargoIds || []).filter(Boolean);
    if (!ids.length) return;
    setPrintingLabels(true);
    setScanError(null);
    setScanMsg(`Получаем этикетки у Ozon (${ids.length})…`);
    try {
      const boxes = [];
      const pallets = [];
      for (const id of ids) {
        const unit = cargoUnits.find(
          (c) => String(c.id) === String(id) || String(c.barcode) === String(id) || String(c.cargoUnitId) === String(id)
        );
        if (unit?.cargoKind === 'pallet') pallets.push(id);
        else boxes.push(id);
      }
      // Короба и паллеты — параллельно (разные принтеры), иначе ждать Ozon дважды подряд.
      const boxKind = fboBoxPrintKind(marketplace);
      if (!boxes.length && !pallets.length) {
        await fboSuppliesApi.printCargoLabels(supplyId, ids, {
          kind: resolveCargoPrintKind(cargoUnits, ids, marketplace),
          marketplace,
          printHelperUrl,
        });
      } else {
        await Promise.all([
          boxes.length
            ? fboSuppliesApi.printCargoLabels(supplyId, boxes, {
                kind: boxKind,
                marketplace,
                printHelperUrl,
              })
            : null,
          pallets.length
            ? fboSuppliesApi.printCargoLabels(supplyId, pallets, {
                kind: 'pallet',
                marketplace,
                printHelperUrl,
              })
            : null,
        ]);
      }
      setScanMsg(`Этикетки отправлены: ${ids.join(', ')}`);
    } catch (e) {
      setScanError(e.message || e.response?.data?.message || 'Не удалось получить этикетки');
    } finally {
      setPrintingLabels(false);
    }
  };

  const handlePrintAllCargoLabels = async () => {
    const ids = cargoUnits.map((c) => c.barcode).filter(Boolean);
    if (!ids.length) {
      setScanError('Нет грузомест с номерами для печати этикеток');
      return;
    }
    await handlePrintCargoLabels(ids);
  };

  const handlePrintYmLabels = async () => {
    setPrintingLabels(true);
    setScanError(null);
    setScanMsg(null);
    try {
      const res = await fboSuppliesApi.printYmCargoLabels(supplyId, { printHelperUrl });
      setScanMsg(
        res?.via === 'helper'
          ? 'Ярлыки грузомест Маркета отправлены на принтер.'
          : res?.opened === false
            ? 'Ярлыки грузомест Маркета скачаны файлом PDF.'
            : 'Ярлыки грузомест Маркета отправлены на печать.'
      );
    } catch (err) {
      setScanError(err.message || 'Не удалось получить ярлыки грузомест из Маркета');
    } finally {
      setPrintingLabels(false);
    }
  };

  const handleDeleteCargo = async (cargoUnitId, e) => {
    e?.stopPropagation?.();
    if (!window.confirm('Удалить грузоместо и весь его состав?')) return;
    try {
      const data = await fboSuppliesApi.deleteCargoUnit(supplyId, cargoUnitId);
      if (data?.packing) {
        onPackingChange(data.packing, {
          supplyStatus: data.supplyStatus,
          packingAllMatch: data.packingAllMatch,
          statusReverted: data.statusReverted,
          lastPackAt: data.lastPackAt ?? null,
        });
        const nextActive = (data.packing.cargoUnits || []).find(
          (c) => String(c.id) === String(activeCargoUnitId) && String(c.id) !== String(cargoUnitId)
        );
        setWeightWarning(nextActive ? cargoWeightExceededMessage(nextActive) : null);
      }
      if (String(activeCargoUnitId) === String(cargoUnitId)) {
        setActiveCargoUnitId(null);
        setWeightWarning(null);
      }
    } catch (e) {
      setScanError(e.response?.data?.message || e.message || 'Не удалось удалить');
    }
  };

  const activeCargo = cargoUnits.find((c) => String(c.id) === String(activeCargoUnitId));
  const isOzon = marketplace !== 'wb' && marketplace !== 'ym' && marketplace !== 'yandex';
  const isYm = marketplace === 'ym' || marketplace === 'yandex';
  const activeWeightWarning =
    weightWarning || (activeCargo ? cargoWeightExceededMessage(activeCargo) : null);
  const activePlacementSummary =
    isOzon && activeCargo ? cargoPlacementSummary(activeCargo.contents) : null;

  const handlePackingChange = (nextPacking, meta) => {
    onPackingChange?.(nextPacking, meta);
    const nextActive = (nextPacking?.cargoUnits || []).find(
      (c) => String(c.id) === String(activeCargoUnitId)
    );
    setWeightWarning(nextActive ? cargoWeightExceededMessage(nextActive) : null);
  };

  return (
    <div className={`fbo-packing${isExpress ? ' fbo-packing--express' : ''}`}>
      {isExpress ? (
        <p className="fbo-packing-hint" style={{ marginBottom: 12 }}>
          Экспресс: скан грузоместа, затем товара — за один скан приёмка с «в пути» (если нужно), сборка,
          упаковка в активное ГМ и печать этикетки. Комплекты можно собирать по комплектующим.
        </p>
      ) : null}
      {isExpress ? (
        <div className="fbo-express-filters">
          <label className="fbo-collect-category-filter">
            <span className="muted-hint">Категория</span>
            <select
              className="form-select form-select-sm"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Фильтр по категории в экспрессе"
            >
              <option value="">Все категории</option>
              {categoryOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className="fbo-packing-scan">
        <BarcodeScanField
          id={isExpress ? 'fbo-express-barcode' : 'fbo-packing-barcode'}
          label="Штрихкод"
          className="form-control"
          formClassName="fbo-packing-scan-row warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
          placeholder={
            newCargoMode
              ? 'Штрихкод коробки / паллеты'
              : isExpress
                ? 'Грузоместо или товар (приёмка + сборка + упаковка)'
                : isOzon
                  ? 'Штрихкод товара из поставки'
                  : 'Коробка / паллета, затем товары поставки'
          }
          loading={scanLoading || labelPrinting}
          disabled={scanLoading || labelPrinting}
          enableGlobalCapture
          onScan={handleScan}
          hint={
            isExpress ? (
              <>
                Сначала отсканируйте <strong>грузоместо</strong> (или «Новое грузоместо» / короб на Ozon).
                Затем сканируйте <strong>товар</strong> или <strong>комплектующую</strong>: приёмка с
                «в пути» + сборка + упаковка + этикетка (этикетка — после полного набора комплекта).
              </>
            ) : isOzon ? (
              <>
                Создайте грузоместа кнопкой <strong>«Короб на Ozon»</strong> или{' '}
                <strong>«Паллета на Ozon»</strong> (сразу несколько — поле <strong>«Кол-во»</strong>), либо
                отсканируйте этикетку через{' '}
                <strong>«Новое грузоместо»</strong>. Затем сканируйте <strong>товары из поставки</strong>{' '}
                (+1 шт. за скан).
                {chestnyZnakEnabled ? (
                  <>
                    {' '}
                    Можно сканировать <strong>код маркировки</strong> (Data Matrix).
                  </>
                ) : null}{' '}
                Если состав в Ozon уже заполнен — обновляйте через{' '}
                <strong>Excel</strong>, а не кнопку отправки состава.
              </>
            ) : (
              <>
                Сначала отсканируйте штрихкод <strong>коробки или паллеты</strong> — откроется грузоместо.
                Затем сканируйте <strong>товары из этой поставки</strong>
                {chestnyZnakEnabled ? (
                  <>
                    {' '}
                    или <strong>код маркировки</strong>
                  </>
                ) : null}{' '}
                (+1 шт. за скан).
                Для следующей коробки нажмите <strong>«Новое грузоместо»</strong> и отсканируйте её штрихкод.
                {isYm ? (
                  <>
                    {' '}
                    Ярлыки грузомест Маркет создаёт только в кабинете: страница поставки →{' '}
                    <strong>«Ярлыки для грузомест»</strong> → «Создать» (не позже чем за 3 ч до поставки). Затем
                    нажмите <strong>«Ярлыки Маркета»</strong>, чтобы распечатать их отсюда.
                  </>
                ) : null}
              </>
            )
          }
        >
          <Button
            type="button"
            variant={newCargoMode ? 'primary' : 'secondary'}
            disabled={scanLoading || creatingOnOzon}
            onClick={handleNewCargoMode}
            title="Добавить или переключить грузоместо по скану коробки"
          >
            {newCargoMode ? 'Отмена' : 'Новое грузоместо'}
          </Button>
          {isOzon ? (
            <>
              <span className="fbo-ozon-create-opts">
                <label className="fbo-ozon-create-opts__count" title="Сколько грузомест создать на Ozon за раз">
                  Кол-во
                  <input
                    type="number"
                    min={1}
                    max={OZON_CARGO_CREATE_MAX}
                    step={1}
                    value={ozonCreateCount}
                    disabled={Boolean(creatingOnOzon)}
                    onChange={(e) => setOzonCreateCount(e.target.value.replace(/[^\d]/g, ''))}
                  />
                </label>
                <label className="fbo-ozon-create-opts__print" title="После создания сразу получить этикетки новых грузомест и отправить на печать">
                  <input
                    type="checkbox"
                    checked={ozonCreatePrint}
                    disabled={Boolean(creatingOnOzon)}
                    onChange={(e) => setOzonCreatePrint(e.target.checked)}
                  />
                  печать этикеток
                </label>
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={scanLoading || creatingOnOzon || syncingFromOzon || printingLabels}
                onClick={() => handleCreateOnOzon('box')}
                title="Создать пустые коробки на Ozon (указанное кол-во) и добавить в сборку"
              >
                {creatingOnOzon === 'box' ? 'Ozon…' : 'Короб на Ozon'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={scanLoading || creatingOnOzon || syncingFromOzon || printingLabels}
                onClick={() => handleCreateOnOzon('pallet')}
                title="Создать пустые паллеты на Ozon (указанное кол-во) и добавить в сборку"
              >
                {creatingOnOzon === 'pallet' ? 'Ozon…' : 'Паллета на Ozon'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={scanLoading || creatingOnOzon || syncingFromOzon || printingLabels}
                onClick={handleSyncFromOzon}
                title="Подтянуть все короба и ТГМ из Ozon (включая привязанные к транспортным грузоместам)"
              >
                {syncingFromOzon ? 'Синхр…' : 'Подтянуть из Ozon'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={scanLoading || creatingOnOzon || printingLabels || !cargoUnits.length}
                onClick={handlePrintAllCargoLabels}
                title="Скачать этикетки всех грузомест и отправить на печать"
              >
                {printingLabels ? 'Этикетки…' : 'Печать этикеток'}
              </Button>
            </>
          ) : null}
          {isYm ? (
            <Button
              type="button"
              variant="secondary"
              disabled={scanLoading || printingLabels}
              onClick={handlePrintYmLabels}
              title="Скачать ярлыки грузомест, созданные в кабинете Маркета, и отправить на печать"
            >
              {printingLabels ? 'Ярлыки…' : 'Ярлыки Маркета'}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={scanLoading}
            onClick={() => setRemoveModalOpen(true)}
          >
            Убрать товар
          </Button>
        </BarcodeScanField>
      </div>

      {activeCargo ? (
        <div
          className={`fbo-packing-active alert ${
            activeCargo.weightExceeded ? 'alert-warning' : 'alert-info'
          }`}
        >
          Активное грузоместо: <strong>{activeCargo.barcode}</strong>
          {' '}
          <span className="text-muted">
            ({activeCargo.cargoKind === 'pallet' ? 'паллета' : 'короб'}
            {' · '}
            {activeCargo.totalQuantity ?? 0} шт.
            {(activeCargo.totalVolumeL > 0 || activeCargo.totalWeightG > 0) && (
              <>
                {' '}
                · {fmtVolumeL(activeCargo.totalVolumeL)} · {cargoWeightSummary(activeCargo)}
              </>
            )}
            {activeCargo.weightLimitKg ? (
              <> · лимит {activeCargo.weightLimitKg} кг</>
            ) : null}
            {activePlacementSummary ? (
              <> · <strong>{activePlacementSummary}</strong></>
            ) : null}
            )
          </span>
        </div>
      ) : (
        <div className="fbo-packing-active alert alert-warning">
          {isOzon
            ? 'Нет активного грузоместа — нажмите «Новое грузоместо» и отсканируйте коробку.'
            : 'Нет активного грузоместа — отсканируйте коробку или нажмите «Новое грузоместо».'}
          {isExpress ? ' Затем сканируйте товар для экспресс-упаковки.' : ''}
        </div>
      )}

      {scanLoading ? (
        <div className="alert alert-info" role="status">
          Сканирование…
        </div>
      ) : null}
      {scanError && <div className="alert alert-danger">{scanError}</div>}
      {placementWarning ? (
        <div className="alert alert-warning">{placementWarning}</div>
      ) : null}
      {activeWeightWarning && !scanError ? (
        <div className="alert alert-warning">{activeWeightWarning}</div>
      ) : null}
      {scanMsg && !scanError && <div className="alert alert-success">{scanMsg}</div>}

      {ozonMeta?.filledCargoWarning ? (
        <div className="alert alert-warning">{ozonMeta.filledCargoWarning}</div>
      ) : null}
      {ozonMeta?.error ? (
        <div className="alert alert-warning">Ozon: {ozonMeta.error}</div>
      ) : null}

      <div className="fbo-items-toolbar">
        <h4 className="fbo-packing-section-title" style={{ margin: 0, flex: 1 }}>
          Грузоместа ({cargoUnits.length})
          {isExpress && activeCargo?.barcode ? (
            <span className="text-muted fw-normal" style={{ fontSize: 13, marginLeft: 8 }}>
              активное: {activeCargo.barcode}
            </span>
          ) : null}
        </h4>
        {isExpress && cargoUnits.length > 0 ? (
          <Button
            variant="secondary"
            size="small"
            onClick={() => setExpressCargoListOpen((v) => !v)}
            title={expressCargoListOpen ? 'Скрыть номера коробок' : 'Показать все грузоместа'}
          >
            {expressCargoListOpen ? 'Скрыть номера' : `Номера ГМ (${cargoUnits.length})`}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="small"
          disabled={exporting || !(cargoUnits.length > 0)}
          onClick={handleExportExcel}
        >
          {exporting ? 'Выгрузка…' : 'Excel по грузоместам'}
        </Button>
      </div>

      {isExpress ? (
        <>
          {cargoUnits.length === 0 ? (
            <p className="text-muted">
              {isOzon
                ? 'Пока нет грузомест — нажмите «Новое грузоместо» и отсканируйте коробку.'
                : 'Пока нет грузомест — отсканируйте штрихкод коробки или нажмите «Новое грузоместо».'}
            </p>
          ) : expressCargoListOpen ? (
            <div className="fbo-express-cargo-switch" role="list">
              {sortedCargoUnits.map((cargo) => {
                const isActive = String(cargo.id) === String(activeCargoUnitId);
                return (
                  <button
                    key={cargo.id}
                    type="button"
                    role="listitem"
                    className={[
                      'fbo-express-cargo-chip',
                      isActive ? 'fbo-express-cargo-chip--active' : '',
                      cargo.weightExceeded ? 'fbo-express-cargo-chip--overweight' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => handleSelectCargo(cargo.id)}
                    title={cargo.barcode}
                  >
                    <strong>{cargo.barcode}</strong>
                    <span className="text-muted">
                      {cargo.cargoKind === 'pallet' ? 'паллета' : 'короб'} · {cargo.totalQuantity ?? 0} шт.
                    </span>
                    {isActive ? <span className="badge bg-primary">активно</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="fbo-express-columns">
            <section className="fbo-express-col fbo-express-col--pending">
              <h4 className="fbo-packing-section-title">
                К скану
                <span className="text-muted fw-normal" style={{ fontSize: 13, marginLeft: 8 }}>
                  осталось {expressPendingItems.length}
                  {expressFilterActive
                    ? ` · найдено ${expressPendingItems.length} из ${sortedSupplyItems.length}`
                    : null}
                </span>
              </h4>
              <div className="table-responsive fbo-express-col__scroll">
                <table className="table table-sm table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Название</th>
                      <th>Артикул</th>
                      <th>Штрихкод</th>
                      <th title="Упаковано / план">Осталось</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expressPendingItems.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-muted text-center py-3">
                          {expressFilterActive
                            ? 'Ничего не найдено'
                            : filteredSupplyItems.length === 0
                              ? 'Нет строк'
                              : 'Всё упаковано'}
                        </td>
                      </tr>
                    ) : null}
                    {expressPendingItems.map((it) => {
                      const stat = statsByItemId.get(String(it.id));
                      const planned = stat?.planned ?? it.quantity ?? 0;
                      const packed = stat?.packed ?? 0;
                      const left = Math.max(0, planned - packed);
                      return (
                        <tr key={it.id}>
                          <td>{it.productName || it.name || '—'}</td>
                          <td>{it.sku || '—'}</td>
                          <td>{it.barcode || '—'}</td>
                          <td>
                            <FboSupplyItemPackingCell
                              supplyId={supplyId}
                              itemId={it.id}
                              packed={packed}
                              planned={planned}
                              byCargo={stat?.byCargo || []}
                              onSaved={onItemQuantitySaved}
                              onBreakdownClick={() =>
                                onBreakdownClick?.({
                                  ...it,
                                  packed,
                                  planned,
                                  stat,
                                  byCargo: stat?.byCargo || [],
                                })
                              }
                            />
                            <span className="fbo-express-left-qty text-muted">ещё {left}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="fbo-express-col fbo-express-col--cargo">
              <h4 className="fbo-packing-section-title">
                Состав ГМ
                {activeCargo ? (
                  <span className="text-muted fw-normal" style={{ fontSize: 13, marginLeft: 8 }}>
                    {activeCargo.barcode} · {activeCargo.totalQuantity ?? 0} шт.
                  </span>
                ) : null}
              </h4>
              {!activeCargo ? (
                <p className="text-muted">Нет активного грузоместа.</p>
              ) : (
                <div className="fbo-express-col__scroll">
                  <div className="fbo-express-cargo-meta">
                    <FboCargoUnitKind
                      supplyId={supplyId}
                      cargo={activeCargo}
                      onPackingChange={handlePackingChange}
                    />
                    <FboCargoBarcodeEdit
                      supplyId={supplyId}
                      cargo={activeCargo}
                      onPackingChange={handlePackingChange}
                    />
                    {isOzon && activeCargo.barcode ? (
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={printingLabels}
                        onClick={(e) => handlePrintCargoLabels([activeCargo.barcode], e)}
                        title="Печать этикетки грузоместа"
                      >
                        Этикетка
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={(e) => handleDeleteCargo(activeCargo.id, e)}
                    >
                      Удалить ГМ
                    </Button>
                  </div>
                  {(activeCargo.contents || []).length === 0 ? (
                    <p className="text-muted small mb-0">Пусто — отсканируйте товары.</p>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm fbo-cargo-items-table mb-0">
                        <thead>
                          <tr>
                            <th>Товар</th>
                            <th>Артикул</th>
                            <th className="text-end">Кол-во</th>
                            {isOzon ? <th>Размещение</th> : null}
                            <th>Срок годности</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(activeCargo.contents || []).map((line) => (
                            <tr key={line.id}>
                              <td>{line.productName || line.sku || '—'}</td>
                              <td>{line.sku || '—'}</td>
                              <td className="text-end">
                                <strong>{line.quantity}</strong>
                              </td>
                              {isOzon ? (
                                <td className="fbo-cargo-items-table__meta">
                                  <span
                                    className={`badge ${
                                      placementKindLabel(line) === 'Сортируемый'
                                        ? 'bg-info text-dark'
                                        : placementKindLabel(line) === 'Несортируемый'
                                          ? 'bg-secondary'
                                          : 'bg-light text-dark border'
                                    }`}
                                  >
                                    {placementKindLabel(line)}
                                  </span>
                                  <FboCargoContentMeta
                                    supplyId={supplyId}
                                    line={line}
                                    marketplace={marketplace}
                                    onPackingChange={handlePackingChange}
                                    variant="inline"
                                    showZone
                                    showExpiry={false}
                                  />
                                </td>
                              ) : null}
                              <td className="fbo-cargo-items-table__meta">
                                <FboCargoContentMeta
                                  supplyId={supplyId}
                                  line={line}
                                  marketplace={marketplace}
                                  onPackingChange={handlePackingChange}
                                  variant="inline"
                                  showZone={false}
                                  showExpiry
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="fbo-cargo-items-table__totals">
                            <td colSpan={isOzon ? 3 : 2} className="text-end">
                              <strong>Итого</strong>
                            </td>
                            <td className="text-end">
                              <strong>{activeCargo.totalQuantity ?? 0}</strong>
                            </td>
                            <td colSpan={isOzon ? 2 : 1} className="text-muted">
                              {fmtVolumeL(activeCargo.totalVolumeL)} · {cargoWeightSummary(activeCargo)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          {isOzon ? (
            <FboTransportCargoes
              printHelperUrl={printHelperUrl}
              supplyId={supplyId}
              packing={packing}
              onPackingChange={onPackingChange}
              disabled={scanLoading || creatingOnOzon || syncingFromOzon || printingLabels}
            />
          ) : null}
        </>
      ) : (
        <>
          <p className="fbo-packing-hint" style={{ marginTop: 4 }}>
            {marketplace === 'wb'
              ? 'Формат WB: баркод, кол-во, ШК короба, срок годности.'
              : 'Формат Ozon: ШК товара, артикул, кол-во, зона, срок годности, ШК ГМ, тип ГМ.'}
          </p>
          {cargoUnits.length === 0 ? (
            <p className="text-muted">
              {isOzon
                ? 'Пока нет грузомест — нажмите «Новое грузоместо» и отсканируйте коробку.'
                : 'Пока нет грузомест — отсканируйте штрихкод коробки или нажмите «Новое грузоместо».'}
            </p>
          ) : (
            <div className="fbo-cargo-list">
              {sortedCargoUnits.map((cargo) => {
                const isActive = String(cargo.id) === String(activeCargoUnitId);
                return (
                  <div
                    key={cargo.id}
                    className={[
                      'fbo-cargo-card',
                      isActive ? 'fbo-cargo-card--active' : 'fbo-cargo-card--collapsed',
                      cargo.weightExceeded ? 'fbo-cargo-card--overweight' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div
                      className="fbo-cargo-card__head"
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectCargo(cargo.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelectCargo(cargo.id);
                        }
                      }}
                    >
                      <div className="fbo-cargo-card__title">
                        <strong>{cargo.barcode}</strong>
                        {isActive ? <span className="badge bg-primary ms-2">активно</span> : null}
                        {cargo.transportCargoBarcode ? (
                          <span className="badge bg-secondary ms-2" title="Привязан к транспортному грузоместу">
                            ТГМ {cargo.transportCargoBarcode}
                          </span>
                        ) : null}
                      </div>
                      <span className="fbo-cargo-card__summary text-muted small">
                        {cargo.cargoKind === 'pallet' ? 'паллета' : 'короб'}
                        {' · '}
                        {cargo.totalQuantity ?? 0} шт.
                        {(cargo.totalVolumeL > 0 || cargo.totalWeightG > 0) && (
                          <>
                            {' '}
                            · {fmtVolumeL(cargo.totalVolumeL)} · {cargoWeightSummary(cargo)}
                          </>
                        )}
                        {cargo.weightExceeded ? (
                          <span className="fbo-cargo-card__overweight"> · превышен вес</span>
                        ) : null}
                      </span>
                      <span className="text-muted small">{fmtDt(cargo.createdAt)}</span>
                      {isOzon && cargo.barcode ? (
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={printingLabels}
                          onClick={(e) => handlePrintCargoLabels([cargo.barcode], e)}
                          title="Печать этикетки грузоместа"
                        >
                          Этикетка
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={(e) => handleDeleteCargo(cargo.id, e)}
                      >
                        Удалить
                      </Button>
                    </div>
                    {isActive ? (
                      <div className="fbo-cargo-card__body">
                        <FboCargoUnitKind
                          supplyId={supplyId}
                          cargo={cargo}
                          onPackingChange={handlePackingChange}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <FboCargoBarcodeEdit
                          supplyId={supplyId}
                          cargo={cargo}
                          onPackingChange={handlePackingChange}
                          onClick={(e) => e.stopPropagation()}
                        />
                        {cargo.weightExceeded ? (
                          <div className="alert alert-warning py-2 px-3 small mb-2">
                            {cargoWeightExceededMessage(cargo)}
                          </div>
                        ) : null}
                        {(cargo.contents || []).length === 0 ? (
                          <p className="text-muted small mb-0">Пусто — отсканируйте товары.</p>
                        ) : (
                          <div className="table-responsive">
                            <table className="table table-sm fbo-cargo-items-table mb-0">
                              <thead>
                                <tr>
                                  <th>Товар</th>
                                  <th>Артикул</th>
                                  <th className="text-end">Кол-во</th>
                                  {isOzon ? <th>Размещение</th> : null}
                                  <th>Срок годности</th>
                                  <th className="text-end">Объём</th>
                                  <th className="text-end">Масса</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(cargo.contents || []).map((line) => (
                                  <tr key={line.id}>
                                    <td>{line.productName || line.sku || '—'}</td>
                                    <td>{line.sku || '—'}</td>
                                    <td className="text-end">
                                      <strong>{line.quantity}</strong>
                                    </td>
                                    {isOzon ? (
                                      <td className="fbo-cargo-items-table__meta">
                                        <div className="fbo-placement-kind">
                                          <span
                                            className={`badge ${
                                              placementKindLabel(line) === 'Сортируемый'
                                                ? 'bg-info text-dark'
                                                : placementKindLabel(line) === 'Несортируемый'
                                                  ? 'bg-secondary'
                                                  : 'bg-light text-dark border'
                                            }`}
                                          >
                                            {placementKindLabel(line)}
                                          </span>
                                        </div>
                                        <FboCargoContentMeta
                                          supplyId={supplyId}
                                          line={line}
                                          marketplace={marketplace}
                                          onPackingChange={handlePackingChange}
                                          variant="inline"
                                          showZone
                                          showExpiry={false}
                                        />
                                      </td>
                                    ) : null}
                                    <td className="fbo-cargo-items-table__meta">
                                      <FboCargoContentMeta
                                        supplyId={supplyId}
                                        line={line}
                                        marketplace={marketplace}
                                        onPackingChange={handlePackingChange}
                                        variant="inline"
                                        showZone={false}
                                        showExpiry
                                      />
                                    </td>
                                    <td className="text-end text-muted">
                                      {fmtVolumeL(line.lineVolumeL)}
                                    </td>
                                    <td className="text-end text-muted">
                                      {fmtWeightG(line.lineWeightG)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              {(cargo.contents || []).length > 0 ? (
                                <tfoot>
                                  <tr className="fbo-cargo-items-table__totals">
                                    <td colSpan={isOzon ? 5 : 4} className="text-end">
                                      <strong>Итого по грузоместу</strong>
                                    </td>
                                    <td className="text-end">
                                      <strong>{fmtVolumeL(cargo.totalVolumeL)}</strong>
                                    </td>
                                    <td className="text-end">
                                      <strong>{cargoWeightSummary(cargo)}</strong>
                                    </td>
                                  </tr>
                                </tfoot>
                              ) : null}
                            </table>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {isOzon ? (
            <FboTransportCargoes
              printHelperUrl={printHelperUrl}
              supplyId={supplyId}
              packing={packing}
              onPackingChange={onPackingChange}
              disabled={scanLoading || creatingOnOzon || syncingFromOzon || printingLabels}
            />
          ) : null}

          <h4 className="fbo-packing-section-title" style={{ marginTop: 20 }}>
            Товары поставки
            <span className="text-muted fw-normal" style={{ fontSize: 13, marginLeft: 8 }}>
              не собранные сверху
            </span>
            {itemSearchActive ? (
              <span className="text-muted fw-normal" style={{ fontSize: 13, marginLeft: 8 }}>
                · найдено {filteredSupplyItems.length} из {sortedSupplyItems.length}
              </span>
            ) : null}
          </h4>
          <div className="table-responsive">
            <table className="table table-sm table-hover">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Артикул</th>
                  <th>Штрихкод</th>
                  {isOzon ? <th>Размещение</th> : null}
                  <th title="Упаковано / план; нажмите на план (справа), чтобы изменить количество в поставке">Расхождения</th>
                </tr>
              </thead>
              <tbody>
                {filteredSupplyItems.length === 0 ? (
                  <tr>
                    <td colSpan={isOzon ? 5 : 4} className="text-muted text-center py-3">
                      {itemSearchActive ? 'Ничего не найдено' : 'Нет строк'}
                    </td>
                  </tr>
                ) : null}
                {filteredSupplyItems.map((it) => {
                  const stat = statsByItemId.get(String(it.id));
                  const planned = stat?.planned ?? it.quantity ?? 0;
                  const packed = stat?.packed ?? 0;
                  const complete = isSupplyItemPackingComplete(stat, it);
                  return (
                    <tr key={it.id} className={complete ? 'fbo-item-row--complete' : ''}>
                      <td>{it.productName || it.name || '—'}</td>
                      <td>{it.sku || '—'}</td>
                      <td>{it.barcode || '—'}</td>
                      {isOzon ? (
                        <td>
                          <span
                            className={`badge ${
                              placementKindLabel(it) === 'Сортируемый'
                                ? 'bg-info text-dark'
                                : placementKindLabel(it) === 'Несортируемый'
                                  ? 'bg-secondary'
                                  : 'bg-light text-dark border'
                            }`}
                          >
                            {placementKindLabel(it)}
                          </span>
                        </td>
                      ) : null}
                      <td>
                        <FboSupplyItemPackingCell
                          supplyId={supplyId}
                          itemId={it.id}
                          packed={packed}
                          planned={planned}
                          byCargo={stat?.byCargo || []}
                          onSaved={onItemQuantitySaved}
                          onBreakdownClick={() =>
                            onBreakdownClick?.({
                              ...it,
                              packed,
                              planned,
                              stat,
                              byCargo: stat?.byCargo || [],
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <FboSupplyPackingRemoveModal
        isOpen={removeModalOpen}
        onClose={() => setRemoveModalOpen(false)}
        supplyId={supplyId}
        activeCargoUnitId={activeCargoUnitId}
        activeCargoBarcode={activeCargo?.barcode}
        onPackingChange={handlePackingChange}
        revertCollect={isExpress}
      />

      <Modal
        isOpen={Boolean(overageConfirm)}
        onClose={handleCancelOverage}
        title="Лишний товар"
        size="medium"
        closeOnBackdropClick={!overageConfirmBusy}
        closeOnEscape={!overageConfirmBusy}
      >
        <p className="mb-2">
          {overageConfirm?.message ||
            'Упаковано больше, чем в поставке. Добавить ещё 1 шт. в грузоместо?'}
        </p>
        {overageConfirm?.sku || overageConfirm?.productName ? (
          <p className="text-muted small mb-3">
            {[overageConfirm.sku, overageConfirm.productName].filter(Boolean).join(' · ')}
            {overageConfirm.planned != null && overageConfirm.packed != null
              ? ` · план ${overageConfirm.planned}, уже ${overageConfirm.packed}`
              : null}
          </p>
        ) : null}
        <div className="d-flex flex-wrap gap-2 justify-content-end">
          <Button
            type="button"
            variant="secondary"
            onClick={handleCancelOverage}
            disabled={overageConfirmBusy}
          >
            Не добавлять
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirmOverage} disabled={overageConfirmBusy}>
            {overageConfirmBusy ? 'Добавление…' : 'Добавить всё равно'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

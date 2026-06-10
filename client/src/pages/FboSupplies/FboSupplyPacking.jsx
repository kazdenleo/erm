/**
 * Вкладка «Сборка» поставки FBO: грузоместа и сканирование.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { FboSupplyPackedBreakdownModal } from './FboSupplyPackedBreakdownModal.jsx';
import { FboSupplyPackingRemoveModal } from './FboSupplyPackingRemoveModal.jsx';
import { FboCargoContentMeta } from './FboCargoContentMeta.jsx';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';
import { ozonPlacementZoneLabel } from '../../constants/ozonPlacementZones';

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function packedCellClass(packed, planned) {
  if (packed === planned) return 'ok';
  if (packed > planned) return 'over';
  if (packed > 0) return 'short';
  return 'none';
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

export function FboSupplyPacking({
  supplyId,
  marketplace = 'ozon',
  supplyItems = [],
  packing,
  onPackingChange,
  onBreakdownClick,
  itemSearchQuery = '',
}) {
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanMsg, setScanMsg] = useState(null);
  const [activeCargoUnitId, setActiveCargoUnitId] = useState(null);
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const scanLoadingRef = useRef(false);

  scanLoadingRef.current = scanLoading;

  const statsByItemId = useMemo(
    () => buildStatsMap(packing?.itemStats),
    [packing?.itemStats]
  );

  const sortedSupplyItems = useMemo(
    () => sortSupplyItemsForPacking(supplyItems, statsByItemId),
    [supplyItems, statsByItemId]
  );

  const filteredSupplyItems = useMemo(
    () => filterSupplyItemsByQuery(sortedSupplyItems, itemSearchQuery),
    [sortedSupplyItems, itemSearchQuery]
  );

  const itemSearchActive = Boolean(normalizeProductSearchQuery(itemSearchQuery));

  const handleScan = useCallback(
    async (raw) => {
      const trimmed = (raw || '').trim();
      if (trimmed.length < 2 || scanLoadingRef.current) return;
      setScanError(null);
      setScanMsg(null);
      setScanLoading(true);
      try {
        const data = await fboSuppliesApi.packingScan(supplyId, {
          barcode: trimmed,
          activeCargoUnitId,
        });
        if (data?.activeCargoUnitId != null) {
          setActiveCargoUnitId(data.activeCargoUnitId);
        }
        if (data?.packing) {
          onPackingChange(data.packing, {
            supplyStatus: data.supplyStatus,
            packingAllMatch: data.packingAllMatch,
            statusReverted: data.statusReverted,
          });
        }
        setScanMsg(data?.message || 'Готово');
        playEventSound(SOUND_EVENTS.scan_ok);
      } catch (e) {
        playEventSound(SOUND_EVENTS.scan_error);
        setScanError(e.response?.data?.message || e.message || 'Ошибка сканирования');
      } finally {
        setScanLoading(false);
      }
    },
    [supplyId, activeCargoUnitId, onPackingChange]
  );

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

  const handleDeleteCargo = async (cargoUnitId) => {
    if (!window.confirm('Удалить грузоместо и весь его состав?')) return;
    try {
      const data = await fboSuppliesApi.deleteCargoUnit(supplyId, cargoUnitId);
      if (data?.packing) {
        onPackingChange(data.packing, {
          supplyStatus: data.supplyStatus,
          packingAllMatch: data.packingAllMatch,
          statusReverted: data.statusReverted,
        });
      }
      if (String(activeCargoUnitId) === String(cargoUnitId)) {
        setActiveCargoUnitId(null);
      }
    } catch (e) {
      setScanError(e.response?.data?.message || e.message || 'Не удалось удалить');
    }
  };

  const activeCargo = (packing?.cargoUnits || []).find(
    (c) => String(c.id) === String(activeCargoUnitId)
  );

  return (
    <div className="fbo-packing">
      <div className="fbo-packing-scan">
        <BarcodeScanField
          id="fbo-packing-barcode"
          label="Штрихкод"
          className="form-control"
          formClassName="fbo-packing-scan-row warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
          placeholder="Коробка / паллета, затем товары поставки"
          loading={scanLoading}
          disabled={scanLoading}
          enableGlobalCapture
          onScan={handleScan}
          hint={
            <>
              Сначала отсканируйте штрихкод <strong>коробки или паллеты</strong> — откроется грузоместо.
              Затем сканируйте <strong>товары из этой поставки</strong> (+1 шт. за скан).
              Чтобы перейти к другой коробке, снова отсканируйте её штрихкод — активным станет это грузоместо
              (новая коробка создаётся автоматически).
              {marketplace === 'ozon' ? (
                <>
                  {' '}
                  В одном грузоместе нельзя смешивать <strong>сортируемый</strong> и{' '}
                  <strong>несортируемый</strong> товар.
                </>
              ) : null}
            </>
          }
        >
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
        <div className="fbo-packing-active alert alert-info">
          Активное грузоместо: <strong>{activeCargo.barcode}</strong>
          {' '}
          <span className="text-muted">
            ({activeCargo.totalQuantity ?? 0} шт. внутри)
          </span>
        </div>
      ) : (
        <div className="fbo-packing-active alert alert-warning">
          Нет активного грузоместа — отсканируйте коробку или паллету.
        </div>
      )}

      {scanError && <div className="alert alert-danger">{scanError}</div>}
      {scanMsg && !scanError && <div className="alert alert-success">{scanMsg}</div>}

      <div className="fbo-items-toolbar">
        <h4 className="fbo-packing-section-title" style={{ margin: 0, flex: 1 }}>
          Грузоместа ({packing?.cargoUnits?.length ?? 0})
        </h4>
        <Button
          variant="secondary"
          size="small"
          disabled={exporting || !(packing?.cargoUnits?.length > 0)}
          onClick={handleExportExcel}
        >
          {exporting ? 'Выгрузка…' : 'Excel по грузоместам'}
        </Button>
      </div>
      <p className="fbo-packing-hint" style={{ marginTop: 4 }}>
        {marketplace === 'wb'
          ? 'Формат WB: баркод, кол-во, ШК короба, срок годности.'
          : 'Формат Ozon: артикул, кол-во, зона, ШК ГМ, срок годности (1 дата на SKU в грузоместе).'}
      </p>
      {(packing?.cargoUnits || []).length === 0 ? (
        <p className="text-muted">Пока нет грузомест — отсканируйте штрихкод коробки.</p>
      ) : (
        <div className="fbo-cargo-list">
          {(packing.cargoUnits || []).map((cargo) => {
            const isActive = String(cargo.id) === String(activeCargoUnitId);
            return (
              <div
                key={cargo.id}
                className={`fbo-cargo-card${isActive ? ' fbo-cargo-card--active' : ''}`}
              >
                <div className="fbo-cargo-card__head">
                  <button
                    type="button"
                    className="fbo-cargo-card__select btn btn-link"
                    onClick={() => setActiveCargoUnitId(cargo.id)}
                  >
                    <strong>{cargo.barcode}</strong>
                    {isActive ? <span className="badge bg-primary ms-2">активно</span> : null}
                  </button>
                  <span className="text-muted small">{fmtDt(cargo.createdAt)}</span>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => handleDeleteCargo(cargo.id)}
                  >
                    Удалить грузоместо
                  </Button>
                </div>
                {(cargo.contents || []).length === 0 ? (
                  <p className="text-muted small mb-0">Пусто</p>
                ) : (
                  <ul className="fbo-cargo-card__items">
                    {(cargo.contents || []).map((line) => (
                      <li key={line.id}>
                        <div>
                          {line.productName || line.sku || '—'} — <strong>{line.quantity}</strong> шт.
                        </div>
                        <FboCargoContentMeta
                          supplyId={supplyId}
                          line={line}
                          marketplace={marketplace}
                          onPackingChange={onPackingChange}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

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
              {marketplace === 'ozon' ? <th>Размещение</th> : null}
              <th>План</th>
              <th>Расхождения</th>
            </tr>
          </thead>
          <tbody>
            {filteredSupplyItems.length === 0 ? (
              <tr>
                <td colSpan={marketplace === 'ozon' ? 6 : 5} className="text-muted text-center py-3">
                  {itemSearchActive ? 'Ничего не найдено' : 'Нет строк'}
                </td>
              </tr>
            ) : null}
            {filteredSupplyItems.map((it) => {
              const stat = statsByItemId.get(String(it.id));
              const planned = stat?.planned ?? it.quantity ?? 0;
              const packed = stat?.packed ?? 0;
              const cls = packedCellClass(packed, planned);
              const complete = isSupplyItemPackingComplete(stat, it);
              return (
                <tr key={it.id} className={complete ? 'fbo-item-row--complete' : ''}>
                  <td>{it.productName || it.name || '—'}</td>
                  <td>{it.sku || '—'}</td>
                  <td>{it.barcode || '—'}</td>
                  {marketplace === 'ozon' ? (
                    <td>{ozonPlacementZoneLabel(it.placementZone, it.ozonTags)}</td>
                  ) : null}
                  <td>{planned}</td>
                  <td>
                    <button
                      type="button"
                      className={`fbo-packed-cell fbo-packed-${cls}`}
                      onClick={() =>
                        onBreakdownClick?.({
                          ...it,
                          packed,
                          planned,
                          stat,
                          byCargo: stat?.byCargo || [],
                        })
                      }
                      title="Где упаковано"
                    >
                      {packed} / {planned}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FboSupplyPackingRemoveModal
        isOpen={removeModalOpen}
        onClose={() => setRemoveModalOpen(false)}
        supplyId={supplyId}
        activeCargoUnitId={activeCargoUnitId}
        activeCargoBarcode={activeCargo?.barcode}
        onPackingChange={onPackingChange}
      />
    </div>
  );
}

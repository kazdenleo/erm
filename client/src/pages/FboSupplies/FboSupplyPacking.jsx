/**
 * Вкладка «Сборка» поставки FBO: грузоместа и сканирование.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { FboSupplyPackingRemoveModal } from './FboSupplyPackingRemoveModal.jsx';
import { FboCargoContentMeta } from './FboCargoContentMeta.jsx';
import { FboCargoUnitKind } from './FboCargoUnitKind.jsx';
import { cargoWeightExceededMessage, fmtVolumeL, fmtWeightG } from './fboPackingFormat.js';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';

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
  const [weightWarning, setWeightWarning] = useState(null);
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

  const cargoUnits = packing?.cargoUnits || [];

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

  const handleScan = useCallback(
    async (raw) => {
      const trimmed = (raw || '').trim();
      if (trimmed.length < 2 || scanLoadingRef.current) return;
      setScanError(null);
      setScanMsg(null);
      setWeightWarning(null);
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
          const nextActiveId = data.activeCargoUnitId ?? activeCargoUnitId;
          const nextActive = (data.packing.cargoUnits || []).find(
            (c) => String(c.id) === String(nextActiveId)
          );
          setWeightWarning(data?.weightWarning || cargoWeightExceededMessage(nextActive) || null);
        } else {
          setWeightWarning(data?.weightWarning || null);
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
  const activeWeightWarning =
    weightWarning || (activeCargo ? cargoWeightExceededMessage(activeCargo) : null);
  const isOzon = marketplace !== 'wb';

  const handlePackingChange = (nextPacking, meta) => {
    onPackingChange?.(nextPacking, meta);
    const nextActive = (nextPacking?.cargoUnits || []).find(
      (c) => String(c.id) === String(activeCargoUnitId)
    );
    setWeightWarning(nextActive ? cargoWeightExceededMessage(nextActive) : null);
  };

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
              Повторный скан того же штрихкода коробки переключит на это грузоместо.
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
                · {fmtVolumeL(activeCargo.totalVolumeL)} · {fmtWeightG(activeCargo.totalWeightG)}
              </>
            )}
            {activeCargo.weightLimitKg ? (
              <> · лимит {activeCargo.weightLimitKg} кг</>
            ) : null}
            )
          </span>
        </div>
      ) : (
        <div className="fbo-packing-active alert alert-warning">
          Нет активного грузоместа — отсканируйте коробку или паллету.
        </div>
      )}

      {scanError && <div className="alert alert-danger">{scanError}</div>}
      {activeWeightWarning && !scanError ? (
        <div className="alert alert-warning">{activeWeightWarning}</div>
      ) : null}
      {scanMsg && !scanError && <div className="alert alert-success">{scanMsg}</div>}

      <div className="fbo-items-toolbar">
        <h4 className="fbo-packing-section-title" style={{ margin: 0, flex: 1 }}>
          Грузоместа ({cargoUnits.length})
        </h4>
        <Button
          variant="secondary"
          size="small"
          disabled={exporting || !(cargoUnits.length > 0)}
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
      {cargoUnits.length === 0 ? (
        <p className="text-muted">Пока нет грузомест — отсканируйте штрихкод коробки.</p>
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
                  onClick={() => setActiveCargoUnitId(cargo.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveCargoUnitId(cargo.id);
                    }
                  }}
                >
                  <div className="fbo-cargo-card__title">
                    <strong>{cargo.barcode}</strong>
                    {isActive ? <span className="badge bg-primary ms-2">активно</span> : null}
                  </div>
                  <span className="fbo-cargo-card__summary text-muted small">
                    {cargo.cargoKind === 'pallet' ? 'паллета' : 'короб'}
                    {' · '}
                    {cargo.totalQuantity ?? 0} шт.
                    {(cargo.totalVolumeL > 0 || cargo.totalWeightG > 0) && (
                      <>
                        {' '}
                        · {fmtVolumeL(cargo.totalVolumeL)} · {fmtWeightG(cargo.totalWeightG)}
                      </>
                    )}
                    {cargo.weightExceeded ? (
                      <span className="fbo-cargo-card__overweight"> · превышен вес</span>
                    ) : null}
                  </span>
                  <span className="text-muted small">{fmtDt(cargo.createdAt)}</span>
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
                              {isOzon ? <th>Зона</th> : null}
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
                                  <strong>{fmtWeightG(cargo.totalWeightG)}</strong>
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
              <th>План</th>
              <th>Расхождения</th>
            </tr>
          </thead>
          <tbody>
            {filteredSupplyItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted text-center py-3">
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
        onPackingChange={handlePackingChange}
      />
    </div>
  );
}

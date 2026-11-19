/**
 * Вкладка «Возврат»: приём коробок сканом, реактивация без перепаковки, присвоение новых этикеток.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { getFboSupplyStatusLabel } from '../../constants/fboSupplyStatuses';

function cargoTitle(unit) {
  return unit?.barcodeLabel || unit?.barcode || `#${unit?.id}`;
}

function contentsSummary(unit) {
  const lines = unit?.contents || [];
  if (!lines.length) return 'пусто';
  const pcs = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  return `${lines.length} поз., ${pcs} шт.`;
}

export function FboSupplyReturn({
  supplyId,
  supplyStatus,
  marketplace,
  onSupplyChange,
  onPackingChange,
  printHelperUrl = '',
}) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const [newShipmentNumber, setNewShipmentNumber] = useState('');
  const [newSupplyId, setNewSupplyId] = useState('');
  const [reactivating, setReactivating] = useState(false);

  /** null | { fromBarcode, fromLabel } — ждём скан новой этикетки */
  const [labelStep, setLabelStep] = useState(null);
  const [assignedIds, setAssignedIds] = useState(() => new Set());
  const [printing, setPrinting] = useState(false);

  const scanLockRef = useRef(false);
  const status = supplyStatus || state?.supply?.status || '';

  const canAcceptReturn = ['shipped', 'closed', 'return'].includes(status);
  const canReactivate = status === 'return';
  const canAssignLabels = ['return', 'packing', 'ready_for_supply'].includes(status);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!supplyId) return;
      if (!silent) setLoading(true);
      try {
        const data = await fboSuppliesApi.getReturn(supplyId);
        setState(data);
        if (!silent) setErr(null);
      } catch (e) {
        if (!silent) {
          setErr(e.response?.data?.message || e.message || 'Не удалось загрузить возврат');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [supplyId]
  );

  useEffect(() => {
    load({ silent: false });
  }, [load]);

  const cargoUnits = state?.cargoUnits || [];
  const progress = state?.progress || { total: 0, returned: 0, pending: 0 };

  const handleReturnScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || scanLockRef.current || !canAcceptReturn) return;
      scanLockRef.current = true;
      setScanning(true);
      setErr(null);
      setMsg(null);
      try {
        const data = await fboSuppliesApi.returnScan(supplyId, { barcode: code });
        setState(data);
        setMsg(data.message || 'Принято');
        playEventSound(SOUND_EVENTS.scan_ok);
        if (data.supplyStatus) {
          onSupplyChange?.(data.supply ?? { status: data.supplyStatus }, {
            status: data.supplyStatus,
          });
        }
      } catch (e) {
        playEventSound(SOUND_EVENTS.scan_error);
        setErr(e.response?.data?.message || e.message || 'Ошибка сканирования');
      } finally {
        setScanning(false);
        scanLockRef.current = false;
      }
    },
    [supplyId, canAcceptReturn, onSupplyChange]
  );

  const handleReactivate = useCallback(async () => {
    const num = String(newShipmentNumber || '').trim();
    if (!num || reactivating) return;
    setReactivating(true);
    setErr(null);
    setMsg(null);
    try {
      const data = await fboSuppliesApi.reactivate(supplyId, {
        externalShipmentNumber: num,
        externalSupplyId: String(newSupplyId || '').trim() || undefined,
      });
      setMsg(data.message || 'Поставка возвращена в активные');
      playEventSound(SOUND_EVENTS.scan_ok);
      setAssignedIds(new Set());
      setLabelStep(null);
      if (data.supply) {
        onSupplyChange?.(data.supply, { status: data.supplyStatus || data.supply.status });
      }
      if (data.packing) {
        onPackingChange?.(data.packing);
      }
      await load({ silent: true });
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setErr(e.response?.data?.message || e.message || 'Не удалось реактивировать');
    } finally {
      setReactivating(false);
    }
  }, [
    newShipmentNumber,
    newSupplyId,
    reactivating,
    supplyId,
    onSupplyChange,
    onPackingChange,
    load,
  ]);

  const handleLabelScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || scanLockRef.current || !canAssignLabels) return;

      if (!labelStep) {
        const unit = cargoUnits.find(
          (c) =>
            String(c.barcode) === code ||
            String(c.barcodeLabel) === code ||
            String(c.id) === code
        );
        if (!unit) {
          // Сервер подтвердит при втором шаге; на первом шаге ищем локально и на сервере через «from»
          setLabelStep({ fromBarcode: code, fromLabel: code });
          setMsg(`Коробка ${code}: отсканируйте новую этикетку`);
          playEventSound(SOUND_EVENTS.scan_ok);
          return;
        }
        setLabelStep({
          fromBarcode: unit.barcode,
          fromLabel: cargoTitle(unit),
          cargoUnitId: unit.id,
        });
        setMsg(`Коробка ${cargoTitle(unit)}: отсканируйте новую этикетку`);
        playEventSound(SOUND_EVENTS.scan_ok);
        return;
      }

      scanLockRef.current = true;
      setScanning(true);
      setErr(null);
      setMsg(null);
      try {
        const data = await fboSuppliesApi.assignReturnLabel(supplyId, {
          fromBarcode: labelStep.fromBarcode,
          toBarcode: code,
        });
        setMsg(data.message || 'Этикетка присвоена');
        playEventSound(SOUND_EVENTS.scan_ok);
        if (data.cargoUnitId != null) {
          setAssignedIds((prev) => new Set(prev).add(Number(data.cargoUnitId)));
        }
        if (data.packing) {
          onPackingChange?.(data.packing);
        }
        setLabelStep(null);
        await load({ silent: true });
      } catch (e) {
        playEventSound(SOUND_EVENTS.scan_error);
        setErr(e.response?.data?.message || e.message || 'Не удалось присвоить этикетку');
      } finally {
        setScanning(false);
        scanLockRef.current = false;
      }
    },
    [canAssignLabels, labelStep, cargoUnits, supplyId, onPackingChange, load]
  );

  const cancelLabelStep = () => {
    setLabelStep(null);
    setMsg(null);
  };

  const printLabels = useCallback(
    async (ids) => {
      if (!ids?.length || printing) return;
      setPrinting(true);
      setErr(null);
      try {
        await fboSuppliesApi.printCargoLabels(supplyId, ids, {
          printHelperUrl: printHelperUrl || undefined,
          marketplace: marketplace || state?.supply?.marketplace,
        });
        setMsg(`Отправлено на печать: ${ids.length} этикет.`);
      } catch (e) {
        setErr(e.response?.data?.message || e.message || 'Не удалось напечатать этикетки');
      } finally {
        setPrinting(false);
      }
    },
    [supplyId, printing, printHelperUrl, marketplace, state?.supply?.marketplace]
  );

  const mpHint = useMemo(() => {
    const mp = String(marketplace || state?.supply?.marketplace || '').toLowerCase();
    if (mp === 'wb') return 'WB';
    if (mp === 'ym' || mp === 'yandex') return 'Яндекс Маркет';
    return 'Ozon';
  }, [marketplace, state?.supply?.marketplace]);

  if (loading && !state) {
    return <p className="muted-hint">Загрузка возврата…</p>;
  }

  return (
    <div className="fbo-return">
      {err ? <div className="alert alert-danger">{err}</div> : null}
      {msg ? <div className="alert alert-success">{msg}</div> : null}

      <div className="fbo-return__progress">
        Принято коробок:{' '}
        <strong>
          {progress.returned} / {progress.total}
        </strong>
        {status ? (
          <span className="muted-hint"> · статус: {getFboSupplyStatusLabel(status)}</span>
        ) : null}
      </div>

      {canAcceptReturn ? (
        <section className="fbo-return__section">
          <h3 className="fbo-return__heading">Приём возврата</h3>
          <p className="muted-hint">
            Сканируйте штрихкод грузоместа. Остатки из состава коробки вернутся на склад списания.
            Можно принимать частично.
          </p>
          <BarcodeScanField
            id="fbo-return-scan"
            label="Скан коробки"
            placeholder="Отсканируйте коробку возврата"
            onScan={handleReturnScan}
            loading={scanning}
            disabled={!canAcceptReturn}
            enableGlobalCapture={canAcceptReturn && !canAssignLabels}
          />
        </section>
      ) : null}

      {canReactivate ? (
        <section className="fbo-return__section">
          <h3 className="fbo-return__heading">Вернуть в активные без перепаковки</h3>
          <p className="muted-hint">
            Создайте новую поставку на {mpHint}, укажите новый номер. Состав грузомест сохранится,
            товар снова зарезервируется под эту поставку. Затем присвойте новые этикетки к коробкам.
          </p>
          <div className="fbo-return__reactivate-form">
            <label className="form-label" htmlFor="fbo-return-new-number">
              Новый номер поставки
            </label>
            <input
              id="fbo-return-new-number"
              className="form-control"
              value={newShipmentNumber}
              onChange={(e) => setNewShipmentNumber(e.target.value)}
              placeholder="Номер отгрузки с маркетплейса"
              autoComplete="off"
            />
            <label className="form-label" htmlFor="fbo-return-new-supply-id">
              ID поставки на МП (необязательно)
            </label>
            <input
              id="fbo-return-new-supply-id"
              className="form-control"
              value={newSupplyId}
              onChange={(e) => setNewSupplyId(e.target.value)}
              placeholder="external supply id"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="primary"
              disabled={!String(newShipmentNumber).trim() || reactivating}
              onClick={handleReactivate}
            >
              {reactivating ? 'Сохранение…' : 'Вернуть в активные'}
            </Button>
          </div>
        </section>
      ) : null}

      {canAssignLabels ? (
        <section className="fbo-return__section">
          <h3 className="fbo-return__heading">Присвоить новые этикетки</h3>
          <p className="muted-hint">
            {labelStep
              ? `Выбрана коробка «${labelStep.fromLabel}». Отсканируйте новую этикетку.`
              : 'Сначала отсканируйте текущую коробку, затем — новую этикетку с маркетплейса.'}
          </p>
          <div className="fbo-packing-scan-row">
            <BarcodeScanField
              id="fbo-return-label-scan"
              label={labelStep ? 'Новая этикетка' : 'Текущая коробка'}
              placeholder={
                labelStep
                  ? 'Отсканируйте новую этикетку'
                  : 'Отсканируйте коробку, затем новую этикетку'
              }
              onScan={handleLabelScan}
              loading={scanning}
              enableGlobalCapture={!canAcceptReturn || status !== 'return'}
            />
            {labelStep ? (
              <Button type="button" variant="secondary" onClick={cancelLabelStep}>
                Сбросить
              </Button>
            ) : null}
          </div>
          <div className="fbo-return__print-row">
            <Button
              type="button"
              variant="secondary"
              disabled={printing || !cargoUnits.length}
              onClick={() => printLabels(cargoUnits.map((c) => c.id))}
            >
              {printing ? 'Печать…' : 'Печать всех этикеток'}
            </Button>
            {assignedIds.size > 0 ? (
              <Button
                type="button"
                variant="secondary"
                disabled={printing}
                onClick={() => printLabels([...assignedIds])}
              >
                Печать перепривязанных ({assignedIds.size})
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="fbo-return__section">
        <h3 className="fbo-return__heading">Грузоместа</h3>
        {!cargoUnits.length ? (
          <p className="muted-hint">В поставке нет грузомест</p>
        ) : (
          <ul className="fbo-return__cargo-list">
            {cargoUnits.map((unit) => {
              const returned = Boolean(unit.returnedAt);
              const assigned = assignedIds.has(Number(unit.id));
              return (
                <li
                  key={unit.id}
                  className={`fbo-return__cargo-card${
                    returned ? ' fbo-return__cargo-card--returned' : ''
                  }${assigned ? ' fbo-return__cargo-card--assigned' : ''}`}
                >
                  <div className="fbo-return__cargo-head">
                    <strong>{cargoTitle(unit)}</strong>
                    <span className="muted-hint">{contentsSummary(unit)}</span>
                    {returned ? (
                      <span className="fbo-return__badge fbo-return__badge--ok">Принято</span>
                    ) : canAcceptReturn ? (
                      <span className="fbo-return__badge">Ожидает</span>
                    ) : null}
                    {assigned ? (
                      <span className="fbo-return__badge fbo-return__badge--assigned">
                        Этикетка обновлена
                      </span>
                    ) : null}
                  </div>
                  {unit.contents?.length ? (
                    <ul className="fbo-return__contents">
                      {unit.contents.map((line) => (
                        <li key={line.id}>
                          {line.sku || line.productName || `#${line.productId}`} — {line.quantity}{' '}
                          шт.
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Транспортные грузоместа Ozon (ТГМ): создание и привязка коробов.
 */

import React, { useMemo, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';

export function FboTransportCargoes({
  supplyId,
  packing,
  onPackingChange,
  disabled = false,
  printHelperUrl = '',
}) {
  const transportCargoes = packing?.transportCargoes || [];
  const cargoUnits = packing?.cargoUnits || [];
  const [createCount, setCreateCount] = useState('1');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [selectedUnitIds, setSelectedUnitIds] = useState([]);

  const unboundUnits = useMemo(
    () => cargoUnits.filter((u) => !u.transportCargoId),
    [cargoUnits]
  );

  const unitsByTransport = useMemo(() => {
    const map = new Map();
    for (const u of cargoUnits) {
      if (!u.transportCargoId) continue;
      const key = Number(u.transportCargoId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(u);
    }
    return map;
  }, [cargoUnits]);

  const handleCreate = async () => {
    const n = Math.min(Math.max(parseInt(createCount, 10) || 1, 1), 40);
    setBusy('create');
    setError(null);
    setMsg(null);
    try {
      const data = await fboSuppliesApi.createOzonTransportCargoes(supplyId, { count: n });
      if (data?.packing && typeof onPackingChange === 'function') {
        onPackingChange(data.packing);
      }
      setMsg(data?.message || `Создано ТГМ: ${n}`);
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось создать ТГМ');
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setBusy(null);
    }
  };

  const handleBind = async (transport) => {
    if (!selectedUnitIds.length) {
      setError('Выберите короба для привязки');
      return;
    }
    setBusy(`bind-${transport.id}`);
    setError(null);
    setMsg(null);
    try {
      const data = await fboSuppliesApi.bindOzonTransportCargoes(supplyId, {
        transportCargoId: transport.barcode,
        cargoUnitIds: selectedUnitIds,
      });
      if (data?.packing && typeof onPackingChange === 'function') {
        onPackingChange(data.packing);
      }
      setSelectedUnitIds([]);
      setMsg(data?.message || 'Короба привязаны');
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось привязать короба');
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setBusy(null);
    }
  };

  const handleUnbind = async (transport, unit) => {
    setBusy(`unbind-${unit.id}`);
    setError(null);
    setMsg(null);
    try {
      const data = await fboSuppliesApi.bindOzonTransportCargoes(supplyId, {
        transportCargoId: transport.barcode,
        unbindCargoBarcodes: [unit.barcode],
      });
      if (data?.packing && typeof onPackingChange === 'function') {
        onPackingChange(data.packing);
      }
      setMsg(data?.message || `Отвязан короб ${unit.barcode}`);
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось отвязать короб');
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setBusy(null);
    }
  };

  const handlePrint = async (transport) => {
    setBusy(`print-${transport.id}`);
    setError(null);
    setMsg(null);
    try {
      const res = await fboSuppliesApi.printTransportCargoLabels(supplyId, [transport.barcode], {
        printHelperUrl,
      });
      setMsg(
        res?.via === 'helper'
          ? 'Этикетка ТГМ отправлена на принтер'
          : res?.opened === false
            ? 'Этикетка ТГМ скачана файлом PDF'
            : 'Этикетка ТГМ открыта для печати'
      );
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (e) {
      setError(e.message || 'Не удалось напечатать этикетку ТГМ');
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setBusy(null);
    }
  };

  const toggleUnit = (unitId) => {
    setSelectedUnitIds((prev) =>
      prev.includes(unitId) ? prev.filter((id) => id !== unitId) : [...prev, unitId]
    );
  };

  return (
    <div className="fbo-transport-cargoes" style={{ marginTop: 20 }}>
      <div className="fbo-items-toolbar" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h4 className="fbo-packing-section-title" style={{ margin: 0, flex: 1 }}>
          Транспортные грузоместа ({transportCargoes.length})
        </h4>
        <label className="fbo-ozon-create-opts__count" title="Сколько ТГМ создать на Ozon">
          Кол-во
          <input
            type="number"
            min={1}
            max={40}
            step={1}
            value={createCount}
            disabled={disabled || Boolean(busy)}
            onChange={(e) => setCreateCount(e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || Boolean(busy)}
          onClick={handleCreate}
          title="Создать транспортные грузоместа (паллеты) на Ozon"
        >
          {busy === 'create' ? 'Ozon…' : 'ТГМ на Ozon'}
        </Button>
      </div>
      <p className="fbo-packing-hint" style={{ marginTop: 4 }}>
        ТГМ — паллета, к которой прикрепляют короба. Сначала создайте ТГМ, затем привяжите короба.
        «Подтянуть из Ozon» также подхватывает ТГМ и привязки.
      </p>
      {error ? <div className="alert alert-danger py-2">{error}</div> : null}
      {msg && !error ? <div className="alert alert-success py-2">{msg}</div> : null}

      {transportCargoes.length === 0 ? (
        <p className="text-muted">Пока нет транспортных грузомест.</p>
      ) : (
        <div className="fbo-cargo-list">
          {transportCargoes.map((tc) => {
            const isOpen = String(expandedId) === String(tc.id);
            const bound = unitsByTransport.get(Number(tc.id)) || [];
            return (
              <div
                key={tc.id}
                className={`fbo-cargo-card ${isOpen ? 'fbo-cargo-card--active' : 'fbo-cargo-card--collapsed'}`}
              >
                <div
                  className="fbo-cargo-card__head"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setExpandedId(isOpen ? null : tc.id);
                    setSelectedUnitIds([]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(isOpen ? null : tc.id);
                    }
                  }}
                >
                  <div className="fbo-cargo-card__title">
                    <strong>{tc.barcode}</strong>
                    <span className="badge bg-secondary ms-2">ТГМ</span>
                  </div>
                  <span className="fbo-cargo-card__summary text-muted small">
                    паллета · коробов {bound.length || tc.boxCount || 0}
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={disabled || Boolean(busy)}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handlePrint(tc);
                    }}
                  >
                    {busy === `print-${tc.id}` ? '…' : 'Этикетка'}
                  </Button>
                </div>
                {isOpen ? (
                  <div className="fbo-cargo-card__body" onClick={(e) => e.stopPropagation()}>
                    <div style={{ marginBottom: 10 }}>
                      <strong className="small">Привязанные короба</strong>
                      {bound.length === 0 ? (
                        <p className="text-muted small mb-0">Пока пусто</p>
                      ) : (
                        <ul className="mb-2" style={{ paddingLeft: 18 }}>
                          {bound.map((u) => (
                            <li key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span>{u.barcode}</span>
                              <Button
                                variant="secondary"
                                size="small"
                                disabled={disabled || Boolean(busy)}
                                onClick={() => void handleUnbind(tc, u)}
                              >
                                {busy === `unbind-${u.id}` ? '…' : 'Отвязать'}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <strong className="small">Свободные короба</strong>
                      {unboundUnits.length === 0 ? (
                        <p className="text-muted small mb-0">Нет свободных коробов</p>
                      ) : (
                        <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                            {unboundUnits.map((u) => (
                              <label key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={selectedUnitIds.includes(u.id)}
                                  onChange={() => toggleUnit(u.id)}
                                  disabled={disabled || Boolean(busy)}
                                />
                                <span>
                                  {u.barcode}{' '}
                                  <span className="text-muted">
                                    ({u.cargoKind === 'pallet' ? 'паллета' : 'короб'} · {u.totalQuantity || 0} шт.)
                                  </span>
                                </span>
                              </label>
                            ))}
                          </div>
                          <Button
                            type="button"
                            variant="primary"
                            size="small"
                            style={{ marginTop: 8 }}
                            disabled={disabled || Boolean(busy) || !selectedUnitIds.length}
                            onClick={() => void handleBind(tc)}
                          >
                            {busy === `bind-${tc.id}` ? 'Привязка…' : 'Прикрепить выбранные'}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

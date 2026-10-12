/**
 * Размещение и перемещение между ячейками: скан товара и ячеек, остаток «без адреса», журнал.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { ProductPicker } from './ProductPicker';

const UNPLACED = 'unplaced';

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

export function MovesTab({ warehouseId, settings, locations, reloadLocations, onSettingsSaved }) {
  const [product, setProduct] = useState(null);
  const [whInfo, setWhInfo] = useState(null);
  const [from, setFrom] = useState(UNPLACED);
  const [to, setTo] = useState('');
  const [qty, setQty] = useState('');
  const [cellTarget, setCellTarget] = useState('to');
  const [scannedCell, setScannedCell] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingKind, setPendingKind] = useState(settings.trackQuantities ? 'unplaced' : 'unassigned');
  const [pending, setPending] = useState([]);
  const [movements, setMovements] = useState([]);

  const locById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const activeLocations = useMemo(() => locations.filter((l) => l.isActive), [locations]);

  const loadPending = useCallback(async () => {
    try {
      setPending((await addressStorageApi.listPending(warehouseId, pendingKind)) || []);
    } catch {
      setPending([]);
    }
  }, [warehouseId, pendingKind]);

  const loadMovements = useCallback(async () => {
    try {
      setMovements((await addressStorageApi.listMovements(warehouseId, { limit: 100 })) || []);
    } catch {
      setMovements([]);
    }
  }, [warehouseId]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (settings.trackQuantities) void loadMovements();
  }, [loadMovements, settings.trackQuantities]);

  const loadProductInfo = useCallback(
    async (productId) => {
      const r = await addressStorageApi.productLocations(productId);
      const wh = (r?.warehouses || []).find((w) => w.warehouseId === warehouseId) || null;
      setWhInfo(wh);
      return wh;
    },
    [warehouseId]
  );

  const chooseProduct = useCallback(
    async (p, { fromLocationId = null } = {}) => {
      setProduct(p);
      setMessage(null);
      const wh = await loadProductInfo(p.id).catch(() => null);
      const srcStock = fromLocationId ? wh?.stocks.find((s) => s.location.id === fromLocationId) : null;
      const nextFrom = srcStock ? String(fromLocationId) : UNPLACED;
      setFrom(nextFrom);
      const available = srcStock ? srcStock.quantity : wh?.unplaced ?? 0;
      setQty(available > 0 ? String(available) : '');
      const assignedId = wh?.assigned?.id;
      setTo(assignedId && String(assignedId) !== nextFrom ? String(assignedId) : '');
      setCellTarget('to');
    },
    [loadProductInfo]
  );

  const sourceAvailable = useMemo(() => {
    if (!whInfo) return 0;
    if (from === UNPLACED) return whInfo.unplaced;
    return whInfo.stocks.find((s) => String(s.location.id) === from)?.quantity ?? 0;
  }, [whInfo, from]);

  const handleScan = async (code) => {
    setMessage(null);
    try {
      const r = await addressStorageApi.resolveScan(warehouseId, code);
      if (r.type === 'product') {
        playEventSound(SOUND_EVENTS.scan_ok);
        await chooseProduct({ id: r.product.id, sku: r.product.sku, name: r.product.name });
        return;
      }
      const loc = r.location;
      playEventSound(SOUND_EVENTS.scan_ok);
      if (!product) {
        setScannedCell(r);
        if (r.items.length === 1) {
          await chooseProduct(
            { id: r.items[0].productId, sku: r.items[0].sku, name: r.items[0].name },
            { fromLocationId: loc.id }
          );
        }
        return;
      }
      if (cellTarget === 'from') {
        setFrom(String(loc.id));
        const have = whInfo?.stocks.find((s) => s.location.id === loc.id)?.quantity ?? 0;
        setQty(have > 0 ? String(have) : '');
        setCellTarget('to');
      } else {
        setTo(String(loc.id));
      }
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: addressStorageError(e).message });
    }
  };

  const reset = () => {
    setProduct(null);
    setWhInfo(null);
    setFrom(UNPLACED);
    setTo('');
    setQty('');
    setScannedCell(null);
    setCellTarget('to');
  };

  const doMove = async ({ force = false } = {}) => {
    if (!product) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await addressStorageApi.moveStock(warehouseId, {
        productId: product.id,
        fromLocationId: from === UNPLACED ? null : Number(from),
        toLocationId: to === UNPLACED || to === '' ? null : Number(to),
        quantity: Number(qty),
        force,
      });
      playEventSound(SOUND_EVENTS.scan_ok);
      setMessage({
        ok: true,
        text: `${product.sku}: ${r.quantity} шт ${r.from || 'без адреса'} → ${r.to || 'без адреса'}`,
      });
      reset();
      await Promise.all([reloadLocations(), loadPending(), loadMovements()]);
    } catch (e) {
      const err = addressStorageError(e);
      if (err.code === 'LOCATION_OVER_CAPACITY' && window.confirm(`${err.message}\n\nВсё равно положить?`)) {
        setBusy(false);
        await doMove({ force: true });
        return;
      }
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const placeOne = async (row) => {
    setBusy(true);
    setMessage(null);
    try {
      await addressStorageApi.moveStock(warehouseId, {
        productId: row.productId,
        toAssigned: true,
        quantity: row.unplaced,
        force: true,
      });
      await Promise.all([reloadLocations(), loadPending(), loadMovements()]);
    } catch (e) {
      setMessage({ ok: false, text: addressStorageError(e).message });
    } finally {
      setBusy(false);
    }
  };

  const placeAll = async () => {
    if (!window.confirm('Положить весь остаток «без адреса» в закреплённые ячейки товаров?')) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await addressStorageApi.placeUnplacedToAssigned(warehouseId);
      setMessage({ ok: true, text: `Размещено: ${r.quantity} шт по ${r.products} товарам` });
      await Promise.all([reloadLocations(), loadPending(), loadMovements()]);
    } catch (e) {
      setMessage({ ok: false, text: addressStorageError(e).message });
    } finally {
      setBusy(false);
    }
  };

  const enableTracking = async () => {
    try {
      const saved = await addressStorageApi.saveSettings(warehouseId, { trackQuantities: true });
      onSettingsSaved?.(saved);
      setPendingKind('unplaced');
    } catch (e) {
      setMessage({ ok: false, text: addressStorageError(e).message });
    }
  };

  const cellOption = (l) => (
    <option key={l.id} value={l.id}>
      {l.code}
      {l.capacity != null ? ` (${l.stockQty}/${l.capacity})` : l.stockQty ? ` (${l.stockQty} шт)` : ''}
    </option>
  );

  return (
    <div className="address-moves">
      {!settings.trackQuantities ? (
        <div className="alert alert-info py-2">
          Учёт количества по ячейкам выключен — система знает только закреплённую ячейку товара. Чтобы размещать
          приход и перемещать товар между ячейками, включите учёт.{' '}
          <Button size="small" onClick={enableTracking}>
            Включить учёт количества
          </Button>
        </div>
      ) : (
        <section className="address-moves__form">
          <h4 className="address-settings__title">Перемещение</h4>
          <BarcodeScanField
            id="address-move-scan"
            onScan={handleScan}
            enableGlobalCapture
            placeholder="Сканируйте товар или ячейку"
            hint={
              product
                ? `Следующая отсканированная ячейка — «${cellTarget === 'from' ? 'Откуда' : 'Куда'}»`
                : 'Начните со скана товара или ячейки, откуда берёте'
            }
          />
          {scannedCell && !product ? (
            <div className="address-moves__cell-items">
              В ячейке <code className="address-code">{scannedCell.location.code}</code>:
              {scannedCell.items.length === 0 ? <span className="muted-hint"> пусто</span> : null}
              {scannedCell.items.map((it) => (
                <button
                  key={it.productId}
                  type="button"
                  className="address-chip address-chip--btn"
                  onClick={() =>
                    chooseProduct({ id: it.productId, sku: it.sku, name: it.name }, { fromLocationId: scannedCell.location.id })
                  }
                >
                  {it.sku} · {it.quantity} шт
                </button>
              ))}
            </div>
          ) : null}

          <div className="address-moves__grid">
            <label className="address-generate__row">
              <span>Товар</span>
              {product ? (
                <span>
                  <code>{product.sku}</code> {product.name}{' '}
                  <button type="button" className="btn btn-link btn-sm" onClick={reset}>
                    сменить
                  </button>
                </span>
              ) : (
                <ProductPicker warehouseId={warehouseId} onPick={(p) => chooseProduct(p)} />
              )}
            </label>
            {product && whInfo ? (
              <p className="muted-hint address-moves__summary">
                На складе {whInfo.warehouseQty} шт
                {whInfo.assigned ? (
                  <>
                    {' '}
                    · 📌 <code>{whInfo.assigned.code}</code>
                  </>
                ) : (
                  ' · нет закреплённой ячейки'
                )}
                {whInfo.stocks.map((s) => (
                  <span key={s.location.id}>
                    {' '}
                    · {s.location.code}: {s.quantity}
                  </span>
                ))}
                {whInfo.unplaced ? ` · без адреса: ${whInfo.unplaced}` : ''}
              </p>
            ) : null}
            <label className={`address-generate__row${cellTarget === 'from' ? ' address-moves__target' : ''}`}>
              <span>Откуда</span>
              <span className="address-moves__field">
                <select
                  className="form-select form-select-sm"
                  value={from}
                  disabled={!product}
                  onChange={(e) => setFrom(e.target.value)}
                >
                  <option value={UNPLACED}>Без адреса ({whInfo?.unplaced ?? 0} шт)</option>
                  {(whInfo?.stocks || []).map((s) => (
                    <option key={s.location.id} value={s.location.id}>
                      {s.location.code} ({s.quantity} шт)
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-link btn-sm" disabled={!product} onClick={() => setCellTarget('from')}>
                  скан
                </button>
              </span>
            </label>
            <label className={`address-generate__row${cellTarget === 'to' ? ' address-moves__target' : ''}`}>
              <span>Куда</span>
              <span className="address-moves__field">
                <select className="form-select form-select-sm" value={to} disabled={!product} onChange={(e) => setTo(e.target.value)}>
                  <option value="">— выберите ячейку —</option>
                  {from !== UNPLACED ? <option value={UNPLACED}>Без адреса (снять с ячейки)</option> : null}
                  {whInfo?.assigned ? <optgroup label="Закреплённая">{cellOption(locById.get(whInfo.assigned.id) || whInfo.assigned)}</optgroup> : null}
                  <optgroup label="Все ячейки">{activeLocations.map(cellOption)}</optgroup>
                </select>
                <button type="button" className="btn btn-link btn-sm" disabled={!product} onClick={() => setCellTarget('to')}>
                  скан
                </button>
              </span>
            </label>
            <label className="address-generate__row">
              <span>Количество</span>
              <span className="address-moves__field">
                <input
                  type="number"
                  min={1}
                  max={sourceAvailable || undefined}
                  className="form-control form-control-sm address-settings__num"
                  value={qty}
                  disabled={!product}
                  onChange={(e) => setQty(e.target.value)}
                />
                <span className="muted-hint">доступно {sourceAvailable}</span>
              </span>
            </label>
          </div>
          <div className="address-modal__actions address-modal__actions--start">
            <Button onClick={() => doMove()} disabled={busy || !product || !to || !(Number(qty) > 0)}>
              {busy ? '…' : 'Переместить'}
            </Button>
          </div>
        </section>
      )}

      {message ? (
        <div className={`alert py-2 ${message.ok ? 'alert-success' : 'alert-danger'}`} role="status">
          {message.text}
        </div>
      ) : null}

      <section className="address-moves__pending">
        <div className="address-toolbar">
          <div className="erp-filter-row" style={{ marginBottom: 0 }}>
            {settings.trackQuantities ? (
              <button
                type="button"
                className={`erp-filter-btn${pendingKind === 'unplaced' ? ' erp-filter-btn--active' : ''}`}
                onClick={() => setPendingKind('unplaced')}
              >
                Без адреса
              </button>
            ) : null}
            <button
              type="button"
              className={`erp-filter-btn${pendingKind === 'unassigned' ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setPendingKind('unassigned')}
            >
              Нет закреплённой ячейки
            </button>
          </div>
          <span className="muted-hint">{pending.length >= 500 ? '500+' : pending.length} товаров</span>
          <div className="address-toolbar__spacer" />
          {pendingKind === 'unplaced' && pending.some((p) => p.assignedLocationId) ? (
            <Button size="small" onClick={placeAll} disabled={busy}>
              Разместить всё в закреплённые ячейки
            </Button>
          ) : null}
        </div>
        <div className="table-responsive">
          <table className="table table-sm address-table">
            <thead>
              <tr>
                <th>Артикул</th>
                <th>Товар</th>
                <th className="text-end">На складе</th>
                {pendingKind === 'unplaced' ? <th className="text-end">Без адреса</th> : null}
                <th>Закреплённая ячейка</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    {pendingKind === 'unplaced' ? 'Весь остаток размещён по ячейкам' : 'У всех товаров с остатком есть ячейка'}
                  </td>
                </tr>
              ) : (
                pending.map((row) => (
                  <tr key={row.productId}>
                    <td>
                      <code>{row.sku}</code>
                    </td>
                    <td>{row.name}</td>
                    <td className="text-end">{row.warehouseQty}</td>
                    {pendingKind === 'unplaced' ? <td className="text-end fw-bold">{row.unplaced}</td> : null}
                    <td>{row.assignedLocationCode ? <code className="address-code">{row.assignedLocationCode}</code> : '—'}</td>
                    <td className="text-nowrap">
                      {pendingKind === 'unplaced' && row.assignedLocationId ? (
                        <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => placeOne(row)}>
                          в закреплённую
                        </button>
                      ) : null}
                      {settings.trackQuantities ? (
                        <button
                          type="button"
                          className="btn btn-link btn-sm p-0 ms-2"
                          onClick={() => chooseProduct({ id: row.productId, sku: row.sku, name: row.name })}
                        >
                          разместить…
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {settings.trackQuantities ? (
        <section>
          <h4 className="address-settings__title">Журнал перемещений</h4>
          <div className="table-responsive">
            <table className="table table-sm address-table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Товар</th>
                  <th>Откуда</th>
                  <th>Куда</th>
                  <th className="text-end">Шт</th>
                  <th>Кто</th>
                </tr>
              </thead>
              <tbody>
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      Пока нет перемещений
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id}>
                      <td className="text-nowrap">{fmtDate(m.createdAt)}</td>
                      <td>
                        <code>{m.productSku}</code> <span className="muted-hint">{m.productName}</span>
                      </td>
                      <td>{m.fromCode ? <code className="address-code">{m.fromCode}</code> : <span className="muted-hint">без адреса</span>}</td>
                      <td>
                        {m.toCode ? (
                          <code className="address-code">{m.toCode}</code>
                        ) : (
                          <span className="muted-hint">{m.kind === 'auto_out' ? 'отгрузка / списание' : 'без адреса'}</span>
                        )}
                      </td>
                      <td className="text-end">{m.quantity}</td>
                      <td>{m.userName || (m.kind === 'auto_out' ? 'система' : '—')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

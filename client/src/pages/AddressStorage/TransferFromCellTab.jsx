/**
 * Документ перемещения (ПМ) со скана ячеек-источников:
 * ячейка → (если несколько товаров — выбор) → кол-во сканом товара или вручную →
 * следующая ячейка/товар → … → один ПМ. Каждая строка снимается со своей ячейки.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { receiptsApi } from '../../services/receipts.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';

function lineKey(productId, fromLocationId) {
  return `${productId}:${fromLocationId || ''}`;
}

export function TransferFromCellTab({ warehouseId, warehouse, warehouses, settings }) {
  const [cell, setCell] = useState(null); // { location, items } — текущая ячейка для скана
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [lines, setLines] = useState([]); // { productId, sku, name, quantity, maxQty, fromLocationId, fromLocationCode }
  const [draftQty, setDraftQty] = useState({}); // `${productId}` -> string (для текущей ячейки)
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const destWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) =>
          Number(w.id) !== Number(warehouseId) &&
          Number(w.organizationId) === Number(warehouse?.organizationId)
      ),
    [warehouses, warehouseId, warehouse?.organizationId]
  );

  useEffect(() => {
    setCell(null);
    setToWarehouseId('');
    setLines([]);
    setDraftQty({});
    setMessage(null);
  }, [warehouseId]);

  useEffect(() => {
    if (!toWarehouseId && destWarehouses.length === 1) {
      setToWarehouseId(String(destWarehouses[0].id));
    }
  }, [toWarehouseId, destWarehouses]);

  const resetAll = () => {
    setCell(null);
    setLines([]);
    setDraftQty({});
    setMessage(null);
  };

  const qtyInCart = useCallback(
    (productId, fromLocationId) => {
      const locId = fromLocationId ?? cell?.location?.id;
      return (
        lines.find(
          (l) =>
            Number(l.productId) === Number(productId) &&
            Number(l.fromLocationId) === Number(locId)
        )?.quantity || 0
      );
    },
    [lines, cell]
  );

  const putLine = useCallback(
    (item, quantity, loc) => {
      const location = loc || cell?.location;
      if (!location?.id) {
        setMessage({ ok: false, text: 'Сначала отсканируйте ячейку' });
        return false;
      }
      const qty = Math.floor(Number(quantity) || 0);
      if (qty < 1) {
        setMessage({ ok: false, text: 'Укажите количество больше 0' });
        return false;
      }
      const maxInCell = Math.max(0, Number(item.quantity) || 0);
      if (qty > maxInCell) {
        setMessage({ ok: false, text: `В ячейке только ${maxInCell} шт «${item.sku}»` });
        return false;
      }
      const fromLocationId = Number(location.id);
      const fromLocationCode = String(location.code || '').trim();
      setMessage(null);
      setLines((prev) => {
        const rest = prev.filter(
          (l) =>
            !(
              Number(l.productId) === Number(item.productId) &&
              Number(l.fromLocationId) === fromLocationId
            )
        );
        return [
          ...rest,
          {
            productId: item.productId,
            sku: item.sku,
            name: item.name,
            quantity: qty,
            maxQty: maxInCell || qty,
            fromLocationId,
            fromLocationCode,
          },
        ];
      });
      setDraftQty((d) => ({ ...d, [item.productId]: String(qty) }));
      return true;
    },
    [cell]
  );

  const removeLine = (productId, fromLocationId) => {
    setLines((prev) =>
      prev.filter(
        (l) =>
          !(
            Number(l.productId) === Number(productId) &&
            Number(l.fromLocationId) === Number(fromLocationId)
          )
      )
    );
  };

  const handleScan = async (code) => {
    setMessage(null);
    try {
      const r = await addressStorageApi.resolveScan(warehouseId, code);
      if (r?.type === 'location' || r?.location) {
        playEventSound(SOUND_EVENTS.scan_ok);
        const items = (r.items || []).filter((it) => it?.productId && Number(it.quantity) > 0);
        const loc = r.location;
        setCell({ location: loc, items });
        const drafts = {};
        for (const it of items) drafts[it.productId] = String(it.quantity);
        setDraftQty(drafts);
        if (items.length === 0) {
          setMessage({ ok: false, text: `Ячейка ${loc?.code || code} пуста — нечего перемещать` });
          return;
        }
        if (items.length === 1) {
          putLine(items[0], items[0].quantity, loc);
          setMessage({
            ok: true,
            text: `Ячейка ${loc.code}: ${items[0].sku} — ${items[0].quantity} шт. Сканируйте товар (+1) или правьте количество, затем следующую ячейку.`,
          });
        } else {
          setMessage({
            ok: true,
            text: `Ячейка ${loc.code}: несколько товаров — выберите нужный`,
          });
        }
        return;
      }
      if ((r?.type === 'product' || r?.product) && cell) {
        const item = (cell.items || []).find((it) => Number(it.productId) === Number(r.product.id));
        if (!item) {
          playEventSound(SOUND_EVENTS.scan_error);
          setMessage({ ok: false, text: 'Этого товара нет в текущей ячейке' });
          return;
        }
        const maxInCell = Number(item.quantity) || 0;
        const next = qtyInCart(item.productId, cell.location.id) + 1;
        if (next > maxInCell) {
          playEventSound(SOUND_EVENTS.scan_error);
          setMessage({ ok: false, text: `В ячейке только ${maxInCell} шт` });
          return;
        }
        playEventSound(SOUND_EVENTS.scan_ok);
        putLine(item, next, cell.location);
        setMessage({
          ok: true,
          text: `${item.sku}: ${next} шт из ${cell.location.code}`,
        });
        return;
      }
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: 'Сначала отсканируйте ячейку, откуда берёте товар' });
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: addressStorageError(e).message });
    }
  };

  const submit = async () => {
    if (!toWarehouseId) {
      setMessage({ ok: false, text: 'Выберите склад назначения' });
      return;
    }
    if (!lines.length) {
      setMessage({ ok: false, text: 'Добавьте хотя бы один товар (скан ячейки)' });
      return;
    }
    const orgId = warehouse?.organizationId;
    if (!orgId) {
      setMessage({ ok: false, text: 'У склада не указана организация' });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const res = await receiptsApi.create({
        documentType: 'transfer',
        organizationId: orgId,
        warehouseId: Number(warehouseId),
        toWarehouseId: Number(toWarehouseId),
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          fromLocationId: Number(l.fromLocationId),
        })),
      });
      const receipt = res?.data?.receipt || res?.receipt;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const count = lines.length;
      const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
      playEventSound(SOUND_EVENTS.scan_ok);
      setMessage({
        ok: true,
        text: `Создано перемещение ${num}: ${count} поз. / ${totalQty} шт`,
      });
      setLines([]);
      setCell(null);
      setDraftQty({});
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: getApiErrorMessage(e, addressStorageError(e).message) });
    } finally {
      setBusy(false);
    }
  };

  if (!settings?.trackQuantities) {
    return (
      <div className="alert alert-info py-2">
        Чтобы снимать товар с ячейки при перемещении между складами, включите учёт количества по ячейкам.
      </div>
    );
  }

  if (!destWarehouses.length) {
    return (
      <div className="alert alert-info py-2">
        Нет другого склада той же организации — документ перемещения недоступен.
      </div>
    );
  }

  const destName = destWarehouses.find((w) => String(w.id) === String(toWarehouseId))?.name;

  return (
    <div className="address-moves address-transfer-out">
      <h4 className="address-settings__title">Документ перемещения (ПМ)</h4>
      <p className="muted-hint" style={{ marginBottom: 12 }}>
        Склад-источник: <strong>{warehouse?.name}</strong>. Скан ячейки → товар (если в ячейке несколько —
        выберите) → количество сканом ШК товара (+1) или вручную → следующая ячейка. В конце — один
        документ перемещения.
      </p>

      <BarcodeScanField
        id="address-transfer-from-scan"
        onScan={handleScan}
        enableGlobalCapture
        disabled={busy}
        placeholder={cell ? 'Товар из ячейки (+1) или следующая ячейка' : 'Сканируйте ячейку откуда'}
        hint={
          cell
            ? `Текущая ячейка ${cell.location.code}: товар (+1) или другая ячейка`
            : 'Сначала штрихкод ячейки'
        }
      />

      <div className="address-moves__grid" style={{ marginTop: 12 }}>
        <label className="address-generate__row">
          <span>Склад куда</span>
          <select
            className="form-select form-select-sm"
            value={toWarehouseId}
            disabled={busy}
            onChange={(e) => setToWarehouseId(e.target.value)}
          >
            <option value="">— Выберите —</option>
            {destWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {cell ? (
        <div className="address-moves__cell-items" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>
              Текущая ячейка <code className="address-code">{cell.location.code}</code>
              {(cell.items || []).length === 0 ? <span className="muted-hint"> — пусто</span> : null}
            </span>
            <button
              type="button"
              className="btn btn-link btn-sm"
              disabled={busy}
              onClick={() => {
                setCell(null);
                setDraftQty({});
              }}
            >
              сбросить ячейку
            </button>
          </div>
          {(cell.items || []).length > 1 ? (
            <p className="muted-hint" style={{ marginTop: 8 }}>
              В ячейке несколько товаров — выберите нужный
            </p>
          ) : null}
          {(cell.items || []).map((it) => {
            const inDoc = qtyInCart(it.productId, cell.location.id);
            return (
              <div key={it.productId} className="address-generate__row" style={{ marginTop: 8 }}>
                <span>
                  <code>{it.sku}</code> {it.name}
                  <span className="muted-hint">
                    {' '}
                    · в ячейке {it.quantity}
                    {inDoc ? ` · в документе ${inDoc}` : ''}
                  </span>
                </span>
                <span className="address-moves__field">
                  <input
                    className="form-control form-control-sm"
                    type="number"
                    min={1}
                    max={it.quantity}
                    style={{ width: 80 }}
                    disabled={busy}
                    value={draftQty[it.productId] ?? String(inDoc || it.quantity)}
                    onChange={(e) => setDraftQty((d) => ({ ...d, [it.productId]: e.target.value }))}
                  />
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      playEventSound(SOUND_EVENTS.scan_ok);
                      putLine(it, draftQty[it.productId] ?? (inDoc || it.quantity), cell.location);
                    }}
                  >
                    {inDoc ? 'Обновить' : 'В документ'}
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {lines.length ? (
        <section style={{ marginTop: 16 }}>
          <h5 className="address-settings__title">В документе ({lines.length})</h5>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {lines.map((l) => (
              <li key={lineKey(l.productId, l.fromLocationId)} style={{ marginBottom: 6 }}>
                <code className="address-code">{l.fromLocationCode || '—'}</code>
                {' → '}
                <code>{l.sku}</code> {l.name} — <strong>{l.quantity}</strong> шт{' '}
                <button
                  type="button"
                  className="btn btn-link btn-sm"
                  disabled={busy}
                  onClick={() => removeLine(l.productId, l.fromLocationId)}
                >
                  убрать
                </button>
              </li>
            ))}
          </ul>
          <p className="muted-hint">
            {warehouse?.name} → {destName || '…'}
          </p>
        </section>
      ) : null}

      {message ? (
        <p className={message.ok ? 'warehouse-ops-msg success' : 'warehouse-ops-msg error'} role="status">
          {message.text}
        </p>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button disabled={busy || !lines.length || !toWarehouseId} onClick={submit}>
          {busy ? 'Оформляю…' : 'Создать документ перемещения'}
        </Button>
        {lines.length || cell ? (
          <Button variant="secondary" disabled={busy} onClick={resetAll}>
            Сбросить
          </Button>
        ) : null}
      </div>
    </div>
  );
}

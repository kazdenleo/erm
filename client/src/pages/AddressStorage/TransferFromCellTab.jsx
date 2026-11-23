/**
 * Документ перемещения (ПМ) со скана ячейки-источника:
 * ячейка → выбор товаров и количеств → склад «куда» → один ПМ на несколько позиций.
 * Товар снимается с отсканированной ячейки (fromLocationId).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { receiptsApi } from '../../services/receipts.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';

export function TransferFromCellTab({ warehouseId, warehouse, warehouses, settings }) {
  const [cell, setCell] = useState(null); // { location, items }
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [lines, setLines] = useState([]); // { productId, sku, name, quantity, maxQty }
  const [draftQty, setDraftQty] = useState({}); // productId -> string
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

  const reset = () => {
    setCell(null);
    setLines([]);
    setDraftQty({});
    setMessage(null);
  };

  const qtyInCart = useCallback(
    (productId) => lines.find((l) => Number(l.productId) === Number(productId))?.quantity || 0,
    [lines]
  );

  const availableInCell = useCallback(
    (productId) => {
      const item = (cell?.items || []).find((it) => Number(it.productId) === Number(productId));
      return Math.max(0, (item?.quantity || 0) - qtyInCart(productId));
    },
    [cell, qtyInCart]
  );

  const addOrUpdateLine = (item, quantity) => {
    const qty = Math.floor(Number(quantity) || 0);
    if (qty < 1) {
      setMessage({ ok: false, text: 'Укажите количество больше 0' });
      return;
    }
    const maxInCell =
      (cell?.items || []).find((it) => Number(it.productId) === Number(item.productId))?.quantity || 0;
    if (qty > maxInCell) {
      setMessage({ ok: false, text: `В ячейке только ${maxInCell} шт «${item.sku}»` });
      return;
    }
    setMessage(null);
    // Из ячейки с несколькими товарами — в документ только выбранная позиция.
    setLines([
      {
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        quantity: qty,
        maxQty: maxInCell || qty,
      },
    ]);
    setDraftQty({ [item.productId]: String(qty) });
  };

  const removeLine = (productId) => {
    setLines((prev) => prev.filter((l) => Number(l.productId) !== Number(productId)));
  };

  const handleScan = async (code) => {
    setMessage(null);
    try {
      const r = await addressStorageApi.resolveScan(warehouseId, code);
      if (r?.type === 'location' || r?.location) {
        playEventSound(SOUND_EVENTS.scan_ok);
        const items = r.items || [];
        setCell({ location: r.location, items });
        const drafts = {};
        for (const it of items) drafts[it.productId] = String(it.quantity);
        setDraftQty(drafts);
        if (items.length === 1) {
          const it = items[0];
          setLines([
            {
              productId: it.productId,
              sku: it.sku,
              name: it.name,
              quantity: it.quantity,
              maxQty: it.quantity,
            },
          ]);
        } else {
          setLines([]);
        }
        return;
      }
      if ((r?.type === 'product' || r?.product) && cell) {
        const item = (cell.items || []).find((it) => Number(it.productId) === Number(r.product.id));
        if (!item) {
          playEventSound(SOUND_EVENTS.scan_error);
          setMessage({ ok: false, text: 'Этого товара нет в отсканированной ячейке' });
          return;
        }
        playEventSound(SOUND_EVENTS.scan_ok);
        const left = availableInCell(item.productId);
        if (left < 1) {
          setMessage({ ok: false, text: 'Весь остаток этого товара уже в документе' });
          return;
        }
        addOrUpdateLine(item, qtyInCart(item.productId) + 1);
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
    if (!cell?.location?.id) {
      setMessage({ ok: false, text: 'Отсканируйте ячейку-источник' });
      return;
    }
    if (!toWarehouseId) {
      setMessage({ ok: false, text: 'Выберите склад назначения' });
      return;
    }
    if (!lines.length) {
      setMessage({ ok: false, text: 'Добавьте хотя бы один товар' });
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
          fromLocationId: Number(cell.location.id),
        })),
      });
      const receipt = res?.data?.receipt || res?.receipt;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const count = lines.length;
      const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
      playEventSound(SOUND_EVENTS.scan_ok);
      setMessage({
        ok: true,
        text: `Создано перемещение ${num}: ${count} поз. / ${totalQty} шт из ячейки ${cell.location.code}`,
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
        Склад-источник: <strong>{warehouse?.name}</strong>. Отсканируйте ячейку → если товаров несколько,
        выберите один → укажите склад «куда». Товар снимается с этой ячейки.
      </p>

      <BarcodeScanField
        id="address-transfer-from-scan"
        onScan={handleScan}
        enableGlobalCapture
        disabled={busy}
        placeholder={cell ? 'Сканируйте товар из ячейки или снова ячейку' : 'Сканируйте ячейку откуда'}
        hint={
          cell
            ? `Ячейка ${cell.location.code}: добавьте товары в документ`
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
              Ячейка <code className="address-code">{cell.location.code}</code>
              {(cell.items || []).length === 0 ? <span className="muted-hint"> — пусто</span> : null}
            </span>
            <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={reset}>
              сменить ячейку
            </button>
          </div>
          {(cell.items || []).length > 1 ? (
            <p className="muted-hint" style={{ marginTop: 8 }}>
              В ячейке несколько товаров — выберите один
            </p>
          ) : null}
          {(cell.items || []).map((it) => {
            const inDoc = qtyInCart(it.productId);
            return (
              <div key={it.productId} className="address-generate__row" style={{ marginTop: 8 }}>
                <span>
                  <code>{it.sku}</code> {it.name}
                  <span className="muted-hint">
                    {' '}
                    · в ячейке {it.quantity}
                    {inDoc ? ` · выбран` : ''}
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
                    value={draftQty[it.productId] ?? String(it.quantity)}
                    onChange={(e) => setDraftQty((d) => ({ ...d, [it.productId]: e.target.value }))}
                  />
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => addOrUpdateLine(it, draftQty[it.productId] ?? it.quantity)}
                  >
                    {inDoc ? 'Выбран' : 'Выбрать'}
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
              <li key={l.productId} style={{ marginBottom: 6 }}>
                <code>{l.sku}</code> {l.name} — <strong>{l.quantity}</strong> шт{' '}
                <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={() => removeLine(l.productId)}>
                  убрать
                </button>
              </li>
            ))}
          </ul>
          <p className="muted-hint">
            {warehouse?.name} / {cell?.location?.code} → {destName || '…'}
          </p>
        </section>
      ) : null}

      {message ? (
        <p className={message.ok ? 'warehouse-ops-msg success' : 'warehouse-ops-msg error'} role="status">
          {message.text}
        </p>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button disabled={busy || !lines.length || !toWarehouseId || !cell} onClick={submit}>
          {busy ? 'Оформляю…' : 'Создать документ перемещения'}
        </Button>
        {lines.length || cell ? (
          <Button variant="secondary" disabled={busy} onClick={reset}>
            Сбросить
          </Button>
        ) : null}
      </div>
    </div>
  );
}

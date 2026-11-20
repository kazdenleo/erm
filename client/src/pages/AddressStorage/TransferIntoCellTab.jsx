/**
 * Межскладское перемещение в ячейку текущего склада: скан/выбор ячейки и товара,
 * склад-источник + количество → документ ПМ с размещением в ячейку.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { receiptsApi } from '../../services/receipts.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { ProductPicker } from './ProductPicker';

export function TransferIntoCellTab({ warehouseId, warehouse, warehouses, locations, settings }) {
  const [toLocationId, setToLocationId] = useState('');
  const [product, setProduct] = useState(null);
  const [productInfo, setProductInfo] = useState(null);
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [qty, setQty] = useState('1');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scanTarget, setScanTarget] = useState('cell'); // cell | product

  const activeLocations = useMemo(() => (locations || []).filter((l) => l.isActive), [locations]);
  const sourceWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) =>
          Number(w.id) !== Number(warehouseId) &&
          Number(w.organizationId) === Number(warehouse?.organizationId)
      ),
    [warehouses, warehouseId, warehouse?.organizationId]
  );

  const sourceWhInfo = useMemo(() => {
    if (!productInfo || !fromWarehouseId) return null;
    return (productInfo.warehouses || []).find((w) => String(w.warehouseId) === String(fromWarehouseId)) || null;
  }, [productInfo, fromWarehouseId]);

  const sourceAvailable = sourceWhInfo?.warehouseQty ?? 0;

  useEffect(() => {
    setToLocationId('');
    setProduct(null);
    setProductInfo(null);
    setFromWarehouseId('');
    setQty('1');
    setMessage(null);
    setScanTarget('cell');
  }, [warehouseId]);

  useEffect(() => {
    if (!fromWarehouseId && sourceWarehouses.length === 1) {
      setFromWarehouseId(String(sourceWarehouses[0].id));
    }
  }, [fromWarehouseId, sourceWarehouses]);

  const loadProduct = useCallback(async (p) => {
    setProduct(p);
    setMessage(null);
    try {
      const info = await addressStorageApi.productLocations(p.id);
      setProductInfo(info);
      const others = (info?.warehouses || []).filter((w) => Number(w.warehouseId) !== Number(warehouseId));
      const withStock = others.find((w) => (w.warehouseQty || 0) > 0);
      if (withStock) {
        setFromWarehouseId(String(withStock.warehouseId));
        setQty(String(Math.min(withStock.warehouseQty, Math.max(1, Number(qty) || 1))));
      }
    } catch {
      setProductInfo(null);
    }
  }, [warehouseId, qty]);

  const handleScan = async (code) => {
    setMessage(null);
    try {
      const r = await addressStorageApi.resolveScan(warehouseId, code);
      if (r.type === 'location' || r.location) {
        const loc = r.location;
        playEventSound(SOUND_EVENTS.scan_ok);
        setToLocationId(String(loc.id));
        setScanTarget('product');
        if (!product && Array.isArray(r.items) && r.items.length === 1) {
          await loadProduct({ id: r.items[0].productId, sku: r.items[0].sku, name: r.items[0].name });
        }
        return;
      }
      if (r.type === 'product' || r.product) {
        playEventSound(SOUND_EVENTS.scan_ok);
        await loadProduct({ id: r.product.id, sku: r.product.sku, name: r.product.name });
        setScanTarget('cell');
        return;
      }
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: 'Не распознано: отсканируйте ячейку или товар' });
    } catch (e) {
      playEventSound(SOUND_EVENTS.scan_error);
      setMessage({ ok: false, text: addressStorageError(e).message });
    }
  };

  const submit = async () => {
    if (!toLocationId) {
      setMessage({ ok: false, text: 'Укажите ячейку назначения' });
      return;
    }
    if (!product?.id) {
      setMessage({ ok: false, text: 'Укажите товар' });
      return;
    }
    if (!fromWarehouseId) {
      setMessage({ ok: false, text: 'Укажите склад-источник' });
      return;
    }
    const quantity = Math.floor(Number(qty) || 0);
    if (quantity < 1) {
      setMessage({ ok: false, text: 'Количество должно быть больше 0' });
      return;
    }
    if (quantity > sourceAvailable) {
      setMessage({
        ok: false,
        text: `На складе-источнике только ${sourceAvailable} шт`,
      });
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
        warehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(warehouseId),
        lines: [
          {
            productId: product.id,
            quantity,
            toLocationId: Number(toLocationId),
          },
        ],
      });
      const receipt = res?.data?.receipt || res?.receipt;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const placed = (res?.data?.placements || res?.placements || [])[0];
      playEventSound(SOUND_EVENTS.scan_ok);
      setMessage({
        ok: true,
        text: `Создано перемещение ${num || ''}: ${quantity} шт → ячейка${
          placed?.code ? ` ${placed.code}` : ''
        }`.trim(),
      });
      setProduct(null);
      setProductInfo(null);
      setQty('1');
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
        Чтобы принимать перемещения сразу в ячейку, включите учёт количества по ячейкам в настройках склада.
      </div>
    );
  }

  if (!sourceWarehouses.length) {
    return (
      <div className="alert alert-info py-2">
        Нет другого склада той же организации — межскладское перемещение недоступно.
      </div>
    );
  }

  const toLoc = activeLocations.find((l) => String(l.id) === String(toLocationId));

  return (
    <div className="address-moves address-transfer-in">
      <h4 className="address-settings__title">С другого склада в ячейку</h4>
      <p className="muted-hint" style={{ marginBottom: 12 }}>
        Склад назначения: <strong>{warehouse?.name}</strong>. Отсканируйте или выберите ячейку, товар и склад,
        откуда берёте — создаётся документ перемещения (ПМ), товар сразу ложится в ячейку.
      </p>

      <BarcodeScanField
        id="address-transfer-scan"
        onScan={handleScan}
        enableGlobalCapture
        disabled={busy}
        placeholder={
          scanTarget === 'cell' ? 'Сканируйте ячейку назначения' : 'Сканируйте товар (или снова ячейку)'
        }
        hint={
          scanTarget === 'cell'
            ? 'Сначала ячейка «куда», затем товар'
            : 'Можно отсканировать товар или выбрать ниже'
        }
      />

      <div className="address-moves__grid" style={{ marginTop: 12 }}>
        <label className="address-generate__row">
          <span>Ячейка куда</span>
          <select
            className="form-select form-select-sm"
            value={toLocationId}
            disabled={busy}
            onChange={(e) => {
              setToLocationId(e.target.value);
              setScanTarget('product');
            }}
          >
            <option value="">— Выберите или отсканируйте —</option>
            {activeLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code}
                {l.capacity != null ? ` (${l.stockQty}/${l.capacity})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="address-generate__row">
          <span>Товар</span>
          {product ? (
            <span>
              <code>{product.sku}</code> {product.name}{' '}
              <button
                type="button"
                className="btn btn-link btn-sm"
                disabled={busy}
                onClick={() => {
                  setProduct(null);
                  setProductInfo(null);
                }}
              >
                сменить
              </button>
            </span>
          ) : (
            <ProductPicker warehouseId={warehouseId} onPick={(p) => loadProduct(p)} />
          )}
        </label>

        <label className="address-generate__row">
          <span>Склад откуда</span>
          <select
            className="form-select form-select-sm"
            value={fromWarehouseId}
            disabled={busy}
            onChange={(e) => setFromWarehouseId(e.target.value)}
          >
            <option value="">— Выберите —</option>
            {sourceWarehouses.map((w) => {
              const stock =
                productInfo?.warehouses?.find((x) => Number(x.warehouseId) === Number(w.id))
                  ?.warehouseQty ?? null;
              return (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {stock != null ? ` (${stock} шт)` : ''}
                </option>
              );
            })}
          </select>
        </label>

        <label className="address-generate__row">
          <span>Количество</span>
          <input
            className="form-control form-control-sm"
            type="number"
            min={1}
            max={sourceAvailable || undefined}
            value={qty}
            disabled={busy}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
      </div>

      {product && fromWarehouseId ? (
        <p className="muted-hint">
          Доступно на складе-источнике: <strong>{sourceAvailable}</strong> шт
          {toLoc ? (
            <>
              {' '}
              · куда: <code className="address-code">{toLoc.code}</code>
            </>
          ) : null}
        </p>
      ) : null}

      {message ? (
        <p className={message.ok ? 'warehouse-ops-msg success' : 'warehouse-ops-msg error'} role="status">
          {message.text}
        </p>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Button
          disabled={
            busy || !toLocationId || !product || !fromWarehouseId || Math.floor(Number(qty) || 0) < 1
          }
          onClick={submit}
        >
          {busy ? 'Оформляю…' : 'Оформить перемещение в ячейку'}
        </Button>
      </div>
    </div>
  );
}

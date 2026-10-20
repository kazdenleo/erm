/**
 * Печать этикетки ШК упаковки по скану товара (или самого ШК коробки).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../services/api';
import { productsApi } from '../../services/products.api';
import { FastScanInput } from '../../components/common/FastScanInput/FastScanInput';
import { Button } from '../../components/common/Button/Button';
import { printPackagingBarcodeLabel } from '../../hooks/useProductLabelPrint.js';
import {
  boxPackagingsFromProduct,
  matchBoxPackaging,
} from '../../utils/productBoxPackagings.js';
import { clearScanField } from '../../utils/scanInput';
import './PackagingLabelScanPrint.css';

function productTitle(p) {
  if (!p) return '';
  const name = String(p.name || '').trim();
  const sku = String(p.sku || '').trim();
  if (name && sku) return `${name} · ${sku}`;
  return name || sku || `Товар #${p.id}`;
}

export function PackagingLabelScanPrint() {
  const scanRef = useRef(null);
  const busyRef = useRef(false);
  const [printHelperUrl, setPrintHelperUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [lastProduct, setLastProduct] = useState(null);
  const [packagings, setPackagings] = useState([]);
  const [lastPrinted, setLastPrinted] = useState(null);
  const [copies, setCopies] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/config');
        const url = (res?.data?.data?.printHelperUrl ?? res?.data?.printHelperUrl ?? '').trim();
        if (!cancelled) setPrintHelperUrl(url || 'http://127.0.0.1:9100');
      } catch {
        if (!cancelled) setPrintHelperUrl('http://127.0.0.1:9100');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const focusScan = useCallback(() => {
    window.setTimeout(() => {
      const el = scanRef.current;
      if (el && !el.disabled) {
        el.focus();
        clearScanField(el);
      }
    }, 40);
  }, []);

  useEffect(() => {
    focusScan();
  }, [focusScan]);

  const printPack = useCallback(
    async (product, pack, copiesCount = 1) => {
      const id = product?.id;
      const code = String(pack?.barcode || '').trim();
      if (!id || !code) {
        return { ok: false, message: 'Нет ШК упаковки для печати' };
      }
      const n = Math.max(1, Math.min(20, Math.floor(Number(copiesCount) || 1)));
      let last = { ok: true };
      let i = 0;
      while (i < n) {
        last = await printPackagingBarcodeLabel(
          printHelperUrl,
          id,
          code,
          pack.units_per_box
        );
        if (!last.ok) break;
        i += 1;
      }
      return last;
    },
    [printHelperUrl]
  );

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const product = await productsApi.getByBarcode(code);
        if (!product?.id) {
          setMessage({ kind: 'error', text: 'Товар не найден' });
          setLastProduct(null);
          setPackagings([]);
          return;
        }
        const packs = boxPackagingsFromProduct(product);
        setLastProduct(product);
        setPackagings(packs);
        if (!packs.length) {
          setMessage({
            kind: 'error',
            text: 'У товара нет ШК упаковки — задайте его в карточке товара',
          });
          setLastPrinted(null);
          return;
        }
        const matched = matchBoxPackaging(packs, code);
        const pack = matched || packs[0];
        const out = await printPack(product, pack, copies);
        if (!out.ok) {
          setMessage({ kind: 'error', text: out.message || 'Не удалось напечатать' });
          return;
        }
        setLastPrinted(pack);
        setMessage({
          kind: 'success',
          text: matched
            ? `Напечатан ШК упаковки ${pack.barcode} (${pack.units_per_box} шт в коробке)`
            : packs.length > 1
              ? `Напечатан ШК упаковки ${pack.barcode}. У товара несколько упаковок — можно выбрать другую ниже`
              : `Напечатан ШК упаковки ${pack.barcode} (${pack.units_per_box} шт в коробке)`,
        });
      } catch (e) {
        setMessage({
          kind: 'error',
          text: e?.response?.data?.message || e?.message || 'Ошибка поиска / печати',
        });
        setLastProduct(null);
        setPackagings([]);
        setLastPrinted(null);
      } finally {
        busyRef.current = false;
        setBusy(false);
        focusScan();
      }
    },
    [copies, focusScan, printPack]
  );

  const reprint = async (pack) => {
    if (!lastProduct || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const out = await printPack(lastProduct, pack, copies);
      if (!out.ok) {
        setMessage({ kind: 'error', text: out.message || 'Не удалось напечатать' });
        return;
      }
      setLastPrinted(pack);
      setMessage({
        kind: 'success',
        text: `Напечатан ШК упаковки ${pack.barcode} (${pack.units_per_box} шт в коробке)`,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  };

  return (
    <div className="packaging-label-scan">
      <p className="subtitle">
        Отсканируйте штрихкод или артикул товара — на принтер уйдёт этикетка с ШК упаковки (коробки).
        Если отсканировать сам ШК коробки — напечатается именно он. Нужен Print Helper.
      </p>

      <div className="packaging-label-scan__row">
        <label className="packaging-label-scan__copies" htmlFor="packaging-label-copies">
          Копий за скан
          <input
            id="packaging-label-copies"
            type="number"
            min={1}
            max={20}
            value={copies}
            disabled={busy}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value) || 1);
              setCopies(Math.max(1, Math.min(20, n)));
            }}
          />
        </label>
      </div>

      <div className="packaging-label-scan__scan">
        <FastScanInput
          inputRef={scanRef}
          onScan={handleScan}
          disabled={busy}
          autoFocus
          placeholder="Сканируйте товар или ШК упаковки"
          className="warehouse-ops-scan-input packaging-label-scan__input"
        />
        {busy ? <span className="packaging-label-scan__busy">Печать…</span> : null}
      </div>

      {message ? (
        <p
          className={
            message.kind === 'success'
              ? 'packaging-label-scan__msg packaging-label-scan__msg--ok'
              : 'packaging-label-scan__msg packaging-label-scan__msg--err'
          }
          role="status"
        >
          {message.text}
        </p>
      ) : null}

      {lastProduct ? (
        <div className="packaging-label-scan__card">
          <div className="packaging-label-scan__product">{productTitle(lastProduct)}</div>
          {packagings.length ? (
            <ul className="packaging-label-scan__packs">
              {packagings.map((pack) => {
                const active = lastPrinted?.barcode === pack.barcode;
                return (
                  <li key={pack.barcode}>
                    <Button
                      type="button"
                      size="small"
                      variant={active ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() => reprint(pack)}
                    >
                      {pack.barcode}
                      {pack.units_per_box > 0 ? ` · ${pack.units_per_box} шт` : ''}
                      {active ? ' ✓' : ''}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted">Нет ШК упаковки</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

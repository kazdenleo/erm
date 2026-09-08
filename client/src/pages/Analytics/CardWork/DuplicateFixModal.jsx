/**
 * Одна форма на группу дублей: совпавшие поля у всех карточек группы.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../../components/common/Modal/Modal';
import { Button } from '../../../components/common/Button/Button';
import { productsApi } from '../../../services/products.api';
import { MP_IDENTITY_LINK_META } from '../../../utils/productMpFieldLinks.js';
import { productCardPath } from '../../../utils/productCardPath.js';

const FIELD_BY_LABEL = {
  'Артикул ERP': { key: 'sku', kind: 'sku' },
  'Артикул продавца Ozon': { key: 'sku_ozon', kind: 'seller', marketplace: 'ozon' },
  'Артикул продавца WB': { key: 'mp_wb_vendor_code', kind: 'seller', marketplace: 'wb' },
  'Артикул продавца Я.Маркет': { key: 'sku_ym', kind: 'seller', marketplace: 'ym' },
  'Артикул производителя Ozon': { key: 'manufacturerOzon', kind: 'manufacturer', marketplace: 'ozon' },
  'Артикул производителя Я.Маркет': { key: 'manufacturerYm', kind: 'manufacturer', marketplace: 'ym' },
  Штрихкод: { key: 'barcode', kind: 'barcode' },
};

const MP_ID_SPECS = [
  {
    key: 'ozon_product_id',
    kind: 'mp_id',
    marketplace: 'ozon',
    label: 'Ozon product_id',
  },
  { key: 'sku_wb', kind: 'mp_id', marketplace: 'wb', label: 'WB nmId' },
  {
    key: 'ym_market_sku',
    kind: 'mp_id',
    marketplace: 'ym',
    label: 'Я.Маркет product_id',
  },
];

function readMpId(product, key) {
  if (key === 'ozon_product_id') {
    const v = product?.ozon_product_id ?? product?.marketplace_ozon_product_id;
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
  }
  if (key === 'sku_wb') return String(product?.sku_wb || '').trim();
  if (key === 'ym_market_sku') {
    const v = product?.ym_market_sku ?? product?.ym_product_id;
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
  }
  return '';
}

function parseMpNumericId(raw) {
  const digits = String(raw || '').trim().replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unwrapProduct(res) {
  const body = res?.data ?? res;
  return body?.data ?? body?.product ?? body;
}

function barcodesList(product) {
  const raw = Array.isArray(product?.barcodes) ? product.barcodes : [];
  return raw
    .map((b) => {
      if (typeof b === 'string') return { barcode: b.trim(), marketplaces: [] };
      const code = String(b?.barcode || '').trim();
      if (!code) return null;
      return {
        barcode: code,
        marketplaces: Array.isArray(b.marketplaces) ? b.marketplaces : [],
      };
    })
    .filter(Boolean);
}

function readFieldValue(product, meta, barcodeOriginal) {
  if (meta.kind === 'barcode') {
    const want = String(barcodeOriginal || '').trim().toLowerCase();
    const hit = barcodesList(product).find((b) => b.barcode.toLowerCase() === want);
    return hit?.barcode || String(barcodeOriginal || '');
  }
  if (meta.key === 'sku') return String(product?.sku || '');
  if (meta.key === 'sku_ozon') return String(product?.sku_ozon || '');
  if (meta.key === 'mp_wb_vendor_code') return String(product?.mp_wb_vendor_code || '');
  if (meta.key === 'sku_ym') return String(product?.sku_ym || '');
  if (meta.key === 'manufacturerOzon') return String(product?.ozon_draft?.vendorCode || '');
  if (meta.key === 'manufacturerYm') return String(product?.ym_draft?.vendorCode || '');
  if (meta.kind === 'mp_id') return readMpId(product, meta.key);
  return '';
}

/** Список типов полей, которые правим в группе (одинаковые данные). */
function resolveFieldSpecs(group) {
  const specs = [];
  const seen = new Set();
  const push = (spec) => {
    const id = spec.kind === 'barcode' ? `barcode:${spec.barcodeOriginal}` : spec.key;
    if (seen.has(id)) return;
    seen.add(id);
    specs.push(spec);
  };

  for (const mf of group?.matchedFields || []) {
    const meta = FIELD_BY_LABEL[mf.label];
    if (!meta) continue;
    if (meta.kind === 'barcode') {
      push({
        ...meta,
        label: 'Штрихкод',
        barcodeOriginal: String(mf.value || ''),
      });
    } else {
      push({ ...meta, label: mf.label });
    }
  }

  const hadMatched = specs.length > 0;
  for (const spec of MP_ID_SPECS) push({ ...spec });
  if (hadMatched) return specs;

  const kinds = group?.kinds || [];
  const v = String(group?.value || '');
  if (kinds.includes('sku')) push({ ...FIELD_BY_LABEL['Артикул ERP'], label: 'Артикул ERP' });
  if (kinds.includes('seller_sku')) {
    for (const [label, meta] of Object.entries(FIELD_BY_LABEL)) {
      if (meta.kind === 'seller') push({ ...meta, label });
    }
  }
  if (kinds.includes('manufacturer_sku')) {
    for (const [label, meta] of Object.entries(FIELD_BY_LABEL)) {
      if (meta.kind === 'manufacturer') push({ ...meta, label });
    }
  }
  if (kinds.includes('barcode') && v) {
    push({ ...FIELD_BY_LABEL['Штрихкод'], label: 'Штрихкод', barcodeOriginal: v });
  }
  for (const spec of MP_ID_SPECS) push({ ...spec });
  return specs;
}

function fieldRowKey(spec) {
  return spec.kind === 'barcode' ? `barcode:${spec.barcodeOriginal}` : spec.key;
}

function buildUpdates(product, fieldValues) {
  const updates = {};
  let ozonDraft = null;
  let ymDraft = null;
  let nextBarcodes = null;

  for (const f of fieldValues) {
    const next = String(f.value || '').trim();
    const prev = String(f.original || '').trim();
    if (next === prev) continue;

    if (f.key === 'sku') updates.sku = next;
    else if (f.key === 'sku_ozon') updates.sku_ozon = next;
    else if (f.key === 'mp_wb_vendor_code') updates.mp_wb_vendor_code = next;
    else if (f.key === 'sku_ym') updates.sku_ym = next;
    else if (f.key === 'ozon_product_id') {
      updates.marketplace_ozon_product_id = parseMpNumericId(next);
      if (!Object.prototype.hasOwnProperty.call(updates, 'sku_ozon')) {
        updates.sku_ozon = String(product?.sku_ozon || '').trim() || null;
      }
    } else if (f.key === 'sku_wb') {
      updates.sku_wb = next || null;
    } else if (f.key === 'ym_market_sku') {
      updates.marketplace_ym_product_id = parseMpNumericId(next);
      if (!Object.prototype.hasOwnProperty.call(updates, 'sku_ym')) {
        updates.sku_ym = String(product?.sku_ym || '').trim() || null;
      }
    }
    else if (f.key === 'manufacturerOzon') {
      ozonDraft = {
        ...(product.ozon_draft && typeof product.ozon_draft === 'object' ? product.ozon_draft : {}),
        ...(ozonDraft || {}),
        vendorCode: next,
      };
    } else if (f.key === 'manufacturerYm') {
      ymDraft = {
        ...(product.ym_draft && typeof product.ym_draft === 'object' ? product.ym_draft : {}),
        ...(ymDraft || {}),
        vendorCode: next,
      };
    } else if (f.kind === 'barcode') {
      if (!nextBarcodes) nextBarcodes = barcodesList(product);
      const idx = nextBarcodes.findIndex(
        (b) => b.barcode.toLowerCase() === String(f.original || '').trim().toLowerCase()
      );
      if (idx >= 0) {
        if (!next) nextBarcodes.splice(idx, 1);
        else nextBarcodes[idx] = { ...nextBarcodes[idx], barcode: next };
      } else if (next) {
        nextBarcodes.push({ barcode: next, marketplaces: [] });
      }
    }
  }

  if (ozonDraft) updates.ozon_draft = ozonDraft;
  if (ymDraft) updates.ym_draft = ymDraft;
  if (nextBarcodes) updates.barcodes = nextBarcodes;
  return updates;
}

export function DuplicateFixModal({ isOpen, onClose, group, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);

  const fieldSpecs = useMemo(() => resolveFieldSpecs(group), [group]);
  const productIds = useMemo(
    () => (group?.products || []).map((p) => Number(p.productId)).filter((n) => n > 0),
    [group]
  );

  const load = useCallback(async () => {
    if (!productIds.length) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loaded = await Promise.all(
        productIds.map(async (id) => {
          const res = await productsApi.getById(id);
          const product = unwrapProduct(res);
          if (!product?.id) throw new Error(`Карточка #${id} не найдена`);
          const fields = fieldSpecs.map((spec) => {
            const original = readFieldValue(product, spec, spec.barcodeOriginal);
            return {
              key: spec.key,
              rowKey: fieldRowKey(spec),
              label: spec.label,
              kind: spec.kind,
              marketplace: spec.marketplace || null,
              barcodeOriginal: spec.barcodeOriginal || '',
              original,
              value: original,
            };
          });
          return {
            productId: Number(product.id),
            sku: product.sku || '',
            name: product.name || '',
            product,
            fields,
          };
        })
      );
      setRows(loaded);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить карточки');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [productIds, fieldSpecs]);

  useEffect(() => {
    if (!isOpen) return undefined;
    load();
    return undefined;
  }, [isOpen, load]);

  const title = useMemo(() => {
    const v = group?.value || '';
    return v ? `Исправить дубль: ${v}` : 'Исправить дубль';
  }, [group]);

  const setFieldValue = (productId, rowKey, value) => {
    setRows((prev) =>
      prev.map((row) =>
        row.productId !== productId
          ? row
          : {
              ...row,
              fields: row.fields.map((f) => (f.rowKey === rowKey ? { ...f, value } : f)),
            }
      )
    );
  };

  const hasSellerChanges = useMemo(
    () =>
      rows.some((row) =>
        row.fields.some(
          (f) =>
            f.kind === 'seller' &&
            String(f.value || '').trim() !== String(f.original || '').trim()
        )
      ),
    [rows]
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const jobs = [];
      for (const row of rows) {
        const updates = buildUpdates(row.product, row.fields);
        if (!Object.keys(updates).length) continue;
        jobs.push(productsApi.update(row.productId, updates));
      }
      if (jobs.length) await Promise.all(jobs);
      if (typeof onSaved === 'function') await onSaved();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить карточки');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl" scrollable>
      <div className="card-work-fix-modal">
        <p className="card-work-fix-modal__lead">
          Одинаковые поля группы и ID карточек МП (связь). Если у двух товаров один
          product_id / nmId — это одна карточка на маркетплейсе; лишний id очистите.
        </p>

        {error ? <div className="sales-analytics__error">{error}</div> : null}
        {loading ? <p className="sales-analytics__empty">Загрузка карточек…</p> : null}

        {!loading && !rows.length ? (
          <p className="sales-analytics__empty">Нет карточек для правки.</p>
        ) : null}

        {!loading && rows.length > 0 ? (
          <div className="card-work-fix-modal__products">
            {rows.map((row) => (
              <section key={row.productId} className="card-work-fix-modal__product">
                <div className="card-work-fix-modal__product-head">
                  <strong>{row.sku || `#${row.productId}`}</strong>
                  <span>{row.name || 'Без названия'}</span>
                  <Link
                    className="card-work__link"
                    to={productCardPath(row.productId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    открыть
                  </Link>
                </div>
                <div className="card-work-fix-modal__fields">
                  {row.fields.map((f) => (
                    <label key={f.rowKey} className="card-work-fix-modal__field">
                      <span>{f.label}</span>
                      <input
                        type="text"
                        value={f.value}
                        onChange={(e) => setFieldValue(row.productId, f.rowKey, e.target.value)}
                        disabled={saving}
                      />
                      {f.kind === 'seller' &&
                      String(f.value || '').trim() !== String(f.original || '').trim() ? (
                        <span className="card-work-fix-modal__warn">
                          {MP_IDENTITY_LINK_META[f.marketplace]?.warn ||
                            'Если артикула нет на маркетплейсе, может создаться новая карточка.'}
                        </span>
                      ) : null}
                      {f.kind === 'manufacturer' ? (
                        <span className="card-work-fix-modal__hint">
                          Смена не создаёт новую карточку на МП.
                        </span>
                      ) : null}
                      {f.kind === 'mp_id' ? (
                        <span className="card-work-fix-modal__hint">
                          Id связи с кабинетом. Ночной импорт ходит по нему, не по артикулу.
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {hasSellerChanges ? (
          <div className="card-work-fix-modal__warn-block">
            Изменены артикулы продавца — сначала смените их в кабинете МП, иначе при отправке может
            создаться дубль карточки.
          </div>
        ) : null}

        <div className="card-work-fix-modal__actions">
          <Button variant="secondary" size="small" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={handleSave}
            disabled={saving || loading || !rows.length}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

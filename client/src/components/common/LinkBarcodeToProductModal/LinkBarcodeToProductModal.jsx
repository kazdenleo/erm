/**
 * Модалка: неизвестный штрихкод → привязать к существующему товару.
 * Если у товара нет габаритов упаковки — сначала окно с габаритами (упаковка обязательна).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import { ProductSearchInput } from '../ProductSearchInput/ProductSearchInput';
import { productsApi } from '../../../services/products.api';
import { barcodeStringsFromProduct } from '../../../utils/productBarcodes.js';
import { playEventSound, SOUND_EVENTS } from '../../../utils/soundSettings';
import { useAuth } from '../../../context/AuthContext';
import {
  getProfileLengthUnit,
  getProfileWeightUnit,
  lengthDisplayToMm,
  lengthInputStep,
  lengthMmToDisplay,
  lengthUnitLabel,
  weightDisplayToG,
  weightGToDisplay,
  weightInputStep,
  weightUnitLabel,
} from '../../../utils/displayUnits.js';
import './LinkBarcodeToProductModal.css';

function numDim(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Габариты упаковки (length/width/height) уже заданы в карточке. */
export function productHasPackageDimensions(product) {
  if (!product) return false;
  return (
    numDim(product.length) != null &&
    numDim(product.width) != null &&
    numDim(product.height) != null
  );
}

function emptyDimForm() {
  return {
    length: '',
    width: '',
    height: '',
    weight: '',
    product_length: '',
    product_width: '',
    product_height: '',
    product_weight: '',
  };
}

function dimFormFromProduct(product, lengthUnit, weightUnit) {
  if (!product) return emptyDimForm();
  return {
    length: lengthMmToDisplay(product.length, lengthUnit),
    width: lengthMmToDisplay(product.width, lengthUnit),
    height: lengthMmToDisplay(product.height, lengthUnit),
    weight: weightGToDisplay(product.weight, weightUnit),
    product_length: lengthMmToDisplay(
      product.product_length ?? product.productLength,
      lengthUnit
    ),
    product_width: lengthMmToDisplay(
      product.product_width ?? product.productWidth,
      lengthUnit
    ),
    product_height: lengthMmToDisplay(
      product.product_height ?? product.productHeight,
      lengthUnit
    ),
    product_weight: weightGToDisplay(
      product.product_weight ?? product.productWeight,
      weightUnit
    ),
  };
}

/** Собрать payload для PUT /products (мм и г). */
function buildDimensionsPayload(form, lengthUnit, weightUnit) {
  const length = lengthDisplayToMm(form.length, lengthUnit);
  const width = lengthDisplayToMm(form.width, lengthUnit);
  const height = lengthDisplayToMm(form.height, lengthUnit);
  const weight = weightDisplayToG(form.weight, weightUnit);
  const product_length = lengthDisplayToMm(form.product_length, lengthUnit);
  const product_width = lengthDisplayToMm(form.product_width, lengthUnit);
  const product_height = lengthDisplayToMm(form.product_height, lengthUnit);
  const product_weight = weightDisplayToG(form.product_weight, weightUnit);

  const payload = {};
  if (length != null) payload.length = length;
  if (width != null) payload.width = width;
  if (height != null) payload.height = height;
  if (weight != null) payload.weight = weight;
  if (product_length != null) payload.product_length = product_length;
  if (product_width != null) payload.product_width = product_width;
  if (product_height != null) payload.product_height = product_height;
  if (product_weight != null) payload.product_weight = product_weight;

  if (length != null && width != null && height != null) {
    const liters = (length * width * height) / 1_000_000;
    if (liters > 0) payload.volume = Math.round(liters * 1000) / 1000;
  }
  return { payload, length, width, height };
}

function DimField({ id, label, value, onChange, step, disabled }) {
  return (
    <label className="link-barcode-modal__dim-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="warehouse-ops-scan-input link-barcode-modal__dim-input"
      />
    </label>
  );
}

export function LinkBarcodeToProductModal({
  isOpen,
  onClose,
  barcode,
  products = [],
  onLinked,
  title = 'Привязать штрихкод к товару',
}) {
  const { profile } = useAuth();
  const lengthUnit = getProfileLengthUnit(profile);
  const weightUnit = getProfileWeightUnit(profile);
  const L = lengthUnitLabel(lengthUnit);
  const Wt = weightUnitLabel(weightUnit);
  const lengthStep = lengthInputStep(lengthUnit);
  const weightStep = weightInputStep(weightUnit);

  const trimmedBarcode = String(barcode || '').trim();
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dimsOpen, setDimsOpen] = useState(false);
  const [dimForm, setDimForm] = useState(emptyDimForm);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setProductId('');
      setDetail(null);
      setError(null);
      setSaving(false);
      setDetailLoading(false);
      setDimsOpen(false);
      setDimForm(emptyDimForm());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !productId) {
      setDetail(null);
      setDimsOpen(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    productsApi
      .getById(productId)
      .then((wrap) => {
        const p = wrap?.data ?? wrap;
        if (cancelled) return;
        if (p?.id) {
          setDetail(p);
          const needPkg = !productHasPackageDimensions(p);
          setDimForm(dimFormFromProduct(p, lengthUnit, weightUnit));
          setDimsOpen(needPkg);
        } else {
          setDetail(null);
          setDimsOpen(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.response?.data?.message || e.message || 'Не удалось загрузить товар');
          setDimsOpen(false);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, productId, lengthUnit, weightUnit]);

  const needPackageDims = useMemo(
    () => Boolean(detail) && !productHasPackageDimensions(detail),
    [detail]
  );

  const setDimField = (key, value) => {
    setDimForm((prev) => ({ ...prev, [key]: value }));
  };

  const saveDimensionsAndLink = async () => {
    if (!trimmedBarcode || !productId) return;
    const { payload, length, width, height } = buildDimensionsPayload(
      dimForm,
      lengthUnit,
      weightUnit
    );
    if (needPackageDims && (length == null || width == null || height == null)) {
      setError('Укажите длину, ширину и высоту упаковки — без них нельзя привязать штрихкод');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (Object.keys(payload).length > 0) {
        await productsApi.update(productId, payload);
      }
      const updated = await productsApi.appendBarcode(productId, trimmedBarcode);
      playEventSound(SOUND_EVENTS.scan_ok);
      setDimsOpen(false);
      onLinked?.(updated);
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          'Не удалось сохранить (возможно, штрихкод уже у другого товара)'
      );
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setSaving(false);
    }
  };

  const handleLink = async () => {
    if (!trimmedBarcode || !productId) return;
    if (needPackageDims) {
      setDimsOpen(true);
      setError('Сначала укажите габариты упаковки');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await productsApi.appendBarcode(productId, trimmedBarcode);
      playEventSound(SOUND_EVENTS.scan_ok);
      onLinked?.(updated);
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          'Не удалось сохранить (возможно, штрихкод уже у другого товара)'
      );
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setSaving(false);
    }
  };

  const existingBarcodes = barcodeStringsFromProduct(detail?.barcodes);

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title} size="large" closeOnBackdropClick={!saving}>
        <div className="link-barcode-modal">
          <p className="warehouse-ops-hint">
            Код не найден в базе (при приёмке). Укажите товар, к которому относится этикетка — штрихкод
            будет добавлен к карточке; дальше он будет находиться при сканировании везде.
          </p>
          <div className="link-barcode-modal__scanned">
            <span className="link-barcode-modal__label">Отсканировано:</span>
            <code className="link-barcode-modal__code">{trimmedBarcode || '—'}</code>
          </div>

          <label className="link-barcode-modal__label-block">
            Поиск товара (штрихкод, артикул, название)
            <ProductSearchInput
              value={search}
              onChange={setSearch}
              products={products}
              disabled={saving}
              placeholder="Введите для поиска…"
              className="warehouse-ops-scan-input link-barcode-modal__search"
              onSelect={(p) => {
                if (p?.id) setProductId(String(p.id));
                setSearch('');
              }}
            />
          </label>

          {productId ? (
            <p className="warehouse-ops-hint link-barcode-modal__cap-hint">
              Выбран: {detail?.sku || productId}
              {detail?.name ? ` — ${detail.name}` : ''}
              {needPackageDims && !detailLoading ? (
                <span className="link-barcode-modal__dims-needed">
                  {' '}
                  · нет габаритов упаковки — укажите в окне
                </span>
              ) : null}
            </p>
          ) : (
            <p className="warehouse-ops-hint link-barcode-modal__cap-hint">
              Выберите товар из подсказок поиска.
            </p>
          )}

          <div className="link-barcode-modal__existing">
            <span className="link-barcode-modal__label">Штрихкоды у выбранного товара:</span>
            {detailLoading ? (
              <p className="muted">Загрузка…</p>
            ) : productId && existingBarcodes.length === 0 ? (
              <p className="muted">Пока нет привязанных штрихкодов</p>
            ) : productId ? (
              <ul className="link-barcode-modal__barcode-list">
                {existingBarcodes.map((b) => (
                  <li key={b}>
                    <code>{b}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Выберите товар — список появится здесь</p>
            )}
          </div>

          {error && <div className="warehouse-ops-error">{error}</div>}

          <div className="link-barcode-modal__actions">
            {needPackageDims ? (
              <Button
                type="button"
                onClick={() => {
                  setError(null);
                  setDimsOpen(true);
                }}
                disabled={saving || !productId || !trimmedBarcode || detailLoading}
              >
                Указать габариты и привязать
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleLink}
                disabled={saving || !productId || !trimmedBarcode || detailLoading}
              >
                {saving ? 'Сохранение…' : 'Привязать штрихкод'}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Отмена
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isOpen && dimsOpen}
        onClose={() => {
          if (!saving) setDimsOpen(false);
        }}
        title="Габариты товара и упаковки"
        size="large"
        closeOnBackdropClick={!saving}
      >
        <div className="link-barcode-modal link-barcode-modal--dims">
          <p className="warehouse-ops-hint">
            У товара {detail?.sku || productId}
            {detail?.name ? ` «${detail.name}»` : ''} не заполнены габариты упаковки. Укажите их, чтобы
            привязать штрихкод <code>{trimmedBarcode}</code>.
          </p>

          <fieldset className="link-barcode-modal__dim-block" disabled={saving}>
            <legend>
              Упаковка <span className="link-barcode-modal__req">обязательно</span>
            </legend>
            <div className="link-barcode-modal__dim-grid">
              <DimField
                id="link-bc-pkg-l"
                label={`Длина (${L})`}
                value={dimForm.length}
                onChange={(v) => setDimField('length', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-pkg-w"
                label={`Ширина (${L})`}
                value={dimForm.width}
                onChange={(v) => setDimField('width', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-pkg-h"
                label={`Высота (${L})`}
                value={dimForm.height}
                onChange={(v) => setDimField('height', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-pkg-wt"
                label={`Вес с упаковкой (${Wt})`}
                value={dimForm.weight}
                onChange={(v) => setDimField('weight', v)}
                step={weightStep}
                disabled={saving}
              />
            </div>
          </fieldset>

          <fieldset className="link-barcode-modal__dim-block" disabled={saving}>
            <legend>
              Товар без упаковки <span className="muted">необязательно</span>
            </legend>
            <div className="link-barcode-modal__dim-grid">
              <DimField
                id="link-bc-item-l"
                label={`Длина (${L})`}
                value={dimForm.product_length}
                onChange={(v) => setDimField('product_length', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-item-w"
                label={`Ширина (${L})`}
                value={dimForm.product_width}
                onChange={(v) => setDimField('product_width', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-item-h"
                label={`Высота (${L})`}
                value={dimForm.product_height}
                onChange={(v) => setDimField('product_height', v)}
                step={lengthStep}
                disabled={saving}
              />
              <DimField
                id="link-bc-item-wt"
                label={`Вес (${Wt})`}
                value={dimForm.product_weight}
                onChange={(v) => setDimField('product_weight', v)}
                step={weightStep}
                disabled={saving}
              />
            </div>
          </fieldset>

          {error && <div className="warehouse-ops-error">{error}</div>}

          <div className="link-barcode-modal__actions">
            <Button type="button" onClick={saveDimensionsAndLink} disabled={saving || !trimmedBarcode}>
              {saving ? 'Сохранение…' : 'Сохранить и привязать штрихкод'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDimsOpen(false)}
              disabled={saving}
            >
              Назад
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

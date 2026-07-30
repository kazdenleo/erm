import React, { useEffect, useRef, useState } from 'react';
import { resolveMarketplaceVolumeLiters } from '../../utils/productVolume.js';
import {
  formatMoneyInput,
  parseMoneyInput,
  percentFromActualAndBefore,
  priceBeforeFromActualAndPercent,
  getMarketplacePricePack,
} from './marketplacePriceMath.js';

const MP_COLORS = {
  ozon: '#0b91ff',
  wb: '#cb11ab',
  ym: '#c9a000',
};

const MP_BG = {
  ozon: 'rgba(0,91,255,0.06)',
  wb: 'rgba(203,17,171,0.06)',
  ym: 'rgba(255,204,0,0.08)',
};

/**
 * Ячейки МП: мин. FBS / мин. FBO (по флагам); опционально факт. и до скидки + %.
 */
export function MarketplacePriceCells({
  product,
  marketplace,
  minPrice,
  minPriceFbs = null,
  minPriceFbo = null,
  showFbs = true,
  showFbo = false,
  minOnly = false,
  isLoading,
  hasSku,
  skuBadge,
  strategyLocked,
  onOpenMinDetails,
  onOpenMinDetailsFbs,
  onOpenMinDetailsFbo,
  onSave,
  disabled = false,
}) {
  const pack = getMarketplacePricePack(product, marketplace);
  const primaryMin = minPrice != null && !isNaN(Number(minPrice)) ? Number(minPrice) : null;
  const fbsMin =
    minPriceFbs != null && !isNaN(Number(minPriceFbs))
      ? Number(minPriceFbs)
      : showFbs && !showFbo
        ? primaryMin
        : minPriceFbs != null && !isNaN(Number(minPriceFbs))
          ? Number(minPriceFbs)
          : null;
  const fboMin =
    minPriceFbo != null && !isNaN(Number(minPriceFbo))
      ? Number(minPriceFbo)
      : showFbo && !showFbs
        ? primaryMin
        : minPriceFbo != null && !isNaN(Number(minPriceFbo))
          ? Number(minPriceFbo)
          : null;
  const min = primaryMin ?? fbsMin ?? fboMin;

  const initialActual = pack.sellingPrice != null ? pack.sellingPrice : min;
  const [actualStr, setActualStr] = useState(() => formatMoneyInput(initialActual));
  const [beforeStr, setBeforeStr] = useState(() => formatMoneyInput(pack.priceBeforeDiscount));
  const [pctStr, setPctStr] = useState(() => formatMoneyInput(pack.discountPercent));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveTimerRef = useRef(null);
  const productId = product?.id;
  const bg = MP_BG[marketplace];
  const color = MP_COLORS[marketplace] || 'var(--text)';
  const bothSchemes = showFbs && showFbo;

  useEffect(() => {
    const next = getMarketplacePricePack(product, marketplace);
    const nextActual = next.sellingPrice != null ? next.sellingPrice : min;
    setActualStr(formatMoneyInput(nextActual));
    setBeforeStr(formatMoneyInput(next.priceBeforeDiscount));
    setPctStr(formatMoneyInput(next.discountPercent));
  }, [productId, marketplace, pack.sellingPrice, pack.priceBeforeDiscount, pack.discountPercent, min]);

  const scheduleSave = (payload) => {
    if (typeof onSave !== 'function') return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave({ productId, marketplace, ...payload });
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
      } finally {
        setSaving(false);
      }
    }, 550);
  };

  const currentActual = () => {
    const n = parseMoneyInput(actualStr);
    if (n != null && n > 0) return n;
    return min != null && min > 0 ? min : null;
  };

  const onActualChange = (raw) => {
    if (strategyLocked) return;
    setActualStr(raw);
    const actual = parseMoneyInput(raw);
    const pct = parseMoneyInput(pctStr);
    const before = parseMoneyInput(beforeStr);
    let nextBefore = before;
    let nextPct = pct;
    if (actual != null && actual > 0) {
      if (pct != null && pct < 100) {
        nextBefore = priceBeforeFromActualAndPercent(actual, pct);
        if (nextBefore != null) setBeforeStr(formatMoneyInput(nextBefore));
      } else if (before != null && before > 0) {
        nextPct = percentFromActualAndBefore(actual, before);
        if (nextPct != null) setPctStr(formatMoneyInput(nextPct));
      }
    }
    scheduleSave({
      sellingPrice: actual,
      priceBeforeDiscount: nextBefore,
      discountPercent: nextPct,
    });
  };

  const onBeforeChange = (raw) => {
    setBeforeStr(raw);
    const before = parseMoneyInput(raw);
    const actual = currentActual();
    let nextPct = parseMoneyInput(pctStr);
    if (before != null && before > 0 && actual != null) {
      nextPct = percentFromActualAndBefore(actual, before);
      if (nextPct != null) setPctStr(formatMoneyInput(nextPct));
    } else if (raw.trim() === '') {
      nextPct = null;
      setPctStr('');
    }
    scheduleSave({ priceBeforeDiscount: before, discountPercent: nextPct });
  };

  const onPctChange = (raw) => {
    setPctStr(raw);
    const pct = parseMoneyInput(raw);
    const actual = currentActual();
    let nextBefore = parseMoneyInput(beforeStr);
    if (pct != null && pct < 100 && actual != null) {
      nextBefore = priceBeforeFromActualAndPercent(actual, pct);
      if (nextBefore != null) setBeforeStr(formatMoneyInput(nextBefore));
    } else if (raw.trim() === '') {
      nextBefore = null;
      setBeforeStr('');
    }
    scheduleSave({ priceBeforeDiscount: nextBefore, discountPercent: pct });
  };

  const renderEmpty = () => {
    if (isLoading) return <span className="mp-price-muted">...</span>;
    if (min == null && !hasSku) return <span className="mp-price-muted">—</span>;
    return null;
  };

  const volumeLiters = resolveMarketplaceVolumeLiters(product, marketplace);
  const mpNorm = String(marketplace || '').toLowerCase();
  const volumeMissing = volumeLiters == null || !(Number(volumeLiters) > 0);
  const volumeLabel = !volumeMissing
    ? `${Number(volumeLiters).toFixed(2)} л`
    : 'нет габаритов';
  const volumeMissingTitle =
    mpNorm === 'ozon'
      ? 'Нет габаритов упаковки Ozon (атрибуты / вкладка Ozon / связь с Основным)'
      : mpNorm === 'wb' || mpNorm === 'wildberries'
        ? 'Нет габаритов упаковки WB (атрибуты 90849/90745/90846 или wb_draft.dimensions)'
        : mpNorm === 'ym' || mpNorm === 'yandex'
          ? 'Нет габаритов упаковки Яндекс.Маркет (ym_draft.weightDimensions)'
          : 'Нет габаритов маркетплейса';

  const renderVolumeHint = (show) => {
    if (!show || !volumeLabel) return null;
    return (
      <div
        className={`mp-price-volume${volumeMissing ? ' mp-price-volume-missing' : ''}`}
        title={
          volumeMissing
            ? volumeMissingTitle
            : `Объём для расчёта мин. цены (${marketplace})`
        }
      >
        {volumeLabel}
      </div>
    );
  };

  const renderMinBtn = (value, onOpen, label, { showVolume = false } = {}) => {
    if (isLoading) return <span className="mp-price-muted">...</span>;
    if (value != null) {
      return (
        <div className="mp-price-min-wrap">
          <button
            type="button"
            className="mp-price-cell-min-btn"
            style={{ color }}
            onClick={onOpen}
            title={label ? `Детали расчёта мин. цены ${label}` : 'Детали расчёта минимальной цены'}
          >
            {value} ₽
          </button>
          {renderVolumeHint(showVolume)}
        </div>
      );
    }
    if (hasSku) {
      return (
        <div className="mp-price-min-wrap">
          <span className="mp-badge" style={{ opacity: 0.5 }}>
            {skuBadge}
          </span>
          {renderVolumeHint(showVolume)}
        </div>
      );
    }
    return (
      <div className="mp-price-min-wrap">
        <span className="mp-price-muted">—</span>
        {renderVolumeHint(showVolume)}
      </div>
    );
  };

  const empty = renderEmpty();
  const showInputs = !isLoading && (min != null || hasSku);
  // Объём один на МП — показываем в первой колонке мин. (FBS, иначе FBO, иначе единственная)
  const volumeInFbs = showFbs;
  const volumeInFbo = showFbo && !showFbs;
  const volumeInSingle = !showFbs && !showFbo;

  return (
    <>
      {showFbs && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {renderMinBtn(
            bothSchemes || showFbs ? fbsMin ?? (showFbo ? null : primaryMin) : primaryMin,
            onOpenMinDetailsFbs || onOpenMinDetails,
            bothSchemes ? 'FBS' : showFbs && !showFbo ? 'FBS' : null,
            { showVolume: volumeInFbs }
          )}
        </td>
      )}
      {showFbo && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {renderMinBtn(
            bothSchemes || showFbo ? fboMin ?? (showFbs ? null : primaryMin) : primaryMin,
            onOpenMinDetailsFbo || onOpenMinDetails,
            bothSchemes ? 'FBO' : 'FBO',
            { showVolume: volumeInFbo }
          )}
        </td>
      )}
      {!showFbs && !showFbo && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {empty || renderMinBtn(primaryMin, onOpenMinDetails, null, { showVolume: volumeInSingle })}
        </td>
      )}

      {!minOnly && (
        <td className="mp-col mp-col-actual" style={{ background: bg }}>
          {!showInputs ? (
            renderEmpty()
          ) : (
            <div className="mp-price-stack">
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                className="mp-price-input"
                value={actualStr}
                disabled={disabled || strategyLocked || saving}
                readOnly={strategyLocked}
                title={
                  strategyLocked
                    ? 'Стратегия ценообразования активна — цена задаётся стратегией'
                    : 'Фактическая цена'
                }
                placeholder="факт"
                onChange={(e) => onActualChange(e.target.value)}
              />
              {(saving || savedFlash) && (
                <span className="mp-price-cell-status">{saving ? '…' : '✓'}</span>
              )}
            </div>
          )}
        </td>
      )}

      {!minOnly && (
        <td className="mp-col mp-col-discount" style={{ background: bg }}>
          {!showInputs ? (
            renderEmpty()
          ) : (
            <div className="mp-price-discount-pair">
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                className="mp-price-input"
                value={beforeStr}
                disabled={disabled || saving}
                placeholder="до ск."
                title="Цена до скидки"
                onChange={(e) => onBeforeChange(e.target.value)}
              />
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                max="99.99"
                className="mp-price-input mp-price-input-pct"
                value={pctStr}
                disabled={disabled || saving}
                placeholder="%"
                title="Скидка %"
                onChange={(e) => onPctChange(e.target.value)}
              />
            </div>
          )}
        </td>
      )}
    </>
  );
}

/** @deprecated use MarketplacePriceCells */
export function MarketplacePriceCell(props) {
  return <MarketplacePriceCells {...props} />;
}

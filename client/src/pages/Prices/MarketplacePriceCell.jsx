import React, { useEffect, useRef, useState } from 'react';
import {
  formatMoneyInput,
  parseMoneyInput,
  percentFromActualAndBefore,
  priceBeforeFromActualAndPercent,
  getMarketplacePricePack,
  productCostBase,
  marginPercentFromPrice,
  formatMarginPercent,
} from './marketplacePriceMath.js';

function MarginHint({ price, costBase, titlePrefix = 'Маржинальность' }) {
  const pct = marginPercentFromPrice(price, costBase);
  const label = formatMarginPercent(pct);
  if (!label) return null;
  const tone = pct >= 0 ? 'positive' : 'negative';
  return (
    <span
      className={`mp-margin-hint mp-margin-hint--${tone}`}
      title={`${titlePrefix}: (цена − себестоимость − доп.) / цена`}
    >
      {label}
    </span>
  );
}

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
  onRequestDisableStrategy = null,
  onOpenMinDetails,
  onOpenMinDetailsFbs,
  onOpenMinDetailsFbo,
  onSave,
  disabled = false,
  showMax = false,
}) {
  const pack = getMarketplacePricePack(product, marketplace);
  const costBase = productCostBase(product);
  const [strategyUnlocked, setStrategyUnlocked] = useState(false);
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
  const initialMax = pack.maxPrice != null && Number.isFinite(Number(pack.maxPrice)) ? Number(pack.maxPrice) : null;
  const [maxStr, setMaxStr] = useState(() => formatMoneyInput(initialMax));
  const [actualStr, setActualStr] = useState(() => formatMoneyInput(pack.sellingPrice));
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
    setActualStr(formatMoneyInput(next.sellingPrice));
    setBeforeStr(formatMoneyInput(next.priceBeforeDiscount));
    setPctStr(formatMoneyInput(next.discountPercent));
  }, [productId, marketplace, pack.sellingPrice, pack.priceBeforeDiscount, pack.discountPercent]);

  useEffect(() => {
    setMaxStr(formatMoneyInput(pack.maxPrice));
  }, [productId, marketplace, pack.maxPrice]);

  useEffect(() => {
    setStrategyUnlocked(false);
  }, [productId, strategyLocked]);

  const commercialLocked = strategyLocked && !strategyUnlocked;

  const ensureStrategyUnlocked = async () => {
    if (!commercialLocked) return true;
    if (typeof onRequestDisableStrategy !== 'function') return false;
    const ok = await onRequestDisableStrategy(productId);
    if (ok) setStrategyUnlocked(true);
    return Boolean(ok);
  };

  const scheduleSave = (payload) => {
    if (typeof onSave !== 'function') return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave({
          productId,
          marketplace,
          ...payload,
          clearProductStrategy: strategyLocked || strategyUnlocked,
        });
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
      } finally {
        setSaving(false);
      }
    }, 550);
  };

  const currentActual = () => {
    const n = parseMoneyInput(actualStr);
    return n != null && n > 0 ? n : null;
  };

  const onActualChange = async (raw) => {
    if (commercialLocked) {
      const ok = await ensureStrategyUnlocked();
      if (!ok) return;
    }
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

  const onBeforeChange = async (raw) => {
    if (commercialLocked) {
      const ok = await ensureStrategyUnlocked();
      if (!ok) return;
    }
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

  const onPctChange = async (raw) => {
    if (commercialLocked) {
      const ok = await ensureStrategyUnlocked();
      if (!ok) return;
    }
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

  const onMaxChange = (raw) => {
    setMaxStr(raw);
    scheduleSave({ maxPrice: parseMoneyInput(raw) });
  };

  const renderEmpty = () => {
    if (isLoading) return <span className="mp-price-muted">...</span>;
    if (min == null && !hasSku) return <span className="mp-price-muted">—</span>;
    return null;
  };

  const renderMinBtn = (value, onOpen, label) => {
    if (isLoading) return <span className="mp-price-muted">...</span>;
    const canOpen = typeof onOpen === 'function';
    const title = label ? `Детали расчёта мин. цены ${label}` : 'Детали расчёта минимальной цены';
    const inner =
      value != null ? (
        `${value} ₽`
      ) : hasSku ? (
        <span className="mp-badge" style={{ opacity: 0.7 }}>
          {skuBadge}
        </span>
      ) : (
        '—'
      );
    return (
      <div className="mp-price-min-wrap">
        {canOpen ? (
          <button
            type="button"
            className="mp-price-cell-min-btn"
            style={{ color: value != null ? color : 'var(--muted)' }}
            onClick={onOpen}
            title={title}
          >
            {inner}
          </button>
        ) : (
          <span className={value != null ? '' : 'mp-price-muted'}>{inner}</span>
        )}
        <MarginHint price={value} costBase={costBase} titlePrefix={`Маржа мин.${label ? ` ${label}` : ''}`} />
      </div>
    );
  };

  const empty = renderEmpty();

  return (
    <>
      {showFbs && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {renderMinBtn(
            bothSchemes || showFbs ? fbsMin ?? (showFbo ? null : primaryMin) : primaryMin,
            onOpenMinDetailsFbs || onOpenMinDetails,
            bothSchemes ? 'FBS' : showFbs && !showFbo ? 'FBS' : null
          )}
        </td>
      )}
      {showFbo && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {renderMinBtn(
            bothSchemes || showFbo ? fboMin ?? (showFbs ? null : primaryMin) : primaryMin,
            onOpenMinDetailsFbo || onOpenMinDetails,
            bothSchemes ? 'FBO' : 'FBO'
          )}
        </td>
      )}
      {!showFbs && !showFbo && (
        <td className="mp-col mp-col-min" style={{ background: bg }}>
          {empty || renderMinBtn(primaryMin, onOpenMinDetails)}
        </td>
      )}

      {showMax && (
        <td className="mp-col mp-col-max" style={{ background: bg }}>
          {isLoading ? (
            <span className="mp-price-muted">...</span>
          ) : (
            <div className="mp-price-field">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className="mp-price-input mp-price-input-max"
                value={maxStr}
                disabled={disabled || saving}
                placeholder=""
                title="Максимальная цена продажи"
                onChange={(e) => onMaxChange(e.target.value)}
              />
              <MarginHint price={parseMoneyInput(maxStr)} costBase={costBase} titlePrefix="Маржа макс." />
            </div>
          )}
        </td>
      )}

      {!minOnly && (
        <td className="mp-col mp-col-actual" style={{ background: bg }}>
          {isLoading ? (
            <span className="mp-price-muted">...</span>
          ) : (
            <div className="mp-price-field">
              <div className="mp-price-stack">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className="mp-price-input"
                  value={actualStr}
                  disabled={disabled || saving}
                  title={
                    commercialLocked
                      ? 'Стратегия активна — при изменении цен она будет отключена для товара'
                      : 'Цена после скидки'
                  }
                  placeholder="после"
                  onChange={(e) => onActualChange(e.target.value)}
                />
                {(saving || savedFlash) && (
                  <span className="mp-price-cell-status">{saving ? '…' : '✓'}</span>
                )}
              </div>
              <MarginHint
                price={parseMoneyInput(actualStr)}
                costBase={costBase}
                titlePrefix="Маржа после скидки"
              />
            </div>
          )}
        </td>
      )}

      {!minOnly && (
        <td className="mp-col mp-col-discount" style={{ background: bg }}>
          {isLoading ? (
            <span className="mp-price-muted">...</span>
          ) : (
            <div className="mp-price-field">
              <div className="mp-price-discount-pair">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className="mp-price-input"
                  value={beforeStr}
                  disabled={disabled || saving}
                  placeholder="до"
                  title={
                    commercialLocked
                      ? 'Стратегия активна — при изменении цен она будет отключена для товара'
                      : 'Цена до скидки'
                  }
                  onChange={(e) => onBeforeChange(e.target.value)}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className="mp-price-input mp-price-input-pct"
                  value={pctStr}
                  disabled={disabled || saving}
                  placeholder="%"
                  title={
                    commercialLocked
                      ? 'Стратегия активна — при изменении цен она будет отключена для товара'
                      : 'Скидка %'
                  }
                  onChange={(e) => onPctChange(e.target.value)}
                />
              </div>
              <MarginHint
                price={parseMoneyInput(beforeStr)}
                costBase={costBase}
                titlePrefix="Маржа до скидки"
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

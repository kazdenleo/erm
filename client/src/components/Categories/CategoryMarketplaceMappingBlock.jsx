import React from 'react';
import {
  getWbCommissionSchemesForDisplay,
  getMpPriceCalcSchemeKey,
  resolveMpCommissionEntry,
} from '../../utils/marketplaceCategoryCommissions';

const MP_BADGE_CLASS = {
  wb: 'wb',
  wildberries: 'wb',
  ozon: 'ozon',
  ym: 'ym',
  yandex: 'ym',
};

function mpBadgeClass(marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  return MP_BADGE_CLASS[mp] || mp;
}

export function CommissionSchemesRow({ schemes, note, priceCalcSchemeKey = null }) {
  if (!schemes?.length && !note) return null;
  return (
    <div className="category-mp-commissions">
      {(schemes || []).map((s) => {
        const isPriceCalc = priceCalcSchemeKey && s.key === priceCalcSchemeKey;
        return (
          <span
            key={s.key}
            className={`category-mp-commission-chip${s.display ? '' : ' category-mp-commission-chip--empty'}${isPriceCalc ? ' category-mp-commission-chip--price-calc' : ''}`}
            title={
              isPriceCalc
                ? `${s.label} — используется в расчёте минимальной цены`
                : s.label
            }
          >
            <span className="category-mp-commission-chip-label">{s.shortLabel}</span>
            <span className="category-mp-commission-chip-value">{s.display || '—'}</span>
          </span>
        );
      })}
      {note && <span className="category-mp-commissions-note">{note}</span>}
    </div>
  );
}

/**
 * Блок сопоставления категории с маркетплейсом и комиссиями по схемам продаж.
 */
export function CategoryMarketplaceMappingBlock({
  marketplace,
  mapping,
  wbCommissionsByCategoryId,
  mpCommissionsPreview,
}) {
  const mp = String(marketplace || '').toLowerCase();
  const categoryName = mapping?.marketplace_category_name || 'Категория не найдена';
  const categoryId = mapping?.marketplace_category_id ?? mapping?.category_id;

  let schemes = [];
  let note = null;
  let priceCalcSchemeKey = null;

  if (mp === 'wb' || mp === 'wildberries') {
    const row = categoryId != null ? wbCommissionsByCategoryId?.get(String(categoryId)) : null;
    const wb = getWbCommissionSchemesForDisplay(row);
    schemes = wb.schemes;
    note = wb.note;
    priceCalcSchemeKey = wb.priceCalcSchemeKey;
  } else {
    const entry = resolveMpCommissionEntry(mpCommissionsPreview, mp, categoryId);
    schemes = entry?.schemes || [];
    note = entry?.note || null;
    priceCalcSchemeKey = getMpPriceCalcSchemeKey(mp);
    if (!schemes.length) {
      note = note || 'Нет данных в кэше комиссий';
    }
  }

  return (
    <div className="category-mp-mapping">
      <div className="category-mp-row">
        <span className={`mp-badge ${mpBadgeClass(mp)}`}>{mpBadgeClass(mp)}</span>
        <span className="category-mp-name">{categoryName}</span>
      </div>
      <CommissionSchemesRow schemes={schemes} note={note} priceCalcSchemeKey={priceCalcSchemeKey} />
    </div>
  );
}

/**
 * Список сопоставлений категории со всеми маркетплейсами.
 */
export function CategoryMarketplaceMappingsPanel({
  mappings,
  wbCommissionsByCategoryId,
  mpCommissionsPreview,
}) {
  if (!mappings || typeof mappings !== 'object' || Object.keys(mappings).length === 0) {
    return null;
  }

  return (
    <div className="category-mp-panel">
      <div className="category-mp-panel-title">Сопоставлено с маркетплейсами</div>
      {Object.entries(mappings).map(([marketplace, mappingsList]) => {
        const mapping = Array.isArray(mappingsList) ? mappingsList[0] : null;
        if (!mapping) return null;
        return (
          <CategoryMarketplaceMappingBlock
            key={marketplace}
            marketplace={marketplace}
            mapping={mapping}
            wbCommissionsByCategoryId={wbCommissionsByCategoryId}
            mpCommissionsPreview={mpCommissionsPreview}
          />
        );
      })}
    </div>
  );
}

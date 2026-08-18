import React from 'react';
import {
  ATTR_MP_CODES,
  attrMpLinkKey,
  mpAttributeOptionValue,
  normalizeAttrMpLinks,
  parseMpAttributeOptionValue,
} from '../../../utils/productAttributeMpLinks.js';
import './AttributeMpLinkFields.css';

const MP_META = {
  ozon: { label: 'Ozon', color: '#005bff' },
  wb: { label: 'Wildberries', color: '#cb11ab' },
  ym: { label: 'Яндекс.Маркет', color: '#fc3f1d' },
};

function optionLabel(attr, getId, getName) {
  const name = String((getName ? getName(attr) : attr?.name) || '').trim() || 'Без названия';
  const id = String((getId ? getId(attr) : attr?.id) ?? '').trim();
  return id ? `${name} (${id})` : name;
}

/**
 * Выбор характеристик МП для связи с ERP-атрибутом.
 * Если список options пуст — текстовое поле по названию характеристики.
 */
export function AttributeMpLinkFields({
  links,
  onChange,
  ozonOptions = [],
  wbOptions = [],
  ymOptions = [],
  getOzonId,
  getOzonName,
  getWbId,
  getWbName,
  getYmId,
  getYmName,
  disabled = false,
}) {
  const current = normalizeAttrMpLinks(links);
  const optionsByMp = { ozon: ozonOptions, wb: wbOptions, ym: ymOptions };
  const getters = {
    ozon: { getId: getOzonId, getName: getOzonName },
    wb: { getId: getWbId, getName: getWbName },
    ym: { getId: getYmId, getName: getYmName },
  };

  const setMp = (mp, entry) => {
    onChange?.({ ...current, [mp]: entry });
  };

  return (
    <div className="attribute-mp-links">
      {ATTR_MP_CODES.map((mp) => {
        const meta = MP_META[mp];
        const list = optionsByMp[mp] || [];
        const { getId, getName } = getters[mp];
        const selected = current[mp];
        const selectedKey = attrMpLinkKey(selected);
        const selectValue = selected
          ? mpAttributeOptionValue(
              { id: selected.id, name: selected.name },
              (a) => a.id,
              (a) => a.name
            )
          : '';
        const hasOptions = list.length > 0;
        const selectedInList =
          hasOptions &&
          selected &&
          list.some((a) => attrMpLinkKey({
            id: String((getId ? getId(a) : a?.id) ?? ''),
            name: String((getName ? getName(a) : a?.name) ?? ''),
          }) === selectedKey);

        return (
          <div key={mp} className="attribute-mp-links__row">
            <label className="attribute-mp-links__label">
              <span className="attribute-mp-links__badge" style={{ background: meta.color }}>
                {mp === 'ozon' ? 'OZ' : mp === 'wb' ? 'WB' : 'ЯМ'}
              </span>
              {meta.label}
            </label>
            {hasOptions ? (
              <select
                className="form-select form-select-sm"
                disabled={disabled}
                value={selectValue}
                onChange={(e) => setMp(mp, parseMpAttributeOptionValue(e.target.value))}
              >
                <option value="">— не связано —</option>
                {selected && !selectedInList ? (
                  <option value={selectValue}>
                    {selected.name || selected.id || 'Выбранная характеристика'}
                  </option>
                ) : null}
                {list.map((attr) => {
                  const val = mpAttributeOptionValue(attr, getId, getName);
                  return (
                    <option key={val} value={val}>
                      {optionLabel(attr, getId, getName)}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input
                type="text"
                className="form-control form-control-sm"
                disabled={disabled}
                placeholder="Название характеристики на МП"
                value={selected?.name || selected?.id || ''}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setMp(mp, v ? { id: '', name: v } : null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

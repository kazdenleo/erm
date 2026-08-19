import React, { useState } from 'react';
import {
  ATTR_MP_CODES,
  addAttrMpLink,
  attrMpLinkKey,
  mpAttributeOptionValue,
  normalizeAttrMpLinks,
  parseMpAttributeOptionValue,
  removeAttrMpLink,
} from '../../../utils/productAttributeMpLinks.js';
import './AttributeMpLinkFields.css';

const MP_META = {
  ozon: { label: 'Ozon', color: '#005bff' },
  wb: { label: 'Wildberries', color: '#cb11ab' },
  ym: { label: 'Яндекс.Маркет', color: '#fc3f1d' },
};

function optionLabel(attr, getName) {
  return String((getName ? getName(attr) : attr?.name) || '').trim() || 'Без названия';
}

function sortAttrsByName(list, getName) {
  return [...(list || [])].sort((a, b) =>
    optionLabel(a, getName).localeCompare(optionLabel(b, getName), 'ru', { sensitivity: 'base' })
  );
}

function entryLabel(entry) {
  return String(entry?.name || entry?.id || 'Характеристика').trim();
}

/**
 * Прикрепление характеристик МП к полю/атрибуту ERP.
 * На один маркетплейс можно добавить несколько характеристик.
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
  const [draftByMp, setDraftByMp] = useState({ ozon: '', wb: '', ym: '' });

  const addEntry = (mp, entry) => {
    if (!entry) return;
    onChange?.(addAttrMpLink(current, mp, entry));
  };

  return (
    <div className="attribute-mp-links">
      {ATTR_MP_CODES.map((mp) => {
        const meta = MP_META[mp];
        const list = optionsByMp[mp] || [];
        const { getId, getName } = getters[mp];
        const selected = current[mp] || [];
        const selectedKeys = new Set(selected.map((e) => attrMpLinkKey(e)).filter(Boolean));
        const hasOptions = list.length > 0;
        const available = sortAttrsByName(
          list.filter((a) => {
            const k = attrMpLinkKey({
              id: String((getId ? getId(a) : a?.id) ?? ''),
              name: String((getName ? getName(a) : a?.name) ?? ''),
            });
            return k && !selectedKeys.has(k);
          }),
          getName
        );

        return (
          <div key={mp} className="attribute-mp-links__row">
            <label className="attribute-mp-links__label">
              <span className="attribute-mp-links__badge" style={{ background: meta.color }}>
                {mp === 'ozon' ? 'OZ' : mp === 'wb' ? 'WB' : 'ЯМ'}
              </span>
              {meta.label}
            </label>
            <div className="attribute-mp-links__chips">
              {selected.map((entry) => (
                <span key={attrMpLinkKey(entry)} className="attribute-mp-links__chip">
                  {entryLabel(entry)}
                  <button
                    type="button"
                    className="attribute-mp-links__chip-remove"
                    disabled={disabled}
                    aria-label="Удалить характеристику"
                    onClick={() => onChange?.(removeAttrMpLink(current, mp, entry))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {selected.length === 0 ? (
                <span className="attribute-mp-links__empty">не прикреплено</span>
              ) : null}
            </div>
            {hasOptions ? (
              <select
                className="form-select form-select-sm"
                disabled={disabled || available.length === 0}
                value=""
                onChange={(e) => {
                  addEntry(mp, parseMpAttributeOptionValue(e.target.value));
                }}
              >
                <option value="">
                  {available.length ? 'Добавить характеристику…' : 'Все характеристики уже добавлены'}
                </option>
                {available.map((attr) => {
                  const val = mpAttributeOptionValue(attr, getId, getName);
                  return (
                    <option key={val} value={val}>
                      {optionLabel(attr, getName)}
                    </option>
                  );
                })}
              </select>
            ) : (
              <div className="attribute-mp-links__manual">
                <input
                  type="text"
                  className="form-control form-control-sm"
                  disabled={disabled}
                  placeholder="Название характеристики на МП"
                  value={draftByMp[mp] || ''}
                  onChange={(e) => setDraftByMp((prev) => ({ ...prev, [mp]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const v = String(draftByMp[mp] || '').trim();
                    if (!v) return;
                    addEntry(mp, { id: '', name: v });
                    setDraftByMp((prev) => ({ ...prev, [mp]: '' }));
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={disabled || !String(draftByMp[mp] || '').trim()}
                  onClick={() => {
                    const v = String(draftByMp[mp] || '').trim();
                    if (!v) return;
                    addEntry(mp, { id: '', name: v });
                    setDraftByMp((prev) => ({ ...prev, [mp]: '' }));
                  }}
                >
                  Добавить
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

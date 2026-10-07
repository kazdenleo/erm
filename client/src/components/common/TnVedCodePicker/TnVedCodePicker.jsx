/**
 * Выбор кода ТН ВЭД из классификатора ЕАЭС (поиск по коду или названию)
 * и проверка, подходит ли код для предмета WB / типа товара Ozon.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { tnVedApi } from '../../../services/tnVed.api';
import './TnVedCodePicker.css';

const MP_LABELS = { wb: 'WB', ozon: 'Ozon' };

function compatBadge(mp, res) {
  const label = MP_LABELS[mp];
  if (!res || res.status === 'no_mapping') return null;
  switch (res.status) {
    case 'ok':
      return {
        tone: 'ok',
        text: `${label}: подходит${res.isKiz ? ' (нужна маркировка)' : ''}`,
        title: res.value || '',
      };
    case 'not_allowed':
      return {
        tone: 'bad',
        text: mp === 'wb' ? `${label}: не разрешён для предмета` : `${label}: нет в справочнике типа`,
        title: 'Маркетплейс не примет этот код для выбранной категории',
      };
    case 'no_attribute':
      return { tone: 'muted', text: `${label}: поле ТН ВЭД не требуется`, title: '' };
    default:
      return { tone: 'muted', text: `${label}: не удалось проверить`, title: res.message || '' };
  }
}

export function TnVedCodePicker({
  value,
  onChange,
  error,
  required = false,
  id = 'tnVedCode',
  label = 'Код ТН ВЭД',
  hint = 'Выберите код из классификатора ТН ВЭД ЕАЭС (поиск по коду или названию).',
  marketplaceContext = null,
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [compat, setCompat] = useState(null);
  const [compatLoading, setCompatLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await tnVedApi.searchCodes({ q: query, limit: 40 });
        if (!cancelled) setOptions(res?.data || []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return undefined;
    }
    let cancelled = false;
    tnVedApi
      .getCode(value)
      .then((res) => {
        if (!cancelled) setSelected(res?.data ? { ...res.data, found: true } : { code: value, found: false });
      })
      .catch(() => {
        if (!cancelled) setSelected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const contextKey = marketplaceContext ? JSON.stringify(marketplaceContext) : '';

  useEffect(() => {
    setCompat(null);
    if (!value || !/^\d{10}$/.test(value) || !contextKey) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      setCompatLoading(true);
      try {
        const res = await tnVedApi.checkCompatibility({ ...JSON.parse(contextKey), code: value });
        if (!cancelled) setCompat(res?.data || null);
      } catch {
        if (!cancelled) setCompat(null);
      } finally {
        if (!cancelled) setCompatLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value, contextKey]);

  const selectedInfo = useMemo(() => {
    if (!value) return null;
    if (selected && selected.code === value) return selected;
    const hit = options.find((o) => o.code === value);
    return hit ? { ...hit, found: true } : null;
  }, [value, selected, options]);

  const badges = compat ? [compatBadge('wb', compat.wb), compatBadge('ozon', compat.ozon)].filter(Boolean) : [];

  return (
    <div className="tnved-picker">
      <label className="tnved-picker__label" htmlFor={id}>
        {label}
        {required ? <span className="tnved-picker__req"> *</span> : null}
      </label>
      {hint ? <p className="tnved-picker__hint">{hint}</p> : null}
      {value ? (
        <div className="tnved-selected">
          <div className="tnved-selected__body">
            <span>
              <strong>{value}</strong>
              {selectedInfo?.name ? ` — ${selectedInfo.name}` : ''}
            </span>
            {selectedInfo?.positionName ? (
              <span className="tnved-selected__position">{selectedInfo.positionName}</span>
            ) : null}
            {selectedInfo && selectedInfo.found === false ? (
              <span className="tnved-selected__warn">Кода нет в классификаторе ТН ВЭД ЕАЭС — выберите действующий код</span>
            ) : null}
            {selectedInfo && selectedInfo.found && selectedInfo.active === false ? (
              <span className="tnved-selected__warn">Код исключён из классификатора — выберите действующий код</span>
            ) : null}
            {compatLoading ? <span className="tnved-selected__position">Проверка WB / Ozon…</span> : null}
            {badges.length ? (
              <div className="tnved-badges">
                {badges.map((b) => (
                  <span key={b.text} className={`tnved-badge tnved-badge--${b.tone}`} title={b.title}>
                    {b.text}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="tnved-clear"
            onClick={() => onChange('')}
            aria-label="Сбросить код ТН ВЭД"
          >
            ×
          </button>
        </div>
      ) : null}
      <input
        id={id}
        type="text"
        className="form-control form-control-sm tnved-picker__search"
        placeholder="Поиск: 8708 или «амортизатор»…"
        value={query}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open ? (
        <div className="tnved-options">
          {loading ? (
            <div className="tnved-picker__muted">Поиск…</div>
          ) : options.length === 0 ? (
            <div className="tnved-picker__muted">
              {(() => {
                const digits = query.replace(/\D/g, '');
                if (digits.length > 10) return 'Код ТН ВЭД — 10 цифр, введено больше';
                if (digits.length === 10) return 'Кода нет в классификаторе ТН ВЭД ЕАЭС — проверьте цифры';
                return 'Ничего не найдено';
              })()}
            </div>
          ) : (
            options.map((row) => (
              <button
                key={row.code}
                type="button"
                className={`tnved-option${value === row.code ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(row.code);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <strong>{row.code}</strong>
                <span>{row.name}</span>
                {row.positionName ? <small className="tnved-option__position">{row.positionName}</small> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
      {error ? <div className="tnved-picker__error">{error}</div> : null}
    </div>
  );
}

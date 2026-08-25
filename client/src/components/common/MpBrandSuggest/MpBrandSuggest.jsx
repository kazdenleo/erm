/**
 * Подсказка бренда из справочника маркетплейса (локальная копия + живой поиск).
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { integrationsApi } from '../../../services/integrations.api.js';

const DEBOUNCE_MS = 280;

const PLACEHOLDERS = {
  wb: 'Словарь WB, например MILES',
  ozon: 'Словарь Ozon, выберите из подсказки',
  ym: 'Как vendor в кабинете Яндекса',
};

export function MpBrandSuggest({
  marketplace = 'wb',
  value = '',
  onChange,
  onSelect,
  subjectId,
  organizationId,
  className,
  id,
  placeholder,
  disabled,
  title,
}) {
  const autoId = useId();
  const listId = `${id || autoId}-${marketplace}-brands`;
  const [options, setOptions] = useState([]);
  const seqRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const query = String(value || '').trim();
  const mp = String(marketplace || 'wb').toLowerCase();

  useEffect(() => {
    if (query.length < 1) {
      setOptions([]);
      return undefined;
    }
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      void integrationsApi
        .getMarketplaceBrands({
          marketplace: mp,
          q: query,
          subjectId: subjectId || undefined,
          organizationId: organizationId || undefined,
        })
        .then((list) => {
          if (seq !== seqRef.current) return;
          setOptions(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setOptions([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, mp, subjectId, organizationId]);

  const names = useMemo(
    () =>
      options
        .map((o) => String(o?.name || '').trim())
        .filter(Boolean),
    [options]
  );

  const commitCanonical = () => {
    const cur = String(valueRef.current || '').trim();
    if (!cur) return;
    const lower = cur.toLowerCase();
    const hit = (optionsRef.current || []).find(
      (o) => String(o?.name || '').trim().toLowerCase() === lower
    );
    const exactName = hit?.name || names.find((n) => n.toLowerCase() === lower);
    if (exactName && exactName !== cur && typeof onChange === 'function') onChange(exactName);
    if (hit && typeof onSelect === 'function') onSelect(hit);
  };

  return (
    <>
      <input
        id={id}
        list={listId}
        className={className}
        value={value ?? ''}
        disabled={disabled}
        title={title}
        placeholder={placeholder || PLACEHOLDERS[mp] || 'Как в кабинете МП'}
        autoComplete="off"
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={commitCanonical}
      />
      <datalist id={listId}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Подсказка бренда из справочника Wildberries (без учёта регистра: Miles → MILES).
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { integrationsApi } from '../../../services/integrations.api.js';

const DEBOUNCE_MS = 280;

export function WbBrandSuggest({
  value = '',
  onChange,
  subjectId,
  organizationId,
  className,
  id,
  placeholder = 'Как в справочнике WB, например MILES',
  disabled,
  title,
}) {
  const autoId = useId();
  const listId = `${id || autoId}-wb-brands`;
  const [options, setOptions] = useState([]);
  const seqRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const query = String(value || '').trim();

  useEffect(() => {
    if (query.length < 1) {
      setOptions([]);
      return undefined;
    }
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      void integrationsApi
        .getWildberriesBrands({
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
  }, [query, subjectId, organizationId]);

  const names = useMemo(
    () =>
      options
        .map((o) => String(o?.name || '').trim())
        .filter(Boolean),
    [options]
  );

  const commitCanonical = () => {
    const cur = String(valueRef.current || '').trim();
    if (!cur || !names.length) return;
    const lower = cur.toLowerCase();
    const exact = names.find((n) => n.toLowerCase() === lower);
    if (exact && exact !== cur && typeof onChange === 'function') onChange(exact);
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
        placeholder={placeholder}
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

/**
 * Поле сканера: нативные input/keydown-слушатели, без React onChange.
 * Родитель не перерисовывается на каждый символ — только по onScan после паузы / Enter.
 */

import React, { memo, useEffect, useRef } from 'react';
import { isLikelyBarcodeScan, normalizeProductSearchQuery } from '../../../utils/productSearch';
import { looksLikeCis } from '../../../utils/chestnyZnakCis';
import { clearScanField, readScanFieldValue } from '../../../utils/scanInput';

function assignRef(ref, el) {
  if (typeof ref === 'function') ref(el);
  else if (ref) ref.current = el;
}

/** При ручном вводе артикула авто-скан только для длинного числового штрихкода (8+ цифр). */
function isBarcodeLikeForScan(raw, { manualTypingMode = false } = {}) {
  const v = normalizeProductSearchQuery(raw);
  if (!v) return false;
  if (looksLikeCis(v)) return true;
  if (/[a-zа-я]/i.test(v)) return false;
  if (!manualTypingMode) return isLikelyBarcodeScan(v);
  return /^\d{8,}$/.test(v);
}

function FastScanInputInner({
  onScan,
  onManualQuery = null,
  disabled = false,
  debounceMs = 120,
  manualDebounceMs = 250,
  minLength = 2,
  enableGlobalCapture = false,
  autoFocus = true,
  inputRef: externalRef = null,
  id,
  className = 'warehouse-ops-scan-input',
  placeholder,
  onBlur,
}) {
  const localRef = useRef(null);
  const scanDebounceRef = useRef(null);
  const manualDebounceRef = useRef(null);
  const onScanRef = useRef(onScan);
  const onManualQueryRef = useRef(onManualQuery);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onManualQueryRef.current = onManualQuery;
  }, [onManualQuery]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    const el = localRef.current;
    if (!el || disabled) return undefined;

    const clearScanDebounce = () => {
      if (scanDebounceRef.current) {
        clearTimeout(scanDebounceRef.current);
        scanDebounceRef.current = null;
      }
    };

    const clearManualDebounce = () => {
      if (manualDebounceRef.current) {
        clearTimeout(manualDebounceRef.current);
        manualDebounceRef.current = null;
      }
    };

    const fireScan = (raw) => {
      if (disabledRef.current) return;
      const trimmed = normalizeProductSearchQuery(raw ?? readScanFieldValue(el));
      if (trimmed.length < minLength) return;
      clearScanDebounce();
      clearManualDebounce();
      clearScanField(el);
      onScanRef.current?.(trimmed);
    };

    const scheduleScan = (raw) => {
      clearScanDebounce();
      scanDebounceRef.current = setTimeout(() => fireScan(raw), debounceMs);
    };

    const scheduleManualQuery = () => {
      if (typeof onManualQueryRef.current !== 'function') return;
      clearManualDebounce();
      manualDebounceRef.current = setTimeout(() => {
        manualDebounceRef.current = null;
        const q = readScanFieldValue(el).trim();
        if (q.length < minLength) return;
        if (isBarcodeLikeForScan(q, { manualTypingMode: true })) return;
        onManualQueryRef.current?.(q);
      }, manualDebounceMs);
    };

    const onInput = () => {
      const v = readScanFieldValue(el);
      const hasManualQuery = typeof onManualQueryRef.current === 'function';
      if (/[\r\n]/.test(el.value)) {
        const cleaned = normalizeProductSearchQuery(el.value);
        clearScanField(el);
        scheduleScan(cleaned);
        return;
      }
      if (!v.trim()) {
        clearScanDebounce();
        clearManualDebounce();
        return;
      }
      if (hasManualQuery) {
        if (isBarcodeLikeForScan(v, { manualTypingMode: true })) {
          scheduleScan(v);
          return;
        }
        if (v.trim().length >= minLength) {
          clearScanDebounce();
          scheduleManualQuery();
        }
        return;
      }
      if (isLikelyBarcodeScan(v) || v.trim().length >= minLength) {
        scheduleScan(v);
        return;
      }
      scheduleManualQuery();
    };

    const onKeyDown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      fireScan();
    };

    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeyDown);

    return () => {
      clearScanDebounce();
      clearManualDebounce();
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [disabled, debounceMs, manualDebounceMs, minLength]);

  useEffect(() => {
    if (!enableGlobalCapture || disabled) return undefined;

    const appendToInput = (key) => {
      const el = localRef.current;
      if (!el) return;
      el.focus();
      el.value += key;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onKeyDown = (e) => {
      if (disabledRef.current) return;
      if (e.target === localRef.current) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        e.target?.isContentEditable;
      if (isEditable && e.target !== localRef.current) return;

      if (e.key === 'Enter') {
        const el = localRef.current;
        const buf = readScanFieldValue(el);
        if (buf.length >= minLength) {
          e.preventDefault();
          e.stopPropagation();
          clearScanField(el);
          onScanRef.current?.(buf);
        }
        return;
      }

      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;

      e.preventDefault();
      e.stopPropagation();
      appendToInput(e.key);
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enableGlobalCapture, disabled, minLength]);

  useEffect(() => {
    assignRef(externalRef, localRef.current);
  });

  useEffect(() => {
    if (!autoFocus || disabled) return undefined;
    const t = setTimeout(() => localRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [autoFocus, disabled]);

  return (
    <input
      id={id}
      ref={localRef}
      type="text"
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onBlur={onBlur}
    />
  );
}

export const FastScanInput = memo(FastScanInputInner);

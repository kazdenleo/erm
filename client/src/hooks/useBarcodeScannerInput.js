/**
 * Поле ввода под сканер штрихкодов: Enter и пауза после быстрого ввода (без кнопки).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isLikelyBarcodeScan, normalizeProductSearchQuery } from '../utils/productSearch';

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_MIN_LENGTH = 2;

export function useBarcodeScannerInput({
  onScan,
  disabled = false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  minLength = DEFAULT_MIN_LENGTH,
  enableGlobalCapture = false,
  autoFocus = true,
} = {}) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const valueRef = useRef('');
  const debounceRef = useRef(null);
  const onScanRef = useRef(onScan);
  const disabledRef = useRef(disabled);
  const globalBufferRef = useRef('');
  const globalLastKeyAtRef = useRef(0);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const fireScan = useCallback(
    (raw) => {
      const fromInput = normalizeProductSearchQuery(inputRef.current?.value ?? '');
      const trimmed =
        fromInput.length >= minLength ? fromInput : normalizeProductSearchQuery(raw ?? valueRef.current);
      if (trimmed.length < minLength || disabledRef.current) return;
      clearDebounce();
      setValue('');
      valueRef.current = '';
      onScanRef.current?.(trimmed);
    },
    [clearDebounce, minLength]
  );

  const scheduleScan = useCallback(
    (raw) => {
      clearDebounce();
      debounceRef.current = setTimeout(() => fireScan(raw), debounceMs);
    },
    [clearDebounce, debounceMs, fireScan]
  );

  const handleChange = useCallback(
    (e) => {
      const v = e.target.value;
      if (/[\r\n]/.test(v)) {
        const cleaned = normalizeProductSearchQuery(v);
        setValue('');
        valueRef.current = '';
        scheduleScan(cleaned);
        return;
      }
      setValue(v);
      valueRef.current = v;
      if (!v.trim()) {
        clearDebounce();
        return;
      }
      if (isLikelyBarcodeScan(v) || v.trim().length >= minLength) {
        scheduleScan(v);
      }
    },
    [clearDebounce, minLength, scheduleScan]
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      fireScan();
    },
    [fireScan]
  );

  const handleSubmit = useCallback(
    (e) => {
      e?.preventDefault?.();
      fireScan();
    },
    [fireScan]
  );

  useEffect(() => {
    if (!autoFocus || disabled) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [autoFocus, disabled]);

  useEffect(() => {
    if (!enableGlobalCapture || disabled) return undefined;

    const onKeyDown = (e) => {
      if (disabledRef.current) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        e.target?.isContentEditable;
      if (isEditable && e.target !== inputRef.current) return;

      if (e.key === 'Enter') {
        const buf = normalizeProductSearchQuery(globalBufferRef.current);
        globalBufferRef.current = '';
        if (buf.length >= minLength) {
          e.preventDefault();
          e.stopPropagation();
          onScanRef.current?.(buf);
          setValue('');
          valueRef.current = '';
        }
        return;
      }

      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable && e.target !== inputRef.current) return;

      globalBufferRef.current += e.key;
      globalLastKeyAtRef.current = Date.now();
    };

    const onKeyDownCapture = (e) => {
      if (e.key === 'Enter' && globalBufferRef.current) {
        onKeyDown(e);
      }
    };

    document.addEventListener('keydown', onKeyDownCapture, true);
    return () => document.removeEventListener('keydown', onKeyDownCapture, true);
  }, [enableGlobalCapture, disabled, minLength]);

  useEffect(() => () => clearDebounce(), [clearDebounce]);

  return {
    value,
    setValue,
    inputRef,
    clear: () => {
      clearDebounce();
      setValue('');
      valueRef.current = '';
    },
    focus: () => inputRef.current?.focus(),
    inputProps: {
      ref: inputRef,
      value,
      onChange: handleChange,
      onKeyDown: handleKeyDown,
      disabled,
      autoComplete: 'off',
    },
    handleSubmit,
  };
}

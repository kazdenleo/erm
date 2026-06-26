/**
 * Поле ввода под сканер штрихкодов: Enter и пауза после быстрого ввода (без кнопки).
 * Uncontrolled input — символы отображаются сразу, без re-render родителя на каждую клавишу.
 */

import { useCallback, useEffect, useRef } from 'react';
import { isLikelyBarcodeScan, normalizeProductSearchQuery } from '../utils/productSearch';

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_MIN_LENGTH = 2;

function readInputValue(input) {
  return normalizeProductSearchQuery(input?.value ?? '');
}

function clearInputEl(input) {
  if (input) input.value = '';
}

export function useBarcodeScannerInput({
  onScan,
  disabled = false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  minLength = DEFAULT_MIN_LENGTH,
  enableGlobalCapture = false,
  autoFocus = true,
} = {}) {
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const onScanRef = useRef(onScan);
  const disabledRef = useRef(disabled);
  const globalBufferRef = useRef('');

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    clearDebounce();
    clearInputEl(inputRef.current);
    globalBufferRef.current = '';
  }, [clearDebounce]);

  const fireScan = useCallback(
    (raw) => {
      const trimmed = normalizeProductSearchQuery(
        raw ?? readInputValue(inputRef.current) ?? globalBufferRef.current
      );
      if (trimmed.length < minLength || disabledRef.current) return;
      clearDebounce();
      clear();
      onScanRef.current?.(trimmed);
    },
    [clear, clearDebounce, minLength]
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
        clearInputEl(inputRef.current);
        scheduleScan(cleaned);
        return;
      }
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

    const appendToInput = (key) => {
      const input = inputRef.current;
      if (!input) {
        globalBufferRef.current += key;
        return;
      }
      input.focus();
      input.value += key;
      globalBufferRef.current = input.value;
    };

    const onKeyDown = (e) => {
      if (disabledRef.current) return;
      if (e.target === inputRef.current) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        e.target?.isContentEditable;
      if (isEditable && e.target !== inputRef.current) return;

      if (e.key === 'Enter') {
        const buf = readInputValue(inputRef.current) || normalizeProductSearchQuery(globalBufferRef.current);
        if (buf.length >= minLength) {
          e.preventDefault();
          e.stopPropagation();
          clear();
          onScanRef.current?.(buf);
        }
        return;
      }

      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable && e.target !== inputRef.current) return;

      e.preventDefault();
      e.stopPropagation();
      appendToInput(e.key);
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enableGlobalCapture, disabled, minLength, clear]);

  useEffect(() => () => clearDebounce(), [clearDebounce]);

  return {
    inputRef,
    clear,
    focus: () => inputRef.current?.focus(),
    inputProps: {
      ref: inputRef,
      onChange: handleChange,
      onKeyDown: handleKeyDown,
      disabled,
      autoComplete: 'off',
    },
    handleSubmit,
  };
}

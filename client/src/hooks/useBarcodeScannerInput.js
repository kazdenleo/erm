/**
 * Поле ввода под сканер штрихкодов: Enter и пауза после быстрого ввода (без кнопки).
 * Обёртка над FastScanInput — родитель не re-render на каждый символ.
 */

import { useCallback, useRef } from 'react';
import { clearScanField } from '../utils/scanInput';

export function useBarcodeScannerInput({
  onScan,
  disabled = false,
  debounceMs = 120,
  minLength = 2,
  enableGlobalCapture = false,
  autoFocus = true,
} = {}) {
  const inputRef = useRef(null);

  const clear = useCallback(() => {
    clearScanField(inputRef.current);
  }, []);

  const handleSubmit = useCallback(
    (e) => {
      e?.preventDefault?.();
    },
    []
  );

  return {
    inputRef,
    clear,
    focus: () => inputRef.current?.focus(),
    scanInputProps: {
      onScan,
      disabled,
      debounceMs,
      minLength,
      enableGlobalCapture,
      autoFocus,
      inputRef,
    },
    handleSubmit,
  };
}

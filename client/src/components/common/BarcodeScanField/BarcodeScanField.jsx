/**
 * Поле сканирования: отправка по Enter и после паузы (сканер), без кнопки.
 */

import React, { memo } from 'react';
import { useBarcodeScannerInput } from '../../../hooks/useBarcodeScannerInput';
import { FastScanInput } from '../FastScanInput/FastScanInput';

function BarcodeScanFieldInner({
  onScan,
  disabled = false,
  loading = false,
  placeholder = 'Наведите сканер на поле и отсканируйте',
  label,
  id,
  className = 'warehouse-ops-scan-input',
  formClassName = 'warehouse-ops-scan-form warehouse-ops-scan-form--no-btn',
  hint,
  enableGlobalCapture = false,
  debounceMs,
  minLength,
  children,
}) {
  const busy = disabled || loading;
  const { scanInputProps, handleSubmit } = useBarcodeScannerInput({
    onScan,
    disabled: busy,
    enableGlobalCapture,
    debounceMs,
    minLength,
  });

  return (
    <div className="barcode-scan-field">
      {label ? (
        <label className="form-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <form onSubmit={handleSubmit} className={formClassName}>
        <FastScanInput
          id={id}
          className={className}
          placeholder={placeholder}
          {...scanInputProps}
        />
        {children}
      </form>
      {hint ? <p className="warehouse-ops-hint fbo-packing-hint">{hint}</p> : null}
    </div>
  );
}

export const BarcodeScanField = memo(BarcodeScanFieldInner);

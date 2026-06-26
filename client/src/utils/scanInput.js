/** Uncontrolled scan field: read / clear without React state on each keystroke. */

export function readScanFieldValue(inputEl) {
  return String(inputEl?.value ?? '').replace(/[\r\n]+/g, '');
}

export function clearScanField(inputEl) {
  if (inputEl) inputEl.value = '';
}

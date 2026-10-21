/**
 * Режим сканирования камерой телефона.
 * continuous — принимать ШК сразу, пока в кадре
 * button — только по нажатию «Сканировать»
 */

import { readItem, writeItem } from './storage';

export const CAMERA_SCAN_MODES = {
  continuous: 'continuous',
  button: 'button',
};

export const CAMERA_SCAN_MODE_LABELS = {
  continuous: 'Постоянно',
  button: 'По кнопке',
};

export function normalizeCameraScanMode(raw) {
  return raw === CAMERA_SCAN_MODES.button ? CAMERA_SCAN_MODES.button : CAMERA_SCAN_MODES.continuous;
}

export async function loadCameraScanMode() {
  return normalizeCameraScanMode(await readItem('cameraScanMode'));
}

export async function saveCameraScanMode(mode) {
  const next = normalizeCameraScanMode(mode);
  await writeItem('cameraScanMode', next);
  return next;
}

/**
 * Пауза фоновой синхронизации FBS (cron / server.js).
 * Ручной POST /orders/sync-fbs не использует этот флаг.
 */

let fbsBackgroundSyncPaused = false;

export function setOrdersFbsBackgroundSyncPaused(value) {
  fbsBackgroundSyncPaused = Boolean(value);
}

export function isOrdersFbsBackgroundSyncPaused() {
  return fbsBackgroundSyncPaused;
}

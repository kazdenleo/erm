import * as SecureStore from 'expo-secure-store';

const KEYS = {
  token: 'erm.token',
  server: 'erm.server',
  organizationId: 'erm.organizationId',
  receiptSession: 'erm.receiptSession',
  cargoPurchase: 'erm.cargoPurchase',
  cargoBatch: 'erm.cargoBatch',
  autoPrintLabel: 'erm.autoPrintLabel',
  labelPrinter: 'erm.labelPrinter',
  /** Камера: continuous | button */
  cameraScanMode: 'erm.cameraScanMode',
};

export async function readItem(key) {
  try {
    return await SecureStore.getItemAsync(KEYS[key]);
  } catch {
    return null;
  }
}

export async function writeItem(key, value) {
  try {
    if (value == null || value === '') {
      await SecureStore.deleteItemAsync(KEYS[key]);
    } else {
      await SecureStore.setItemAsync(KEYS[key], String(value));
    }
  } catch {
    /* хранилище недоступно — работаем без сохранения */
  }
}

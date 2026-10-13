import * as SecureStore from 'expo-secure-store';

const KEYS = {
  token: 'erm.token',
  server: 'erm.server',
  organizationId: 'erm.organizationId',
  receiptSession: 'erm.receiptSession',
  cargoPurchase: 'erm.cargoPurchase',
  autoPrintLabel: 'erm.autoPrintLabel',
  labelPrinter: 'erm.labelPrinter',
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

import { PermissionsAndroid, Platform } from 'react-native';
import LabelPrinter from '../../modules/label-printer';
import { readItem, writeItem } from './storage';

export const DEFAULT_PRINTER_SETTINGS = {
  address: null,
  name: null,
  widthMm: 58,
  heightMm: 40,
  gapMm: 2,
  marginMm: 1,
  density: 8,
  direction: 1,
  invert: false,
};

/** Прямая печать есть только в собранном APK (в Expo Go нативного модуля нет). */
export const directPrintAvailable = Platform.OS === 'android' && LabelPrinter != null;

export async function loadPrinterSettings() {
  const raw = await readItem('labelPrinter');
  if (!raw) return { ...DEFAULT_PRINTER_SETTINGS };
  try {
    return { ...DEFAULT_PRINTER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

export async function savePrinterSettings(settings) {
  await writeItem('labelPrinter', JSON.stringify(settings));
}

async function ensureBluetoothPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 31) return;
  const permission = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT;
  if (await PermissionsAndroid.check(permission)) return;
  const result = await PermissionsAndroid.request(permission);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Разрешите приложению доступ к «Устройствам поблизости» в настройках Android');
  }
}

function printOptions(settings) {
  const { widthMm, heightMm, gapMm, marginMm, density, direction, invert } = settings;
  return { widthMm, heightMm, gapMm, marginMm, density, direction, invert, dpi: 203, copies: 1 };
}

function requireModule() {
  if (!LabelPrinter) throw new Error('Прямая печать доступна только в установленном приложении');
}

export async function listBondedDevices() {
  requireModule();
  await ensureBluetoothPermission();
  return LabelPrinter.getBondedDevices();
}

export async function printLabelFile(fileUri, settings) {
  requireModule();
  if (!settings?.address) throw new Error('Принтер этикеток не выбран (Настройки → Принтер этикеток)');
  await ensureBluetoothPermission();
  await LabelPrinter.printFile(settings.address, fileUri, printOptions(settings));
}

export async function printTestLabel(settings) {
  requireModule();
  if (!settings?.address) throw new Error('Сначала выберите принтер');
  await ensureBluetoothPermission();
  await LabelPrinter.printTest(settings.address, printOptions(settings));
}

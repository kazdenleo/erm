import { fetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import { apiUrl, authHeaders, ApiError } from '../api/client';
import { directPrintAvailable, loadPrinterSettings, printLabelFile } from './labelPrinter';

/**
 * Скачать этикетку заказа (PDF или PNG) с сервера и напечатать: на выбранный Bluetooth-принтер этикеток,
 * а если он не настроен — через системный диалог печати.
 */
export async function printOrderLabel(orderId) {
  const id = String(orderId ?? '').trim();
  if (!id) throw new ApiError('Не указан заказ');

  const response = await fetch(apiUrl(`/orders/${encodeURIComponent(id)}/label`), {
    headers: { Accept: '*/*', ...authHeaders() },
  });
  if (!response.ok) {
    let message = '';
    try {
      const json = await response.json();
      message = json?.message || json?.error || '';
    } catch {
      message = '';
    }
    throw new ApiError(
      message || (response.status === 409 ? 'Этикетка ещё не готова' : `Этикетка недоступна (HTTP ${response.status})`),
      response.status
    );
  }

  const isPng = String(response.headers.get('content-type') || '').includes('image/png');
  const safeId = id.replace(/[^\w-]+/g, '_');
  const file = new File(Paths.cache, `label_${safeId}.${isPng ? 'png' : 'pdf'}`);
  if (file.exists) file.delete();
  file.write(await response.bytes());

  if (directPrintAvailable) {
    const settings = await loadPrinterSettings();
    if (settings.address) {
      await printLabelFile(file.uri, settings);
      return;
    }
  }

  if (isPng) {
    const b64 = await file.base64();
    await Print.printAsync({
      html: `<html><head><style>@page{margin:0}body{margin:0}</style></head><body><img src="data:image/png;base64,${b64}" style="width:100%"/></body></html>`,
    });
  } else {
    await Print.printAsync({ uri: file.uri });
  }
}

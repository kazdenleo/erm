import { fetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import { apiUrl, authHeaders, ApiError } from '../api/client';
import { directPrintAvailable, loadPrinterSettings, printLabelFile } from './labelPrinter';

async function downloadLabelToCache(path, params, filePrefix) {
  const response = await fetch(apiUrl(path, params), {
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
    throw new ApiError(message || `Этикетка недоступна (HTTP ${response.status})`, response.status);
  }

  const isPng = String(response.headers.get('content-type') || '').includes('image/png');
  const safe = String(filePrefix || 'label').replace(/[^\w-]+/g, '_');
  const file = new File(Paths.cache, `${safe}.${isPng ? 'png' : 'pdf'}`);
  if (file.exists) file.delete();
  file.write(await response.bytes());
  return { file, isPng };
}

async function sendLabelToPrinter(file, isPng, copies = 1) {
  const n = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));

  if (directPrintAvailable) {
    const settings = await loadPrinterSettings();
    if (settings.address) {
      for (let i = 0; i < n; i += 1) {
        await printLabelFile(file.uri, settings);
      }
      return;
    }
  }

  if (isPng) {
    const b64 = await file.base64();
    const img = `<img src="data:image/png;base64,${b64}" style="width:100%;page-break-after:always"/>`;
    await Print.printAsync({
      html: `<html><head><style>@page{margin:0}body{margin:0}</style></head><body>${img.repeat(n)}</body></html>`,
    });
  } else {
    for (let i = 0; i < n; i += 1) {
      await Print.printAsync({ uri: file.uri });
    }
  }
}

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
  await sendLabelToPrinter(file, isPng, 1);
}

/**
 * Этикетка ШК упаковки товара → Bluetooth-принтер или системный диалог.
 */
export async function printPackagingLabel(productId, { barcode, unitsPerBox, copies = 1 } = {}) {
  const id = String(productId ?? '').trim();
  const code = String(barcode || '').trim();
  if (!id || !code) throw new ApiError('Нет товара или штрихкода упаковки');

  const units = Math.floor(Number(unitsPerBox) || 0);
  const params = { format: 'png', barcode: code };
  if (units > 0) params.units = String(units);

  const { file, isPng } = await downloadLabelToCache(
    `/products/${encodeURIComponent(id)}/packaging-label`,
    params,
    `packaging_${id}_${code}`
  );
  await sendLabelToPrinter(file, isPng, copies);
}

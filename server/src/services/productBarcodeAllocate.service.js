/**
 * Выделение уникального штрихкода товара (WB API или внутренний EAN-13).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import {
  buildEan13,
  barcodesFromWbGeneratePayload,
  coerceBarcodeString,
  isCorruptBarcodeString,
} from '../utils/productBarcodes.js';

export async function generateWbBarcodeFromApi(ctx = {}) {
  const data = await integrationsService._wbContentApiPost(
    '/content/v2/barcodes',
    { count: 1 },
    { profileId: ctx.profileId, organizationId: ctx.organizationId }
  );
  const code = barcodesFromWbGeneratePayload(data)[0] || '';
  if (!code) {
    throw new Error('Wildberries не вернул штрихкод');
  }
  return code;
}

export async function barcodeTaken(code) {
  const s = coerceBarcodeString(code);
  if (!s || isCorruptBarcodeString(s)) return true;
  const r = await query('SELECT 1 FROM barcodes WHERE TRIM(barcode) = TRIM($1) LIMIT 1', [s]);
  return (r.rowCount || 0) > 0;
}

export async function allocateUniqueInternalEan13(productId) {
  const idNum = Number(productId) || 0;
  for (let i = 0; i < 40; i += 1) {
    const idPart = String(idNum % 100000).padStart(5, '0');
    const rand = String((Math.floor(Math.random() * 10000) + i) % 10000).padStart(4, '0');
    const code = buildEan13(`200${idPart}${rand}`);
    if (code && !(await barcodeTaken(code))) return code;
  }
  throw new Error('Не удалось сгенерировать уникальный штрихкод товара');
}

export async function allocateProductBarcode({ productId, profileId, organizationId } = {}) {
  let code = null;
  const orgId = organizationId ?? null;
  if (orgId != null && orgId !== '') {
    try {
      const generated = await generateWbBarcodeFromApi({
        profileId: profileId ?? null,
        organizationId: orgId,
      });
      if (generated && !isCorruptBarcodeString(generated) && !(await barcodeTaken(generated))) {
        code = generated;
      }
    } catch (e) {
      logger.info('[Barcode] WB API unavailable, using internal EAN-13', e?.message || e);
    }
  }
  if (!code) code = await allocateUniqueInternalEan13(productId);
  return code;
}

export default {
  generateWbBarcodeFromApi,
  allocateProductBarcode,
};

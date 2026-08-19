/**
 * Реестр адаптеров отправки закупки поставщику по API.
 */

import { canonicalSupplierApiCode } from '../../repositories/suppliers.repository.pg.js';
import { deleteMikadoBasketItems, submitMikadoPurchase } from './mikado.adapter.js';
import { submitMoskvorechiePurchase } from './moskvorechie.adapter.js';

const ADAPTERS = {
  mikado: submitMikadoPurchase,
  moskvorechie: submitMoskvorechiePurchase,
};

export function resolveSupplierOrderAdapter(supplierCode) {
  const code = canonicalSupplierApiCode(supplierCode);
  return ADAPTERS[code] || null;
}

export function supportedSupplierOrderApiCodes() {
  return Object.keys(ADAPTERS);
}

export { deleteMikadoBasketItems, submitMikadoPurchase, submitMoskvorechiePurchase };

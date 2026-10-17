/**
 * Адресное хранение: ячейки, закрепление товаров, перемещения, план склада.
 */

import api from './api';

const unwrap = (r) => r.data?.data ?? r.data;
const wh = (id) => `/address-storage/warehouses/${id}`;

let warehousesCache = null;
let warehousesCacheAt = 0;
const WAREHOUSES_TTL_MS = 60000;

export const addressStorageApi = {
  listWarehouses: async ({ force = false } = {}) => {
    if (!force && warehousesCache && Date.now() - warehousesCacheAt < WAREHOUSES_TTL_MS) {
      return warehousesCache;
    }
    const data = unwrap(await api.get('/address-storage/warehouses'));
    warehousesCache = data;
    warehousesCacheAt = Date.now();
    return data;
  },
  invalidateWarehouses: () => {
    warehousesCache = null;
  },

  getSettings: async (warehouseId) => unwrap(await api.get(`${wh(warehouseId)}/settings`)),
  saveSettings: async (warehouseId, body) => {
    const data = unwrap(await api.put(`${wh(warehouseId)}/settings`, body));
    warehousesCache = null;
    return data;
  },

  listLocations: async (warehouseId) => unwrap(await api.get(`${wh(warehouseId)}/locations`)),
  createLocation: async (warehouseId, body) => {
    const data = unwrap(await api.post(`${wh(warehouseId)}/locations`, body));
    warehousesCache = null;
    return data;
  },
  generateLocations: async (warehouseId, body) => {
    const data = unwrap(await api.post(`${wh(warehouseId)}/locations/generate`, body));
    warehousesCache = null;
    return data;
  },
  updateLocation: async (warehouseId, locationId, body) =>
    unwrap(await api.patch(`${wh(warehouseId)}/locations/${locationId}`, body)),
  bulkUpdateLocations: async (warehouseId, ids, patch) =>
    unwrap(await api.post(`${wh(warehouseId)}/locations/bulk-update`, { ids, patch })),
  deleteLocations: async (warehouseId, ids, { force = false } = {}) => {
    const data = unwrap(await api.post(`${wh(warehouseId)}/locations/delete`, { ids, force }));
    warehousesCache = null;
    return data;
  },
  renumberRoute: async (warehouseId, strategy) =>
    unwrap(await api.post(`${wh(warehouseId)}/locations/renumber`, { strategy })),
  labelsPdf: async (warehouseId, ids) => {
    const r = await api.post(`${wh(warehouseId)}/locations/labels`, { ids }, { responseType: 'blob', timeout: 180000 });
    return r.data;
  },

  searchProducts: async (warehouseId, q) =>
    unwrap(await api.get(`${wh(warehouseId)}/products`, { params: { q } })),
  assignProduct: async (warehouseId, productId, locationId) =>
    unwrap(await api.put(`${wh(warehouseId)}/assignments`, { productId, locationId })),
  importAssignments: async (warehouseId, text) =>
    unwrap(await api.post(`${wh(warehouseId)}/assignments/import`, { text })),

  resolveScan: async (warehouseId, code) =>
    unwrap(await api.get(`${wh(warehouseId)}/resolve`, { params: { code } })),
  moveStock: async (warehouseId, body) => unwrap(await api.post(`${wh(warehouseId)}/moves`, body)),
  placeUnplacedToAssigned: async (warehouseId) =>
    unwrap(await api.post(`${wh(warehouseId)}/moves/place-assigned`, {})),
  listMovements: async (warehouseId, params = {}) =>
    unwrap(await api.get(`${wh(warehouseId)}/movements`, { params })),
  listPending: async (warehouseId, kind) =>
    unwrap(await api.get(`${wh(warehouseId)}/pending`, { params: { kind } })),

  getHeatmap: async (warehouseId, days = 30) =>
    unwrap(await api.get(`${wh(warehouseId)}/heatmap`, { params: { days } })),
  getLayout: async (warehouseId) => unwrap(await api.get(`${wh(warehouseId)}/layout`)),
  saveLayout: async (warehouseId, body) => unwrap(await api.put(`${wh(warehouseId)}/layout`, body)),

  productLocations: async (productId) => unwrap(await api.get(`/address-storage/products/${productId}`)),
  lookup: async (productIds) => unwrap(await api.post('/address-storage/lookup', { productIds })),
};

/** Сообщение об ошибке API и код из details (LOCATION_HAS_STOCK и т.п.). */
export function addressStorageError(e) {
  const data = e?.response?.data;
  return {
    message: data?.message || e?.message || 'Ошибка',
    code: data?.details?.code || null,
  };
}

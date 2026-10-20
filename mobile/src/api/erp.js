import { request } from './client';

const unwrap = (json) => json?.data ?? json;
const listOf = (json) => {
  const d = unwrap(json);
  return Array.isArray(d) ? d : [];
};

/** Ответ /orders бывает массивом, { data: [] } или { data: { orders: [] } }. */
function ordersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.orders)) return payload.data.orders;
  if (Array.isArray(payload?.orders)) return payload.orders;
  return [];
}

export const authApi = {
  login: (login, password) =>
    request('/auth/login', { method: 'POST', body: { login, password }, withContext: false }).then(unwrap),
  me: () => request('/auth/me', { withContext: false }).then(unwrap),
};

export const organizationsApi = {
  list: () => request('/organizations').then(listOf),
};

export const warehousesApi = {
  list: (organizationId) => request('/warehouses', { params: { organizationId } }).then(listOf),
};

export const suppliersApi = {
  list: () => request('/suppliers').then(listOf),
};

export const productsApi = {
  byBarcode: (code) => request(`/products/by-barcode/${encodeURIComponent(code)}`).then(unwrap),
};

export const ordersApi = {
  listInAssembly: () => ordersApi.listByStatus('in_assembly'),
  listByStatus: (status) =>
    request('/orders', {
      params: { status, limit: 500, skipAutoReserve: '1' },
      timeoutMs: 60000,
    }).then(ordersList),
  sendToAssembly: (items) =>
    request('/orders/send-to-assembly', {
      method: 'POST',
      body: { orderIds: items },
      timeoutMs: 120000,
    }).then(unwrap),
  labelStatus: (orderId) =>
    request(`/orders/${encodeURIComponent(orderId)}/label/status`, { timeoutMs: 20000 }).then(unwrap),
};

export const assemblyApi = {
  findByBarcode: (barcode, { marketplace, preferOrderId, preferMarketplace, listOrder } = {}) => {
    const body = { barcode: String(barcode).trim() };
    if (marketplace && marketplace !== 'all') body.marketplace = marketplace;
    if (preferOrderId) {
      body.preferOrderId = String(preferOrderId);
      if (preferMarketplace && preferMarketplace !== 'all') body.preferMarketplace = preferMarketplace;
    }
    if (Array.isArray(listOrder) && listOrder.length) body.listOrder = listOrder;
    return request('/assembly/find-by-barcode', { method: 'POST', body }).then(unwrap);
  },
  markCollected: (marketplace, orderId, { stickerNumber = null, pickedItems = null } = {}) => {
    const body = { marketplace: String(marketplace), orderId: String(orderId) };
    const sn = stickerNumber != null ? String(stickerNumber).trim() : '';
    if (sn) body.stickerNumber = sn;
    if (Array.isArray(pickedItems) && pickedItems.length) body.pickedItems = pickedItems;
    return request('/assembly/mark-collected', { method: 'POST', body, timeoutMs: 120000 }).then(unwrap);
  },
};

export const cargoApi = {
  listPurchases: (search) => request('/purchase-cargo/purchases', { params: { search } }).then(listOf),
  getPurchase: (purchaseId) => request(`/purchase-cargo/purchases/${purchaseId}`).then(unwrap),
  setExpected: (purchaseId, expectedCargoPlaces) =>
    request(`/purchase-cargo/purchases/${purchaseId}/expected`, {
      method: 'PUT',
      body: { expectedCargoPlaces },
    }).then(unwrap),
  acceptPlace: (purchaseId, barcode, { force = false, forceExceed = false } = {}) =>
    request(`/purchase-cargo/purchases/${purchaseId}/places`, {
      method: 'POST',
      body: { barcode, force, forceExceed },
    }).then(unwrap),
  getPlace: (placeId) => request(`/purchase-cargo/places/${placeId}`).then(unwrap),
  removePlace: (placeId) => request(`/purchase-cargo/places/${placeId}/remove`, { method: 'POST' }).then(unwrap),
  openPlace: (placeId) => request(`/purchase-cargo/places/${placeId}/open`, { method: 'POST' }).then(unwrap),
  closePlace: (placeId) => request(`/purchase-cargo/places/${placeId}/close`, { method: 'POST' }).then(unwrap),
  addItem: (placeId, { code = null, productId = null, quantity = 1 }) =>
    request(`/purchase-cargo/places/${placeId}/items`, {
      method: 'POST',
      body: { code, productId, quantity },
    }).then(unwrap),
  setItemQuantity: (placeId, productId, quantity) =>
    request(`/purchase-cargo/places/${placeId}/items/set`, {
      method: 'POST',
      body: { productId, quantity },
    }).then(unwrap),
};

/** Приёмка грузомест без закупки. */
export const cargoBatchesApi = {
  list: (status = 'open') => request('/cargo-batches/batches', { params: { status } }).then(listOf),
  create: ({ warehouseId, organizationId, expectedPlaces, note }) =>
    request('/cargo-batches/batches', {
      method: 'POST',
      body: { warehouseId, organizationId, expectedPlaces, note },
    }).then(unwrap),
  get: (batchId) => request(`/cargo-batches/batches/${batchId}`).then(unwrap),
  setExpected: (batchId, expectedPlaces) =>
    request(`/cargo-batches/batches/${batchId}/expected`, {
      method: 'PUT',
      body: { expectedPlaces },
    }).then(unwrap),
  acceptPlace: (batchId, barcode, { force = false } = {}) =>
    request(`/cargo-batches/batches/${batchId}/places`, {
      method: 'POST',
      body: { barcode, force },
    }).then(unwrap),
  complete: (batchId, { supplierId, organizationId } = {}) =>
    request(`/cargo-batches/batches/${batchId}/complete`, {
      method: 'POST',
      body: { supplierId, organizationId },
      timeoutMs: 120000,
    }).then(unwrap),
  getPlace: (placeId) => request(`/cargo-batches/places/${placeId}`).then(unwrap),
  removePlace: (placeId) => request(`/cargo-batches/places/${placeId}/remove`, { method: 'POST' }).then(unwrap),
  openPlace: (placeId) => request(`/cargo-batches/places/${placeId}/open`, { method: 'POST' }).then(unwrap),
  closePlace: (placeId) => request(`/cargo-batches/places/${placeId}/close`, { method: 'POST' }).then(unwrap),
  addItem: (placeId, { code = null, productId = null, quantity = 1 }) =>
    request(`/cargo-batches/places/${placeId}/items`, {
      method: 'POST',
      body: { code, productId, quantity },
    }).then(unwrap),
  setItemQuantity: (placeId, productId, quantity) =>
    request(`/cargo-batches/places/${placeId}/items/set`, {
      method: 'POST',
      body: { productId, quantity },
    }).then(unwrap),
};

export const purchasesApi = {
  completeReceipt: (receiptId, warehouseId) =>
    request(`/purchases/receipts/${receiptId}/complete`, {
      method: 'POST',
      body: warehouseId ? { warehouseId } : {},
      timeoutMs: 120000,
    }).then(unwrap),
};

export const receiptsApi = {
  createSession: (warehouseId) =>
    request('/receipts/sessions', { method: 'POST', body: { warehouseId } }).then(unwrap),
  getSession: (sessionId) => request(`/receipts/sessions/${encodeURIComponent(sessionId)}`).then(unwrap),
  addQuantity: (sessionId, { code, quantity, cost = null }) =>
    request(`/receipts/sessions/${encodeURIComponent(sessionId)}/add-quantity`, {
      method: 'POST',
      body: { code, quantity, cost },
    }).then(unwrap),
  setQuantity: (sessionId, productId, quantity) =>
    request(`/receipts/sessions/${encodeURIComponent(sessionId)}/set-quantity`, {
      method: 'POST',
      body: { productId, quantity },
    }).then(unwrap),
  complete: (sessionId, { supplierId, organizationId }) =>
    request(`/receipts/sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      body: { supplierId, organizationId },
      timeoutMs: 60000,
    }).then(unwrap),
};

export const addressStorageApi = {
  listWarehouses: () => request('/address-storage/warehouses').then(listOf),
  lookup: (productIds) =>
    request('/address-storage/lookup', {
      method: 'POST',
      body: { productIds: Array.isArray(productIds) ? productIds : [] },
    }).then(unwrap),
};

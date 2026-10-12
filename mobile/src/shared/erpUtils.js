// Общие чистые функции веб-клиента ERP (подключены через watchFolders в metro.config.js).
export {
  applyAssemblyBarcodeScan,
  applyAssemblyPickScan,
  assemblyLineScanKey,
  assemblyPickedItemsList,
  isAssemblyCompositionComplete,
  isKitSkuScanForOrder,
  isRootKitSkuScanForOrder,
  orderItemMatchesScannedProduct,
  scannedProductStillNeededOnOrder,
  scannedQtyForAssemblyLine,
} from '../../../client/src/utils/assemblyKitScan.js';
export {
  normalizeMarketplaceForUI,
  orderGroupKey,
  singleOrderListGroupKey,
} from '../../../client/src/utils/orderListGroupKey.js';
export { orderStickerCellValue, splitStickerEmphasis } from '../../../client/src/utils/orderStickerDisplay.js';

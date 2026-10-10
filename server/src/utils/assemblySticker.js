import { isOzonLabelStickerNumber } from './ozonPosting.js';

/**
 * Есть ли у заказа номер стикера маркетплейса — без него заказ на сборке не собираем.
 * WB/Ozon: номер приходит вместе с этикеткой; Яндекс и ручные заказы стикера не требуют.
 */
export function orderHasAssemblySticker(order) {
  if (!order) return false;
  const mp = String(order.marketplace ?? '').trim().toLowerCase();
  const sn = String(order.assemblyStickerNumber ?? order.assembly_sticker_number ?? '').trim();
  if (mp === 'wb' || mp === 'wildberries') return sn !== '';
  if (mp === 'ozon') return isOzonLabelStickerNumber(sn);
  return true;
}

export const NO_STICKER_ASSEMBLY_MESSAGE =
  'У заказа нет стикера маркетплейса — собирать его нельзя. Обновите стикер кнопкой с часами в строке заказа.';

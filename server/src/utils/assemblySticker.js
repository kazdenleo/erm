import { isOzonLabelStickerNumber } from './ozonPosting.js';

/**
 * Можно ли собирать заказ: у WB нужен номер стикера (он появляется после добавления в поставку).
 * Ozon — номер `ii…` с этикетки либо уже скачанная этикетка: у части отправлений
 * (сортировочный центр) Ozon печатает только номер отправления и scanit не отдаёт.
 * Яндекс и ручные заказы стикера не требуют.
 * @param {object} order
 * @param {{ isLabelCached?: (order: object) => boolean }} [opts]
 */
export function orderHasAssemblySticker(order, { isLabelCached = null } = {}) {
  if (!order) return false;
  const mp = String(order.marketplace ?? '').trim().toLowerCase();
  const sn = String(order.assemblyStickerNumber ?? order.assembly_sticker_number ?? '').trim();
  if (mp === 'wb' || mp === 'wildberries') return sn !== '';
  if (mp === 'ozon') {
    if (isOzonLabelStickerNumber(sn)) return true;
    return typeof isLabelCached === 'function' && isLabelCached(order) === true;
  }
  return true;
}

export const NO_STICKER_ASSEMBLY_MESSAGE =
  'У заказа нет стикера маркетплейса — собирать его нельзя. Обновите стикер кнопкой с часами в строке заказа.';

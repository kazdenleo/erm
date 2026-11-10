/** Покрытие строки FBO: с наличия, с пути, не покрыто резервом, итого. */
export function getFboItemReserveParts(item, plannedQty = null) {
  const stock = Number(item?.reservedFromStock ?? item?.reserved_from_stock) || 0;
  const incoming = Number(item?.reservedFromIncoming ?? item?.reserved_from_incoming) || 0;
  const total = stock + incoming;
  const planned =
    plannedQty != null
      ? Math.max(0, Number(plannedQty) || 0)
      : Math.max(0, Number(item?.quantity) || 0);
  const unreserved = Math.max(0, planned - total);
  return { stock, incoming, total, planned, unreserved };
}

/**
 * Текст для title при наведении на количество штук в поставке.
 * @param {{ stock?: number, incoming?: number, unreserved?: number, planned?: number, reserveDisabled?: boolean }} parts
 */
export function formatFboReserveHoverTitle({
  stock = 0,
  incoming = 0,
  unreserved = 0,
  planned = null,
  reserveDisabled = false,
} = {}) {
  if (reserveDisabled) {
    return 'Резерв выключен. Включите «Списать остатки при отгрузке», чтобы резервировать товар.';
  }
  const lines = [
    planned != null && Number.isFinite(Number(planned)) ? `В поставке: ${Number(planned) || 0} шт.` : null,
    `В наличии: ${Number(stock) || 0}`,
    `В пути: ${Number(incoming) || 0}`,
    `Не в резерве: ${Number(unreserved) || 0}`,
  ].filter(Boolean);
  return lines.join('\n');
}

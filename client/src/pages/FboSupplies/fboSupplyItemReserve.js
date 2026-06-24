/** Покрытие строки FBO: с наличия, с пути и итого. */
export function getFboItemReserveParts(item) {
  const stock = Number(item?.reservedFromStock ?? item?.reserved_from_stock) || 0;
  const incoming = Number(item?.reservedFromIncoming ?? item?.reserved_from_incoming) || 0;
  return { stock, incoming, total: stock + incoming };
}

function gcd(a, b) {
  let x = Math.abs(Math.floor(Number(a)) || 0);
  let y = Math.abs(Math.floor(Number(b)) || 0);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Кратно сколько заказывать: если за период товар уходил только в комплектах — НОД количеств в составе. */
export function orderMultipleFromKits(directQty, kitComponentQtys) {
  if ((Number(directQty) || 0) > 0) return 1;
  const qtys = [...new Set((kitComponentQtys || []).map((q) => Math.max(1, Math.floor(Number(q) || 1))))];
  if (!qtys.length) return 1;
  const g = qtys.reduce((acc, q) => gcd(acc, q), qtys[0]);
  return g >= 2 ? g : 1;
}

/** Округляем заказ вверх так, чтобы (свободно + в пути + заказ) было кратно шагу. */
export function toOrderRounded({ need, available, incoming, orderMultiple }) {
  const coverNeed = Math.max(0, Math.ceil(Number(need) || 0));
  const avail = Math.max(0, Number(available) || 0);
  const inc = Math.max(0, Number(incoming) || 0);
  const raw = Math.max(0, coverNeed - avail - inc);
  const step = Math.max(1, Math.floor(Number(orderMultiple) || 1));
  if (step <= 1 || raw <= 0) return raw;
  const target = avail + inc + raw;
  const roundedTarget = Math.ceil(target / step) * step;
  return Math.max(0, roundedTarget - avail - inc);
}

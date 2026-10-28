import { ozonPromoPort } from './ports/ozon.js';
import { wbPromoPort } from './ports/wb.js';
import { ymPromoPort } from './ports/ym.js';

const PORTS = {
  ozon: ozonPromoPort,
  wb: wbPromoPort,
  ym: ymPromoPort,
};

export function getPromoPort(marketplace) {
  const id = String(marketplace || '').toLowerCase();
  const port = PORTS[id];
  if (!port) throw new Error(`Нет адаптера акций для маркетплейса: ${marketplace}`);
  return port;
}

export function listPromoPorts() {
  return Object.values(PORTS).map((port) => ({
    id: port.id,
    label: port.label || port.id,
    ready: port.ready !== false,
    capabilities: port.capabilities(),
  }));
}

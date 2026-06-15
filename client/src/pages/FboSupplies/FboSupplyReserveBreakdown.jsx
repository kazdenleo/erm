/**
 * Подпись резерва: с наличия / с пути.
 */

import React from 'react';

export function FboSupplyReserveBreakdown({
  reservedFromStock = 0,
  reservedFromIncoming = 0,
  inline = false,
  showEmpty = false,
}) {
  const stock = Number(reservedFromStock) || 0;
  const incoming = Number(reservedFromIncoming) || 0;
  if (stock <= 0 && incoming <= 0 && !showEmpty) return null;

  const parts = [];
  if (stock > 0) {
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part" title="Зарезервировано с наличия">
        нал: {stock}
      </span>
    );
  } else if (showEmpty) {
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty" title="С наличия на складе списания">
        нал: 0
      </span>
    );
  }
  if (incoming > 0) {
    parts.push(
      <span key="incoming" className="fbo-reserve-breakdown__part" title="Зарезервировано с пути">
        путь: {incoming}
      </span>
    );
  } else if (showEmpty) {
    parts.push(
      <span key="incoming" className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty" title="Из ожидаемых поступлений (в пути)">
        путь: 0
      </span>
    );
  }

  return (
    <span
      className={['fbo-reserve-breakdown', inline ? 'fbo-reserve-breakdown--inline' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {parts}
    </span>
  );
}

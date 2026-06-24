/**
 * Подпись резерва: с наличия / с пути.
 */

import React from 'react';

export function FboSupplyReserveBreakdown({
  reservedFromStock = 0,
  reservedFromIncoming = 0,
  sourceOnHand = null,
  sourceIncoming = null,
  reserveDisabled = false,
  inline = false,
  showEmpty = false,
}) {
  const stock = Number(reservedFromStock) || 0;
  const incoming = Number(reservedFromIncoming) || 0;
  const onHand = sourceOnHand != null ? Number(sourceOnHand) || 0 : null;
  const onPath = sourceIncoming != null ? Number(sourceIncoming) || 0 : null;

  if (reserveDisabled) {
    if (!showEmpty) return null;
    return (
      <span className="fbo-reserve-breakdown fbo-reserve-breakdown--disabled">
        <span
          className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty"
          title="Включите «Списать остатки при отгрузке», чтобы резервировать товар"
        >
          резерв выкл.
        </span>
      </span>
    );
  }

  if (stock <= 0 && incoming <= 0 && !showEmpty) return null;

  const parts = [];
  if (stock > 0) {
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part" title="С наличия на складах FBO и основном">
        нал: {stock}
      </span>
    );
  } else if (showEmpty) {
    const hint =
      onHand != null && onHand > 0
        ? `На складах ${onHand} шт., но не покрывает эту строку (занято заказами или более ранними поставками)`
        : 'Свободного наличия на складах FBO и основном нет';
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty" title={hint}>
        нал: 0
      </span>
    );
  }

  if (incoming > 0) {
    parts.push(
      <span key="incoming" className="fbo-reserve-breakdown__part" title="Из ожидаемых поступлений">
        путь: {incoming}
      </span>
    );
  } else if (showEmpty) {
    const hint =
      onPath != null && onPath > 0
        ? `В пути ${onPath} шт., но не выделено на эту строку`
        : 'Нет ожидаемых поступлений по этому товару';
    parts.push(
      <span
        key="incoming"
        className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty"
        title={hint}
      >
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

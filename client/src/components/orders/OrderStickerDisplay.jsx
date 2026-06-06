import React from 'react';
import {
  orderStickerCellValue,
  shouldEmphasizeStickerSuffix,
  splitStickerEmphasis,
} from '../../utils/orderStickerDisplay';

function WbStickerNumber({ text, className = '' }) {
  const parts = splitStickerEmphasis(text);
  if (!parts) return <span className={className}>—</span>;
  if (!parts.prefix) {
    return (
      <strong className={`order-sticker-suffix ${className}`.trim()}>{parts.suffix}</strong>
    );
  }
  return (
    <span className={`order-sticker-value ${className}`.trim()}>
      <span className="order-sticker-prefix">{parts.prefix}</span>
      {' '}
      <strong className="order-sticker-suffix">{parts.suffix}</strong>
    </span>
  );
}

/**
 * Стикер заказа: для WB последние 4 цифры крупнее; для Ozon/ЯМ — номер заказа как есть.
 */
export function OrderStickerDisplay({
  order,
  groupOrders = null,
  className = '',
  emphasize = null,
}) {
  const value = orderStickerCellValue(order, { groupOrders });
  if (value === '—') return <span className={className}>—</span>;

  const wbEmphasis = emphasize ?? shouldEmphasizeStickerSuffix(order);
  if (!wbEmphasis) {
    return <strong className={className}>{value}</strong>;
  }

  const stickers = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <span className={`order-sticker-display ${className}`.trim()}>
      {stickers.map((sticker, index) => (
        <React.Fragment key={`${sticker}-${index}`}>
          {index > 0 ? ', ' : null}
          <WbStickerNumber text={sticker} />
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * Логотип MySell: знак или знак + слово.
 */

import React from 'react';

export function BrandLogo({
  variant = 'full',
  className = '',
  title = 'MySell',
  height = 28,
}) {
  const src = variant === 'mark' ? '/logo-mysell-mark.svg' : '/logo-mysell.svg';
  const aspect = variant === 'mark' ? 1 : 220 / 48;
  const width = Math.round(height * aspect);

  return (
    <img
      src={src}
      alt={title}
      width={width}
      height={height}
      className={`brand-logo brand-logo--${variant}${className ? ` ${className}` : ''}`}
      draggable={false}
    />
  );
}

/**
 * Button Component
 * Переиспользуемый компонент кнопки
 */

import React from 'react';

export function Button({ 
  children, 
  onClick, 
  variant = 'primary', 
  type = 'button',
  disabled = false,
  className = '',
  size = 'medium',
  ...props 
}) {
  const v = variant === 'success' || variant === 'danger' || variant === 'warning' || variant === 'info'
    ? variant
    : variant === 'secondary'
      ? 'secondary'
      : 'primary';

  const s = size === 'small' ? 'btn-sm' : size === 'large' ? 'btn-lg' : '';
  const buttonClass = `btn btn-${v} ${s} ${className}`.replace(/\s+/g, ' ').trim();
  
  return (
    <button
      type={type}
      className={buttonClass}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}


/**
 * Modal Component
 * Компонент модального окна
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** usePortal=true: рендер в body — вложенные модалки не ломаются из‑за родительского диалога. */
export function Modal({
  isOpen,
  onClose,
  title,
  headerExtra = null,
  children,
  size = 'medium',
  closeOnBackdropClick = true,
  closeOnEscape = true,
  usePortal = true,
}) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (closeOnEscape && e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, closeOnEscape]);

  if (!isOpen) return null;

  const dialogSizeClass =
    size === 'small' ? 'modal-sm' :
      size === 'large' ? 'modal-lg' :
        size === 'xl' ? 'modal-xl' :
          size === 'full' ? 'modal-fullscreen' :
            '';

  const content = (
    <>
      <div className="modal-backdrop fade show modal-backdrop-erm" aria-hidden />
      <div
        className="modal fade show modal-erm"
        style={{ display: 'block' }}
        role="dialog"
        aria-modal="true"
        data-erm-size={size}
        onMouseDown={closeOnBackdropClick ? onClose : undefined}
      >
        <div
          className={`modal-dialog modal-dialog-centered ${dialogSizeClass}`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              {headerExtra ? <div className="modal-header-extra">{headerExtra}</div> : null}
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">{children}</div>
          </div>
        </div>
      </div>
    </>
  );

  if (usePortal && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}


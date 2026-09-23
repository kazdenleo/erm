/**
 * Modal Component
 * Компонент модального окна
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

const STACK_BASE_MODAL = 1150;
const STACK_STEP = 20;

/** Сколько portaled-модалок уже в DOM (текущая ещё не смонтирована). */
function countStackedModals() {
  if (typeof document === 'undefined') return 0;
  return document.querySelectorAll('.modal.modal-erm--stacked').length;
}

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
  scrollable = false,
}) {
  const modalRef = useRef(null);
  const wasOpenRef = useRef(false);
  const stackDepthRef = useRef(0);

  // Глубину фиксируем в момент открытия (сколько модалок уже в DOM).
  if (isOpen && usePortal && !wasOpenRef.current) {
    stackDepthRef.current = countStackedModals();
  }
  if (!isOpen) {
    stackDepthRef.current = 0;
  }
  wasOpenRef.current = Boolean(isOpen);

  const stackDepth = isOpen && usePortal ? stackDepthRef.current : 0;
  const zModal = STACK_BASE_MODAL + stackDepth * STACK_STEP;

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      // Не снимаем overflow, если ещё открыта другая модалка.
      if (!document.querySelector('.modal.modal-erm.show')) {
        document.body.style.overflow = '';
      }
    }

    return () => {
      if (!document.querySelector('.modal.modal-erm.show')) {
        document.body.style.overflow = '';
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return undefined;

    const handleEscape = (e) => {
      if (e.key !== 'Escape') return;
      // Сверху открыта portaled-модалка — закрываем только её, не родителя.
      if (!usePortal && document.querySelector('.modal.modal-erm--stacked')) {
        return;
      }
      if (usePortal) {
        const stacked = document.querySelectorAll('.modal.modal-erm--stacked');
        if (stacked.length > 0 && stacked[stacked.length - 1] !== modalRef.current) {
          return;
        }
      }
      onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, closeOnEscape, usePortal]);

  const dialogSizeClass = useMemo(
    () =>
      size === 'small'
        ? 'modal-sm'
        : size === 'large'
          ? 'modal-lg'
          : size === 'xl'
            ? 'modal-xl'
            : size === 'full'
              ? 'modal-fullscreen'
              : '',
    [size]
  );

  if (!isOpen) return null;

  const content = (
    <div
      ref={modalRef}
      className={`modal fade show modal-erm${usePortal ? ' modal-erm--stacked' : ''}`}
      style={{
        display: 'block',
        ...(usePortal ? { ['--erm-modal-dialog-z']: String(zModal) } : null),
      }}
      role="dialog"
      aria-modal="true"
      data-erm-size={size}
      data-erm-stack={usePortal ? String(stackDepth) : undefined}
      onMouseDown={closeOnBackdropClick ? onClose : undefined}
    >
      {/* Затемнение внутри модалки — всегда под .modal-dialog, без «двойных» полей */}
      <div className="modal-backdrop-erm modal-backdrop-erm--internal" aria-hidden />
      <div
        className={`modal-dialog ${dialogSizeClass}${scrollable ? ' modal-dialog-scrollable' : ''}`}
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
  );

  if (usePortal && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}

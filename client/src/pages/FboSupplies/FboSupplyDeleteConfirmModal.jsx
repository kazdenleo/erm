/**
 * Модалка подтверждения удаления FBO-поставки.
 */

import React from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';

export function FboSupplyDeleteConfirmModal({
  open,
  supplyLabel = null,
  deleting = false,
  onCancel,
  onConfirm,
}) {
  return (
    <Modal
      isOpen={!!open}
      onClose={deleting ? () => {} : onCancel}
      title="Удалить поставку?"
      size="small"
      closeOnBackdropClick={!deleting}
      closeOnEscape={!deleting}
    >
      <p style={{ marginTop: 0 }}>
        {supplyLabel ? (
          <>
            Удалить поставку <strong>{supplyLabel}</strong>?
          </>
        ) : (
          'Удалить эту поставку?'
        )}
      </p>
      <p className="text-muted" style={{ marginBottom: 16 }}>
        Связанные строки товаров и грузоместа будут удалены. Это действие нельзя отменить.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button type="button" variant="secondary" disabled={deleting} onClick={onCancel}>
          Отмена
        </Button>
        <Button type="button" variant="primary" disabled={deleting} onClick={onConfirm}>
          {deleting ? 'Удаление…' : 'Удалить'}
        </Button>
      </div>
    </Modal>
  );
}

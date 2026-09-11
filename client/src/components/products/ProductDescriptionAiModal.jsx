import React from 'react';
import { Modal } from '../common/Modal/Modal';
import { ProductDescriptionAiChat } from './ProductDescriptionAiChat.jsx';

export function ProductDescriptionAiModal({
  isOpen,
  onClose,
  productId = null,
  getDraft,
  onApply,
}) {
  if (!isOpen) return null;
  return (
    <Modal isOpen onClose={onClose} title="ИИ — описание" size="large" scrollable>
      <ProductDescriptionAiChat
        embedded
        productId={productId}
        getDraft={getDraft}
        onApply={(proposed, data) => {
          onApply?.(proposed, data);
          onClose?.();
        }}
      />
    </Modal>
  );
}

export default ProductDescriptionAiModal;

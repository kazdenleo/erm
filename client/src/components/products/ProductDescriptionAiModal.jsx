import React from 'react';
import { Modal } from '../common/Modal/Modal';
import { ProductDescriptionAiChat } from './ProductDescriptionAiChat.jsx';

export function ProductDescriptionAiModal({
  isOpen,
  onClose,
  productId = null,
  getDraft,
  onApply,
  settingsAttribute = null,
  onSettingsSaved,
  contextAttributes = [],
  title = 'ИИ — описание',
  outputDefs,
  examples,
  inputPlaceholder,
  saveOkMessage,
  missingAttrMessage,
}) {
  if (!isOpen) return null;
  return (
    <Modal isOpen onClose={onClose} title={title} size="large" scrollable>
      <ProductDescriptionAiChat
        embedded
        title={title}
        productId={productId}
        getDraft={getDraft}
        onApply={(proposed, data) => {
          onApply?.(proposed, data);
          onClose?.();
        }}
        settingsAttribute={settingsAttribute}
        onSettingsSaved={onSettingsSaved}
        contextAttributes={contextAttributes}
        outputDefs={outputDefs}
        examples={examples}
        inputPlaceholder={inputPlaceholder}
        saveOkMessage={saveOkMessage}
        missingAttrMessage={missingAttrMessage}
      />
    </Modal>
  );
}

export default ProductDescriptionAiModal;

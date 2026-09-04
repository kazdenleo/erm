import React, { useMemo, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import { AttributeEditorAiChat } from '../../products/AttributeEditorAiChat.jsx';
import { OzonVehicleApplicabilityEditor } from '../OzonVehicleApplicabilityEditor/OzonVehicleApplicabilityEditor.jsx';
import { attrAiChatEnabled } from '../../../utils/editableAttribute.js';
import { erpAttrEditorKey } from '../../../utils/aiAttributeEditorFields.js';
import {
  emptyVehicleRow,
  setVehicleGroupRows,
  vehicleGroupRows,
} from '../../../utils/ozonComplexAttributes.js';

export function EditableAttributeEditorModal({
  isOpen,
  onClose,
  attr,
  value,
  onApply,
  productId,
  getContext,
  vehicleGroups = [],
  ozonComplex,
  showAiChat = false,
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const [complexDraft, setComplexDraft] = useState(ozonComplex);
  const [openKey, setOpenKey] = useState(0);

  React.useEffect(() => {
    if (!isOpen) return;
    setDraft(String(value ?? ''));
    setComplexDraft(ozonComplex);
    setOpenKey((k) => k + 1);
  }, [isOpen, value, ozonComplex]);

  const primaryGroup = vehicleGroups[0] || null;
  const rows = useMemo(
    () => (primaryGroup ? vehicleGroupRows(complexDraft, primaryGroup.complexId) : []),
    [complexDraft, primaryGroup]
  );

  const outputFields = useMemo(() => {
    const list = [{ key: erpAttrEditorKey(attr?.id), label: attr?.name || 'Атрибут', type: 'text' }];
    if (primaryGroup) list.push({ key: 'vehicles', label: 'Автомобили Ozon', type: 'vehicles' });
    return list;
  }, [attr, primaryGroup]);

  const applyAi = (proposed) => {
    const key = erpAttrEditorKey(attr?.id);
    if (proposed?.[key] != null) setDraft(String(proposed[key]));
    if (Array.isArray(proposed?.vehicles_json) && primaryGroup) {
      const nextRows = proposed.vehicles_json.map((r) => ({
        mark: String(r.mark || ''),
        model: String(r.model || ''),
        modification: String(r.modification || ''),
      }));
      setComplexDraft(setVehicleGroupRows(complexDraft, primaryGroup.complexId, nextRows));
    }
  };

  if (!isOpen || !attr) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={attr.name || 'Редактирование'} size="xl" scrollable>
      <div key={openKey} className="row g-3">
        <div className={showAiChat && attrAiChatEnabled(attr) ? 'col-lg-7' : 'col-12'}>
          <label className="form-label small text-muted">Значение в ERP</label>
          <textarea
            className="form-control"
            rows={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {primaryGroup ? (
            <div className="mt-3">
              <OzonVehicleApplicabilityEditor
                rows={rows.length ? rows : [emptyVehicleRow()]}
                onChange={(next) =>
                  setComplexDraft(setVehicleGroupRows(complexDraft, primaryGroup.complexId, next))
                }
              />
            </div>
          ) : null}
        </div>
        {showAiChat && attrAiChatEnabled(attr) ? (
          <div className="col-lg-5">
            <AttributeEditorAiChat
              productId={productId}
              outputFields={outputFields}
              getContext={() => {
                const ctx = typeof getContext === 'function' ? getContext() : {};
                return { ...ctx, [erpAttrEditorKey(attr.id)]: draft };
              }}
              onApply={applyAi}
            />
          </div>
        ) : null}
      </div>
      <div className="d-flex justify-content-end gap-2 mt-3">
        <Button type="button" variant="secondary" size="small" onClick={onClose}>
          Отмена
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          onClick={() => {
            onApply?.({ value: draft, ozonComplex: complexDraft });
            onClose();
          }}
        >
          Применить
        </Button>
      </div>
    </Modal>
  );
}

export default EditableAttributeEditorModal;

import React, { useMemo, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import { OzonVehicleApplicabilityEditor } from '../OzonVehicleApplicabilityEditor/OzonVehicleApplicabilityEditor.jsx';
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
  vehicleGroups = [],
  ozonComplex,
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

  if (!isOpen || !attr) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={attr.name || 'Редактирование'} size="large" scrollable>
      <div key={openKey}>
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

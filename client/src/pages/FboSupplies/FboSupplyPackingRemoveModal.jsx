/**
 * Снятие лишнего товара из активного грузоместа: 1 скан = −1 шт.
 */

import React, { useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';

export function FboSupplyPackingRemoveModal({
  isOpen,
  onClose,
  supplyId,
  activeCargoUnitId,
  activeCargoBarcode,
  onPackingChange,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  const handleScan = async (trimmed) => {
    if (trimmed.length < 2 || loading) return;
    if (!activeCargoUnitId) {
      setError('Нет активного грузоместа — закройте окно и отсканируйте коробку');
      return;
    }
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const data = await fboSuppliesApi.packingScanRemove(supplyId, {
        barcode: trimmed,
        activeCargoUnitId,
      });
      if (data?.packing) {
        onPackingChange?.(data.packing, {
          supplyStatus: data.supplyStatus,
          packingAllMatch: data.packingAllMatch,
          statusReverted: data.statusReverted,
        });
      }
      setMsg(data?.message || 'Снято 1 шт.');
      playEventSound(SOUND_EVENTS.scan_ok);
    } catch (err) {
      playEventSound(SOUND_EVENTS.scan_error);
      setError(err.response?.data?.message || err.message || 'Не удалось снять товар');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Убрать товар из грузоместа" size="medium">
      <p className="text-muted small mb-2">
        Каждый скан уменьшает количество на <strong>1 шт.</strong> в активном грузоместе.
      </p>
      {activeCargoBarcode ? (
        <p className="mb-3">
          Грузоместо: <strong>{activeCargoBarcode}</strong>
        </p>
      ) : (
        <p className="alert alert-warning py-2 small mb-3">
          Сначала отсканируйте коробку на вкладке «Сборка».
        </p>
      )}
      <BarcodeScanField
        id="fbo-packing-remove-barcode"
        label="Штрихкод товара"
        className="form-control"
        placeholder="Сканируйте товар для удаления"
        loading={loading}
        disabled={loading || !activeCargoUnitId}
        onScan={handleScan}
      />
      {error ? (
        <p className="text-danger small mt-2 mb-0" role="alert">
          {error}
        </p>
      ) : null}
      {msg ? (
        <p className="text-success small mt-2 mb-0" role="status">
          {msg}
        </p>
      ) : null}
      <div className="d-flex flex-wrap gap-2 justify-content-end mt-3">
        <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
          Закрыть
        </Button>
      </div>
    </Modal>
  );
}

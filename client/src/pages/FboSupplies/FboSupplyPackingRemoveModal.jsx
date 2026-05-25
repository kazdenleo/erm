/**
 * Снятие лишнего товара из активного грузоместа: 1 скан = −1 шт.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
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
  const [barcodeInput, setBarcodeInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setBarcodeInput('');
      setError(null);
      setMsg(null);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = barcodeInput.trim();
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
      if (data?.packing) onPackingChange?.(data.packing);
      setMsg(data?.message || 'Снято 1 шт.');
      playEventSound(SOUND_EVENTS.scan_ok);
      setBarcodeInput('');
      setTimeout(() => inputRef.current?.focus(), 50);
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
      <form onSubmit={handleSubmit}>
        <label className="form-label" htmlFor="fbo-packing-remove-barcode">
          Штрихкод товара
        </label>
        <input
          id="fbo-packing-remove-barcode"
          ref={inputRef}
          type="text"
          className="form-control"
          value={barcodeInput}
          disabled={loading || !activeCargoUnitId}
          onChange={(e) => setBarcodeInput(e.target.value)}
          autoComplete="off"
          placeholder="Сканируйте товар для удаления"
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
          <Button
            type="submit"
            variant="primary"
            disabled={loading || !activeCargoUnitId}
          >
            {loading ? '…' : 'Сканировать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

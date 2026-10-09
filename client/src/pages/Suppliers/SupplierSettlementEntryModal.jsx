/**
 * Модалка ручной операции взаиморасчётов: оплата поставщику или корректировка баланса
 */

import React, { useEffect, useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { suppliersApi } from '../../services/suppliers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { describeBalance, formatMoney, parseMoneyInput, todayIsoDate } from './settlementFormat';

export function SupplierSettlementEntryModal({ isOpen, supplierId, initialKind = 'payment', currentBalance = 0, onClose, onSaved }) {
  const [kind, setKind] = useState(initialKind);
  const [adjustMode, setAdjustMode] = useState('target');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIsoDate());
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setKind(initialKind);
    setAdjustMode('target');
    setAmount('');
    setDate(todayIsoDate());
    setComment('');
    setError(null);
  }, [isOpen, initialKind]);

  const parsed = parseMoneyInput(amount);
  let resultBalance = null;
  if (Number.isFinite(parsed)) {
    if (kind === 'payment') resultBalance = currentBalance - parsed;
    else if (adjustMode === 'target') resultBalance = parsed;
    else resultBalance = currentBalance + parsed;
  }

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!Number.isFinite(parsed)) {
      setError('Укажите сумму');
      return;
    }
    if (kind === 'payment' && parsed <= 0) {
      setError('Сумма оплаты должна быть больше нуля');
      return;
    }
    if (kind === 'adjustment' && adjustMode === 'delta' && parsed === 0) {
      setError('Сумма корректировки не может быть нулевой');
      return;
    }
    const payload = { kind, date, comment: comment.trim() };
    if (kind === 'adjustment' && adjustMode === 'target') {
      payload.targetBalance = parsed;
      if (!payload.comment) payload.comment = `Установлен баланс ${formatMoney(parsed)}`;
    } else {
      payload.amount = parsed;
    }
    setSaving(true);
    setError(null);
    try {
      await suppliersApi.createSettlementEntry(supplierId, payload);
      onSaved?.();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось сохранить операцию'));
    } finally {
      setSaving(false);
    }
  };

  const current = describeBalance(currentBalance);
  const result = resultBalance != null ? describeBalance(resultBalance) : null;

  let amountLabel = 'Сумма оплаты, ₽';
  let amountPlaceholder = '10 000';
  if (kind === 'adjustment' && adjustMode === 'target') {
    amountLabel = 'Итоговый баланс, ₽';
    amountPlaceholder = 'Положительный — наш долг, отрицательный — переплата';
  } else if (kind === 'adjustment') {
    amountLabel = 'Изменение баланса, ₽';
    amountPlaceholder = '+ увеличить наш долг, − уменьшить';
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={kind === 'payment' ? 'Оплата поставщику' : 'Корректировка баланса'}
      size="medium"
    >
      <form onSubmit={handleSubmit}>
        <div className="btn-group w-100 mb-3" role="group">
          <button
            type="button"
            className={`btn btn-sm ${kind === 'payment' ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => setKind('payment')}
          >
            Оплата
          </button>
          <button
            type="button"
            className={`btn btn-sm ${kind === 'adjustment' ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => setKind('adjustment')}
          >
            Корректировка
          </button>
        </div>

        {kind === 'adjustment' ? (
          <div className="d-flex flex-wrap gap-3 mb-3">
            <label className="form-check">
              <input
                type="radio"
                className="form-check-input"
                checked={adjustMode === 'target'}
                onChange={() => setAdjustMode('target')}
              />
              <span className="form-check-label">Установить итоговый баланс</span>
            </label>
            <label className="form-check">
              <input
                type="radio"
                className="form-check-input"
                checked={adjustMode === 'delta'}
                onChange={() => setAdjustMode('delta')}
              />
              <span className="form-check-label">Изменить на сумму</span>
            </label>
          </div>
        ) : null}

        <div className="row g-3">
          <div className="col-md-7">
            <label className="form-label" htmlFor="settlementAmount">{amountLabel}</label>
            <input
              id="settlementAmount"
              type="text"
              inputMode="decimal"
              className="form-control form-control-sm"
              placeholder={amountPlaceholder}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
            />
          </div>
          <div className="col-md-5">
            <label className="form-label" htmlFor="settlementDate">Дата</label>
            <input
              id="settlementDate"
              type="date"
              className="form-control form-control-sm"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div className="col-12">
            <label className="form-label" htmlFor="settlementComment">Комментарий</label>
            <input
              id="settlementComment"
              type="text"
              className="form-control form-control-sm"
              placeholder={kind === 'payment' ? 'Номер платёжки, счёт…' : 'Причина корректировки'}
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <div className="supplier-settlements__preview">
          <div>
            Сейчас: <strong>{current.label}{current.amount ? ` ${formatMoney(current.amount)}` : ''}</strong>
          </div>
          {result ? (
            <div>
              После операции:{' '}
              <strong className={`supplier-settlements__tone--${result.tone}`}>
                {result.label}{result.amount ? ` ${formatMoney(result.amount)}` : ''}
              </strong>
            </div>
          ) : null}
        </div>

        {error ? <div className="error" style={{ marginTop: '12px' }}>{error}</div> : null}

        <div className="d-flex justify-content-end gap-2 mt-4">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={saving}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

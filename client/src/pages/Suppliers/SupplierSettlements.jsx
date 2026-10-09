/**
 * SupplierSettlements Page
 * Взаиморасчёты с поставщиком: баланс, журнал операций, оплаты и корректировки
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { suppliersApi } from '../../services/suppliers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { SupplierSettlementEntryModal } from './SupplierSettlementEntryModal';
import {
  SETTLEMENT_OPERATION_LABELS,
  describeBalance,
  formatDateTime,
  formatMoney,
} from './settlementFormat';
import './Suppliers.css';

export function SupplierSettlements() {
  const { supplierId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalKind, setModalKind] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await suppliersApi.getSettlements(supplierId));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось загрузить взаиморасчёты'));
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDeleteEntry = async (op) => {
    const label = SETTLEMENT_OPERATION_LABELS[op.type] || 'операцию';
    if (!window.confirm(`Удалить «${label}» на ${formatMoney(Math.abs(op.amount))}?`)) return;
    try {
      await suppliersApi.deleteSettlementEntry(supplierId, op.entryId);
      await load();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Не удалось удалить операцию'));
    }
  };

  if (loading && !data) {
    return <div className="loading">Загрузка взаиморасчётов...</div>;
  }

  if (error || !data) {
    return (
      <div className="card">
        <Link to="/suppliers" className="supplier-settlements__back">← К списку поставщиков</Link>
        <div className="error">{error || 'Поставщик не найден'}</div>
      </div>
    );
  }

  const { supplier, summary, operations } = data;
  const balance = describeBalance(summary.balance);

  return (
    <div className="card">
      <Link to="/suppliers" className="supplier-settlements__back">← К списку поставщиков</Link>
      <div className="supplier-settlements__header">
        <div>
          <h1 className="title" style={{ marginBottom: 4 }}>Взаиморасчёты: {supplier.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Приёмки увеличивают наш долг, возвраты поставщику и оплаты — уменьшают
          </p>
        </div>
        <div className="supplier-settlements__actions">
          <Button variant="primary" size="small" onClick={() => setModalKind('payment')}>
            💳 Оплата
          </Button>
          <Button variant="secondary" size="small" onClick={() => setModalKind('adjustment')}>
            ✏️ Корректировка
          </Button>
        </div>
      </div>

      <div className="supplier-settlements__stats">
        <div className={`supplier-settlements__stat supplier-settlements__stat--main supplier-settlements__stat--${balance.tone}`}>
          <div className="supplier-settlements__stat-label">{balance.label}</div>
          <div className="supplier-settlements__stat-value">{formatMoney(balance.amount)}</div>
        </div>
        <div className="supplier-settlements__stat">
          <div className="supplier-settlements__stat-label">Принято товара</div>
          <div className="supplier-settlements__stat-value">{formatMoney(summary.received)}</div>
        </div>
        <div className="supplier-settlements__stat">
          <div className="supplier-settlements__stat-label">Возвращено поставщику</div>
          <div className="supplier-settlements__stat-value">{formatMoney(summary.returned)}</div>
        </div>
        <div className="supplier-settlements__stat">
          <div className="supplier-settlements__stat-label">Оплачено</div>
          <div className="supplier-settlements__stat-value">{formatMoney(summary.paid)}</div>
        </div>
        <div className="supplier-settlements__stat">
          <div className="supplier-settlements__stat-label">Корректировки</div>
          <div className="supplier-settlements__stat-value">{formatMoney(summary.adjusted)}</div>
        </div>
      </div>

      <h3 className="supplier-settlements__section-title">Операции</h3>
      {operations.length === 0 ? (
        <div className="empty-state">
          <p>Операций пока нет</p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className={`table${loading ? ' supplier-settlements__table--loading' : ''}`}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Операция</th>
                <th style={{ textAlign: 'right' }}>Долг +</th>
                <th style={{ textAlign: 'right' }}>Долг −</th>
                <th style={{ textAlign: 'right' }}>Баланс</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={op.key}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(op.occurredAt)}</td>
                  <td>
                    <div>
                      {SETTLEMENT_OPERATION_LABELS[op.type] || op.type}
                      {op.documentNumber ? <span className="text-muted"> · {op.documentNumber}</span> : null}
                    </div>
                    {op.missingCostLines > 0 ? (
                      <div className="supplier-settlements__warn">
                        ⚠ Без себестоимости строк: {op.missingCostLines} — учтены как 0 ₽
                      </div>
                    ) : null}
                    {op.comment ? <div className="text-muted small">{op.comment}</div> : null}
                    {op.createdBy ? <div className="text-muted small">{op.createdBy}</div> : null}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {op.amount > 0 ? formatMoney(op.amount) : ''}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {op.amount < 0 ? formatMoney(-op.amount) : ''}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{formatMoney(op.balanceAfter)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {op.entryId ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => handleDeleteEntry(op)}
                        style={{ padding: '4px 8px', color: '#fca5a5', borderColor: '#fca5a5' }}
                        title="Удалить операцию"
                      >
                        🗑️
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SupplierSettlementEntryModal
        isOpen={modalKind != null}
        supplierId={supplier.id}
        initialKind={modalKind || 'payment'}
        currentBalance={summary.balance}
        onClose={() => setModalKind(null)}
        onSaved={() => {
          setModalKind(null);
          void load();
        }}
      />
    </div>
  );
}

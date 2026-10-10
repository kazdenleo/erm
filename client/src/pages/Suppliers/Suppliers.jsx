/**
 * Suppliers Page
 * Страница управления поставщиками
 */

import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSuppliers } from '../../hooks/useSuppliers';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { SupplierForm } from '../../components/forms/SupplierForm/SupplierForm';
import { suppliersApi } from '../../services/suppliers.api';
import { autoOrderSettingsFromApiConfig } from '../../utils/supplierAutoOrderSettings';
import { formatSupplierWarehouseOrderWindow } from '../../utils/supplierWarehouseArrival';
import { describeBalance, formatMoney, formatSignedBalance } from './settlementFormat';
import './Suppliers.css';

export function Suppliers() {
  const navigate = useNavigate();
  const { suppliers, loading, error, createSupplier, updateSupplier, deleteSupplier, loadSuppliers } = useSuppliers();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [balances, setBalances] = useState(null);

  useEffect(() => {
    let cancelled = false;
    suppliersApi
      .getSettlementBalances()
      .then((rows) => {
        if (cancelled) return;
        setBalances(new Map(rows.map((r) => [String(r.supplierId), r])));
      })
      .catch((err) => {
        console.error('Error loading supplier balances:', err);
        if (!cancelled) setBalances(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const renderBalance = (supplierId) => {
    if (balances == null) return <span className="text-muted">…</span>;
    const row = balances.get(String(supplierId));
    const b = describeBalance(row?.balance);
    return (
      <Link to={`/suppliers/${supplierId}/settlements`} className="suppliers-balance" title="Открыть взаиморасчёты">
        {b.tone === 'neutral' ? (
          <span className="text-muted">{b.label}</span>
        ) : (
          <span className={`supplier-settlements__tone--${b.tone}`} title={`${b.label} ${formatMoney(b.amount)}`}>
            {formatSignedBalance(row.balance)}
          </span>
        )}
      </Link>
    );
  };

  const handleCreate = () => {
    setEditingSupplier(null);
    setIsModalOpen(true);
  };

  const handleEdit = (supplier) => {
    setEditingSupplier(supplier);
    setIsModalOpen(true);
  };

  const handleSubmit = async (supplierData) => {
    try {
      console.log('[Suppliers] Submitting supplier data:', supplierData);
      if (editingSupplier) {
        const result = await updateSupplier(editingSupplier.id, supplierData);
        console.log('[Suppliers] Update result:', result);
      } else {
        const result = await createSupplier(supplierData);
        console.log('[Suppliers] Create result:', result);
      }
      setIsModalOpen(false);
      setEditingSupplier(null);
      // Перезагружаем список поставщиков, чтобы увидеть обновленные данные
      if (loadSuppliers) {
        await loadSuppliers();
      }
    } catch (error) {
      console.error('Error saving supplier:', error);
      alert('Ошибка сохранения поставщика: ' + error.message);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этого поставщика?')) {
      try {
        await deleteSupplier(id);
      } catch (error) {
        console.error('Error deleting supplier:', error);
        alert('Ошибка удаления поставщика: ' + error.message);
      }
    }
  };

  if (loading) {
    return <div className="loading">Загрузка поставщиков...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      <h1 className="title">🚛 Поставщики</h1>
      <p className="subtitle">Управление поставщиками и их настройками</p>
      
      <div className="actions">
        <Button variant="primary" onClick={handleCreate}>➕ Добавить поставщика</Button>
      </div>

      <div className="suppliers-list" style={{marginTop: '20px'}}>
        {suppliers.length === 0 ? (
          <div className="empty-state">
            <p>Поставщики не найдены</p>
          </div>
        ) : (
          <table className="suppliers-table table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Название</th>
                <th>Склады</th>
                <th>Автозаказ</th>
                <th>Активен</th>
                <th style={{textAlign: 'right'}} title="Со знаком минус — наш долг поставщику, без минуса — переплата">Баланс</th>
                <th style={{textAlign: 'right'}}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map(s => {
                const warehouses = s.apiConfig?.warehouses || [];
                const auto = autoOrderSettingsFromApiConfig(s.apiConfig);
                return (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>
                    {s.name}
                    {auto.isPriority ? (
                      <span className="badge bg-primary ms-1" title="Приоритетный поставщик">★</span>
                    ) : null}
                  </td>
                  <td>
                    {warehouses.length > 0 ? (
                      <div style={{fontSize: '13px'}}>
                        {warehouses.map((w, idx) => (
                          <div key={idx} style={{marginBottom: '4px'}}>
                            <strong>{w.name}</strong> — {formatSupplierWarehouseOrderWindow(w)}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{color: 'var(--muted)', fontSize: '13px'}}>Нет складов</span>
                    )}
                  </td>
                  <td style={{ fontSize: '13px' }}>
                    {auto.autoOrdersEnabled ? (
                      <div>
                        <span className="text-success">Вкл</span>
                        {auto.minOrderAmount != null ? (
                          <div className="text-muted">от {auto.minOrderAmount.toLocaleString('ru-RU')} ₽</div>
                        ) : (
                          <div className="text-muted">без мин. суммы</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted">Выкл</span>
                    )}
                  </td>
                  <td>{s.isActive !== false && s.active !== false ? 'Да' : 'Нет'}</td>
                  <td style={{textAlign: 'right'}}>{renderBalance(s.id)}</td>
                  <td>
                    <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end'}}>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => navigate(`/suppliers/${s.id}/settlements`)}
                        style={{padding: '6px 10px', fontSize: '14px'}}
                        title="Взаиморасчёты"
                      >
                        💰
                      </Button>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleEdit(s)}
                        style={{padding: '6px 10px', fontSize: '14px'}}
                      >
                        ✏️
                      </Button>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleDelete(s.id)}
                        style={{padding: '6px 10px', fontSize: '14px', color: '#fca5a5', borderColor: '#fca5a5'}}
                      >
                        🗑️
                      </Button>
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingSupplier(null);
        }}
        title={editingSupplier ? 'Редактировать поставщика' : 'Добавить поставщика'}
        size="medium"
      >
        <SupplierForm
          supplier={editingSupplier}
          onSubmit={handleSubmit}
          onCancel={() => {
            setIsModalOpen(false);
            setEditingSupplier(null);
          }}
        />
      </Modal>
    </div>
  );
}



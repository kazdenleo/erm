/**
 * Suppliers Page
 * Страница управления поставщиками
 */

import React, { useState } from 'react';
import { useSuppliers } from '../../hooks/useSuppliers';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { SupplierForm } from '../../components/forms/SupplierForm/SupplierForm';
import './Suppliers.css';

export function Suppliers() {
  const { suppliers, loading, error, createSupplier, updateSupplier, deleteSupplier, loadSuppliers } = useSuppliers();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);

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
                <th>Активен</th>
                <th style={{textAlign: 'right'}}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map(s => {
                const warehouses = s.apiConfig?.warehouses || [];
                return (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>{s.name}</td>
                  <td>
                    {warehouses.length > 0 ? (
                      <div style={{fontSize: '13px'}}>
                        {warehouses.map((w, idx) => (
                          <div key={idx} style={{marginBottom: '4px'}}>
                            <strong>{w.name}</strong> — до {w.time || '—'}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{color: 'var(--muted)', fontSize: '13px'}}>Нет складов</span>
                    )}
                  </td>
                  <td>{s.isActive !== false && s.active !== false ? 'Да' : 'Нет'}</td>
                  <td>
                    <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end'}}>
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



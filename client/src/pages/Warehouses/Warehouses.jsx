/**
 * Warehouses Page
 * Страница управления складами
 */

import React, { useState, useEffect } from 'react';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { WarehouseForm } from '../../components/forms/WarehouseForm/WarehouseForm';
import { warehouseMappingsApi } from '../../services/warehouseMappings.api';
import './Warehouses.css';

export function Warehouses() {
  const { warehouses, loading, error, createWarehouse, updateWarehouse, deleteWarehouse, loadWarehouses } = useWarehouses();
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState(null);
  const [filterOrganizationId, setFilterOrganizationId] = useState('');

  const [mappings, setMappings] = useState([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState(null);
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState(null);
  const [mappingForm, setMappingForm] = useState({ warehouseId: '', marketplace: 'ozon', marketplaceWarehouseId: '' });

  // Логирование для отладки
  useEffect(() => {
    console.log('[Warehouses] Suppliers loaded:', suppliers);
    console.log('[Warehouses] Suppliers count:', suppliers.length);
  }, [suppliers]);

  const loadMappings = async () => {
    setMappingsLoading(true);
    setMappingsError(null);
    try {
      const list = await warehouseMappingsApi.list();
      setMappings(Array.isArray(list) ? list : []);
    } catch (e) {
      setMappings([]);
      setMappingsError(e.response?.data?.message || e.message || 'Не удалось загрузить привязки складов');
    } finally {
      setMappingsLoading(false);
    }
  };

  useEffect(() => {
    loadMappings();
  }, []);

  const handleCreate = () => {
    setEditingWarehouse(null);
    setIsModalOpen(true);
  };

  const handleEdit = (warehouse) => {
    setEditingWarehouse(warehouse);
    setIsModalOpen(true);
  };

  const handleSubmit = async (warehouseData) => {
    try {
      console.log('[Warehouses] Submitting warehouse data:', warehouseData);
      console.log('[Warehouses] warehouseData keys:', Object.keys(warehouseData));
      console.log('[Warehouses] warehouseData.wbWarehouseName:', warehouseData.wbWarehouseName);
      console.log('[Warehouses] warehouseData.wbWarehouseName type:', typeof warehouseData.wbWarehouseName);
      console.log('[Warehouses] warehouseData JSON:', JSON.stringify(warehouseData, null, 2));
      if (editingWarehouse) {
        await updateWarehouse(editingWarehouse.id, warehouseData);
      } else {
        await createWarehouse(warehouseData);
      }
      // Перезагружаем список складов, чтобы увидеть обновленные данные
      await loadWarehouses();
      setIsModalOpen(false);
      setEditingWarehouse(null);
    } catch (error) {
      console.error('Error saving warehouse:', error);
      alert('Ошибка сохранения склада: ' + error.message);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этот склад?')) {
      try {
        await deleteWarehouse(id);
        // Перезагружаем список складов
        await loadWarehouses();
      } catch (error) {
        console.error('Error deleting warehouse:', error);
        alert('Ошибка удаления склада: ' + error.message);
      }
    }
  };

  const openCreateMapping = () => {
    setEditingMapping(null);
    setMappingForm({ warehouseId: '', marketplace: 'ozon', marketplaceWarehouseId: '' });
    setMappingModalOpen(true);
  };

  const openEditMapping = (m) => {
    setEditingMapping(m);
    setMappingForm({
      warehouseId: String(m.warehouse_id ?? m.warehouseId ?? ''),
      marketplace: String(m.marketplace ?? 'ozon'),
      marketplaceWarehouseId: String(m.marketplace_warehouse_id ?? m.marketplaceWarehouseId ?? ''),
    });
    setMappingModalOpen(true);
  };

  const submitMapping = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        warehouseId: mappingForm.warehouseId,
        marketplace: mappingForm.marketplace,
        marketplaceWarehouseId: mappingForm.marketplaceWarehouseId,
      };
      if (editingMapping?.id) {
        await warehouseMappingsApi.update(editingMapping.id, payload);
      } else {
        await warehouseMappingsApi.create(payload);
      }
      setMappingModalOpen(false);
      setEditingMapping(null);
      await loadMappings();
    } catch (err) {
      alert('Ошибка сохранения привязки: ' + (err.response?.data?.message || err.message));
    }
  };

  const deleteMapping = async (id) => {
    if (!window.confirm('Удалить привязку склада?')) return;
    try {
      await warehouseMappingsApi.delete(id);
      await loadMappings();
    } catch (err) {
      alert('Ошибка удаления привязки: ' + (err.response?.data?.message || err.message));
    }
  };

  if (loading) {
    return <div className="loading">Загрузка складов...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  const handleFilterOrganizationChange = (e) => {
    const v = e.target.value;
    setFilterOrganizationId(v);
    loadWarehouses(v || undefined);
  };

  return (
    <div className="card">
      <h1 className="title">📦 Склады</h1>
      <p className="subtitle">Управление складами и остатками товаров</p>
      
      <p style={{fontSize: '14px', color: 'var(--muted)', marginBottom: '8px'}}>Управление складами: добавление, редактирование и удаление складов с адресами.</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '14px', color: 'var(--muted)' }}>Организация:</label>
        <select
          value={filterOrganizationId}
          onChange={handleFilterOrganizationChange}
          style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', minWidth: '200px' }}
        >
          <option value="">Все организации</option>
          {organizations.map(org => (
            <option key={org.id} value={org.id}>{org.name}</option>
          ))}
        </select>
      </div>

      <div className="warehouses-list" style={{marginTop: '16px', width: '100%'}}>
        {warehouses.length === 0 ? (
          <div className="empty-state">
            <p>Склады не найдены</p>
          </div>
        ) : (
          <table className="warehouses-table table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Тип</th>
                <th>Адрес</th>
                <th>Поставщик</th>
                <th>Основной склад</th>
                <th>Склад Wildberries</th>
                <th>Время приема заказов</th>
                <th style={{textAlign: 'right'}}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map(w => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>{w.type === 'supplier' ? 'Склад поставщика' : 'Склад'}</td>
                  <td>{w.address || '—'}</td>
                  <td>{w.supplierId ? suppliers.find(s => s.id === w.supplierId)?.name || w.supplierId : '—'}</td>
                  <td>{w.mainWarehouseId || '—'}</td>
                  <td>{w.type === 'warehouse' && w.wbWarehouseName ? w.wbWarehouseName : '—'}</td>
                  <td>{w.type === 'supplier' && w.orderAcceptanceTime ? w.orderAcceptanceTime : '—'}</td>
                  <td>
                    <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end'}}>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleEdit(w)}
                        style={{padding: '6px 10px', fontSize: '14px'}}
                      >
                        ✏️
                      </Button>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleDelete(w.id)}
                        style={{padding: '6px 10px', fontSize: '14px', color: '#fca5a5', borderColor: '#fca5a5'}}
                      >
                        🗑️
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      
      <div className="actions" style={{marginTop: '16px'}}>
        <Button variant="primary" onClick={handleCreate}>➕ Добавить склад</Button>
      </div>

      <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid var(--border)' }} />

      <h2 className="title" style={{ fontSize: 18, marginTop: 0 }}>Привязка складов маркетплейсов</h2>
      <p className="subtitle" style={{ marginTop: 6 }}>
        Нужна, чтобы заказы с маркетплейса резервировали остаток именно с правильного фактического склада (например, Москва).
      </p>
      {mappingsError && <div className="error">{mappingsError}</div>}
      {mappingsLoading ? (
        <div className="loading">Загрузка привязок…</div>
      ) : (
        <table className="warehouses-table table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Фактический склад</th>
              <th>Маркетплейс</th>
              <th>Склад маркетплейса (ID/название)</th>
              <th style={{ textAlign: 'right' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 ? (
              <tr><td colSpan={5} className="muted">Привязок пока нет.</td></tr>
            ) : mappings.map(m => {
              const wid = m.warehouse_id ?? m.warehouseId;
              const wh = warehouses.find(x => String(x.id) === String(wid));
              return (
                <tr key={m.id}>
                  <td>{m.id}</td>
                  <td>{wh?.address || `Склад #${wid}`}</td>
                  <td>{String(m.marketplace || '').toUpperCase()}</td>
                  <td>{m.marketplace_warehouse_id ?? m.marketplaceWarehouseId}</td>
                  <td>
                    <div style={{display: 'flex', gap: '6px', justifyContent: 'flex-end'}}>
                      <Button variant="secondary" size="small" onClick={() => openEditMapping(m)}>✏️</Button>
                      <Button variant="secondary" size="small" onClick={() => deleteMapping(m.id)} style={{ color: '#fca5a5', borderColor: '#fca5a5' }}>🗑️</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="actions" style={{marginTop: '12px'}}>
        <Button variant="secondary" onClick={openCreateMapping}>➕ Добавить привязку</Button>
        <Button variant="secondary" onClick={loadMappings}>Обновить</Button>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingWarehouse(null);
        }}
        title={editingWarehouse ? 'Редактировать склад' : 'Добавить склад'}
        size="medium"
      >
        <WarehouseForm
          warehouse={editingWarehouse}
          suppliers={suppliers}
          warehouses={warehouses}
          organizations={organizations}
          onSubmit={handleSubmit}
          onCancel={() => {
            setIsModalOpen(false);
            setEditingWarehouse(null);
          }}
        />
      </Modal>

      <Modal
        isOpen={mappingModalOpen}
        onClose={() => { setMappingModalOpen(false); setEditingMapping(null); }}
        title={editingMapping ? 'Редактировать привязку' : 'Добавить привязку'}
        size="medium"
      >
        <form onSubmit={submitMapping} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-group">
            <label className="label">Фактический склад</label>
            <select
              className="form-control"
              value={mappingForm.warehouseId}
              onChange={(e) => setMappingForm(prev => ({ ...prev, warehouseId: e.target.value }))}
              required
            >
              <option value="">Выберите склад</option>
              {warehouses.filter(w => w.type === 'warehouse' && !w.supplierId).map(w => (
                <option key={w.id} value={String(w.id)}>{w.address || `Склад #${w.id}`}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="label">Маркетплейс</label>
            <select
              className="form-control"
              value={mappingForm.marketplace}
              onChange={(e) => setMappingForm(prev => ({ ...prev, marketplace: e.target.value }))}
              required
            >
              <option value="ozon">Ozon</option>
              <option value="wb">Wildberries</option>
              <option value="ym">Яндекс Маркет</option>
            </select>
          </div>
          <div className="form-group">
            <label className="label">Склад маркетплейса (точно как в заказе)</label>
            <input
              className="form-control"
              value={mappingForm.marketplaceWarehouseId}
              onChange={(e) => setMappingForm(prev => ({ ...prev, marketplaceWarehouseId: e.target.value }))}
              placeholder="Напр. 'Москва (FBS)' или ID склада"
              required
            />
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Для Ozon это обычно значение из заказа: <code>delivery_method.warehouse_name</code>.
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button type="button" variant="secondary" onClick={() => { setMappingModalOpen(false); setEditingMapping(null); }}>Отмена</Button>
            <Button type="submit" variant="primary">Сохранить</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}



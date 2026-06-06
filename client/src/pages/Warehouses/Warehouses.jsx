/**
 * Warehouses Page
 * Страница управления складами
 */

import React, { useState, useEffect } from 'react';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { formatWeekendDaysLabel } from '../../utils/warehouseWeekendDays.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { WarehouseForm } from '../../components/forms/WarehouseForm/WarehouseForm';
import { warehouseMappingsApi } from '../../services/warehouseMappings.api';
import { integrationsApi } from '../../services/integrations.api';
import {
  normalizeWarehouseMappingMarketplace,
  warehouseMappingMarketplaceHint,
  warehouseMappingMarketplaceLabel,
  WAREHOUSE_MAPPING_MARKETPLACES,
} from '../../utils/warehouseMappingMarketplaces';
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
  const [mappingForm, setMappingForm] = useState({
    warehouseId: '',
    marketplace: 'ozon',
    marketplaceWarehouseId: '',
  });
  const [mpSuggestions, setMpSuggestions] = useState([]);
  const [mpSuggestionsLoading, setMpSuggestionsLoading] = useState(false);
  const [mpSuggestionsError, setMpSuggestionsError] = useState(null);

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

  const selectedMappingWarehouse = warehouses.find(
    (w) => String(w.id) === String(mappingForm.warehouseId)
  );
  const mappingOrgId =
    selectedMappingWarehouse?.organizationId ??
    selectedMappingWarehouse?.organization_id ??
    '';

  useEffect(() => {
    if (!mappingModalOpen) return;
    const orgId = String(mappingOrgId || '').trim();
    const mp = normalizeWarehouseMappingMarketplace(mappingForm.marketplace);
    if (!orgId) {
      setMpSuggestions([]);
      setMpSuggestionsError(null);
      setMpSuggestionsLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setMpSuggestionsLoading(true);
      setMpSuggestionsError(null);
      try {
        let items = [];
        if (mp === 'ozon') {
          const response = await integrationsApi.getOzonWarehouses({ organizationId: orgId });
          const payload = response?.data ?? response;
          const list = payload?.result ?? payload?.warehouses ?? payload?.data ?? [];
          items = (Array.isArray(list) ? list : []).map((x) => {
            const id = x.warehouse_id ?? x.warehouseId ?? x.id ?? null;
            const name = x.name ?? x.warehouse_name ?? '';
            const idStr = id != null ? String(id).trim() : '';
            const nameStr = String(name || '').trim();
            const bindValue =
              idStr && nameStr ? `${idStr} — ${nameStr}` : nameStr || idStr;
            return { value: bindValue, label: bindValue || nameStr || idStr };
          });
        } else if (mp === 'wb') {
          const response = await integrationsApi.getWildberriesSellerWarehouses({
            organizationId: orgId,
          });
          const payload = response?.data ?? response;
          const list = payload?.warehouses ?? payload?.data ?? payload ?? [];
          items = (Array.isArray(list) ? list : []).map((o) => {
            const id = o.id ?? o.warehouseId ?? null;
            const name = o.name ?? o.warehouseName ?? '';
            const idStr = id != null ? String(id).trim() : '';
            const nameStr = String(name || '').trim();
            const bindValue = idStr || nameStr;
            const label =
              idStr && nameStr ? `${idStr} — ${nameStr}` : nameStr || idStr;
            return { value: bindValue, label };
          });
        } else if (mp === 'ym') {
          const response = await integrationsApi.getYandexCampaigns({ organizationId: orgId });
          const payload = response?.data ?? response;
          const list = payload?.campaigns ?? payload?.result?.campaigns ?? payload?.data ?? [];
          items = (Array.isArray(list) ? list : []).map((c) => {
            const id = c.id ?? c.campaignId ?? null;
            const name = c.domain ?? c.clientId ?? c.name ?? c.business?.name ?? '';
            const idStr = id != null ? String(id).trim() : '';
            return {
              value: idStr,
              label: idStr ? `${idStr}${name ? ` · ${name}` : ''}` : '',
            };
          });
        }
        items = items.filter((x) => String(x.value || '').trim() !== '');
        items.sort((a, b) => String(a.label).localeCompare(String(b.label), 'ru'));
        if (!cancelled) setMpSuggestions(items);
      } catch (e) {
        if (!cancelled) {
          setMpSuggestions([]);
          setMpSuggestionsError(
            e.response?.data?.message || e.message || 'Не удалось загрузить список'
          );
        }
      } finally {
        if (!cancelled) setMpSuggestionsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [mappingModalOpen, mappingForm.marketplace, mappingOrgId]);

  const handleCreate = () => {
    setEditingWarehouse(null);
    setIsModalOpen(true);
  };

  const handleEdit = (warehouse) => {
    setEditingWarehouse(warehouse);
    setIsModalOpen(true);
  };

  const handleSubmit = async (warehouseData) => {
    if (editingWarehouse) {
      return await updateWarehouse(editingWarehouse.id, warehouseData);
    }
    return await createWarehouse(warehouseData);
  };

  const handleWarehouseSaved = async () => {
    await loadWarehouses();
    await loadMappings();
    setIsModalOpen(false);
    setEditingWarehouse(null);
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
      marketplace: normalizeWarehouseMappingMarketplace(m.marketplace ?? 'ozon'),
      marketplaceWarehouseId: String(m.marketplace_warehouse_id ?? m.marketplaceWarehouseId ?? ''),
    });
    setMappingModalOpen(true);
  };

  const submitMapping = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        warehouseId: mappingForm.warehouseId,
        marketplace: normalizeWarehouseMappingMarketplace(mappingForm.marketplace),
        marketplaceWarehouseId: String(mappingForm.marketplaceWarehouseId || '').trim(),
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
                <th>Выходные</th>
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
                  <td>
                    {w.type === 'warehouse'
                      ? formatWeekendDaysLabel(w.weekendDays ?? w.weekend_days)
                      : '—'}
                  </td>
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
                  <td>{warehouseMappingMarketplaceLabel(m.marketplace)}</td>
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
          onSaved={handleWarehouseSaved}
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
        size="large"
      >
        <form onSubmit={submitMapping} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-group">
            <label className="label">Фактический склад</label>
            <select
              className="form-control"
              value={mappingForm.warehouseId}
              onChange={(e) => setMappingForm((prev) => ({ ...prev, warehouseId: e.target.value }))}
              required
            >
              <option value="">Выберите склад</option>
              {warehouses.filter((w) => w.type === 'warehouse' && !w.supplierId).map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.address || `Склад #${w.id}`}
                </option>
              ))}
            </select>
            {!mappingOrgId && mappingForm.warehouseId ? (
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                У склада не указана организация — список складов МП из API недоступен, введите значение вручную.
              </div>
            ) : null}
          </div>
          <div className="form-group">
            <label className="label">Маркетплейс</label>
            <select
              className="form-control"
              value={normalizeWarehouseMappingMarketplace(mappingForm.marketplace)}
              onChange={(e) =>
                setMappingForm((prev) => ({
                  ...prev,
                  marketplace: e.target.value,
                  marketplaceWarehouseId: '',
                }))
              }
              required
            >
              {WAREHOUSE_MAPPING_MARKETPLACES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              На один фактический склад можно привязать по одной записи для Ozon, Wildberries и Яндекс.Маркет.
            </div>
          </div>
          <div className="form-group">
            <label className="label">Склад маркетплейса (точно как в заказе)</label>
            {mappingOrgId && mpSuggestionsLoading ? (
              <div className="alert alert-secondary py-2 mb-2">Загрузка списка из интеграции…</div>
            ) : null}
            {mappingOrgId && mpSuggestionsError ? (
              <div className="alert alert-warning py-2 mb-2">{mpSuggestionsError}</div>
            ) : null}
            {mappingOrgId && mpSuggestions.length > 0 ? (
              <select
                className="form-control mb-2"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) setMappingForm((prev) => ({ ...prev, marketplaceWarehouseId: v }));
                }}
              >
                <option value="">— Выберите из API (необязательно) —</option>
                {mpSuggestions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              className="form-control"
              value={mappingForm.marketplaceWarehouseId}
              onChange={(e) =>
                setMappingForm((prev) => ({ ...prev, marketplaceWarehouseId: e.target.value }))
              }
              placeholder={
                normalizeWarehouseMappingMarketplace(mappingForm.marketplace) === 'wb'
                  ? 'Напр. «Теплый Стан» или id склада FBS'
                  : normalizeWarehouseMappingMarketplace(mappingForm.marketplace) === 'ym'
                    ? 'Напр. campaignId: 12345678'
                    : "Напр. 'Москва (FBS)' или id — название"
              }
              required
            />
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              {warehouseMappingMarketplaceHint(mappingForm.marketplace)}
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



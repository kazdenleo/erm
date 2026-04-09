/**
 * WarehouseForm Component
 * Форма создания/редактирования склада
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../../common/Button/Button';
import { integrationsApi } from '../../../services/integrations.api';
import { warehouseMappingsApi } from '../../../services/warehouseMappings.api';

export function WarehouseForm({ warehouse, suppliers = [], warehouses = [], organizations = [], onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    type: '',
    address: '',
    organizationId: '',
    supplierId: '',
    mainWarehouseId: '',
    orderAcceptanceTime: '',
    wbWarehouseName: ''
  });
  
  const [errors, setErrors] = useState({});
  const [wbWarehouses, setWbWarehouses] = useState([]);
  const [loadingWbWarehouses, setLoadingWbWarehouses] = useState(false);
  const [wbWarehouseToBind, setWbWarehouseToBind] = useState('');
  const [wbOffices, setWbOffices] = useState([]);
  const [loadingWbOffices, setLoadingWbOffices] = useState(false);
  const [wbOfficesError, setWbOfficesError] = useState(null);
  const [wbOfficeToBind, setWbOfficeToBind] = useState('');
  const [ozonWarehouses, setOzonWarehouses] = useState([]);
  const [loadingOzonWarehouses, setLoadingOzonWarehouses] = useState(false);
  const [ozonWarehousesError, setOzonWarehousesError] = useState(null);
  const [ozonWarehouseName, setOzonWarehouseName] = useState('');
  const [ymCampaigns, setYmCampaigns] = useState([]);
  const [loadingYmCampaigns, setLoadingYmCampaigns] = useState(false);
  const [ymCampaignsError, setYmCampaignsError] = useState(null);
  const [ymCampaignId, setYmCampaignId] = useState('');
  const [mappingBusy, setMappingBusy] = useState(false);
  const [existingMappings, setExistingMappings] = useState([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState(null);

  const loadMappings = async (warehouseId) => {
    const wid = warehouseId != null ? String(warehouseId) : '';
    if (!wid) return;
    setMappingsLoading(true);
    setMappingsError(null);
    try {
      const list = await warehouseMappingsApi.list({ warehouseId: wid });
      setExistingMappings(Array.isArray(list) ? list : []);
    } catch (e) {
      setExistingMappings([]);
      setMappingsError(e.response?.data?.message || e.message || 'Не удалось загрузить привязки');
    } finally {
      setMappingsLoading(false);
    }
  };

  // Загрузка списка складов Wildberries из тарифов
  useEffect(() => {
    const loadWBWarehouses = async () => {
      setLoadingWbWarehouses(true);
      try {
        const response = await integrationsApi.getWildberriesTariffs();
        console.log('[WarehouseForm] WB tariffs response:', response);
        if (response?.data?.response?.data?.warehouseList) {
          const warehousesList = response.data.response.data.warehouseList;
          console.log('[WarehouseForm] Raw warehouses list:', warehousesList);
          console.log('[WarehouseForm] First warehouse sample:', warehousesList[0]);
          // Сортируем склады по названию для удобства
          const sortedWarehouses = [...warehousesList].sort((a, b) => {
            const nameA = (a.warehouseName || '').toLowerCase();
            const nameB = (b.warehouseName || '').toLowerCase();
            return nameA.localeCompare(nameB);
          });
          console.log('[WarehouseForm] Sorted warehouses:', sortedWarehouses);
          setWbWarehouses(sortedWarehouses);
          console.log('[WarehouseForm] Loaded WB warehouses:', sortedWarehouses.length);
        } else {
          console.warn('[WarehouseForm] No WB warehouses found in tariffs. Response structure:', {
            hasData: !!response?.data,
            hasResponse: !!response?.data?.response,
            hasDataResponse: !!response?.data?.response?.data,
            hasWarehouseList: !!response?.data?.response?.data?.warehouseList,
            fullResponse: response
          });
          setWbWarehouses([]);
        }
      } catch (err) {
        console.error('[WarehouseForm] Error loading WB warehouses:', err);
        setWbWarehouses([]);
      } finally {
        setLoadingWbWarehouses(false);
      }
    };
    
    loadWBWarehouses();
  }, []);

  // Загрузка складов продавца WB (FBS)
  useEffect(() => {
    const loadOffices = async () => {
      setLoadingWbOffices(true);
      setWbOfficesError(null);
      try {
        const response = await integrationsApi.getWildberriesSellerWarehouses();
        const payload = response?.data ?? response;
        const list = payload?.warehouses ?? payload?.data ?? payload ?? [];
        const arr = Array.isArray(list) ? list : [];
        const normalized = arr
          .map((o) => {
            const id = o.id ?? o.warehouseId ?? null;
            const name = o.name ?? o.warehouseName ?? '';
            const idStr = id != null && String(id).trim() !== '' ? String(id).trim() : '';
            const nameStr = String(name || '').trim();
            return {
              id,
              name: idStr && nameStr ? `${idStr} — ${nameStr}` : (nameStr || idStr),
              address: o.address ?? '',
            };
          })
          .filter((x) => String(x.name || '').trim() !== '');
        normalized.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' }));
        setWbOffices(normalized);
      } catch (err) {
        console.error('[WarehouseForm] Error loading WB offices:', err);
        setWbOffices([]);
        setWbOfficesError(err.response?.data?.message || err.message || 'Не удалось загрузить склады WB');
      } finally {
        setLoadingWbOffices(false);
      }
    };
    loadOffices();
  }, []);

  // Загрузка кампаний Яндекс.Маркета
  useEffect(() => {
    const loadYm = async () => {
      setLoadingYmCampaigns(true);
      setYmCampaignsError(null);
      try {
        const response = await integrationsApi.getYandexCampaigns();
        const payload = response?.data ?? response;
        const list = payload?.campaigns ?? payload?.result?.campaigns ?? payload?.data ?? [];
        const arr = Array.isArray(list) ? list : [];
        const normalized = arr
          .map((c) => ({
            id: c.id ?? c.campaignId ?? null,
            name: c.domain ?? c.clientId ?? c.name ?? c.business?.name ?? '',
          }))
          .filter((x) => x.id != null);
        setYmCampaigns(normalized);
      } catch (err) {
        console.error('[WarehouseForm] Error loading YM campaigns:', err);
        setYmCampaigns([]);
        setYmCampaignsError(err.response?.data?.message || err.message || 'Не удалось загрузить кампании ЯМ');
      } finally {
        setLoadingYmCampaigns(false);
      }
    };
    loadYm();
  }, []);

  // Загрузка списка складов Ozon из API
  useEffect(() => {
    const loadOzonWarehouses = async () => {
      setLoadingOzonWarehouses(true);
      setOzonWarehousesError(null);
      try {
        const response = await integrationsApi.getOzonWarehouses();
        const payload = response?.data ?? response;
        const list = payload?.result ?? payload?.warehouses ?? payload?.data ?? [];
        const arr = Array.isArray(list) ? list : [];
        const normalized = arr
          .map((x) => {
            const id = x.warehouse_id ?? x.warehouseId ?? x.id ?? null;
            const name = x.name ?? x.warehouse_name ?? x.title ?? '';
            const idStr = id != null && String(id).trim() !== '' ? String(id).trim() : '';
            const nameStr = String(name || '').trim();
            return { id, name: idStr && nameStr ? `${idStr} — ${nameStr}` : (nameStr || idStr) };
          })
          .filter((x) => String(x.name || '').trim() !== '');
        normalized.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' }));
        setOzonWarehouses(normalized);
      } catch (err) {
        console.error('[WarehouseForm] Error loading Ozon warehouses:', err);
        setOzonWarehouses([]);
        setOzonWarehousesError(err.response?.data?.message || err.message || 'Не удалось загрузить склады Ozon');
      } finally {
        setLoadingOzonWarehouses(false);
      }
    };
    loadOzonWarehouses();
  }, []);

  useEffect(() => {
    if (warehouse) {
      setFormData({
        type: warehouse.type || '',
        address: warehouse.address || '',
        organizationId: warehouse.organizationId != null ? String(warehouse.organizationId) : (warehouse.organization_id != null ? String(warehouse.organization_id) : ''),
        supplierId: warehouse.supplierId ? String(warehouse.supplierId) : '',
        mainWarehouseId: warehouse.mainWarehouseId ? String(warehouse.mainWarehouseId) : '',
        orderAcceptanceTime: warehouse.orderAcceptanceTime || '',
        wbWarehouseName: warehouse.wbWarehouseName || ''
      });
      setOzonWarehouseName('');
      setWbWarehouseToBind('');
      setYmCampaignId('');
      setWbOfficeToBind('');
      loadMappings(warehouse.id);
    } else {
      setFormData({
        type: '',
        address: '',
        organizationId: '',
        supplierId: '',
        mainWarehouseId: '',
        orderAcceptanceTime: '',
        wbWarehouseName: ''
      });
      setOzonWarehouseName('');
      setWbWarehouseToBind('');
      setYmCampaignId('');
      setWbOfficeToBind('');
      setExistingMappings([]);
      setMappingsError(null);
    }
  }, [warehouse]);

  const canManageMappings = Boolean(warehouse?.id);

  const bindMarketplaceWarehouse = async (marketplace, marketplaceWarehouseId) => {
    if (!canManageMappings) return;
    const mw = String(marketplaceWarehouseId || '').trim();
    if (!mw) return;
    setMappingBusy(true);
    try {
      await warehouseMappingsApi.create({
        warehouseId: warehouse.id,
        marketplace,
        marketplaceWarehouseId: mw,
      });
      await loadMappings(warehouse.id);
      alert(`Привязка сохранена: ${marketplace.toUpperCase()} → "${mw}"`);
    } catch (e) {
      alert('Ошибка привязки склада: ' + (e.response?.data?.message || e.message));
    } finally {
      setMappingBusy(false);
    }
  };

  const deleteMapping = async (id) => {
    if (!canManageMappings) return;
    if (!window.confirm('Удалить привязку?')) return;
    setMappingBusy(true);
    try {
      await warehouseMappingsApi.delete(id);
      await loadMappings(warehouse.id);
    } catch (e) {
      alert('Ошибка удаления привязки: ' + (e.response?.data?.message || e.message));
    } finally {
      setMappingBusy(false);
    }
  };

  useEffect(() => {
    console.log('[WarehouseForm] Suppliers:', suppliers);
    console.log('[WarehouseForm] Current formData:', formData);
  }, [suppliers, formData]);

  const handleChange = (field, value) => {
    console.log(`[WarehouseForm] handleChange: ${field} =`, value);
    setFormData(prev => {
      const newData = { ...prev, [field]: value };
      console.log(`[WarehouseForm] New formData:`, newData);
      return newData;
    });
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const validate = () => {
    const newErrors = {};
    
    if (!formData.type) {
      newErrors.type = 'Выберите тип склада';
    }
    if (formData.type === 'supplier') {
      if (!formData.supplierId) {
        newErrors.supplierId = 'Выберите поставщика';
      }
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!validate()) {
      return;
    }

    const payload = {
      type: formData.type,
      address: formData.address.trim() || null,
      organizationId: formData.organizationId && formData.organizationId.trim() !== '' ? formData.organizationId : null,
      supplierId: formData.type === 'supplier' ? (formData.supplierId || null) : null,
      mainWarehouseId: formData.type === 'supplier' ? (formData.mainWarehouseId || null) : null,
      orderAcceptanceTime: formData.type === 'supplier' ? (formData.orderAcceptanceTime || null) : null,
      wbWarehouseName: formData.type === 'warehouse' 
        ? (formData.wbWarehouseName && formData.wbWarehouseName.trim() !== '' 
            ? formData.wbWarehouseName.trim() 
            : null)
        : null
    };
    
    console.log('[WarehouseForm] Submitting payload:', JSON.stringify(payload, null, 2));
    console.log('[WarehouseForm] formData.wbWarehouseName:', formData.wbWarehouseName);
    console.log('[WarehouseForm] formData.type:', formData.type);
    console.log('[WarehouseForm] payload.wbWarehouseName:', payload.wbWarehouseName);
    console.log('[WarehouseForm] payload.wbWarehouseName type:', typeof payload.wbWarehouseName);
    console.log('[WarehouseForm] payload.wbWarehouseName length:', payload.wbWarehouseName ? payload.wbWarehouseName.length : 0);

    onSubmit(payload);
  };

  return (
    <form className="warehouse-form" onSubmit={handleSubmit}>
      <div className="row g-3">
      <div className="col-md-4">
        <label className="form-label" htmlFor="stockType">
          Тип склада <span style={{color: '#ef4444'}}>*</span>
        </label>
        <select
          id="stockType"
          className="form-select form-select-sm"
          value={formData.type}
          onChange={(e) => handleChange('type', e.target.value)}
          required
        >
          <option value="">-- Выберите тип --</option>
          <option value="supplier">Склад поставщика</option>
          <option value="warehouse">Склад</option>
        </select>
        {errors.type && <div className="error">{errors.type}</div>}
      </div>

      <div className="col-md-8">
        <label className="form-label" htmlFor="stockAddress">Адрес</label>
        <textarea
          id="stockAddress"
          className="form-control form-control-sm"
          rows="3"
          placeholder="Например: г. Москва, ул. Ленина, д. 1"
          value={formData.address}
          onChange={(e) => handleChange('address', e.target.value)}
        />
      </div>

      <div className="col-md-6">
        <label className="form-label" htmlFor="warehouseOrganization">Организация</label>
        <select
          id="warehouseOrganization"
          className="form-select form-select-sm"
          value={formData.organizationId}
          onChange={(e) => handleChange('organizationId', e.target.value)}
        >
          <option value="">-- Без организации --</option>
          {organizations.map(org => (
            <option key={org.id} value={org.id}>{org.name}</option>
          ))}
        </select>
      </div>
      </div>

      {formData.type === 'warehouse' && (
        <div className="mt-3">
          <label className="form-label" htmlFor="wbWarehouseSelect">Склад Wildberries</label>
          <div className="text-muted small mb-2">
            Выберите соответствующий склад Wildberries из списка тарифов. Это необходимо для корректного расчета логистики.
          </div>
          {loadingWbWarehouses ? (
            <div className="alert alert-secondary py-2">Загрузка складов Wildberries...</div>
          ) : wbWarehouses.length === 0 ? (
            <div className="alert alert-warning py-2">
              Склады Wildberries не загружены. Убедитесь, что в настройках интеграции Wildberries указан API ключ и загружены тарифы.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                id="wbWarehouseSelect"
                className="form-select form-select-sm"
                value={formData.wbWarehouseName}
                onChange={(e) => handleChange('wbWarehouseName', e.target.value)}
              >
                <option value="">-- Выберите склад Wildberries --</option>
                {wbWarehouses.map((wbWarehouse, index) => {
                  const warehouseName = wbWarehouse.warehouseName || '';
                  if (index === 0) {
                    console.log(`[WarehouseForm] First warehouse option:`, { warehouseName, fullWarehouse: wbWarehouse });
                  }
                  return (
                    <option key={index} value={warehouseName}>
                      {warehouseName} {wbWarehouse.geoName ? `(${wbWarehouse.geoName})` : ''}
                    </option>
                  );
                })}
              </select>
              {canManageMappings && (
                <>
                  <select
                    className="form-select form-select-sm"
                    style={{ maxWidth: 240 }}
                    value={wbWarehouseToBind}
                    onChange={(e) => setWbWarehouseToBind(e.target.value)}
                    title="Выберите склад WB для привязки к этому складу"
                  >
                    <option value="">-- Привязать WB склад --</option>
                    {wbWarehouses.map((w, i) => (
                      <option key={i} value={String(w.warehouseName || '')}>
                        {String(w.warehouseName || '')}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={mappingBusy || !wbWarehouseToBind}
                    onClick={() => bindMarketplaceWarehouse('wb', wbWarehouseToBind)}
                  >
                    Привязать
                  </Button>
                </>
              )}
            </div>
          )}

          {canManageMappings && wbWarehouses.length === 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control form-control-sm"
                style={{ maxWidth: 420 }}
                value={wbWarehouseToBind}
                onChange={(e) => setWbWarehouseToBind(e.target.value)}
                placeholder="Введите название/ID склада WB (как в заказе/тарифах)"
              />
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !String(wbWarehouseToBind || '').trim()}
                onClick={() => bindMarketplaceWarehouse('wb', wbWarehouseToBind)}
              >
                Привязать
              </Button>
            </div>
          )}
        </div>
      )}

      {formData.type === 'warehouse' && (
        <div className="mt-3">
          <label className="form-label" htmlFor="wbOfficeSelect">Wildberries: склад продавца (FBS)</label>
          <div className="text-muted small mb-2">
            Это склад продавца WB (FBS). Его нужно привязать к фактическому складу.
          </div>
          {!canManageMappings ? (
            <div className="alert alert-secondary py-2">Сначала сохраните склад, затем можно добавить привязки маркетплейсов.</div>
          ) : loadingWbOffices ? (
            <div className="alert alert-secondary py-2">Загрузка офисов WB…</div>
          ) : wbOfficesError ? (
            <div className="alert alert-warning py-2">Не удалось загрузить склады WB: {wbOfficesError}</div>
          ) : wbOffices.length === 0 ? (
            <div className="alert alert-warning py-2">
              Склады WB не загружены. Проверьте интеграцию WB и доступ к Marketplace API.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                id="wbOfficeSelect"
                className="form-select form-select-sm"
                value={wbOfficeToBind}
                onChange={(e) => setWbOfficeToBind(e.target.value)}
              >
                <option value="">-- Выберите склад WB (FBS) --</option>
                {wbOffices.map((o) => (
                  <option key={String(o.id ?? o.name)} value={String(o.name)}>
                    {String(o.name)}{o.address ? ` · ${o.address}` : ''}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !String(wbOfficeToBind || '').trim()}
                onClick={() => bindMarketplaceWarehouse('wb', wbOfficeToBind)}
              >
                Привязать FBS
              </Button>
            </div>
          )}
          {canManageMappings && (wbOfficesError || wbOffices.length === 0) && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control form-control-sm"
                style={{ maxWidth: 420 }}
                value={wbOfficeToBind}
                onChange={(e) => setWbOfficeToBind(e.target.value)}
                placeholder="Введите offices[0] из заказа WB (например «Теплый стан»)"
              />
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !String(wbOfficeToBind || '').trim()}
                onClick={() => bindMarketplaceWarehouse('wb', wbOfficeToBind)}
              >
                Привязать FBS
              </Button>
            </div>
          )}
        </div>
      )}

      {formData.type === 'warehouse' && (
        <div className="mt-3">
          <label className="form-label" htmlFor="ozonWarehouseSelect">Склад Ozon (для резервирования)</label>
          <div className="text-muted small mb-2">
            Выберите склад Ozon. После выбора нажмите «Привязать» — заказы Ozon будут резервировать остаток с этого фактического склада.
          </div>
          {!canManageMappings ? (
            <div className="alert alert-secondary py-2">Сначала сохраните склад, затем можно добавить привязки маркетплейсов.</div>
          ) : loadingOzonWarehouses ? (
            <div className="alert alert-secondary py-2">Загрузка складов Ozon…</div>
          ) : ozonWarehousesError ? (
            <div className="alert alert-warning py-2">
              Не удалось загрузить склады Ozon: {ozonWarehousesError}
            </div>
          ) : ozonWarehouses.length === 0 ? (
            <div className="alert alert-warning py-2">
              Склады Ozon не загружены. Проверьте настройки интеграции Ozon (client_id/api_key).
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                id="ozonWarehouseSelect"
                className="form-select form-select-sm"
                value={ozonWarehouseName}
                onChange={(e) => setOzonWarehouseName(e.target.value)}
              >
                <option value="">-- Выберите склад Ozon --</option>
                {ozonWarehouses.map((w, i) => (
                  <option key={String(w.id ?? i)} value={String(w.name)}>
                    {String(w.name)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !ozonWarehouseName}
                onClick={() => bindMarketplaceWarehouse('ozon', ozonWarehouseName)}
                title="Создать привязку Ozon→этот склад"
              >
                Привязать
              </Button>
            </div>
          )}
        </div>
      )}

      {formData.type === 'warehouse' && (
        <div className="mt-3">
          <label className="form-label" htmlFor="ymCampaignSelect">Яндекс.Маркет (кампания → склад)</label>
          <div className="text-muted small mb-2">
            В Яндекс.Маркете используем <code>campaignId</code> как ключ для сопоставления. Выберите кампанию и нажмите «Привязать».
          </div>
          {!canManageMappings ? (
            <div className="alert alert-secondary py-2">Сначала сохраните склад, затем можно добавить привязки маркетплейсов.</div>
          ) : loadingYmCampaigns ? (
            <div className="alert alert-secondary py-2">Загрузка кампаний Яндекс.Маркета…</div>
          ) : ymCampaignsError ? (
            <div className="alert alert-warning py-2">Не удалось загрузить кампании: {ymCampaignsError}</div>
          ) : ymCampaigns.length === 0 ? (
            <div className="alert alert-warning py-2">Кампании не найдены. Проверьте настройки интеграции Яндекс.Маркет (api_key).</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                id="ymCampaignSelect"
                className="form-select form-select-sm"
                value={ymCampaignId}
                onChange={(e) => setYmCampaignId(e.target.value)}
              >
                <option value="">-- Выберите кампанию ЯМ --</option>
                {ymCampaigns.map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {String(c.id)}{c.name ? ` · ${c.name}` : ''}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !ymCampaignId}
                onClick={() => bindMarketplaceWarehouse('ym', ymCampaignId)}
              >
                Привязать
              </Button>
            </div>
          )}

          {canManageMappings && (loadingYmCampaigns || ymCampaignsError || ymCampaigns.length === 0) && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-control form-control-sm"
                style={{ maxWidth: 240 }}
                value={ymCampaignId}
                onChange={(e) => setYmCampaignId(e.target.value)}
                placeholder="campaignId (число)"
              />
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={mappingBusy || !String(ymCampaignId || '').trim()}
                onClick={() => bindMarketplaceWarehouse('ym', ymCampaignId)}
              >
                Привязать
              </Button>
            </div>
          )}
        </div>
      )}

      {formData.type === 'warehouse' && canManageMappings && (
        <div className="mt-3">
          <label className="form-label">Текущие привязки маркетплейсов</label>
          {mappingsError && <div className="alert alert-warning py-2">{mappingsError}</div>}
          {mappingsLoading ? (
            <div className="alert alert-secondary py-2">Загрузка привязок…</div>
          ) : existingMappings.length === 0 ? (
            <div className="alert alert-secondary py-2">Привязок пока нет.</div>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>MP</th>
                    <th>MP склад</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {existingMappings.map((m) => (
                    <tr key={m.id}>
                      <td>{m.id}</td>
                      <td>{String(m.marketplace || '').toUpperCase()}</td>
                      <td>{m.marketplace_warehouse_id ?? m.marketplaceWarehouseId}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          disabled={mappingBusy}
                          onClick={() => deleteMapping(m.id)}
                        >
                          Удалить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <Button type="button" variant="secondary" size="small" disabled={mappingsLoading || mappingBusy} onClick={() => loadMappings(warehouse.id)}>
              Обновить привязки
            </Button>
          </div>
        </div>
      )}

      {formData.type === 'supplier' && (
        <>
          <div className="mt-3">
            <label className="form-label" htmlFor="stockSupplier">
              Поставщик <span style={{color: '#ef4444'}}>*</span>
            </label>
            {suppliers.length === 0 ? (
              <div className="alert alert-warning py-2">
                Нет доступных поставщиков. Сначала создайте поставщика в разделе "Поставщики".
              </div>
            ) : (
              <select
                id="stockSupplier"
                className="form-select form-select-sm"
                value={formData.supplierId}
                onChange={(e) => handleChange('supplierId', e.target.value)}
                required={formData.type === 'supplier'}
              >
                <option value="">-- Выберите поставщика --</option>
                {suppliers.map(supplier => (
                  <option key={supplier.id} value={String(supplier.id)}>
                    {supplier.name || `Поставщик #${supplier.id}`}
                  </option>
                ))}
              </select>
            )}
            {errors.supplierId && <div className="error">{errors.supplierId}</div>}
            {process.env.NODE_ENV === 'development' && (
              <div style={{fontSize: '11px', color: '#6b7280', marginTop: '4px'}}>
                Доступно поставщиков: {suppliers.length}
              </div>
            )}
          </div>

          <div className="mt-3">
            <label className="form-label" htmlFor="mainWarehouseSelect">Основной склад</label>
            <div className="text-muted small mb-2">
              Выберите основной склад, к которому относится этот склад поставщика. Итого по основному складу будет включать остатки на основном складе и всех прикрепленных складах поставщиков.
            </div>
            <select
              id="mainWarehouseSelect"
              className="form-select form-select-sm"
              value={formData.mainWarehouseId}
              onChange={(e) => handleChange('mainWarehouseId', e.target.value)}
            >
              <option value="">-- Выберите основной склад --</option>
              {warehouses
                .filter(w => w.type === 'warehouse')
                .map(warehouse => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.address || `Склад #${warehouse.id}`}
                  </option>
                ))}
            </select>
          </div>

          <div className="mt-3">
            <label className="form-label" htmlFor="orderAcceptanceTime">
              Время приема заказов
            </label>
            <div className="text-muted small mb-2">
              Укажите время, до которого принимаются заказы на этом складе поставщика (формат ЧЧ:ММ, например, 18:00).
            </div>
            <input
              type="time"
              id="orderAcceptanceTime"
              className="form-control form-control-sm"
              style={{ maxWidth: 180 }}
              value={formData.orderAcceptanceTime}
              onChange={(e) => handleChange('orderAcceptanceTime', e.target.value)}
              placeholder="18:00"
            />
          </div>
        </>
      )}

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{marginTop: '12px'}}>
          {Object.values(errors)[0]}
        </div>
      )}

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary">Сохранить</Button>
      </div>
    </form>
  );
}


/**
 * Integrations Page
 * Страница настроек интеграций (маркетплейсы по организациям + поставщики)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { integrationsApi } from '../../services/integrations.api';
import { organizationsApi } from '../../services/organizations.api';
import { marketplaceCabinetsApi } from '../../services/marketplaceCabinets.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { useAuth } from '../../context/AuthContext';
import './Integrations.css';

export function Integrations() {
  const { selectedOrganizationId, setSelectedOrganizationId } = useAuth();
  const [activeTab, setActiveTab] = useState('marketplaces');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [configs, setConfigs] = useState({
    marketplaces: { ozon: {}, wildberries: {}, yandex: {} },
    suppliers: { mikado: {}, moskvorechie: {} }
  });
  const [organizations, setOrganizations] = useState([]);
  const selectedOrgId = selectedOrganizationId ? Number(selectedOrganizationId) : null;
  const [cabinets, setCabinets] = useState([]);
  const [cabinetsLoading, setCabinetsLoading] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await integrationsApi.getAll();
      setConfigs((prev) => response.data || prev);
    } catch (err) {
      console.error('Ошибка загрузки настроек интеграций:', err);
      setError(err.message || 'Ошибка загрузки настроек');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    organizationsApi
      .getAll()
      .then((r) => setOrganizations(r?.data || []))
      .catch(() => setOrganizations([]));
  }, []);

  // Интеграции теперь привязаны к организации — грузим/обновляем при смене организации.
  useEffect(() => {
    if (!selectedOrgId) return;
    loadConfigs();
  }, [selectedOrgId, loadConfigs]);

  // Если организация ещё не выбрана — выберем первую доступную (иначе заголовок X-Organization-Id не уйдёт).
  useEffect(() => {
    if (selectedOrgId) return;
    const first = (organizations || [])[0];
    if (first?.id != null) {
      setSelectedOrganizationId(String(first.id));
    }
  }, [organizations, selectedOrgId, setSelectedOrganizationId]);

  useEffect(() => {
    if (!selectedOrgId) {
      setCabinets([]);
      return;
    }
    setCabinetsLoading(true);
    marketplaceCabinetsApi.list(selectedOrgId)
      .then((r) => setCabinets(r?.data || []))
      .catch(() => setCabinets([]))
      .finally(() => setCabinetsLoading(false));
  }, [selectedOrgId]);

  const loadCabinets = () => {
    if (!selectedOrgId) return;
    setCabinetsLoading(true);
    marketplaceCabinetsApi.list(selectedOrgId)
      .then((r) => setCabinets(r?.data || []))
      .catch(() => setCabinets([]))
      .finally(() => setCabinetsLoading(false));
  };

  const handleSaveMarketplace = async (type, formData) => {
    try {
      setError(null);
      await integrationsApi.saveMarketplace(type, formData);
      await loadConfigs();
      alert(`${type === 'ozon' ? 'Ozon' : type === 'wildberries' ? 'Wildberries' : 'Yandex Market'} настроен успешно!`);
    } catch (err) {
      console.error(`Ошибка сохранения настроек ${type}:`, err);
      setError(err.message || `Ошибка сохранения настроек ${type}`);
    }
  };

  const handleSaveSupplier = async (type, formData) => {
    try {
      setError(null);
      await integrationsApi.saveSupplier(type, formData);
      await loadConfigs();
      alert(`${type === 'mikado' ? 'Mikado' : 'Moskvorechie'} настроен успешно!`);
    } catch (err) {
      console.error(`Ошибка сохранения настроек ${type}:`, err);
      setError(err.message || `Ошибка сохранения настроек ${type}`);
    }
  };

  const handleTest = (type, category) => {
    // Заглушка для теста подключения (можно добавить реальный тест позже)
    alert(`Проверка подключения ${category === 'marketplaces' ? type : type} (в разработке)`);
  };

  if (loading) {
    return <div className="loading">Загрузка настроек интеграций...</div>;
  }

  return (
    <div className="card">
      <h1 className="title">Интеграции</h1>
      <p className="subtitle">Настройка подключений к маркетплейсам и поставщикам</p>
      <p className="subtitle small text-muted mb-3" style={{ marginTop: '-0.25rem' }}>
        <a
          href="/api/help/marketplace-product-identifiers"
          target="_blank"
          rel="noopener noreferrer"
        >
          Справочник: идентификаторы товара на маркетплейсах
        </a>
        {' — открывается в браузере (новая вкладка).'}
      </p>

      {error && (
        <div className="error" style={{ marginBottom: '16px' }}>
          {error}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab-btn ${activeTab === 'marketplaces' ? 'active' : ''}`}
          onClick={() => setActiveTab('marketplaces')}
        >
          Маркетплейсы
        </button>
        <button
          className={`tab-btn ${activeTab === 'suppliers' ? 'active' : ''}`}
          onClick={() => setActiveTab('suppliers')}
        >
          Поставщики
        </button>
      </div>

      {activeTab === 'marketplaces' && (
        <MarketplacesTab
          organizations={organizations}
          selectedOrgId={selectedOrgId}
          onSelectOrg={(id) => setSelectedOrganizationId(id != null && id !== '' ? String(id) : null)}
          cabinets={cabinets}
          cabinetsLoading={cabinetsLoading}
          onSaveCabinet={async (cabinetId, type, formData) => {
            if (!selectedOrgId) return;
            if (cabinetId) {
              await marketplaceCabinetsApi.update(selectedOrgId, cabinetId, { config: formData });
            } else {
              await marketplaceCabinetsApi.create(selectedOrgId, {
                marketplace_type: type,
                name: type === 'ozon' ? 'Ozon' : type === 'yandex' ? 'Яндекс.Маркет' : 'Wildberries',
                config: formData
              });
            }
            loadCabinets();
          }}
          onDeleteCabinet={async (id) => {
            if (!selectedOrgId || !window.confirm('Удалить кабинет?')) return;
            await marketplaceCabinetsApi.delete(selectedOrgId, id);
            loadCabinets();
          }}
          onTest={handleTest}
          onSaveLegacy={handleSaveMarketplace}
        />
      )}

      {activeTab === 'suppliers' && (
        <SuppliersTab
          configs={configs.suppliers}
          onSave={handleSaveSupplier}
          onTest={handleTest}
        />
      )}
    </div>
  );
}

// Компонент для вкладки маркетплейсов (по организациям: Озон/Яндекс — несколько кабинетов, ВБ — один)
function MarketplacesTab({
  organizations,
  selectedOrgId,
  onSelectOrg,
  cabinets,
  cabinetsLoading,
  onSaveCabinet,
  onDeleteCabinet,
  onTest,
  onSaveLegacy
}) {
  const [activeMarketplace, setActiveMarketplace] = useState('ozon');
  const [addingCabinetType, setAddingCabinetType] = useState(null);
  const onSave = onSaveLegacy || (() => {});

  const MarketplaceForm = ({ type, config, onSave: onSaveForm, onTest: onTestForm, cabinetId, onDelete }) => {
    const [formData, setFormData] = useState(config || {});
    const [saving, setSaving] = useState(false);
    const [tokenStatus, setTokenStatus] = useState(null);
    const [tokenCheckLoading, setTokenCheckLoading] = useState(false);
    const [isTariffsModalOpen, setIsTariffsModalOpen] = useState(false);
    const [tariffsData, setTariffsData] = useState(null);
    const [tariffsLoading, setTariffsLoading] = useState(false);
    const [tariffsError, setTariffsError] = useState(null);
    const [commissionsData, setCommissionsData] = useState(null);
    const [commissionsLoading, setCommissionsLoading] = useState(false);
    const [commissionsError, setCommissionsError] = useState(null);
    const [activeTab, setActiveTab] = useState('logistics');
    const [commissionSearch, setCommissionSearch] = useState('');
    const [expandedParents, setExpandedParents] = useState(new Set());
    const [isOzonCategoriesModalOpen, setIsOzonCategoriesModalOpen] = useState(false);
    const [ozonCategoriesData, setOzonCategoriesData] = useState(null);
    const [ozonCategoriesLoading, setOzonCategoriesLoading] = useState(false);
    const [ozonCategoriesError, setOzonCategoriesError] = useState(null);
    const [ozonCategorySearch, setOzonCategorySearch] = useState('');
    const [isYmCategoriesModalOpen, setIsYmCategoriesModalOpen] = useState(false);
    const [ymCategoriesData, setYmCategoriesData] = useState(null);
    const [ymCategoriesLoading, setYmCategoriesLoading] = useState(false);
    const [ymCategoriesError, setYmCategoriesError] = useState(null);
    const [ymCategorySearch, setYmCategorySearch] = useState('');

    useEffect(() => {
      setFormData(config || {});
      setTokenStatus(null);
    }, [config]);

    const handleSubmit = async (e) => {
      e.preventDefault();
      setSaving(true);
      try {
        if (onSaveForm) await onSaveForm(type, formData);
        else await onSave(type, formData);
      } finally {
        setSaving(false);
      }
    };

    const handleChange = (field, value) => {
      setFormData({ ...formData, [field]: value });
    };

    const handleCheckToken = async () => {
      setTokenCheckLoading(true);
      try {
        const s = await integrationsApi.getMarketplaceTokenStatus(type);
        setTokenStatus(s);
      } catch (e) {
        setTokenStatus({ marketplace: type, valid: false, message: e?.message || 'Ошибка проверки токена' });
      } finally {
        setTokenCheckLoading(false);
      }
    };

    const handleLoadTariffs = async () => {
      if (!formData.api_key) {
        alert('Сначала укажите API ключ');
        return;
      }
      
      setTariffsLoading(true);
      setCommissionsLoading(true);
      setTariffsError(null);
      setCommissionsError(null);
      setActiveTab('logistics');
      
      try {
        // Загружаем данные последовательно, чтобы не превысить лимит API (1 запрос в минуту)
        // Сначала тарифы
        try {
          const tariffsResponse = await integrationsApi.getWildberriesTariffs();
          setTariffsData(tariffsResponse.data);
        } catch (err) {
          console.error('Ошибка загрузки тарифов:', err);
          const errorMessage = err.response?.status === 429 
            ? 'Превышен лимит запросов к API Wildberries. Попробуйте позже.'
            : (err.message || 'Ошибка загрузки тарифов');
          setTariffsError(errorMessage);
        } finally {
          setTariffsLoading(false);
        }
        
        // Открываем модальное окно сразу после загрузки тарифов
        setIsTariffsModalOpen(true);
        
        // Загружаем комиссии из БД (без задержки, так как данные уже в БД)
        try {
          const commissionsResponse = await integrationsApi.getWildberriesCommissions();
          setCommissionsData(commissionsResponse.data);
        } catch (err) {
          console.error('Ошибка загрузки комиссий:', err);
          setCommissionsError(err.message || 'Ошибка загрузки комиссий');
        } finally {
          setCommissionsLoading(false);
        }
      } catch (err) {
        console.error('Ошибка загрузки данных:', err);
        setTariffsError(err.message || 'Ошибка загрузки данных');
        alert(err.message || 'Ошибка загрузки данных');
        setTariffsLoading(false);
        setCommissionsLoading(false);
      }
    };

    const handleLoadOzonCategories = async () => {
      if (!formData.client_id || !formData.api_key) {
        alert('Сначала укажите Client ID и API Key');
        return;
      }
      
      setOzonCategoriesLoading(true);
      setOzonCategoriesError(null);
      
      try {
        const categoriesResponse = await integrationsApi.getOzonCategories({ forceRefresh: true });
        const categories = categoriesResponse?.data || [];
        
        if (categories.length === 0) {
          setOzonCategoriesError('Категории не найдены. Возможно, не настроена интеграция Ozon или API не вернул данные.');
          setIsOzonCategoriesModalOpen(true);
        } else {
          setOzonCategoriesData(categories);
          setIsOzonCategoriesModalOpen(true);
        }
      } catch (err) {
        console.error('Ошибка загрузки категорий Ozon:', err);
        console.error('Response data:', err.response?.data);
        console.error('Response status:', err.response?.status);
        
        // Извлекаем понятное сообщение об ошибке
        let errorMessage = 'Ошибка загрузки категорий Ozon';
        
        if (err.response?.data?.error) {
          errorMessage = err.response.data.error;
        } else if (err.response?.data?.message) {
          errorMessage = err.response.data.message;
        } else if (err.response?.data?.details) {
          errorMessage = err.response.data.details;
        } else if (err.message) {
          errorMessage = err.message;
        }
        
        // Если это ошибка 404 от API Ozon, добавляем подсказку
        if (errorMessage.includes('404') || errorMessage.includes('не найден')) {
          errorMessage = 'API Ozon вернул ошибку 404. Проверьте правильность Client ID и API Key в настройках интеграции. Убедитесь, что используете актуальные учетные данные из личного кабинета Ozon Seller.';
        }
        
        setOzonCategoriesError(errorMessage);
        
        // Показываем модальное окно с ошибкой
        setIsOzonCategoriesModalOpen(true);
      } finally {
        setOzonCategoriesLoading(false);
      }
    };

    const handleLoadYmCategories = async () => {
      if (!formData.api_key) {
        alert('Сначала укажите API Key');
        return;
      }
      setYmCategoriesLoading(true);
      setYmCategoriesError(null);
      try {
        await integrationsApi.updateYandexCategories();
        const categoriesResponse = await integrationsApi.getYandexCategories({ forceRefresh: true });
        const categories = categoriesResponse?.data || [];
        if (categories.length === 0) {
          setYmCategoriesError('Категории не найдены. Проверьте API Key и настройки интеграции.');
        } else {
          setYmCategoriesData(categories);
          setYmCategoriesError(null);
        }
      } catch (err) {
        setYmCategoriesError(err.response?.data?.error || err.message || 'Ошибка загрузки категорий');
      } finally {
        setYmCategoriesLoading(false);
      }
      setIsYmCategoriesModalOpen(true);
    };

    if (type === 'ozon') {
      return (
        <form onSubmit={handleSubmit} className="integration-form">
          <div className="field">
            <label className="label">Client ID</label>
            <input
              type="text"
              className="input"
              value={formData.client_id || ''}
              onChange={(e) => handleChange('client_id', e.target.value)}
              placeholder="Ваш Client ID"
              required
            />
          </div>
          <div className="field">
            <label className="label">API Key</label>
            <input
              type="password"
              className="input"
              value={formData.api_key || ''}
              onChange={(e) => handleChange('api_key', e.target.value)}
              placeholder="Ваш API ключ"
              required
            />
          </div>
          <div className="field">
            <label className="label">Дата окончания токена (опционально)</label>
            <input
              type="date"
              className="input"
              value={(formData.token_expires_at || '').slice(0, 10)}
              onChange={(e) => handleChange('token_expires_at', e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              Срок действия токенов — до 180 дней. Если не указать, при сохранении подставится дата через 180 дней. За 10 дней до окончания придёт уведомление.
            </div>
          </div>
          {tokenStatus && (
            <div style={{ marginBottom: '10px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: tokenStatus.valid ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
              <strong>{tokenStatus.valid ? 'Токен валиден' : 'Токен не проходит проверку'}</strong>
              <div style={{ marginTop: '4px', color: 'var(--muted)' }}>{tokenStatus.message}</div>
              {Array.isArray(tokenStatus.checks) && tokenStatus.checks.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {tokenStatus.checks.map((c, idx) => (
                    <div key={`${c.scope || 'scope'}_${idx}`} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 600, minWidth: '90px' }}>{String(c.scope)}:</span>
                      <span style={{ color: c.valid ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>
                        {c.valid ? 'OK' : 'FAIL'}
                      </span>
                      <span style={{ color: 'var(--muted)' }}>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {tokenStatus.expires_at && (
                <div style={{ marginTop: '4px', color: 'var(--muted)' }}>
                  expires_at: {String(tokenStatus.expires_at).slice(0, 10)}{tokenStatus.days_left != null ? ` (дней: ${tokenStatus.days_left})` : ''}
                </div>
              )}
            </div>
          )}
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onTest(type, 'marketplaces')}
            >
              Проверить подключение
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCheckToken}
              disabled={tokenCheckLoading || !formData.client_id || !formData.api_key}
            >
              {tokenCheckLoading ? 'Проверка…' : 'Проверить токен'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleLoadOzonCategories}
              disabled={ozonCategoriesLoading || !formData.client_id || !formData.api_key}
            >
              {ozonCategoriesLoading ? 'Загрузка...' : '📁 Категории'}
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
          <Modal
            isOpen={isOzonCategoriesModalOpen}
            onClose={() => {
              setIsOzonCategoriesModalOpen(false);
              setOzonCategoriesData(null);
              setOzonCategoriesError(null);
              setOzonCategorySearch('');
            }}
            title="Категории Ozon"
            size="large"
          >
            <div>
              {ozonCategoriesError ? (
                <div style={{color: 'var(--error)', padding: '16px', background: 'var(--accent-50)', borderRadius: '8px', border: '1px solid var(--accent-100)'}}>
                  <div style={{fontWeight: 600, marginBottom: '8px'}}>Ошибка загрузки категорий</div>
                  <div style={{fontSize: '14px'}}>{ozonCategoriesError}</div>
                  {ozonCategoriesError.includes('Client ID') || ozonCategoriesError.includes('API Key') ? (
                    <div style={{marginTop: '12px', fontSize: '13px', color: 'var(--muted)'}}>
                      Пожалуйста, настройте интеграцию Ozon: укажите Client ID и API Key в форме выше и нажмите "Сохранить".
                    </div>
                  ) : null}
                </div>
              ) : ozonCategoriesLoading ? (
                <div style={{padding: '16px', textAlign: 'center'}}>
                  Загрузка данных...
                </div>
              ) : ozonCategoriesData && ozonCategoriesData.length > 0 ? (
                <div>
                  <div style={{marginBottom: '16px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px'}}>
                    <div><strong>Всего категорий:</strong> {ozonCategoriesData.length}</div>
                  </div>
                  {/* Поиск по категории */}
                  <div style={{marginBottom: '16px'}}>
                    <input
                      type="text"
                      placeholder="Поиск по названию категории..."
                      value={ozonCategorySearch}
                      onChange={(e) => setOzonCategorySearch(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                        fontSize: '14px',
                        background: 'var(--bg)',
                        color: 'var(--text)'
                      }}
                    />
                  </div>
                  
                  {/* Список категорий */}
                  <div style={{maxHeight: '500px', overflowY: 'auto'}}>
                    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                      <thead>
                        <tr style={{background: 'var(--bg-secondary)'}}>
                          <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>ID</th>
                          <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)'}}>Название</th>
                          <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)'}}>Путь</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ozonCategoriesData
                          .filter(cat => {
                            if (!ozonCategorySearch.trim()) return true;
                            const searchLower = ozonCategorySearch.toLowerCase();
                            return (cat.name || '').toLowerCase().includes(searchLower) ||
                                   (cat.path || '').toLowerCase().includes(searchLower);
                          })
                          .map((category, index) => {
                            // Гарантируем уникальный ключ - используем комбинацию id и index
                            const uniqueKey = category.id && category.id !== 'undefined' && category.id !== 'null' 
                              ? `ozon_cat_${category.id}` 
                              : `ozon_cat_index_${index}`;
                            return (
                            <tr key={uniqueKey} style={{borderBottom: '1px solid var(--border)'}}>
                              <td style={{padding: '8px 6px', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '12px', color: 'var(--muted)'}}>
                                {category.id || '—'}
                              </td>
                              <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{category.name || '—'}</td>
                              <td style={{padding: '8px 6px', color: 'var(--muted)', fontSize: '12px'}}>{category.path || '—'}</td>
                            </tr>
                          );
                          })}
                      </tbody>
                    </table>
                    {ozonCategorySearch && ozonCategoriesData.filter(cat => {
                      const searchLower = ozonCategorySearch.toLowerCase();
                      return (cat.name || '').toLowerCase().includes(searchLower) ||
                             (cat.path || '').toLowerCase().includes(searchLower);
                    }).length === 0 && (
                      <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                        Ничего не найдено
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                  Нет данных о категориях
                </div>
              )}
            </div>
          </Modal>
        </form>
      );
    }

    if (type === 'wildberries') {
      return (
        <form onSubmit={handleSubmit} className="integration-form">
          <div className="field">
            <label className="label">API Key</label>
            <input
              type="password"
              className="input"
              value={formData.api_key || ''}
              onChange={(e) => handleChange('api_key', e.target.value)}
              placeholder="Ваш API ключ"
              required
            />
          </div>
          <div className="field">
            <label className="label">Дата окончания токена (опционально)</label>
            <input
              type="date"
              className="input"
              value={(formData.token_expires_at || '').slice(0, 10)}
              onChange={(e) => handleChange('token_expires_at', e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              Срок действия токенов — до 180 дней. Если не указать, при сохранении подставится дата через 180 дней. За 10 дней до окончания придёт уведомление.
            </div>
          </div>
          {tokenStatus && (
            <div style={{ marginBottom: '10px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: tokenStatus.valid ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
              <strong>{tokenStatus.valid ? 'Токен валиден' : 'Токен не проходит проверку'}</strong>
              <div style={{ marginTop: '4px', color: 'var(--muted)' }}>{tokenStatus.message}</div>
              {Array.isArray(tokenStatus.checks) && tokenStatus.checks.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {tokenStatus.checks.map((c, idx) => (
                    <div key={`wb_${c.scope}_${idx}`} style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, minWidth: '100px' }}>{String(c.scope)}:</span>
                      <span style={{ color: c.valid ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}>{c.valid ? 'OK' : 'FAIL'}</span>
                      <span style={{ color: 'var(--muted)', wordBreak: 'break-word' }}>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {tokenStatus.expires_at && (
                <div style={{ marginTop: '4px', color: 'var(--muted)' }}>
                  expires_at: {String(tokenStatus.expires_at).slice(0, 10)}{tokenStatus.days_left != null ? ` (дней: ${tokenStatus.days_left})` : ''}
                </div>
              )}
            </div>
          )}
          <div className="field">
            <label className="label">% Эквайринга</label>
            <input
              type="number"
              className="input"
              value={formData.acquiring_percent || ''}
              onChange={(e) => handleChange('acquiring_percent', e.target.value)}
              placeholder="Процент эквайринга для расчета цены продажи"
              min="0"
              max="100"
              step="0.01"
            />
            <small style={{color: 'var(--muted)', fontSize: '12px', marginTop: '4px', display: 'block'}}>
              Процент эквайринга используется для расчета цены продажи товаров на Wildberries (например, 2.5)
            </small>
          </div>
          <div className="field">
            <label className="label">% Услуги Джем</label>
            <input
              type="number"
              className="input"
              value={formData.gem_services_percent || ''}
              onChange={(e) => handleChange('gem_services_percent', e.target.value)}
              placeholder="Процент услуг Джем для расчета цены продажи"
              min="0"
              max="100"
              step="0.01"
            />
            <small style={{color: 'var(--muted)', fontSize: '12px', marginTop: '4px', display: 'block'}}>
              Процент услуг Джем вычисляется от суммы товара и добавляется к расчету минимальной цены (например, 1.5)
            </small>
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onTest(type, 'marketplaces')}
            >
              Проверить подключение
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCheckToken}
              disabled={tokenCheckLoading || !formData.api_key}
            >
              {tokenCheckLoading ? 'Проверка…' : 'Проверить токен'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleLoadTariffs}
              disabled={tariffsLoading || !formData.api_key}
            >
              {tariffsLoading ? 'Загрузка...' : '📊 Тарифы'}
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
          <Modal
            isOpen={isTariffsModalOpen}
            onClose={() => {
              setIsTariffsModalOpen(false);
              setTariffsData(null);
              setTariffsError(null);
              setCommissionsData(null);
              setCommissionsError(null);
              setActiveTab('logistics');
            }}
            title="Тарифы Wildberries"
            size="large"
          >
            <div>
              {/* Вкладки */}
              <div style={{display: 'flex', gap: '8px', marginBottom: '16px', borderBottom: '2px solid var(--border)'}}>
                <button
                  type="button"
                  onClick={() => setActiveTab('logistics')}
                  style={{
                    padding: '10px 16px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    borderBottom: activeTab === 'logistics' ? '2px solid var(--primary)' : '2px solid transparent',
                    color: activeTab === 'logistics' ? 'var(--primary)' : 'var(--text)',
                    fontWeight: activeTab === 'logistics' ? 600 : 400,
                    transition: 'all 0.2s'
                  }}
                >
                  Логистика
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('commission')}
                  style={{
                    padding: '10px 16px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    borderBottom: activeTab === 'commission' ? '2px solid var(--primary)' : '2px solid transparent',
                    color: activeTab === 'commission' ? 'var(--primary)' : 'var(--text)',
                    fontWeight: activeTab === 'commission' ? 600 : 400,
                    transition: 'all 0.2s'
                  }}
                >
                  Комиссия
                </button>
              </div>

              {/* Вкладка Логистика */}
              {activeTab === 'logistics' && (
                <>
                  {tariffsError ? (
                    <div style={{color: 'var(--error)', padding: '16px'}}>
                      Ошибка: {tariffsError}
                    </div>
                  ) : tariffsLoading ? (
                    <div style={{padding: '16px', textAlign: 'center'}}>
                      Загрузка данных...
                    </div>
                  ) : tariffsData?.response?.data ? (
                    <div>
                      <div style={{marginBottom: '16px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px'}}>
                        <div><strong>Дата следующего обновления:</strong> {tariffsData.response.data.dtNextBox || '—'}</div>
                        <div><strong>Действует до:</strong> {tariffsData.response.data.dtTillMax || '—'}</div>
                      </div>
                      {tariffsData.response.data.warehouseList && tariffsData.response.data.warehouseList.length > 0 ? (
                        <div style={{overflowX: 'auto'}}>
                          <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                            <thead>
                              <tr style={{background: 'var(--bg-secondary)'}}>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Склад</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Регион</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>FBS 1л, ₽</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>FBS коэф, %</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>FBS доп.л, ₽</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Лог. 1л, ₽</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Лог. коэф, %</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Лог. доп.л, ₽</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Хран. 1л, ₽</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Хран. коэф, %</th>
                                <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Хран. доп.л, ₽</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tariffsData.response.data.warehouseList.map((warehouse, index) => (
                                <tr key={index} style={{borderBottom: '1px solid var(--border)'}}>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.warehouseName || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.geoName || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryMarketplaceBase || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryMarketplaceCoefExpr || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryMarketplaceLiter || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryBase || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryCoefExpr || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxDeliveryLiter || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxStorageBase || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxStorageCoefExpr || '—'}</td>
                                  <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{warehouse.boxStorageLiter || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                          Нет данных о тарифах
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                      Нет данных о тарифах
                    </div>
                  )}
                </>
              )}

              {/* Вкладка Комиссия */}
              {activeTab === 'commission' && (
                <>
                  {commissionsError ? (
                    <div style={{color: 'var(--error)', padding: '16px'}}>
                      Ошибка: {commissionsError}
                      <div style={{marginTop: '12px'}}>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={async () => {
                            setCommissionsLoading(true);
                            setCommissionsError(null);
                            try {
                              await integrationsApi.updateWildberriesCommissions();
                              const commissionsResponse = await integrationsApi.getWildberriesCommissions();
                              setCommissionsData(commissionsResponse.data);
                            } catch (err) {
                              console.error('Ошибка обновления комиссий:', err);
                              setCommissionsError(err.message || 'Ошибка обновления комиссий');
                            } finally {
                              setCommissionsLoading(false);
                            }
                          }}
                        >
                          Обновить комиссии из API
                        </Button>
                      </div>
                    </div>
                  ) : commissionsLoading ? (
                    <div style={{padding: '16px', textAlign: 'center'}}>
                      Загрузка данных...
                    </div>
                  ) : commissionsData?.report && Array.isArray(commissionsData.report) && commissionsData.report.length > 0 ? (
                    <div>
                      {/* Кнопка обновления и поиск по категории */}
                      <div style={{marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center'}}>
                        <input
                          type="text"
                          placeholder="Поиск по названию категории..."
                          value={commissionSearch}
                          onChange={(e) => {
                            setCommissionSearch(e.target.value);
                            // При очистке поиска сворачиваем все категории
                            if (!e.target.value.trim()) {
                              setExpandedParents(new Set());
                            }
                          }}
                          style={{
                            flex: 1,
                            padding: '8px 12px',
                            border: '1px solid var(--border)',
                            borderRadius: '4px',
                            fontSize: '14px',
                            background: 'var(--bg)',
                            color: 'var(--text)'
                          }}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={commissionsLoading}
                          onClick={async () => {
                            setCommissionsLoading(true);
                            setCommissionsError(null);
                            try {
                              await integrationsApi.updateWildberriesCommissions();
                              const commissionsResponse = await integrationsApi.getWildberriesCommissions();
                              setCommissionsData(commissionsResponse.data);
                              alert('Комиссии успешно обновлены!');
                            } catch (err) {
                              console.error('Ошибка обновления комиссий:', err);
                              setCommissionsError(err.message || 'Ошибка обновления комиссий');
                              alert('Ошибка обновления комиссий: ' + (err.message || 'Неизвестная ошибка'));
                            } finally {
                              setCommissionsLoading(false);
                            }
                          }}
                          style={{whiteSpace: 'nowrap'}}
                        >
                          Обновить
                        </Button>
                      </div>
                      
                      {/* Таблица комиссий с группировкой */}
                      <div style={{overflowX: 'auto'}}>
                        {(() => {
                          // Группируем комиссии по родительским категориям
                          const groupedByParent = {};
                          commissionsData.report.forEach(item => {
                            const parentName = item.parentName || 'Без категории';
                            if (!groupedByParent[parentName]) {
                              groupedByParent[parentName] = [];
                            }
                            groupedByParent[parentName].push(item);
                          });
                          
                          // Фильтруем по поисковому запросу
                          const searchLower = commissionSearch.toLowerCase();
                          const filteredGroups = Object.entries(groupedByParent).map(([parentName, items]) => {
                            const filteredItems = items.filter(item => {
                              if (!searchLower) return true;
                              const categoryName = (item.subjectName || '').toLowerCase();
                              const parentNameLower = (item.parentName || '').toLowerCase();
                              return categoryName.includes(searchLower) || parentNameLower.includes(searchLower);
                            });
                            return { parentName, items: filteredItems, allItems: items };
                          }).filter(group => group.items.length > 0);
                          
                          const toggleParent = (parentName) => {
                            setExpandedParents(prev => {
                              const newExpanded = new Set(prev);
                              if (newExpanded.has(parentName)) {
                                newExpanded.delete(parentName);
                              } else {
                                newExpanded.add(parentName);
                              }
                              return newExpanded;
                            });
                          };
                          
                          return (
                            <>
                              {filteredGroups.length === 0 ? (
                                <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                                  Ничего не найдено
                                </div>
                              ) : (
                                <>
                                  <div style={{marginBottom: '8px', fontSize: '12px', color: 'var(--muted)'}}>
                                    Родительских категорий: {filteredGroups.length} | Всего категорий: {commissionsData.report.length}
                                  </div>
                                  <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                                    <thead>
                                      <tr style={{background: 'var(--bg-secondary)'}}>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap', width: '30%'}}>Родительская категория</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Бронирование, %</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Маркетплейс (FBS), %</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Самовывоз (C&C), %</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Витрина/Курьер WB (DBS/DBW), %</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Витрина экспресс (EDBS), %</th>
                                        <th style={{padding: '8px 6px', textAlign: 'left', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap'}}>Склад WB (FBW), %</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {filteredGroups.map((group, groupIndex) => {
                                        const isExpanded = expandedParents.has(group.parentName) || (searchLower && group.items.length > 0);
                                        
                                        return (
                                          <React.Fragment key={groupIndex}>
                                            {/* Родительская категория */}
                                            <tr 
                                              style={{
                                                background: 'var(--bg-secondary)',
                                                cursor: 'pointer',
                                                borderBottom: '2px solid var(--border)'
                                              }}
                                              onClick={() => toggleParent(group.parentName)}
                                            >
                                              <td style={{padding: '8px 6px', fontWeight: 600}}>
                                                <span style={{marginRight: '8px'}}>
                                                  {isExpanded ? '▼' : '▶'}
                                                </span>
                                                {group.parentName} ({group.items.length})
                                              </td>
                                              <td colSpan="6" style={{padding: '8px 6px', color: 'var(--muted)', fontSize: '12px'}}>
                                                Нажмите, чтобы {isExpanded ? 'свернуть' : 'развернуть'}
                                              </td>
                                            </tr>
                                            {/* Дочерние категории */}
                                            {isExpanded && group.items.map((item, itemIndex) => (
                                              <tr key={`${groupIndex}-${itemIndex}`} style={{borderBottom: '1px solid var(--border)'}}>
                                                <td style={{padding: '8px 6px 8px 32px', whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: '12px'}}>
                                                  {item.subjectName || '—'}
                                                </td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.kgvpBooking !== undefined && item.kgvpBooking !== null ? `${item.kgvpBooking}%` : '—'}</td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.kgvpMarketplace !== undefined && item.kgvpMarketplace !== null ? `${item.kgvpMarketplace}%` : '—'}</td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.kgvpPickup !== undefined && item.kgvpPickup !== null ? `${item.kgvpPickup}%` : '—'}</td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.kgvpSupplier !== undefined && item.kgvpSupplier !== null ? `${item.kgvpSupplier}%` : '—'}</td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.kgvpSupplierExpress !== undefined && item.kgvpSupplierExpress !== null ? `${item.kgvpSupplierExpress}%` : '—'}</td>
                                                <td style={{padding: '8px 6px', whiteSpace: 'nowrap'}}>{item.paidStorageKgvp !== undefined && item.paidStorageKgvp !== null ? `${item.paidStorageKgvp}%` : '—'}</td>
                                              </tr>
                                            ))}
                                          </React.Fragment>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div style={{padding: '16px', textAlign: 'center', color: 'var(--muted)'}}>
                      <p style={{marginBottom: '16px'}}>Нет данных о комиссиях</p>
                      <p style={{fontSize: '12px', marginBottom: '16px'}}>
                        Комиссии WB загружаются автоматически каждый день в 1:00 или вручную по кнопке ниже.
                      </p>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={commissionsLoading}
                        onClick={async () => {
                          setCommissionsLoading(true);
                          setCommissionsError(null);
                          try {
                            await integrationsApi.updateWildberriesCommissions();
                            const commissionsResponse = await integrationsApi.getWildberriesCommissions();
                            setCommissionsData(commissionsResponse.data);
                            alert('Комиссии успешно загружены!');
                          } catch (err) {
                            console.error('Ошибка загрузки комиссий:', err);
                            setCommissionsError(err.message || 'Ошибка загрузки комиссий');
                            alert('Ошибка загрузки комиссий: ' + (err.message || 'Неизвестная ошибка'));
                          } finally {
                            setCommissionsLoading(false);
                          }
                        }}
                      >
                        {commissionsLoading ? 'Загрузка...' : 'Загрузить комиссии из API'}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </Modal>
        </form>
      );
    }

    if (type === 'yandex') {
      return (
        <form onSubmit={handleSubmit} className="integration-form">
          <div className="field">
            <label className="label">Yandex API Key</label>
            <input
              type="password"
              className="input"
              value={formData.api_key || ''}
              onChange={(e) => handleChange('api_key', e.target.value)}
              placeholder="Ключ API от Яндекс.Маркета"
              required
            />
          </div>
          <div className="field">
            <label className="label">Дата окончания токена (опционально)</label>
            <input
              type="date"
              className="input"
              value={(formData.token_expires_at || '').slice(0, 10)}
              onChange={(e) => handleChange('token_expires_at', e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              Срок действия токенов — до 180 дней. Если не указать, при сохранении подставится дата через 180 дней. За 10 дней до окончания придёт уведомление.
            </div>
          </div>
          {tokenStatus && (
            <div style={{ marginBottom: '10px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', background: tokenStatus.valid ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
              <strong>{tokenStatus.valid ? 'Токен валиден' : 'Токен не проходит проверку'}</strong>
              <div style={{ marginTop: '4px', color: 'var(--muted)' }}>{tokenStatus.message}</div>
              {tokenStatus.expires_at && (
                <div style={{ marginTop: '4px', color: 'var(--muted)' }}>
                  expires_at: {String(tokenStatus.expires_at).slice(0, 10)}{tokenStatus.days_left != null ? ` (дней: ${tokenStatus.days_left})` : ''}
                </div>
              )}
            </div>
          )}
          <div className="field">
            <label className="label">Campaign ID</label>
            <input
              type="text"
              className="input"
              value={formData.campaign_id || ''}
              onChange={(e) => handleChange('campaign_id', e.target.value)}
              placeholder="ID кампании"
              required
            />
          </div>
          <div className="field">
            <label className="label">Business ID (кабинет)</label>
            <input
              type="text"
              className="input"
              value={formData.business_id || ''}
              onChange={(e) => handleChange('business_id', e.target.value)}
              placeholder="Нужен для заказов. Настройки → API в ЛК Маркета"
            />
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onTest(type, 'marketplaces')}
            >
              Проверить подключение
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCheckToken}
              disabled={tokenCheckLoading || !formData.api_key}
            >
              {tokenCheckLoading ? 'Проверка…' : 'Проверить токен'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleLoadYmCategories}
              disabled={ymCategoriesLoading || !formData.api_key}
            >
              {ymCategoriesLoading ? 'Загрузка...' : '📁 Категории'}
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
          <Modal
            isOpen={isYmCategoriesModalOpen}
            onClose={() => {
              setIsYmCategoriesModalOpen(false);
              setYmCategoriesData(null);
              setYmCategoriesError(null);
              setYmCategorySearch('');
            }}
            title="Категории Яндекс.Маркета"
            size="large"
          >
            <div>
              {ymCategoriesError ? (
                <div style={{color: 'var(--error)', padding: '16px', background: 'var(--accent-50)', borderRadius: '8px'}}>
                  {ymCategoriesError}
                </div>
              ) : ymCategoriesLoading ? (
                <div style={{padding: '16px', textAlign: 'center'}}>Загрузка...</div>
              ) : ymCategoriesData && ymCategoriesData.length > 0 ? (
                <div>
                  <div style={{marginBottom: '16px'}}><strong>Всего категорий:</strong> {ymCategoriesData.length}</div>
                  <input
                    type="text"
                    placeholder="Поиск..."
                    value={ymCategorySearch}
                    onChange={(e) => setYmCategorySearch(e.target.value)}
                    style={{width: '100%', padding: '8px 12px', marginBottom: '12px', border: '1px solid var(--border)', borderRadius: '4px'}}
                  />
                  <div style={{maxHeight: '400px', overflowY: 'auto'}}>
                    {ymCategoriesData
                      .filter(c => !ymCategorySearch.trim() || (c.name || '').toLowerCase().includes(ymCategorySearch.toLowerCase()))
                      .slice(0, 200)
                      .map(cat => (
                        <div key={cat.id} style={{padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '13px'}}>
                          <span style={{color: 'var(--muted)', marginRight: '8px'}}>{cat.id}</span>
                          {cat.name}
                        </div>
                      ))}
                    {(ymCategoriesData.filter(c => !ymCategorySearch.trim() || (c.name || '').toLowerCase().includes(ymCategorySearch.toLowerCase())).length > 200) && (
                      <div style={{padding: '8px', color: 'var(--muted)', fontSize: '12px'}}>Показаны первые 200 из {ymCategoriesData.length}</div>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{padding: '16px', color: 'var(--muted)'}}>Нет данных. Обновите категории кнопкой выше.</div>
              )}
            </div>
          </Modal>
        </form>
      );
    }

    return null;
  };

  const ozonCabinets = (cabinets || []).filter((c) => c.marketplace_type === 'ozon');
  const wbCabinets = (cabinets || []).filter((c) => c.marketplace_type === 'wildberries');
  const ymCabinets = (cabinets || []).filter((c) => c.marketplace_type === 'yandex');
  const hasWb = wbCabinets.length > 0;

  return (
    <div className="marketplaces-tab">
      <div className="field" style={{ marginBottom: '16px' }}>
        <label className="label">Организация</label>
        <select
          className="input"
          value={selectedOrgId || ''}
          onChange={(e) => onSelectOrg(e.target.value ? String(e.target.value) : null)}
        >
          <option value="">— Выберите организацию —</option>
          {(organizations || []).map((org) => (
            <option key={org.id} value={org.id}>{org.name}</option>
          ))}
        </select>
        <p style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
          Для Озон и Яндекс.Маркет можно добавить несколько кабинетов, для Wildberries — один на организацию.
        </p>
      </div>

      {!selectedOrgId ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', background: 'var(--card)', borderRadius: '8px', border: '1px dashed var(--border)' }}>
          Выберите организацию для настройки кабинетов маркетплейсов
        </div>
      ) : cabinetsLoading ? (
        <div style={{ padding: '24px', textAlign: 'center' }}>Загрузка кабинетов...</div>
      ) : (
        <>
          <div className="marketplace-tabs">
            <button
              className={`marketplace-tab-btn ${activeMarketplace === 'ozon' ? 'active' : ''}`}
              onClick={() => setActiveMarketplace('ozon')}
            >
              Ozon {ozonCabinets.length > 0 && `(${ozonCabinets.length})`}
            </button>
            <button
              className={`marketplace-tab-btn ${activeMarketplace === 'wildberries' ? 'active' : ''}`}
              onClick={() => setActiveMarketplace('wildberries')}
            >
              Wildberries {wbCabinets.length > 0 && `(${wbCabinets.length})`}
            </button>
            <button
              className={`marketplace-tab-btn ${activeMarketplace === 'yandex' ? 'active' : ''}`}
              onClick={() => setActiveMarketplace('yandex')}
            >
              Yandex Market {ymCabinets.length > 0 && `(${ymCabinets.length})`}
            </button>
          </div>

          <div className="marketplace-content">
            {activeMarketplace === 'ozon' && (
              <div className="cabinets-section">
                {ozonCabinets.map((cab) => (
                  <div key={cab.id} className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <strong>{cab.name}</strong>
                      <Button type="button" variant="secondary" size="small" onClick={() => onDeleteCabinet && onDeleteCabinet(cab.id)} style={{ color: '#dc2626' }}>Удалить</Button>
                    </div>
                    <MarketplaceForm
                      type="ozon"
                      config={cab.config || {}}
                      onSave={onSaveCabinet ? (type, formData) => onSaveCabinet(cab.id, type, formData) : undefined}
                      onTest={onTest}
                    />
                  </div>
                ))}
                {addingCabinetType === 'ozon' && (
                  <div className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px dashed var(--border)', borderRadius: '8px' }}>
                    <strong style={{ marginBottom: '12px', display: 'block' }}>Новый кабинет Ozon</strong>
                    <MarketplaceForm
                      type="ozon"
                      config={{}}
                      onSave={async (type, formData) => {
                        if (onSaveCabinet) await onSaveCabinet(null, type, formData);
                        setAddingCabinetType(null);
                      }}
                      onTest={onTest}
                    />
                    <Button type="button" variant="secondary" onClick={() => setAddingCabinetType(null)} style={{ marginTop: '8px' }}>Отмена</Button>
                  </div>
                )}
                <Button type="button" variant="secondary" onClick={() => setAddingCabinetType('ozon')} disabled={addingCabinetType !== null}>+ Добавить кабинет Ozon</Button>
              </div>
            )}
            {activeMarketplace === 'wildberries' && (
              <div className="cabinets-section">
                {wbCabinets.map((cab) => (
                  <div key={cab.id} className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <strong>{cab.name}</strong>
                      <Button type="button" variant="secondary" size="small" onClick={() => onDeleteCabinet && onDeleteCabinet(cab.id)} style={{ color: '#dc2626' }}>Удалить</Button>
                    </div>
                    <MarketplaceForm
                      type="wildberries"
                      config={cab.config || {}}
                      onSave={onSaveCabinet ? (type, formData) => onSaveCabinet(cab.id, type, formData) : undefined}
                      onTest={onTest}
                    />
                  </div>
                ))}
                {!hasWb && addingCabinetType === 'wildberries' ? (
                  <div className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px dashed var(--border)', borderRadius: '8px' }}>
                    <strong style={{ marginBottom: '12px', display: 'block' }}>Кабинет Wildberries (один на организацию)</strong>
                    <MarketplaceForm
                      type="wildberries"
                      config={{}}
                      onSave={async (type, formData) => {
                        if (onSaveCabinet) await onSaveCabinet(null, type, formData);
                        setAddingCabinetType(null);
                      }}
                      onTest={onTest}
                    />
                    <Button type="button" variant="secondary" onClick={() => setAddingCabinetType(null)} style={{ marginTop: '8px' }}>Отмена</Button>
                  </div>
                ) : !hasWb ? (
                  <Button type="button" variant="secondary" onClick={() => setAddingCabinetType('wildberries')}>+ Добавить кабинет Wildberries</Button>
                ) : null}
              </div>
            )}
            {activeMarketplace === 'yandex' && (
              <div className="cabinets-section">
                {ymCabinets.map((cab) => (
                  <div key={cab.id} className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <strong>{cab.name}</strong>
                      <Button type="button" variant="secondary" size="small" onClick={() => onDeleteCabinet && onDeleteCabinet(cab.id)} style={{ color: '#dc2626' }}>Удалить</Button>
                    </div>
                    <MarketplaceForm
                      type="yandex"
                      config={cab.config || {}}
                      onSave={onSaveCabinet ? (type, formData) => onSaveCabinet(cab.id, type, formData) : undefined}
                      onTest={onTest}
                    />
                  </div>
                ))}
                {addingCabinetType === 'yandex' && (
                  <div className="cabinet-card" style={{ marginBottom: '16px', padding: '16px', border: '1px dashed var(--border)', borderRadius: '8px' }}>
                    <strong style={{ marginBottom: '12px', display: 'block' }}>Новый кабинет Яндекс.Маркет</strong>
                    <MarketplaceForm
                      type="yandex"
                      config={{}}
                      onSave={async (type, formData) => {
                        if (onSaveCabinet) await onSaveCabinet(null, type, formData);
                        setAddingCabinetType(null);
                      }}
                      onTest={onTest}
                    />
                    <Button type="button" variant="secondary" onClick={() => setAddingCabinetType(null)} style={{ marginTop: '8px' }}>Отмена</Button>
                  </div>
                )}
                <Button type="button" variant="secondary" onClick={() => setAddingCabinetType('yandex')} disabled={addingCabinetType !== null} style={{ marginTop: '8px' }}>+ Добавить кабинет Яндекс.Маркет</Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Компонент для вкладки поставщиков
function SuppliersTab({ configs, onSave, onTest }) {
  const [activeSupplier, setActiveSupplier] = useState('mikado');

  const SupplierForm = ({ type, config, onSave, onTest }) => {
    const [formData, setFormData] = useState(config || {});
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      setFormData(config || {});
    }, [config]);

    const handleSubmit = async (e) => {
      e.preventDefault();
      setSaving(true);
      try {
        await onSave(type, formData);
      } finally {
        setSaving(false);
      }
    };

    const handleChange = (field, value) => {
      setFormData({ ...formData, [field]: value });
    };

    if (type === 'mikado') {
      return (
        <form onSubmit={handleSubmit} className="integration-form">
          <div className="field">
            <label className="label">User ID</label>
            <input
              type="text"
              className="input"
              value={formData.user_id || ''}
              onChange={(e) => handleChange('user_id', e.target.value)}
              placeholder="Ваш User ID"
              required
            />
          </div>
          <div className="field">
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={formData.password || ''}
              onChange={(e) => handleChange('password', e.target.value)}
              placeholder="Ваш пароль"
              required
            />
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onTest(type, 'suppliers')}
            >
              Проверить подключение
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        </form>
      );
    }

    if (type === 'moskvorechie') {
      return (
        <form onSubmit={handleSubmit} className="integration-form">
          <div className="field">
            <label className="label">User ID</label>
            <input
              type="text"
              className="input"
              value={formData.user_id || ''}
              onChange={(e) => handleChange('user_id', e.target.value)}
              placeholder="Ваш User ID"
              required
            />
          </div>
          <div className="field">
            <label className="label">API Key</label>
            <input
              type="password"
              className="input"
              value={formData.password || ''}
              onChange={(e) => handleChange('password', e.target.value)}
              placeholder="Ваш API ключ от Moskvorechie"
              required
            />
            <small style={{color: 'var(--muted)', fontSize: '12px', marginTop: '4px', display: 'block'}}>
              API ключ используется вместо пароля для подключения к API Moskvorechie
            </small>
          </div>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onTest(type, 'suppliers')}
            >
              Проверить подключение
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </div>
        </form>
      );
    }

    return null;
  };

  return (
    <div className="suppliers-tab">
      <div className="supplier-tabs">
        <button
          className={`supplier-tab-btn ${activeSupplier === 'mikado' ? 'active' : ''}`}
          onClick={() => setActiveSupplier('mikado')}
        >
          Mikado
        </button>
        <button
          className={`supplier-tab-btn ${activeSupplier === 'moskvorechie' ? 'active' : ''}`}
          onClick={() => setActiveSupplier('moskvorechie')}
        >
          Moskvorechie
        </button>
      </div>

      <div className="supplier-content">
        {activeSupplier === 'mikado' && (
          <SupplierForm
            type="mikado"
            config={configs.mikado}
            onSave={onSave}
            onTest={onTest}
          />
        )}
        {activeSupplier === 'moskvorechie' && (
          <SupplierForm
            type="moskvorechie"
            config={configs.moskvorechie}
            onSave={onSave}
            onTest={onTest}
          />
        )}
      </div>
    </div>
  );
}


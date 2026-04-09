/**
 * CategoryForm Component
 * Форма создания/редактирования категории
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../../common/Button/Button';
import { categoriesApi } from '../../../services/categories.api';
import { categoryMappingsApi } from '../../../services/categoryMappings.api';
import { integrationsApi } from '../../../services/integrations.api';
import api from '../../../services/api';

/** Сравнение путей Ozon: пробелы, ›/>, ё→е (часто расходится с отображением в UI) */
function normalizeOzonPathForMatch(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/\s*›\s*/g, ' > ')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/ё/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Из составного id Ozon «descriptionCategoryId_typeId» в списке категорий */
function parseOzonCompositeId(ozonCategoryId) {
  const raw = ozonCategoryId != null ? String(ozonCategoryId).trim() : '';
  const u = raw.indexOf('_');
  if (u <= 0) return { descId: null, typeId: null };
  const descPart = raw.slice(0, u).trim();
  const typePart = raw.slice(u + 1).trim();
  const descId = parseInt(descPart, 10);
  const typeId = parseInt(typePart, 10);
  if (!Number.isFinite(descId) || descId <= 0 || !Number.isFinite(typeId) || typeId <= 0) {
    return { descId: null, typeId: null };
  }
  return { descId, typeId };
}

export function CategoryForm({ category, categories = [], allAttributes = [], marketplaceCategories: propsMarketplace, marketplaceCategoriesLoading: propsLoading, onRefreshOzonCategories, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    parentId: '',
    wbCategoryId: '',
    ozonCategoryId: '',
    ymCategoryId: '',
    certificateNumber: '',
    certificateValidFrom: '',
    certificateValidTo: ''
  });
  const [attributeIds, setAttributeIds] = useState([]);
  const [selectedAttributeId, setSelectedAttributeId] = useState('');
  
  const [errors, setErrors] = useState({});
  const [loadingCategories, setLoadingCategories] = useState({
    wb: false,
    ozon: false,
    ym: false
  });
  const [marketplaceCategories, setMarketplaceCategories] = useState({
    wb: [],
    ozon: [],
    ym: []
  });
  const [ozonSearchQuery, setOzonSearchQuery] = useState('');
  const [ozonDropdownOpen, setOzonDropdownOpen] = useState(false);
  const [ozonSelectedCategory, setOzonSelectedCategory] = useState(null);
  const [ozonRefreshing, setOzonRefreshing] = useState(false);
  const [wbSearchQuery, setWbSearchQuery] = useState('');
  const [wbDropdownOpen, setWbDropdownOpen] = useState(false);
  const [wbSelectedCategory, setWbSelectedCategory] = useState(null);
  const [ymSearchQuery, setYmSearchQuery] = useState('');
  const [ymDropdownOpen, setYmDropdownOpen] = useState(false);
  const [ymSelectedCategory, setYmSelectedCategory] = useState(null);

  const useProps = propsMarketplace != null && typeof propsMarketplace === 'object';
  const effective = useProps ? propsMarketplace : marketplaceCategories;
  const loading = useProps
    ? { wb: propsLoading, ozon: propsLoading, ym: propsLoading }
    : loadingCategories;

  // Загрузка категорий маркетплейсов только если не переданы снаружи (кэш со страницы)
  useEffect(() => {
    if (useProps) return;
    let cancelled = false;
    const load = async () => {
      setLoadingCategories(prev => ({ ...prev, wb: true, ozon: true, ym: true }));
      try {
        const [wbRes, ozonRes, ymRes] = await Promise.all([
          categoriesApi.getAll('wb'),
          categoriesApi.getAll('ozon'),
          categoriesApi.getAll('ym')
        ]);
        if (cancelled) return;
        setMarketplaceCategories({
          wb: wbRes?.data || [],
          ozon: ozonRes?.data || ozonRes || [],
          ym: ymRes?.data || []
        });
      } catch (e) {
        if (!cancelled) console.error('[CategoryForm] Error loading marketplace categories:', e);
      } finally {
        if (!cancelled) setLoadingCategories(prev => ({ ...prev, wb: false, ozon: false, ym: false }));
      }
    };
    load();
    return () => { cancelled = true; };
  }, [useProps]);

  // Загрузка существующих маппингов для категории
  // Выполняется после загрузки категорий маркетплейсов
  useEffect(() => {
    const loadExistingMappings = async () => {
      if (!category) return;
      if (loading.wb || loading.ozon || loading.ym) return;

      try {
        if (category.marketplace_mappings) {
          const savedMappings = typeof category.marketplace_mappings === 'string' 
            ? JSON.parse(category.marketplace_mappings) 
            : category.marketplace_mappings;
          
          const wbCategoryId = savedMappings.wb ? String(savedMappings.wb) : '';
          const ozonCategoryId = savedMappings.ozon ? String(savedMappings.ozon) : '';
          const ymCategoryId = savedMappings.ym ? String(savedMappings.ym) : '';
          const ymCat = ymCategoryId ? effective.ym.find(c => String(c.id) === ymCategoryId) : null;
          if (ymCat) {
            setYmSelectedCategory(ymCat);
            setYmSearchQuery(ymCat.name || '');
          }
          const wbCat = wbCategoryId ? effective.wb.find(c => String(c.id) === wbCategoryId) : null;
          if (wbCat) {
            setWbSelectedCategory(wbCat);
            setWbSearchQuery(wbCat.name || '');
          }
          let finalOzonCategoryId = ozonCategoryId || '';
          if (ozonCategoryId) {
            let selectedOzonCategory = effective.ozon.find(cat => {
              const catIdStr = String(cat.id);
              const mappingIdStr = String(ozonCategoryId);
              if (catIdStr === mappingIdStr) return true;
              if (catIdStr.replace('ozon_', '') === mappingIdStr) return true;
              if (catIdStr === `ozon_${mappingIdStr}`) return true;
              const catIdNum = catIdStr.replace('ozon_', '');
              const mappingIdNum = mappingIdStr.replace('ozon_', '');
              if (catIdNum === mappingIdNum) return true;
              return false;
            });
            if (savedMappings.ozon_display && (!selectedOzonCategory || !String(selectedOzonCategory.id || '').includes('_'))) {
              const want = normalizeOzonPathForMatch(savedMappings.ozon_display);
              let pathMatch = effective.ozon.find(
                (cat) => normalizeOzonPathForMatch(cat.path) === want && String(cat.id || '').includes('_')
              );
              if (!pathMatch && want.includes(' > ')) {
                const last = want.split(' > ').pop() || '';
                pathMatch = effective.ozon.find(
                  (cat) => String(cat.id || '').includes('_')
                    && normalizeOzonPathForMatch(cat.path).endsWith(last)
                );
              }
              if (pathMatch) selectedOzonCategory = pathMatch;
            }
            if (selectedOzonCategory) {
              finalOzonCategoryId = selectedOzonCategory.id;
              setOzonSelectedCategory(selectedOzonCategory);
              setOzonSearchQuery(
                savedMappings.ozon_display
                  || (selectedOzonCategory.path && selectedOzonCategory.path !== selectedOzonCategory.name ? selectedOzonCategory.path : null)
                  || selectedOzonCategory.name
                  || ''
              );
            } else if (savedMappings.ozon_display) {
              setOzonSearchQuery(savedMappings.ozon_display);
            } else {
              setOzonSearchQuery(ozonCategoryId ? `ID: ${ozonCategoryId}` : '');
            }
          }
          
          setFormData(prev => ({
            ...prev,
            wbCategoryId,
            ozonCategoryId: finalOzonCategoryId || prev.ozonCategoryId,
            ymCategoryId
          }));
          return;
        }
        
        const productsResponse = await api.get('/products');
        const allProducts = productsResponse.data?.data || [];
        const categoryProducts = allProducts.filter(
          p => p.user_category_id === category.id || String(p.user_category_id) === String(category.id)
        );

        if (categoryProducts.length === 0) return;

        const firstProduct = categoryProducts[0];
        try {
          const mappingsResponse = await categoryMappingsApi.getByProduct(firstProduct.id);
          const mappings = mappingsResponse.data?.data || mappingsResponse.data || [];
          
          const mappingsByMarketplace = {};
          mappings.forEach(mapping => {
            mappingsByMarketplace[mapping.marketplace] = mapping;
          });
          
          const wbMapping = mappingsByMarketplace.wb;
          const wbCategoryId = wbMapping?.category_id 
            ? String(wbMapping.category_id) 
            : '';
          const ozonMapping = mappingsByMarketplace.ozon;
          const ozonCategoryId = ozonMapping?.category_id 
            ? String(ozonMapping.category_id) 
            : '';
          const ymCategoryId = mappingsByMarketplace.ym?.category_id 
            ? String(mappingsByMarketplace.ym.category_id) 
            : '';
          
          const selectedOzonCategory = ozonCategoryId 
            ? effective.ozon.find(cat => {
                // Ozon категории могут иметь id в формате "ozon_123" или просто число
                const catIdStr = String(cat.id);
                const mappingIdStr = String(ozonCategoryId);
                // Пробуем разные варианты сравнения
                if (catIdStr === mappingIdStr) return true;
                if (catIdStr.replace('ozon_', '') === mappingIdStr) return true;
                if (catIdStr === `ozon_${mappingIdStr}`) return true;
                // Также проверяем числовые значения
                const catIdNum = catIdStr.replace('ozon_', '');
                const mappingIdNum = mappingIdStr.replace('ozon_', '');
                if (catIdNum === mappingIdNum) return true;
                return false;
              })
            : null;
          
          let mmForDisplay = category?.marketplace_mappings;
          if (typeof mmForDisplay === 'string') {
            try { mmForDisplay = JSON.parse(mmForDisplay || '{}'); } catch (_) { mmForDisplay = {}; }
          }
          const ozonDisplayFromCategory = mmForDisplay?.ozon_display || null;
          if (selectedOzonCategory) {
            setOzonSelectedCategory(selectedOzonCategory);
            setOzonSearchQuery(
              ozonDisplayFromCategory
                || (selectedOzonCategory.path && selectedOzonCategory.path !== selectedOzonCategory.name ? selectedOzonCategory.path : null)
                || selectedOzonCategory.name
                || ''
            );
            setFormData(prev => ({
              ...prev,
              ozonCategoryId: selectedOzonCategory.id
            }));
          } else {
            setOzonSelectedCategory(null);
            setOzonSearchQuery(ozonDisplayFromCategory || (ozonCategoryId ? `ID: ${ozonCategoryId}` : ''));
          }
          
          const ymCatFound = ymCategoryId ? effective.ym.find(c => String(c.id) === ymCategoryId) : null;
          if (ymCatFound) {
            setYmSelectedCategory(ymCatFound);
            setYmSearchQuery(ymCatFound.name || '');
          }
          const wbCategoryFound = effective.wb.find(c => String(c.id) === wbCategoryId);
          if (wbCategoryFound) {
            setWbSelectedCategory(wbCategoryFound);
            setWbSearchQuery(wbCategoryFound.name || '');
          }
          if (!wbCategoryFound && wbMapping?.marketplace_category_name && wbCategoryId) {
            const foundByName = effective.wb.find(c => 
              c.name === wbMapping.marketplace_category_name
            );
            if (foundByName) {
              setWbSelectedCategory(foundByName);
              setWbSearchQuery(foundByName.name || '');
              setFormData(prev => ({
                ...prev,
                wbCategoryId: String(foundByName.id),
                ozonCategoryId,
                ymCategoryId
              }));
              return;
            }
          }
          
          setFormData(prev => ({
            ...prev,
            wbCategoryId,
            ozonCategoryId: selectedOzonCategory ? selectedOzonCategory.id : (ozonCategoryId || ''),
            ymCategoryId
          }));
        } catch (err) {
          if (err.response?.status !== 404) {
            console.error('[CategoryForm] Error loading mappings:', err);
          }
        }
      } catch (error) {
        console.error('[CategoryForm] Error loading products:', error);
      }
    };

    loadExistingMappings();
  }, [category, loading.wb, loading.ozon, loading.ym, effective.wb, effective.ozon, effective.ym]);

  useEffect(() => {
    if (category) {
      setFormData(prev => ({
        ...prev,
        name: category.name || '',
        description: category.description || '',
        parentId: category.parent_id || category.parentId || '',
        certificateNumber: category.certificateNumber || category.certificate_number || '',
        certificateValidFrom: category.certificateValidFrom || category.certificate_valid_from || '',
        certificateValidTo: category.certificateValidTo || category.certificate_valid_to || ''
        // Не сбрасываем wbCategoryId, ozonCategoryId, ymCategoryId здесь,
        // они устанавливаются в loadExistingMappings после загрузки категорий
      }));
      const ids = category.attribute_ids && Array.isArray(category.attribute_ids)
        ? category.attribute_ids.map((id) => String(id))
        : [];
      setAttributeIds(ids);
    } else {
      setFormData({
        name: '',
        description: '',
        parentId: '',
        wbCategoryId: '',
        ozonCategoryId: '',
        ymCategoryId: '',
        certificateNumber: '',
        certificateValidFrom: '',
        certificateValidTo: ''
      });
      setAttributeIds([]);
      setSelectedAttributeId('');
      setOzonSelectedCategory(null);
      setOzonSearchQuery('');
      setWbSelectedCategory(null);
      setWbSearchQuery('');
      setYmSelectedCategory(null);
      setYmSearchQuery('');
    }
  }, [category]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
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
    
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Введите название категории';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validate()) {
      return;
    }

    // Преобразуем ID категорий
    // Для WB и YM - числа, для Ozon - строка (description_category_id)
    const wbCategoryId = formData.wbCategoryId && formData.wbCategoryId !== '' 
      ? (typeof formData.wbCategoryId === 'string' ? parseInt(formData.wbCategoryId, 10) : Number(formData.wbCategoryId))
      : null;
    
    // Для Ozon ID должен быть строкой (VARCHAR в БД)
    // Убираем префикс "ozon_" если есть, но оставляем как строку
    let ozonCategoryId = null;
    if (formData.ozonCategoryId && formData.ozonCategoryId !== '') {
      const ozonIdStr = String(formData.ozonCategoryId);
      // Убираем префикс "ozon_" если есть
      const cleanId = ozonIdStr.replace(/^ozon_/, '');
      // Проверяем, что это валидный ID (не пустая строка)
      if (cleanId && cleanId !== '' && cleanId !== 'undefined' && cleanId !== 'null') {
        ozonCategoryId = cleanId; // Оставляем как строку
      }
    }
    
    const ymCategoryId = formData.ymCategoryId && formData.ymCategoryId !== '' 
      ? (typeof formData.ymCategoryId === 'string' ? parseInt(formData.ymCategoryId, 10) : Number(formData.ymCategoryId))
      : null;

    const fromComposite = parseOzonCompositeId(ozonCategoryId);
    let ozonDescId = ozonSelectedCategory?.description_category_id != null ? Number(ozonSelectedCategory.description_category_id) : null;
    let ozonTypeId = ozonSelectedCategory?.type_id != null ? Number(ozonSelectedCategory.type_id) : null;
    if (fromComposite.descId != null && fromComposite.typeId != null) {
      ozonDescId = fromComposite.descId;
      ozonTypeId = fromComposite.typeId;
    }
    const isOzonType = String(ozonCategoryId || '').includes('_');
    const ozonDisplay = (isOzonType && (ozonSelectedCategory?.path || ozonSearchQuery)) ? (ozonSelectedCategory?.path || ozonSearchQuery) : null;
    const payload = {
      name: formData.name.trim(),
      description: formData.description.trim() || null,
      parent_id: formData.parentId || null,
      attribute_ids: attributeIds.length > 0 ? attributeIds : [],
      certificate_number: formData.certificateNumber.trim() || null,
      certificate_valid_from: formData.certificateValidFrom || null,
      certificate_valid_to: formData.certificateValidTo || null,
      marketplaceMappings: {
        wb: wbCategoryId && !isNaN(wbCategoryId) && wbCategoryId > 0 ? wbCategoryId : null,
        ozon: ozonCategoryId || null,
        ...(ozonDisplay ? { ozon_display: ozonDisplay } : {}),
        ...(ozonDescId != null && ozonTypeId != null && ozonTypeId > 0
          ? { ozon_description_category_id: ozonDescId, ozon_type_id: ozonTypeId }
          : {}),
        ym: ymCategoryId && !isNaN(ymCategoryId) && ymCategoryId > 0 ? ymCategoryId : null
      }
    };

    console.log('[CategoryForm] Submitting payload:', payload);
    console.log('[CategoryForm] Category IDs:', {
      wbCategoryId: formData.wbCategoryId,
      wbCategoryIdParsed: wbCategoryId,
      wbCategoryIdType: typeof wbCategoryId,
      ozonCategoryId: formData.ozonCategoryId,
      ozonCategoryIdParsed: ozonCategoryId,
      ozonCategoryIdType: typeof ozonCategoryId
    });

    // Передаем данные в onSubmit, который сохранит категорию и маппинги
    await onSubmit(payload);
  };

  // Фильтруем категории, исключая текущую (при редактировании)
  const availableCategories = categories.filter(cat => !category || cat.id !== category.id);

  return (
    <form className="category-form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="label" htmlFor="categoryName">
          Название категории <span style={{color: '#ef4444'}}>*</span>
        </label>
        <input
          id="categoryName"
          type="text"
          className="form-control form-control-sm"
          placeholder="Введите название категории"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

      <div className="field">
        <label className="label" htmlFor="categoryDescription">Описание</label>
        <textarea
          id="categoryDescription"
          className="form-control form-control-sm"
          rows="3"
          placeholder="Введите описание категории"
          value={formData.description}
          onChange={(e) => handleChange('description', e.target.value)}
        />
      </div>

      <div className="field" style={{ marginTop: '8px' }}>
        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '4px' }}>Сертификат соответствия (для маркетплейсов)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 160px', gap: '10px' }}>
          <div>
            <label className="label" htmlFor="catCertNumber">Номер сертификата</label>
            <input
              id="catCertNumber"
              type="text"
              className="form-control form-control-sm"
              value={formData.certificateNumber}
              onChange={(e) => handleChange('certificateNumber', e.target.value)}
              placeholder="Например: RU C-RU.АБ12.В.12345/20"
            />
          </div>
          <div>
            <label className="label" htmlFor="catCertFrom">Дата начала</label>
            <input
              id="catCertFrom"
              type="date"
              className="form-control form-control-sm"
              value={formData.certificateValidFrom}
              onChange={(e) => handleChange('certificateValidFrom', e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="catCertTo">Дата окончания</label>
            <input
              id="catCertTo"
              type="date"
              className="form-control form-control-sm"
              value={formData.certificateValidTo}
              onChange={(e) => handleChange('certificateValidTo', e.target.value)}
            />
          </div>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '6px' }}>
          Эти поля могут автоматически обновляться из раздела «Настройки → Сертификаты».
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="categoryParent">Родительская категория</label>
        <select
          id="categoryParent"
          className="form-select form-select-sm"
          value={formData.parentId}
          onChange={(e) => handleChange('parentId', e.target.value)}
        >
          <option value="">Без родительской категории</option>
          {availableCategories
            .filter(cat => !cat.parent_id && !cat.parentId) // Только родительские категории
            .map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
        </select>
      </div>

      <div className="field" style={{ marginTop: '16px' }}>
        <label className="label">Атрибуты категории</label>
        <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px' }}>
          Добавьте атрибуты, которые будут доступны для товаров этой категории
        </p>
        {allAttributes.length === 0 ? (
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Нет атрибутов. Создайте атрибуты в разделе «Настройки → Атрибуты».</span>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
              <select
                id="categoryAttributesSelect"
                className="form-select form-select-sm"
                value={selectedAttributeId}
                onChange={(e) => setSelectedAttributeId(e.target.value)}
                style={{ flex: 1, maxWidth: '280px' }}
              >
                <option value="">Выберите атрибут...</option>
                {allAttributes
                  .filter((attr) => !attributeIds.includes(String(attr.id)))
                  .map((attr) => (
                    <option key={attr.id} value={attr.id}>
                      {attr.name}
                    </option>
                  ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => {
                  if (selectedAttributeId) {
                    setAttributeIds((prev) => (prev.includes(selectedAttributeId) ? prev : [...prev, selectedAttributeId]));
                    setSelectedAttributeId('');
                  }
                }}
                disabled={!selectedAttributeId}
              >
                Добавить
              </Button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
              {attributeIds.map((id) => {
                const attr = allAttributes.find((a) => String(a.id) === id);
                return (
                  <span
                    key={id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      background: 'var(--bg-secondary, #f3f4f6)',
                      borderRadius: '6px',
                      fontSize: '13px',
                    }}
                  >
                    {attr?.name || id}
                    <button
                      type="button"
                      onClick={() => setAttributeIds((prev) => prev.filter((x) => x !== id))}
                      aria-label="Удалить"
                      style={{
                        padding: '0 4px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--muted, #6b7280)',
                        fontSize: '16px',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              {attributeIds.length === 0 && (
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Атрибуты не добавлены</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Сопоставление с маркетплейсами */}
      <div style={{marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border)'}}>
        <h4 style={{fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)'}}>
          🏪 Сопоставление с маркетплейсами
        </h4>
        <p style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '16px'}}>
          Выберите соответствующие категории маркетплейсов. Сопоставления будут применены ко всем товарам этой категории.
        </p>

        {/* Wildberries */}
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="wbCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span style={{background: '#cb11ab', color: 'white', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', fontWeight: 600}}>WB</span>
              Wildberries
            </span>
          </label>
          {loading.wb ? (
            <div style={{padding: '8px', color: 'var(--muted)', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="wbCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={wbSearchQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setWbSearchQuery(q);
                      setWbDropdownOpen(true);
                      if (!q.trim()) {
                        setWbSelectedCategory(null);
                        handleChange('wbCategoryId', '');
                      }
                    }}
                    onFocus={() => setWbDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setWbDropdownOpen(false), 200)}
                    autoComplete="off"
                    style={{ background: '#fff', color: '#1a1a1a', caretColor: '#1a1a1a' }}
                  />
                  {wbDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {!wbSearchQuery.trim() ? (
                        <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                          Начните вводить название категории
                        </div>
                      ) : (
                        (() => {
                          const q = wbSearchQuery.toLowerCase();
                          const list = effective.wb.filter(c => {
                            const n = (c.name || '').toLowerCase();
                            const p = (c.parent_name || '').toLowerCase();
                            return n.includes(q) || p.includes(q);
                          }).slice(0, 20);
                          if (!list.length) {
                            return <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>Ничего не найдено</div>;
                          }
                          return list.map(cat => (
                            <div
                              key={cat.id}
                              style={{
                                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                                background: wbSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                              }}
                              onMouseDown={(e) => { e.preventDefault(); setWbSelectedCategory(cat); setWbSearchQuery(cat.name || ''); handleChange('wbCategoryId', String(cat.id)); setWbDropdownOpen(false); }}
                            >
                              <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                              {cat.parent_name && <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.parent_name}</div>}
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  )}
                </div>
                {wbSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setWbSelectedCategory(null); setWbSearchQuery(''); handleChange('wbCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Ozon */}
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="ozonCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span style={{background: '#005bff', color: 'white', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', fontWeight: 600}}>OZON</span>
              Ozon
            </span>
            {(
              <button
                type="button"
                onClick={async () => {
                  setOzonRefreshing(true);
                  try {
                    const res = await integrationsApi.getOzonCategories({ forceRefresh: true });
                    const raw = res?.data || res || [];
                    const formatted = raw.map(cat => ({
                      id: cat.id,
                      name: cat.name,
                      path: cat.path,
                      marketplace_category_id: cat.id,
                      marketplace: 'ozon',
                      parent_id: cat.parent_id,
                      disabled: cat.disabled
                    }));
                    if (onRefreshOzonCategories) onRefreshOzonCategories(formatted);
                    else setMarketplaceCategories(prev => ({ ...prev, ozon: formatted }));
                  } catch (e) {
                    console.error('[CategoryForm] Ozon refresh failed:', e);
                  } finally {
                    setOzonRefreshing(false);
                  }
                }}
                disabled={ozonRefreshing}
                style={{ marginLeft: '8px', fontSize: '11px', padding: '2px 8px', cursor: ozonRefreshing ? 'not-allowed' : 'pointer', opacity: ozonRefreshing ? 0.7 : 1 }}
              >
                {ozonRefreshing ? 'Загрузка…' : (effective.ozon.length > 0 ? 'Обновить список' : 'Загрузить список категорий')}
              </button>
            )}
          </label>
          <p style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', marginBottom: '6px' }}>
            Для атрибутов Ozon в карточке товара выберите <strong>тип товара</strong> — пункт с путём вида «Категория › Тип товара» (не только категорию).
          </p>
          {loading.ozon ? (
            <div style={{padding: '8px', color: 'var(--muted)', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="ozonCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={ozonSearchQuery}
                    onChange={(e) => {
                      const query = e.target.value;
                      setOzonSearchQuery(query);
                      setOzonDropdownOpen(true);
                      if (!query.trim()) {
                        setOzonSelectedCategory(null);
                        handleChange('ozonCategoryId', '');
                      }
                    }}
                    onFocus={() => setOzonDropdownOpen(true)}
                    onBlur={() => {
                      setTimeout(() => setOzonDropdownOpen(false), 200);
                    }}
                    autoComplete="off"
                    style={{
                      background: '#fff',
                      color: '#1a1a1a',
                      caretColor: '#1a1a1a'
                    }}
                  />
                  {ozonDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {(() => {
                        if (!ozonSearchQuery.trim()) {
                          return (
                            <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                              Начните вводить название категории
                            </div>
                          );
                        }
                        const searchLower = ozonSearchQuery.toLowerCase();
                        const filtered = effective.ozon.filter(cat => {
                          const name = (cat.name || '').toLowerCase();
                          const path = (cat.path || '').toLowerCase();
                          return name.includes(searchLower) || path.includes(searchLower);
                        }).slice(0, 20);
                        if (filtered.length === 0) {
                          return (
                            <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                              Ничего не найдено
                            </div>
                          );
                        }
                        return filtered.map(cat => (
                          <div
                            key={cat.id}
                            style={{
                              padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                              background: ozonSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                            }}
                            onMouseDown={(e) => {
                              e.preventDefault(); // Предотвращаем blur
                              setOzonSelectedCategory(cat);
                              const isType = String(cat.id || '').includes('_');
                              setOzonSearchQuery(isType && cat.path ? cat.path : (cat.name || ''));
                              handleChange('ozonCategoryId', cat.id);
                              setOzonDropdownOpen(false);
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = ozonSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff'; }}
                          >
                            {String(cat.id || '').includes('_') ? (
                              <>
                                <div style={{ fontSize: '13px', fontWeight: 500 }}>{cat.path || cat.name}</div>
                                <div style={{ fontSize: '10px', color: '#005bff', marginTop: '2px' }}>Тип товара — для атрибутов Ozon</div>
                              </>
                            ) : (
                              <>
                                <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                                {cat.path && cat.path !== cat.name && (
                                  <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.path}</div>
                                )}
                              </>
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
                {ozonSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setOzonSelectedCategory(null); setOzonSearchQuery(''); handleChange('ozonCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Yandex Market */}
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="ymCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span style={{background: '#fc0', color: '#000', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', fontWeight: 600}}>YM</span>
              Yandex Market
            </span>
          </label>
          {loading.ym ? (
            <div style={{padding: '8px', color: '#6b7280', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="ymCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={ymSearchQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setYmSearchQuery(q);
                      setYmDropdownOpen(true);
                      if (!q.trim()) {
                        setYmSelectedCategory(null);
                        handleChange('ymCategoryId', '');
                      }
                    }}
                    onFocus={() => setYmDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setYmDropdownOpen(false), 200)}
                    autoComplete="off"
                    style={{ background: '#fff', color: '#1a1a1a', caretColor: '#1a1a1a' }}
                  />
                  {ymDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {!ymSearchQuery.trim() ? (
                        <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                          Начните вводить название категории
                        </div>
                      ) : (
                        (() => {
                          const q = ymSearchQuery.toLowerCase();
                          const list = effective.ym.filter(c => {
                            const n = (c.name || '').toLowerCase();
                            const p = (c.path || c.parent_name || '').toLowerCase();
                            return n.includes(q) || p.includes(q);
                          }).slice(0, 20);
                          if (!list.length) {
                            return <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>Ничего не найдено</div>;
                          }
                          return list.map(cat => (
                            <div
                              key={cat.id}
                              style={{
                                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                                background: ymSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                              }}
                              onMouseDown={(e) => { e.preventDefault(); setYmSelectedCategory(cat); setYmSearchQuery(cat.name || ''); handleChange('ymCategoryId', String(cat.id)); setYmDropdownOpen(false); }}
                            >
                              <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                              {cat.path && cat.path !== cat.name && <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.path}</div>}
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  )}
                </div>
                {ymSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setYmSelectedCategory(null); setYmSearchQuery(''); handleChange('ymCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{marginTop: '12px'}}>
          {Object.values(errors)[0]}
        </div>
      )}

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary">{category ? 'Сохранить' : 'Добавить категорию'}</Button>
      </div>
    </form>
  );
}


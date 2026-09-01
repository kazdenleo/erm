import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { FILTER_CATEGORY_NONE } from '../../utils/uncategorizedCategoryFilter.js';

/**
 * Диалог выбора области отправки цен на маркетплейсы.
 */
export function PushPricesModal({
  isOpen,
  onClose,
  onSubmit,
  loading = false,
  organizations = [],
  categories = [],
  showUncategorizedCategoryOption = false,
  pageFilters = {},
  selectedProductIds = [],
}) {
  const selectedCount = selectedProductIds.length;
  const hasPageFilters = Boolean(
    pageFilters.organizationId || pageFilters.brandId || pageFilters.categoryId
  );

  const [scope, setScope] = useState('all');
  const [pickedCategoryIds, setPickedCategoryIds] = useState(() => new Set());

  useEffect(() => {
    if (!isOpen) return;
    if (selectedCount > 0) setScope('selected');
    else if (hasPageFilters) setScope('filter');
    else setScope('all');
    setPickedCategoryIds(new Set());
  }, [isOpen, selectedCount, hasPageFilters]);

  const pageFilterSummary = useMemo(() => {
    const parts = [];
    if (pageFilters.organizationId) {
      const org = organizations.find((o) => String(o.id) === String(pageFilters.organizationId));
      parts.push(`организация: ${org?.name || pageFilters.organizationId}`);
    }
    if (pageFilters.brandId) {
      parts.push(`бренд: ${pageFilters.brandName || pageFilters.brandId}`);
    }
    if (pageFilters.categoryId) {
      if (pageFilters.categoryId === FILTER_CATEGORY_NONE) {
        parts.push('категория: без категории');
      } else {
        parts.push(`категория: ${pageFilters.categoryName || pageFilters.categoryId}`);
      }
    }
    return parts.join(' · ');
  }, [pageFilters, organizations]);

  const sortedCategories = useMemo(() => {
    return [...(categories || [])].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    );
  }, [categories]);

  const toggleCategory = (id) => {
    setPickedCategoryIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSubmit =
    scope === 'all' ||
    (scope === 'filter' && hasPageFilters) ||
    (scope === 'categories' && pickedCategoryIds.size > 0) ||
    (scope === 'selected' && selectedCount > 0);

  const handleSubmit = () => {
    const payload = {};
    if (pageFilters.organizationId) {
      payload.organizationId = pageFilters.organizationId;
    }

    if (scope === 'all') {
      onSubmit({ scope: 'all', payload });
      return;
    }
    if (scope === 'filter') {
      if (pageFilters.brandId) payload.brandId = pageFilters.brandId;
      if (pageFilters.categoryId) payload.categoryIds = [pageFilters.categoryId];
      onSubmit({ scope: 'filter', payload });
      return;
    }
    if (scope === 'categories') {
      payload.categoryIds = [...pickedCategoryIds];
      onSubmit({ scope: 'categories', payload });
      return;
    }
    if (scope === 'selected') {
      payload.productIds = selectedProductIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
      onSubmit({ scope: 'selected', payload });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Отправить цены на маркетплейсы"
      size="medium"
    >
      <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '0 0 12px' }}>
        Будут отправлены сохранённые цены (стратегия / selling / мин.) только для организаций с включённой
        автоотправкой и рассчитанными мин. ценами.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="radio"
            name="push-scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
            style={{ marginTop: '3px' }}
          />
          <span>
            <strong>Все товары</strong>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {pageFilters.organizationId
                ? 'Только выбранная организация (фильтр страницы)'
                : 'Все организации с автоотправкой цен'}
            </div>
          </span>
        </label>

        <label
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            cursor: hasPageFilters ? 'pointer' : 'not-allowed',
            opacity: hasPageFilters ? 1 : 0.5,
          }}
        >
          <input
            type="radio"
            name="push-scope"
            checked={scope === 'filter'}
            onChange={() => setScope('filter')}
            disabled={!hasPageFilters}
            style={{ marginTop: '3px' }}
          />
          <span>
            <strong>По фильтру страницы</strong>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {hasPageFilters ? pageFilterSummary : 'Задайте организацию, бренд или категорию в фильтрах выше'}
            </div>
          </span>
        </label>

        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="radio"
            name="push-scope"
            checked={scope === 'categories'}
            onChange={() => setScope('categories')}
            style={{ marginTop: '3px' }}
          />
          <span style={{ flex: 1 }}>
            <strong>По категориям</strong>
            <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: scope === 'categories' ? '6px' : 0 }}>
              Выберите одну или несколько категорий
            </div>
            {scope === 'categories' && (
              <div
                className="prices-push-categories"
                style={{
                  maxHeight: '180px',
                  overflowY: 'auto',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '6px',
                  padding: '6px 8px',
                  fontSize: '12px',
                }}
              >
                {showUncategorizedCategoryOption && (
                  <label style={{ display: 'flex', gap: '6px', marginBottom: '4px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={pickedCategoryIds.has(FILTER_CATEGORY_NONE)}
                      onChange={() => toggleCategory(FILTER_CATEGORY_NONE)}
                    />
                    <span>Без категории</span>
                  </label>
                )}
                {sortedCategories.map((cat) => (
                  <label
                    key={cat.id}
                    style={{ display: 'flex', gap: '6px', marginBottom: '4px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={pickedCategoryIds.has(String(cat.id))}
                      onChange={() => toggleCategory(String(cat.id))}
                    />
                    <span>{cat.name || `#${cat.id}`}</span>
                  </label>
                ))}
                {!sortedCategories.length && !showUncategorizedCategoryOption && (
                  <span style={{ color: 'var(--muted)' }}>Категории не найдены</span>
                )}
              </div>
            )}
          </span>
        </label>

        <label
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            cursor: selectedCount > 0 ? 'pointer' : 'not-allowed',
            opacity: selectedCount > 0 ? 1 : 0.5,
          }}
        >
          <input
            type="radio"
            name="push-scope"
            checked={scope === 'selected'}
            onChange={() => setScope('selected')}
            disabled={selectedCount === 0}
            style={{ marginTop: '3px' }}
          />
          <span>
            <strong>Выбранные товары</strong>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {selectedCount > 0
                ? `Отмечено в таблице: ${selectedCount}`
                : 'Отметьте товары галочками в таблице'}
            </div>
          </span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          Отмена
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={loading || !canSubmit}>
          {loading ? 'Запуск…' : 'Отправить'}
        </Button>
      </div>
    </Modal>
  );
}

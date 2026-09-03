/**
 * Страница карточки товара (создание и редактирование).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { Button } from '../../components/common/Button/Button';
import { ProductForm } from '../../components/forms/ProductForm/ProductForm';
import { useCategories } from '../../hooks/useCategories';
import { useBrands } from '../../hooks/useBrands';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useProducts } from '../../hooks/useProducts';
import { productsApi } from '../../services/products.api.js';
import './ProductCard.css';

const CARD_TABS = ['main', 'price', 'ozon', 'wb', 'ym', 'competitors'];

export function ProductCard() {
  const { productId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !productId || productId === 'new';
  const formRef = useRef(null);

  const { categories, loadCategories } = useCategories();
  const { brands } = useBrands();
  const { organizations } = useOrganizations();
  const {
    products,
    createProduct,
    updateProduct,
    deleteProduct,
    archiveProduct,
  } = useProducts({ autoLoad: false });

  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState(null);

  const initialTab = useMemo(() => {
    const tab = String(searchParams.get('tab') || 'main').trim();
    return CARD_TABS.includes(tab) ? tab : 'main';
  }, [searchParams]);

  const leaveCard = useCallback(() => {
    const from = location.state?.from;
    if (typeof from === 'string' && from.startsWith('/')) {
      navigate(from);
      return;
    }
    // Не navigate(-1): при прямом заходе / редиректах history часто «ломает» кнопку «Назад»
    navigate('/products');
  }, [navigate, location.state]);

  const handleBack = useCallback(() => {
    if (formRef.current?.requestClose) {
      void formRef.current.requestClose();
      return;
    }
    leaveCard();
  }, [leaveCard]);

  useEffect(() => {
    void loadCategories({ silent: categories.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз при открытии карточки
  }, [isNew, productId]);

  useEffect(() => {
    if (isNew) {
      setProduct(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const id = Number(productId);
    if (!Number.isInteger(id) || id < 1) {
      setError('Товар не найден');
      setProduct(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const response = await productsApi.getById(id);
        const full = response?.data ?? response;
        if (cancelled) return;
        if (!full?.id) {
          setError('Товар не найден');
          setProduct(null);
          return;
        }
        setProduct(full);
      } catch (e) {
        if (cancelled) return;
        setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить товар');
        setProduct(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isNew, productId]);

  const handleSubmit = async (productData) => {
    try {
      if (product?.id) {
        const updated = await updateProduct(product.id, productData);
        if (updated) setProduct(updated);
        return updated;
      }
      const created = await createProduct(productData);
      if (created?.id) {
        setProduct(created);
        navigate(`/products/${created.id}`, { replace: true });
      }
      return created;
    } catch (err) {
      const message =
        err.response?.data?.details
          ?.map((d) => {
            const path = Array.isArray(d.path) ? d.path.join('.') : '';
            const msg = d.message || '';
            return path ? `${path}: ${msg}` : msg;
          })
          .filter(Boolean)
          .join('; ') ||
        err.response?.data?.message ||
        err.message ||
        'Неизвестная ошибка';
      alert('Ошибка сохранения товара: ' + message);
      throw err;
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Вы уверены, что хотите удалить этот товар?')) return;
    try {
      await deleteProduct(id);
      navigate('/products');
    } catch (err) {
      alert('Ошибка удаления товара: ' + (err.response?.data?.message || err.message || 'Неизвестная ошибка'));
    }
  };

  const handleArchive = async (id) => {
    if (!window.confirm('Отправить товар в архив? Он скроется из списка по умолчанию, история сохранится.')) return;
    try {
      await archiveProduct(id);
      navigate('/products');
    } catch (err) {
      alert('Ошибка архивации товара: ' + (err.response?.data?.message || err.message || 'Неизвестная ошибка'));
    }
  };

  const title = isNew
    ? 'Новый товар'
    : product?.name || product?.sku || (loading ? 'Карточка товара' : 'Товар');
  const subtitle = !isNew && product?.sku && product?.name ? `Артикул: ${product.sku}` : null;

  return (
    <div className="product-card-page">
      <PageTitle
        iconClass="pe-7s-box2"
        iconBgClass="bg-mean-fruit"
        title={title}
        subtitle={subtitle}
        actions={
          <Button className="btn-shadow" variant="secondary" size="small" onClick={handleBack}>
            ← Назад
          </Button>
        }
      />
      {loading ? (
        <p className="text-muted px-3">Загрузка карточки…</p>
      ) : error ? (
        <div className="alert alert-danger mx-3">{error}</div>
      ) : (
        <ProductForm
          ref={formRef}
          product={isNew ? null : product}
          categories={categories}
          brands={brands}
          organizations={organizations}
          products={products}
          initialTab={initialTab}
          onSubmit={handleSubmit}
          onCancel={leaveCard}
          onProductUpdate={setProduct}
          onDeleteProduct={product?.id ? handleDelete : undefined}
          onArchiveProduct={product?.id ? handleArchive : undefined}
          canDeleteProduct={product?.canDelete === true}
          canArchiveProduct={Boolean(product?.hasParticipation) && !Boolean(product?.isArchived)}
        />
      )}
    </div>
  );
}

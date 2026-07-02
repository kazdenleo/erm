/**
 * Кнопки вставки в текст ответа / шаблона + inline-поиск товаров
 */

import React, { useRef, useState } from 'react';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import { productsApi } from '../../services/products.api';
import {
  formatProductForQuestionReply,
  getProductMarketplaceNumber,
  normalizeQuestionMarketplace,
  productNameWithoutArticle,
} from './questionsDisplay';
import { QUESTION_TEMPLATE_NAME_TOKEN, resolveBuyerNameForReply } from './questionTemplateText';
import '../../components/common/ProductSearchInput/ProductSearchInput.css';

function enrichProductWithMarketplaceNumber(product, marketplace, number) {
  const mp = normalizeQuestionMarketplace(marketplace);
  const num = number != null ? String(number).trim() : '';
  if (!num || !mp) return product;
  if (mp === 'ozon') {
    return { ...product, ozon_market_sku: num };
  }
  if (mp === 'wb') {
    return { ...product, sku_wb: num };
  }
  if (mp === 'ym') {
    return { ...product, ym_market_sku: num, ym_product_id: num, marketplace_ym_product_id: Number(num) };
  }
  return product;
}

export function insertTextAtCursor({ textareaRef, value, onChange, text }) {
  const el = textareaRef?.current;
  const body = String(value ?? '');
  const token = String(text ?? '').trim();
  if (!token) return;

  if (!el) {
    onChange(body ? `${body}${body.endsWith(' ') ? '' : ' '}${token}` : token);
    return;
  }

  const start = el.selectionStart ?? body.length;
  const end = el.selectionEnd ?? body.length;
  const before = body.slice(0, start);
  const after = body.slice(end);
  const needSpace = before.length > 0 && !/[\s([{«"']$/.test(before);
  const insert = `${needSpace ? ' ' : ''}${token}`;
  const newBody = before + insert + after;
  onChange(newBody);

  const cursor = start + insert.length;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(cursor, cursor);
  });
}

export function QuestionTextInsertToolbar({
  textareaRef,
  value,
  onChange,
  disabled,
  mode = 'template',
  showName = true,
  showProduct = false,
  organizationId = null,
  buyerNameLabel = null,
  questionProductLabel = null,
  questionSkuOrOffer = null,
  questionMarketplace = null,
}) {
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [productResolving, setProductResolving] = useState(false);
  const productSearchRef = useRef(null);
  const isReply = mode === 'reply';

  const insertName = () => {
    const text = isReply
      ? resolveBuyerNameForReply(buyerNameLabel)
      : QUESTION_TEMPLATE_NAME_TOKEN;
    if (!String(text ?? '').trim()) return;
    insertTextAtCursor({ textareaRef, value, onChange, text });
  };

  const insertProduct = (label) => {
    const text = String(label ?? '').trim();
    if (!text || text === 'товар' || text === '—') return;
    insertTextAtCursor({ textareaRef, value, onChange, text });
    setProductSearch('');
    requestAnimationFrame(() => productSearchRef.current?.focus());
  };

  const closeProductPicker = () => {
    setProductPickerOpen(false);
    setProductSearch('');
    setProductResolving(false);
  };

  const handleInsertFromQuestion = async () => {
    const mp = normalizeQuestionMarketplace(questionMarketplace);
    const offerId = String(questionSkuOrOffer ?? '').trim();
    if (mp && offerId && organizationId) {
      setProductResolving(true);
      try {
        const resolved = await productsApi.resolveMarketplaceNumberByOffer(offerId, mp, {
          organizationId
        });
        if (resolved?.number) {
          insertProduct(resolved.number);
          return;
        }
      } catch {
        /* fallback */
      } finally {
        setProductResolving(false);
      }
    }
    insertProduct(questionProductLabel);
  };

  const handleProductSelect = async (product) => {
    if (!product) return;
    let enriched = product;
    const mp = normalizeQuestionMarketplace(questionMarketplace);
    if (mp && !getProductMarketplaceNumber(product, mp)) {
      setProductResolving(true);
      try {
        const resolved = await productsApi.resolveMarketplaceNumber(product.id, mp);
        if (resolved?.number) {
          enriched = enrichProductWithMarketplaceNumber(product, mp, resolved.number);
        }
      } catch {
        /* вставим ERP-артикул */
      } finally {
        setProductResolving(false);
      }
    }
    insertProduct(formatProductForQuestionReply(enriched, questionMarketplace));
  };

  const openProductPicker = () => {
    setProductPickerOpen(true);
    setProductSearch('');
  };

  const showQuestionProduct =
    isReply &&
    questionProductLabel &&
    String(questionProductLabel).trim() !== '' &&
    String(questionProductLabel).trim() !== 'товар' &&
    String(questionProductLabel).trim() !== '—';

  const leadingOption = showQuestionProduct
    ? {
        label: 'Из вопроса',
        sublabel: questionProductLabel,
        onSelect: handleInsertFromQuestion,
      }
    : null;

  const renderProductOption = (product) => {
    const sku = String(product?.sku || '').trim() || '—';
    const mpNumber = getProductMarketplaceNumber(product, questionMarketplace);
    const displayArticle = mpNumber || sku;
    const nameOnly = productNameWithoutArticle(sku, product?.name);
    return (
      <>
        <div className="product-search-input__row">
          <div className="product-search-input__sku">{displayArticle}</div>
          {mpNumber && sku !== '—' && sku !== mpNumber ? (
            <div className="product-search-input__meta">{sku}</div>
          ) : null}
        </div>
        {nameOnly ? <div className="product-search-input__name">{nameOnly}</div> : null}
      </>
    );
  };

  return (
    <div className="questions-template-body-editor__toolbar">
      <span className="questions-template-body-editor__toolbar-label">Вставить в текст:</span>
      {showName ? (
        <button
          type="button"
          className="questions-template-token questions-template-token--insert"
          onClick={insertName}
          disabled={disabled}
          title={
            isReply
              ? 'Вставить имя покупателя из вопроса'
              : 'Вставить метку имени (подставится при ответе)'
          }
        >
          <span className="questions-template-token__icon" aria-hidden="true">
            👤
          </span>
          Имя покупателя
        </button>
      ) : null}
      {showProduct && isReply ? (
        !productPickerOpen ? (
          <button
            type="button"
            className="questions-template-token questions-template-token--insert questions-template-token--product"
            onClick={openProductPicker}
            disabled={disabled}
            title="Найти товар и вставить номер карточки на МП"
          >
            <span className="questions-template-token__icon" aria-hidden="true">
              📦
            </span>
            Товар
          </button>
        ) : (
          <div className="questions-product-inline questions-template-token--product">
            <span className="questions-template-token__icon questions-product-inline__icon" aria-hidden="true">
              📦
            </span>
            <ProductSearchInput
              id="questions-reply-product-search"
              inputRef={productSearchRef}
              className="questions-product-inline__input"
              value={productSearch}
              onChange={setProductSearch}
              organizationId={organizationId}
              placeholder={productResolving ? 'Загрузка номера МП…' : 'Артикул или название'}
              disabled={disabled || productResolving}
              autoFocus
              leadingOption={leadingOption}
              onEscape={closeProductPicker}
              renderOption={renderProductOption}
              onSelect={handleProductSelect}
            />
            <button
              type="button"
              className="questions-product-inline__close"
              onClick={closeProductPicker}
              disabled={disabled}
              title="Закрыть поиск"
              aria-label="Закрыть поиск товара"
            >
              ×
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

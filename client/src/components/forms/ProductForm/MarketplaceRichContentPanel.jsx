/**
 * Панель Rich-контента: визуальный предпросмотр и открытие сверстанной страницы.
 */

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../common/Button/Button';
import {
  buildRichContentPreviewHtml,
  hasRichContentPreview,
  openRichContentPreviewPage,
} from '../../../utils/marketplaceRichContentPreview.js';
import { RichContentConstructor } from '../../../pages/Settings/RichContentConstructor.jsx';

const MP_LABEL = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

function previewCode(marketplace, payload) {
  if (!payload) return '';
  if (marketplace === 'ozon') {
    try {
      return JSON.stringify(payload.json || JSON.parse(payload.jsonString || '{}'), null, 2);
    } catch {
      return String(payload.jsonString || '');
    }
  }
  return String(payload.description || '');
}

export function MarketplaceRichContentPanel({
  marketplace,
  loading = false,
  error = '',
  result = null,
  onGenerate,
  disabled = false,
  categoryId = '',
  productId = '',
  onModulesDraftChange,
  mpFieldLinks = null,
  onMpFieldLinkToggle,
}) {
  const mp = String(marketplace || '').toLowerCase();
  const payload = result?.[mp] || null;
  const notes = Array.isArray(payload?.notes) ? payload.notes : [];
  const ready = hasRichContentPreview(mp, payload);
  const html = useMemo(
    () => (ready ? buildRichContentPreviewHtml(mp, payload) : ''),
    [ready, mp, payload]
  );
  const [showCode, setShowCode] = useState(false);
  const [openError, setOpenError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const isOzon = mp === 'ozon';
  const code = previewCode(mp, payload);

  const handleOpenPage = () => {
    setOpenError('');
    try {
      openRichContentPreviewPage(mp, payload);
    } catch (e) {
      setOpenError(e?.message || 'Не удалось открыть страницу предпросмотра');
    }
  };

  return (
    <div
      id={`rich-content-preview-${mp}`}
      className="card mt-3 border-secondary"
    >
      <div className="card-header d-flex align-items-center justify-content-between gap-2 flex-wrap">
        <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 0' }}>
          Предпросмотр Rich-контента
        </span>
        <div className="d-flex gap-2 flex-wrap">
          <Button
            type="button"
            variant="secondary"
            onClick={onGenerate}
            disabled={disabled || loading}
          >
            {loading ? 'Генерация…' : 'Сгенерировать из карточки'}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleOpenPage}
            disabled={!ready}
            title={ready ? 'Открыть сверстанную страницу в новой вкладке' : 'Сначала сгенерируйте контент'}
          >
            Открыть страницу
          </Button>
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
          {isOzon
            ? `Вёрстка виджетов ${MP_LABEL[mp]} из шаблона категории.`
            : `${MP_LABEL[mp]} не принимает Rich JSON через API — показываем свёрстанное описание из того же шаблона категории.`}
          {categoryId ? (
            <>
              {' '}
              <Link to={`/settings/content/rich-content?categoryId=${encodeURIComponent(categoryId)}`}>
                Шаблон категории
              </Link>
            </>
          ) : null}
          {productId ? (
            <>
              {' · '}
              <Link to={`/settings/content/rich-content?productId=${encodeURIComponent(productId)}`}>
                Шаблон этого товара
              </Link>
            </>
          ) : null}
        </p>
        {productId ? (
          <details
            className="rich-content-product-editor"
            open={editOpen}
            onToggle={(e) => setEditOpen(e.currentTarget.open)}
          >
            <summary>Изменить вёрстку этого товара</summary>
            {editOpen ? (
              <RichContentConstructor
                embeddedProductId={String(productId)}
                onModulesChange={onModulesDraftChange}
              />
            ) : null}
          </details>
        ) : null}
        {error ? (
          <div className="alert alert-danger py-2 mb-2" style={{ fontSize: '12px' }}>
            {error}
          </div>
        ) : null}
        {openError ? (
          <div className="alert alert-warning py-2 mb-2" style={{ fontSize: '12px' }}>
            {openError}
          </div>
        ) : null}
        {notes.length > 0 ? (
          <ul style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 8, paddingLeft: 18 }}>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {ready ? (
          <>
            <iframe
              title={`Предпросмотр Rich-контента ${MP_LABEL[mp] || mp}`}
              srcDoc={html}
              sandbox="allow-same-origin"
              style={{
                width: '100%',
                height: 420,
                border: '1px solid rgba(0,0,0,.12)',
                borderRadius: 8,
                background: '#f2f3f5',
              }}
            />
            <button
              type="button"
              className="btn btn-link btn-sm px-0 mt-2"
              onClick={() => setShowCode((v) => !v)}
            >
              {showCode ? 'Скрыть код' : 'Показать код'}
            </button>
            {showCode ? (
              <textarea
                className="form-control form-control-sm font-monospace"
                readOnly
                rows={isOzon ? 10 : 8}
                value={code}
                style={{ fontSize: '11px' }}
              />
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
            Пока не сгенерировано.
          </div>
        )}
      </div>
    </div>
  );
}

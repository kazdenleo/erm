/**
 * Price Promotions Page
 * Страница акций маркетплейсов (Ozon / WB / YM)
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { pricesApi } from '../../services/prices.api.js';
import { Modal } from '../../components/common/Modal/Modal';
import { useProductCardModal } from '../../context/ProductCardModalContext.jsx';
import './Prices.css';

function formatRub(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${n} ₽`;
}

/**
 * Предлагаемая цена для входа в акцию Ozon.
 * Обычные акции: alert_max_action_price.
 * Эластичный бустинг (ELASTIC_BOOSTING): alert_max_action_price = 0,
 * цена входа — max_action_price / price_min_elastic.
 */
function ozonSuggestedEntryPrice(p) {
  if (!p) return null;
  const alert = Number(p.alert_max_action_price);
  if (Number.isFinite(alert) && alert > 0) return alert;
  const maxAction = Number(p.max_action_price);
  if (Number.isFinite(maxAction) && maxAction > 0) return maxAction;
  const minElastic = Number(p.price_min_elastic);
  if (Number.isFinite(minElastic) && minElastic > 0) return minElastic;
  return null;
}

function isOzonElasticBoostingAction(action) {
  const t = String(action?.action_type || action?.discount_type || '').toUpperCase();
  if (t === 'ELASTIC_BOOSTING') return true;
  return /эластич|elastic/i.test(String(action?.title || ''));
}

export function PricePromotions() {
  const { openProductCardFromClick } = useProductCardModal();
  const [activePromoMarketplace, setActivePromoMarketplace] = useState('ozon'); // 'ozon' | 'wb' | 'ym'
  const [ozonActions, setOzonActions] = useState([]);
  const [ozonActionsLoading, setOzonActionsLoading] = useState(false);
  const [ozonActionsError, setOzonActionsError] = useState(null);
  const [wbActions, setWbActions] = useState([]);
  const [wbActionsLoading, setWbActionsLoading] = useState(false);
  const [wbActionsError, setWbActionsError] = useState(null);
  const [actionModal, setActionModal] = useState({ isOpen: false, action: null });
  const [actionModalTab, setActionModalTab] = useState('participating');
  const [actionProducts, setActionProducts] = useState([]);
  const [actionCandidates, setActionCandidates] = useState([]);
  const [actionProductsLoading, setActionProductsLoading] = useState(false);
  const [actionCandidatesLoading, setActionCandidatesLoading] = useState(false);
  const [actionProductsError, setActionProductsError] = useState(null);
  const [actionCandidatesError, setActionCandidatesError] = useState(null);
  const [wbActionModal, setWbActionModal] = useState({ isOpen: false, promotion: null });
  const [wbActionDetails, setWbActionDetails] = useState(null);
  const [wbActionDetailsLoading, setWbActionDetailsLoading] = useState(false);
  const [wbActionDetailsError, setWbActionDetailsError] = useState(null);
  const [wbActionModalTab, setWbActionModalTab] = useState('details'); // 'details' | 'participating' | 'candidates'
  const [wbNomenclaturesIn, setWbNomenclaturesIn] = useState([]);
  const [wbNomenclaturesOut, setWbNomenclaturesOut] = useState([]);
  const [wbNomenclaturesInLoading, setWbNomenclaturesInLoading] = useState(false);
  const [wbNomenclaturesOutLoading, setWbNomenclaturesOutLoading] = useState(false);
  const [wbNomenclaturesInError, setWbNomenclaturesInError] = useState(null);
  const [wbNomenclaturesOutError, setWbNomenclaturesOutError] = useState(null);
  const [wbNomenclaturesInNotApplicable, setWbNomenclaturesInNotApplicable] = useState(false);
  const [wbNomenclaturesOutNotApplicable, setWbNomenclaturesOutNotApplicable] = useState(false);

  // При открытии модалки акции — загружаем участвующие и доступные товары
  useEffect(() => {
    if (!actionModal.isOpen || !actionModal.action?.id) {
      return;
    }
    const actionId = actionModal.action.id;
    setActionProducts([]);
    setActionCandidates([]);
    setActionProductsError(null);
    setActionCandidatesError(null);

    let cancelled = false;
    (async () => {
      setActionProductsLoading(true);
      try {
        const res = await pricesApi.getOzonActionProducts(actionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setActionProducts(Array.isArray(data) ? data : []);
        if (res?.error) setActionProductsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setActionProductsError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setActionProducts([]);
        }
      } finally {
        if (!cancelled) setActionProductsLoading(false);
      }
    })();

    setActionCandidatesLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getOzonActionCandidates(actionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setActionCandidates(Array.isArray(data) ? data : []);
        if (res?.error) setActionCandidatesError(res.error);
      } catch (err) {
        if (!cancelled) {
          setActionCandidatesError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setActionCandidates([]);
        }
      } finally {
        if (!cancelled) setActionCandidatesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [actionModal.isOpen, actionModal.action?.id]);

  // Загрузка акций Ozon при открытии вкладки Ozon
  useEffect(() => {
    if (activePromoMarketplace !== 'ozon') return;
    let cancelled = false;
    const load = async () => {
      setOzonActionsLoading(true);
      setOzonActionsError(null);
      try {
        const res = await pricesApi.getOzonActions();
        const data = res?.data ?? res;
        if (cancelled) return;
        setOzonActions(Array.isArray(data) ? data : []);
        if (!Array.isArray(data) && res?.error) setOzonActionsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setOzonActionsError(err.response?.data?.error || err.message || 'Ошибка загрузки акций');
          setOzonActions([]);
        }
      } finally {
        if (!cancelled) setOzonActionsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activePromoMarketplace]);

  // При открытии модалки акции WB — загружаем детали и номенклатуры (участвующие / доступные)
  useEffect(() => {
    if (!wbActionModal.isOpen || !wbActionModal.promotion?.id) {
      setWbActionDetails(null);
      setWbNomenclaturesIn([]);
      setWbNomenclaturesOut([]);
      setWbActionModalTab('details');
      return;
    }
    const promotionId = wbActionModal.promotion.id;
    let cancelled = false;
    setWbActionDetails(null);
    setWbActionDetailsError(null);
    setWbActionDetailsLoading(true);
    setWbNomenclaturesIn([]);
    setWbNomenclaturesOut([]);
    setWbNomenclaturesInError(null);
    setWbNomenclaturesOutError(null);
    setWbNomenclaturesInNotApplicable(false);
    setWbNomenclaturesOutNotApplicable(false);

    (async () => {
      try {
        const res = await pricesApi.getWBPromotionDetails(promotionId);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbActionDetails(data || null);
        if (res?.error) setWbActionDetailsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbActionDetailsError(err.response?.data?.error || err.message || 'Ошибка загрузки деталей акции');
          setWbActionDetails(null);
        }
      } finally {
        if (!cancelled) setWbActionDetailsLoading(false);
      }
    })();

    setWbNomenclaturesInLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getWBPromotionNomenclatures(promotionId, true, 1000, 0);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbNomenclaturesIn(Array.isArray(data) ? data : []);
        setWbNomenclaturesInNotApplicable(res?.notApplicable === true);
        if (res?.error) setWbNomenclaturesInError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbNomenclaturesInError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setWbNomenclaturesIn([]);
        }
      } finally {
        if (!cancelled) setWbNomenclaturesInLoading(false);
      }
    })();

    setWbNomenclaturesOutLoading(true);
    (async () => {
      try {
        const res = await pricesApi.getWBPromotionNomenclatures(promotionId, false, 1000, 0);
        if (cancelled) return;
        const data = res?.data ?? res;
        setWbNomenclaturesOut(Array.isArray(data) ? data : []);
        setWbNomenclaturesOutNotApplicable(res?.notApplicable === true);
        if (res?.error) setWbNomenclaturesOutError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbNomenclaturesOutError(err.response?.data?.error || err.message || 'Ошибка загрузки');
          setWbNomenclaturesOut([]);
        }
      } finally {
        if (!cancelled) setWbNomenclaturesOutLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [wbActionModal.isOpen, wbActionModal.promotion?.id]);

  // Загрузка акций WB при открытии вкладки Wildberries
  useEffect(() => {
    if (activePromoMarketplace !== 'wb') return;
    let cancelled = false;
    const load = async () => {
      setWbActionsLoading(true);
      setWbActionsError(null);
      try {
        const res = await pricesApi.getWBActions();
        const data = res?.data ?? res;
        if (cancelled) return;
        setWbActions(Array.isArray(data) ? data : []);
        if (!Array.isArray(data) && res?.error) setWbActionsError(res.error);
      } catch (err) {
        if (!cancelled) {
          setWbActionsError(err.response?.data?.error || err.message || 'Ошибка загрузки акций WB');
          setWbActions([]);
        }
      } finally {
        if (!cancelled) setWbActionsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activePromoMarketplace]);

  return (
    <div className="card">
      <h1 className="title">Акции</h1>
      <p className="subtitle">
        Акции маркетплейсов ·{' '}
        <Link to="/prices" style={{ color: 'var(--primary)' }}>Минимальные цены</Link>
      </p>

      {/* Вкладки маркетплейсов */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {[
          { key: 'ozon', label: 'Ozon' },
          { key: 'wb', label: 'Wildberries' },
          { key: 'ym', label: 'Яндекс.Маркет' }
        ].map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActivePromoMarketplace(key)}
            style={{
              padding: '8px 14px',
              background: activePromoMarketplace === key ? 'rgba(255,255,255,0.1)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: activePromoMarketplace === key ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Контент вкладки Ozon */}
      {activePromoMarketplace === 'ozon' && (
        <div className="prices-table-container" style={{ marginTop: '16px' }}>
          {ozonActionsLoading ? (
            <p style={{ color: 'var(--muted)' }}>Загрузка акций...</p>
          ) : ozonActionsError ? (
            <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {ozonActionsError}</p>
          ) : ozonActions.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>Акций нет</p>
          ) : (
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Тип</th>
                  <th>Начало</th>
                  <th>Окончание</th>
                  <th>Участвует товаров</th>
                  <th title="Количество товаров, которые могут участвовать в акции">Могут участвовать</th>
                </tr>
              </thead>
              <tbody>
                {ozonActions.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setActionModal({ isOpen: true, action: a })}
                    style={{ cursor: 'pointer' }}
                    title="Нажмите, чтобы открыть товары акции"
                  >
                    <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{a.id}</td>
                    <td>{a.title || '—'}</td>
                    <td>{a.action_type || a.discount_type || '—'}</td>
                    <td style={{ fontSize: '13px' }}>
                      {a.date_start ? new Date(a.date_start).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ fontSize: '13px' }}>
                      {a.date_end ? new Date(a.date_end).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ textAlign: 'center' }}>{a.participating_products_count ?? a.potential_products_count ?? 0}</td>
                    <td style={{ textAlign: 'center' }}>{a.potential_products_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activePromoMarketplace === 'wb' && (
        <div className="prices-table-container" style={{ marginTop: '16px' }}>
          {wbActionsLoading ? (
            <p style={{ color: 'var(--muted)' }}>Загрузка акций WB...</p>
          ) : wbActionsError ? (
            <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbActionsError}</p>
          ) : wbActions.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>Акций WB нет</p>
          ) : (
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Тип</th>
                  <th>Начало</th>
                  <th>Окончание</th>
                  <th title="Товаров в акции">В акции</th>
                  <th title="Товаров не в акции (могут участвовать)">Не в акции</th>
                  <th>% участия</th>
                </tr>
              </thead>
              <tbody>
                {wbActions.map((a) => (
                  <tr
                    key={a.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setWbActionModal({ isOpen: true, promotion: a })}
                    title="Нажмите, чтобы открыть детали акции"
                  >
                    <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{a.id}</td>
                    <td>{a.name || '—'}</td>
                    <td>{a.type || '—'}</td>
                    <td style={{ fontSize: '13px' }}>
                      {a.startDateTime ? new Date(a.startDateTime).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ fontSize: '13px' }}>
                      {a.endDateTime ? new Date(a.endDateTime).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ textAlign: 'center' }}>{a.inPromoActionTotal ?? a.inPromoActionLeftovers ?? '—'}</td>
                    <td style={{ textAlign: 'center' }}>{a.notInPromoActionTotal ?? a.notInPromoActionLeftovers ?? '—'}</td>
                    <td style={{ textAlign: 'center' }}>{a.participationPercentage != null ? `${a.participationPercentage}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {activePromoMarketplace === 'ym' && (
        <p style={{ color: 'var(--muted)', marginTop: '24px' }}>Раздел акций Яндекс.Маркета — в разработке</p>
      )}

      {/* Модалка: товары акции Ozon — участвующие и доступные к акции */}
      <Modal
        isOpen={actionModal.isOpen}
        onClose={() => setActionModal({ isOpen: false, action: null })}
        title={actionModal.action ? `Акция: ${actionModal.action.title || actionModal.action.id}` : 'Акция'}
        size="xl"
      >
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
          <button
            type="button"
            onClick={() => setActionModalTab('participating')}
            style={{
              padding: '8px 14px',
              background: actionModalTab === 'participating' ? 'rgba(0,91,255,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: actionModalTab === 'participating' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Участвующие в акции
          </button>
          <button
            type="button"
            onClick={() => setActionModalTab('candidates')}
            style={{
              padding: '8px 14px',
              background: actionModalTab === 'candidates' ? 'rgba(0,91,255,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: actionModalTab === 'candidates' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Доступные к акции
          </button>
        </div>
        {actionModalTab === 'participating' && (
          <div className="prices-table-container">
            {actionProductsLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка...</p>
            ) : actionProductsError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {actionProductsError}</p>
            ) : actionProducts.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>Нет товаров из нашей системы, участвующих в этой акции</p>
            ) : (
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Сохранённая минимальная цена для Ozon">Мин. цена (Ozon), ₽</th>
                      <th>Цена, ₽</th>
                      <th>Цена по акции, ₽</th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th>Рек. цена акции, ₽</th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th>Бустинг, %</th>
                      <th>Цена мин. бустинга, ₽</th>
                      <th>Цена макс. бустинга, ₽</th>
                      <th>Мин. бустинг, %</th>
                      <th>Макс. бустинг, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionProducts.map((p) => (
                      <tr key={p.id} style={p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>
                          {p.our_product_id != null ? (
                            <button
                              type="button"
                              onClick={(e) => openProductCardFromClick(p.our_product_id, e)}
                              title="Открыть карточку товара"
                              style={{ padding: 0, border: 0, background: 'transparent', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', textAlign: 'left' }}
                            >
                              {p.our_product_name || '—'}
                            </button>
                          ) : (
                            p.our_product_name || '—'
                          )}
                        </td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>
                          {p.our_product_id != null ? (
                            <button
                              type="button"
                              onClick={(e) => openProductCardFromClick(p.our_product_id, e)}
                              title="Открыть карточку товара"
                              style={{ padding: 0, border: 0, background: 'transparent', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              {p.our_sku ?? p.offer_id ?? '—'}
                            </button>
                          ) : (
                            p.our_sku ?? p.offer_id ?? '—'
                          )}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td style={{ color: 'var(--primary)' }}>{p.min_price_ozon != null ? `${p.min_price_ozon} ₽` : '—'}</td>
                        <td>{p.price != null ? `${p.price} ₽` : '—'}</td>
                        <td>{p.action_price != null ? `${p.action_price} ₽` : '—'}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой, товар может быть исключён' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td>{p.alert_max_action_price != null ? `${p.alert_max_action_price} ₽` : '—'}</td>
                        <td>{p.max_action_price != null ? `${p.max_action_price} ₽` : '—'}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{p.current_boost != null ? p.current_boost : '—'}</td>
                        <td>{p.price_min_elastic != null ? `${p.price_min_elastic} ₽` : '—'}</td>
                        <td>{p.price_max_elastic != null ? `${p.price_max_elastic} ₽` : '—'}</td>
                        <td>{p.min_boost != null ? p.min_boost : '—'}</td>
                        <td>{p.max_boost != null ? p.max_boost : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {actionModalTab === 'candidates' && (
          <div className="prices-table-container">
            {actionCandidatesLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка...</p>
            ) : actionCandidatesError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {actionCandidatesError}</p>
            ) : actionCandidates.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>Нет товаров из нашей системы, доступных к добавлению в эту акцию</p>
            ) : (
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Сохранённая минимальная цена для Ozon">Мин. цена (Ozon), ₽</th>
                      <th>Цена, ₽</th>
                      <th>Цена по акции, ₽</th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th>Рек. цена акции, ₽</th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th>Бустинг, %</th>
                      <th>Цена мин. бустинга, ₽</th>
                      <th>Цена макс. бустинга, ₽</th>
                      <th>Мин. бустинг, %</th>
                      <th>Макс. бустинг, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionCandidates.map((p) => (
                      <tr key={p.id} style={p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>{p.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{p.our_sku ?? p.offer_id ?? '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td style={{ color: 'var(--primary)' }}>{p.min_price_ozon != null ? `${p.min_price_ozon} ₽` : '—'}</td>
                        <td>{p.price != null ? `${p.price} ₽` : '—'}</td>
                        <td>{p.action_price != null ? `${p.action_price} ₽` : '—'}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td>{p.alert_max_action_price != null ? `${p.alert_max_action_price} ₽` : '—'}</td>
                        <td>{p.max_action_price != null ? `${p.max_action_price} ₽` : '—'}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{p.current_boost != null ? p.current_boost : '—'}</td>
                        <td>{p.price_min_elastic != null ? `${p.price_min_elastic} ₽` : '—'}</td>
                        <td>{p.price_max_elastic != null ? `${p.price_max_elastic} ₽` : '—'}</td>
                        <td>{p.min_boost != null ? p.min_boost : '—'}</td>
                        <td>{p.max_boost != null ? p.max_boost : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Модалка: детали акции WB + номенклатуры (участвующие / доступные) */}
      <Modal
        isOpen={wbActionModal.isOpen}
        onClose={() => setWbActionModal({ isOpen: false, promotion: null })}
        title={wbActionModal.promotion ? `Акция WB: ${wbActionModal.promotion.name || wbActionModal.promotion.id}` : 'Акция WB'}
        size="xl"
      >
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
          <button
            type="button"
            onClick={() => setWbActionModalTab('details')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'details' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'details' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Детали
          </button>
          <button
            type="button"
            onClick={() => setWbActionModalTab('participating')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'participating' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'participating' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Участвующие в акции
          </button>
          <button
            type="button"
            onClick={() => setWbActionModalTab('candidates')}
            style={{
              padding: '8px 14px',
              background: wbActionModalTab === 'candidates' ? 'rgba(203,17,171,0.2)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: wbActionModalTab === 'candidates' ? '#fff' : 'var(--muted)',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Доступные к акции
          </button>
        </div>

        {wbActionModalTab === 'details' && (
          <>
            {wbActionDetailsLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка деталей акции...</p>
            ) : wbActionDetailsError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbActionDetailsError}</p>
            ) : wbActionDetails ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {wbActionDetails.description && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Описание</strong>
                    <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{wbActionDetails.description}</p>
                  </div>
                )}
                {Array.isArray(wbActionDetails.advantages) && wbActionDetails.advantages.length > 0 && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Преимущества</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                      {wbActionDetails.advantages.map((adv, i) => (
                        <li key={i}>{adv}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 24px' }}>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Тип</span>
                    <div>{wbActionDetails.type || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Начало</span>
                    <div>{wbActionDetails.startDateTime ? new Date(wbActionDetails.startDateTime).toLocaleString('ru-RU') : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Окончание</span>
                    <div>{wbActionDetails.endDateTime ? new Date(wbActionDetails.endDateTime).toLocaleString('ru-RU') : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>В акции (остаток / всего)</span>
                    <div>{wbActionDetails.inPromoActionLeftovers != null || wbActionDetails.inPromoActionTotal != null ? `${wbActionDetails.inPromoActionLeftovers ?? '—'} / ${wbActionDetails.inPromoActionTotal ?? '—'}` : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Не в акции (остаток / всего)</span>
                    <div>{wbActionDetails.notInPromoActionLeftovers != null || wbActionDetails.notInPromoActionTotal != null ? `${wbActionDetails.notInPromoActionLeftovers ?? '—'} / ${wbActionDetails.notInPromoActionTotal ?? '—'}` : '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)', fontSize: '12px' }}>% участия</span>
                    <div>{wbActionDetails.participationPercentage != null ? `${wbActionDetails.participationPercentage}%` : '—'}</div>
                  </div>
                  {wbActionDetails.exceptionProductsCount != null && (
                    <div>
                      <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Исключённых товаров</span>
                      <div>{wbActionDetails.exceptionProductsCount}</div>
                    </div>
                  )}
                </div>
                {Array.isArray(wbActionDetails.ranging) && wbActionDetails.ranging.length > 0 && (
                  <div>
                    <strong style={{ color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase' }}>Ранжирование</strong>
                    <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                      <table className="prices-table table" style={{ minWidth: '280px' }}>
                        <thead>
                          <tr>
                            <th>Условие</th>
                            <th>% участия</th>
                            <th>Буст</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wbActionDetails.ranging.map((r, i) => (
                            <tr key={i}>
                              <td>{r.condition || '—'}</td>
                              <td>{r.participationRate != null ? `${r.participationRate}%` : '—'}</td>
                              <td>{r.boost != null ? r.boost : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--muted)' }}>Нет деталей по акции</p>
            )}
          </>
        )}

        {wbActionModalTab === 'participating' && (
          <div className="prices-table-container">
            {wbNomenclaturesInLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка товаров в акции...</p>
            ) : wbNomenclaturesInError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbNomenclaturesInError}</p>
            ) : wbNomenclaturesIn.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                {wbNomenclaturesInNotApplicable
                  ? 'Для этой акции список товаров недоступен (например, авто-акция).'
                  : 'Нет товаров, участвующих в этой акции'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID (nm)</th>
                      <th>В акции</th>
                      <th>Цена, ₽</th>
                      <th>Валюта</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesIn.map((n) => (
                      <tr key={n.id}>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{n.inAction ? 'Да' : 'Нет'}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
                        <td>{n.currencyCode || '—'}</td>
                        <td>{n.planPrice != null ? `${n.planPrice}` : '—'}</td>
                        <td>{n.discount != null ? `${n.discount}%` : '—'}</td>
                        <td>{n.planDiscount != null ? `${n.planDiscount}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {wbActionModalTab === 'candidates' && (
          <div className="prices-table-container">
            {wbNomenclaturesOutLoading ? (
              <p style={{ color: 'var(--muted)' }}>Загрузка товаров, доступных к акции...</p>
            ) : wbNomenclaturesOutError ? (
              <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {wbNomenclaturesOutError}</p>
            ) : wbNomenclaturesOut.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                {wbNomenclaturesOutNotApplicable
                  ? 'Для этой акции список товаров недоступен (например, авто-акция).'
                  : 'Нет товаров, доступных к добавлению в эту акцию'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th>ID (nm)</th>
                      <th>В акции</th>
                      <th>Цена, ₽</th>
                      <th>Валюта</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesOut.map((n) => (
                      <tr key={n.id}>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{n.inAction ? 'Да' : 'Нет'}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
                        <td>{n.currencyCode || '—'}</td>
                        <td>{n.planPrice != null ? `${n.planPrice}` : '—'}</td>
                        <td>{n.discount != null ? `${n.discount}%` : '—'}</td>
                        <td>{n.planDiscount != null ? `${n.planDiscount}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

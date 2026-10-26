/**
 * Price Promotions Page
 * Страница акций маркетплейсов (Ozon / WB / YM)
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { pricesApi } from '../../services/prices.api.js';
import { Modal } from '../../components/common/Modal/Modal';
import { productCardPath } from '../../utils/productCardPath.js';
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

/** У доступных к акции action_price=0 — показываем цену входа. */
function ozonDisplayActionPrice(p) {
  const ap = Number(p?.action_price);
  if (Number.isFinite(ap) && ap > 0) return ap;
  return ozonSuggestedEntryPrice(p);
}

function joinTitle(row) {
  if (row?.join_block_reason === 'below_floor') return 'Цена входа ниже минимальной — продажа в минус';
  if (row?.join_block_reason === 'no_floor') return 'Минимальная цена не посчитана — вход закрыт';
  if (row?.join_block_reason === 'no_entry_price') return 'Нет цены входа';
  return 'Войти в акцию';
}

function positivePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Мин. цена из карточки: FBS и FBO, если они различаются. */
function cardMinParts(row) {
  const fbs = positivePrice(row?.card_min_fbs);
  const fbo = positivePrice(row?.card_min_fbo);
  const plain = positivePrice(row?.card_min ?? row?.floor ?? row?.min_price_ozon);
  if (fbs != null && fbo != null && fbs !== fbo) {
    return [
      { key: 'fbs', label: 'FBS', value: fbs },
      { key: 'fbo', label: 'FBO', value: fbo },
    ];
  }
  const one = fbs ?? fbo ?? plain;
  return one != null ? [{ key: 'min', label: '', value: one }] : [];
}

function minPriceCell(row) {
  const parts = cardMinParts(row);
  if (!parts.length) return '—';
  if (parts.length === 1 && !parts[0].label) return formatRub(parts[0].value);
  return (
    <div>
      {parts.map((part) => (
        <div key={part.key} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {part.label} {formatRub(part.value)}
        </div>
      ))}
    </div>
  );
}

function formatLevelProfit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  return `${rounded > 0 ? '+' : ''}${rounded} ₽`;
}

function boostLevelsCell(row, promoBusyKey, onSet) {
  const levels = Array.isArray(row?.boost_levels) ? row.boost_levels : [];
  if (!levels.length) return '—';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {levels.map((level) => {
        const busy = promoBusyKey === `ozon-boost-${row.id}-${level.boost}`;
        const profitNum = Number(level.profit_rub);
        const hasProfit = Number.isFinite(profitNum);
        const color = hasProfit && profitNum < 0 ? 'var(--danger, #ef4444)' : 'var(--success, #22c55e)';
        return (
          <div
            key={level.boost}
            title={level.current ? 'Ближайший уровень к текущей цене в акции' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              whiteSpace: 'nowrap',
              background: level.current ? 'rgba(0,91,255,0.12)' : 'transparent',
              borderRadius: 4,
              padding: '1px 4px',
            }}
          >
            <span style={{ width: 36, fontWeight: 600 }}>{level.boost}%</span>
            <span style={{ width: 58 }}>{formatRub(level.price)}</span>
            <span style={{ width: 64, color: hasProfit ? color : 'var(--muted)', fontWeight: 600 }}>{formatLevelProfit(level.profit_rub)}</span>
            <button
              type="button"
              disabled={Boolean(level.join_block_reason) || busy}
              title={level.join_block_reason ? joinTitle({ join_block_reason: level.join_block_reason }) : 'Поставить эту предельную цену. Она же станет ценой в разделе «Цены»'}
              onClick={() => onSet(level)}
              style={{ padding: '2px 6px', fontSize: 11 }}
            >
              {busy ? '...' : 'Поставить'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function profitCell(row) {
  const raw = row?.profit_rub;
  const n = raw == null || raw === '' ? null : Number(raw);
  const hasProfit = Number.isFinite(n);
  const markup = Number(row?.markup_rub);
  const hasMarkup = Number.isFinite(markup) && markup >= 0;
  if (!hasProfit && !hasMarkup) return '—';
  const color = hasProfit && n < 0 ? 'var(--danger, #ef4444)' : 'var(--success, #22c55e)';
  const markupText = hasMarkup ? `${Number.isInteger(markup) ? markup : Math.round(markup * 100) / 100} ₽` : null;
  return (
    <div title="Чистая прибыль при продаже по цене входа в акцию. Ниже — мин. наценка из карточки товара.">
      <div style={{ color: hasProfit ? color : 'var(--muted)', fontWeight: hasProfit ? 600 : 400 }}>
        {hasProfit ? `${n > 0 ? `+${n}` : n} ₽` : '—'}
      </div>
      {markupText ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap' }}>
          наценка {markupText}
        </div>
      ) : null}
    </div>
  );
}

/** Коды типов акций Ozon (GET /v1/actions → action_type) в формулировках кабинета. */
const OZON_ACTION_TYPE = {
  UNSPECIFIED: 'Не указан',
  ACTION_TYPE_UNSPECIFIED: 'Не указан',
  DISCOUNT: 'Скидка',
  STOCK_DISCOUNT: 'Скидка на сток',
  ADDITIONAL_DISCOUNT: 'Дополнительная скидка',
  MARKETPLACE_MULTI_LEVEL_DISCOUNT_ON_AMOUNT: 'Многоуровневая скидка от суммы',
  ELASTIC_BOOSTING: 'Эластичный бустинг',
  VOUCHER: 'Промокод',
  INSTALLMENT: 'Рассрочка',
};

const OZON_DISCOUNT_TYPE = {
  UNKNOWN: 'Не указан',
  PERCENT: 'Процент',
  CURRENCY: 'Сумма',
  FIXED: 'Фиксированная сумма',
  RUB: 'Сумма',
  FINAL_PRICE: 'Итоговая цена',
};

const WB_PROMO_TYPE = {
  regular: 'Обычная',
  auto: 'Автоакция',
};

function promoTypeLabel(code, dict) {
  if (code == null || String(code).trim() === '') return '—';
  const key = String(code).trim();
  if (/[а-яё]/i.test(key)) return key;
  return dict[key] || dict[key.toUpperCase()] || dict[key.toLowerCase()] || key;
}

function ozonActionTypeLabel(action) {
  if (action?.action_type) return promoTypeLabel(action.action_type, OZON_ACTION_TYPE);
  if (action?.discount_type) return promoTypeLabel(action.discount_type, OZON_DISCOUNT_TYPE);
  return '—';
}

const PROMO_MARKETPLACES = [
  { key: 'ozon', label: 'Ozon', shortLabel: 'OZ' },
  { key: 'wb', label: 'Wildberries', shortLabel: 'WB' },
  { key: 'ym', label: 'Яндекс.Маркет', shortLabel: 'YM' },
];

const YM_STATUS = {
  AUTO: 'автоматически',
  PARTIALLY_AUTO: 'частично автоматически',
  MANUAL: 'вручную',
  NOT_PARTICIPATING: 'не участвует',
  RENEWED: 'перенесён',
  RENEW_FAILED: 'не перенесён',
  MINIMUM_FOR_PROMOS: 'по минимуму акции',
};

export function PricePromotions() {
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
  const [promoReload, setPromoReload] = useState(0);
  const [promoBusyKey, setPromoBusyKey] = useState('');
  const [promoNotice, setPromoNotice] = useState(null);
  const [ymPromos, setYmPromos] = useState([]);
  const [ymPromosLoading, setYmPromosLoading] = useState(false);
  const [ymPromosError, setYmPromosError] = useState(null);
  const [ymModal, setYmModal] = useState({ isOpen: false, promo: null });
  const [ymOffers, setYmOffers] = useState([]);
  const [ymOffersLoading, setYmOffersLoading] = useState(false);
  const [ymOffersError, setYmOffersError] = useState(null);
  const [ymModalTab, setYmModalTab] = useState('participating');

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
        if (res?.notApplicable) {
          setActionCandidatesError(res.error || 'Ozon не отдаёт список доступных товаров для этой акции');
        } else if (res?.error) setActionCandidatesError(res.error);
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
  }, [actionModal.isOpen, actionModal.action?.id, promoReload]);

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
  }, [wbActionModal.isOpen, wbActionModal.promotion?.id, promoReload]);

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

  useEffect(() => {
    if (activePromoMarketplace !== 'ym') return;
    let cancelled = false;
    (async () => {
      setYmPromosLoading(true);
      setYmPromosError(null);
      try {
        const res = await pricesApi.getYmPromos();
        if (cancelled) return;
        const data = res?.data ?? [];
        setYmPromos(Array.isArray(data) ? data : []);
        if (res?.ok === false) setYmPromosError(res.error || 'Ошибка загрузки акций');
      } catch (err) {
        if (!cancelled) {
          setYmPromosError(err.response?.data?.error || err.message || 'Ошибка загрузки акций Яндекс Маркета');
          setYmPromos([]);
        }
      } finally {
        if (!cancelled) setYmPromosLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activePromoMarketplace]);

  useEffect(() => {
    if (!ymModal.isOpen || !ymModal.promo?.id) return;
    let cancelled = false;
    (async () => {
      setYmOffersLoading(true);
      setYmOffersError(null);
      try {
        const res = await pricesApi.getYmPromoOffers(ymModal.promo.id);
        if (cancelled) return;
        const data = res?.data ?? [];
        setYmOffers(Array.isArray(data) ? data : []);
        if (res?.ok === false) setYmOffersError(res.error || 'Ошибка загрузки товаров');
      } catch (err) {
        if (!cancelled) {
          setYmOffersError(err.response?.data?.error || err.message || 'Ошибка загрузки товаров');
          setYmOffers([]);
        }
      } finally {
        if (!cancelled) setYmOffersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ymModal.isOpen, ymModal.promo?.id, promoReload]);

  const runPromoAction = async (key, fn) => {
    setPromoBusyKey(key);
    setPromoNotice(null);
    try {
      const res = await fn();
      if (res?.ok === false) {
        setPromoNotice({ type: 'error', text: res.error || 'Не удалось выполнить действие' });
      } else {
        const skipped = Array.isArray(res?.blocked) && res.blocked.length ? ` Не вошли: ${res.blocked.length}.` : '';
        setPromoNotice({ type: 'ok', text: res?.notice || `Готово.${skipped}` });
        setPromoReload((n) => n + 1);
      }
    } catch (err) {
      setPromoNotice({
        type: 'error',
        text: err.response?.data?.error || err.message || 'Не удалось выполнить действие',
      });
    } finally {
      setPromoBusyKey('');
    }
  };

  const noticeBox = promoNotice ? (
    <p style={{ color: promoNotice.type === 'error' ? 'var(--danger, #ef4444)' : 'var(--success, #22c55e)', marginBottom: 12 }}>
      {promoNotice.text}
    </p>
  ) : null;

  return (
    <div className="card">
      <h1 className="title">Акции</h1>
      <p className="subtitle">
        Акции маркетплейсов. Вход закрыт, если цена акции ниже минимальной или минимум не посчитан. ·{' '}
        <Link to="/prices" style={{ color: 'var(--primary)' }}>Минимальные цены</Link>
      </p>

      <div className="erp-filter-row promo-mp-tabs" role="tablist" aria-label="Маркетплейс">
        {PROMO_MARKETPLACES.map(({ key, label, shortLabel }) => {
          const active = activePromoMarketplace === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`erp-filter-btn promo-mp-tab promo-mp-tab--${key}${active ? ' promo-mp-tab--active' : ''}`}
              onClick={() => setActivePromoMarketplace(key)}
            >
              <span className={`mp-badge ${key}`}>{shortLabel}</span>
              <span className="erp-filter-btn__label">{label}</span>
            </button>
          );
        })}
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
                    <td title={a.action_type || a.discount_type || undefined}>{ozonActionTypeLabel(a)}</td>
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
                    <td title={a.type || undefined}>{promoTypeLabel(a.type, WB_PROMO_TYPE)}</td>
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
        <div className="prices-table-container" style={{ marginTop: '16px' }}>
          {ymPromosLoading ? (
            <p style={{ color: 'var(--muted)' }}>Загрузка акций Яндекс Маркета...</p>
          ) : ymPromosError ? (
            <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {ymPromosError}</p>
          ) : ymPromos.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>Акций Яндекс Маркета нет</p>
          ) : (
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Начало</th>
                  <th>Окончание</th>
                </tr>
              </thead>
              <tbody>
                {ymPromos.map((a) => (
                  <tr
                    key={a.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setYmModalTab('participating'); setYmModal({ isOpen: true, promo: a }); }}
                    title="Открыть товары акции"
                  >
                    <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{a.id}</td>
                    <td>{a.name || '—'}</td>
                    <td style={{ fontSize: '13px' }}>{a.period?.fromDate ? new Date(a.period.fromDate).toLocaleDateString('ru-RU') : (a.period?.dateTimeFrom ? new Date(a.period.dateTimeFrom).toLocaleDateString('ru-RU') : '—')}</td>
                    <td style={{ fontSize: '13px' }}>{a.period?.toDate ? new Date(a.period.toDate).toLocaleDateString('ru-RU') : (a.period?.dateTimeTo ? new Date(a.period.dateTimeTo).toLocaleDateString('ru-RU') : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
        <p style={{ color: 'var(--muted)', fontSize: '12px', margin: '0 0 10px' }}>
          У товара одна предельная цена: вход по цене акции обновляет её и в разделе «Цены». Если она не выше требуемой цены акции, товар участвует; чтобы выйти — поднимите предельную цену выше этого порога или снимите товар с акции. У эластичного бустинга шкала: чем ниже цена, тем выше процент. Края присылает Ozon, промежуточные цены считаются по прямой между ними.
        </p>
        {noticeBox}
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
                      <th></th>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Минимальная цена из карточки товара">Мин. цена, ₽</th>
                      <th title="Чистая прибыль при продаже по цене входа в акцию. Под цифрой — мин. наценка из карточки">Прибыль, ₽</th>
                      <th>Цена, ₽</th>
                      <th title="У участвующих — текущая цена в акции. У доступных Ozon отдаёт 0 — показываем предлагаемую цену входа">
                        Цена по акции, ₽
                      </th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th title="Для обычных акций — alert_max_action_price. Для эластичного бустинга Ozon отдаёт 0; берём max_action_price / цену мин. бустинга">
                        Предлагаемая цена входа, ₽
                      </th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th title="Чем ниже цена, тем выше бустинг. Края шкалы присылает Ozon, промежуточные цены — по прямой между ними. Справа прибыль при продаже по этой цене">
                        Уровни бустинга
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionProducts.map((p) => (
                      <tr key={p.id} style={p.below_floor || p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td>
                          <button
                            type="button"
                            disabled={promoBusyKey === `ozon-out-${p.id}`}
                            onClick={() => runPromoAction(`ozon-out-${p.id}`, () => pricesApi.leaveOzonAction(actionModal.action.id, [{
                              ozonProductId: p.id,
                              price: p.price,
                              maxActionPrice: p.max_action_price,
                              floor: p.floor ?? p.card_min,
                            }]))}
                            title="Снять с акции. Для бустинга Ozon не даёт исключить товар: предельная цена поднимается до обычной цены"
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {promoBusyKey === `ozon-out-${p.id}` ? '...' : 'Выйти'}
                          </button>
                        </td>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>
                          {p.our_product_id != null ? (
                            <Link
                              to={productCardPath(p.our_product_id)}
                              title="Открыть карточку товара"
                              style={{ color: 'inherit', textDecoration: 'underline' }}
                            >
                              {p.our_product_name || '—'}
                            </Link>
                          ) : (
                            p.our_product_name || '—'
                          )}
                        </td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>
                          {p.our_product_id != null ? (
                            <Link
                              to={productCardPath(p.our_product_id)}
                              title="Открыть карточку товара"
                              style={{ color: 'inherit', textDecoration: 'underline' }}
                            >
                              {p.our_sku ?? p.offer_id ?? '—'}
                            </Link>
                          ) : (
                            p.our_sku ?? p.offer_id ?? '—'
                          )}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td>{minPriceCell(p)}</td>
                        <td>{profitCell(p)}</td>
                        <td>{formatRub(p.price)}</td>
                        <td>{formatRub(p.entry_price ?? ozonDisplayActionPrice(p))}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой, товар может быть исключён' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td title={Number(p.alert_max_action_price) > 0 ? 'alert_max_action_price' : 'Для эластичного бустинга: max_action_price / price_min_elastic'}>
                          {formatRub(ozonSuggestedEntryPrice(p))}
                        </td>
                        <td>{formatRub(p.max_action_price)}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{boostLevelsCell(p, promoBusyKey, (level) => runPromoAction(`ozon-boost-${p.id}-${level.boost}`, () => pricesApi.setOzonActionPrice(actionModal.action.id, [{
                          ozonProductId: p.id,
                          actionPrice: level.price,
                          boost: level.boost,
                          ourProductId: p.our_product_id,
                        }])))}</td>
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
              <p style={{ color: actionCandidatesError.startsWith('Ozon не отдаёт') ? 'var(--muted)' : 'var(--danger, #ef4444)' }}>
                {actionCandidatesError.startsWith('Ozon не отдаёт') ? actionCandidatesError : `⚠️ ${actionCandidatesError}`}
              </p>
            ) : actionCandidates.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>Нет товаров из нашей системы, доступных к добавлению в эту акцию</p>
            ) : (
              <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                <table className="prices-table table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Наш товар</th>
                      <th>Артикул</th>
                      <th>ID Ozon</th>
                      <th title="Минимальная цена из карточки товара">Мин. цена, ₽</th>
                      <th title="Чистая прибыль при продаже по цене входа в акцию. Под цифрой — мин. наценка из карточки">Прибыль, ₽</th>
                      <th>Цена, ₽</th>
                      <th title="У участвующих — текущая цена в акции. У доступных Ozon отдаёт 0 — показываем предлагаемую цену входа">
                        Цена по акции, ₽
                      </th>
                      <th title="Цена выше рекомендуемой">⚠ Превышена</th>
                      <th title="Для обычных акций — alert_max_action_price. Для эластичного бустинга Ozon отдаёт 0; берём max_action_price / цену мин. бустинга">
                        Предлагаемая цена входа, ₽
                      </th>
                      <th>Макс. цена акции, ₽</th>
                      <th>Режим</th>
                      <th>Мин. остаток</th>
                      <th>Остаток</th>
                      <th title="Чем ниже цена, тем выше бустинг. Края шкалы присылает Ozon, промежуточные цены — по прямой между ними. Справа прибыль при продаже по этой цене">
                        Уровни бустинга
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionCandidates.map((p) => (
                      <tr key={p.id} style={p.below_floor || p.alert_max_action_price_failed ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td>
                          <button
                            type="button"
                            disabled={Boolean(p.join_block_reason) || promoBusyKey === `ozon-in-${p.id}`}
                            title={joinTitle(p)}
                            onClick={() => runPromoAction(`ozon-in-${p.id}`, () => pricesApi.joinOzonAction(actionModal.action.id, [{
                              ozonProductId: p.id,
                              actionPrice: p.entry_price ?? ozonDisplayActionPrice(p),
                              ourProductId: p.our_product_id,
                              stock: p.stock,
                            }]))}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {promoBusyKey === `ozon-in-${p.id}` ? '...' : 'Войти'}
                          </button>
                        </td>
                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.our_product_name || ''}>{p.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{p.our_sku ?? p.offer_id ?? '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--muted)' }}>{p.id}</td>
                        <td>{minPriceCell(p)}</td>
                        <td>{profitCell(p)}</td>
                        <td>{formatRub(p.price)}</td>
                        <td>{formatRub(p.entry_price ?? ozonDisplayActionPrice(p))}</td>
                        <td title={p.alert_max_action_price_failed ? 'Цена выше рекомендуемой' : ''}>{p.alert_max_action_price_failed ? '⚠ Да' : '—'}</td>
                        <td title={Number(p.alert_max_action_price) > 0 ? 'alert_max_action_price' : 'Для эластичного бустинга: max_action_price / price_min_elastic'}>
                          {formatRub(ozonSuggestedEntryPrice(p))}
                        </td>
                        <td>{formatRub(p.max_action_price)}</td>
                        <td style={{ fontSize: '12px' }}>{p.add_mode || '—'}</td>
                        <td>{p.min_stock != null ? p.min_stock : '—'}</td>
                        <td>{p.stock != null ? p.stock : '—'}</td>
                        <td>{boostLevelsCell(p, promoBusyKey, (level) => runPromoAction(`ozon-boost-${p.id}-${level.boost}`, () => pricesApi.setOzonActionPrice(actionModal.action.id, [{
                          ozonProductId: p.id,
                          actionPrice: level.price,
                          boost: level.boost,
                          ourProductId: p.our_product_id,
                        }])))}</td>
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
        {noticeBox}
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0 }}>
          Выйти из акции Wildberries через API нельзя: площадка принимает только добавление. Убрать товар можно в кабинете WB. Автоакции список товаров не отдают.
        </p>

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
                    <div title={wbActionDetails.type || undefined}>{promoTypeLabel(wbActionDetails.type, WB_PROMO_TYPE)}</div>
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
                      <th>Товар</th>
                      <th>ID (nm)</th>
                      <th>Мин. цена, ₽</th>
                      <th title="Чистая прибыль при продаже по плановой цене акции. Под цифрой — мин. наценка из карточки">Прибыль, ₽</th>
                      <th>Цена, ₽</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesIn.map((n) => (
                      <tr key={n.id} style={n.below_floor ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td>{n.our_sku || n.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{minPriceCell(n)}</td>
                        <td>{profitCell(n)}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
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
                      <th></th>
                      <th>Товар</th>
                      <th>ID (nm)</th>
                      <th>Мин. цена, ₽</th>
                      <th title="Чистая прибыль при продаже по плановой цене акции. Под цифрой — мин. наценка из карточки">Прибыль, ₽</th>
                      <th>Цена, ₽</th>
                      <th>План. цена, ₽</th>
                      <th>Скидка, %</th>
                      <th>План. скидка, %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wbNomenclaturesOut.map((n) => (
                      <tr key={n.id} style={n.below_floor ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                        <td>
                          <button
                            type="button"
                            disabled={Boolean(n.join_block_reason) || !n.our_product_id || promoBusyKey === `wb-in-${n.id}`}
                            title={n.our_product_id ? joinTitle(n) : 'Товар не найден в каталоге'}
                            onClick={() => runPromoAction(`wb-in-${n.id}`, () => pricesApi.joinWbPromotion(wbActionModal.promotion.id, [{
                              nmId: n.id,
                              planPrice: n.entry_price ?? n.planPrice,
                              ourProductId: n.our_product_id,
                            }]))}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {promoBusyKey === `wb-in-${n.id}` ? '...' : 'Войти'}
                          </button>
                        </td>
                        <td>{n.our_sku || n.our_product_name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--muted)' }}>{n.id}</td>
                        <td>{minPriceCell(n)}</td>
                        <td>{profitCell(n)}</td>
                        <td>{n.price != null ? `${n.price}` : '—'}</td>
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

      <Modal
        isOpen={ymModal.isOpen}
        onClose={() => setYmModal({ isOpen: false, promo: null })}
        title={ymModal.promo ? `Акция Яндекс Маркета: ${ymModal.promo.name || ymModal.promo.id}` : 'Акция Яндекс Маркета'}
        size="xl"
      >
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px' }}>
          <button type="button" onClick={() => setYmModalTab('participating')} style={{ padding: '6px 12px', fontSize: 13 }}>
            Участвующие
          </button>
          <button type="button" onClick={() => setYmModalTab('candidates')} style={{ padding: '6px 12px', fontSize: 13 }}>
            Можно добавить
          </button>
        </div>
        {noticeBox}
        <p style={{ color: 'var(--muted)', fontSize: 12 }}>
          Изменения на Маркете применяются несколько часов.
        </p>
        {ymOffersLoading ? (
          <p style={{ color: 'var(--muted)' }}>Загрузка товаров...</p>
        ) : ymOffersError ? (
          <p style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {ymOffersError}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th></th>
                  <th>Товар</th>
                  <th>Артикул МП</th>
                  <th>Статус</th>
                  <th>Цена, ₽</th>
                  <th>Цена акции, ₽</th>
                  <th>Макс. цена акции, ₽</th>
                  <th>Мин. цена, ₽</th>
                  <th title="Чистая прибыль при продаже по цене входа в акцию. Под цифрой — мин. наценка из карточки">Прибыль, ₽</th>
                </tr>
              </thead>
              <tbody>
                {ymOffers
                  .filter((row) => (ymModalTab === 'participating' ? row.participating : !row.participating))
                  .map((row) => (
                    <tr key={row.offer_id} style={row.below_floor ? { backgroundColor: 'rgba(239,68,68,0.08)' } : undefined}>
                      <td>
                        {row.participating ? (
                          <button
                            type="button"
                            disabled={promoBusyKey === `ym-out-${row.offer_id}`}
                            onClick={() => runPromoAction(`ym-out-${row.offer_id}`, () => pricesApi.leaveYmPromo(ymModal.promo.id, [row.offer_id]))}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {promoBusyKey === `ym-out-${row.offer_id}` ? '...' : 'Выйти'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={Boolean(row.join_block_reason) || promoBusyKey === `ym-in-${row.offer_id}`}
                            title={joinTitle(row)}
                            onClick={() => runPromoAction(`ym-in-${row.offer_id}`, () => pricesApi.joinYmPromo(ymModal.promo.id, [{
                              offerId: row.offer_id,
                              promoPrice: row.max_promo_price ?? row.entry_price,
                            }]))}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {promoBusyKey === `ym-in-${row.offer_id}` ? '...' : 'Войти'}
                          </button>
                        )}
                      </td>
                      <td>{row.our_sku || row.our_product_name || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{row.offer_id}</td>
                      <td>{YM_STATUS[row.status] || row.status || '—'}</td>
                      <td>{formatRub(row.price)}</td>
                      <td>{formatRub(row.promo_price)}</td>
                      <td>{formatRub(row.max_promo_price)}</td>
                      <td>{minPriceCell(row)}</td>
                      <td>{profitCell(row)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

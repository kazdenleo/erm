/**
 * Контент-рейтинг карточки маркетплейса (Ozon / YM). WB — оценка через API недоступна.
 */

import React from 'react';
import './MarketplaceCardQualityPanel.css';

const YM_CARD_STATUS = {
  HAS_CARD_CAN_NOT_UPDATE: 'Карточка Маркета',
  HAS_CARD_CAN_UPDATE: 'Можно дополнить',
  HAS_CARD_CAN_UPDATE_ERRORS: 'Изменения не приняты',
  HAS_CARD_CAN_UPDATE_PROCESSING: 'Изменения на проверке',
  NO_CARD_NEED_CONTENT: 'Создайте карточку',
  NO_CARD_MARKET_WILL_CREATE: 'Создаст Маркет',
  NO_CARD_ERRORS: 'Не создана из-за ошибки',
  NO_CARD_PROCESSING: 'Проверяем данные',
  NO_CARD_ADD_TO_CAMPAIGN: 'Разместите товар в магазине',
};

function scoreTone(score) {
  if (!Number.isFinite(Number(score))) return 'muted';
  const n = Number(score);
  if (n >= 80) return 'good';
  if (n >= 50) return 'mid';
  return 'bad';
}

function formatFetchedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function compactScore(rating, marketplace) {
  if (marketplace === 'wb' || rating?.unavailable) return { text: 'нет API', tone: 'muted' };
  const score = Number(rating?.score);
  if (!Number.isFinite(score)) return { text: 'нет данных', tone: 'muted' };
  const max = Number.isFinite(Number(rating?.max)) ? Number(rating.max) : 100;
  return { text: `${Math.round(score)}/${max}`, tone: scoreTone(score), pct: Math.max(0, Math.min(100, (score / max) * 100)) };
}

/** Компактные оценки OZ / WB / YM на вкладке «Основное». */
export function ProductMainQualityBlock({ ratings = {} }) {
  const rows = [
    { mp: 'ozon', label: 'Ozon', rating: ratings.ozon },
    { mp: 'wb', label: 'WB', rating: ratings.wb },
    { mp: 'ym', label: 'Я.Маркет', rating: ratings.ym },
  ];
  return (
    <div className="product-main-quality">
      {rows.map((row) => {
        const s = compactScore(row.rating, row.mp);
        return (
          <div key={row.mp} className="product-main-quality__row">
            <span className={`mp-badge ${row.mp}`}>{row.mp === 'ozon' ? 'OZ' : row.mp === 'wb' ? 'WB' : 'ЯМ'}</span>
            <span className="product-main-quality__name">{row.label}</span>
            <span className={`product-main-quality__score product-main-quality__score--${s.tone}`}>{s.text}</span>
            {s.pct != null ? (
              <span className="product-main-quality__bar" aria-hidden>
                <span style={{ width: `${s.pct}%` }} />
              </span>
            ) : (
              <span className="product-main-quality__bar product-main-quality__bar--empty" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MarketplaceCardQualityPanel({ marketplace, rating }) {
  const mp = String(marketplace || '').toLowerCase();
  const unavailable = rating?.unavailable === true || mp === 'wb';
  const score = Number(rating?.score);
  const hasScore = Number.isFinite(score);
  const max = Number.isFinite(Number(rating?.max)) ? Number(rating.max) : 100;
  const tone = scoreTone(score);
  const fetched = formatFetchedAt(rating?.fetched_at || rating?.fetchedAt);
  const groups = Array.isArray(rating?.groups) ? rating.groups.filter((g) => g?.name || g?.rating != null) : [];
  const recs = Array.isArray(rating?.recommendations)
    ? rating.recommendations.map((r) => (typeof r === 'string' ? r : r?.text)).filter(Boolean)
    : [];
  const cardStatus = rating?.card_status || rating?.cardStatus || null;
  const statusLabel = cardStatus ? YM_CARD_STATUS[cardStatus] || cardStatus : null;

  if (unavailable || mp === 'wb') {
    return (
      <div className="mp-card-quality mp-card-quality--unavailable">
        <div className="mp-card-quality__title">Качество карточки</div>
        <p className="mp-card-quality__hint">
          Wildberries не отдаёт оценку качества карточки через API. В кабинете WB рейтинг карточки
          можно посмотреть вручную.
        </p>
      </div>
    );
  }

  if (!rating || (!hasScore && recs.length === 0 && !statusLabel)) {
    return (
      <div className="mp-card-quality mp-card-quality--empty">
        <div className="mp-card-quality__title">Качество карточки</div>
        <p className="mp-card-quality__hint">
          Нажмите «Обновить данные», чтобы загрузить оценку с маркетплейса.
        </p>
      </div>
    );
  }

  const pct = hasScore ? Math.max(0, Math.min(100, (score / max) * 100)) : 0;

  return (
    <div className={`mp-card-quality mp-card-quality--${tone}`}>
      <div className="mp-card-quality__head">
        <div className="mp-card-quality__title">Качество карточки</div>
        {hasScore ? (
          <div className={`mp-card-quality__score mp-card-quality__score--${tone}`}>
            {Math.round(score * 10) / 10}
            <span className="mp-card-quality__score-max"> / {max}</span>
          </div>
        ) : (
          <div className="mp-card-quality__score mp-card-quality__score--muted">нет балла</div>
        )}
      </div>
      {hasScore ? (
        <div className="mp-card-quality__bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="mp-card-quality__meta">
        {statusLabel ? <span>Статус: {statusLabel}</span> : null}
        {fetched ? <span>Обновлено {fetched}</span> : null}
      </div>
      {groups.length > 0 ? (
        <ul className="mp-card-quality__groups">
          {groups.map((g, i) => (
            <li key={g.key || `${g.name}-${i}`}>
              <span>{g.name || g.key || 'Группа'}</span>
              {g.rating != null ? <strong>{Math.round(Number(g.rating))}</strong> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {recs.length > 0 ? (
        <div className="mp-card-quality__recs">
          <div className="mp-card-quality__recs-title">Что улучшить</div>
          <ul>
            {recs.slice(0, 8).map((text, i) => (
              <li key={`${text}-${i}`}>{text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

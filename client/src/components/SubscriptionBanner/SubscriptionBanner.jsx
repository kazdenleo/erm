import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

function formatRuDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

export function SubscriptionBanner() {
  const { user, isAdmin } = useAuth();
  const sub = user?.profile?.subscription;

  const view = useMemo(() => {
    if (isAdmin || !sub) return null;
    if (sub.status === 'trial' && sub.trialEndsAt) {
      const end = new Date(sub.trialEndsAt).getTime();
      const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / 86400000));
      return {
        tone: 'info',
        text: `Пробный период: осталось ≈ ${daysLeft} дн. (до ${formatRuDate(sub.trialEndsAt)}). Тариф после trial — на странице тарифов.`,
      };
    }
    if (sub.status === 'past_due' || sub.writeAllowed === false) {
      return {
        tone: 'warn',
        text: 'Пробный период или подписка закончились. Можно смотреть данные; изменения — после выбора тарифа на странице тарифов (онлайн или заявка).',
      };
    }
    if (sub.status === 'suspended') {
      return {
        tone: 'danger',
        text: 'Аккаунт приостановлен. Обратитесь в поддержку.',
      };
    }
    return null;
  }, [sub, isAdmin]);

  if (!view) return null;

  const bg =
    view.tone === 'danger' ? '#fef2f2' : view.tone === 'warn' ? '#fffbeb' : '#eff6ff';
  const border =
    view.tone === 'danger' ? '#fecaca' : view.tone === 'warn' ? '#fde68a' : '#bfdbfe';
  const color =
    view.tone === 'danger' ? '#991b1b' : view.tone === 'warn' ? '#92400e' : '#1e3a8a';

  return (
    <div
      role="status"
      style={{
        margin: '0 0 12px',
        padding: '10px 14px',
        borderRadius: 8,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 13,
        lineHeight: 1.45,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span>{view.text}</span>
      <span style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        <Link to="/pricing" style={{ color: 'inherit', fontWeight: 600 }}>
          Тарифы
        </Link>
        <Link to="/support" style={{ color: 'inherit', fontWeight: 600 }}>
          Поддержка
        </Link>
        <Link to="/offer" style={{ color: 'inherit' }}>
          Оферта
        </Link>
      </span>
    </div>
  );
}

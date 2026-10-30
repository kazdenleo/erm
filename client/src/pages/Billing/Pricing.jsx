import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../../components/common/Button/Button';

export function Pricing() {
  const { isAuthenticated, user, refreshUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightPlan = String(searchParams.get('plan') || '').trim().toLowerCase();
  const [data, setData] = useState(null);
  const [usage, setUsage] = useState(null);
  const [myRequests, setMyRequests] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');

  const sub = user?.profile?.subscription;
  const online = !!data?.onlinePaymentsEnabled;

  const loadPlans = useCallback(() => {
    setLoading(true);
    setError('');
    return api
      .get('/billing/plans')
      .then((res) => setData(res.data?.data ?? null))
      .catch((e) => setError(e?.response?.data?.message || e.message || 'Ошибка'))
      .finally(() => setLoading(false));
  }, []);

  const loadMyRequests = useCallback(() => {
    if (!isAuthenticated) {
      setMyRequests([]);
      return Promise.resolve();
    }
    return api
      .get('/billing/requests/mine')
      .then((res) => setMyRequests(res.data?.data || []))
      .catch(() => setMyRequests([]));
  }, [isAuthenticated]);

  const loadUsage = useCallback(() => {
    if (!isAuthenticated) {
      setUsage(null);
      return Promise.resolve();
    }
    return api
      .get('/billing/usage')
      .then((res) => setUsage(res.data?.data ?? null))
      .catch(() => setUsage(null));
  }, [isAuthenticated]);

  useEffect(() => {
    loadPlans();
    loadMyRequests();
    loadUsage();
  }, [loadPlans, loadMyRequests, loadUsage]);

  useEffect(() => {
    if (!isAuthenticated || searchParams.get('paid') !== '1') return;
    let cancelled = false;
    (async () => {
      setInfo('Проверяем оплату…');
      try {
        const res = await api.post('/billing/payments/sync');
        if (cancelled) return;
        if (res.data?.data?.synced) {
          setInfo('Оплата прошла — тариф активирован.');
          if (typeof refreshUser === 'function') await refreshUser();
        } else {
          setInfo(
            'Если оплата уже прошла, статус обновится через несколько секунд. Можно обновить страницу.'
          );
        }
        await loadMyRequests();
        await loadUsage();
      } catch {
        if (!cancelled) setInfo('Не удалось сверить оплату автоматически — обновите страницу позже.');
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams);
          next.delete('paid');
          setSearchParams(next, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, searchParams, setSearchParams, loadMyRequests, loadUsage, refreshUser]);

  const pending = myRequests.find((r) => r.status === 'pending');

  const requestPlan = async (planCode, period) => {
    setInfo('');
    setError('');
    if (!isAuthenticated) {
      window.location.href = `/register?plan=${encodeURIComponent(planCode)}`;
      return;
    }
    const key = `req:${planCode}:${period}`;
    setBusyKey(key);
    try {
      const res = await api.post('/billing/requests', { planCode, period });
      setInfo(res.data?.message || 'Заявка отправлена');
      await loadMyRequests();
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Не удалось создать заявку');
      await loadMyRequests();
    } finally {
      setBusyKey('');
    }
  };

  const payOnline = async (planCode, period) => {
    setInfo('');
    setError('');
    if (!isAuthenticated) {
      window.location.href = `/register?plan=${encodeURIComponent(planCode)}`;
      return;
    }
    const key = `pay:${planCode}:${period}`;
    setBusyKey(key);
    try {
      const res = await api.post('/billing/checkout', { planCode, period });
      const url = res.data?.confirmationUrl || res.data?.data?.confirmationUrl;
      if (url) {
        window.location.href = url;
        return;
      }
      setError('Не получена ссылка на оплату');
      await loadMyRequests();
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Ошибка оплаты');
      await loadMyRequests();
    } finally {
      setBusyKey('');
    }
  };

  const cancelPending = async () => {
    setBusyKey('cancel');
    setError('');
    setInfo('');
    try {
      const res = await api.post('/billing/requests/cancel');
      setInfo(res.data?.message || 'Отменено');
      await loadMyRequests();
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Ошибка отмены');
    } finally {
      setBusyKey('');
    }
  };

  const formatLimit = (used, max) => {
    if (max == null) return `${used} / ∞`;
    return `${used} / ${max}`;
  };

  return (
    <div
      className={isAuthenticated ? 'card' : 'login-page'}
      style={isAuthenticated ? { padding: 20 } : undefined}
    >
      <div
        className={isAuthenticated ? undefined : 'login-card card'}
        style={isAuthenticated ? undefined : { maxWidth: 960, width: '100%', padding: 24 }}
      >
      <h1 className="title">Тарифы</h1>
      <p className="subtitle text-muted">
        Пробный период — {data?.trialDays ?? 7} дней. {data?.paymentNote || ''}
      </p>
      {!isAuthenticated ? (
        <p className="small mb-2">
          <Link to="/register">Регистрация</Link>
          {' · '}
          <Link to="/login">Вход</Link>
          {' · '}
          <Link to="/">На главную</Link>
        </p>
      ) : null}
      {sub ? (
        <p className="small mb-2">
          Сейчас:{' '}
          <strong>
            {sub.planName || sub.effectivePlanCode || '—'} ({sub.status})
          </strong>
          {sub.trialEndsAt ? (
            <>
              {' '}
              · trial до {new Date(sub.trialEndsAt).toLocaleString('ru-RU')}
            </>
          ) : null}
          {sub.subscriptionEndsAt ? (
            <>
              {' '}
              · оплачено до {new Date(sub.subscriptionEndsAt).toLocaleString('ru-RU')}
            </>
          ) : null}
        </p>
      ) : null}
      {usage?.usage && usage?.plan ? (
        <p className="small text-muted mb-2">
          Использование: пользователи {formatLimit(usage.usage.users, usage.plan.maxUsers)}, орг.{' '}
          {formatLimit(usage.usage.organizations, usage.plan.maxOrganizations)}, кабинеты МП{' '}
          {formatLimit(usage.usage.cabinets, usage.plan.maxMpCabinets)}, товары{' '}
          {formatLimit(usage.usage.products, usage.plan.maxProducts)}
        </p>
      ) : null}
      {pending ? (
        <div
          className="alert alert-info py-2 px-3 mb-3"
          style={{ background: 'rgba(59,130,246,0.08)', borderRadius: 8 }}
        >
          Открытая заявка: <strong>{pending.planName}</strong> (
          {pending.period === 'year' ? 'год' : 'месяц'}
          {pending.amountRub != null
            ? `, ${Number(pending.amountRub).toLocaleString('ru-RU')} ₽`
            : ''}
          )
          {pending.paymentProvider === 'yookassa' ? ' · онлайн-оплата' : ' · счёт / перевод'}.
          {pending.confirmationUrl ? (
            <>
              {' '}
              <a href={pending.confirmationUrl}>Продолжить оплату</a>
            </>
          ) : null}{' '}
          <Button
            type="button"
            variant="secondary"
            disabled={busyKey === 'cancel'}
            onClick={cancelPending}
          >
            Отменить заявку
          </Button>
        </div>
      ) : null}
      {loading ? <p className="text-muted">Загрузка…</p> : null}
      {error ? <p className="text-danger">{error}</p> : null}
      {info ? <p className="text-success">{info}</p> : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
        {(data?.plans || []).map((p) => (
          <div
            key={p.code}
            className="border rounded p-3"
            style={{
              borderColor:
                highlightPlan === p.code || p.highlighted ? '#3b82f6' : undefined,
              boxShadow:
                highlightPlan === p.code || p.highlighted ? '0 0 0 1px #3b82f6' : undefined,
            }}
          >
            {p.highlighted ? (
              <div className="badge bg-primary mb-2">Популярный</div>
            ) : null}
            <h2 style={{ fontSize: '1.15rem' }}>{p.name}</h2>
            <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
              {Number(p.priceMonthRub).toLocaleString('ru-RU')} ₽
              <span className="text-muted" style={{ fontSize: 14, fontWeight: 400 }}>
                {' '}
                / мес
              </span>
            </div>
            {p.priceYearRub ? (
              <div className="text-muted small mb-2">
                Год: {Number(p.priceYearRub).toLocaleString('ru-RU')} ₽
              </div>
            ) : null}
            <p className="small">{p.blurb}</p>
            <ul className="small mb-3" style={{ paddingLeft: 18 }}>
              {(p.featureLabels || []).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <div className="d-flex flex-column gap-2">
              {online ? (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={!!pending || !!busyKey}
                    onClick={() => payOnline(p.code, 'month')}
                  >
                {busyKey === `pay:${p.code}:month`
                  ? 'Переход…'
                  : isAuthenticated
                    ? 'Оплатить месяц'
                    : 'Начать — месяц'}
              </Button>
                  {p.priceYearRub ? (
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!!pending || !!busyKey}
                      onClick={() => payOnline(p.code, 'year')}
                    >
                      {busyKey === `pay:${p.code}:year`
                        ? 'Переход…'
                        : isAuthenticated
                          ? 'Оплатить год'
                          : 'Начать — год'}
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button
                type="button"
                variant={online ? 'secondary' : 'primary'}
                disabled={!!pending || !!busyKey}
                onClick={() => requestPlan(p.code, 'month')}
              >
                {busyKey === `req:${p.code}:month`
                  ? 'Отправка…'
                  : !isAuthenticated
                    ? 'Регистрация'
                    : online
                      ? 'Заявка на месяц (счёт)'
                      : 'Заявка на месяц'}
              </Button>
              {p.priceYearRub && isAuthenticated ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!!pending || !!busyKey}
                  onClick={() => requestPlan(p.code, 'year')}
                >
                  {busyKey === `req:${p.code}:year`
                    ? 'Отправка…'
                    : online
                      ? 'Заявка на год (счёт)'
                      : 'Заявка на год'}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="d-flex flex-wrap gap-2 mt-4">
        {isAuthenticated ? (
          <Link to="/support">
            <Button type="button" variant="secondary">
              Поддержка
            </Button>
          </Link>
        ) : (
          <Link to="/register">
            <Button type="button" variant="primary">
              Регистрация — 7 дней бесплатно
            </Button>
          </Link>
        )}
        <Link to="/offer" className="btn btn-link">
          Оферта
        </Link>
        <Link to="/privacy" className="btn btn-link">
          Конфиденциальность
        </Link>
      </div>
      </div>
    </div>
  );
}

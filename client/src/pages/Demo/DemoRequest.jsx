/**
 * Заявка на бесплатный демо-доступ: кабинет создаётся сразу, доступ на почту.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api.js';
import { Button } from '../../components/common/Button/Button';
import { BrandLogo } from '../../components/brand/BrandLogo.jsx';
import '../Login/Login.css';
import './DemoRequest.css';

export function DemoRequest() {
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [acceptOffer, setAcceptOffer] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [enabled, setEnabled] = useState(null);
  const [trialDays, setTrialDays] = useState(7);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/config');
        const data = res?.data?.data || res?.data || {};
        if (cancelled) return;
        setEnabled(data.demoRequestEnabled !== false);
        setTrialDays(Number(data.demoTrialDays) || 7);
        setTurnstileSiteKey(String(data.turnstileSiteKey || '').trim());
      } catch {
        if (!cancelled) setEnabled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey || !enabled) return undefined;
    const w = window;
    if (w.turnstile) {
      try {
        w.turnstile.render('#erm-demo-turnstile', {
          sitekey: turnstileSiteKey,
          callback: (token) => setTurnstileToken(token || ''),
        });
      } catch {
        /* ignore */
      }
      return undefined;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      try {
        window.turnstile?.render('#erm-demo-turnstile', {
          sitekey: turnstileSiteKey,
          callback: (token) => setTurnstileToken(token || ''),
        });
      } catch {
        /* ignore */
      }
    };
    document.body.appendChild(script);
    return () => {
      try {
        script.remove();
      } catch {
        /* ignore */
      }
    };
  }, [turnstileSiteKey, enabled]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!enabled) {
      setError('Заявки на демо временно закрыты.');
      return;
    }
    if (!acceptOffer) {
      setError('Нужно принять оферту и политику конфиденциальности');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/demo/request', {
        companyName,
        fullName,
        email,
        phone,
        acceptOffer: true,
        turnstileToken: turnstileToken || undefined,
        website,
      });
      const data = res?.data?.data || null;
      setResult({
        message: res?.data?.message || 'Демо создано',
        ...data,
      });
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось создать демо');
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="login-page">
        <div className="login-card card">
          <div className="login-brand">
            <BrandLogo height={36} />
          </div>
          <h1 className="login-title">Демо готово</h1>
          <p className="login-lead">{result.message}</p>
          <div className="login-form" style={{ gap: 8 }}>
            <p>
              <strong>Кабинет:</strong> {result.accountName}
            </p>
            <p>
              <strong>Вход:</strong>{' '}
              <a href={result.loginUrl || '/login'}>{result.loginUrl || '/login'}</a>
            </p>
            <p>
              <strong>Логин (телефон):</strong> {result.phone}
            </p>
            {result.temporaryPassword ? (
              <p>
                <strong>Временный пароль:</strong> {result.temporaryPassword}
              </p>
            ) : (
              <p>Пароль отправлен на {result.email}</p>
            )}
            <p className="text-muted" style={{ fontSize: 13 }}>
              Срок {result.trialDays || trialDays} дней · до 50 товаров · примеры{' '}
              {result.sampleSku || 'DEMO-001'} и DEMO-002. На главной — чеклист; при входе смените
              пароль.
            </p>
            <Link className="btn btn-primary" to="/login">
              Войти в кабинет
            </Link>
            <Link className="btn btn-secondary" to="/">
              На главную
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card card">
        <div className="login-brand">
          <BrandLogo height={36} />
        </div>
        <h1 className="login-title">Бесплатный демо-доступ</h1>
        <p className="login-lead">
          Создадим кабинет за минуту: организация, склад, два демо-товара с ценами, доступ на{' '}
          {trialDays} дней. Данные придут на email.
        </p>

        <div className="demo-walkthrough" aria-label="Что увидите в демо">
          <div className="demo-walkthrough-title">Что увидите</div>
          <ol className="demo-walkthrough-list">
            <li>
              <strong>Каталог</strong> — DEMO-001 и DEMO-002 с себестоимостью и остатком на складе
            </li>
            <li>
              <strong>Цены</strong> — минимальные цены и витрина по Ozon / WB / Я.Маркету
            </li>
            <li>
              <strong>Интеграции</strong> — подключение API кабинетов маркетплейсов
            </li>
            <li>
              <strong>Аналитика</strong> — юнит-экономика, РНП и сверка после загрузки данных
            </li>
          </ol>
          <p className="demo-walkthrough-note">
            На главной — чеклист первых шагов; за 1–2 дня до конца пришлём напоминание. Демо можно
            один раз продлить на 3 дня.
          </p>
        </div>

        {enabled === false ? (
          <p className="login-error">Заявки на демо временно закрыты. Напишите нам с лендинга.</p>
        ) : (
          <form className="login-form" onSubmit={handleSubmit}>
            <label>
              Компания / магазин
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                required
                minLength={2}
                autoComplete="organization"
              />
            </label>
            <label>
              ФИО
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                minLength={2}
                autoComplete="name"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label>
              Телефон (логин)
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoComplete="tel"
                placeholder="+7..."
              />
            </label>
            {/* honeypot */}
            <input
              type="text"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0 }}
              aria-hidden="true"
            />
            {turnstileSiteKey ? <div id="erm-demo-turnstile" style={{ margin: '8px 0' }} /> : null}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={acceptOffer}
                onChange={(e) => setAcceptOffer(e.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span>
                Принимаю{' '}
                <Link to="/offer" target="_blank">
                  оферту
                </Link>{' '}
                и{' '}
                <Link to="/privacy" target="_blank">
                  политику
                </Link>
              </span>
            </label>
            {error ? <div className="login-error">{error}</div> : null}
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Создаём кабинет…' : 'Получить демо'}
            </Button>
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              Уже есть аккаунт? <Link to="/login">Войти</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

export default DemoRequest;

/**
 * Публичные страницы оферты и политики конфиденциальности.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api.js';
import '../Login/Login.css';

export function LegalDocument({ kind }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const path = kind === 'privacy' ? '/billing/legal/privacy' : '/billing/legal/offer';
    setLoading(true);
    setError('');
    api
      .get(path)
      .then((res) => {
        if (cancelled) return;
        setDoc(res.data?.data ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.message || e.message || 'Не удалось загрузить документ');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return (
    <div className="login-page" style={{ alignItems: 'flex-start', paddingTop: 48, paddingBottom: 48 }}>
      <div className="login-card card" style={{ maxWidth: 720, width: '100%' }}>
        <p className="login-subtitle" style={{ marginBottom: 8 }}>
          <Link to="/">← На главную</Link>
          {' · '}
          <Link to="/register">Регистрация</Link>
          {' · '}
          <Link to={kind === 'privacy' ? '/offer' : '/privacy'}>
            {kind === 'privacy' ? 'Оферта' : 'Конфиденциальность'}
          </Link>
        </p>
        {loading ? <p className="text-muted">Загрузка…</p> : null}
        {error ? <div className="login-error">{error}</div> : null}
        {doc ? (
          <>
            <h1 className="login-title" style={{ fontSize: '1.5rem' }}>
              {doc.title}
            </h1>
            {doc.revisedAt ? (
              <p className="text-muted small">Редакция от {doc.revisedAt}</p>
            ) : null}
            {doc.disclaimer ? (
              <p className="text-muted small" style={{ fontStyle: 'italic' }}>
                {doc.disclaimer}
              </p>
            ) : null}
            {(doc.sections || []).map((s) => (
              <section key={s.heading} style={{ marginTop: 20 }}>
                <h2 style={{ fontSize: '1.05rem', marginBottom: 8 }}>{s.heading}</h2>
                <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, margin: 0 }}>{s.body}</p>
              </section>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function OfferPage() {
  return <LegalDocument kind="offer" />;
}

export function PrivacyPage() {
  return <LegalDocument kind="privacy" />;
}

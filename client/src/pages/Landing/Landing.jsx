/**
 * Публичный продающий сайт — светлая версия исходного дизайна лендинга.
 * Контент — в landingContent.js.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../../components/brand/BrandLogo.jsx';
import { LANDING as C } from './landingContent.js';
import './Landing.css';

function useScrollNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return scrolled;
}

function useReveal() {
  const rootRef = useRef(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;
    const nodes = root.querySelectorAll('.ld-reveal');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add('is-in');
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
  return rootRef;
}

function planCtaTo(planId) {
  const code = String(planId || '').trim();
  return code ? `/pricing?plan=${encodeURIComponent(code)}` : '/pricing';
}

export function Landing() {
  const scrolled = useScrollNav();
  const rootRef = useReveal();
  const [openFeatureId, setOpenFeatureId] = useState(null);
  const [legalParty, setLegalParty] = useState(null);
  const [promo, setPromo] = useState(null);
  const [trialDays, setTrialDays] = useState(14);
  const year = new Date().getFullYear();
  const openFeature = C.features.find((f) => f.id === openFeatureId) || null;
  const legal = {
    company: legalParty?.company || C.legal.company,
    inn: legalParty?.inn || C.legal.inn,
    ogrn: legalParty?.ogrn || C.legal.ogrn,
    address: legalParty?.address || C.legal.address,
    domain: legalParty?.domain || C.legal.domain,
  };
  const contacts = (() => {
    if (!legalParty?.configured) return C.contacts;
    const list = [];
    if (legalParty.email) {
      list.push({
        label: 'Email',
        value: legalParty.email,
        href: `mailto:${legalParty.email}`,
      });
    }
    if (legalParty.telegram) {
      const handle = String(legalParty.telegram).replace(/^@/, '');
      list.push({
        label: 'Telegram',
        value: legalParty.telegram.startsWith('@')
          ? legalParty.telegram
          : `@${handle}`,
        href: `https://t.me/${handle}`,
      });
    }
    return list.length ? list : C.contacts;
  })();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [legalRes, promoRes] = await Promise.all([
          fetch('/api/billing/legal/offer'),
          fetch('/api/billing/promo'),
        ]);
        const legalJson = await legalRes.json();
        const promoJson = await promoRes.json();
        const party = legalJson?.data?.party;
        if (!cancelled && party && typeof party === 'object') {
          setLegalParty(party);
        }
        if (!cancelled && promoJson?.ok && promoJson.data) {
          if (typeof promoJson.data.trialDays === 'number') {
            setTrialDays(promoJson.data.trialDays);
          }
          if (promoJson.data.promo && typeof promoJson.data.promo === 'object') {
            setPromo(promoJson.data.promo);
          }
        }
      } catch {
        /* лендинг остаётся на статическом fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!openFeatureId) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenFeatureId(null);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [openFeatureId]);

  return (
    <div className="landing" ref={rootRef}>
      <header className={`landing-nav${scrolled ? ' is-scrolled' : ''}`}>
        <div className="landing-shell landing-nav__inner">
          <a className="landing-brand" href="#top" aria-label={C.brand}>
            <BrandLogo height={32} />
            {C.brandNote ? <span className="landing-brand__note">{C.brandNote}</span> : null}
          </a>
          <nav className="landing-nav__links" aria-label="Разделы">
            <a href="#features">Возможности</a>
            <a href="#integrations">Интеграции</a>
            <a href="#pricing">Тарифы</a>
            <a href="#contacts">Контакты</a>
          </nav>
          <div className="landing-nav__actions">
            <Link className="ld-btn ld-btn--ghost" to={C.ctaSecondary.to}>
              {C.ctaSecondary.label}
            </Link>
            <Link className="ld-btn ld-btn--primary" to={C.ctaPrimary.to}>
              {C.ctaPrimary.label}
            </Link>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero">
          <div className="landing-hero__bg" aria-hidden="true">
            <div className="landing-hero__grid" />
            <div className="landing-hero__orb" />
          </div>
          <div className="landing-shell landing-hero__content">
            <h1 className="landing-hero__brand">{C.brand}</h1>
            <p className="landing-hero__headline">{C.tagline}</p>
            <p className="landing-hero__support">{C.heroSupport}</p>
            {promo ? (
              <div
                className={`landing-promo${promo.active ? '' : ' landing-promo--ended'}`}
                role="status"
              >
                <div className="landing-promo__top">
                  <span className="landing-promo__badge">{C.promo.badge}</span>
                  <strong className="landing-promo__title">
                    {promo.title || C.promo.title}
                  </strong>
                </div>
                <p className="landing-promo__lead">
                  {promo.active
                    ? C.promo.lead
                    : 'Места по акции закончились. Доступен обычный пробный период.'}{' '}
                  Пробный период — {trialDays} дней.
                </p>
                <div className="landing-promo__seats">
                  <span className="landing-promo__seats-label">{C.promo.seatsLabel}</span>
                  <span className="landing-promo__seats-value">
                    {typeof promo.seatsLeft === 'number'
                      ? promo.seatsLeft
                      : C.promo.seatsFallback}
                  </span>
                </div>
              </div>
            ) : null}
            <div className="landing-hero__cta">
              <Link
                className="ld-btn ld-btn--primary ld-btn--lg"
                to={promo?.active ? C.promo.ctaTo : C.ctaPrimary.to}
              >
                {promo?.active ? C.promo.cta : C.ctaPrimary.label}
              </Link>
              <Link className="ld-btn ld-btn--ghost ld-btn--lg" to={C.ctaSecondary.to}>
                {C.ctaSecondary.label}
              </Link>
            </div>
          </div>
        </section>

        <section className="landing-section" id="features">
          <div className="landing-shell">
            <div className="landing-section__head ld-reveal">
              <h2 className="landing-section__title">{C.featuresTitle}</h2>
              <p className="landing-section__lead">{C.featuresLead}</p>
            </div>
            <div className="landing-features">
              {C.features.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="landing-feature ld-reveal"
                  onClick={() => setOpenFeatureId(f.id)}
                  aria-haspopup="dialog"
                  aria-expanded={openFeatureId === f.id}
                >
                  <span className="landing-feature__title">{f.title}</span>
                  <span className="landing-feature__text">{f.text}</span>
                  <span className="landing-feature__more">Подробнее →</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section" id="integrations">
          <div className="landing-shell">
            <div className="landing-section__head ld-reveal">
              <h2 className="landing-section__title">{C.integrationsTitle}</h2>
              <p className="landing-section__lead">{C.integrationsLead}</p>
            </div>
            <div className="landing-integrations ld-reveal">
              {C.integrations.map((item) => (
                <span
                  key={item.name}
                  className={`landing-chip${item.status === 'soon' ? ' landing-chip--soon' : ''}`}
                >
                  <span className="landing-chip__dot" aria-hidden="true" />
                  {item.name}
                  {item.status === 'soon' && (
                    <span className="landing-chip__soon">скоро</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section" id="pricing">
          <div className="landing-shell">
            <div className="landing-section__head ld-reveal">
              <h2 className="landing-section__title">{C.pricingTitle}</h2>
              <p className="landing-section__lead">{C.pricingLead}</p>
            </div>
            <div className="landing-plans">
              {C.plans.map((plan) => {
                const to = planCtaTo(plan.id);
                const isHash = to.startsWith('#');
                return (
                  <article
                    key={plan.id}
                    className={`landing-plan ld-reveal${plan.highlighted ? ' landing-plan--hot' : ''}`}
                  >
                    {plan.highlighted && (
                      <span className="landing-plan__badge">Популярный</span>
                    )}
                    <h3 className="landing-plan__name">{plan.name}</h3>
                    <p className="landing-plan__blurb">{plan.blurb}</p>
                    <p className="landing-plan__price">
                      {plan.price}
                      {plan.period ? (
                        <span className="landing-plan__period">{plan.period}</span>
                      ) : null}
                    </p>
                    <ul className="landing-plan__list">
                      {plan.features.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    {isHash ? (
                      <a className="ld-btn ld-btn--ghost ld-btn--on-plan" href={to}>
                        {plan.cta}
                      </a>
                    ) : (
                      <Link
                        className={`ld-btn ld-btn--on-plan ${
                          plan.highlighted ? 'ld-btn--primary' : 'ld-btn--ghost'
                        }`}
                        to={to}
                      >
                        {plan.cta}
                      </Link>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="landing-section" id="how">
          <div className="landing-shell">
            <div className="landing-section__head ld-reveal">
              <h2 className="landing-section__title">{C.howTitle}</h2>
            </div>
            <div className="landing-how">
              {C.howSteps.map((step) => (
                <div key={step.title} className="landing-how__step ld-reveal">
                  <h3 className="landing-how__title">{step.title}</h3>
                  <p className="landing-how__text">{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section" id="contacts">
          <div className="landing-shell">
            <div className="landing-section__head ld-reveal">
              <h2 className="landing-section__title">{C.contactsTitle}</h2>
              <p className="landing-section__lead">
                {legalParty?.configured
                  ? 'Свяжитесь с нами — ответим по делу.'
                  : C.contactsLead}
              </p>
            </div>
            <div className="landing-contacts ld-reveal">
              {contacts.map((row) => (
                <div key={row.label} className="landing-contact-row">
                  <span className="landing-contact-row__label">{row.label}</span>
                  <a className="landing-contact-row__value" href={row.href}>
                    {row.value}
                  </a>
                </div>
              ))}
              <p className="landing-contacts__note">{C.contactsNote}</p>
            </div>
          </div>
        </section>
      </main>

      {openFeature ? (
        <div
          className="landing-modal"
          role="presentation"
          onClick={() => setOpenFeatureId(null)}
        >
          <div
            className="landing-modal__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`landing-feature-${openFeature.id}-title`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="landing-modal__head">
              <h3
                id={`landing-feature-${openFeature.id}-title`}
                className="landing-modal__title"
              >
                {openFeature.title}
              </h3>
              <button
                type="button"
                className="landing-modal__close"
                onClick={() => setOpenFeatureId(null)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <p className="landing-modal__lead">{openFeature.detailLead}</p>
            {(openFeature.detailBody || []).map((p) => (
              <p key={p.slice(0, 48)} className="landing-modal__p">
                {p}
              </p>
            ))}
            {Array.isArray(openFeature.bullets) && openFeature.bullets.length > 0 ? (
              <ul className="landing-modal__list">
                {openFeature.bullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            <div className="landing-modal__actions">
              <Link
                className="ld-btn ld-btn--primary"
                to={C.ctaPrimary.to}
                onClick={() => setOpenFeatureId(null)}
              >
                {C.ctaPrimary.label}
              </Link>
              <button
                type="button"
                className="ld-btn ld-btn--ghost"
                onClick={() => setOpenFeatureId(null)}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="landing-footer">
        <div className="landing-shell">
          <div className="landing-footer__top">
            <a className="landing-brand" href="#top" aria-label={C.brand}>
              <BrandLogo height={28} />
            </a>
            <nav className="landing-footer__links" aria-label="Подвал">
              {C.footerLinks.map((link) =>
                link.to ? (
                  <Link key={link.label} to={link.to}>
                    {link.label}
                  </Link>
                ) : (
                  <a key={link.label} href={link.href}>
                    {link.label}
                  </a>
                )
              )}
            </nav>
          </div>
          <div className="landing-footer__legal">
            <span>{legal.company}</span>
            <span>
              {legal.inn} · {legal.ogrn}
            </span>
            <span>{legal.address}</span>
            <span>{legal.domain}</span>
          </div>
          <p className="landing-footer__copy">
            © {year} {C.brand}
          </p>
        </div>
      </footer>
    </div>
  );
}

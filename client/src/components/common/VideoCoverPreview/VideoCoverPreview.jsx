/**
 * Живое превью видеообложки: слайды + эффект перехода по настройкам шаблона.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  normalizeVideoCoverSettings,
  pickVideoCoverSlideUrls,
  VIDEO_COVER_TRANSITIONS,
} from '../../../utils/videoCoverTemplate.js';
import './VideoCoverPreview.css';

const DEMO_SLIDES = [
  {
    url: 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fc3f1d"/><stop offset="1" stop-color="#7c2d12"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><text x="225" y="310" text-anchor="middle" fill="#fff" font-size="72" font-family="sans-serif" font-weight="700">1</text></svg>`
    ),
  },
  {
    url: 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#005bff"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><text x="225" y="310" text-anchor="middle" fill="#fff" font-size="72" font-family="sans-serif" font-weight="700">2</text></svg>`
    ),
  },
  {
    url: 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#10b981"/><stop offset="1" stop-color="#064e3b"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><text x="225" y="310" text-anchor="middle" fill="#fff" font-size="72" font-family="sans-serif" font-weight="700">3</text></svg>`
    ),
  },
  {
    url: 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#a855f7"/><stop offset="1" stop-color="#4c1d95"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><text x="225" y="310" text-anchor="middle" fill="#fff" font-size="72" font-family="sans-serif" font-weight="700">4</text></svg>`
    ),
  },
  {
    url: 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#f59e0b"/><stop offset="1" stop-color="#92400e"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><text x="225" y="310" text-anchor="middle" fill="#fff" font-size="72" font-family="sans-serif" font-weight="700">5</text></svg>`
    ),
  },
];

function aspectPadding(ratio) {
  if (ratio === '1:1') return '100%';
  if (ratio === '16:9') return '56.25%';
  return '133.333%'; // 3:4
}

function transitionLabel(id) {
  return VIDEO_COVER_TRANSITIONS.find((t) => t.id === id)?.label || id;
}

/**
 * @param {object} props
 * @param {object} [props.settings]
 * @param {string[]} [props.imageUrls] — реальные фото; без них — демо-слайды
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {string} [props.className]
 * @param {boolean} [props.showCaption]
 */
export function VideoCoverPreview({
  settings: rawSettings,
  imageUrls,
  size = 'md',
  className = '',
  showCaption = true,
}) {
  const settings = useMemo(() => normalizeVideoCoverSettings(rawSettings), [rawSettings]);
  const slides = useMemo(() => {
    const fromProduct = pickVideoCoverSlideUrls(
      Array.isArray(imageUrls) ? imageUrls : [],
      settings
    );
    if (fromProduct.length) return fromProduct;
    return DEMO_SLIDES.slice(0, Math.max(1, settings.maxSlides)).map((s) => s.url);
  }, [imageUrls, settings]);

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState('hold'); // hold | leave
  const [prevIndex, setPrevIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    setPrevIndex(0);
    setPhase('hold');
  }, [slides.join('|'), settings.transition, settings.slideDurationMs, settings.transitionMs]);

  useEffect(() => {
    if (slides.length < 2) return undefined;
    const holdMs = Math.max(400, settings.slideDurationMs);
    const transMs =
      settings.transition === 'none' ? 0 : Math.max(0, settings.transitionMs);

    let leaveTimer;
    const holdTimer = setTimeout(() => {
      if (transMs <= 0) {
        setPrevIndex(index);
        setIndex((i) => (i + 1) % slides.length);
        setPhase('hold');
        return;
      }
      setPrevIndex(index);
      setPhase('leave');
      leaveTimer = setTimeout(() => {
        setIndex((i) => (i + 1) % slides.length);
        setPhase('hold');
      }, transMs);
    }, holdMs);

    return () => {
      clearTimeout(holdTimer);
      if (leaveTimer) clearTimeout(leaveTimer);
    };
  }, [index, slides.length, settings.slideDurationMs, settings.transitionMs, settings.transition]);

  const nextIndex = slides.length ? (index + 1) % slides.length : 0;
  const pad = aspectPadding(settings.aspectRatio);
  const sizeClass = size === 'lg' ? 'is-lg' : size === 'sm' ? 'is-sm' : 'is-md';

  return (
    <div className={`video-cover-preview ${sizeClass} ${className}`.trim()}>
      <div
        className={`video-cover-preview__frame transition-${settings.transition} phase-${phase}`}
        style={{
          paddingBottom: pad,
          ['--vc-trans']: `${Math.max(0, settings.transitionMs)}ms`,
        }}
      >
        {slides.length === 0 ? (
          <div className="video-cover-preview__empty">Нет слайдов</div>
        ) : (
          <>
            {phase === 'leave' && settings.transition !== 'none' ? (
              <img
                key={`prev-${prevIndex}`}
                className="video-cover-preview__slide is-leaving"
                src={slides[prevIndex]}
                alt=""
                draggable={false}
              />
            ) : null}
            <img
              key={`cur-${index}-${phase}`}
              className={`video-cover-preview__slide is-current${phase === 'leave' ? ' is-entering' : ''}`}
              src={phase === 'leave' ? slides[nextIndex] : slides[index]}
              alt=""
              draggable={false}
            />
          </>
        )}
        <div className="video-cover-preview__badge" aria-hidden>
          Ozon
        </div>
      </div>
      {showCaption ? (
        <div className="video-cover-preview__caption text-muted small">
          Превью · {transitionLabel(settings.transition)} · {slides.length} слайд
          {slides.length === 1 ? '' : slides.length < 5 ? 'а' : 'ов'} · {settings.aspectRatio}
          {!imageUrls?.length ? ' · демо' : ''}
        </div>
      ) : null}
    </div>
  );
}

/**
 * URL галереи товара для превью (бейдж Ozon).
 * @param {Array} images
 * @param {string} [marketplace='ozon']
 */
export function productImageUrlsForVideoCoverPreview(images, marketplace = 'ozon') {
  const mp = String(marketplace || 'ozon').toLowerCase();
  const list = Array.isArray(images) ? images : [];
  const filtered = list.filter((img) => {
    if (!img || typeof img !== 'object') return false;
    const flags = img.marketplaces && typeof img.marketplaces === 'object' ? img.marketplaces : null;
    if (!flags) return true;
    const v = flags[mp];
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return true;
  });
  const primaryIdx = filtered.findIndex((img) => img.primary === true);
  const ordered =
    primaryIdx > 0
      ? [filtered[primaryIdx], ...filtered.filter((_, i) => i !== primaryIdx)]
      : filtered;
  const out = [];
  const seen = new Set();
  for (const img of ordered) {
    const u = String(img.url ?? img.href ?? img.src ?? '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export default VideoCoverPreview;

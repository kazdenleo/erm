/**
 * Иконка «скопировать текст» для карточки новости МП.
 */

import React, { useEffect, useRef, useState } from 'react';

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function CopyIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
      />
    </svg>
  );
}

function CheckIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  );
}

/**
 * @param {{ title?: string, body?: string, className?: string }} props
 */
export function NewsCopyTextButton({ title = '', body = '', className = '' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const headline = String(title || '').trim();
    const text = String(body || '').trim();
    const payload = [headline, text].filter(Boolean).join('\n\n');
    const ok = await copyTextToClipboard(payload);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      className={`platform-mp-news-copy${copied ? ' platform-mp-news-copy--done' : ''}${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      title={copied ? 'Скопировано' : 'Скопировать текст'}
      aria-label={copied ? 'Скопировано' : 'Скопировать текст новости'}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

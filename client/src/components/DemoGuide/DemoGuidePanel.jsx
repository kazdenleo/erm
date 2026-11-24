/**
 * Стартовый виджет на Home: чеклист, бейджи, продление демо.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDemoUxContext } from '../../context/DemoUxContext.jsx';
import { Button } from '../common/Button/Button';
import './DemoGuide.css';

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

export function DemoGuidePanel() {
  const { ux, loading, dismissChecklist, extendDemo } = useDemoUxContext();
  const [extending, setExtending] = useState(false);
  const [extendMsg, setExtendMsg] = useState('');
  const [extendErr, setExtendErr] = useState('');

  if (loading && !ux) return null;
  if (!ux?.isDemo) return null;

  const showChecklist = ux.checklist && !ux.checklist.dismissed && !ux.checklist.complete;
  const showBadges = Array.isArray(ux.badges) && ux.badges.length > 0;
  const showExtend = Boolean(ux.canExtendDemo);

  const onExtend = async () => {
    setExtending(true);
    setExtendErr('');
    setExtendMsg('');
    try {
      const data = await extendDemo();
      const days = data?.extendedDays || 3;
      setExtendMsg(`Демо продлено на ${days} дня`);
    } catch (e) {
      setExtendErr(e?.response?.data?.message || e?.message || 'Не удалось продлить');
    } finally {
      setExtending(false);
    }
  };

  return (
    <div className="demo-guide-panel mb-3" role="region" aria-label="Старт в кабинете">
      <div className="demo-guide-header">
        <div>
          <div className="demo-guide-title">Демо-кабинет</div>
          <div className="demo-guide-sub">
            {ux.trialEndsAt
              ? `Доступ до ${formatRuDate(ux.trialEndsAt)}`
              : 'Пробный доступ активен'}
            {ux.demoExtendedAt ? ' · уже продлевали один раз' : ''}
          </div>
        </div>
        <div className="demo-guide-header-actions">
          {showExtend ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={extending}
              onClick={onExtend}
            >
              {extending ? 'Продлеваем…' : '+3 дня'}
            </Button>
          ) : null}
          <Link className="btn btn-sm btn-outline-primary" to="/pricing">
            Тарифы
          </Link>
        </div>
      </div>

      {extendMsg ? <div className="demo-guide-ok">{extendMsg}</div> : null}
      {extendErr ? <div className="demo-guide-err">{extendErr}</div> : null}

      {showChecklist ? (
        <div className="demo-guide-checklist">
          <div className="demo-guide-checklist-top">
            <strong>
              Первые шаги · {ux.checklist.doneCount}/{ux.checklist.total}
            </strong>
            <button type="button" className="demo-guide-dismiss" onClick={() => dismissChecklist()}>
              Скрыть
            </button>
          </div>
          <ul className="demo-guide-steps">
            {(ux.checklist.steps || []).map((s) => (
              <li key={s.id} className={s.done ? 'is-done' : ''}>
                <span className="demo-guide-check" aria-hidden="true">
                  {s.done ? '✓' : '○'}
                </span>
                {s.done ? (
                  <span>{s.title}</span>
                ) : (
                  <Link to={s.path || '/'}>{s.title}</Link>
                )}
                {!s.done && s.hint ? <span className="demo-guide-hint-inline">{s.hint}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showBadges ? (
        <div className="demo-guide-badges">
          <div className="demo-guide-badges-label">Отметки</div>
          <div className="demo-guide-badge-list">
            {ux.badges.map((b) => (
              <span key={b.id} className="demo-guide-badge" title={b.description || ''}>
                {b.title}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DemoGuidePanel;

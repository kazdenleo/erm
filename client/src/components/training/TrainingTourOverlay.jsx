import React from 'react';
import './TrainingTourOverlay.css';

export function TrainingTourOverlay({ tour, step, stepIndex, targetRect, onNext, onPrev, onClose }) {
  const pad = 8;
  const hole = targetRect
    ? {
        top: Math.max(0, targetRect.top - pad),
        left: Math.max(0, targetRect.left - pad),
        width: targetRect.width + pad * 2,
        height: targetRect.height + pad * 2,
      }
    : null;

  const panelStyle = (() => {
    if (!hole) return { bottom: 24, left: '50%', transform: 'translateX(-50%)' };
    const below = hole.top + hole.height + 12;
    const spaceBelow = window.innerHeight - below;
    if (spaceBelow > 220) {
      return {
        top: Math.min(below, window.innerHeight - 240),
        left: Math.min(Math.max(16, hole.left), window.innerWidth - 360),
      };
    }
    return {
      top: Math.max(16, hole.top - 200),
      left: Math.min(Math.max(16, hole.left), window.innerWidth - 360),
    };
  })();

  const isLast = stepIndex >= (tour.steps?.length || 1) - 1;

  return (
    <div className="training-tour" role="dialog" aria-modal="true" aria-label={tour.title}>
      <div className="training-tour__shade" onClick={onClose} />
      {hole ? (
        <div
          className="training-tour__hole"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
          }}
        />
      ) : null}
      <div className="training-tour__panel card" style={panelStyle}>
        <div className="training-tour__meta">
          <span>
            {tour.title} · шаг {stepIndex + 1} из {tour.steps.length}
          </span>
          <button type="button" className="training-tour__close" onClick={onClose} aria-label="Закрыть тур">
            ×
          </button>
        </div>
        <h3 className="training-tour__title">{step.title}</h3>
        <p className="training-tour__body">{step.body}</p>
        {!hole ? (
          <p className="training-tour__hint text-muted">
            Элемент на экране не найден — откройте нужный раздел вручную или нажмите «Далее».
          </p>
        ) : null}
        <div className="training-tour__actions">
          <button type="button" className="btn btn-light" onClick={onPrev} disabled={stepIndex <= 0}>
            Назад
          </button>
          <button type="button" className="btn btn-primary" onClick={onNext}>
            {isLast ? 'Готово' : 'Далее'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Контекст интерактивных туров обучения.
 * Провайдер должен жить выше Layout (в App), иначе при смене маршрута тур сбрасывается.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getTrainingTour } from '../pages/Training/tours.js';
import { TrainingTourOverlay } from '../components/training/TrainingTourOverlay.jsx';

const TrainingTourContext = createContext(null);

const STORAGE_KEY = 'erm:trainingTour';
const OPEN_NAV_EVENT = 'erm:training-open-nav';

function readStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.tourId) return null;
    return { tourId: parsed.tourId, stepIndex: Number(parsed.stepIndex) || 0 };
  } catch {
    return null;
  }
}

function writeStored(state) {
  try {
    if (!state) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function routeMatches(stepRoute, loc) {
  if (!stepRoute) return true;
  const [pathOnly, qs] = String(stepRoute).split('?');
  if (loc.pathname !== pathOnly) return false;
  if (!qs) return true;
  const want = new URLSearchParams(qs);
  const have = new URLSearchParams(loc.search || '');
  for (const [k, v] of want.entries()) {
    if (have.get(k) !== v) return false;
  }
  return true;
}

function isVisiblyHighlightable(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
}

function collectSelectors(step) {
  return [step?.selector, ...(step?.fallbackSelectors || []), '.app-main__inner', '.app-page-title', 'h1.title']
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function findTourTarget(step) {
  const selectors = collectSelectors(step);
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (isVisiblyHighlightable(el)) return { el, sel, visible: true };
  }
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return { el, sel, visible: false };
  }
  return null;
}

function openNavForStep(step) {
  const groupPath = step?.openNavGroup;
  if (!groupPath) return;
  try {
    window.dispatchEvent(new CustomEvent(OPEN_NAV_EVENT, { detail: { groupPath } }));
  } catch {
    /* ignore */
  }
}

export { OPEN_NAV_EVENT };

export function TrainingTourProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [tourId, setTourId] = useState(() => readStored()?.tourId || null);
  const [stepIndex, setStepIndex] = useState(() => readStored()?.stepIndex || 0);
  const [targetRect, setTargetRect] = useState(null);
  const [targetReady, setTargetReady] = useState(false);

  const tour = tourId ? getTrainingTour(tourId) : null;
  const step = tour?.steps?.[stepIndex] || null;

  const persist = useCallback((nextId, nextStep) => {
    if (!nextId) writeStored(null);
    else writeStored({ tourId: nextId, stepIndex: nextStep });
  }, []);

  const stopTour = useCallback(() => {
    setTourId(null);
    setStepIndex(0);
    setTargetRect(null);
    setTargetReady(false);
    persist(null, 0);
  }, [persist]);

  const startTour = useCallback(
    (id, fromStep = 0) => {
      const t = getTrainingTour(id);
      if (!t?.steps?.length) return;
      const idx = Math.max(0, Math.min(fromStep, t.steps.length - 1));
      setTargetRect(null);
      setTargetReady(false);
      setTourId(t.id);
      setStepIndex(idx);
      persist(t.id, idx);
      const route = t.steps[idx]?.route;
      if (route) {
        openNavForStep(t.steps[idx]);
        navigate(route);
      }
    },
    [navigate, persist]
  );

  const goToStep = useCallback(
    (idx) => {
      if (!tour?.steps?.length) return;
      const next = Math.max(0, Math.min(idx, tour.steps.length - 1));
      setTargetRect(null);
      setTargetReady(false);
      setStepIndex(next);
      persist(tour.id, next);
      const nextStepDef = tour.steps[next];
      const route = nextStepDef?.route;
      if (route) {
        openNavForStep(nextStepDef);
        if (!routeMatches(route, location)) {
          navigate(route);
        }
      }
    },
    [tour, location, navigate, persist]
  );

  const nextStep = useCallback(() => {
    if (!tour) return;
    if (stepIndex >= tour.steps.length - 1) stopTour();
    else goToStep(stepIndex + 1);
  }, [tour, goToStep, stepIndex, stopTour]);

  const prevStep = useCallback(() => {
    if (!tour) return;
    if (stepIndex <= 0) return;
    goToStep(stepIndex - 1);
  }, [tour, goToStep, stepIndex]);

  useEffect(() => {
    if (!step) {
      setTargetRect(null);
      setTargetReady(false);
      return undefined;
    }

    let cancelled = false;
    let tries = 0;
    const maxTries = 40;

    const measure = () => {
      if (cancelled) return;

      if (!routeMatches(step.route, location)) {
        tries += 1;
        if (tries === 1 && step.route) navigate(step.route);
        if (tries < maxTries) window.setTimeout(measure, 120);
        return;
      }

      openNavForStep(step);

      const found = findTourTarget(step);
      if (found?.el && found.visible) {
        try {
          found.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch {
          /* ignore */
        }
        const r = found.el.getBoundingClientRect();
        setTargetRect({
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        });
        setTargetReady(true);
        return;
      }

      // Элемент есть, но ещё скрыт (подменю) — подождём раскрытия.
      if (found?.el && !found.visible) {
        tries += 1;
        if (tries < maxTries) {
          window.setTimeout(measure, 120);
          return;
        }
      }

      tries += 1;
      if (tries < maxTries) {
        window.setTimeout(measure, 120);
        return;
      }

      // Последний шанс — подсветить контент страницы.
      const main = document.querySelector('.app-main__inner');
      if (main && isVisiblyHighlightable(main)) {
        const r = main.getBoundingClientRect();
        setTargetRect({
          top: Math.min(r.top + 8, window.innerHeight * 0.2),
          left: r.left + 8,
          width: Math.min(r.width - 16, 520),
          height: 72,
        });
        setTargetReady(true);
        return;
      }

      setTargetRect(null);
      setTargetReady(true);
    };

    const t = window.setTimeout(measure, 60);
    const onResize = () => {
      if (!cancelled) measure();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [step, location.pathname, location.search, navigate]);

  const value = useMemo(
    () => ({
      tourId,
      tour,
      step,
      stepIndex,
      stepCount: tour?.steps?.length || 0,
      startTour,
      stopTour,
      nextStep,
      prevStep,
      goToStep,
      isActive: Boolean(tour),
    }),
    [tourId, tour, step, stepIndex, startTour, stopTour, nextStep, prevStep, goToStep]
  );

  return (
    <TrainingTourContext.Provider value={value}>
      {children}
      {tour && step ? (
        <TrainingTourOverlay
          tour={tour}
          step={step}
          stepIndex={stepIndex}
          targetRect={targetRect}
          targetReady={targetReady}
          onNext={nextStep}
          onPrev={prevStep}
          onClose={stopTour}
        />
      ) : null}
    </TrainingTourContext.Provider>
  );
}

export function useTrainingTour() {
  const ctx = useContext(TrainingTourContext);
  if (!ctx) {
    return {
      isActive: false,
      startTour: () => {},
      stopTour: () => {},
    };
  }
  return ctx;
}

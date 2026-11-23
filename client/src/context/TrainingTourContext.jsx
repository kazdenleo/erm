/**
 * Контекст интерактивных туров обучения.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getTrainingTour } from '../pages/Training/tours.js';
import { TrainingTourOverlay } from '../components/training/TrainingTourOverlay.jsx';

const TrainingTourContext = createContext(null);

const STORAGE_KEY = 'erm:trainingTour';

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

export function TrainingTourProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [tourId, setTourId] = useState(() => readStored()?.tourId || null);
  const [stepIndex, setStepIndex] = useState(() => readStored()?.stepIndex || 0);
  const [targetRect, setTargetRect] = useState(null);

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
    persist(null, 0);
  }, [persist]);

  const startTour = useCallback(
    (id, fromStep = 0) => {
      const t = getTrainingTour(id);
      if (!t?.steps?.length) return;
      const idx = Math.max(0, Math.min(fromStep, t.steps.length - 1));
      setTourId(t.id);
      setStepIndex(idx);
      persist(t.id, idx);
      const route = t.steps[idx]?.route;
      if (route && !location.pathname.startsWith(route.split('?')[0])) {
        navigate(route);
      }
    },
    [location.pathname, navigate, persist]
  );

  const goToStep = useCallback(
    (idx) => {
      if (!tour?.steps?.length) return;
      const next = Math.max(0, Math.min(idx, tour.steps.length - 1));
      setStepIndex(next);
      persist(tour.id, next);
      const route = tour.steps[next]?.route;
      if (route) {
        const pathOnly = route.split('?')[0];
        if (location.pathname !== pathOnly || (route.includes('?') && location.search !== `?${route.split('?')[1]}`)) {
          navigate(route);
        }
      }
    },
    [tour, location.pathname, location.search, navigate, persist]
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
    if (!step?.selector) {
      setTargetRect(null);
      return undefined;
    }

    let cancelled = false;
    let tries = 0;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(step.selector);
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        const r = el.getBoundingClientRect();
        setTargetRect({
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        });
        return;
      }
      setTargetRect(null);
      tries += 1;
      if (tries < 20) window.setTimeout(measure, 150);
    };

    const t = window.setTimeout(measure, 80);
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [step, location.pathname, location.search]);

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

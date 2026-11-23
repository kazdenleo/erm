/**
 * Раздел «Обучение» — каталог уроков и карточка урока.
 */

import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { StepVisual } from '../../components/training/StepVisual.jsx';
import { useTrainingTour } from '../../context/TrainingTourContext.jsx';
import {
  TRAINING_CATEGORIES,
  TRAINING_LESSONS,
  getCategory,
  getLessonsByCategory,
  getTrainingLesson,
  searchTrainingLessons,
} from './content/index.js';
import './Training.css';

function Callout({ callout }) {
  if (!callout?.text) return null;
  return (
    <div className={`training-callout training-callout--${callout.type || 'info'}`} role="note">
      {callout.text}
    </div>
  );
}

function LessonView({ lesson }) {
  const navigate = useNavigate();
  const { startTour } = useTrainingTour();
  const category = getCategory(lesson.categoryId);

  return (
    <div className="training-lesson">
      <div className="training-lesson__top">
        <button type="button" className="btn btn-light btn-sm" onClick={() => navigate('/training')}>
          ← К каталогу
        </button>
        <div className="training-lesson__actions">
          {lesson.relatedPath ? (
            <Link className="btn btn-outline-primary btn-sm" to={lesson.relatedPath}>
              Открыть раздел
            </Link>
          ) : null}
          {lesson.tourId ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => startTour(lesson.tourId)}
            >
              Запустить тур
            </button>
          ) : null}
        </div>
      </div>

      <header className="training-lesson__header">
        {category ? <div className="training-lesson__cat">{category.title}</div> : null}
        <h1 className="training-lesson__title">{lesson.title}</h1>
        <p className="training-lesson__summary">{lesson.summary}</p>
        <div className="training-lesson__meta">
          <span>~{lesson.durationMin || 5} мин</span>
          {(lesson.tags || []).slice(0, 5).map((t) => (
            <span key={t} className="training-tag">
              {t}
            </span>
          ))}
        </div>
      </header>

      {(lesson.sections || []).map((section) => (
        <section key={section.title} className="training-section card">
          <h2 className="training-section__title">{section.title}</h2>
          {(section.paragraphs || []).map((p) => (
            <p key={p.slice(0, 48)} className="training-section__p">
              {p}
            </p>
          ))}
          {section.steps?.length ? (
            <ol className="training-steps">
              {section.steps.map((step, idx) => (
                <li key={`${step.title}-${idx}`} className="training-step">
                  <div className="training-step__text">
                    <h3>
                      <span className="training-step__num">{idx + 1}</span>
                      {step.title}
                    </h3>
                    <p>{step.text}</p>
                    {step.tip ? <p className="training-step__tip">{step.tip}</p> : null}
                  </div>
                  {step.visual ? (
                    <div className="training-step__visual">
                      <StepVisual id={step.visual} caption={step.title} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {section.bullets?.length ? (
            <ul className="training-bullets">
              {section.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
          <Callout callout={section.callout} />
        </section>
      ))}
    </div>
  );
}

function Catalog({ query, setQuery, categoryFilter, setCategoryFilter }) {
  const lessons = useMemo(() => {
    let list = searchTrainingLessons(query);
    if (categoryFilter) list = list.filter((l) => l.categoryId === categoryFilter);
    return list;
  }, [query, categoryFilter]);

  return (
    <div className="training-catalog">
      <div className="training-catalog__toolbar card">
        <input
          className="form-control"
          type="search"
          placeholder="Поиск по урокам: сборка, этикетки, FBO…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск по обучению"
        />
        <div className="training-catalog__chips" role="tablist" aria-label="Категории">
          <button
            type="button"
            className={`training-chip${!categoryFilter ? ' is-active' : ''}`}
            onClick={() => setCategoryFilter('')}
          >
            Все ({TRAINING_LESSONS.length})
          </button>
          {TRAINING_CATEGORIES.map((c) => {
            const count = getLessonsByCategory(c.id).length;
            return (
              <button
                key={c.id}
                type="button"
                className={`training-chip${categoryFilter === c.id ? ' is-active' : ''}`}
                onClick={() => setCategoryFilter(c.id)}
              >
                {c.title} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {!categoryFilter && !query ? (
        <div className="training-tracks">
          {TRAINING_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="training-track card"
              onClick={() => setCategoryFilter(c.id)}
            >
              <i className={`${c.iconClass} training-track__icon`} aria-hidden />
              <div>
                <h2>{c.title}</h2>
                <p>{c.lead}</p>
                <span className="text-muted">{getLessonsByCategory(c.id).length} ур.</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      <div className="training-lesson-grid">
        {lessons.map((lesson) => {
          const cat = getCategory(lesson.categoryId);
          return (
            <Link key={lesson.id} to={`/training/${lesson.id}`} className="training-lesson-card card">
              <div className="training-lesson-card__cat">{cat?.title}</div>
              <h3>{lesson.title}</h3>
              <p>{lesson.summary}</p>
              <div className="training-lesson-card__footer">
                <span>~{lesson.durationMin || 5} мин</span>
                {lesson.tourId ? <span className="training-lesson-card__tour">есть тур</span> : null}
              </div>
            </Link>
          );
        })}
        {!lessons.length ? (
          <div className="card training-empty">Ничего не найдено. Попробуйте другой запрос.</div>
        ) : null}
      </div>
    </div>
  );
}

export function Training() {
  const { lessonId } = useParams();
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const lesson = lessonId ? getTrainingLesson(lessonId) : null;

  if (lessonId && !lesson) {
    return (
      <div className="training-page">
        <PageTitle iconClass="pe-7s-study" title="Обучение" subtitle="Урок не найден" />
        <div className="card">
          <p>Такого урока нет.</p>
          <Link to="/training" className="btn btn-primary">
            К каталогу
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="training-page" data-tour="page-training">
      <PageTitle
        iconClass="pe-7s-study"
        title="Обучение"
        subtitle={
          lesson
            ? lesson.title
            : 'Пошаговые инструкции и интерактивные туры по работе в MySell'
        }
      />
      {lesson ? (
        <LessonView lesson={lesson} />
      ) : (
        <Catalog
          query={query}
          setQuery={setQuery}
          categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter}
        />
      )}
    </div>
  );
}

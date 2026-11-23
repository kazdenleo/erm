import { TRAINING_CATEGORIES } from './categories.js';
import { LESSONS_START } from './lessonsStart.js';
import { LESSONS_SETTINGS } from './lessonsSettings.js';
import { LESSONS_PRODUCTS } from './lessonsProducts.js';
import { LESSONS_ORDERS } from './lessonsOrders.js';
import { LESSONS_WAREHOUSE } from './lessonsWarehouse.js';
import {
  LESSONS_FBO,
  LESSONS_PRICES,
  LESSONS_ANALYTICS,
  LESSONS_ADS,
  LESSONS_COMMS,
} from './lessonsFboPricesAnalytics.js';

export { TRAINING_CATEGORIES };

export const TRAINING_LESSONS = [
  ...LESSONS_START,
  ...LESSONS_SETTINGS,
  ...LESSONS_PRODUCTS,
  ...LESSONS_ORDERS,
  ...LESSONS_WAREHOUSE,
  ...LESSONS_FBO,
  ...LESSONS_PRICES,
  ...LESSONS_ANALYTICS,
  ...LESSONS_ADS,
  ...LESSONS_COMMS,
];

const byId = new Map(TRAINING_LESSONS.map((l) => [l.id, l]));

export function getTrainingLesson(id) {
  return byId.get(String(id || '')) || null;
}

export function getLessonsByCategory(categoryId) {
  return TRAINING_LESSONS.filter((l) => l.categoryId === categoryId);
}

export function searchTrainingLessons(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return TRAINING_LESSONS;
  return TRAINING_LESSONS.filter((l) => {
    const hay = [
      l.title,
      l.summary,
      ...(l.tags || []),
      ...((l.sections || []).flatMap((s) => [
        s.title,
        ...(s.paragraphs || []),
        ...(s.bullets || []),
        ...((s.steps || []).flatMap((st) => [st.title, st.text])),
      ])),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return hay.includes(q);
  });
}

export function getCategory(categoryId) {
  return TRAINING_CATEGORIES.find((c) => c.id === categoryId) || null;
}

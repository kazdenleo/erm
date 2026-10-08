/**
 * Калькулятор времени подготовки поставки: штуки × норма + прочее время → рабочие дни по 8 ч без сб/вс.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { formatDateRu, formatQty } from '../shared/analyticsKit';

const WORKDAY_HOURS = 8;
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const BASIS_OPTIONS = [
  { value: 'both', label: 'Сборка + упаковка FBO' },
  { value: 'packing', label: 'Только упаковка' },
  { value: 'collect', label: 'Только сборка FBO' },
];

function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const todayYmd = () => toYmd(new Date());

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

/** Дата последнего рабочего дня: старт в выходной переносится на понедельник. */
function finishDate(startYmd, workdays) {
  const [y, m, day] = String(startYmd || todayYmd()).split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, day || 1);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  for (let left = workdays - 1; left > 0; ) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}

function daysWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'рабочий день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'рабочих дня';
  return 'рабочих дней';
}

function formatHours(sec) {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function basisSec(basis, summary) {
  const collect = Number(summary?.fboCollectSecPerUnit) || 0;
  const packing = Number(summary?.packingSecPerUnit) || 0;
  if (basis === 'collect') return collect;
  if (basis === 'packing') return packing;
  return collect + packing;
}

export function PackingCalculator({ summary }) {
  const [qty, setQty] = useState('');
  const [basis, setBasis] = useState('both');
  const [secPerUnit, setSecPerUnit] = useState('');
  const [otherMin, setOtherMin] = useState('');
  const [start, setStart] = useState(todayYmd);

  const statsSec = basisSec(basis, summary);
  useEffect(() => {
    setSecPerUnit(statsSec > 0 ? String(Math.round(statsSec * 10) / 10) : '');
  }, [statsSec]);

  const result = useMemo(() => {
    const q = Math.max(Number(qty) || 0, 0);
    const sec = Math.max(Number(String(secPerUnit).replace(',', '.')) || 0, 0);
    const other = Math.max(Number(String(otherMin).replace(',', '.')) || 0, 0);
    const totalSec = q * sec + other * 60;
    if (totalSec <= 0) return null;
    const workdays = Math.max(Math.ceil(totalSec / 3600 / WORKDAY_HOURS - 1e-9), 1);
    const end = finishDate(start, workdays);
    return { totalSec, workdays, end };
  }, [qty, secPerUnit, otherMin, start]);

  return (
    <div className="employee-metrics__calc">
      <div className="employee-metrics__calc-title">Сколько займёт подготовка поставки</div>
      <div className="employee-metrics__calc-row">
        <label className="sales-analytics__filter">
          <span>Штук</span>
          <input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 90 }} />
        </label>
        <label className="sales-analytics__filter">
          <span>Норма</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {BASIS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="sales-analytics__filter"
          title={
            statsSec > 0
              ? `По данным за период: ${formatQty(statsSec, 1)} с/шт. Можно изменить вручную`
              : 'За период нет данных — укажите норму вручную'
          }
        >
          <span>Сек на штуку</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={secPerUnit}
            placeholder="нет данных"
            onChange={(e) => setSecPerUnit(e.target.value)}
            style={{ width: 90 }}
          />
        </label>
        <label className="sales-analytics__filter" title="Подготовка коробок, печать, погрузка и т. п.">
          <span>Прочее, мин</span>
          <input
            type="number"
            min={0}
            value={otherMin}
            onChange={(e) => setOtherMin(e.target.value)}
            style={{ width: 90 }}
          />
        </label>
        <label className="sales-analytics__filter">
          <span>Начало</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value || todayYmd())} />
        </label>
        <div className="employee-metrics__calc-result">
          {result ? (
            <>
              <strong>{formatHours(result.totalSec)}</strong> работы — {result.workdays} {daysWord(result.workdays)} по{' '}
              {WORKDAY_HOURS} ч, готово {formatDateRu(toYmd(result.end))} ({WEEKDAYS[result.end.getDay()]})
            </>
          ) : (
            <span className="employee-metrics__calc-empty">Укажите количество штук и норму</span>
          )}
        </div>
      </div>
    </div>
  );
}

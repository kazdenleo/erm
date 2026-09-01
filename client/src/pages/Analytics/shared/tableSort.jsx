import React, { useCallback, useMemo, useState } from 'react';

/**
 * Клиентская сортировка строк таблицы: клик по колонке — по возрастанию, повторный — по убыванию.
 */
export function useTableSort(initialKey = null, initialDir = 'asc') {
  const [sort, setSort] = useState(
    initialKey ? { key: initialKey, dir: initialDir } : { key: null, dir: 'asc' }
  );

  const toggleSort = useCallback((key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  return { sort, toggleSort };
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null || a === '') return 1;
  if (b == null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  return String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });
}

/**
 * @param {Array} rows
 * @param {{ key: string|null, dir: 'asc'|'desc' }} sort
 * @param {Record<string, (row: any) => any>} [getters]
 */
export function sortRows(rows, sort, getters = {}) {
  if (!sort?.key || !Array.isArray(rows) || rows.length < 2) return rows;
  const get = getters[sort.key] || ((r) => r[sort.key]);
  const mul = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((ra, rb) => mul * compareValues(get(ra), get(rb)));
}

export function SortableTh({
  sortKey,
  sort,
  onSort,
  className = '',
  title,
  children,
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  const classes = [
    'sales-analytics__th-sortable',
    className,
    active ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <th
      className={classes}
      title={title}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="sales-analytics__sort-btn"
        onClick={() => onSort(sortKey)}
      >
        <span>{children}</span>
        <span className="sales-analytics__sort-ind" aria-hidden>
          {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}
        </span>
      </button>
    </th>
  );
}

/** Удобная обёртка: сортирует rows при изменении sort. */
export function useSortedRows(rows, sort, getters) {
  return useMemo(() => sortRows(rows, sort, getters), [rows, sort, getters]);
}

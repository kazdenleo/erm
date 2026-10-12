/**
 * Вид стеллажей: сетка «полки × ячейки», раскраска по метрике и подсветка ячеек выбранного товара.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addressStorageApi } from '../../services/addressStorage.api';
import { AssignProductModal } from './AssignProductModal';
import { ProductPicker } from './ProductPicker';
import { HeatControls } from './HeatLegend';
import { useHeatmap } from './useHeatmap';
import {
  LOCATION_TYPE_LABELS,
  downloadBlob,
  groupRacks,
  heatColor,
  locationTooltip,
  splitAddress,
} from './addressStorageUtils';

export function RackViewTab({ warehouseId, settings, locations, reloadLocations, setParam, searchParams }) {
  const [metric, setMetric] = useState('fill');
  const [days, setDays] = useState(30);
  const [selectedId, setSelectedId] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [highlightProduct, setHighlightProduct] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const firstHitRef = useRef(null);

  const rackParam = searchParams.get('rack');
  const productParam = Number(searchParams.get('product')) || null;
  const { statsById, maxima } = useHeatmap(warehouseId, days, `${reloadKey}-${locations.length}`);
  const racks = useMemo(() => groupRacks(locations, settings.separator), [locations, settings.separator]);
  const visibleRacks = rackParam != null ? racks.filter((r) => r.key === rackParam) : racks;

  useEffect(() => {
    if (!productParam) {
      setHighlightProduct(null);
      return;
    }
    if (highlightProduct?.id === productParam) return;
    const fromCells = locations.flatMap((l) => l.products).find((p) => p.productId === productParam);
    setHighlightProduct(
      fromCells ? { id: productParam, sku: fromCells.sku, name: fromCells.name } : { id: productParam, sku: `#${productParam}` }
    );
  }, [productParam, locations, highlightProduct?.id]);

  const hitIds = useMemo(() => {
    if (!highlightProduct) return new Set();
    return new Set(
      locations.filter((l) => l.products.some((p) => p.productId === highlightProduct.id)).map((l) => l.id)
    );
  }, [highlightProduct, locations]);

  const hitRacks = useMemo(() => {
    const set = new Set();
    for (const l of locations) if (hitIds.has(l.id)) set.add(splitAddress(l.parts, settings.separator).rackKey);
    return set;
  }, [hitIds, locations, settings.separator]);

  useEffect(() => {
    if (hitIds.size && firstHitRef.current) {
      firstHitRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [hitIds, rackParam]);

  const selected = locations.find((l) => l.id === selectedId) || null;
  const selectedStat = selected ? statsById.get(selected.id) : null;
  let firstHitAssigned = false;

  if (!locations.length) {
    return <p className="text-muted">Ячеек пока нет — создайте их на вкладке «Ячейки».</p>;
  }

  return (
    <div className="address-racks">
      <div className="address-toolbar">
        <div className="address-toolbar__picker">
          <ProductPicker
            warehouseId={warehouseId}
            placeholder="Показать товар на стеллажах"
            onPick={(p) => {
              setHighlightProduct({ id: p.id, sku: p.sku, name: p.name });
              setParam({ product: p.id, rack: null });
            }}
          />
        </div>
        {highlightProduct ? (
          <span className="address-highlight-info">
            <strong>{highlightProduct.sku}</strong> {highlightProduct.name || ''}:{' '}
            {hitIds.size
              ? `ячейки ${locations.filter((l) => hitIds.has(l.id)).map((l) => l.code).join(', ')}`
              : 'не размещён на этом складе'}
            <button
              type="button"
              className="btn btn-link btn-sm"
              onClick={() => {
                setHighlightProduct(null);
                setParam({ product: null });
              }}
            >
              сбросить
            </button>
          </span>
        ) : null}
      </div>

      <HeatControls metric={metric} onMetric={setMetric} days={days} onDays={setDays} />

      <div className="address-rack-chips">
        <button
          type="button"
          className={`address-rack-chip${rackParam == null ? ' address-rack-chip--active' : ''}`}
          onClick={() => setParam({ rack: null })}
        >
          Все ({racks.length})
        </button>
        {racks.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`address-rack-chip${rackParam === r.key ? ' address-rack-chip--active' : ''}${
              hitRacks.has(r.key) ? ' address-rack-chip--hit' : ''
            }`}
            onClick={() => setParam({ rack: r.key })}
          >
            {r.key || 'Ячейки'}
          </button>
        ))}
      </div>

      <div className="address-racks__body">
        <div className="address-racks__grid">
          {visibleRacks.map((rack) => (
            <section key={rack.key} className={`address-rack${hitRacks.has(rack.key) ? ' address-rack--hit' : ''}`}>
              <header className="address-rack__title">
                {rack.key ? `Стеллаж ${rack.key}` : 'Ячейки'}
                <span className="muted-hint"> · {rack.locations.length} яч.</span>
              </header>
              <div className="address-rack__shelves">
                {rack.shelves.map((shelf) => (
                  <div key={shelf.shelf} className="address-rack__shelf">
                    {shelf.shelf ? <div className="address-rack__shelf-label">{shelf.shelf}</div> : null}
                    <div className="address-rack__cells">
                      {shelf.cells.map((loc) => {
                        const stat = statsById.get(loc.id);
                        const hit = hitIds.has(loc.id);
                        const refProps = hit && !firstHitAssigned ? { ref: firstHitRef } : {};
                        if (hit) firstHitAssigned = true;
                        const main = loc.products[0];
                        return (
                          <button
                            key={loc.id}
                            type="button"
                            {...refProps}
                            className={`address-cell${hit ? ' address-cell--hit' : ''}${
                              selectedId === loc.id ? ' address-cell--selected' : ''
                            }${loc.isActive ? '' : ' address-cell--inactive'}`}
                            style={{ background: heatColor(metric, loc, stat, maxima) }}
                            title={locationTooltip(loc, stat)}
                            onClick={() => setSelectedId(loc.id)}
                          >
                            <span className="address-cell__code">
                              {splitAddress(loc.parts, settings.separator).cell || loc.code}
                            </span>
                            {main ? (
                              <span className="address-cell__sku">
                                {main.assigned ? '📌' : ''}
                                {main.sku}
                                {loc.products.length > 1 ? ` +${loc.products.length - 1}` : ''}
                              </span>
                            ) : null}
                            {settings.trackQuantities && stat?.quantity ? (
                              <span className="address-cell__qty">{stat.quantity}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {selected ? (
          <aside className="address-cell-panel">
            <div className="address-cell-panel__head">
              <code className="address-code address-code--lg">{selected.code}</code>
              <button type="button" className="btn btn-link btn-sm" onClick={() => setSelectedId(null)} aria-label="Закрыть">
                ✕
              </button>
            </div>
            <dl className="address-cell-panel__meta">
              <dt>Тип</dt>
              <dd>{LOCATION_TYPE_LABELS[selected.type]}</dd>
              <dt>Вместимость</dt>
              <dd>{selected.capacity ?? 'не ограничена'}</dd>
              {settings.trackQuantities ? (
                <>
                  <dt>В ячейке</dt>
                  <dd>{selectedStat?.quantity ?? 0} шт</dd>
                </>
              ) : null}
              <dt>Отгружено за {days} дн.</dt>
              <dd>{selectedStat?.shipped ?? 0} шт</dd>
              <dt>Без движения</dt>
              <dd>{selectedStat?.idleDays != null ? `${selectedStat.idleDays} дн.` : '—'}</dd>
            </dl>
            <h5 className="address-modal__subtitle">Товары</h5>
            {selected.products.length === 0 ? <p className="muted-hint">Пусто</p> : null}
            <ul className="address-modal__list">
              {selected.products.map((p) => (
                <li key={p.productId}>
                  {p.assigned ? '📌 ' : ''}
                  <Link to={`/products/${p.productId}`}>
                    <code>{p.sku}</code>
                  </Link>{' '}
                  {p.name}
                  {p.quantity ? <span className="muted-hint"> — {p.quantity} шт</span> : null}
                </li>
              ))}
            </ul>
            <div className="address-cell-panel__actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setAssignOpen(true)}>
                📌 Закрепить товар
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() =>
                  addressStorageApi
                    .labelsPdf(warehouseId, [selected.id])
                    .then((blob) => downloadBlob(blob, `cell-${selected.code}.pdf`))
                    .catch(() => {})
                }
              >
                🖨 Этикетка
              </button>
            </div>
          </aside>
        ) : null}
      </div>

      {assignOpen && selected ? (
        <AssignProductModal
          warehouseId={warehouseId}
          location={selected}
          onClose={() => setAssignOpen(false)}
          onChanged={async () => {
            await reloadLocations();
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

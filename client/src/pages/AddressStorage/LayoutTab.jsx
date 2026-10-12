/**
 * План склада сверху: редактор элементов на сетке и просмотр с тепловой картой по стеллажам.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { ProductPicker } from './ProductPicker';
import { HeatControls } from './HeatLegend';
import { useHeatmap } from './useHeatmap';
import { colorForHeat, compareText, groupRacks, rackHeat, splitAddress } from './addressStorageUtils';

const KINDS = {
  rack: { label: 'Стеллаж', w: 4, h: 1 },
  zone: { label: 'Зона', w: 8, h: 6 },
  wall: { label: 'Стена', w: 6, h: 0.5 },
  door: { label: 'Ворота / дверь', w: 2, h: 0.5 },
  table: { label: 'Стол упаковки', w: 3, h: 2 },
  label: { label: 'Подпись', w: 4, h: 1 },
};

const snap = (v) => Math.round(v * 2) / 2;
const round2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const normAngle = (v) => ((Math.round(Number(v) || 0) % 360) + 360) % 360;
let idSeq = 0;
const newId = () => `i${Date.now().toString(36)}${(idSeq += 1)}`;

/** Поворот на 90° вокруг центра: прямоугольник w×h под углом θ — то же, что h×w под углом θ+90°. */
function rotated90(it, layout) {
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const w = it.h;
  const h = it.w;
  const place = it.rot ? round2 : snap;
  return {
    w,
    h,
    x: clamp(place(cx - w / 2), 0, Math.max(0, layout.width - w)),
    y: clamp(place(cy - h / 2), 0, Math.max(0, layout.height - h)),
  };
}

/** Новый размер повёрнутого элемента: угол напротив ручки остаётся на месте. */
function resizedRotated(orig, dx, dy, layout) {
  const rad = (orig.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = clamp(snap(orig.w + dx * cos + dy * sin), 0.5, layout.width);
  const h = clamp(snap(orig.h - dx * sin + dy * cos), 0.5, layout.height);
  const ax = orig.x + orig.w / 2 - (orig.w / 2) * cos + (orig.h / 2) * sin;
  const ay = orig.y + orig.h / 2 - (orig.w / 2) * sin - (orig.h / 2) * cos;
  const cx = ax + (w / 2) * cos - (h / 2) * sin;
  const cy = ay + (w / 2) * sin + (h / 2) * cos;
  return { w, h, x: round2(cx - w / 2), y: round2(cy - h / 2) };
}

function itemStyle(kind) {
  switch (kind) {
    case 'zone':
      return { fill: 'rgba(116, 143, 252, 0.08)', stroke: '#748ffc', dash: '6 4' };
    case 'wall':
      return { fill: '#495057', stroke: '#343a40' };
    case 'door':
      return { fill: '#ffa94d', stroke: '#e8590c' };
    case 'table':
      return { fill: '#fff3bf', stroke: '#f59f00' };
    case 'label':
      return { fill: 'transparent', stroke: 'transparent' };
    default:
      return { fill: '#f1f3f5', stroke: '#868e96' };
  }
}

export function LayoutTab({ warehouseId, settings, locations, setParam }) {
  const [layout, setLayout] = useState(null);
  const [saved, setSaved] = useState(null);
  const [mode, setMode] = useState('view');
  const [cell, setCell] = useState(24);
  const [selectedId, setSelectedId] = useState(null);
  const [metric, setMetric] = useState('fill');
  const [days, setDays] = useState(30);
  const [highlight, setHighlight] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const { statsById } = useHeatmap(warehouseId, days, locations.length);
  const racks = useMemo(() => groupRacks(locations, settings.separator), [locations, settings.separator]);
  const rackByKey = useMemo(() => new Map(racks.map((r) => [r.key, r])), [racks]);

  useEffect(() => {
    let cancelled = false;
    setLayout(null);
    addressStorageApi
      .getLayout(warehouseId)
      .then((l) => {
        if (cancelled) return;
        setLayout(l);
        setSaved(JSON.stringify(l));
        setMode(l.items.length ? 'view' : 'edit');
      })
      .catch((e) => !cancelled && setMessage({ ok: false, text: addressStorageError(e).message }));
    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  const dirty = layout && saved !== JSON.stringify(layout);
  const items = useMemo(() => layout?.items || [], [layout?.items]);
  const selected = items.find((i) => i.id === selectedId) || null;

  const updateItem = useCallback((id, patch) => {
    setLayout((l) => ({ ...l, items: l.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  }, []);

  const rackShipMax = useMemo(() => {
    let max = 0;
    for (const r of racks) {
      const s = r.locations.reduce((acc, l) => acc + (statsById.get(l.id)?.shipped ?? 0), 0);
      if (s > max) max = s;
    }
    return max;
  }, [racks, statsById]);

  const hitRacks = useMemo(() => {
    if (!highlight) return new Set();
    const set = new Set();
    for (const l of locations) {
      if (l.products.some((p) => p.productId === highlight.id)) set.add(splitAddress(l.parts, settings.separator).rackKey);
    }
    return set;
  }, [highlight, locations, settings.separator]);

  const placedKeys = useMemo(() => new Set(items.filter((i) => i.kind === 'rack').map((i) => i.rackKey)), [items]);
  const unplacedRacks = racks.filter((r) => !placedKeys.has(r.key));

  const toCells = (evt) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: (evt.clientX - rect.left) / cell, y: (evt.clientY - rect.top) / cell };
  };

  useEffect(() => {
    const move = (evt) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toCells(evt);
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (d.type === 'move') {
        updateItem(d.id, {
          x: clamp(round2(d.orig.x + snap(dx)), 0, layout.width - d.orig.w),
          y: clamp(round2(d.orig.y + snap(dy)), 0, layout.height - d.orig.h),
        });
      } else if (d.orig.rot) {
        updateItem(d.id, resizedRotated(d.orig, dx, dy, layout));
      } else {
        updateItem(d.id, {
          w: clamp(snap(d.orig.w + dx), 0.5, layout.width - d.orig.x),
          h: clamp(snap(d.orig.h + dy), 0.5, layout.height - d.orig.y),
        });
      }
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toCells зависит только от cell
  }, [cell, layout?.width, layout?.height, updateItem]);

  const rotateSelected = useCallback(() => {
    if (!selected || !layout) return;
    updateItem(selected.id, rotated90(selected, layout));
  }, [selected, layout, updateItem]);

  useEffect(() => {
    if (mode !== 'edit' || !selected) return undefined;
    const onKey = (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) return;
      const step = 0.5;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Delete') {
        setLayout((l) => ({ ...l, items: l.items.filter((it) => it.id !== selected.id) }));
        setSelectedId(null);
      } else if (['r', 'R', 'к', 'К'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        rotateSelected();
      } else if (moves[e.key]) {
        e.preventDefault();
        const [dx, dy] = moves[e.key];
        updateItem(selected.id, {
          x: clamp(selected.x + dx, 0, layout.width - selected.w),
          y: clamp(selected.y + dy, 0, layout.height - selected.h),
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, selected, layout?.width, layout?.height, updateItem, rotateSelected]);

  const addItem = (kind, extra = {}) => {
    const def = KINDS[kind];
    const it = { id: newId(), kind, x: 1, y: 1, w: def.w, h: def.h, rot: 0, label: kind === 'table' ? 'Упаковка' : '', rackKey: '', ...extra };
    setLayout((l) => ({ ...l, items: [...l.items, it] }));
    setSelectedId(it.id);
  };

  /** Расставить ещё не размещённые стеллажи рядами с проходами. */
  const autoPlace = () => {
    const sorted = [...unplacedRacks].sort((a, b) => compareText(a.key, b.key));
    const occupiedBottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    let x = 1;
    let y = occupiedBottom > 0 ? Math.ceil(occupiedBottom) + 2 : 1;
    const added = [];
    for (const r of sorted) {
      const cols = Math.max(...r.shelves.map((s) => s.cells.length), 1);
      const w = clamp(cols, 2, 10);
      if (x + w > layout.width - 1) {
        x = 1;
        y += 3;
      }
      added.push({ id: newId(), kind: 'rack', x, y, w, h: 1, label: '', rackKey: r.key });
      x += w + 1;
    }
    const needH = Math.max(layout.height, Math.ceil(y + 2));
    setLayout((l) => ({ ...l, height: Math.min(300, needH), items: [...l.items, ...added] }));
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await addressStorageApi.saveLayout(warehouseId, layout);
      setLayout(r);
      setSaved(JSON.stringify(r));
      setMessage({ ok: true, text: 'План сохранён' });
    } catch (e) {
      setMessage({ ok: false, text: addressStorageError(e).message });
    } finally {
      setBusy(false);
    }
  };

  if (!layout) return <p className="text-muted">Загрузка плана…</p>;

  const W = layout.width * cell;
  const H = layout.height * cell;
  const edit = mode === 'edit';

  return (
    <div className="address-layout">
      <div className="address-toolbar">
        <div className="erp-filter-row" style={{ marginBottom: 0 }}>
          <button type="button" className={`erp-filter-btn${!edit ? ' erp-filter-btn--active' : ''}`} onClick={() => setMode('view')}>
            Просмотр
          </button>
          <button type="button" className={`erp-filter-btn${edit ? ' erp-filter-btn--active' : ''}`} onClick={() => setMode('edit')}>
            Редактор
          </button>
        </div>
        {!edit ? (
          <div className="address-toolbar__picker">
            <ProductPicker
              warehouseId={warehouseId}
              placeholder="Где лежит товар?"
              onPick={(p) => setHighlight({ id: p.id, sku: p.sku, name: p.name })}
            />
          </div>
        ) : null}
        {highlight && !edit ? (
          <span className="address-highlight-info">
            <strong>{highlight.sku}</strong>:{' '}
            {hitRacks.size ? `стеллажи ${[...hitRacks].join(', ')}` : 'не размещён на этом складе'}
            <button type="button" className="btn btn-link btn-sm" onClick={() => setHighlight(null)}>
              сбросить
            </button>
          </span>
        ) : null}
        <div className="address-toolbar__spacer" />
        <label className="address-layout__zoom muted-hint">
          Масштаб
          <input type="range" min={12} max={40} value={cell} onChange={(e) => setCell(Number(e.target.value))} />
        </label>
        {dirty ? (
          <>
            <Button size="small" onClick={save} disabled={busy}>
              {busy ? '…' : 'Сохранить план'}
            </Button>
            <Button size="small" variant="secondary" onClick={() => setLayout(JSON.parse(saved))} disabled={busy}>
              Отменить
            </Button>
          </>
        ) : null}
      </div>

      {!edit ? <HeatControls metric={metric} onMetric={setMetric} days={days} onDays={setDays} /> : null}

      {edit ? (
        <div className="address-toolbar address-toolbar--secondary">
          <span className="muted-hint">Добавить:</span>
          {Object.entries(KINDS).map(([k, v]) => (
            <button key={k} type="button" className="btn btn-sm btn-secondary" onClick={() => addItem(k)}>
              {v.label}
            </button>
          ))}
          {unplacedRacks.length ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={autoPlace}>
              Расставить стеллажи ({unplacedRacks.length})
            </button>
          ) : null}
          <span className="muted-hint">
            Размер плана{' '}
            <input
              type="number"
              className="form-control form-control-sm address-layout__size"
              value={layout.width}
              min={5}
              max={300}
              onChange={(e) => setLayout((l) => ({ ...l, width: clamp(Number(e.target.value) || 5, 5, 300) }))}
            />
            ×
            <input
              type="number"
              className="form-control form-control-sm address-layout__size"
              value={layout.height}
              min={5}
              max={300}
              onChange={(e) => setLayout((l) => ({ ...l, height: clamp(Number(e.target.value) || 5, 5, 300) }))}
            />{' '}
            клеток
          </span>
        </div>
      ) : null}

      {message ? (
        <div className={`alert py-2 ${message.ok ? 'alert-success' : 'alert-danger'}`} role="status">
          {message.text}
        </div>
      ) : null}

      {!items.length && !edit ? (
        <div className="address-empty">
          <p>План склада ещё не нарисован.</p>
          <Button onClick={() => setMode('edit')}>Открыть редактор</Button>
        </div>
      ) : (
        <div className="address-layout__body">
          <div className="address-layout__canvas">
            <svg
              ref={svgRef}
              width={W}
              height={H}
              className={`address-layout__svg${edit ? ' address-layout__svg--edit' : ''}`}
              onPointerDown={(e) => {
                if (e.target === svgRef.current || e.target.dataset?.bg) setSelectedId(null);
              }}
            >
              <defs>
                <pattern id="address-grid" width={cell} height={cell} patternUnits="userSpaceOnUse">
                  <path d={`M ${cell} 0 L 0 0 0 ${cell}`} fill="none" stroke="#e9ecef" strokeWidth="1" />
                </pattern>
              </defs>
              <rect data-bg="1" width={W} height={H} fill={edit ? 'url(#address-grid)' : '#fcfcfd'} />
              {[...items]
                .sort((a, b) => (a.kind === 'zone' ? -1 : 0) - (b.kind === 'zone' ? -1 : 0))
                .map((it) => {
                  const st = itemStyle(it.kind);
                  const rack = it.kind === 'rack' ? rackByKey.get(it.rackKey) : null;
                  let fill = st.fill;
                  if (it.kind === 'rack' && !edit && rack) {
                    fill = metric === 'type' ? '#f1f3f5' : colorForHeat(metric, rackHeat(metric, rack.locations, statsById, rackShipMax));
                  }
                  const hit = it.kind === 'rack' && hitRacks.has(it.rackKey);
                  const missing = it.kind === 'rack' && it.rackKey && !rack;
                  const isSel = edit && it.id === selectedId;
                  const text = it.label || (it.kind === 'rack' ? it.rackKey || 'Стеллаж ?' : '');
                  const x = it.x * cell;
                  const y = it.y * cell;
                  const w = it.w * cell;
                  const h = it.h * cell;
                  const rot = normAngle(it.rot);
                  const cx = x + w / 2;
                  const cy = y + h / 2;
                  // Надпись вдоль длинной стороны и никогда не вверх ногами.
                  const vertical = it.kind !== 'zone' && h > w * 1.3;
                  const baseTextAngle = vertical ? -90 : 0;
                  const screenTextAngle = normAngle(rot + baseTextAngle);
                  const textAngle = baseTextAngle + (screenTextAngle > 90 && screenTextAngle <= 270 ? 180 : 0);
                  const [tw, th] = vertical ? [h, w] : [w, h];
                  const fontSize = Math.max(9, Math.min(14, Math.min(th * 0.6, (tw / Math.max(1, text.length)) * 1.6)));
                  return (
                    <g
                      key={it.id}
                      className={`address-layout__item address-layout__item--${it.kind}${hit ? ' address-layout__item--hit' : ''}`}
                      onPointerDown={(e) => {
                        if (!edit) return;
                        e.stopPropagation();
                        setSelectedId(it.id);
                        dragRef.current = { type: 'move', id: it.id, start: toCells(e), orig: { ...it } };
                      }}
                      onClick={() => {
                        if (!edit && it.kind === 'rack' && rack) setParam({ tab: 'racks', rack: rack.key });
                      }}
                    >
                      <title>
                        {it.kind === 'rack'
                          ? `${text}${rack ? ` · ${rack.locations.length} яч.` : missing ? ' · нет ячеек с таким стеллажом' : ''}`
                          : KINDS[it.kind]?.label}
                      </title>
                      <g transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}>
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        rx={it.kind === 'zone' ? 6 : 2}
                        fill={fill}
                        stroke={hit ? '#f76707' : missing ? '#fa5252' : isSel ? '#1c7ed6' : st.stroke}
                        strokeWidth={hit || isSel ? 3 : 1}
                        strokeDasharray={missing ? '4 3' : st.dash}
                      />
                      {text ? (
                        <text
                          x={it.kind === 'zone' ? x + 6 : cx}
                          y={it.kind === 'zone' ? y + 14 : cy}
                          fontSize={it.kind === 'zone' ? 12 : fontSize}
                          textAnchor={it.kind === 'zone' ? 'start' : 'middle'}
                          dominantBaseline={it.kind === 'zone' ? 'auto' : 'central'}
                          transform={it.kind !== 'zone' && textAngle ? `rotate(${textAngle} ${cx} ${cy})` : undefined}
                          className="address-layout__text"
                          fill={it.kind === 'wall' ? '#fff' : '#212529'}
                        >
                          {text}
                        </text>
                      ) : null}
                      {isSel ? (
                        <rect
                          x={x + w - 6}
                          y={y + h - 6}
                          width={10}
                          height={10}
                          fill="#1c7ed6"
                          className="address-layout__handle"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            dragRef.current = { type: 'resize', id: it.id, start: toCells(e), orig: { ...it, rot } };
                          }}
                        />
                      ) : null}
                      </g>
                    </g>
                  );
                })}
            </svg>
          </div>

          {edit && selected ? (
            <aside className="address-cell-panel">
              <div className="address-cell-panel__head">
                <strong>{KINDS[selected.kind]?.label}</strong>
                <button type="button" className="btn btn-link btn-sm" onClick={() => setSelectedId(null)} aria-label="Закрыть">
                  ✕
                </button>
              </div>
              <div className="address-generate">
                <label className="address-generate__row">
                  <span>Тип</span>
                  <select
                    className="form-select form-select-sm"
                    value={selected.kind}
                    onChange={(e) => updateItem(selected.id, { kind: e.target.value })}
                  >
                    {Object.entries(KINDS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selected.kind === 'rack' ? (
                  <label className="address-generate__row">
                    <span>Стеллаж</span>
                    <select
                      className="form-select form-select-sm"
                      value={selected.rackKey}
                      onChange={(e) => updateItem(selected.id, { rackKey: e.target.value })}
                    >
                      <option value="">— не выбран —</option>
                      {racks.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.key || 'Ячейки'} ({r.locations.length} яч.){placedKeys.has(r.key) && r.key !== selected.rackKey ? ' · уже на плане' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="address-generate__row">
                  <span>Подпись</span>
                  <input
                    className="form-control form-control-sm"
                    value={selected.label}
                    maxLength={64}
                    placeholder={selected.kind === 'rack' ? 'по умолчанию — код стеллажа' : ''}
                    onChange={(e) => updateItem(selected.id, { label: e.target.value })}
                  />
                </label>
                {['x', 'y', 'w', 'h'].map((k) => (
                  <label key={k} className="address-generate__row">
                    <span>{{ x: 'X', y: 'Y', w: 'Ширина', h: 'Глубина' }[k]}</span>
                    <input
                      type="number"
                      step={0.5}
                      className="form-control form-control-sm"
                      value={selected[k]}
                      onChange={(e) => updateItem(selected.id, { [k]: snap(Number(e.target.value) || 0) })}
                    />
                  </label>
                ))}
                <label className="address-generate__row">
                  <span>Угол, °</span>
                  <span className="address-moves__field">
                    <input
                      type="number"
                      step={15}
                      min={0}
                      max={359}
                      className="form-control form-control-sm"
                      value={normAngle(selected.rot)}
                      onChange={(e) => updateItem(selected.id, { rot: normAngle(e.target.value) })}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      title="Повернуть на 90° (клавиша R)"
                      onClick={rotateSelected}
                    >
                      ⟳ 90°
                    </button>
                  </span>
                </label>
              </div>
              <p className="muted-hint">
                Перетаскивайте мышью, синий уголок — изменить размер. Стрелки — сдвиг, R — повернуть на 90°, Delete —
                удалить.
              </p>
              <div className="address-cell-panel__actions">
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => addItem(selected.kind, { ...selected, id: newId(), x: selected.x + 1, y: selected.y + 1, rackKey: '' })}
                >
                  Дублировать
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    setLayout((l) => ({ ...l, items: l.items.filter((it) => it.id !== selected.id) }));
                    setSelectedId(null);
                  }}
                >
                  Удалить
                </button>
              </div>
            </aside>
          ) : null}
        </div>
      )}
      {!edit && items.length ? (
        <p className="muted-hint mt-2">Нажмите на стеллаж, чтобы открыть его ячейки.</p>
      ) : null}
    </div>
  );
}

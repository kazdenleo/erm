/**
 * Прогресс поставки FBO: % выполнения (приёмка / сборка / упаковка).
 * Общий % — по нормам сек/шт, если есть; иначе среднее трёх этапов.
 */

import React, { useMemo } from 'react';

function clamp01(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function stagePct(done, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return clamp01((Number(done) || 0) / t);
}

function StageRow({ label, pct, done, total, pending = false }) {
  const p = Math.round(pct * 100);
  return (
    <div className="fbo-supply-progress__stage">
      <div className="fbo-supply-progress__stage-head">
        <span className="fbo-supply-progress__stage-label">{label}</span>
        <span className="fbo-supply-progress__stage-meta">
          {pending ? '…' : total > 0 ? `${p}%` : '—'}
        </span>
      </div>
      <div
        className="fbo-supply-progress__bar fbo-supply-progress__bar--sm"
        role="progressbar"
        aria-valuenow={pending ? 0 : p}
        aria-valuemin={0}
        aria-valuemax={100}
        title={pending ? undefined : total > 0 ? `${done}/${total}` : undefined}
      >
        <div
          className={[
            'fbo-supply-progress__bar-fill',
            p >= 100 && !pending ? 'fbo-supply-progress__bar-fill--done' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ width: pending ? '0%' : `${p}%` }}
        />
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.row
 * @param {object|null} props.norms
 * @param {boolean} [props.reserveLoading]
 */
export function FboSupplyProgress({ row, norms, reserveLoading = false }) {
  const model = useMemo(() => {
    const qty = Math.max(Number(row?.itemCount) || 0, 0);
    const reserveOn = row?.deductStock !== false;
    const stock = Number(row?.reservedFromStockTotal ?? row?.reserved_from_stock_total) || 0;
    const path = Number(row?.reservedFromIncomingTotal ?? row?.reserved_from_incoming_total) || 0;
    const covered = reserveOn ? Math.min(stock + path, qty) : qty;
    const collected = Math.min(Math.max(Number(row?.collectedTotal) || 0, 0), qty || Infinity);
    const packed = Math.min(Math.max(Number(row?.packedTotal) || 0, 0), qty || Infinity);

    const receiptPct = qty > 0 ? stagePct(covered, qty) : 0;
    const collectPct = qty > 0 ? stagePct(collected, qty) : 0;
    const packPct = qty > 0 ? stagePct(packed, qty) : 0;

    const receiptSec = Number(norms?.receiptFboSecPerUnit);
    const collectSec = Number(norms?.fboCollectSecPerUnit);
    const packSec = Number(norms?.packingSecPerUnit);

    const stages = [];
    if (reserveOn) {
      stages.push({
        done: covered,
        weight:
          Number.isFinite(receiptSec) && receiptSec > 0
            ? receiptSec
            : null,
        pending: reserveLoading,
      });
    }
    stages.push({
      done: Math.min(collected, qty),
      weight: Number.isFinite(collectSec) && collectSec > 0 ? collectSec : null,
      pending: false,
    });
    stages.push({
      done: Math.min(packed, qty),
      weight: Number.isFinite(packSec) && packSec > 0 ? packSec : null,
      pending: false,
    });

    const active = stages.filter((s) => !s.pending);
    const withNorms = active.filter((s) => s.weight != null);
    let overall = 0;
    if (qty > 0 && active.length) {
      if (withNorms.length) {
        let totalW = 0;
        let doneW = 0;
        for (const s of withNorms) {
          const w = s.weight * qty;
          totalW += w;
          doneW += s.weight * Math.min(s.done, qty);
        }
        overall = totalW > 0 ? clamp01(doneW / totalW) : 0;
      } else {
        overall = clamp01(
          active.reduce((sum, s) => sum + stagePct(s.done, qty), 0) / active.length
        );
      }
    }

    const coveredPending = reserveOn && reserveLoading;
    return {
      qty,
      covered: reserveOn ? covered : qty,
      coveredPending,
      collected: qty > 0 ? Math.min(collected, qty) : collected,
      packed: qty > 0 ? Math.min(packed, qty) : packed,
      receiptPct: reserveOn ? receiptPct : 1,
      collectPct,
      packPct,
      overall,
      overallPct: Math.round(overall * 100),
      showReceipt: reserveOn,
      allDone: qty > 0 && overall >= 1,
    };
  }, [row, norms, reserveLoading]);

  if (!model.qty) {
    return <span className="muted">—</span>;
  }

  return (
    <div
      className={[
        'fbo-supply-progress',
        model.allDone ? 'fbo-supply-progress--done' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={(e) => e.stopPropagation()}
      title={
        model.coveredPending
          ? 'Считаем покрытие наличием…'
          : `Выполнено ${model.overallPct}% (приёмка / сборка / упаковка)`
      }
    >
      <div className="fbo-supply-progress__overall">
        <span
          className={[
            'fbo-supply-progress__overall-pct',
            model.allDone ? 'fbo-supply-progress__overall-pct--done' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {model.coveredPending && model.overallPct === 0 ? '…' : `${model.overallPct}%`}
        </span>
        <div
          className="fbo-supply-progress__bar fbo-supply-progress__bar--lg"
          role="progressbar"
          aria-valuenow={model.overallPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={[
              'fbo-supply-progress__bar-fill',
              model.allDone ? 'fbo-supply-progress__bar-fill--done' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ width: `${model.overallPct}%` }}
          />
        </div>
      </div>
      {model.showReceipt ? (
        <StageRow
          label="Приёмка"
          pct={model.receiptPct}
          done={model.covered}
          total={model.qty}
          pending={model.coveredPending}
        />
      ) : null}
      <StageRow label="Сборка" pct={model.collectPct} done={model.collected} total={model.qty} />
      <StageRow label="Упаковка" pct={model.packPct} done={model.packed} total={model.qty} />
    </div>
  );
}

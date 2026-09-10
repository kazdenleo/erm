/**
 * Вкладка «Этикетки»: совместный сбор по поставке FBO — скан → печать этикетки, прогресс собрано/нужно.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import {
  useProductLabelPrint,
  canUsePrintHelper,
  openProductLabelPrintTab,
  buildProductLabelPrintPageUrl,
} from '../../hooks/useProductLabelPrint.js';
import { packedCellClass } from './fboPackedCell.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';

const POLL_MS = 3000;

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function closePrintSlot(slot) {
  if (!slot || slot.closed) return;
  try {
    slot.close();
  } catch {
    /* ignore */
  }
}

export function FboSupplyCollect({
  supplyId,
  marketplace = 'ozon',
  itemSearchQuery = '',
  printHelperUrl = '',
}) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState(null);
  const [lastMsg, setLastMsg] = useState(null);
  const [overagePrompt, setOveragePrompt] = useState(null);
  const [manualPrintingId, setManualPrintingId] = useState(null);
  const scanLockRef = useRef(false);
  const { printProductLabel, printing, error: printHookError, setError: setPrintHookError } =
    useProductLabelPrint(printHelperUrl);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!supplyId) return;
      if (!silent) setLoading(true);
      try {
        const data = await fboSuppliesApi.getCollect(supplyId);
        setState(data);
        if (!silent) setErr(null);
      } catch (e) {
        if (!silent) {
          setErr(e.response?.data?.message || e.message || 'Не удалось загрузить сбор');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [supplyId]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!supplyId) return undefined;
    const t = setInterval(() => {
      load({ silent: true });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [supplyId, load]);

  const items = state?.items || [];
  const searchActive = Boolean(normalizeProductSearchQuery(itemSearchQuery));
  const filteredItems = useMemo(() => {
    if (!searchActive) return items;
    return filterSupplyItemsByQuery(items, itemSearchQuery);
  }, [items, itemSearchQuery, searchActive]);

  const sendToPrinter = useCallback(
    async (printInfo, printSlot = null) => {
      if (!printInfo?.productId) {
        closePrintSlot(printSlot);
        return false;
      }
      const copies = Math.max(1, Math.min(99, Number(printInfo.copies) || 1));
      const mp = printInfo.marketplace || marketplace || undefined;
      const pageUrl = buildProductLabelPrintPageUrl(printInfo.productId, copies, mp);

      // Вкладка, открытая синхронно по жесту скана — обходим блокировку popup после await.
      if (printSlot && !printSlot.closed) {
        try {
          printSlot.location.href = pageUrl;
          printSlot.focus?.();
          return true;
        } catch {
          closePrintSlot(printSlot);
        }
      }

      if (canUsePrintHelper(printHelperUrl) && copies === 1) {
        const ok = await printProductLabel(printInfo.productId, { copies, marketplace: mp });
        if (ok) return true;
      }

      const opened = openProductLabelPrintTab(printInfo.productId, copies, mp);
      if (!opened) {
        setErr(
          'Не удалось открыть печать. Разрешите всплывающие окна или нажмите 🖨️ у строки.'
        );
      }
      return opened;
    },
    [marketplace, printHelperUrl, printProductLabel]
  );

  const applyScanResult = useCallback(
    async (data, printSlot = null) => {
      if (data?.state) setState(data.state);
      const collected = data?.item?.collected;
      const planned = data?.item?.planned;
      const sku = data?.item?.sku || data?.print?.title || '';
      const kitProg = data?.kitProgress;
      let msg = data?.message || data?.warning || null;
      if (!msg) {
        if (data?.action === 'kit_progress' && kitProg) {
          msg = `Комплект ${sku}: комплектующие ${kitProg.scannedPieces}/${kitProg.needPieces} — этикетка после полного набора`;
        } else {
          msg = `Собрано ${collected} из ${planned}: ${sku}`;
        }
      }
      setLastMsg(msg);
      playEventSound(SOUND_EVENTS.scan_ok);

      if (data?.print?.productId) {
        const ok = await sendToPrinter(data.print, printSlot);
        if (ok) {
          setLastMsg(`${msg} · этикетка отправлена на печать`);
        }
      } else {
        closePrintSlot(printSlot);
      }
    },
    [sendToPrinter]
  );

  const doScan = useCallback(
    async (barcode, { allowOverage = false } = {}) => {
      const code = String(barcode || '').trim();
      if (!code || !supplyId || scanLockRef.current) return;
      scanLockRef.current = true;
      setScanning(true);
      setErr(null);
      setPrintHookError?.(null);

      // Синхронно по событию скана (Enter) — иначе браузер режет window.open после await.
      const useHelper = canUsePrintHelper(printHelperUrl);
      const printSlot = useHelper ? null : window.open('about:blank', '_blank');

      try {
        const data = await fboSuppliesApi.collectScan(supplyId, {
          barcode: code,
          allowOverage,
        });
        await applyScanResult(data, printSlot);
      } catch (e) {
        closePrintSlot(printSlot);
        const codeErr = e.response?.data?.code;
        const msg = e.response?.data?.message || e.message || 'Ошибка скана';
        if (codeErr === 'COLLECT_OVERAGE' && !allowOverage) {
          playEventSound(SOUND_EVENTS.scan_error);
          setOveragePrompt({
            barcode: code,
            message: msg,
            sku: e.response?.data?.sku,
            planned: e.response?.data?.planned,
            collected: e.response?.data?.collected,
          });
        } else {
          playEventSound(SOUND_EVENTS.scan_error);
          setErr(msg);
        }
      } finally {
        setScanning(false);
        scanLockRef.current = false;
      }
    },
    [supplyId, applyScanResult, printHelperUrl, setPrintHookError]
  );

  const confirmOverage = async () => {
    const code = overagePrompt?.barcode;
    setOveragePrompt(null);
    if (code) await doScan(code, { allowOverage: true });
  };

  const handleManualPrint = async (it) => {
    if (!it?.productId || manualPrintingId) return;
    setManualPrintingId(it.id);
    setErr(null);
    setPrintHookError?.(null);
    try {
      const ok = await sendToPrinter({
        productId: it.productId,
        copies: 1,
        marketplace: marketplace || undefined,
        title: it.sku || it.productName || it.name,
      });
      if (ok) {
        setLastMsg(`Этикетка: ${it.sku || it.productName || it.productId}`);
      }
    } finally {
      setManualPrintingId(null);
    }
  };

  if (loading && !state) {
    return <div className="fbo-collect-panel">Загрузка сбора…</div>;
  }

  return (
    <div className="fbo-collect-panel">
      <p className="fbo-packing-hint">
        Сканируйте товар из поставки или комплектующие комплекта. Этикетка печатается для обычного
        товара сразу; для комплекта — только после скана всего SKU комплекта или всех комплектующих.
        Несколько сотрудников могут работать одновременно; прогресс общий.
      </p>

      {(state?.activeUsers || []).length > 0 ? (
        <div className="fbo-collect-users" aria-live="polite">
          Сейчас работают: {state.activeUsers.map((u) => u.userName).join(', ')}
        </div>
      ) : null}

      <div className="fbo-collect-summary muted-hint">
        Собрано {state?.collectedTotal ?? 0} из {state?.plannedTotal ?? 0}
        {state?.itemCount != null
          ? ` · позиций готово: ${state.completeCount ?? 0}/${state.itemCount}`
          : null}
      </div>

      <div className="fbo-packing-scan-row">
        <BarcodeScanField
          id={`fbo-collect-scan-${supplyId}`}
          label="Скан для этикетки"
          placeholder="Штрихкод / артикул товара или комплектующей"
          disabled={scanning || printing}
          loading={scanning || printing}
          onScan={(code) => doScan(code)}
          enableGlobalCapture
        />
      </div>

      {lastMsg ? <div className="alert alert-success fbo-collect-flash">{lastMsg}</div> : null}
      {err || printHookError ? (
        <div className="alert alert-danger">{err || printHookError}</div>
      ) : null}

      <div className="table-responsive fbo-collect-table-wrap">
        <table className="table table-sm fbo-items-table">
          <thead>
            <tr>
              <th>Артикул</th>
              <th>Товар</th>
              <th>Комплектующие</th>
              <th className="text-end">Собрано / нужно</th>
              <th className="text-center" style={{ width: 52 }}>
                Печать
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted">
                  {searchActive ? 'Ничего не найдено' : 'Нет позиций'}
                </td>
              </tr>
            ) : (
              filteredItems.map((it) => {
                const cls = packedCellClass(it.collected, it.planned);
                const comps = it.kitComponents || [];
                return (
                  <tr
                    key={it.id}
                    className={[
                      it.complete ? 'fbo-item-row--complete' : '',
                      it.collected > 0 && !it.complete ? 'fbo-item-row--partial' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td>
                      <code>{it.sku || '—'}</code>
                    </td>
                    <td>
                      <div className="fbo-collect-item-name">
                        {it.productName || it.name || '—'}
                      </div>
                    </td>
                    <td>
                      {it.isKit && comps.length > 0 ? (
                        <ul className="fbo-collect-kit-comps">
                          {comps.map((c) => (
                            <li key={c.productId}>
                              <code>{c.sku || `#${c.productId}`}</code>
                              <span className="muted-hint">
                                {' '}
                                ×{c.need}
                                {c.got > 0 ? ` (${c.got}/${c.need})` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="text-end">
                      <span className={`fbo-packed-cell fbo-packed-cell--${cls}`}>
                        {it.collected} / {it.planned}
                      </span>
                      {it.isKit && it.kitProgress && it.kitProgress.needPieces > 0 && !it.complete ? (
                        <div className="fbo-collect-kit-progress muted-hint">
                          к комплекту: {it.kitProgress.scannedPieces}/{it.kitProgress.needPieces}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        className="btn btn-link btn-sm fbo-collect-print-btn"
                        title="Печать 1 этикетки"
                        disabled={!it.productId || manualPrintingId === it.id || printing}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleManualPrint(it);
                        }}
                      >
                        {manualPrintingId === it.id ? '…' : '🖨️'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {(state?.recentScans || []).length > 0 ? (
        <div className="fbo-collect-recent">
          <div className="fbo-packing-section-title">Последние сканы</div>
          <ul className="fbo-collect-recent-list">
            {state.recentScans.slice(0, 12).map((s) => (
              <li key={s.id}>
                <span className="muted-hint">{fmtTime(s.createdAt)}</span>{' '}
                {s.userName || 'Сотрудник'}: <code>{s.itemSku || s.barcode || '—'}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Modal
        isOpen={Boolean(overagePrompt)}
        onClose={() => setOveragePrompt(null)}
        title="План уже выполнен"
        size="small"
      >
        <p style={{ marginTop: 0 }}>{overagePrompt?.message}</p>
        <p className="text-muted">Добавить сверх плана и всё равно напечатать этикетку?</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={() => setOveragePrompt(null)}>
            Не добавлять
          </Button>
          <Button type="button" variant="primary" onClick={confirmOverage}>
            Добавить сверх плана
          </Button>
        </div>
      </Modal>
    </div>
  );
}

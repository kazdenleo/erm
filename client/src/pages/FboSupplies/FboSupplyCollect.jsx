/**
 * Вкладка «Этикетки»: совместный сбор по поставке FBO — скан → печать этикетки, прогресс собрано/нужно.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';
import { useProductLabelPrint } from '../../hooks/useProductLabelPrint.js';
import { packedCellClass } from './fboPackedCell.js';
import { filterSupplyItemsByQuery, normalizeProductSearchQuery } from '../../utils/productSearch';

const POLL_MS = 3000;

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
  const scanLockRef = useRef(false);
  const { printProductLabel, printing } = useProductLabelPrint(printHelperUrl);

  const load = useCallback(async ({ silent = false } = {}) => {
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
  }, [supplyId]);

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

  const runPrint = useCallback(
    async (printInfo) => {
      if (!printInfo?.productId) return;
      try {
        await printProductLabel(printInfo.productId, printInfo.copies || 1, {
          marketplace: printInfo.marketplace || marketplace || undefined,
        });
      } catch {
        /* сообщение уже в хуке / не блокируем сбор */
      }
    },
    [marketplace, printProductLabel]
  );

  const applyScanResult = useCallback(
    async (data) => {
      if (data?.state) setState(data.state);
      const collected = data?.item?.collected;
      const planned = data?.item?.planned;
      const sku = data?.item?.sku || data?.print?.title || '';
      const via =
        data?.match === 'kit_component'
          ? ` (по комплектующей${data.scannedComponentSku ? ` ${data.scannedComponentSku}` : ''})`
          : '';
      setLastMsg(
        data?.warning ||
          `Собрано ${collected} из ${planned}: ${sku}${via}`
      );
      if (data?.warning || data?.item?.complete) {
        playEventSound(SOUND_EVENTS.scan_ok);
      } else {
        playEventSound(SOUND_EVENTS.scan_ok);
      }
      await runPrint(data?.print);
    },
    [runPrint]
  );

  const doScan = useCallback(
    async (barcode, { allowOverage = false } = {}) => {
      const code = String(barcode || '').trim();
      if (!code || !supplyId || scanLockRef.current) return;
      scanLockRef.current = true;
      setScanning(true);
      setErr(null);
      try {
        const data = await fboSuppliesApi.collectScan(supplyId, { barcode: code, allowOverage });
        await applyScanResult(data);
      } catch (e) {
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
    [supplyId, applyScanResult]
  );

  const confirmOverage = async () => {
    const code = overagePrompt?.barcode;
    setOveragePrompt(null);
    if (code) await doScan(code, { allowOverage: true });
  };

  if (loading && !state) {
    return <div className="fbo-collect-panel">Загрузка сбора…</div>;
  }

  return (
    <div className="fbo-collect-panel">
      <p className="fbo-packing-hint">
        Сканируйте товар из поставки или комплектующую комплекта — напечатается этикетка позиции поставки.
        Несколько сотрудников могут работать одновременно; прогресс общий.
      </p>

      {(state?.activeUsers || []).length > 0 ? (
        <div className="fbo-collect-users" aria-live="polite">
          Сейчас работают:{' '}
          {state.activeUsers.map((u) => u.userName).join(', ')}
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
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="table-responsive fbo-collect-table-wrap">
        <table className="table table-sm fbo-items-table">
          <thead>
            <tr>
              <th>Артикул</th>
              <th>Товар</th>
              <th className="text-end">Собрано / нужно</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-muted">
                  {searchActive ? 'Ничего не найдено' : 'Нет позиций'}
                </td>
              </tr>
            ) : (
              filteredItems.map((it) => {
                const cls = packedCellClass(it.collected, it.planned);
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
                    <td className="text-end">
                      <span className={`fbo-packed-cell fbo-packed-cell--${cls}`}>
                        {it.collected} / {it.planned}
                      </span>
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
        <p className="text-muted">
          Добавить сверх плана и всё равно напечатать этикетку?
        </p>
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

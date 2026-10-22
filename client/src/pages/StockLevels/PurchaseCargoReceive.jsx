/**
 * Грузоместа в приёмке: скан места → скан товаров внутри → оформление через приёмку.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarcodeScanField } from '../../components/common/BarcodeScanField/BarcodeScanField';
import { Button } from '../../components/common/Button/Button';
import {
  purchaseCargoApi,
  purchaseCargoErrorCode,
  purchaseCargoErrorData,
} from '../../services/purchaseCargo.api';
import { purchasesApi } from '../../services/purchases.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { playEventSound, SOUND_EVENTS } from '../../utils/soundSettings';

const MULTIPLIERS = [1, 5, 10, 20];

const CARGO_PLACE_STATUS_LABEL = {
  accepted: 'Принято',
  opened: 'В работе',
  closed: 'Разобрано',
  received: 'Оприходовано',
};

function cargoPlaceStatusLabel(status) {
  return CARGO_PLACE_STATUS_LABEL[String(status || '')] || String(status || '—');
}

function fmtDt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function applyCargoState(data, setState, setExpectedDraft) {
  setState(data);
  setExpectedDraft(
    data?.expectedCargoPlaces != null && data.expectedCargoPlaces !== ''
      ? String(data.expectedCargoPlaces)
      : ''
  );
}

export function PurchaseCargoReceive({
  purchaseId,
  editable = true,
  currentUserId = null,
  /** В модалке приёмки: скрываем дубль «Оформить приёмку» (есть в шапке). */
  embeddedInReceipt = false,
  /** Скан мест и ожидаемое число (вкладка «Приёмка»). */
  showScan = true,
  /** Список мест, разбор и состав (вкладка «Состав грузомест»). */
  showList = true,
  onChanged = null,
}) {
  const [cargoState, setCargoState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expectedDraft, setExpectedDraft] = useState('');
  const [message, setMessage] = useState(null);
  const [activePlaceId, setActivePlaceId] = useState(null);
  const [placeData, setPlaceData] = useState(null);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [completeBusy, setCompleteBusy] = useState(false);
  const busyRef = useRef(false);
  const purchaseIdRef = useRef(purchaseId);
  purchaseIdRef.current = purchaseId;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refreshPurchase = useCallback(async ({ notify = true } = {}) => {
    const pid = Number(purchaseIdRef.current);
    if (!Number.isFinite(pid) || pid < 1) {
      setCargoState(null);
      return null;
    }
    const data = await purchaseCargoApi.getPurchase(pid);
    applyCargoState(data, setCargoState, setExpectedDraft);
    if (notify) {
      try {
        onChangedRef.current?.(data);
      } catch {
        /* ignore */
      }
    }
    return data;
  }, []);

  useEffect(() => {
    if (!showList && activePlaceId) {
      setActivePlaceId(null);
      setPlaceData(null);
    }
  }, [showList, activePlaceId]);

  useEffect(() => {
    let cancelled = false;
    const pid = Number(purchaseId);
    if (!Number.isFinite(pid) || pid < 1) {
      setCargoState(null);
      setActivePlaceId(null);
      setPlaceData(null);
      return undefined;
    }
    setLoading(true);
    setActivePlaceId(null);
    setPlaceData(null);
    setMessage(null);
    purchaseCargoApi
      .getPurchase(pid)
      .then((data) => {
        if (!cancelled) applyCargoState(data, setCargoState, setExpectedDraft);
      })
      .catch(() => {
        if (!cancelled) setCargoState(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [purchaseId]);

  const runBusy = useCallback(async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const openPlacePanel = useCallback(async (placeId) => {
    const id = Number(placeId);
    if (!Number.isFinite(id) || id < 1) return;
    setPlaceLoading(true);
    setMessage(null);
    setActivePlaceId(id);
    try {
      let next = await purchaseCargoApi.getPlace(id);
      if (next?.place?.status === 'accepted') {
        next = await purchaseCargoApi.openPlace(id);
      }
      setPlaceData(next);
      await refreshPurchase({ notify: false });
    } catch (e) {
      setMessage({ kind: 'error', text: getApiErrorMessage(e, 'Не удалось открыть грузоместо') });
      setActivePlaceId(null);
      setPlaceData(null);
    } finally {
      setPlaceLoading(false);
    }
  }, [refreshPurchase]);

  const closePlacePanel = useCallback(() => {
    setActivePlaceId(null);
    setPlaceData(null);
  }, []);

  const acceptPlace = useCallback(
    async (code, { force = false, forceExceed = false } = {}) => {
      const pid = Number(purchaseId);
      const res = await purchaseCargoApi.acceptPlace(pid, code, { force, forceExceed });
      applyCargoState(res.state, setCargoState, setExpectedDraft);
      if (res.alreadyAccepted) {
        playEventSound(SOUND_EVENTS.scan_ok);
        const place = (res.state?.places || []).find((p) => Number(p.id) === Number(res.placeId));
        if (
          place &&
          (place.status === 'accepted' || place.status === 'opened' || place.status === 'closed')
        ) {
          if (window.confirm(`Грузоместо «${code}» уже принято.\n\nПерейти к приёмке товара из него?`)) {
            await openPlacePanel(res.placeId);
          }
        } else {
          setMessage({ kind: 'warning', text: `${code}: товар из этого места уже оприходован` });
        }
        return;
      }
      const total = (res.state?.places || []).length;
      const expected = res.state?.expectedCargoPlaces;
      setMessage({
        kind: 'success',
        text: `Принято грузоместо ${code} · ${expected != null ? `${total} из ${expected}` : `всего ${total}`}`,
      });
      playEventSound(SOUND_EVENTS.scan_ok);
    },
    [purchaseId, openPlacePanel]
  );

  const handlePlaceScan = useCallback(
    (raw) => {
      const code = String(raw || '').trim();
      if (!code || !editable) return;
      runBusy(async () => {
        setMessage(null);
        try {
          await acceptPlace(code);
        } catch (e) {
          playEventSound(SOUND_EVENTS.scan_error);
          const errCode = purchaseCargoErrorCode(e);
          if (errCode === 'PRODUCT_BARCODE') {
            if (
              window.confirm(
                `${getApiErrorMessage(e, 'Похоже на штрихкод товара')}.\n\nВсё равно принять как грузоместо?`
              )
            ) {
              try {
                await acceptPlace(code, { force: true });
              } catch (err) {
                setMessage({ kind: 'error', text: getApiErrorMessage(err) });
              }
            }
            return;
          }
          if (errCode === 'EXPECTED_EXCEEDED') {
            const extra = purchaseCargoErrorData(e);
            const accepted = extra?.accepted ?? cargoState?.places?.length;
            const expected = extra?.expected ?? cargoState?.expectedCargoPlaces;
            if (
              window.confirm(
                `Уже принято ${accepted} из ${expected} грузомест.\n\nДобавить ещё одно грузоместо?`
              )
            ) {
              try {
                await acceptPlace(code, { forceExceed: true });
              } catch (err) {
                setMessage({ kind: 'error', text: getApiErrorMessage(err) });
              }
            }
            return;
          }
          setMessage({
            kind: 'error',
            text: `${code}: ${getApiErrorMessage(e, 'Не удалось принять грузоместо')}`,
          });
        }
      });
    },
    [acceptPlace, cargoState?.expectedCargoPlaces, cargoState?.places?.length, editable, runBusy]
  );

  const handleProductScan = useCallback(
    (raw) => {
      const code = String(raw || '').trim();
      if (!code || !activePlaceId || !editable) return;
      runBusy(async () => {
        setMessage(null);
        try {
          const res = await purchaseCargoApi.addItem(activePlaceId, {
            code,
            quantity: multiplier,
          });
          setPlaceData(res);
          setMultiplier(1);
          await refreshPurchase();
          const name = res.product?.name || res.product?.sku || code;
          if (res.product?.inPurchase) {
            setMessage({ kind: 'success', text: `+${res.added} · ${name}` });
            playEventSound(SOUND_EVENTS.scan_ok);
          } else {
            setMessage({
              kind: 'warning',
              text: `+${res.added} · ${name} — этого товара нет в закупке`,
            });
            playEventSound(SOUND_EVENTS.scan_error);
          }
        } catch (e) {
          playEventSound(SOUND_EVENTS.scan_error);
          const errCode = purchaseCargoErrorCode(e);
          if (errCode === 'CARGO_PLACE_BARCODE') {
            const otherId = Number(purchaseCargoErrorData(e)?.placeId);
            if (otherId === Number(activePlaceId)) {
              setMessage({ kind: 'warning', text: 'Это штрихкод текущего грузоместа' });
              return;
            }
            if (
              Number.isFinite(otherId) &&
              otherId > 0 &&
              window.confirm('Это штрихкод другого грузоместа. Закрыть текущее и перейти к нему?')
            ) {
              try {
                if (placeData?.place?.status === 'opened') {
                  await purchaseCargoApi.closePlace(activePlaceId);
                }
                await openPlacePanel(otherId);
              } catch (err) {
                setMessage({ kind: 'error', text: getApiErrorMessage(err) });
              }
            }
            return;
          }
          setMessage({
            kind: errCode === 'CIS_DUPLICATE' ? 'warning' : 'error',
            text: `${code}: ${getApiErrorMessage(e, 'Товар не найден')}`,
          });
        }
      });
    },
    [
      activePlaceId,
      editable,
      multiplier,
      openPlacePanel,
      placeData?.place?.status,
      refreshPurchase,
      runBusy,
    ]
  );

  const changeItemQty = async (item, quantity) => {
    if (!activePlaceId || !editable) return;
    await runBusy(async () => {
      try {
        const next = await purchaseCargoApi.setItemQuantity(activePlaceId, item.productId, quantity);
        setPlaceData(next);
        await refreshPurchase();
      } catch (e) {
        setMessage({ kind: 'error', text: getApiErrorMessage(e) });
      }
    });
  };

  const saveExpected = async () => {
    if (!editable || busy) return;
    const trimmed = String(expectedDraft || '').trim();
    let value = null;
    if (trimmed !== '') {
      value = Math.floor(Number(trimmed.replace(/\D+/g, '')));
      if (!Number.isFinite(value) || value < 0) {
        setMessage({ kind: 'error', text: 'Некорректное ожидаемое число грузомест' });
        return;
      }
    }
    await runBusy(async () => {
      try {
        const data = await purchaseCargoApi.setExpected(purchaseId, value);
        applyCargoState(data, setCargoState, setExpectedDraft);
        setMessage({ kind: 'success', text: 'Ожидаемое число мест сохранено' });
      } catch (e) {
        setMessage({
          kind: 'error',
          text: getApiErrorMessage(e, 'Не удалось сохранить ожидаемое число грузомест'),
        });
      }
    });
  };

  const removePlace = async (place) => {
    if (!place?.id || !editable || busy) return;
    if (
      !window.confirm(
        `Удалить грузоместо «${place.barcode}»? Можно только если в нём ещё нет принятого товара.`
      )
    ) {
      return;
    }
    await runBusy(async () => {
      try {
        const data = await purchaseCargoApi.removePlace(place.id);
        applyCargoState(data, setCargoState, setExpectedDraft);
        if (Number(activePlaceId) === Number(place.id)) closePlacePanel();
      } catch (e) {
        setMessage({ kind: 'error', text: getApiErrorMessage(e, 'Не удалось удалить грузоместо') });
      }
    });
  };

  const closeActivePlace = async () => {
    if (!activePlaceId) return;
    const items = placeData?.items || [];
    if (items.length === 0 && !window.confirm('Грузоместо пустое. Закрыть место без товара?')) {
      return;
    }
    await runBusy(async () => {
      try {
        await purchaseCargoApi.closePlace(activePlaceId);
        await refreshPurchase();
        closePlacePanel();
        setMessage({ kind: 'success', text: 'Грузоместо закрыто' });
      } catch (e) {
        setMessage({ kind: 'error', text: getApiErrorMessage(e) });
      }
    });
  };

  const completeReceipt = async () => {
    const receipt = cargoState?.receipt;
    const warehouseId = cargoState?.purchase?.warehouseId ?? cargoState?.purchase?.warehouse_id;
    if (!receipt?.id) return;
    const places = cargoState?.places || [];
    const withoutItems = places.filter((p) => p.status === 'accepted').length;
    const inProgress = places.filter((p) => p.status === 'opened').length;
    const expected = cargoState?.expectedCargoPlaces;
    const warnings = [];
    if (expected != null && places.length < expected) {
      warnings.push(`Принято мест: ${places.length} из ${expected}.`);
    }
    if (withoutItems) warnings.push(`Мест без разбора товара: ${withoutItems}.`);
    if (inProgress) warnings.push(`Не закрыто мест: ${inProgress}.`);
    if (
      !window.confirm(
        [`Оформить приёмку? Будет оприходовано ${receipt.scannedTotal} шт.`, ...warnings]
          .filter(Boolean)
          .join('\n')
      )
    ) {
      return;
    }
    setCompleteBusy(true);
    setMessage(null);
    try {
      await purchasesApi.completeReceipt(receipt.id, warehouseId ? { warehouseId } : {});
      await refreshPurchase();
      closePlacePanel();
      setMessage({ kind: 'success', text: 'Приёмка оформлена — товар оприходован на склад' });
    } catch (e) {
      setMessage({ kind: 'error', text: getApiErrorMessage(e, 'Не удалось оформить приёмку') });
    } finally {
      setCompleteBusy(false);
    }
  };

  const places = cargoState?.places || [];
  const receipt = cargoState?.receipt;
  const doneCount = places.filter((p) => p.status === 'closed' || p.status === 'received').length;
  const isReceiptOwner =
    !receipt?.createdByUserId ||
    (currentUserId != null && Number(receipt.createdByUserId) === Number(currentUserId));

  const placeEditable =
    placeData?.place?.status === 'opened' || placeData?.place?.status === 'closed';

  const activePlaceItems = placeData?.items || [];
  const activeTotalQty = useMemo(
    () => activePlaceItems.reduce((s, i) => s + (Number(i.quantity) || 0), 0),
    [activePlaceItems]
  );

  if (loading && !cargoState) {
    if (!showScan && !showList) return null;
    return (
      <div className="purchase-cargo-receive">
        {!embeddedInReceipt ? <h4 style={{ marginTop: 8 }}>Грузоместа</h4> : null}
        <p className="muted" style={{ fontSize: 13 }}>
          Загрузка грузомест…
        </p>
      </div>
    );
  }

  if (!showScan && !showList) return null;

  return (
    <div className="purchase-cargo-receive">
      {!embeddedInReceipt ? <h4 style={{ marginTop: 8 }}>Грузоместа</h4> : null}
      {showScan && showList && !embeddedInReceipt ? (
        <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
          Отсканируйте штрихкод грузоместа, затем откройте место и отсканируйте товары внутри. В итоге
          по каждому месту будет список позиций.
        </p>
      ) : null}
      {showScan && !showList ? (
        <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
          Отсканируйте штрихкоды пришедших грузомест. Разбор и состав — на вкладке «Состав грузомест».
        </p>
      ) : null}
      {showList && !showScan ? (
        <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
          Откройте место и отсканируйте товары внутри. Состав по местам — ниже.
        </p>
      ) : null}

      {message && (showScan || showList) ? (
        <p
          className={
            message.kind === 'success'
              ? 'warehouse-ops-msg success'
              : message.kind === 'warning'
                ? 'warehouse-ops-msg'
                : 'warehouse-ops-msg error'
          }
          role="status"
          style={{
            marginBottom: 10,
            ...(message.kind === 'warning' ? { color: 'var(--warning, #b26a00)' } : null),
          }}
        >
          {message.text}
        </p>
      ) : null}

      {showScan ? (
        <>
          {editable && !activePlaceId ? (
            <div style={{ marginBottom: 12 }}>
              <BarcodeScanField
                id="purchase-cargo-place-scan"
                label="Скан грузоместа"
                placeholder="Отсканируйте штрихкод грузоместа"
                loading={busy}
                disabled={busy}
                enableGlobalCapture={showScan && !activePlaceId}
                onScan={handlePlaceScan}
                hint={
                  showList
                    ? 'Сначала примите все пришедшие места, затем зайдите в каждое и разберите товар.'
                    : 'Принятые места появятся на вкладке «Состав грузомест».'
                }
              />
            </div>
          ) : null}

          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <span className="muted" style={{ fontSize: 13 }}>
              Ожидается мест
            </span>
            <input
              className="warehouse-ops-input"
              style={{ width: 88 }}
              inputMode="numeric"
              value={expectedDraft}
              disabled={!editable || busy}
              placeholder="—"
              onChange={(e) => setExpectedDraft(e.target.value)}
            />
            <Button variant="secondary" disabled={!editable || busy} onClick={saveExpected}>
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </Button>
            <span style={{ fontSize: 14 }}>
              Принято:{' '}
              <strong>
                {places.length}
                {cargoState?.expectedCargoPlaces != null ? ` из ${cargoState.expectedCargoPlaces}` : ''}
              </strong>
              {' · '}
              разобрано: <strong>{doneCount}</strong>
              {cargoState?.report?.totalQuantity != null ? (
                <span className="muted"> · товара в местах {cargoState.report.totalQuantity} шт</span>
              ) : null}
            </span>
          </div>

          {cargoState?.expectedCargoPlaces != null &&
          places.length > Number(cargoState.expectedCargoPlaces) ? (
            <p className="error" style={{ marginBottom: 10 }} role="alert">
              Принято мест больше ожидаемого ({places.length} &gt; {cargoState.expectedCargoPlaces}).
              Лишнее место можно удалить на вкладке «Состав грузомест», если в нём ещё нет товара.
            </p>
          ) : null}
        </>
      ) : null}

      {showList && activePlaceId ? (
        <div className="purchase-cargo-place-panel warehouse-ops-product-card" style={{ marginBottom: 16 }}>
          {placeLoading && !placeData ? (
            <p className="muted">Открываем грузоместо…</p>
          ) : placeData ? (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>
                    {placeData.place.barcode}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {placeData.place.number
                      ? `Место ${placeData.place.number} из ${placeData.place.placesTotal}`
                      : 'Грузоместо'}{' '}
                    · {cargoPlaceStatusLabel(placeData.place.status)}
                  </div>
                </div>
                <Button variant="secondary" disabled={busy} onClick={closePlacePanel}>
                  К списку мест
                </Button>
              </div>

              {placeEditable && editable ? (
                <>
                  <BarcodeScanField
                    id="purchase-cargo-product-scan"
                    label="Скан товара из места"
                    placeholder="Отсканируйте товар"
                    loading={busy}
                    disabled={busy}
                    enableGlobalCapture
                    onScan={handleProductScan}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      margin: '10px 0',
                    }}
                  >
                    <span className="muted" style={{ fontSize: 13 }}>
                      Количество за скан:
                    </span>
                    {MULTIPLIERS.map((m) => (
                      <Button
                        key={m}
                        variant={multiplier === m ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() => setMultiplier(m)}
                      >
                        ×{m}
                      </Button>
                    ))}
                  </div>
                </>
              ) : null}

              <p style={{ fontWeight: 600, margin: '8px 0' }}>
                В месте: позиций {activePlaceItems.length} · штук {activeTotalQty}
              </p>
              {activePlaceItems.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  Пока ничего не принято
                </p>
              ) : (
                <div className="warehouse-ops-table-wrap">
                  <table className="warehouse-ops-table">
                    <thead>
                      <tr>
                        <th>Товар</th>
                        <th>По закупке</th>
                        <th style={{ width: 140 }}>Кол-во</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePlaceItems.map((item) => {
                        const remaining = item.inPurchase
                          ? Math.max(0, (item.expectedQuantity || 0) - (item.receivedBefore || 0))
                          : null;
                        const over = remaining != null && item.receiptQuantity > remaining;
                        return (
                          <tr
                            key={item.productId}
                            style={
                              !item.inPurchase
                                ? { background: 'var(--warning-bg, #fff8e6)' }
                                : undefined
                            }
                          >
                            <td>
                              <div>{item.name || item.sku || `#${item.productId}`}</div>
                              {item.sku ? (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {item.sku}
                                </div>
                              ) : null}
                            </td>
                            <td>
                              {item.inPurchase ? (
                                <span style={over ? { color: 'var(--danger, #c62828)' } : undefined}>
                                  {item.receiptQuantity} из {remaining}
                                </span>
                              ) : (
                                <span className="muted">Нет в закупке</span>
                              )}
                            </td>
                            <td>
                              {placeEditable && editable ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      item.quantity <= 1
                                        ? window.confirm(`Убрать «${item.name}» из грузоместа?`) &&
                                          changeItemQty(item, 0)
                                        : changeItemQty(item, item.quantity - 1)
                                    }
                                  >
                                    −
                                  </Button>
                                  <strong style={{ minWidth: 28, textAlign: 'center' }}>
                                    {item.quantity}
                                  </strong>
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => changeItemQty(item, item.quantity + 1)}
                                  >
                                    +
                                  </Button>
                                </div>
                              ) : (
                                item.quantity
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {placeData.place.status === 'opened' && editable ? (
                <div style={{ marginTop: 12 }}>
                  <Button disabled={busy} onClick={closeActivePlace}>
                    Товар принят — закрыть место
                  </Button>
                </div>
              ) : null}
              {placeData.place.status === 'closed' ? (
                <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                  Место разобрано. Новый скан товара снова откроет его.
                </p>
              ) : null}
              {placeData.place.status === 'received' ? (
                <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                  Товар из этого места уже оприходован на склад.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {showList && !activePlaceId ? (
        <>
          {!showScan ? (
            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: 10,
                fontSize: 14,
              }}
            >
              <span>
                Принято:{' '}
                <strong>
                  {places.length}
                  {cargoState?.expectedCargoPlaces != null
                    ? ` из ${cargoState.expectedCargoPlaces}`
                    : ''}
                </strong>
                {' · '}
                разобрано: <strong>{doneCount}</strong>
                {cargoState?.report?.totalQuantity != null ? (
                  <span className="muted"> · товара в местах {cargoState.report.totalQuantity} шт</span>
                ) : null}
              </span>
            </div>
          ) : null}
          {places.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              Пока нет принятых грузомест.
              {embeddedInReceipt ? ' Отсканируйте места на вкладке «Приёмка».' : ''}
            </p>
          ) : (
            <div className="warehouse-ops-table-wrap">
              <table className="warehouse-ops-table">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>№</th>
                    <th>Штрихкод</th>
                    <th>Статус</th>
                    <th>Позиций</th>
                    <th>Шт</th>
                    <th>Принято</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {places.map((place, index) => (
                    <tr key={place.id}>
                      <td>{index + 1}</td>
                      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{place.barcode}</td>
                      <td>{cargoPlaceStatusLabel(place.status)}</td>
                      <td>{place.itemsCount ?? 0}</td>
                      <td>{place.quantity ?? 0}</td>
                      <td>{fmtDt(place.acceptedAt)}</td>
                      <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {place.status !== 'received' ? (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => openPlacePanel(place.id)}
                          >
                            Открыть
                          </Button>
                        ) : null}
                        {place.status === 'accepted' && editable ? (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => removePlace(place)}
                          >
                            Удалить
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(cargoState?.report?.places || []).some((p) => (p.items || []).length > 0) ? (
            <div style={{ marginTop: 12 }}>
              <h5 style={{ margin: '0 0 8px' }}>Товар по грузоместам</h5>
              {(cargoState.report.places || []).map((place) =>
                (place.items || []).length ? (
                  <div key={place.placeId} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {place.barcode}
                      <span className="muted" style={{ fontWeight: 400 }}>
                        {' '}
                        · {place.quantity} шт
                      </span>
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {(place.items || []).map((item) => (
                        <li key={`${place.placeId}-${item.productId}`}>
                          {item.name || item.sku || `#${item.productId}`} — {item.quantity} шт
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null
              )}
            </div>
          ) : null}

          {receipt && !embeddedInReceipt ? (
            <div
              className="warehouse-ops-product-card"
              style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <strong>Черновик приёмки</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                Принято товара: {receipt.scannedTotal} шт
              </span>
              {isReceiptOwner ? (
                <Button
                  disabled={!editable || completeBusy || receipt.scannedTotal <= 0}
                  onClick={completeReceipt}
                >
                  {completeBusy ? 'Оформляю…' : 'Оформить приёмку'}
                </Button>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  Оформить приёмку может только сотрудник, который её начал.
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

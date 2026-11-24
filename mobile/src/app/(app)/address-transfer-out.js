/**
 * Документ ПМ: скан ячейки → товар (выбор при нескольких) → кол-во сканом/+вручную →
 * следующая ячейка → … → один документ. Строки с разных ячеек накапливаются.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { addressStorageApi, receiptsApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { scanError, scanOk } from '../../lib/feedback';
import { ScanBar } from '../../components/ScanBar';
import { Banner, Button, Card, Field, Loading } from '../../ui/components';
import { colors } from '../../ui/theme';

function lineKey(productId, fromLocationId) {
  return `${productId}:${fromLocationId || ''}`;
}

export default function AddressTransferOutScreen() {
  const { organizationId } = useAuth();
  const busyRef = useRef(false);
  const [warehouses, setWarehouses] = useState(null);
  const [fromWarehouseId, setFromWarehouseId] = useState(null);
  const [toWarehouseId, setToWarehouseId] = useState(null);
  const [cell, setCell] = useState(null);
  const [lines, setLines] = useState([]);
  const [draftQty, setDraftQty] = useState({});
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    addressStorageApi.listWarehouses().then(
      (all) => {
        const list = (all || []).filter(
          (w) => organizationId == null || Number(w.organizationId) === Number(organizationId)
        );
        setWarehouses(list);
        const withCells = list.filter((w) => w.settings?.enabled && w.settings?.trackQuantities);
        if (withCells.length === 1) setFromWarehouseId(withCells[0].id);
      },
      (e) => {
        setWarehouses([]);
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось загрузить склады') });
      }
    );
  }, [organizationId]);

  const sourceWarehouses = useMemo(
    () => (warehouses || []).filter((w) => w.settings?.enabled && w.settings?.trackQuantities),
    [warehouses]
  );

  const destWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) =>
          Number(w.id) !== Number(fromWarehouseId) &&
          Number(w.organizationId) ===
            Number((warehouses || []).find((x) => Number(x.id) === Number(fromWarehouseId))?.organizationId)
      ),
    [warehouses, fromWarehouseId]
  );

  const resetDoc = useCallback(() => {
    setCell(null);
    setLines([]);
    setDraftQty({});
  }, []);

  useEffect(() => {
    resetDoc();
    setToWarehouseId(null);
    setMessage(null);
  }, [fromWarehouseId, resetDoc]);

  useEffect(() => {
    if (!toWarehouseId && destWarehouses.length === 1) setToWarehouseId(destWarehouses[0].id);
  }, [toWarehouseId, destWarehouses]);

  const qtyInCart = useCallback(
    (productId, fromLocationId) => {
      const locId = fromLocationId ?? cell?.location?.id;
      return (
        lines.find(
          (l) =>
            Number(l.productId) === Number(productId) &&
            Number(l.fromLocationId) === Number(locId)
        )?.quantity || 0
      );
    },
    [lines, cell]
  );

  const putLine = useCallback(
    (item, quantity, loc) => {
      const location = loc || cell?.location;
      if (!location?.id) {
        setMessage({ kind: 'error', text: 'Сначала отсканируйте ячейку' });
        return false;
      }
      const qty = Math.floor(Number(quantity) || 0);
      if (qty < 1) {
        setMessage({ kind: 'error', text: 'Укажите количество' });
        return false;
      }
      const maxInCell = Math.max(0, Number(item.quantity) || 0);
      if (qty > maxInCell) {
        setMessage({ kind: 'error', text: `В ячейке только ${maxInCell} шт` });
        return false;
      }
      const fromLocationId = Number(location.id);
      const fromLocationCode = String(location.code || '').trim();
      setLines((prev) => {
        const rest = prev.filter(
          (l) =>
            !(
              Number(l.productId) === Number(item.productId) &&
              Number(l.fromLocationId) === fromLocationId
            )
        );
        return [
          ...rest,
          {
            productId: item.productId,
            sku: item.sku,
            name: item.name,
            quantity: qty,
            fromLocationId,
            fromLocationCode,
          },
        ];
      });
      setDraftQty((d) => ({ ...d, [item.productId]: String(qty) }));
      setMessage(null);
      return true;
    },
    [cell]
  );

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || !fromWarehouseId || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const r = await addressStorageApi.resolveScan(fromWarehouseId, code);
        if (!r) {
          scanError();
          setMessage({ kind: 'error', text: `Не распознано: «${code}»` });
          return;
        }
        if (r.type === 'location' || r.location) {
          scanOk();
          const items = (r.items || []).filter((it) => it?.productId && Number(it.quantity) > 0);
          const loc = r.location;
          setCell({ location: loc, items });
          const drafts = {};
          for (const it of items) drafts[it.productId] = String(it.quantity);
          setDraftQty(drafts);
          if (items.length === 0) {
            setMessage({ kind: 'error', text: `Ячейка ${loc?.code || code} пуста` });
            return;
          }
          if (items.length === 1) {
            putLine(items[0], items[0].quantity, loc);
            setMessage({
              kind: 'success',
              text: `${loc.code}: ${items[0].sku} · ${items[0].quantity} шт. Скан товара (+1) или следующая ячейка.`,
            });
          } else {
            setMessage({ kind: 'success', text: `Ячейка ${loc.code}: выберите товар` });
          }
          return;
        }
        if ((r.type === 'product' || r.product) && cell) {
          const item = (cell.items || []).find((it) => Number(it.productId) === Number(r.product.id));
          if (!item) {
            scanError();
            setMessage({ kind: 'error', text: 'Товара нет в этой ячейке' });
            return;
          }
          const next = qtyInCart(item.productId, cell.location.id) + 1;
          if (next > (Number(item.quantity) || 0)) {
            scanError();
            setMessage({ kind: 'error', text: 'Больше остатка в ячейке' });
            return;
          }
          scanOk();
          putLine(item, next, cell.location);
          setMessage({ kind: 'success', text: `${item.sku}: ${next} шт из ${cell.location.code}` });
          return;
        }
        scanError();
        setMessage({ kind: 'error', text: 'Сначала отсканируйте ячейку' });
      } catch (e) {
        scanError();
        setMessage({ kind: 'error', text: errorMessage(e, 'Ошибка скана') });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fromWarehouseId, cell, qtyInCart, putLine]
  );

  const submit = async () => {
    if (!lines.length) {
      setMessage({ kind: 'error', text: 'Добавьте товары (скан ячейки)' });
      return;
    }
    if (!toWarehouseId) {
      setMessage({ kind: 'error', text: 'Выберите склад куда' });
      return;
    }
    const src = (warehouses || []).find((w) => Number(w.id) === Number(fromWarehouseId));
    const orgId = src?.organizationId || organizationId;
    if (!orgId) {
      setMessage({ kind: 'error', text: 'Не определена организация' });
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await receiptsApi.create({
        documentType: 'transfer',
        organizationId: Number(orgId),
        warehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(toWarehouseId),
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          fromLocationId: Number(l.fromLocationId),
        })),
      });
      const receipt = res?.receipt || res;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
      scanOk();
      setMessage({
        kind: 'success',
        text: `ПМ ${num} · ${lines.length} поз. / ${totalQty} шт`,
      });
      resetDoc();
    } catch (e) {
      scanError();
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось создать перемещение') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  const destName = destWarehouses.find((w) => String(w.id) === String(toWarehouseId))?.name;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Ячейка → товар (выбор при нескольких) → количество сканом ШК (+1) или вручную → следующая ячейка.
        В конце — один документ перемещения.
      </Text>

      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />

      <Card style={styles.gap}>
        <Text style={styles.section}>Склад откуда</Text>
        {sourceWarehouses.length === 0 ? (
          <Text style={styles.muted}>Нет складов с учётом по ячейкам</Text>
        ) : (
          sourceWarehouses.map((w) => {
            const active = String(w.id) === String(fromWarehouseId);
            return (
              <Pressable
                key={w.id}
                onPress={() => setFromWarehouseId(w.id)}
                style={[styles.option, active && styles.optionActive]}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {w.name || `Склад #${w.id}`}
                </Text>
              </Pressable>
            );
          })
        )}
      </Card>

      {fromWarehouseId ? (
        <>
          <Card style={styles.gap}>
            <Text style={styles.section}>Склад куда</Text>
            {destWarehouses.length === 0 ? (
              <Text style={styles.muted}>Нет другого склада</Text>
            ) : (
              destWarehouses.map((w) => {
                const active = String(w.id) === String(toWarehouseId);
                return (
                  <Pressable
                    key={w.id}
                    onPress={() => setToWarehouseId(w.id)}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{w.name}</Text>
                  </Pressable>
                );
              })
            )}
          </Card>

          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder={cell ? 'Товар (+1) или следующая ячейка' : 'Сканируйте ячейку откуда'}
          />

          {cell ? (
            <Card style={styles.gap}>
              <View style={styles.rowBetween}>
                <Text style={styles.section}>Ячейка {cell.location.code}</Text>
                <Button
                  title="Сбросить"
                  variant="secondary"
                  small
                  onPress={() => {
                    setCell(null);
                    setDraftQty({});
                  }}
                  disabled={busy}
                />
              </View>
              {(cell.items || []).length === 0 ? <Text style={styles.muted}>Пусто</Text> : null}
              {(cell.items || []).length > 1 ? (
                <Text style={styles.muted}>Выберите товар</Text>
              ) : null}
              {(cell.items || []).map((it) => {
                const inDoc = qtyInCart(it.productId, cell.location.id);
                const selected = inDoc > 0;
                return (
                  <Pressable
                    key={it.productId}
                    disabled={busy}
                    onPress={() => {
                      putLine(it, Math.max(1, Number(draftQty[it.productId]) || Number(it.quantity) || 1), cell.location);
                      scanOk();
                    }}
                    style={[styles.itemRow, selected && styles.itemRowActive]}
                  >
                    <Text style={[styles.itemTitle, selected && styles.itemTitleActive]}>
                      {it.sku} · в ячейке {it.quantity} шт
                      {selected ? ` · в документе ${inDoc}` : ''}
                    </Text>
                    <Text style={styles.muted}>{it.name}</Text>
                  </Pressable>
                );
              })}
              {lines.some((l) => Number(l.fromLocationId) === Number(cell.location.id)) ? (
                <Field
                  label="Количество (выбранный / правьте и нажмите товар выше)"
                  value={
                    draftQty[
                      lines.find((l) => Number(l.fromLocationId) === Number(cell.location.id))
                        ?.productId
                    ] ?? ''
                  }
                  onChangeText={(v) => {
                    const activeLine = lines.find(
                      (l) => Number(l.fromLocationId) === Number(cell.location.id)
                    );
                    if (!activeLine) return;
                    setDraftQty((d) => ({ ...d, [activeLine.productId]: v }));
                    const qty = Math.floor(Number(v) || 0);
                    if (qty >= 1) {
                      const item = (cell.items || []).find(
                        (it) => Number(it.productId) === Number(activeLine.productId)
                      );
                      if (item) putLine(item, qty, cell.location);
                    }
                  }}
                  keyboardType="number-pad"
                />
              ) : null}
            </Card>
          ) : null}

          {lines.length ? (
            <Card style={styles.gap}>
              <Text style={styles.section}>В документе ({lines.length})</Text>
              {lines.map((l) => (
                <View key={lineKey(l.productId, l.fromLocationId)} style={styles.lineRow}>
                  <Text style={styles.itemTitle}>
                    {l.fromLocationCode || '—'} → {l.sku} · {l.quantity} шт
                  </Text>
                  <Button
                    title="Убрать"
                    variant="secondary"
                    small
                    disabled={busy}
                    onPress={() =>
                      setLines((prev) =>
                        prev.filter(
                          (x) =>
                            !(
                              Number(x.productId) === Number(l.productId) &&
                              Number(x.fromLocationId) === Number(l.fromLocationId)
                            )
                        )
                      )
                    }
                  />
                </View>
              ))}
              <Text style={styles.muted}>→ {destName || '…'}</Text>
              <Button
                title={busy ? 'Оформляю…' : 'Создать документ перемещения'}
                onPress={submit}
                loading={busy}
                disabled={!toWarehouseId || !lines.length}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hint: { fontSize: 15, color: colors.muted, lineHeight: 22 },
  gap: { gap: 10 },
  section: { fontSize: 17, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EEF5FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { fontWeight: '700', color: colors.primary },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  itemRow: {
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemRowActive: { borderColor: colors.primary, backgroundColor: '#EEF5FF' },
  itemTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  itemTitleActive: { color: colors.primary },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
});

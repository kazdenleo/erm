/**
 * Перемещение товара между ячейками одного склада: скан «откуда» → товар → «куда».
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { addressStorageApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { scanError, scanOk } from '../../lib/feedback';
import { ScanBar } from '../../components/ScanBar';
import { Banner, Button, Card, Chip, Field, Loading } from '../../ui/components';
import { colors } from '../../ui/theme';

const UNPLACED = 'unplaced';

export default function AddressMovesScreen() {
  const { organizationId } = useAuth();
  const busyRef = useRef(false);
  const [warehouses, setWarehouses] = useState(null);
  const [warehouseId, setWarehouseId] = useState(null);
  const [product, setProduct] = useState(null);
  const [whInfo, setWhInfo] = useState(null);
  const [from, setFrom] = useState(UNPLACED);
  const [to, setTo] = useState('');
  const [toCode, setToCode] = useState('');
  const [qty, setQty] = useState('');
  const [cellItems, setCellItems] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [forceOffer, setForceOffer] = useState(false);
  const [expect, setExpect] = useState('from'); // from | product | to

  useEffect(() => {
    addressStorageApi.listWarehouses().then(
      (all) => {
        const list = (all || []).filter(
          (w) =>
            w.settings?.enabled &&
            w.settings?.trackQuantities &&
            (organizationId == null || Number(w.organizationId) === Number(organizationId))
        );
        setWarehouses(list);
        if (list.length === 1) setWarehouseId(list[0].id);
      },
      (e) => {
        setWarehouses([]);
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось загрузить склады') });
      }
    );
  }, [organizationId]);

  const resetLine = useCallback(() => {
    setProduct(null);
    setWhInfo(null);
    setFrom(UNPLACED);
    setTo('');
    setToCode('');
    setQty('');
    setCellItems(null);
    setForceOffer(false);
    setExpect('from');
  }, []);

  useEffect(() => {
    resetLine();
    setMessage(null);
  }, [warehouseId, resetLine]);

  const sourceAvailable = useMemo(() => {
    if (!whInfo) return 0;
    if (from === UNPLACED) return whInfo.unplaced || 0;
    return whInfo.stocks?.find((s) => String(s.location.id) === String(from))?.quantity ?? 0;
  }, [whInfo, from]);

  const chooseProduct = useCallback(
    async (p, { fromLocationId = null } = {}) => {
      setProduct(p);
      setCellItems(null);
      const info = await addressStorageApi.productLocations(p.id);
      const wh = (info?.warehouses || []).find((w) => Number(w.warehouseId) === Number(warehouseId)) || null;
      setWhInfo(wh);
      const srcStock = fromLocationId
        ? wh?.stocks?.find((s) => Number(s.location.id) === Number(fromLocationId))
        : null;
      const nextFrom = srcStock ? String(fromLocationId) : UNPLACED;
      setFrom(nextFrom);
      const available = srcStock ? srcStock.quantity : wh?.unplaced ?? 0;
      setQty(available > 0 ? String(available) : '1');
      const assignedId = wh?.assigned?.id;
      if (assignedId && String(assignedId) !== nextFrom) {
        setTo(String(assignedId));
        setToCode(wh.assigned.code || '');
      } else {
        setTo('');
        setToCode('');
      }
      setExpect('to');
    },
    [warehouseId]
  );

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || !warehouseId || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const r = await addressStorageApi.resolveScan(warehouseId, code);
        if (!r) {
          scanError();
          setMessage({ kind: 'error', text: `Не распознано: «${code}»` });
          return;
        }
        if (r.type === 'product') {
          scanOk();
          await chooseProduct({ id: r.product.id, sku: r.product.sku, name: r.product.name });
          return;
        }
        const loc = r.location;
        scanOk();
        if (!product) {
          setFrom(String(loc.id));
          setCellItems({ location: loc, items: r.items || [] });
          setExpect('product');
          if ((r.items || []).length === 1) {
            await chooseProduct(
              { id: r.items[0].productId, sku: r.items[0].sku, name: r.items[0].name },
              { fromLocationId: loc.id }
            );
          }
          return;
        }
        setTo(String(loc.id));
        setToCode(loc.code || '');
        setExpect('to');
      } catch (e) {
        scanError();
        const hint = e?.data?.details?.warehouseName
          ? ` (это склад «${e.data.details.warehouseName}»)`
          : '';
        setMessage({ kind: 'error', text: `${errorMessage(e, 'Ошибка скана')}${hint}` });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [warehouseId, product, chooseProduct]
  );

  const doMove = async ({ force = false } = {}) => {
    if (!product || !warehouseId) return;
    const quantity = Math.floor(Number(qty) || 0);
    if (quantity < 1) {
      setMessage({ kind: 'error', text: 'Укажите количество' });
      return;
    }
    if (!to) {
      setMessage({ kind: 'error', text: 'Отсканируйте ячейку «куда»' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const r = await addressStorageApi.moveStock(warehouseId, {
        productId: product.id,
        fromLocationId: from === UNPLACED ? null : Number(from),
        toLocationId: Number(to),
        quantity,
        force,
      });
      scanOk();
      setMessage({
        kind: 'success',
        text: `${product.sku}: ${r.quantity} шт → ${r.to || toCode || 'ячейка'}`,
      });
      resetLine();
      } catch (e) {
      const code = e?.data?.details?.code || e?.code;
      if (code === 'LOCATION_OVER_CAPACITY' && !force) {
        setForceOffer(true);
        setMessage({
          kind: 'warning',
          text: `${errorMessage(e, 'Ячейка переполнена')}. Нажмите «Всё равно положить».`,
        });
      } else {
        scanError();
        setForceOffer(false);
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось переместить') });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const warehouse = (warehouses || []).find((w) => String(w.id) === String(warehouseId));

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Скан ячейки «откуда» → товар (если в ячейке несколько) → скан ячейки «куда» → Переместить.
      </Text>

      <Banner
        kind={message?.kind}
        text={message?.text}
        onClose={() => {
          setMessage(null);
          setForceOffer(false);
        }}
      />

      <Card style={styles.gap}>
        <Text style={styles.section}>Склад</Text>
        {(warehouses || []).length === 0 ? (
          <Text style={styles.muted}>Нет складов с учётом количества по ячейкам</Text>
        ) : (
          (warehouses || []).map((w) => {
            const active = String(w.id) === String(warehouseId);
            return (
              <Pressable
                key={w.id}
                onPress={() => setWarehouseId(w.id)}
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

      {warehouseId ? (
        <>
          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder={
              expect === 'from'
                ? 'Сканируйте ячейку откуда'
                : expect === 'product'
                  ? 'Сканируйте товар'
                  : 'Сканируйте ячейку куда'
            }
          />

          {cellItems && !product ? (
            <Card style={styles.gap}>
              <Text style={styles.section}>В ячейке {cellItems.location.code}</Text>
              {(cellItems.items || []).length === 0 ? (
                <Text style={styles.muted}>Пусто</Text>
              ) : (
                cellItems.items.map((it) => (
                  <Pressable
                    key={it.productId}
                    onPress={() =>
                      chooseProduct(
                        { id: it.productId, sku: it.sku, name: it.name },
                        { fromLocationId: cellItems.location.id }
                      )
                    }
                    style={styles.itemRow}
                  >
                    <Text style={styles.itemTitle}>
                      {it.sku} · {it.quantity} шт
                    </Text>
                    <Text style={styles.muted}>{it.name}</Text>
                  </Pressable>
                ))
              )}
            </Card>
          ) : null}

          {product ? (
            <Card style={styles.gap}>
              <Text style={styles.section}>
                {product.sku} · {product.name}
              </Text>
              <Text style={styles.muted}>
                Откуда:{' '}
                {from === UNPLACED
                  ? `без адреса (${whInfo?.unplaced ?? 0})`
                  : whInfo?.stocks?.find((s) => String(s.location.id) === String(from))?.location
                      ?.code || from}{' '}
                · доступно {sourceAvailable} шт
              </Text>
              <Text style={styles.muted}>Куда: {toCode || (to ? `#${to}` : '— отсканируйте ячейку')}</Text>
              <Field
                label="Количество"
                value={qty}
                onChangeText={setQty}
                keyboardType="number-pad"
                placeholder="шт"
              />
              <View style={styles.row}>
                <Button title="Сбросить" variant="secondary" onPress={resetLine} disabled={busy} />
                {forceOffer ? (
                  <Button
                    title="Всё равно положить"
                    onPress={() => {
                      setForceOffer(false);
                      doMove({ force: true });
                    }}
                    loading={busy}
                  />
                ) : (
                  <Button
                    title="Переместить"
                    onPress={() => doMove({ force: false })}
                    loading={busy}
                    disabled={!to || Math.floor(Number(qty) || 0) < 1}
                  />
                )}
              </View>
              {whInfo?.stocks?.length ? (
                <View style={styles.chips}>
                  {whInfo.stocks.map((s) => (
                    <Chip
                      key={s.location.id}
                      label={`${s.location.code}: ${s.quantity}`}
                      active={String(s.location.id) === String(from)}
                      onPress={() => {
                        setFrom(String(s.location.id));
                        setQty(String(s.quantity));
                      }}
                    />
                  ))}
                </View>
              ) : null}
            </Card>
          ) : null}

          {warehouse ? (
            <Text style={styles.mutedCenter}>{warehouse.name}</Text>
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
  mutedCenter: { textAlign: 'center', fontSize: 13, color: colors.muted },
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
  itemRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  itemTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { cargoApi } from '../../../../api/erp';
import { errorMessage } from '../../../../api/client';
import { scanError, scanOk } from '../../../../lib/feedback';
import { ScanBar } from '../../../../components/ScanBar';
import { PlaceStatusBadge } from '../../../../features/cargo/placeStatus';
import { Banner, Button, Card, Chip, Loading } from '../../../../ui/components';
import { colors } from '../../../../ui/theme';

const MULTIPLIERS = [1, 5, 10, 20];

function ItemRow({ item, editable, onChange, onRemove }) {
  const remaining = item.inPurchase ? Math.max(0, (item.expectedQuantity || 0) - (item.receivedBefore || 0)) : null;
  const over = remaining != null && item.receiptQuantity > remaining;
  const exact = remaining != null && item.receiptQuantity === remaining;
  return (
    <View style={[styles.item, !item.inPurchase && styles.itemExtra]}>
      <View style={styles.flex}>
        <Text style={styles.itemName}>{item.name}</Text>
        <Text style={styles.itemSku}>{item.sku}</Text>
        {item.inPurchase ? (
          <Text style={[styles.itemHint, over && { color: colors.danger }, exact && { color: colors.success }]}>
            Всего по закупке: {item.receiptQuantity} из {remaining}
          </Text>
        ) : (
          <Text style={[styles.itemHint, { color: colors.warning }]}>Нет в закупке</Text>
        )}
      </View>
      {editable ? (
        <Pressable
          style={styles.qtyButton}
          onPress={() => (item.quantity <= 1 ? onRemove(item) : onChange(item, item.quantity - 1))}
        >
          <Text style={styles.qtyButtonText}>−</Text>
        </Pressable>
      ) : null}
      <Text style={styles.itemQty}>{item.quantity}</Text>
      {editable ? (
        <Pressable style={styles.qtyButton} onPress={() => onChange(item, item.quantity + 1)}>
          <Text style={styles.qtyButtonText}>+</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function CargoPlaceScreen() {
  const { placeId, autoOpen } = useLocalSearchParams();
  const id = String(placeId || '');
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const busyRef = useRef(false);
  const autoOpenRef = useRef(autoOpen === '1');

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

  const open = useCallback(
    () =>
      runBusy(async () => {
        try {
          setData(await cargoApi.openPlace(id));
          setMessage({ kind: 'success', text: 'Грузоместо вскрыто — сканируйте товар' });
          scanOk();
        } catch (e) {
          setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось вскрыть грузоместо') });
          scanError();
        }
      }),
    [id, runBusy]
  );

  useEffect(() => {
    cargoApi.getPlace(id).then(
      (next) => {
        setData(next);
        if (autoOpenRef.current && next.place.status === 'accepted') open();
        autoOpenRef.current = false;
      },
      (e) => setLoadError(errorMessage(e, 'Не удалось загрузить грузоместо'))
    );
  }, [id, open]);

  const switchToPlace = (otherId) =>
    Alert.alert('Другое грузоместо', 'Закрыть текущее место и перейти к отсканированному?', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Перейти',
        onPress: () =>
          runBusy(async () => {
            try {
              if (data?.place?.status === 'opened') await cargoApi.closePlace(id);
              router.replace(`/cargo/place/${otherId}?autoOpen=1`);
            } catch (e) {
              setMessage({ kind: 'error', text: errorMessage(e) });
            }
          }),
      },
    ]);

  const handleScan = (code) => {
    const status = data?.place?.status;
    if (status === 'accepted') {
      if (code === data.place.barcode) return open();
      setMessage({ kind: 'warning', text: 'Сначала вскройте грузоместо' });
      scanError();
      return;
    }
    return runBusy(async () => {
      setMessage(null);
      try {
        const res = await cargoApi.addItem(id, { code, quantity: multiplier });
        setData(res);
        const name = res.product?.name || res.product?.sku || code;
        if (res.product?.inPurchase) {
          setMessage({ kind: 'success', text: `+${res.added} · ${name}` });
          scanOk();
        } else {
          setMessage({ kind: 'warning', text: `+${res.added} · ${name} — этого товара нет в закупке` });
          scanError();
        }
        setMultiplier(1);
      } catch (e) {
        scanError();
        if (e?.code === 'CARGO_PLACE_BARCODE' && e.data?.data?.placeId) {
          const otherId = Number(e.data.data.placeId);
          if (otherId === Number(id)) setMessage({ kind: 'warning', text: 'Это штрихкод текущего грузоместа' });
          else switchToPlace(otherId);
          return;
        }
        setMessage({
          kind: e?.code === 'CIS_DUPLICATE' ? 'warning' : 'error',
          text: `${code}: ${errorMessage(e, 'Товар не найден')}`,
        });
      }
    });
  };

  const changeQuantity = (item, quantity) =>
    runBusy(async () => {
      try {
        setData(await cargoApi.setItemQuantity(id, item.productId, quantity));
      } catch (e) {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    });

  const confirmRemoveItem = (item) =>
    Alert.alert('Убрать товар из грузоместа?', item.name, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Убрать', style: 'destructive', onPress: () => changeQuantity(item, 0) },
    ]);

  const close = () =>
    runBusy(async () => {
      try {
        await cargoApi.closePlace(id);
        router.back();
      } catch (e) {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    });

  const confirmClose = () => {
    if ((data?.items || []).length > 0) return close();
    return Alert.alert('Грузоместо пустое', 'Закрыть место без товара?', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Закрыть', onPress: close },
    ]);
  };

  const removePlace = () =>
    Alert.alert('Удалить грузоместо?', data.place.barcode, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () =>
          runBusy(async () => {
            try {
              await cargoApi.removePlace(id);
              router.back();
            } catch (e) {
              setMessage({ kind: 'error', text: errorMessage(e) });
            }
          }),
      },
    ]);

  if (!data && !loadError) return <Loading text="Загружаем грузоместо…" />;

  if (!data) {
    return (
      <View style={styles.content}>
        <Banner text={loadError} />
        <Button title="Назад" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  const { place, items = [] } = data;
  const editable = place.status === 'opened' || place.status === 'closed';
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const title = place.number ? `Место ${place.number} из ${place.placesTotal}` : 'Грузоместо';

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title }} />
      <Card style={styles.gapSmall}>
        <Text style={styles.barcode}>{place.barcode}</Text>
        <PlaceStatusBadge status={place.status} />
      </Card>

      {place.status === 'accepted' ? (
        <View style={styles.gap}>
          <Button title="Вскрыть грузоместо" loading={busy} onPress={open} />
          <Text style={styles.muted}>Или отсканируйте штрихкод этого места ещё раз.</Text>
          <ScanBar onScan={handleScan} busy={busy} placeholder="Штрихкод грузоместа" />
          <Button title="Удалить грузоместо" variant="secondary" onPress={removePlace} />
        </View>
      ) : null}

      {editable ? (
        <>
          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder="Отсканируйте товар из места"
            cameraHint="Наведите на штрихкод товара"
          />
          <View style={styles.multipliers}>
            <Text style={styles.muted}>Количество за скан:</Text>
            {MULTIPLIERS.map((m) => (
              <Chip key={m} label={`×${m}`} active={multiplier === m} onPress={() => setMultiplier(m)} />
            ))}
          </View>
        </>
      ) : null}

      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />

      {place.status !== 'accepted' ? (
        <>
          <Text style={styles.section}>
            В месте: позиций {items.length} · штук {totalQty}
          </Text>
          {items.length === 0 ? <Text style={styles.muted}>Пока ничего не принято</Text> : null}
          {items.map((item) => (
            <ItemRow
              key={item.productId}
              item={item}
              editable={editable}
              onChange={changeQuantity}
              onRemove={confirmRemoveItem}
            />
          ))}
        </>
      ) : null}

      {place.status === 'opened' ? (
        <Button title="Товар принят — закрыть место" loading={busy} onPress={confirmClose} />
      ) : null}
      {place.status === 'closed' ? (
        <Text style={styles.muted}>Место разобрано. Новый скан товара снова откроет его.</Text>
      ) : null}
      {place.status === 'received' ? (
        <Text style={styles.muted}>Товар из этого места уже оприходован на склад.</Text>
      ) : null}
      {place.status !== 'opened' ? (
        <Button title="К закупке" variant="secondary" onPress={() => router.back()} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  gap: { gap: 10 },
  gapSmall: { gap: 8 },
  flex: { flex: 1 },
  barcode: { fontSize: 20, fontWeight: '700', color: colors.text },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  multipliers: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemExtra: { borderColor: colors.warning, backgroundColor: colors.warningBg },
  itemName: { fontSize: 16, color: colors.text, fontWeight: '500' },
  itemSku: { fontSize: 13, color: colors.muted, marginTop: 2 },
  itemHint: { fontSize: 13, color: colors.muted, marginTop: 4, fontWeight: '600' },
  itemQty: { fontSize: 22, fontWeight: '800', color: colors.text, minWidth: 36, textAlign: 'center' },
  qtyButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  qtyButtonText: { fontSize: 24, fontWeight: '600', color: colors.text },
});

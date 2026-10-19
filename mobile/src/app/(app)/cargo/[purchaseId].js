import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../context/AuthContext';
import { cargoApi, purchasesApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { scanError, scanOk } from '../../../lib/feedback';
import { writeItem } from '../../../lib/storage';
import { ScanBar } from '../../../components/ScanBar';
import { CargoReport } from '../../../features/cargo/CargoReport';
import { PlaceStatusBadge } from '../../../features/cargo/placeStatus';
import { Banner, Button, Card, Field, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

const POLL_MS = 5000;

function ExpectedEditor({ value, onSave, onCancel, busy }) {
  const [text, setText] = useState(value != null ? String(value) : '');
  const save = () => {
    const trimmed = text.trim();
    onSave(trimmed === '' ? null : Number(trimmed.replace(/\D+/g, '')));
  };
  return (
    <View style={styles.gap}>
      <Field
        label="Сколько грузомест должно прийти (пусто — неизвестно)"
        value={text}
        onChangeText={setText}
        keyboardType="number-pad"
        autoFocus
        onSubmitEditing={save}
      />
      <View style={styles.row}>
        <Button title="Отмена" variant="secondary" small style={styles.flex} onPress={onCancel} />
        <Button title="Сохранить" small style={styles.flex} loading={busy} onPress={save} />
      </View>
    </View>
  );
}

export default function CargoPurchaseScreen() {
  const { purchaseId } = useLocalSearchParams();
  const id = String(purchaseId || '');
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editingExpected, setEditingExpected] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = useCallback(
    () =>
      cargoApi.getPurchase(id).then(
        (next) => {
          setData(next);
          setLoadError(null);
          writeItem('cargoPurchase', next.purchase.status === 'open' ? id : null);
        },
        (e) => {
          if (e?.status === 404) writeItem('cargoPurchase', null);
          setLoadError(errorMessage(e, 'Не удалось загрузить закупку'));
        }
      ),
    [id]
  );

  useFocusEffect(
    useCallback(() => {
      refresh();
      const t = setInterval(() => {
        if (!busyRef.current) refresh();
      }, POLL_MS);
      return () => clearInterval(t);
    }, [refresh])
  );

  const runBusy = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openPlace = (placeId) => router.push(`/cargo/place/${placeId}`);

  const accept = async (code, force = false) => {
    const res = await cargoApi.acceptPlace(id, code, { force });
    setData(res.state);
    if (res.alreadyAccepted) {
      scanOk();
      const place = res.state.places.find((p) => p.id === res.placeId);
      if (place?.status === 'accepted' || place?.status === 'opened' || place?.status === 'closed') {
        Alert.alert('Грузоместо уже принято', `${code}\n\nПерейти к приёмке товара из него?`, [
          { text: 'Отмена', style: 'cancel' },
          { text: 'Открыть', onPress: () => openPlace(res.placeId) },
        ]);
      } else {
        setMessage({ kind: 'warning', text: `${code}: товар из этого места уже оприходован` });
      }
      return;
    }
    const total = res.state.places.length;
    const expected = res.state.expectedCargoPlaces;
    setMessage({
      kind: 'success',
      text: `Принято грузоместо ${code} · ${expected != null ? `${total} из ${expected}` : `всего ${total}`}`,
    });
    scanOk();
  };

  const handleScan = (code) =>
    runBusy(async () => {
      setMessage(null);
      try {
        await accept(code);
      } catch (e) {
        scanError();
        if (e?.code === 'PRODUCT_BARCODE') {
          Alert.alert('Похоже на штрихкод товара', `${e.message}.\n\nВсё равно принять как грузоместо?`, [
            { text: 'Отмена', style: 'cancel' },
            {
              text: 'Принять',
              onPress: () =>
                runBusy(() =>
                  accept(code, true).catch((err) => setMessage({ kind: 'error', text: errorMessage(err) }))
                ),
            },
          ]);
          return;
        }
        setMessage({ kind: 'error', text: `${code}: ${errorMessage(e, 'Не удалось принять грузоместо')}` });
      }
    });

  const saveExpected = (value) =>
    runBusy(async () => {
      try {
        setData(await cargoApi.setExpected(id, value));
        setEditingExpected(false);
      } catch (e) {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    });

  const confirmRemove = (place) =>
    Alert.alert('Удалить грузоместо?', place.barcode, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () =>
          runBusy(async () => {
            try {
              setData(await cargoApi.removePlace(place.id));
            } catch (e) {
              setMessage({ kind: 'error', text: errorMessage(e) });
            }
          }),
      },
    ]);

  const complete = async () => {
    setCompleteBusy(true);
    try {
      await purchasesApi.completeReceipt(data.receipt.id, data.purchase.warehouseId);
      Alert.alert('Приёмка оформлена', 'Товар из грузомест оприходован на склад');
      await refresh();
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось оформить приёмку') });
    } finally {
      setCompleteBusy(false);
    }
  };

  const confirmComplete = () => {
    const places = data.places || [];
    const withoutItems = places.filter((p) => p.status === 'accepted').length;
    const inProgress = places.filter((p) => p.status === 'opened').length;
    const expected = data.expectedCargoPlaces;
    const warnings = [];
    if (expected != null && places.length < expected) warnings.push(`Принято мест: ${places.length} из ${expected}.`);
    if (withoutItems) warnings.push(`Мест без разбора товара: ${withoutItems}.`);
    if (inProgress) warnings.push(`Не закрыто мест: ${inProgress}.`);
    Alert.alert(
      'Оформить приёмку?',
      [`Будет оприходовано ${data.receipt.scannedTotal} шт.`, ...warnings].join('\n'),
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Оформить', onPress: complete },
      ]
    );
  };

  if (!data && !loadError) return <Loading text="Загружаем закупку…" />;

  if (!data) {
    return (
      <View style={styles.content}>
        <Banner text={loadError} />
        <Button title="К списку закупок" variant="secondary" onPress={() => router.replace('/cargo')} />
      </View>
    );
  }

  const { purchase, places = [], receipt, expectedCargoPlaces, report } = data;
  const doneCount = places.filter((p) => p.status === 'closed' || p.status === 'received').length;
  const isReceiptOwner =
    !receipt?.createdByUserId || (user?.id != null && Number(receipt.createdByUserId) === Number(user.id));

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `Закупка №${purchase.id}` }} />
      <View style={styles.scanArea}>
        <ScanBar
          onScan={handleScan}
          busy={busy}
          placeholder="Отсканируйте грузоместо"
          cameraHint="Наведите на штрихкод грузоместа"
        />
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card style={styles.gapSmall}>
        <Text style={styles.supplier}>{purchase.supplierName || 'Поставщик не указан'}</Text>
        {purchase.warehouseName ? <Text style={styles.muted}>Склад: {purchase.warehouseName}</Text> : null}
        <Text style={styles.muted}>
          Позиций: {purchase.itemsCount} · ожидается {purchase.expectedTotal} шт · принято ранее {purchase.receivedTotal}
        </Text>
      </Card>

      <Card style={styles.gapSmall}>
        <View style={styles.progressRow}>
          <View style={styles.flex}>
            <Text style={styles.muted}>Принято грузомест</Text>
            <Text style={styles.progress}>
              {places.length}
              {expectedCargoPlaces != null ? <Text style={styles.progressOf}> из {expectedCargoPlaces}</Text> : null}
            </Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.muted}>Разобрано</Text>
            <Text style={styles.progress}>{doneCount}</Text>
          </View>
        </View>
        {editingExpected ? (
          <ExpectedEditor
            value={expectedCargoPlaces}
            busy={busy}
            onCancel={() => setEditingExpected(false)}
            onSave={saveExpected}
          />
        ) : (
          <Pressable onPress={() => setEditingExpected(true)}>
            <Text style={styles.link}>
              {expectedCargoPlaces != null ? 'Изменить ожидаемое количество мест' : 'Указать, сколько мест должно прийти'}
            </Text>
          </Pressable>
        )}
      </Card>

      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />
      {loadError ? <Banner kind="warning" text={`Нет связи: ${loadError}`} /> : null}

      <Text style={styles.section}>Грузоместа</Text>
      {places.length === 0 ? (
        <Text style={styles.muted}>Отсканируйте штрихкоды всех пришедших мест, затем зайдите в каждое и примите товар.</Text>
      ) : null}
      {places.map((place, index) => (
        <Pressable
          key={place.id}
          onPress={() => openPlace(place.id)}
          onLongPress={() => (place.status === 'accepted' ? confirmRemove(place) : null)}
          style={({ pressed }) => [styles.place, pressed && styles.pressed]}
        >
          <Text style={styles.placeNumber}>{index + 1}</Text>
          <View style={styles.flex}>
            <Text style={styles.placeBarcode} numberOfLines={1}>
              {place.barcode}
            </Text>
            <PlaceStatusBadge status={place.status} />
          </View>
          {place.quantity > 0 ? (
            <View style={styles.placeQty}>
              <Text style={styles.placeQtyValue}>{place.quantity}</Text>
              <Text style={styles.mutedSmall}>шт</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
      {places.some((p) => p.status === 'accepted') ? (
        <Text style={styles.mutedSmall}>Нажмите на место, чтобы принять из него товар; удерживайте, чтобы удалить ошибочный скан.</Text>
      ) : null}

      <CargoReport report={report} />

      {receipt ? (
        <Card style={styles.gap}>
          <Text style={styles.section}>Черновик приёмки</Text>
          <Text style={styles.muted}>Принято товара: {receipt.scannedTotal} шт</Text>
          {isReceiptOwner ? (
            <Button
              title="Оформить приёмку"
              disabled={receipt.scannedTotal <= 0}
              loading={completeBusy}
              onPress={confirmComplete}
            />
          ) : (
            <Text style={styles.mutedSmall}>Оформить приёмку может только сотрудник, который её начал.</Text>
          )}
        </Card>
      ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scanArea: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: colors.bg, zIndex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  gap: { gap: 10 },
  gapSmall: { gap: 6 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  supplier: { fontSize: 18, fontWeight: '700', color: colors.text },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  mutedSmall: { fontSize: 13, color: colors.muted },
  link: { fontSize: 15, color: colors.primary, fontWeight: '600', marginTop: 4 },
  progressRow: { flexDirection: 'row', gap: 12 },
  progress: { fontSize: 32, fontWeight: '800', color: colors.text },
  progressOf: { fontSize: 20, fontWeight: '600', color: colors.muted },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.85 },
  placeNumber: { fontSize: 20, fontWeight: '800', color: colors.muted, minWidth: 28, textAlign: 'center' },
  placeBarcode: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 6 },
  placeQty: { alignItems: 'center' },
  placeQtyValue: { fontSize: 20, fontWeight: '800', color: colors.text },
});

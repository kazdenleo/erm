import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../context/AuthContext';
import { cargoBatchesApi, suppliersApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { scanError, scanOk } from '../../../lib/feedback';
import { writeItem } from '../../../lib/storage';
import { ScanBar } from '../../../components/ScanBar';
import { CargoReport } from '../../../features/cargo/CargoReport';
import { PlaceStatusBadge } from '../../../features/cargo/placeStatus';
import { Banner, Button, Card, Field, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

const POLL_MS = 5000;
const SUPPLIERS_LIMIT = 30;

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

function SupplierPicker({ onCancel, onConfirm, busy }) {
  const [suppliers, setSuppliers] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    suppliersApi
      .list()
      .then(setSuppliers)
      .catch((e) => {
        setSuppliers([]);
        setError(errorMessage(e, 'Не удалось загрузить поставщиков'));
      });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = suppliers || [];
    const matched = q ? list.filter((s) => String(s.name || '').toLowerCase().includes(q)) : list;
    return matched.slice(0, SUPPLIERS_LIMIT);
  }, [suppliers, query]);

  if (suppliers === null) return <Loading text="Загружаем поставщиков…" />;

  return (
    <Card style={styles.gap}>
      <Text style={styles.section}>Поставщик (необязательно)</Text>
      <Banner text={error} onClose={() => setError(null)} />
      <Field label="Поиск" value={query} onChangeText={setQuery} autoFocus />
      <Pressable onPress={() => setSelected(null)} style={[styles.option, selected == null && styles.optionActive]}>
        <Text style={[styles.optionText, selected == null && styles.optionTextActive]}>Без поставщика</Text>
      </Pressable>
      {filtered.map((s) => {
        const active = String(selected) === String(s.id);
        return (
          <Pressable key={s.id} onPress={() => setSelected(s.id)} style={[styles.option, active && styles.optionActive]}>
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{s.name}</Text>
          </Pressable>
        );
      })}
      <View style={styles.row}>
        <Button title="Отмена" variant="secondary" style={styles.flex} onPress={onCancel} />
        <Button title="Оформить" style={styles.flex} loading={busy} onPress={() => onConfirm(selected)} />
      </View>
    </Card>
  );
}

export default function CargoFreeBatchScreen() {
  const { batchId } = useLocalSearchParams();
  const id = String(batchId || '');
  const { user, organizationId } = useAuth();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editingExpected, setEditingExpected] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = useCallback(
    () =>
      cargoBatchesApi.get(id).then(
        (next) => {
          setData(next);
          setLoadError(null);
          writeItem('cargoBatch', next.status === 'open' ? id : null);
        },
        (e) => {
          if (e?.status === 404) writeItem('cargoBatch', null);
          setLoadError(errorMessage(e, 'Не удалось загрузить пакет'));
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

  const openPlace = (placeId) => router.push(`/cargo-free/place/${placeId}`);

  const accept = async (code, force = false) => {
    const res = await cargoBatchesApi.acceptPlace(id, code, { force });
    setData(res.state);
    if (res.alreadyAccepted) {
      scanOk();
      const place = res.state.places.find((p) => p.id === res.placeId);
      if (place && place.status !== 'received') {
        Alert.alert('Грузоместо уже принято', `${code}\n\nПерейти к приёмке товара из него?`, [
          { text: 'Отмена', style: 'cancel' },
          { text: 'Открыть', onPress: () => openPlace(res.placeId) },
        ]);
      } else {
        setMessage({ kind: 'warning', text: `${code}: уже оприходовано` });
      }
      return;
    }
    const total = res.state.places.length;
    const expected = res.state.expectedPlaces;
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
        setData(await cargoBatchesApi.setExpected(id, value));
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
              setData(await cargoBatchesApi.removePlace(place.id));
            } catch (e) {
              setMessage({ kind: 'error', text: errorMessage(e) });
            }
          }),
      },
    ]);

  const complete = async (supplierId) => {
    setCompleteBusy(true);
    try {
      const next = await cargoBatchesApi.complete(id, {
        supplierId,
        organizationId: organizationId ? Number(organizationId) : null,
      });
      setData(next);
      setCompleting(false);
      writeItem('cargoBatch', null);
      Alert.alert('Приёмка оформлена', 'Товар оприходован на склад. Ниже — отчёт по грузоместам.');
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
    const expected = data.expectedPlaces;
    const warnings = [];
    if (expected != null && places.length < expected) warnings.push(`Принято мест: ${places.length} из ${expected}.`);
    if (withoutItems) warnings.push(`Мест без разбора товара: ${withoutItems}.`);
    if (inProgress) warnings.push(`Не закрыто мест: ${inProgress}.`);
    if (inProgress) {
      Alert.alert('Есть открытые места', 'Сначала закройте все открытые грузоместа.');
      return;
    }
    Alert.alert(
      'Оформить приёмку?',
      [`Будет оприходовано ${data.scannedTotal} шт.`, ...warnings].join('\n'),
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Далее', onPress: () => setCompleting(true) },
      ]
    );
  };

  if (!data && !loadError) return <Loading text="Загружаем пакет…" />;

  if (!data) {
    return (
      <View style={styles.content}>
        <Banner text={loadError} />
        <Button title="К списку" variant="secondary" onPress={() => router.replace('/cargo-free')} />
      </View>
    );
  }

  const { places = [], report, expectedPlaces } = data;
  const doneCount = places.filter((p) => p.status === 'closed' || p.status === 'received').length;
  const isOwner = !data.createdByUserId || (user?.id != null && Number(data.createdByUserId) === Number(user.id));
  const isOpen = data.status === 'open';

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `Пакет №${data.id}` }} />
      {isOpen ? (
        <View style={styles.scanArea}>
          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder="Отсканируйте грузоместо"
            cameraHint="Наведите на штрихкод грузоместа"
          />
        </View>
      ) : null}
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={styles.gapSmall}>
          <Text style={styles.supplier}>{data.warehouseName || `Склад #${data.warehouseId}`}</Text>
          <Text style={styles.muted}>Статус: {data.status === 'open' ? 'В работе' : 'Оформлено'}</Text>
        </Card>

        <Card style={styles.gapSmall}>
          <View style={styles.progressRow}>
            <View style={styles.flex}>
              <Text style={styles.muted}>Принято мест</Text>
              <Text style={styles.progress}>
                {places.length}
                {expectedPlaces != null ? <Text style={styles.progressOf}> из {expectedPlaces}</Text> : null}
              </Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.muted}>Разобрано</Text>
              <Text style={styles.progress}>{doneCount}</Text>
            </View>
          </View>
          {isOpen ? (
            editingExpected ? (
              <ExpectedEditor
                value={expectedPlaces}
                busy={busy}
                onCancel={() => setEditingExpected(false)}
                onSave={saveExpected}
              />
            ) : (
              <Pressable onPress={() => setEditingExpected(true)}>
                <Text style={styles.link}>
                  {expectedPlaces != null ? 'Изменить ожидаемое количество мест' : 'Указать, сколько мест должно прийти'}
                </Text>
              </Pressable>
            )
          ) : null}
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
            onPress={() => (isOpen ? openPlace(place.id) : null)}
            onLongPress={() => (isOpen && place.status === 'accepted' ? confirmRemove(place) : null)}
            style={({ pressed }) => [styles.place, pressed && isOpen && styles.pressed]}
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
        {isOpen && places.some((p) => p.status === 'accepted') ? (
          <Text style={styles.mutedSmall}>Нажмите на место, чтобы принять товар; удерживайте, чтобы удалить ошибочный скан.</Text>
        ) : null}

        <CargoReport report={report} />

        {isOpen ? (
          completing ? (
            <SupplierPicker busy={completeBusy} onCancel={() => setCompleting(false)} onConfirm={complete} />
          ) : (
            <Card style={styles.gap}>
              <Text style={styles.section}>Оформление</Text>
              <Text style={styles.muted}>Принято товара: {data.scannedTotal} шт</Text>
              {isOwner ? (
                <Button
                  title="Оформить приёмку"
                  disabled={data.scannedTotal <= 0}
                  loading={completeBusy}
                  onPress={confirmComplete}
                />
              ) : (
                <Text style={styles.mutedSmall}>Оформить приёмку может только сотрудник, который её начал.</Text>
              )}
            </Card>
          )
        ) : (
          <Card style={styles.gap}>
            <Text style={styles.muted}>
              Приёмка оформлена
              {data.warehouseReceiptId ? ` · документ #${data.warehouseReceiptId}` : ''}
            </Text>
            <Button title="К списку" variant="secondary" onPress={() => router.replace('/cargo-free')} />
          </Card>
        )}
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
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
});

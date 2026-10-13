import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  DEFAULT_PRINTER_SETTINGS,
  directPrintAvailable,
  listBondedDevices,
  loadPrinterSettings,
  printTestLabel,
  savePrinterSettings,
} from '../../lib/labelPrinter';
import { Banner, Button, Card, Field } from '../../ui/components';
import { colors } from '../../ui/theme';

const NUMBER_FIELDS = [
  { key: 'widthMm', label: 'Ширина, мм', min: 20, max: 110 },
  { key: 'heightMm', label: 'Высота, мм', min: 10, max: 200 },
  { key: 'gapMm', label: 'Зазор, мм', min: 0, max: 10 },
  { key: 'density', label: 'Плотность (1–15)', min: 1, max: 15 },
];

export default function PrinterSettingsCard() {
  const [settings, setSettings] = useState(DEFAULT_PRINTER_SETTINGS);
  const [drafts, setDrafts] = useState({});
  const [devices, setDevices] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadPrinterSettings().then(setSettings);
  }, []);

  const update = (patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      savePrinterSettings(next);
      return next;
    });
  };

  const run = async (name, action) => {
    setBusy(name);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || String(e) });
    } finally {
      setBusy(null);
    }
  };

  const findDevices = () =>
    run('devices', async () => {
      const list = await listBondedDevices();
      setDevices(list);
      if (!list.length) {
        setMessage({ kind: 'warning', text: 'Нет сопряжённых устройств. Сначала подключите принтер в настройках Bluetooth телефона.' });
      }
    });

  const selectDevice = (device) => {
    update({ address: device.address, name: device.name });
    setDevices(null);
  };

  const testPrint = () =>
    run('test', async () => {
      await printTestLabel(settings);
      setMessage({ kind: 'success', text: 'Тестовая этикетка отправлена на принтер' });
    });

  const commitNumber = (field) => {
    const raw = drafts[field.key];
    if (raw == null) return;
    const value = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(value) && value >= field.min && value <= field.max) {
      update({ [field.key]: value });
    }
    setDrafts((prev) => ({ ...prev, [field.key]: undefined }));
  };

  if (!directPrintAvailable) {
    return (
      <Card style={styles.gap}>
        <Text style={styles.section}>Принтер этикеток</Text>
        <Text style={styles.muted}>Прямая печать на Bluetooth-принтер доступна только в установленном APK на Android.</Text>
      </Card>
    );
  }

  return (
    <Card style={styles.gap}>
      <Text style={styles.section}>Принтер этикеток</Text>
      <Text style={styles.muted}>
        Xprinter и другие TSPL-принтеры по Bluetooth. Сначала включите принтер и сопрягите его в настройках Bluetooth
        телефона (PIN обычно 0000 или 1234), затем выберите его здесь.
      </Text>

      <Text style={styles.text}>
        {settings.address ? `Выбран: ${settings.name || 'без имени'} (${settings.address})` : 'Принтер не выбран — печать через системный диалог'}
      </Text>

      <View style={styles.buttons}>
        <Button title="Выбрать принтер" small onPress={findDevices} loading={busy === 'devices'} disabled={!!busy} />
        {settings.address ? (
          <Button title="Забыть" small variant="secondary" onPress={() => update({ address: null, name: null })} disabled={!!busy} />
        ) : null}
      </View>

      {devices?.length ? (
        <View style={styles.gap}>
          {devices.map((d) => {
            const active = d.address === settings.address;
            return (
              <Pressable key={d.address} onPress={() => selectDevice(d)} style={[styles.option, active && styles.optionActive]}>
                <Text style={[styles.optionText, active && styles.optionTextActive]}>{d.name || 'Без имени'}</Text>
                <Text style={styles.muted}>{d.address}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.grid}>
        {NUMBER_FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            style={styles.cell}
            keyboardType="decimal-pad"
            value={drafts[f.key] ?? String(settings[f.key])}
            onChangeText={(t) => setDrafts((prev) => ({ ...prev, [f.key]: t }))}
            onBlur={() => commitNumber(f)}
            onSubmitEditing={() => commitNumber(f)}
          />
        ))}
      </View>

      <View style={styles.row}>
        <Text style={styles.rowText}>Повернуть на 180°</Text>
        <Switch value={settings.direction === 0} onValueChange={(v) => update({ direction: v ? 0 : 1 })} />
      </View>
      <View style={styles.row}>
        <Text style={styles.rowText}>Инвертировать (если печатает негатив)</Text>
        <Switch value={!!settings.invert} onValueChange={(v) => update({ invert: v })} />
      </View>

      <Button title="Тестовая печать" onPress={testPrint} disabled={!!busy || !settings.address} loading={busy === 'test'} />
      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  text: { fontSize: 16, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  buttons: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: { flexBasis: '47%', flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, fontSize: 16, color: colors.text },
});

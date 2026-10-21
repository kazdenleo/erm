import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useAuth } from '../../context/AuthContext';
import PrinterSettingsCard from '../../features/printer/PrinterSettingsCard';
import {
  CAMERA_SCAN_MODE_LABELS,
  CAMERA_SCAN_MODES,
  loadCameraScanMode,
  saveCameraScanMode,
} from '../../lib/cameraScanMode';
import { readItem, writeItem } from '../../lib/storage';
import { Button, Card } from '../../ui/components';
import { colors } from '../../ui/theme';

export default function SettingsScreen() {
  const { user, organizations, organizationId, selectOrganization, serverUrl, signOut } = useAuth();
  const [autoPrint, setAutoPrint] = useState(false);
  const [cameraScanMode, setCameraScanMode] = useState(CAMERA_SCAN_MODES.continuous);

  useEffect(() => {
    readItem('autoPrintLabel').then((v) => setAutoPrint(v === '1'));
    loadCameraScanMode().then(setCameraScanMode);
  }, []);

  const toggleAutoPrint = (v) => {
    setAutoPrint(v);
    writeItem('autoPrintLabel', v ? '1' : null);
  };

  const setScanMode = (mode) => {
    setCameraScanMode(mode);
    saveCameraScanMode(mode);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card style={styles.gap}>
        <Text style={styles.section}>Организация</Text>
        {organizations.length === 0 ? (
          <Text style={styles.muted}>Нет доступных организаций</Text>
        ) : (
          organizations.map((o) => {
            const active = String(o.id) === String(organizationId);
            return (
              <Pressable
                key={o.id}
                onPress={() => selectOrganization(o.id)}
                style={[styles.option, active && styles.optionActive]}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>{o.name || `#${o.id}`}</Text>
              </Pressable>
            );
          })
        )}
      </Card>

      <Card style={styles.gap}>
        <Text style={styles.section}>Сканер камеры</Text>
        <Text style={styles.muted}>
          Для печати ШК упаковки удобнее «По кнопке»: код находится в кадре, печать — только после нажатия
          «Сканировать». «Постоянно» — как раньше, сразу принимает каждый новый штрихкод.
        </Text>
        <View style={styles.modeRow}>
          {[CAMERA_SCAN_MODES.continuous, CAMERA_SCAN_MODES.button].map((mode) => {
            const active = cameraScanMode === mode;
            return (
              <Pressable
                key={mode}
                onPress={() => setScanMode(mode)}
                style={[styles.modeBtn, active && styles.modeBtnActive]}
              >
                <Text style={[styles.modeBtnText, active && styles.modeBtnTextActive]}>
                  {CAMERA_SCAN_MODE_LABELS[mode]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card style={styles.gap}>
        <Text style={styles.section}>Сборка</Text>
        <View style={styles.row}>
          <Text style={styles.rowText}>Печатать этикетку сразу после сборки</Text>
          <Switch value={autoPrint} onValueChange={toggleAutoPrint} />
        </View>
        <Text style={styles.muted}>
          Если ниже выбран принтер этикеток — стикер сразу уходит на него по Bluetooth. Иначе открывается системный
          диалог печати Android. Если этикетки печатает ПК на складе — оставьте выключенным.
        </Text>
      </Card>

      <PrinterSettingsCard />

      <Card style={styles.gap}>
        <Text style={styles.section}>Аккаунт</Text>
        <Text style={styles.text}>{user?.fullName || user?.email}</Text>
        <Text style={styles.muted}>Сервер: {serverUrl}</Text>
        <Text style={styles.muted}>Версия приложения: {Constants.expoConfig?.version}</Text>
        <Button title="Выйти" variant="danger" onPress={signOut} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  gap: { gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  text: { fontSize: 16, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, fontSize: 16, color: colors.text },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeBtn: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  modeBtnActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  modeBtnText: { fontSize: 16, color: colors.text, fontWeight: '600' },
  modeBtnTextActive: { color: colors.primary },
});

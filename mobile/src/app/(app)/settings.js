import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useAuth } from '../../context/AuthContext';
import { readItem, writeItem } from '../../lib/storage';
import { Button, Card } from '../../ui/components';
import { colors } from '../../ui/theme';

export default function SettingsScreen() {
  const { user, organizations, organizationId, selectOrganization, serverUrl, signOut } = useAuth();
  const [autoPrint, setAutoPrint] = useState(false);

  useEffect(() => {
    readItem('autoPrintLabel').then((v) => setAutoPrint(v === '1'));
  }, []);

  const toggleAutoPrint = (v) => {
    setAutoPrint(v);
    writeItem('autoPrintLabel', v ? '1' : null);
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
        <Text style={styles.section}>Сборка</Text>
        <View style={styles.row}>
          <Text style={styles.rowText}>Печатать этикетку сразу после сборки</Text>
          <Switch value={autoPrint} onValueChange={toggleAutoPrint} />
        </View>
        <Text style={styles.muted}>
          Печать идёт через системный диалог телефона (Wi‑Fi принтер или служба печати Android). Если этикетки печатает
          ПК на складе — оставьте выключенным.
        </Text>
      </Card>

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
});

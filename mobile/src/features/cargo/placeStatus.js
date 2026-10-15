import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../ui/theme';

const STATUS = {
  accepted: { label: 'Принято', fg: colors.primary, bg: '#EFF4FF' },
  opened: { label: 'В работе', fg: colors.warning, bg: colors.warningBg },
  closed: { label: 'Разобрано', fg: colors.success, bg: colors.successBg },
  received: { label: 'Оприходовано', fg: colors.muted, bg: colors.bg },
};

export function PlaceStatusBadge({ status }) {
  const s = STATUS[status] || STATUS.accepted;
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.text, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, alignSelf: 'flex-start' },
  text: { fontSize: 13, fontWeight: '700' },
});

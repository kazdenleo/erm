import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from './theme';

export function Button({ title, onPress, variant = 'primary', disabled = false, loading = false, style, small = false }) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        isPrimary && styles.buttonPrimary,
        isDanger && styles.buttonDanger,
        !isPrimary && !isDanger && styles.buttonSecondary,
        (disabled || loading) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary || isDanger ? colors.primaryText : colors.primary} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            small && styles.buttonTextSmall,
            (isPrimary || isDanger) && { color: colors.primaryText },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field({ label, style, ...inputProps }) {
  return (
    <View style={[styles.field, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} style={styles.input} {...inputProps} />
    </View>
  );
}

export function Banner({ kind = 'error', text, onClose }) {
  if (!text) return null;
  const palette =
    kind === 'success'
      ? { bg: colors.successBg, fg: colors.success }
      : kind === 'warning'
        ? { bg: colors.warningBg, fg: colors.warning }
        : { bg: colors.dangerBg, fg: colors.danger };
  return (
    <Pressable onPress={onClose} style={[styles.banner, { backgroundColor: palette.bg }]}>
      <Text style={[styles.bannerText, { color: palette.fg }]}>{text}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, color }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: color || colors.primary, borderColor: color || colors.primary }]}
    >
      <Text style={[styles.chipText, active && { color: colors.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

export function Loading({ text }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
      {text ? <Text style={styles.muted}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonSmall: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  buttonSecondary: { backgroundColor: colors.card, borderColor: colors.border },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 17, fontWeight: '600', color: colors.primary },
  buttonTextSmall: { fontSize: 15 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  field: { gap: 6 },
  label: { fontSize: 14, color: colors.muted },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 17,
    color: colors.text,
    backgroundColor: colors.card,
  },
  banner: { borderRadius: 12, padding: 14 },
  bannerText: { fontSize: 16, fontWeight: '500' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipText: { fontSize: 15, color: colors.text, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  muted: { color: colors.muted, fontSize: 15, textAlign: 'center' },
});

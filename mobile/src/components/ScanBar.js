import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CameraScanner } from './CameraScanner';
import { colors } from '../ui/theme';

function cleanCode(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, '')
    .trim();
}

/**
 * Поле скана: аппаратный сканер ТСД работает как клавиатура (код + Enter),
 * камера телефона — через кнопку «Камера». Экранная клавиатура по умолчанию скрыта.
 */
export const ScanBar = forwardRef(function ScanBar({ onScan, busy = false, placeholder, cameraHint }, ref) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const focus = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useImperativeHandle(ref, () => ({ focus }), [focus]);

  useFocusEffect(
    useCallback(() => {
      focus();
    }, [focus])
  );

  const submit = (raw) => {
    const code = cleanCode(raw);
    setValue('');
    if (code.length >= 2) onScan(code);
    focus();
  };

  const onChangeText = (text) => {
    // Часть сканеров присылает перевод строки внутри текста вместо события submit.
    if (/[\r\n]/.test(text)) submit(text);
    else setValue(text);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={() => submit(value)}
          submitBehavior="submit"
          showSoftInputOnFocus={keyboard}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="done"
          placeholder={placeholder || 'Отсканируйте штрихкод'}
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        {busy ? <ActivityIndicator style={styles.spinner} color={colors.primary} /> : null}
      </View>
      <View style={styles.actions}>
        <Pressable style={[styles.action, styles.camera]} onPress={() => setCameraOpen(true)}>
          <Text style={[styles.actionText, styles.cameraText]}>Камера</Text>
        </Pressable>
        <Pressable
          style={[styles.action, keyboard && styles.actionActive]}
          onPress={() => {
            setKeyboard((k) => !k);
            inputRef.current?.blur();
            focus();
          }}
        >
          <Text style={styles.actionText}>{keyboard ? 'Скрыть клавиатуру' : 'Ввести вручную'}</Text>
        </Pressable>
      </View>
      <CameraScanner
        visible={cameraOpen}
        hint={cameraHint}
        onClose={() => {
          setCameraOpen(false);
          focus();
        }}
        onScan={(code) => onScan(code)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  inputRow: { justifyContent: 'center' },
  input: {
    minHeight: 56,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingRight: 44,
    fontSize: 18,
    color: colors.text,
    backgroundColor: colors.card,
  },
  spinner: { position: 'absolute', right: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  action: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  actionActive: { borderColor: colors.primary },
  actionText: { fontSize: 16, fontWeight: '600', color: colors.text },
  camera: { backgroundColor: colors.primary, borderColor: colors.primary },
  cameraText: { color: colors.primaryText },
});

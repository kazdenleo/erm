import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CameraScanner } from './CameraScanner';
import { colors } from '../ui/theme';

function cleanCode(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, '')
    .trim();
}

/** Сканер в режиме клавиатуры печатает код за доли секунды; пауза дольше — код целиком введён. */
const SCAN_IDLE_MS = 350;

/** Один и тот же ШК повторно не принимаем (двойной скан / удержание в луче). */
const DUPLICATE_COOLDOWN_MS = 1500;

/**
 * Поле скана: аппаратный сканер ТСД работает как клавиатура — код принимается по Enter или,
 * если сканер не шлёт Enter, автоматически после паузы во вводе. Камера телефона — через кнопку «Камера».
 * Экранная клавиатура по умолчанию скрыта; в режиме ручного ввода код принимается только по Enter.
 */
export const ScanBar = forwardRef(function ScanBar({ onScan, busy = false, placeholder, cameraHint }, ref) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const idleTimer = useRef(null);
  const onScanRef = useRef(onScan);
  const queue = useRef([]);
  const draining = useRef(false);
  const lastAccepted = useRef({ code: '', at: 0 });
  const busyWas = useRef(busy);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    []
  );

  const clearIdleTimer = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  };

  const focus = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useImperativeHandle(ref, () => ({ focus }), [focus]);

  useFocusEffect(
    useCallback(() => {
      focus();
    }, [focus])
  );

  // После обработки скана поле часто теряет фокус — вернуть его, иначе следующий скан «висит» до нажатия.
  useEffect(() => {
    if (busyWas.current && !busy && !keyboard && !cameraOpen) focus();
    busyWas.current = busy;
  }, [busy, keyboard, cameraOpen, focus]);

  /** Коды, отсканированные во время обработки предыдущего, не теряются, а обрабатываются по очереди. */
  const enqueue = useCallback(async (code) => {
    const now = Date.now();
    if (code === lastAccepted.current.code && now - lastAccepted.current.at < DUPLICATE_COOLDOWN_MS) {
      return;
    }
    if (queue.current[queue.current.length - 1] === code) return;

    lastAccepted.current = { code, at: now };
    queue.current.push(code);
    if (draining.current) return;
    draining.current = true;
    try {
      while (queue.current.length) {
        const next = queue.current.shift();
        try {
          await onScanRef.current(next);
        } catch {
          /* ошибки показывает сам экран */
        }
        // Дать экрану перерисоваться, чтобы следующий код обработался уже с обновлённым состоянием.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      draining.current = false;
    }
  }, []);

  const submit = (raw) => {
    clearIdleTimer();
    const code = cleanCode(raw);
    setValue('');
    if (code.length >= 2) enqueue(code);
    focus();
  };

  const onChangeText = (text) => {
    // Часть сканеров присылает перевод строки внутри текста вместо события submit.
    if (/[\r\n]/.test(text)) {
      submit(text);
      return;
    }
    setValue(text);
    clearIdleTimer();
    if (!keyboard && text) {
      idleTimer.current = setTimeout(() => submit(text), SCAN_IDLE_MS);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={() => submit(value)}
          blurOnSubmit={false}
          submitBehavior="submit"
          showSoftInputOnFocus={keyboard}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          importantForAutofill="no"
          textContentType="none"
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
            clearIdleTimer();
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
        onScan={enqueue}
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

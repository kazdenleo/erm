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

function CameraIcon({ active }) {
  const stroke = active ? colors.primaryText : colors.primary;
  return (
    <View style={styles.iconRoot} accessibilityElementsHidden>
      <View style={[styles.iconBody, { borderColor: stroke }]} />
      <View style={[styles.iconLens, { borderColor: stroke }]} />
      <View style={[styles.iconBump, { backgroundColor: stroke }]} />
    </View>
  );
}

/**
 * Скан без ручного ввода: скрытое поле принимает аппаратный сканер ТСД,
 * камера включается/выключается иконкой (без модалки и без «Готово»).
 */
export const ScanBar = forwardRef(function ScanBar({ onScan, busy = false, placeholder, cameraHint }, ref) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
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

  useEffect(() => {
    if (busyWas.current && !busy) focus();
    busyWas.current = busy;
  }, [busy, focus]);

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
    if (/[\r\n]/.test(text)) {
      submit(text);
      return;
    }
    setValue(text);
    clearIdleTimer();
    if (text) {
      idleTimer.current = setTimeout(() => submit(text), SCAN_IDLE_MS);
    }
  };

  const toggleCamera = () => {
    setCameraOpen((open) => !open);
    focus();
  };

  return (
    <View style={styles.wrap}>
      {/* Скрытый приёмник для аппаратного сканера (клавиатурный wedge). */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={() => submit(value)}
        blurOnSubmit={false}
        submitBehavior="submit"
        showSoftInputOnFocus={false}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        importantForAutofill="no"
        textContentType="none"
        caretHidden
        contextMenuHidden
        accessible={false}
        style={styles.hiddenInput}
      />

      <View style={styles.toolbar}>
        <View style={styles.status}>
          <Text style={styles.statusText} numberOfLines={2}>
            {busy ? 'Обрабатываем скан…' : placeholder || 'Отсканируйте штрихкод'}
          </Text>
          {busy ? <ActivityIndicator color={colors.primary} /> : null}
        </View>
        <Pressable
          onPress={toggleCamera}
          style={[styles.cameraBtn, cameraOpen && styles.cameraBtnActive]}
          accessibilityRole="button"
          accessibilityLabel={cameraOpen ? 'Скрыть камеру' : 'Показать камеру'}
        >
          <CameraIcon active={cameraOpen} />
        </Pressable>
      </View>

      <CameraScanner active={cameraOpen} hint={cameraHint} onScan={enqueue} />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  hiddenInput: {
    position: 'absolute',
    opacity: 0.01,
    height: 1,
    width: 1,
    padding: 0,
    margin: 0,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.card,
  },
  status: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusText: { flex: 1, fontSize: 16, color: colors.text, fontWeight: '600' },
  cameraBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  cameraBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  iconRoot: { width: 26, height: 20, justifyContent: 'center', alignItems: 'center' },
  iconBody: {
    width: 24,
    height: 16,
    borderWidth: 2,
    borderRadius: 4,
  },
  iconLens: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderWidth: 2,
    borderRadius: 4,
  },
  iconBump: {
    position: 'absolute',
    top: 0,
    right: 4,
    width: 6,
    height: 3,
    borderRadius: 1,
  },
});

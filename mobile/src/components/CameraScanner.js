import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  CAMERA_SCAN_MODES,
  loadCameraScanMode,
  normalizeCameraScanMode,
} from '../lib/cameraScanMode';
import { Button } from '../ui/components';
import { colors } from '../ui/theme';

const BARCODE_TYPES = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'code93',
  'itf14',
  'codabar',
  'qr',
  'datamatrix',
];

/** В continuous: пауза между авто-приёмами одного и того же кода. */
const SAME_CODE_PAUSE_MS = 2500;

/**
 * Встроенный сканер камеры.
 * mode: continuous | button (если не передан — читается из настроек).
 */
export function CameraScanner({ active, onScan, hint, mode: modeProp, busy = false }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [mode, setMode] = useState(() => normalizeCameraScanMode(modeProp));
  const [previewCode, setPreviewCode] = useState('');
  const lastAutoRef = useRef({ code: '', at: 0 });
  /** После авто-приёма этот код игнорируем, пока в кадре не появится другой. */
  const lockedCodeRef = useRef('');
  const previewRef = useRef('');

  useEffect(() => {
    if (modeProp) {
      setMode(normalizeCameraScanMode(modeProp));
      return undefined;
    }
    let cancelled = false;
    loadCameraScanMode().then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, [modeProp]);

  useEffect(() => {
    if (!active) {
      setPreviewCode('');
      previewRef.current = '';
      lockedCodeRef.current = '';
      lastAutoRef.current = { code: '', at: 0 };
    }
  }, [active]);

  if (!active) return null;

  const isButton = mode === CAMERA_SCAN_MODES.button;

  const handleScanned = ({ data }) => {
    if (busy) return;
    const code = String(data || '').trim();
    if (!code) return;

    if (isButton) {
      if (previewRef.current !== code) {
        previewRef.current = code;
        setPreviewCode(code);
      }
      return;
    }

    // continuous: другой код снимает блокировку предыдущего
    if (lockedCodeRef.current && lockedCodeRef.current !== code) {
      lockedCodeRef.current = '';
    }
    if (lockedCodeRef.current === code) return;

    const now = Date.now();
    if (lastAutoRef.current.code === code && now - lastAutoRef.current.at < SAME_CODE_PAUSE_MS) {
      return;
    }
    lastAutoRef.current = { code, at: now };
    lockedCodeRef.current = code;
    previewRef.current = code;
    setPreviewCode(code);
    onScan(code);
  };

  const acceptPreview = () => {
    if (busy) return;
    const code = String(previewRef.current || previewCode || '').trim();
    if (!code) return;
    lockedCodeRef.current = code;
    onScan(code);
    // После приёма по кнопке сбрасываем превью — следующий тот же ШК нужно снова навести и нажать.
    previewRef.current = '';
    setPreviewCode('');
  };

  if (!permission) return <View style={styles.panel} />;

  if (!permission.granted) {
    return (
      <View style={[styles.panel, styles.center]}>
        <Text style={styles.permText}>Нужен доступ к камере для сканирования штрихкодов.</Text>
        <Button title="Разрешить" onPress={requestPermission} />
      </View>
    );
  }

  return (
    // На Android TextureView/SurfaceView камеры чернеет внутри ScrollView и при overflow:hidden.
    <View style={styles.panel} collapsable={false}>
      <View style={styles.cameraWrap} collapsable={false}>
        <CameraView
          style={styles.camera}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={busy ? undefined : handleScanned}
        />
        <View pointerEvents="none" style={styles.frame} />
      </View>
      <View style={styles.overlay}>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        <Text style={styles.modeBadge}>
          {isButton ? 'Режим: по кнопке' : 'Режим: постоянно'}
        </Text>
        <Text style={styles.last} numberOfLines={1}>
          {previewCode
            ? isButton
              ? `Найден: ${previewCode}`
              : `Последний: ${previewCode}`
            : 'Наведите на штрихкод'}
        </Text>
        {isButton ? (
          <Button
            title={busy ? 'Обработка…' : previewCode ? 'Сканировать' : 'Наведите на код'}
            onPress={acceptPreview}
            disabled={busy || !previewCode}
            style={styles.acceptBtn}
          />
        ) : null}
        <Pressable style={styles.torch} onPress={() => setTorch((t) => !t)}>
          <Text style={styles.torchText}>{torch ? 'Фонарик: вкл' : 'Фонарик'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: 300,
    borderRadius: 14,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: colors.border,
    // Не использовать overflow:'hidden' — на Android это часто даёт чёрный превью.
    ...Platform.select({ android: { elevation: 1 }, ios: {} }),
  },
  cameraWrap: {
    flex: 1,
    width: '100%',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    overflow: Platform.OS === 'ios' ? 'hidden' : 'visible',
  },
  camera: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  frame: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '18%',
    height: '40%',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 12,
  },
  overlay: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
  },
  hint: { color: '#FDE68A', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  modeBadge: { color: '#93C5FD', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  last: { color: '#fff', fontSize: 13, textAlign: 'center' },
  acceptBtn: { alignSelf: 'stretch', marginTop: 2 },
  torch: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#1F2937',
  },
  torchText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16, backgroundColor: colors.card },
  permText: { fontSize: 15, color: colors.text, textAlign: 'center' },
});

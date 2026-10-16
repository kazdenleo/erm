import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
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

/** Тот же код повторно не принимаем, пока он в кадре (камера шлёт десятки событий в секунду). */
const SAME_CODE_PAUSE_MS = 2000;

/** Встроенный сканер камеры (без модалки и без кнопки «Готово»). */
export function CameraScanner({ active, onScan, hint }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [lastCode, setLastCode] = useState('');
  const lastRef = useRef({ code: '', at: 0 });

  if (!active) return null;

  const handleScanned = ({ data }) => {
    const code = String(data || '').trim();
    if (!code) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < SAME_CODE_PAUSE_MS) return;
    lastRef.current = { code, at: now };
    setLastCode(code);
    onScan(code);
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
          onBarcodeScanned={handleScanned}
        />
        <View pointerEvents="none" style={styles.frame} />
      </View>
      <View style={styles.overlay}>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        <Text style={styles.last} numberOfLines={1}>
          {lastCode ? `Последний: ${lastCode}` : 'Наведите на штрихкод'}
        </Text>
        <Pressable style={styles.torch} onPress={() => setTorch((t) => !t)}>
          <Text style={styles.torchText}>{torch ? 'Фонарик: вкл' : 'Фонарик'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: 260,
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
    top: '22%',
    height: '42%',
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
  last: { color: '#fff', fontSize: 13, textAlign: 'center' },
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

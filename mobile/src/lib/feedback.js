import { Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';

/** Короткий сигнал успешного скана (вибрация + haptic). */
export function scanOk() {
  try {
    if (Platform.OS === 'android') Vibration.vibrate(50);
    else Vibration.vibrate(10);
  } catch {
    /* ignore */
  }
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Сигнал ошибки скана. */
export function scanError() {
  try {
    if (Platform.OS === 'android') Vibration.vibrate([0, 60, 50, 60]);
    else Vibration.vibrate(40);
  } catch {
    /* ignore */
  }
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

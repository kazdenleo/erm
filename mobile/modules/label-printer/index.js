import { requireOptionalNativeModule } from 'expo';

/** Нативная печать на термопринтер этикеток (TSPL по Bluetooth). null — в Expo Go и на iOS. */
export default requireOptionalNativeModule('LabelPrinter');

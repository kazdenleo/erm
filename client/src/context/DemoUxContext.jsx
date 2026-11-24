/**
 * Контекст UX демо/онбординга: чеклист, подсказки, бейджи.
 */
import React, { createContext, useContext } from 'react';
import { useDemoUx } from '../hooks/useDemoUx.js';

const DemoUxContext = createContext(null);

export function DemoUxProvider({ children }) {
  const value = useDemoUx();
  return <DemoUxContext.Provider value={value}>{children}</DemoUxContext.Provider>;
}

export function useDemoUxContext() {
  const ctx = useContext(DemoUxContext);
  if (!ctx) {
    return {
      ux: null,
      loading: false,
      reload: async () => null,
      completeStep: async () => null,
      dismissHint: async () => null,
      dismissChecklist: async () => null,
      extendDemo: async () => null,
      hintVisible: () => false,
    };
  }
  return ctx;
}

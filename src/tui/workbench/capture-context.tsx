import React, { createContext, useContext } from 'react';

export type CaptureSetter = (on: boolean) => void;

const CaptureContext = createContext<CaptureSetter>(() => {});

export function useCapture(): CaptureSetter {
  return useContext(CaptureContext);
}

export function CaptureProvider({
  value,
  children,
}: {
  value: CaptureSetter;
  children: React.ReactNode;
}): React.ReactElement {
  return React.createElement(CaptureContext.Provider, { value }, children);
}

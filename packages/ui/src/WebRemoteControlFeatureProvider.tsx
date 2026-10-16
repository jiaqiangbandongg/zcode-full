import { createContext, useContext } from "react";
import type { ReactNode } from "react";
const DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED = true;

const WebRemoteControlFeatureContext = createContext(
  DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED,
);

export function WebRemoteControlFeatureProvider({
  enabled = DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <WebRemoteControlFeatureContext.Provider value={enabled}>
      {children}
    </WebRemoteControlFeatureContext.Provider>
  );
}

export function useWebRemoteControlFeatureEnabled(): boolean {
  return useContext(WebRemoteControlFeatureContext);
}

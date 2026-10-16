export interface WebRemoteControlFeatureGate {
  isEnabled(): boolean;
  assertEnabled(): void;
}

export function createWebRemoteControlFeatureGate(
  enabled = true,
): WebRemoteControlFeatureGate {
  return {
    isEnabled: () => enabled,
    assertEnabled: () => {
      if (!enabled) {
        throw new Error("Web remote control is disabled in this build");
      }
    },
  };
}

import type { ElkPoint } from "elkjs/lib/elk-api.js";

export const ENGINEERING_INFRASTRUCTURE_SYSTEM_ID =
  "engineering-infrastructure";
export const CAPABILITY_MAP_ROOT_PADDING = 16;
export const CAPABILITY_MAP_SYSTEM_GAP = 48;

export interface CapabilitySystemPlacementInput {
  id: string;
  width: number;
  height: number;
}

export function buildCapabilitySystemPositions(
  systemLayouts: CapabilitySystemPlacementInput[],
) {
  const engineeringInfrastructure = systemLayouts.find(
    (systemLayout) =>
      systemLayout.id === ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
  );
  const runtimeSystems = systemLayouts.filter(
    (systemLayout) =>
      systemLayout.id !== ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
  );
  const positions = new Map<string, ElkPoint>();
  let x = CAPABILITY_MAP_ROOT_PADDING;
  let runtimeRowHeight = 0;

  for (const systemLayout of runtimeSystems) {
    positions.set(systemLayout.id, {
      x,
      y: CAPABILITY_MAP_ROOT_PADDING,
    });
    x += systemLayout.width + CAPABILITY_MAP_SYSTEM_GAP;
    runtimeRowHeight = Math.max(runtimeRowHeight, systemLayout.height);
  }

  if (engineeringInfrastructure) {
    const runtimeRowRight =
      runtimeSystems.length > 0
        ? x - CAPABILITY_MAP_SYSTEM_GAP
        : CAPABILITY_MAP_ROOT_PADDING;
    const runtimeRowWidth =
      runtimeRowRight - CAPABILITY_MAP_ROOT_PADDING;
    positions.set(engineeringInfrastructure.id, {
      x:
        CAPABILITY_MAP_ROOT_PADDING +
        Math.max(
          0,
          (runtimeRowWidth - engineeringInfrastructure.width) / 2,
        ),
      y:
        CAPABILITY_MAP_ROOT_PADDING +
        runtimeRowHeight +
        CAPABILITY_MAP_SYSTEM_GAP,
    });
  }

  return positions;
}

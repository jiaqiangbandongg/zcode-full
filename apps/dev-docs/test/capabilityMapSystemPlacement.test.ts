import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MAP_ROOT_PADDING,
  CAPABILITY_MAP_SYSTEM_GAP,
  ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
  buildCapabilitySystemPositions,
} from "@/capability-map/capabilityMapSystemPlacement.js";

describe("能力图顶层区域布局", () => {
  it("前三个运行层横向排列，工程基础设施居中放在下方", () => {
    const positions = buildCapabilitySystemPositions([
      { id: "renderer", width: 100, height: 200 },
      { id: "host", width: 120, height: 180 },
      { id: "zcode-cli", width: 80, height: 220 },
      {
        id: ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
        width: 160,
        height: 100,
      },
    ]);

    expect(positions.get("renderer")).toEqual({
      x: CAPABILITY_MAP_ROOT_PADDING,
      y: CAPABILITY_MAP_ROOT_PADDING,
    });
    expect(positions.get("host")).toEqual({
      x: CAPABILITY_MAP_ROOT_PADDING + 100 + CAPABILITY_MAP_SYSTEM_GAP,
      y: CAPABILITY_MAP_ROOT_PADDING,
    });
    expect(positions.get("zcode-cli")).toEqual({
      x:
        CAPABILITY_MAP_ROOT_PADDING +
        100 +
        CAPABILITY_MAP_SYSTEM_GAP +
        120 +
        CAPABILITY_MAP_SYSTEM_GAP,
      y: CAPABILITY_MAP_ROOT_PADDING,
    });
    expect(positions.get(ENGINEERING_INFRASTRUCTURE_SYSTEM_ID)).toEqual({
      x: 134,
      y:
        CAPABILITY_MAP_ROOT_PADDING +
        220 +
        CAPABILITY_MAP_SYSTEM_GAP,
    });
  });
});

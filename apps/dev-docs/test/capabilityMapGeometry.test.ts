import { describe, expect, it } from "vitest";
import {
  CAPABILITY_GROUP_CONTENT_TOP,
  CAPABILITY_GROUP_FRAME_BORDER_WIDTH,
  CAPABILITY_GROUP_HEADER_HEIGHT,
  CAPABILITY_HEADER_CONTENT_GAP,
  CAPABILITY_SYSTEM_CONTENT_TOP,
  CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH,
  CAPABILITY_SYSTEM_HEADER_HEIGHT,
} from "@/capability-map/capabilityMapGeometry.js";

describe("能力图父子元素间距", () => {
  it.each([
    {
      contentTop: CAPABILITY_SYSTEM_CONTENT_TOP,
      frameBorderWidth: CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH,
      headerHeight: CAPABILITY_SYSTEM_HEADER_HEIGHT,
      level: "顶层区域",
    },
    {
      contentTop: CAPABILITY_GROUP_CONTENT_TOP,
      frameBorderWidth: CAPABILITY_GROUP_FRAME_BORDER_WIDTH,
      headerHeight: CAPABILITY_GROUP_HEADER_HEIGHT,
      level: "能力群",
    },
  ])(
    "$level 子元素不会覆盖标题区",
    ({ contentTop, frameBorderWidth, headerHeight }) => {
      const effectiveClearance =
        contentTop - frameBorderWidth - headerHeight;
      expect(effectiveClearance).toBeGreaterThanOrEqual(
        CAPABILITY_HEADER_CONTENT_GAP,
      );
    },
  );
});

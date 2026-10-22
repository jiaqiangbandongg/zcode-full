import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevicePlatformIcon, getDevicePlatformLabel } from "@zcode/ui/device-platform-icon";
import { ZCodeAppLogo } from "@zcode/ui/app-logo";
import { BottomSheet, BottomSheetTrigger } from "@zcode/ui/bottom-sheet";

describe("mobile presentation package boundary", () => {
  it.each(["darwin", "win32", "linux", "unknown"])(
    "renders platform %s without browser services",
    (platform) => {
      expect(renderToStaticMarkup(createElement(DevicePlatformIcon, { platform }))).toContain(
        "svg",
      );
      expect(getDevicePlatformLabel(platform)).toBe(
        { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform],
      );
    },
  );
  it("retains logo and accessible dialog trigger exports", () => {
    expect(renderToStaticMarkup(createElement(ZCodeAppLogo))).toContain('data-app-logo="zcode"');
    expect(
      renderToStaticMarkup(
        createElement(BottomSheet, {}, createElement(BottomSheetTrigger, {}, "Choose")),
      ),
    ).toContain('aria-haspopup="dialog"');
  });
});

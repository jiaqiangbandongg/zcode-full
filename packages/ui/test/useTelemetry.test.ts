import { afterEach, describe, expect, it, vi } from "vitest";

const originalDateTimeFormat = Intl.DateTimeFormat;

afterEach(() => {
  Intl.DateTimeFormat = originalDateTimeFormat;
});

describe("useTelemetry helpers", () => {
  it("uses provided Intl-like options when collecting renderer telemetry context", async () => {
    const { collectTelemetryRendererContext } = await import("@zcode/shared");

    const context = collectTelemetryRendererContext({
      intlLocale: "en-US",
      timeZone: "Asia/Shanghai",
      screen: {
        width: 3024,
        height: 1964,
      },
    });

    expect(context).toEqual({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "en-US",
      screenResolution: "3024x1964",
    });
  });

  it("falls back to Intl resolved locale and time zone", async () => {
    Intl.DateTimeFormat = vi.fn(() => ({
      resolvedOptions: () => ({
        locale: "en-US",
        timeZone: "Asia/Shanghai",
      }),
    })) as typeof Intl.DateTimeFormat;

    const { collectTelemetryRendererContext } = await import("@zcode/shared");

    const context = collectTelemetryRendererContext({
      screen: {
        width: 3024,
        height: 1964,
      },
    });

    expect(context).toEqual({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "en-US",
      screenResolution: "3024x1964",
    });
  });
});

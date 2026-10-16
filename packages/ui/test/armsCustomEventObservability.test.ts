import { describe, expect, it } from "vitest";
import {
  recordArmsCustomEventForE2E,
  type ArmsCustomEventE2EEntry,
} from "@/lib/armsCustomEventObservability.js";

describe("recordArmsCustomEventForE2E", () => {
  it("非 E2E 构建不创建调试缓冲", () => {
    const host = {} as Window & {
      __zcodeArmsCustomEventsE2E?: ArmsCustomEventE2EEntry[];
    };
    recordArmsCustomEventForE2E(
      { name: "plan_request", group: "plan_usage" },
      { enabled: false, host },
    );
    expect(host.__zcodeArmsCustomEventsE2E).toBeUndefined();
  });

  it("E2E 缓冲保留最新 200 条完整 payload", () => {
    const host = {} as Window & {
      __zcodeArmsCustomEventsE2E?: ArmsCustomEventE2EEntry[];
    };
    for (let index = 0; index < 205; index += 1) {
      recordArmsCustomEventForE2E(
        {
          name: `event-${index}`,
          group: "ui_perf",
          value: index,
          properties: { talk_id: `session-${index}` },
        },
        { enabled: true, host, now: () => index },
      );
    }

    expect(host.__zcodeArmsCustomEventsE2E).toHaveLength(200);
    expect(host.__zcodeArmsCustomEventsE2E?.[0]).toEqual({
      name: "event-5",
      group: "ui_perf",
      value: 5,
      properties: { talk_id: "session-5" },
      recordedAt: 5,
    });
    expect(host.__zcodeArmsCustomEventsE2E?.at(-1)?.name).toBe("event-204");
  });
});

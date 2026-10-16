import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Highspeed metrics share refresh", () => {
  it("在指标持久化 promise 收尾后主动唤醒分享重算", () => {
    const source = readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");
    const cleanup = "highspeedMetricsInFlightRef.current.delete(record.sourceCommandId);";
    const cleanupIndex = source.indexOf(cleanup);

    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(source.slice(cleanupIndex, cleanupIndex + 500)).toContain(
      "refreshHighspeedAutoShareClock",
    );
  });
});

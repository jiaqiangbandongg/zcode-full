import { describe, expect, it } from "vitest";
import {
  shouldReportHostConsoleError,
  stringifyHostLogArg,
} from "../src/host/hostLog.js";

describe("host log formatting", () => {
  it("serializes Error with message and stack instead of an empty object", () => {
    const error = new Error("Stream closed before handshake completed");

    const text = stringifyHostLogArg(error);

    expect(text).toContain("Stream closed before handshake completed");
    expect(text).toContain("stack");
    expect(text).not.toBe("{}");
  });

  it("Node warning 不应通过 console.error 再上报一条结构化 error", () => {
    expect(
      shouldReportHostConsoleError([
        "(node:71190) ExperimentalWarning: SQLite is an experimental feature",
      ]),
    ).toBe(false);
    expect(shouldReportHostConsoleError(["remote handshake failed"])).toBe(true);
  });
});

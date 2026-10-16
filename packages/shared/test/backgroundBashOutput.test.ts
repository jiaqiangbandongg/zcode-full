import { describe, expect, it } from "vitest";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("background Bash output query", () => {
  it("rejects arbitrary paths and caller-selected read budgets", () => {
    const input = { sessionId: "session", workId: "work" };
    expect(v4BackgroundBashOutputParamsSchema.parse(input)).toEqual(input);
    for (const extra of [{ path: "/secret" }, { limit: 100_000 }, { offset: 0 }]) {
      expect(v4BackgroundBashOutputParamsSchema.safeParse({ ...input, ...extra }).success).toBe(
        false,
      );
    }
  });

  it("separates empty successful output from missing or unreadable output", () => {
    const output = {
      kind: "output",
      workId: "work",
      status: "running",
      output: "",
      truncated: false,
      outputPath: "/output",
    };
    expect(backgroundBashOutputResultSchema.parse(output)).toEqual(output);
    for (const extra of [
      { command: "build" },
      { startedAt: 1 },
      { completedAt: 2 },
      { exitCode: 0 },
      { totalBytes: 0 },
    ]) {
      expect(backgroundBashOutputResultSchema.safeParse({ ...output, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      backgroundBashOutputResultSchema.safeParse({ ...output, output: "x".repeat(8193) }).success,
    ).toBe(false);
    for (const kind of ["unavailable", "unsupported", "read_failed"]) {
      expect(backgroundBashOutputResultSchema.parse({ kind, workId: "work" }).kind).toBe(kind);
    }
  });
});

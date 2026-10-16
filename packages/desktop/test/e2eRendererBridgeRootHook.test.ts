import Mocha, { Test } from "mocha";
import { describe, expect, it } from "vitest";

import { createE2ERendererBridgeRootHooks } from "./e2e/helpers/e2e-renderer-bridge-root-hook.js";

class SilentReporter {
  constructor(_runner: Mocha.Runner) {}
}

async function runMochaWithRendererPreflight(
  runPreflight: () => Promise<void>,
  readBeforeSessionError?: () => unknown,
): Promise<{ events: string[]; failureCount: number; hookError: Error | null }> {
  const events: string[] = [];
  const mocha = new Mocha({
    reporter: SilentReporter,
    rootHooks: createE2ERendererBridgeRootHooks(async () => {
      events.push("preflight");
      await runPreflight();
    }, readBeforeSessionError),
  });
  mocha.suite.addTest(
    new Test("product case", () => {
      events.push("test-body");
    }),
  );

  let hookError: Error | null = null;
  const failureCount = await new Promise<number>((resolve) => {
    const runner = mocha.run(resolve);
    runner.on("fail", (_runnable, error: Error) => {
      hookError = error;
    });
  });

  return { events, failureCount, hookError };
}

describe("desktop e2e renderer bridge root hook", () => {
  it("runs renderer preflight before the product test body", async () => {
    const result = await runMochaWithRendererPreflight(async () => {});

    expect(result).toEqual({
      events: ["preflight", "test-body"],
      failureCount: 0,
      hookError: null,
    });
  });

  it("reports preflight rejection as a root-hook failure and skips the test body", async () => {
    const result = await runMochaWithRendererPreflight(async () => {
      throw new Error("e2e-bridge-preflight infra failure: forced");
    });

    expect(result.events).toEqual(["preflight"]);
    expect(result.failureCount).toBe(1);
    expect(result.hookError?.message).toBe("e2e-bridge-preflight infra failure: forced");
  });

  it("reports beforeSession setup failure before preflight and skips the product test", async () => {
    const result = await runMochaWithRendererPreflight(
      async () => {
        throw new Error("preflight must not run");
      },
      () => new Error("process exit barrier failed"),
    );

    expect(result.events).toEqual([]);
    expect(result.failureCount).toBe(1);
    expect(result.hookError?.message).toBe(
      "e2e-before-session infra failure: process exit barrier failed",
    );
  });

  it("treats a falsy non-null beforeSession rejection as a failure", async () => {
    const result = await runMochaWithRendererPreflight(async () => {}, () => "");

    expect(result.events).toEqual([]);
    expect(result.failureCount).toBe(1);
    expect(result.hookError?.message).toBe("e2e-before-session infra failure: ");
  });
});

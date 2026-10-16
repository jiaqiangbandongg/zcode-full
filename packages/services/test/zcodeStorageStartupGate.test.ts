import { describe, expect, it, vi } from "vitest";
import { ZCodeStorageStartupGate } from "#src/zcode-agent/zcodeStorageStartupGate.js";

const state = (phase: string, sequence: number, attemptId = "attempt-1") => ({
  schemaVersion: 1,
  attemptId,
  sequence,
  databaseId: "opaque-db",
  databaseKind: "session",
  phase,
  elapsedMs: 0,
});

describe("数据库启动请求门禁", () => {
  it("等待真实 ready；旧 sequence/其他 attempt 的 ready 不放行", async () => {
    const gate = new ZCodeStorageStartupGate(true);
    let released = false;
    const waiting = gate.wait().then(() => {
      released = true;
    });
    gate.accept(state("checking", 1));
    gate.accept(state("migrating", 3));
    gate.accept(state("ready", 2));
    gate.accept(state("ready", 4, "other-attempt"));
    await Promise.resolve();
    expect(released).toBe(false);
    expect(gate.snapshot?.phase).toBe("migrating");
    gate.accept(state("ready", 4));
    await waiting;
    expect(released).toBe(true);
    gate.dispose();
  });

  it("合法迁移超过普通请求 3 分钟仍等待；首次状态超时明确失败", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ZCodeStorageStartupGate(true);
      gate.accept(state("checking", 1));
      gate.accept(state("migrating", 2));
      let released = false;
      const waiting = gate.wait().then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(released).toBe(false);
      gate.accept(state("ready", 3));
      await waiting;
      gate.dispose();
      const silent = new ZCodeStorageStartupGate(true, 30);
      const failed = expect(silent.wait()).rejects.toThrow(/startup_status_timeout/);
      await vi.advanceTimersByTimeAsync(30);
      await failed;
      silent.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败/transport 关闭立即拒绝等待；错误结构不会带出原始内容", async () => {
    const gate = new ZCodeStorageStartupGate(true);
    const failed = expect(gate.wait()).rejects.toThrow(/checksum_mismatch/);
    gate.accept({ ...state("failed", 1), errorCode: "checksum_mismatch" });
    await failed;
    gate.dispose();
    const closed = new ZCodeStorageStartupGate(true);
    closed.accept(state("migrating", 1));
    const ended = expect(closed.wait()).rejects.toThrow(/closed/);
    closed.dispose();
    await ended;
    expect(closed.snapshot).toMatchObject({
      phase: "failed",
      errorCode: "transport_closed",
      sequence: 2,
    });
  });

  it("旧 Agent 明确采用原启动路径；新通知仍需严格 schema，ready 是该进程终态", async () => {
    const gate = new ZCodeStorageStartupGate(false);
    await gate.wait();
    expect(gate.accept({ ...state("ready", 1), secret: "invalid-extra-field" })).toBe(false);
    gate.accept(state("checking", 1));
    gate.accept(state("ready", 2));
    gate.accept(state("migrating", 3));
    expect(gate.snapshot?.phase).toBe("ready");
    gate.dispose();
  });
});

it("首通知缺失的超时也产生可订阅失败，不只拒绝业务 Promise", async () => {
  const gate = new ZCodeStorageStartupGate(true, 1);
  const states: string[] = [];
  gate.onDidChange((state) => states.push(state.errorCode ?? state.phase));
  await expect(gate.wait()).rejects.toThrow("startup_status_timeout");
  expect(gate.snapshot?.phase).toBe("failed");
  expect(states).toEqual(["startup_status_timeout"]);
  gate.dispose();
});

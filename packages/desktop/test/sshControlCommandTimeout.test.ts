import { afterEach, describe, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({ exec: vi.fn(), end: vi.fn(), destroy: vi.fn() }));
vi.mock("ssh2", () => ({
  Client: class {
    once(event: string, handler: () => void) {
      if (event === "ready") queueMicrotask(handler);
      return this;
    }
    connect() {}
    exec = control.exec;
    end = control.end;
    destroy = control.destroy;
  },
}));
vi.mock("./e2e/helpers/desktop-app.js", () => ({}));
vi.mock("./e2e/helpers/custom-openai-provider-store.js", () => ({}));
vi.mock("./e2e/helpers/v4-conversation.js", () => ({}));
import { runSSHCommand } from "./e2e/helpers/ssh-remote-p0.js";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SSH 控制命令截止", () => {
  it("握手成功但 exec ACK 永不返回时仍然超时，迟到 channel 被销毁", async () => {
    vi.useFakeTimers();
    let failure = "";
    void runSSHCommand(
      { host: "fixture", port: 22, username: "dev", password: "fixture" },
      "probe",
      { timeoutMs: 1000 },
    ).catch((error: Error) => {
      failure = error.message;
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(failure).toContain("SSH 控制命令超过");
    expect(control.destroy).toHaveBeenCalledOnce();
    expect(control.end).toHaveBeenCalledOnce();
    const channel = { destroy: vi.fn() };
    control.exec.mock.calls[0]![1](null, channel);
    expect(channel.destroy).toHaveBeenCalledOnce();
  });
});

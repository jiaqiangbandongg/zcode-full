import { describe, expect, it, vi } from "vitest";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";

describe("完全访问唯一应答", () => {
  it("更新完成前不应答，重复调用共享提交，同 session 校验", async () => {
    const registry = new V4InteractionRegistry();
    let complete!: () => void;
    const operation = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const fullAccess = vi.fn(() => operation);
    const reply = vi.fn();
    registry.register("p", reply, { sessionId: "s", kind: "other", fullAccess });
    await expect(registry.resolveFullAccess("p", "other")).rejects.toThrow("not supported");
    const first = registry.resolveFullAccess("p", "s");
    const duplicate = registry.resolveFullAccess("p", "s");
    expect(registry.resolve("p", { optionId: "deny" })).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    complete();
    await Promise.all([first, duplicate]);
    expect(fullAccess).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith({ optionId: "allowOnce" });
    expect(await registry.resolveFullAccess("p", "s")).toBe(false);
  });
  it("保存失败保留审批，可重试；普通问答不允许伪造能力", async () => {
    const registry = new V4InteractionRegistry();
    const fullAccess = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const reply = vi.fn();
    registry.register("p", reply, { sessionId: "s", kind: "other", fullAccess });
    await expect(registry.resolveFullAccess("p", "s")).rejects.toThrow("disk full");
    expect(reply).not.toHaveBeenCalled();
    expect(registry.has("p")).toBe(true);
    await registry.resolveFullAccess("p", "s");
    registry.register("question", vi.fn(), { sessionId: "s", kind: "other" });
    await expect(registry.resolveFullAccess("question", "s")).rejects.toThrow("not supported");
  });
});

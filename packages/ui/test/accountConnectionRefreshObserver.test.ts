import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import { createAccountConnectionRefreshObserver } from "@/root/accountConnectionRefreshObserver.js";

function view(
  revision: number,
  availability = "unavailable",
  connectionKey = "user/start",
  current = true,
): ProviderSettingsView {
  return {
    revision,
    providers: [
      {
        providerId: "account:bigmodel-individual-coding-plan",
        accountState: {
          availability,
          connectionKey,
          current,
          entitled: availability === "available",
        },
      },
    ],
  } as ProviderSettingsView;
}

describe("套餐失效事件（Todo93）", () => {
  it("Start 与付费同时 current 时只观察付费失效", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    const combined = (revision: number, start: string, paid: string) => {
      const snapshot = view(revision, paid);
      return {
        ...snapshot,
        providers: [
          { ...view(revision, start).providers[0]!, providerId: "account:bigmodel-start-plan" },
          ...snapshot.providers,
        ],
      };
    };
    await observer.accept(combined(1, "available", "available"));
    await observer.accept(combined(2, "unavailable", "available"));
    expect(notify).not.toHaveBeenCalled();
    await observer.accept(combined(3, "available", "unavailable"));
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].providerId).toBe("account:bigmodel-individual-coding-plan");
  });
  it("设置意图先变化而 View 尚未更新时立即废弃建议", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(1, "available"));
    await observer.accept(view(2));
    const event = notify.mock.calls[0]![0];
    observer.invalidate();
    await observer.accept(view(3));
    expect(event.isCurrent()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("首份只建基线；同身份从可用到失效只通知一次，恢复后可再次通知", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(1));
    await observer.accept(view(2));
    expect(notify).not.toHaveBeenCalled();
    await observer.accept(view(3, "available"));
    await observer.accept(view(4));
    await observer.accept(view(5));
    expect(notify).toHaveBeenCalledTimes(1);
    await observer.accept(view(6, "available"));
    await observer.accept(view(7));
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("unknown 不判失效、不清除确定基线；初始 unknown 后首份不可用不提示", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(1, "unknown"));
    await observer.accept(view(2));
    expect(notify).not.toHaveBeenCalled();
    await observer.accept(view(3, "pending"));
    await observer.accept(view(4, "unknown"));
    expect(notify).not.toHaveBeenCalled();
    await observer.accept(view(5));
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("账号/Team 身份改变重新建基线；切走切回不复活旧建议", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(1, "available", "user/team-a"));
    await observer.accept(view(2, "unavailable", "user/team-b"));
    expect(notify).not.toHaveBeenCalled();
    await observer.accept(view(3, "available"));
    await observer.accept(view(4));
    const event = notify.mock.calls[0]![0];
    expect(event.isCurrent()).toBe(true);
    await observer.accept(view(5, "unavailable", "other-user/start"));
    await observer.accept(view(6));
    expect(event.isCurrent()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("在途通知不阻塞新事实，旧通知不得在恢复后生效", async () => {
    let finish!: () => void;
    const notify = vi.fn(
      async (_event: { isCurrent(): boolean }) =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(1, "available"));
    const pending = observer.accept(view(2));
    await observer.accept(view(3, "available"));
    expect(notify.mock.calls[0]![0].isCurrent()).toBe(false);
    finish();
    await pending;
    observer.dispose();
    await observer.accept(view(4));
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("旧 revision、非 current 不产生跨身份失效", async () => {
    const notify = vi.fn();
    const observer = createAccountConnectionRefreshObserver(notify);
    await observer.accept(view(3, "available"));
    await observer.accept(view(2));
    await observer.accept(view(4, "unavailable", "user/start", false));
    await observer.accept(view(5));
    expect(notify).not.toHaveBeenCalled();
  });
});

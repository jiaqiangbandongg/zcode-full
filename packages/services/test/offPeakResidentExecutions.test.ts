import { describe, expect, it, vi } from "vitest";
import { OffPeakResidentExecutions } from "../src/session/offPeakResidentExecutions.js";
import type { OffPeakLifecycleNotification } from "@zcode/shared";

function fixture() {
  const renew = vi.fn(async (_id: string, current: () => boolean) => {
    expect(current()).toBe(true);
  });
  const takeover = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const control = vi.fn(async () => ({ accepted: true }));
  const complete = vi.fn(async () => {});
  const runs = new OffPeakResidentExecutions({ renew, takeover, release });
  const handle = runs.register({
    offPeakTaskId: "task",
    executionId: "execution",
    sessionId: "session",
    ticketId: "one",
    control,
    complete,
  });
  const event = (body: Record<string, unknown>) =>
    runs.handle({
      offPeakTaskId: "task",
      executionId: "execution",
      sessionId: "session",
      ...body,
    } as OffPeakLifecycleNotification);
  return { runs, handle, event, control, renew, release, takeover, complete };
}

describe("Host 闲时票据交接", () => {
  it("首轮尚未接纳时取消，等待同一次 admission 后终止，不向不存在的执行丢失取消", async () => {
    const f = fixture();
    const cancelled = f.runs.cancel("task");
    await Promise.resolve();
    expect(f.control).not.toHaveBeenCalled();
    f.handle.admitted();
    expect(await cancelled).toBe(true);
    expect(f.control).toHaveBeenCalledWith({
      sessionId: "session",
      executionId: "execution",
      action: "cancel",
    });
  });

  it("首轮接纳尚未落 running 时保留生命周期事件，确认派发后才重新排队", async () => {
    const f = fixture();
    const pending = f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    await Promise.resolve();
    expect(f.renew).not.toHaveBeenCalled();
    f.handle.admitted();
    await pending;
    expect(f.renew).toHaveBeenCalledTimes(1);
    expect(await f.runs.deliverTicket("task", "two", { headers: { ticket: "two" } })).toEqual({
      sessionId: "session",
    });
    expect(f.control).toHaveBeenCalledWith({
      sessionId: "session",
      executionId: "execution",
      action: "replace_ticket",
      renewalId: 1,
      ticketId: "two",
      requestAuth: { headers: { ticket: "two" } },
    });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("用户接管立即废弃续票关联，迟到票据释放且不再调用 CLI 换票", async () => {
    const f = fixture();
    f.handle.admitted();
    await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    const guard = f.runs.retakeGuard("task");
    await f.event({ type: "user_takeover" });
    expect(guard()).toBe(false);
    await f.runs.deliverTicket("task", "late", {});
    expect(f.control).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith("late");
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("票释放不等于任务完成，只有匹配执行身份的完成事件能收口", async () => {
    const f = fixture();
    f.handle.admitted();
    await f.event({ type: "ticket_released", ticketId: "one" });
    expect(f.release).toHaveBeenCalledWith("one");
    expect(f.complete).not.toHaveBeenCalled();
    await f.event({ type: "completed", executionId: "old", outcome: "succeeded" });
    expect(f.complete).not.toHaveBeenCalled();
    await f.event({ type: "completed", outcome: "succeeded" });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
});

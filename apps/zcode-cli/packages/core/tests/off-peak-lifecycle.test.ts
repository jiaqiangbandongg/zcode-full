import { describe, expect, it } from "vitest";
import {
  OffPeakLifecycle,
  type OffPeakLifecycleEvent,
  type OffPeakWorkSnapshot,
} from "../src/runtime/off-peak/lifecycle.js";

function fixture() {
  const facts: OffPeakWorkSnapshot = {
    mainRunning: true,
    backgroundRunning: false,
    pendingNotifications: false,
    pendingInputs: false,
  };
  const events: OffPeakLifecycleEvent[] = [];
  const lifecycle = new OffPeakLifecycle({
    executionId: "run-1",
    offPeakTaskId: "task-1",
    ticketId: "ticket-1",
    readWork: () => facts,
    emit: (event) => {
      events.push(event);
    },
  });
  return { facts, events, lifecycle };
}

describe("闲时票据与整项任务生命周期", () => {
  it("同一换票回执丢失后可幂等确认，不重复释放旧票或覆盖下一轮新票", () => {
    const { lifecycle, events } = fixture();
    const first = lifecycle.ticketExpired("ticket-1")!;
    expect(lifecycle.replaceTicket(first, "ticket-2")).toBe(true);
    expect(lifecycle.replaceTicket(first, "ticket-2")).toBe(true);
    expect(events.filter((event) => event.type === "ticket_released")).toHaveLength(1);
    const second = lifecycle.ticketExpired("ticket-2")!;
    expect(lifecycle.replaceTicket(second, "ticket-3")).toBe(true);
    expect(lifecycle.replaceTicket(first, "ticket-2")).toBe(false);
  });
  it("主轮结束等待后台，后台终态到通知入队之间不能提前完成", () => {
    const { facts, events, lifecycle } = fixture();
    facts.backgroundRunning = true;
    facts.mainRunning = false;
    lifecycle.mainEnded("succeeded");
    expect(lifecycle.state).toBe("waiting_background");
    facts.backgroundRunning = false;
    facts.pendingNotifications = true;
    lifecycle.workChanged();
    expect(events.some((event) => event.type === "completed")).toBe(false);
    facts.mainRunning = true;
    facts.pendingNotifications = false;
    lifecycle.workChanged();
    facts.mainRunning = false;
    lifecycle.mainEnded("succeeded");
    lifecycle.workChanged();
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("票过期时保留 Bash 完成事实，新票到达才允许模型续跑", async () => {
    const { facts, events, lifecycle } = fixture();
    facts.mainRunning = false;
    facts.backgroundRunning = true;
    const renewal = lifecycle.ticketExpired("ticket-1");
    expect(lifecycle.ticketExpired("ticket-1")).toBe(renewal);
    expect(events.filter((event) => event.type === "ticket_needed")).toHaveLength(1);
    const waiting = lifecycle.waitForTicket();
    facts.backgroundRunning = false;
    facts.pendingNotifications = true;
    lifecycle.workChanged();
    expect(lifecycle.state).toBe("waiting_ticket");
    expect(lifecycle.replaceTicket(renewal!, "ticket-2")).toBe(true);
    await expect(waiting).resolves.toBe("ticket-2");
    expect(lifecycle.state).toBe("waiting_background");
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("用户接管后拒绝迟到的新票，已启动闲时子轮释放前保留旧票", () => {
    const { facts, events, lifecycle } = fixture();
    const child = lifecycle.retainIdleModelRound();
    facts.mainRunning = false;
    facts.backgroundRunning = true;
    lifecycle.takeOver();
    expect(lifecycle.state).toBe("running_user");
    expect(events.some((event) => event.type === "ticket_released")).toBe(false);
    expect(lifecycle.ticketExpired("ticket-1")).toBeUndefined();
    expect(lifecycle.replaceTicket(1, "late-ticket")).toBe(false);
    child.release();
    child.release();
    expect(events.filter((event) => event.type === "ticket_released")).toHaveLength(1);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("等待票期间用户接管会结束等待，旧回执不能抢回归属", async () => {
    const { lifecycle } = fixture();
    const child = lifecycle.retainIdleModelRound();
    const renewal = lifecycle.ticketExpired("ticket-1");
    const waiting = lifecycle.waitForTicket();
    lifecycle.takeOver();
    await expect(waiting).rejects.toMatchObject({ code: "off_peak_user_takeover" });
    await expect(lifecycle.waitForTicket()).rejects.toMatchObject({
      code: "off_peak_user_takeover",
    });
    expect(lifecycle.replaceTicket(renewal!, "late-ticket")).toBe(false);
    expect(lifecycle.state).toBe("running_user");
    child.release();
  });

  it("聊天停止保留普通后台行为，任务卡取消则阻止后续唤起", async () => {
    const { facts, lifecycle, events } = fixture();
    facts.mainRunning = false;
    facts.backgroundRunning = true;
    lifecycle.mainEnded("stopped");
    expect(lifecycle.state).toBe("waiting_background");
    lifecycle.ticketExpired("ticket-1");
    const waiting = lifecycle.waitForTicket();
    lifecycle.cancel();
    await expect(waiting).rejects.toMatchObject({ code: "off_peak_cancelled" });
    facts.backgroundRunning = false;
    lifecycle.workChanged();
    expect(lifecycle.state).toBe("cancelled");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("仅持票模型轮结束不等于整项完成，待接纳输入仍阻止收口", () => {
    const { facts, events, lifecycle } = fixture();
    const round = lifecycle.retainIdleModelRound();
    facts.mainRunning = false;
    facts.pendingInputs = true;
    lifecycle.takeOver();
    round.release();
    expect(events.filter((event) => event.type === "ticket_released")).toHaveLength(1);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    facts.pendingInputs = false;
    lifecycle.mainEnded("succeeded");
    expect(lifecycle.state).toBe("completed");
  });
});

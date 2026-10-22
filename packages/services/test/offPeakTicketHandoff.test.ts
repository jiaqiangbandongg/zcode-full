import { describe, expect, it, vi } from "vitest";
import type {
  OffPeakControlParams,
  OffPeakControlResult,
  OffPeakLifecycleNotification,
} from "@zcode/shared";
import { OffPeakResidentExecutions } from "../src/session/offPeakResidentExecutions.js";

function fixture() {
  const control = vi.fn<(input: OffPeakControlParams) => Promise<OffPeakControlResult>>(
    async () => ({ accepted: true }),
  );
  const release = vi.fn(async (_ticket: string) => {});
  const renew = vi.fn(async () => {});
  const runs = new OffPeakResidentExecutions({ renew, release, takeover: async () => {} });
  runs
    .register({
      offPeakTaskId: "task",
      sessionId: "session",
      executionId: "execution",
      ticketId: "one",
      control,
      complete: async () => {},
    })
    .admitted();
  const event = (body: Record<string, unknown>) =>
    runs.handle({
      offPeakTaskId: "task",
      sessionId: "session",
      executionId: "execution",
      ...body,
    } as OffPeakLifecycleNotification);
  return { runs, control, release, renew, event };
}

describe("闲时换票确认恢复", () => {
  it("重试得到明确拒绝后才释放候选票并重新申请", async () => {
    const f = fixture();
    await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    f.control
      .mockRejectedValueOnce(new Error("unknown result"))
      .mockResolvedValueOnce({ accepted: false });
    await expect(f.runs.deliverTicket("task", "two", {})).rejects.toThrow("unknown result");
    await expect(f.runs.retryPendingTickets()).rejects.toThrow("off_peak_ticket_handoff_rejected");
    expect(f.release).toHaveBeenCalledExactlyOnceWith("two");
    expect(f.renew).toHaveBeenCalledTimes(2);
  });
  it("连续丢失回执保留相同票据重试，期间不重新取票", async () => {
    const f = fixture();
    await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    const current = f.runs.retakeGuard("task");
    f.control
      .mockRejectedValueOnce(new Error("lost ACK"))
      .mockRejectedValueOnce(new Error("lost ACK again"));
    await expect(
      f.runs.deliverTicket("task", "two", { headers: { ticket: "two" } }),
    ).rejects.toThrow("lost ACK");
    expect(current()).toBe(false);
    await expect(f.runs.retryPendingTickets()).rejects.toThrow("lost ACK again");
    await f.runs.retryPendingTickets();
    expect(f.control).toHaveBeenCalledTimes(3);
    expect(
      f.control.mock.calls.every(
        ([input]) => JSON.stringify(input) === JSON.stringify(f.control.mock.calls[0]![0]),
      ),
    ).toBe(true);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.renew).toHaveBeenCalledTimes(1);
    await f.runs.retryPendingTickets();
    expect(f.control).toHaveBeenCalledTimes(3);
  });

  it("首轮交接与同步重试并发时只发送一次控制请求", async () => {
    const f = fixture();
    await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    let finish!: (result: OffPeakControlResult) => void;
    f.control.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = f.runs.deliverTicket("task", "two", {});
    await Promise.resolve();
    const retry = f.runs.retryPendingTickets();
    expect(f.control).toHaveBeenCalledTimes(1);
    finish({ accepted: true });
    await Promise.all([delivery, retry]);
  });

  it("新一轮续票先于旧回执到达时，旧回执不能释放或覆盖新票", async () => {
    const f = fixture();
    await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
    let finish!: (result: OffPeakControlResult) => void;
    f.control.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldDelivery = f.runs.deliverTicket("task", "two", {});
    await Promise.resolve();
    await f.event({ type: "ticket_needed", renewalId: 2, expiredTicketId: "two" });
    await f.runs.deliverTicket("task", "three", {});
    finish({ accepted: true });
    await oldDelivery;
    await f.event({ type: "completed", outcome: "succeeded" });
    await f.event({ type: "ticket_released", ticketId: "three" });
    expect(f.runs.has("task")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith("three");
  });

  it.each(["user_takeover", "completed"])(
    "交接尚未送达就 %s 时，只释放未安装候选票",
    async (type) => {
      const f = fixture();
      await f.event({ type: "ticket_needed", renewalId: 1, expiredTicketId: "one" });
      f.control
        .mockRejectedValueOnce(new Error("not delivered"))
        .mockResolvedValueOnce({ accepted: false });
      await expect(f.runs.deliverTicket("task", "two", {})).rejects.toThrow("not delivered");
      await f.event({ type, outcome: "succeeded" });
      await f.event({ type: "ticket_released", ticketId: "one" });
      await f.runs.retryPendingTickets();
      expect(f.release.mock.calls.map(([ticket]) => ticket)).toEqual(["one", "two"]);
      if (type === "user_takeover") await f.event({ type: "completed", outcome: "succeeded" });
      expect(f.runs.has("task")).toBe(false);
    },
  );
});

import { commandsQueryParamsSchema } from "../src/zcode-protocol-v4/command.js";
import { describe, expect, it } from "vitest";
import {
  localTtftContextSchema,
  localTtftFactsSchema,
  calibrateLocalTtftClock,
} from "../src/localTtft.js";

describe("本地 TTFT 协议与跨进程时钟边界", () => {
  it("只接受有界无正文观测上下文", () => {
    const context = { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" };
    expect(localTtftContextSchema.safeParse(context).success).toBe(true);
    expect(localTtftContextSchema.safeParse({ ...context, prompt: "private" }).success).toBe(false);
    expect(
      localTtftFactsSchema.safeParse({ ...context, stages: Array.from({ length: 100 }, () => 0) })
        .success,
    ).toBe(false);
  });
  it("往返区间扣除服务端处理后给出 offset 与实测误差界限", () => {
    expect(
      calibrateLocalTtftClock(1000, 1014, { instanceId: "cli", receivedAt: 1202, sentAt: 1212 }),
    ).toEqual({ instanceId: "cli", offsetMs: -200, errorMs: 2, measuredAt: 1014 });
    expect(
      calibrateLocalTtftClock(1000, 1050, { instanceId: "cli", receivedAt: 1202, sentAt: 1203 }),
    ).toBeUndefined();
    expect(
      calibrateLocalTtftClock(1000, 1001, { instanceId: "cli", receivedAt: 1202, sentAt: 1212 }),
    ).toBeUndefined();
  });
});

it("时钟探测不能携带 session 命令查询", () => {
  expect(
    commandsQueryParamsSchema.safeParse({
      clock: true,
      commands: [{ sessionId: "session", commandId: "input" }],
    }).success,
  ).toBe(false);
  expect(
    commandsQueryParamsSchema.safeParse({
      clock: true,
      commands: [{ sessionId: null, commandId: "probe" }],
    }).success,
  ).toBe(true);
});

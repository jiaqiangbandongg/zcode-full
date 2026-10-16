import { describe, expect, it, vi } from "vitest";
import type { HighspeedPrepareTurnResult, HighspeedTurnExecution } from "@zcode/shared";
import {
  HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS,
  HIGHSPEED_SEND_WAIT_BUDGET_MS,
  buildHighspeedRuntimeOverride,
  prepareHighspeedSendContext,
  readRegularTpsWithinSendBudget,
} from "../../src/highspeed/highspeedSend.js";

const card = {
  cardId: "hsc-1",
  taskId: "task-1",
  provider: "zai",
  model: "glm-5",
  issuedAt: 1_000,
  expiresAt: 10_000,
};

/**
 * 加速执行材料只带「本轮选哪个模型」和「本次执行鉴权」：端点、API 形态、模型能力都由
 * 隐藏内建 Provider Config 提供，不再随单次发送下发 provider 定义。
 */
const execution = {
  modelSelection: { providerId: "account:zai-highspeed-card", modelId: "glm-5" },
  requestAuth: {
    apiKey: "jwt",
    headers: { Authorization: "Bearer jwt", "X-Highspeed-Card-ID": "hsc-1" },
  },
  selectionFallback: {
    providerId: "account:zai-highspeed-card",
    rules: [
      { reason: "highspeed_card_expired", providerErrorCode: "3402" },
      { reason: "highspeed_request_failed" },
    ],
    target: { providerId: "account:zai-team-coding-plan", modelId: "glm-5" },
  },
} satisfies HighspeedTurnExecution;

describe("buildHighspeedRuntimeOverride", () => {
  it("persists card metadata without overriding the normal route for an accelerated mock card", () => {
    const result: HighspeedPrepareTurnResult = {
      kind: "accelerated",
      card,
      nextDrawAt: 20_000,
    };

    expect(buildHighspeedRuntimeOverride(result)).toEqual({
      highspeedMeta: {
        schemaVersion: 1,
        ...card,
      },
    });
  });

  it("injects the Highspeed selection and execution-scoped auth for a real accelerated card", () => {
    const result: HighspeedPrepareTurnResult = {
      kind: "accelerated",
      card,
      nextDrawAt: 20_000,
      execution,
    };

    expect(buildHighspeedRuntimeOverride(result)).toEqual({
      highspeedMeta: {
        schemaVersion: 1,
        ...card,
      },
      modelSelection: execution.modelSelection,
      // selectionScope=execution 是加速轮的关键约束：只作用于本轮执行，不写 Session Selection。
      modelExecution: {
        selectionScope: "execution",
        requestAuth: execution.requestAuth,
        selectionFallback: execution.selectionFallback,
      },
    });
  });
});

describe("prepareHighspeedSendContext", () => {
  it("uses one prepared result for both command payload and visual card tracking", async () => {
    const result: HighspeedPrepareTurnResult = {
      kind: "accelerated",
      card,
      nextDrawAt: 20_000,
      execution,
    };

    await expect(
      prepareHighspeedSendContext("task-1", async (taskId) => {
        expect(taskId).toBe("task-1");
        return result;
      }),
    ).resolves.toEqual({
      override: {
        highspeedMeta: { schemaVersion: 1, ...card },
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
      acceleratedCard: card,
    });
  });

  it("keeps fallback sends free of Highspeed payload and visual state", async () => {
    await expect(
      prepareHighspeedSendContext("task-1", async () => ({
        kind: "fallback",
        reason: "cooldown",
        nextDrawAt: null,
      })),
    ).resolves.toEqual({ override: {} });
  });
});

describe("readRegularTpsWithinSendBudget", () => {
  // 可控的等待器：记录每次请求的预算，并允许测试手动唤醒，避免绑定真实计时器。
  function manualWait() {
    const waits: Array<{ ms: number; resolve: () => void }> = [];
    const wait = (ms: number) => new Promise<void>((resolve) => waits.push({ ms, resolve }));
    return { waits, wait };
  }

  it("returns the TPS when the read settles inside the budget", async () => {
    const { wait } = manualWait();
    await expect(
      readRegularTpsWithinSendBudget({ read: async () => 42, elapsedMs: 100, wait }),
    ).resolves.toBe(42);
  });

  it("gives up after the budget and lets the read finish in the background", async () => {
    // CR-02 回归：TPS monitor 配 15s 超时，曾在抽中后同步 await，把 1s 发送承诺拉长到最多 16s。
    const { waits, wait } = manualWait();
    let resolveRead!: (value: number) => void;
    const onTimeout = vi.fn();
    const pending = readRegularTpsWithinSendBudget({
      read: () =>
        new Promise<number>((resolve) => {
          resolveRead = resolve;
        }),
      elapsedMs: 0,
      onTimeout,
      wait,
    });
    while (waits.length === 0) await Promise.resolve();
    expect(waits[0]?.ms).toBe(HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS);
    waits.shift()?.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(onTimeout).toHaveBeenCalledWith(HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS);
    // 后台迟到的结果不抛错、不影响已提交的发送。
    resolveRead(42);
    await Promise.resolve();
  });

  it("caps the wait by the remaining send budget and skips waiting once it is spent", async () => {
    const remaining = manualWait();
    const slow = readRegularTpsWithinSendBudget({
      read: () => new Promise<number>(() => {}),
      elapsedMs: HIGHSPEED_SEND_WAIT_BUDGET_MS - 100,
      wait: remaining.wait,
    });
    while (remaining.waits.length === 0) await Promise.resolve();
    expect(remaining.waits[0]?.ms).toBe(100);
    remaining.waits.shift()?.resolve();
    await expect(slow).resolves.toBeUndefined();

    const spent = manualWait();
    const read = vi.fn(async () => 42);
    const onTimeout = vi.fn();
    await expect(
      readRegularTpsWithinSendBudget({
        read,
        elapsedMs: HIGHSPEED_SEND_WAIT_BUDGET_MS,
        onTimeout,
        wait: spent.wait,
      }),
    ).resolves.toBeUndefined();
    // 预算耗尽仍发起一次请求预热 Service 缓存，但不再等待。
    expect(read).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(0);
    expect(spent.waits).toHaveLength(0);
  });

  it("treats read failures as missing TPS without blocking the send", async () => {
    const { wait } = manualWait();
    const onError = vi.fn();
    await expect(
      readRegularTpsWithinSendBudget({
        read: async () => {
          throw new Error("monitor down");
        },
        elapsedMs: 0,
        onError,
        wait,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordStreamTextDebug } from "../src/model/runner-debug.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";

// 回归（2026-07-06，v4 stop 失效根因）：用户 stop / sendQueuedNow 抢占 abort 流式请求后，
// AI SDK StreamTextResult 的 request/response 聚合 promise 永不 settle（流被中途放弃）。
// recordStreamTextDebug 的失败路径若无界 await 这些聚合，会卡死 runStreamText 的 catch，
// TurnCancelled 无法上抛，turn 永不收口（e2e：conversation-session-v4-vertical-slice / v4-sendnow）。
// 失败路径必须有界等待：聚合不 settle 时也要在超时窗口内返回并完成记录。
describe("recordStreamTextDebug failed-stream aggregate settling", () => {
  let debugDir: string;

  beforeEach(async () => {
    debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-debug-"));
  });

  afterEach(async () => {
    await rm(debugDir, { recursive: true, force: true });
  });

  const resolved = {
    modelId: "test-model",
    providerId: "test-provider",
    baseURL: "https://api.example.test",
    headers: {},
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;

  const request = {
    messages: [],
    metadata: { sessionId: "sess-runner-debug-abort" },
  } as unknown as AiSdkModelTextRequest;

  const options = {
    messages: [],
    headers: {},
  } as unknown as AiSdkStreamTextOptions;

  it("resolves within the bounded window when aborted stream aggregates never settle", async () => {
    const neverSettles = new Promise<never>(() => {});
    const result = {
      request: neverSettles,
      response: neverSettles,
    } as unknown as AiSdkStreamTextResult;

    const startedAt = Date.now();
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      error: new Error("v4 session stopped"),
      isDev: true,
      normalizedToolCalls: [],
      options,
      recordModelIO: true,
      request,
      requestId: "req-abort-1",
      resolved,
      result,
      startedAt,
    });
    const elapsedMs = Date.now() - startedAt;

    // 有界等待（1s 窗口）+ 少量余量；无界等待时此处永远超时。
    expect(elapsedMs).toBeLessThan(5_000);

    // 即便聚合不可得，失败记录本身仍应落盘（error + fallback request body）。
    const files = await readdir(debugDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(debugDir, files[0]!), "utf8");
    const record = JSON.parse(content.trim()) as {
      error?: { message?: string };
      type?: string;
    };
    expect(record.type).toBe("model_io");
    expect(record.error?.message).toBe("v4 session stopped");
  }, 10_000);

  it("still records settled aggregates on the failed path", async () => {
    const result = {
      request: Promise.resolve({ body: { model: "test-model" } }),
      response: Promise.resolve({ id: "resp-1", headers: {}, modelId: "test-model" }),
    } as unknown as AiSdkStreamTextResult;

    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      error: new Error("provider 500"),
      isDev: true,
      normalizedToolCalls: [],
      options,
      recordModelIO: true,
      request,
      requestId: "req-failed-1",
      resolved,
      result,
      startedAt: Date.now(),
    });

    const files = await readdir(debugDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(debugDir, files[0]!), "utf8");
    const record = JSON.parse(content.trim()) as {
      response?: { responseId?: string };
      model?: Record<string, unknown>;
    };
    expect(record.response?.responseId).toBe("resp-1");
    expect(record.model).not.toHaveProperty("role");
    expect(record.model).not.toHaveProperty("source");
  });
});

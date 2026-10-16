import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCliDeviceMid } from "../src/device/cli-device-mid.js";
import {
  createAnthropicRequestMetadataUserId,
  redactAnthropicRequestMetadata,
  resolveAnthropicRequestMetadataUserId,
} from "../src/model/anthropic-request-metadata.js";
import {
  type AiSdkGenerateTextOptions,
  type AiSdkModelRuntime,
  type AiSdkStreamTextOptions,
} from "../src/model/runner.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("ensureCliDeviceMid", () => {
  it("consumes the existing Desktop/telemetry deviceMid without rewriting other state", async () => {
    const root = await createTemporaryRoot();
    const stateFile = await writeTelemetryState(root, {
      deviceMid: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
      lastDailyActiveDate: "2026-07-27",
    });

    const deviceMid = await ensureCliDeviceMid({
      createId: () => "should-not-be-created",
      env: { ZCODE_DATA_BASE_DIR: root },
    });

    expect(deviceMid).toBe("7f1431f0-53e8-41c1-9cf9-22d11aa51d6a");
    await expect(readJson(stateFile)).resolves.toEqual({
      deviceMid: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
      lastDailyActiveDate: "2026-07-27",
    });
  });

  it("generates and persists one shared UUID for concurrent CLI consumers", async () => {
    const root = await createTemporaryRoot();
    await writeTelemetryState(root, {
      lastDailyActiveDate: "2026-07-27",
    });
    let createCount = 0;
    const createId = () => {
      createCount += 1;
      return "b77a8d4b-38a8-40c8-a7c8-ab9f7637dadc";
    };

    const values = await Promise.all([
      ensureCliDeviceMid({ createId, env: { ZCODE_DATA_BASE_DIR: root } }),
      ensureCliDeviceMid({ createId, env: { ZCODE_DATA_BASE_DIR: root } }),
      ensureCliDeviceMid({ createId, env: { ZCODE_DATA_BASE_DIR: root } }),
    ]);

    expect(values).toEqual([
      "b77a8d4b-38a8-40c8-a7c8-ab9f7637dadc",
      "b77a8d4b-38a8-40c8-a7c8-ab9f7637dadc",
      "b77a8d4b-38a8-40c8-a7c8-ab9f7637dadc",
    ]);
    expect(createCount).toBe(1);
    await expect(readJson(telemetryStateFile(root))).resolves.toEqual({
      deviceMid: "b77a8d4b-38a8-40c8-a7c8-ab9f7637dadc",
      lastDailyActiveDate: "2026-07-27",
    });
  });

  it("uses the same UUID format as the existing Desktop generator", async () => {
    const root = await createTemporaryRoot();

    const deviceMid = await ensureCliDeviceMid({
      env: { ZCODE_DATA_BASE_DIR: root },
    });

    expect(deviceMid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(readJson(telemetryStateFile(root))).resolves.toMatchObject({
      deviceMid,
    });
  });

  it("uses one process-stable fallback when the telemetry state cannot be persisted", async () => {
    const root = await createTemporaryRoot();
    const blockedBaseDir = join(root, "not-a-directory");
    await writeFile(blockedBaseDir, "blocked", "utf-8");
    let createCount = 0;
    const createId = () => `fallback-${++createCount}`;

    const first = await ensureCliDeviceMid({
      createId,
      env: { ZCODE_DATA_BASE_DIR: blockedBaseDir },
    });
    const second = await ensureCliDeviceMid({
      createId,
      env: { ZCODE_DATA_BASE_DIR: blockedBaseDir },
    });

    expect(first).toBe("fallback-1");
    expect(second).toBe("fallback-1");
    expect(createCount).toBe(1);
  });
});

describe("Anthropic request metadata", () => {
  it("serializes the shared deviceMid, empty account UUID, and normalized subagent session", () => {
    const userId = createAnthropicRequestMetadataUserId({
      deviceMid: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
      sessionId: "sess_subagent_agent_2d480878-38af-4bae-a54f-096e2fb0f4d7",
    });

    expect(JSON.parse(userId)).toEqual({
      device_id: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
      account_uuid: "",
      session_id: "2d480878-38af-4bae-a54f-096e2fb0f4d7",
    });
  });

  it("keeps the required session_id key for low-level requests without session context", () => {
    expect(
      JSON.parse(
        createAnthropicRequestMetadataUserId({
          deviceMid: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
        }),
      ),
    ).toEqual({
      device_id: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
      account_uuid: "",
      session_id: "",
    });
  });

  it("does not resolve or create device identity for non-Anthropic transports", async () => {
    const root = await createTemporaryRoot();

    await expect(
      resolveAnthropicRequestMetadataUserId({
        env: { ZCODE_DATA_BASE_DIR: root },
        providerKind: "openai-compatible",
        sessionId: "sess_openai",
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(telemetryStateFile(root), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("redacts device attribution from model I/O debug payloads", () => {
    expect(
      redactAnthropicRequestMetadata({
        metadata: { user_id: "wire-device-and-session" },
      }),
    ).toEqual({
      metadata: { user_id: "[REDACTED]" },
    });
    expect(
      redactAnthropicRequestMetadata({
        providerOptions: {
          anthropic: {
            effort: "high",
            metadata: { userId: "options-device-and-session" },
          },
        },
      }),
    ).toEqual({
      providerOptions: {
        anthropic: {
          effort: "high",
          metadata: { userId: "[REDACTED]" },
        },
      },
    });
  });

  it("injects dynamic metadata into generate and stream while preserving Anthropic options", async () => {
    const root = await createTemporaryRoot();
    await writeTelemetryState(root, {
      deviceMid: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
    });
    let generated: AiSdkGenerateTextOptions | undefined;
    let streamed: AiSdkStreamTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        generated = options;
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: usage(1, 1),
          usage: usage(1, 1),
        } as never;
      },
      streamText(options) {
        streamed = options;
        return {
          fullStream: stream([
            {
              finishReason: "stop",
              totalUsage: usage(1, 1),
              type: "finish",
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      env: { ZCODE_DATA_BASE_DIR: root },
      registry: anthropicRegistry(),
      runtime,
    });
    const request = {
      messages: [{ content: "Ping", role: "user" as const }],
      providerId: "anthropic" as never,
      modelId: "claude-test" as never,
      providerOptions: {
        anthropic: {
          effort: "high",
          metadata: { userId: "stale-static-user-id" },
        },
      },
      traceContext: {
        sessionId: "sess_subagent_agent_2d480878-38af-4bae-a54f-096e2fb0f4d7" as never,
        traceId: "trace_anthropic_metadata" as never,
      },
    };

    await executeAdapterGenerateText(adapter, request);
    for await (const _event of executeAdapterStreamText(adapter, request)) {
      // Drain the shared stream request path.
    }

    for (const options of [generated, streamed]) {
      const anthropicOptions = options?.providerOptions?.anthropic as
        | { effort?: string; metadata?: { userId?: string } }
        | undefined;
      // Reasoning 由 Model Option Map 写入最终原始请求体；SDK Provider Options
      // 这里只承载 Anthropic 动态归因元数据，不能形成第二套 Reasoning 映射。
      expect(anthropicOptions?.effort).toBeUndefined();
      expect(JSON.parse(anthropicOptions?.metadata?.userId ?? "")).toEqual({
        device_id: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
        account_uuid: "",
        session_id: "2d480878-38af-4bae-a54f-096e2fb0f4d7",
      });
    }
  });
});

function anthropicRegistry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      anthropic: {
        apiKey: "test-key",
        baseURL: "https://api.example.test",
        kind: "anthropic",
      },
    },
  });
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-device-mid-"));
  temporaryRoots.push(root);
  return root;
}

function telemetryStateFile(root: string): string {
  return join(root, ".zcode", "v2", "telemetry-state.json");
}

async function writeTelemetryState(root: string, state: Record<string, unknown>): Promise<string> {
  const stateFile = telemetryStateFile(root);
  await mkdir(join(root, ".zcode", "v2"), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
  return stateFile;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      noCacheTokens: inputTokens,
    },
    outputTokenDetails: {
      reasoningTokens: undefined,
      textTokens: outputTokens,
    },
  };
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

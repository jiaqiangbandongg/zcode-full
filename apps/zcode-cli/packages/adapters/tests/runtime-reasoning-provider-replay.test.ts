import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  InMemorySessionEventStore,
  SESSION_ENTRY_MODEL_SELECTION,
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createProjectId,
  createSessionId,
  parseModelSelectionValue,
  type Model,
  type ModelRequest,
  type SessionId,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";
import { AgentRuntime } from "../../core/src/runtime.js";

const MODEL_ID = createModelId("GLM-5.3");
const USER_ID = createMessageId("old-user");
const ASSISTANT_ID = createMessageId("old-assistant");
const SIGNATURE = "fixture-signature\nopaque ";
const REDACTED_DATA = "fixture-redacted-opaque";
const HISTORICAL_CONTENT = [
  { type: "thinking", thinking: "Historical thinking", signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED_DATA },
  { type: "text", text: "Inspecting report" },
  { type: "tool_use", id: "old-read", name: "Read", input: { file_path: "report.txt" } },
];
const cases = ["zai", "bigmodel"].flatMap((family) => {
  const legacy = `builtin:${family}-coding-plan`;
  const individual = `account:${family}-individual-coding-plan`;
  const team = `account:${family}-team-coding-plan`;
  return [
    [legacy, individual],
    [legacy, team],
    [individual, team],
    [team, individual],
  ] as const;
});

describe.each(["off", "on"] as const)(
  "Runtime reasoning replay (streaming=%s)",
  (modelStreaming) => {
    it.each(cases)(
      "restores %s and replays into %s without changing old bytes",
      async (source, target) => {
        const root = await mkdtemp(join(tmpdir(), "zcode-reasoning-replay-"));
        const sessionID = createSessionId("reasoning-replay");
        let store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
        const db = new DatabaseSync(join(root, "session.sqlite"));
        let runtime: AgentRuntime | undefined;
        try {
          // 合并修复：空库建表后移除尚未播种的迁移记录，模拟升级前数据；只操作临时夹具。
          db.prepare("DELETE FROM schema_migration WHERE id = ?").run(
            "0020_provider_model_selection",
          );
          await seedHistory({ db, store, root, sessionID, providerId: source });
          const snapshot = () => ({
            messages: db
              .prepare("select data from message where id in (?, ?) order by id")
              .all(USER_ID, ASSISTANT_ID),
            parts: db
              .prepare("select data from part where message_id in (?, ?) order by id")
              .all(USER_ID, ASSISTANT_ID),
          });
          const before = snapshot();
          // Todo109 已将迁移收进数据库启动；不能恢复已删除的逐 Session 迁移接口。
          store.close();
          store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
          const migrated = snapshot();
          expect(migrated.messages).toHaveLength(before.messages.length);
          for (const [index, row] of before.messages.entries()) {
            expect(JSON.parse(String(migrated.messages[index]!.data))).toMatchObject(
              JSON.parse(String(row.data)),
            );
          }
          expect(migrated.parts).toEqual(before.parts);
          const entries = await store.sessionEntries({
            sessionID,
            type: SESSION_ENTRY_MODEL_SELECTION,
          });
          const selection = parseModelSelectionValue(entries.at(-1)?.data);
          if (!selection) throw new Error("Missing restored model selection");
          expect(selection.providerId).toBe(
            source.startsWith("builtin:")
              ? source
                  .replace("builtin:", "account:")
                  .replace("-coding-plan", "-individual-coding-plan")
              : source,
          );
          const decoded = (await store.messages({ sessionID })).find(
            (message) => message.info.id === ASSISTANT_ID,
          );
          expect(decoded?.info).toMatchObject({ providerId: source, modelId: MODEL_ID });

          const bodies: Array<{ messages: Array<{ role: string; content: unknown[] }> }> = [];
          vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            expect(request.url).toBe("https://reasoning.invalid/v1/messages");
            bodies.push(await request.json());
            return modelResponse(modelStreaming === "on");
          });
          const provider = createRegistryProviderConfig(
            parseProviderConfig({
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-key" },
              api: { type: "anthropic-messages", baseUrl: "https://reasoning.invalid/v1" },
            }),
          );
          const model = createRegistryModelConfig(
            parseModelConfig({
              enabled: true,
              properties: createTestModelProperties(),
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: '{"max_tokens": maxOutputTokens}' },
              },
            }),
          );
          if (!provider.ok || !model.ok) throw new Error("Invalid model fixture config");
          const adapter = new AiSdkModelAdapter({
            env: {},
            retry: { maxAttempts: 1 },
          });
          const requests: ModelRequest[] = [];
          runtime = new AgentRuntime(
            sessionID,
            {
              mode: "build",
              modelStreaming,
              workingDirectory: root,
              modelSelection: selection,
              memory: { enabled: false },
              compact: { enabled: false },
            },
            {
              sessionStore: store,
              eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
              modelFactory: ({ selection }) =>
                observeModel(
                  adapter.createModel({
                    providerId: selection.providerId,
                    modelId: selection.modelId,
                    providerConfig: provider.config,
                    modelConfig: model.config,
                    options: { maxOutputTokens: 32_000, ...selection.options },
                  }),
                  requests,
                ),
            },
          );
          await runtime.resumeFromStore();
          runtime.setSessionModelSelection({
            ...selection,
            providerId: createModelProviderId(target),
          });
          await runtime.executeTurn("Continue after restart");

          expect(bodies).toHaveLength(1);
          const assistant = bodies[0]!.messages.find((message) => message.role === "assistant");
          expect(assistant?.content).toEqual(HISTORICAL_CONTENT);
          expect(bodies[0]!.messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "tool_result",
                  tool_use_id: "old-read",
                  content: "Report content",
                }),
              ]),
            }),
          );
          await runtime.executeTurn("Continue the same task again");
          expect(bodies).toHaveLength(2);
          expect(
            bodies[1]!.messages.find((message) => message.role === "assistant")?.content,
          ).toEqual(assistant?.content);
          const canonical = requests[0]!.messages.find((message) => message.role === "assistant");
          expect(canonical).toMatchObject({ providerId: source, modelId: MODEL_ID });
          expect(canonical?.content).toEqual(
            expect.arrayContaining([
              {
                type: "reasoning",
                text: "Historical thinking",
                providerOptions: { anthropic: { signature: SIGNATURE } },
              },
              {
                type: "reasoning",
                text: "",
                providerOptions: { anthropic: { redactedData: REDACTED_DATA } },
              },
            ]),
          );
          expect(snapshot()).toEqual(migrated);
        } finally {
          runtime?.beginShutdown();
          vi.unstubAllGlobals();
          db.close();
          store.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);

function observeModel(model: Model, requests: ModelRequest[]): Model {
  return {
    ...model,
    bind: (options) => observeModel(model.bind(options), requests),
    generateText(request) {
      requests.push(request);
      return model.generateText(request);
    },
    streamText(request) {
      requests.push(request);
      return model.streamText(request);
    },
  };
}

async function seedHistory(input: {
  db: DatabaseSync;
  store: ReturnType<typeof createSqliteSessionStore>;
  root: string;
  sessionID: SessionId;
  providerId: string;
}) {
  const { db, store, root, sessionID, providerId } = input;
  const legacy = providerId.startsWith("builtin:");
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("reasoning-replay"),
    directory: root,
    slug: "replay",
    title: "Replay",
    version: "old",
  });
  const modelSelection = { providerId, modelId: MODEL_ID, options: { reasoningLevel: "disabled" } };
  // 已发布旧格式直接写入 SQLite，避免用新版 writer 生成伪旧数据。
  const insert = db.prepare(
    "insert into message(id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?)",
  );
  insert.run(
    USER_ID,
    sessionID,
    1,
    1,
    1,
    JSON.stringify({
      role: "user",
      agent: "zcode-agent",
      time: { created: 1 },
      ...(legacy
        ? { model: { providerID: providerId, modelID: MODEL_ID, variant: "disabled" } }
        : { modelSelection }),
    }),
  );
  insert.run(
    ASSISTANT_ID,
    sessionID,
    2,
    2,
    3,
    JSON.stringify({
      role: "assistant",
      time: { created: 2, completed: 3 },
      parentID: USER_ID,
      ...(legacy
        ? { providerID: providerId, modelID: MODEL_ID, variant: "disabled" }
        : { providerId, modelId: MODEL_ID, reasoningLevel: "disabled" }),
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: root, root },
      cost: 0,
      tokens: { input: 20, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    }),
  );
  db.prepare(
    "insert into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)",
  ).run(
    `${sessionID}:runtime-model-selection`,
    sessionID,
    SESSION_ENTRY_MODEL_SELECTION,
    1,
    1,
    JSON.stringify(
      legacy ? { providerId, modelId: MODEL_ID, thoughtLevel: "disabled" } : { modelSelection },
    ),
  );
  for (const [id, text, metadata] of [
    ["signed", "Historical thinking", { anthropic: { signature: SIGNATURE } }],
    ["redacted", "", { anthropic: { redactedData: REDACTED_DATA } }],
  ] as const) {
    await store.savePart({
      id: createPartId(id),
      sessionID,
      messageID: ASSISTANT_ID,
      type: "reasoning",
      text,
      metadata,
      time: { start: 2, end: 3 },
    });
  }
  for (const [messageID, text] of [
    [USER_ID, "Inspect report"],
    [ASSISTANT_ID, "Inspecting report"],
  ] as const) {
    await store.savePart({
      id: createPartId(`${messageID}-text`),
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: 1, end: 3 },
    });
  }
  await store.savePart({
    id: createPartId("read"),
    sessionID,
    messageID: ASSISTANT_ID,
    type: "tool",
    tool: "Read",
    callID: "old-read",
    state: {
      status: "completed",
      input: { file_path: "report.txt" },
      output: "Report content",
      title: "Report",
      metadata: {},
      time: { start: 2, end: 3 },
    },
  });
}

function modelResponse(streaming: boolean): Response {
  const message = {
    id: "msg_replay",
    model: MODEL_ID,
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 1 },
    content: [{ type: "text", text: "done" }],
  };
  if (!streaming)
    return new Response(JSON.stringify(message), {
      headers: { "content-type": "application/json" },
    });
  const events = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

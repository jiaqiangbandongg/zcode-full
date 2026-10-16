import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "./artifacts.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  createApp,
  makeCaseDirs,
  modelContentToText,
  writeProviderConfig,
} from "./case-utils.mjs";
import { FAKE_MODEL } from "./constants.mjs";
import { assertUsageAnchorScenario } from "./case-usage-anchor-assertions.mjs";
import { createScenarioHandler, promptsForScenario } from "./case-usage-anchor-provider.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import { startScriptedProvider, stopScriptedProvider } from "./scripted-provider.mjs";

const CASE_NAME = "usage-anchor";
const CONTEXT_WINDOW = 20_000;
const MAX_OUTPUT_TOKENS = 16_000;

const SCENARIOS = ["full", "reactive", "input-only", "hydration", "rewind"];
const RESTART_AFTER_SCENARIOS = new Set(["full", "reactive", "hydration", "rewind"]);

export const usageAnchorCase = {
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const scenarioResults = [];
    const scenarioFailures = [];
    const caseRoot = input.caseRoot;

    for (const scenario of SCENARIOS) {
      try {
        scenarioResults.push(await runScenario({ ...input, caseRoot, scenario }));
      } catch (error) {
        scenarioFailures.push({ error, scenario });
      }
    }

    if (scenarioFailures.length > 0) {
      const details = scenarioFailures
        .map(
          ({ error, scenario }) => `${scenario}: ${error instanceof Error ? error.message : error}`,
        )
        .join("\n");
      throw new Error(`usage-anchor scenario failures:\n${details}`, {
        cause: scenarioFailures[0].error,
      });
    }

    const resultPath = `${input.artifactsRoot}/cases/${CASE_NAME}/result.json`;
    const capturePath = `${input.artifactsRoot}/cases/${CASE_NAME}/capture.json`;
    const eventsPath = `${input.artifactsRoot}/cases/${CASE_NAME}/events.json`;
    await mkdir(`${input.artifactsRoot}/cases/${CASE_NAME}`, { recursive: true });
    const resultPayload = buildCaseResult({
      capturedProviderRequestCount: scenarioResults.reduce(
        (total, result) => total + result.capturedProviderRequestCount,
        0,
      ),
      caseName: CASE_NAME,
      capturePath,
      events: scenarioResults.flatMap((result) => result.events),
      eventsPath,
      response: scenarioResults.map((result) => result.response).join("\n"),
      resultPath,
      traceId: scenarioResults.at(-1)?.traceId,
    });
    await writeJsonFile(capturePath, {
      case: CASE_NAME,
      scenarios: scenarioResults.map((result) => ({
        name: result.scenario,
        records: result.records,
      })),
    });
    await writeJsonFile(eventsPath, {
      case: CASE_NAME,
      scenarios: scenarioResults.map((result) => ({
        events: result.events,
        name: result.scenario,
      })),
    });
    await writeJsonFile(resultPath, {
      ...resultPayload,
      scenarios: scenarioResults.map(({ events: _events, records: _records, ...result }) => result),
    });
    return resultPayload;
  },
};

async function runScenario(input) {
  const scenarioName = `${CASE_NAME}-${input.scenario}`;
  const paths = await makeCaseDirs({
    ...input,
    caseName: scenarioName,
    caseRoot: join(input.caseRoot, input.scenario),
  });
  const events = [];
  let app;
  let provider;
  let rewindFollowUpRecordIndex;
  const historySnapshots = {};
  const durableSnapshots = {};

  try {
    await prepareWorkspace({
      fixtureDir: input.fixtureDir,
      workspace: paths.workspace,
    });
    provider = await startScriptedProvider({
      handler: createScenarioHandler(input.scenario),
      name: scenarioName,
    });
    await writeProviderConfig(paths.configPath, {
      apiKeyRequired: false,
      baseURL: provider.baseURL,
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      model: FAKE_MODEL,
      providerId: "compact-e2e-fake",
      providerName: "Usage Anchor E2E Provider",
      storageDir: paths.storageDir,
    });
    app = createApp({
      configPath: paths.configPath,
      modules: input.modules,
      runtimeConfig: buildRuntimeConfig({
        compact: {
          bufferTokens: 1,
          contextWindow: CONTEXT_WINDOW,
          // Reactive 场景只关闭 auto compact，保留 overflow 后的 reactive compact。
          maxConsecutiveFailures: input.scenario === "reactive" ? 0 : 1,
          microcompact: { enabled: false },
        },
        modelContextBudgetStrategy: "preflight-v1",
        maxTurns: 8,
        workspace: paths.workspace,
      }),
      storageDir: paths.storageDir,
    });

    const prompts = promptsForScenario(input.scenario);
    let result;
    for (const prompt of prompts) {
      result = await app.submitPrompt(prompt, { onEvent: async (event) => events.push(event) });
    }

    historySnapshots.beforeRestart = captureRuntimeHistory(app);
    durableSnapshots.beforeRestart = await captureDurableAssistantHistory(app);

    if (RESTART_AFTER_SCENARIOS.has(input.scenario) && input.scenario !== "rewind") {
      const sessionId = app.sessionId;
      await app.close?.();
      app = createApp({
        configPath: paths.configPath,
        modules: input.modules,
        resume: true,
        runtimeConfig: buildRuntimeConfig({
          compact: {
            bufferTokens: 1,
            contextWindow: CONTEXT_WINDOW,
            microcompact: { enabled: false },
          },
          modelContextBudgetStrategy: "preflight-v1",
          maxTurns: 8,
          workspace: paths.workspace,
        }),
        sessionId,
        storageDir: paths.storageDir,
      });
      await app.resume?.();
      historySnapshots.afterRestartBeforeFollowUp = captureRuntimeHistory(app);
      durableSnapshots.afterRestartBeforeFollowUp = await captureDurableAssistantHistory(app);
      result = await app.submitPrompt("Hydration follow-up after restart.", {
        onEvent: async (event) => events.push(event),
      });
      historySnapshots.afterRestart = captureRuntimeHistory(app);
      durableSnapshots.afterRestart = await captureDurableAssistantHistory(app);
    }

    if (input.scenario === "rewind") {
      historySnapshots.beforeRewind = historySnapshots.beforeRestart;
      durableSnapshots.beforeRewind = durableSnapshots.beforeRestart;
      const targetMessageId = app.runtime.latestAssistantMessageId;
      assertCondition(
        typeof targetMessageId === "string" && targetMessageId.length > 0,
        "expected a persisted assistant id before rewind",
      );
      await app.submitPrompt(`/rewind conversation ${targetMessageId}`, {
        onEvent: async (event) => events.push(event),
      });
      rewindFollowUpRecordIndex = provider.records.length;
      result = await app.submitPrompt("Rewind follow-up.", {
        onEvent: async (event) => events.push(event),
      });
      historySnapshots.afterRewind = captureRuntimeHistory(app);
      durableSnapshots.afterRewind = await captureDurableAssistantHistory(app);

      const sessionId = app.sessionId;
      await app.close?.();
      app = createApp({
        configPath: paths.configPath,
        modules: input.modules,
        resume: true,
        runtimeConfig: buildRuntimeConfig({
          compact: {
            bufferTokens: 1,
            contextWindow: CONTEXT_WINDOW,
            microcompact: { enabled: false },
          },
          modelContextBudgetStrategy: "preflight-v1",
          maxTurns: 8,
          workspace: paths.workspace,
        }),
        sessionId,
        storageDir: paths.storageDir,
      });
      await app.resume?.();
      historySnapshots.afterRestartBeforeFollowUp = captureRuntimeHistory(app);
      durableSnapshots.afterRestartBeforeFollowUp = await captureDurableAssistantHistory(app);
      result = await app.submitPrompt("Rewind follow-up after restart.", {
        onEvent: async (event) => events.push(event),
      });
      historySnapshots.afterRestart = captureRuntimeHistory(app);
      durableSnapshots.afterRestart = await captureDurableAssistantHistory(app);
    }

    assertUsageAnchorScenario({
      records: provider.records,
      response: result?.response ?? "",
      rewindFollowUpRecordIndex,
      scenario: input.scenario,
      durableSnapshots,
      historySnapshots,
    });
    assertProviderCapture(provider.records);
    await writeJsonFile(paths.capturePath, {
      records: provider.records,
      scenario: input.scenario,
    });
    await writeJsonFile(paths.eventsPath, events);

    return {
      capturedProviderRequestCount: provider.records.length,
      events,
      records: provider.records,
      response: result?.response ?? "",
      resultPath: paths.resultPath,
      scenario: input.scenario,
      traceId: result?.traceId,
      durableSnapshots,
      historySnapshots,
    };
  } catch (error) {
    await writeJsonFile(paths.capturePath, {
      error: error instanceof Error ? error.message : String(error),
      records: provider?.records ?? [],
      scenario: input.scenario,
    });
    await writeJsonFile(paths.eventsPath, events);
    throw error;
  } finally {
    await app?.close?.();
    await stopScriptedProvider(provider);
  }
}

function captureRuntimeHistory(app) {
  const entries = app?.runtime?.messageHistory?.borrowReadOnlyRuntimeEntries?.() ?? [];
  return entries.map((entry) => ({
    content:
      entry.kind === "attachment" ? entry.content : modelContentToText(entry.message?.content),
    kind: entry.kind ?? "message",
    role: entry.kind === "attachment" ? undefined : entry.message?.role,
    source: entry.metadata?.source,
    tokens: entry.tokens ? structuredClone(entry.tokens) : undefined,
  }));
}

async function captureDurableAssistantHistory(app) {
  const runtime = app?.runtime;
  const sessionStore = runtime?.sessionStore;
  if (!sessionStore?.messages) {
    throw new Error(
      `E2E runtime session store is unavailable; runtime keys: ${Object.getOwnPropertyNames(runtime ?? {}).join(",")}`,
    );
  }
  const messages = (await sessionStore.messages({ sessionID: app.sessionId })) ?? [];
  return messages
    .filter((message) => message.info?.role === "assistant")
    .map((message) => ({
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      id: message.info.id,
      tokens: message.info.tokens ? structuredClone(message.info.tokens) : undefined,
    }));
}

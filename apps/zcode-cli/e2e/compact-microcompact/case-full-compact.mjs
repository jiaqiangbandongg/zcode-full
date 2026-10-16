import { DEFAULT_PROVIDER } from "./constants.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  compactBoundaries,
  createApp,
  makeCaseDirs,
  modelRequests,
  stringifyModelRequest,
  writeProviderConfig,
} from "./case-utils.mjs";
import { startCaptureProxy, stopCaptureProxy, writeCaptureFile } from "./capture-proxy.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";

const MANUAL_CASE_NAME = "manual-full-compact";
const AUTO_CASE_NAME = "auto-full-compact";
const MANUAL_DONE_MARKER = "MANUAL_FULL_COMPACT_E2E_DONE";
const MANUAL_SUMMARY_MARKER = "MANUAL_FULL_COMPACT_SUMMARY_MARKER";
const AUTO_DONE_MARKER = "AUTO_FULL_COMPACT_E2E_DONE";
const AUTO_SENTINEL = "AUTO_BASH_FULL_COMPACT_SENTINEL";

export const manualFullCompactCase = {
  name: MANUAL_CASE_NAME,
  requiresApiKey: true,
  async run(input) {
    return runRealFullCompactCase(input, {
      assert: assertManualOutcome,
      caseName: MANUAL_CASE_NAME,
      compactConfig: { bufferTokens: 1_000, contextWindow: 1_000_000 },
      prompts: [
        "Manual compact setup A. Reply with MANUAL_SETUP_ALPHA_ACK only. Do not use tools.",
        "Manual compact setup B. Reply with MANUAL_SETUP_BETA_ACK only. Do not use tools.",
        `/compact Include ${MANUAL_SUMMARY_MARKER}. Preserve that the next continuation must answer ${MANUAL_DONE_MARKER}.`,
        `Continue the manual full compact E2E. Answer with ${MANUAL_DONE_MARKER} only.`,
      ],
    });
  },
};

export const autoFullCompactCase = {
  name: AUTO_CASE_NAME,
  requiresApiKey: true,
  async run(input) {
    return runRealFullCompactCase(input, {
      assert: assertAutoOutcome,
      autoSentinel: AUTO_SENTINEL,
      caseName: AUTO_CASE_NAME,
      compactConfig: {
        bufferTokens: 1,
        contextWindow: 180,
        microcompact: { enabled: false },
      },
      prompts: [
        [
          "Run the auto compact E2E.",
          "Use Bash exactly once with this command: node scripts/emit-auto.mjs",
          "After the Bash result returns, answer with AUTO_FULL_COMPACT_E2E_DONE.",
          "The Bash output intentionally has many lines so runtime performs auto compact before the final answer.",
        ].join("\n"),
      ],
    });
  },
};

async function runRealFullCompactCase(input, scenario) {
  const events = [];
  const paths = await makeCaseDirs({ ...input, caseName: scenario.caseName });
  let app;
  let captureProxy;

  try {
    await prepareWorkspace({
      autoSentinel: scenario.autoSentinel,
      fixtureDir: input.fixtureDir,
      workspace: paths.workspace,
    });
    captureProxy = await startCaptureProxy({ upstreamBaseURL: input.options.baseURL });
    await writeProviderConfig(paths.configPath, {
      baseURL: captureProxy.baseURL,
      model: input.options.model,
      providerId: DEFAULT_PROVIDER,
      providerName: "DeepSeek",
      storageDir: paths.storageDir,
    });
    app = await createApp({
      configPath: paths.configPath,
      modules: input.modules,
      runtimeConfig: buildRuntimeConfig({
        compact: scenario.compactConfig,
        workspace: paths.workspace,
      }),
      storageDir: paths.storageDir,
    });

    let result;
    for (const prompt of scenario.prompts) {
      result = await app.submitPrompt(prompt, {
        onEvent: async (event) => events.push(event),
      });
    }

    scenario.assert({
      events,
      response: result?.response ?? "",
      modules: input.modules,
    });
    assertProviderCapture(captureProxy.records);

    await writeCaptureFile(captureProxy, paths.capturePath);
    await writeJsonFile(paths.eventsPath, events);
    const resultPayload = buildCaseResult({
      capturedProviderRequestCount: captureProxy.records.length,
      caseName: scenario.caseName,
      capturePath: paths.capturePath,
      events,
      eventsPath: paths.eventsPath,
      response: result?.response ?? "",
      resultPath: paths.resultPath,
      traceId: result?.traceId,
    });
    await writeJsonFile(paths.resultPath, resultPayload);
    return resultPayload;
  } catch (error) {
    await writeCaptureFile(captureProxy, paths.capturePath);
    await writeJsonFile(paths.eventsPath, events);
    throw error;
  } finally {
    await app?.close?.();
    await stopCaptureProxy(captureProxy);
  }
}

function assertManualOutcome(input) {
  const { SessionEventType, CompactTrigger, CompactPhase } = input.modules;
  const boundaries = compactBoundaries(input.events, SessionEventType);
  const compactRequests = modelRequests(input.events, SessionEventType).filter(
    (event) => event.payload?.querySource === "compact",
  );
  const finalContext = stringifyModelRequest(modelRequests(input.events, SessionEventType).at(-1));

  assertCondition(boundaries.length >= 1, "expected a manual compact boundary");
  assertCondition(boundaries.at(-1)?.payload?.trigger === CompactTrigger.Manual, "expected manual trigger", {
    boundary: boundaries.at(-1)?.payload,
  });
  assertCondition(
    boundaries.at(-1)?.payload?.phase === CompactPhase.StandaloneTurn,
    "expected standalone compact phase",
    { boundary: boundaries.at(-1)?.payload },
  );
  assertCondition(compactRequests.length >= 1, "expected a compact summary model request");
  assertCondition(compactRequests.every((event) => event.payload?.toolCount === 0), "compact must not expose tools");
  assertCondition(
    stringifyModelRequest(compactRequests.at(-1)).includes(MANUAL_SUMMARY_MARKER),
    "expected custom compact instruction to reach summary request",
  );
  assertCondition(
    finalContext.includes("This session is being continued from a previous conversation"),
    "expected post-compact continuation context",
  );
  assertCondition(input.response.includes(MANUAL_DONE_MARKER), `expected ${MANUAL_DONE_MARKER}`, {
    response: input.response,
  });
}

function assertAutoOutcome(input) {
  const { SessionEventType, CompactTrigger, CompactPhase } = input.modules;
  const boundaries = compactBoundaries(input.events, SessionEventType);
  const toolResults = input.events.filter((event) => event.type === SessionEventType.ToolCallResult);
  const compactRequests = modelRequests(input.events, SessionEventType).filter(
    (event) => event.payload?.querySource === "compact",
  );

  assertCondition(toolResults.length >= 1, "expected at least one Bash tool result");
  assertCondition(boundaries.length >= 1, "expected an auto compact boundary");
  assertCondition(boundaries.at(-1)?.payload?.trigger === CompactTrigger.Auto, "expected auto trigger", {
    boundary: boundaries.at(-1)?.payload,
  });
  assertCondition(boundaries.at(-1)?.payload?.phase === CompactPhase.MidTurn, "expected mid-turn compact", {
    boundary: boundaries.at(-1)?.payload,
  });
  assertCondition(compactRequests.length >= 1, "expected compact summary request");
  assertCondition(input.response.includes(AUTO_DONE_MARKER), `expected ${AUTO_DONE_MARKER}`, {
    response: input.response,
  });
}

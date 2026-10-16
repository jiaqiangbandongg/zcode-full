import { FAKE_MODEL } from "./constants.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  compactBoundaries,
  createApp,
  fakeProviderConfig,
  makeCaseDirs,
  modelRequests,
  writeProviderConfig,
} from "./case-utils.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import {
  chatCompletion,
  contextExceededError,
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "./scripted-provider.mjs";

const PTL_CASE_NAME = "compact-ptl-retry";
const REACTIVE_CASE_NAME = "reactive-compact";
const PTL_SUMMARY_MARKER = "PTL_RETRY_SUMMARY_MARKER";
const REACTIVE_DONE_MARKER = "REACTIVE_COMPACT_E2E_DONE";
const REACTIVE_SUMMARY_MARKER = "REACTIVE_COMPACT_SUMMARY_MARKER";

export const compactPtlRetryCase = {
  name: PTL_CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    return runScriptedCompactCase(input, {
      assert: assertPtlRetryOutcome,
      caseName: PTL_CASE_NAME,
      handler: createPtlRetryHandler(),
      prompts: [
        "PTL setup round A. Reply with PTL_SETUP_A_ACK only. Do not use tools.",
        "PTL setup round B. Reply with PTL_SETUP_B_ACK only. Do not use tools.",
        "/compact keep the PTL retry marker",
      ],
    });
  },
};

export const reactiveCompactCase = {
  name: REACTIVE_CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    return runScriptedCompactCase(input, {
      assert: assertReactiveOutcome,
      caseName: REACTIVE_CASE_NAME,
      handler: createReactiveHandler(),
      maxConsecutiveFailures: 0,
      prompts: [
        "Reactive setup round A. Reply with REACTIVE_SETUP_A_ACK only. Do not use tools.",
        "Reactive setup round B. Reply with REACTIVE_SETUP_B_ACK only. Do not use tools.",
        `Trigger reactive compact and then answer ${REACTIVE_DONE_MARKER}.`,
      ],
    });
  },
};

async function runScriptedCompactCase(input, scenario) {
  const events = [];
  const paths = await makeCaseDirs({ ...input, caseName: scenario.caseName });
  let app;
  let provider;

  try {
    await prepareWorkspace({
      fixtureDir: input.fixtureDir,
      workspace: paths.workspace,
    });
    provider = await startScriptedProvider({
      handler: scenario.handler,
      name: scenario.caseName,
    });
    await writeProviderConfig(
      paths.configPath,
      fakeProviderConfig({
        baseURL: provider.baseURL,
        model: FAKE_MODEL,
        storageDir: paths.storageDir,
      }),
    );
    app = await createApp({
      configPath: paths.configPath,
      modules: input.modules,
      runtimeConfig: buildRuntimeConfig({
        compact: {
          bufferTokens: 1,
          contextWindow: 220,
          maxConsecutiveFailures: scenario.maxConsecutiveFailures ?? 1,
          microcompact: { enabled: false },
        },
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
      records: provider.records,
      response: result?.response ?? "",
      modules: input.modules,
    });
    assertProviderCapture(provider.records);

    await writeScriptedCaptureFile(provider, paths.capturePath);
    await writeJsonFile(paths.eventsPath, events);
    const resultPayload = buildCaseResult({
      capturedProviderRequestCount: provider.records.length,
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
    await writeScriptedCaptureFile(provider, paths.capturePath);
    await writeJsonFile(paths.eventsPath, events);
    throw error;
  } finally {
    await app?.close?.();
    await stopScriptedProvider(provider);
  }
}

function createPtlRetryHandler() {
  let compactAttempts = 0;
  let mainResponses = 0;
  return async ({ body }) => {
    if (isCompactRequest(body)) {
      compactAttempts += 1;
      if (compactAttempts === 1) {
        return { body: contextExceededError(), status: 400 };
      }
      return {
        body: chatCompletion({
          content: `<analysis>retry ok</analysis><summary>${PTL_SUMMARY_MARKER}: compact retry succeeded.</summary>`,
          model: body?.model,
        }),
      };
    }

    mainResponses += 1;
    return {
      body: chatCompletion({
        content: `PTL_SETUP_${mainResponses}_ACK`,
        model: body?.model,
      }),
    };
  };
}

function createReactiveHandler() {
  let compactAttempts = 0;
  let mainResponses = 0;
  let overflowSent = false;
  return async ({ body }) => {
    if (isCompactRequest(body)) {
      compactAttempts += 1;
      return {
        body: chatCompletion({
          content: `<analysis>reactive ok</analysis><summary>${REACTIVE_SUMMARY_MARKER}: continue the user request.</summary>`,
          model: body?.model,
        }),
      };
    }

    mainResponses += 1;
    if (mainResponses === 3 && !overflowSent) {
      overflowSent = true;
      return { body: contextExceededError(), status: 400 };
    }

    return {
      body: chatCompletion({
        content: mainResponses >= 4 ? REACTIVE_DONE_MARKER : `REACTIVE_SETUP_${mainResponses}_ACK`,
        model: body?.model,
      }),
    };
  };
}

function assertPtlRetryOutcome(input) {
  const { SessionEventType, CompactTrigger } = input.modules;
  const boundaries = compactBoundaries(input.events, SessionEventType);
  const compactRequests = modelRequests(input.events, SessionEventType).filter(
    (event) => event.payload?.querySource === "compact",
  );
  const compactStatuses = input.records
    .filter((record) => record.requestBody.includes("create a detailed summary"))
    .map((record) => record.status);

  assertCondition(boundaries.length >= 1, "expected compact boundary after PTL retry");
  assertCondition(boundaries.at(-1)?.payload?.trigger === CompactTrigger.Manual, "expected manual trigger");
  assertCondition(compactRequests.length >= 2, "expected compact prompt-too-long retry");
  assertCondition(
    compactRequests.some((event) => event.payload?.compactPromptTooLongRetry === 1),
    "expected retry metadata on second compact request",
  );
  assertCondition(compactStatuses.includes(400) && compactStatuses.includes(200), "expected 400 then 200 compact requests", {
    compactStatuses,
  });
}

function assertReactiveOutcome(input) {
  const { SessionEventType, CompactTrigger, CompactPhase, CompactReason } = input.modules;
  const boundaries = compactBoundaries(input.events, SessionEventType);
  const compactRequests = modelRequests(input.events, SessionEventType).filter(
    (event) => event.payload?.querySource === "compact",
  );

  assertCondition(
    boundaries.every((event) => event.payload?.trigger !== CompactTrigger.Auto),
    "reactive compact fixture must not auto compact before the provider overflow",
    { boundaries: boundaries.map((event) => event.payload) },
  );
  assertCondition(boundaries.length >= 1, "expected reactive compact boundary");
  assertCondition(boundaries.at(-1)?.payload?.trigger === CompactTrigger.Reactive, "expected reactive trigger", {
    boundary: boundaries.at(-1)?.payload,
  });
  assertCondition(boundaries.at(-1)?.payload?.phase === CompactPhase.Reactive, "expected reactive phase");
  assertCondition(
    boundaries.at(-1)?.payload?.compactReason === CompactReason.ProviderOverflow,
    "expected provider overflow reason",
  );
  assertCondition(compactRequests.length >= 1, "expected reactive compact summary request");
  assertCondition(input.records.some((record) => record.status === 400), "expected captured context overflow");
  assertCondition(input.response.includes(REACTIVE_DONE_MARKER), `expected ${REACTIVE_DONE_MARKER}`, {
    response: input.response,
  });
}

function isCompactRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("Your task is to create a detailed summary"),
  );
}

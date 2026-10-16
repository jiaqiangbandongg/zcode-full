import {
  assertCondition,
  buildCaseResult,
  buildRuntimeConfig,
  compactBoundaries,
  createApp,
  makeCaseDirs,
  modelRequests,
  writeProviderConfig,
} from "./case-utils.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import {
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "./scripted-provider.mjs";

const CASE_NAME = "openai-responses-compact";
const FAKE_API_KEY = "sk-e2e-fake";
const MODEL = "gpt-5.5-e2e";
const MODEL_REF = `${CASE_NAME}/${MODEL}`;
const SETUP_MARKER = "RESPONSES_COMPACT_SETUP_ACK";
const SUMMARY_MARKER = "RESPONSES_COMPACT_SUMMARY_MARKER";
const DONE_MARKER = "RESPONSES_COMPACT_DONE";
const COMPACT_PROMPT_MARKER = "Your task is to create a detailed summary";

export const openAiResponsesCompactCase = {
  model: MODEL_REF,
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const events = [];
    const paths = await makeCaseDirs({ ...input, caseName: CASE_NAME });
    let app;
    let provider;

    try {
      await prepareWorkspace({ fixtureDir: input.fixtureDir, workspace: paths.workspace });
      provider = await startScriptedProvider({
        handler: createResponsesHandler(),
        name: CASE_NAME,
      });
      await writeProviderConfig(paths.configPath, {
        apiKey: FAKE_API_KEY,
        baseURL: provider.baseURL,
        kind: "openai",
        model: MODEL,
        providerId: CASE_NAME,
        providerName: "OpenAI Responses Compact E2E",
        storageDir: paths.storageDir,
      });
      app = await createApp({
        configPath: paths.configPath,
        modules: input.modules,
        runtimeConfig: {
          ...buildRuntimeConfig({
            compact: {
              bufferTokens: 1,
              contextWindow: 1_000_000,
              microcompact: { enabled: false },
            },
            workspace: paths.workspace,
          }),
          modelStreaming: "on",
        },
        storageDir: paths.storageDir,
      });

      const prompts = [
        `Reply with ${SETUP_MARKER} only. Do not use tools.`,
        `/compact Include ${SUMMARY_MARKER}.`,
        `Continue after compact and reply with ${DONE_MARKER} only.`,
      ];
      const promptResults = [];
      let result;
      for (const prompt of prompts) {
        result = await app.submitPrompt(prompt, {
          onEvent: async (event) => events.push(event),
        });
        promptResults.push(result);
      }

      assertOutcome({
        compactResponse: promptResults[1]?.response ?? "",
        events,
        modules: input.modules,
        records: provider.records,
        response: result?.response ?? "",
      });

      await writeScriptedCaptureFile(provider, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      const resultPayload = buildCaseResult({
        capturedProviderRequestCount: provider.records.length,
        caseName: CASE_NAME,
        capturePath: paths.capturePath,
        events,
        eventsPath: paths.eventsPath,
        model: MODEL_REF,
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
  },
};

function createResponsesHandler() {
  let responseIndex = 0;
  return async ({ body }) => {
    responseIndex += 1;
    const requestText = JSON.stringify(body);

    if (requestText.includes(COMPACT_PROMPT_MARKER)) {
      if (body?.stream === true) {
        return {
          body: {
            error: {
              code: "streaming_not_supported",
              message: "Streaming is not supported for this compact fixture.",
              type: "invalid_request_error",
            },
          },
          status: 404,
        };
      }
      return {
        body: responsesJson({
          id: `resp-compact-${responseIndex}`,
          text: `<analysis>compat e2e</analysis><summary>${SUMMARY_MARKER}: compact succeeded.</summary>`,
          omitMessageId: true,
          omitAnnotations: true,
        }),
      };
    }

    const text = requestText.includes(DONE_MARKER) ? DONE_MARKER : SETUP_MARKER;
    if (body?.stream === true) {
      return responsesSse({ id: `resp-main-${responseIndex}`, text });
    }

    return {
      body: responsesJson({ id: `resp-sidecar-${responseIndex}`, text: "Responses Compact E2E" }),
    };
  };
}

function responsesSse(input) {
  const messageId = `${input.id}-message`;
  const frames = [
    {
      type: "response.created",
      response: { id: input.id, created_at: 1, model: MODEL, service_tier: null },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: messageId, phase: "final_answer" },
    },
    { type: "response.output_text.delta", item_id: messageId, delta: input.text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: messageId, phase: "final_answer" },
    },
    {
      type: "response.completed",
      response: { incomplete_details: null, usage: responsesUsage(), service_tier: null },
    },
  ];
  return {
    bodyText: `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    headers: { "content-type": "text/event-stream" },
  };
}

function responsesJson(input) {
  return {
    id: input.id,
    created_at: 1,
    model: MODEL,
    output: [
      {
        type: "message",
        role: "assistant",
        ...(!input.omitMessageId ? { id: `${input.id}-message` } : {}),
        content: [
          {
            type: "output_text",
            text: input.text,
            ...(!input.omitAnnotations ? { annotations: [] } : {}),
          },
        ],
      },
    ],
    usage: responsesUsage(),
  };
}

function responsesUsage() {
  return {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function assertOutcome(input) {
  const { CompactPhase, CompactReason, CompactTrigger, SessionEventType } = input.modules;
  const boundaries = compactBoundaries(input.events, SessionEventType);
  const compactRequests = modelRequests(input.events, SessionEventType).filter(
    (event) => event.payload?.querySource === "compact",
  );
  const compactCompletions = input.events.filter(
    (event) =>
      event.type === SessionEventType.ModelComplete && event.payload?.querySource === "compact",
  );
  const mainCompletions = input.events.filter(
    (event) =>
      event.type === SessionEventType.ModelComplete && event.payload?.querySource === "main_turn",
  );
  const completedEvents = input.events.filter(
    (event) => event.type === SessionEventType.CompactCompleted,
  );
  const providerRequests = input.records.map((record) => ({
    ...record,
    body: JSON.parse(record.requestBody),
  }));
  const compactProviderRequests = providerRequests.filter((record) =>
    record.requestBody.includes(COMPACT_PROMPT_MARKER),
  );
  const compactStreamRequest = compactProviderRequests[0];
  const compactFallbackRequest = compactProviderRequests[1];
  const compactResponse = JSON.parse(compactFallbackRequest?.responseBody ?? "null");
  const setupRequest = providerRequests.find(
    (record) =>
      record.requestBody.includes(SETUP_MARKER) &&
      !record.requestBody.includes(COMPACT_PROMPT_MARKER) &&
      !record.requestBody.includes(DONE_MARKER),
  );
  const postCompactRequest = providerRequests.find((record) =>
    record.requestBody.includes(DONE_MARKER),
  );
  const compactTurnIds = new Set(compactRequests.map((event) => event.turnId));
  const compactStreamingEvents = input.events.filter(
    (event) => event.type === SessionEventType.ModelStreaming && compactTurnIds.has(event.turnId),
  );

  assertCondition(boundaries.length === 1, "expected exactly one compact boundary", { boundaries });
  assertCondition(
    boundaries[0]?.payload?.trigger === CompactTrigger.Manual,
    "expected manual compact",
  );
  assertCondition(
    boundaries[0]?.payload?.phase === CompactPhase.StandaloneTurn,
    "expected standalone compact phase",
  );
  assertCondition(
    boundaries[0]?.payload?.compactReason === CompactReason.UserRequested,
    "expected user-requested compact reason",
  );
  assertCondition(compactRequests.length === 1, "expected one compact model request", {
    compactRequestCount: compactRequests.length,
  });
  assertCondition(
    completedEvents.length === 1 && completedEvents[0]?.payload?.status === "completed",
    "expected compact completed status",
    { completedEvents },
  );
  assertCondition(
    compactCompletions.length === 1 &&
      compactCompletions[0]?.payload?.content?.includes(SUMMARY_MARKER),
    "expected compact model completion to retain summary marker",
    { compactCompletions },
  );
  assertCondition(
    mainCompletions[0]?.payload?.content?.includes(SETUP_MARKER),
    "expected streaming main turn to complete with setup marker",
    { mainCompletions },
  );
  assertCondition(input.compactResponse === "Compacted", "expected compact command response", {
    compactResponse: input.compactResponse,
  });
  assertCondition(
    compactProviderRequests.length === 2,
    "expected streaming compact request followed by non-stream fallback",
    {
      compactRequests: compactProviderRequests.map((record) => ({
        status: record.status,
        stream: record.body?.stream,
      })),
    },
  );
  assertCondition(compactStreamingEvents.length === 0, "compact stream must remain hidden", {
    compactStreamingEvents,
  });
  assertCondition(compactStreamRequest?.status === 404, "compact stream fixture must fail", {
    status: compactStreamRequest?.status,
  });
  assertCondition(
    compactFallbackRequest?.status === 200,
    "compact non-stream fallback fixture must succeed",
    { status: compactFallbackRequest?.status },
  );
  assertCondition(compactStreamRequest?.body?.stream === true, "compact must try streaming first", {
    body: compactStreamRequest?.body,
  });
  assertCondition(
    compactFallbackRequest?.body?.stream !== true,
    "compact must fall back to non-streaming",
    { body: compactFallbackRequest?.body },
  );
  assertCondition(
    JSON.stringify(withoutStream(compactStreamRequest?.body)) ===
      JSON.stringify(withoutStream(compactFallbackRequest?.body)),
    "compact transport legs must preserve the same request semantics",
    {
      fallback: withoutStream(compactFallbackRequest?.body),
      stream: withoutStream(compactStreamRequest?.body),
    },
  );
  assertCondition(
    providerRequests.every((record) => record.method === "POST" && record.url === "/responses"),
    "expected only POST /responses provider traffic",
    { requests: providerRequests.map((record) => ({ method: record.method, url: record.url })) },
  );
  assertCondition(
    !input.records.some((record) => record.url?.includes("/chat/completions")),
    "must not request Chat Completions",
  );
  assertCondition(
    providerRequests.every(
      (record) => record.requestHeaders.authorization === `Bearer ${FAKE_API_KEY}`,
    ),
    "expected the fake OpenAI API key on every provider request",
  );
  assertCondition(setupRequest?.body?.stream === true, "setup main request must stream", {
    body: setupRequest?.body,
  });
  assertCondition(
    postCompactRequest?.body?.stream === true,
    "post-compact main request must stream",
    { body: postCompactRequest?.body },
  );
  assertCondition(compactResponse?.output?.[0]?.id === undefined, "fixture must omit message id");
  assertCondition(
    compactResponse?.output?.[0]?.content?.[0]?.annotations === undefined,
    "fixture must omit output_text annotations",
  );
  assertCondition(
    postCompactRequest?.requestBody.includes(SUMMARY_MARKER),
    "post-compact request must retain summary marker",
  );
  assertCondition(input.response.includes(DONE_MARKER), `expected ${DONE_MARKER}`, {
    response: input.response,
  });
}

function withoutStream(body) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "stream"));
}

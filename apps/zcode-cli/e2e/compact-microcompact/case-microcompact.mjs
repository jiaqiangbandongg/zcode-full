import { DEFAULT_PROVIDER } from "./constants.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  compactBoundaries,
  countEvents,
  createApp,
  hasMicrocompactPlaceholder,
  makeCaseDirs,
  modelRequests,
  stringifyModelRequest,
  writeProviderConfig,
} from "./case-utils.mjs";
import { startCaptureProxy, stopCaptureProxy, writeCaptureFile } from "./capture-proxy.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";

const CASE_NAME = "microcompact";
const COMPLETION_MARKER = "MICROCOMPACT_E2E_DONE";
const ALPHA_SENTINEL = "ALPHA_BASH_MICROCOMPACT_SENTINEL";
const BETA_SENTINEL = "BETA_BASH_MICROCOMPACT_SENTINEL";
const MICROCOMPACT_THRESHOLD_TOKENS = 1;
const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 1;
const MICROCOMPACT_MIN_TOKEN_SAVINGS = 1;

export const microcompactCase = {
  name: CASE_NAME,
  requiresApiKey: true,
  async run(input) {
    const events = [];
    const paths = await makeCaseDirs(input);
    let app;
    let captureProxy;

    try {
      await prepareWorkspace({
        alphaSentinel: ALPHA_SENTINEL,
        betaSentinel: BETA_SENTINEL,
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
          compact: {
            microcompact: {
              compactableToolNames: ["Bash"],
              enabled: true,
              keepRecentToolResults: MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
              minTokenSavings: MICROCOMPACT_MIN_TOKEN_SAVINGS,
              thresholdTokens: MICROCOMPACT_THRESHOLD_TOKENS,
            },
          },
          workspace: paths.workspace,
        }),
        storageDir: paths.storageDir,
      });

      const result = await app.submitPrompt(buildPrompt(), {
        onEvent: async (event) => events.push(event),
      });

      assertMicrocompactOutcome({
        events,
        response: result.response,
        SessionEventType: input.modules.SessionEventType,
      });
      assertProviderCapture(captureProxy.records);

      await writeCaptureFile(captureProxy, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      const resultPayload = buildCaseResult({
        capturedProviderRequestCount: captureProxy.records.length,
        caseName: CASE_NAME,
        capturePath: paths.capturePath,
        events,
        eventsPath: paths.eventsPath,
        response: result.response,
        resultPath: paths.resultPath,
        traceId: result.traceId,
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
  },
};

function buildPrompt() {
  return [
    "Run this exact disposable Docker E2E procedure.",
    "Use the Bash tool exactly twice. Do not combine the commands into one Bash call.",
    "First Bash command: node scripts/emit-alpha.mjs",
    "Second Bash command: node scripts/emit-beta.mjs",
    "The scripts write marker files and print large stdout; that is intentional.",
    "Do not answer until both Bash tool results have been returned.",
    `Then answer with ${COMPLETION_MARKER} and mention that both scripts completed.`,
  ].join("\n");
}

function assertMicrocompactOutcome(input) {
  const { events, response, SessionEventType } = input;
  const toolResultEvents = events.filter((event) => event.type === SessionEventType.ToolCallResult);
  const microcompactEvents = events.filter(
    (event) => event.type === SessionEventType.MicrocompactBoundary,
  );
  const fullCompactEvents = compactBoundaries(events, SessionEventType);
  const finalContext = stringifyModelRequest(modelRequests(events, SessionEventType).at(-1));
  const hasAlpha = finalContext.includes(ALPHA_SENTINEL);
  const hasBeta = finalContext.includes(BETA_SENTINEL);

  assertCondition(toolResultEvents.length >= 2, "expected at least two tool results");
  assertCondition(microcompactEvents.length >= 1, "expected a microcompact boundary");
  assertCondition(fullCompactEvents.length === 0, "did not expect full compact boundary", {
    compactBoundaryCount: fullCompactEvents.length,
  });
  assertCondition(hasMicrocompactPlaceholder(finalContext), "expected microcompact placeholder", {
    finalContextPreview: finalContext.slice(0, 1000),
  });
  assertCondition(
    (hasAlpha || hasBeta) && hasAlpha !== hasBeta,
    "expected final request to keep only the most recent Bash sentinel",
    {
      hasAlpha,
      hasBeta,
      microcompactBoundaryCount: countEvents(events, SessionEventType.MicrocompactBoundary),
    },
  );
  assertCondition(response.includes(COMPLETION_MARKER), `expected ${COMPLETION_MARKER}`, {
    response,
  });
}

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAKE_MODEL } from "./constants.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  createApp,
  fakeProviderConfig,
  makeCaseDirs,
  modelRequests,
  stringifyModelRequest,
  writeProviderConfig,
} from "./case-utils.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import {
  chatCompletion,
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "./scripted-provider.mjs";

const CASE_NAME = "background-bash";
const COMPLETION_MARKER = "BACKGROUND_BASH_E2E_DONE";
const BACKGROUND_STDOUT_FIRST = "BACKGROUND_BASH_E2E_STDOUT_FIRST";
const BACKGROUND_STDERR = "BACKGROUND_BASH_E2E_STDERR";
const BACKGROUND_STDOUT_LAST = "BACKGROUND_BASH_E2E_STDOUT_LAST";
const FOREGROUND_STDOUT_FIRST = "FOREGROUND_BASH_E2E_STDOUT_FIRST";
const FOREGROUND_STDERR = "FOREGROUND_BASH_E2E_STDERR";
const FOREGROUND_STDOUT_LAST = "FOREGROUND_BASH_E2E_STDOUT_LAST";
const BACKGROUND_TOOL_CALL_ID = "call_background_bash_e2e";
const WAIT_TOOL_CALL_ID = "call_background_bash_wait";
const PIPE_FLUSH_MS = 50;
const WAIT_FOR_BACKGROUND_POLL_MS = 1_500;

export const backgroundBashCase = {
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const events = [];
    const paths = await makeCaseDirs({ ...input, caseName: CASE_NAME });
    let app;
    let provider;

    try {
      await prepareWorkspace({
        fixtureDir: input.fixtureDir,
        workspace: paths.workspace,
      });
      await writeBashScripts(paths.workspace);
      provider = await startScriptedProvider({
        handler: createBackgroundBashHandler(),
        name: CASE_NAME,
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
            contextWindow: 1_000_000,
            microcompact: { enabled: false },
          },
          maxTurns: 6,
          workspace: paths.workspace,
        }),
        storageDir: paths.storageDir,
      });

      const result = await app.submitPrompt(buildPrompt(), {
        onEvent: async (event) => events.push(event),
      });

      await assertBackgroundBashOutcome({
        events,
        records: provider.records,
        response: result.response,
        SessionEventType: input.modules.SessionEventType,
      });
      assertProviderCapture(provider.records);

      await writeScriptedCaptureFile(provider, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      const resultPayload = buildCaseResult({
        capturedProviderRequestCount: provider.records.length,
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
      await writeScriptedCaptureFile(provider, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
    }
  },
};

function buildPrompt() {
  return [
    "Run the background Bash E2E.",
    "Use Bash with run_in_background=true to run node scripts/background-bash.mjs.",
    "When the runtime reports the background task notification, read no files and answer with the completion marker only.",
    `Completion marker: ${COMPLETION_MARKER}`,
  ].join("\n");
}

function createBackgroundBashHandler() {
  let requestCount = 0;
  let waitIssued = false;

  return async ({ body }) => {
    requestCount += 1;
    const requestText = JSON.stringify(body?.messages ?? []);
    if (requestCount === 1) {
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall(BACKGROUND_TOOL_CALL_ID, "Bash", {
              command: "node scripts/background-bash.mjs",
              description: "Run background Bash E2E script",
              run_in_background: true,
            }),
          ],
        }),
      };
    }
    if (!waitIssued) {
      waitIssued = true;
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall(WAIT_TOOL_CALL_ID, "Bash", {
              command: "node scripts/foreground-bash.mjs",
              description: "Wait for background Bash E2E completion",
            }),
          ],
        }),
      };
    }
    if (requestText.includes("<task-notification>")) {
      return {
        body: chatCompletion({
          content: COMPLETION_MARKER,
          model: body?.model,
        }),
      };
    }

    return {
      body: chatCompletion({
        content: "BACKGROUND_BASH_E2E_MISSING_NOTIFICATION",
        model: body?.model,
      }),
    };
  };
}

async function assertBackgroundBashOutcome(input) {
  const { events, response, records, SessionEventType } = input;
  const startedEvents = events.filter(
    (event) => event.type === SessionEventType.BackgroundTaskStarted,
  );
  const completedEvents = events.filter(
    (event) => event.type === SessionEventType.BackgroundTaskCompleted,
  );
  const completedPayload = completedEvents.at(-1)?.payload;
  const requestContexts = modelRequests(events, SessionEventType).map(stringifyModelRequest);
  const notifiedContext = requestContexts.find((context) =>
    context.includes("<task-notification>"),
  );
  const messages = providerMessages(records);

  assertCondition(response.includes(COMPLETION_MARKER), `expected ${COMPLETION_MARKER}`, {
    response,
  });
  assertCondition(startedEvents.length >= 1, "expected a background task started event");
  assertCondition(completedEvents.length >= 1, "expected a background task completed event");
  assertCondition(completedPayload?.status === "completed", "expected background task completion", {
    completedPayload,
  });
  assertCondition(
    typeof completedPayload?.outputPath === "string" &&
      completedPayload.outputPath.endsWith("-stdout.log"),
    "expected stdout output path on background completion",
    { completedPayload },
  );
  assertCondition(
    completedPayload?.stderrPersistedOutputPath === undefined,
    "expected no split stderr output path on background completion",
    { completedPayload },
  );

  const expectedBackgroundResult =
    `Command running in background with ID: ${completedPayload.taskId}. ` +
    `Output is being written to: ${completedPayload.outputPath}. ` +
    "You will be notified when it completes. " +
    "To check interim output, use Read on that file path.";
  const backgroundResult = messages.find(
    (message) => message?.role === "tool" && message?.tool_call_id === BACKGROUND_TOOL_CALL_ID,
  )?.content;
  assertCondition(
    backgroundResult === expectedBackgroundResult,
    "expected exact single-path background Bash provider result",
    { backgroundResult, expectedBackgroundResult },
  );

  const expectedForegroundResult = [
    FOREGROUND_STDOUT_FIRST,
    FOREGROUND_STDERR,
    FOREGROUND_STDOUT_LAST,
  ].join("\n");
  const foregroundResult = messages.find(
    (message) => message?.role === "tool" && message?.tool_call_id === WAIT_TOOL_CALL_ID,
  )?.content;
  assertCondition(
    foregroundResult === expectedForegroundResult,
    "expected foreground Bash provider result to preserve synchronized stdout/stderr order",
    { foregroundResult, expectedForegroundResult },
  );

  const expectedNotification = [
    "<task-notification>",
    `<task-id>${completedPayload.taskId}</task-id>`,
    `<tool-use-id>${BACKGROUND_TOOL_CALL_ID}</tool-use-id>`,
    `<output-file>${completedPayload.outputPath}</output-file>`,
    "<status>completed</status>",
    '<summary>Background command "Run background Bash E2E script" completed (exit code 0)</summary>',
    "</task-notification>",
  ].join("\n");
  const providerNotification = messages.find(
    (message) =>
      typeof message?.content === "string" && message.content.includes("<task-notification>"),
  )?.content;

  assertCondition(Boolean(notifiedContext), "expected task notification in model context");
  assertCondition(
    providerNotification === expectedNotification,
    "expected exact single-path background Bash completion notification",
    { expectedNotification, providerNotification },
  );

  const output = await readFile(completedPayload.outputPath, "utf8");
  const expectedOutput = [
    BACKGROUND_STDOUT_FIRST,
    BACKGROUND_STDERR,
    BACKGROUND_STDOUT_LAST,
    "",
  ].join("\n");
  assertCondition(
    output === expectedOutput,
    "expected canonical output file to preserve synchronized stdout/stderr order",
    { expectedOutput, output, outputPath: completedPayload.outputPath },
  );
  assertCondition(
    completedPayload.stdoutPersistedOutputPath === completedPayload.outputPath,
    "expected stdout compatibility path to reuse the canonical output file",
    {
      completedPayload,
    },
  );
}

function providerMessages(records) {
  return records.flatMap((record) => {
    const body = JSON.parse(record.requestBody);
    return Array.isArray(body?.messages) ? body.messages : [];
  });
}

async function writeBashScripts(workspace) {
  const backgroundScript = [
    'import { writeSync } from "node:fs";',
    `writeSync(1, ${JSON.stringify(`${BACKGROUND_STDOUT_FIRST}\n`)});`,
    `await new Promise((resolve) => setTimeout(resolve, ${PIPE_FLUSH_MS}));`,
    `writeSync(2, ${JSON.stringify(`${BACKGROUND_STDERR}\n`)});`,
    `await new Promise((resolve) => setTimeout(resolve, ${PIPE_FLUSH_MS}));`,
    `writeSync(1, ${JSON.stringify(`${BACKGROUND_STDOUT_LAST}\n`)});`,
    "",
  ].join("\n");
  const foregroundScript = [
    'import { writeSync } from "node:fs";',
    `writeSync(1, ${JSON.stringify(`${FOREGROUND_STDOUT_FIRST}\n`)});`,
    `await new Promise((resolve) => setTimeout(resolve, ${PIPE_FLUSH_MS}));`,
    `writeSync(2, ${JSON.stringify(`${FOREGROUND_STDERR}\n`)});`,
    `await new Promise((resolve) => setTimeout(resolve, ${PIPE_FLUSH_MS}));`,
    `writeSync(1, ${JSON.stringify(`${FOREGROUND_STDOUT_LAST}\n`)});`,
    `await new Promise((resolve) => setTimeout(resolve, ${WAIT_FOR_BACKGROUND_POLL_MS}));`,
    "",
  ].join("\n");
  await Promise.all([
    writeFile(join(workspace, "scripts", "background-bash.mjs"), backgroundScript),
    writeFile(join(workspace, "scripts", "foreground-bash.mjs"), foregroundScript),
  ]);
}

function openAiToolCall(id, name, input) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(input),
    },
  };
}

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

const CASE_NAME = "bash-read-state";
const COMPLETION_MARKER = "BASH_READ_STATE_E2E_DONE";
const TARGET_FILE = "target.txt";
const INITIAL_CONTENT = "alpha\nbeta\n";
const FORMATTED_CONTENT = "delta\nbeta\n";
const STALE_HINT =
  "[This command modified 1 file you've previously read: target.txt. Call Read before editing.]";
const NOT_READ_ERROR = "File has not been read yet. Read it first before writing to it.";

export const bashReadStateCase = {
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const events = [];
    const paths = await makeCaseDirs({ ...input, caseName: CASE_NAME });
    const targetPath = join(paths.workspace, TARGET_FILE);
    let app;
    let provider;

    try {
      await prepareWorkspace({
        fixtureDir: input.fixtureDir,
        workspace: paths.workspace,
      });
      await writeFile(targetPath, INITIAL_CONTENT);
      await writeFormatterScript(paths.workspace);
      provider = await startScriptedProvider({
        handler: createBashReadStateHandler({ targetPath }),
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
          maxTurns: 8,
          workspace: paths.workspace,
        }),
        storageDir: paths.storageDir,
      });

      const result = await app.submitPrompt(buildPrompt({ targetPath }), {
        onEvent: async (event) => events.push(event),
      });

      await assertBashReadStateOutcome({
        events,
        records: provider.records,
        response: result.response,
        SessionEventType: input.modules.SessionEventType,
        targetPath,
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

function buildPrompt({ targetPath }) {
  return [
    "Run the Bash read-state E2E.",
    `First use Bash to run cat ${TARGET_FILE}.`,
    `Then use Edit to replace alpha with gamma in ${targetPath}.`,
    "Then use Bash to run node scripts/overwrite-target.mjs --fix.",
    "When the stale read hint appears, answer with the completion marker only.",
    `Completion marker: ${COMPLETION_MARKER}`,
  ].join("\n");
}

function createBashReadStateHandler({ targetPath }) {
  let requestCount = 0;

  return async ({ body }) => {
    requestCount += 1;
    const requestText = JSON.stringify(body?.messages ?? []);

    if (requestCount === 1) {
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall("call_bash_read_state_cat", "Bash", {
              command: `cat ${TARGET_FILE}`,
              description: "Read target through Bash cat",
            }),
          ],
        }),
      };
    }

    if (requestCount === 2) {
      assertCondition(
        requestText.includes("alpha") && requestText.includes("beta"),
        "expected Bash cat output before Edit",
        { requestText: tailForDiagnostics(requestText) },
      );
      assertCondition(!requestText.includes(NOT_READ_ERROR), "unexpected read guard before Edit", {
        requestText: tailForDiagnostics(requestText),
      });
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall("call_bash_read_state_edit", "Edit", {
              file_path: targetPath,
              old_string: "alpha",
              new_string: "gamma",
            }),
          ],
        }),
      };
    }

    if (requestCount === 3) {
      assertCondition(
        requestText.includes("has been updated successfully"),
        "expected Edit success after Bash cat read-state backfill",
        { requestText: tailForDiagnostics(requestText) },
      );
      assertCondition(!requestText.includes(NOT_READ_ERROR), "Edit should not fail unread guard", {
        requestText: tailForDiagnostics(requestText),
      });
      return {
        body: chatCompletion({
          model: body?.model,
          toolCalls: [
            openAiToolCall("call_bash_read_state_format", "Bash", {
              command: "node scripts/overwrite-target.mjs --fix",
              description: "Rewrite the previously read target file",
            }),
          ],
        }),
      };
    }

    if (requestCount === 4) {
      assertCondition(requestText.includes(STALE_HINT), "expected Bash stale read hint", {
        requestText: tailForDiagnostics(requestText),
      });
      return {
        body: chatCompletion({
          content: COMPLETION_MARKER,
          model: body?.model,
        }),
      };
    }

    return {
      body: chatCompletion({
        content: "BASH_READ_STATE_E2E_UNEXPECTED_EXTRA_REQUEST",
        model: body?.model,
      }),
    };
  };
}

async function assertBashReadStateOutcome(input) {
  const { events, records, response, SessionEventType, targetPath } = input;
  const finalContent = await readFile(targetPath, "utf8");
  const requestContexts = modelRequests(events, SessionEventType).map(stringifyModelRequest);
  const providerRequestTexts = records.map(providerRequestMessageText);
  const allProviderText = providerRequestTexts.join("\n");

  assertCondition(response.includes(COMPLETION_MARKER), `expected ${COMPLETION_MARKER}`, {
    response,
  });
  assertCondition(finalContent === FORMATTED_CONTENT, "expected formatter to rewrite target file", {
    finalContent,
    targetPath,
  });
  assertCondition(
    requestContexts.some((context) => context.includes("alpha") && context.includes("beta")),
    "expected model context to include Bash cat output",
  );
  assertCondition(
    requestContexts.some((context) => context.includes("has been updated successfully")),
    "expected model context to include Edit success",
  );
  assertCondition(allProviderText.includes(STALE_HINT), "expected provider request stale hint", {
    staleHint: STALE_HINT,
  });
  assertCondition(
    !allProviderText.includes(NOT_READ_ERROR),
    "unexpected unread guard in provider traffic",
  );
}

async function writeFormatterScript(workspace) {
  const script = [
    "import { writeFile } from 'node:fs/promises';",
    "await new Promise((resolve) => setTimeout(resolve, 30));",
    `await writeFile(${JSON.stringify(TARGET_FILE)}, ${JSON.stringify(FORMATTED_CONTENT)});`,
    "console.log('formatted target');",
    "",
  ].join("\n");
  await writeFile(join(workspace, "scripts", "overwrite-target.mjs"), script);
}

function providerRequestMessageText(record) {
  try {
    const body = JSON.parse(record.requestBody);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return messages.map((message) => JSON.stringify(message.content ?? "")).join("\n");
  } catch {
    return "";
  }
}

function tailForDiagnostics(text) {
  return text.slice(Math.max(0, text.length - 4_000));
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

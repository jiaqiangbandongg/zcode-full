import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./e2e/helpers/upstream-replay-server.js";
import type { E2ENetworkCaptureArtifact } from "./e2e/helpers/network-capture-proxy.js";

const SSE_EVENT_TEXT = 'event: message_start\ndata: {"type":"message_start"}\n\n';

const activeServers: UpstreamReplayServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Upstream replay server", () => {
  it("closes the listener when the initial artifact write fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-start-failure-"));
    tempDirs.push(tempDir);
    const fixturePath = join(tempDir, "fixture.json");
    const artifactPath = join(tempDir, "artifact.json");
    const port = await reserveLoopbackPort();
    const initialWriteError = new Error("initial-artifact-write-failed");
    let artifactWriteCount = 0;
    await writeFile(fixturePath, JSON.stringify({ fixtures: [], version: 1 }, null, 2), "utf-8");

    await expect(
      startUpstreamReplayServer({
        artifactPath,
        artifactWriter: async () => {
          artifactWriteCount += 1;
          throw initialWriteError;
        },
        fixturePaths: [fixturePath],
        port,
      }),
    ).rejects.toBe(initialWriteError);

    expect(artifactWriteCount).toBe(1);
    await expectLoopbackPortAvailable(port);
  });

  it.runIf(process.platform === "win32")(
    "ends the provider response when a persistently locked artifact cannot be replaced",
    async () => {
      const { artifactPath, server } = await startFixtureServer("end");
      const reader = await open(artifactPath, "r");

      try {
        const response = await fetch(`${server.baseUrl}/messages`, {
          body: JSON.stringify({
            messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(3000),
        });

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toContain("Upstream E2E replay handler failed");
      } finally {
        await reader.close();
      }
    },
  );

  it("expands static fixture variables before matching and replaying", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-replay-vars-"));
    tempDirs.push(tempDir);
    const fixturePath = join(tempDir, "fixture.json");
    const artifactPath = join(tempDir, "artifact.json");
    const runtimeRoot = "C:/e2e-home/ZCodeProject/.zcode-e2e";
    await writeFile(
      fixturePath,
      JSON.stringify(
        {
          fixtures: [
            {
              id: "static-runtime-path",
              match: {
                bodyIncludes: ["Read {{e2eRuntimeRoot}}/shared/readonly.txt"],
                method: "POST",
                pathIncludes: "/messages",
              },
              response: {
                statusCode: 200,
                toolUse: {
                  id: "toolu_static_runtime_path",
                  input: {
                    file_path: "{{e2eRuntimeRoot}}/shared/readonly.txt",
                  },
                  name: "Read",
                },
              },
            },
          ],
          version: 1,
        },
        null,
        2,
      ),
    );
    const server = await startUpstreamReplayServer({
      artifactPath,
      fixturePaths: [fixturePath],
      fixtureVariables: { e2eRuntimeRoot: runtimeRoot },
    });
    activeServers.push(server);

    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          {
            content: `Read ${runtimeRoot}/shared/readonly.txt`,
            role: "user",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain(`\\"file_path\\":\\"${runtimeRoot}/shared/readonly.txt\\"`);
    expect(responseText).not.toContain("{{e2eRuntimeRoot}}");
  });

  it.each([
    {
      output:
        "Command running in background with ID: bash_first. Output is being written to: /tmp/first.log.\nCommand running in background with ID: bash_last. Output is being written to: /tmp/last.log.",
      expected: "bash_last",
    },
    { output: "agentId: agent_other", expected: "{{latestBashTaskId}}" },
  ])(
    "resolves Bash task IDs from actual launch results: $expected",
    async ({ output, expected }) => {
      const tempDir = await mkdtemp(join(tmpdir(), "zcode-bash-task-replay-"));
      tempDirs.push(tempDir);
      const fixturePath = join(tempDir, "fixture.json");
      await writeFile(
        fixturePath,
        JSON.stringify({
          version: 1,
          fixtures: [
            {
              id: "bash-task-output",
              match: { method: "POST", pathIncludes: "/messages" },
              response: {
                statusCode: 200,
                toolUse: {
                  id: "toolu_bash_task_output",
                  name: "TaskOutput",
                  input: { task_id: "{{latestBashTaskId}}", block: false },
                },
              },
            },
          ],
        }),
      );
      const server = await startUpstreamReplayServer({
        fixturePaths: [fixturePath],
        artifactPath: join(tempDir, "artifact.json"),
      });
      activeServers.push(server);
      const response = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_bash_launch",
                  content: output,
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`\\"task_id\\":\\"${expected}\\"`);
    },
  );

  it("records normal SSE EOF as complete end", async () => {
    const { artifactPath, server } = await startFixtureServer("end");

    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });

    await expect(response.text()).resolves.toBe(SSE_EVENT_TEXT);

    await server.stop();
    activeServers.pop();

    const record = (await readArtifact(artifactPath)).records[0];
    expect(record?.status).toBe("complete");
    expect(record?.replay).toEqual({
      closeMode: "end",
      fixtureId: "sse-close-mode-end",
    });
    expect(record?.responseEvents).toHaveLength(1);
  });

  it("destroys SSE response streams when closeMode is destroy", async () => {
    const { artifactPath, server } = await startFixtureServer("destroy");

    let fetchFailed = false;
    try {
      const response = await fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      await response.text();
    } catch {
      fetchFailed = true;
    }

    await server.stop();
    activeServers.pop();

    const record = (await readArtifact(artifactPath)).records[0];
    expect(fetchFailed).toBe(true);
    expect(record?.status).toBe("error");
    expect(record?.error).toBe("Replay fixture destroyed SSE response stream");
    expect(record?.replay).toEqual({
      closeMode: "destroy",
      fixtureId: "sse-close-mode-destroy",
    });
    expect(record?.responseEvents).toHaveLength(1);
  });

  it("injects a loopback Browser fixture URL without trailing punctuation", async () => {
    const server = await startBrowserVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              "BROWSER_VARIABLE_PROBE E2E_BROWSER_FIXTURE_URL:http://127.0.0.1:43123/basic),",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("http://127.0.0.1:43123/basic");
    expect(body).not.toContain("{{browserFixtureUrl}}");
    expect(body).not.toContain("/basic),");
  });

  it("injects the latest automation id from a CronList tool result", async () => {
    const server = await startAutomationVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          { role: "user", content: "AUTOMATION_VARIABLE_PROBE" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_cron_list",
                content: JSON.stringify({
                  automations: [{ automationId: "automation-runtime-123" }],
                }),
              },
            ],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("automation-runtime-123");
    expect(body).not.toContain("{{latestAutomationId}}");
  });

  it("injects Browser stable tab ids from the latest tool result", async () => {
    const server = await startBrowserTabVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          { role: "user", content: "BROWSER_TAB_VARIABLE_PROBE" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_tabs_stale",
                content:
                  '=> {"e2eBrowserTabId":"tab-single-stale","e2eBrowserTabAId":"tab-a-stale","e2eBrowserTabBId":"tab-b-stale"}\n\nStructured content:\n',
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_tabs_list",
                content:
                  '=> {\n  "e2eBrowserTabAId": "tab-a-runtime",\n  "e2eBrowserTabBId": "tab-b-runtime",\n  "e2eBrowserTabId": "tab-single-runtime"\n}\n\nStructured content:\n',
              },
            ],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("tab-single-runtime");
    expect(body).toContain("tab-a-runtime");
    expect(body).toContain("tab-b-runtime");
    expect(body).not.toContain("{{latestBrowserTabId}}");
    expect(body).not.toContain("{{latestBrowserTabAId}}");
    expect(body).not.toContain("{{latestBrowserTabBId}}");
    expect(body).not.toContain("stale");
  });

  it("fails closed when the Browser fixture URL marker is not loopback", async () => {
    const server = await startBrowserVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: "BROWSER_VARIABLE_PROBE E2E_BROWSER_FIXTURE_URL:https://example.com/basic",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      "Missing E2E_BROWSER_FIXTURE_URL replay variable",
    );
  });

  it("contains a missing Browser fixture variable artifact failure in the request handler", async () => {
    let artifactWriteCount = 0;
    let failedMissingVariableArtifact = false;
    const unhandledRejections: unknown[] = [];
    const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const server = await startBrowserVariableFixtureServer({
        artifactWriter: async (path, value) => {
          artifactWriteCount += 1;
          const artifact = value as E2ENetworkCaptureArtifact;
          const containsMissingVariableResponse = artifact.records.some(
            (record) =>
              record.status === "complete" &&
              record.statusCode === 500 &&
              record.responseTextPreview?.includes(
                "Missing E2E_BROWSER_FIXTURE_URL replay variable",
              ),
          );
          if (containsMissingVariableResponse && !failedMissingVariableArtifact) {
            failedMissingVariableArtifact = true;
            throw new Error("missing-variable-artifact-write-failed");
          }
          await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
        },
      });
      const response = await fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          messages: [{ role: "user", content: "BROWSER_VARIABLE_PROBE" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(
        "Missing E2E_BROWSER_FIXTURE_URL replay variable",
      );
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

      expect(artifactWriteCount).toBeGreaterThanOrEqual(4);
      expect(failedMissingVariableArtifact).toBe(true);
      expect(unhandledRejections).toEqual([]);
      expect(handlerWarning).toHaveBeenCalledWith(
        expect.stringContaining("missing-variable-artifact-write-failed"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      handlerWarning.mockRestore();
    }
  });

  it("matches the latest tool_result instead of a success marker inside tool code", async () => {
    const server = await startLatestToolResultFixtureServer();
    const request = (toolResult: string) =>
      fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  input: { code: "return 'E2E_TOOL_RESULT_OK'" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  content: toolResult,
                },
              ],
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const failedResult = await request("E2E_TOOL_RESULT_FAILED");
    expect(failedResult.status).toBe(500);
    await expect(failedResult.text()).resolves.toContain("Missing Upstream e2e fixture");

    const successfulResult = await request("E2E_TOOL_RESULT_OK");
    expect(successfulResult.status).toBe(200);
    await expect(successfulResult.text()).resolves.toContain("tool result matched");
  });

  it("matches the background prompt when task-notification only appears in tool schema", async () => {
    const server = await startBackgroundFixtureServer();
    const response = await requestBackgroundDirectPrompt(
      server,
      "E2E_BACKGROUND_DIRECT_USER_PROMPT: send immediately. Payload: E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD.",
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("background-direct-user-prompt-received-ok");
  });

  it("rejects the background prompt when task-notification is in the latest user message", async () => {
    const server = await startBackgroundFixtureServer();
    const response = await requestBackgroundDirectPrompt(
      server,
      "<task-notification>completed</task-notification> E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD",
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("Missing Upstream e2e fixture");
  });
});

async function startFixtureServer(closeMode: "end" | "destroy") {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-replay-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: `sse-close-mode-${closeMode}`,
            match: {
              bodyIncludes: ["SSE_CLOSE_MODE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              closeMode,
              events: [
                {
                  byteLength: Buffer.byteLength(SSE_EVENT_TEXT, "utf-8"),
                  offsetMs: 0,
                  sequence: 0,
                  text: SSE_EVENT_TEXT,
                },
              ],
              headers: { "content-type": "text/event-stream; charset=utf-8" },
              statusCode: 200,
              statusMessage: "OK",
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return { artifactPath, server };
}

async function startBrowserVariableFixtureServer(
  options: {
    artifactWriter?: Parameters<typeof startUpstreamReplayServer>[0]["artifactWriter"];
  } = {},
) {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-browser-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "browser-variable",
            match: {
              bodyIncludes: ["BROWSER_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_browser_variable",
                input: {
                  code: "await tab.goto('{{browserFixtureUrl}}')",
                  title: "打开测试页面",
                },
                name: "mcp__node_repl__js",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
    ...(options.artifactWriter ? { artifactWriter: options.artifactWriter } : {}),
  });
  activeServers.push(server);
  return server;
}

async function startAutomationVariableFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-automation-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "automation-variable",
            match: {
              bodyIncludes: ["AUTOMATION_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_automation_variable",
                input: { id: "{{latestAutomationId}}", title: "updated" },
                name: "CronUpdate",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startBrowserTabVariableFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-browser-tab-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "browser-tab-variable",
            match: {
              bodyIncludes: ["BROWSER_TAB_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_browser_tab_variable",
                input: {
                  code: [
                    "const browser = await agent.browsers.get('iab');",
                    "const tab = await browser.tabs.get('{{latestBrowserTabId}}');",
                    "const tabA = await browser.tabs.get('{{latestBrowserTabAId}}');",
                    "const tabB = await browser.tabs.get('{{latestBrowserTabBId}}');",
                  ].join("\n"),
                  title: "恢复 Browser tab",
                },
                name: "mcp__node_repl__js",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startLatestToolResultFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-tool-result-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "latest-tool-result",
            match: {
              lastUserMessageIncludes: ["E2E_TOOL_RESULT_OK"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: { statusCode: 200, text: "tool result matched" },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startBackgroundFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-background-fixture-"));
  tempDirs.push(tempDir);
  const artifactPath = join(tempDir, "artifact.json");
  const fixturePath = join(
    import.meta.dirname,
    "e2e/fixtures/upstream/conversation-session/conversation-session-background.json",
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

function requestBackgroundDirectPrompt(server: UpstreamReplayServer, latestUserText: string) {
  // Bug 根因：TaskOutput 的 provider schema 自身包含 notification 标签；
  // 是否已注入通知必须只看最新 user message，不能扫描整个请求体。
  return fetch(`${server.baseUrl}/messages`, {
    body: JSON.stringify({
      messages: [{ role: "user", content: latestUserText }],
      tools: [
        {
          description: "Background tasks receive a <task-notification> when the task completes.",
          name: "TaskOutput",
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function readArtifact(path: string): Promise<E2ENetworkCaptureArtifact> {
  return JSON.parse(await readFile(path, "utf-8")) as E2ENetworkCaptureArtifact;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await listenOnLoopback(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNetServer(server);
    throw new Error("Temporary port server did not expose an address");
  }
  await closeNetServer(server);
  return address.port;
}

async function expectLoopbackPortAvailable(port: number): Promise<void> {
  const server = createNetServer();
  try {
    await listenOnLoopback(server, port);
  } finally {
    if (server.listening) {
      await closeNetServer(server);
    }
  }
}

function listenOnLoopback(server: NetServer, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

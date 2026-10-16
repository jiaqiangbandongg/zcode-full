import { describe, expect, it, vi } from "vitest";
import type { BrowserCommandResult, SessionId, TurnId } from "@zcode/contracts";
import {
  consumeBrowserTurnState,
  recordBrowserTurnPageActivity,
  recordBrowserTurnToolResult,
} from "../src/repl/browser-turn-state.js";
import { appendBrowserTurnScreenshot } from "../src/runtime/methods/browser-turn-screenshot.js";
import { MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES } from "../src/tool/executor/result-display.js";

const sessionId = "session-browser-shot" as SessionId;
const turnId = "turn-browser-shot" as TurnId;
const meta = {
  browserUse: true as const,
  backendType: "iab" as const,
  browserId: "iab-1",
  browserGeneration: 2,
  openTabIds: ["tab-1"],
  tabId: "tab-1",
  currentUrl: "https://example.com",
};

function setupRuntime(
  execute: ReturnType<typeof vi.fn>,
  options: {
    imageProcessorPort?: { prepareForModel: ReturnType<typeof vi.fn> };
    turnId?: TurnId;
  } = {},
) {
  const events: Array<{ type: string; payload: unknown }> = [];
  const persistPart = vi.fn(async () => undefined);
  const runtime = {
    appendEvent: vi.fn(async () => undefined),
    browserControlPort: { execute },
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    logger: { debug: vi.fn(), warn: vi.fn() },
    persistPart,
    sessionId,
    imageProcessorPort: options.imageProcessorPort,
  };
  const state = {
    events,
    turnAbortSignal: new AbortController().signal,
    turnId: options.turnId ?? turnId,
    turnTraceContext: { traceId: "trace-1", turnId: options.turnId ?? turnId },
  };
  return { events, persistPart, runtime, state };
}

describe("browser turn screenshot", () => {
  it("records the MCP child browser marker when the same result emitted an image", () => {
    recordBrowserTurnToolResult({
      output: {
        _meta: {
          "zcode/nodeReplEmittedImage": true,
          "zcode/browserTurnScreenshot": {
            browserGeneration: 2,
            browserId: "iab-1",
            tabId: "tab-1",
          },
        },
      },
      sessionId,
      toolName: "mcp__node_repl__js",
      turnId,
    });

    expect(consumeBrowserTurnState(sessionId, turnId)).toEqual({
      candidate: { browserGeneration: 2, browserId: "iab-1" },
    });
  });

  it("persists an active-tab screenshot as a display-only turn-tail part", async () => {
    recordBrowserTurnPageActivity({ meta, sessionId, turnId });
    const execute = vi.fn(async (input: { command: { method: string } }) => {
      if (input.command.method === "list") {
        return {
          ok: true,
          tabs: [
            {
              tabId: "tab-1",
              url: "https://example.com",
              title: "Example",
              active: true,
              viewport: { width: 1280, height: 720 },
            },
          ],
          elapsedMs: 1,
        } satisfies BrowserCommandResult;
      }
      return {
        ok: true,
        image: { base64: "AAAA", mimeType: "image/png" },
        elapsedMs: 1,
      } satisfies BrowserCommandResult;
    });
    const { events, persistPart, runtime, state } = setupRuntime(execute);

    await appendBrowserTurnScreenshot(runtime as never, state as never, "message-1" as never);

    expect(execute.mock.calls.map(([input]) => input.command)).toEqual([
      { method: "list" },
      { method: "screenshot", tabId: "tab-1" },
    ]);
    expect(persistPart).toHaveBeenCalledWith(
      expect.objectContaining({
        messageID: "message-1",
        state: expect.objectContaining({
          metadata: expect.objectContaining({
            display: expect.objectContaining({
              kind: "node_repl_images",
              source: "browser_turn_end",
            }),
          }),
        }),
      }),
      state.turnTraceContext,
    );
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_scheduled",
      "tool_call_started",
      "tool_call_result",
    ]);
  });

  it("captures the turn-tail screenshot when this turn already emitted an image", async () => {
    recordBrowserTurnToolResult({
      output: {
        _meta: {
          "zcode/nodeReplEmittedImage": true,
          "zcode/browserTurnScreenshot": {
            browserGeneration: 2,
            browserId: "iab-1",
            tabId: "tab-1",
          },
        },
      },
      sessionId,
      toolName: "mcp__node_repl__js",
      turnId,
    });
    const execute = vi.fn(async (input: { command: { method: string } }) =>
      input.command.method === "list"
        ? ({
            ok: true,
            tabs: [
              {
                tabId: "tab-1",
                url: "https://example.com",
                title: "Example",
                active: true,
                viewport: { width: 1280, height: 720 },
              },
            ],
            elapsedMs: 1,
          } satisfies BrowserCommandResult)
        : ({
            ok: true,
            image: { base64: "AAAA", mimeType: "image/png" },
            elapsedMs: 1,
          } satisfies BrowserCommandResult),
    );
    const { persistPart, runtime, state } = setupRuntime(execute);

    await appendBrowserTurnScreenshot(runtime as never, state as never, "message-1" as never);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(persistPart).toHaveBeenCalledOnce();
  });

  it("silently keeps the completed turn when no active tab exists", async () => {
    recordBrowserTurnPageActivity({ meta, sessionId, turnId });
    const execute = vi.fn(async () => ({ ok: true, tabs: [], elapsedMs: 1 }));
    const { persistPart, runtime, state } = setupRuntime(execute);

    await appendBrowserTurnScreenshot(runtime as never, state as never, "message-1" as never);

    expect(persistPart).not.toHaveBeenCalled();
    expect(runtime.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("no active tab"),
      expect.objectContaining({
        event: "browser.turn_screenshot.skipped_no_active_tab",
      }),
    );
  });

  it("compresses an oversized screenshot before creating the persisted display", async () => {
    recordBrowserTurnPageActivity({ meta, sessionId, turnId });
    const oversizedBase64 = "A".repeat(MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES + 4);
    const execute = vi.fn(async (input: { command: { method: string } }) =>
      input.command.method === "list"
        ? ({
            ok: true,
            tabs: [
              {
                tabId: "tab-1",
                url: "https://example.com",
                title: "Example",
                active: true,
                viewport: { width: 1280, height: 720 },
              },
            ],
            elapsedMs: 1,
          } satisfies BrowserCommandResult)
        : ({
            ok: true,
            image: { base64: oversizedBase64, mimeType: "image/png" },
            elapsedMs: 1,
          } satisfies BrowserCommandResult),
    );
    const prepareForModel = vi.fn(async () => ({
      data: Buffer.from("compressed-image"),
      mediaType: "image/webp",
      resized: true,
      transformedSizeBytes: 16,
    }));
    const { persistPart, runtime, state } = setupRuntime(execute, {
      imageProcessorPort: { prepareForModel },
    });

    await appendBrowserTurnScreenshot(runtime as never, state as never, "message-1" as never);

    expect(prepareForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBase64Bytes: MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES,
        maxDimension: 2048,
        mediaType: "image/png",
      }),
      { signal: state.turnAbortSignal },
    );
    expect(persistPart).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          metadata: expect.objectContaining({
            display: expect.objectContaining({
              images: [
                {
                  base64: Buffer.from("compressed-image").toString("base64"),
                  mimeType: "image/webp",
                },
              ],
            }),
          }),
        }),
      }),
      state.turnTraceContext,
    );
  });

  it("captures independently for consecutive turns in the same session", async () => {
    const secondTurnId = "turn-browser-shot-2" as TurnId;
    recordBrowserTurnPageActivity({ meta, sessionId, turnId });
    recordBrowserTurnPageActivity({ meta, sessionId, turnId: secondTurnId });
    const execute = vi.fn(async (input: { command: { method: string } }) =>
      input.command.method === "list"
        ? ({
            ok: true,
            tabs: [
              {
                tabId: "tab-1",
                url: "https://example.com",
                title: "Example",
                active: true,
                viewport: { width: 1280, height: 720 },
              },
            ],
            elapsedMs: 1,
          } satisfies BrowserCommandResult)
        : ({
            ok: true,
            image: { base64: "AAAA", mimeType: "image/png" },
            elapsedMs: 1,
          } satisfies BrowserCommandResult),
    );
    const first = setupRuntime(execute, { turnId });
    const second = setupRuntime(execute, { turnId: secondTurnId });

    await appendBrowserTurnScreenshot(
      first.runtime as never,
      first.state as never,
      "message-1" as never,
    );
    await appendBrowserTurnScreenshot(
      second.runtime as never,
      second.state as never,
      "message-2" as never,
    );

    expect(first.persistPart).toHaveBeenCalledOnce();
    expect(second.persistPart).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(4);
  });
});

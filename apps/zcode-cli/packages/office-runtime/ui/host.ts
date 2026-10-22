import { readWindowState, writeWindowState, type WindowState } from "#ui/windowStorage.ts";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { PLUGIN_VERSION, SERVER_NAME } from "#office/contract.ts";
import { CAPTURE_EXAMPLES, TITLE } from "#office/wording.ts";

type ListHandler = NonNullable<App["onlisttools"]>;
type CallHandler = NonNullable<App["oncalltool"]>;
type ListToolsResult = Awaited<ReturnType<ListHandler>>;
export type ToolDefinition = ListToolsResult["tools"][number];
export type CallToolResult = Awaited<ReturnType<CallHandler>>;

export type PageToolHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<CallToolResult>;

/**
 * Tools the page exposes to the model while it is open (MCP Apps app-provided tools). The
 * definitions are static so the host sees them at the handshake; the UI bundle binds handlers later.
 */
export const PAGE_TOOLS: ToolDefinition[] = [
  {
    name: "capture_view",
    title: `Capture ${TITLE} view`,
    description: `Take a picture of a rendered document location in the ${TITLE} panel so you can see layout, charts, images and formatting that text extraction misses. Pass an anchor such as ${CAPTURE_EXAMPLES} (the document must be open in the panel; call open_document first), or omit it to capture what the user currently sees.`,
    inputSchema: {
      type: "object",
      properties: {
        anchor: {
          type: "string",
          maxLength: 1200,
          description: "Location to capture; defaults to the visible view.",
        },
        maxWidth: {
          type: "integer",
          minimum: 320,
          maximum: 2000,
          description: "Maximum image width in pixels (default 1600).",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];

type ToolResult = Parameters<NonNullable<App["ontoolresult"]>>[0];

/**
 * One App connection per page. The bootstrap loader creates it before the UI bundle exists, so it
 * keeps every tool result and the page tools are registered through a late-bound table.
 */
function createHost() {
  const pageId = crypto.randomUUID();
  const currentViewId = () =>
    (
      app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined
    )?.stateKey ?? pageId;
  const app = new App(
    { name: SERVER_NAME, version: PLUGIN_VERSION },
    { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  const results: ToolResult[] = [];
  const handlers = new Map<string, PageToolHandler>();
  const waiters = new Set<() => void>();
  let connection: Promise<void> | undefined;
  const emit = (name: string) => void window.dispatchEvent(new Event(`office:${name}`));

  // Handlers are installed before connect so nothing sent during the handshake is lost.
  app.ontoolresult = (result) => {
    results.push(result);
    if (results.length > 20) results.shift();
    emit("toolresult");
  };
  app.onhostcontextchanged = () => emit("hostchange");
  app.onlisttools = async (): Promise<ListToolsResult> => ({ tools: PAGE_TOOLS });
  app.oncalltool = async (params, extra) => {
    if (!PAGE_TOOLS.some((tool) => tool.name === params.name))
      return {
        isError: true,
        content: [{ type: "text", text: `The ${TITLE} page has no tool ${params.name}.` }],
      };
    try {
      // The UI bundle may still be loading when the first call arrives.
      const deadline = Date.now() + 20_000;
      while (!handlers.has(params.name) && Date.now() < deadline)
        await new Promise<void>((resolve) => {
          const done = () => (waiters.delete(done), resolve());
          waiters.add(done);
          setTimeout(done, 500);
        });
      const handler = handlers.get(params.name);
      if (!handler) throw new Error(`The ${TITLE} panel is still loading; try again in a moment.`);
      const scoped = extra as { mcpReq?: { signal?: AbortSignal }; signal?: AbortSignal };
      return await handler(params.arguments ?? {}, scoped.mcpReq?.signal ?? scoped.signal);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };

  window.addEventListener("pagehide", () => {
    void app
      .callServerTool({ name: "release_view", arguments: { viewId: currentViewId() } })
      .catch(() => undefined);
  });

  const ready = () =>
    (connection ??= app
      .connect(new PostMessageTransport(window.parent, window.parent))
      .then(() => emit("hostchange")));

  return {
    app,
    get viewId() {
      return currentViewId();
    },
    ready,
    readWindow(): WindowState {
      const surface = app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined;
      if (!surface?.stateKey) return {};
      try {
        return readWindowState(localStorage, surface.stateKey);
      } catch {
        return {};
      }
    },
    saveWindow(patch: WindowState): void {
      const surface = app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined;
      if (!surface?.stateKey) return;
      try {
        writeWindowState(localStorage, surface.stateKey, patch);
      } catch {
        /* 存储不可用仍可预览。 */
      }
    },
    readDocument(): string | null {
      return this.readWindow().path ?? null;
    },
    saveDocument(path: string): void {
      this.saveWindow({ path });
    },
    /** Tool results received so far (oldest first); the UI drains them on mount. */
    takeResults: () => results.splice(0, results.length),
    handleTool(name: string, handler: PageToolHandler) {
      handlers.set(name, handler);
      for (const wake of waiters) wake();
    },
    get context() {
      return app.getHostContext();
    },
    get capabilities() {
      return app.getHostCapabilities();
    },
  };
}

export type Host = ReturnType<typeof createHost>;

declare global {
  interface Window {
    __officeHost?: Host;
  }
}

/** The loader page and the UI bundle share this instance; never connect twice. */
export function getHost(): Host {
  return (window.__officeHost ??= createHost());
}

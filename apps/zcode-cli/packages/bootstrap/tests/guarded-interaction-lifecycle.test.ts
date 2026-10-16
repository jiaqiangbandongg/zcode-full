import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  createSessionId,
  createToolCallId,
  SessionEventType,
  type ExecutionRequest,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import { zcodePermissionResponseSchema } from "@zcode/shared";
import {
  createToolExecutor,
  createToolRegistry,
  registerBuiltInTools,
  PermissionService,
} from "@zcode/core";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { createProtocolInteractionBroker } from "../src/zcode-protocol/interaction-broker.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

const QUESTION = "Which color?";
const questionInput = {
  questions: [
    {
      header: "Color",
      question: QUESTION,
      options: [
        { label: "Blue", description: "Use blue" },
        { label: "Red", description: "Use red" },
      ],
    },
  ],
};

function harness(
  options: {
    onVisible?: (id: string, registry: V4InteractionRegistry) => void;
    clientError?: number;
    clientResponse?: () => PermissionBrokerResult;
  } = {},
) {
  const sessionId = createSessionId("guarded-wire");
  const interactions = new V4InteractionRegistry();
  const projection = new ProductProjection(sessionId, "epoch");
  const events: SessionEvent[] = [];
  const requests: Array<{ requestId: string; toolName: string }> = [];
  const execution = vi.fn(async (_request: ExecutionRequest) => ({
    status: "completed" as const,
    exitCode: 0,
    stdout: { text: "controlled execution", bytes: 20, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(),
    completedAt: new Date(),
  }));
  const registry = createToolRegistry();
  registerBuiltInTools(registry);
  const saveProjectPermission = vi.fn();
  const context = {
    v4Interactions: interactions,
    // 真正的 broker 在问答登记前读取持久化元数据；测试保留这个异步边界。
    deps: { sessionStore: { sessionEntries: async () => [] } },
    requestClient: (
      _method: string,
      request: { requestId: string; toolName: string },
      _schema: unknown,
      callOptions: { signal?: AbortSignal },
    ) => {
      requests.push(request);
      if (options.clientError)
        return Promise.reject(new ProtocolRequestError(options.clientError, "protocol failure"));
      if (options.clientResponse)
        return Promise.resolve(zcodePermissionResponseSchema.parse(options.clientResponse()));
      return new Promise((_, reject) => {
        const abort = () => reject(new ProtocolRequestError(-32021, "client request cancelled"));
        if (callOptions.signal?.aborted) abort();
        else callOptions.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const executor = createToolExecutor({
    mode: "guarded",
    workingDirectory: process.cwd(),
    sessionId,
    registry,
    permissionService: new PermissionService(),
    bashShellSelection: { dialect: "posix", source: "auto-detected", display: { name: "bash" } },
    executionPort: { run: execution },
    permissionBroker: createProtocolInteractionBroker(context),
    sessionStore: {
      getSession: async () => ({ projectID: "fixture-project" }),
      getProjectPermission: async () => ({ allow: [{ toolName: "Bash" }] }),
      saveProjectPermission,
    } as never,
    emitEvent: async (event) => {
      events.push(event);
      projection.applyEvent({ ...event, sequenceNumber: events.length } as SessionEvent);
      if (event.type === SessionEventType.PermissionRequested)
        options.onVisible?.(event.payload.requestId!, interactions);
    },
  });
  const commands = new V4CommandExecutor({ getRecord: () => undefined, interactions });
  const answer = (
    id: string,
    value: {
      optionId?: string;
      freeText?: string;
      action?: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    },
  ) =>
    commands.execute({
      type: "resolveInteraction",
      payload: { interactionId: id, answer: value },
      sessionId,
      commandId: crypto.randomUUID(),
      clientId: "client",
      issuedAt: Date.now(),
    });
  const run = (
    name = "Bash",
    input: unknown = { command: "rm -rf fixture" },
    signal?: AbortSignal,
  ) => executor.execute({ id: createToolCallId("guarded-wire-tool"), name, input }, { signal });
  return {
    run,
    answer,
    interactions,
    projection,
    events,
    requests,
    execution,
    saveProjectPermission,
  };
}

afterEach(() => vi.useRealTimers());

describe("Guarded real executor → protocol broker → V4 command → result", () => {
  it.each(["allow", "modify"] as const)(
    "a client %s with modified input closes one request and executes the approved command",
    async (decision) => {
      const command = "git reset --hard";
      let responses = 0;
      const h = harness({
        clientResponse: () =>
          ++responses === 1
            ? { decision, modifiedInput: { command } }
            : { decision: "deny", reason: "Unexpected reapproval" },
      });
      const result = await h.run();
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.modelContent).toContain("controlled execution");
      expect(h.requests).toHaveLength(1);
      expect(h.execution).toHaveBeenCalledTimes(1);
      expect(h.execution.mock.calls[0]?.[0]).toMatchObject({ command: { mode: "shell", command } });
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(1);
      expect(
        h.events.filter((event) => event.type === SessionEventType.ToolCallResult),
      ).toHaveLength(1);
      expect(h.interactions.has(h.requests[0]!.requestId)).toBe(false);
      expect(h.projection.getSnapshot().pendingInteractions).toEqual([]);
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
    },
  );

  it("cancellation during a broker-approved edit still prevents execution", async () => {
    const controller = new AbortController();
    const h = harness({
      clientResponse: () => {
        controller.abort();
        return { decision: "modify", modifiedInput: { command: "git reset --hard" } };
      },
    });
    const result = await h.run("Bash", { command: "rm -rf fixture" }, controller.signal);
    expect(result.error?.type).toBe(CoreErrorType.ToolCancelled);
    expect(h.requests).toHaveLength(1);
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.interactions.has(h.requests[0]!.requestId)).toBe(false);
    expect(h.projection.getSnapshot().pendingInteractions).toEqual([]);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });

  it.each(["Blue", "Custom teal", ""])(
    "an immediate AskUserQuestion answer is delivered exactly once: %s",
    async (answer) => {
      const h = harness({
        onVisible: (id, registry) => {
          expect(registry.has(id)).toBe(true);
          expect(
            registry.resolve(id, {
              action: "accept",
              content: { answers: answer ? { [QUESTION]: answer } : {} },
            }),
          ).toBe(true);
        },
      });
      const result = await h.run("AskUserQuestion", questionInput);
      expect(result.success).toBe(true);
      expect(result.modelContent).toContain(answer || "The user did not provide answers");
      expect(h.requests).toHaveLength(1);
      expect(
        h.events.filter((event) => event.type === SessionEventType.ToolCallResult),
      ).toHaveLength(1);
      expect(h.projection.getSnapshot().pendingInteractions).toEqual([]);
    },
  );

  it.each(["allowOnce", "deny", "allowAlways"])(
    "finishes %s through the real command registry, rejecting duplicates",
    async (optionId) => {
      const h = harness();
      const pending = h.run();
      await vi.waitFor(() =>
        expect(h.projection.getSnapshot().pendingInteractions).toHaveLength(1),
      );
      const id = h.requests[0]!.requestId;
      expect(h.execution).not.toHaveBeenCalled();
      await h.answer(id, { optionId, freeText: "Keep files" });
      await h.answer(id, { optionId: "allowOnce" });
      const result = await pending;
      expect(result.success, JSON.stringify(result)).toBe(optionId === "allowOnce");
      if (optionId !== "allowOnce")
        expect(result.modelContent ?? result.error?.message).toContain("Keep files");
      expect(h.execution).toHaveBeenCalledTimes(optionId === "allowOnce" ? 1 : 0);
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
      expect(h.interactions.has(id)).toBe(false);
      expect(h.projection.getSnapshot().pendingInteractions).toEqual([]);
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(1);
    },
  );

  it("no human response does not activate the AskUserQuestion automatic-answer timer", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.run();
    await vi.advanceTimersByTimeAsync(600_000);
    const id = h.requests[0]!.requestId;
    expect(h.interactions.has(id)).toBe(true);
    expect(h.projection.getSnapshot().pendingInteractions).toHaveLength(1);
    expect(h.execution).not.toHaveBeenCalled();
    await h.answer(id, { optionId: "deny" });
    expect((await pending).success).toBe(false);
    expect(h.interactions.has(id)).toBe(false);
  });

  it.each([
    [-32021, CoreErrorType.ToolCancelled],
    [-32022, CoreErrorType.PermissionTimeout],
    [-32020, CoreErrorType.ConfigurationError],
  ] as const)(
    "preserves the failure category for protocol code %s",
    async (clientError, errorType) => {
      const h = harness({ clientError });
      const result = await h.run();
      expect(result.error?.type).toBe(errorType);
      expect(h.execution).not.toHaveBeenCalled();
      expect(h.projection.getSnapshot().pendingInteractions).toEqual([]);
    },
  );

  it("cancellation racing with approval still prevents execution", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.run("Bash", { command: "rm -rf fixture" }, controller.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const id = h.requests[0]!.requestId;
    const response = h.answer(id, { optionId: "allowOnce" });
    controller.abort();
    await response;
    expect((await pending).error?.type).toBe(CoreErrorType.ToolCancelled);
    expect(h.execution).not.toHaveBeenCalled();
    expect(h.interactions.has(id)).toBe(false);
  });
});

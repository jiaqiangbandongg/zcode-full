import { describe, expect, it } from "vitest";
import type { Logger } from "@zcode/contracts";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import {
  activateSessionForResume,
  listSessionSubagents,
  readSession,
} from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";

interface RecordedLog {
  context?: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

function createRecordingLogger(logs: RecordedLog[]): Logger {
  const logger = {
    child: () => logger,
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "debug", message, context }),
    error: (message: string, _error?: Error, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
  } as Logger;
  return logger;
}

function contextWithLogger(
  logger: Logger,
  overrides: Record<string, unknown> = {},
): ZCodeProtocolAgentServerContext {
  return {
    deps: {},
    sessions: new Map(),
    logger,
    ...overrides,
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("session lifecycle diagnostics", () => {
  it("records the active-runtime miss before readSession reports Session is not active", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs));

    await expect(
      readSession(context, {
        deliveryKind: "desktop-continuous",
        sessionId: "sess_missing",
      }),
    ).rejects.toThrow("Session is not active: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.require_missing",
          deliveryKind: "desktop-continuous",
          operation: "session_read",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records the persisted-session miss when cold resume cannot find the id", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });

    await expect(activateSessionForResume(context, { sessionId: "sess_missing" })).rejects.toThrow(
      "Session not found: sess_missing",
    );

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.resume_persisted_missing",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records the durable parent miss that surfaces through v4 hydration", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });

    await expect(
      listSessionSubagents(context, { sessionId: "sess_missing", endedLimit: 1 }),
    ).rejects.toThrow("Session not found: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.persisted_missing",
          operation: "session_subagents",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("includes the session and phase when the gateway hydration source fails", async () => {
    const errors: Array<{
      context?: Record<string, unknown>;
      error: unknown;
      scope: string;
    }> = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      executeCommand: async () => undefined,
      emitWireFrame: () => undefined,
      loadPersistedEvents: async () => {
        throw new Error("Session not found: sess_missing");
      },
      onError: (scope, error, context) => errors.push({ scope, error, context }),
    });

    await gateway.subscribe({
      topic: conversationTopic("sess_missing"),
      connectionId: "conn-test",
      clientMode: "desktop-continuous",
    });

    expect(errors).toContainEqual(
      expect.objectContaining({
        scope: "v4.hydrate",
        context: expect.objectContaining({
          phase: "loadPersistedEvents",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records a missing persisted session before v4 cold resume returns notFound", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });
    const gateway = createConversationV4Gateway(context);

    await expect(
      gateway.subscribe({
        topic: conversationTopic("sess_missing"),
        connectionId: "conn-test",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("Session is not active and not persisted: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.v4.resume_persisted_missing",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("includes the session and phase when cold resume itself fails", async () => {
    const errors: Array<{
      context?: Record<string, unknown>;
      error: unknown;
      scope: string;
    }> = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => false,
      executeCommand: async () => undefined,
      emitWireFrame: () => undefined,
      resumePersistedSession: async () => {
        throw new Error("activation failed");
      },
      onError: (scope, error, context) => errors.push({ scope, error, context }),
    });

    await expect(
      gateway.subscribe({
        topic: conversationTopic("sess_resume_failed"),
        connectionId: "conn-test",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("Failed to resume persisted session sess_resume_failed");

    expect(errors).toContainEqual(
      expect.objectContaining({
        scope: "v4.subscribe.resume",
        context: expect.objectContaining({
          phase: "resumePersistedSession",
          sessionId: "sess_resume_failed",
        }),
      }),
    );
  });
});

import type { BrowserResponseMeta, SessionId, TurnId } from "@zcode/contracts";

export interface BrowserTurnScreenshotCandidate {
  browserGeneration: number;
  browserId: string;
}

interface BrowserTurnState {
  candidate?: BrowserTurnScreenshotCandidate;
}

const states = new Map<string, BrowserTurnState>();

function stateKey(sessionId: SessionId, turnId: TurnId): string {
  return `${sessionId}:${turnId}`;
}

function readState(sessionId: SessionId, turnId: TurnId): BrowserTurnState {
  const key = stateKey(sessionId, turnId);
  const existing = states.get(key);
  if (existing) return existing;
  const created: BrowserTurnState = {};
  states.set(key, created);
  return created;
}

export function recordBrowserTurnPageActivity(input: {
  meta: BrowserResponseMeta;
  sessionId: SessionId;
  turnId?: TurnId;
}): void {
  if (!input.turnId || !input.meta.tabId) return;
  readState(input.sessionId, input.turnId).candidate = {
    browserGeneration: input.meta.browserGeneration,
    browserId: input.meta.browserId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function recordBrowserTurnToolResult(input: {
  output: unknown;
  sessionId: SessionId;
  toolName: string;
  turnId: TurnId;
}): void {
  if (input.toolName !== "js" && input.toolName !== "mcp__node_repl__js") return;
  const output = asRecord(input.output);
  const responseMeta = asRecord(output?._meta) ?? asRecord(output?.responseMeta);
  const candidate = asRecord(responseMeta?.["zcode/browserTurnScreenshot"]);
  if (
    typeof candidate?.browserId !== "string" ||
    typeof candidate.browserGeneration !== "number" ||
    !Number.isInteger(candidate.browserGeneration)
  ) {
    return;
  }
  readState(input.sessionId, input.turnId).candidate = {
    browserGeneration: candidate.browserGeneration,
    browserId: candidate.browserId,
  };
}

export function consumeBrowserTurnState(
  sessionId: SessionId,
  turnId: TurnId,
): BrowserTurnState | undefined {
  const key = stateKey(sessionId, turnId);
  const state = states.get(key);
  states.delete(key);
  return state;
}

export function clearBrowserTurnState(sessionId: SessionId, turnId: TurnId): void {
  states.delete(stateKey(sessionId, turnId));
}

export const CONVERSATION_TELEMETRY_DIFF_CATEGORIES: readonly [
  "MISSING_EVENT",
  "EXTRA_EVENT",
  "MISSING_FIELD",
  "EXTRA_FIELD",
  "TYPE_MISMATCH",
  "VALUE_MISMATCH",
  "RELATION_MISMATCH",
  "ORDER_MISMATCH",
  "TIMING_INVARIANT_MISMATCH",
];

export type ConversationTelemetryDiffCategory =
  (typeof CONVERSATION_TELEMETRY_DIFF_CATEGORIES)[number];
export type ConversationTelemetryChannel = "report" | "arms";

export interface ConversationTelemetryFinalCapture {
  report: readonly unknown[];
  arms: readonly unknown[];
}

export interface NormalizedConversationTelemetryCapture {
  report: unknown[];
  arms: unknown[];
}

export interface ConversationTelemetryParityDiff {
  category: ConversationTelemetryDiffCategory;
  channel: ConversationTelemetryChannel;
  eventIndex: number | null;
  path: string;
  expected: string;
  actual: string;
}

export interface ConversationTelemetryParityResult {
  equal: boolean;
  expected: NormalizedConversationTelemetryCapture;
  actual: NormalizedConversationTelemetryCapture;
  differences: ConversationTelemetryParityDiff[];
}

export function normalizeConversationTelemetryCapture(
  capture: ConversationTelemetryFinalCapture,
): NormalizedConversationTelemetryCapture;

export function compareConversationTelemetryParity(
  expectedCapture: ConversationTelemetryFinalCapture,
  actualCapture: ConversationTelemetryFinalCapture,
): ConversationTelemetryParityResult;

export function formatConversationTelemetryParityDifferences(
  differences: readonly ConversationTelemetryParityDiff[],
): string;

export function assertConversationTelemetryParity(
  expected: ConversationTelemetryFinalCapture,
  actual: ConversationTelemetryFinalCapture,
): void;

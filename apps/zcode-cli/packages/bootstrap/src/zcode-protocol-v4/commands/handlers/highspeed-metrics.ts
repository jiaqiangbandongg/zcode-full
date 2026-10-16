import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

async function setHighspeedMetrics(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setHighspeedMetrics"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "setHighspeedMetrics",
  );
  if (!resolution?.ok || !resolution.messageId || resolution.row.kind !== "userInput") {
    throw new V4RowTranslationError("setHighspeedMetrics", payload.target.rowId);
  }
  if (!host.setHighspeedMetrics) throw new Error("fault.command.highspeedMetricsUnsupported");
  await host.setHighspeedMetrics(record.app.sessionId, {
    entityId: payload.target.entityId,
    messageId: resolution.messageId,
    metrics: {
      regularTps: payload.regularTps,
      outputTokens: payload.outputTokens,
      durationMs: payload.durationMs,
      highspeedTps: payload.highspeedTps,
      savedDurationMs: payload.savedDurationMs,
      ...(payload.modelDurationMs !== undefined
        ? { modelDurationMs: payload.modelDurationMs }
        : {}),
      ...(payload.toolDurationMs !== undefined ? { toolDurationMs: payload.toolDurationMs } : {}),
      ...(payload.otherDurationMs !== undefined
        ? { otherDurationMs: payload.otherDurationMs }
        : {}),
    },
  });
  return undefined;
}

export const highspeedMetricsHandlers = { setHighspeedMetrics };

import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps, TuiSubmitOptions } from "../types.js";

type ParsedExpertCommand =
  | {
      action: "resume" | "status" | "stop";
      runId?: string;
    }
  | {
      action: "start";
      task: string;
    };

export async function handleExpertCommand(
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const parsed = parseExpertCommandArgs(args);

  if (parsed.action === "status") {
    if (!app.expertWorkflowStatus) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    const result = await app.expertWorkflowStatus({
      abortSignal: options.abortSignal,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (parsed.action === "stop") {
    if (!app.stopExpertWorkflow) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    const result = await app.stopExpertWorkflow({
      abortSignal: options.abortSignal,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (parsed.action === "resume") {
    if (!app.resumeExpertWorkflow) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    if (deps.setMode && (deps.getMode?.() ?? app.getMode?.()) !== "guarded") {
      await deps.setMode("yolo");
    }
    const result = await app.resumeExpertWorkflow({
      abortSignal: options.abortSignal,
      onEvent: options.onEvent,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (!app.runExpertWorkflow) {
    return {
      mode: deps.getMode?.(),
      response: "Expert workflow is not available in this client.",
    };
  }
  if (deps.setMode && (deps.getMode?.() ?? app.getMode?.()) !== "guarded") {
    await deps.setMode("yolo");
  }
  const task = parsed.action === "start" ? parsed.task : "";
  const result = await app.runExpertWorkflow(
    {
      task,
    },
    {
      abortSignal: options.abortSignal,
      onEvent: options.onEvent,
    },
  );
  return {
    mode: deps.getMode?.(),
    response: result.response,
    traceId: result.traceId ?? app.traceId,
  };
}

function parseExpertCommandArgs(args: string): ParsedExpertCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { action: "status" };
  }

  const firstWhitespace = trimmed.search(/\s/);
  const first = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const rest = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim();
  const action = first.toLowerCase();

  if (action === "status" || action === "resume") {
    return {
      action,
      runId: rest || undefined,
    };
  }
  if (action === "stop" || action === "cancel") {
    return {
      action: "stop",
      runId: rest || undefined,
    };
  }

  return {
    action: "start",
    task: trimmed,
  };
}

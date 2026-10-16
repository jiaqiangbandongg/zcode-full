import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMetrics, RunRequestInput, RunSummary } from "../shared/types.js";
import { buildFrameScenario, type TimedCharEvent } from "./frameBuckets.js";
import {
  createRawWriter,
  ensureRunDir,
  toDataRelativePath,
  writeResponseText,
  writeRunSummary,
} from "./dataStore.js";

interface ExecuteRunInput {
  onUpdate?: (run: RunSummary) => void;
  packageRoot: string;
  request: RunRequestInput;
  run: RunSummary;
}

export async function executeDeepseekRun(input: ExecuteRunInput) {
  const runDir = await ensureRunDir(input.packageRoot, input.run.id);
  const rawWriter = createRawWriter(runDir);
  const startedAt = performance.now();
  const charEvents: TimedCharEvent[] = [];
  let firstByteMs: number | null = null;
  let firstTokenMs: number | null = null;
  let outputText = "";
  let outputChars = 0;
  let rawSseChars = 0;
  let sseEvents = 0;
  let lastProgressEmitMs = 0;

  const emitProgress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgressEmitMs < 200) {
      return;
    }
    lastProgressEmitMs = now;
    input.onUpdate?.(
      buildRunSnapshot(input, runDir, {
        metrics: buildMetrics({
          charEvents,
          durationMs: now - startedAt,
          firstByteMs,
          firstTokenMs,
          outputChars,
          rawSseChars,
          sseEvents,
        }),
        outputPreview: outputText.slice(0, 600),
        status: "running",
      }),
    );
  };

  rawWriter.write({
    at: new Date().toISOString(),
    model: input.request.model,
    type: "run.started",
  });

  try {
    const response = await fetch(input.request.baseUrl, {
      body: JSON.stringify(buildRequestBody(input.request)),
      headers: {
        Authorization: `Bearer ${resolveApiKey(input.request)}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    firstByteMs = performance.now() - startedAt;
    rawWriter.write({
      at: new Date().toISOString(),
      elapsedMs: roundMs(firstByteMs),
      status: response.status,
      statusText: response.statusText,
      type: "http.response",
    });
    emitProgress(true);

    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(`DeepSeek request failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    let buffer = "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunkText = decoder.decode(value, { stream: true });
      rawWriter.write({
        at: new Date().toISOString(),
        bytes: value.byteLength,
        chars: chunkText.length,
        elapsedMs: roundMs(performance.now() - startedAt),
        text: chunkText,
        type: "http.chunk",
      });

      buffer += chunkText;
      const parsed = consumeSseBuffer(buffer);
      buffer = parsed.remaining;

      for (const data of parsed.events) {
        const receivedAtMs = performance.now() - startedAt;
        if (data === "[DONE]") {
          rawWriter.write({
            at: new Date().toISOString(),
            elapsedMs: roundMs(receivedAtMs),
            type: "sse.done",
          });
          emitProgress(true);
          continue;
        }

        sseEvents += 1;
        rawSseChars += data.length;
        const decoded = safeParseJson(data);
        const deltaText = extractDeltaText(decoded);
        if (deltaText.length > 0 && firstTokenMs === null) {
          firstTokenMs = receivedAtMs;
        }
        outputText += deltaText;
        outputChars += deltaText.length;
        charEvents.push({ chars: deltaText.length, receivedAtMs });
        rawWriter.write({
          at: new Date().toISOString(),
          data,
          deltaChars: deltaText.length,
          elapsedMs: roundMs(receivedAtMs),
          index: sseEvents,
          type: "sse.data",
        });
        emitProgress();
      }
    }

    const durationMs = performance.now() - startedAt;
    const metrics = buildMetrics({
      charEvents,
      durationMs,
      firstByteMs,
      firstTokenMs,
      outputChars,
      rawSseChars,
      sseEvents,
    });
    const completedRun = buildRunSnapshot(input, runDir, {
      completedAt: new Date().toISOString(),
      metrics,
      outputPreview: outputText.slice(0, 600),
      status: "completed",
    });
    await writeResponseText(runDir, outputText);
    await writeRunSummary(runDir, completedRun);
    rawWriter.write({
      at: new Date().toISOString(),
      metrics,
      type: "run.completed",
    });
    return completedRun;
  } catch (error) {
    const failedRun = buildRunSnapshot(input, runDir, {
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      metrics: null,
      outputPreview: outputText.slice(0, 600),
      status: "failed",
    });
    await writeFile(join(runDir, "response.txt"), outputText, "utf-8");
    await writeRunSummary(runDir, failedRun);
    rawWriter.write({
      at: new Date().toISOString(),
      error: failedRun.error,
      type: "run.failed",
    });
    return failedRun;
  } finally {
    await rawWriter.close();
  }
}

function buildRequestBody(request: RunRequestInput) {
  return {
    max_tokens: request.maxTokens,
    messages: request.messages,
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    stream: true,
    temperature: request.temperature,
    thinking: { type: request.thinkingEnabled ? "enabled" : "disabled" },
  };
}

function resolveApiKey(request: RunRequestInput) {
  const apiKey = request.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing API key. Set DEEPSEEK_API_KEY or provide apiKey in the request.");
  }
  return apiKey;
}

function consumeSseBuffer(buffer: string) {
  const events: string[] = [];
  let remaining = buffer;

  for (;;) {
    const separator = remaining.search(/\r?\n\r?\n/u);
    if (separator < 0) {
      return { events, remaining };
    }
    const rawEvent = remaining.slice(0, separator);
    remaining = remaining.slice(separator + (remaining[separator] === "\r" ? 4 : 2));
    const data = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length > 0) {
      events.push(data);
    }
  }
}

function extractDeltaText(decoded: unknown) {
  if (!isRecord(decoded)) {
    return "";
  }
  const choices = Array.isArray(decoded.choices) ? decoded.choices : [];
  return choices
    .map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        return "";
      }
      return [
        readString(choice.delta, "reasoning_content"),
        readString(choice.delta, "content"),
      ].join("");
    })
    .join("");
}

function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function buildMetrics(input: {
  charEvents: TimedCharEvent[];
  durationMs: number;
  firstByteMs: number | null;
  firstTokenMs: number | null;
  outputChars: number;
  rawSseChars: number;
  sseEvents: number;
}): RunMetrics {
  return {
    charsPerSecond: input.durationMs > 0 ? (input.outputChars / input.durationMs) * 1000 : 0,
    durationMs: roundMs(input.durationMs),
    firstByteMs: input.firstByteMs === null ? null : roundMs(input.firstByteMs),
    firstTokenMs: input.firstTokenMs === null ? null : roundMs(input.firstTokenMs),
    frames: {
      "60": buildFrameScenario(60, input.durationMs, input.charEvents),
      "120": buildFrameScenario(120, input.durationMs, input.charEvents),
    },
    outputChars: input.outputChars,
    rawSseChars: input.rawSseChars,
    sseEvents: input.sseEvents,
  };
}

function buildRunSnapshot(
  input: ExecuteRunInput,
  runDir: string,
  result: Pick<RunSummary, "metrics" | "outputPreview" | "status"> & {
    completedAt?: string | null;
    error?: string | null;
  },
): RunSummary {
  return {
    ...input.run,
    completedAt: result.completedAt ?? null,
    error: result.error ?? null,
    files: {
      raw: toDataRelativePath(input.packageRoot, join(runDir, "raw.ndjson")),
      responseText: toDataRelativePath(input.packageRoot, join(runDir, "response.txt")),
      summary: toDataRelativePath(input.packageRoot, join(runDir, "summary.json")),
    },
    metrics: result.metrics,
    outputPreview: result.outputPreview,
    status: result.status,
  };
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

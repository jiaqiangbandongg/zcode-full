import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import type { ChatMessageInput, RunRequestInput, RunSummary } from "../shared/types.js";
import { DATA_DIR_NAME, createRunId, listRuns, readRawLines, readRun, writeRunSummary } from "./dataStore.js";
import { executeDeepseekRun } from "./deepseekRunner.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-pro";

interface ServerOptions {
  dev: boolean;
  packageRoot: string;
  port: number;
}

const activeRuns = new Map<string, RunSummary>();

export async function startStreamAnimateServer(options: ServerOptions) {
  const vite = options.dev ? await createViteServer(options.packageRoot) : null;
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/")) {
        await handleApiRequest(options.packageRoot, request, response);
        return;
      }
      if (vite) {
        vite.middlewares(request, response, () => sendNotFound(response));
        return;
      }
      await serveStatic(options.packageRoot, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveServer) => server.listen(options.port, "127.0.0.1", resolveServer));
  return {
    close: async () => {
      await Promise.all([
        vite?.close(),
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ]);
    },
    url: `http://127.0.0.1:${options.port}/`,
  };
}

export function getPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function handleApiRequest(
  packageRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/api/config") {
    sendJson(response, 200, {
      dataDir: join("packages", "stream-animate", DATA_DIR_NAME),
      hasEnvApiKey: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/runs") {
    const runs = await listRuns(packageRoot);
    sendJson(response, 200, { runs: mergeActiveRuns(runs) });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/runs") {
    const input = normalizeRunInput(await readJsonBody(request));
    const run = createInitialRun(input);
    activeRuns.set(run.id, run);
    const runDir = await import("./dataStore.js").then(({ ensureRunDir }) =>
      ensureRunDir(packageRoot, run.id),
    );
    await writeRunSummary(runDir, run);
    void executeDeepseekRun({
      onUpdate: (progressRun) => activeRuns.set(progressRun.id, progressRun),
      packageRoot,
      request: input,
      run,
    }).then((finishedRun) => {
      activeRuns.delete(finishedRun.id);
    });
    sendJson(response, 202, { run });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)(?:\/(raw))?$/u.exec(requestUrl.pathname);
  if (request.method === "GET" && runMatch) {
    const runId = runMatch[1];
    if (!runId) {
      sendNotFound(response);
      return;
    }
    const runAction = runMatch[2];
    if (runAction === "raw") {
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "400", 10);
      sendJson(response, 200, {
        lines: await readRawLines(packageRoot, runId, Math.min(Math.max(limit, 1), 2000)),
      });
      return;
    }
    sendJson(response, 200, { run: activeRuns.get(runId) ?? (await readRun(packageRoot, runId)) });
    return;
  }

  sendNotFound(response);
}

function createInitialRun(input: RunRequestInput): RunSummary {
  const now = new Date().toISOString();
  return {
    apiKeySource: input.apiKey?.trim() ? "provided" : "env",
    baseUrl: input.baseUrl,
    completedAt: null,
    createdAt: now,
    error: null,
    files: {
      raw: "",
      responseText: "",
      summary: "",
    },
    id: createRunId(new Date(now)),
    metrics: null,
    model: input.model,
    outputPreview: "",
    reasoningEffort: input.reasoningEffort,
    status: "running",
    thinkingEnabled: input.thinkingEnabled,
  };
}

function normalizeRunInput(value: unknown): RunRequestInput {
  const record = isRecord(value) ? value : {};
  return {
    apiKey: readString(record, "apiKey"),
    baseUrl: readString(record, "baseUrl") || DEFAULT_BASE_URL,
    maxTokens: readBoundedNumber(record.maxTokens, 16, 8192, 2048),
    messages: normalizeMessages(record.messages),
    model: readString(record, "model") || DEFAULT_MODEL,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    stream: true,
    temperature: readBoundedNumber(record.temperature, 0, 2, 0.2),
    thinkingEnabled: record.thinkingEnabled !== false,
  };
}

function normalizeMessages(value: unknown): ChatMessageInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "写个 2000 字的小说关于英雄联盟" },
    ];
  }
  return value.flatMap((message) => {
    if (!isRecord(message)) {
      return [];
    }
    const role: ChatMessageInput["role"] =
      message.role === "system" || message.role === "assistant" ? message.role : "user";
    const content = readString(message, "content").trim();
    return content ? [{ role, content }] : [];
  });
}

function normalizeReasoningEffort(value: unknown) {
  return value === "low" || value === "medium" || value === "high" ? value : "high";
}

function mergeActiveRuns(storedRuns: RunSummary[]) {
  const runById = new Map(storedRuns.map((run) => [run.id, run]));
  for (const run of activeRuns.values()) {
    runById.set(run.id, run);
  }
  return [...runById.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

async function createViteServer(packageRoot: string): Promise<ViteDevServer> {
  const { createServer: createViteDevServer } = await import("vite");
  return createViteDevServer({
    appType: "spa",
    root: packageRoot,
    server: {
      middlewareMode: true,
    },
  });
}

async function serveStatic(packageRoot: string, request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const staticRoot = join(packageRoot, "dist");
  const candidate = resolve(staticRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
  const filePath = candidate.startsWith(staticRoot) ? candidate : join(staticRoot, "index.html");
  const resolvedPath = await resolveStaticPath(filePath, staticRoot);
  if (!resolvedPath) {
    sendNotFound(response);
    return;
  }

  response.setHeader("Content-Type", contentTypeFor(resolvedPath));
  createReadStream(resolvedPath).pipe(response);
}

async function resolveStaticPath(filePath: string, staticRoot: string) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return filePath;
    }
  } catch {
    return join(staticRoot, "index.html");
  }
  return join(staticRoot, "index.html");
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim() ? (JSON.parse(text) as unknown) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendNotFound(response: ServerResponse) {
  sendJson(response, 404, { error: "Not found" });
}

function contentTypeFor(filePath: string) {
  const extension = extname(filePath);
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readBoundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numberValue));
}

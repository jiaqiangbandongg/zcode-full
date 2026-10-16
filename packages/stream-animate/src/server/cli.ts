import type { RunRequestInput } from "../shared/types.js";
import { createRunId } from "./dataStore.js";
import { executeDeepseekRun } from "./deepseekRunner.js";
import { getPackageRoot } from "./http.js";

const options = parseArgs(process.argv.slice(2));
const now = new Date().toISOString();
const request: RunRequestInput = {
  apiKey: options.apiKey,
  baseUrl: options.baseUrl ?? "https://api.deepseek.com/chat/completions",
  maxTokens: Number.parseInt(options.maxTokens ?? "2048", 10),
  messages: [
    { role: "system", content: options.system ?? "You are a helpful assistant." },
    { role: "user", content: options.prompt ?? "写个 2000 字的小说关于英雄联盟" },
  ],
  model: options.model ?? "deepseek-v4-pro",
  reasoningEffort: normalizeEffort(options.reasoningEffort),
  stream: true,
  temperature: Number.parseFloat(options.temperature ?? "0.2"),
  thinkingEnabled: options.thinking !== "disabled",
};

const run = await executeDeepseekRun({
  packageRoot: getPackageRoot(),
  request,
  run: {
    apiKeySource: request.apiKey ? "provided" : "env",
    baseUrl: request.baseUrl,
    completedAt: null,
    createdAt: now,
    error: null,
    files: { raw: "", responseText: "", summary: "" },
    id: createRunId(new Date(now)),
    metrics: null,
    model: request.model,
    outputPreview: "",
    reasoningEffort: request.reasoningEffort,
    status: "running",
    thinkingEnabled: request.thinkingEnabled,
  },
});

console.log(JSON.stringify(run, null, 2));

function parseArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = args[index + 1];
    if (value && !value.startsWith("--")) {
      parsed[key] = value;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function normalizeEffort(value: string | undefined) {
  return value === "low" || value === "medium" || value === "high" ? value : "high";
}

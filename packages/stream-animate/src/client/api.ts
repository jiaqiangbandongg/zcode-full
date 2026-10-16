import type {
  AppConfig,
  CreateRunResponse,
  RawRunResponse,
  RunListResponse,
  RunRequestInput,
  RunSummary,
} from "@/shared/types";

export interface RunFormState {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  model: string;
  prompt: string;
  reasoningEffort: RunRequestInput["reasoningEffort"];
  systemPrompt: string;
  temperature: number;
  thinkingEnabled: boolean;
}

export const DEFAULT_FORM: RunFormState = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/chat/completions",
  maxTokens: 2048,
  model: "deepseek-v4-pro",
  prompt: "写个 2000 字的小说关于英雄联盟",
  reasoningEffort: "high",
  systemPrompt: "You are a helpful assistant.",
  temperature: 0.2,
  thinkingEnabled: true,
};

export async function fetchConfig() {
  return fetchJson<AppConfig>("/api/config");
}

export async function fetchRuns() {
  return (await fetchJson<RunListResponse>("/api/runs")).runs;
}

export async function fetchRun(runId: string) {
  return (await fetchJson<{ run: RunSummary }>(`/api/runs/${runId}`)).run;
}

export async function fetchRawLines(runId: string) {
  return (await fetchJson<RawRunResponse>(`/api/runs/${runId}/raw?limit=200`)).lines;
}

export async function createRun(form: RunFormState) {
  const body: RunRequestInput = {
    apiKey: form.apiKey.trim() || undefined,
    baseUrl: form.baseUrl.trim(),
    maxTokens: form.maxTokens,
    messages: [
      { role: "system", content: form.systemPrompt },
      { role: "user", content: form.prompt },
    ],
    model: form.model.trim(),
    reasoningEffort: form.reasoningEffort,
    stream: true,
    temperature: form.temperature,
    thinkingEnabled: form.thinkingEnabled,
  };
  return (await postJson<CreateRunResponse>("/api/runs", body)).run;
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url);
  return readResponse<T>(response);
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response) {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    throw new Error(readErrorMessage(body) ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

function readErrorMessage(body: unknown) {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error = body.error;
  return typeof error === "string" ? error : null;
}

export type RunStatus = "running" | "completed" | "failed";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ChatMessageInput {
  content: string;
  role: "system" | "user" | "assistant";
}

export interface RunRequestInput {
  apiKey?: string;
  baseUrl: string;
  maxTokens: number;
  messages: ChatMessageInput[];
  model: string;
  reasoningEffort: ReasoningEffort;
  stream: true;
  temperature: number;
  thinkingEnabled: boolean;
}

export interface FrameBucket {
  chars: number;
  endMs: number;
  frameIndex: number;
  startMs: number;
}

export interface FrameTrendPoint {
  chars: number;
  frameIndex: number;
}

export interface FrameForecast {
  horizonFrames: number;
  observed: FrameTrendPoint[];
  predicted: FrameTrendPoint[];
  peakLimit: number;
  windowFrames: number;
}

export interface FrameScenario {
  avgChars: number;
  buckets: FrameBucket[];
  forecast?: FrameForecast;
  fps: 60 | 120;
  frameMs: number;
  maxChars: number;
  nonEmptyFrames: number;
  totalFrames: number;
}

export interface RunMetrics {
  charsPerSecond: number;
  durationMs: number;
  firstByteMs: number | null;
  firstTokenMs: number | null;
  frames: Record<"60" | "120", FrameScenario>;
  outputChars: number;
  rawSseChars: number;
  sseEvents: number;
}

export interface RunSummary {
  apiKeySource: "env" | "provided";
  baseUrl: string;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  files: {
    raw: string;
    responseText: string;
    summary: string;
  };
  id: string;
  metrics: RunMetrics | null;
  model: string;
  outputPreview: string;
  reasoningEffort: ReasoningEffort;
  status: RunStatus;
  thinkingEnabled: boolean;
}

export interface AppConfig {
  dataDir: string;
  hasEnvApiKey: boolean;
}

export interface CreateRunResponse {
  run: RunSummary;
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface RawRunResponse {
  lines: string[];
}

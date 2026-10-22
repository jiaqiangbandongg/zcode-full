export type JsonObject = Record<string, unknown>;

export interface TrajectoryDerivationOptions {
  ignoreToolSearchChanges?: boolean;
}

export interface OpenAiMessage extends JsonObject {
  role: string;
}

export interface RequestEntry {
  kind: "request";
  requestIndex: number;
  bodyWithoutMessages: JsonObject;
}

export interface MessageEntry {
  kind: "message";
  requestIndex: number;
  messageIndex?: number;
  message: OpenAiMessage;
}

export type TrajectoryJsonlEntry = RequestEntry | MessageEntry;

export interface DerivedTrajectory {
  id: string;
  index: number;
  lastRequestIndex: number;
  reason: "initial" | "post-compaction" | "non-incremental-change";
  requestBody: JsonObject & {
    messages: OpenAiMessage[];
  };
  requestCount: number;
}

export interface DerivedTrajectoryManifest {
  schemaVersion: 1;
  generatedAt: string;
  ignoreToolSearchChanges?: true;
  trajectories: Array<{
    id: string;
    lastRequestIndex: number;
    messageCount: number;
    reason: DerivedTrajectory["reason"];
    requestCount: number;
  }>;
}

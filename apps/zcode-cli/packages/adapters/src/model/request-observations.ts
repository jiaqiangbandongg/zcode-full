import type { ModelRequestObservation } from "@zcode/contracts";

const MAX_TRACKED_REQUESTS = 64;

export class RequestObservationStore {
  private readonly entries = new Map<string, ModelRequestObservation[]>();

  record(requestId: string, observation: ModelRequestObservation): void {
    let observations = this.entries.get(requestId);
    if (!observations) {
      if (this.entries.size >= MAX_TRACKED_REQUESTS) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      observations = [];
      this.entries.set(requestId, observations);
    }
    observations.push(observation);
  }

  take(requestId: string): ModelRequestObservation[] {
    const observations = this.entries.get(requestId) ?? [];
    this.entries.delete(requestId);
    return observations;
  }

  get size(): number {
    return this.entries.size;
  }
}

export function readRequestObservationId(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string | undefined {
  const fromInit = init?.headers ? new Headers(init.headers).get("x-request-id") : null;
  const value = fromInit ?? (input instanceof Request ? input.headers.get("x-request-id") : null);
  return value?.trim() || undefined;
}

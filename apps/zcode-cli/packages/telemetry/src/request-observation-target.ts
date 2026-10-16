import type { Attributes } from "@opentelemetry/api";

export interface RequestObservationTarget {
  setAttribute(name: string, value: unknown): void;
  addEvent(name: string, attributes?: Attributes): void;
}

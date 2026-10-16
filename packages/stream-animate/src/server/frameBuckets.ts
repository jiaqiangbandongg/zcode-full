import type { FrameBucket, FrameScenario } from "../shared/types.js";
import { buildFrameForecast } from "./frameForecast.js";

export interface TimedCharEvent {
  chars: number;
  receivedAtMs: number;
}

export function buildFrameScenario(
  fps: 60 | 120,
  durationMs: number,
  events: TimedCharEvent[],
): FrameScenario {
  const frameMs = 1000 / fps;
  const totalFrames = Math.max(1, Math.ceil(durationMs / frameMs));
  const buckets: FrameBucket[] = Array.from({ length: totalFrames }, (_, frameIndex) => ({
    chars: 0,
    endMs: (frameIndex + 1) * frameMs,
    frameIndex,
    startMs: frameIndex * frameMs,
  }));

  for (const event of events) {
    if (event.chars <= 0) {
      continue;
    }
    const frameIndex = Math.min(totalFrames - 1, Math.floor(event.receivedAtMs / frameMs));
    const bucket = buckets[frameIndex];
    if (bucket) {
      bucket.chars += event.chars;
    }
  }

  const maxChars = buckets.reduce((max, bucket) => Math.max(max, bucket.chars), 0);
  const nonEmptyFrames = buckets.filter((bucket) => bucket.chars > 0).length;
  const totalChars = buckets.reduce((sum, bucket) => sum + bucket.chars, 0);

  return {
    avgChars: totalFrames > 0 ? totalChars / totalFrames : 0,
    buckets,
    forecast: buildFrameForecast(fps, buckets, totalFrames),
    fps,
    frameMs,
    maxChars,
    nonEmptyFrames,
    totalFrames,
  };
}

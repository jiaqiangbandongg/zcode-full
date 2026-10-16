export type LoafInvokerType = "user-callback" | "event-listener" | "script" | "unknown";

export interface LongTaskAttributionSummary {
  loaf_script_count: number;
  loaf_top_duration_ms: number;
  loaf_top_invoker_type: LoafInvokerType;
  loaf_top_share_pct: number;
}

interface RawAttribution {
  duration?: unknown;
  invokerType?: unknown;
}

// LoAF(ILongAnimationScript) 才有 invokerType；rAF 来源(ILongTaskAttribution) 只有
// containerType 等容器字段、无 invokerType，归为通用 "script" 桶，与"有 invokerType 但值未知"区分。
function classifyInvokerType(raw: RawAttribution): LoafInvokerType {
  if (raw.invokerType === undefined || raw.invokerType === null) {
    return "script";
  }
  if (raw.invokerType === "user-callback" || raw.invokerType === "event-listener") {
    return raw.invokerType;
  }
  return "unknown";
}

/**
 * 纯函数：解析 ARMS RUM longTask 事件的 snapshots(JSON 字符串化的 top-5 attribution) 与
 * 长任务总时长，提炼低基数归因摘要。不返回原始脚本名/URL，避免路径泄露与高基数字段。
 * 解析失败/无有效 attribution 时返回 null，调用方应静默跳过。
 */
export function summarizeLongTaskAttribution(
  snapshotsRaw: unknown,
  totalDurationMs: unknown,
): LongTaskAttributionSummary | null {
  if (typeof snapshotsRaw !== "string" || snapshotsRaw.length === 0) {
    return null;
  }
  let attributions: unknown;
  try {
    attributions = JSON.parse(snapshotsRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(attributions) || attributions.length === 0) {
    return null;
  }

  let top: RawAttribution | null = null;
  let topDuration = -Infinity;
  for (const item of attributions) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const candidate = item as RawAttribution;
    const duration = typeof candidate.duration === "number" ? candidate.duration : 0;
    if (duration > topDuration) {
      topDuration = duration;
      top = candidate;
    }
  }
  if (!top) {
    return null;
  }

  const total = typeof totalDurationMs === "number" ? totalDurationMs : Number.NaN;
  const sharePct =
    Number.isFinite(total) && total > 0
      ? Math.round((Math.max(0, topDuration) / total) * 100)
      : 0;

  return {
    loaf_script_count: attributions.length,
    loaf_top_duration_ms: Math.round(Math.max(0, topDuration)),
    loaf_top_invoker_type: classifyInvokerType(top),
    loaf_top_share_pct: sharePct,
  };
}

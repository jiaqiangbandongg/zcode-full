import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";

export const HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS = 24 * 60 * 60_000;
export const HIGHSPEED_NOTICE_AUTO_CLOSE_MS = 24 * 60 * 60_000;
export const MIN_HIGHSPEED_SHARE_SPEEDUP = 1.2;
/**
 * 左下角分享卡通知的 payload。指标一律以毫秒事实携带（与发布门禁 isHighspeedShareEligible 同精度），
 * 秒级展示值由渲染侧派生；durationSeconds/savedDurationSeconds 只是 ≤24h 内遗留持久化通知的兼容读取字段。
 */
export interface HighspeedShareNoticePayload extends Record<string, unknown> {
  cardId: string;
  tokenUsage: number;
  durationMs?: number;
  savedDurationMs?: number;
  /** @deprecated 旧版秒级取整字段，只读兼容，不再写入。 */
  durationSeconds?: number;
  /** @deprecated 旧版秒级取整字段，只读兼容，不再写入。 */
  savedDurationSeconds?: number;
}

export async function copyHighspeedShareText(
  text: string,
  writeText: (value: string) => Promise<void> = async (value) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("text clipboard is unavailable");
    }
    await navigator.clipboard.writeText(value);
  },
): Promise<void> {
  await writeText(text);
}

/** 紧凑时长：>=60s 显示分钟，否则秒；加速标签与导出图片共用，跨语言保持一致的紧凑单位。 */
export function formatHighspeedDurationShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}min`;
  return `${totalSeconds}s`;
}

function resolveHighspeedSavedDurationMs(metrics: HighspeedShareMetrics): number {
  return metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
}

/**
 * 分享入口只对完整且可信的卡级数据开放，避免低收益或缺少耗时的结果生成误导性分享卡。
 * 这里使用未四舍五入的倍率，确保 1.2x 边界稳定，展示层的格式化不会影响资格判断。
 */
export function isHighspeedShareEligible(metrics: HighspeedShareMetrics): boolean {
  if (
    !Number.isFinite(metrics.outputTokens) ||
    metrics.outputTokens <= 0 ||
    !Number.isFinite(metrics.durationMs) ||
    metrics.durationMs <= 0 ||
    !Number.isFinite(metrics.regularTps) ||
    metrics.regularTps <= 0 ||
    !Number.isFinite(metrics.highspeedTps) ||
    metrics.highspeedTps <= 0
  ) {
    return false;
  }
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  if (!Number.isFinite(savedDurationMs) || savedDurationMs < 0) return false;
  const overallSpeedup = (metrics.durationMs + savedDurationMs) / metrics.durationMs;
  return Number.isFinite(overallSpeedup) && overallSpeedup > MIN_HIGHSPEED_SHARE_SPEEDUP;
}

/** 优先使用 CLI 真实耗时；旧消息回退到工具 20% / 模型 80% 估算。 */
export function highspeedSpeedup(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 1);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  return Math.max(0, Math.round(((durationMs + savedDurationMs) / durationMs) * 10) / 10);
}

/** 时间节省比例（%），按真实拆分或兼容的 20/80 口径计算。 */
export function highspeedSavedPercent(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 0);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  const regularDurationMs = durationMs + savedDurationMs;
  if (regularDurationMs <= 0) return 0;
  return Math.max(0, Math.min(99, Math.round((savedDurationMs / regularDurationMs) * 100)));
}

const HIGHSPEED_CARD_IMAGE_SIZE = { width: 436, height: 304 } as const;

export interface HighspeedShareImageLabels {
  benefit: string;
  standardSpeed: string;
  speedSummary: string;
  lessWaiting: string;
  imageSummary: string;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&apos;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

/** 与 useTheme 的 applyTheme 一致：根节点 dark class 即暗色；无 DOM 时按暗色品牌卡兜底。 */
function detectHighspeedCardDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement?.classList?.contains("dark") ?? true;
}

/** 将统计区渲染为独立 SVG，复制图片时不会把弹框底部文案和按钮带进去。 */
export async function copyHighspeedCardImage(
  metrics: HighspeedShareMetrics,
  writeImage: (blob: Blob) => Promise<void> = async (blob) => {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof ClipboardItem === "undefined"
    ) {
      throw new Error("image clipboard is unavailable");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  },
  labels?: HighspeedShareImageLabels,
): Promise<void> {
  const savedSeconds = Math.max(0, Math.round(resolveHighspeedSavedDurationMs(metrics) / 1_000));
  const speedup = highspeedSpeedup(metrics);
  const savedPercent = highspeedSavedPercent(metrics);
  const imageLabels: HighspeedShareImageLabels = labels ?? {
    benefit: "ZCode & Coding Plan Exclusive Benefits",
    standardSpeed: "standard generation speed",
    speedSummary: `HighSpeed · ${formatHighspeedDurationShort(metrics.durationMs)}`,
    lessWaiting: `${savedPercent}% less waiting`,
    imageSummary: `${Math.floor(metrics.outputTokens).toLocaleString()} tokens · ${savedSeconds}s saved`,
  };
  const { width, height } = HIGHSPEED_CARD_IMAGE_SIZE;
  const fontStack = "Geist,-apple-system,'Segoe UI',Arial,sans-serif";
  // 深浅模式分别对应设计稿暗/亮两个变体的配色。
  const dark = detectHighspeedCardDarkTheme();
  const palette = dark
    ? {
        bg: "#101010",
        cardStroke: "",
        titleText: "#acacac",
        tagStroke: "rgba(255,255,255,0.16)",
        tagFillTop: "rgba(255,255,255,0.06)",
        tagFillBottom: "rgba(153,153,153,0.06)",
        title: "#ffffff",
        subtitle: "#b1b1b1",
        divider: "#ffffff",
        summary: "#8f8f8f",
        track: "#2b2b2b",
      }
    : {
        bg: "#ffffff",
        cardStroke: ` stroke="#0d0d0d" stroke-opacity="0.1"`,
        titleText: "#5c5c5c",
        tagStroke: "rgba(0,0,0,0.16)",
        tagFillTop: "rgba(0,0,0,0.06)",
        tagFillBottom: "rgba(0,0,0,0.04)",
        title: "#0d0d0d",
        subtitle: "#5c5c5c",
        divider: "#0d0d0d",
        summary: "#5c5c5c",
        track: "rgba(0,0,0,0.08)",
      };
  // 复制出的图片与弹窗一致：整条深色轨道 + 三段渐变填充到“相对耗时”占比，落点用细绿指针标记。
  const meterX = 24;
  const meterY = 186;
  const meterW = width - meterX * 2;
  const meterH = 8;
  const fillW = Math.max(0, meterW * Math.max(0, Math.min(1, (100 - savedPercent) / 100)));
  const markerX = meterX + fillW;
  const meter = `<rect x="${meterX}" y="${meterY}" width="${meterW}" height="${meterH}" rx="1" fill="${palette.track}"/><rect x="${meterX}" y="${meterY}" width="${fillW.toFixed(2)}" height="${meterH}" rx="1" fill="url(#hs-meter)"/><rect x="${(markerX - 1).toFixed(2)}" y="${meterY - 6}" width="2" height="20" rx="1" fill="#01c34b"/>`;
  // Title 行与弹窗一致（Figma 6403:11193）：Z logo 方块 + 权益文案 + HighSpeed 胶囊；logo 用矢量近似。
  const titleRow = `<rect x="24" y="27" width="16" height="16" rx="3.2" fill="#2d2d2d" stroke="rgba(255,255,255,0.12)" stroke-width="0.53"/><text x="32" y="39" text-anchor="middle" fill="#ffffff" font-family="${fontStack}" font-size="11" font-weight="700">Z</text><text x="48" y="39" fill="${palette.titleText}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.benefit)}</text><rect x="286" y="25.5" width="69" height="19" rx="9.5" fill="url(#hs-tag)" stroke="${palette.tagStroke}" stroke-width="0.4"/><text x="320.5" y="38" text-anchor="middle" fill="${palette.titleText}" font-family="${fontStack}" font-size="11">HighSpeed</text>`;
  const defs = `<defs><linearGradient id="hs-tag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.tagFillTop}"/><stop offset="1" stop-color="${palette.tagFillBottom}"/></linearGradient><linearGradient id="hs-meter" x1="${meterX}" y1="0" x2="${markerX.toFixed(2)}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e05048"/><stop offset="0.52" stop-color="#e8b348"/><stop offset="1" stop-color="#34b769"/></linearGradient></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="${palette.bg}"${palette.cardStroke}/>${titleRow}<text x="32" y="118" fill="${palette.title}" font-family="${fontStack}"><tspan font-size="52" font-weight="500" letter-spacing="-1">${speedup}</tspan><tspan font-size="24" font-weight="500">x</tspan><tspan dx="8" font-size="12" font-weight="300" fill="${palette.subtitle}">${escapeXml(imageLabels.standardSpeed)}</tspan></text><line x1="24" y1="140" x2="412" y2="140" stroke="${palette.divider}" stroke-opacity="0.1"/><path d="M28.7 154 24.6 160.5h3l-1.5 6.5 8-8h-4l1.5-5z" fill="#00a640"/><text x="44" y="165" fill="#00a640" font-family="${fontStack}" font-size="13" font-weight="500">${escapeXml(imageLabels.speedSummary)}</text><text x="412" y="164" text-anchor="end" fill="#00a640" font-family="${fontStack}" font-size="11" font-weight="500">${escapeXml(imageLabels.lessWaiting)}</text>${meter}<text x="24" y="270" fill="${palette.summary}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.imageSummary)}</text></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  // Chromium 的图片剪贴板不接受 image/svg+xml；桌面端必须先光栅化为 PNG。
  if (
    typeof Image === "undefined" ||
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    !URL.createObjectURL
  ) {
    await writeImage(svgBlob);
    return;
  }
  const image = new Image();
  // Bug 根因：过去在 canvas 上再用 clip 裁第二层圆角——SVG 位图边缘（拉伸后模糊）与
  // 矢量 clip 边缘（锐利）在四角叠加，即使几何对齐也会残留浅色弧线错位。圆角透明角
  // 由 SVG rect rx 自带；正确做法是让浏览器按导出尺寸直接光栅化 SVG（矢量超采样，
  // viewBox 保持逻辑坐标），drawImage 1:1 落位，canvas 不做任何二次裁剪。
  const exportScale = Math.max(
    2,
    Math.ceil(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  );
  const objectUrl = URL.createObjectURL(
    new Blob(
      [
        svg.replace(
          `width="${width}" height="${height}" viewBox=`,
          `width="${width * exportScale}" height="${height * exportScale}" viewBox=`,
        ),
      ],
      { type: "image/svg+xml" },
    ),
  );
  try {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = HIGHSPEED_CARD_IMAGE_SIZE.width * exportScale;
        canvas.height = HIGHSPEED_CARD_IMAGE_SIZE.height * exportScale;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("canvas context unavailable"));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("canvas export failed"))),
          "image/png",
        );
      };
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = objectUrl;
    });
    await writeImage(pngBlob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function buildHighspeedShareNotice(params: {
  cardId: string;
  metrics: HighspeedShareMetrics;
  now?: number;
}): GlobalNoticeEnvelope {
  const now = params.now ?? Date.now();
  // 分享卡展示完整 Turn 的实际工作时长；节省时间优先使用 CLI 持久化的高速模型耗时，
  // 普通 provider 的降级/重试耗时不会进入 Highspeed 节省计算。
  // Bug 根因：过去只写 ceil(duration)/round(saved) 的秒级字段，渲染侧由秒重建倍率会在
  // (1.2, ~1.25] 边界带系统性低估（6100ms/1225ms 实际 1.2008x → 8/7≈1.14x）而隐藏 View。
  // 这里原样携带发布门禁使用的毫秒值、不做任何取整，渲染侧复检才不可能与门禁相左（spec §9）。
  const payload: HighspeedShareNoticePayload = {
    cardId: params.cardId,
    tokenUsage: Math.max(0, Math.floor(params.metrics.outputTokens)),
    durationMs: Math.max(0, params.metrics.durationMs),
    savedDurationMs: Math.max(0, resolveHighspeedSavedDurationMs(params.metrics)),
  };
  return {
    noticeId: `highspeed-share:${params.cardId}:${now}`,
    dedupeKey: "highspeed-share:latest",
    type: "highspeed-share",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + HIGHSPEED_NOTICE_AUTO_CLOSE_MS,
    payload,
    actions: [],
    dismissPolicy: { kind: "cooldown", cooldownMs: HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS },
    persistencePolicy: "latest-only",
    source: "highspeed",
    revision: now,
  };
}

export function isHighspeedShareNoticePayload(
  payload: Record<string, unknown>,
): payload is HighspeedShareNoticePayload {
  return (
    typeof payload.cardId === "string" &&
    typeof payload.tokenUsage === "number" &&
    (typeof payload.durationMs === "number" || typeof payload.durationSeconds === "number")
  );
}

/**
 * 由通知 payload 还原分享指标：毫秒字段优先（与发布门禁同精度，复检结果必然一致）；
 * 遗留秒级 payload 按 ×1000 兜底。TPS 只为满足 isHighspeedShareEligible 的正数校验而合成，
 * 倍率与节省比例全部由 durationMs + savedDurationMs 计算，不依赖合成 TPS。
 */
export function resolveHighspeedShareNoticeMetrics(
  payload: HighspeedShareNoticePayload,
): HighspeedShareMetrics {
  const durationMs = payload.durationMs ?? (payload.durationSeconds ?? 0) * 1_000;
  const savedDurationMs = payload.savedDurationMs ?? (payload.savedDurationSeconds ?? 0) * 1_000;
  return {
    outputTokens: payload.tokenUsage,
    durationMs,
    regularTps: Math.max(
      1,
      payload.tokenUsage / Math.max((durationMs + savedDurationMs) / 1_000, 1),
    ),
    highspeedTps: Math.max(1, payload.tokenUsage / Math.max(durationMs / 1_000, 1)),
    savedDurationMs,
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  buildHighspeedShareNotice,
  copyHighspeedCardImage,
  copyHighspeedShareText,
  isHighspeedShareEligible,
  isHighspeedShareNoticePayload,
  resolveHighspeedShareNoticeMetrics,
} from "@/highspeed/highspeedShare.js";

const metrics = { outputTokens: 120_000, durationMs: 600_000, regularTps: 20, highspeedTps: 100 };

describe("highspeed client share", () => {
  it("requires a complete speedup greater than 1.2x before enabling sharing", () => {
    expect(
      isHighspeedShareEligible({
        outputTokens: 100,
        durationMs: 10_000,
        regularTps: 10,
        highspeedTps: 18,
        savedDurationMs: 8_000,
      }),
    ).toBe(true);
    expect(
      isHighspeedShareEligible({
        outputTokens: 100,
        durationMs: 10_000,
        regularTps: 10,
        highspeedTps: 18,
        savedDurationMs: 2_000,
      }),
    ).toBe(false);
    expect(
      isHighspeedShareEligible({
        outputTokens: 100,
        durationMs: 10_000,
        regularTps: 10,
        highspeedTps: 18,
        savedDurationMs: 2_001,
      }),
    ).toBe(true);
  });

  it("rejects missing or invalid share metrics", () => {
    expect(
      isHighspeedShareEligible({
        outputTokens: 0,
        durationMs: 10_000,
        regularTps: 10,
        highspeedTps: 18,
        savedDurationMs: 8_000,
      }),
    ).toBe(false);
    expect(
      isHighspeedShareEligible({
        outputTokens: 100,
        durationMs: 0,
        regularTps: 10,
        highspeedTps: 18,
        savedDurationMs: 8_000,
      }),
    ).toBe(false);
    expect(
      isHighspeedShareEligible({
        outputTokens: 100,
        durationMs: 10_000,
        regularTps: 0,
        highspeedTps: 18,
      }),
    ).toBe(false);
  });

  it("publishes millisecond metrics without a server share id or URL", () => {
    const notice = buildHighspeedShareNotice({ cardId: "hsc_xxx", metrics, now: 100_000 });
    expect(notice.payload).toMatchObject({
      cardId: "hsc_xxx",
      tokenUsage: 120_000,
      durationMs: 600_000,
      savedDurationMs: 1_066_667,
    });
    // 回归锁：payload 不再写秒级取整字段，渲染侧只能从毫秒字段派生展示值（spec §9）。
    expect(notice.payload).not.toHaveProperty("durationSeconds");
    expect(notice.payload).not.toHaveProperty("savedDurationSeconds");
    expect(notice.payload).not.toHaveProperty("shareId");
    expect(notice.payload).not.toHaveProperty("shareUrl");
  });

  it("keeps boundary speedups eligible after a publish/render round trip", () => {
    // Bug 回归：6100ms/1225ms 实际倍率 7325/6100≈1.2008 > 1.2 而发布；旧 payload 只带
    // ceil(duration)=7s / round(saved)=1s，渲染侧重建为 8/7≈1.14 ≤ 1.2 便隐藏了 View。
    const boundary = {
      outputTokens: 1_000,
      durationMs: 6_100,
      regularTps: 10,
      highspeedTps: 18,
      savedDurationMs: 1_225,
    };
    expect(isHighspeedShareEligible(boundary)).toBe(true);
    const notice = buildHighspeedShareNotice({ cardId: "hsc_edge", metrics: boundary, now: 1 });
    const payload = notice.payload;
    if (!isHighspeedShareNoticePayload(payload)) throw new Error("payload shape changed");
    const rebuilt = resolveHighspeedShareNoticeMetrics(payload);
    expect(rebuilt).toMatchObject({
      outputTokens: 1_000,
      durationMs: 6_100,
      savedDurationMs: 1_225,
    });
    expect(isHighspeedShareEligible(rebuilt)).toBe(true);
  });

  it("reads legacy second-precision payloads by scaling back to milliseconds", () => {
    const rebuilt = resolveHighspeedShareNoticeMetrics({
      cardId: "hsc_legacy",
      tokenUsage: 120_000,
      durationSeconds: 600,
      savedDurationSeconds: 480,
    });
    expect(rebuilt).toMatchObject({
      outputTokens: 120_000,
      durationMs: 600_000,
      savedDurationMs: 480_000,
    });
    expect(isHighspeedShareEligible(rebuilt)).toBe(true);
  });

  it("copies an image blob containing only the metric card", async () => {
    let copied: Blob | undefined;
    await copyHighspeedCardImage(metrics, async (blob) => {
      copied = blob;
    });
    expect(copied?.type).toBe("image/svg+xml");
    expect(await copied?.text()).toContain("120,000 tokens");
    expect(await copied?.text()).not.toContain("Copy image");
  });

  it("uses localized labels when copying the image", async () => {
    let copied: Blob | undefined;
    await copyHighspeedCardImage(
      metrics,
      async (blob) => {
        copied = blob;
      },
      {
        benefit: "ZCode 与 Coding Plan 专属权益",
        standardSpeed: "标准生成速度",
        speedSummary: "HighSpeed · 20 分钟",
        lessWaiting: "减少等待 80%",
        imageSummary: "120,000 tokens · 节省 1,067 秒",
      },
    );
    const svg = await copied?.text();
    expect(svg).toContain("标准生成速度");
    expect(svg).toContain("减少等待 80%");
    expect(svg).toContain("节省 1,067 秒");
    expect(svg).not.toContain("standard generation speed");
  });

  it("copies the complete share text", async () => {
    let copied = "";
    await copyHighspeedShareText(
      "我用 ZCode 高速卡节省了 120 秒的时间，你也来试试吧。下载 ZCode https://zcode.z.ai",
      async (text) => {
        copied = text;
      },
    );
    expect(copied).toBe(
      "我用 ZCode 高速卡节省了 120 秒的时间，你也来试试吧。下载 ZCode https://zcode.z.ai",
    );
  });

  it("rasterizes the SVG before writing it to the image clipboard", async () => {
    const originalImage = globalThis.Image;
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const onload = vi.fn();
    let rasterSource: Blob | undefined;
    const canvasContext = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
    };
    Object.assign(globalThis, {
      Image: class {
        set src(_value: string) {
          onload();
          (this as { onload?: () => void }).onload?.();
        }
        onload?: () => void;
      },
      document: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => canvasContext,
          toBlob: (callback: (blob: Blob) => void) =>
            callback(new Blob(["png"], { type: "image/png" })),
        }),
      },
    });
    URL.createObjectURL = vi.fn((blob: Blob) => {
      rasterSource = blob;
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    try {
      let copied: Blob | undefined;
      await copyHighspeedCardImage(metrics, async (blob) => {
        copied = blob;
      });
      expect(copied?.type).toBe("image/png");
      expect(onload).toHaveBeenCalled();
      // 回归：canvas 禁止再做二次圆角裁剪——SVG 位图边缘与矢量 clip 边缘叠加会在
      // 四角残留浅色弧线错位；圆角透明角只能由 SVG rect rx 自带。
      expect(canvasContext.clip).not.toHaveBeenCalled();
      // 回归：光栅化 SVG 必须按超采样尺寸（jsdom 无 devicePixelRatio，兜底 2x）
      // 直接光栅化，viewBox 保持逻辑坐标，避免位图拉伸导致边缘模糊。
      const rasterSvg = await rasterSource?.text();
      expect(rasterSvg).toContain('width="872" height="608" viewBox="0 0 436 304"');
      // 回归：导出 PNG 必须是满幅矩形——自带透明圆角会在粘贴环境（聊天工具的圆角
      // 图片容器）内再叠一层圆角，两层半径不一致时四角露出容器背景色形成浅色弧线。
      // 圆角统一交给展示环境裁剪。
      expect(rasterSvg).not.toContain('rx="20"');
    } finally {
      Object.assign(globalThis, { Image: originalImage, document: originalDocument });
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

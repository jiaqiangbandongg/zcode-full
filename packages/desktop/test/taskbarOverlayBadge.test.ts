import { describe, expect, it, vi } from "vitest";
import {
  applyTaskbarOverlayToWindows,
  blendBadgeIntoBitmap,
  createWindowsTaskbarOverlayApplier,
  renderTaskbarBadgePixels,
  renderTaskbarStatusDotPixels,
  TASKBAR_BADGE_IMAGE_SIZE,
} from "../src/main/unreadBadge.js";
import type { TaskbarOverlayWindow } from "../src/main/unreadBadge.js";

const CIRCLE_RED_BGRA = [53, 57, 229, 255];
const WHITE_BGRA = [255, 255, 255, 255];

function pixelAt(pixels: Uint8Array, x: number, y: number): number[] {
  const offset = (y * TASKBAR_BADGE_IMAGE_SIZE + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function isWhitePixel(bgra: number[]): boolean {
  return bgra.every((value) => value === 255);
}

function countWhitePixels(pixels: Uint8Array): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (
      pixels[offset] === 255 &&
      pixels[offset + 1] === 255 &&
      pixels[offset + 2] === 255 &&
      pixels[offset + 3] === 255
    ) {
      count += 1;
    }
  }
  return count;
}

function createFakeWindow(options: { destroyed?: boolean } = {}): TaskbarOverlayWindow & {
  overlays: Array<{ image: unknown; description: string }>;
} {
  const overlays: Array<{ image: unknown; description: string }> = [];
  return {
    isDestroyed: () => Boolean(options.destroyed),
    setOverlayIcon: (image, description) => {
      overlays.push({ image, description });
    },
    overlays,
  };
}

describe("windows taskbar overlay badge", () => {
  describe("renderTaskbarBadgePixels", () => {
    it("输出 32×32 BGRA 缓冲区", () => {
      const pixels = renderTaskbarBadgePixels("1");
      expect(pixels).toBeInstanceOf(Uint8Array);
      expect(pixels.length).toBe(TASKBAR_BADGE_IMAGE_SIZE * TASKBAR_BADGE_IMAGE_SIZE * 4);
    });

    it("圆内空白处是预乘 BGRA 的红色，数字笔画处是白色", () => {
      const pixels = renderTaskbarBadgePixels("1");
      // 圆心 (15.5, 15.5) 半径 15：(16,16) 落在数字 1 的笔画上（白），(4,16) 只落在圆上（红）。
      expect(pixelAt(pixels, 16, 16)).toEqual(WHITE_BGRA);
      expect(pixelAt(pixels, 4, 16)).toEqual(CIRCLE_RED_BGRA);
    });

    it("圆外完全透明（预乘后全 0），保证任务栏图标不被遮挡", () => {
      const pixels = renderTaskbarBadgePixels("1");
      expect(pixelAt(pixels, 0, 0)).toEqual([0, 0, 0, 0]);
    });

    it("画布四周留透明边距，气泡本体只占约 3/4，避免任务栏观感过大", () => {
      const pixels = renderTaskbarBadgePixels("1");
      // 半径 12：画布边缘 2px 内是透明边距，向内一步就是红色圆面。
      expect(pixelAt(pixels, 16, 2)).toEqual([0, 0, 0, 0]);
      expect(pixelAt(pixels, 16, 4)).toEqual(CIRCLE_RED_BGRA);
      expect(pixelAt(pixels, 2, 16)).toEqual([0, 0, 0, 0]);
    });

    it("任务栏红点锚定画布右下角（overlay 整图铺图标右下区域，居中会悬在图标中部）", () => {
      const pixels = renderTaskbarBadgePixels("9+", {
        size: 32,
        padding: 8,
        dot: true,
        anchor: "bottom-right",
      });
      const at = (x: number, y: number): number[] => {
        const offset = (y * 32 + x) * 4;
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
      };
      // radius=(32-16)/2-1=7，圆心 (24,24)：右下区域是红点，左上与画布最外角为空
      expect(at(24, 24)).toEqual([53, 57, 229, 255]);
      expect(at(31, 31)).toEqual([0, 0, 0, 0]);
      expect(at(8, 8)).toEqual([0, 0, 0, 0]);
    });

    it("红点模式只画纯色圆，不渲染数字（托盘 16px 下数字不可读）", () => {
      const pixels = renderTaskbarBadgePixels("9+", { size: 14, glyphScale: 1, padding: 0, dot: true });
      const at = (x: number, y: number): number[] => {
        const offset = (y * 14 + x) * 4;
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
      };
      // 圆心与圆面都是红色，无任何白色笔画像素
      expect(at(7, 7)).toEqual(CIRCLE_RED_BGRA);
      expect(countWhitePixels(pixels)).toBe(0);
    });

    it("每个数字字形都有可见像素，未知字符不产生字形", () => {
      for (const label of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+"]) {
        expect(countWhitePixels(renderTaskbarBadgePixels(label)), `label ${label}`).toBeGreaterThan(
          0,
        );
      }

      const empty = renderTaskbarBadgePixels("");
      expect(empty.every((value) => value === 0)).toBe(true);
    });

    it("两位折叠文案 9+ 的两个字形都可见", () => {
      const pixels = renderTaskbarBadgePixels("9+");
      // 9+ 总宽 22，原点在 x=5：(8,16) 命中 "9" 的竖笔，(22,16) 命中 "+" 的横笔。
      expect(isWhitePixel(pixelAt(pixels, 8, 16))).toBe(true);
      expect(isWhitePixel(pixelAt(pixels, 22, 16))).toBe(true);
    });
  });

  describe("renderTaskbarStatusDotPixels", () => {
    it("输出 Windows 原生 16px overlay 表示，并用半透明像素抗锯齿", () => {
      const pixels = renderTaskbarStatusDotPixels(1);
      expect(pixels.length).toBe(16 * 16 * 4);
      let antialiasedPixels = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset]!;
        if (alpha > 0 && alpha < 255) antialiasedPixels += 1;
      }
      expect(antialiasedPixels).toBeGreaterThan(0);
    });

    it("Win11：红点在 overlay 画布内居中，避免 Shell 二次偏移", () => {
      const pixels = renderTaskbarStatusDotPixels(1, "windows-11");
      const at = (x: number, y: number): number[] => {
        const offset = (y * 16 + x) * 4;
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
      };
      expect(at(8, 8)).toEqual(CIRCLE_RED_BGRA);
      expect(at(5, 8)).toEqual(CIRCLE_RED_BGRA);
      // 左右/上下边缘对称抗锯齿，证明画布内居中
      expect(at(4, 8)).toEqual([27, 29, 115, 128]);
      expect(at(11, 8)).toEqual([27, 29, 115, 128]);
      expect(at(8, 11)).toEqual([27, 29, 115, 128]);
      expect(at(0, 0)).toEqual([0, 0, 0, 0]);
      expect(at(15, 15)).toEqual([0, 0, 0, 0]);
    });

    it("Win10：红点在 overlay 画布内右下锚定，补偿旧任务栏的落点", () => {
      const pixels = renderTaskbarStatusDotPixels(1, "windows-10");
      const at = (x: number, y: number): number[] => {
        const offset = (y * 16 + x) * 4;
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
      };
      expect(at(11, 11)).toEqual(CIRCLE_RED_BGRA);
      expect(at(8, 11)).toEqual(CIRCLE_RED_BGRA);
      expect(at(7, 11)).toEqual([13, 14, 57, 64]);
      expect(at(15, 15)).toEqual([0, 0, 0, 0]);
      // Win10 与 Win11 必须是两套不同圆心，不能退化成同一折中坐标
      expect(at(8, 8)).not.toEqual(CIRCLE_RED_BGRA);
    });

    it("2x 高 DPI 表示尺寸为 32px，两种布局均按比例扩展", () => {
      for (const [layout, center] of [
        ["windows-11", 16],
        ["windows-10", 22],
      ] as const) {
        const pixels = renderTaskbarStatusDotPixels(2, layout);
        expect(pixels.length).toBe(32 * 32 * 4);
        const centerOffset = (center * 32 + center) * 4;
        expect(Array.from(pixels.slice(centerOffset, centerOffset + 4))).toEqual(CIRCLE_RED_BGRA);
        expect(Array.from(pixels.slice(0, 4))).toEqual([0, 0, 0, 0]);
      }
    });
  });

  describe("applyTaskbarOverlayToWindows", () => {
    it("把角标图和描述同步到所有存活窗口", () => {
      const winA = createFakeWindow();
      const winB = createFakeWindow();
      const image = { __badge: true };

      applyTaskbarOverlayToWindows({
        label: "3",
        windows: [winA, winB],
        badgeImageForLabel: () => image,
      });

      expect(winA.overlays).toEqual([{ image, description: "3 unread tasks" }]);
      expect(winB.overlays).toEqual([{ image, description: "3 unread tasks" }]);
    });

    it("label 为 null 时清除 overlay 且不生成徽章图", () => {
      const win = createFakeWindow();
      const badgeImageForLabel = vi.fn();

      applyTaskbarOverlayToWindows({
        label: null,
        windows: [win],
        badgeImageForLabel,
      });

      expect(win.overlays).toEqual([{ image: null, description: "" }]);
      expect(badgeImageForLabel).not.toHaveBeenCalled();
    });

    it("跳过已销毁的窗口", () => {
      const alive = createFakeWindow();
      const destroyed = createFakeWindow({ destroyed: true });

      applyTaskbarOverlayToWindows({
        label: "1",
        windows: [destroyed, alive],
        badgeImageForLabel: () => ({ __badge: true }),
      });

      expect(destroyed.overlays).toHaveLength(0);
      expect(alive.overlays).toHaveLength(1);
    });
  });

  describe("createWindowsTaskbarOverlayApplier", () => {
    it("遍历注入的全部窗口并按 label 缓存徽章图", () => {
      const winA = createFakeWindow();
      const winB = createFakeWindow();
      const createBadgeImage = vi.fn(() => ({ __badge: true }));
      const applier = createWindowsTaskbarOverlayApplier({
        getAllWindows: () => [winA, winB],
        createBadgeImage,
      });

      applier("2");
      applier("2");

      expect(createBadgeImage).toHaveBeenCalledTimes(1);
      expect(createBadgeImage).toHaveBeenCalledWith("2");
      const expectedImage = { __badge: true };
      expect(winA.overlays).toEqual([
        { image: expectedImage, description: "2 unread tasks" },
        { image: expectedImage, description: "2 unread tasks" },
      ]);
      expect(winB.overlays).toHaveLength(2);
    });

    it("label 为 null 时对所有窗口下发 null 清除角标", () => {
      const win = createFakeWindow();
      const applier = createWindowsTaskbarOverlayApplier({
        getAllWindows: () => [win],
        createBadgeImage: vi.fn(),
      });

      applier(null);

      expect(win.overlays).toEqual([{ image: null, description: "" }]);
    });
  });

  describe("blendBadgeIntoBitmap", () => {
    const SIZE = 4;

    function fillBase(): Uint8Array {
      // 4×4 不透明蓝底（预乘 BGRA：B=200, G=40, R=10, A=255）
      const base = new Uint8Array(SIZE * SIZE * 4);
      for (let offset = 0; offset < base.length; offset += 4) {
        base[offset] = 200;
        base[offset + 1] = 40;
        base[offset + 2] = 10;
        base[offset + 3] = 255;
      }
      return base;
    }

    function solidBadge(value: { b: number; g: number; r: number; a: number }): Uint8Array {
      const badge = new Uint8Array(2 * 2 * 4);
      for (let offset = 0; offset < badge.length; offset += 4) {
        badge[offset] = value.b;
        badge[offset + 1] = value.g;
        badge[offset + 2] = value.r;
        badge[offset + 3] = value.a;
      }
      return badge;
    }

    function pixel(buffer: Uint8Array, x: number, y: number): number[] {
      const offset = (y * SIZE + x) * 4;
      return [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!];
    }

    it("不透明徽章完全覆盖目标区域，其余像素不受影响", () => {
      const base = fillBase();
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge: solidBadge({ b: 1, g: 2, r: 3, a: 255 }),
        badgeSize: 2,
        originX: 2,
        originY: 2,
      });

      expect(pixel(base, 2, 2)).toEqual([1, 2, 3, 255]);
      expect(pixel(base, 3, 3)).toEqual([1, 2, 3, 255]);
      expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
      expect(pixel(base, 1, 1)).toEqual([200, 40, 10, 255]);
    });

    it("半透明徽章按预乘 alpha 混合：out = src + dst × (1 - srcA)", () => {
      const base = fillBase();
      // srcA = 128 → keep ≈ 0.498；out.b = 100 + 200 × 0.498039 ≈ 200（四舍五入）
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge: solidBadge({ b: 100, g: 0, r: 0, a: 128 }),
        badgeSize: 2,
        originX: 0,
        originY: 0,
      });

      const [b, g, r, a] = pixel(base, 0, 0);
      expect(a).toBe(255);
      expect(b).toBe(Math.round(100 + 200 * ((255 - 128) / 255)));
      expect(g).toBe(Math.round(0 + 40 * ((255 - 128) / 255)));
      expect(r).toBe(Math.round(0 + 10 * ((255 - 128) / 255)));
    });

    it("徽章透明像素（a=0）不改动底图，越界区域安全裁剪", () => {
      const base = fillBase();
      const badge = new Uint8Array(2 * 2 * 4); // 全透明
      badge[3] = 0;
      blendBadgeIntoBitmap({
        base,
        size: SIZE,
        badge,
        badgeSize: 2,
        originX: 3,
        originY: 3, // 2×2 徽章只有 (3,3) 落在画布内，(4,3)(3,4)(4,4) 越界
      });

      expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
      expect(pixel(base, 3, 3)).toEqual([200, 40, 10, 255]);
    });
  });
});

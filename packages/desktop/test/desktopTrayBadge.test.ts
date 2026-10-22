import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const trayInstances: Array<{
    imageAtCreate: string;
    images: unknown[];
    tooltips: string[];
  }> = [];
  const representations: Array<{
    scaleFactor: number;
    width: number;
    height: number;
    buffer: Buffer;
  }> = [];
  let baseImageCounter = 0;

  const createBaseBuffer = (size: number) => {
    // 不透明蓝底（预乘 BGRA），模拟托盘底图的 1x / 2x 表示
    const buffer = Buffer.alloc(size * size * 4);
    for (let offset = 0; offset < buffer.length; offset += 4) {
      buffer[offset] = 200;
      buffer[offset + 1] = 40;
      buffer[offset + 2] = 10;
      buffer[offset + 3] = 255;
    }
    return buffer;
  };
  const baseBuffer16 = createBaseBuffer(16);
  const baseBuffer32 = createBaseBuffer(32);

  const fakeBaseImage = () => ({
    __baseImage: ++baseImageCounter,
    isEmpty: () => false,
    resize: ({ width }: { width: number }) => ({
      toBitmap: () => (width === 16 ? baseBuffer16 : baseBuffer32),
    }),
  });

  return {
    trayInstances,
    representations,
    baseBuffer16,
    baseBuffer32,
    fakeBaseImage,
    resetBaseImageCounter: () => {
      baseImageCounter = 0;
    },
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
  Tray: class {
    images: unknown[] = [];
    tooltips: string[] = [];
    constructor(imagePath: string) {
      state.trayInstances.push({ imageAtCreate: imagePath, images: this.images, tooltips: this.tooltips });
    }
    setImage(image: unknown) {
      this.images.push(image);
    }
    setToolTip(tooltip: string) {
      this.tooltips.push(tooltip);
    }
    setContextMenu() {}
    on() {}
  },
  nativeImage: {
    createFromPath: () => state.fakeBaseImage(),
    createEmpty: () => ({
      __composed: true,
      addRepresentation: (representation: {
        scaleFactor: number;
        width: number;
        height: number;
        buffer: Buffer;
      }) => state.representations.push(representation),
    }),
  },
}));

describe("desktop tray unread badge", () => {
  beforeEach(() => {
    vi.resetModules();
    state.trayInstances.length = 0;
    state.representations.length = 0;
    state.resetBaseImageCounter();
  });

  async function loadModule() {
    return import("../src/main/desktopTray.js");
  }

  const trayOptions = {
    getLocale: () => "zh-CN" as const,
    showCurrentWindow: () => {},
    executeDesktopCommand: async () => {},
    quitApp: () => {},
    logger: { warn: vi.fn() },
  };

  function pixelOf(buffer: Buffer, size: number, x: number, y: number): number[] {
    const offset = (y * size + x) * 4;
    return [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!];
  }

  it("没有托盘时 no-op 不抛错", async () => {
    const { applyDesktopTrayUnreadBadge } = await loadModule();

    expect(() => applyDesktopTrayUnreadBadge(3)).not.toThrow();
    expect(state.trayInstances).toHaveLength(0);
  });

  it("计数非零时在 Logo 圆角透明缺口合成红点，按 label 缓存", async () => {
    const mod = await loadModule();
    mod.createDesktopTray({ ...trayOptions, platform: "win32" });
    expect(state.trayInstances).toHaveLength(1);

    mod.applyDesktopTrayUnreadBadge(3);
    mod.applyDesktopTrayUnreadBadge(3);

    // 同一 label 只合成一次（缓存的 NativeImage 含 1x/2x 两份表示）
    expect(state.representations).toHaveLength(2);
    expect(state.representations.map(({ scaleFactor, width, height }) => ({
      scaleFactor,
      width,
      height,
    }))).toEqual([
      { scaleFactor: 1, width: 16, height: 16 },
      { scaleFactor: 2, width: 32, height: 32 },
    ]);
    // 创建时 + 两次换图
    const images = state.trayInstances[0]!.images;
    expect(images).toHaveLength(2);

    const oneX = state.representations[0]!.buffer;
    const twoX = state.representations[1]!.buffer;
    // 1x / 2x 都有纯红芯，且抗锯齿边缘与底图混合（不是硬边纯红或原底图）
    expect(pixelOf(oneX, 16, 13, 2)).toEqual([53, 57, 229, 255]);
    expect(pixelOf(twoX, 32, 27, 4)).toEqual([53, 57, 229, 255]);
    expect(pixelOf(twoX, 32, 23, 4)).not.toEqual([200, 40, 10, 255]);
    expect(pixelOf(twoX, 32, 23, 4)).not.toEqual([53, 57, 229, 255]);
    // Logo 本体与远离红点的底图保持不变
    expect(pixelOf(oneX, 16, 8, 8)).toEqual([200, 40, 10, 255]);
    expect(pixelOf(twoX, 32, 16, 16)).toEqual([200, 40, 10, 255]);
    // 整图不应出现白色笔画像素
    for (const buffer of [oneX, twoX]) {
      let hasWhitePixel = false;
      for (let offset = 0; offset + 3 < buffer.length; offset += 4) {
        if (
          buffer[offset] === 255 &&
          buffer[offset + 1] === 255 &&
          buffer[offset + 2] === 255 &&
          buffer[offset + 3] === 255
        ) {
          hasWhitePixel = true;
          break;
        }
      }
      expect(hasWhitePixel).toBe(false);
    }
  });

  it("计数归零时恢复原始托盘底图", async () => {
    const mod = await loadModule();
    mod.createDesktopTray({ ...trayOptions, platform: "win32" });

    mod.applyDesktopTrayUnreadBadge(3);
    mod.applyDesktopTrayUnreadBadge(0);

    const images = state.trayInstances[0]!.images;
    expect(images).toHaveLength(2);
    // 恢复的图就是 createFromPath 返回的底图对象本身
    expect(images[1]).toMatchObject({ __baseImage: 1 });
  });

  it("linux 平台托盘同样生效", async () => {
    const mod = await loadModule();
    mod.createDesktopTray({ ...trayOptions, platform: "linux" });

    mod.applyDesktopTrayUnreadBadge(1);

    expect(state.representations).toHaveLength(2);
  });
});

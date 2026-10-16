import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIGHSPEED_DIFFUSION_DURATION_MS,
  HIGHSPEED_MODEL_SWITCH_START_PROGRESS,
  parseHighSpeedCanvasColor,
  resolveHighSpeedCanvasColor,
  resolveHighSpeedDiffusionDistance,
  resolveHighSpeedDiffusionProgress,
  shouldCompleteHighSpeedDiffusion,
  shouldStartHighSpeedModelSwitch,
} from "@/v4/highspeed/highSpeedDiffusion.js";

/** 模拟 Canvas fillStyle：可解析颜色规范化为 `#rrggbb`，无法解析的值静默忽略并保留旧值。 */
function createFakeCanvasContext(): Pick<CanvasRenderingContext2D, "fillStyle"> {
  const named: Record<string, string> = { black: "#000000", white: "#ffffff" };
  let current = "#000000";
  return {
    get fillStyle() {
      return current;
    },
    set fillStyle(value) {
      if (typeof value !== "string") return;
      const color = value.trim().toLowerCase();
      const short = color.match(/^#([\da-f])([\da-f])([\da-f])$/);
      if (named[color]) current = named[color];
      else if (short)
        current = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
      else if (/^#[\da-f]{6}$/.test(color)) current = color;
    },
  };
}

describe("Highspeed activation visual", () => {
  it("keeps the composer surface light in light themes and dark in dark themes", () => {
    const styles = readFileSync("packages/ui/src/highspeed/highspeed-activation.css", "utf8");

    expect(styles).toContain("--color-highspeed-composer-surface: #ffffff;");
    expect(styles).not.toContain("--color-highspeed-composer-surface: var(--color-input);");
    expect(styles).toMatch(
      /\.dark,\s*\.theme-zai-dark[\s\S]*--color-highspeed-composer-surface: #151515;/,
    );
  });

  it("扩散画布能解析生产压缩后的颜色 token，浅色马赛克底色不回退深色", () => {
    // 回归：生产构建的 Lightning CSS 把 `#ffffff` 压缩为 `#fff`，旧解析只认 6 位 hex，
    // 浅色主题的扩散画布因此落回深色兜底 [21, 21, 21]，马赛克中心显示为黑色。
    expect(parseHighSpeedCanvasColor("#fff")).toEqual([255, 255, 255]);
    expect(parseHighSpeedCanvasColor("#ffffff")).toEqual([255, 255, 255]);
    expect(parseHighSpeedCanvasColor("#151515")).toEqual([21, 21, 21]);
    expect(parseHighSpeedCanvasColor("#9E77ED")).toEqual([158, 119, 237]);
    expect(parseHighSpeedCanvasColor("#7453b0c2")).toEqual([116, 83, 176]);
    expect(parseHighSpeedCanvasColor("rgba(116, 83, 176, 0.76)")).toEqual([116, 83, 176]);
    // 空值或无法按 sRGB 通道读取的颜色交给调用方兜底，不能把 oklch() 分量误读为 RGB。
    expect(parseHighSpeedCanvasColor("")).toBeNull();
    expect(parseHighSpeedCanvasColor("oklch(0.99 0 0)")).toBeNull();

    const canvas = readFileSync(
      "packages/ui/src/v4/highspeed/HighSpeedDiffusionCanvas.tsx",
      "utf8",
    );
    expect(canvas).toContain("resolveHighSpeedCanvasColor");
  });

  it("Canvas 无法解析的颜色 token 回退兜底色，不沿用上一次的 fillStyle", () => {
    // 回归：CSS.supports 接受 var() 等 Canvas 不认的写法；Canvas 赋值时会静默忽略并保留旧值，
    // 曾让 surface 读成默认黑、accent 读成 surface 色（紫色波纹消失），而不是走兜底色。
    const context = createFakeCanvasContext();
    const fallback = [21, 21, 21] as const;

    expect(resolveHighSpeedCanvasColor(context, "#fff", fallback)).toEqual([255, 255, 255]);
    expect(resolveHighSpeedCanvasColor(context, "white", fallback)).toEqual([255, 255, 255]);
    expect(resolveHighSpeedCanvasColor(context, "var(--color-input)", fallback)).toEqual(fallback);
    expect(resolveHighSpeedCanvasColor(context, "  ", fallback)).toEqual(fallback);
    // 与哨兵同色的合法值不能被误判为“被忽略”。
    expect(resolveHighSpeedCanvasColor(context, "#000000", fallback)).toEqual([0, 0, 0]);
    expect(resolveHighSpeedCanvasColor(context, "#ffffff", fallback)).toEqual([255, 255, 255]);
  });

  it("激活前把输入壳描边锚定为 transparent，避免过渡期闪出 currentColor 白边", () => {
    // 回归：Tailwind v4 下 .chat-composer-input-surface 未声明 border-color 时兜底为 currentColor
    // （深色前景近白色）。若不锚定，highspeed 激活时 border-color 会从该近白色过渡到 transparent，
    // 闪出一圈白边。断言 CSS 显式把描边锚定为 transparent 作为过渡起点。
    const styles = readFileSync("packages/ui/src/highspeed/highspeed-activation.css", "utf8");

    expect(styles).toMatch(
      /\.chat-composer-input-surface\s*\{\s*border-color:\s*transparent;\s*\}/,
    );
  });

  it("切换瞬间内层壳背景瞬时切换，避免方角随背景淡出闪现", () => {
    // 回归：内层壳激活时 !rounded-none 瞬时、!bg-transparent 走 transition-colors 渐变，
    // 会在切换一瞬露出仍带背景色的方角。highspeed 的 shellClassName 必须带 !transition-none，
    // 让背景瞬时切透明，切换瞬间不再露方角。
    const composer = readFileSync("packages/ui/src/v4/ConversationComposer.tsx", "utf8");
    const shell = composer.slice(
      composer.indexOf("shellClassName={"),
      composer.indexOf("onChange={handleEditorChange}"),
    );

    expect(shell).toContain("!rounded-none");
    expect(shell).toContain("!bg-transparent");
    expect(shell).toContain("!transition-none");
  });

  it("恢复入场关闭输入壳过渡和倒计时入场关键帧，避免切回 Task 时动效重播", () => {
    // 回归：composer 跨 Task 复用同一实例，切回时 highspeed 类名加在已有输入壳上会重新触发
    // 描边/辉光的 transition；倒计时重新挂载也会重播入场关键帧。
    const styles = readFileSync("packages/ui/src/highspeed/highspeed-activation.css", "utf8");
    const composer = readFileSync("packages/ui/src/v4/ConversationComposer.tsx", "utf8");

    expect(styles).toMatch(
      /\.highspeed-composer-surface\[data-highspeed-entrance="restore"\]\s*\{\s*transition:\s*none;\s*\}/,
    );
    // 死选择器回归：全仓库无任何元素设置 data-chat-input-placeholder，相关规则一律不得回流。
    expect(styles).not.toContain("data-chat-input-placeholder");
    expect(styles).toMatch(
      /\.highspeed-composer-surface\[data-highspeed-entrance="restore"\] \.highspeed-inline-countdown\s*\{\s*animation:\s*none;\s*\}/,
    );
    expect(composer).toContain("data-highspeed-entrance=");
    expect(composer).toContain("useHighspeedComposerEntrance");
  });

  it("uses a responsive center-out diffusion timeline", () => {
    expect(HIGHSPEED_DIFFUSION_DURATION_MS).toBe(1_400);
    expect(resolveHighSpeedDiffusionProgress(700)).toBe(0.5);
    expect(resolveHighSpeedDiffusionProgress(1_500)).toBe(1);
    expect(shouldStartHighSpeedModelSwitch(HIGHSPEED_MODEL_SWITCH_START_PROGRESS)).toBe(true);
    expect(shouldCompleteHighSpeedDiffusion(0.84)).toBe(true);

    expect(resolveHighSpeedDiffusionDistance({ x: 350, y: 52, width: 700, height: 104 })).toBe(0);
    expect(
      resolveHighSpeedDiffusionDistance({ x: 700, y: 52, width: 700, height: 104 }),
    ).toBeCloseTo(1, 4);
  });

  it("keeps the migrated effect presentation-only", () => {
    const composer = readFileSync("packages/ui/src/v4/ConversationComposer.tsx", "utf8");
    const toolbar = readFileSync("packages/ui/src/v4/composer/V4ComposerToolbar.tsx", "utf8");
    const modelSelect = readFileSync("packages/ui/src/ModelConfigSelect.tsx", "utf8");
    const visual = readFileSync("packages/ui/src/highspeed/HighspeedActivationVisual.tsx", "utf8");

    expect(composer).toContain("HighspeedComposerBackground");
    expect(composer).toContain('highspeedCard && "highspeed-composer-surface"');
    expect(composer).not.toContain('highspeedCard && "highspeed-composer-surface overflow-hidden"');
    expect(visual).toContain("overflow-hidden rounded-[inherit]");
    expect(composer).toContain("highspeedCard?.cardId");
    expect(composer).not.toContain("beginHighSpeedActivation");
    expect(visual).toContain('type HighspeedVisualPhase = "diffusing" | "handoff" | "stable"');
    expect(visual).not.toContain("sendText");
    expect(visual).not.toContain("drawHighspeedCard");
    expect(toolbar).not.toContain("highspeedActive?: boolean");
    expect(toolbar).toContain("<HighspeedModelIndicator");
    expect(toolbar).toContain("highspeedPresented && highspeedModel");
    expect(existsSync("packages/ui/src/highspeed/HighspeedModelIndicator.tsx")).toBe(true);
    expect(modelSelect).not.toContain("triggerRollingLeadingIcon");
    expect(modelSelect).not.toContain("triggerLabelRollDirection");
    expect(modelSelect).not.toContain("triggerLabelContentClassName");
    expect(existsSync("packages/ui/src/highspeed/HighspeedBadge.tsx")).toBe(false);
  });

  it("倒计时只渲染一层清晰文字，不叠加外发光", () => {
    const toolbar = readFileSync("packages/ui/src/v4/composer/V4ComposerToolbar.tsx", "utf8");
    const countdown = toolbar.slice(
      toolbar.indexOf('data-highspeed-countdown="true"'),
      toolbar.indexOf("export interface ModelSelectionSource"),
    );

    expect(countdown).not.toContain("blur-[");
    expect(countdown.match(/\{remainingTime\}/g)).toHaveLength(1);
  });

  it("reuses pre-rendered particle sprites instead of blurring every animation frame", () => {
    const particles = readFileSync("packages/ui/src/components/ui/floating-particles.tsx", "utf8");
    const drawFrame = particles.slice(
      particles.indexOf("const draw = (now: number)"),
      particles.indexOf("const observer = new ResizeObserver"),
    );

    expect(particles).toContain("createParticleSprite");
    expect(drawFrame).toContain("context.drawImage");
    expect(drawFrame).not.toContain("context.shadowBlur");
    expect(drawFrame).not.toContain("context.arc");
  });
});

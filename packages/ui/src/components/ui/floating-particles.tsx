import { memo, useEffect, useRef } from "react";
import { cn } from "@/components/lib/utils.js";

const PARTICLE_COUNT = 96;
const PARTICLE_FRAME_INTERVAL_MS = 1_000 / 30;
const PARTICLE_SPRITE_SIZE = 24;
const PARTICLE_RADIUS = 1;
const HIGHLIGHT_PARTICLE_RADIUS = 1.5;
const HIGHLIGHT_PARTICLE_BLUR = 7;
// 高亮 index 按 seeded startLeft 选取，横向覆盖约 8%–92%，避免亮点集中在同一区域。
const HIGHLIGHT_PARTICLE_INDICES = new Set([1, 22, 42, 56, 57, 74, 90]);
// 超过最大相位偏移 2.6s + 最长周期 11.2s，粒子直接处于循环稳态，不再从空场逐个冒出。
const PARTICLE_SETTLED_ELAPSED_MS = 14_000;

interface FloatingParticle {
  cycleDuration: number;
  highlight: boolean;
  horizontalDrift: number;
  opacity: number;
  phaseOffset: number;
  riseDistance: number;
  startLeft: number;
  startTop: number;
  swayDistance: number;
}

function seededUnit(index: number, salt: number) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

const PARTICLES: FloatingParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, index) => {
  const highlight = HIGHLIGHT_PARTICLE_INDICES.has(index);
  return {
    startTop: 94 + seededUnit(index, 1) * 6,
    startLeft: seededUnit(index, 2) * 100,
    riseDistance: 72 + seededUnit(index, 3) * 64,
    horizontalDrift: seededUnit(index, 4) * 36 - 18,
    swayDistance: seededUnit(index, 5) * 16 - 8,
    opacity: highlight ? 0.82 + seededUnit(index, 6) * 0.16 : 0.4 + seededUnit(index, 6) * 0.32,
    cycleDuration: 6.4 + seededUnit(index, 7) * 4.8,
    phaseOffset: seededUnit(index, 8) * 2.6,
    highlight,
  };
});

const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;

function interpolateParticleChannel(progress: number, values: readonly number[]): number {
  const times = [0, 0.12, 0.38, 0.7, 1];
  const nextIndex = times.findIndex((time) => time > progress);
  const segment = Math.max(0, Math.min(times.length - 2, nextIndex - 1));
  const start = times[segment] ?? 0;
  const end = times[segment + 1] ?? 1;
  return lerp(
    values[segment] ?? 0,
    values[segment + 1] ?? 0,
    (progress - start) / Math.max(end - start, Number.EPSILON),
  );
}

function createParticleSprite({
  color,
  glowColor,
  highlight,
  pixelRatio,
}: {
  color: string;
  glowColor?: string;
  highlight: boolean;
  pixelRatio: number;
}): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  sprite.height = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  const context = sprite.getContext("2d", { alpha: true });
  if (!context) return sprite;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = color;
  if (highlight) {
    context.shadowBlur = HIGHLIGHT_PARTICLE_BLUR;
    context.shadowColor = glowColor ?? "transparent";
  }
  context.beginPath();
  context.arc(
    PARTICLE_SPRITE_SIZE / 2,
    PARTICLE_SPRITE_SIZE / 2,
    highlight ? HIGHLIGHT_PARTICLE_RADIUS : PARTICLE_RADIUS,
    0,
    Math.PI * 2,
  );
  context.fill();
  return sprite;
}

export const FloatingParticles = memo(function FloatingParticles({
  className,
  settled = false,
}: {
  className?: string;
  /** 直接从循环稳态开始绘制（Highspeed 恢复入场），跳过从空场逐个冒出的起始段。 */
  settled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Bug 根因：旧实现同时挂载 96 个 motion.span 与独立动画控制器，恰好和扩散 Canvas
    // 收尾竞争 renderer 主线程。统一到一张 Canvas 后，交接只剩父层 opacity 合成。
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let animationFrameId = 0;
    let width = 0;
    let height = 0;
    let lastFrameAt = -PARTICLE_FRAME_INTERVAL_MS;
    let color = "";
    let highlightColor = "";
    let glowColor = "";
    let particleSprite: HTMLCanvasElement | undefined;
    let highlightParticleSprite: HTMLCanvasElement | undefined;
    const startedAt = performance.now() - (settled ? PARTICLE_SETTLED_ELAPSED_MS : 0);

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const style = getComputedStyle(canvas);
      color = style.getPropertyValue("--color-highspeed-particle");
      highlightColor = style.getPropertyValue("--color-highspeed-particle-highlight");
      glowColor = style.getPropertyValue("--color-highspeed-particle-highlight-glow");
      // Bug 根因：Canvas shadowBlur 在部分 Electron/macOS 环境会逐帧触发昂贵的软件栅格化。
      // 辉光只在尺寸变化时离屏生成一次，动画帧复用位图，避免 Renderer 长期满载。
      particleSprite = createParticleSprite({ color, highlight: false, pixelRatio: scale });
      highlightParticleSprite = createParticleSprite({
        color: highlightColor,
        glowColor,
        highlight: true,
        pixelRatio: scale,
      });
    };

    const draw = (now: number) => {
      animationFrameId = window.requestAnimationFrame(draw);
      if (now - lastFrameAt < PARTICLE_FRAME_INTERVAL_MS) return;
      lastFrameAt = now;
      context.clearRect(0, 0, width, height);
      const elapsedSeconds = Math.max(0, (now - startedAt) / 1_000);

      for (const particle of PARTICLES) {
        const activeElapsed = elapsedSeconds - particle.phaseOffset;
        if (activeElapsed < 0 && !reducedMotion) continue;
        const progress = reducedMotion
          ? 0.48
          : (activeElapsed % particle.cycleDuration) / particle.cycleDuration;
        const x = interpolateParticleChannel(progress, [
          0,
          particle.swayDistance * 0.35,
          -particle.swayDistance * 0.25,
          particle.horizontalDrift * 0.65 + particle.swayDistance * 0.2,
          particle.horizontalDrift,
        ]);
        const y = interpolateParticleChannel(progress, [
          0,
          -particle.riseDistance * 0.38,
          -particle.riseDistance * 0.64,
          -particle.riseDistance * 0.82,
          -particle.riseDistance,
        ]);
        const opacity = reducedMotion
          ? particle.opacity * 0.72
          : interpolateParticleChannel(progress, [
              0,
              particle.opacity,
              particle.opacity * 0.92,
              particle.opacity * 0.7,
              0,
            ]);
        const particleScale = interpolateParticleChannel(progress, [0.55, 1.1, 1, 0.8, 0.4]);
        const sprite = particle.highlight ? highlightParticleSprite : particleSprite;
        if (!sprite) continue;
        const spriteSize = PARTICLE_SPRITE_SIZE * particleScale;
        const particleX = (particle.startLeft / 100) * width + x;
        const particleY = (particle.startTop / 100) * height + y;
        context.globalAlpha = opacity;
        context.drawImage(
          sprite,
          particleX - spriteSize / 2,
          particleY - spriteSize / 2,
          spriteSize,
          spriteSize,
        );
      }
      context.globalAlpha = 1;
      if (reducedMotion) window.cancelAnimationFrame(animationFrameId);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    animationFrameId = window.requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [settled]);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="highspeed-particle-canvas absolute inset-0 size-full" />
    </div>
  );
});

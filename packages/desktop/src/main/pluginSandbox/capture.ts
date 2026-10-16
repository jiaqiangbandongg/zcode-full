import { z } from "zod";
import type { PluginSandboxCaptureRequest } from "@zcode/shared/mcp-apps";

const dimension = z.number().finite().positive().max(16_384);
export const sandboxCaptureSchema = z
  .object({
    sandboxId: z.string().min(1).max(512),
    initId: z.number().int().nonnegative(),
    viewportSize: z.object({ width: dimension, height: dimension }).strict(),
    captureRect: z
      .object({
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        width: dimension,
        height: dimension,
      })
      .strict(),
  })
  .strict()
  .refine(
    ({ captureRect: rect, viewportSize: size }) =>
      rect.x + rect.width <= size.width && rect.y + rect.height <= size.height,
  );

export function scaleCaptureRect(
  input: PluginSandboxCaptureRequest,
  size: { width: number; height: number },
) {
  if (size.width <= 0 || size.height <= 0) throw new Error("Sandbox capture is empty");
  const { captureRect: rect, viewportSize: viewport } = input;
  const x = Math.ceil((rect.x * size.width) / viewport.width);
  const y = Math.ceil((rect.y * size.height) / viewport.height);
  const right = Math.min(
    size.width,
    Math.floor(((rect.x + rect.width) * size.width) / viewport.width),
  );
  const bottom = Math.min(
    size.height,
    Math.floor(((rect.y + rect.height) * size.height) / viewport.height),
  );
  if (right <= x || bottom <= y) throw new Error("Sandbox capture is empty");
  return { x, y, width: right - x, height: bottom - y };
}

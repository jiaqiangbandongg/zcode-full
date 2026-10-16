import { z } from "zod";
export * from "./tweakProtocol.js";

export const GEN_UI_HTML_MAX_BYTES = 5_000_000;
export const GEN_UI_STATE_MAX_BYTES = 16 * 1024;
export const GEN_UI_STATE_MAX_ENTRIES = 100;
export const GEN_UI_CONTEXT_MAX_BYTES = 64 * 1024;
export const GEN_UI_GLOBALS_EVENT = "zcode:set_globals";
export const GEN_UI_STATE_CONTEXT_KEY = "zcode/genUiState";
export const GEN_UI_TWEAK_CONTEXT_KEY = "zcode/genUiTweaks";
export const GEN_UI_STATE_METHOD = "zcode/gen-ui/state";
export const GEN_UI_FOLLOW_UP_METHOD = "zcode/gen-ui/follow-up";
export const GEN_UI_TWEAK_METHOD = "zcode/gen-ui/tweak";
export const GEN_UI_PRESENTATION_METHOD = "zcode/gen-ui/presentation";
export const GEN_UI_STATIC_DOMAINS = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
] as const;

/** This is a wire-format check. The executor owns normalization and filesystem authorization. */
export const genUiPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => {
    if (path.includes("\0") || /[\r\n]/u.test(path)) return false;
    const segments = path.split(/[\\/]/u);
    return (
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) &&
      !segments.includes("..") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(segments.at(-1) ?? "")
    );
  }, "Expected an absolute executor path to a lowercase-hyphenated HTML file");
export const genUiReferenceSchema = z
  .object({
    path: genUiPathSchema,
    title: z.string().max(250).optional(),
    mode: z.enum(["wide"]).optional(),
  })
  .strict();
export type GenUiReference = z.infer<typeof genUiReferenceSchema>;

export const genUiScopeSchema = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().max(4096).optional(),
    sessionId: z.string().min(1).max(512),
  })
  .strict();
export type GenUiScope = z.infer<typeof genUiScopeSchema>;
export const genUiStateTargetSchema = genUiScopeSchema.extend({ path: genUiPathSchema });
export type GenUiStateTarget = z.infer<typeof genUiStateTargetSchema>;

function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "undefined" ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new Error("Widget state must contain JSON values only");
    }
    return item;
  });
}
export const genUiWidgetStateSchema = z
  .object({
    modelContent: z.unknown().default(null),
    privateContent: z.unknown().default(null),
  })
  .strict()
  .transform((state, context) => {
    try {
      const serialized = serializeJson(state);
      if (new TextEncoder().encode(serialized).byteLength > GEN_UI_STATE_MAX_BYTES) {
        throw new Error("Widget state exceeds 16 KiB");
      }
      return JSON.parse(serialized) as { modelContent: unknown; privateContent: unknown };
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid widget state",
      });
      return z.NEVER;
    }
  });
export type GenUiWidgetState = z.infer<typeof genUiWidgetStateSchema>;
export const genUiFollowUpSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
    title: z.string().max(250).optional(),
  })
  .strict();

export interface GenUiDocument {
  path: string;
  html: string;
}
const controlBase = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(120),
  reference: z
    .string()
    .regex(/^[\w./:@$#-]{1,160}$/u)
    .optional(),
};
export const genUiTweakControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...controlBase,
      type: z.literal("slider"),
      value: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive().optional(),
      unit: z.string().max(24).optional(),
    })
    .strict(),
  z
    .object({
      ...controlBase,
      type: z.literal("color"),
      value: z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
    })
    .strict(),
  z.object({ ...controlBase, type: z.literal("toggle"), value: z.boolean() }).strict(),
  z
    .object({
      ...controlBase,
      type: z.literal("select"),
      value: z.string().max(120),
      options: z
        .array(
          z.union([
            z.string().min(1).max(120),
            z.object({ label: z.string().min(1).max(120), value: z.string().max(120) }).strict(),
          ]),
        )
        .min(1)
        .max(12),
    })
    .strict(),
]);
export const genUiTweakSchema = z
  .object({
    title: z.string().min(1).max(120),
    controls: z.array(genUiTweakControlSchema).min(1).max(12),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const control of input.controls) {
      if (
        ids.has(control.id) ||
        (control.type === "slider" &&
          (control.min >= control.max ||
            control.value < control.min ||
            control.value > control.max)) ||
        (control.type === "select" &&
          !control.options.some(
            (option) => (typeof option === "string" ? option : option.value) === control.value,
          ))
      )
        ctx.addIssue({ code: "custom", message: "Invalid or duplicate tweak control" });
      ids.add(control.id);
    }
  });
export type GenUiTweak = z.infer<typeof genUiTweakSchema>;
export type GenUiTweakValues = Record<string, string | number | boolean>;
export interface GenUiStateEntry {
  path: string;
  state: GenUiWidgetState;
}
export interface GenUiStateChange {
  target: GenUiStateTarget;
  state: GenUiWidgetState | null;
}
export function buildGenUiScopeKey(scope: GenUiScope): string {
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.sessionId]);
}
export function buildGenUiStateKey(target: GenUiStateTarget): string {
  return JSON.stringify([buildGenUiScopeKey(target), target.path]);
}
export function buildGenUiModelContext(entries: readonly GenUiStateEntry[]): string {
  const selected: Array<{ path: string; state: unknown }> = [];
  for (const entry of [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, GEN_UI_STATE_MAX_ENTRIES)) {
    const parsed = genUiWidgetStateSchema.safeParse(entry.state);
    if (!parsed.success || parsed.data.modelContent === null) continue;
    const next = { path: entry.path, state: parsed.data.modelContent };
    if (
      new TextEncoder().encode(JSON.stringify([...selected, next])).length >
      GEN_UI_CONTEXT_MAX_BYTES
    )
      break;
    selected.push(next);
  }
  return selected.length
    ? `<untrusted_gen_ui_state>\n${JSON.stringify(selected).replaceAll("<", "\\u003c")}\n</untrusted_gen_ui_state>`
    : "";
}
export function stripGenUiModelContext(content: string): string {
  const match = /\n\n<untrusted_gen_ui_state>\n([^]*?)\n<\/untrusted_gen_ui_state>\s*$/u.exec(
    content,
  );
  if (!match) return content;
  try {
    z.array(z.object({ path: genUiPathSchema, state: z.unknown() }).strict())
      .max(GEN_UI_STATE_MAX_ENTRIES)
      .parse(JSON.parse(match[1]!));
    return content.slice(0, match.index);
  } catch {
    return content;
  }
}

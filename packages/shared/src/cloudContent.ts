import { z } from "zod";

export const cloudButtonThemeSchema = z.object({
  variant: z
    .enum(["", "default", "outline", "secondary", "ghost", "destructive", "warning", "link"])
    .optional()
    .transform((value) => value || "default"),
  class: z.string().max(512).optional(),
  style: z.string().max(512).optional(),
});

const url = z
  .string()
  .max(4096)
  .url()
  .refine(
    (value) =>
      URL.canParse(value) &&
      /^https?:\/\//iu.test(value) &&
      !new URL(value).username &&
      !new URL(value).password,
  );
const id = z.string().min(1).max(128);
const image = z.object({
  type: z.literal("image"),
  src: url,
  darkSrc: url.optional(),
  alt: z.string().max(500),
  fit: z.enum(["cover", "contain"]).optional(),
});
export const contentBundleSchema = z.object({
  format: z.literal("zip"),
  url,
  entry: z.string().min(1).max(240),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024)
    .optional(),
});
export type CloudContentBundle = z.infer<typeof contentBundleSchema>;
const hero = z.discriminatedUnion("type", [
  image,
  z.object({
    type: z.literal("video"),
    src: url,
    darkSrc: url.optional(),
    poster: url,
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    muted: z.literal(true),
    fit: z.enum(["cover", "contain"]).optional(),
  }),
  z.object({
    type: z.literal("lottie"),
    src: url,
    darkSrc: url.optional(),
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    speed: z.number().min(0.1).max(4).optional(),
    fallback: image.optional(),
  }),
  z.object({
    type: z.literal("interactive_bundle"),
    runtime: z.literal("zcode-hero-sandbox-v1"),
    bundle: contentBundleSchema,
    viewport: z.object({ aspectRatio: z.literal("4:3") }),
    data: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= 64000),
    events: z.record(id, id).refine((value) => Object.keys(value).length <= 16),
    fallback: image.optional(),
  }),
]);
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("dismiss_content") }),
  z.object({
    type: z.literal("navigate"),
    destination: z.enum(["model_settings", "plugin_store", "settings"]),
  }),
  z.object({ type: z.literal("copy_text"), text: z.string().max(20000) }),
  z.object({ type: z.literal("open_external"), url }),
  z.object({ type: z.literal("claim_plan"), planId: id }),
]);
export const cloudContentPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    revision: z.number().int().positive(),
    kind: z.enum(["campaign", "feature", "notice"]),
    locale: z.enum(["zh-CN", "en-US"]),
    dialog: z.object({
      title: z.string().min(1).max(500),
      description: z.object({
        format: z.enum(["plain_text", "html", "markdown"]),
        text: z.string().max(20000),
      }),
      hero,
      buttons: z
        .array(
          z.object({
            id,
            label: z.string().min(1).max(200),
            variant: z.enum(["primary", "secondary", "link"]),
            theme: cloudButtonThemeSchema.nullish(),
            actionId: id,
          }),
        )
        .max(4),
    }),
    actions: z.record(id, action).refine((value) => Object.keys(value).length <= 16),
  })
  .superRefine((payload, context) => {
    const ids = new Set<string>();
    for (const button of payload.dialog.buttons) {
      if (ids.has(button.id) || !Object.hasOwn(payload.actions, button.actionId))
        context.addIssue({ code: "custom", message: "Duplicate button or missing action" });
      ids.add(button.id);
    }
  });
export type CloudContentPayload = z.infer<typeof cloudContentPayloadSchema>;
export type CloudContentHeroType = CloudContentPayload["dialog"]["hero"]["type"];

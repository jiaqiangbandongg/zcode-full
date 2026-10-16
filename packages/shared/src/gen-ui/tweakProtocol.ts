import { z } from "zod";

const value = z.union([z.string(), z.number().finite(), z.boolean()]);
const base = {
  callback: z.string().min(1).max(128),
  label: z.string().min(1).max(120),
  reference: z.string().max(160).optional(),
};
export const genUiAnnotationControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("range"),
      currentValue: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("color"),
      currentValue: z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
    })
    .strict(),
  z.object({ ...base, type: z.literal("toggle"), currentValue: z.boolean() }).strict(),
  z
    .object({
      ...base,
      type: z.literal("select"),
      currentValue: z.string().max(120),
      options: z
        .array(z.object({ label: z.string().min(1).max(120), value: z.string().max(120) }).strict())
        .min(1)
        .max(12),
    })
    .strict(),
]);
export type GenUiAnnotationControl = z.infer<typeof genUiAnnotationControlSchema>;
export function isGenUiAnnotationValue(
  control: GenUiAnnotationControl,
  candidate: unknown,
): candidate is string | number | boolean {
  switch (control.type) {
    case "range":
      return (
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= control.min &&
        candidate <= control.max
      );
    case "color":
      return (
        typeof candidate === "string" &&
        /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(candidate)
      );
    case "toggle":
      return typeof candidate === "boolean";
    case "select":
      return (
        typeof candidate === "string" &&
        control.options.some((option) => option.value === candidate)
      );
  }
}
const annotationControls = z
  .object({
    controlsMode: z.literal("replace"),
    controls: z.array(genUiAnnotationControlSchema).min(1).max(12),
  })
  .strict()
  .superRefine((input, ctx) => {
    const callbacks = new Set(input.controls.map((control) => control.callback));
    if (
      callbacks.size !== input.controls.length ||
      input.controls.some((control) => !isGenUiAnnotationValue(control, control.currentValue)) ||
      JSON.stringify(input).length > 16384
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid annotation controls" });
    }
  });
const target = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(80),
    selector: z.string().max(1024),
    tagName: z.string().min(1).max(120),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
const registration = {
  registrationId: z.string().min(1).max(128),
  annotationControls,
  targets: z.array(target).length(1),
};
export const genUiTweakMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("register"), ...registration }).strict(),
  z.object({ type: z.literal("update"), ...registration }).strict(),
  z.object({ type: z.literal("dispose"), registrationId: registration.registrationId }).strict(),
  z
    .object({
      type: z.literal("select"),
      registrationId: registration.registrationId,
      targetId: target.shape.id,
    })
    .strict(),
  z.object({ type: z.literal("escape") }).strict(),
]);
export type GenUiTweakMessage = z.infer<typeof genUiTweakMessageSchema>;
export const genUiTweakResultSchema = z
  .object({ annotationControls: annotationControls.optional() })
  .strict();
export type GenUiTweakResult = z.infer<typeof genUiTweakResultSchema>;
export const genUiTweakAnnotationSchema = z
  .object({
    active: z.boolean(),
    selection: z
      .object({ registrationId: registration.registrationId, targetId: target.shape.id })
      .nullable(),
    changes: z
      .array(
        z
          .object({
            registrationId: registration.registrationId,
            targetId: target.shape.id,
            annotationControlChanges: z
              .array(z.object({ callback: base.callback, previousValue: value, value }).strict())
              .max(12),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type GenUiTweakAnnotation = z.infer<typeof genUiTweakAnnotationSchema>;

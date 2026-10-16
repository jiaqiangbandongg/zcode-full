import {
  genUiTweakMessageSchema,
  isGenUiAnnotationValue,
  type GenUiTweakMessage,
  type GenUiTweakResult,
  type GenUiTweakAnnotation,
  type GenUiTweak,
  type GenUiTweakValues,
} from "@zcode/shared/gen-ui";

type Registration = Extract<GenUiTweakMessage, { type: "register" | "update" }>;

/** 上游 helper 的接受状态归页面 owner；guest 只通过 ACK 得到绑定投影。 */
export function createGenUiTweakRegistry() {
  const registrations = new Map<string, Registration>();
  let selection: GenUiTweakAnnotation["selection"] = null;
  const owners = () => {
    const latest = new Map<string, Registration>();
    for (const entry of registrations.values()) latest.set(entry.targets[0]!.id, entry);
    return [...latest.values()];
  };
  return {
    handle(input: GenUiTweakMessage): GenUiTweakResult {
      const message = genUiTweakMessageSchema.parse(input);
      if (message.type === "escape") {
        selection = null;
        return {};
      }
      if (message.type === "dispose") {
        registrations.delete(message.registrationId);
        if (selection?.registrationId === message.registrationId) selection = null;
        return {};
      }
      if (message.type === "select") {
        if (
          !owners().some(
            (entry) =>
              entry.registrationId === message.registrationId &&
              entry.targets[0]!.id === message.targetId,
          )
        )
          throw new Error("Tweak target is no longer available");
        selection = { registrationId: message.registrationId, targetId: message.targetId };
        return {};
      }
      const previous = registrations.get(message.registrationId);
      if (
        message.type === "register"
          ? previous || registrations.size >= 64
          : !previous || previous.targets[0]!.id !== message.targets[0]!.id
      )
        throw new Error("Invalid Tweak registration generation");
      const otherCallbacks = new Set(
        [...registrations.values()]
          .filter((entry) => entry.registrationId !== message.registrationId)
          .flatMap((entry) => entry.annotationControls.controls.map((control) => control.callback)),
      );
      if (
        message.annotationControls.controls.some((control) => otherCallbacks.has(control.callback))
      )
        throw new Error("Duplicate Tweak callback");
      registrations.set(message.registrationId, message);
      return { annotationControls: message.annotationControls };
    },
    groups(): GenUiTweak[] {
      return owners().map((entry) => ({
        title: entry.targets[0]!.label,
        controls: entry.annotationControls.controls.map((control) => {
          const { callback: id, currentValue: value, ...rest } = control;
          return {
            ...rest,
            id,
            value,
            type: control.type === "range" ? "slider" : control.type,
          } as GenUiTweak["controls"][number];
        }),
      }));
    },
    annotation(values: GenUiTweakValues): GenUiTweakAnnotation {
      return {
        active: false,
        selection,
        changes: owners().flatMap((entry) => {
          const annotationControlChanges = entry.annotationControls.controls.flatMap((control) => {
            const value = values[control.callback];
            return value !== control.currentValue && isGenUiAnnotationValue(control, value)
              ? [{ callback: control.callback, previousValue: control.currentValue, value }]
              : [];
          });
          return annotationControlChanges.length
            ? [
                {
                  registrationId: entry.registrationId,
                  targetId: entry.targets[0]!.id,
                  annotationControlChanges,
                },
              ]
            : [];
        }),
      };
    },
  };
}

const ASK_USER_QUESTION_AUTO_RESOLUTION_SETTING_SPEC =
  "conversation-session-ask-user-question-auto-resolution-setting.test.ts";

export function resolveAskUserQuestionClockScaleForWorker({
  requestedScale,
  specs,
}: {
  requestedScale?: string;
  specs: readonly string[];
}): string | undefined {
  const normalizedRequestedScale = requestedScale?.trim();
  if (normalizedRequestedScale) return normalizedRequestedScale;
  return specs.some((spec) =>
    spec.replaceAll("\\", "/").endsWith(`/${ASK_USER_QUESTION_AUTO_RESOLUTION_SETTING_SPEC}`),
  )
    ? "20"
    : undefined;
}

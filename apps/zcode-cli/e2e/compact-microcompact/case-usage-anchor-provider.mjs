import { chatCompletion, contextExceededError } from "./scripted-provider.mjs";

export const FULL_DONE = "USAGE_FULL_COMPACT_DONE";
export const REACTIVE_DONE = "USAGE_REACTIVE_COMPACT_DONE";
export const INPUT_ONLY_DONE = "USAGE_INPUT_ONLY_DONE";
export const HYDRATION_SETUP = "USAGE_HYDRATION_SETUP";
export const HYDRATION_DONE = "USAGE_HYDRATION_DONE";
export const REWIND_KEPT = "USAGE_REWIND_KEPT";
export const REWIND_REMOVED = "USAGE_REWIND_REMOVED";

const HIGH_INPUT_TOKENS = 10_000;
const SUMMARY_USAGE_INPUT_TOKENS = 15_000;
const REWIND_REMOVED_USAGE_INPUT_TOKENS = 19_000;

export function createScenarioHandler(scenario) {
  let mainRequestCount = 0;
  let compactRequestCount = 0;
  let overflowSent = false;

  return async ({ body }) => {
    if (isCompactRequest(body)) {
      compactRequestCount += 1;
      return {
        body: chatCompletion({
          content: `Summary for ${scenario} compact ${compactRequestCount}.`,
          completionTokens: 10,
          model: body?.model,
          promptTokens:
            scenario === "full" || scenario === "reactive" ? SUMMARY_USAGE_INPUT_TOKENS : 50,
        }),
      };
    }

    mainRequestCount += 1;
    if (scenario === "reactive" && mainRequestCount === 3 && !overflowSent) {
      overflowSent = true;
      return { body: contextExceededError(), status: 400 };
    }
    if (scenario === "hydration" && mainRequestCount === 2) {
      return {
        body: chatCompletion({
          content: "",
          model: body?.model,
          promptTokens: SUMMARY_USAGE_INPUT_TOKENS,
        }),
      };
    }
    if (scenario === "input-only" && mainRequestCount === 1) {
      return {
        body: chatCompletion({
          content: "USAGE_INPUT_ONLY_SETUP",
          model: body?.model,
          usage: { prompt_tokens: HIGH_INPUT_TOKENS },
        }),
      };
    }
    if (scenario === "reactive" && mainRequestCount >= 4) {
      return {
        body: chatCompletion({
          content: REACTIVE_DONE,
          model: body?.model,
          promptTokens: HIGH_INPUT_TOKENS,
          usage: {},
        }),
      };
    }

    if (scenario === "rewind" && mainRequestCount >= 3) {
      return {
        body: chatCompletion({
          content: REWIND_KEPT,
          model: body?.model,
          usage: {},
        }),
      };
    }

    const content =
      scenario === "full"
        ? mainRequestCount >= 3
          ? FULL_DONE
          : `USAGE_FULL_SETUP_${mainRequestCount}`
        : scenario === "reactive"
          ? mainRequestCount >= 4
            ? REACTIVE_DONE
            : `USAGE_REACTIVE_SETUP_${mainRequestCount}`
          : scenario === "input-only"
            ? INPUT_ONLY_DONE
            : scenario === "hydration"
              ? mainRequestCount === 1
                ? HYDRATION_SETUP
                : HYDRATION_DONE
              : mainRequestCount === 1
                ? REWIND_KEPT
                : mainRequestCount === 2
                  ? REWIND_REMOVED
                  : REWIND_KEPT;
    const usageInputTokens =
      scenario === "rewind" && mainRequestCount === 2
        ? REWIND_REMOVED_USAGE_INPUT_TOKENS
        : HIGH_INPUT_TOKENS;
    return {
      body: chatCompletion({
        content,
        completionTokens: 200,
        model: body?.model,
        promptTokens: usageInputTokens,
      }),
    };
  };
}

export function promptsForScenario(scenario) {
  switch (scenario) {
    case "full":
      return [
        "Usage full compact setup A.",
        "Usage full compact setup B.",
        "/compact Keep only the full compact marker.",
      ];
    case "reactive":
      return [
        "Usage reactive setup A.",
        "Usage reactive setup B.",
        `Trigger reactive compact and finish with ${REACTIVE_DONE}.`,
      ];
    case "input-only":
      return ["Create an input-only usage anchor.", `Finish with ${INPUT_ONLY_DONE}.`];
    case "hydration":
      return [
        "Create a non-empty hydration usage anchor.",
        "Return an empty assistant response with usage.",
      ];
    case "rewind":
      return ["Create the kept rewind branch.", "Create the branch that will be rewound."];
    default:
      throw new Error(`Unknown usage anchor scenario: ${scenario}`);
  }
}

export function isCompactRequest(body) {
  const userContents = (body?.messages ?? [])
    .filter((message) => message?.role === "user" && typeof message?.content === "string")
    .map((message) => message.content);
  return (
    userContents.some((content) => content.includes("Your task is to create a detailed summary")) &&
    !userContents.some((content) =>
      content.includes("This session is being continued from a previous conversation"),
    )
  );
}

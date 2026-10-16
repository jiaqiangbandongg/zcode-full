import { assertCondition } from "./case-utils.mjs";
import {
  FULL_DONE,
  HYDRATION_DONE,
  HYDRATION_SETUP,
  INPUT_ONLY_DONE,
  REACTIVE_DONE,
  REWIND_KEPT,
  REWIND_REMOVED,
  isCompactRequest,
} from "./case-usage-anchor-provider.mjs";

export function assertUsageAnchorScenario(input) {
  const mainRecords = input.records.filter((record) => !isCompactRequestBody(record));
  const lastBody = parseRecordBody(mainRecords.at(-1));
  const requestText = JSON.stringify(lastBody?.messages ?? []);
  const compactRequestCount = input.records.filter(isCompactRequestBody).length;
  const lastCompactRequestIndex = input.records.reduce(
    (lastIndex, record, index) => (isCompactRequestBody(record) ? index : lastIndex),
    -1,
  );
  const firstMainAfterCompact = input.records
    .slice(lastCompactRequestIndex + 1)
    .find((record) => !isCompactRequestBody(record));

  switch (input.scenario) {
    case "full":
      assertCondition(input.response.includes(FULL_DONE), `expected ${FULL_DONE}`, {
        response: input.response,
      });
      assertCondition(compactRequestCount >= 1, "full compact must issue a summary request");
      assertCondition(
        assistantEntries(input.historySnapshots?.beforeRestart).length === 0,
        "full compact must remove summarized assistants and their runtime token anchors",
        { entries: input.historySnapshots?.beforeRestart },
      );
      assertCondition(
        durableAssistantTokenInput(input.durableSnapshots?.beforeRestart, "USAGE_FULL_SETUP_1") ===
          10_000 &&
          durableAssistantTokenInput(
            input.durableSnapshots?.beforeRestart,
            "USAGE_FULL_SETUP_2",
          ) === 10_000,
        "full compact must leave the original assistant tokens intact in the durable transcript",
        { messages: input.durableSnapshots?.beforeRestart },
      );
      assertCondition(
        !requestText.includes("USAGE_FULL_SETUP_1") && !requestText.includes("USAGE_FULL_SETUP_2"),
        "full compact must not rehydrate summarized assistants",
        { requestText },
      );
      assertCondition(
        assistantEntries(input.historySnapshots?.afterRestartBeforeFollowUp).length === 0,
        "cold hydration after full compact must not recreate summarized assistants or their tokens",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.afterRestartBeforeFollowUp,
          "USAGE_FULL_SETUP_1",
        ) === 10_000,
        "cold hydration must not rewrite summarized assistant tokens in the durable transcript",
        { messages: input.durableSnapshots?.afterRestartBeforeFollowUp },
      );
      break;
    case "reactive":
      assertCondition(input.response.includes(REACTIVE_DONE), `expected ${REACTIVE_DONE}`, {
        response: input.response,
      });
      assertCondition(compactRequestCount >= 1, "reactive overflow must issue a compact request");
      assertCondition(
        firstMainAfterCompact !== undefined,
        "reactive compact must be followed by a real model request",
      );
      assertCondition(
        JSON.stringify(parseRecordBody(firstMainAfterCompact)?.messages ?? []).includes(
          "USAGE_REACTIVE_SETUP_2",
        ),
        "the first request after reactive compact must still contain the preserved tail",
        {
          preservedAssistantContents: (parseRecordBody(firstMainAfterCompact)?.messages ?? [])
            .filter((message) => message?.role === "assistant")
            .map((message) => message.content),
        },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.beforeRestart, "USAGE_REACTIVE_SETUP_2") === 0,
        "reactive compact must invalidate preserved assistant tokens in the live runtime copy",
        { entries: input.historySnapshots?.beforeRestart },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.beforeRestart,
          "USAGE_REACTIVE_SETUP_2",
        ) === 10_000,
        "reactive compact must not rewrite preserved assistant tokens in the durable transcript",
        { messages: input.durableSnapshots?.beforeRestart },
      );
      assertCondition(
        assistantTokenInput(
          input.historySnapshots?.afterRestartBeforeFollowUp,
          "USAGE_REACTIVE_SETUP_2",
        ) === 0,
        "cold hydration after reactive compact must keep preserved assistant tokens invalidated",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.afterRestartBeforeFollowUp,
          "USAGE_REACTIVE_SETUP_2",
        ) === 10_000,
        "cold hydration must preserve the original preserved-tail tokens in durable storage",
        { messages: input.durableSnapshots?.afterRestartBeforeFollowUp },
      );
      break;
    case "input-only":
      assertCondition(input.response.includes(INPUT_ONLY_DONE), `expected ${INPUT_ONLY_DONE}`, {
        response: input.response,
      });
      assertCondition(
        assistantTokenInput(input.historySnapshots?.beforeRestart, "USAGE_INPUT_ONLY_SETUP") ===
          10_000,
        "input-only provider usage must be stored on the committed assistant",
        { entries: input.historySnapshots?.beforeRestart },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.beforeRestart,
          "USAGE_INPUT_ONLY_SETUP",
        ) === 10_000,
        "input-only provider usage must be persisted on the committed assistant",
        { messages: input.durableSnapshots?.beforeRestart },
      );
      break;
    case "hydration":
      assertCondition(input.response.includes(HYDRATION_DONE), `expected ${HYDRATION_DONE}`, {
        response: input.response,
      });
      assertCondition(
        assistantTokenInput(input.historySnapshots?.beforeRestart, HYDRATION_SETUP) === 10_000,
        "the non-empty assistant must persist its provider tokens before hydration",
        { entries: input.historySnapshots?.beforeRestart },
      );
      assertCondition(
        durableAssistantTokenInput(input.durableSnapshots?.beforeRestart, HYDRATION_SETUP) ===
          10_000,
        "the non-empty assistant tokens must be present in durable storage before hydration",
        { messages: input.durableSnapshots?.beforeRestart },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.afterRestartBeforeFollowUp, HYDRATION_SETUP) ===
          10_000,
        "cold hydration must keep the non-empty assistant usage anchor",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        emptyAssistantEntries(input.historySnapshots?.beforeRestart).length === 1 &&
          emptyAssistantEntries(input.historySnapshots?.beforeRestart)[0]?.tokens?.input === 15_000,
        "a contentless assistant with valid provider usage must remain the live usage anchor",
        { entries: input.historySnapshots?.beforeRestart },
      );
      assertCondition(
        emptyAssistantEntries(input.historySnapshots?.afterRestartBeforeFollowUp).length === 1 &&
          emptyAssistantEntries(input.historySnapshots?.afterRestartBeforeFollowUp)[0]?.tokens
            ?.input === 15_000,
        "cold hydration must restore the same contentless assistant usage anchor",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.afterRestartBeforeFollowUp,
          HYDRATION_SETUP,
        ) === 10_000 &&
          durableAssistantEntries(input.durableSnapshots?.afterRestartBeforeFollowUp).some(
            (message) => message.content.length === 0 && (message.tokens?.input ?? 0) === 15_000,
          ),
        "hydration must preserve both the valid anchor and the empty assistant tokens durably",
        { messages: input.durableSnapshots?.afterRestartBeforeFollowUp },
      );
      break;
    case "rewind":
      assertCondition(input.response.includes(REWIND_KEPT), `expected ${REWIND_KEPT}`, {
        response: input.response,
      });
      assertCondition(
        !requestText.includes(REWIND_REMOVED),
        "rewind must remove the rewound assistant from the next provider request",
        { requestText },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.beforeRewind, REWIND_KEPT) === 10_000,
        "rewind must retain the kept branch assistant tokens before branch cut",
        { entries: input.historySnapshots?.beforeRewind },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.beforeRewind, REWIND_REMOVED) === 19_000,
        "rewind setup must record the removed branch assistant tokens",
        { entries: input.historySnapshots?.beforeRewind },
      );
      assertCondition(
        durableAssistantTokenInput(input.durableSnapshots?.beforeRewind, REWIND_KEPT) === 10_000 &&
          durableAssistantTokenInput(input.durableSnapshots?.beforeRewind, REWIND_REMOVED) ===
            19_000,
        "rewind setup must persist both branch token values",
        { messages: input.durableSnapshots?.beforeRewind },
      );
      assertCondition(
        !assistantEntries(input.historySnapshots?.afterRewind).some((message) =>
          message.content.includes(REWIND_REMOVED),
        ),
        "rewind must remove the rewound assistant and its tokens from the live runtime history",
        { entries: input.historySnapshots?.afterRewind },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.afterRewind, REWIND_KEPT) === 10_000,
        "rewind must retain the kept branch assistant tokens in the live runtime history",
        { entries: input.historySnapshots?.afterRewind },
      );
      assertCondition(
        durableAssistantTokenInput(input.durableSnapshots?.afterRewind, REWIND_REMOVED) === 19_000,
        "rewind must retain the removed branch tokens only in the durable transcript",
        { messages: input.durableSnapshots?.afterRewind },
      );
      assertCondition(
        !assistantEntries(input.historySnapshots?.afterRestartBeforeFollowUp).some((message) =>
          message.content.includes(REWIND_REMOVED),
        ),
        "cold hydration after rewind must not restore the removed branch or its tokens",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        assistantTokenInput(input.historySnapshots?.afterRestartBeforeFollowUp, REWIND_KEPT) ===
          10_000,
        "cold hydration after rewind must retain the kept branch assistant tokens",
        { entries: input.historySnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        durableAssistantTokenInput(
          input.durableSnapshots?.afterRestartBeforeFollowUp,
          REWIND_KEPT,
        ) === 10_000 &&
          durableAssistantTokenInput(
            input.durableSnapshots?.afterRestartBeforeFollowUp,
            REWIND_REMOVED,
          ) === 19_000,
        "cold hydration after rewind must preserve durable branch token facts while excluding the removed branch at runtime",
        { messages: input.durableSnapshots?.afterRestartBeforeFollowUp },
      );
      assertCondition(
        input.rewindFollowUpRecordIndex !== undefined,
        "rewind must capture the immediate follow-up request boundary",
      );
      assertCondition(
        !JSON.stringify(
          parseRecordBody(input.records[input.rewindFollowUpRecordIndex])?.messages ?? [],
        ).includes(REWIND_REMOVED),
        "the immediate post-rewind provider request must not contain the removed branch",
      );
      break;
    default:
      throw new Error(`Unknown usage anchor scenario: ${input.scenario}`);
  }
}

function assistantEntries(snapshot) {
  return (snapshot ?? []).filter((entry) => entry.role === "assistant");
}

function emptyAssistantEntries(snapshot) {
  return assistantEntries(snapshot).filter((entry) => entry.content.trim().length === 0);
}

function assistantTokenInput(snapshot, marker) {
  const entry = assistantEntries(snapshot).find((candidate) => candidate.content.includes(marker));
  return entry?.tokens?.input ?? 0;
}

function durableAssistantEntries(snapshot) {
  return snapshot ?? [];
}

function durableAssistantTokenInput(snapshot, marker) {
  const entry = durableAssistantEntries(snapshot).find((candidate) =>
    candidate.content.includes(marker),
  );
  return entry?.tokens?.input ?? 0;
}

function isCompactRequestBody(record) {
  return isCompactRequest(parseRecordBody(record));
}

function parseRecordBody(record) {
  try {
    return JSON.parse(record?.requestBody ?? "{}");
  } catch {
    return {};
  }
}

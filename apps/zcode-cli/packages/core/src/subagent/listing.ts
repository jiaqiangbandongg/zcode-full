import type { AgentListingDelta } from "../agent/agent-listing-metadata.js";
import { type RuntimeAttachmentEntry, type RuntimeMessageEntry } from "../agent/message-history.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import { formatAgentProfileForPrompt } from "./profile.js";

const INITIAL_HEADING = "Available agent types for the Agent tool:";
const ADDED_HEADING = "New agent types are now available for the Agent tool:";
const REMOVED_HEADING = "The following agent types are no longer available:";
const AMBIENT_CONTEXT_NOTE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
const CONCURRENCY_NOTE =
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";

export function collectAgentListingAttachment(input: {
  definitions: AgentDefinitionsSnapshot;
  entries: readonly RuntimeMessageEntry[];
  tools: readonly { name: string }[];
  embeddedSearchEnabled?: boolean;
}): RuntimeAttachmentEntry | undefined {
  if (!input.tools.some((tool) => tool.name === "Agent")) return undefined;
  const announced = new Set<string>();
  for (const entry of input.entries) {
    if (entry.kind !== "attachment" || entry.metadata.source !== "agent_listing_delta") continue;
    // 历史写入/恢复边界已校验并复制 delta；本轮新增 delta 由收集器生成。
    // 此处只读名称增删，避免每次请求重复校验并分配临时数组与 Set。
    const delta = entry.metadata.agentListingDelta;
    if (!delta) continue;
    for (const name of delta.addedTypes) announced.add(name);
    for (const name of delta.removedTypes) announced.delete(name);
  }
  const active = input.definitions.activeAgents;
  const current = new Set(active.map((profile) => profile.name));
  const added = active.filter((profile) => !announced.has(profile.name));
  const removedTypes: string[] = [];
  for (const name of announced) {
    if (!current.has(name)) removedTypes.push(name);
  }
  if (added.length === 0 && removedTypes.length === 0) return undefined;
  added.sort((left, right) => left.name.localeCompare(right.name));
  removedTypes.sort();
  const delta: AgentListingDelta = {
    addedTypes: added.map((profile) => profile.name),
    addedLines: added.map((profile) => formatAgentProfileForPrompt(profile, input)),
    removedTypes,
    isInitial: announced.size === 0,
    showConcurrencyNote: true,
  };
  return {
    kind: "attachment",
    content: formatAgentListingDelta(delta),
    metadata: { source: "agent_listing_delta", agentListingDelta: delta },
  };
}

function formatAgentListingDelta(delta: AgentListingDelta): string {
  const sections: string[] = [];
  if (delta.addedLines.length > 0) {
    sections.push(
      `${delta.isInitial ? INITIAL_HEADING : ADDED_HEADING}\n${delta.addedLines.join("\n")}`,
    );
  }
  if (delta.removedTypes.length > 0) {
    sections.push(
      `${REMOVED_HEADING}\n${delta.removedTypes.map((name) => `- ${name}`).join("\n")}`,
      AMBIENT_CONTEXT_NOTE,
    );
  }
  if (delta.isInitial && delta.showConcurrencyNote) sections.push(CONCURRENCY_NOTE);
  return sections.join("\n\n");
}

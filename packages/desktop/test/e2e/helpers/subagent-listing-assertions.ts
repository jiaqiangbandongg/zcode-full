import assert from "node:assert/strict";
import type { E2ENetworkCaptureArtifact } from "./network-capture-proxy.js";
import type { CapturedPrompt } from "./provider-prefix.js";

const LISTING_HEADING = "Available agent types for the Agent tool:";
const DESCRIPTION_POINTER =
  "Available agent types are listed in <system-reminder> messages in the conversation.";
const CONCURRENCY_NOTE =
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";

export function assertSubagentListingTrajectory(
  artifact: E2ENetworkCaptureArtifact,
  scenario: { parentMarker: string; childMarker: string },
  customNames: readonly string[],
  mcs: boolean,
): void {
  const records = artifact.records.filter(
    (record) => record.status === "complete" && record.path.includes("/messages"),
  );
  const parents = records.filter((record) => {
    const body = JSON.stringify(record.requestJson);
    return (
      body.includes(scenario.parentMarker) &&
      !body.includes("Generate a concise title") &&
      !body.includes("create a detailed summary")
    );
  });
  assert.equal(parents.length, 2, "父请求应只有首轮与 Agent tool_result 后续轮");
  let originalListing: string | undefined;
  for (const record of parents) {
    const request = record.requestJson as {
      tools: Array<{ name: string; description?: string }>;
      messages: Array<{ role: string; content: unknown }>;
      system?: unknown;
    };
    const description = request.tools.find((tool) => tool.name === "Agent")?.description;
    assert.ok(description);
    assert.ok(description.includes(DESCRIPTION_POINTER));
    assert.ok(
      description.includes(
        "Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.",
      ),
    );
    assert.ok(
      description.includes(
        "Each agent type's model, reasoning effort, and tools come from its definition (`.zcode/agents/*.md` frontmatter).",
      ),
    );
    assert.ok(!description.includes("ID or name"));
    assert.ok(!description.includes(".claude/agents"));
    assert.ok(!description.includes(CONCURRENCY_NOTE));
    assert.ok(!description.includes(LISTING_HEADING));
    for (const name of customNames) assert.ok(!description.includes(name));
    const blocks = readMessageTextBlocks(request);
    const listing = blocks.filter((block) => block.text.includes(LISTING_HEADING));
    assert.equal(listing.length, 1, "历史 listing 应保留一次，工具后不得重复追加");
    assert.equal(listing[0]!.role, mcs ? "system" : "user");
    assert.equal(listing[0]!.text.includes("<system-reminder>"), !mcs);
    const questionIndex = blocks.findIndex((block) => block.text.includes(scenario.parentMarker));
    const listingIndex = blocks.indexOf(listing[0]!);
    assert.ok(mcs ? listingIndex > questionIndex : listingIndex < questionIndex);
    assertCompleteToolPairs(request.messages);
    assert.equal(listing[0]!.text.split(CONCURRENCY_NOTE).length - 1, 1);
    for (const name of ["general-purpose", "Explore", ...customNames])
      assert.ok(listing[0]!.text.includes(`- ${name}:`));
    assert.ok(!JSON.stringify(request.system ?? "").includes(LISTING_HEADING));
    const start = listing[0]!.text.indexOf(LISTING_HEADING);
    const end = listing[0]!.text.indexOf(CONCURRENCY_NOTE) + CONCURRENCY_NOTE.length;
    const listingBody = listing[0]!.text.slice(start, end);
    if (originalListing) assert.equal(listingBody, originalListing, "历史目录正文不能改写");
    originalListing = listingBody;
  }
  const children = records.filter((record) => {
    const body = JSON.stringify(record.requestJson);
    return (
      body.includes(scenario.childMarker) &&
      !body.includes(scenario.parentMarker) &&
      !body.includes("Generate a concise title")
    );
  });
  assert.equal(children.length, 1);
  for (const child of children) {
    const request = child.requestJson as { tools?: Array<{ name: string }> };
    assert.ok(!request.tools?.some((tool) => tool.name === "Agent"));
    assert.ok(!JSON.stringify(request).includes(LISTING_HEADING));
  }
}

export function readMessageTextBlocks(request: Pick<CapturedPrompt, "messages">) {
  return request.messages.flatMap(({ role, content }) =>
    (typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block) =>
            block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
          )
        : []
    ).map((text: string) => ({ role, text })),
  );
}

function assertCompleteToolPairs(messages: Array<{ role: string; content: unknown }>): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") assert.equal(pending.size, 0, "MCS 不能插入未完成的工具批次");
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") pending.add(block.id);
      if (block.type === "tool_result") {
        assert.ok(pending.delete(block.tool_use_id), "tool_result 必须对应已出现的 tool_use");
      }
    }
  }
  assert.equal(pending.size, 0, "请求中工具结果必须完整");
}

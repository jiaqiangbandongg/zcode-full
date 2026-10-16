const modelId = "memory-e2e-model";

export const memoryE2EText = Object.freeze({
  customMemoryMarker: "# Persistent Agent Memory",
  customParentPrompt: "delegate",
  customResultMarker: "E2E_CUSTOM_AGENT_DONE",
  customTaskPrompt: "Store the review convention in your persistent project memory.",
  customWriteMarker: "E2E_CUSTOM_MEMORY_WRITTEN",
  closeCancellationPrompt:
    "Close this session while its background Memory extraction is in flight.",
  closeCancellationWriteMarker: "E2E_CLOSE_CANCELLED_EXTRACTION_MUST_NOT_WRITE",
  defaultBoundaryMarker: "E2E_MEMORY_DEFAULT_BOUNDARY",
  defaultBranchPrompt: "MemoryDefaultBranch check",
  disabledPrompt: "Check that disabled memory leaves this request unchanged.",
  extractedDefaultPrompt: "Check the deployment approval policy from project memory.",
  extractedRecallBoundaryMarker: "E2E_EXTRACTED_MEMORY_RECALL_BOUNDARY",
  extractedIndexPointer:
    "- [Deployment approval policy](deployment-approval-policy.md) — staging approval required",
  extractionMarker: "You are now acting as the memory extraction subagent",
  extractionPrompt:
    "The deployment policy requires staging approval because release managers need an audit trail.",
  extractionWriteMarker: "E2E_EXTRACTION_WRITTEN",
  headlessPrompt: "HeadlessMemoryExtractionDisabled",
  recalledPrefix: "Retrieved for possible relevance — use only if it actually applies",
  selectorMarker: "You are selecting memories that will be useful",
});

export function createMemoryExtractionCloseBarrier() {
  const started = deferred();
  const release = deferred();
  return {
    async blockResponse() {
      started.resolve();
      await release.promise;
    },
    releaseResponse() {
      release.resolve();
    },
    waitUntilStarted() {
      return started.promise;
    },
  };
}

export function createProviderHandler({ closeBarrier, paths, retrievalBranch }) {
  return async ({ body }) => {
    const category = classifyRequest(body);
    const text = requestText(body);

    if (category === "selector") {
      const selectedMemory = text.includes(memoryE2EText.extractedDefaultPrompt)
        ? "deployment-approval-policy.md"
        : "database-test-policy.md";
      return completion({
        content: JSON.stringify({ selected_memories: [selectedMemory] }),
        id: `memory-selector-${selectedMemory.replace(".md", "")}`,
      });
    }

    if (category === "extraction") {
      if (text.includes(memoryE2EText.closeCancellationPrompt)) {
        await closeBarrier.blockResponse();
        return completion({
          id: "memory-close-cancelled-extraction-late-write",
          toolCalls: [
            toolCall("memory_close_cancelled_extraction_write", "Write", {
              content: memoryE2EText.closeCancellationWriteMarker,
              file_path: paths.shutdown.cancelledFile,
            }),
          ],
        });
      }
      if (!text.includes(memoryE2EText.extractionPrompt)) {
        return completion({ content: "Nothing to save.", id: "memory-extraction-default-noop" });
      }
      if (text.includes(memoryE2EText.extractedIndexPointer)) {
        return completion({ content: "Nothing to save.", id: "memory-extraction-finished" });
      }
      if (text.includes(memoryE2EText.extractionWriteMarker)) {
        return completion({
          id: "memory-extraction-index-edit",
          toolCalls: [
            toolCall("memory_extraction_index_edit", "Edit", {
              file_path: paths.project.indexFile,
              new_string: updatedProjectMemoryIndex(),
              old_string: initialProjectMemoryIndex(),
            }),
          ],
        });
      }
      return completion({
        id: "memory-extraction-write",
        toolCalls: [
          toolCall("memory_extraction_write", "Write", {
            content: extractedMemoryFile(),
            file_path: paths.project.extractedFile,
          }),
          toolCall("memory_extraction_index_read", "Read", {
            file_path: paths.project.indexFile,
          }),
        ],
      });
    }

    if (category === "custom_agent") {
      if (text.includes(memoryE2EText.customWriteMarker)) {
        return completion({
          content: memoryE2EText.customResultMarker,
          id: "custom-memory-finished",
        });
      }
      return completion({
        id: "custom-memory-write",
        toolCalls: [
          toolCall("custom_memory_write", "Write", {
            content: customMemoryFile(),
            file_path: paths.custom.memoryFile,
          }),
        ],
      });
    }

    if (text.includes(memoryE2EText.disabledPrompt)) {
      return completion({ content: "Disabled Memory request completed.", id: "memory-disabled" });
    }
    if (text.includes(memoryE2EText.headlessPrompt)) {
      return completion({ content: "Headless Memory request completed.", id: "memory-headless" });
    }
    if (text.includes(memoryE2EText.closeCancellationPrompt)) {
      return completion({
        content: "Memory Extraction close scenario scheduled.",
        id: "memory-close-cancellation-main",
      });
    }
    if (text.includes(memoryE2EText.extractedDefaultPrompt)) {
      if (
        retrievalBranch === "semantic-recall" &&
        !text.includes(memoryE2EText.extractedRecallBoundaryMarker)
      ) {
        return completion({
          id: "memory-extracted-recall-boundary",
          toolCalls: [
            toolCall("memory_extracted_recall_boundary", "Bash", {
              command: `printf ${memoryE2EText.extractedRecallBoundaryMarker}`,
            }),
          ],
        });
      }
      return completion({
        content:
          retrievalBranch === "semantic-recall"
            ? "Extracted project Memory recalled."
            : "Updated project Memory index loaded.",
        id: "memory-extracted-default",
      });
    }
    if (text.includes(memoryE2EText.customParentPrompt)) {
      if (text.includes(memoryE2EText.customResultMarker)) {
        return completion({ content: "Custom Memory task completed.", id: "custom-parent-final" });
      }
      return completion({
        id: "custom-parent-agent",
        toolCalls: [
          toolCall("custom_parent_agent", "Agent", {
            description: "Persist review convention",
            prompt: memoryE2EText.customTaskPrompt,
            subagent_type: "memory-curator",
          }),
        ],
      });
    }
    if (text.includes(memoryE2EText.extractionPrompt)) {
      return completion({ content: "Deployment policy noted.", id: "memory-main-extraction" });
    }
    if (text.includes(memoryE2EText.defaultBranchPrompt)) {
      if (text.includes(memoryE2EText.defaultBoundaryMarker)) {
        return completion({ content: "Default Memory branch completed.", id: "memory-main-final" });
      }
      return completion({
        id: "memory-main-tool-boundary",
        toolCalls: [
          toolCall("memory_default_branch_boundary", "Bash", {
            command: `printf ${memoryE2EText.defaultBoundaryMarker}`,
          }),
        ],
      });
    }

    throw new Error(`Unexpected Memory E2E provider request: ${text.slice(-1_000)}`);
  };
}

export function classifyRequest(body) {
  const text = requestText(body);
  if (text.includes(memoryE2EText.selectorMarker)) return "selector";
  if (text.includes(memoryE2EText.extractionMarker)) return "extraction";
  if (text.includes(memoryE2EText.customMemoryMarker)) return "custom_agent";
  return "main";
}

export function requestText(body) {
  return [contentText(body.system), contentText(body.messages ?? body.input ?? [])]
    .filter(Boolean)
    .join("\n");
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const primary = [value.text, value.content, value.output]
    .map(contentText)
    .filter(Boolean)
    .join("\n");
  const toolPayload = [value.input, value.arguments, value.tool_calls]
    .filter((item) => item !== undefined)
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    .join("\n");
  return [primary, toolPayload].filter(Boolean).join("\n");
}

function completion({ content = "", id, toolCalls }) {
  return {
    body: {
      content: toolCalls
        ? toolCalls.map((call) => ({
            id: call.id,
            input: JSON.parse(call.function.arguments),
            name: call.function.name,
            type: "tool_use",
          }))
        : [{ text: content, type: "text" }],
      id: `msg_${id}`,
      model: modelId,
      role: "assistant",
      stop_reason: toolCalls ? "tool_use" : "end_turn",
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function toolCall(id, name, input) {
  return {
    function: { arguments: JSON.stringify(input), name },
    id,
    type: "function",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function existingMemoryFile() {
  return `---
name: database-test-policy
description: Database tests must use the real database rather than mocks.
metadata:
  type: feedback
---

Use the real database for database tests; mocked database tests are not trusted.

**Why:** A prior mocked test passed while production migration behavior failed.

**How to apply:** Use the real database for database integration tests.
`;
}

export function initialProjectMemoryIndex() {
  return "- [Database test policy](database-test-policy.md) — integration tests use isolated databases\n";
}

export function updatedProjectMemoryIndex() {
  return `${initialProjectMemoryIndex()}${memoryE2EText.extractedIndexPointer}\n`;
}

function extractedMemoryFile() {
  return `---
name: deployment-approval-policy
description: Deployment requires staging approval for an audit trail.
metadata:
  type: project
---

Deployment requires staging approval. ${memoryE2EText.extractionWriteMarker}

**Why:** Release managers need an audit trail.

**How to apply:** Require staging approval before deployment.
`;
}

function customMemoryFile() {
  return `---
name: review-convention
description: Review findings should be grounded in first-hand evidence.
metadata:
  type: feedback
---

Ground review findings in first-hand evidence. ${memoryE2EText.customWriteMarker}

**Why:** It prevents speculative defects.

**How to apply:** Reproduce or inspect the active path before reporting a finding.
`;
}

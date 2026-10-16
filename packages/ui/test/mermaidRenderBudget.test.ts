import { describe, expect, it } from "vitest";
import {
  resolveMermaidAutoRenderDecision,
  MERMAID_AUTO_RENDER_MAX_LINES,
} from "@/lib/mermaidRenderBudget.js";

describe("mermaidRenderBudget", () => {
  it("allows ordinary mermaid diagrams to render automatically", () => {
    const decision = resolveMermaidAutoRenderDecision("graph TD\nA-->B");

    expect(decision.shouldRender).toBe(true);
  });

  it("skips automatic rendering while the document is hidden", () => {
    const decision = resolveMermaidAutoRenderDecision("graph TD\nA-->B", {
      documentVisibilityState: "hidden",
    });

    expect(decision).toMatchObject({
      shouldRender: false,
      reason: "document-hidden",
    });
  });

  it("skips automatic rendering when the line budget is exceeded", () => {
    const source = [
      "graph TD",
      ...Array.from(
        { length: MERMAID_AUTO_RENDER_MAX_LINES + 1 },
        (_, index) => `A${index}-->A${index + 1}`,
      ),
    ].join("\n");
    const decision = resolveMermaidAutoRenderDecision(source);

    expect(decision).toMatchObject({
      shouldRender: false,
      reason: "line-count-too-large",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  buildExploreAllowedTools,
  formatExploreAllowedToolsForAgentDescription,
} from "../src/subagent/explore-tools.js";

describe("Explore tool policy", () => {
  it("keeps direct and embedded-search Explore tool lists in sync with provider-visible text", () => {
    expect(buildExploreAllowedTools()).toEqual([
      "Bash",
      "Glob",
      "Grep",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    expect(formatExploreAllowedToolsForAgentDescription()).toBe(
      "Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite",
    );

    expect(buildExploreAllowedTools({ embeddedSearchEnabled: true })).toEqual([
      "Bash",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    expect(
      formatExploreAllowedToolsForAgentDescription({ embeddedSearchEnabled: true }),
    ).toBe("Read, Bash, WebFetch, WebSearch, TodoWrite");
  });
});

import { describe, expect, it } from "vitest";
import type { ZCodeSlashCommand } from "@zcode/shared";
import {
  extractActiveSlashQuery,
  filterSlashCommands,
  replaceActiveSlashCommand,
} from "../src/lib/slashCommands.js";

const commands: ZCodeSlashCommand[] = [
  {
    name: "agent-browser",
    description: "Browser automation CLI for AI agents",
  },
  {
    name: "ai-elements",
    description: "Build AI chat interfaces using ai-elements components",
  },
  {
    name: "plain-docs",
    description: "Reference plain-text docs",
  },
];

describe("extractActiveSlashQuery", () => {
  it("returns the query when the current line starts with slash", () => {
    expect(extractActiveSlashQuery("/agent"))?.toBe("agent");
    expect(extractActiveSlashQuery("hello\n/agent"))?.toBe("agent");
  });

  it("returns empty string for a fresh slash trigger", () => {
    expect(extractActiveSlashQuery("/"))?.toBe("");
  });

  it("returns null when slash is not at the beginning of the line", () => {
    expect(extractActiveSlashQuery("hello /agent")).toBeNull();
    expect(extractActiveSlashQuery("/agent test")).toBeNull();
    expect(extractActiveSlashQuery("/agent\ttest")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("keeps original order when query is empty", () => {
    expect(filterSlashCommands(commands, "").map((command) => command.name)).toEqual([
      "agent-browser",
      "ai-elements",
      "plain-docs",
    ]);
  });

  it("prefers prefix matches over weaker fuzzy matches", () => {
    expect(filterSlashCommands(commands, "ai").map((command) => command.name)).toEqual([
      "ai-elements",
      "plain-docs",
      "agent-browser",
    ]);
  });

  it("supports subsequence fuzzy matching", () => {
    expect(filterSlashCommands(commands, "aeb").map((command) => command.name)).toEqual([
      "agent-browser",
    ]);
  });
});

describe("replaceActiveSlashCommand", () => {
  it("replaces the active slash token and moves cursor after the command", () => {
    expect(replaceActiveSlashCommand("/ag", "", "agent-browser")).toEqual({
      cursorOffset: 15,
      text: "/agent-browser ",
    });
  });

  it("preserves text after the slash token once whitespace starts", () => {
    expect(replaceActiveSlashCommand("hello\n/ag", " remaining text", "agent-browser")).toEqual({
      cursorOffset: 21,
      text: "hello\n/agent-browser  remaining text",
    });
  });

  it("drops the unmatched token tail after the cursor", () => {
    expect(replaceActiveSlashCommand("/ag", "ent-browser", "agent-browser")).toEqual({
      cursorOffset: 15,
      text: "/agent-browser ",
    });
  });
});

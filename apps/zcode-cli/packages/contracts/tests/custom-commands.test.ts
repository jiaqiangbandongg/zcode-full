import { describe, expect, it } from "vitest";
import {
  expandCustomCommandPrompt,
  splitCustomCommandArguments,
  type CustomCommandContent,
} from "../src/commands/index.js";

describe("custom command expansion", () => {
  it("expands all and positional arguments without shell parsing", () => {
    const command = createCommand("Review $ARGUMENTS then run $1 for $2.");
    const expanded = expandCustomCommandPrompt({
      args: '"auth flow" high',
      command,
    });

    expect(expanded.argumentCount).toBe(2);
    expect(expanded.prompt).toContain('Review "auth flow" high');
    expect(expanded.prompt).toContain("then run auth flow for high");
  });

  it("appends arguments when the template has no placeholders", () => {
    const expanded = expandCustomCommandPrompt({
      args: "src/auth.ts",
      command: createCommand("Review the code."),
    });

    expect(expanded.prompt).toContain("Review the code.");
    expect(expanded.prompt).toContain("User arguments:\nsrc/auth.ts");
  });

  it("fails closed for shell expansion syntax", () => {
    expect(() =>
      expandCustomCommandPrompt({
        args: "",
        command: createCommand("Status: !`git status`"),
      }),
    ).toThrow(/unsupported shell expansion/);
  });

  it("splits quoted arguments consistently", () => {
    expect(splitCustomCommandArguments("'one two' three\\ four")).toEqual([
      "one two",
      "three four",
    ]);
  });
});

function createCommand(content: string): CustomCommandContent {
  return {
    bytesRead: content.length,
    content,
    metadata: {
      allowedTools: [],
      description: "Demo command",
      disableNonInteractive: false,
      frontmatterKeys: [],
      name: "demo",
      path: "/tmp/demo.md",
      rootPath: "/tmp",
      scope: "project",
      source: "zcode",
    },
    sizeBytes: content.length,
    truncated: false,
  };
}

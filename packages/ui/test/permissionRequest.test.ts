import type { ZCodePermissionRequest } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  getPermissionOptionDisplayKind,
  getPermissionRequestPreview,
  sortPermissionOptions,
} from "../src/lib/permissionRequest.js";

function createPermissionRequest(
  overrides: Partial<Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">> = {},
): Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw"> {
  return {
    title: "Run a shell command",
    description: "Run a shell command",
    kind: "execute",
    raw: {
      rawInput: {
        command: "git restore --staged",
        args: ["packages/ui/src/SlashCommandPlugin.tsx"],
      },
      locations: [
        { path: "/Users/dev/workspace/z-code/packages/ui/src/SlashCommandPlugin.tsx" },
        { path: "/Users/dev/workspace/z-code/packages/ui/src/ChatView.tsx" },
      ],
    },
    ...overrides,
  };
}

describe("permissionRequest helpers", () => {
  it("orders allow options ahead of always-allow and reject options", () => {
    const orderedOptions = sortPermissionOptions([
      {
        optionId: "reject-always",
        kind: "reject_always",
        name: "Always deny",
        response: { decision: "deny" },
      },
      {
        optionId: "allow-always",
        kind: "allow_always",
        name: "Always allow",
        response: { decision: "allow" },
      },
      {
        optionId: "reject-once",
        kind: "reject_once",
        name: "Deny",
        response: { decision: "deny" },
      },
      {
        optionId: "allow-once",
        kind: "allow_once",
        name: "Allow",
        response: { decision: "allow" },
      },
    ]);

    expect(orderedOptions.map((option) => option.optionId)).toEqual([
      "allow-once",
      "allow-always",
      "reject-once",
      "reject-always",
    ]);
  });

  it("maps ZCode Agent option kinds to stable display kinds", () => {
    expect(getPermissionOptionDisplayKind("allow_once")).toBe("allowOnce");
    expect(getPermissionOptionDisplayKind("allow_always")).toBe("allowAlways");
    expect(getPermissionOptionDisplayKind("reject_once")).toBe("rejectOnce");
    expect(getPermissionOptionDisplayKind("reject_always")).toBe("rejectAlways");
    expect(getPermissionOptionDisplayKind("ask_user")).toBe("custom");
  });

  it("extracts commands and affected files from the raw ZCode Agent payload", () => {
    const preview = getPermissionRequestPreview(createPermissionRequest());

    expect(preview.title).toBe("Run a shell command");
    expect(preview.command).toBe("git restore --staged packages/ui/src/SlashCommandPlugin.tsx");
    expect(preview.filePaths).toEqual([
      "/Users/dev/workspace/z-code/packages/ui/src/SlashCommandPlugin.tsx",
      "/Users/dev/workspace/z-code/packages/ui/src/ChatView.tsx",
    ]);
    expect(preview.scope).toBe("command");
  });

  it("falls back to file scope and ignores cwd-like directory fields", () => {
    const preview = getPermissionRequestPreview(
      createPermissionRequest({
        title: "Read files",
        description: "Read files",
        raw: {
          rawInput: {
            cwd: "/Users/dev/workspace/z-code",
            files: [
              "/Users/dev/workspace/z-code/packages/ui/src/App.tsx",
              "/Users/dev/workspace/z-code/packages/ui/src/App.tsx",
            ],
          },
        },
      }),
    );

    expect(preview.command).toBeNull();
    expect(preview.filePaths).toEqual([
      "/Users/dev/workspace/z-code/packages/ui/src/App.tsx",
    ]);
    expect(preview.scope).toBe("file");
  });

  it("extracts file scope from ZCode protocol input payloads", () => {
    const preview = getPermissionRequestPreview(
      createPermissionRequest({
        title: "Write",
        description: "Tool has side effects and requires approval",
        kind: "Write",
        raw: {
          toolName: "Write",
          input: {
            file_path: "/Users/dev/workspace/z-code/packages/ui/src/App.tsx",
            content: "export const value = 1;\n",
          },
        },
      }),
    );

    expect(preview.command).toBeNull();
    expect(preview.filePaths).toEqual([
      "/Users/dev/workspace/z-code/packages/ui/src/App.tsx",
    ]);
    expect(preview.scope).toBe("file");
  });

  it("extracts single-file add and update changes for permission preview", () => {
    const preview = getPermissionRequestPreview(
      createPermissionRequest({
        title: "Apply patch",
        description: "Apply patch",
        raw: {
          changes: {
            "/Users/dev/workspace/z-code/README.md": {
              type: "add",
              content: "\n",
            },
          },
        },
      }),
    );

    expect(preview.fileChange).toEqual({
      path: "/Users/dev/workspace/z-code/README.md",
      type: "add",
    });
    expect(preview.fileChanges).toEqual([
      {
        path: "/Users/dev/workspace/z-code/README.md",
        type: "add",
      },
    ]);
  });

  it("extracts multiple file changes for grouped permission previews", () => {
    const preview = getPermissionRequestPreview(
      createPermissionRequest({
        title: "Apply patch",
        description: "Apply patch",
        raw: {
          changes: {
            "/Users/dev/workspace/z-code/index.html": {
              type: "update",
              content: "<html></html>",
            },
            "/Users/dev/workspace/z-code/styles.css": {
              type: "update",
              content: "body {}",
            },
            "/Users/dev/workspace/z-code/script.js": {
              type: "update",
              content: "console.log('ok')",
            },
          },
        },
      }),
    );

    expect(preview.fileChange).toBeNull();
    expect(preview.fileChanges).toEqual([
      {
        path: "/Users/dev/workspace/z-code/index.html",
        type: "update",
      },
      {
        path: "/Users/dev/workspace/z-code/styles.css",
        type: "update",
      },
      {
        path: "/Users/dev/workspace/z-code/script.js",
        type: "update",
      },
    ]);
  });
});

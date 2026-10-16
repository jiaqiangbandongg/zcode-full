import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_HOOK_SCHEMA_FIELDS } from "../../contracts/src/hooks/index.js";
import { createConfig } from "../src/config/index.js";
import {
  hookCommandSchema,
  hookMatcherSchema,
  hookProcessSchema,
  hooksSchema,
} from "../src/config/schema.js";

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("workspace hook trust phase 0", () => {
  it("真实 Hook file schema 与 canonical exhaustive lock 保持一致", () => {
    expect(schemaKeys(hooksSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.root);
    expect(schemaKeys(hookMatcherSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.matcher);
    expect(schemaKeys(hooksSchema.shape.events.unwrap())).toEqual(
      WORKSPACE_HOOK_SCHEMA_FIELDS.events,
    );
    expect(schemaKeys(hookProcessSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.process);
    expect(schemaKeys(hookCommandSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.command);
  });

  it("startup/resume/async project hooks 在 admission 实现前继续 hard block", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-hard-block-"));
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".zcode"), { recursive: true });
      await writeFile(
        join(root, ".zcode", "config.json"),
        JSON.stringify({
          hooks: {
            enabled: true,
            events: {
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [{ type: "command", command: "echo startup-project-hook" }],
                },
                {
                  matcher: "resume",
                  hooks: [
                    {
                      type: "command",
                      command: "echo resume-project-hook",
                      async: true,
                    },
                  ],
                },
              ],
            },
          },
        }),
      );

      const result = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });

      expect(result.sources.project.diagnostics).toContainEqual(
        expect.objectContaining({ code: "config_project_hooks_pending_trust", path: "hooks" }),
      );
      expect(result.config.hooks.enabled).toBe(false);
      expect(result.config.hooks.events.SessionStart).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

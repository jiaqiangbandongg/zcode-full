// S08：skills/referenceCatalog 的 workspace/session authority 契约。
// session 直读 runtime 冻结目录；draft 重新扫描 workspace；未知 session fail closed。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeSkillsReferenceCatalogParamsSchema,
  zcodeSkillsReferenceCatalogResultSchema,
} from "@zcode/shared";
import type { SkillLoadOutcome } from "@zcode/contracts";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

const SESSION_CATALOG: SkillLoadOutcome = {
  skills: [
    {
      name: "frozen",
      description: "Frozen session skill",
      path: "/workspace/.zcode/skills/frozen/SKILL.md",
      directory: "/workspace/.zcode/skills/frozen",
      rootPath: "/workspace/.zcode/skills",
      scope: "project",
      source: "zcode",
      safeToAutoLoad: true,
      frontmatterKeys: ["name", "description"],
    },
  ],
  diagnostics: [],
  totalDiscovered: 1,
};

function contextWithSession(sessionId: string): ZCodeProtocolAgentServerContext {
  const record = {
    app: {
      getSkillCatalog: async () => SESSION_CATALOG,
    },
  } as unknown as ZCodeProtocolSessionRecord;
  return {
    deps: { env: {} },
    sessions: new Map([[sessionId, record]]),
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("skills/referenceCatalog protocol", () => {
  it("registers the method and strict schemas", () => {
    expect(zcodeProtocolMethods.skillsReferenceCatalog).toBe("skills/referenceCatalog");
    expect(() =>
      zcodeSkillsReferenceCatalogParamsSchema.parse({
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        sessionId: "session-a",
      }),
    ).not.toThrow();
    expect(() =>
      zcodeSkillsReferenceCatalogResultSchema.parse({
        authority: "session",
        skills: [
          {
            id: "glm:workspace:/w/.zcode/skills/demo/SKILL.md",
            name: "demo",
            description: "Demo",
            path: "/w/.zcode/skills/demo/SKILL.md",
            scope: "workspace",
            enabled: true,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("serves the Session runtime frozen catalog", async () => {
    const result = await getSkillReferenceCatalog(contextWithSession("session-a"), {
      workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
      sessionId: "session-a",
    });

    expect(result).toEqual({
      authority: "session",
      skills: [
        {
          id: "glm:workspace:/workspace/.zcode/skills/frozen/SKILL.md",
          name: "frozen",
          description: "Frozen session skill",
          path: "/workspace/.zcode/skills/frozen/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ],
    });
    expect(() => zcodeSkillsReferenceCatalogResultSchema.parse(result)).not.toThrow();
  });

  it("fails closed for an unknown Session instead of falling back to workspace discovery", async () => {
    await expect(
      getSkillReferenceCatalog(contextWithSession("session-a"), {
        workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
        sessionId: "missing",
      }),
    ).rejects.toThrow(/Session is not active/);
  });

  it("rescans the current workspace catalog for a draft request", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-skill-reference-workspace-"));
    const skillDirectory = join(root, ".zcode", "skills", "manual-added");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      ["---", "name: manual-added", "description: Added outside the app.", "---"].join("\n"),
    );
    try {
      const result = await getSkillReferenceCatalog(
        {
          deps: {
            env: {
              HOME: root,
              ZCODE_STORAGE_DIR: join(root, "cli"),
            },
          },
          sessions: new Map(),
        } as unknown as ZCodeProtocolAgentServerContext,
        { workspace: { workspacePath: root, workspaceKey: root } },
      );

      expect(result.authority).toBe("workspace");
      expect(result.skills).toContainEqual(
        expect.objectContaining({
          name: "manual-added",
          description: "Added outside the app.",
          scope: "workspace",
          enabled: true,
        }),
      );
      expect(() => zcodeSkillsReferenceCatalogResultSchema.parse(result)).not.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPersistentAgentMemoryPrompt } from "../src/subagent/persistent-memory-prompt.js";
import {
  loadPersistentAgentMemory,
  projectPersistentAgentMemoryTools,
  resolvePersistentAgentMemoryRoot,
  sanitizePersistentAgentMemoryKey,
} from "../src/subagent/persistent-memory.js";
import { formatAgentProfilesForPrompt, type AgentProfile } from "../src/subagent/profile.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const fixture = readFileSync(
  new URL("./fixtures/memory/custom-agent-memory.md", import.meta.url),
  "utf8",
).replace(/\n$/u, "");

const scopeGuidance = JSON.parse(
  readFileSync(
    new URL("./fixtures/memory/custom-agent-scope-guidance.json", import.meta.url),
    "utf8",
  ),
) as Record<"user" | "project" | "local", string>;

describe("persistent custom-agent memory", () => {
  it("uses the exact agent key replacement and three ZCode scope roots", () => {
    expect(sanitizePersistentAgentMemoryKey("reviewer/a b")).toBe("reviewer-a-b");
    expect(sanitizePersistentAgentMemoryKey("review😀agent")).toBe("review--agent");
    expect(sanitizePersistentAgentMemoryKey("!!!")).toBe("---");
    expect(sanitizePersistentAgentMemoryKey("")).toBe("unknown");

    expect(root("user")).toBe("/storage/agent-memory/reviewer-a-b");
    expect(root("project")).toBe("/workspace/app/.zcode/agent-memory/reviewer-a-b");
    expect(root("local")).toBe("/workspace/app/.zcode/agent-memory-local/reviewer-a-b");
  });

  it.each(["user", "project", "local"] as const)(
    "renders the exact empty %s-scope provider prompt",
    (scope) => {
      const memoryRoot = root(scope);
      const expected = fixture
        .replace("<MEMORY_ROOT>", memoryRoot)
        .replace("<SCOPE_GUIDANCE>", scopeGuidance[scope]);

      expect(
        buildPersistentAgentMemoryPrompt({ indexContent: "", rootDir: memoryRoot, scope }),
      ).toBe(expected);
    },
  );

  it("loads non-empty MEMORY.md and applies the exact 200-line truncation warning", () => {
    const index = Array.from({ length: 201 }, (_, index) => `- memory ${index + 1}`).join("\n");
    const prompt = buildPersistentAgentMemoryPrompt({
      indexContent: index,
      rootDir: root("project"),
      scope: "project",
    });

    expect(prompt).toContain("## MEMORY.md\n\n- memory 1");
    expect(prompt).toContain("- memory 200\n\n> WARNING: MEMORY.md is 201 lines (limit: 200).");
    expect(prompt).not.toContain("- memory 201");
  });

  it("limits a single long MEMORY.md value and formats integer KB like the baseline", () => {
    const prompt = buildPersistentAgentMemoryPrompt({
      indexContent: "x".repeat(25_600),
      rootDir: root("local"),
      scope: "local",
    });

    expect(prompt).toContain(
      `${"x".repeat(25_000)}\n\n> WARNING: MEMORY.md is 25KB (limit: 24.4KB) — index entries are too long.`,
    );
  });

  it("adds only Write/Edit for explicit tools, then keeps existing filtering", () => {
    const profile = customProfile({
      disallowedTools: ["Edit"],
      memory: "project",
      tools: ["Grep"],
    });
    const config = projectPersistentAgentMemoryTools({
      memory: { enabled: true, storageRoot: "/storage", use: true },
      subagents: { profiles: [profile] },
    });
    const projected = config.subagents?.profiles?.[0];

    expect(projected?.tools).toEqual(["Grep", "Write", "Edit"]);
    expect(projected?.tools).not.toContain("Read");
    expect(formatAgentProfilesForPrompt([projected!])).toContain(
      "- reviewer/a b: Review changes. (Tools: Grep, Write)",
    );
    expect(
      projectPersistentAgentMemoryTools({
        memory: { enabled: false, storageRoot: "/storage", use: true },
        subagents: { profiles: [profile] },
      }).subagents?.profiles?.[0]?.tools,
    ).toEqual(["Grep"]);
    expect(
      projectPersistentAgentMemoryTools({
        memory: { enabled: true, storageRoot: "/storage", use: true },
        subagents: { profiles: [customProfile({ memory: "project" })] },
      }).subagents?.profiles?.[0]?.tools,
    ).toBeUndefined();
    expect(
      projectPersistentAgentMemoryTools({
        memory: { enabled: true, storageRoot: "/storage", use: true },
        subagents: { profiles: [customProfile({ memory: "project", tools: [] })] },
      }).subagents?.profiles?.[0]?.tools,
    ).toEqual(["Write", "Edit"]);

  });

  it("reads MEMORY.md for every child launch and creates nothing when globally disabled", async () => {
    const memoryRoot = root("project");
    const indexPath = join(memoryRoot, "MEMORY.md");
    const fileSystem = new MemoryFileSystem({ [indexPath]: "first index" });
    const profile = customProfile({ memory: "project", tools: ["Write"] });
    const memory = { enabled: true, storageRoot: "/storage", use: true };

    const first = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory,
      profile,
      workspaceRoot: "/workspace/app",
    });
    fileSystem.files[indexPath] = "second index";
    const second = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory,
      profile,
      workspaceRoot: "/workspace/app",
    });

    expect(first?.prompt).toContain("## MEMORY.md\n\nfirst index");
    expect(second?.prompt).toContain("## MEMORY.md\n\nsecond index");
    expect(first?.rootDir).toBe(memoryRoot);
    expect(fileSystem.createdDirectories).toContain(memoryRoot);

    const disabledFileSystem = new MemoryFileSystem({});
    expect(
      await loadPersistentAgentMemory({
        fileSystemPort: disabledFileSystem,
        memory: { enabled: false, storageRoot: "/storage", use: true },
        profile,
        workspaceRoot: "/workspace/app",
      }),
    ).toBeUndefined();
    expect(disabledFileSystem.createdDirectories.size).toBe(0);
  });

  it("still returns the custom Memory prompt when directory creation fails", async () => {
    const fileSystem = new MemoryFileSystem({});
    fileSystem.createDirectory = async () => {
      throw new Error("mkdir failed");
    };

    const loaded = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory: { enabled: true, storageRoot: "/storage", use: true },
      profile: customProfile({ memory: "user", tools: ["Write"] }),
      workspaceRoot: "/workspace/app",
    });

    expect(loaded?.rootDir).toBe("/storage/agent-memory/reviewer-a-b");
    expect(loaded?.prompt).toContain("# Persistent Agent Memory");
  });
});

function root(scope: "user" | "project" | "local"): string {
  return resolvePersistentAgentMemoryRoot({
    agentName: "reviewer/a b",
    scope,
    storageRoot: "/storage",
    workspaceRoot: "/workspace/app",
  });
}

function customProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    description: "Review changes.",
    name: "reviewer/a b",
    source: "project",
    systemPrompt: "Review carefully.",
    ...overrides,
  };
}

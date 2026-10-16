import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createAgentStateId, type SubagentRuntimeConfig } from "@zcode/shared";
import type { ModelRequest } from "@zcode/contracts";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { parseRuntimeSubagentConfig } from "../src/subagent-runtime-config.js";
import * as subagents from "../src/subagents.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

describe("runtime subagent source parsing", () => {
  it("preserves complete profiles, strips project permission and applies disabled user ids", () => {
    const parsed = parseRuntimeSubagentConfig({
      documents: [
        {
          path: "/project/.zcode/agents/reviewer.md",
          source: "project",
          content:
            "---\nname: reviewer\ndescription: Review\npermissionMode: bypassPermissions\nmodel: custom:provider:model\nthoughtLevel: high\ntools: Read, Grep\n---\nNEW_PROMPT",
        },
      ],
      state: {
        disabledAgentIds: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      },
    });
    expect(parsed.profiles[0]).toMatchObject({
      name: "reviewer",
      systemPrompt: "NEW_PROMPT",
      tools: ["Read", "Grep"],
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    expect(parsed.profiles[0]?.permissionMode).toBeUndefined();
    const disabled = createAgentStateId({ name: "reviewer", scope: "user", source: "user" });
    const deleted = parseRuntimeSubagentConfig({
      documents: [
        {
          path: "/user/reviewer.md",
          source: "user",
          content: "---\nname: reviewer\ndescription: Review\n---\nPrompt",
        },
      ],
      state: {
        disabledAgentIds: [disabled],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      },
    });
    expect(deleted.profiles).toEqual([]);
  });
});

describe("subagent initialization source", () => {
  it.each(["host", "files"] as const)(
    "initializes from %s and preserves other storage settings",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "subagent-initial-source-"));
      const workspace = join(root, "workspace"),
        storage = join(root, "cli-storage");
      const configPath = join(root, "config.json");
      const logDir = join(root, "logs");
      const invalidDocument = {
        path: join(workspace, ".zcode", "agents", "invalid.md"),
        source: "project" as const,
        content: "This document intentionally lacks frontmatter",
      };
      const readDiagnostics = async () =>
        (
          await Promise.all(
            (await readdir(logDir)).map((name) => readFile(join(logDir, name), "utf8")),
          )
        )
          .flatMap((text) =>
            text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          )
          .filter((entry) => entry.message === "Agent profile diagnostic");
      const expectedDiagnostic = {
        level: "warn",
        module: "bootstrap.subagents",
        context: {
          code: "agent_missing_frontmatter",
          path: invalidDocument.path,
          message: `Agent Markdown must include frontmatter: ${invalidDocument.path}`,
        },
      };
      const markdown = (prompt: string) =>
        `---\nname: reviewer\ndescription: Review\ntools: Read\n---\n${prompt}`;
      const hostConfig = (prompt: string): SubagentRuntimeConfig => ({
        kind: "ready",
        profiles: [
          {
            path: join(root, "host-agents", "reviewer.md"),
            source: "user",
            name: "reviewer",
            description: "Review",
            tools: ["Read"],
            systemPrompt: prompt,
          },
        ],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      });
      const initial = Promise.withResolvers<SubagentRuntimeConfig>();
      const readHost = vi.fn(async () => initial.promise);
      const fileLoader = vi.spyOn(subagents, "loadZCodeAgentProfiles");
      const pluginLoader = vi.spyOn(subagents, "loadPluginAgentTemplates");
      const requests: ModelRequest[] = [];
      let parentCalls = 0;
      let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
      let creating: ReturnType<typeof createRegistryBackedTestApp> | undefined;
      try {
        await mkdir(join(storage, "agents"), { recursive: true });
        await mkdir(join(workspace, ".zcode", "agents"), { recursive: true });
        if (source === "files") await writeFile(invalidDocument.path, invalidDocument.content);
        await writeFile(
          configPath,
          JSON.stringify({ storage: { dir: join(root, "unused-storage") } }),
        );
        await writeFile(join(storage, "agents", "reviewer.md"), markdown("DISK_PROFILE"));
        creating = createRegistryBackedTestApp({
          loggerFactory: createNodeLoggerFactory({ logDir }),
          env: {
            ZCODE_STORAGE_DIR: storage,
            ZCODE_SESSION_DB_PATH: join(storage, "cli", "db", "db.sqlite"),
          },
          userConfigPath: configPath,
          runtimeConfig: {
            workingDirectory: workspace,
            mode: "yolo",
            mcp: { enabled: false, servers: {} },
            modelSelection: {
              providerId: "zai",
              modelId: "glm-4.6",
              options: { reasoningLevel: "low" },
            },
          },
          ...(source === "host" ? { readSubagentRuntimeConfig: readHost } : {}),
          modelExecutor: {
            async generateText(request) {
              const isChild = JSON.stringify(request.messages).includes("_PROFILE");
              if (isChild) requests.push(request);
              return !isChild && ++parentCalls === 1
                ? {
                    finishReason: "tool-calls",
                    text: "",
                    usage: {},
                    toolCalls: [
                      {
                        id: "source_agent",
                        name: "Agent",
                        input: {
                          description: "Review",
                          prompt: "Review",
                          subagent_type: "reviewer",
                        },
                      },
                    ],
                  }
                : { finishReason: "stop", text: "done", usage: {} };
            },
          },
        });
        if (source === "host") {
          let created = false;
          void creating.then(
            () => {
              created = true;
            },
            () => {},
          );
          await vi.waitFor(() => expect(readHost).toHaveBeenCalledTimes(1));
          expect(created).toBe(false);
          expect(fileLoader).not.toHaveBeenCalled();
          initial.resolve(hostConfig("INITIAL_PROFILE"));
        }
        app = await creating;
        // Host 已记录解析诊断；CLI 不再重复解析/记录，独立 loader 保持诊断。
        expect(await readDiagnostics()).toMatchObject(
          source === "files" ? [expectedDiagnostic] : [],
        );
        expect(fileLoader).toHaveBeenCalledTimes(source === "host" ? 0 : 1);
        expect(pluginLoader).toHaveBeenCalledTimes(1);
        readHost.mockResolvedValue(hostConfig("NEXT_PROFILE"));
        await app.submitPrompt("Please delegate the review");
        expect(readHost).toHaveBeenCalledTimes(source === "host" ? 2 : 0);
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0])).toContain(
          source === "host" ? "NEXT_PROFILE" : "DISK_PROFILE",
        );
        expect(pluginLoader).toHaveBeenCalledTimes(1);
        expect((await readdir(join(storage, "cli", "agents"))).length).toBeGreaterThan(0);
        const diagnostics = await readDiagnostics();
        expect(diagnostics).toMatchObject(
          Array.from({ length: source === "host" ? 0 : 1 }, () => expectedDiagnostic),
        );
        expect(JSON.stringify(diagnostics)).not.toContain(invalidDocument.content);
        // 只替换 subagent 来源；实际 session 数据库仍在环境变量指定的位置。
        expect((await readFile(join(storage, "cli", "db", "db.sqlite"))).length).toBeGreaterThan(0);
      } finally {
        initial.resolve(hostConfig("INITIAL_PROFILE"));
        await (app ?? (await creating?.catch(() => undefined)))?.close?.();
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps builtins and inline definitions through fallback and restores cached plugin templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-fallback-"));
    const profile = (name: string) => ({
      name,
      description: `${name} description`,
      systemPrompt: name,
      source: "user" as const,
    });
    const readHost = vi.fn(
      async (): Promise<SubagentRuntimeConfig> => ({ kind: "built-in-fallback" }),
    );
    const loadTemplates = vi.spyOn(subagents, "loadPluginAgentTemplates");
    const resolvePlugins = vi.spyOn(subagents, "resolvePluginAgentProfiles").mockReturnValue({
      profiles: [profile("fixture:worker")],
      diagnostics: [],
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
    });
    const requests: ModelRequest[] = [];
    let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
    try {
      app = await createRegistryBackedTestApp({
        env: { ZCODE_STORAGE_DIR: root, ZCODE_SESSION_DB_PATH: join(root, "db.sqlite") },
        skipUserConfig: true,
        runtimeConfig: {
          workingDirectory: root,
          mcp: { enabled: false, servers: {} },
          subagents: { profiles: [profile("inline-reviewer")] },
        },
        readSubagentRuntimeConfig: readHost,
        modelExecutor: {
          async generateText(request) {
            requests.push(request);
            return { finishReason: "stop", text: "done", usage: {} };
          },
        },
      });
      await app.submitPrompt("Fallback turn");
      const first = JSON.stringify(requests[0]);
      for (const name of ["Explore", "general-purpose", "inline-reviewer"])
        expect(first).toContain(name);
      expect(first).not.toContain("fixture:worker");
      expect(resolvePlugins).not.toHaveBeenCalled();
      readHost.mockResolvedValue({
        kind: "ready",
        profiles: [profile("file-reviewer")],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      });
      await app.submitPrompt("Recovered turn");
      expect(JSON.stringify(requests[1])).toContain("fixture:worker");
      expect(JSON.stringify(requests[1])).toContain("file-reviewer");
      readHost.mockResolvedValue({ kind: "built-in-fallback" });
      await app.submitPrompt("Fallback again");
      const last = JSON.stringify(requests[2]);
      expect(last).toMatch(/no longer available/);
      expect(last).toContain("inline-reviewer");
      expect(resolvePlugins).toHaveBeenCalledTimes(1);
      expect(loadTemplates).toHaveBeenCalledTimes(1);
      expect(readHost).toHaveBeenCalledTimes(4);
    } finally {
      await app?.close?.();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates an initialization read failure without using the file loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-initial-failure-"));
    const fileLoader = vi.spyOn(subagents, "loadZCodeAgentProfiles");
    const error = new Error("Host configuration unavailable");
    let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
    try {
      await expect(
        createRegistryBackedTestApp({
          env: { ZCODE_STORAGE_DIR: root, ZCODE_SESSION_DB_PATH: join(root, "db.sqlite") },
          skipUserConfig: true,
          runtimeConfig: { workingDirectory: root, mcp: { enabled: false, servers: {} } },
          readSubagentRuntimeConfig: async () => {
            throw error;
          },
        }).then((created) => {
          app = created;
          return "created";
        }),
      ).rejects.toBe(error);
      expect(fileLoader).not.toHaveBeenCalled();
    } finally {
      await app?.close?.();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});

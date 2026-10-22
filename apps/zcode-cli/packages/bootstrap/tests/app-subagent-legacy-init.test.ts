import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { describe, expect, it, vi } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import type { ZCodeApp } from "../src/app/types.js";

const { resolveRuntimeConfig } = vi.hoisted(() => ({ resolveRuntimeConfig: vi.fn() }));
vi.mock("../src/app/runtime-config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/runtime-config.js")>();
  return {
    ...original,
    resolveAppRuntimeConfig: (...args: Parameters<typeof original.resolveAppRuntimeConfig>) => {
      resolveRuntimeConfig(...args);
      return original.resolveAppRuntimeConfig(...args);
    },
  };
});

describe("App 初始化旧 Subagent 身份", () => {
  // 真实文件迁移与 App 初始化在高负载下可能超过默认 5 秒，保留全部迁移顺序断言。
  it("用户目录完成原地迁移再构造 Runtime；项目文件不迁移也不暗中换身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-subagent-init-"));
    const directory = join(root, ".zcode", "agents");
    const file = join(directory, "legacy.md");
    const markdown =
      "---\nname: legacy\ndescription: legacy profile\nmodel: builtin:zai-coding-plan/glm-4.6\nthoughtLevel: high\n---\nreview";
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    let app: ZCodeApp | undefined;
    let creation: Promise<ZCodeApp> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(file, markdown);
      const userRoot = join(root, "storage", "agents");
      await mkdir(userRoot, { recursive: true });
      await writeFile(
        join(userRoot, "user.md"),
        markdown.replace("name: legacy", "name: user-legacy"),
      );
      await mkdir(join(root, "storage", "v2"), { recursive: true });
      const stateFile = join(root, "storage", "v2", "agents-state.json");
      await writeFile(
        stateFile,
        JSON.stringify({
          builtInModelOverrides: { Explore: "builtin:zai-coding-plan/glm-4.6" },
          builtInThoughtLevelOverrides: { Explore: "high" },
        }),
      );
      resolveRuntimeConfig.mockClear();
      creation = Promise.resolve(
        createRegistryBackedTestApp({
          env: { ZCODE_STORAGE_DIR: join(root, "storage") },
          skipUserConfig: true,
          sessionStore: store,
          runtimeConfig: { workingDirectory: root, mcp: { enabled: false } },
        }),
      );
      app = await creation;
      // 用户配置迁移同时规范账户模型 ID 的大小写，项目文档仍保持原字节。
      expect(resolveRuntimeConfig.mock.calls[0]?.[0].subagentProfiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "user-legacy",
            modelSelection: {
              providerId: "account:zai-individual-coding-plan",
              modelId: "GLM-4.6",
              options: { reasoningLevel: "high" },
            },
          }),
        ]),
      );
      expect(resolveRuntimeConfig.mock.calls[0]?.[0].subagentProfiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "legacy",
            modelSelection: {
              providerId: "builtin:zai-coding-plan",
              modelId: "glm-4.6",
              options: { reasoningLevel: "high" },
            },
          }),
        ]),
      );
      expect(await readFile(join(userRoot, "user.md"), "utf8")).toBe(
        markdown
          .replace("name: legacy", "name: user-legacy")
          .replace(
            "model: builtin:zai-coding-plan/glm-4.6",
            "model: account:zai-individual-coding-plan/GLM-4.6",
          ),
      );
      expect(await readFile(file, "utf8")).toBe(markdown);
      expect(
        JSON.parse(await readFile(stateFile, "utf8")).builtInModelSelectionOverrides.Explore,
      ).toEqual({
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-4.6",
        options: { reasoningLevel: "high" },
      });
    } finally {
      app ??= await creation;
      await app?.close?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

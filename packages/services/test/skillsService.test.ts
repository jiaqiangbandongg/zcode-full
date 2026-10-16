import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SKILL_SCAN_DEPTH } from "@zcode/shared";
import type { ISkillsService } from "../src/skills/skills.js";

const originalHome = process.env.HOME;
const originalProcessLabel = process.env.ZCODE_PROCESS_LABEL;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-skills-home-"));
  tempHomes.push(home);
  return home;
}

async function createSkillsServiceInEnv(
  home: string,
  options?: { isDesktopRuntime?: boolean },
): Promise<ISkillsService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/skills/skillsService.js");
  return mod.createSkillsService(options);
}

function writeSkill(basePath: string, folder: string, content: string): void {
  const skillDir = join(basePath, folder);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
}

function writeSkillMeta(basePath: string, folder: string, metadata: unknown): void {
  const skillDir = join(basePath, folder);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "_meta.json"), JSON.stringify(metadata, null, 2), "utf-8");
}

function workspaceSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

function userSkillRoot(home: string): string {
  return join(home, ".zcode", "skills");
}

function userAgentsSkillRoot(home: string): string {
  return join(home, ".agents", "skills");
}

function officialPluginRoot(home: string, pluginName: string, version = "0.1.0"): string {
  return join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    "zcode-plugins-official",
    pluginName,
    version,
  );
}

function marketplacePluginRoot(
  home: string,
  marketplace: string,
  pluginName: string,
  version = "0.0.0",
): string {
  return join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    marketplace,
    pluginName,
    version,
  );
}

function writePluginManifest(pluginRoot: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

function writeClaudePluginManifest(pluginRoot: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

function writeInstalledPluginRecord(
  home: string,
  record: {
    marketplace: string;
    name: string;
    installPath: string;
    version?: string;
  },
): void {
  const pluginsRoot = join(home, ".zcode", "cli", "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  writeFileSync(
    join(pluginsRoot, "installed_plugins.json"),
    JSON.stringify(
      {
        version: 1,
        plugins: [
          {
            id: `${record.name}@${record.marketplace}`,
            name: record.name,
            marketplace: record.marketplace,
            version: record.version ?? "0.0.0",
            installPath: record.installPath,
            installedAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
            scope: "user",
            source: "./plugins/demo",
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeCliConfig(home: string, config: Record<string, unknown>): void {
  const configPath = join(home, ".zcode", "cli", "config.json");
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.ZCODE_PROCESS_LABEL = originalProcessLabel;
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("skillsService", () => {
  it("workspace 同层合并读取 .zcode 与 .agents，并忽略废弃和 Claude 技能目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "repo-review",
      `---
name: repo-review
description: from zcode
---
zcode-body`,
    );
    writeSkill(
      join(workspacePath, ".zcode", "cli", "skills"),
      "old-glm",
      `---
name: old-glm
description: deprecated
---
old-body`,
    );
    writeSkill(
      join(workspacePath, ".agents", "skills"),
      "agents-review",
      `---
name: agents-review
description: from agents
---
agents-body`,
    );
    writeSkill(
      join(workspacePath, ".claude", "skills"),
      "claude-review",
      `---
name: claude-review
description: retired claude
---
claude-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "claude" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["agents-review", "repo-review"]);
    expect(result.skills.find((skill) => skill.name === "agents-review")).toMatchObject({
      description: "from agents",
      scope: "workspace",
      enabled: true,
    });
    expect(result.skills.find((skill) => skill.name === "repo-review")).toMatchObject({
      description: "from zcode",
      scope: "workspace",
      enabled: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "workspace .zcode/skills 软链导入的技能可被 / 和 $ 面板发现",
    async () => {
      const home = makeTempHome();
      const workspacePath = join(home, "workspace");
      const sourceSkillParent = join(home, "external-agent", "skills");
      const sourceSkillDir = join(sourceSkillParent, "imported-skill");
      const linkedSkillDir = join(workspaceSkillRoot(workspacePath), "imported-skill");
      writeSkill(
        sourceSkillParent,
        "imported-skill",
        `---
name: imported-skill
description: imported via symlink
---
imported-body`,
      );
      mkdirSync(workspaceSkillRoot(workspacePath), { recursive: true });
      symlinkSync(sourceSkillDir, linkedSkillDir, "dir");

      const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
      const result = await service.list({ workspacePath, provider: "glm" });

      expect(result.skills.map((skill) => skill.name)).toEqual(["imported-skill"]);
      expect(result.skills[0]).toMatchObject({
        description: "imported via symlink",
        scope: "workspace",
      });
      expect(result.skills[0]?.path).toContain("imported-skill/SKILL.md");
    },
  );

  it("workspace 只有 .agents/skills 时仍能发现技能", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      join(workspacePath, ".agents", "skills"),
      "agents-review",
      `---
name: agents-review
description: from agents
---
agents-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "claude" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["agents-review"]);
    expect(result.skills[0]).toMatchObject({
      description: "from agents",
      scope: "workspace",
    });
  });

  it("递归发现分组目录，跳过隐藏目录但允许 .system 官方目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const root = workspaceSkillRoot(workspacePath);
    writeSkill(
      join(root, "group-a"),
      "public-skill",
      `---
name: public-skill
description: visible
---
public-body`,
    );
    writeSkill(
      join(root, "bundle", ".agents", "skills"),
      "vendored-skill",
      `---
name: vendored-skill
description: hidden
---
vendored-body`,
    );
    writeSkill(
      join(root, ".system"),
      "bundled-system-skill",
      `---
name: bundled-system-skill
description: official
---
system-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      "bundled-system-skill",
      "public-skill",
    ]);
  });

  it.skipIf(process.platform === "win32")("递归扫描时跳过指向文件的软链", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const root = workspaceSkillRoot(workspacePath);
    writeSkill(
      root,
      "zai-grafana-cli",
      `---
name: zai-grafana-cli
description: grafana cli
---
body`,
    );
    const skillDir = join(root, "zai-grafana-cli");
    const binDir = join(skillDir, "bin");
    const executablePath = join(home, "gfctl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(executablePath, "#!/bin/sh\n", "utf-8");
    symlinkSync(executablePath, join(binDir, "gfctl"));

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["zai-grafana-cli"]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "skill_scan_failed")).toBe(
      false,
    );
  });

  it("读取 SKILL.md 时兼容 CRLF、多行 description 和中文冒号", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "windows-skill",
      "---\r\nname: windows-skill\r\ndescription: |\r\n  first line\r\n  second line\r\n---\r\nbody line",
    );
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "cn-colon-skill",
      `---
name: cn-colon-skill
description: 学术数据查询。触发场景: 提到论文、学者、机构时使用。
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.find((skill) => skill.name === "windows-skill")).toMatchObject({
      description: "first line\nsecond line",
      body: "body line",
    });
    expect(result.skills.find((skill) => skill.name === "cn-colon-skill")).toMatchObject({
      description: "学术数据查询。触发场景: 提到论文、学者、机构时使用。",
      body: "body",
    });
  });

  it("读取技能时会合并同目录 _meta.json 的版本信息", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const publishedAt = Date.now();
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "feishu-drive",
      `---
name: feishu-drive
description: drive
---
body`,
    );
    writeSkillMeta(workspaceSkillRoot(workspacePath), "feishu-drive", {
      ownerId: "owner-1",
      slug: "feishu-drive",
      version: "1.0.0",
      publishedAt,
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills[0]?.metadata).toEqual({
      ownerId: "owner-1",
      slug: "feishu-drive",
      version: "1.0.0",
      publishedAt,
    });
  });

  it("桌面 runtime 同时读取用户级 ~/.zcode/skills 和 ~/.agents/skills", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      userSkillRoot(home),
      "zcode-global",
      `---
name: zcode-global
description: user zcode
---
body`,
    );
    writeSkill(
      userAgentsSkillRoot(home),
      "agents-global",
      `---
name: agents-global
description: user agents
---
body`,
    );
    writeSkill(
      userSkillRoot(home),
      "copied-global",
      `---
name: copied-global
description: copied into zcode
---
zcode-body`,
    );
    writeSkill(
      userAgentsSkillRoot(home),
      "copied-global",
      `---
name: copied-global
description: original agents copy
---
agents-body`,
    );
    writeSkill(
      userSkillRoot(home),
      "current-review",
      `---
name: shared-review
description: zcode version
---
zcode-review-body`,
    );
    writeSkill(
      userAgentsSkillRoot(home),
      "external-review",
      `---
name: shared-review
description: agents version
---
agents-review-body`,
    );
    writeSkill(
      join(home, ".zcode", "cli", "skills"),
      "old-global",
      `---
name: old-global
description: deprecated
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.capability).toEqual({ userScopeAvailable: true });
    expect(result.skills.map((skill) => skill.name)).toEqual([
      "agents-global",
      "copied-global",
      "shared-review",
      "zcode-global",
    ]);
    expect(result.skills.find((skill) => skill.name === "copied-global")?.path)
      .toContain(join(home, ".zcode", "skills", "copied-global"));
    expect(result.skills.find((skill) => skill.name === "shared-review")?.path)
      .toContain(join(home, ".zcode", "skills", "current-review"));
    expect(result.skills.every((skill) => skill.scope === "user")).toBe(true);
  });

  it("桌面 runtime 用户级 ~/.zcode/skills 没有技能时 fallback 到 ~/.agents/skills", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      userAgentsSkillRoot(home),
      "agents-global",
      `---
name: agents-global
description: user agents
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["agents-global"]);
    expect(result.skills[0]?.scope).toBe("user");
  });

  it("读取已启用官方 plugin 声明的技能目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const browserUsePluginRoot = officialPluginRoot(home, "browser-use");
    const documentPluginRoot = officialPluginRoot(home, "documents");
    const zcodeGuidePluginRoot = officialPluginRoot(home, "zcode-guide");
    const iosPluginRoot = officialPluginRoot(home, "ios-simulator");
    const androidPluginRoot = officialPluginRoot(home, "android-emulator");
    writePluginManifest(browserUsePluginRoot, {
      name: "browser-use",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(documentPluginRoot, {
      name: "documents",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(zcodeGuidePluginRoot, {
      name: "zcode-guide",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(iosPluginRoot, {
      name: "ios-simulator",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(androidPluginRoot, {
      name: "android-emulator",
      skills: "skills",
      version: "0.1.0",
    });
    writeSkill(
      join(browserUsePluginRoot, "skills"),
      "control-browser",
      `---
name: control-browser
description: browser skill
---
browser-body`,
    );
    writeSkill(
      join(documentPluginRoot, "skills"),
      "docx",
      `---
name: docx
description: docx skill
---
docx-body`,
    );
    writeSkill(
      join(documentPluginRoot, "skills"),
      "pdf",
      `---
name: pdf
description: pdf skill
---
pdf-body`,
    );
    writeSkill(
      join(zcodeGuidePluginRoot, "skills"),
      "diagnosing-plugins",
      `---
name: diagnosing-plugins
description: Diagnose plugin discovery and enablement problems
---
diagnosing-body`,
    );
    writeSkill(
      join(iosPluginRoot, "skills"),
      "ios-simulator",
      `---
name: ios-simulator
description: ios skill
---
ios-body`,
    );
    writeSkill(
      join(androidPluginRoot, "skills"),
      "android-emulator",
      `---
name: android-emulator
description: android skill
---
android-body`,
    );
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "ios-simulator@zcode-plugins-official": true,
        },
      },
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual([
      "control-browser",
      "diagnosing-plugins",
      "docx",
      "ios-simulator",
      "pdf",
    ]);
    expect(result.skills.map((skill) => skill.scope)).toEqual([
      "plugin",
      "plugin",
      "plugin",
      "plugin",
      "plugin",
    ]);
    expect(result.skills.map((skill) => skill.pluginName).sort()).toEqual([
      "browser-use",
      "documents",
      "documents",
      "ios-simulator",
      "zcode-guide",
    ]);
    expect(result.skills.find((skill) => skill.name === "android-emulator")).toBeUndefined();
  });

  it("suppressed 内置插件不贡献任何 skill", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const browserUsePluginRoot = officialPluginRoot(home, "browser-use");
    const documentPluginRoot = officialPluginRoot(home, "documents");
    const skillCreatorPluginRoot = officialPluginRoot(home, "skill-creator");
    const zcodeGuidePluginRoot = officialPluginRoot(home, "zcode-guide");
    writePluginManifest(browserUsePluginRoot, {
      name: "browser-use",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(documentPluginRoot, {
      name: "documents",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(skillCreatorPluginRoot, {
      name: "skill-creator",
      skills: "skills",
      version: "0.1.0",
    });
    writePluginManifest(zcodeGuidePluginRoot, {
      name: "zcode-guide",
      skills: "skills",
      version: "0.1.0",
    });
    writeSkill(
      join(browserUsePluginRoot, "skills"),
      "control-browser",
      `---
name: control-browser
description: browser skill
---
browser-body`,
    );
    writeSkill(
      join(documentPluginRoot, "skills"),
      "docx",
      `---
name: docx
description: docx skill
---
docx-body`,
    );
    writeSkill(
      join(skillCreatorPluginRoot, "skills"),
      "skill-creator",
      `---
name: skill-creator
description: skill creator skill
---
creator-body`,
    );
    writeSkill(
      join(zcodeGuidePluginRoot, "skills"),
      "diagnosing-plugins",
      `---
name: diagnosing-plugins
description: Diagnose plugin discovery and enablement problems
---
diagnosing-body`,
    );
    // browser、documents 和 zcode-guide 被卸载（suppressed），skill-creator 保持默认启用。
    writeCliConfig(home, {
      plugins: {
        suppressedBuiltins: [
          "browser-use@zcode-plugins-official",
          "documents@zcode-plugins-official",
          "zcode-guide@zcode-plugins-official",
        ],
      },
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["skill-creator"]);
    expect(result.skills.find((skill) => skill.name === "control-browser")).toBeUndefined();
    expect(result.skills.find((skill) => skill.name === "docx")).toBeUndefined();
    expect(result.skills.find((skill) => skill.name === "diagnosing-plugins")).toBeUndefined();
    expect(result.skills.find((skill) => skill.pluginName === "browser")).toBeUndefined();
    expect(result.skills.find((skill) => skill.pluginName === "documents")).toBeUndefined();
    expect(result.skills.find((skill) => skill.pluginName === "zcode-guide")).toBeUndefined();
  });

  it("读取已安装 marketplace plugin 声明的技能目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = marketplacePluginRoot(
      home,
      "claude-plugins-official",
      "amazon-location-service",
    );
    writeClaudePluginManifest(pluginRoot, {
      name: "amazon-location-service",
      skills: "skills",
      version: "1.0.0",
    });
    writeSkill(
      join(pluginRoot, "skills"),
      "amazon-location-service",
      `---
name: amazon-location-service
description: amazon location skill
---
amazon-body`,
    );
    writeInstalledPluginRecord(home, {
      installPath: pluginRoot,
      marketplace: "claude-plugins-official",
      name: "amazon-location-service",
    });
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "amazon-location-service@claude-plugins-official": true,
        },
      },
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "amazon-location-service",
        pluginName: "amazon-location-service",
        pluginId: "amazon-location-service@claude-plugins-official",
        scope: "plugin",
      }),
    ]);
  });

  // Bugfix 回归（差一层目录）：Claude 插件规范里 manifest skills 数组项指向「技能目录本身」
  // （项内直接是 SKILL.md），agent 端扫描已支持（adapters/src/skills/scan.ts）；这里验证
  // 桌面 services 端技能列表对同一形态的消费，两端语义保持一致。
  it("读取 manifest skills 数组声明的插件技能（数组项即技能目录）", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = marketplacePluginRoot(
      home,
      "claude-plugins-official",
      "mattpocock-skills",
    );
    writeClaudePluginManifest(pluginRoot, {
      name: "mattpocock-skills",
      skills: ["./skills/engineering/tdd", "./skills/productivity/tdd", "./skills/bundle-root"],
      version: "1.0.0",
    });
    // 数组项内直接是 SKILL.md；engineering/tdd 与 productivity/tdd 叶子同名但 frontmatter
    // name 不同，验证不被提前按目录名去重；bundle-root 验证「根自身即技能」规则。
    writeSkill(
      join(pluginRoot, "skills", "engineering", "tdd"),
      "tdd",
      `---
name: tdd
description: engineering tdd skill
---
tdd-body`,
    );
    writeSkill(
      join(pluginRoot, "skills", "productivity", "tdd"),
      "productivity-tdd",
      `---
name: productivity-tdd
description: productivity tdd skill
---
productivity-tdd-body`,
    );
    writeSkill(
      join(pluginRoot, "skills", "bundle-root"),
      "bundle-root",
      `---
name: bundle-root
description: skill whose SKILL.md sits directly in the declared root
---
bundle-root-body`,
    );
    writeInstalledPluginRecord(home, {
      installPath: pluginRoot,
      marketplace: "claude-plugins-official",
      name: "mattpocock-skills",
    });
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "mattpocock-skills@claude-plugins-official": true,
        },
      },
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      "bundle-root",
      "productivity-tdd",
      "tdd",
    ]);
    for (const skill of result.skills) {
      expect(skill.pluginName).toBe("mattpocock-skills");
      expect(skill.scope).toBe("plugin");
    }
  });

  it("非桌面 runtime 不读取用户级技能", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      userSkillRoot(home),
      "zcode-global",
      `---
name: zcode-global
description: user zcode
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: false });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.capability).toEqual({
      userScopeAvailable: false,
      userScopeReason: "desktop_only",
    });
    expect(result.skills).toEqual([]);
  });

  // Windows 跳过：此测试失败原因是 CLI config 写入逻辑问题，非 Windows 特定
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)("setEnabled 会把技能开关按路径写入 CLI config 且不按 workspaceIdentity 隔离", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "repo-review",
      `---
name: repo-review
description: review
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const before = await service.list({
      workspacePath,
      workspaceIdentity: "remote:ssh:a:/workspace",
      provider: "glm",
    });
    const skill = before.skills[0]!;

    await service.setEnabled({
      workspacePath,
      workspaceIdentity: "remote:ssh:a:/workspace",
      provider: "glm",
      scope: skill.scope,
      skillId: skill.id,
      enabled: false,
    });

    const disabled = await service.list({
      workspacePath,
      workspaceIdentity: "remote:ssh:a:/workspace",
      provider: "glm",
    });
    const enabled = await service.list({
      workspacePath,
      workspaceIdentity: "remote:ssh:b:/workspace",
      provider: "glm",
    });
    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { skills?: Record<string, { enable?: boolean }> };
    expect(disabled.skills[0]?.enabled).toBe(false);
    expect(enabled.skills[0]?.enabled).toBe(false);
    expect(config.skills?.[skill.path]).toEqual({ enable: false });

    await service.setEnabled({
      workspacePath,
      workspaceIdentity: "remote:ssh:a:/workspace",
      provider: "glm",
      scope: skill.scope,
      skillId: skill.id,
      enabled: true,
    });

    const reenabled = await service.list({
      workspacePath,
      workspaceIdentity: "remote:ssh:a:/workspace",
      provider: "glm",
    });
    const reenabledConfig = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { skills?: Record<string, { enable?: boolean }> };
    expect(reenabled.skills[0]?.enabled).toBe(true);
    expect(reenabledConfig.skills?.[skill.path]).toBeUndefined();
  });

  it("读取旧版 skills-state.json 时不会迁移或写入旧状态文件", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const legacySkillId = "workspace:legacy-skill";
    const legacyStatePath = join(home, ".zcode", "v2", "skills-state.json");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      legacyStatePath,
      JSON.stringify({ disabledByWorkspace: { [workspacePath]: [legacySkillId] } }),
      "utf-8",
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    await service.list({ workspacePath, provider: "glm" });

    const state = JSON.parse(readFileSync(legacyStatePath, "utf-8")) as {
      disabledByWorkspace?: Record<string, string[]>;
    };
    expect(state.disabledByWorkspace).toEqual({ [workspacePath]: [legacySkillId] });
    expect(existsSync(join(home, ".zcode", "cli", "config.json"))).toBe(false);
  });

  it("buildPromptContext 只注入启用且被提及的技能正文", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "code-review",
      `---
name: code-review
description: Review code
---
review-body`,
    );
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "plan-maker",
      `---
name: plan-maker
description: Make plans
---
plan-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const context = await service.buildPromptContext({
      workspacePath,
      provider: "glm",
      prompt: "请先执行 $code-review",
    });

    expect(context.prompt).toContain("<available_skills>");
    expect(context.prompt).toContain("<activated_skill name=\"code-review\"");
    expect(context.prompt).toContain("review-body");
    expect(context.prompt).not.toContain("plan-body");
    expect(context.activatedSkillNames).toEqual(["code-review"]);
    expect(existsSync(join(home, ".zcode", "v2", "skills-audit.log"))).toBe(true);
  });

  it("被禁用的技能即便被提及也不会注入", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "code-review",
      `---
name: code-review
description: Review code
---
review-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const list = await service.list({ workspacePath, provider: "glm" });
    await service.setEnabled({
      workspacePath,
      provider: "glm",
      scope: list.skills[0]!.scope,
      skillId: list.skills[0]!.id,
      enabled: false,
    });

    const context = await service.buildPromptContext({
      workspacePath,
      provider: "glm",
      prompt: "请先执行 $code-review",
    });

    expect(context.prompt).toBe("请先执行 $code-review");
    expect(context.activatedSkillNames).toEqual([]);
  });

  it("缺少 frontmatter 时用目录名加载且不产出诊断", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "no-frontmatter",
      "just markdown body without yaml header",
    );
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "good-skill",
      `---
name: good-skill
description: ok
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["good-skill", "no-frontmatter"]);
    expect(result.skills.find((skill) => skill.name === "no-frontmatter")?.description).toBe("");
    expect(result.skills.find((skill) => skill.name === "no-frontmatter")?.body).toBe(
      "just markdown body without yaml header",
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "skill_missing_frontmatter" && diagnostic.severity === "error",
      ),
    ).toBe(false);
  });

  it("name 不符合 lowercase-hyphen 规范时仍按原 name 加载且不产出 warning", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "fallback-name",
      `---
name: BadName_With_Caps
description: bad name
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["BadName_With_Caps"]);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "skill_invalid_name" && diagnostic.skillName === "BadName_With_Caps",
      ),
    ).toBe(false);
  });

  it("description 超过 1024 字符会产出 error 并跳过", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const longDescription = "a".repeat(1100);
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "too-long",
      `---
name: too-long
description: "${longDescription}"
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills).toEqual([]);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "skill_description_too_long"),
    ).toBe(true);
  });

  it("未识别的 frontmatter key 不产出 warning 且 skill 仍可用", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "extra-key",
      `---
name: extra-key
description: ok
unknown-field: hello
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["extra-key"]);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "skill_unknown_frontmatter" &&
          diagnostic.message.includes("unknown-field"),
      ),
    ).toBe(false);
  });

  it("同名 skill 出现两次时按路径同时保留且不产出 duplicate warning", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "dup-first",
      `---
name: shared-name
description: first
---
first-body`,
    );
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "dup-second",
      `---
name: shared-name
description: second
---
second-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["shared-name", "shared-name"]);
    expect(result.skills.map((skill) => skill.path.replaceAll("\\", "/").split("/skills/").at(-1))).toEqual([
      "dup-first/SKILL.md",
      "dup-second/SKILL.md",
    ]);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "skill_duplicate_name"),
    ).toBe(false);
  });

  it("worktree 内子目录扫描会向上汇集祖先 .zcode/skills", async () => {
    const home = makeTempHome();
    const repoRoot = join(home, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const childWorkspace = join(repoRoot, "packages", "child");
    writeSkill(
      workspaceSkillRoot(childWorkspace),
      "child-skill",
      `---
name: child-skill
description: scoped to child
---
body`,
    );
    writeSkill(
      workspaceSkillRoot(repoRoot),
      "root-skill",
      `---
name: root-skill
description: scoped to repo root
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath: childWorkspace, provider: "glm" });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      "child-skill",
      "root-skill",
    ]);
  });

  it("deleteSkill 删除 .zcode/skills 工作区技能目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const skillDir = join(workspaceSkillRoot(workspacePath), "repo-review");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "repo-review",
      `---
name: repo-review
description: review
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const before = await service.list({ workspacePath, provider: "glm" });
    const skill = before.skills.find((s) => s.name === "repo-review")!;
    expect(existsSync(skillDir)).toBe(true);

    await service.deleteSkill({ workspacePath, skillId: skill.id });

    expect(existsSync(skillDir)).toBe(false);
    const after = await service.list({ workspacePath, provider: "glm" });
    expect(after.skills.find((s) => s.name === "repo-review")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "deleteSkill 删除用户级 ~/.zcode/skills 软链技能：只删链接、保留外部目标",
    async () => {
      const home = makeTempHome();
      const workspacePath = join(home, "workspace");
      const sourceParent = join(home, "external-agent", "skills");
      const sourceSkillDir = join(sourceParent, "cua-driver");
      const linkedSkillDir = join(userSkillRoot(home), "cua-driver");
      writeSkill(
        sourceParent,
        "cua-driver",
        `---
name: cua-driver
description: linked
---
body`,
      );
      mkdirSync(userSkillRoot(home), { recursive: true });
      symlinkSync(sourceSkillDir, linkedSkillDir, "dir");

      const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
      const before = await service.list({ workspacePath, provider: "glm" });
      const skill = before.skills.find((s) => s.name === "cua-driver")!;
      expect(skill.scope).toBe("user");

      await service.deleteSkill({ workspacePath, skillId: skill.id });

      // 软链本体被删除
      expect(existsSync(linkedSkillDir)).toBe(false);
      // 外部目标目录及其 SKILL.md 完好无损
      expect(existsSync(sourceSkillDir)).toBe(true);
      expect(existsSync(join(sourceSkillDir, "SKILL.md"))).toBe(true);
      const after = await service.list({ workspacePath, provider: "glm" });
      expect(after.skills.find((s) => s.name === "cua-driver")).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "deleteSkill 删除工作区 .zcode/skills 软链技能：只删链接、保留外部目标",
    async () => {
      const home = makeTempHome();
      const workspacePath = join(home, "workspace");
      const sourceParent = join(home, "external-agent", "skills");
      const sourceSkillDir = join(sourceParent, "imported-skill");
      const linkedSkillDir = join(workspaceSkillRoot(workspacePath), "imported-skill");
      writeSkill(
        sourceParent,
        "imported-skill",
        `---
name: imported-skill
description: linked
---
body`,
      );
      mkdirSync(workspaceSkillRoot(workspacePath), { recursive: true });
      symlinkSync(sourceSkillDir, linkedSkillDir, "dir");

      const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
      const before = await service.list({ workspacePath, provider: "glm" });
      const skill = before.skills.find((s) => s.name === "imported-skill")!;

      await service.deleteSkill({ workspacePath, skillId: skill.id });

      expect(existsSync(linkedSkillDir)).toBe(false);
      expect(existsSync(join(sourceSkillDir, "SKILL.md"))).toBe(true);
      const after = await service.list({ workspacePath, provider: "glm" });
      expect(after.skills.find((s) => s.name === "imported-skill")).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "deleteSkill 拒绝经由“软链祖先目录”删除，保护外部目标数据",
    async () => {
      // 用户把一整个外部目录软链进 ~/.zcode/skills（分组软链），
      // 其下的技能扫描时会被发现。删除时若顺着分组软链 rm，会删掉外部真实目录里的子技能——数据丢失。
      // 本用例断言这种情况被安全拦截：抛错、且外部目标完好。
      const home = makeTempHome();
      const workspacePath = join(home, "workspace");
      const externalGroup = join(home, "external-agent", "group");
      writeSkill(
        externalGroup,
        "nested-skill",
        `---
name: nested-skill
description: nested under a symlinked group dir
---
body`,
      );
      mkdirSync(userSkillRoot(home), { recursive: true });
      // ~/.zcode/skills/mygroup -> /external-agent/group
      symlinkSync(externalGroup, join(userSkillRoot(home), "mygroup"), "dir");

      const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
      const before = await service.list({ workspacePath, provider: "glm" });
      const skill = before.skills.find((s) => s.name === "nested-skill")!;

      await expect(
        service.deleteSkill({ workspacePath, skillId: skill.id }),
      ).rejects.toThrow();

      // 外部目标目录及其 SKILL.md 必须完好无损
      expect(existsSync(join(externalGroup, "nested-skill", "SKILL.md"))).toBe(true);
    },
  );

  it("deleteSkill 删除用户级 ~/.agents/skills 技能（removeFromCommon 会拒绝的场景）", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const skillDir = join(userAgentsSkillRoot(home), "feishu-drive");
    writeSkill(
      userAgentsSkillRoot(home),
      "feishu-drive",
      `---
name: feishu-drive
description: drive
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const before = await service.list({ workspacePath, provider: "glm" });
    const skill = before.skills.find((s) => s.name === "feishu-drive")!;
    expect(skill.scope).toBe("user");
    expect(existsSync(skillDir)).toBe(true);

    await service.deleteSkill({ workspacePath, skillId: skill.id });

    expect(existsSync(skillDir)).toBe(false);
    const after = await service.list({ workspacePath, provider: "glm" });
    expect(after.skills.find((s) => s.name === "feishu-drive")).toBeUndefined();
  });

  it("deleteSkill 拒绝删除 plugin 作用域技能", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = marketplacePluginRoot(
      home,
      "claude-plugins-official",
      "amazon-location-service",
    );
    writeClaudePluginManifest(pluginRoot, {
      name: "amazon-location-service",
      skills: "skills",
      version: "1.0.0",
    });
    const pluginSkillDir = join(pluginRoot, "skills", "amazon-location-service");
    writeSkill(
      join(pluginRoot, "skills"),
      "amazon-location-service",
      `---
name: amazon-location-service
description: amazon location skill
---
amazon-body`,
    );
    writeInstalledPluginRecord(home, {
      installPath: pluginRoot,
      marketplace: "claude-plugins-official",
      name: "amazon-location-service",
    });
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "amazon-location-service@claude-plugins-official": true,
        },
      },
    });

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const before = await service.list({ workspacePath, provider: "glm" });
    const skill = before.skills.find((s) => s.name === "amazon-location-service")!;
    expect(skill.scope).toBe("plugin");

    await expect(service.deleteSkill({ workspacePath, skillId: skill.id })).rejects.toThrow();
    // 插件技能目录不应被删除。
    expect(existsSync(pluginSkillDir)).toBe(true);
  });

  it("deleteSkill 对未知 skillId 抛错", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(
      workspaceSkillRoot(workspacePath),
      "repo-review",
      `---
name: repo-review
description: review
---
body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    await expect(
      service.deleteSkill({ workspacePath, skillId: "does-not-exist" }),
    ).rejects.toThrow();
  });

  it("扫描技能根时跳过 node_modules 等内容目录", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const root = workspaceSkillRoot(workspacePath);
    // 真实技能。
    writeSkill(
      root,
      "real-skill",
      `---
name: real-skill
description: real
---
real-body`,
    );
    // Bugfix（ZCT-2070384010482601984）：node_modules 里携带的 SKILL.md 不应被发现，
    // 旧实现会整棵递归 node_modules，在 Windows 上把扫描放大到数十秒。
    writeSkill(
      join(root, "real-skill", "node_modules", "some-dep"),
      "skill",
      `---
name: dep-skill
description: should be ignored
---
dep-body`,
    );
    // dist 同理排除。
    writeSkill(
      join(root, "dist"),
      "built",
      `---
name: dist-skill
description: should be ignored
---
dist-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["real-skill"]);
  });

  it("分组目录（depth 2）内的技能仍可被发现", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const root = workspaceSkillRoot(workspacePath);
    writeSkill(
      join(root, "group-a"),
      "grouped-skill",
      `---
name: grouped-skill
description: grouped
---
grouped-body`,
    );

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["grouped-skill"]);
  });

  it("超过最大扫描深度的技能不会被发现", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const root = workspaceSkillRoot(workspacePath);
    // 构造一条超过 MAX_SKILL_SCAN_DEPTH 的目录链，末端放一个 SKILL.md。
    const segments = Array.from({ length: MAX_SKILL_SCAN_DEPTH + 2 }, (_, index) => `lvl-${index}`);
    writeSkill(join(root, ...segments), "too-deep", `---
name: too-deep
description: beyond depth cap
---
deep-body`);

    const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.skills.map((skill) => skill.name)).not.toContain("too-deep");
  });

  it.skipIf(process.platform === "win32")(
    "目录软链构成环时扫描可终止且不重复",
    async () => {
      const home = makeTempHome();
      const workspacePath = join(home, "workspace");
      const root = workspaceSkillRoot(workspacePath);
      writeSkill(
        root,
        "cyclic-skill",
        `---
name: cyclic-skill
description: cyclic
---
cyclic-body`,
      );
      // 在技能根内放一个指回根的软链，制造潜在环路。
      mkdirSync(root, { recursive: true });
      symlinkSync(root, join(root, "loop-back"), "dir");

      const service = await createSkillsServiceInEnv(home, { isDesktopRuntime: true });
      const result = await service.list({ workspacePath, provider: "glm" });

      // 不应卡死、不应重复列出同一技能。
      expect(result.skills.map((skill) => skill.name)).toEqual(["cyclic-skill"]);
    },
  );
});

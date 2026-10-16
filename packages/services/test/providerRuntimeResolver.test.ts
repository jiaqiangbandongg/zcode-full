import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCleanEnv,
  resolveProviderConfigDir,
  findBinary,
} from "../src/runtime-tools/providerRuntimeResolver.js";
import { setDataBaseDir } from "../src/paths.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("providerRuntimeResolver glm workdir discovery", () => {
  const originalCwd = process.cwd();
  const originalZCodeAgentWorkdir = process.env.ZCODE_AGENT_WORKDIR;
  const originalGlmBinaryPath = process.env.GLM_BINARY_PATH;
  const originalHome = process.env.HOME;
  const createdDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    restoreEnv("ZCODE_AGENT_WORKDIR", originalZCodeAgentWorkdir);
    restoreEnv("GLM_BINARY_PATH", originalGlmBinaryPath);
    restoreEnv("HOME", originalHome);

    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("会在当前仓库旁边自动发现 zcode-cli 作为 glm 工作目录", () => {
    delete process.env.ZCODE_AGENT_WORKDIR;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-glm-workdir-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code-2");
    const glmRepoDir = join(sandboxRoot, "zcode-cli");
    mkdirSync(appRepoDir, { recursive: true });
    mkdirSync(join(glmRepoDir, "packages", "cli", "src"), { recursive: true });
    writeFileSync(join(glmRepoDir, "packages", "cli", "src", "main.ts"), "console.log('glm');\n");

    process.chdir(appRepoDir);

    expect(realpathSync(findBinary("glm")!)).toBe(
      realpathSync(join(glmRepoDir, "packages", "cli", "src", "main.ts")),
    );
  });

  it("desktop dev cwd 在 packages/desktop 时仍会发现仓库相邻的 zcode-cli", () => {
    delete process.env.ZCODE_AGENT_WORKDIR;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-glm-desktop-cwd-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code-3");
    const desktopDir = join(appRepoDir, "packages", "desktop");
    const glmRepoDir = join(sandboxRoot, "zcode-cli");
    mkdirSync(desktopDir, { recursive: true });
    mkdirSync(join(glmRepoDir, "packages", "cli", "src"), { recursive: true });
    writeFileSync(join(appRepoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(glmRepoDir, "packages", "cli", "src", "main.ts"), "console.log('glm');\n");

    process.chdir(desktopDir);

    expect(realpathSync(findBinary("glm")!)).toBe(
      realpathSync(join(glmRepoDir, "packages", "cli", "src", "main.ts")),
    );
  });

  it("zcode-cli 源码入口会作为 glm dev binary 被发现", () => {
    delete process.env.ZCODE_AGENT_WORKDIR;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-glm-src-cli-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code");
    const glmRepoDir = join(sandboxRoot, "zcode-cli");
    mkdirSync(appRepoDir, { recursive: true });
    mkdirSync(join(glmRepoDir, "src"), { recursive: true });
    writeFileSync(join(glmRepoDir, "src", "cli.ts"), "console.log('glm');\n");

    process.chdir(appRepoDir);

    expect(realpathSync(findBinary("glm")!)).toBe(realpathSync(join(glmRepoDir, "src", "cli.ts")));
  });

  it("无源码仓库时会回退到准备好的 zcode-agent 二进制", () => {
    delete process.env.ZCODE_AGENT_WORKDIR;
    delete process.env.GLM_BINARY_PATH;

    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-glm-binary-"));
    createdDirs.push(sandboxRoot);
    // Keep the fallback test hermetic: a developer may already have a valid
    // ~/.zcode/server/agents runtime, which intentionally outranks repository
    // bundled resources in production.
    process.env.HOME = sandboxRoot;

    const appRepoDir = join(sandboxRoot, "z-code-2");
    // Bugfix: GLM 生产态二进制名会按平台解析，Windows 下实际查找的是 zcode-agent.exe。
    // 之前测试固定写成无后缀文件，导致 findBinary("glm") 返回 null，
    // 最终被 realpathSync(null) 表现成对 ...\\null 的 lstat，掩盖了真实原因。
    const binaryName = process.platform === "win32" ? "zcode-agent.exe" : "zcode-agent";
    const binaryPath = join(appRepoDir, "bundled-resources", "glm", binaryName);
    mkdirSync(join(appRepoDir, "bundled-resources", "glm"), { recursive: true });
    writeFileSync(binaryPath, "binary\n");

    process.chdir(appRepoDir);

    expect(realpathSync(findBinary("glm")!)).toBe(realpathSync(binaryPath));
  });

  it("ZCODE_AGENT_WORKDIR 可显式指定 zcode-cli 源码入口", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-workdir-priority-"));
    createdDirs.push(sandboxRoot);

    const workdir = join(sandboxRoot, "zcode-cli");
    mkdirSync(join(workdir, "packages", "cli", "src"), { recursive: true });
    writeFileSync(join(workdir, "packages", "cli", "src", "main.ts"), "console.log('new');\n");
    process.env.ZCODE_AGENT_WORKDIR = workdir;

    expect(realpathSync(findBinary("glm")!)).toBe(
      realpathSync(join(workdir, "packages", "cli", "src", "main.ts")),
    );
  });
});

describe("providerRuntimeResolver workspace config dir identity", () => {
  const originalHome = process.env.HOME;
  const createdDirs: string[] = [];

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    setDataBaseDir(null);
    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GLM 配置目录由 ZCode Agent home 统一承载，不再按 workspaceIdentity 计算", () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-agent-resolver-home-"));
    createdDirs.push(home);
    process.env.HOME = home;
    // Bugfix: paths.ts 会在模块加载时固定默认 dataBaseDir，测试不能只改 HOME。
    setDataBaseDir(home);

    const workspacePath = "/home/dev";
    const workspaceIdentity = "remote:ssh:localhost:2223:dev:/home/dev";

    expect(resolveProviderConfigDir("glm", workspacePath, workspaceIdentity)).toBe(
      join(home, ".zcode", "cli"),
    );
  });

  it("本地 GLM 配置目录同样使用 ZCode Agent home", () => {
    const home = mkdtempSync(join(tmpdir(), "zcode-agent-resolver-home-"));
    createdDirs.push(home);
    process.env.HOME = home;
    // Bugfix: paths.ts 会在模块加载时固定默认 dataBaseDir，测试不能只改 HOME。
    setDataBaseDir(home);

    const workspacePath = "/Users/demo/project";

    expect(resolveProviderConfigDir("glm", workspacePath)).toBe(join(home, ".zcode", "cli"));
  });
});

describe("providerRuntimeResolver clean env", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const createdDirs: string[] = [];

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    setDataBaseDir(null);

    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 GLM provider 不再解析三方 bundled runtime", () => {
    expect(findBinary("claude")).toBeNull();
    expect(findBinary("codex")).toBeNull();
    expect(findBinary("gemini")).toBeNull();
    expect(findBinary("opencode")).toBeNull();
  });

  it("glm clean env 会把 HOME 切到 dataBaseDir，保证 session 读写目录一致", () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-glm-home-"));
    createdDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);

    const env = buildCleanEnv("glm", join(dataBaseDir, ".zcode", "cli"));

    expect(env.HOME).toBe(dataBaseDir);
    if (process.platform === "win32") {
      expect(env.USERPROFILE).toBe(dataBaseDir);
    }
  });

  it("clean env 会剔除宿主 GOOGLE_API_KEY 并保留调用方额外参数", () => {
    process.env.GOOGLE_API_KEY = "host-google-api-key";

    const env = buildCleanEnv("glm", "/tmp/glm-home", {
      EXTRA_FLAG: "1",
    });

    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.EXTRA_FLAG).toBe("1");
  });

  it("agent 子进程会强制 Python 使用 UTF-8 输出，避免 Windows GBK 字节被模型读成乱码", () => {
    const env = buildCleanEnv("glm", "/tmp/glm-home");

    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
  });
});

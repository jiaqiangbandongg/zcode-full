import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_APP_NAME, HELPER_DISPLAY_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { afterEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";
const tempDirs: string[] = [];
const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_FILE_DIR, "../../..");
const doctorSource = readFileSync(join(REPO_ROOT, "scripts/doctor-macos-release-app.sh"), "utf-8");

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

function writeFakeMachOExecutable(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  writeFileSync(filePath, buffer, { mode: 0o755 });
}

function writeFakeTool(binDir: string, toolName: "codesign" | "spctl" | "xcrun", logPath: string) {
  writeExecutable(
    join(binDir, toolName),
    `#!/bin/bash
set -euo pipefail
printf '${toolName}' >> "${logPath}"
for arg in "$@"; do
  printf '\\t%s' "$arg" >> "${logPath}"
done
printf '\\n' >> "${logPath}"
if [[ "${toolName}" == "codesign" && "\${ZCODE_FAKE_CODESIGN_FAIL_HELPER:-0}" == "1" && "$*" == *"${HELPER_APP_NAME}"* ]]; then
  echo "fake helper codesign rejection" >&2
  exit 7
fi
if [[ "${toolName}" == "xcrun" && "\${ZCODE_FAKE_STAPLER_FAIL_HELPER:-0}" == "1" && "$*" == *"${HELPER_APP_NAME}"* ]]; then
  echo "fake helper stapler rejection" >&2
  exit 8
fi
`,
  );
}

function createReleaseApp(rootDir: string, productName = "ZCode") {
  const appPath = join(rootDir, `${productName}.app`);

  writeExecutable(join(appPath, "Contents", "MacOS", productName), "#!/bin/bash\n");

  return { appPath };
}

function createZcodeHomeHelper(zcodeHome: string, variant?: string) {
  const helperAppPath = join(
    zcodeHome,
    "computer-use",
    ...(variant ? [variant] : []),
    HELPER_APP_NAME,
  );
  writeFakeMachOExecutable(join(helperAppPath, "Contents", "MacOS", HELPER_DISPLAY_NAME));
  return helperAppPath;
}

function runDoctor(appPath: string, binDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync("bash", ["scripts/doctor-macos-release-app.sh", appPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ZCODE_ENV: "production",
      // Test selection must not inherit a developer's active dev/preview helper variant.
      ZCODE_CUA_HELPER_INSTALL_VARIANT: "",
      ...extraEnv,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf-8",
    stdio: "pipe",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isWindows)("doctor-macos-release-app.sh", () => {
  it("keeps shell defaults aligned with producer Helper identity", () => {
    expect(doctorSource).toContain(`${HELPER_APP_NAME}}"`);
    expect(doctorSource).toContain(
      `HELPER_EXECUTABLE_NAME="\${ZCODE_CUA_HELPER_EXECUTABLE_NAME:-${HELPER_DISPLAY_NAME}}"`,
    );
  });

  it("Preview 自动按 bundle 名推导主可执行，并验收 preview Helper 目录", () => {
    const workspaceDir = makeTempDir("zcode-macos-preview-doctor-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir, "ZCode Preview");
    const zcodeHome = join(workspaceDir, ".zcode");
    const helperAppPath = createZcodeHomeHelper(zcodeHome, "preview");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);
    writeFakeTool(binDir, "xcrun", toolLog);

    const output = runDoctor(appPath, binDir, {
      ZCODE_ENV: "test",
      ZCODE_CUA_REQUIRE_HELPER: "1",
      ZCODE_HOME: zcodeHome,
    });

    expect(output).toContain(`validating ZCode Preview.app: ${appPath}`);
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${helperAppPath}`);
  });

  it("默认只验收安装后的 ZCode.app，不强绑 Computer Use Helper 发布", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    const output = runDoctor(appPath, binDir, { ZCODE_HOME: zcodeHome });

    expect(output).toContain("[macos-release-doctor] done");
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${appPath}`);
    expect(log).not.toContain(HELPER_APP_NAME);
    expect(output).toContain("standalone Computer Use Helper.app not required");
  });

  it("CUA release gate 验收外置 ZCode Computer Use.app", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-helper-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");
    const helperAppPath = createZcodeHomeHelper(zcodeHome);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);
    writeFakeTool(binDir, "xcrun", toolLog);

    const output = runDoctor(appPath, binDir, {
      ZCODE_CUA_REQUIRE_HELPER: "1",
      ZCODE_HOME: zcodeHome,
    });

    expect(output).toContain("[macos-release-doctor] done");
    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${appPath}`);
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${helperAppPath}`);
    expect(log).toContain(`spctl\t-a\t-vv\t-t\texec\t${helperAppPath}`);
    expect(log).toContain(`xcrun\tstapler\tvalidate\t${helperAppPath}`);
  });

  it("CUA release gate 在 Helper staple 无效时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-stapler-fail-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");
    const helperAppPath = createZcodeHomeHelper(zcodeHome);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);
    writeFakeTool(binDir, "xcrun", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_CUA_REQUIRE_HELPER: "1",
        ZCODE_CUA_HELPER_APP_PATH: helperAppPath,
        ZCODE_FAKE_STAPLER_FAIL_HELPER: "1",
      }),
    ).toThrow(/fake helper stapler rejection/);
  });

  it("CUA release gate 缺少外置 Helper.app 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-missing-helper-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_CUA_REQUIRE_HELPER: "1",
        ZCODE_HOME: zcodeHome,
      }),
    ).toThrow(/Computer Use Helper\.app missing/);
  });

  it("CUA release gate 在没有 ZCODE_HOME/HOME 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-no-home-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_CUA_REQUIRE_HELPER: "1",
        ZCODE_HOME: "",
        HOME: "",
      }),
    ).toThrow(/no product helper path/);
  });

  it("helper codesign 失败时不应继续判定 release app 验收成功", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-fail-helper-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");
    const helperAppPath = createZcodeHomeHelper(zcodeHome);

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_CUA_REQUIRE_HELPER: "1",
        ZCODE_HOME: zcodeHome,
        ZCODE_FAKE_CODESIGN_FAIL_HELPER: "1",
      }),
    ).toThrow(/fake helper codesign rejection/);

    const log = readFileSync(toolLog, "utf-8");
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${helperAppPath}`);
    expect(log).not.toContain(`spctl\t-a\t-vv\t-t\texec\t${helperAppPath}`);
  });

  it("helper 主可执行仍是 shell wrapper 时应 fail-closed", () => {
    const workspaceDir = makeTempDir("zcode-macos-release-doctor-helper-wrapper-");
    const binDir = join(workspaceDir, "bin");
    const toolLog = join(workspaceDir, "tool.log");
    const { appPath } = createReleaseApp(workspaceDir);
    const zcodeHome = join(workspaceDir, ".zcode");
    const helperAppPath = createZcodeHomeHelper(zcodeHome);
    writeExecutable(join(helperAppPath, "Contents", "MacOS", HELPER_DISPLAY_NAME), "#!/bin/bash\n");

    mkdirSync(binDir, { recursive: true });
    writeFakeTool(binDir, "codesign", toolLog);
    writeFakeTool(binDir, "spctl", toolLog);

    expect(() =>
      runDoctor(appPath, binDir, {
        ZCODE_CUA_REQUIRE_HELPER: "1",
        ZCODE_HOME: zcodeHome,
      }),
    ).toThrow(/not a Mach-O executable/);
    const log = existsSync(toolLog) ? readFileSync(toolLog, "utf-8") : "";
    expect(log).toContain(`codesign\t--verify\t--deep\t--strict\t${appPath}`);
    expect(log).not.toContain(`codesign\t--verify\t--deep\t--strict\t${helperAppPath}`);
  });
});

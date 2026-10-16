import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// cdn-preload.sh 是纯 bash 脚本，Windows 上没有原生 bash 环境（或行为不一致），跳过整个测试套件。
const isWindows = process.platform === "win32";

const tempDirs: string[] = [];
const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_FILE_DIR, "../../..");

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isWindows)("cdn-preload.sh", () => {
  it("默认预热 upload 阶段写出的所有有效文件大小记录", () => {
    const workspaceDir = makeTempDir("cdn-preload-workspace-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      cdnUrlsIn,
      [
        "https://cdn-zcode.z.ai/zcode/electron/releases/1.3.0/ZCode-1.3.0-mac-arm64.dmg\t3145728",
        "https://cdn-zcode.z.ai/zcode/electron/releases/update/mac/arm64/latest-mac.yml\t128",
        "https://cdn-zcode.z.ai/zcode/electron/releases/1.3.0/ZCode-1.3.0-mac-arm64.zip",
        "",
      ].join("\n"),
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

if [[ "$2" == "PushObjectCache" ]]; then
  printf '%s\n' '{"PushTaskId":"task-123"}'
  exit 0
fi

if [[ "$2" == "DescribeRefreshTaskById" ]]; then
  printf '%s\n' '{"Tasks":[{"Status":"Complete","Process":"100%"}]}'
  exit 0
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
const fs = require("fs");

const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input || "{}");
const args = process.argv.slice(2);
const filter = args[args.length - 1] || "";

if (filter.includes("PushTaskId")) {
  process.stdout.write(payload.PushTaskId || "");
  process.exit(0);
}

if (filter.includes("Tasks[0].Status")) {
  process.stdout.write(payload.Tasks?.[0]?.Status || "Unknown");
  process.exit(0);
}

if (filter.includes("Tasks[0].Process")) {
  process.stdout.write(payload.Tasks?.[0]?.Process || "0%");
  process.exit(0);
}

process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CDN_DOMAIN: "",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        POLL_INTERVAL: "0",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain("no minimum file size threshold is applied");
    expect(output).toContain("Filtered URLs: 2, Skipped URLs: 1");
    expect(output).toContain(
      "skip preload (missing/invalid recorded size): https://cdn-zcode.z.ai/zcode/electron/releases/1.3.0/ZCode-1.3.0-mac-arm64.zip",
    );

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(aliyunCalls).toHaveLength(4);
    const pushCalls = aliyunCalls.filter((line) => line.includes("PushObjectCache"));
    const describeCalls = aliyunCalls.filter((line) => line.includes("DescribeRefreshTaskById"));
    expect(pushCalls).toHaveLength(2);
    expect(pushCalls.some((line) => line.includes("latest-mac.yml"))).toBe(true);
    expect(pushCalls.some((line) => line.includes("ZCode-1.3.0-mac-arm64.dmg"))).toBe(true);
    expect(pushCalls.every((line) => !line.includes("--Area"))).toBe(true);
    expect(output).not.toContain("--Area");
    expect(describeCalls).toHaveLength(2);
  }, 30_000);

  it("多 CDN 账号预热时应按 URL 域名选择 aliyun profile 并用同一 profile 轮询", () => {
    const workspaceDir = makeTempDir("cdn-preload-profile-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      cdnUrlsIn,
      [
        "https://cdn-zcode.z.ai/zcode/electron/releases/1.3.0/ZCode-1.3.0-linux-arm64.AppImage\t3145728",
        "https://cdn.zcode-ai.com/zcode/electron/releases/1.3.0/ZCode-1.3.0-linux-arm64.AppImage\t3145728",
      ].join("\n"),
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

profile=""
for ((i = 1; i <= $#; i++)); do
  if [[ "\${!i}" == "--profile" ]]; then
    next_index=$((i + 1))
    profile="\${!next_index}"
    break
  fi
done

if [[ "$2" == "PushObjectCache" ]]; then
  if [[ "$profile" == "z-ai-account" ]]; then
    printf '%s\\n' '{"PushTaskId":"task-z-ai"}'
  elif [[ "$profile" == "zcode-ai-account" ]]; then
    printf '%s\\n' '{"PushTaskId":"task-zcode-ai"}'
  else
    echo "unexpected profile: $profile" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$2" == "DescribeRefreshTaskById" ]]; then
  printf '%s\\n' '{"Tasks":[{"Status":"Complete","Process":"100%"}]}'
  exit 0
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input || "{}");
const filter = process.argv.at(-1) || "";
if (filter.includes("PushTaskId")) process.stdout.write(payload.PushTaskId || "");
else if (filter.includes("Tasks[0].Status")) process.stdout.write(payload.Tasks?.[0]?.Status || "Unknown");
else if (filter.includes("Tasks[0].Process")) process.stdout.write(payload.Tasks?.[0]?.Process || "0%");
else process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        CDN_DOMAIN: "cdn-zcode.z.ai,cdn.zcode-ai.com",
        CDN_PRELOAD_PROFILE: "z-ai-account,zcode-ai-account",
        POLL_INTERVAL: "0",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain("SUCCESS: All CDN tasks are Complete.");

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const pushCalls = aliyunCalls.filter((line) => line.includes("PushObjectCache"));
    const describeCalls = aliyunCalls.filter((line) => line.includes("DescribeRefreshTaskById"));
    expect(pushCalls).toHaveLength(2);
    expect(describeCalls).toHaveLength(2);
    expect(
      pushCalls.some(
        (line) => line.includes("cdn-zcode.z.ai") && line.includes("--profile z-ai-account"),
      ),
    ).toBe(true);
    expect(
      pushCalls.some(
        (line) => line.includes("cdn.zcode-ai.com") && line.includes("--profile zcode-ai-account"),
      ),
    ).toBe(true);
    expect(pushCalls.every((line) => !line.includes("--region"))).toBe(true);
    expect(pushCalls.every((line) => !line.includes("--Area"))).toBe(true);
    expect(
      describeCalls.some(
        (line) => line.includes("task-z-ai") && line.includes("--profile z-ai-account"),
      ),
    ).toBe(true);
    expect(
      describeCalls.some(
        (line) => line.includes("task-zcode-ai") && line.includes("--profile zcode-ai-account"),
      ),
    ).toBe(true);
    expect(describeCalls.every((line) => !line.includes("--region"))).toBe(true);
  }, 30_000);

  it("显式配置 PRELOAD_MIN_BYTES 时仍可按文件大小筛选预热对象", () => {
    const workspaceDir = makeTempDir("cdn-preload-threshold-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      cdnUrlsIn,
      [
        "https://cdn.codegeex.cn/zcode/electron/releases/1.3.0/ZCode-1.3.0-mac-arm64.dmg\t3145728",
        "https://cdn.codegeex.cn/zcode/electron/releases/update/mac/arm64/latest-mac.yml\t128",
      ].join("\n"),
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

if [[ "$2" == "PushObjectCache" ]]; then
  printf '%s\n' '{"PushTaskId":"task-threshold"}'
  exit 0
fi

if [[ "$2" == "DescribeRefreshTaskById" ]]; then
  printf '%s\n' '{"Tasks":[{"Status":"Complete","Process":"100%"}]}'
  exit 0
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input || "{}");
const filter = process.argv.at(-1) || "";
if (filter.includes("PushTaskId")) process.stdout.write(payload.PushTaskId || "");
else if (filter.includes("Tasks[0].Status")) process.stdout.write(payload.Tasks?.[0]?.Status || "Unknown");
else if (filter.includes("Tasks[0].Process")) process.stdout.write(payload.Tasks?.[0]?.Process || "0%");
else process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        POLL_INTERVAL: "0",
        PRELOAD_MIN_BYTES: "2097152",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain("Filtered URLs: 1, Skipped URLs: 1");
    expect(output).toContain("skip preload (128 bytes < 2097152)");

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(aliyunCalls).toHaveLength(2);
    expect(aliyunCalls[0]).toContain("PushObjectCache");
    expect(aliyunCalls[0]).toContain("ZCode-1.3.0-mac-arm64.dmg");
    expect(aliyunCalls[1]).toContain("DescribeRefreshTaskById");
  }, 30_000);

  it("提交 CDN 预热遇到 EOF 后会重试并继续轮询", () => {
    const workspaceDir = makeTempDir("cdn-preload-retry-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const attemptPath = join(workspaceDir, "push-attempts.txt");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      cdnUrlsIn,
      "https://cdn.codegeex.cn/zcode/electron/releases/1.6.0/ZCode-1.6.0-mac-arm64.dmg\t3145728\n",
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

if [[ "$2" == "PushObjectCache" ]]; then
  attempts="0"
  [[ -f "${attemptPath}" ]] && attempts="$(cat "${attemptPath}")"
  attempts="$((attempts + 1))"
  printf '%s' "$attempts" > "${attemptPath}"
  if [[ "$attempts" == "1" ]]; then
    echo 'ERROR: Post "https://cdn.example.invalid/": EOF' >&2
    exit 1
  fi
  printf '%s\n' '{"PushTaskId":"task-retry"}'
  exit 0
fi

if [[ "$2" == "DescribeRefreshTaskById" ]]; then
  printf '%s\n' '{"Tasks":[{"Status":"Complete","Process":"100%"}]}'
  exit 0
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input || "{}");
const filter = process.argv.at(-1) || "";
if (filter.includes("PushTaskId")) process.stdout.write(payload.PushTaskId || "");
else if (filter.includes("Tasks[0].Status")) process.stdout.write(payload.Tasks?.[0]?.Status || "Unknown");
else if (filter.includes("Tasks[0].Process")) process.stdout.write(payload.Tasks?.[0]?.Process || "0%");
else process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        POLL_INTERVAL: "0",
        CDN_PRELOAD_RETRY_SLEEP: "0",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain("SUCCESS: All CDN tasks are Complete.");

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(aliyunCalls.filter((line) => line.includes("PushObjectCache"))).toHaveLength(2);
    expect(aliyunCalls.filter((line) => line.includes("DescribeRefreshTaskById"))).toHaveLength(1);
  }, 30_000);

  it("提交 CDN 预热遇到 SignatureNonceUsed 时按已触达服务端处理", () => {
    const workspaceDir = makeTempDir("cdn-preload-nonce-used-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      cdnUrlsIn,
      "https://cdn.codegeex.cn/zcode/electron/releases/1.6.0/ZCode-1.6.0-mac-arm64.dmg\t3145728\n",
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

if [[ "$2" == "PushObjectCache" ]]; then
  cat >&2 <<'JSON'
{"RequestId":"43BEE5F4-664A-3F6C-AD1C-846C2730779B","Message":"Specified signature nonce was used already.","Code":"SignatureNonceUsed"}
JSON
  exit 1
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        POLL_INTERVAL: "0",
        CDN_PRELOAD_RETRY_SLEEP: "0",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain(
      "No task IDs returned; 1 CDN preload request(s) may already be submitted.",
    );

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(aliyunCalls.filter((line) => line.includes("PushObjectCache"))).toHaveLength(1);
    expect(aliyunCalls.some((line) => line.includes("DescribeRefreshTaskById"))).toBe(false);
  }, 30_000);

  it("提交 CDN 预热重试耗尽后不阻塞后续流程", () => {
    const workspaceDir = makeTempDir("cdn-preload-soft-fail-");
    const binDir = join(workspaceDir, "bin");
    const aliyunLogPath = join(workspaceDir, "aliyun.log");
    const cdnUrlsIn = join(workspaceDir, "cdn-urls.txt");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      cdnUrlsIn,
      "https://cdn.codegeex.cn/zcode/electron/releases/1.6.0/ZCode-1.6.0-mac-arm64.dmg\t3145728\n",
      "utf-8",
    );

    writeExecutable(
      join(binDir, "aliyun"),
      `#!/bin/bash
set -euo pipefail
echo "$*" >> "${aliyunLogPath}"

if [[ "$2" == "PushObjectCache" ]]; then
  echo 'ERROR: Post "https://cdn.example.invalid/": EOF' >&2
  exit 1
fi

echo "unexpected CDN command: $*" >&2
exit 1
`,
    );

    writeExecutable(
      join(binDir, "jq"),
      `#!/usr/bin/env node
process.stdout.write("\\n");
`,
    );

    const output = execFileSync("bash", ["scripts/cdn-preload.sh"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CDN_URLS_IN: cdnUrlsIn,
        CDN_PRELOAD_MAX_ATTEMPTS: "2",
        CDN_PRELOAD_RETRY_SLEEP: "0",
      },
      timeout: 25_000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(output).toContain(
      "No tasks submitted. CDN preload is best-effort; continue release flow.",
    );

    const aliyunCalls = readFileSync(aliyunLogPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(aliyunCalls.filter((line) => line.includes("PushObjectCache"))).toHaveLength(2);
    expect(aliyunCalls.some((line) => line.includes("DescribeRefreshTaskById"))).toBe(false);
  }, 30_000);
});

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = `Usage:
  node scripts/create-workspace-hook-trust-uat-fixture.mjs [--target <new-directory>] [--json]
  node scripts/create-workspace-hook-trust-uat-fixture.mjs --verify <existing-workspace> [--json]

Creates a harmless Workspace Hook Trust manual-acceptance workspace.
The target directory must not already exist. Without --target, a new directory is created under the OS temp directory.

--verify asserts an existing fixture is still pristine before a UAT round: every
declaration must be enabled and no Hook may have produced evidence yet. Exits
non-zero when the fixture drifted, so a polluted workspace fails in seconds
instead of invalidating a whole manual round.
`;

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    target: { type: "string" },
    verify: { type: "string" },
  },
  strict: true,
});

if (parsed.values.help) {
  process.stdout.write(usage);
  process.exit(0);
}

if (parsed.values.verify !== undefined) {
  if (parsed.values.target !== undefined) {
    process.stderr.write("--verify cannot be combined with --target.\n");
    process.exit(2);
  }
  await verifyFixture(resolve(parsed.values.verify), parsed.values.json === true);
}

const workspacePath = parsed.values.target
  ? resolve(parsed.values.target)
  : await mkdtemp(join(tmpdir(), "zcode-workspace-hook-trust-uat-"));

if (parsed.values.target) {
  await mkdir(workspacePath);
}

const zcodeDirectory = join(workspacePath, ".zcode");
const recorderPath = join(zcodeDirectory, "workspace-hook-trust-uat-recorder.mjs");
const configPath = join(zcodeDirectory, "config.json");
const evidencePath = join(workspacePath, ".workspace-hook-trust-uat", "executions.jsonl");
await mkdir(zcodeDirectory, { recursive: true });

const recorder = `import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const event = process.argv[2] ?? "unknown";
const label = process.argv[3] ?? "unknown";
const outputDirectory = join(process.cwd(), ".workspace-hook-trust-uat");
const outputPath = join(outputDirectory, "executions.jsonl");
await mkdir(outputDirectory, { recursive: true });
await appendFile(
  outputPath,
  JSON.stringify({ event, label, executedAt: new Date().toISOString(), cwd: process.cwd() }) + "\\n",
  "utf8",
);
process.stdout.write(\`workspace-hook-trust-uat:\${event}:\${label}\\n\`);
`;

const config = {
  hooks: {
    enabled: true,
    timeoutMs: 10_000,
    maxOutputBytes: 32_768,
    events: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            {
              type: "process",
              command: "node",
              args: [
                ".zcode/workspace-hook-trust-uat-recorder.mjs",
                "SessionStart",
                "session-start-a",
              ],
              enabled: true,
              timeoutMs: 10_000,
              statusMessage: "Workspace Hook Trust UAT — SessionStart A",
            },
            {
              type: "process",
              command: "node",
              args: [
                ".zcode/workspace-hook-trust-uat-recorder.mjs",
                "SessionStart",
                "session-start-b",
              ],
              enabled: true,
              timeoutMs: 10_000,
              statusMessage: "Workspace Hook Trust UAT — SessionStart B",
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "process",
              command: "node",
              args: [
                ".zcode/workspace-hook-trust-uat-recorder.mjs",
                "UserPromptSubmit",
                "prompt-submit",
              ],
              enabled: true,
              timeoutMs: 10_000,
              statusMessage: "Workspace Hook Trust UAT — UserPromptSubmit",
            },
          ],
        },
      ],
    },
  },
};

const readme = `# Workspace Hook Trust manual acceptance fixture

This workspace contains three harmless project Hook declarations:

- SessionStart / session-start-a
- SessionStart / session-start-b
- UserPromptSubmit / prompt-submit

Each admitted Hook appends one JSON line to:

\`${evidencePath}\`

Before Trust admission, that file must not be created by these Hooks.
Follow the repository checklist:

\`docs/testing/workspace-hook-trust-manual-acceptance.md\`
`;

await Promise.all([
  writeFile(recorderPath, recorder, "utf8"),
  writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
  writeFile(join(workspacePath, "README.md"), readme, "utf8"),
]);

const result = { workspacePath, configPath, recorderPath, evidencePath };
if (parsed.values.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      "Workspace Hook Trust UAT fixture created.",
      `workspace: ${workspacePath}`,
      `config:    ${configPath}`,
      `evidence:  ${evidencePath}`,
      "",
      "Open the workspace in ZCode Desktop, then follow:",
      "docs/testing/workspace-hook-trust-manual-acceptance.md",
      "",
    ].join("\n"),
  );
}

/**
 * UAT 现场校验。
 *
 * 背景（2026-08-10 实测）：一次诊断脚本直接对正在验收的 fixture 调用了
 * writeWorkspaceHookConfiguredToggle，把三条声明写成 enabled:false。由于
 * runtime admission 只在存在「已启用且待授信」的声明时才开审核流程，全部关闭后
 * 审核面板不再出现——验收者据此误判为产品缺陷，损失一整轮人工验收。
 * 这里在每轮开始前做廉价断言，让污染在数秒内暴露，而不是等测完才发现。
 */
async function verifyFixture(workspacePath, asJson) {
  const targetConfigPath = join(workspacePath, ".zcode", "config.json");
  const targetEvidencePath = join(workspacePath, ".workspace-hook-trust-uat", "executions.jsonl");
  const problems = [];
  let declarations = [];

  let raw;
  try {
    raw = JSON.parse(await readFile(targetConfigPath, "utf8"));
  } catch (error) {
    problems.push(`配置无法读取或不是合法 JSON：${targetConfigPath}（${error.message}）`);
  }

  if (raw) {
    const hooks = raw.hooks;
    if (!hooks || typeof hooks !== "object") {
      problems.push("配置缺少 hooks 根对象。");
    } else {
      if (hooks.enabled !== true) {
        problems.push(`hooks.enabled 应为 true，实际为 ${JSON.stringify(hooks.enabled)}。`);
      }
      for (const [event, matchers] of Object.entries(hooks.events ?? {})) {
        for (const [matcherIndex, matcher] of (matchers ?? []).entries()) {
          for (const [hookIndex, hook] of (matcher?.hooks ?? []).entries()) {
            const label =
              `${event}[${matcherIndex}][${hookIndex}] ${hook?.statusMessage ?? ""}`.trim();
            declarations.push({ label, enabled: hook?.enabled });
            // enabled 缺省即视为启用（runtime 语义是 enabled !== false）；只有显式 false 才算漂移。
            if (hook?.enabled === false) {
              problems.push(`声明已被关闭，应为启用：${label}`);
            }
          }
        }
      }
      if (declarations.length === 0) {
        problems.push("配置中没有任何 Hook 声明。");
      }
    }
  }

  // 未授信前 Hook 不得执行，因此证据文件在干净现场下必须不存在。
  try {
    await stat(targetEvidencePath);
    problems.push(`上一轮的执行证据仍在，需重新生成 fixture：${targetEvidencePath}`);
  } catch {
    // 不存在即符合预期。
  }

  const ok = problems.length === 0;
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ok, workspacePath, problems, declarations }, null, 2)}\n`,
    );
  } else if (ok) {
    process.stdout.write(
      [
        "Workspace Hook Trust UAT fixture 现场干净，可以开始本轮验收。",
        `workspace:    ${workspacePath}`,
        `declarations: ${declarations.length} 条，全部启用`,
        "",
      ].join("\n"),
    );
  } else {
    process.stderr.write(
      [
        "Workspace Hook Trust UAT fixture 已漂移，请勿在此现场继续验收：",
        ...problems.map((item) => `  - ${item}`),
        "",
        "重新生成干净现场：",
        "  node scripts/create-workspace-hook-trust-uat-fixture.mjs",
        "",
      ].join("\n"),
    );
  }
  process.exit(ok ? 0 : 1);
}

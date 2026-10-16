import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hooks-"));
  tempRoots.push(root);
  return root;
}

async function createHooksServiceInEnv(home: string, options?: { logger?: ServiceLogger }) {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/hooks/hooksService.js");
  return mod.createHooksService(options);
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("hooksService", () => {
  it("loads hooks from workspace directories before user directories", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");

    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(workspacePath, ".zcode"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents"), { recursive: true });
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });

    writeFileSync(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  { type: "process", command: "node", args: ["user-zcode.mjs"], customFlag: true },
                ],
              },
            ],
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "process",
                    command: "node",
                    args: ["project-zcode.mjs"],
                    timeoutMs: 5000,
                  },
                ],
              },
            ],
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(home, ".agents", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo agents" }] }],
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo claude" }] }],
        },
      }),
      "utf-8",
    );

    const service = await createHooksServiceInEnv(home);
    const result = await service.loadHooks({ workspacePath });

    expect(result.hooksEnabled).toBe(true);
    expect(
      result.hooks.map(
        (hook) => `${hook.location?.source}:${hook.location?.scope}:${hook.command}`,
      ),
    ).toEqual([
      "zcode:project:node",
      "claude:project:echo claude",
      "zcode:user:node",
      "agents:user:echo agents",
    ]);
    expect(result.hooks[0]).toEqual(expect.objectContaining({ timeout: 5 }));
    expect(result.hooks[0]?.location?.directoryPath).toBe(join(workspacePath, ".zcode"));
    expect(result.hooks[2]).toEqual(
      expect.objectContaining({ args: ["user-zcode.mjs"], custom: { customFlag: true } }),
    );
  });

  it("keeps identical user and project hooks as separate source records", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    const hookConfig = {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo verify" }] }],
        },
      },
    };
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    mkdirSync(join(workspacePath, ".zcode"), { recursive: true });
    writeFileSync(join(home, ".zcode", "cli", "config.json"), JSON.stringify(hookConfig), "utf-8");
    writeFileSync(
      join(workspacePath, ".zcode", "config.json"),
      JSON.stringify(hookConfig),
      "utf-8",
    );

    const service = await createHooksServiceInEnv(home);
    const result = await service.loadHooks({ workspacePath });

    expect(result.hooks).toHaveLength(2);
    expect(result.hooks.map((hook) => hook.location?.scope)).toEqual(["project", "user"]);
  });

  it("saves zcode hooks to user and workspace config files", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ features: { mcp: true } }),
      "utf-8",
    );

    const service = await createHooksServiceInEnv(home);
    await service.saveHooks({
      workspacePath,
      hooks: [
        {
          id: "keep-user",
          event: "Stop",
          type: "process",
          command: "node",
          args: ["stop.mjs"],
          enabled: true,
          custom: { extra: "user" },
          location: {
            source: "zcode",
            scope: "user",
            directoryPath: join(home, ".zcode", "cli"),
          },
        },
        {
          id: "keep-project",
          event: "PreToolUse",
          type: "process",
          command: "node",
          enabled: true,
          location: {
            source: "zcode",
            scope: "project",
            directoryPath: join(workspacePath, ".zcode"),
            projectPath: workspacePath,
          },
        },
        {
          id: "skip-agents",
          event: "Stop",
          type: "command",
          command: "echo agents",
          enabled: true,
          location: {
            source: "agents",
            scope: "user",
            directoryPath: join(home, ".agents"),
          },
        },
      ],
    });

    const saved = JSON.parse(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"));
    expect(saved.features).toEqual({ mcp: true });
    expect(saved.hooks.events.Stop).toEqual([
      {
        hooks: [
          { type: "process", command: "node", args: ["stop.mjs"], enabled: true, extra: "user" },
        ],
      },
    ]);
    expect(saved.hooks.events.PreToolUse).toBeUndefined();

    const projectSaved = JSON.parse(
      readFileSync(join(workspacePath, ".zcode", "config.json"), "utf-8"),
    );
    expect(projectSaved.hooks.events.PreToolUse).toEqual([
      {
        hooks: [{ type: "process", command: "node", enabled: true }],
      },
    ]);
  });

  it("round-trips command hooks with async and shell fields", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    const service = await createHooksServiceInEnv(home);

    await service.saveHooks({
      workspacePath,
      hooks: [
        {
          id: "command-hook",
          event: "SessionStart",
          matcher: "startup",
          type: "command",
          command: "./hooks/session-start.sh",
          async: true,
          shell: "bash",
          statusMessage: "Preparing workspace",
          timeout: 12,
          enabled: true,
          location: {
            source: "zcode",
            scope: "project",
            directoryPath: join(workspacePath, ".zcode"),
            projectPath: workspacePath,
          },
        },
      ],
    });

    const loaded = await service.loadHooks({ workspacePath });
    expect(loaded.hooks[0]).toMatchObject({
      type: "command",
      async: true,
      shell: "bash",
      statusMessage: "Preparing workspace",
      timeout: 12,
      enabled: true,
    });
  });

  it("persists a disabled hook in the runtime-readable project config", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(workspacePath, ".zcode"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "process", command: "node", args: ["hook.mjs"] }],
              },
            ],
          },
        },
      }),
      "utf-8",
    );

    const service = await createHooksServiceInEnv(home);
    const initial = await service.loadHooks({ workspacePath });
    const hook = initial.hooks[0];
    expect(hook).toBeDefined();

    await service.saveHooks({
      workspacePath,
      hooks: initial.hooks.map((item) =>
        item.id === hook!.id ? { ...item, enabled: false } : item,
      ),
    });

    const saved = JSON.parse(readFileSync(join(workspacePath, ".zcode", "config.json"), "utf-8"));
    expect(saved.hooks.events.PreToolUse[0].hooks[0]).toMatchObject({
      type: "process",
      command: "node",
      args: ["hook.mjs"],
      enabled: false,
    });

    const disabled = await service.loadHooks({ workspacePath });
    expect(disabled.hooks[0]).toEqual(expect.objectContaining({ enabled: false }));
    expect(disabled.hooksEnabled).toBe(false);
  });

  it("trust store 不可读时使用可注入 service logger 并保持 fail closed", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(workspacePath, ".zcode"), { recursive: true });
    // 修复原因：CR-01 后非法 JSON（如 "{broken"）统一走 schema 解析分支（文案"结构不符合
    // schema"，已由 workspaceHookTrustCorrupt.test.ts 覆盖）；本用例验证的是 IO 不可读分支，
    // 因此用目录占位 trust store 路径——readFile 对目录稳定返回 EISDIR/EPERM（非 ENOENT），
    // 在 macOS/Linux/Windows 上都能触发"不可读"日志分支。
    mkdirSync(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), {
      recursive: true,
    });
    writeFileSync(
      join(workspacePath, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo untrusted" }] }],
          },
        },
      }),
      "utf-8",
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const service = await createHooksServiceInEnv(home, { logger });
      const result = await service.loadHooks({ workspacePath });

      expect(result.trustStoreCorrupt).toBe(true);
      expect(result.hooks[0]?.workspaceHook?.trustState).not.toBe("trusted_persistent");
      expect(logger.warn).toHaveBeenCalledWith(
        undefined,
        "Workspace Hook Trust store 不可读，已 fail-closed 忽略全部持久信任记录",
        expect.objectContaining({ path: expect.stringContaining("workspace-hook-trust-v1.json") }),
      );
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

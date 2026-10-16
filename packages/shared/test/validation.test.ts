import { describe, expect, it } from "vitest";
import { HostResponseTypes } from "../src/channels.js";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
  wslConnectOptionsSchema,
  zcodePersistedMessageSchema,
} from "../src/validation.js";

it("资源查询取消必须指定 requestId 且不接受附加字段", () => {
  const cancel = { type: "resource-usage-snapshot-cancel", requestId: "sample-1" };
  expect(hostIncomingMessageSchema.safeParse(cancel).success).toBe(true);
  expect(hostIncomingMessageSchema.safeParse({ ...cancel, requestId: "" }).success).toBe(false);
  expect(hostIncomingMessageSchema.safeParse({ ...cancel, workspacePath: "/other" }).success).toBe(
    false,
  );
});

it("accepts persisted user messages with video attachments", () => {
  expect(
    zcodePersistedMessageSchema.safeParse({
      role: "user",
      content: "Summarize the video.",
      timestamp: 1,
      attachments: [
        {
          kind: "video",
          filename: "demo.mp4",
          mimeType: "video/mp4",
          sizeBytes: 1,
          dataBase64: "/w==",
        },
      ],
    }).success,
  ).toBe(true);
});

describe("hostResponseMessageSchema", () => {
  it("rejects unsafe WSL user values but keeps empty default-user compatibility", () => {
    expect(
      wslConnectOptionsSchema.safeParse({
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "root/dev",
      }).success,
    ).toBe(false);
    expect(
      wslConnectOptionsSchema.safeParse({
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "root",
      }).success,
    ).toBe(true);
    expect(
      wslConnectOptionsSchema.safeParse({
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "",
      }).success,
    ).toBe(true);
  });

  it("accepts host log response payload", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.Log,
      level: "info",
      source: "oauthService",
      message: "restoreSession started",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts agent process lifecycle payload", () => {
    const spawned = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessSpawned,
      pid: 12345,
      provider: "glm",
      workspacePath: "/repo/demo",
      command: "/tmp/zcode-agent",
      args: ["--stdio"],
      startedAt: Date.now(),
      runtimeGeneration: 2,
      runtimeInstanceId: "runtime-instance-2",
    });

    const ready = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessReady,
      pid: 12345,
      provider: "glm",
      workspacePath: "/repo/demo",
      readyAt: Date.now(),
      startupDurationMs: 120,
      runtimeGeneration: 2,
      runtimeInstanceId: "runtime-instance-2",
    });

    const exited = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessExited,
      pid: 12345,
      provider: "glm",
      workspacePath: "/repo/demo",
      exitCode: 1,
      signal: null,
      endedAt: Date.now(),
      terminationKind: "unexpected",
      runtimeReady: true,
      runtimeGeneration: 2,
      runtimeInstanceId: "runtime-instance-2",
      uptimeMs: 100,
      stderrLineCount: 1,
      stderrTail: ["Error: write EPIPE"],
    });

    const spawnError = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessError,
      pid: null,
      provider: "glm",
      workspacePath: "/repo/demo",
      command: "/tmp/missing-zcode-agent",
      args: ["app-server", "--stdio"],
      errorName: "Error",
      errorCode: "ENOENT",
      errorMessage: "spawn ENOENT",
      errorStack: "Error: spawn ENOENT",
      runtimeGeneration: 2,
      runtimeInstanceId: "runtime-instance-2",
      occurredAt: Date.now(),
    });

    expect(spawned.success).toBe(true);
    expect(ready.success).toBe(true);
    expect(exited.success).toBe(true);
    expect(spawnError.success).toBe(true);
  });

  it("keeps accepting lifecycle payloads from a rolling-upgrade host without runtime instance IDs", () => {
    const spawned = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessSpawned,
      pid: 12345,
      provider: "glm",
      workspacePath: "/repo/demo",
      command: "/tmp/zcode-agent",
      args: ["--stdio"],
      startedAt: Date.now(),
    });
    const exited = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentProcessExited,
      pid: 12345,
      provider: "glm",
      workspacePath: "/repo/demo",
      exitCode: 1,
      signal: null,
      endedAt: Date.now(),
      terminationKind: "unexpected",
      runtimeGeneration: 2,
      uptimeMs: 100,
      stderrLineCount: 0,
    });

    expect(spawned.success).toBe(true);
    expect(exited.success).toBe(true);
  });

  it("accepts a strict CUA operation state payload", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.CuaOperationState,
      active: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      workspacePath: "C:\\repo",
      workspaceIdentity: "local:test",
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    { active: "true" },
    { sessionId: "" },
    { turnId: "" },
    { workspacePath: "" },
    { unexpected: true },
  ])("rejects invalid CUA operation state payload %#", (override) => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: "cua-operation-state",
      active: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      workspacePath: "C:\\repo",
      ...override,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts network telemetry batch payload", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.NetworkTelemetryBatch,
      observations: [
        {
          transport: "rpc",
          interface: "file.read",
          durationMs: 12,
          ok: true,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a strict Agent resource sample and rejects identity fields", () => {
    const payload = {
      type: HostResponseTypes.AgentResourceSample,
      runtimeSurface: "remote",
      sample: {
        arch: "x64",
        cpuCores: 1.5,
        cpuPercent: 18.75,
        intervalMs: 60_000,
        logicalCpuCount: 8,
        platform: "linux",
        rssKb: 131_072,
      },
    };

    expect(hostResponseMessageSchema.safeParse(payload).success).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        ...payload,
        sample: {
          ...payload.sample,
          workspaceIdentity: "remote:ssh:secret",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts cron scheduler wake request with a non-empty automation id", () => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.CronSchedulerWakeRequest,
        automationId: "automation-1",
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.CronSchedulerWakeRequest,
        automationId: "",
      }).success,
    ).toBe(false);
  });

  it("accepts agent running task count payload", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts workspace running task facts used by the Host-owned WSL TTL", () => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
        workspacePath: "/work/a",
        workspaceIdentity: "remote:wsl:a",
        runningTaskCount: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts local host init payload", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "init-local",
      workspacePath: "/repo/active",
      agentWarmupTargets: [{ workspacePath: "/repo/active" }],
      zcodeBuiltinProviderConfigFilePath: "/repo/config/provider/zcode-builtin.json",
      runtimeProcessEnvPatch: {
        PATH: "/Users/demo/.local/bin:/usr/bin:/bin",
        FNM_DIR: "/Users/demo/.fnm",
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "init-local") {
      expect(parsed.data.runtimeProcessEnvPatch?.PATH).toContain("/Users/demo/.local/bin");
      expect(parsed.data.zcodeBuiltinProviderConfigFilePath).toBe(
        "/repo/config/provider/zcode-builtin.json",
      );
    }
  });

  it("rejects local host init without an ZCode Built-in Provider Config", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "init-local",
      }).success,
    ).toBe(false);
  });

  it("rejects non-string values in local host runtime env patch", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "init-local",
        zcodeBuiltinProviderConfigFilePath: "/repo/config/provider/zcode-builtin.json",
        runtimeProcessEnvPatch: { PATH: ["/usr/bin"] },
      }).success,
    ).toBe(false);
  });

  it("rejects more than one local host agent warmup target", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "init-local",
      zcodeBuiltinProviderConfigFilePath: "/repo/config/provider/zcode-builtin.json",
      agentWarmupTargets: ["a", "b"].map((name) => ({
        workspacePath: `/repo/${name}`,
      })),
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts window Host connect payload with remote ZCode Agent asset dirs", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "connect-remote-workspace",
      requestId: "connect-docker-1",
      target: {
        kind: "docker",
        container: "demo",
      },
      remoteAssets: {
        mockCdnDir: "/tmp/mock-cdn",
        remoteCdnBaseUrl: "",
        remoteCdnBaseUrls: ["https://cdn.codegeex.cn/zcode/electron/releases/0.0.0-test"],
        remoteCacheDir: "/tmp/remote-cache",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts encrypted SSH private key passphrase in window Host connect payload", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "connect-remote-workspace",
      requestId: "connect-ssh-1",
      target: {
        kind: "ssh",
        host: "demo.internal",
        port: 22,
        username: "root",
        sshConfigAlias: "demo-alias",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "key-secret",
      },
      remoteAssets: {},
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "connect-remote-workspace") {
      expect(parsed.data.target).toMatchObject({
        kind: "ssh",
        sshConfigAlias: "demo-alias",
      });
    }
  });

  it("accepts combined workspace session snapshots in settings", () => {
    const parsed = appSettingsSchema.safeParse({
      recentProjects: [],
      locale: "zh-CN",
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: "/tmp/local-demo",
          workspacePurpose: "conversation",
        },
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            port: 22,
            username: "root",
            sshConfigAlias: "demo-alias",
            privateKeyPath: "~/.ssh/id_ed25519",
            passwordCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
            privateKeyPassphraseCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
          },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "failed",
          lastConnectionError: "connection refused",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lastWorkspaceSession?.[0]).toEqual({
        kind: "local",
        workspacePath: "/tmp/local-demo",
        workspacePurpose: "conversation",
      });
      expect(parsed.data.lastWorkspaceSession?.[1]).toMatchObject({
        kind: "remote",
        target: {
          kind: "ssh",
          sshConfigAlias: "demo-alias",
        },
      });
    }
  });

  it("defaults legacy local workspace sessions to project purpose", () => {
    const parsed = appSettingsSchema.parse({
      lastWorkspaceSession: [{ kind: "local", workspacePath: "/tmp/legacy-project" }],
    });

    expect(parsed.lastWorkspaceSession[0]).toEqual({
      kind: "local",
      workspacePath: "/tmp/legacy-project",
      workspacePurpose: "project",
    });
  });

  it("rejects unsafe persisted WSL users in settings and patches", () => {
    const remoteSession = {
      kind: "remote",
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:root-dev:/workspace/demo",
      target: {
        kind: "wsl",
        distro: "Ubuntu",
        user: "root/dev",
      },
      lastOpenedAt: Date.now(),
      lastConnectionStatus: "failed",
    };

    expect(
      appSettingsSchema.safeParse({
        lastWorkspaceSession: [remoteSession],
      }).success,
    ).toBe(false);
    expect(
      appSettingsPatchSchema.safeParse({
        lastWorkspaceSession: [remoteSession],
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        lastWorkspaceSession: [
          {
            ...remoteSession,
            workspaceIdentity: "remote:wsl:Ubuntu:root:/workspace/demo",
            target: {
              kind: "wsl",
              distro: "Ubuntu",
              user: "root",
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("defaults Memory to off and preserves an explicit user selection", () => {
    const defaults = appSettingsSchema.parse({});
    const explicitEnabled = appSettingsSchema.parse({ memoryEnabled: true });
    const explicitDisabled = appSettingsSchema.parse({ memoryEnabled: false });

    expect(defaults.memoryEnabled).toBe(false);
    expect(explicitEnabled.memoryEnabled).toBe(true);
    expect(explicitDisabled.memoryEnabled).toBe(false);
  });

  it("defaults AskUserQuestion auto-resolution to on and validates boolean patches", () => {
    const defaults = appSettingsSchema.parse({});
    const explicitEnabled = appSettingsSchema.parse({
      askUserQuestionAutoResolutionEnabled: true,
    });
    const explicitDisabled = appSettingsSchema.parse({
      askUserQuestionAutoResolutionEnabled: false,
    });

    expect(defaults.askUserQuestionAutoResolutionEnabled).toBe(true);
    expect(explicitEnabled.askUserQuestionAutoResolutionEnabled).toBe(true);
    expect(explicitDisabled.askUserQuestionAutoResolutionEnabled).toBe(false);
    expect(
      appSettingsPatchSchema.parse({
        askUserQuestionAutoResolutionEnabled: false,
      }).askUserQuestionAutoResolutionEnabled,
    ).toBe(false);
    expect(
      appSettingsPatchSchema.safeParse({
        askUserQuestionAutoResolutionEnabled: "false",
      }).success,
    ).toBe(false);
  });

  it("首次统一开启消息流 reasoning，迁移后保留用户选择", () => {
    const defaults = appSettingsSchema.parse({});
    const migratedMissing = appSettingsSchema.parse({
      messageStreamShowTodos: true,
    });
    const migratedLegacyDisabled = appSettingsSchema.parse({
      messageStreamShowReasoning: false,
    });
    const migratedLegacyEnabled = appSettingsSchema.parse({
      messageStreamShowReasoning: true,
    });
    const explicitDisabled = appSettingsSchema.parse({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
    });
    const explicitEnabled = appSettingsSchema.parse({
      messageStreamShowReasoning: true,
      messageStreamShowReasoningMigrationInitialized: true,
    });
    const patch = appSettingsPatchSchema.parse({
      messageStreamShowReasoning: false,
      messageStreamShowTodos: true,
    });

    expect(defaults.messageStreamShowReasoning).toBe(true);
    expect(defaults.messageStreamShowReasoningMigrationInitialized).toBe(true);
    expect(defaults.messageStreamShowTodos).toBe(false);
    expect(migratedMissing.messageStreamShowReasoning).toBe(true);
    expect(migratedMissing.messageStreamShowReasoningMigrationInitialized).toBe(true);
    expect(migratedMissing.messageStreamShowTodos).toBe(true);
    expect(migratedLegacyDisabled.messageStreamShowReasoning).toBe(true);
    expect(migratedLegacyEnabled.messageStreamShowReasoning).toBe(true);
    expect(explicitDisabled.messageStreamShowReasoning).toBe(false);
    expect(explicitEnabled.messageStreamShowReasoning).toBe(true);
    expect(patch).toMatchObject({
      messageStreamShowReasoning: false,
      messageStreamShowTodos: true,
    });
  });

  it("defaults tool call grouping preferences by group type", () => {
    const parsed = appSettingsSchema.parse({});
    const patch = appSettingsPatchSchema.parse({
      toolGroupingExploreEnabled: false,
      toolGroupingTerminalEnabled: false,
      toolGroupingChangesEnabled: true,
    });

    expect(parsed.toolGroupingExploreEnabled).toBe(true);
    expect(parsed.toolGroupingTerminalEnabled).toBe(true);
    expect(parsed.toolGroupingChangesEnabled).toBe(false);
    expect(patch).toMatchObject({
      toolGroupingExploreEnabled: false,
      toolGroupingTerminalEnabled: false,
      toolGroupingChangesEnabled: true,
    });
    expect(appSettingsPatchSchema.safeParse({ toolGroupingExploreEnabled: "false" }).success).toBe(
      false,
    );
  });

  it("首次统一开启 Windows 关闭到托盘，迁移后保留用户选择", () => {
    const defaults = appSettingsSchema.parse({});
    const migratedLegacyDisabled = appSettingsSchema.parse({
      closeToTrayOnWindows: false,
    });
    const migratedLegacyEnabled = appSettingsSchema.parse({
      closeToTrayOnWindows: true,
    });
    const explicitDisabled = appSettingsSchema.parse({
      closeToTrayOnWindows: false,
      closeToTrayOnWindowsMigrationInitialized: true,
    });
    const explicitEnabled = appSettingsSchema.parse({
      closeToTrayOnWindows: true,
      closeToTrayOnWindowsMigrationInitialized: true,
    });

    expect(defaults.closeToTrayOnWindows).toBe(true);
    expect(defaults.closeToTrayOnWindowsMigrationInitialized).toBe(true);
    expect(migratedLegacyDisabled.closeToTrayOnWindows).toBe(true);
    expect(migratedLegacyEnabled.closeToTrayOnWindows).toBe(true);
    expect(explicitDisabled.closeToTrayOnWindows).toBe(false);
    expect(explicitEnabled.closeToTrayOnWindows).toBe(true);
  });

  it("accepts explicit HTTP proxy and custom CA settings", () => {
    const parsed = appSettingsSchema.parse({
      httpProxy: "http://127.0.0.1:7890",
      httpProxyNoProxy: "localhost,127.0.0.1",
      httpProxyCaCertPath: "/tmp/root-ca.pem",
    });
    const patch = appSettingsPatchSchema.parse({
      httpProxy: "http://127.0.0.1:7890",
      httpProxyNoProxy: "localhost,127.0.0.1",
      httpProxyCaCertPath: "/tmp/root-ca.pem",
    });

    expect(parsed.httpProxy).toBe("http://127.0.0.1:7890");
    expect(parsed.httpProxyNoProxy).toBe("localhost,127.0.0.1");
    expect(parsed.httpProxyCaCertPath).toBe("/tmp/root-ca.pem");
    expect(patch.httpProxyNoProxy).toBe("localhost,127.0.0.1");
    expect(patch.httpProxyCaCertPath).toBe("/tmp/root-ca.pem");
  });

  it("defaults the embedded Browser insecure certificate switch to off and accepts patches", () => {
    const parsed = appSettingsSchema.parse({});
    const enabled = appSettingsSchema.parse({
      embeddedBrowserAllowInsecureCertificates: true,
    });
    const patch = appSettingsPatchSchema.parse({
      embeddedBrowserAllowInsecureCertificates: true,
    });

    // 降低安全性的开关必须默认关闭，升级到新版本的用户不能被动获得放行行为。
    expect(parsed.embeddedBrowserAllowInsecureCertificates).toBe(false);
    expect(enabled.embeddedBrowserAllowInsecureCertificates).toBe(true);
    expect(patch.embeddedBrowserAllowInsecureCertificates).toBe(true);
  });

  it("defaults the composer Computer Use entry to hidden and accepts patches", () => {
    const parsed = appSettingsSchema.parse({});
    const shown = appSettingsSchema.parse({ computerUseComposerEntryHidden: false });
    const patch = appSettingsPatchSchema.parse({ computerUseComposerEntryHidden: false });

    // 2026-08-21 产品决定输入框入口默认不展示，设置项保留、默认关闭。
    // 显式存过 false 的用户保持展示——default 只对缺省字段生效，不覆盖既有选择。
    expect(parsed.computerUseComposerEntryHidden).toBe(true);
    expect(shown.computerUseComposerEntryHidden).toBe(false);
    expect(patch.computerUseComposerEntryHidden).toBe(false);
  });

  it("defaults ZCode interaction behavior to queue and accepts guide patches", () => {
    const parsed = appSettingsSchema.parse({});
    const patch = appSettingsPatchSchema.parse({
      zcodeInteractionBehavior: "guide",
    });

    expect(parsed.zcodeInteractionBehavior).toBe("queue");
    expect(patch).toMatchObject({
      zcodeInteractionBehavior: "guide",
    });
  });

  it("accepts provider family domain settings and defaults migration marker to false", () => {
    const defaults = appSettingsSchema.parse({});
    const parsed = appSettingsSchema.parse({
      providerFamilyDomain: "zai",
      providerFamilyDomainUpdatedAt: 123,
      providerFamilyDomainMigrated: true,
    });
    const patch = appSettingsPatchSchema.parse({
      providerFamilyDomain: "",
      providerFamilyDomainUpdatedAt: 456,
      providerFamilyDomainMigrated: true,
    });

    expect(defaults.providerFamilyDomain).toBeUndefined();
    expect(defaults.providerFamilyDomainMigrated).toBe(false);
    expect(parsed.providerFamilyDomain).toBe("zai");
    expect(parsed.providerFamilyDomainUpdatedAt).toBe(123);
    expect(parsed.providerFamilyDomainMigrated).toBe(true);
    expect(patch.providerFamilyDomain).toBe("");
    expect(patch.providerFamilyDomainUpdatedAt).toBe(456);
  });

  it("normalizes legacy enabled agent CLI providers to ZCode Agent", () => {
    const parsed = appSettingsSchema.parse({
      enabledBuiltinAgentCliProviders: ["claude", "codex", "gemini", "opencode"],
    });
    const patch = appSettingsPatchSchema.parse({
      enabledBuiltinAgentCliProviders: ["claude", "codex"],
    });

    expect(parsed.enabledBuiltinAgentCliProviders).toEqual(["glm"]);
    expect(patch.enabledBuiltinAgentCliProviders).toEqual(["glm"]);
  });

  it("preserves SSH remote asset install mode and drops historical resource packages", () => {
    const parsed = appSettingsSchema.safeParse({
      recentProjects: [],
      locale: "zh-CN",
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            port: 22,
            username: "root",
            assetInstallMode: "remote-download",
            resourcePackages: {
              selectedPackageIds: ["acp-codex", "unknown-retired-runtime"],
            },
          },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "connected",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    const sessionEntry = parsed.data.lastWorkspaceSession[0];
    expect(sessionEntry).toMatchObject({
      kind: "remote",
      target: {
        kind: "ssh",
        assetInstallMode: "remote-download",
      },
    });
    if (sessionEntry?.kind !== "remote") {
      throw new Error("expected remote workspace session");
    }
    expect(sessionEntry.target).not.toHaveProperty("resourcePackages");
  });

  it("migrates legacy lastOpenTabs and remoteWorkspaceHistory into lastWorkspaceSession", () => {
    const parsed = appSettingsSchema.safeParse({
      recentProjects: [],
      locale: "zh-CN",
      lastOpenTabs: ["/tmp/local-demo"],
      lastWorkspaceSession: [{ kind: "remote", historyId: "remote-history-1" }],
      remoteWorkspaceHistory: [
        {
          id: "remote-history-1",
          workspacePath: "/workspace/demo",
          target: {
            kind: "docker",
            container: "demo",
          },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "failed",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lastWorkspaceSession).toEqual([
      {
        kind: "remote",
        workspacePath: "/workspace/demo",
        target: {
          kind: "docker",
          container: "demo",
        },
        lastOpenedAt: expect.any(Number),
        lastConnectionStatus: "failed",
      },
      {
        kind: "local",
        workspacePath: "/tmp/local-demo",
        workspacePurpose: "project",
      },
    ]);
  });

  it("migrates legacy remoteWorkspaceHistory after dropping historical resource packages", () => {
    const parsed = appSettingsSchema.safeParse({
      recentProjects: [],
      locale: "zh-CN",
      lastWorkspaceSession: [{ kind: "remote", historyId: "remote-history-ssh" }],
      remoteWorkspaceHistory: [
        {
          id: "remote-history-ssh",
          workspacePath: "/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            username: "root",
            resourcePackages: {
              selectedPackageIds: ["acp-codex", "unknown-retired-runtime"],
            },
          },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "connected",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    const sessionEntry = parsed.data.lastWorkspaceSession[0];
    expect(sessionEntry).toMatchObject({
      kind: "remote",
      workspacePath: "/workspace/demo",
      target: {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
      },
      lastOpenedAt: expect.any(Number),
      lastConnectionStatus: "connected",
    });
    if (sessionEntry?.kind !== "remote") {
      throw new Error("expected remote workspace session");
    }
    expect(sessionEntry.target).not.toHaveProperty("resourcePackages");
  });

  it("drops retired ZCode Agent proxy settings from legacy settings files", () => {
    const parsed = appSettingsSchema.safeParse({
      recentProjects: [],
      locale: "zh-CN",
      retiredProxyUrl: "127.0.0.1:7890",
      retiredProxyUseSystemCa: true,
      retiredProxyCaCertPath: "C:\\Users\\test\\proxy-ca.pem",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("retiredProxyUrl");
    expect(parsed.data).not.toHaveProperty("retiredProxyUseSystemCa");
    expect(parsed.data).not.toHaveProperty("retiredProxyCaCertPath");
  });
});

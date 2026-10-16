import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-mcp-sync-home-"));
}

async function writeZcodeUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".zcode", "cli", "config.json");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`,
  );
  return configPath;
}

async function writeAgentsUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".agents", "mcp.json");
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
  );
  return configPath;
}

async function readRemoteZcodeServers(home: string) {
  const raw = await readFile(join(home, ".zcode", "cli", "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    mcp?: { servers?: Record<string, Record<string, unknown>> };
  };
  return parsed.mcp?.servers ?? {};
}

describe("mcp sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists user zcode MCP servers as local candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeZcodeUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.localHomeDir).toBe(home);
    expect(result.candidates).toMatchObject([
      {
        name: "context7",
        enabled: true,
        source: "zcode",
        path: join(home, ".zcode", "cli", "config.json"),
        config: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      },
    ]);
  });

  it("marks a candidate disabled when only enabled:false is present", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 外部工具/手工编辑写的是 enabled:false；同步侧不能把它当成启用状态。
    await writeZcodeUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: false,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
  });

  it("clears a stale enabled flag when toggling a server", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上配置里 enable 与 enabled 并存，切换开关后不能再留下自相矛盾的字段。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: false,
    });

    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: true,
    });

    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("migrates a legacy enable flag to enabled when listing candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 存量配置只有桌面端历史写入的 enable；同步侧读取时应就地迁移成契约字段 enabled。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("keeps a candidate disabled when legacy enable:false collides with enabled:true", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上事故配置：停用写了 enable:false，但外部导入残留 enabled:true。迁移必须保住停用语义。
    await writeZcodeUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
    expect((await readRemoteZcodeServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("leaves the config file untouched when no legacy enable flag exists", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 迁移必须幂等：没有残留字段时不能重写文件，否则每次列举候选都会动用户的配置。
    // 故意用非规范化的紧凑 JSON 落盘，任何重写都会改变字节内容。
    const configPath = join(home, ".zcode", "cli", "config.json");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    const raw = JSON.stringify({
      mcp: {
        servers: {
          context7: {
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            enabled: false,
          },
        },
      },
    });
    await writeFile(configPath, raw);
    const service = createMcpSyncService();

    await service.listLocalUserMcpCandidates();

    await expect(readFile(configPath, "utf-8")).resolves.toBe(raw);
  });

  it("checks remote MCP config directory write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createMcpSyncService();

    const result = await service.checkRemoteUserMcpWriteAccess();

    expect(result).toMatchObject({
      ok: true,
      path: join(remoteHome, ".zcode", "cli"),
    });
  });

  it("reports remote MCP write preflight failure when cli path is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".zcode"), { recursive: true });
    await writeFile(join(remoteHome, ".zcode", "cli"), "not a directory");
    const service = createMcpSyncService();

    const result = await service.checkRemoteUserMcpWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".zcode", "cli"));
    expect(result.error).toBeTruthy();
  });

  it("falls back to user agents MCP servers when zcode user MCP is empty", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeAgentsUserMcp(home, {
      docs: {
        type: "http",
        url: "https://mcp.example.com/mcp",
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates).toMatchObject([
      {
        name: "docs",
        source: "agents",
        path: join(home, ".agents", "mcp.json"),
      },
    ]);
  });

  it("imports stdio and HTTP MCP servers while preserving secrets", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { CONTEXT7_API_KEY: "secret-local" },
      },
      docsApi: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    const result = await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      remoteWorkspacePath: "/home/dev/project",
      overwrite: false,
    });

    expect(result.results).toMatchObject([
      { name: "context7", status: "synced" },
      { name: "docsApi", status: "synced" },
    ]);
    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "secret-local" },
    });
    expect(remoteServers.docsApi).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("creates imported remote MCP config with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    const previousUmask = process.umask(0o000);
    try {
      const remoteHome = makeHome();
      process.env.HOME = remoteHome;
      const remoteService = createMcpSyncService();

      await remoteService.importMcpServers({
        servers: [
          {
            id: "docs-api",
            name: "docsApi",
            source: "zcode",
            path: "/Users/local/.zcode/cli/config.json",
            enabled: true,
            config: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: { Authorization: "Bearer secret-token" },
            },
          },
        ],
        localHomeDir: "/Users/local",
        overwrite: false,
      });

      const configMode = (await stat(join(remoteHome, ".zcode", "cli", "config.json")))
        .mode;
      expect(configMode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails remote import without overwriting an invalid zcode config file", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const invalidConfigPath = join(remoteHome, ".zcode", "cli", "config.json");
    await mkdir(join(remoteHome, ".zcode", "cli"), { recursive: true });
    await writeFile(invalidConfigPath, '{"mcp":');
    const remoteService = createMcpSyncService();

    await expect(
      remoteService.importMcpServers({
        servers: exported.servers,
        localHomeDir: exported.localHomeDir,
        remoteWorkspacePath: "/home/dev/project",
        overwrite: false,
      }),
    ).rejects.toThrow(/config\.json/);
    await expect(readFile(invalidConfigPath, "utf-8")).resolves.toBe('{"mcp":');
  });

  it("loads and saves user MCP through the service on the current host", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "deepwiki",
      config: {
        type: "http",
        url: "https://mcp.deepwiki.com/mcp",
      },
    });

    const result = await service.loadMcpFromUserDirectory();

    expect(result.servers).toMatchObject([
      {
        source: "zcodeagentmcp",
        scope: "user",
        name: "deepwiki",
        config: {
          type: "http",
          url: "https://mcp.deepwiki.com/mcp",
        },
      },
    ]);
    expect(result.servers[0]?.file?.filePath).toBe(
      join(home, ".zcode", "cli", "config.json"),
    );
  });

  it("loads workspace MCP before user MCP using the same directory precedence", async () => {
    const home = makeHome();
    const workspace = join(home, "workspace");
    process.env.HOME = home;
    await writeZcodeUserMcp(home, {
      userOnly: { type: "http", url: "https://user.example.test/mcp" },
    });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify(
        {
          mcp: {
            servers: {
              workspaceOnly: {
                type: "http",
                url: "https://workspace.example.test/mcp",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const service = createMcpSyncService();

    const result = await service.loadMcpFromUserDirectory({ workspacePath: workspace });

    expect(result.servers.map((server) => `${server.scope}:${server.name}`)).toEqual([
      "workspace:workspaceOnly",
      "user:userOnly",
    ]);
  });

  it("rewrites filesystem MCP home and workspace paths for the remote host", async () => {
    const localHome = makeHome();
    const localWorkspacePath = join(localHome, "workspace", "z-code");
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          join(localWorkspacePath, "src"),
          join(localHome, "Documents"),
        ],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      localWorkspacePath,
      remoteWorkspacePath: "/srv/z-code",
      overwrite: false,
    });

    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.filesystem?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/srv/z-code/src",
      join(remoteHome, "Documents"),
    ]);
  });

  it("skips same-name remote MCP servers without overwriting", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeZcodeUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeZcodeUserMcp(remoteHome, {
      context7: {
        type: "stdio",
        command: "existing-command",
      },
    });
    const remoteService = createMcpSyncService();

    const result = await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      remoteWorkspacePath: "/home/dev/project",
      overwrite: false,
    });

    expect(result.results).toEqual([
      {
        name: "context7",
        status: "skipped",
        path: join(remoteHome, ".zcode", "cli", "config.json"),
      },
    ]);
    const remoteServers = await readRemoteZcodeServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "existing-command",
    });
  });
});

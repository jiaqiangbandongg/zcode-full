import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_PLUGIN_MARKETPLACES } from "@zcode/shared";
import { getE2EAppDataPaths } from "./desktop-app.js";

export const PLUGIN_RUNTIME_ENV_MARKETPLACE_ID =
  "e2e-plugin-runtime-env-market";
export const PLUGIN_RUNTIME_ENV_NAME = "e2e-plugin-secret-agent";
export const PLUGIN_RUNTIME_ENV_ID = `${PLUGIN_RUNTIME_ENV_NAME}@${PLUGIN_RUNTIME_ENV_MARKETPLACE_ID}`;
export const PLUGIN_RUNTIME_ENV_VARIABLE = "E2E_PLUGIN_RUNTIME_SECRET";
export const PLUGIN_RUNTIME_ENV_RESOLVED_MARKER =
  "E2E_PLUGIN_RUNTIME_SECRET_RESOLVED";
export const PLUGIN_RUNTIME_ENV_TOOL_NAME =
  "mcp__plugin_e2e-plugin-secret-agent_secret-verifier__verify_secret_env";
export const PLUGIN_RUNTIME_ENV_AGENT_NAME = `${PLUGIN_RUNTIME_ENV_NAME}:secret-auditor`;
export const PLUGIN_RUNTIME_ENV_AGENT_BARE_NAME = "secret-auditor";

export interface PluginRuntimeEnvFixture {
  marketplaceRoot: string;
}

export async function createPluginRuntimeEnvFixture(
  expectedSecret: string,
): Promise<PluginRuntimeEnvFixture> {
  const { homeDir } = getE2EAppDataPaths();
  await primeDefaultPluginMarketplacesForE2E(homeDir);
  const marketplaceRoot = join(
    homeDir,
    "fixtures",
    PLUGIN_RUNTIME_ENV_MARKETPLACE_ID,
  );
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_RUNTIME_ENV_NAME);
  await rm(marketplaceRoot, { force: true, recursive: true });

  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_RUNTIME_ENV_NAME,
    version: "1.0.0",
    description: "E2E plugin MCP secret env and agent projection fixture",
    agents: "agents",
    mcpServers: {
      "secret-verifier": {
        type: "stdio",
        command: "node",
        args: ["${ZCODE_PLUGIN_ROOT}/server.mjs"],
        env: {
          [PLUGIN_RUNTIME_ENV_VARIABLE]: `\${${PLUGIN_RUNTIME_ENV_VARIABLE}}`,
        },
      },
    },
  });
  await writeText(
    join(pluginRoot, "agents", `${PLUGIN_RUNTIME_ENV_AGENT_BARE_NAME}.md`),
    [
      "---",
      `name: ${PLUGIN_RUNTIME_ENV_AGENT_BARE_NAME}`,
      "description: Verifies plugin agent resource identity",
      "tools:",
      "  - Read",
      "---",
      "Report the plugin agent identity.",
    ].join("\n"),
  );
  await writeText(
    join(pluginRoot, "server.mjs"),
    buildSecretVerifierServer(
      createHash("sha256").update(expectedSecret).digest("hex"),
    ),
  );
  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: PLUGIN_RUNTIME_ENV_MARKETPLACE_ID,
    description: "E2E Plugin Runtime Env Market",
    plugins: [
      {
        name: PLUGIN_RUNTIME_ENV_NAME,
        version: "1.0.0",
        description: "Plugin MCP secret env and agent projection fixture",
        source: `./plugins/${PLUGIN_RUNTIME_ENV_NAME}`,
      },
    ],
  });

  return { marketplaceRoot };
}

async function primeDefaultPluginMarketplacesForE2E(homeDir: string): Promise<void> {
  const path = join(
    homeDir,
    ".zcode",
    "cli",
    "plugins",
    "known_marketplaces.json",
  );
  const existing = await readKnownMarketplaceRecords(path);
  const now = new Date().toISOString();
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const marketplace of DEFAULT_PLUGIN_MARKETPLACES) {
    const current = byId.get(marketplace.id);
    byId.set(marketplace.id, {
      ...(current ?? {
        addedAt: now,
        id: marketplace.id,
        name: marketplace.name,
        source: marketplace.source.includes(":")
          ? { source: "url", url: marketplace.source }
          : { repo: marketplace.source, source: "github" },
      }),
      // 修复原因：该 case 只验证本地插件，若默认市场未标记为已加载，设置页会并发 clone
      // GitHub 官方市场并占住插件协议请求，导致本地市场已落盘但添加弹窗无法收尾。
      lastUpdated: current?.lastUpdated ?? now,
      pluginCount: Math.max(1, current?.pluginCount ?? marketplace.pluginCount),
    });
  }
  await writeJson(path, {
    version: 1,
    marketplaces: [...byId.values()],
  });
}

async function readKnownMarketplaceRecords(
  path: string,
): Promise<Array<Record<string, unknown> & { id: string; pluginCount?: number }>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as {
      marketplaces?: unknown;
    };
    if (!Array.isArray(parsed.marketplaces)) return [];
    return parsed.marketplaces.filter(
      (
        record,
      ): record is Record<string, unknown> & {
        id: string;
        pluginCount?: number;
      } =>
        typeof record === "object" &&
        record !== null &&
        typeof (record as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

function buildSecretVerifierServer(expectedSecretHash: string): string {
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import readline from "node:readline";
const actual = process.env.${PLUGIN_RUNTIME_ENV_VARIABLE} || "";
const resolved = createHash("sha256").update(actual).digest("hex") === ${JSON.stringify(expectedSecretHash)};
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "e2e-plugin-secret-agent", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "verify_secret_env", description: "Return only whether the plugin secret environment was resolved", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: resolved ? ${JSON.stringify(PLUGIN_RUNTIME_ENV_RESOLVED_MARKER)} : "E2E_PLUGIN_RUNTIME_SECRET_UNRESOLVED" }] } });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

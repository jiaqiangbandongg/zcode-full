import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZCodeAgentMcpServer } from "@zcode/shared";
import { appendWorkspaceToFilesystemMcpServers } from "../src/session/mcpWorkspaceScope.js";

const tempDirs: string[] = [];

async function makeWorkspaceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mcp-workspace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("appendWorkspaceToFilesystemMcpServers", () => {
  it("会给 filesystem MCP 非持久化追加当前 workspace", async () => {
    const workspacePath = await makeWorkspaceDir();
    const servers: ZCodeAgentMcpServer[] = [
      {
        name: "filesystem",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/Users/example/Desktop",
        ],
        env: [],
      },
    ];

    const scoped = appendWorkspaceToFilesystemMcpServers(servers, workspacePath);

    expect(scoped).not.toBe(servers);
    expect(scoped?.[0]).toMatchObject({
      name: "filesystem",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/example/Desktop",
        workspacePath,
      ],
    });
    expect(servers[0]?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/Users/example/Desktop",
    ]);
  });

  it("workspace 已存在于 filesystem MCP 时不会重复追加", async () => {
    const workspacePath = await makeWorkspaceDir();
    const servers: ZCodeAgentMcpServer[] = [
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", workspacePath],
        env: [],
      },
    ];

    const scoped = appendWorkspaceToFilesystemMcpServers(servers, workspacePath);

    expect(scoped).toBe(servers);
    expect(scoped?.[0]?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      workspacePath,
    ]);
  });

  it("远程或不存在的 workspace 不会注入本机 filesystem MCP", () => {
    const servers: ZCodeAgentMcpServer[] = [
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/example/Desktop"],
        env: [],
      },
    ];

    const scoped = appendWorkspaceToFilesystemMcpServers(
      servers,
      "/definitely/not/a/local/workspace",
    );

    expect(scoped).toBe(servers);
  });
});

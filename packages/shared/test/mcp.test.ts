import { describe, expect, it } from "vitest";
import {
  convertToZCodeAgentMcpServer,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
} from "../src/mcp.js";

describe("zcode-cua MCP matcher (single source of truth for services + CLI bootstrap)", () => {
  it("matches the zcode-cua command by leaf name", () => {
    expect(isZCodeCuaMcpCommand("zcode-cua")).toBe(true);
    expect(isZCodeCuaMcpCommand("/opt/homebrew/bin/zcode-cua")).toBe(true);
    expect(isZCodeCuaMcpCommand("uvx")).toBe(false);
    expect(isZCodeCuaMcpCommand("zcode-cua-server")).toBe(false);
  });

  it("matches uvx/pip package spec forms", () => {
    for (const arg of ["zcode-cua", "zcode-cua[macos]", "zcode-cua@v0.1.3", "zcode-cua[macos]@v0.1.3"]) {
      expect(isZCodeCuaMcpPackageArg(arg)).toBe(true);
    }
  });

  it("matches git and local-path forms (the drift that broke desktop/services parity)", () => {
    expect(isZCodeCuaMcpPackageArg("zcode-cua.git")).toBe(true);
    expect(isZCodeCuaMcpPackageArg("git+https://github.com/x/zcode-cua.git@v0.1.3")).toBe(true);
    expect(isZCodeCuaMcpPackageArg("/Users/me/src/zcode-cua")).toBe(true);
    expect(isZCodeCuaMcpPackageArg("C:\\src\\zcode-cua")).toBe(true);
  });

  it("does not match unrelated args", () => {
    for (const arg of ["--from", "run", "zcode-cua-server", "not-zcode-cua", "server.js"]) {
      expect(isZCodeCuaMcpPackageArg(arg)).toBe(false);
    }
  });

  it("recognizes a package spec placed in COMMAND position (command/arg matchers stay consistent)", () => {
    // 之前 command matcher 只认精确叶子 zcode-cua，会漏判把包规格直接当 command 的配置 → 漏注入 broker。
    for (const command of ["zcode-cua@1.2.3", "zcode-cua[macos]", "zcode-cua.git", "/opt/tools/zcode-cua@1.2.3"]) {
      expect(isZCodeCuaMcpCommand(command), command).toBe(true);
    }
  });

  it("recognizes pip == pins and the zcode_cua underscore distribution name (PyPI treats _ == -)", () => {
    for (const arg of ["zcode-cua==1.2.3", "zcode_cua", "zcode_cua==1.2.3", "zcode_cua@v0.1.3"]) {
      expect(isZCodeCuaMcpPackageArg(arg), arg).toBe(true);
    }
    expect(isZCodeCuaMcpCommand("zcode_cua")).toBe(true);
  });

  it("does not false-positive on sibling packages like zcode-cua-proxy", () => {
    for (const value of ["zcode-cua-proxy", "zcode-cua-proxy@1.0.0", "zcode-cua-helper"]) {
      expect(isZCodeCuaMcpCommand(value), value).toBe(false);
      expect(isZCodeCuaMcpPackageArg(value), value).toBe(false);
    }
  });

  it("recognizes `python -m zcode_cua.server` submodule form (M1 fail-open fix)", () => {
    // `python -m zcode_cua.server` → arg 是 `zcode_cua.server`；旧 matcher 漏判 → 不注入 broker → fail-open。
    for (const arg of ["zcode_cua.server", "zcode-cua.server", "zcode_cua.main", "zcode-cua.__main__"]) {
      expect(isZCodeCuaMcpPackageArg(arg), arg).toBe(true);
    }
  });

  it("recognizes local paths with a trailing separator (M1 fail-open fix)", () => {
    // `.../zcode-cua/` 直接取叶子会得到空串 → 漏判 → fail-open。
    expect(isZCodeCuaMcpPackageArg("/Users/me/src/zcode-cua/")).toBe(true);
    expect(isZCodeCuaMcpPackageArg("C:\\src\\zcode-cua\\")).toBe(true);
    expect(isZCodeCuaMcpCommand("/opt/homebrew/bin/zcode-cua/")).toBe(true);
    // 但带尾斜杠的 sibling 仍不误判。
    expect(isZCodeCuaMcpPackageArg("/Users/me/src/zcode-cua-proxy/")).toBe(false);
  });
});

describe("MCP config helpers", () => {
  it("passes legacy http_headers through to ZCode Agent MCP servers", () => {
    expect(
      convertToZCodeAgentMcpServer("web-search-prime", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 5000,
        http_headers: {
          Authorization: "Bearer token",
        },
      }),
    ).toEqual({
      name: "web-search-prime",
      type: "http",
      url: "https://bigmodel.example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
      timeoutMs: 5000,
    });
  });

  it("preserves timeoutMs when converting stdio MCP servers for ZCode Agent", () => {
    expect(
      convertToZCodeAgentMcpServer("context7", {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        timeoutMs: 3,
      }),
    ).toEqual({
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [],
      timeoutMs: 3,
    });
  });

  it("preserves timeoutMs when converting sse MCP servers for ZCode Agent", () => {
    expect(
      convertToZCodeAgentMcpServer("stream", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        timeoutMs: 8000,
      }),
    ).toEqual({
      name: "stream",
      type: "sse",
      url: "https://bigmodel.example.test/sse",
      headers: [],
      timeoutMs: 8000,
    });
  });

  it("preserves HTTP OAuth client credentials when converting MCP servers for ZCode Agent", () => {
    expect(
      convertToZCodeAgentMcpServer("protected", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "client_credentials",
          clientId: "zcode-client",
          clientSecret: "secret",
          scope: "mcp:tools",
        },
      }),
    ).toMatchObject({
      name: "protected",
      type: "http",
      oauth: {
        type: "client_credentials",
        clientId: "zcode-client",
        clientSecret: "secret",
        scope: "mcp:tools",
      },
    });
  });

  it("preserves HTTP OAuth authorization code config when converting MCP servers for ZCode Agent", () => {
    expect(
      convertToZCodeAgentMcpServer("figma", {
        type: "http",
        url: "https://mcp.figma.com/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "ZCode",
          redirectPath: "/oauth/callback/mcp/figma",
          scope: "mcp:connect",
        },
      }),
    ).toMatchObject({
      name: "figma",
      type: "http",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });

  it("does not persist implicit OAuth defaults when converting bare HTTP MCP servers", () => {
    expect(
      convertToZCodeAgentMcpServer("notion", {
        type: "http",
        url: "https://mcp.notion.com/mcp",
        timeoutMs: 30000,
      }),
    ).toEqual({
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: [],
      timeoutMs: 30000,
    });
  });

  it("drops invalid timeoutMs when converting MCP servers for ZCode Agent", () => {
    expect(
      convertToZCodeAgentMcpServer("zero", {
        type: "stdio",
        command: "npx",
        timeoutMs: 0,
      }),
    ).not.toHaveProperty("timeoutMs");

    expect(
      convertToZCodeAgentMcpServer("fractional", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 1.5,
      }),
    ).not.toHaveProperty("timeoutMs");
  });

  it("keeps headers ahead of legacy http_headers when both are present", () => {
    expect(
      convertToZCodeAgentMcpServer("web-reader", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        headers: {
          Authorization: "Bearer fresh",
        },
        http_headers: {
          Authorization: "Bearer stale",
        },
      }),
    ).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer fresh" }],
    });
  });
});

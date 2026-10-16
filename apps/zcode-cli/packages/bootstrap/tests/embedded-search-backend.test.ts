import { describe, expect, it } from "vitest";
import { resolveDefaultEmbeddedSearchBackend } from "../src/app/embedded-search-backend.js";

describe("resolveDefaultEmbeddedSearchBackend", () => {
  it("uses bundled bfs, ugrep, and ripgrep paths by default", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: {
          ZCODE_BFS_BINARY: "/opt/zcode/tools/bfs/bfs",
          ZCODE_RG_BINARY: "/opt/zcode/tools/ripgrep/rg",
          ZCODE_UGREP_BINARY: "/opt/zcode/tools/ugrep/ugrep",
        },
      }),
    ).toEqual({
      kind: "native-binaries",
      findCommand: "/opt/zcode/tools/bfs/bfs",
      grepCommand: "/opt/zcode/tools/ugrep/ugrep",
      rgCommand: "/opt/zcode/tools/ripgrep/rg",
    });
  });

  it("falls back to bfs, ugrep, and rg command names when bundled paths are unavailable", () => {
    expect(resolveDefaultEmbeddedSearchBackend({ env: {} })).toEqual({
      kind: "native-binaries",
      findCommand: "bfs",
      grepCommand: "ugrep",
      rgCommand: "rg",
    });
  });

  it("preserves the explicit internal CLI compatibility override", () => {
    expect(
      resolveDefaultEmbeddedSearchBackend({
        env: { ZCODE_EMBEDDED_SEARCH_COMMAND: "/tmp/zcode-test" },
      }),
    ).toEqual({
      kind: "internal-cli",
      command: "/tmp/zcode-test",
      args: ["__internal-search"],
    });
  });
});

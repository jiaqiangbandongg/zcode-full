import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  E2E_RUNTIME_RELATIVE_ROOT,
  E2E_RUNTIME_ROOT_REPLAY_TOKEN,
  createE2EReplayFixtureVariables,
  resolveE2EHomeDir,
  resolveE2EStorageRoot,
  resolveE2ERuntimePath,
  resolveE2ERuntimeRoot,
  resolveE2EShellPath,
  resolveE2EToolPath,
} from "./e2e/helpers/e2e-runtime-paths.js";

const DESKTOP_TEST_DIR = import.meta.dirname;
const E2E_DIR = join(DESKTOP_TEST_DIR, "e2e");
const SOURCE_EXTENSIONS = new Set([".js", ".json", ".mjs", ".ts", ".tsx"]);

describe("Desktop E2E runtime paths", () => {
  it("keeps runtime files below the isolated Agent execution workspace", () => {
    const e2eHomeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2ERuntimeRoot(e2eHomeDir)).toBe(join(e2eHomeDir, "ZCodeProject", ".zcode-e2e"));
    expect(resolveE2ERuntimePath("bg25", "release-child-bash")).toBe(
      join(resolveE2ERuntimeRoot(), "bg25", "release-child-bash"),
    );
  });

  it("uses portable absolute tool paths and workspace-relative shell paths", () => {
    expect(resolveE2EToolPath("bg25", "continued-work.txt")).toBe(
      resolveE2ERuntimePath("bg25", "continued-work.txt").replaceAll("\\", "/"),
    );
    expect(resolveE2EShellPath("bg25", "release-child-bash")).toBe(
      ".zcode-e2e/bg25/release-child-bash",
    );
    expect(E2E_RUNTIME_RELATIVE_ROOT).toBe(".zcode-e2e");
    expect(E2E_RUNTIME_ROOT_REPLAY_TOKEN).toBe("{{e2eRuntimeRoot}}");
    expect(createE2EReplayFixtureVariables(resolve("root", "fixture-home"))).toEqual({
      e2eRuntimeRoot: resolveE2ERuntimeRoot(resolve("root", "fixture-home")).replaceAll("\\", "/"),
    });
  });

  it("uses the existing E2E HOME precedence", () => {
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: { ZCODE_DATA_BASE_DIR: resolve("root", "data-base") },
      }),
    ).toBe(resolve("root", "data-base"));
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: {
          ZCODE_DATA_BASE_DIR: resolve("root", "data-base"),
          ZCODE_E2E_HOME_DIR: resolve("root", "explicit-home"),
        },
      }),
    ).toBe(resolve("root", "explicit-home"));
  });

  it("keeps the E2E CLI storage under the legacy .zcode directory", () => {
    const homeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2EStorageRoot(homeDir)).toBe(join(homeDir, ".zcode"));
  });

  it("does not allow raw system /tmp paths in Desktop E2E runtime sources", () => {
    const offenders = collectSourceFiles(E2E_DIR)
      .filter((path) => readFileSync(path, "utf-8").includes("/tmp"))
      .map((path) => relative(E2E_DIR, path).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(path);
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
  });
}

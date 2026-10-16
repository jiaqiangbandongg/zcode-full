import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { getRawHeader } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { ASAR_UNPACK_NATIVE_GLOB, replaceAppAsarFromStaging } from "../scripts/app-asar-repack.mjs";

const require = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(require.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

describe("app asar repack", () => {
  it("TMPDIR 含隐藏目录时仍应 unpack native，并删除旧 sidecar 残留", async () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), ".zcode-asar-repack-test-"));
    try {
      const sourceDir = resolve(rootDir, "source");
      const targetPrebuildDir = resolve(sourceDir, "node_modules/node-pty/prebuilds/darwin-arm64");
      const appAsarPath = resolve(rootDir, "app.asar");
      const oldUnpackedPath = `${appAsarPath}.unpacked`;
      mkdirSync(targetPrebuildDir, { recursive: true });
      mkdirSync(oldUnpackedPath, { recursive: true });
      writeFileSync(resolve(targetPrebuildDir, "pty.node"), "native-binary");
      writeFileSync(resolve(targetPrebuildDir, "spawn-helper"), "helper-binary");
      writeFileSync(resolve(oldUnpackedPath, "stale-native.node"), "stale");

      await replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: "darwin-arm64",
        runAsarCommand: (args: string[]) => {
          execFileSync(process.execPath, [asarCliPath, ...args]);
        },
      });

      const header = getRawHeader(appAsarPath).header as {
        files: Record<string, unknown>;
      };
      const nativeHeader = (
        header.files as {
          node_modules: {
            files: {
              "node-pty": {
                files: {
                  prebuilds: {
                    files: {
                      "darwin-arm64": { files: Record<string, { unpacked?: boolean }> };
                    };
                  };
                };
              };
            };
          };
        }
      ).node_modules.files["node-pty"].files.prebuilds.files["darwin-arm64"].files;

      expect(ASAR_UNPACK_NATIVE_GLOB).toBe("*.{node,dll,dylib,exe}");
      expect(nativeHeader["pty.node"].unpacked).toBe(true);
      expect(nativeHeader["spawn-helper"].unpacked).toBe(true);
      expect(
        readFileSync(
          resolve(oldUnpackedPath, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"),
          "utf8",
        ),
      ).toBe("native-binary");
      expect(existsSync(resolve(oldUnpackedPath, "stale-native.node"))).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});

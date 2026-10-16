import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBashPrefixPermissionPnpmShim } from "./e2e/helpers/bash-prefix-permission-shim.js";

describe("Bash prefix permission E2E pnpm shim", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("prepends a case-owned executable only for the BPR spec", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-bpr-shim-"));
    roots.push(homeDir);
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const shimPath = await installBashPrefixPermissionPnpmShim({
      environment,
      homeDir,
      specs: [
        "/repo/packages/desktop/test/e2e/conversation-session/" +
          "conversation-session-v4-bash-command-prefix-permission.test.ts",
      ],
    });

    expect(shimPath).toBe(
      join(
        homeDir,
        "ZCodeProject",
        ".zcode-e2e",
        "conversation-session-v4-bash-command-prefix-permission",
        "bin",
        "pnpm",
      ),
    );
    expect(environment.PATH?.split(process.platform === "win32" ? ";" : ":")[0]).toBe(
      join(
        homeDir,
        "ZCodeProject",
        ".zcode-e2e",
        "conversation-session-v4-bash-command-prefix-permission",
        "bin",
      ),
    );
    expect(await readFile(shimPath!, "utf8")).toContain('printf "%s\\n" "lint-ok"');
    if (process.platform !== "win32") {
      await expect(access(shimPath!, constants.X_OK)).resolves.toBeUndefined();
    }
  });

  it("does not change PATH for unrelated specs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-bpr-shim-unrelated-"));
    roots.push(homeDir);
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    await expect(
      installBashPrefixPermissionPnpmShim({
        environment,
        homeDir,
        specs: ["/repo/packages/desktop/test/e2e/conversation-session/other.test.ts"],
      }),
    ).resolves.toBeUndefined();
    expect(environment.PATH).toBe("/usr/bin:/bin");
  });

  it("preserves the Windows-style Path key instead of creating a competing PATH key", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-bpr-shim-path-key-"));
    roots.push(homeDir);
    const environment: NodeJS.ProcessEnv = { Path: "/usr/bin:/bin" };

    await installBashPrefixPermissionPnpmShim({
      environment,
      homeDir,
      specs: [
        "/repo/packages/desktop/test/e2e/conversation-session/" +
          "conversation-session-v4-bash-command-prefix-permission.test.ts",
      ],
    });

    expect(environment.Path?.split(process.platform === "win32" ? ";" : ":")[0]).toBe(
      join(
        homeDir,
        "ZCodeProject",
        ".zcode-e2e",
        "conversation-session-v4-bash-command-prefix-permission",
        "bin",
      ),
    );
    expect(environment.PATH).toBeUndefined();
  });
});

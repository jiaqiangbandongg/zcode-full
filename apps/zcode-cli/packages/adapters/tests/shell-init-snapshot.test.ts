import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ShellInitSnapshotManager,
  buildShellInitSnapshotCreationScript,
  detectShellInitConfigPath,
  supportsShellInitSnapshot,
} from "../src/exec/shell-init-snapshot.js";

describe("shell init snapshot", () => {
  it("supports only POSIX and Git Bash dialects", () => {
    expect(supportsShellInitSnapshot("posix")).toBe(true);
    expect(supportsShellInitSnapshot("git-bash")).toBe(true);
    expect(supportsShellInitSnapshot("cmd")).toBe(false);
    expect(supportsShellInitSnapshot("legacy-shell")).toBe(false);
  });

  it("detects rc file path from shell kind", () => {
    expect(
      detectShellInitConfigPath({
        env: { HOME: "/home/user" },
        shellPath: "/bin/zsh",
      }),
    ).toBe("/home/user/.zshrc");
    expect(
      detectShellInitConfigPath({
        env: { HOME: "/home/user" },
        shellPath: "/bin/bash",
      }),
    ).toBe("/home/user/.bashrc");
    expect(
      detectShellInitConfigPath({
        env: { HOME: "/home/user" },
        shellPath: "/bin/sh",
      }),
    ).toBe("/home/user/.profile");
  });

  it("detects Git Bash rc file path from USERPROFILE when HOME is unavailable", () => {
    expect(
      detectShellInitConfigPath({
        env: { USERPROFILE: "C:\\Users\\me" },
        shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      }),
    ).toBe(join("C:\\Users\\me", ".bashrc"));
  });

  it("builds a snapshot creation script that sources config and writes exports", () => {
    const script = buildShellInitSnapshotCreationScript({
      configPath: "/home/user/.bashrc",
      configExists: true,
      shellKind: "bash",
      snapshotPath: "/tmp/zcode-snapshot.sh",
    });

    expect(script).toContain("SNAPSHOT_FILE='/tmp/zcode-snapshot.sh'");
    expect(script).toContain('source "/home/user/.bashrc" < /dev/null');
    expect(script).toContain('echo "# Snapshot file" >| "$SNAPSHOT_FILE"');
    expect(script).toContain('echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"');
    expect(script).toContain("declare -F | cut -d' ' -f3 | grep -vE '^_[^_]'");
    expect(script).toContain("encoded_func=$(declare -f \"$func\" | base64 )");
    expect(script).toContain("base64 -d");
    expect(script).toContain('shopt -p | head -n 1000');
    expect(script).toContain('set -o | grep "on"');
    expect(script).toContain("alias | grep -v \"='winpty \"");
    expect(script).toContain("sed 's/^/alias -- /'");
    expect(script).toContain("head -n 1000");
    expect(script).toContain("export PATH=");
  });

  it("builds zsh snapshot creation scripts with zsh-specific exports", () => {
    const script = buildShellInitSnapshotCreationScript({
      configPath: "/home/user/.zshrc",
      configExists: true,
      shellKind: "zsh",
      snapshotPath: "/tmp/zcode-zsh-snapshot.sh",
    });

    expect(script).toContain("SNAPSHOT_FILE='/tmp/zcode-zsh-snapshot.sh'");
    expect(script).toContain('source "/home/user/.zshrc" < /dev/null');
    expect(script).toContain("typeset +f | grep -vE '^_[^_]'");
    expect(script).toContain("typeset -f \"$func\"");
    expect(script).toContain("setopt | sed 's/^/setopt /' | head -n 1000");
    expect(script).toContain("alias | grep -v \"='winpty \"");
    expect(script).not.toContain("declare -f");
    expect(script).not.toContain("shopt -s expand_aliases");
  });

  it("omits rc sourcing when the selected shell has no config file", () => {
    const script = buildShellInitSnapshotCreationScript({
      configPath: "/home/user/.bashrc",
      configExists: false,
      shellKind: "bash",
      snapshotPath: "/tmp/zcode-snapshot.sh",
    });

    expect(script).toContain("SNAPSHOT_FILE='/tmp/zcode-snapshot.sh'");
    expect(script).not.toContain('source "/home/user/.bashrc" < /dev/null');
    expect(script).toContain('echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"');
    expect(script).not.toContain("declare -F");
    expect(script).not.toContain("alias |");
  });

  it("caches successful snapshot creation with snapshot-<shell>-<time>-<id> names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      const match = script.match(/SNAPSHOT_FILE='([^']+)'/u);
      if (!match) throw new Error("missing snapshot path");
      await writeFile(match[1], "alias ll='ls -l'\n");
      return { stdout: "", stderr: "" };
    });

    try {
      const manager = new ShellInitSnapshotManager({ execFile });
      const first = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });
      const second = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });

      expect(first).toBeDefined();
      if (!first) throw new Error("expected ready snapshot");
      expect(second).toEqual(first);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(first.path).toMatch(/\/shell-snapshots\/snapshot-bash-\d+-[a-z0-9]{6}\.sh$/u);
      expect(first.path).not.toContain("/session/");

      const cleanup = await manager.cleanup();
      expect(cleanup).toEqual({ deleted: 1, errors: 0 });
      await expect(stat(first.path)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent snapshot creation for matching requests", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    let markCreationStarted: (() => void) | undefined;
    let releaseCreation: (() => void) | undefined;
    const creationStarted = new Promise<void>((resolve) => {
      markCreationStarted = resolve;
    });
    const creationReleased = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      markCreationStarted?.();
      await creationReleased;

      const script = args.at(-1) ?? "";
      const match = script.match(/SNAPSHOT_FILE='([^']+)'/u);
      if (!match) throw new Error("missing snapshot path");
      await writeFile(match[1], "alias ll='ls -l concurrent'\n");
      return { stdout: "", stderr: "" };
    });

    try {
      const manager = new ShellInitSnapshotManager({ execFile });
      const request = {
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix" as const,
        shellPath: "/bin/bash",
      };

      const firstPromise = manager.getOrCreate(request);
      const secondPromise = manager.getOrCreate({ ...request });

      await creationStarted;
      expect(execFile).toHaveBeenCalledTimes(1);
      releaseCreation?.();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first).toBeDefined();
      if (!first) throw new Error("expected ready snapshot");
      expect(second).toEqual(first);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(await readFile(first.path, "utf8")).toBe("alias ll='ls -l concurrent'\n");

      const cleanup = await manager.cleanup();
      expect(cleanup).toEqual({ deleted: 1, errors: 0 });
      await expect(stat(first.path)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps bash and zsh snapshots separate for the same session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      const match = script.match(/SNAPSHOT_FILE='([^']+)'/u);
      if (!match) throw new Error("missing snapshot path");
      await writeFile(match[1], `# ${match[1].includes("zsh") ? "zsh" : "bash"}\n`);
      return { stdout: "", stderr: "" };
    });

    try {
      const manager = new ShellInitSnapshotManager({ execFile });
      const bash = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });
      const zsh = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/zsh",
      });

      expect(bash).toBeDefined();
      expect(zsh).toBeDefined();
      if (!bash || !zsh) {
        throw new Error("expected ready snapshots");
      }
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(bash.path).not.toBe(zsh.path);
      expect(bash.path).toMatch(/\/shell-snapshots\/snapshot-bash-\d+-[a-z0-9]{6}\.sh$/u);
      expect(zsh.path).toMatch(/\/shell-snapshots\/snapshot-zsh-\d+-[a-z0-9]{6}\.sh$/u);
      expect(await readFile(bash.path, "utf8")).toBe("# bash\n");
      expect(await readFile(zsh.path, "utf8")).toBe("# zsh\n");

      const cleanup = await manager.cleanup();
      expect(cleanup).toEqual({ deleted: 2, errors: 0 });
      await expect(stat(bash.path)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(zsh.path)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("creates a new random snapshot for a new manager instead of reusing cold-resume leftovers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      const match = script.match(/SNAPSHOT_FILE='([^']+)'/u);
      if (!match) throw new Error("missing snapshot path");
      await writeFile(match[1], "alias ll='ls -l fresh'\n");
      return { stdout: "", stderr: "" };
    });
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    try {
      const staleManager = new ShellInitSnapshotManager({ execFile });
      const stale = await staleManager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });
      if (!stale) throw new Error("expected ready snapshot");
      await writeFile(stale.path, "alias ll='stale'\n");

      const freshManager = new ShellInitSnapshotManager({ execFile });
      const fresh = await freshManager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });

      expect(fresh).toBeDefined();
      if (!fresh) throw new Error("expected ready snapshot");
      expect(fresh.path).not.toBe(stale.path);
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(await readFile(fresh.path, "utf8")).toBe("alias ll='ls -l fresh'\n");
    } finally {
      nowSpy.mockRestore();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses host paths in creation scripts and Git Bash paths when sourcing snapshots", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    const windowsLikeRoot = join(rootDir, "C:\\Users\\me\\ZCode");
    let creationSnapshotPath = "";
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "-lc") return { stdout: "/usr/bin:/bin\n", stderr: "" };

      const script = args.at(-1) ?? "";
      const match = script.match(/SNAPSHOT_FILE='([^']+)'/u);
      if (!match) throw new Error("missing snapshot path");
      creationSnapshotPath = match[1];
      expect(creationSnapshotPath).toContain("C:\\Users\\me\\ZCode");
      await mkdir(dirname(creationSnapshotPath), { recursive: true });
      await writeFile(creationSnapshotPath, "alias ll='ls -l git-bash'\n");
      return { stdout: "", stderr: "" };
    });

    try {
      const manager = new ShellInitSnapshotManager({ execFile });
      const result = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir: windowsLikeRoot,
        shellDialect: "git-bash",
        shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      });

      expect(result).toBeDefined();
      if (!result) throw new Error("expected ready snapshot");
      expect(result.path).toContain("C:\\Users\\me\\ZCode");
      expect(result.path).toBe(creationSnapshotPath);
      expect(result.shellPath).toContain("C:/Users/me/ZCode");
      expect(result.shellPath).not.toContain("\\");
      expect(execFile).toHaveBeenCalledTimes(2);

      const cleanup = await manager.cleanup();
      expect(cleanup).toEqual({ deleted: 1, errors: 0 });
      await expect(stat(result.path)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("caches failed snapshot creation and keeps later calls failed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-snapshot-"));
    const execFile = vi.fn(async () => {
      throw new Error("shell init failed");
    });

    try {
      const manager = new ShellInitSnapshotManager({ execFile });
      const first = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });
      const second = await manager.getOrCreate({
        env: { HOME: rootDir },
        rootDir,
        shellDialect: "posix",
        shellPath: "/bin/bash",
      });

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(execFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns disabled for cmd and legacy shells", async () => {
    const manager = new ShellInitSnapshotManager();
    const result = await manager.getOrCreate({
      env: {},
      rootDir: "/tmp/zcode",
      shellDialect: "cmd",
      shellPath: "cmd.exe",
    });

    expect(result).toBeUndefined();
  });
});

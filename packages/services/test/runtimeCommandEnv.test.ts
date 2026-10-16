import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";
import {
  buildLoginShellEnvPatch,
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "../src/runtime-tools/runtimeCommandEnv.js";

const originalVitest = process.env.VITEST;

describe("runtimeCommandEnv", () => {
  afterEach(() => {
    vi.useRealTimers();
    if (originalVitest == null) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
  });

  it("seals user network env before host runtime sanitization", () => {
    process.env.VITEST = "1";

    const patch = buildRuntimeProcessEnvPatch({
      HTTP_PROXY: "http://shell-proxy:8080",
      NODE_ENV: "development",
      NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
      PATH: "/usr/bin:/bin",
      npm_config_proxy: "http://npm-proxy:8080",
    });

    expect(patch.HTTP_PROXY).toBeUndefined();
    expect(patch.NODE_ENV).toBeUndefined();
    expect(patch.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(patch[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeDefined();
    expect(readZCodeToolEnvPassthroughEnv(patch)).toMatchObject({
      HTTP_PROXY: "http://shell-proxy:8080",
      NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
      npm_config_proxy: "http://npm-proxy:8080",
    });
  });

  it("keeps POSIX bootstrap paths when login shell capture is unavailable", () => {
    process.env.VITEST = "1";

    const patch = buildRuntimeProcessEnvPatch({
      PATH: "/usr/bin:/bin",
    });

    const pathEntries = patch.PATH?.split(":") ?? [];
    if (process.platform === "darwin") {
      expect(pathEntries).toContain("/opt/homebrew/bin");
      expect(pathEntries).toContain("/usr/local/bin");
    } else if (process.platform !== "win32") {
      expect(pathEntries).toContain("/usr/local/bin");
      expect(pathEntries).toContain("/usr/local/sbin");
    }
  });

  it("keeps user commands ahead of bundled runtime tools on PATH", () => {
    process.env.VITEST = "1";
    const root = mkdtempSync(join(tmpdir(), "zcode-runtime-tool-path-order-"));
    const systemBin = join(root, "system-bin");
    const binarySuffix = process.platform === "win32" ? ".exe" : "";
    const runtimeBinaries = {
      ZCODE_BFS_BINARY: join(root, "runtime", "bfs", `bfs${binarySuffix}`),
      ZCODE_RG_BINARY: join(root, "runtime", "ripgrep", `rg${binarySuffix}`),
      ZCODE_UGREP_BINARY: join(root, "runtime", "ugrep", `ugrep${binarySuffix}`),
    } as const;

    try {
      mkdirSync(systemBin, { recursive: true });
      for (const binaryPath of Object.values(runtimeBinaries)) {
        mkdirSync(dirname(binaryPath), { recursive: true });
        writeFileSync(binaryPath, "runtime tool\n");
        if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
      }

      const patch = buildRuntimeProcessEnvPatch({
        PATH: systemBin,
        ...runtimeBinaries,
      });
      const pathEntries = patch.PATH?.split(delimiter) ?? [];
      const systemIndex = pathEntries.indexOf(systemBin);
      expect(systemIndex).toBeGreaterThanOrEqual(0);
      for (const binaryPath of Object.values(runtimeBinaries)) {
        expect(pathEntries.indexOf(dirname(binaryPath))).toBeGreaterThan(systemIndex);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows Path casing before building the runtime patch", () => {
    const userPath = "C:\\Users\\demo\\bin;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32";
    const normalized = normalizeRuntimeProcessEnv(
      {
        PATH: "C:\\dotenv-only-bin",
        Path: userPath,
      },
      "win32",
    );
    const patch = buildRuntimeProcessEnvPatch(normalized, null, {
      platform: "win32",
      windowsNodePaths: [],
    });

    expect(normalized).toEqual({ PATH: userPath });
    expect(patch.PATH).toEqual(expect.stringMatching(/^C:\\Users\\demo\\bin;/));
    expect(patch.PATH).toContain("C:\\Program Files\\Git\\cmd");
    expect(Object.keys(patch).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
  });

  it("inherits login shell env required by cd hook based version managers", () => {
    const patch = buildLoginShellEnvPatch({
      AUTOENV_ENV_FILENAME: ".env",
      CHRUBY_ROOT: "/opt/chruby",
      DIRENV_CONFIG: "/Users/dev/.config/direnv",
      FNM_DIR: "/Users/dev/.fnm",
      FNM_MULTISHELL_PATH: "/tmp/fnm-shell",
      GEM_HOME: "/Users/dev/.gem/ruby/3.4.0",
      GEM_PATH: "/Users/dev/.gem/ruby/3.4.0:/opt/ruby/gems",
      GOENV_ROOT: "/Users/dev/.goenv",
      GVM_ROOT: "/Users/dev/.gvm",
      HTTP_PROXY: "http://shell-proxy:8080",
      JENV_ROOT: "/Users/dev/.jenv",
      MISE_DATA_DIR: "/Users/dev/.local/share/mise",
      MY_RUBY_HOME: "/Users/dev/.rvm/rubies/ruby-3.4.0",
      NODE_OPTIONS: "--openssl-legacy-provider",
      NODENV_ROOT: "/Users/dev/.nodenv",
      NVM_CD_FLAGS: "-q",
      PYENV_VERSION: "project-env",
      PYENV_VIRTUALENV_DISABLE_PROMPT: "1",
      RBENV_ROOT: "/Users/dev/.rbenv",
      RUBIES: "/opt/rubies",
      SDKMAN_CANDIDATES_DIR: "/Users/dev/.sdkman/candidates",
      SDKMAN_PLATFORM: "darwinarm64",
      gvm_go_name: "go1.22",
      rvm_path: "/Users/dev/.rvm",
      rvm_prefix: "/Users/dev",
    });

    expect(patch).toMatchObject({
      AUTOENV_ENV_FILENAME: ".env",
      CHRUBY_ROOT: "/opt/chruby",
      DIRENV_CONFIG: "/Users/dev/.config/direnv",
      FNM_DIR: "/Users/dev/.fnm",
      FNM_MULTISHELL_PATH: "/tmp/fnm-shell",
      GEM_HOME: "/Users/dev/.gem/ruby/3.4.0",
      GEM_PATH: "/Users/dev/.gem/ruby/3.4.0:/opt/ruby/gems",
      GOENV_ROOT: "/Users/dev/.goenv",
      GVM_ROOT: "/Users/dev/.gvm",
      JENV_ROOT: "/Users/dev/.jenv",
      MISE_DATA_DIR: "/Users/dev/.local/share/mise",
      MY_RUBY_HOME: "/Users/dev/.rvm/rubies/ruby-3.4.0",
      NODENV_ROOT: "/Users/dev/.nodenv",
      NVM_CD_FLAGS: "-q",
      PYENV_VERSION: "project-env",
      PYENV_VIRTUALENV_DISABLE_PROMPT: "1",
      RBENV_ROOT: "/Users/dev/.rbenv",
      RUBIES: "/opt/rubies",
      SDKMAN_CANDIDATES_DIR: "/Users/dev/.sdkman/candidates",
      SDKMAN_PLATFORM: "darwinarm64",
      gvm_go_name: "go1.22",
      rvm_path: "/Users/dev/.rvm",
      rvm_prefix: "/Users/dev",
    });
    expect(patch.HTTP_PROXY).toBeUndefined();
    expect(patch.NODE_OPTIONS).toBeUndefined();
    const passthrough = readZCodeToolEnvPassthroughEnv(patch);
    expect(passthrough).toMatchObject({
      HTTP_PROXY: "http://shell-proxy:8080",
    });
    expect(passthrough.NODE_OPTIONS).toBeUndefined();
  });

  it("captures PATH and inherited fields with one asynchronous login shell call", async () => {
    const executeShell = vi.fn(async () =>
      [
        "shell startup chatter",
        "__ZCODE_LOGIN_ENV_START__\0",
        "PATH=/Users/dev/.local/bin:/usr/bin:/bin\0",
        "FNM_DIR=/Users/dev/.fnm\0",
        "HTTP_PROXY=http://shell-proxy:8080\0",
        "__ZCODE_LOGIN_ENV_END__\0",
      ].join(""),
    );

    const snapshot = await captureLoginShellEnvSnapshot({
      baseEnv: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      shellPath: "/bin/zsh",
      executeShell,
    });

    expect(executeShell).toHaveBeenCalledTimes(1);
    expect(executeShell).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", expect.stringContaining("env -0")],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expect.stringContaining("/usr/bin") }),
      }),
    );
    expect(snapshot).toEqual({
      PATH: "/Users/dev/.local/bin:/usr/bin:/bin",
      FNM_DIR: "/Users/dev/.fnm",
      HTTP_PROXY: "http://shell-proxy:8080",
    });
  });

  it("settles login shell capture at the hard deadline even when the executor never settles", async () => {
    vi.useFakeTimers();
    let executionSignal: AbortSignal | undefined;
    const snapshotPromise = captureLoginShellEnvSnapshot({
      baseEnv: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      shellPath: "/bin/zsh",
      timeoutMs: 25,
      executeShell: (_shellPath, _shellArgs, options) => {
        executionSignal = options.signal;
        return new Promise(() => {});
      },
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(snapshotPromise).resolves.toBeNull();
    expect(executionSignal?.aborted).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "kills the login-shell process group when a descendant keeps stdio open",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "zcode-login-shell-deadline-"));
      const shellPath = join(root, "shell-with-background-child.sh");
      try {
        writeFileSync(
          shellPath,
          "#!/bin/sh\n(trap '' HUP TERM; sleep 30) &\nexec /bin/sh \"$@\"\n",
        );
        chmodSync(shellPath, 0o755);
        const startedAt = Date.now();

        const snapshot = await captureLoginShellEnvSnapshot({
          baseEnv: { PATH: "/usr/bin:/bin" },
          platform: process.platform,
          shellPath,
          timeoutMs: 100,
        });

        expect(snapshot).toBeNull();
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("builds the complete runtime patch from one precomputed snapshot", async () => {
    const captureSnapshot = vi.fn(async () => ({
      PATH: ["/Users/dev/.local/bin", "/usr/bin", "/bin"].join(delimiter),
      FNM_DIR: "/Users/dev/.fnm",
      HTTP_PROXY: "http://shell-proxy:8080",
    }));

    const patch = await prepareRuntimeProcessEnvPatch(
      { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      { captureSnapshot },
    );

    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    expect(patch.PATH?.split(delimiter)[0]).toBe("/Users/dev/.local/bin");
    expect(patch.FNM_DIR).toBe("/Users/dev/.fnm");
    expect(readZCodeToolEnvPassthroughEnv(patch)).toMatchObject({
      HTTP_PROXY: "http://shell-proxy:8080",
    });
  });
});

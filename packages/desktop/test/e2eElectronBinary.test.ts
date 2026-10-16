import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveE2EElectronBinary } from "./e2e/helpers/e2e-electron-binary.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("E2E Electron binary preflight", () => {
  it("loads local E2E env before reading timeout and resolving Electron", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const loadEnvIndex = wdioSource.indexOf("\nloadE2ELocalEnv();");
    const readTimeoutIndex = wdioSource.indexOf("const E2E_ELECTRON_INSTALL_TIMEOUT_MS");
    const resolveElectronIndex = wdioSource.indexOf("const ELECTRON_APP_BINARY_PATH");

    expect(loadEnvIndex).toBeGreaterThan(-1);
    expect(readTimeoutIndex).toBeGreaterThan(loadEnvIndex);
    expect(resolveElectronIndex).toBeGreaterThan(readTimeoutIndex);
  });

  it("returns the executable referenced by path.txt without reinstalling", async () => {
    const { desktopDir, electronRoot, repoRoot } = await createWorkspace();
    const electronBinary = resolve(electronRoot, "dist", "Electron.app", "electron");
    await mkdir(resolve(electronBinary, ".."), { recursive: true });
    await writeFile(resolve(electronRoot, "path.txt"), "Electron.app/electron");
    await writeFile(electronBinary, "binary");
    const installElectronPackage = vi.fn();

    expect(resolveE2EElectronBinary({ desktopDir, installElectronPackage, repoRoot })).toBe(
      electronBinary,
    );
    expect(installElectronPackage).not.toHaveBeenCalled();
  });

  it("runs electron install.js when only the package wrapper exists", async () => {
    const { desktopDir, electronRoot, repoRoot } = await createWorkspace();
    const electronBinary = resolve(electronRoot, "dist", "electron");
    const electronWrapperDir = resolve(repoRoot, "node_modules", ".bin");
    await mkdir(electronWrapperDir, { recursive: true });
    await writeFile(resolve(electronWrapperDir, "electron"), "wrapper");
    const environment = { ELECTRON_MIRROR: "https://mirror.example/electron" };
    const installTimeoutMs = 12_345;
    const installElectronPackage = vi.fn(() => {
      mkdirSync(resolve(electronRoot, "dist"), { recursive: true });
      writeFileSync(resolve(electronRoot, "path.txt"), "electron");
      writeFileSync(electronBinary, "binary");
    });

    expect(
      resolveE2EElectronBinary({
        desktopDir,
        environment,
        installElectronPackage,
        installTimeoutMs,
        repoRoot,
      }),
    ).toBe(electronBinary);
    expect(installElectronPackage).toHaveBeenCalledWith({
      environment,
      installScriptPath: resolve(electronRoot, "install.js"),
      packageRoot: electronRoot,
      timeoutMs: installTimeoutMs,
    });
  });

  it("terminates a blocked install and reports bounded sanitized diagnostics", async () => {
    const { desktopDir, electronRoot, repoRoot } = await createWorkspace();
    await writeFile(resolve(electronRoot, "install.js"), "setInterval(() => {}, 1_000);");
    const installTimeoutMs = 100;
    const startedAt = Date.now();
    let caught: unknown;

    try {
      resolveE2EElectronBinary({
        desktopDir,
        environment: {
          ELECTRON_MIRROR: "https://user:secret@mirror.example/electron?token=secret",
        },
        installTimeoutMs,
        repoRoot,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("预期 Electron 安装超时错误");
    }
    expect(caught.message).toContain("安装超时");
    expect(caught.message).toContain(`timeout=${installTimeoutMs}ms`);
    expect(caught.message).toContain("ELECTRON_MIRROR=https://mirror.example/electron");
    expect(caught.message).not.toContain("user:secret");
    expect(caught.message).not.toContain("token=secret");
    expect(caught.cause).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("fails before ChromeDriver when install.js does not produce a binary", async () => {
    const { desktopDir, repoRoot } = await createWorkspace();

    expect(() =>
      resolveE2EElectronBinary({
        desktopDir,
        installElectronPackage: vi.fn(),
        repoRoot,
      }),
    ).toThrow(/ELECTRON_SKIP_BINARY_DOWNLOAD/u);
  });
});

async function createWorkspace() {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "zcode-e2e-electron-"));
  temporaryRoots.push(repoRoot);
  const desktopDir = resolve(repoRoot, "packages", "desktop");
  const electronRoot = resolve(repoRoot, "node_modules", "electron");
  await mkdir(electronRoot, { recursive: true });
  await writeFile(resolve(electronRoot, "package.json"), "{}");
  await writeFile(resolve(electronRoot, "install.js"), "");
  return { desktopDir, electronRoot, repoRoot };
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceDir = resolve(desktopDir, "../..");
const fixturePath = resolve(desktopDir, "test/fixtures/installer-preserve-files.nsi");
const installerNshPath = resolve(desktopDir, "build/installer.nsh");
const appBuilderLibDir = dirname(require.resolve("app-builder-lib/package.json"));
const { getBinFromUrl } = require(resolve(appBuilderLibDir, "out/binDownload.js"));

const NSIS_CHECKSUM =
  "VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==";
const NSIS_RESOURCES_CHECKSUM =
  "Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==";

if (process.platform !== "win32") {
  process.stdout.write("[installer-preserve-files] skipped: Windows only\n");
} else {
  const [nsisDir, nsisResourcesDir] = await Promise.all([
    getBinFromUrl("nsis-3.0.4.1", "nsis-3.0.4.1.7z", NSIS_CHECKSUM),
    getBinFromUrl("nsis-resources-3.4.1", "nsis-resources-3.4.1.7z", NSIS_RESOURCES_CHECKSUM),
  ]);
  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-preserve-files-"));
  try {
    const makensisPath = resolve(nsisDir, "makensis.exe");
    const uninstallerOutput = join(tempRoot, "uninstaller.exe");
    execFileSync(
      makensisPath,
      [
        "/V2",
        "/WX",
        "/DBUILD_UNINSTALLER",
        `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
        `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
        `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
        `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
        `/DFIXTURE_EXE=${process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"}`,
        `/DOUTPUT_FILE=${uninstallerOutput}`,
        fixturePath,
      ],
      { cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const [scenario, omitManifest] of [
      ["manifest", false],
      ["legacy", true],
    ]) {
      const outputPath = join(tempRoot, `${scenario}.exe`);
      const installDir = join(tempRoot, scenario);
      const compileArgs = [
        "/V2",
        `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
        `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
        `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
        `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
        `/DFIXTURE_EXE=${process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"}`,
        `/DOUTPUT_FILE=${outputPath}`,
        fixturePath,
      ];
      if (omitManifest) compileArgs.splice(-1, 0, "/DOMIT_MANIFEST");
      execFileSync(makensisPath, compileArgs, {
        cwd: workspaceDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(outputPath, ["/S", `/D=${installDir}`], { encoding: "utf-8" });
      const ownedFileExists = existsSync(join(installDir, "owned-by-zcode.txt"));
      if (omitManifest !== ownedFileExists) {
        throw new Error(`${scenario}: ownership fallback mismatch`);
      }
      if (!existsSync(join(installDir, "user-data.txt"))) {
        throw new Error(`${scenario}: unrelated file was removed`);
      }
      if (readFileSync(join(installDir, "ZCode.exe")).length === 0) {
        throw new Error(`${scenario}: application payload was not installed`);
      }
    }
    const failureOutputPath = join(tempRoot, "failure.exe");
    const failureInstallDir = join(tempRoot, "failure");
    const failureLogPath = join(tempRoot, "failure-uninstaller.log");
    const failureCompileArgs = [
      "/V2",
      "/WX",
      "/DBUILD_UNINSTALLER",
      `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
      `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
      `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
      `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
      `/DFIXTURE_EXE=${process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"}`,
      `/DOUTPUT_FILE=${failureOutputPath}`,
      `/DZCODE_UNINSTALLER_LOG_PATH=${failureLogPath}`,
      "/DFAIL_DELETE",
      fixturePath,
    ];
    execFileSync(makensisPath, failureCompileArgs, {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failureExitCode = 0;
    try {
      execFileSync(failureOutputPath, ["/S", `/D=${failureInstallDir}`], {
        encoding: "utf-8",
      });
    } catch (error) {
      failureExitCode = error.status ?? 0;
    }
    if (failureExitCode === 0) {
      throw new Error("manifest cleanup failure unexpectedly returned success");
    }
    const failureLog = readFileSync(failureLogPath, "utf8");
    for (const marker of ["cleanup-started", "cleanup-failed reason=permission-or-disk-space"]) {
      if (!failureLog.includes(marker)) {
        throw new Error(`uninstaller log is missing ${marker}: ${failureLog}`);
      }
    }
    if (!/\[pid=[1-9]\d*\]/.test(failureLog)) {
      throw new Error(`uninstaller log is missing a positive PID: ${failureLog}`);
    }

    process.stdout.write("[installer-preserve-files] passed\n");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
